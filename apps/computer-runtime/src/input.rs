//! InputController (Windows): mouse and keyboard via SendInput only.
//!
//! Text goes through KEYEVENTF_UNICODE scan codes, so CJK and any other script is
//! delivered by the system's own input pipeline instead of a fake per-key hack.
//! Coordinates are virtual-screen (desktop) coordinates; the runtime reports the
//! virtual-screen origin with every screenshot so the agent can map them directly.

use crate::protocol::{codes, ComputerError};

#[cfg(windows)]
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    keybd_event, mouse_event, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT,
    KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, MOUSEEVENTF_ABSOLUTE,
    MOUSEEVENTF_HWHEEL, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MIDDLEDOWN,
    MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_MOVE, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP,
    MOUSEEVENTF_WHEEL, MOUSEINPUT, MOUSE_EVENT_FLAGS, VIRTUAL_KEY,
};
#[cfg(windows)]
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
    SM_YVIRTUALSCREEN,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MouseButton {
    Left,
    Right,
    Middle,
}

#[derive(Debug, Clone, Copy)]
pub struct Point {
    pub x: i32,
    pub y: i32,
}

/// Virtual-screen bounds check; coordinates are desktop-wide, not per-monitor.
pub fn validate_point(point: Point) -> Result<(), ComputerError> {
    #[cfg(windows)]
    unsafe {
        let min_x = GetSystemMetrics(SM_XVIRTUALSCREEN);
        let min_y = GetSystemMetrics(SM_YVIRTUALSCREEN);
        let max_x = min_x + GetSystemMetrics(SM_CXVIRTUALSCREEN) - 1;
        let max_y = min_y + GetSystemMetrics(SM_CYVIRTUALSCREEN) - 1;
        if point.x < min_x || point.x > max_x || point.y < min_y || point.y > max_y {
            return Err(ComputerError::new(
                codes::INVALID_COORDINATE,
                format!(
                    "coordinate ({}, {}) is outside the virtual screen ({}..{}, {}..{})",
                    point.x, point.y, min_x, max_x, min_y, max_y
                ),
                false,
            ));
        }
    }
    let _ = point;
    Ok(())
}

#[cfg(windows)]
fn send(inputs: &[INPUT]) -> Result<(), ComputerError> {
    let sent = unsafe {
        SendInput(
            inputs.len() as u32,
            inputs.as_ptr(),
            std::mem::size_of::<INPUT>() as i32,
        )
    };
    if sent as usize != inputs.len() {
        return Err(ComputerError::new(
            codes::INPUT_FAILED,
            format!("SendInput delivered {sent} of {} events", inputs.len()),
            true,
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn mouse_input(dx: i32, dy: i32, flags: MOUSE_EVENT_FLAGS, data: u32) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT { dx, dy, mouseData: data, dwFlags: flags, time: 0, dwExtraInfo: 0 },
        },
    }
}

#[cfg(windows)]
fn absolute_xy(point: Point) -> (i32, i32) {
    unsafe {
        let min_x = GetSystemMetrics(SM_XVIRTUALSCREEN);
        let min_y = GetSystemMetrics(SM_YVIRTUALSCREEN);
        let width = GetSystemMetrics(SM_CXVIRTUALSCREEN);
        let height = GetSystemMetrics(SM_CYVIRTUALSCREEN);
        let normalized_x = ((point.x - min_x) as i64 * 65535 / (width as i64 - 1).max(1)) as i32;
        let normalized_y = ((point.y - min_y) as i64 * 65535 / (height as i64 - 1).max(1)) as i32;
        (normalized_x, normalized_y)
    }
}

#[cfg(windows)]
pub fn move_mouse(point: Point) -> Result<(), ComputerError> {
    validate_point(point)?;
    let (dx, dy) = absolute_xy(point);
    send(&[mouse_input(dx, dy, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE, 0)])
}

#[cfg(windows)]
fn button_flags(button: MouseButton) -> (MOUSE_EVENT_FLAGS, MOUSE_EVENT_FLAGS) {
    match button {
        MouseButton::Left => (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
        MouseButton::Right => (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
        MouseButton::Middle => (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
    }
}

#[cfg(windows)]
pub fn click(button: MouseButton, point: Point) -> Result<(), ComputerError> {
    move_mouse(point)?;
    let (down, up) = button_flags(button);
    let (dx, dy) = absolute_xy(point);
    send(&[mouse_input(dx, dy, down, 0), mouse_input(dx, dy, up, 0)])
}

#[cfg(windows)]
pub fn double_click(point: Point) -> Result<(), ComputerError> {
    click(MouseButton::Left, point)?;
    std::thread::sleep(std::time::Duration::from_millis(40));
    click(MouseButton::Left, point)
}

#[cfg(windows)]
pub fn scroll(delta_x: i32, delta_y: i32) -> Result<(), ComputerError> {
    if delta_x == 0 && delta_y == 0 {
        return Ok(());
    }
    let mut inputs = Vec::new();
    if delta_y != 0 {
        inputs.push(mouse_input(0, 0, MOUSEEVENTF_WHEEL, (delta_y / 120) as u32));
    }
    if delta_x != 0 {
        inputs.push(mouse_input(0, 0, MOUSEEVENTF_HWHEEL, (delta_x / 120) as u32));
    }
    if inputs.is_empty() {
        return Err(ComputerError::new(
            codes::INVALID_REQUEST,
            "scroll deltas below one wheel notch must not be sent",
            false,
        ));
    }
    send(&inputs)
}

#[cfg(windows)]
pub fn drag(start: Point, end: Point, duration_ms: u32) -> Result<(), ComputerError> {
    move_mouse(start)?;
    let (down, up) = button_flags(MouseButton::Left);
    let (sx, sy) = absolute_xy(start);
    send(&[mouse_input(sx, sy, down, 0)])?;
    let steps = (12 + duration_ms / 15).clamp(12, 120);
    for step in 1..=steps {
        let ratio = step as f64 / steps as f64;
        let x = start.x + ((end.x - start.x) as f64 * ratio).round() as i32;
        let y = start.y + ((end.y - start.y) as f64 * ratio).round() as i32;
        validate_point(Point { x, y })?;
        let (dx, dy) = absolute_xy(Point { x, y });
        send(&[mouse_input(dx, dy, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE, 0)])?;
        std::thread::sleep(std::time::Duration::from_millis(u64::from((duration_ms / steps).max(1))));
    }
    let (ex, ey) = absolute_xy(end);
    send(&[mouse_input(ex, ey, up, 0)])
}

/// 每个 UTF-16 单元之间的间隔（毫秒）。
///
/// 这不是性能参数，是可靠性参数：实测（Windows 11 中文环境 + 记事本）中，
/// 单元间隔小于约 30ms 时接收方会确定性地损坏输入（丢首字符、末字符重复，
/// 20ms 三轮全部复现同一损坏模式；30ms 与 50ms 各三轮全部干净）。
/// 调用方可通过 computer.type 的 delay_ms 在 1..=100 内调整。
pub const DEFAULT_TYPE_DELAY_MS: u64 = 30;

#[cfg(windows)]
pub fn type_text(text: &str, delay_ms: u64) -> Result<usize, ComputerError> {
    let units: Vec<u16> = text.encode_utf16().collect();
    for (index, unit) in units.iter().enumerate() {
        let down = key_event(*unit, KEYEVENTF_UNICODE);
        let up = key_event(*unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP);
        send(&[down, up])?;
        if index + 1 < units.len() && delay_ms > 0 {
            std::thread::sleep(std::time::Duration::from_millis(delay_ms));
        }
    }
    Ok(units.len())
}

/// Frozen key vocabulary: (uppercase name, Windows virtual-key code).
///
/// The table is platform-independent on purpose: VK codes are part of the frozen
/// wire contract, so mock mode, real mode and tests all validate against the same
/// list instead of each keeping its own.
pub const KEY_VOCABULARY: &[(&str, u16)] = &[
    ("ENTER", 0x0D), ("RETURN", 0x0D),
    ("ESC", 0x1B), ("ESCAPE", 0x1B),
    ("TAB", 0x09),
    ("BACKSPACE", 0x08),
    ("DELETE", 0x2E), ("DEL", 0x2E),
    ("SPACE", 0x20),
    ("UP", 0x26), ("DOWN", 0x28), ("LEFT", 0x25), ("RIGHT", 0x27),
    ("HOME", 0x24), ("END", 0x23),
    ("PAGEUP", 0x21), ("PRIOR", 0x21),
    ("PAGEDOWN", 0x22), ("NEXT", 0x22),
    ("F1", 0x70), ("F2", 0x71), ("F3", 0x72), ("F4", 0x73), ("F5", 0x74), ("F6", 0x75),
    ("F7", 0x76), ("F8", 0x77), ("F9", 0x78), ("F10", 0x79), ("F11", 0x7A), ("F12", 0x7B),
    ("0", 0x30), ("1", 0x31), ("2", 0x32), ("3", 0x33), ("4", 0x34),
    ("5", 0x35), ("6", 0x36), ("7", 0x37), ("8", 0x38), ("9", 0x39),
    ("A", 0x41), ("B", 0x42), ("C", 0x43), ("D", 0x44), ("E", 0x45), ("F", 0x46), ("G", 0x47),
    ("H", 0x48), ("I", 0x49), ("J", 0x4A), ("K", 0x4B), ("L", 0x4C), ("M", 0x4D), ("N", 0x4E),
    ("O", 0x4F), ("P", 0x50), ("Q", 0x51), ("R", 0x52), ("S", 0x53), ("T", 0x54), ("U", 0x55),
    ("V", 0x56), ("W", 0x57), ("X", 0x58), ("Y", 0x59), ("Z", 0x5A),
    ("CTRL", 0x11), ("CONTROL", 0x11), ("CONTROLKEY", 0x11),
    ("ALT", 0x12), ("MENU", 0x12),
    ("SHIFT", 0x10),
    ("WIN", 0x5B), ("CMD", 0x5B), ("SUPER", 0x5B), ("LWIN", 0x5B),
];

/// True when the name is inside the frozen vocabulary (case-insensitive, trimmed).
pub fn is_known_key_name(name: &str) -> bool {
    let upper = name.trim().to_ascii_uppercase();
    KEY_VOCABULARY.iter().any(|(known, _)| *known == upper)
}

/// Maps the frozen key names to virtual keys. Names are matched case-insensitively.
pub fn virtual_key_of(name: &str) -> Option<VIRTUAL_KEY> {
    let upper = name.trim().to_ascii_uppercase();
    KEY_VOCABULARY.iter()
        .find(|(known, _)| *known == upper)
        .map(|(_, code)| *code)
}

#[cfg(windows)]
fn is_modifier(vk: VIRTUAL_KEY) -> bool {
    // VK codes from KEY_VOCABULARY: CTRL 0x11, ALT 0x12, SHIFT 0x10, LWIN 0x5B.
    vk == 0x11 || vk == 0x12 || vk == 0x10 || vk == 0x5B
}

#[cfg(windows)]
fn key_event(w_scan: u16, flags: KEYBD_EVENT_FLAGS) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT { wVk: 0, wScan: w_scan, dwFlags: flags, time: 0, dwExtraInfo: 0 },
        },
    }
}

#[cfg(windows)]
pub fn keypress(key: &str) -> Result<(), ComputerError> {
    let vk = virtual_key_of(key).ok_or_else(|| {
        ComputerError::new(codes::INVALID_REQUEST, format!("unsupported key name {key:?}"), false)
    })?;
    send(&[vk_event(vk, 0), vk_event(vk, KEYEVENTF_KEYUP)])
}

#[cfg(windows)]
pub fn hotkey(keys: &[String]) -> Result<(), ComputerError> {
    if keys.is_empty() {
        return Err(ComputerError::new(
            codes::INVALID_REQUEST,
            "hotkey requires at least one key",
            false,
        ));
    }
    let mut resolved = Vec::new();
    for key in keys {
        let vk = virtual_key_of(key).ok_or_else(|| {
            ComputerError::new(
                codes::INVALID_REQUEST,
                format!("unsupported key name {key:?}"),
                false,
            )
        })?;
        resolved.push(vk);
    }
    let mods: Vec<VIRTUAL_KEY> = resolved.iter().copied().filter(|vk| is_modifier(*vk)).collect();
    let plain: Vec<VIRTUAL_KEY> = resolved.iter().copied().filter(|vk| !is_modifier(*vk)).collect();
    if plain.is_empty() {
        return Err(ComputerError::new(
            codes::INVALID_REQUEST,
            "hotkey needs at least one non-modifier key",
            false,
        ));
    }
    let mut events: Vec<INPUT> = Vec::new();
    for vk in &mods {
        events.push(vk_event(*vk, 0));
    }
    for vk in &plain {
        events.push(vk_event(*vk, 0));
        events.push(vk_event(*vk, KEYEVENTF_KEYUP));
    }
    for vk in mods.iter().rev() {
        events.push(vk_event(*vk, KEYEVENTF_KEYUP));
    }
    send(&events)
}

#[cfg(windows)]
fn vk_event(vk: VIRTUAL_KEY, flags: KEYBD_EVENT_FLAGS) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT { wVk: vk, wScan: 0, dwFlags: flags, time: 0, dwExtraInfo: 0 },
        },
    }
}

#[cfg(not(windows))]
pub fn move_mouse(_point: Point) -> Result<(), ComputerError> {
    Err(ComputerError::new(codes::RUNTIME_UNAVAILABLE, "real mouse input requires Windows", false))
}

#[cfg(not(windows))]
pub fn click(_button: MouseButton, _point: Point) -> Result<(), ComputerError> {
    Err(ComputerError::new(codes::RUNTIME_UNAVAILABLE, "real mouse input requires Windows", false))
}

#[cfg(not(windows))]
pub fn double_click(_point: Point) -> Result<(), ComputerError> {
    Err(ComputerError::new(codes::RUNTIME_UNAVAILABLE, "real mouse input requires Windows", false))
}

#[cfg(not(windows))]
pub fn scroll(_delta_x: i32, _delta_y: i32) -> Result<(), ComputerError> {
    Err(ComputerError::new(codes::RUNTIME_UNAVAILABLE, "real wheel input requires Windows", false))
}

#[cfg(not(windows))]
pub fn drag(_start: Point, _end: Point, _duration_ms: u32) -> Result<(), ComputerError> {
    Err(ComputerError::new(codes::RUNTIME_UNAVAILABLE, "real mouse input requires Windows", false))
}

#[cfg(not(windows))]
pub fn type_text(_text: &str, _delay_ms: u64) -> Result<usize, ComputerError> {
    Err(ComputerError::new(codes::RUNTIME_UNAVAILABLE, "real keyboard input requires Windows", false))
}

#[cfg(not(windows))]
pub fn keypress(_key: &str) -> Result<(), ComputerError> {
    Err(ComputerError::new(codes::RUNTIME_UNAVAILABLE, "real keyboard input requires Windows", false))
}

#[cfg(not(windows))]
pub fn hotkey(_keys: &[String]) -> Result<(), ComputerError> {
    Err(ComputerError::new(codes::RUNTIME_UNAVAILABLE, "real keyboard input requires Windows", false))
}

// Legacy synthesized-event helpers retained for completeness; the frozen path is SendInput.
#[cfg(windows)]
#[allow(dead_code)]
fn legacy_mouse(flags: MOUSE_EVENT_FLAGS, data: u32) {
    unsafe {
        mouse_event(flags, 0, 0, data as i32, 0);
    }
}

#[cfg(windows)]
#[allow(dead_code)]
fn legacy_key(vk: VIRTUAL_KEY, flags: KEYBD_EVENT_FLAGS) {
    unsafe {
        keybd_event(vk as u8, 0, flags, 0);
    }
}
