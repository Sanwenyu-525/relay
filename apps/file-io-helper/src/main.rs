use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::io::{self, BufRead, Read, Write};

const VERSION: &str = "relay-file-io-v1";
const MAX_REQUEST_BYTES: u64 = 2 * 1024 * 1024;
const MAX_CONTENT_BYTES: usize = 256 * 1024;
const MAX_FILE_BYTES: usize = 1024 * 1024;
const MAX_TEXT_BYTES: usize = 64 * 1024;
const MAX_RESIDUAL_CANDIDATES: usize = 32;
const MAX_RESIDUAL_ENUM_ENTRIES: usize = 4096;
const MAX_RESIDUAL_READ_BYTES: usize = 4 * 1024 * 1024;

#[derive(Deserialize)]
struct Request {
    version: String,
    op: String,
    root_path: String,
    expected_root_id: Option<String>,
    changes: Option<Vec<Change>>,
    files: Option<Vec<ReconcileFile>>,
}

#[derive(Deserialize)]
struct Change {
    path: String,
    action: String,
    baseline_sha256: Option<String>,
    content: Option<String>,
    target_sha256: Option<String>,
    expected_parent_chain: Option<Vec<ChainEntry>>,
    expected_target_id: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
struct ChainEntry {
    path: String,
    id: String,
}

#[derive(Deserialize)]
struct ReconcileFile {
    path: String,
    expected_parent_chain: Vec<ChainEntry>,
    expected_target_id: Option<String>,
    expected_sha256: Option<String>,
}

#[derive(Debug)]
struct Failure {
    code: &'static str,
    message: String,
}

impl Failure {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn valid_sha(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
}

fn valid_id(value: &str) -> bool {
    let Some((volume, file)) = value.split_once(':') else {
        return false;
    };
    volume.len() == 16
        && file.len() == 32
        && volume
            .bytes()
            .chain(file.bytes())
            .all(|b| b.is_ascii_hexdigit())
}

fn segments(path: &str) -> Result<Vec<&str>, Failure> {
    if path.len() > 1024 || path.is_empty() || path.contains('\\') {
        return Err(Failure::new(
            "INVALID_PATH",
            "expected a canonical relative path of at most 1024 bytes",
        ));
    }
    let parts: Vec<_> = path.split('/').collect();
    if parts.iter().any(|s| !safe_segment(s)) {
        return Err(Failure::new(
            "INVALID_PATH",
            "path contains an unsafe Windows segment",
        ));
    }
    let first = parts[0].to_ascii_lowercase();
    if first == ".git"
        || first == "node_modules"
        || first == ".relay"
        || first == "data"
        || first == ".env"
        || first.starts_with(".env.")
    {
        return Err(Failure::new("PROTECTED_PATH", "path is protected"));
    }
    Ok(parts)
}

fn safe_segment(s: &str) -> bool {
    if s.is_empty() || s == "." || s == ".." || s.ends_with(['.', ' ']) || s.len() > 255 {
        return false;
    }
    if s.chars()
        .any(|c| c < '\u{20}' || matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*' | '\\'))
    {
        return false;
    }
    let base = s
        .split('.')
        .next()
        .unwrap_or("")
        .trim_end()
        .to_ascii_lowercase();
    if ["con", "prn", "aux", "nul"].contains(&base.as_str()) {
        return false;
    }
    let reserved = |prefix: &str| {
        base.strip_prefix(prefix).is_some_and(|n| {
            n.chars().count() == 1
                && (matches!(
                    n,
                    "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                ))
        })
    };
    !reserved("com") && !reserved("lpt")
}

fn check_changes(changes: &[Change], execute: bool) -> Result<(), Failure> {
    if changes.is_empty() || changes.len() > 16 {
        return Err(Failure::new(
            "INVALID_REQUEST",
            "changes must contain 1 to 16 files",
        ));
    }
    let mut seen = std::collections::HashSet::new();
    let mut total_content_bytes = 0;
    for change in changes {
        segments(&change.path)?;
        if !seen.insert(change.path.to_lowercase()) {
            return Err(Failure::new("INVALID_REQUEST", "duplicate path"));
        }
        if !matches!(change.action.as_str(), "CREATE" | "MODIFY" | "DELETE") {
            return Err(Failure::new("INVALID_REQUEST", "invalid action"));
        }
        if execute {
            let chain = change.expected_parent_chain.as_ref().ok_or_else(|| {
                Failure::new("INVALID_REQUEST", "expected_parent_chain is required")
            })?;
            check_chain(&change.path, chain)?;
            match change.action.as_str() {
                "CREATE" if change.baseline_sha256.is_some() => {
                    return Err(Failure::new(
                        "INVALID_REQUEST",
                        "CREATE must not have a baseline",
                    ));
                }
                "MODIFY" | "DELETE"
                    if !change.baseline_sha256.as_deref().is_some_and(valid_sha) =>
                {
                    return Err(Failure::new(
                        "INVALID_REQUEST",
                        "MODIFY/DELETE require a baseline hash",
                    ));
                }
                _ => {}
            }
            if change
                .expected_target_id
                .as_deref()
                .is_some_and(|id| !valid_id(id))
            {
                return Err(Failure::new(
                    "INVALID_REQUEST",
                    "target identity is malformed",
                ));
            }
            if change.action == "DELETE" {
                if change.content.is_some() || change.target_sha256.is_some() {
                    return Err(Failure::new("INVALID_REQUEST", "DELETE has no content"));
                }
            } else {
                let content = change
                    .content
                    .as_ref()
                    .ok_or_else(|| Failure::new("INVALID_REQUEST", "content is required"))?;
                total_content_bytes += content.len();
                if total_content_bytes > MAX_CONTENT_BYTES
                    || change.target_sha256.as_deref().is_some_and(|s| {
                        !valid_sha(s) || !s.eq_ignore_ascii_case(&sha(content.as_bytes()))
                    })
                {
                    return Err(Failure::new(
                        "INVALID_REQUEST",
                        "total content exceeds 256 KiB or target hash differs",
                    ));
                }
            }
        }
    }
    Ok(())
}

fn check_chain(path: &str, chain: &[ChainEntry]) -> Result<(), Failure> {
    let parts = segments(path)?;
    if chain.len() > parts.len() - 1 {
        return Err(Failure::new("INVALID_REQUEST", "parent chain is too long"));
    }
    for (i, entry) in chain.iter().enumerate() {
        if entry.path != parts[..=i].join("/") || !valid_id(&entry.id) {
            return Err(Failure::new("INVALID_REQUEST", "parent chain is malformed"));
        }
    }
    Ok(())
}

fn run(request: Request) -> Result<Value, Failure> {
    if request.version != VERSION {
        return Err(Failure::new(
            "INVALID_VERSION",
            "unsupported protocol version",
        ));
    }
    #[cfg(not(windows))]
    {
        let _ = request;
        Err(Failure::new("UNSUPPORTED_PLATFORM", "Windows is required"))
    }
    #[cfg(windows)]
    {
        win::run(request)
    }
}

fn main() {
    if std::env::args_os().skip(1).any(|arg| arg == "--managed-content") {
        std::process::exit(content_protocol::main());
    }
    let mut input = Vec::new();
    let response = match io::stdin()
        .lock()
        .take(MAX_REQUEST_BYTES + 2)
        .read_until(b'\n', &mut input)
    {
        Ok(_) if input.len() as u64 <= MAX_REQUEST_BYTES => {
            let request = serde_json::from_slice::<Request>(&input)
                .map_err(|_| Failure::new("INVALID_JSON", "request must be one JSON line"));
            request.and_then(run)
        }
        _ => Err(Failure::new("REQUEST_TOO_LARGE", "request exceeds 2 MiB")),
    };
    let value = match response {
        Ok(value) => value,
        Err(err) => {
            json!({"version":VERSION,"ok":false,"error":{"code":err.code,"message":err.message}})
        }
    };
    let mut stdout = io::stdout().lock();
    let _ = writeln!(stdout, "{value}");
    let _ = stdout.flush();
}

#[cfg(windows)]
mod win;
mod content_protocol;
