//! 全局 Esc 监听（Windows WH_KEYBOARD_LL 低级键盘钩子）。
//!
//! 安全边界：这是**被动观察者**——每个键盘事件都原样经 CallNextHookEx 转发，
//! 从不吞键、从不改写，用户其它应用完全无感；只在电脑操控进行期间安装，
//! overlay 隐藏后立即卸载，不长期常驻。
//!
//! 低级钩子要求安装线程跑 Windows 消息循环：这里由专用线程常驻 GetMessageW，
//! 宿主线程用 PostThreadMessageW(WM_QUIT) 让它退出 → Unhook → 线程结束。
//! WebView 的 keydown 监听不行：用户焦点通常在 Chrome/VS Code 等前台应用上。

#[cfg(windows)]
mod imp {
    use std::sync::mpsc::{channel, Receiver, Sender};
    use std::sync::Mutex;
    use std::thread;

    use windows::Win32::Foundation::{HINSTANCE, LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::System::Threading::GetCurrentThreadId;
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, GetMessageW, PostThreadMessageW, SetWindowsHookExW, UnhookWindowsHookEx,
        HC_ACTION, HHOOK, KBDLLHOOKSTRUCT, MSG, WH_KEYBOARD_LL, WM_KEYDOWN, WM_QUIT,
    };

    const VK_ESCAPE: u32 = 0x1B;

    static EVENT_TX: Mutex<Option<Sender<()>>> = Mutex::new(None);

    /// 钩子过程不能捕获环境，经由静态发送器把 Esc 观测事件交给 watcher 通道。
    /// 锁内只有一次 map + send，非竞争路径，不会拖慢键盘事件链。
    unsafe extern "system" fn esc_hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        // 被动观察：只读 KBDLLHOOKSTRUCT 的 vkCode，永不拦截或改写按键。
        if code as u32 == HC_ACTION && wparam.0 as u32 == WM_KEYDOWN {
            unsafe {
                let info = &*(lparam.0 as *const KBDLLHOOKSTRUCT);
                if info.vkCode == VK_ESCAPE {
                    if let Some(sender) =
                        EVENT_TX.lock().ok().and_then(|guard| guard.as_ref().cloned()) {
                        let _ = sender.send(());
                    }
                }
            }
        }
        unsafe { CallNextHookEx(None, code, wparam, lparam) }
    }

    pub struct EscWatcher {
        thread_id: u32,
        receiver: Receiver<()>,
    }

    impl EscWatcher {
        /** 非阻塞读取：观测到 Esc 按下时返回 Some(())。 */
        pub fn take_press(&self) -> Option<()> {
            self.receiver.try_recv().ok()
        }

        /** 向钩子线程投递 WM_QUIT：消息循环退出 → 反安装钩子 → 线程结束。 */
        pub fn stop(&self) {
            unsafe {
                let _ = PostThreadMessageW(self.thread_id, WM_QUIT, WPARAM(0), LPARAM(0));
            }
        }
    }

    pub fn install() -> Option<EscWatcher> {
        let (sender, receiver) = channel();
        *EVENT_TX.lock().ok()? = Some(sender);
        let (ready_tx, ready_rx) = channel::<u32>();
        thread::Builder::new().name("relay-esc-hook".into()).spawn(move || {
            unsafe {
                let _ = ready_tx.send(GetCurrentThreadId());
                let module = GetModuleHandleW(None).unwrap_or_default();
                // LL 钩子的 hMod 参数按 HINSTANCE 传入；exe 模块句柄两者同值。
                let instance = HINSTANCE(module.0);
                let hook: HHOOK = match SetWindowsHookExW(WH_KEYBOARD_LL, Some(esc_hook_proc), Some(instance), 0) {
                    Ok(hook) => hook,
                    Err(_) => return,
                };
                let mut message = MSG::default();
                while GetMessageW(&mut message, None, 0, 0).as_bool() {}
                let _ = UnhookWindowsHookEx(hook);
            }
        }).ok()?;
        let thread_id = ready_rx.recv().ok()?;
        Some(EscWatcher { thread_id, receiver })
    }
}

#[cfg(windows)]
pub use imp::{install, EscWatcher};

#[cfg(not(windows))]
mod imp {
    /// 非 Windows 桌面当前不支持全局 Esc；Overlay 仍显示，仅退出按钮不可用。
    pub struct EscWatcher;
    impl EscWatcher {
        pub fn take_press(&self) -> Option<()> { None }
        pub fn stop(&self) {}
    }
    pub fn install() -> Option<EscWatcher> { None }
}

#[cfg(not(windows))]
pub use imp::{install, EscWatcher};
