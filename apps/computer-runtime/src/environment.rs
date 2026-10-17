//! 环境与执行能力探测（V2 Phase 2）。
//!
//! 只报告**实测到的事实**，不用「理论上支持」代替结果：
//!   * DPI 感知状态（V2 坐标空间一致性的前提）；
//!   * 显示器与虚拟屏（物理坐标，DPI 修复之后）；
//!   * Windows Child Session 的真实状态（启用 / 是否已有子会话）；
//!   * UI Automation 客户端库是否可加载（完整 provider 属 Phase 4）。
//!
//! `mode_availability` 是执行路由的输入：后台（Browser/UIA）与独立会话（Child Session）
//! 在本阶段分别标记为未实现/是否可用；`foreground` 永远是「需要用户授权」。
//! **任何一条路径不可用都不构成回退理由**——回退决定权在 API 侧路由，不在运行时。

use serde_json::{json, Value};

/// 进程启动时把自己设为 per-monitor DPI aware V2。
///
/// 必须在任何窗口度量/截图之前调用：否则虚拟屏、窗口矩形、SendInput 归一化坐标
/// 都基于 DPI 虚拟化视图，与 UIA（per-monitor 物理坐标）不一致，
/// 「截图坐标 → 元素坐标 → 点击坐标」会互相错位（见 V2 审查 §6.3）。
/// 失败不致命（老系统可能不支持 V2），但要如实报告实际生效的感知级别。
#[cfg(windows)]
pub fn initialize_dpi_awareness() -> &'static str {
    use windows_sys::Win32::UI::HiDpi::{
        SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
    };
    let ok = unsafe { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
    if ok != 0 {
        return "PER_MONITOR_AWARE_V2";
    }
    // 退回系统默认（进程外部清单或系统缩放）；如实报告，不假装成功。
    "DEFAULT_OR_OLDER"
}

#[cfg(not(windows))]
pub fn initialize_dpi_awareness() -> &'static str {
    "NOT_APPLICABLE"
}

/// 探测结果：调用方（API 侧）不应缓存超过一次会话的时长。
pub fn describe() -> Value {
    json!({
        "platform": "windows",
        "dpi_awareness": current_dpi_awareness(),
        "virtual_screen": virtual_screen(),
        "monitors": monitors(),
        "child_session": child_session(),
        "ui_automation": ui_automation(),
        "mode_availability": mode_availability(),
    })
}

/// 进程启动时记录的实际 DPI 感知级别（由 main 写入，避免重复探测）。
#[cfg(windows)]
static DPI_AWARENESS: std::sync::OnceLock<String> = std::sync::OnceLock::new();

#[cfg(windows)]
pub fn record_dpi_awareness(value: &str) {
    let _ = DPI_AWARENESS.set(value.to_string());
}

fn current_dpi_awareness() -> String {
    #[cfg(windows)]
    {
        DPI_AWARENESS.get().cloned().unwrap_or_else(|| "UNKNOWN".to_string())
    }
    #[cfg(not(windows))]
    {
        "NOT_APPLICABLE".to_string()
    }
}

fn virtual_screen() -> Value {
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
            SM_YVIRTUALSCREEN,
        };
        json!({
            "x": GetSystemMetrics(SM_XVIRTUALSCREEN),
            "y": GetSystemMetrics(SM_YVIRTUALSCREEN),
            "width": GetSystemMetrics(SM_CXVIRTUALSCREEN),
            "height": GetSystemMetrics(SM_CYVIRTUALSCREEN),
        })
    }
    #[cfg(not(windows))]
    {
        Value::Null
    }
}

/// 每个显示器的物理矩形（DPI 修复之后与 UIA 的坐标同源）。
fn monitors() -> Value {
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::Foundation::{LPARAM, RECT, TRUE};
        use windows_sys::Win32::Graphics::Gdi::{
            EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFO,
        };
        use windows_sys::core::BOOL;

        struct Collected {
            monitors: Vec<Value>,
        }

        unsafe extern "system" fn collect(
            monitor: HMONITOR,
            _hdc: HDC,
            _rect: *mut RECT,
            lparam: LPARAM,
        ) -> BOOL {
            unsafe {
                let state = &mut *(lparam as *mut Collected);
                let mut info: MONITORINFO = std::mem::zeroed();
                info.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
                if GetMonitorInfoW(monitor, &mut info) == 0 {
                    return TRUE;
                }
                state.monitors.push(json!({
                    "x": info.rcMonitor.left,
                    "y": info.rcMonitor.top,
                    "width": info.rcMonitor.right - info.rcMonitor.left,
                    "height": info.rcMonitor.bottom - info.rcMonitor.top,
                    "primary": info.dwFlags & 1 != 0,
                }));
                TRUE
            }
        }

        let mut state = Collected { monitors: Vec::new() };
        let enumerated = EnumDisplayMonitors(
            std::ptr::null_mut(),
            std::ptr::null(),
            Some(collect),
            &mut state as *mut Collected as LPARAM,
        );
        if enumerated == 0 {
            return Value::Null;
        }
        Value::Array(state.monitors)
    }
    #[cfg(not(windows))]
    {
        Value::Null
    }
}

/// Windows Child Session 的真实状态。
///
/// `enabled` = 系统级开关（WTSIsChildSessionsEnabled）；
/// `available` = 当前是否**确实存在**一个已连接的子会话（WTSGetChildSessionId 成功）。
/// 只有 available 为真，独立工作区才可能已经就绪；能否**创建并连入**子会话
/// 属 Phase 5 的连接实测范围，本探测不代它下结论。
fn child_session() -> Value {
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::System::RemoteDesktop::{
            WTSGetChildSessionId, WTSIsChildSessionsEnabled,
        };
        let mut enabled: windows_sys::core::BOOL = 0;
        let enabled_ok = WTSIsChildSessionsEnabled(&mut enabled) != 0;
        let mut session_id: u32 = 0;
        let session_ok = WTSGetChildSessionId(&mut session_id) != 0;
        json!({
            "enabled": enabled_ok && enabled != 0,
            "enabled_query_ok": enabled_ok,
            "available": session_ok,
            "session_id": if session_ok { json!(session_id) } else { Value::Null },
        })
    }
    #[cfg(not(windows))]
    {
        json!({ "enabled": false, "enabled_query_ok": false, "available": false, "session_id": Value::Null })
    }
}

/// UIA 客户端库是否可加载。完整 provider（树遍历、Pattern 调用）属 Phase 4。
fn ui_automation() -> Value {
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::System::LibraryLoader::{GetModuleHandleW, LoadLibraryW};
        let name: Vec<u16> = "UIAutomationCore.dll\0".encode_utf16().collect();
        let module = LoadLibraryW(name.as_ptr());
        let loadable = !module.is_null();
        // 已加载过就不用再持有引用；库由系统常驻。
        let already = !GetModuleHandleW(name.as_ptr()).is_null();
        json!({
            "client_library_loadable": loadable,
            "provider_implemented": false,
            "already_loaded": already,
        })
    }
    #[cfg(not(windows))]
    {
        json!({ "client_library_loadable": false, "provider_implemented": false, "already_loaded": false })
    }
}

/// 执行模式的可用性摘要（执行路由的输入）。
///
/// 语义严格：
///   * `background`：Browser/CDP 与 UIA 都还没有实现，因此 `unavailable`——
///     **这不是「暂时失败、可回退」**，而是「当前没有后台执行路径」；
///   * `isolated`：只有子会话确实可用时才是 `available`；
///   * `foreground`：永远 `requires_user_authorization`，不存在自动进入。
fn mode_availability() -> Value {
    let child = child_session();
    let isolated_available = child["available"].as_bool().unwrap_or(false);
    json!({
        "background": {
            "status": "unavailable",
            "browser_cdp": "not_configured",
            "ui_automation": "provider_not_implemented",
        },
        "isolated": {
            "status": if isolated_available { "available" } else { "unavailable" },
            "reason": if isolated_available { Value::Null }
                else { json!("child session is enabled at system level but no connected child session exists (creation/connection is Phase 5 work)") },
        },
        "foreground": {
            "status": "requires_user_authorization",
        },
    })
}
