import ctypes, ctypes.wintypes, sys

# 用法: python resize-window.py <hwnd> <cssW> <cssH>
# 目标：让 WebView 内容区（CSS px）达到目标尺寸；用 GetDpiForWindow 换算物理像素，
# 依 “外框物理 = 内容物理 + 边框差” 逐次逼近（最多4次），边框差按本次测量更新。
hwnd = int(sys.argv[1])
cssW, cssH = int(sys.argv[2]), int(sys.argv[3])
user32 = ctypes.windll.user32
try:
    ctypes.windll.shcore.SetProcessDpiAwareness(2)
except Exception:
    pass
user32.ShowWindow(hwnd, 9)

GetDpiForWindow = user32.GetDpiForWindow
GetDpiForWindow.restype = ctypes.wintypes.UINT
dpi = GetDpiForWindow(hwnd)
scale = dpi / 96.0
tarW, tarH = round(cssW * scale), round(cssH * scale)

# 初值边框差：外框 - 内容
rect = ctypes.wintypes.RECT()
user32.GetWindowRect(hwnd, ctypes.byref(rect))
curW, curH = rect.right - rect.left, rect.bottom - rect.top
# 初始内容假设 = 1160x780 逻辑
borderW, borderH = curW - round(1160 * scale), curH - round(780 * scale)
print(f"dpi={dpi} scale={scale} targetPhys={tarW}x{tarH} border0={borderW}x{borderH}")
ok = user32.SetWindowPos(hwnd, 0, 0, 0, tarW + borderW, tarH + borderH, 0x0004 | 0x0002)  # NOZORDER|NOMOVE
print("SetWindowPos:", ok)
