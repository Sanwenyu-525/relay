//! 截图目标抽象（V2 Phase 2 / §12）。
//!
//! V1 的 `computer.screenshot` 只能截「用户当前桌面」。V2 把它拆成显式目标：
//!
//! * `user_desktop`——用户当前桌面（需要读取权限；默认目标，因为代理会话尚未落地）；
//! * `window`——指定窗口区域（需要 `window_id`）；
//! * `agent_session`——Agent 独立工作区（需要子会话，当前不可用 → 明确拒绝）；
//! * `browser_page`——浏览器页面（需要浏览器适配器，尚未实现 → 明确拒绝）。
//!
//! 后两者在本阶段**不可用即拒绝**：不悄悄退回整屏桌面截图。等 Phase 4/5 落地后，
//! 它们各自接上 provider；路由侧（API）负责在拒绝时给出可读原因与后续动作。

use crate::protocol::{codes, ComputerError};
use crate::screenshot::{capture_region, capture_virtual_screen, Screenshot};
use crate::window;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaptureTarget {
    UserDesktop,
    Window,
    AgentSession,
    BrowserPage,
}

impl CaptureTarget {
    pub fn parse(value: &str) -> Result<Self, ComputerError> {
        match value {
            "" | "user_desktop" => Ok(Self::UserDesktop),
            "window" => Ok(Self::Window),
            "agent_session" => Ok(Self::AgentSession),
            "browser_page" => Ok(Self::BrowserPage),
            other => Err(ComputerError::new(
                codes::INVALID_REQUEST,
                format!(
                    "unknown capture target {other:?}; expected user_desktop/window/agent_session/browser_page"
                ),
                false,
            )),
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::UserDesktop => "user_desktop",
            Self::Window => "window",
            Self::AgentSession => "agent_session",
            Self::BrowserPage => "browser_page",
        }
    }

    /// 真实截图。不可用的目标返回类型化错误，绝不退化成整屏桌面。
    pub fn capture(self, window_id: Option<&str>) -> Result<Screenshot, ComputerError> {
        match self {
            Self::UserDesktop => capture_virtual_screen(),
            Self::Window => {
                let id = window_id.ok_or_else(|| ComputerError::new(
                    codes::INVALID_REQUEST,
                    "capture target 'window' requires window_id",
                    false,
                ))?;
                let info = window::window_state_by_id(id)?;
                if info.width <= 0 || info.height <= 0 {
                    return Err(ComputerError::new(
                        codes::CAPTURE_TARGET_UNAVAILABLE,
                        format!("window {id} has no capturable area ({}x{})", info.width, info.height),
                        true,
                    ));
                }
                capture_region(info.x, info.y, info.width, info.height)
            }
            Self::AgentSession => Err(ComputerError::new(
                codes::ISOLATED_SESSION_UNAVAILABLE,
                "capture target 'agent_session' requires an isolated Agent workspace; \
                 no connected child session is available. Isolated workspace creation is \
                 not implemented yet — this does not fall back to the user desktop.",
                false,
            )),
            Self::BrowserPage => Err(ComputerError::new(
                codes::CAPTURE_TARGET_UNAVAILABLE,
                "capture target 'browser_page' requires the browser adapter (not implemented).",
                false,
            )),
        }
    }
}
