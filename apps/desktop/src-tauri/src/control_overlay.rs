//! Computer Control 桌面 Overlay（屏幕边缘呼吸光 + 顶部状态条）。
//!
//! 状态事实链：Worker 在派发 Computer 动作时把操控状态写入数据库（migration 0096）
//! → API 提供只读端点 → 本模块轮询并翻译为桌面窗口表现。Overlay 只是 Observer：
//! 只画状态、转发 Esc；真正的输入控制与取消都走 API/Worker 的既有通道
//! （run_control_requests + Worker 100ms 控制轮询 + 杀 Computer Runtime）。
//!
//! 窗口形态：透明、无边框、置顶、跳过任务栏、`set_ignore_cursor_events` 点击穿透、
//! `WS_EX_NOACTIVATE` 不抢焦点——不阻挡鼠标键盘、不改变目标应用焦点。
//! 主线程只负责创建窗口（run_on_main_thread）；显示/隐藏/定位/注入状态都在
//! 轮询线程经 Tauri 的线程安全句柄完成。
//!
//! DPI 与多显示器：定位与尺寸一律使用物理像素（PhysicalPosition/PhysicalSize），
//! 跟随 `primary_monitor` 的实测值，不硬编码分辨率；显示器选择集中在一个函数，
//! 为后续「Overlay 跟随目标显示器」留扩展点。

use std::path::PathBuf;
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};

use crate::esc_hook::{self, EscWatcher};
use crate::http_loopback::request_loopback;

pub const OVERLAY_LABEL: &str = "computer-control-overlay";
const DEV_OVERLAY_URL: &str = "http://127.0.0.1:5173/overlay.html";
const POLL_ACTIVE_MS: u64 = 600;
const POLL_IDLE_MS: u64 = 2000;
const ESC_CANCEL_MIN_INTERVAL_MS: u64 = 1200;
const HIDE_AFTER_STOP_MS: u64 = 320;

#[derive(Serialize, PartialEq, Clone)]
struct OverlayStatePayload {
    state: String,
    action_type: Option<String>,
    action_label: Option<String>,
}

struct SessionSnapshot {
    state: String,
    action_type: Option<String>,
    action_label: Option<String>,
}

/// 启动 Overlay 管理线程；由 lib.rs setup 调用一次。
pub fn spawn(app: AppHandle, base_url: String, workspace_id: String, bearer_token: String) {
    let _ = thread::Builder::new().name("computer-control-overlay".into()).spawn(move || {
        run(app, base_url, workspace_id, bearer_token);
    });
}

fn run(app: AppHandle, base_url: String, workspace_id: String, bearer_token: String) {
    let mut visible = false;
    let mut esc: Option<EscWatcher> = None;
    let mut last_cancel_at = Instant::now() - Duration::from_millis(10_000);
    let mut last_payload = String::new();
    loop {
        // 活跃期 600ms（状态条文案要及时），空闲期 2s（轻量轮询）。
        thread::sleep(Duration::from_millis(if visible { POLL_ACTIVE_MS } else { POLL_IDLE_MS }));
        let Some(snapshot) = poll_once(&base_url, &workspace_id, &bearer_token) else { continue };
        let active = snapshot.state != "STOPPED";
        if active {
            // Esc 观测 → 转发为 API 取消（既有 Run 控制通道）；限流避免钩子抖动重发。
            if let Some(watcher) = &esc {
                if watcher.take_press().is_some()
                    && last_cancel_at.elapsed() >= Duration::from_millis(ESC_CANCEL_MIN_INTERVAL_MS) {
                    last_cancel_at = Instant::now();
                    let path = format!("{}/cancel", session_path(&workspace_id));
                    if let Err(error) = request_loopback(
                        extract_port(&base_url).unwrap_or(0), "POST", &path, &bearer_token) {
                        eprintln!("Relay control overlay: cancel request failed: {error}");
                    }
                }
            }
            ensure_window(&app);
            if esc.is_none() {
                esc = esc_hook::install();
            }
            if !visible {
                show_overlay(&app);
                visible = true;
                // 页面可能还停在上一轮的淡出表现：清空缓存强制重发一次状态。
                last_payload.clear();
            }
            send_state(&app, &snapshot, &mut last_payload);
        } else if visible {
            // STOPPED：让页面先淡出，再隐藏窗口（保留窗口实例，下次会话零重建成本）。
            send_state(&app, &snapshot, &mut last_payload);
            thread::sleep(Duration::from_millis(HIDE_AFTER_STOP_MS));
            if let Some(window) = app.get_webview_window(OVERLAY_LABEL) {
                let _ = window.hide();
            }
            visible = false;
            if let Some(watcher) = esc.take() {
                watcher.stop();
            }
        }
    }
}

fn poll_once(base_url: &str, workspace_id: &str, bearer: &str) -> Option<SessionSnapshot> {
    let port = extract_port(base_url)?;
    let response = request_loopback(port, "GET", &session_path(workspace_id), bearer).ok()?;
    if response.status != 200 { return None; }
    parse_session(&response.body)
}

fn session_path(workspace_id: &str) -> String {
    format!("/api/v1/workspaces/{workspace_id}/computer/control-session")
}

fn extract_port(base_url: &str) -> Option<u16> {
    base_url.rsplit(':').next()?.parse().ok()
}

fn parse_session(body: &str) -> Option<SessionSnapshot> {
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    let state = value.get("state")?.as_str()?.to_string();
    if !matches!(state.as_str(), "RUNNING" | "STOP_REQUESTED" | "STOPPED") {
        return None;
    }
    Some(SessionSnapshot {
        state,
        action_type: value.get("action_type").and_then(|v| v.as_str()).map(str::to_string),
        action_label: value.get("action_label").and_then(|v| v.as_str()).map(str::to_string),
    })
}

fn ensure_window(app: &AppHandle) {
    if app.get_webview_window(OVERLAY_LABEL).is_some() { return; }
    // 窗口创建必须在主线程：轮询线程经 run_on_main_thread 派发；窗口已存在时本函数
    // 早退，不会反复派发。
    let app_for_main = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Err(error) = build_window(&app_for_main) {
            eprintln!("Relay control overlay: {error}");
        }
    });
}

fn build_window(app: &AppHandle) -> Result<(), String> {
    if app.get_webview_window(OVERLAY_LABEL).is_some() { return Ok(()); }
    let url = if tauri::is_dev() {
        WebviewUrl::External(DEV_OVERLAY_URL.parse()
            .map_err(|error| format!("invalid overlay dev url: {error}"))?)
    } else {
        // 打包产物：frontendDist（workbench/dist）下的独立轻量页面，不加载工作台 SPA。
        WebviewUrl::App(PathBuf::from("overlay.html"))
    };
    WebviewWindowBuilder::new(app, OVERLAY_LABEL, url)
        .title("Relay Control Overlay")
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .focused(false)
        .visible(false)
        .shadow(false)
        .build()
        .map_err(|error| format!("overlay window build failed: {error}"))?;
    Ok(())
}

/// 显示前定位：跟随主显示器的物理像素矩形（任意 DPI / 分辨率都正确）。
/// 多显示器扩展点：替换 select_target_monitor 即可让 Overlay 跟随目标显示器。
fn show_overlay(app: &AppHandle) {
    let Some(window) = app.get_webview_window(OVERLAY_LABEL) else { return };
    if let Ok(Some(monitor)) = select_target_monitor(app) {
        let _ = window.set_position(PhysicalPosition::new(monitor.position().x, monitor.position().y));
        let _ = window.set_size(PhysicalSize::new(monitor.size().width, monitor.size().height));
    }
    let _ = window.set_ignore_cursor_events(true);
    apply_click_through_and_no_activate(&window);
    let _ = window.show();
}

#[allow(unused_variables)]
fn select_target_monitor(app: &AppHandle) -> Result<Option<tauri::Monitor>, tauri::Error> {
    // 当前只支持主屏；不为这次 UI 重构多显示器系统，但选择逻辑只在这一处。
    app.primary_monitor()
}

/// 双保险：窗口级 WS_EX_TRANSPARENT/WS_EX_LAYERED（点击穿透）+ WS_EX_NOACTIVATE
/// （show 也不抢前台焦点）+ WS_EX_TOOLWINDOW（不出现在 Alt-Tab）。
#[cfg(windows)]
fn apply_click_through_and_no_activate(window: &tauri::WebviewWindow) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        GWL_EXSTYLE, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT,
    };
    let Ok(handle) = window.hwnd() else { return };
    let hwnd = HWND(handle.0);
    let extra = (WS_EX_LAYERED.0 | WS_EX_TRANSPARENT.0 | WS_EX_NOACTIVATE.0
        | WS_EX_TOOLWINDOW.0) as usize;
    unsafe {
        #[cfg(target_pointer_width = "64")]
        {
            use windows::Win32::UI::WindowsAndMessaging::{GetWindowLongPtrW, SetWindowLongPtrW};
            let current = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as usize;
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, (current | extra) as isize);
        }
        #[cfg(not(target_pointer_width = "64"))]
        {
            use windows::Win32::UI::WindowsAndMessaging::{GetWindowLongW, SetWindowLongW};
            let current = GetWindowLongW(hwnd, GWL_EXSTYLE) as usize;
            SetWindowLongW(hwnd, GWL_EXSTYLE, (current | extra) as i32);
        }
    }
}

#[cfg(not(windows))]
fn apply_click_through_and_no_activate(_window: &tauri::WebviewWindow) {}

fn send_state(app: &AppHandle, snapshot: &SessionSnapshot, last_payload: &mut String) {
    let payload = OverlayStatePayload {
        state: snapshot.state.clone(),
        action_type: snapshot.action_type.clone(),
        action_label: snapshot.action_label.clone(),
    };
    let Ok(json) = serde_json::to_string(&payload) else { return };
    // 状态不变不写 DOM（页面内部也有签名去重，双保险）。
    if *last_payload == json { return; }
    *last_payload = json.clone();
    if let Some(window) = app.get_webview_window(OVERLAY_LABEL) {
        let script = format!(
            "window.__relayControlOverlayState && window.__relayControlOverlayState({json});");
        if let Err(error) = window.eval(&script) {
            eprintln!("Relay control overlay: push state failed: {error}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_port_reads_last_segment() {
        assert_eq!(extract_port("http://127.0.0.1:32123"), Some(32123));
        assert_eq!(extract_port("http://127.0.0.1"), None);
        assert_eq!(extract_port("http://127.0.0.1:notaport"), None);
    }

    #[test]
    fn session_path_is_scoped() {
        assert_eq!(session_path("ws-1"),
            "/api/v1/workspaces/ws-1/computer/control-session");
    }

    #[test]
    fn parse_session_accepts_known_states_and_fields() {
        let parsed = parse_session(r#"{"state":"RUNNING","action_type":"COMPUTER_CLICK",
            "action_label":"正在点击 (12, 34)","run_id":"r","started_at":null,"updated_at":null}"#)
            .expect("valid payload parses");
        assert_eq!(parsed.state, "RUNNING");
        assert_eq!(parsed.action_type.as_deref(), Some("COMPUTER_CLICK"));
        assert_eq!(parsed.action_label.as_deref(), Some("正在点击 (12, 34)"));
        let stopped = parse_session(r#"{"state":"STOPPED","action_type":null,
            "action_label":null,"run_id":null,"started_at":null,"updated_at":null}"#)
            .expect("stopped parses");
        assert_eq!(stopped.action_label, None);
        assert!(parse_session(r#"{"state":"SOMETHING"}"#).is_none(), "未知状态拒绝");
        assert!(parse_session("not json").is_none());
    }
}
