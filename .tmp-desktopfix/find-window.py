import ctypes
user32 = ctypes.windll.user32
hwnd = user32.FindWindowW(None, "Relay Agent")
print("hwnd:", hwnd)
