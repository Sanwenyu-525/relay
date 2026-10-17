//! Persistent stdin/stdout JSON-lines loop for the Computer Runtime.

use relay_computer_runtime::protocol::{ComputerReply, PROTOCOL_VERSION};
use relay_computer_runtime::handle_request;
use serde::Deserialize;
use std::io::{BufRead, Write};

#[derive(Debug, Deserialize)]
struct LineRequest {
    version: String,
    request_id: String,
    method: String,
    #[serde(default)]
    params: serde_json::Value,
}

fn main() {
    // V2：进程必须在任何窗口度量/截图之前设为 per-monitor DPI aware V2，
    // 否则截图、窗口矩形与 SendInput 归一化坐标基于 DPI 虚拟化视图，
    // 与 UIA 的物理坐标不一致。实际生效级别随 describe_environment 上报。
    let awareness = relay_computer_runtime::environment::initialize_dpi_awareness();
    relay_computer_runtime::environment::record_dpi_awareness(awareness);

    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut out = std::io::BufWriter::new(stdout.lock());
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(line) => line,
            Err(_) => break, // parent closed the pipe: exit quietly.
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let reply: ComputerReply = match serde_json::from_str::<LineRequest>(trimmed) {
            Ok(request) => handle_request(&relay_computer_runtime::protocol::ComputerRequest {
                version: request.version,
                request_id: request.request_id,
                method: request.method,
                params: request.params,
            }),
            Err(error) => ComputerReply {
                version: PROTOCOL_VERSION,
                request_id: String::new(),
                success: false,
                result: None,
                error: Some(relay_computer_runtime::protocol::ComputerErrorBody {
                    code: "INVALID_REQUEST".to_string(),
                    message: format!("request line is not valid JSON: {error}"),
                    retryable: false,
                }),
            },
        };
        match serde_json::to_string(&reply) {
            Ok(text) => {
                let _ = writeln!(out, "{text}");
                let _ = out.flush();
            }
            Err(error) => {
                eprintln!("relay-computer-runtime: reply serialization failed: {error}");
                break;
            }
        }
    }
}
