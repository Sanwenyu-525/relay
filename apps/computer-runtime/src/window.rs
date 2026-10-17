//! WindowProvider (Windows): enumerate, inspect and activate top-level windows.

use crate::protocol::{codes, ComputerError};

#[derive(Debug, Clone)]
pub struct WindowInfo {
    /// Stable string form of the HWND; valid for the window's process lifetime.
    pub id: String,
    pub title: String,
    pub process_name: Option<String>,
    pub process_id: u32,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub visible: bool,
    pub focused: bool,
}

#[cfg(windows)]
type RawWindow = windows_sys::Win32::Foundation::HWND;

#[cfg(windows)]
fn raw_address(hwnd: RawWindow) -> usize {
    hwnd as usize
}

#[cfg(windows)]
pub fn list_windows() -> Result<Vec<WindowInfo>, ComputerError> {
    use windows_sys::Win32::Foundation::{HWND, LPARAM};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetForegroundWindow, GetWindowLongPtrW, GetWindowRect, GetWindowTextW,
        GetWindowThreadProcessId, IsIconic, IsWindowVisible, GWL_EXSTYLE, GWL_STYLE,
        WS_EX_TOOLWINDOW,
    };

    struct Collected {
        windows: Vec<WindowInfo>,
        foreground: usize,
    }

    unsafe extern "system" fn collect(hwnd: HWND, lparam: LPARAM) -> i32 {
        unsafe {
            let state = &mut *(lparam as *mut Collected);
            if IsWindowVisible(hwnd) == 0 {
                return 1;
            }
            let mut title = [0u16; 512];
            let len = GetWindowTextW(hwnd, title.as_mut_ptr(), title.len() as i32);
            if len <= 0 {
                return 1;
            }
            let ex_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
            if ex_style & WS_EX_TOOLWINDOW != 0 {
                return 1;
            }
            let style = GetWindowLongPtrW(hwnd, GWL_STYLE) as u32;
            // A window without a caption cannot be meaningfully activated.
            const WS_CAPTION: u32 = 0x00C0_0000;
            if style & WS_CAPTION == 0 && IsIconic(hwnd) == 0 {
                return 1;
            }
            let mut rect = std::mem::zeroed();
            if GetWindowRect(hwnd, &mut rect) == 0 {
                return 1;
            }
            let mut process_id: u32 = 0;
            GetWindowThreadProcessId(hwnd, &mut process_id);
            state.windows.push(WindowInfo {
                id: raw_address(hwnd).to_string(),
                title: String::from_utf16_lossy(&title[..len as usize]),
                process_name: process_name_of(process_id),
                process_id,
                x: rect.left,
                y: rect.top,
                width: rect.right - rect.left,
                height: rect.bottom - rect.top,
                visible: true,
                focused: raw_address(hwnd) == state.foreground,
            });
            1
        }
    }

    unsafe {
        let mut state = Collected { windows: Vec::new(), foreground: raw_address(GetForegroundWindow()) };
        let enumerated = EnumWindows(Some(collect), &mut state as *mut Collected as LPARAM);
        if enumerated == 0 {
            return Err(ComputerError::new(codes::WINDOW_NOT_FOUND, "EnumWindows failed", true));
        }
        // Enumeration order is z-order (front to back); keep it, it is actionable.
        Ok(state.windows)
    }
}

#[cfg(windows)]
fn process_name_of(process_id: u32) -> Option<String> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process_id);
        if handle.is_null() {
            return None;
        }
        let mut buffer = [0u16; 260];
        let mut size = buffer.len() as u32;
        let ok = QueryFullProcessImageNameW(handle, 0, buffer.as_mut_ptr(), &mut size);
        CloseHandle(handle);
        if ok == 0 || size == 0 {
            return None;
        }
        let path = String::from_utf16_lossy(&buffer[..size as usize]);
        path.rsplit(['\\', '/']).next().map(str::to_string)
    }
}

#[cfg(windows)]
pub fn window_state_by_id(window_id: &str) -> Result<WindowInfo, ComputerError> {
    use windows_sys::Win32::UI::WindowsAndMessaging::IsWindow;
    unsafe {
        let hwnd = hwnd_from_id(window_id)?;
        if IsWindow(hwnd) == 0 {
            return Err(ComputerError::new(
                codes::WINDOW_NOT_FOUND,
                format!("window {window_id} no longer exists"),
                true,
            ));
        }
        window_state(hwnd)
    }
}

#[cfg(not(windows))]
pub fn window_state_by_id(_window_id: &str) -> Result<WindowInfo, ComputerError> {
    Err(ComputerError::new(
        codes::RUNTIME_UNAVAILABLE,
        "real window inspection requires Windows",
        false,
    ))
}

#[cfg(windows)]
fn hwnd_from_id(window_id: &str) -> Result<RawWindow, ComputerError> {
    let raw: usize = window_id.trim().parse().map_err(|_| {
        ComputerError::new(
            codes::WINDOW_NOT_FOUND,
            format!("window_id {window_id:?} is not a valid window handle"),
            false,
        )
    })?;
    Ok(raw as RawWindow)
}

#[cfg(windows)]
pub fn activate_window(window_id: &str) -> Result<WindowInfo, ComputerError> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        AllowSetForegroundWindow, GetForegroundWindow, IsIconic, IsWindow, SetForegroundWindow,
        ShowWindow, SW_RESTORE, SW_SHOWMINIMIZED,
    };

    unsafe {
        let hwnd = hwnd_from_id(window_id)?;
        if IsWindow(hwnd) == 0 {
            return Err(ComputerError::new(
                codes::WINDOW_NOT_FOUND,
                format!("window {window_id} no longer exists"),
                true,
            ));
        }
        // Grant foreground rights to any process, then try the standard path.
        AllowSetForegroundWindow(u32::MAX);
        if IsIconic(hwnd) != 0 {
            ShowWindow(hwnd, SW_RESTORE);
        }
        SetForegroundWindow(hwnd);
        if raw_address(GetForegroundWindow()) != raw_address(hwnd) {
            // Retry via the minimize/restore cycle, the classic workaround for
            // foreground locks held by another process.
            ShowWindow(hwnd, SW_SHOWMINIMIZED);
            ShowWindow(hwnd, SW_RESTORE);
            SetForegroundWindow(hwnd);
        }
        let state = window_state(hwnd)?;
        if !state.focused {
            return Err(ComputerError::new(
                codes::WINDOW_ACTIVATION_FAILED,
                format!("window {window_id} did not become the foreground window"),
                true,
            ));
        }
        Ok(state)
    }
}

#[cfg(windows)]
fn window_state(hwnd: RawWindow) -> Result<WindowInfo, ComputerError> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowLongPtrW, GetWindowRect, GetWindowTextW,
        GetWindowThreadProcessId, IsWindowVisible, GWL_EXSTYLE, WS_EX_TOOLWINDOW,
    };
    unsafe {
        let mut title = [0u16; 512];
        let len = GetWindowTextW(hwnd, title.as_mut_ptr(), title.len() as i32);
        let mut rect = std::mem::zeroed();
        if GetWindowRect(hwnd, &mut rect) == 0 {
            return Err(ComputerError::new(
                codes::WINDOW_NOT_FOUND,
                "window vanished before state read",
                true,
            ));
        }
        let mut process_id: u32 = 0;
        GetWindowThreadProcessId(hwnd, &mut process_id);
        let ex_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
        Ok(WindowInfo {
            id: raw_address(hwnd).to_string(),
            title: if len <= 0 {
                String::new()
            } else {
                String::from_utf16_lossy(&title[..len as usize])
            },
            process_name: process_name_of(process_id),
            process_id,
            x: rect.left,
            y: rect.top,
            width: rect.right - rect.left,
            height: rect.bottom - rect.top,
            visible: IsWindowVisible(hwnd) != 0 && ex_style & WS_EX_TOOLWINDOW == 0,
            focused: raw_address(GetForegroundWindow()) == raw_address(hwnd),
        })
    }
}

#[cfg(not(windows))]
pub fn list_windows() -> Result<Vec<WindowInfo>, ComputerError> {
    Err(ComputerError::new(
        codes::RUNTIME_UNAVAILABLE,
        "real window enumeration requires Windows",
        false,
    ))
}

#[cfg(not(windows))]
pub fn activate_window(_window_id: &str) -> Result<WindowInfo, ComputerError> {
    Err(ComputerError::new(
        codes::RUNTIME_UNAVAILABLE,
        "real window activation requires Windows",
        false,
    ))
}
