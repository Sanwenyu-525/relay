//! Relay Computer Runtime — the isolated native helper for Windows computer use.
//!
//! Process shape: persistent JSON-lines loop over stdin/stdout (same discipline as
//! the packaged relay-file-io-helper). The API side spawns it lazily, correlates
//! replies by `request_id`, and kills it when idle. The runtime itself is
//! stateless per request: nothing is cached between calls, so a crash costs one
//! respawn and never a half-applied action.

pub mod capture;
pub mod environment;
pub mod input;
pub mod mock;
pub mod protocol;
pub mod screenshot;
pub mod window;

use capture::CaptureTarget;
use protocol::{codes, ComputerError, ComputerReply, ComputerRequest, PROTOCOL_VERSION,
  FOREGROUND_INPUT_METHODS};
use serde_json::{json, Value};

/// Dispatches one request. Pure function: all platform access goes through the
/// providers, which is what makes mock mode and unit tests possible.
pub fn handle_request(request: &ComputerRequest) -> ComputerReply {
    handle_request_with_mode(request, mock::is_mock_mode())
}

/// Explicit-mode variant: tests and mock drills never depend on ambient env.
pub fn handle_request_with_mode(request: &ComputerRequest, mock: bool) -> ComputerReply {
    let result = dispatch(request, mock);
    match result {
        Ok(value) => ComputerReply {
            version: PROTOCOL_VERSION,
            request_id: request.request_id.clone(),
            success: true,
            result: Some(value),
            error: None,
        },
        Err(error) => ComputerReply {
            version: PROTOCOL_VERSION,
            request_id: request.request_id.clone(),
            success: false,
            result: None,
            error: Some(protocol::ComputerErrorBody {
                code: error.code.to_string(),
                message: error.message,
                retryable: error.retryable,
            }),
        },
    }
}

fn dispatch(request: &ComputerRequest, mock: bool) -> Result<Value, ComputerError> {
    if request.version != PROTOCOL_VERSION {
        return Err(protocol::invalid_request(format!(
            "unsupported protocol version {:?}; expected {PROTOCOL_VERSION}",
            request.version
        )));
    }
    if request.request_id.trim().is_empty() {
        return Err(protocol::invalid_request("request_id must not be empty"));
    }
    if !protocol::METHODS.contains(&request.method.as_str()) {
        return Err(protocol::invalid_request(format!(
            "unknown method {:?}",
            request.method
        )));
    }
    let params = &request.params;
    // V2 硬闸门：在用户当前桌面产生输入的方法必须带显式前台授权。
    // 这条检查在 mock 之前：mock 也要模拟这条契约（V2 §32）。
    if FOREGROUND_INPUT_METHODS.contains(&request.method.as_str()) &&
        params.get("allow_foreground").and_then(Value::as_bool) != Some(true) {
        return Err(ComputerError::new(
            codes::FOREGROUND_NOT_AUTHORIZED,
            format!(
                "{} 会在用户当前桌面产生输入；必须由调用方在用户授权后显式传 allow_foreground=true。\
                 后台路径不可用时不允许静默降级到用户桌面。",
                request.method
            ),
            false,
        ));
    }
    match request.method.as_str() {
        "computer.describe_environment" => {
            if mock {
                return mock::mock_environment();
            }
            Ok(environment::describe())
        }
        "computer.screenshot" => {
            let target = match params.get("target") {
                None | Some(Value::Null) => CaptureTarget::UserDesktop,
                Some(value) => CaptureTarget::parse(value.as_str().unwrap_or_default())?,
            };
            if mock {
                return mock::mock_screenshot_for(target);
            }
            let shot = target.capture(params.get("window_id").and_then(Value::as_str))?;
            Ok(json!({
                "type": "computer_screenshot",
                "target": target.name(),
                "image": screenshot::base64_encode(&shot.png),
                "width": shot.width,
                "height": shot.height,
                "origin_x": shot.origin_x,
                "origin_y": shot.origin_y,
                "timestamp": now_millis(),
            }))
        }
        "computer.get_windows" => {
            if mock {
                return mock::mock_windows();
            }
            let windows = window::list_windows()?;
            Ok(json!({
                "windows": windows.iter().map(window_value).collect::<Vec<_>>(),
            }))
        }
        "computer.activate_window" => {
            let window_id = string_param(params, "window_id")?;
            if mock {
                return mock::mock_activate(&window_id);
            }
            let info = window::activate_window(&window_id)?;
            Ok(window_value(&info))
        }
        "computer.click" => {
            let point = point_param(params)?;
            let button = match string_opt(params, "button")?.as_deref() {
                None | Some("left") => input::MouseButton::Left,
                Some("right") => input::MouseButton::Right,
                Some("middle") => input::MouseButton::Middle,
                Some(other) => {
                    return Err(protocol::invalid_request(format!(
                        "unsupported button {other:?}; expected left/right/middle"
                    )))
                }
            };
            if mock {
                return mock::mock_click(params);
            }
            input::click(button, point)?;
            Ok(json!({ "clicked": true, "x": point.x, "y": point.y, "button": button_name(button) }))
        }
        "computer.double_click" => {
            let point = point_param(params)?;
            if mock {
                return mock::mock_click(params);
            }
            input::double_click(point)?;
            Ok(json!({ "double_clicked": true, "x": point.x, "y": point.y }))
        }
        "computer.scroll" => {
            let (dx, dy) = scroll_params(params)?;
            if mock {
                return mock::mock_scroll(params);
            }
            input::scroll(dx, dy)?;
            Ok(json!({ "scrolled": true, "delta_x": dx, "delta_y": dy }))
        }
        "computer.drag" => {
            let start = point_at(params, "start")?;
            let end = point_at(params, "end")?;
            let duration = params
                .get("duration_ms")
                .and_then(Value::as_u64)
                .unwrap_or(300)
                .min(10_000) as u32;
            if mock {
                return mock::mock_drag(params);
            }
            input::drag(start, end, duration)?;
            Ok(json!({ "dragged": true, "start": { "x": start.x, "y": start.y },
                "end": { "x": end.x, "y": end.y }, "duration_ms": duration }))
        }
        "computer.type" => {
            let text = string_param(params, "text")?;
            // delay_ms 是可靠性参数（见 input::DEFAULT_TYPE_DELAY_MS）：字符间隔，
            // 1..=100 毫秒可调，缺省 30。非法值按 INVALID_REQUEST 拒绝，不静默取默认。
            let delay_ms = match params.get("delay_ms") {
                None | Some(Value::Null) => input::DEFAULT_TYPE_DELAY_MS,
                Some(value) => {
                    let raw = value.as_u64().ok_or_else(|| protocol::invalid_request(
                        "delay_ms must be an integer between 1 and 100"))?;
                    if raw < 1 || raw > 100 {
                        return Err(protocol::invalid_request(
                            "delay_ms must be an integer between 1 and 100"));
                    }
                    raw
                }
            };
            if mock {
                return mock::mock_type(params);
            }
            let units = input::type_text(&text, delay_ms)?;
            Ok(json!({ "typed": true, "length": units }))
        }
        "computer.keypress" => {
            let key = string_param(params, "key")?;
            if mock {
                return mock::mock_keypress(params);
            }
            input::keypress(&key)?;
            Ok(json!({ "pressed": true, "key": key }))
        }
        "computer.hotkey" => {
            let keys = string_list(params, "keys")?;
            if mock {
                return mock::mock_hotkey(params);
            }
            input::hotkey(&keys)?;
            Ok(json!({ "pressed": true, "keys": keys }))
        }
        _ => Err(protocol::invalid_request(format!(
            "method {:?} is declared but not implemented",
            request.method
        ))),
    }
}

fn window_value(info: &window::WindowInfo) -> Value {
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

fn button_name(button: input::MouseButton) -> &'static str {
    match button {
        input::MouseButton::Left => "left",
        input::MouseButton::Right => "right",
        input::MouseButton::Middle => "middle",
    }
}

fn string_param(params: &Value, key: &str) -> Result<String, ComputerError> {
    params
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| protocol::invalid_request(format!("missing string parameter {key:?}")))
}

fn string_opt(params: &Value, key: &str) -> Result<Option<String>, ComputerError> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        Some(_) => Err(protocol::invalid_request(format!(
            "parameter {key:?} must be a string"
        ))),
    }
}

fn string_list(params: &Value, key: &str) -> Result<Vec<String>, ComputerError> {
    let value = params
        .get(key)
        .ok_or_else(|| protocol::invalid_request(format!("missing parameter {key:?}")))?;
    let array = value
        .as_array()
        .ok_or_else(|| protocol::invalid_request(format!("parameter {key:?} must be an array")))?;
    if array.is_empty() {
        return Err(protocol::invalid_request(format!("parameter {key:?} must not be empty")));
    }
    array
        .iter()
        .map(|item| {
            item.as_str()
                .map(str::to_string)
                .ok_or_else(|| protocol::invalid_request(format!("parameter {key:?} must contain strings")))
        })
        .collect()
}

fn point_param(params: &Value) -> Result<input::Point, ComputerError> {
    point_at(params, "")
}

fn point_at(params: &Value, key: &str) -> Result<input::Point, ComputerError> {
    let (x, y) = if key.is_empty() {
        (
            params.get("x").and_then(Value::as_i64),
            params.get("y").and_then(Value::as_i64),
        )
    } else {
        let nested = params
            .get(key)
            .ok_or_else(|| protocol::invalid_request(format!("missing parameter {key:?}")))?;
        (
            nested.get("x").and_then(Value::as_i64),
            nested.get("y").and_then(Value::as_i64),
        )
    };
    let x = x.ok_or_else(|| protocol::invalid_request("missing integer parameter x"))?;
    let y = y.ok_or_else(|| protocol::invalid_request("missing integer parameter y"))?;
    if x < i64::from(i32::MIN) || x > i64::from(i32::MAX) || y < i64::from(i32::MIN)
        || y > i64::from(i32::MAX)
    {
        return Err(protocol::invalid_request(format!(
            "coordinate ({x}, {y}) is out of range"
        )));
    }
    Ok(input::Point { x: x as i32, y: y as i32 })
}

fn scroll_params(params: &Value) -> Result<(i32, i32), ComputerError> {
    let dx = params.get("delta_x").and_then(Value::as_i64).unwrap_or(0);
    let dy = params.get("delta_y").and_then(Value::as_i64).unwrap_or(0);
    if dx.abs() > 1_000_000 || dy.abs() > 1_000_000 {
        return Err(protocol::invalid_request("scroll deltas are out of range"));
    }
    Ok((dx as i32, dy as i32))
}

/// Wall-clock milliseconds; screenshots record when they were taken.
pub fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

/// Error code table guard: the frozen vocabulary is asserted by tests.
pub fn is_known_code(code: &str) -> bool {
    matches!(
        code,
        codes::INVALID_REQUEST
            | codes::RUNTIME_UNAVAILABLE
            | codes::SCREENSHOT_FAILED
            | codes::WINDOW_NOT_FOUND
            | codes::WINDOW_ACTIVATION_FAILED
            | codes::INVALID_COORDINATE
            | codes::INPUT_FAILED
            | codes::PERMISSION_DENIED
            | codes::USER_CANCELLED
            | codes::TIMEOUT
            | codes::FOREGROUND_NOT_AUTHORIZED
            | codes::ISOLATED_SESSION_UNAVAILABLE
            | codes::CAPTURE_TARGET_UNAVAILABLE
            | codes::UNKNOWN
    )
}
