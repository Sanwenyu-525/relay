import ctypes, ctypes.wintypes, winreg, sys, json
from datetime import datetime

# 用法: python dpi-set.py <appliedDpi>  例: 1440=150%, 1200=125%
target = int(sys.argv[1])
action = sys.argv[2] if len(sys.argv) > 2 else "set"

with winreg.CreateKeyEx(winreg.HKEY_CURRENT_USER, r"Control Panel\Desktop\WindowMetrics", 0, winreg.KEY_SET_VALUE | winreg.KEY_QUERY_VALUE) as k:
    old, t = winreg.QueryValueEx(k, "AppliedDPI")
    winreg.SetValueEx(k, "AppliedDPI", 0, winreg.REG_DWORD, target)
print(f"AppliedDPI: {old} -> {target}")

# 广播 WM_SETTINGCHANGE（环境/策略变更通知）
HWND_BROADCAST = 0xFFFF
WM_SETTINGCHANGE = 0x001A
SMTO_ABORTIFHUNG = 0x0002
res = ctypes.windll.user32.SendMessageTimeoutW(HWND_BROADCAST, WM_SETTINGCHANGE, 0, 0, SMTO_ABORTIFHUNG, 3000, ctypes.byref(ctypes.wintypes.DWORD()))
print("WM_SETTINGCHANGE broadcast result:", res)

# 探测系统生效值
try:
    ctypes.windll.shcore.SetProcessDpiAwareness(2)
except Exception:
    pass
out = {
    "captured_at": datetime.now().isoformat(timespec="seconds"),
    "action": action, "target": target,
    "appliedDPI_now": winreg.QueryValueEx(winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Control Panel\Desktop\WindowMetrics"), "AppliedDPI")[0],
    "getDpiForSystem": ctypes.windll.user32.GetDpiForSystem(),
    "gdi_logpixels_y": ctypes.windll.gdi32.GetDeviceCaps(ctypes.windll.user32.GetDC(0), 90),
}
print(json.dumps(out, ensure_ascii=False))
with open(sys.argv[3] if len(sys.argv) > 3 else ".tmp-uidpi/dpi-set-last.json", "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, indent=2)
