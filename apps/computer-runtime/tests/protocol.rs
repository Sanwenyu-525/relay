//! Protocol and mock-path unit tests (no real Windows input is ever synthesized).

use relay_computer_runtime::protocol::{
    codes, ComputerError, ComputerReply, ComputerRequest, PROTOCOL_VERSION,
};
use relay_computer_runtime::{handle_request_with_mode, is_known_code};
use serde_json::{json, Value};

fn request(method: &str, params: Value) -> ComputerRequest {
    ComputerRequest {
        version: PROTOCOL_VERSION.to_string(),
        request_id: "req-1".to_string(),
        method: method.to_string(),
        params,
    }
}

fn ok(method: &str, params: Value) -> Value {
    let reply = handle_request_with_mode(&request(method, params), true);
    assert!(reply.success, "expected success, got {reply:?}");
    reply.result.expect("missing result")
}

fn err(method: &str, params: Value) -> ComputerError {
    let reply = handle_request_with_mode(&request(method, params), true);
    assert!(!reply.success, "expected failure, got {reply:?}");
    let error = reply.error.expect("missing error body");
    ComputerError::new(
        Box::leak(error.code.into_boxed_str()),
        error.message,
        error.retryable,
    )
}

#[test]
fn protocol_roundtrip_reply_shapes() {
    let reply = ComputerReply {
        version: PROTOCOL_VERSION,
        request_id: "req-1".to_string(),
        success: true,
        result: Some(json!({ "ok": true })),
        error: None,
    };
    let text = serde_json::to_string(&reply).expect("serialize");
    assert!(text.contains(PROTOCOL_VERSION));
    assert!(text.contains("req-1"));
    assert!(text.contains("\"success\":true"));
}

#[test]
fn wrong_protocol_version_is_rejected_before_any_provider_runs() {
    let bad = ComputerRequest {
        version: "relay-computer-v0".to_string(),
        request_id: "req-1".to_string(),
        method: "computer.screenshot".to_string(),
        params: json!({}),
    };
    let reply = handle_request_with_mode(&bad, false);
    assert!(!reply.success);
    assert_eq!(reply.error.map(|error| error.code), Some("INVALID_REQUEST".to_string()));
}

#[test]
fn unknown_method_and_empty_request_id_are_type_rejected() {
    assert_eq!(err("computer.teleport", json!({})).code, "INVALID_REQUEST");
    let mut bad = request("computer.screenshot", json!({}));
    bad.request_id = "  ".to_string();
    let reply = handle_request_with_mode(&bad, false);
    assert!(!reply.success);
}

#[test]
fn explicit_real_mode_never_falls_back_to_mock_answers() {
    // The explicit-mode contract: mock=false must not read ambient COMPUTER_RUNTIME_MODE.
    // On Windows the real provider runs (a headless session may legitimately fail the
    // capture); on other hosts it fails closed. Either way no mock marker may appear.
    let reply = handle_request_with_mode(&request("computer.screenshot", json!({})), false);
    if reply.success {
        assert!(reply.result.as_ref().and_then(|value| value.get("mock")).is_none(),
            "explicit real mode must not answer with mock data");
    } else {
        let code = reply.error.map(|error| error.code);
        assert!(code == Some("RUNTIME_UNAVAILABLE".to_string()) ||
            code == Some("SCREENSHOT_FAILED".to_string()),
            "explicit real mode failed with an unexpected code: {code:?}");
    }
}

#[test]
fn mock_screenshot_has_real_shape() {
    let shot = ok("computer.screenshot", json!({}));
    assert_eq!(shot["type"], "computer_screenshot");
    assert_eq!(shot["width"], 1280);
    assert_eq!(shot["height"], 720);
    let image = shot["image"].as_str().expect("image must be a base64 string");
    assert!(image.len() > 100, "mock image must not be empty");
    assert!(shot.get("timestamp").is_some());
}

#[test]
fn mock_windows_carry_identity_and_bounds() {
    let windows = ok("computer.get_windows", json!({}));
    let list = windows["windows"].as_array().expect("windows array");
    assert!(list.len() >= 2);
    for window in list {
        assert!(window["id"].is_string());
        assert!(window["title"].is_string());
        assert!(window["process_id"].is_number());
        assert!(window["width"].is_number());
        assert!(window["focused"].is_boolean());
    }
    assert_eq!(list.iter().filter(|window| window["focused"] == true).count(), 1);
}

#[test]
fn mock_activate_rejects_unknown_window_and_accepts_known() {
    assert_eq!(err("computer.activate_window",
        json!({ "window_id": "9999", "allow_foreground": true })).code, "WINDOW_NOT_FOUND");
    let activated = ok("computer.activate_window",
        json!({ "window_id": "1000", "allow_foreground": true }));
    assert_eq!(activated["mock_activated"], "1000");
}

#[test]
fn coordinate_validation_rejects_negative_and_missing_values() {
    assert_eq!(err("computer.click",
        json!({ "x": -1, "y": 10, "allow_foreground": true })).code, "INVALID_COORDINATE");
    assert_eq!(err("computer.click", json!({ "y": 10, "allow_foreground": true })).code, "INVALID_REQUEST");
    assert_eq!(
        err("computer.drag", json!({ "start": { "x": -5, "y": 1 }, "end": { "x": 5, "y": 5 },
            "allow_foreground": true })).code,
        "INVALID_COORDINATE"
    );
}

#[test]
fn button_enum_is_closed() {
    assert_eq!(
        err("computer.click", json!({ "x": 10, "y": 10, "button": "double", "allow_foreground": true })).code,
        "INVALID_REQUEST"
    );
    let clicked = ok("computer.click", json!({ "x": 10, "y": 10, "button": "right", "allow_foreground": true }));
    assert_eq!(clicked["button"], "right");
}

#[test]
fn key_and_hotkey_vocabularies_are_strict() {
    assert_eq!(err("computer.keypress", json!({ "key": "PLAY", "allow_foreground": true })).code, "INVALID_REQUEST");
    assert_eq!(err("computer.hotkey", json!({ "keys": [], "allow_foreground": true })).code, "INVALID_REQUEST");
    assert_eq!(
        err("computer.hotkey", json!({ "keys": ["CTRL"], "allow_foreground": true })).code,
        "INVALID_REQUEST"
    );
    let pressed = ok("computer.hotkey", json!({ "keys": ["CTRL", "SHIFT", "S"], "allow_foreground": true }));
    assert_eq!(pressed["pressed"], true);
}

#[test]
fn unicode_type_counts_code_units() {
    // "你好 AB" is 5 UTF-16 code units (and 9 UTF-8 bytes); both the real
    // KEYEVENTF_UNICODE path and the mock path must report the same number.
    let typed = ok("computer.type", json!({ "text": "你好 AB", "allow_foreground": true }));
    assert_eq!(typed["length"], 5);
}

#[test]
fn type_delay_ms_is_validated_before_any_provider_runs() {
    // delay_ms 是可靠性参数：缺省与合法值放行，越界与非法类型在派发前拒绝。
    let with_default = ok("computer.type", json!({ "text": "abc", "allow_foreground": true }));
    assert_eq!(with_default["length"], 3);
    let with_delay = ok("computer.type", json!({ "text": "abc", "delay_ms": 100, "allow_foreground": true }));
    assert_eq!(with_delay["length"], 3);
    assert_eq!(err("computer.type",
        json!({ "text": "abc", "delay_ms": 0, "allow_foreground": true })).code, "INVALID_REQUEST");
    assert_eq!(err("computer.type",
        json!({ "text": "abc", "delay_ms": 101, "allow_foreground": true })).code, "INVALID_REQUEST");
    assert_eq!(err("computer.type",
        json!({ "text": "abc", "delay_ms": "30", "allow_foreground": true })).code, "INVALID_REQUEST");
}

#[test]
fn every_frozen_error_code_is_declared() {
    for code in [
        codes::INVALID_REQUEST,
        codes::RUNTIME_UNAVAILABLE,
        codes::SCREENSHOT_FAILED,
        codes::WINDOW_NOT_FOUND,
        codes::WINDOW_ACTIVATION_FAILED,
        codes::INVALID_COORDINATE,
        codes::INPUT_FAILED,
        codes::PERMISSION_DENIED,
        codes::USER_CANCELLED,
        codes::TIMEOUT,
        codes::FOREGROUND_NOT_AUTHORIZED,
        codes::ISOLATED_SESSION_UNAVAILABLE,
        codes::CAPTURE_TARGET_UNAVAILABLE,
        codes::UNKNOWN,
    ] {
        assert!(is_known_code(code), "{code} must stay in the frozen vocabulary");
    }
}

#[test]
fn desktop_input_requires_explicit_foreground_authorization() {
    // V2 硬闸门：不加 allow_foreground 一律不执行，绝不静默降级到用户桌面。
    for method in [
        "computer.activate_window", "computer.click", "computer.double_click", "computer.scroll",
        "computer.drag", "computer.type", "computer.keypress", "computer.hotkey",
    ] {
        let mut params = json!({ "text": "x", "window_id": "1000", "key": "ENTER",
            "keys": ["CTRL", "C"], "x": 1, "y": 2,
            "start": { "x": 0, "y": 0 }, "end": { "x": 1, "y": 1 } });
        let reply = handle_request_with_mode(&request(method, params.clone()), true);
        assert!(!reply.success, "{method} must refuse without authorization");
        assert_eq!(reply.error.map(|error| error.code),
            Some("FOREGROUND_NOT_AUTHORIZED".to_string()), "{method} must report the reason");
        // 带上显式授权后才允许进入执行路径。
        params["allow_foreground"] = json!(true);
        let authorized = handle_request_with_mode(&request(method, params), true);
        assert!(authorized.success, "{method} with authorization: {authorized:?}");
    }
}

#[test]
fn read_only_methods_never_require_foreground_authorization() {
    for method in ["computer.screenshot", "computer.get_windows", "computer.describe_environment"] {
        let reply = handle_request_with_mode(&request(method, json!({})), true);
        assert!(reply.success, "{method} is read-only and must not require authorization: {reply:?}");
    }
}

#[test]
fn capture_targets_are_explicit_and_unavailable_targets_refuse() {
    // 用户桌面与窗口目标在 mock 下可用；独立工作区与浏览器页明确拒绝，
    // 不退回整屏桌面截图。
    let desktop = ok("computer.screenshot", json!({ "target": "user_desktop" }));
    assert_eq!(desktop["target"], "user_desktop");
    let window = ok("computer.screenshot", json!({ "target": "window" }));
    assert_eq!(window["target"], "window");
    let isolated = err("computer.screenshot", json!({ "target": "agent_session" }));
    assert_eq!(isolated.code, "ISOLATED_SESSION_UNAVAILABLE");
    let browser = err("computer.screenshot", json!({ "target": "browser_page" }));
    assert_eq!(browser.code, "CAPTURE_TARGET_UNAVAILABLE");
    assert_eq!(err("computer.screenshot", json!({ "target": "screen" })).code, "INVALID_REQUEST");
}

#[test]
fn environment_probe_reports_modes_honestly_in_mock() {
    let env = ok("computer.describe_environment", json!({}));
    assert_eq!(env["mock"], true);
    // 后台与独立会话在 mock 下都不可用，前台需要授权——与真实形状一致。
    assert_eq!(env["mode_availability"]["background"]["status"], "unavailable");
    assert_eq!(env["mode_availability"]["isolated"]["status"], "unavailable");
    assert_eq!(env["mode_availability"]["foreground"]["status"], "requires_user_authorization");
    assert_eq!(env["ui_automation"]["provider_implemented"], false);
}

#[test]
fn environment_probe_in_real_mode_reports_platform_facts() {
    // 真实探测：不假设结果，只断言形状与「不谎报已实现」。
    let reply = handle_request_with_mode(&request("computer.describe_environment", json!({})), false);
    if !reply.success {
        // 非 Windows 上真实模式失败关闭。
        return;
    }
    let env = reply.result.expect("result");
    assert_eq!(env["platform"], "windows");
    assert!(env["dpi_awareness"].is_string());
    assert!(env["virtual_screen"]["width"].is_number());
    assert!(env["child_session"]["enabled"].is_boolean());
    assert!(env["child_session"]["available"].is_boolean());
    assert_eq!(env["ui_automation"]["provider_implemented"], false,
        "UIA provider 尚未实现，探测不得谎报");
    assert_eq!(env["mode_availability"]["foreground"]["status"], "requires_user_authorization");
}
