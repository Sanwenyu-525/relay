import ctypes, ctypes.wintypes, time
user32 = ctypes.windll.user32
hwnd = 857724
# 先确认窗口仍在且标题匹配
buf = ctypes.create_unicode_buffer(256)
user32.GetWindowTextW(hwnd, buf, 256)
print("title:", buf.value)
if "Relay" not in buf.value:
    print("window gone or changed; abort")
else:
    user32.PostMessageW(hwnd, 0x0010, 0, 0)  # WM_CLOSE
    time.sleep(5)
    print("still visible:", user32.IsWindowVisible(hwnd), "valid:", user32.IsWindow(hwnd))
