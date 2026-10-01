use super::*;
use crate::content_protocol::{self, Request};
use std::io::{BufRead, Write};
use windows_sys::Win32::Foundation::ERROR_LOCK_VIOLATION;
use windows_sys::Win32::Storage::FileSystem::{
    LOCKFILE_EXCLUSIVE_LOCK, LOCKFILE_FAIL_IMMEDIATELY, LockFileEx,
};
use windows_sys::Win32::System::IO::OVERLAPPED;

const SENTINEL: &str = ".relay-content-admission.lock";

fn admission(root: &Handle, exclusive: bool) -> Result<(Handle, String), Failure> {
    // Read-only shared opens deny WRITE/DELETE sharing, so no participant can
    // replace the sentinel while another participant has its real handle.
    let file = nt_open(
        root,
        SENTINEL,
        READ_DATA | READ_ATTRIBUTES | SYNCHRONIZE,
        FILE_SHARE_READ,
        3,
        NT_NON_DIRECTORY | NT_OPEN_REPARSE,
    )?
    .ok_or_else(|| Failure::new("LOCK_UNAVAILABLE", "content sentinel unavailable"))?;
    let id = information(&file, false)?;
    let mut overlapped: OVERLAPPED = unsafe { zeroed() };
    let flags = LOCKFILE_FAIL_IMMEDIATELY
        | if exclusive {
            LOCKFILE_EXCLUSIVE_LOCK
        } else {
            0
        };
    if unsafe { LockFileEx(file.0, flags, 0, 1, 0, &mut overlapped) } == 0 {
        return Err(if unsafe { GetLastError() } == ERROR_LOCK_VIOLATION {
            Failure::new(
                if exclusive {
                    "CONTENT_FREEZE_BUSY"
                } else {
                    "CONTENT_FROZEN"
                },
                "content admission is held",
            )
        } else {
            win_error("LOCK_UNAVAILABLE")
        });
    }
    if information(&file, false)? != id {
        return Err(Failure::new(
            "LOCK_UNAVAILABLE",
            "content sentinel identity changed",
        ));
    }
    Ok((file, id))
}

fn directory(parent: &Handle, name: &str) -> Result<Handle, Failure> {
    if let Some(handle) = open_directory(parent, name)? {
        return Ok(handle);
    }
    match create_directory(parent, name) {
        Ok(handle) => Ok(handle),
        Err(error) if error.code == "CONFLICT" => open_directory(parent, name)?
            .ok_or_else(|| Failure::new("PARENT_CHANGED", "content directory disappeared")),
        Err(error) => Err(error),
    }
}

fn bytes(hex: &str) -> Result<Vec<u8>, Failure> {
    if hex.len() > MAX_CONTENT_BYTES * 2 || !hex.len().is_multiple_of(2) {
        return Err(Failure::new(
            "INVALID_CONTENT",
            "content exceeds 256 KiB or invalid hex",
        ));
    }
    hex.as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let digit = |byte: u8| match byte {
                b'0'..=b'9' => Some(byte - b'0'),
                b'a'..=b'f' => Some(byte - b'a' + 10),
                _ => None,
            };
            match (digit(pair[0]), digit(pair[1])) {
                (Some(high), Some(low)) => Ok(high * 16 + low),
                _ => Err(Failure::new("INVALID_CONTENT", "invalid content hex")),
            }
        })
        .collect()
}

pub(crate) fn run(
    request: Request,
    input: &mut impl BufRead,
    stdout: &mut impl Write,
) -> Result<(), Failure> {
    let (version, path) = match &request {
        Request::Publish {
            version, root_path, ..
        }
        | Request::Freeze {
            version, root_path, ..
        } => (version, root_path),
    };
    if version != content_protocol::VERSION {
        return Err(Failure::new(
            "INVALID_VERSION",
            "unsupported content protocol",
        ));
    }
    // Root and every ancestor stay open without DELETE sharing throughout IO.
    let (roots, root_id) = root(path, None)?;
    let root = roots.last().unwrap();
    match request {
        Request::Publish {
            artifact_id,
            version_id,
            content_hex,
            ..
        } => {
            if !content_protocol::uuid(&artifact_id) || !content_protocol::uuid(&version_id) {
                return Err(Failure::new(
                    "INVALID_CONTENT",
                    "content IDs must be canonical UUIDs",
                ));
            }
            let content = bytes(&content_hex)?;
            let (_shared, sentinel_id) = admission(root, false)?;
            test_latch("content_shared", None)?;
            // No staging/target directory or file exists before shared admission.
            let staging = directory(root, "staging")?;
            let stage_name = format!("{version_id}.part");
            let stage_handle = create_file(&staging, &stage_name).map_err(|error| {
                if error.code == "CONFLICT" {
                    Failure::new("STAGING_OCCUPIED", "content staging already exists")
                } else {
                    error
                }
            })?;
            let mut stage = Staged {
                handle: stage_handle,
                committed: false,
            };
            test_latch("content_stage_created", None)?;
            set_delete_pending(&stage.handle, true)?;
            if link_count(&stage.handle)? != 0 {
                return Err(Failure::new(
                    "HARD_LINK",
                    "content staging acquired another link",
                ));
            }
            write_bytes(&stage.handle, &content)?;
            set_delete_pending(&stage.handle, false)?;
            information(&stage.handle, false)?;
            let artifacts = directory(root, "artifacts")?;
            let artifact = directory(&artifacts, &artifact_id)?;
            let version = directory(&artifact, &version_id)?;
            test_latch("content_before_rename", None)?;
            rename_relative(&stage.handle, &version, "content.md")?;
            stage.committed = true;
            information(&stage.handle, false)?;
            if unsafe { FlushFileBuffers(stage.handle.0) } == 0 {
                return Err(win_error("FLUSH_FAILED"));
            }
            content_protocol::output(
                stdout,
                json!({ "version": content_protocol::VERSION,
                "ok": true, "op": "publish-content", "root_id": root_id, "sentinel_id": sentinel_id,
                "storage_ref": format!("artifacts/{artifact_id}/{version_id}/content.md"),
                "sha256": sha(&content), "size": content.len().to_string() }),
            )
        }
        Request::Freeze { nonce, .. } => {
            if !content_protocol::uuid(&nonce) {
                return Err(Failure::new("INVALID_INPUT", "invalid private nonce"));
            }
            let (exclusive, sentinel_id) = admission(root, true)?;
            content_protocol::output(
                stdout,
                json!({ "version": content_protocol::VERSION, "ok": true,
                "event": "content_freeze_ready", "nonce": nonce, "root_id": root_id,
                "sentinel_id": sentinel_id }),
            )?;
            let Some(frame) = content_protocol::frame(input, 16 * 1024)? else {
                return Ok(());
            };
            let release: content_protocol::Release = serde_json::from_slice(&frame)
                .map_err(|_| Failure::new("INVALID_INPUT", "invalid release frame"))?;
            if release.version != content_protocol::VERSION
                || release.op != "release-content-freeze"
                || release.nonce != nonce
            {
                return Err(Failure::new("INVALID_INPUT", "release identity differs"));
            }
            drop(exclusive);
            content_protocol::output(
                stdout,
                json!({ "version": content_protocol::VERSION, "ok": true,
                "event": "content_freeze_released", "nonce": nonce }),
            )
        }
    }
}
