//! ScreenshotProvider (Windows): virtual-screen capture via GDI + PNG encoding.
//!
//! V1 uses the compatible-DC BitBlt path: it is the same mechanism behind Print
//! Screen, works on every Windows 10/11 build without capture consent prompts, and
//! keeps the runtime dependency-free. Windows.Graphics.Capture is the V2 upgrade
//! path (per-frame desktop duplication), noted in the design doc; the provider seam
//! (`capture_virtual_screen`) is where that swap lands.

use crate::protocol::{codes, ComputerError};

/// Real virtual-screen capture result.
pub struct Screenshot {
    pub png: Vec<u8>,
    pub width: i32,
    pub height: i32,
    /// Left edge of the virtual screen in desktop coordinates (multi-monitor origin).
    pub origin_x: i32,
    pub origin_y: i32,
}

#[cfg(windows)]
pub fn capture_virtual_screen() -> Result<Screenshot, ComputerError> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
        SM_YVIRTUALSCREEN,
    };
    unsafe {
        let origin_x = GetSystemMetrics(SM_XVIRTUALSCREEN);
        let origin_y = GetSystemMetrics(SM_YVIRTUALSCREEN);
        let width = GetSystemMetrics(SM_CXVIRTUALSCREEN);
        let height = GetSystemMetrics(SM_CYVIRTUALSCREEN);
        if width <= 0 || height <= 0 {
            return Err(ComputerError::new(
                codes::SCREENSHOT_FAILED,
                format!("virtual screen metrics invalid ({width}x{height})"),
                false,
            ));
        }
        capture_area(origin_x, origin_y, width, height)
    }
}

/// 截取桌面坐标里的一个矩形区域（V2 的 `window` 目标用它）。
#[cfg(windows)]
pub fn capture_region(x: i32, y: i32, width: i32, height: i32) -> Result<Screenshot, ComputerError> {
    if width <= 0 || height <= 0 {
        return Err(ComputerError::new(
            codes::CAPTURE_TARGET_UNAVAILABLE,
            format!("region has no capturable area ({width}x{height})"),
            true,
        ));
    }
    capture_area(x, y, width, height)
}

#[cfg(windows)]
fn capture_area(origin_x: i32, origin_y: i32, width: i32, height: i32) -> Result<Screenshot, ComputerError> {
    use windows_sys::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits,
        GetDC, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, DIB_RGB_COLORS, SRCCOPY,
    };

    unsafe {
        let screen_dc = GetDC(std::ptr::null_mut());
        if screen_dc.is_null() {
            return Err(ComputerError::new(codes::SCREENSHOT_FAILED, "GetDC(null) failed", true));
        }
        let mem_dc = CreateCompatibleDC(screen_dc);
        let bitmap = CreateCompatibleBitmap(screen_dc, width, height);
        if mem_dc.is_null() || bitmap.is_null() {
            if !bitmap.is_null() {
                DeleteObject(bitmap);
            }
            if !mem_dc.is_null() {
                DeleteDC(mem_dc);
            }
            ReleaseDC(std::ptr::null_mut(), screen_dc);
            return Err(ComputerError::new(
                codes::SCREENSHOT_FAILED,
                "compatible DC/bitmap allocation failed",
                true,
            ));
        }
        let previous = SelectObject(mem_dc, bitmap);
        let blit = BitBlt(mem_dc, 0, 0, width, height, screen_dc, origin_x, origin_y, SRCCOPY);
        let mut bgra = vec![0u8; (width as usize) * (height as usize) * 4];
        let mut info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                // Negative height requests a top-down DIB (row 0 = screen top).
                biHeight: -height,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: 0,
                biSizeImage: 0,
                biXPelsPerMeter: 0,
                biYPelsPerMeter: 0,
                biClrUsed: 0,
                biClrImportant: 0,
            },
            bmiColors: [Default::default(); 1],
        };
        let copied = GetDIBits(
            mem_dc,
            bitmap,
            0,
            height as u32,
            bgra.as_mut_ptr().cast(),
            &mut info,
            DIB_RGB_COLORS,
        );
        SelectObject(mem_dc, previous);
        DeleteObject(bitmap);
        DeleteDC(mem_dc);
        ReleaseDC(std::ptr::null_mut(), screen_dc);
        if blit == 0 || copied != height {
            return Err(ComputerError::new(
                codes::SCREENSHOT_FAILED,
                format!("screen capture incomplete (BitBlt={blit}, rows={copied})"),
                true,
            ));
        }
        let rgb = bgra_to_rgb(&bgra);
        let png = encode_png(&rgb, width as u32, height as u32)
            .map_err(|message| ComputerError::new(codes::SCREENSHOT_FAILED, message, false))?;
        Ok(Screenshot { png, width, height, origin_x, origin_y })
    }
}

/// GDI 32-bit DIBs are BGRA with an unused alpha byte; PNG RGB wants packed RGB.
fn bgra_to_rgb(bgra: &[u8]) -> Vec<u8> {
    let mut rgb = Vec::with_capacity(bgra.len() / 4 * 3);
    for pixel in bgra.chunks_exact(4) {
        rgb.push(pixel[2]);
        rgb.push(pixel[1]);
        rgb.push(pixel[0]);
    }
    rgb
}

/// PNG encode (8-bit RGB, no interlace). The `png` crate's zlib backend is pure Rust.
pub fn encode_png(rgb: &[u8], width: u32, height: u32) -> Result<Vec<u8>, String> {
    let mut bytes: Vec<u8> = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut bytes, width, height);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder
            .write_header()
            .map_err(|error| format!("png header: {error}"))?;
        writer
            .write_image_data(rgb)
            .map_err(|error| format!("png data: {error}"))?;
        writer.finish().map_err(|error| format!("png finish: {error}"))?;
    }
    Ok(bytes)
}

/// Standard base64 (RFC 4648, padded). The API side treats the image as opaque.
pub fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[(triple >> 18) as usize & 0x3F] as char);
        out.push(TABLE[(triple >> 12) as usize & 0x3F] as char);
        if chunk.len() > 1 {
            out.push(TABLE[(triple >> 6) as usize & 0x3F] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(TABLE[triple as usize & 0x3F] as char);
        } else {
            out.push('=');
        }
    }
    out
}

#[cfg(not(windows))]
pub fn capture_virtual_screen() -> Result<Screenshot, ComputerError> {
    Err(ComputerError::new(
        codes::RUNTIME_UNAVAILABLE,
        "real screenshot capture requires Windows",
        false,
    ))
}

#[cfg(not(windows))]
pub fn capture_region(_x: i32, _y: i32, _width: i32, _height: i32) -> Result<Screenshot, ComputerError> {
    Err(ComputerError::new(
        codes::RUNTIME_UNAVAILABLE,
        "real region capture requires Windows",
        false,
    ))
}
