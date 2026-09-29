import ctypes, ctypes.wintypes, json, sys
from datetime import datetime

hwnd = int(sys.argv[1])
user32 = ctypes.windll.user32
dwmapi = ctypes.windll.dwmapi

# 让本进程 DPI 感知，保证坐标是物理像素
try:
    ctypes.windll.shcore.SetProcessDpiAwareness(2)
except Exception:
    pass

rect = ctypes.wintypes.RECT()
user32.GetWindowRect(hwnd, ctypes.byref(rect))
frame = ctypes.wintypes.RECT()
dwmapi.DwmGetWindowAttribute(hwnd, 9, ctypes.byref(frame), ctypes.sizeof(frame))  # EXTENDED_FRAME_BOUNDS

GetDpiForWindow = user32.GetDpiForWindow
GetDpiForWindow.restype = ctypes.wintypes.UINT
dpi_window = GetDpiForWindow(hwnd)

out = {
    "captured_at": datetime.now().isoformat(timespec="seconds"),
    "hwnd": hwnd,
    "windowRect_physical": {"l": rect.left, "t": rect.top, "r": rect.right, "b": rect.bottom,
                             "w": rect.right - rect.left, "h": rect.bottom - rect.top},
    "dwmFrameBounds_physical": {"l": frame.left, "t": frame.top, "r": frame.right, "b": frame.bottom,
                                 "w": frame.right - frame.left, "h": frame.bottom - frame.top},
    "dpiForWindow": dpi_window,
    "scalePct": round(dpi_window * 100 / 96),
}
print(json.dumps(out, ensure_ascii=False, indent=2))
if len(sys.argv) > 2:
    with open(sys.argv[2], "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
