use super::*;
use std::ffi::c_void;
use std::mem::{size_of, zeroed};
use std::os::windows::ffi::OsStrExt;
use std::ptr::{null, null_mut};
use windows_sys::Win32::Foundation::{
    CloseHandle, ERROR_NO_MORE_FILES, GENERIC_READ, GetLastError, HANDLE, INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Storage::FileSystem::{
    BY_HANDLE_FILE_INFORMATION, CreateFileW, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_NORMAL,
    FILE_ATTRIBUTE_REPARSE_POINT, FILE_ATTRIBUTE_TAG_INFO, FILE_BASIC_INFO, FILE_BEGIN,
    FILE_DISPOSITION_INFO, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
    FILE_ID_EXTD_DIR_INFO, FILE_ID_INFO, FILE_RENAME_INFO, FILE_SHARE_READ, FILE_SHARE_WRITE,
    FileAttributeTagInfo, FileBasicInfo, FileDispositionInfo, FileIdExtdDirectoryInfo,
    FileIdExtdDirectoryRestartInfo, FileIdInfo, FlushFileBuffers, GetFileInformationByHandle,
    GetFileInformationByHandleEx, GetFinalPathNameByHandleW, OPEN_EXISTING, ReadFile, SetEndOfFile,
    SetFileInformationByHandle, SetFilePointerEx, WriteFile,
};

const READ_DATA: u32 = 0x0001;
const WRITE_DATA: u32 = 0x0002;
const TRAVERSE: u32 = 0x0020;
const READ_ATTRIBUTES: u32 = 0x0080;
const DELETE: u32 = 0x00010000;
const SYNCHRONIZE: u32 = 0x00100000;
const NT_FILE_OPEN: u32 = 1;
const NT_FILE_CREATE: u32 = 2;
const NT_DIRECTORY: u32 = 0x0001;
const NT_NON_DIRECTORY: u32 = 0x0040;
const NT_SYNCHRONOUS: u32 = 0x0020;
const NT_OPEN_REPARSE: u32 = 0x00200000;
const OBJ_CASE_INSENSITIVE: u32 = 0x0040;
const STATUS_NAME_NOT_FOUND: u32 = 0xc0000034;
const STATUS_PATH_NOT_FOUND: u32 = 0xc000003a;
const STATUS_NAME_COLLISION: u32 = 0xc0000035;

#[repr(C)]
struct UnicodeString {
    length: u16,
    maximum_length: u16,
    buffer: *mut u16,
}

#[repr(C)]
struct ObjectAttributes {
    length: u32,
    root_directory: HANDLE,
    object_name: *mut UnicodeString,
    attributes: u32,
    security_descriptor: *mut c_void,
    security_quality_of_service: *mut c_void,
}

#[repr(C)]
struct IoStatusBlock {
    status: usize,
    information: usize,
}

#[link(name = "ntdll")]
unsafe extern "system" {
    fn NtCreateFile(
        file_handle: *mut HANDLE,
        desired_access: u32,
        object_attributes: *mut ObjectAttributes,
        io_status_block: *mut IoStatusBlock,
        allocation_size: *mut i64,
        file_attributes: u32,
        share_access: u32,
        create_disposition: u32,
        create_options: u32,
        ea_buffer: *mut c_void,
        ea_length: u32,
    ) -> i32;
    fn NtSetInformationFile(
        file_handle: HANDLE,
        io_status_block: *mut IoStatusBlock,
        file_information: *mut c_void,
        length: u32,
        file_information_class: u32,
    ) -> i32;
}

#[link(name = "bcrypt")]
unsafe extern "system" {
    fn BCryptGenRandom(algorithm: HANDLE, buffer: *mut u8, length: u32, flags: u32) -> i32;
}

struct Handle(HANDLE);

impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}

fn win_error(code: &'static str) -> Failure {
    Failure::new(code, format!("Windows error {}", unsafe { GetLastError() }))
}

fn nt_open(
    parent: &Handle,
    name: &str,
    access: u32,
    share: u32,
    disposition: u32,
    options: u32,
) -> Result<Option<Handle>, Failure> {
    let mut wide: Vec<u16> = std::ffi::OsStr::new(name).encode_wide().collect();
    let byte_len = wide.len() * 2;
    if byte_len > u16::MAX as usize - 2 {
        return Err(Failure::new(
            "INVALID_PATH",
            "segment exceeds NT name limit",
        ));
    }
    let mut unicode = UnicodeString {
        length: byte_len as u16,
        maximum_length: byte_len as u16,
        buffer: wide.as_mut_ptr(),
    };
    let mut attrs = ObjectAttributes {
        length: size_of::<ObjectAttributes>() as u32,
        root_directory: parent.0,
        object_name: &mut unicode,
        attributes: OBJ_CASE_INSENSITIVE,
        security_descriptor: null_mut(),
        security_quality_of_service: null_mut(),
    };
    let mut io = IoStatusBlock {
        status: 0,
        information: 0,
    };
    let mut handle = null_mut();
    let status = unsafe {
        NtCreateFile(
            &mut handle,
            access,
            &mut attrs,
            &mut io,
            null_mut(),
            FILE_ATTRIBUTE_NORMAL,
            share,
            disposition,
            options | NT_SYNCHRONOUS,
            null_mut(),
            0,
        )
    };
    if status >= 0 {
        if handle.is_null() || handle == INVALID_HANDLE_VALUE {
            return Err(Failure::new(
                "NT_OPEN_FAILED",
                "NtCreateFile returned no handle",
            ));
        }
        Ok(Some(Handle(handle)))
    } else if matches!(status as u32, STATUS_NAME_NOT_FOUND | STATUS_PATH_NOT_FOUND)
        && disposition == NT_FILE_OPEN
    {
        Ok(None)
    } else if status as u32 == STATUS_NAME_COLLISION && disposition == NT_FILE_CREATE {
        Err(Failure::new("CONFLICT", "entry was created concurrently"))
    } else {
        Err(Failure::new(
            "NT_OPEN_FAILED",
            format!("NtCreateFile status 0x{:08x}", status as u32),
        ))
    }
}

fn information(handle: &Handle, directory: bool) -> Result<String, Failure> {
    let mut attr: FILE_ATTRIBUTE_TAG_INFO = unsafe { zeroed() };
    let ok = unsafe {
        GetFileInformationByHandleEx(
            handle.0,
            FileAttributeTagInfo,
            &mut attr as *mut _ as *mut c_void,
            size_of::<FILE_ATTRIBUTE_TAG_INFO>() as u32,
        )
    };
    if ok == 0 {
        return Err(win_error("IDENTITY_UNAVAILABLE"));
    }
    if attr.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || (attr.FileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0) != directory
    {
        return Err(Failure::new(
            "UNSAFE_ENTRY",
            "entry is a reparse point or wrong type",
        ));
    }
    let mut info: FILE_ID_INFO = unsafe { zeroed() };
    let ok = unsafe {
        GetFileInformationByHandleEx(
            handle.0,
            FileIdInfo,
            &mut info as *mut _ as *mut c_void,
            size_of::<FILE_ID_INFO>() as u32,
        )
    };
    if ok == 0 {
        return Err(win_error("IDENTITY_UNAVAILABLE"));
    }
    if !directory && link_count(handle)? != 1 {
        return Err(Failure::new("HARD_LINK", "target has multiple hard links"));
    }
    let file_id: String = info
        .FileId
        .Identifier
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    Ok(format!("{:016x}:{file_id}", info.VolumeSerialNumber))
}

fn link_count(handle: &Handle) -> Result<u32, Failure> {
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { zeroed() };
    if unsafe { GetFileInformationByHandle(handle.0, &mut info) } == 0 {
        return Err(win_error("IDENTITY_UNAVAILABLE"));
    }
    Ok(info.nNumberOfLinks)
}

fn root(path: &str, expected: Option<&str>) -> Result<(Vec<Handle>, String), Failure> {
    let bytes = path.as_bytes();
    if bytes.len() > 4096
        || bytes.len() < 3
        || !bytes[0].is_ascii_alphabetic()
        || bytes[1] != b':'
        || bytes[2] != b'\\'
        || path.contains('\0')
    {
        return Err(Failure::new(
            "INVALID_ROOT",
            "root_path must be an absolute drive path",
        ));
    }
    let tail = &path[3..];
    if tail.split('\\').any(|part| part == "." || part == "..")
        || path.contains('/')
        || path.contains("\\\\")
    {
        return Err(Failure::new(
            "INVALID_ROOT",
            "root_path must be lexically canonical",
        ));
    }
    let drive = &path[..3];
    let wide: Vec<u16> = std::ffi::OsStr::new(drive)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let raw = unsafe {
        CreateFileW(
            wide.as_ptr(),
            GENERIC_READ,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            null_mut(),
        )
    };
    if raw == INVALID_HANDLE_VALUE {
        return Err(win_error("ROOT_UNAVAILABLE"));
    }
    let mut handles = vec![Handle(raw)];
    information(&handles[0], true)?;
    for segment in tail.split('\\').filter(|part| !part.is_empty()) {
        if !safe_segment(segment) {
            return Err(Failure::new("INVALID_ROOT", "unsafe root ancestor segment"));
        }
        let next = open_directory(handles.last().unwrap(), segment)?
            .ok_or_else(|| Failure::new("ROOT_UNAVAILABLE", "root ancestor is missing"))?;
        handles.push(next);
    }
    let handle = handles.last().unwrap();
    let id = information(handle, true)?;
    let needed = unsafe { GetFinalPathNameByHandleW(handle.0, null_mut(), 0, 0) };
    if needed == 0 || needed > 32767 {
        return Err(win_error("ROOT_PATH_UNAVAILABLE"));
    }
    let mut final_path = vec![0_u16; needed as usize + 1];
    let count = unsafe {
        GetFinalPathNameByHandleW(
            handle.0,
            final_path.as_mut_ptr(),
            final_path.len() as u32,
            0,
        )
    };
    if count == 0 || count as usize >= final_path.len() {
        return Err(win_error("ROOT_PATH_UNAVAILABLE"));
    }
    let resolved = String::from_utf16(&final_path[..count as usize])
        .map_err(|_| Failure::new("ROOT_PATH_UNAVAILABLE", "invalid final path"))?;
    let resolved = resolved
        .strip_prefix("\\\\?\\")
        .ok_or_else(|| Failure::new("ROOT_PATH_UNAVAILABLE", "unexpected final path form"))?;
    fn trim_root(s: &str) -> &str {
        if s.len() > 3 {
            s.trim_end_matches('\\')
        } else {
            s
        }
    }
    if !trim_root(resolved).eq_ignore_ascii_case(trim_root(path)) {
        return Err(Failure::new(
            "ROOT_PATH_CHANGED",
            "managed root moved or an ancestor redirected",
        ));
    }
    if let Some(expected) = expected
        && (!valid_id(expected) || !id.eq_ignore_ascii_case(expected))
    {
        return Err(Failure::new(
            "ROOT_CHANGED",
            "managed root identity differs",
        ));
    }
    Ok((handles, id))
}

fn open_directory(parent: &Handle, name: &str) -> Result<Option<Handle>, Failure> {
    let entry = nt_open(
        parent,
        name,
        TRAVERSE | READ_ATTRIBUTES | SYNCHRONIZE,
        FILE_SHARE_READ | FILE_SHARE_WRITE,
        NT_FILE_OPEN,
        NT_OPEN_REPARSE,
    )?;
    if let Some(ref handle) = entry {
        information(handle, true)?;
    }
    Ok(entry)
}

fn open_listing_directory(
    parent: &Handle,
    name: &str,
    expected_id: &str,
) -> Result<Handle, Failure> {
    let handle = nt_open(
        parent,
        name,
        READ_DATA | READ_ATTRIBUTES | SYNCHRONIZE,
        FILE_SHARE_READ | FILE_SHARE_WRITE,
        NT_FILE_OPEN,
        NT_OPEN_REPARSE | NT_DIRECTORY,
    )?
    .ok_or_else(|| Failure::new("PARENT_CHANGED", "directory disappeared before enumeration"))?;
    let id = information(&handle, true)?;
    if !id.eq_ignore_ascii_case(expected_id) {
        return Err(Failure::new("PARENT_CHANGED", "directory identity changed"));
    }
    Ok(handle)
}

fn directory_times(handle: &Handle) -> Result<(i64, i64), Failure> {
    let mut basic: FILE_BASIC_INFO = unsafe { zeroed() };
    if unsafe {
        GetFileInformationByHandleEx(
            handle.0,
            FileBasicInfo,
            &mut basic as *mut _ as *mut c_void,
            size_of::<FILE_BASIC_INFO>() as u32,
        )
    } == 0
    {
        return Err(win_error("DIRECTORY_CHANGED"));
    }
    Ok((basic.LastWriteTime, basic.ChangeTime))
}

struct ResidualName {
    name: String,
    id: String,
    attributes: u32,
}

fn residual_names(directory: &Handle, volume: &str) -> Result<Vec<ResidualName>, Failure> {
    let mut names = Vec::new();
    let mut scanned = 0;
    let mut first = true;
    let mut seen = std::collections::HashSet::new();
    loop {
        // The API resumes from the same held directory handle on later calls.
        let mut buffer = vec![0_u64; 8192];
        let class = if first {
            FileIdExtdDirectoryRestartInfo
        } else {
            FileIdExtdDirectoryInfo
        };
        first = false;
        if unsafe {
            GetFileInformationByHandleEx(
                directory.0,
                class,
                buffer.as_mut_ptr() as *mut c_void,
                (buffer.len() * size_of::<u64>()) as u32,
            )
        } == 0
        {
            if unsafe { GetLastError() } == ERROR_NO_MORE_FILES {
                return Ok(names);
            }
            return Err(win_error("ENUMERATION_FAILED"));
        }
        let bytes = buffer.len() * size_of::<u64>();
        let mut offset = 0_usize;
        loop {
            let minimum = std::mem::offset_of!(FILE_ID_EXTD_DIR_INFO, FileName);
            if offset + minimum > bytes {
                return Err(Failure::new(
                    "ENUMERATION_FAILED",
                    "malformed directory entry",
                ));
            }
            let entry = unsafe {
                &*((buffer.as_ptr() as *const u8).add(offset) as *const FILE_ID_EXTD_DIR_INFO)
            };
            let length = entry.FileNameLength as usize;
            let next = entry.NextEntryOffset as usize;
            let entry_end = if next == 0 { bytes } else { offset + next };
            if length == 0
                || !length.is_multiple_of(2)
                || entry_end > bytes
                || next != 0 && (next < minimum || !next.is_multiple_of(8))
                || offset + minimum + length > entry_end
            {
                return Err(Failure::new(
                    "ENUMERATION_FAILED",
                    "malformed directory entry",
                ));
            }
            scanned += 1;
            if scanned > MAX_RESIDUAL_ENUM_ENTRIES {
                return Err(Failure::new(
                    "ENUMERATION_LIMIT",
                    "directory exceeds 4096 entries",
                ));
            }
            let characters = unsafe {
                std::slice::from_raw_parts(
                    std::ptr::addr_of!(entry.FileName) as *const u16,
                    length / 2,
                )
            };
            let name = String::from_utf16(characters)
                .map_err(|_| Failure::new("ENUMERATION_FAILED", "invalid directory name"))?;
            if name.to_ascii_lowercase().starts_with(".__relay-file-io-") {
                if !safe_segment(&name) || !seen.insert(name.to_lowercase()) {
                    return Err(Failure::new(
                        "UNSAFE_ENTRY",
                        "unsafe or duplicate residual name",
                    ));
                }
                if names.len() >= MAX_RESIDUAL_CANDIDATES {
                    return Err(Failure::new(
                        "RESIDUAL_LIMIT",
                        "more than 32 residual candidates",
                    ));
                }
                let file_id: String = entry
                    .FileId
                    .Identifier
                    .iter()
                    .map(|b| format!("{b:02x}"))
                    .collect();
                names.push(ResidualName {
                    name,
                    id: format!("{volume}:{file_id}"),
                    attributes: entry.FileAttributes,
                });
            }
            if next == 0 {
                break;
            }
            offset = entry_end;
        }
    }
}

fn create_directory(parent: &Handle, name: &str) -> Result<Handle, Failure> {
    let entry = nt_open(
        parent,
        name,
        TRAVERSE | READ_ATTRIBUTES | SYNCHRONIZE,
        FILE_SHARE_READ | FILE_SHARE_WRITE,
        NT_FILE_CREATE,
        NT_DIRECTORY,
    )?;
    let handle = entry
        .ok_or_else(|| Failure::new("CREATE_FAILED", "directory creation returned no handle"))?;
    information(&handle, true)?;
    Ok(handle)
}

fn open_file(parent: &Handle, name: &str, delete_access: bool) -> Result<Option<Handle>, Failure> {
    let access = READ_DATA | READ_ATTRIBUTES | SYNCHRONIZE | if delete_access { DELETE } else { 0 };
    let entry = nt_open(
        parent,
        name,
        access,
        0,
        NT_FILE_OPEN,
        NT_OPEN_REPARSE | NT_NON_DIRECTORY,
    )?;
    if let Some(ref handle) = entry {
        information(handle, false)?;
    }
    Ok(entry)
}

fn create_file(parent: &Handle, name: &str) -> Result<Handle, Failure> {
    let entry = nt_open(
        parent,
        name,
        READ_DATA | WRITE_DATA | READ_ATTRIBUTES | DELETE | SYNCHRONIZE,
        0,
        NT_FILE_CREATE,
        NT_NON_DIRECTORY,
    )?;
    let handle =
        entry.ok_or_else(|| Failure::new("CREATE_FAILED", "file creation returned no handle"))?;
    Ok(handle)
}

fn read_bytes(handle: &Handle) -> Result<Vec<u8>, Failure> {
    if unsafe { SetFilePointerEx(handle.0, 0, null_mut(), FILE_BEGIN) } == 0 {
        return Err(win_error("READ_FAILED"));
    }
    let mut output = Vec::new();
    let mut chunk = [0_u8; 8192];
    loop {
        let mut count = 0;
        if unsafe {
            ReadFile(
                handle.0,
                chunk.as_mut_ptr(),
                chunk.len() as u32,
                &mut count,
                null_mut(),
            )
        } == 0
        {
            return Err(win_error("READ_FAILED"));
        }
        if count == 0 {
            return Ok(output);
        }
        if output.len() + count as usize > MAX_FILE_BYTES {
            return Err(Failure::new(
                "FILE_TOO_LARGE",
                "file exceeds 1 MiB read limit",
            ));
        }
        output.extend_from_slice(&chunk[..count as usize]);
    }
}

fn write_bytes(handle: &Handle, bytes: &[u8]) -> Result<(), Failure> {
    if unsafe { SetFilePointerEx(handle.0, 0, null_mut(), FILE_BEGIN) } == 0
        || unsafe { SetEndOfFile(handle.0) } == 0
    {
        return Err(win_error("WRITE_FAILED"));
    }
    let mut offset = 0;
    while offset < bytes.len() {
        let mut written = 0;
        if unsafe {
            WriteFile(
                handle.0,
                bytes[offset..].as_ptr(),
                (bytes.len() - offset) as u32,
                &mut written,
                null_mut(),
            )
        } == 0
            || written == 0
        {
            return Err(win_error("WRITE_FAILED"));
        }
        offset += written as usize;
    }
    if unsafe { FlushFileBuffers(handle.0) } == 0 {
        return Err(win_error("FLUSH_FAILED"));
    }
    if read_bytes(handle)? != bytes {
        return Err(Failure::new(
            "VERIFY_FAILED",
            "written bytes differ on held handle",
        ));
    }
    Ok(())
}

fn set_delete_pending(handle: &Handle, delete: bool) -> Result<(), Failure> {
    let disposition = FILE_DISPOSITION_INFO { DeleteFile: delete };
    if unsafe {
        SetFileInformationByHandle(
            handle.0,
            FileDispositionInfo,
            &disposition as *const _ as *const c_void,
            size_of::<FILE_DISPOSITION_INFO>() as u32,
        )
    } == 0
    {
        return Err(win_error("DELETE_FAILED"));
    }
    Ok(())
}

fn delete_file(handle: &Handle) -> Result<(), Failure> {
    set_delete_pending(handle, true)
}

fn staging_name() -> Result<String, Failure> {
    let mut random = [0_u8; 16];
    let status =
        unsafe { BCryptGenRandom(null_mut(), random.as_mut_ptr(), random.len() as u32, 2) };
    if status < 0 {
        return Err(Failure::new(
            "RANDOM_UNAVAILABLE",
            "cannot create staging name",
        ));
    }
    let suffix: String = random.iter().map(|b| format!("{b:02x}")).collect();
    Ok(format!(".__relay-file-io-{suffix}.tmp"))
}

fn rename_relative(source: &Handle, parent: &Handle, target: &str) -> Result<(), Failure> {
    let name: Vec<u16> = std::ffi::OsStr::new(target).encode_wide().collect();
    let offset = std::mem::offset_of!(FILE_RENAME_INFO, FileName);
    let size = offset + (name.len() + 1) * 2;
    let mut storage = vec![0_u64; size.max(size_of::<FILE_RENAME_INFO>()).div_ceil(8)];
    let info = storage.as_mut_ptr() as *mut FILE_RENAME_INFO;
    unsafe {
        (*info).Anonymous.ReplaceIfExists = false;
        (*info).RootDirectory = parent.0;
        (*info).FileNameLength = (name.len() * 2) as u32;
        std::ptr::copy_nonoverlapping(
            name.as_ptr(),
            std::ptr::addr_of_mut!((*info).FileName) as *mut u16,
            name.len(),
        );
        let mut iosb = IoStatusBlock {
            status: 0,
            information: 0,
        };
        let status =
            NtSetInformationFile(source.0, &mut iosb, info as *mut c_void, size as u32, 10);
        if status < 0 {
            let code = if status as u32 == STATUS_NAME_COLLISION {
                "CONFLICT"
            } else {
                "RENAME_FAILED"
            };
            return Err(Failure::new(
                code,
                format!("NtSetInformationFile status 0x{:08x}", status as u32),
            ));
        }
    }
    Ok(())
}

struct Staged {
    handle: Handle,
    committed: bool,
}

impl Drop for Staged {
    fn drop(&mut self) {
        if !self.committed {
            let _ = set_delete_pending(&self.handle, true);
        }
    }
}

fn prepare_stage(parent: &Handle, content: &[u8]) -> Result<Staged, Failure> {
    let temporary_name = staging_name()?;
    let handle = create_file(parent, &temporary_name)?;
    let stage = Staged {
        handle,
        committed: false,
    };
    test_latch("post_create", Some(&temporary_name))?;
    // A hard link may be created between create and this mark. The link count
    // below detects that before any bytes are written. Once marked pending,
    // Windows rejects new links to this staging object.
    set_delete_pending(&stage.handle, true)?;
    if link_count(&stage.handle)? != 0 {
        return Err(Failure::new(
            "HARD_LINK",
            "staging object acquired another hard link before deletion lock",
        ));
    }
    test_latch("stage", Some(&temporary_name))?;
    write_bytes(&stage.handle, content)?;
    set_delete_pending(&stage.handle, false)?;
    information(&stage.handle, false)?;
    Ok(stage)
}

fn commit_stage(stage: &mut Staged, parent: &Handle, target: &str) -> Result<String, Failure> {
    rename_relative(&stage.handle, parent, target)?;
    stage.committed = true;
    information(&stage.handle, false)
}

// The integration test uses this latch only in debug builds to try a rename
// while the production code is holding the relevant directory/file handles.
#[cfg(debug_assertions)]
fn test_latch(stage: &str, detail: Option<&str>) -> Result<(), Failure> {
    if std::env::var("RELAY_FILE_IO_TEST_STAGE").ok().as_deref() != Some(stage) {
        return Ok(());
    }
    let ready = std::env::var("RELAY_FILE_IO_TEST_READY")
        .map_err(|_| Failure::new("TEST_LATCH", "missing ready path"))?;
    let release = std::env::var("RELAY_FILE_IO_TEST_RELEASE")
        .map_err(|_| Failure::new("TEST_LATCH", "missing release path"))?;
    let pid;
    let marker = if stage == "gap" && detail.is_none() {
        pid = std::process::id().to_string();
        pid.as_str()
    } else {
        detail.unwrap_or("ready")
    };
    std::fs::write(ready, marker).map_err(|_| Failure::new("TEST_LATCH", "cannot signal ready"))?;
    for _ in 0..1000 {
        if std::path::Path::new(&release).exists() {
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    Err(Failure::new("TEST_LATCH", "release timed out"))
}

#[cfg(not(debug_assertions))]
fn test_latch(_stage: &str, _detail: Option<&str>) -> Result<(), Failure> {
    Ok(())
}

struct Parents {
    handles: Vec<Handle>,
    chain: Vec<ChainEntry>,
    exists: bool,
    created: bool,
}

impl Parents {
    fn last<'a>(&'a self, root: &'a Handle) -> &'a Handle {
        self.handles.last().unwrap_or(root)
    }
}

fn parents(
    root: &Handle,
    parts: &[&str],
    expected: Option<&[ChainEntry]>,
    create: bool,
) -> Result<Parents, Failure> {
    let mut result = Parents {
        handles: Vec::new(),
        chain: Vec::new(),
        exists: true,
        created: false,
    };
    for (i, segment) in parts[..parts.len() - 1].iter().enumerate() {
        let path = parts[..=i].join("/");
        let expected_id = expected.and_then(|chain| chain.get(i));
        let handle = if expected.is_some() && expected_id.is_none() && create {
            result.created = true;
            create_directory(result.last(root), segment)?
        } else if expected.is_some() && expected_id.is_none() {
            if open_directory(result.last(root), segment)?.is_some() {
                return Err(Failure::new(
                    "CONFLICT",
                    "previously absent parent now exists",
                ));
            }
            result.exists = false;
            break;
        } else {
            match open_directory(result.last(root), segment)? {
                Some(handle) => handle,
                None => {
                    if expected_id.is_some() {
                        return Err(Failure::new("CONFLICT", "expected parent is missing"));
                    }
                    result.exists = false;
                    break;
                }
            }
        };
        let id = information(&handle, true)?;
        if expected_id.is_some_and(|entry| !id.eq_ignore_ascii_case(&entry.id)) {
            return Err(Failure::new("CONFLICT", "parent identity changed"));
        }
        result.chain.push(ChainEntry { path, id });
        result.handles.push(handle);
    }
    if expected.is_some_and(|chain| result.chain.len() < chain.len()) {
        return Err(Failure::new(
            "CONFLICT",
            "expected parent chain is incomplete",
        ));
    }
    Ok(result)
}

fn text_value(bytes: &[u8]) -> (Option<String>, Option<&'static str>) {
    if bytes.len() > MAX_TEXT_BYTES {
        return (None, Some("TEXT_TOO_LARGE"));
    }
    if bytes
        .iter()
        .any(|b| *b == 0 || (*b < 32 && !matches!(*b, 9 | 10 | 13)))
    {
        return (None, Some("BINARY_OR_INVALID_UTF8"));
    }
    match String::from_utf8(bytes.to_vec()) {
        Ok(text) => (Some(text), None),
        Err(_) => (None, Some("BINARY_OR_INVALID_UTF8")),
    }
}

fn capture(root: &Handle, changes: Vec<Change>) -> Value {
    let mut files = Vec::new();
    for change in changes {
        let parts = match segments(&change.path) {
            Ok(v) => v,
            Err(_) => unreachable!(),
        };
        let mut result = json!({"path":change.path,"action":change.action,"parent_chain":[],
            "target_id":null,"sha256":null,"text":null,"text_unavailable_reason":null});
        match parents(root, &parts, None, false) {
            Ok(p) => {
                result["parent_chain"] = json!(p.chain);
                if p.exists {
                    match open_file(p.last(root), parts[parts.len() - 1], false) {
                        Ok(Some(handle)) => {
                            match (information(&handle, false), read_bytes(&handle)) {
                                (Ok(id), Ok(bytes)) => {
                                    let (text, reason) = text_value(&bytes);
                                    result["target_id"] = json!(id);
                                    result["sha256"] = json!(sha(&bytes));
                                    result["text"] = json!(text);
                                    result["text_unavailable_reason"] = json!(reason);
                                }
                                (Err(error), _) | (_, Err(error)) => {
                                    result["error"] = json!(error.code)
                                }
                            }
                        }
                        Ok(None) => {}
                        Err(error) => result["error"] = json!(error.code),
                    }
                }
            }
            Err(error) => result["error"] = json!(error.code),
        }
        files.push(result);
    }
    json!(files)
}

fn execute(root: &Handle, changes: Vec<Change>) -> Value {
    let mut results = Vec::new();
    let mut all_applied = true;
    for change in changes {
        let parts = segments(&change.path).expect("prevalidated path");
        let mut result = json!({"path":change.path,"action":change.action,"status":"FAILED",
            "parent_chain":[],"target_id":null,"actual_sha256":null,"effect_uncertain":false});
        let expected = change
            .expected_parent_chain
            .as_deref()
            .expect("prevalidated chain");
        // A failed nested CREATE may already have made one of several parent
        // directories. Treat its error as an uncertain effect conservatively.
        let mut effect_uncertain = change.action == "CREATE" && expected.len() < parts.len() - 1;
        let applied = (|| -> Result<(), Failure> {
            let p = parents(root, &parts, Some(expected), change.action == "CREATE")?;
            effect_uncertain = p.created;
            result["parent_chain"] = json!(p.chain);
            if !p.exists {
                return Err(Failure::new("CONFLICT", "parent is missing"));
            }
            test_latch("parent", None)?;
            let parent = p.last(root);
            let name = parts[parts.len() - 1];
            if change.action == "CREATE" {
                if change.expected_target_id.is_some() {
                    if let Some(existing) = open_file(parent, name, false)? {
                        result["target_id"] = json!(information(&existing, false)?);
                        result["actual_sha256"] = json!(sha(&read_bytes(&existing)?));
                    }
                    return Err(Failure::new("CONFLICT", "target existed during capture"));
                }
                if let Some(existing) = open_file(parent, name, false)? {
                    result["target_id"] = json!(information(&existing, false)?);
                    result["actual_sha256"] = json!(sha(&read_bytes(&existing)?));
                    return Err(Failure::new("CONFLICT", "target already exists"));
                }
                effect_uncertain = true;
                let mut stage =
                    prepare_stage(parent, change.content.as_deref().unwrap().as_bytes())?;
                let id = commit_stage(&mut stage, parent, name)?;
                result["target_id"] = json!(id);
                result["actual_sha256"] = json!(sha(change.content.as_deref().unwrap().as_bytes()));
            } else {
                if change.expected_target_id.is_none() {
                    if let Some(existing) = open_file(parent, name, false)? {
                        result["target_id"] = json!(information(&existing, false)?);
                        result["actual_sha256"] = json!(sha(&read_bytes(&existing)?));
                    }
                    return Err(Failure::new("CONFLICT", "target was absent during capture"));
                }
                let handle = open_file(parent, name, true)?
                    .ok_or_else(|| Failure::new("CONFLICT", "target is missing"))?;
                let id = information(&handle, false)?;
                result["target_id"] = json!(id);
                if !id.eq_ignore_ascii_case(change.expected_target_id.as_deref().unwrap()) {
                    return Err(Failure::new("CONFLICT", "target identity changed"));
                }
                let current = read_bytes(&handle)?;
                let current_sha = sha(&current);
                result["actual_sha256"] = json!(current_sha);
                if !current_sha.eq_ignore_ascii_case(change.baseline_sha256.as_deref().unwrap()) {
                    return Err(Failure::new("CONFLICT", "baseline hash changed"));
                }
                // Link count is checked again immediately before the effect.
                information(&handle, false)?;
                test_latch("target", None)?;
                information(&handle, false)?;
                if change.action == "DELETE" {
                    effect_uncertain = true;
                    delete_file(&handle)?;
                    result["target_id"] = Value::Null;
                    result["actual_sha256"] = Value::Null;
                } else {
                    let content = change.content.as_deref().unwrap();
                    effect_uncertain = true;
                    let mut stage = prepare_stage(parent, content.as_bytes())?;
                    information(&handle, false)?;
                    let backup_name = staging_name()?;
                    rename_relative(&handle, parent, &backup_name)?;
                    result["backup_path"] = json!(if parts.len() == 1 {
                        backup_name.clone()
                    } else {
                        format!("{}/{}", parts[..parts.len() - 1].join("/"), backup_name)
                    });
                    test_latch("gap", None)?;
                    let id = match commit_stage(&mut stage, parent, name) {
                        Ok(id) => id,
                        Err(error) => {
                            if rename_relative(&handle, parent, name).is_ok() {
                                result.as_object_mut().unwrap().remove("backup_path");
                                return Err(error);
                            }
                            return Err(Failure::new(
                                "RENAME_FAILED",
                                "target gap was occupied; original preserved at backup_path",
                            ));
                        }
                    };
                    result["target_id"] = json!(id);
                    result["actual_sha256"] = json!(sha(content.as_bytes()));
                    delete_file(&handle)?;
                    result.as_object_mut().unwrap().remove("backup_path");
                }
            }
            Ok(())
        })();
        match applied {
            Ok(()) => {
                result["status"] = json!("APPLIED");
                result["effect_uncertain"] = json!(false);
            }
            Err(error) => {
                all_applied = false;
                result["status"] = json!(if error.code == "CONFLICT" && !effect_uncertain {
                    "CONFLICT"
                } else {
                    "FAILED"
                });
                result["effect_uncertain"] = json!(effect_uncertain);
                result["error"] = json!(error.code);
            }
        }
        results.push(result);
    }
    json!({"outcome":if all_applied {"SUCCEEDED"} else {"FAILED"},"files":results})
}

fn reconcile(root: &Handle, files: Vec<ReconcileFile>) -> Value {
    let mut results = Vec::new();
    for file in files {
        let parts = segments(&file.path).expect("prevalidated path");
        let mut result = json!({"path":file.path,"parent_chain":[],"target_id":null,
            "sha256":null,"matches":false});
        match parents(root, &parts, Some(&file.expected_parent_chain), false) {
            Ok(p) if p.exists => {
                result["parent_chain"] = json!(p.chain);
                match open_file(p.last(root), parts[parts.len() - 1], false) {
                    Ok(Some(handle)) => match (information(&handle, false), read_bytes(&handle)) {
                        (Ok(id), Ok(bytes)) => {
                            let actual_sha = sha(&bytes);
                            result["target_id"] = json!(id);
                            result["sha256"] = json!(actual_sha);
                            result["matches"] = json!(
                                file.expected_target_id
                                    .as_deref()
                                    .is_some_and(|expected| expected.eq_ignore_ascii_case(&id))
                                    && file.expected_sha256.as_deref().is_some_and(|expected| {
                                        expected.eq_ignore_ascii_case(&actual_sha)
                                    })
                            );
                        }
                        (Err(error), _) | (_, Err(error)) => result["error"] = json!(error.code),
                    },
                    Ok(None) => {
                        result["matches"] = json!(
                            file.expected_target_id.is_none() && file.expected_sha256.is_none()
                        );
                    }
                    Err(error) => result["error"] = json!(error.code),
                }
            }
            Ok(p) => {
                result["parent_chain"] = json!(p.chain);
                result["error"] = json!("PARENT_MISSING");
            }
            Err(error) => result["error"] = json!(error.code),
        }
        results.push(result);
    }
    json!(results)
}

fn observed_file(
    parent: &Handle,
    name: &str,
    path: &str,
    enumerated_id: Option<&str>,
    target: bool,
    total_read: &mut usize,
) -> Result<(Value, Option<Handle>), Failure> {
    let mut value = json!({"path":path,"id":null,"sha256":null,
        "status":"MISSING","error":null});
    if target {
        value["state"] = json!("MISSING");
    }
    match open_file(parent, name, false) {
        Ok(Some(handle)) => {
            if target {
                value["state"] = json!("PRESENT");
            }
            let id = information(&handle, false)?;
            value["id"] = json!(id);
            if enumerated_id.is_some_and(|expected| !expected.eq_ignore_ascii_case(&id)) {
                value["status"] = json!("CHANGED");
                value["error"] = json!("ENTRY_CHANGED");
                return Ok((value, Some(handle)));
            }
            match read_bytes(&handle) {
                Ok(bytes) => {
                    if link_count(&handle)? != 1 {
                        value["status"] = json!("UNSAFE");
                        value["error"] = json!("HARD_LINK");
                    } else {
                        *total_read += bytes.len();
                        if *total_read > MAX_RESIDUAL_READ_BYTES {
                            return Err(Failure::new(
                                "RESIDUAL_READ_LIMIT",
                                "residual inspection exceeds 4 MiB total read",
                            ));
                        }
                        value["sha256"] = json!(sha(&bytes));
                        value["status"] = json!("READABLE");
                    }
                }
                Err(error) => {
                    value["status"] = json!(if error.code == "FILE_TOO_LARGE" {
                        "TOO_LARGE"
                    } else {
                        "UNREADABLE"
                    });
                    value["error"] = json!(error.code);
                }
            }
            Ok((value, Some(handle)))
        }
        Ok(None) => {
            if !target {
                value["status"] = json!("DISAPPEARED");
                value["error"] = json!("ENTRY_CHANGED");
            }
            Ok((value, None))
        }
        Err(error) => {
            if target {
                value["state"] = json!("UNKNOWN");
            }
            value["status"] = json!(if matches!(error.code, "UNSAFE_ENTRY" | "HARD_LINK") {
                "UNSAFE"
            } else {
                "UNREADABLE"
            });
            value["error"] = json!(error.code);
            Ok((value, None))
        }
    }
}

struct ResidualSnapshot {
    path: String,
    id: String,
    parents: Parents,
    listing_handle: Option<Handle>,
    initial_times: (i64, i64),
    names: Vec<ResidualName>,
    candidates: Vec<Value>,
}

impl ResidualSnapshot {
    fn directory<'a>(&'a self, root: &'a Handle) -> &'a Handle {
        self.listing_handle.as_ref().unwrap_or(root)
    }
}

fn inspect_residuals(
    root_handles: &[Handle],
    root_path: &str,
    root_id: &str,
    files: Vec<ReconcileFile>,
) -> Result<Value, Failure> {
    let root = root_handles.last().unwrap();
    let volume = root_id.split_once(':').unwrap().0;
    let mut results = Vec::new();
    let mut held_files = Vec::new();
    let mut snapshots: Vec<ResidualSnapshot> = Vec::new();
    let mut total_candidates = 0;
    let mut total_read = 0;
    let mut complete = true;
    for file in files {
        let parts = segments(&file.path).expect("prevalidated path");
        // No expected chain permits observing newly created parents. The frozen
        // prefix is then checked against the opened handle identities.
        let parents = parents(root, &parts, None, false)?;
        if parents.chain.len() < file.expected_parent_chain.len()
            || file
                .expected_parent_chain
                .iter()
                .zip(&parents.chain)
                .any(|(expected, actual)| !expected.id.eq_ignore_ascii_case(&actual.id))
        {
            return Err(Failure::new(
                "PARENT_CHANGED",
                "frozen parent identity changed",
            ));
        }
        if !parents.exists {
            results.push(json!({"path":file.path,"parent_chain":parents.chain,
                "target":{"path":file.path,"state":"MISSING","id":null,"sha256":null,
                    "status":"MISSING","error":null},"candidates":[]}));
            continue;
        }
        let parent_path = parts[..parts.len() - 1].join("/");
        let parent_id = parents.chain.last().map_or(root_id, |entry| &entry.id);
        let index = if let Some(index) = snapshots.iter().position(|snapshot| {
            snapshot.path.eq_ignore_ascii_case(&parent_path)
                && snapshot.id.eq_ignore_ascii_case(parent_id)
        }) {
            index
        } else {
            let (listing_parent, listing_name) = if parents.handles.is_empty() {
                if root_handles.len() == 1 {
                    // The drive root has GENERIC_READ, including list access.
                    (None, "")
                } else {
                    (
                        Some(&root_handles[root_handles.len() - 2]),
                        root_path
                            .trim_end_matches('\\')
                            .rsplit('\\')
                            .next()
                            .unwrap(),
                    )
                }
            } else {
                let before = if parents.handles.len() == 1 {
                    root
                } else {
                    &parents.handles[parents.handles.len() - 2]
                };
                (Some(before), parts[parts.len() - 2])
            };
            let listing_handle = if let Some(before) = listing_parent {
                Some(open_listing_directory(before, listing_name, parent_id)?)
            } else {
                None
            };
            let directory = listing_handle.as_ref().unwrap_or(root);
            let initial_times = directory_times(directory)?;
            let names = residual_names(directory, volume)?;
            total_candidates += names.len();
            if total_candidates > MAX_RESIDUAL_CANDIDATES {
                return Err(Failure::new(
                    "RESIDUAL_LIMIT",
                    "more than 32 candidates in request",
                ));
            }
            test_latch("inspect_enum", None)?;
            let mut candidates = Vec::new();
            for residual in &names {
                let relative = if parent_path.is_empty() {
                    residual.name.clone()
                } else {
                    format!("{parent_path}/{}", residual.name)
                };
                if residual.attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)
                    != 0
                {
                    complete = false;
                    candidates.push(json!({"path":relative,"id":null,"sha256":null,
                        "status":"UNSAFE","error":"UNSAFE_ENTRY"}));
                    continue;
                }
                let (value, handle) = observed_file(
                    directory,
                    &residual.name,
                    &relative,
                    Some(&residual.id),
                    false,
                    &mut total_read,
                )?;
                if value["status"] != "READABLE" {
                    complete = false;
                }
                if let Some(handle) = handle {
                    held_files.push(handle);
                }
                candidates.push(value);
            }
            test_latch("inspect_observed", None)?;
            snapshots.push(ResidualSnapshot {
                path: parent_path,
                id: parent_id.to_owned(),
                parents,
                listing_handle,
                initial_times,
                names,
                candidates,
            });
            snapshots.len() - 1
        };
        let snapshot = &snapshots[index];
        let directory = snapshot.directory(root);
        let name = parts[parts.len() - 1];
        let (target, target_handle) =
            observed_file(directory, name, &file.path, None, true, &mut total_read)?;
        if let Some(handle) = target_handle {
            held_files.push(handle);
        }
        if !matches!(target["status"].as_str(), Some("READABLE" | "MISSING")) {
            complete = false;
        }
        results.push(
            json!({"path":file.path,"parent_chain":snapshot.parents.chain,
            "target":target,"candidates":snapshot.candidates}),
        );
    }
    for snapshot in &snapshots {
        let directory = snapshot.directory(root);
        let later = residual_names(directory, volume)?;
        if snapshot.names.len() != later.len()
            || snapshot
                .names
                .iter()
                .zip(&later)
                .any(|(a, b)| a.name != b.name || a.id != b.id || a.attributes != b.attributes)
            || directory_times(directory)? != snapshot.initial_times
        {
            return Err(Failure::new(
                "DIRECTORY_CHANGED",
                "directory changed while inspecting",
            ));
        }
    }
    Ok(
        json!({"version":VERSION,"ok":complete,"root_id":root_id,"complete":complete,
        "files":results,"error":if complete { Value::Null } else {
            json!({"code":"INCOMPLETE_OBSERVATION","message":"a target or candidate was not safely readable"})
        }}),
    )
}

pub(super) fn run(request: Request) -> Result<Value, Failure> {
    let expected = if request.op == "inspect-root" {
        None
    } else {
        Some(
            request
                .expected_root_id
                .as_deref()
                .ok_or_else(|| Failure::new("INVALID_REQUEST", "expected_root_id is required"))?,
        )
    };
    let (root_handles, root_id) = root(&request.root_path, expected)?;
    let root = root_handles.last().unwrap();
    match request.op.as_str() {
        "inspect-root" => Ok(json!({"version":VERSION,"ok":true,"root_id":root_id,
            "limits":{"max_request_bytes":MAX_REQUEST_BYTES,"max_content_bytes":MAX_CONTENT_BYTES,
                "max_read_bytes":MAX_FILE_BYTES,"max_capture_text_bytes":MAX_TEXT_BYTES,
                "max_files":16,"max_residual_candidates":MAX_RESIDUAL_CANDIDATES,
                "max_residual_enum_entries":MAX_RESIDUAL_ENUM_ENTRIES,
                "max_residual_read_bytes":MAX_RESIDUAL_READ_BYTES}})),
        "capture" => {
            let changes = request
                .changes
                .ok_or_else(|| Failure::new("INVALID_REQUEST", "changes required"))?;
            check_changes(&changes, false)?;
            Ok(json!({"version":VERSION,"ok":true,"root_id":root_id,"files":capture(root,changes)}))
        }
        "execute" => {
            let changes = request
                .changes
                .ok_or_else(|| Failure::new("INVALID_REQUEST", "changes required"))?;
            check_changes(&changes, true)?;
            let outcome = execute(root, changes);
            Ok(json!({"version":VERSION,"ok":true,"root_id":root_id,
                "outcome":outcome["outcome"],"files":outcome["files"]}))
        }
        "reconcile" | "inspect-residuals" => {
            let files = request
                .files
                .ok_or_else(|| Failure::new("INVALID_REQUEST", "files required"))?;
            if files.is_empty() || files.len() > 16 {
                return Err(Failure::new(
                    "INVALID_REQUEST",
                    "files must contain 1 to 16 items",
                ));
            }
            let mut seen = std::collections::HashSet::new();
            for file in &files {
                check_chain(&file.path, &file.expected_parent_chain)?;
                if !seen.insert(file.path.to_lowercase())
                    || file
                        .expected_target_id
                        .as_deref()
                        .is_some_and(|id| !valid_id(id))
                    || file
                        .expected_sha256
                        .as_deref()
                        .is_some_and(|hash| !valid_sha(hash))
                    || file.expected_target_id.is_some() != file.expected_sha256.is_some()
                {
                    return Err(Failure::new(
                        "INVALID_REQUEST",
                        "reconcile file is malformed",
                    ));
                }
            }
            if request.op == "inspect-residuals" {
                inspect_residuals(&root_handles, &request.root_path, &root_id, files)
            } else {
                Ok(
                    json!({"version":VERSION,"ok":true,"root_id":root_id,"files":reconcile(root,files)}),
                )
            }
        }
        _ => Err(Failure::new("INVALID_REQUEST", "unknown operation")),
    }
}
