//! Computer Runtime wire protocol (relay-computer-v1).
//!
//! The runtime is a persistent native helper process: one JSON request per line on
//! stdin, one JSON reply per line on stdout, correlated by `request_id`. Shape and
//! validation discipline follow the packaged `relay-file-io-helper` precedent:
//! a pinned version tag, strictly validated replies, and no silent success.

use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: &str = "relay-computer-v1";

/// One inbound request line.
#[derive(Debug, Clone, Deserialize)]
pub struct ComputerRequest {
    pub version: String,
    pub request_id: String,
    pub method: String,
    #[serde(default)]
    pub params: serde_json::Value,
}

/// One outbound reply line. `success=false` always carries a typed error.
#[derive(Debug, Clone, Serialize)]
pub struct ComputerReply {
    pub version: &'static str,
    pub request_id: String,
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ComputerErrorBody>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ComputerErrorBody {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

/// Typed runtime failure. Codes are part of the frozen contract with the API.
#[derive(Debug, Clone)]
pub struct ComputerError {
    pub code: &'static str,
    pub message: String,
    pub retryable: bool,
}

impl ComputerError {
    pub fn new(code: &'static str, message: impl Into<String>, retryable: bool) -> Self {
        Self { code, message: message.into(), retryable }
    }
}

impl std::fmt::Display for ComputerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl From<ComputerError> for ComputerReply {
    fn from(error: ComputerError) -> Self {
        ComputerReply {
            version: PROTOCOL_VERSION,
            request_id: String::new(),
            success: false,
            result: None,
            error: Some(ComputerErrorBody {
                code: error.code.to_string(),
                message: error.message,
                retryable: error.retryable,
            }),
        }
    }
}

/// Frozen error-code vocabulary (docs: computer-plugin-v1.md §2、V2 §17).
pub mod codes {
    pub const INVALID_REQUEST: &str = "INVALID_REQUEST";
    pub const RUNTIME_UNAVAILABLE: &str = "RUNTIME_UNAVAILABLE";
    pub const SCREENSHOT_FAILED: &str = "SCREENSHOT_FAILED";
    pub const WINDOW_NOT_FOUND: &str = "WINDOW_NOT_FOUND";
    pub const WINDOW_ACTIVATION_FAILED: &str = "WINDOW_ACTIVATION_FAILED";
    pub const INVALID_COORDINATE: &str = "INVALID_COORDINATE";
    pub const INPUT_FAILED: &str = "INPUT_FAILED";
    pub const PERMISSION_DENIED: &str = "PERMISSION_DENIED";
    pub const USER_CANCELLED: &str = "USER_CANCELLED";
    pub const TIMEOUT: &str = "TIMEOUT";
    pub const UNKNOWN: &str = "UNKNOWN";
    /// V2：桌面输入必须带显式前台授权；缺失即拒绝，绝不静默降级。
    pub const FOREGROUND_NOT_AUTHORIZED: &str = "FOREGROUND_NOT_AUTHORIZED";
    /// V2：需要独立工作区但子会话不可用（禁止回退到用户桌面）。
    pub const ISOLATED_SESSION_UNAVAILABLE: &str = "ISOLATED_SESSION_UNAVAILABLE";
    /// V2：请求的截图目标在当前环境不可获得（如浏览器页、独立工作区）。
    pub const CAPTURE_TARGET_UNAVAILABLE: &str = "CAPTURE_TARGET_UNAVAILABLE";
}

pub fn invalid_request(message: impl Into<String>) -> ComputerError {
    ComputerError::new(codes::INVALID_REQUEST, message, false)
}

pub fn unknown_error(message: impl Into<String>) -> ComputerError {
    ComputerError::new(codes::UNKNOWN, message, false)
}

/// The frozen tool/method names: V1 的十个动作 + V2 的鼠标移动与环境探测。
pub const METHODS: &[&str] = &[
    "computer.screenshot",
    "computer.get_windows",
    "computer.activate_window",
    "computer.move",
    "computer.click",
    "computer.double_click",
    "computer.scroll",
    "computer.drag",
    "computer.type",
    "computer.keypress",
    "computer.hotkey",
    "computer.describe_environment",
];

/// V2：在**用户当前桌面**上产生输入的方法。它们默认不执行，
/// 必须由调用方显式传 `allow_foreground: true`（该授权由 Gateway 审批后才会带上）。
///
/// `computer.move` 也在此表内：移动光标虽然不产生点击，但会改变用户桌面的当前
/// 指针位置，后续的滚动/拖拽都以它为前提，因此同样需要显式授权。
pub const FOREGROUND_INPUT_METHODS: &[&str] = &[
    "computer.activate_window",
    "computer.move",
    "computer.click",
    "computer.double_click",
    "computer.scroll",
    "computer.drag",
    "computer.type",
    "computer.keypress",
    "computer.hotkey",
];
