import ctypes, ctypes.wintypes, sys

# 用法: python resize-window2.py <hwnd> <cssW> <cssH> <curInnerCssW> <curInnerCssH>
# 以“当前外框物理 - 当前内容物理”求实际边框差，再设目标外框。
hwnd = int(sys.argv[1])
cssW, cssH = int(sys.argv[2]), int(sys.argv[3])
curInnerW, curInnerH = int(sys.argv[4]), int(sys.argv[5])
user32 = ctypes.windll.user32
try:
    ctypes.windll.shcore.SetProcessDpiAwareness(2)
except Exception:
    pass
user32.ShowWindow(hwnd, 9)
GetDpiForWindow = user32.GetDpiForWindow
GetDpiForWindow.restype = ctypes.wintypes.UINT
scale = GetDpiForWindow(hwnd) / 96.0
rect = ctypes.wintypes.RECT()
user32.GetWindowRect(hwnd, ctypes.byref(rect))
outerW, outerH = rect.right - rect.left, rect.bottom - rect.top
borderW = outerW - round(curInnerW * scale)
borderH = outerH - round(curInnerH * scale)
tarW, tarH = round(cssW * scale) + borderW, round(cssH * scale) + borderH
ok = user32.SetWindowPos(hwnd, 0, 0, 0, tarW, tarH, 0x0004 | 0x0002)
print(f"scale={scale} border={borderW}x{borderH} targetOuter={tarW}x{tarH} ok={ok}")
