import ctypes, ctypes.wintypes, winreg, json, sys
from datetime import datetime

def regval(path, name):
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, path) as k:
            v, t = winreg.QueryValueEx(k, name)
            return v
    except OSError:
        return None

out = {
    "captured_at": datetime.now().isoformat(timespec="seconds"),
    "logPixels": regval(r"Control Panel\Desktop", "LogPixels"),
    "appliedDPI_WinMetrics": regval(r"Control Panel\Desktop\WindowMetrics", "AppliedDPI"),
    "dpiScalingVer": regval(r"Control Panel\Desktop", "DpiScalingVer"),
    "Win8DpiScaling": regval(r"Control Panel\Desktop", "Win8DpiScaling"),
}
try:
    user32 = ctypes.windll.user32
    # 未设置进程 DPI 感知时 GetDpiForSystem 返回虚拟化前的值；两种都记
    out["getDpiForSystem_raw"] = user32.GetDpiForSystem()
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except Exception:
        pass
    out["getDpiForSystem_aware"] = user32.GetDpiForSystem()
    hdc = user32.GetDC(0)
    out["gdi_screen_width_px"] = ctypes.windll.gdi32.GetDeviceCaps(hdc, 8)
    out["gdi_screen_height_px"] = ctypes.windll.gdi32.GetDeviceCaps(hdc, 10)
    out["gdi_logpixels_y"] = ctypes.windll.gdi32.GetDeviceCaps(hdc, 90)
    user32.ReleaseDC(0, hdc)
except Exception as e:
    out["probe_error"] = str(e)

print(json.dumps(out, ensure_ascii=False, indent=2))
if len(sys.argv) > 1:
    with open(sys.argv[1], "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
