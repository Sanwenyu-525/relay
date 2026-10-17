//! 仅回环（127.0.0.1）的最小 HTTP/1.1 客户端，桌面壳专用。
//!
//! 只服务两个调用：轮询 Computer Control 会话状态（GET）与转发 Esc 取消（POST）。
//! 都是短连接、无请求体、Bearer 头、明文回环，为此引入 hyper/tokio 栈不成比例；
//! 响应按 `Connection: close` 读到 EOF，头部与正文按第一个空行切开。
//! Token 与路径都由本仓常量/UUID 构成，不存在头注入面。

use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::Duration;

const IO_TIMEOUT: Duration = Duration::from_millis(2500);

pub struct LoopbackResponse {
    pub status: u16,
    pub body: String,
}

/// 发起一次回环请求。失败一律返回 Err(String)，由调用方决定降级方式。
pub fn request_loopback(port: u16, method: &str, path: &str, bearer: &str)
    -> Result<LoopbackResponse, String> {
    let stream = TcpStream::connect(("127.0.0.1", port))
        .map_err(|error| format!("loopback connect failed: {error}"))?;
    stream.set_read_timeout(Some(IO_TIMEOUT))
        .map_err(|error| format!("loopback read timeout: {error}"))?;
    stream.set_write_timeout(Some(IO_TIMEOUT))
        .map_err(|error| format!("loopback write timeout: {error}"))?;
    let mut stream = stream;
    let request = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\
         Authorization: Bearer {bearer}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    stream.write_all(request.as_bytes())
        .map_err(|error| format!("loopback write failed: {error}"))?;
    stream.flush().map_err(|error| format!("loopback flush failed: {error}"))?;
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw)
        .map_err(|error| format!("loopback read failed: {error}"))?;
    let text = String::from_utf8_lossy(&raw);
    let (head, body) = text.split_once("\r\n\r\n")
        .ok_or_else(|| "loopback response has no header/body separator".to_string())?;
    let status = head.split_whitespace().nth(1)
        .and_then(|value| value.parse::<u16>().ok())
        .ok_or_else(|| "loopback status line is malformed".to_string())?;
    Ok(LoopbackResponse { status, body: body.to_string() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loopback_response_shape() {
        // 只测纯解析路径的构成块：状态行提取在 request_loopback 内完成，
        // 这里确认结构字段与文档一致，防止误改成元组导致调用方漂移。
        let response = LoopbackResponse { status: 200, body: "{}".into() };
        assert_eq!(response.status, 200);
        assert_eq!(response.body, "{}");
    }
}
