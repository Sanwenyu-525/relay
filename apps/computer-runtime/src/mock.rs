//! Mock Computer Runtime (COMPUTER_RUNTIME_MODE=mock).
//!
//! Mock answers are only for UI/agent-flow testing: they are deterministic, they
//! never touch the real desktop, and they fail closed for anything that would
//! require a real screen or a real window. Production always uses the real
//! Windows providers.

use crate::input::validate_point;
use crate::protocol::ComputerError;
use crate::screenshot::encode_png;
use crate::window::WindowInfo;
use serde_json::{json, Value};

pub fn is_mock_mode() -> bool {
    std::env::var("COMPUTER_RUNTIME_MODE")
        .map(|value| value.eq_ignore_ascii_case("mock"))
        .unwrap_or(false)
}

const MOCK_WIDTH: i32 = 1280;
const MOCK_HEIGHT: i32 = 720;

/// Deterministic gradient PNG; shape matches the real screenshot reply exactly.
pub fn mock_screenshot() -> Result<Value, ComputerError> {
    Ok(mock_screenshot_value("user_desktop"))
}

/// 目标感知的 mock 截图：不可用的目标在 mock 下也返回同一套类型化拒绝，
/// 这样 UI/Agent 流程测试能覆盖「不可用即拒绝」这条契约（V2 §32）。
pub fn mock_screenshot_for(target: crate::capture::CaptureTarget) -> Result<Value, ComputerError> {
    use crate::capture::CaptureTarget;
    match target {
        CaptureTarget::UserDesktop | CaptureTarget::Window => Ok(mock_screenshot_value(target.name())),
        CaptureTarget::AgentSession => Err(ComputerError::new(
            "ISOLATED_SESSION_UNAVAILABLE",
            "mock: capture target 'agent_session' requires an isolated Agent workspace (unavailable)",
            false,
        )),
        CaptureTarget::BrowserPage => Err(ComputerError::new(
            "CAPTURE_TARGET_UNAVAILABLE",
            "mock: capture target 'browser_page' requires the browser adapter (not implemented)",
            false,
        )),
    }
}

fn mock_screenshot_value(target: &str) -> Value {
    let mut rgb = Vec::with_capacity((MOCK_WIDTH * MOCK_HEIGHT * 3) as usize);
    for y in 0..MOCK_HEIGHT {
        for x in 0..MOCK_WIDTH {
            rgb.push((x % 256) as u8);
            rgb.push((y % 256) as u8);
            rgb.push(128);
        }
    }
    let png = encode_png(&rgb, MOCK_WIDTH as u32, MOCK_HEIGHT as u32)
        .unwrap_or_default();
    let image = crate::screenshot::base64_encode(&png);
    json!({
        "type": "computer_screenshot",
        "target": target,
        "image": image,
        "width": MOCK_WIDTH,
        "height": MOCK_HEIGHT,
        "origin_x": 0,
        "origin_y": 0,
        "timestamp": 0,
        "mock": true,
    })
}

/// 环境探测的 mock：报告「后台不可用、独立会话不可用、前台需授权」这一真实契约形状。
pub fn mock_environment() -> Result<Value, ComputerError> {
    Ok(json!({
        "platform": "mock",
        "dpi_awareness": "PER_MONITOR_AWARE_V2",
        "virtual_screen": { "x": 0, "y": 0, "width": MOCK_WIDTH, "height": MOCK_HEIGHT },
        "monitors": [{ "x": 0, "y": 0, "width": MOCK_WIDTH, "height": MOCK_HEIGHT, "primary": true }],
        "child_session": { "enabled": false, "enabled_query_ok": true, "available": false, "session_id": null },
        "ui_automation": { "client_library_loadable": true, "provider_implemented": false, "already_loaded": false },
        "mode_availability": {
            "background": { "status": "unavailable", "browser_cdp": "not_configured", "ui_automation": "provider_not_implemented" },
            "isolated": { "status": "unavailable", "reason": "mock: no child session" },
            "foreground": { "status": "requires_user_authorization" },
        },
        "mock": true,
    }))
}

pub fn mock_windows() -> Result<Value, ComputerError> {
    let windows = [
        WindowInfo {
            id: "1000".to_string(),
            title: "Mock Notepad".to_string(),
            process_name: Some("notepad.exe".to_string()),
            process_id: 4242,
            x: 100,
            y: 100,
            width: 800,
            height: 600,
            visible: true,
            focused: true,
        },
        WindowInfo {
            id: "2000".to_string(),
            title: "Mock Chrome".to_string(),
            process_name: Some("chrome.exe".to_string()),
            process_id: 5252,
            x: 150,
            y: 150,
            width: 1024,
            height: 768,
            visible: true,
            focused: false,
        },
    ];
    Ok(json!({ "windows": windows.iter().map(window_json).collect::<Vec<_>>(), "mock": true }))
}

pub fn mock_activate(window_id: &str) -> Result<Value, ComputerError> {
    let known = ["1000", "2000"];
    if !known.contains(&window_id) {
        return Err(ComputerError::new(
            "WINDOW_NOT_FOUND",
            format!("mock window {window_id} does not exist"),
            true,
        ));
    }
    let mut info = mock_windows()?;
    info["mock_activated"] = json!(window_id);
    Ok(info)
}

pub fn mock_move(params: &Value) -> Result<Value, ComputerError> {
    coordinate_of(params)?;
    let x = params.get("x").and_then(Value::as_i64).unwrap_or_default();
    let y = params.get("y").and_then(Value::as_i64).unwrap_or_default();
    Ok(json!({ "moved": true, "x": x, "y": y, "mock": true }))
}

pub fn mock_click(params: &Value) -> Result<Value, ComputerError> {
    coordinate_of(params)?;
    let x = params.get("x").and_then(Value::as_i64).unwrap_or_default();
    let y = params.get("y").and_then(Value::as_i64).unwrap_or_default();
    Ok(json!({ "clicked": true, "x": x, "y": y, "button": button_of(params), "mock": true }))
}

/// mock 与真实路径同形：报**实际**整格位移，请求值不同时一并带出。
pub fn mock_scroll(applied_x: i32, applied_y: i32, requested_x: i32,
    requested_y: i32) -> Result<Value, ComputerError> {
    let mut out = json!({
        "scrolled": true,
        "delta_x": applied_x,
        "delta_y": applied_y,
        "mock": true,
    });
    if applied_x != requested_x || applied_y != requested_y {
        out["requested_delta_x"] = json!(requested_x);
        out["requested_delta_y"] = json!(requested_y);
    }
    Ok(out)
}

pub fn mock_drag(params: &Value) -> Result<Value, ComputerError> {
    let start = point_of(params, "start")?;
    let end = point_of(params, "end")?;
    validate_point(start).ok();
    validate_point(end).ok();
    Ok(json!({ "dragged": true, "start": { "x": start.x, "y": start.y },
        "end": { "x": end.x, "y": end.y }, "mock": true }))
}

pub fn mock_type(params: &Value) -> Result<Value, ComputerError> {
    let text = params.get("text").and_then(Value::as_str).unwrap_or_default();
    Ok(json!({ "typed": true, "length": text.chars().count(), "mock": true }))
}

pub fn mock_keypress(params: &Value) -> Result<Value, ComputerError> {
    let key = params.get("key").and_then(Value::as_str).unwrap_or_default();
    if !crate::input::is_known_key_name(key) {
        return Err(ComputerError::new(
            "INVALID_REQUEST",
            format!("unsupported key name {key:?}"),
            false,
        ));
    }
    Ok(json!({ "pressed": true, "key": key, "mock": true }))
}

pub fn mock_hotkey(params: &Value) -> Result<Value, ComputerError> {
    let keys = params.get("keys").and_then(Value::as_array).cloned().unwrap_or_default();
    if keys.is_empty() {
        return Err(ComputerError::new(
            "INVALID_REQUEST",
            "hotkey requires at least one key",
            false,
        ));
    }
    let mut names: Vec<String> = Vec::new();
    for key in &keys {
        let name = key.as_str().ok_or_else(|| {
            ComputerError::new("INVALID_REQUEST", "hotkey keys must be strings", false)
        })?;
        if !crate::input::is_known_key_name(name) {
            return Err(ComputerError::new(
                "INVALID_REQUEST",
                format!("unsupported key name {name:?}"),
                false,
            ));
        }
        names.push(name.to_string());
    }
    if names.iter().all(|name| {
        crate::input::virtual_key_of(name).is_some_and(|vk| vk == 0x11 || vk == 0x12 || vk == 0x10 || vk == 0x5B)
    }) {
        return Err(ComputerError::new(
            "INVALID_REQUEST",
            "hotkey needs at least one non-modifier key",
            false,
        ));
    }
    Ok(json!({ "pressed": true, "keys": keys, "mock": true }))
}

fn window_json(info: &WindowInfo) -> Value {
    json!({
        "id": info.id,
        "title": info.title,
        "process_name": info.process_name,
        "process_id": info.process_id,
        "x": info.x,
        "y": info.y,
        "width": info.width,
        "height": info.height,
        "visible": info.visible,
        "focused": info.focused,
    })
}

fn button_of(params: &Value) -> &'static str {
    match params.get("button").and_then(Value::as_str).unwrap_or("left") {
        "right" => "right",
        "middle" => "middle",
        _ => "left",
    }
}

fn coordinate_of(params: &Value) -> Result<(), ComputerError> {
    let x = params.get("x").and_then(Value::as_i64).unwrap_or_default();
    let y = params.get("y").and_then(Value::as_i64).unwrap_or_default();
    if x < 0 || y < 0 || x > i64::from(i32::MAX) || y > i64::from(i32::MAX) {
        return Err(ComputerError::new(
            "INVALID_COORDINATE",
            format!("coordinate ({x}, {y}) is invalid"),
            false,
        ));
    }
    Ok(())
}

fn point_of(params: &Value, key: &str) -> Result<crate::input::Point, ComputerError> {
    let value = params.get(key).ok_or_else(|| {
        ComputerError::new("INVALID_REQUEST", format!("missing {key}"), false)
    })?;
    let x = value.get("x").and_then(Value::as_i64).unwrap_or_default();
    let y = value.get("y").and_then(Value::as_i64).unwrap_or_default();
    if x < 0 || y < 0 {
        return Err(ComputerError::new(
            "INVALID_COORDINATE",
            format!("coordinate ({x}, {y}) is invalid"),
            false,
        ));
    }
    Ok(crate::input::Point { x: x as i32, y: y as i32 })
}
