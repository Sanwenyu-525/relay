use serde::Deserialize;
use serde_json::{Value, json};
use std::io::{self, BufRead, Write};

pub(super) const VERSION: &str = "relay-managed-content-v1";

#[derive(Deserialize)]
#[serde(tag = "op", deny_unknown_fields)]
pub(super) enum Request {
    #[serde(rename = "publish-content")]
    Publish {
        version: String,
        root_path: String,
        artifact_id: String,
        version_id: String,
        content_hex: String,
    },
    #[serde(rename = "hold-content-freeze")]
    Freeze {
        version: String,
        root_path: String,
        nonce: String,
    },
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Release {
    pub version: String,
    pub op: String,
    pub nonce: String,
}

pub(super) fn uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| {
            if [8, 13, 18, 23].contains(&index) {
                byte == b'-'
            } else {
                byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
            }
        })
}

pub(super) fn frame(
    reader: &mut impl BufRead,
    limit: usize,
) -> Result<Option<Vec<u8>>, super::Failure> {
    let mut value = Vec::new();
    loop {
        let bytes = reader
            .fill_buf()
            .map_err(|_| super::Failure::new("IO_FAILED", "private input failed"))?;
        if bytes.is_empty() {
            return if value.is_empty() {
                Ok(None)
            } else {
                Err(super::Failure::new(
                    "INVALID_INPUT",
                    "unterminated private frame",
                ))
            };
        }
        let newline = bytes.iter().position(|byte| *byte == b'\n');
        let count = newline.map_or(bytes.len(), |index| index + 1);
        if value.len() + count > limit {
            return Err(super::Failure::new(
                "INVALID_INPUT",
                "private frame exceeds limit",
            ));
        }
        value.extend_from_slice(&bytes[..count]);
        reader.consume(count);
        if newline.is_some() {
            return Ok(Some(value));
        }
    }
}

pub(super) fn output(writer: &mut impl Write, value: Value) -> Result<(), super::Failure> {
    let bytes = serde_json::to_vec(&value)
        .map_err(|_| super::Failure::new("IO_FAILED", "private output failed"))?;
    if bytes.len() > 16 * 1024 {
        return Err(super::Failure::new(
            "IO_FAILED",
            "private output exceeds limit",
        ));
    }
    writer
        .write_all(&bytes)
        .and_then(|_| writer.write_all(b"\n"))
        .and_then(|_| writer.flush())
        .map_err(|_| super::Failure::new("IO_FAILED", "private output failed"))
}

pub(super) fn main() -> i32 {
    let mut input = io::stdin().lock();
    let mut stdout = io::stdout().lock();
    let result = (|| {
        if std::env::args_os().skip(1).count() != 1 {
            return Err(super::Failure::new(
                "INVALID_INPUT",
                "unexpected private arguments",
            ));
        }
        let bytes = frame(&mut input, super::MAX_REQUEST_BYTES as usize)?
            .ok_or_else(|| super::Failure::new("INVALID_INPUT", "missing private frame"))?;
        let request: Request = serde_json::from_slice(&bytes)
            .map_err(|_| super::Failure::new("INVALID_INPUT", "invalid private frame"))?;
        #[cfg(windows)]
        {
            super::win::content::run(request, &mut input, &mut stdout)
        }
        #[cfg(not(windows))]
        {
            let _ = request;
            Err(super::Failure::new(
                "UNSUPPORTED_PLATFORM",
                "Windows is required",
            ))
        }
    })();
    if let Err(error) = result {
        let _ = output(
            &mut stdout,
            json!({ "version": VERSION, "ok": false,
            "error": { "code": error.code, "message": error.message } }),
        );
        return 1;
    }
    0
}
