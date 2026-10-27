//! 模型连接凭据的**操作系统级**保护存储（P2 前置设施）。
//!
//! 一次进程一个请求：stdin 一行 JSON，stdout 一行 JSON，与 `relay-file-io-helper` 同一形态。
//! 为什么单独一个二进制：DPAPI 是 Windows 用户级密钥派生，必须由本机进程调用；把它塞进
//! 文件 IO helper 会让一个「搬文件」的组件持有秘密，边界会糊。
//!
//! 边界：
//!   * 只保存**一个**秘密（Provider API Key）与它的不透明引用，不解析业务语义；
//!   * 加密用 DPAPI **当前用户**作用域 + 固定域分隔熵，换用户或换机器都解不开；
//!   * `resolve` 把秘密写到 stdout 的管道里（调用方进程私有），本进程不落日志、不写临时明文；
//!   * 引用必须是安全文件名（无路径分隔符），杜绝 `../` 逃逸；
//!   * 任何错误只回错误码与短消息，**不回显秘密**，也不回显秘密长度以外的内容。

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

const PROTOCOL: &str = "relay-credential-v1";
const MAX_INPUT_BYTES: usize = 64 * 1024;
const MAX_SECRET_BYTES: usize = 8 * 1024;
const MAX_REFERENCE_LEN: usize = 64;
const MIN_REFERENCE_LEN: usize = 8;

#[derive(Deserialize)]
struct Request {
    version: String,
    op: String,
    root: String,
    #[serde(default)]
    reference: String,
    #[serde(default)]
    secret: String,
}

#[derive(Serialize)]
struct ErrorBody {
    code: &'static str,
    message: String,
}

#[derive(Serialize)]
struct Reply {
    version: &'static str,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    exists: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    secret: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<ErrorBody>,
}

impl Reply {
    fn ok() -> Self {
        Reply { version: PROTOCOL, ok: true, exists: None, secret: None, error: None }
    }
    fn failed(code: &'static str, message: impl Into<String>) -> Self {
        Reply { version: PROTOCOL, ok: false, exists: None, secret: None,
            error: Some(ErrorBody { code, message: message.into() }) }
    }
}

/// 引用只接受 `[A-Za-z0-9_-]`，长度 8..=64，且不以 `-`/`_` 开头：
/// 它同时是文件名，任何分隔符或点号都会被拒绝，避免路径逃逸。
fn validate_reference(reference: &str) -> Result<(), &'static str> {
    if reference.len() < MIN_REFERENCE_LEN || reference.len() > MAX_REFERENCE_LEN {
        return Err("INVALID_REFERENCE");
    }
    let bytes = reference.as_bytes();
    let first = bytes[0];
    if !first.is_ascii_alphanumeric() {
        return Err("INVALID_REFERENCE");
    }
    if !bytes.iter().all(|b| b.is_ascii_alphanumeric() || *b == b'-' || *b == b'_') {
        return Err("INVALID_REFERENCE");
    }
    Ok(())
}

fn blob_path(root: &Path, reference: &str) -> PathBuf {
    root.join(format!("{reference}.bin"))
}

fn main() {
    let mut input = String::new();
    let mut stdin = io::stdin().lock();
    let mut limited = Vec::new();
    let mut buffer = [0u8; 8192];
    loop {
        match stdin.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => {
                limited.extend_from_slice(&buffer[..read]);
                if limited.len() > MAX_INPUT_BYTES {
                    emit(Reply::failed("INPUT_TOO_LARGE", "request exceeds the input limit"));
                    return;
                }
            }
            Err(_) => {
                emit(Reply::failed("INPUT_READ_FAILED", "request could not be read"));
                return;
            }
        }
    }
    input.push_str(&String::from_utf8_lossy(&limited));

    let request: Request = match serde_json::from_str(input.trim()) {
        Ok(value) => value,
        Err(_) => {
            emit(Reply::failed("INVALID_REQUEST", "request is not valid JSON"));
            return;
        }
    };
    emit(handle(request));
}

fn emit(reply: Reply) {
    let stdout = io::stdout();
    let mut handle = stdout.lock();
    let _ = handle.write_all(serde_json::to_string(&reply).unwrap_or_default().as_bytes());
    let _ = handle.write_all(b"\n");
    let _ = handle.flush();
}

fn handle(request: Request) -> Reply {
    if request.version != PROTOCOL {
        return Reply::failed("PROTOCOL_MISMATCH", "unsupported protocol version");
    }
    if let Err(code) = validate_reference(&request.reference) {
        return Reply::failed(code, "reference must be 8-64 characters of [A-Za-z0-9_-]");
    }
    let root = PathBuf::from(&request.root);
    if !root.is_absolute() {
        return Reply::failed("INVALID_ROOT", "root must be an absolute path");
    }
    match request.op.as_str() {
        "protect" => protect(&root, &request.reference, &request.secret),
        "resolve" => resolve(&root, &request.reference),
        "delete" => delete(&root, &request.reference),
        "status" => status(&root, &request.reference),
        _ => Reply::failed("UNKNOWN_OP", "unsupported operation"),
    }
}

fn protect(root: &Path, reference: &str, secret: &str) -> Reply {
    if secret.is_empty() {
        return Reply::failed("EMPTY_SECRET", "secret must not be empty");
    }
    if secret.len() > MAX_SECRET_BYTES {
        return Reply::failed("SECRET_TOO_LARGE", "secret exceeds the size limit");
    }
    if let Err(error) = fs::create_dir_all(root) {
        return Reply::failed("ROOT_UNAVAILABLE", format!("root cannot be created: {error}"));
    }
    let protected = match protect_bytes(secret.as_bytes()) {
        Ok(value) => value,
        Err(message) => return Reply::failed("PROTECT_FAILED", message),
    };
    let target = blob_path(root, reference);
    let staging = root.join(format!("{reference}.bin.tmp"));
    if let Err(error) = fs::write(&staging, &protected) {
        return Reply::failed("WRITE_FAILED", format!("staging write failed: {error}"));
    }
    if let Err(error) = fs::rename(&staging, &target) {
        let _ = fs::remove_file(&staging);
        return Reply::failed("WRITE_FAILED", format!("commit failed: {error}"));
    }
    Reply { exists: Some(true), ..Reply::ok() }
}

fn resolve(root: &Path, reference: &str) -> Reply {
    let path = blob_path(root, reference);
    let protected = match fs::read(&path) {
        Ok(value) => value,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Reply { exists: Some(false), ..Reply::failed("NOT_FOUND", "no credential stored")
                .with_exists(false) };
        }
        Err(error) => return Reply::failed("READ_FAILED", format!("read failed: {error}")),
    };
    let plain = match unprotect_bytes(&protected) {
        Ok(value) => value,
        Err(message) => return Reply::failed("UNPROTECT_FAILED", message),
    };
    match String::from_utf8(plain) {
        Ok(secret) => Reply { secret: Some(secret), ..Reply::ok() },
        Err(_) => Reply::failed("UNPROTECT_FAILED", "credential is not valid UTF-8"),
    }
}

fn delete(root: &Path, reference: &str) -> Reply {
    let path = blob_path(root, reference);
    match fs::remove_file(&path) {
        Ok(()) => Reply { exists: Some(false), ..Reply::ok() },
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            Reply { exists: Some(false), ..Reply::ok() }
        }
        Err(error) => Reply::failed("DELETE_FAILED", format!("delete failed: {error}")),
    }
}

fn status(root: &Path, reference: &str) -> Reply {
    let exists = blob_path(root, reference).is_file();
    Reply { exists: Some(exists), ..Reply::ok() }
}

impl Reply {
    fn with_exists(self, exists: bool) -> Self {
        Reply { exists: Some(exists), ..self }
    }
}

/// DPAPI 域分隔熵：不同用途的 blob 不能互相替换，即使同一用户下也一样。
const ENTROPY: &[u8] = b"relay-model-credential-v1";

#[cfg(windows)]
fn protect_bytes(plain: &[u8]) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB, CryptProtectData,
    };

    let mut input = plain.to_vec();
    let mut entropy = ENTROPY.to_vec();
    let mut output = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
    let data_in = CRYPT_INTEGER_BLOB { cbData: input.len() as u32, pbData: input.as_mut_ptr() };
    let entropy_in = CRYPT_INTEGER_BLOB {
        cbData: entropy.len() as u32, pbData: entropy.as_mut_ptr() };
    // 当前用户作用域：不加 CRYPTPROTECT_LOCAL_MACHINE，换用户即解不开。
    let ok = unsafe {
        CryptProtectData(&data_in, std::ptr::null(), &entropy_in, std::ptr::null(),
            std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut output)
    };
    if ok == 0 {
        return Err("DPAPI protect failed".to_string());
    }
    let result = unsafe {
        std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec()
    };
    unsafe { LocalFree(output.pbData as *mut core::ffi::c_void) };
    Ok(result)
}

#[cfg(windows)]
fn unprotect_bytes(protected: &[u8]) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB, CryptUnprotectData,
    };

    let mut input = protected.to_vec();
    let mut entropy = ENTROPY.to_vec();
    let mut output = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
    let data_in = CRYPT_INTEGER_BLOB { cbData: input.len() as u32, pbData: input.as_mut_ptr() };
    let entropy_in = CRYPT_INTEGER_BLOB {
        cbData: entropy.len() as u32, pbData: entropy.as_mut_ptr() };
    let ok = unsafe {
        CryptUnprotectData(&data_in, std::ptr::null_mut(), &entropy_in, std::ptr::null(),
            std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut output)
    };
    if ok == 0 {
        return Err("DPAPI unprotect failed".to_string());
    }
    let result = unsafe {
        std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec()
    };
    unsafe { LocalFree(output.pbData as *mut core::ffi::c_void) };
    Ok(result)
}

#[cfg(not(windows))]
fn protect_bytes(_plain: &[u8]) -> Result<Vec<u8>, String> {
    Err("credential helper requires Windows DPAPI".to_string())
}

#[cfg(not(windows))]
fn unprotect_bytes(_protected: &[u8]) -> Result<Vec<u8>, String> {
    Err("credential helper requires Windows DPAPI".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let mut path = std::env::temp_dir();
        path.push(format!("relay-credential-test-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&path);
        path
    }

    #[test]
    fn reference_validation_rejects_traversal_and_short_tokens() {
        assert!(validate_reference("cred-0001").is_ok());
        assert!(validate_reference("../escape").is_err());
        assert!(validate_reference("a/b").is_err());
        assert!(validate_reference("a\\b").is_err());
        assert!(validate_reference("short").is_err());
        assert!(validate_reference("-leading").is_err());
        assert!(validate_reference(&"a".repeat(65)).is_err());
    }

    #[test]
    fn protect_resolve_delete_round_trip() {
        let root = temp_root("roundtrip");
        let reference = "cred-roundtrip";
        let secret = "synthetic-secret-value-0123456789";
        let protected = protect(&root, reference, secret);
        assert!(protected.ok, "protect failed: {:?}", protected.error.map(|e| e.message));
        assert!(blob_path(&root, reference).is_file());
        // 落盘内容不是明文。
        let bytes = fs::read(blob_path(&root, reference)).unwrap();
        assert!(!bytes.windows(secret.len()).any(|window| window == secret.as_bytes()));

        let resolved = resolve(&root, reference);
        assert!(resolved.ok);
        assert_eq!(resolved.secret.as_deref(), Some(secret));

        let removed = delete(&root, reference);
        assert!(removed.ok);
        assert!(!blob_path(&root, reference).is_file());
        let missing = resolve(&root, reference);
        assert!(!missing.ok);
        assert_eq!(missing.error.as_ref().map(|e| e.code), Some("NOT_FOUND"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn tampered_blob_is_rejected_instead_of_returning_garbage() {
        let root = temp_root("tamper");
        let reference = "cred-tamper";
        assert!(protect(&root, reference, "synthetic-secret").ok);
        let path = blob_path(&root, reference);
        let mut bytes = fs::read(&path).unwrap();
        let last = bytes.len() - 1;
        bytes[last] ^= 0xff;
        fs::write(&path, &bytes).unwrap();
        let resolved = resolve(&root, reference);
        assert!(!resolved.ok);
        assert_eq!(resolved.error.as_ref().map(|e| e.code), Some("UNPROTECT_FAILED"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn empty_secret_is_refused() {
        let root = temp_root("empty");
        let reply = protect(&root, "cred-empty", "");
        assert!(!reply.ok);
        assert_eq!(reply.error.as_ref().map(|e| e.code), Some("EMPTY_SECRET"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn delete_is_idempotent() {
        let root = temp_root("idempotent");
        let reply = delete(&root, "cred-absent");
        assert!(reply.ok);
        assert_eq!(reply.exists, Some(false));
    }
}
