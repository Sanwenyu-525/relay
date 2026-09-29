import ctypes, ctypes.wintypes, sys, json
from datetime import datetime

hwnd = int(sys.argv[1])
out = sys.argv[2]

user32 = ctypes.windll.user32
gdi32 = ctypes.windll.gdi32
try:
    ctypes.windll.shcore.SetProcessDpiAwareness(2)
except Exception:
    pass

# 先恢复窗口（若最小化）并置前
user32.ShowWindow(hwnd, 9)  # SW_RESTORE
user32.SetForegroundWindow(hwnd)

class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [("biSize", ctypes.wintypes.DWORD), ("biWidth", ctypes.wintypes.LONG),
                ("biHeight", ctypes.wintypes.LONG), ("biPlanes", ctypes.wintypes.WORD),
                ("biBitCount", ctypes.wintypes.WORD), ("biCompression", ctypes.wintypes.DWORD),
                ("biSizeImage", ctypes.wintypes.DWORD), ("biXPelsPerMeter", ctypes.wintypes.LONG),
                ("biYPelsPerMeter", ctypes.wintypes.LONG), ("biClrUsed", ctypes.wintypes.DWORD),
                ("biClrImportant", ctypes.wintypes.DWORD)]

class BITMAPINFO(ctypes.Structure):
    _fields_ = [("bmiHeader", BITMAPINFOHEADER), ("bmiColors", ctypes.wintypes.DWORD * 3)]

rect = ctypes.wintypes.RECT()
user32.GetWindowRect(hwnd, ctypes.byref(rect))
w, h = rect.right - rect.left, rect.bottom - rect.top
hdc = user32.GetDC(0)
mem = gdi32.CreateCompatibleDC(hdc)
bmp = gdi32.CreateCompatibleBitmap(hdc, w, h)
gdi32.SelectObject(mem, bmp)
# PW_RENDERFULLCONTENT = 2（Win8.1+，含 WebView2/硬件合成内容）
ok = user32.PrintWindow(hwnd, mem, 2)

bi = BITMAPINFOHEADER()
bi.biSize = ctypes.sizeof(BITMAPINFOHEADER)
bi.biWidth = w
bi.biHeight = h
bi.biPlanes = 1
bi.biBitCount = 32
bi.biCompression = 0
buf = ctypes.create_string_buffer(w * h * 4)
gdi32.GetDIBits(mem, bmp, 0, h, buf, ctypes.byref(bi), 0)

# 写 BMP（24bit 转换省略，直接 32bit BMP with BI_RGB，再由 PIL/ffmpeg 转 png；无 PIL 时保 BMP）
import struct
def write_bmp(path, w, h, data):
    row = ((w * 32 + 31) // 32) * 4
    pixel_size = row * h
    header = struct.pack("<2sIHHIIiiHHIIiiII", b"BM", 14 + 40 + pixel_size, 0, 0, 14 + 40, 40, w, h, 1, 32, 0, pixel_size, 0, 0, 0, 0)
    with open(path, "wb") as f:
        f.write(header)
        f.write(data.raw if hasattr(data, "raw") else bytes(data))


try:
    from PIL import Image
    import PIL.ImageWin
    img = PIL.ImageWin.Dib(1, 0)
    import PIL.Image as _I
    raw = bytes(buf.raw if hasattr(buf, "raw") else buf)
    _I.frombytes("RGBA", (w, h), raw, "raw", "BGRA").save(out)
    print("png saved via PIL")
except Exception as e:
    write_bmp(out.replace(".png", ".bmp") if out.endswith(".png") else out, w, h, buf)
    print("PIL failed, bmp saved:", e)
gdi32.DeleteObject(bmp)
gdi32.DeleteDC(mem)
user32.ReleaseDC(0, hdc)
print(json.dumps({"ok": bool(ok), "w": w, "h": h, "captured_at": datetime.now().isoformat(timespec="seconds")}))
