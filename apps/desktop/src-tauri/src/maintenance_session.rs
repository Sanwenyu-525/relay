//! Private, headless stop proof for the current Windows login session only.

use std::{fs, io::{self, BufRead, Write}, path::{Component, PathBuf, Prefix}};

use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

use crate::{SingleInstanceError, acquire_single_instance_named, job_sidecar::recover_old_launches};

const MAX_INPUT_BYTES: usize = 16 * 1024;
const MAX_OUTPUT_BYTES: usize = 64 * 1024;
const MAX_STOPPED_LAUNCHES: usize = 64;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StartFrame {
    #[serde(rename = "type")]
    kind: String,
    version: u8,
    nonce: String,
    data_root: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReleaseFrame {
    #[serde(rename = "type")]
    kind: String,
    version: u8,
    nonce: String,
}

struct Failure { code: &'static str, nonce: Option<String> }

fn failure(code: &'static str, nonce: Option<&str>) -> Failure {
    Failure { code, nonce: nonce.map(str::to_owned) }
}

fn canonical_uuid(value: &str) -> bool {
    Uuid::parse_str(value).is_ok_and(|id| id.to_string() == value)
}

/// A bounded LF/CRLF frame; an unterminated partial frame is never accepted.
fn read_frame(reader: &mut impl BufRead) -> Result<Option<Vec<u8>>, &'static str> {
    let mut frame = Vec::new();
    loop {
        let bytes = reader.fill_buf().map_err(|_| "MAINTENANCE_SESSION_IO_FAILED")?;
        if bytes.is_empty() {
            return if frame.is_empty() { Ok(None) } else { Err("MAINTENANCE_SESSION_INVALID") };
        }
        let end = bytes.iter().position(|byte| *byte == b'\n');
        let count = end.map_or(bytes.len(), |index| index + 1);
        if frame.len() + count > MAX_INPUT_BYTES { return Err("MAINTENANCE_SESSION_INVALID"); }
        frame.extend_from_slice(&bytes[..count]);
        reader.consume(count);
        if end.is_some() { return Ok(Some(frame)); }
    }
}

fn respond(writer: &mut impl Write, value: serde_json::Value) -> Result<(), &'static str> {
    let mut bytes = serde_json::to_vec(&value).map_err(|_| "MAINTENANCE_SESSION_IO_FAILED")?;
    bytes.push(b'\n');
    if bytes.len() > MAX_OUTPUT_BYTES { return Err("MAINTENANCE_SESSION_IO_FAILED"); }
    writer.write_all(&bytes).and_then(|_| writer.flush()).map_err(|_| "MAINTENANCE_SESSION_IO_FAILED")
}

fn session(reader: &mut impl BufRead, writer: &mut impl Write, mutex_name: &str)
    -> Result<(), Failure> {
    let bytes = read_frame(reader).map_err(|code| failure(code, None))?
        .ok_or_else(|| failure("MAINTENANCE_SESSION_INVALID", None))?;
    let start: StartFrame = serde_json::from_slice(&bytes)
        .map_err(|_| failure("MAINTENANCE_SESSION_INVALID", None))?;
    if start.kind != "maintenance_session_start" || start.version != 1 || !canonical_uuid(&start.nonce) {
        return Err(failure("MAINTENANCE_SESSION_INVALID", None));
    }
    let fail = |code| failure(code, Some(&start.nonce));
    let root = PathBuf::from(&start.data_root);
    if !root.is_absolute() || start.data_root.starts_with("\\\\") {
        return Err(fail("MAINTENANCE_SESSION_INVALID"));
    }
    let metadata = fs::symlink_metadata(&root).map_err(|_| fail("MAINTENANCE_SESSION_INVALID"))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(fail("MAINTENANCE_SESSION_INVALID"));
    }
    let root = fs::canonicalize(root).map_err(|_| fail("MAINTENANCE_SESSION_INVALID"))?;
    if !matches!(root.components().next(), Some(Component::Prefix(value))
        if matches!(value.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_))) {
        return Err(fail("MAINTENANCE_SESSION_INVALID"));
    }
    let guard = acquire_single_instance_named(mutex_name, false).map_err(|error| fail(match error {
        SingleInstanceError::Busy => "MAINTENANCE_SESSION_BUSY",
        SingleInstanceError::Unavailable => "MAINTENANCE_SESSION_IO_FAILED",
    }))?;
    // Bound recovery before it stops any Job; never truncate the proof list.
    let records = root.join("runtime-launches");
    let records_present = match fs::symlink_metadata(&records) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => true,
        Ok(_) => return Err(fail("MAINTENANCE_SESSION_STOP_FAILED")),
        Err(error) if error.kind() == io::ErrorKind::NotFound => false,
        Err(_) => return Err(fail("MAINTENANCE_SESSION_STOP_FAILED")),
    };
    if records_present {
        let mut count = 0;
        for entry in fs::read_dir(&records).map_err(|_| fail("MAINTENANCE_SESSION_STOP_FAILED"))? {
            let entry = entry.map_err(|_| fail("MAINTENANCE_SESSION_STOP_FAILED"))?;
            if entry.path().extension().is_some_and(|value| value == "json") {
                count += 1;
                if count > MAX_STOPPED_LAUNCHES { return Err(fail("MAINTENANCE_SESSION_STOP_FAILED")); }
            }
        }
    }
    let stopped = recover_old_launches(&root).map_err(|_| fail("MAINTENANCE_SESSION_STOP_FAILED"))?;
    if stopped.len() > MAX_STOPPED_LAUNCHES { return Err(fail("MAINTENANCE_SESSION_STOP_FAILED")); }
    respond(writer, json!({ "type": "maintenance_ready", "version": 1,
        "nonce": start.nonce, "stoppedLaunches": stopped })).map_err(fail)?;
    let Some(bytes) = read_frame(reader).map_err(fail)? else {
        drop(guard);
        return Ok(());
    };
    let release: ReleaseFrame = serde_json::from_slice(&bytes)
        .map_err(|_| fail("MAINTENANCE_SESSION_INVALID"))?;
    if release.kind != "maintenance_session_release" || release.version != 1 || release.nonce != start.nonce {
        return Err(fail("MAINTENANCE_SESSION_INVALID"));
    }
    drop(guard);
    respond(writer, json!({ "type": "maintenance_released", "version": 1,
        "nonce": start.nonce })).map_err(fail)
}

pub(super) fn run(valid_args: bool) -> i32 {
    let mut input = io::stdin().lock();
    let mut output = io::stdout().lock();
    let result = if valid_args {
        session(&mut input, &mut output, crate::SINGLE_INSTANCE_MUTEX)
    } else { Err(failure("MAINTENANCE_SESSION_INVALID", None)) };
    match result {
        Ok(()) => 0,
        Err(error) => {
            let _ = respond(&mut output, json!({ "type": "maintenance_error", "version": 1,
                "nonce": error.nonce, "code": error.code }));
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{ffi::OsString, io::{BufReader, Cursor, Read}, path::Path,
        sync::mpsc, thread, time::{Duration, Instant}};
    use crate::job_sidecar::{ManagedProcess, arm_launch};
    use windows::Win32::{Foundation::{CloseHandle, WAIT_OBJECT_0},
        System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE}};

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("relay-maintenance-session-{}", Uuid::new_v4()));
            fs::create_dir(&root).unwrap();
            Self(root)
        }
        fn start(&self, nonce: &str) -> Vec<u8> {
            format!("{}\n", json!({ "type": "maintenance_session_start", "version": 1,
                "nonce": nonce, "dataRoot": self.0 })).into_bytes()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let base = std::env::temp_dir().canonicalize().unwrap();
            assert!(self.0.canonicalize().unwrap().starts_with(base));
            fs::remove_dir_all(&self.0).unwrap();
        }
    }
    fn mutex_name() -> String { format!("Local\\RelayMaintenanceTest-{}", Uuid::new_v4()) }
    fn frames(bytes: &[u8]) -> Vec<serde_json::Value> {
        String::from_utf8_lossy(bytes).lines().map(|line| serde_json::from_str(line).unwrap()).collect()
    }

    struct Input { receiver: mpsc::Receiver<Vec<u8>>, bytes: Vec<u8>, offset: usize }
    impl Read for Input {
        fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
            let bytes = self.fill_buf()?;
            let count = output.len().min(bytes.len());
            output[..count].copy_from_slice(&bytes[..count]);
            self.consume(count);
            Ok(count)
        }
    }
    impl BufRead for Input {
        fn fill_buf(&mut self) -> io::Result<&[u8]> {
            if self.offset == self.bytes.len() {
                self.bytes = self.receiver.recv().unwrap_or_default();
                self.offset = 0;
            }
            Ok(&self.bytes[self.offset..])
        }
        fn consume(&mut self, count: usize) { self.offset += count; }
    }
    struct Output { sender: mpsc::Sender<Vec<u8>>, bytes: Vec<u8> }
    impl Write for Output {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.bytes.extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            self.sender.send(self.bytes.clone()).map_err(|_| io::ErrorKind::BrokenPipe.into())
        }
    }

    #[test]
    fn ready_holds_the_old_guard_until_matching_release() {
        let fixture = Fixture::new();
        let nonce = Uuid::new_v4().to_string();
        let name = mutex_name();
        let (sender, receiver) = mpsc::channel();
        let (events, responses) = mpsc::channel();
        let session_name = name.clone();
        let task = thread::spawn(move || session(&mut Input { receiver, bytes: vec![], offset: 0 },
            &mut Output { sender: events, bytes: vec![] }, &session_name).map_err(|error| error.code));
        sender.send(fixture.start(&nonce)).unwrap();
        let ready = responses.recv_timeout(Duration::from_secs(10)).unwrap();
        assert_eq!(frames(&ready)[0]["type"], "maintenance_ready");
        assert!(matches!(acquire_single_instance_named(&name, false), Err(SingleInstanceError::Busy)));
        sender.send(format!("{}\n", json!({ "type": "maintenance_session_release",
            "version": 1, "nonce": nonce })).into_bytes()).unwrap();
        let released = responses.recv_timeout(Duration::from_secs(10)).unwrap();
        assert_eq!(frames(&released)[1]["type"], "maintenance_released");
        assert!(task.join().unwrap().is_ok());
        assert!(acquire_single_instance_named(&name, false).is_ok());
    }

    #[test]
    fn eof_releases_the_guard_without_a_release_claim() {
        let fixture = Fixture::new();
        let name = mutex_name();
        let mut output = Vec::new();
        assert!(session(&mut Cursor::new(fixture.start(&Uuid::new_v4().to_string())),
            &mut output, &name).is_ok());
        assert_eq!(frames(&output).len(), 1);
        assert!(acquire_single_instance_named(&name, false).is_ok());
    }

    #[test]
    fn an_open_desktop_guard_is_busy_and_never_returns_ready() {
        let fixture = Fixture::new();
        let name = mutex_name();
        let _desktop = acquire_single_instance_named(&name, false).ok().unwrap();
        let mut output = Vec::new();
        let error = session(&mut Cursor::new(fixture.start(&Uuid::new_v4().to_string())),
            &mut output, &name).err().unwrap();
        assert_eq!(error.code, "MAINTENANCE_SESSION_BUSY");
        assert!(output.is_empty());
    }

    #[test]
    fn invalid_frames_and_unknown_release_fail_closed() {
        let fixture = Fixture::new();
        for frame in [b"{}\n".to_vec(), vec![b'x'; MAX_INPUT_BYTES + 1],
            format!("{}\n", json!({ "type": "maintenance_session_start", "version": 2,
                "nonce": Uuid::new_v4().to_string(), "dataRoot": fixture.0 })).into_bytes(),
            format!("{}\n", json!({ "type": "maintenance_session_start", "version": 1,
                "nonce": Uuid::new_v4().to_string(), "dataRoot": fixture.0, "extra": true })).into_bytes(),
            format!("{}\n", json!({ "type": "maintenance_session_start", "version": 1,
                "nonce": "not-a-uuid", "dataRoot": fixture.0 })).into_bytes(),
            format!("{}\n", json!({ "type": "maintenance_session_start", "version": 1,
                "nonce": Uuid::new_v4().to_string(), "dataRoot": "relative" })).into_bytes(),
            fixture.start(&Uuid::new_v4().to_string()).into_iter().take_while(|byte| *byte != b'\n').collect()] {
            let mut output = Vec::new();
            assert_eq!(session(&mut Cursor::new(frame), &mut output, &mutex_name()).err().unwrap().code,
                "MAINTENANCE_SESSION_INVALID");
            assert!(output.is_empty());
        }
        for release in [json!({ "type": "maintenance_session_release", "version": 1,
            "nonce": Uuid::new_v4().to_string() }), json!({ "type": "unknown", "version": 1,
            "nonce": Uuid::new_v4().to_string() })] {
            let name = mutex_name();
            let mut input = fixture.start(&Uuid::new_v4().to_string());
            input.extend(format!("{release}\n").as_bytes());
            let mut output = Vec::new();
            assert_eq!(session(&mut Cursor::new(input), &mut output, &name).err().unwrap().code,
                "MAINTENANCE_SESSION_INVALID");
            assert_eq!(frames(&output).len(), 1);
            assert!(acquire_single_instance_named(&name, false).is_ok());
        }
    }

    #[test]
    fn bad_armed_record_preserves_evidence_and_never_returns_ready() {
        let fixture = Fixture::new();
        let records = fixture.0.join("runtime-launches");
        fs::create_dir(&records).unwrap();
        let record = records.join(format!("{}.json", Uuid::new_v4()));
        fs::write(&record, b"{\"state\":\"ARMED\"}").unwrap();
        let mut output = Vec::new();
        let error = session(&mut Cursor::new(fixture.start(&Uuid::new_v4().to_string())),
            &mut output, &mutex_name()).err().unwrap();
        assert_eq!(error.code, "MAINTENANCE_SESSION_STOP_FAILED");
        assert!(output.is_empty());
        assert!(record.exists());
    }

    #[test]
    fn ready_proves_the_recorded_api_and_worker_descendant_stopped() {
        let node = std::env::var_os("RELAY_TEST_NODE").expect("RELAY_TEST_NODE is required for real Windows Jobs");
        let fixture = Fixture::new();
        let launch = arm_launch(&fixture.0).unwrap();
        let args: [OsString; 2] = ["-e".into(), "setInterval(()=>{},1000)".into()];
        let api = ManagedProcess::spawn(Path::new(&node), &args, &[], launch.api_job, None).unwrap();
        let args: [OsString; 2] = ["-e".into(),
            "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(c.pid);setInterval(()=>{},1000)".into()];
        let mut worker = ManagedProcess::spawn(Path::new(&node), &args, &[], launch.supervisor_job, None).unwrap();
        let mut child_pid = String::new();
        BufReader::new(worker.take_stdout().unwrap()).read_line(&mut child_pid).unwrap();
        let child = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, false, child_pid.trim().parse().unwrap()) }.unwrap();
        let mut output = Vec::new();
        assert!(session(&mut Cursor::new(fixture.start(&Uuid::new_v4().to_string())),
            &mut output, &mutex_name()).is_ok());
        assert_eq!(frames(&output)[0]["stoppedLaunches"][0]["launchId"], launch.id);
        assert_eq!(frames(&output)[0]["stoppedLaunches"][0]["stopEvidence"],
            "armed_job_terminated_and_active_count_zero");
        // Job accounting can reach zero just before the process handle signals.
        // Require the OS exit evidence as well; a deadline is only a failure bound.
        let deadline = Instant::now() + Duration::from_secs(5);
        while api.try_wait().unwrap().is_none() || worker.try_wait().unwrap().is_none() {
            assert!(Instant::now() < deadline, "recorded API/Worker process did not exit");
            thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(unsafe { WaitForSingleObject(child, 5000) }, WAIT_OBJECT_0);
        unsafe { CloseHandle(child) }.unwrap();
        assert!(fixture.0.join("runtime-launches").join(format!("{}.json", launch.id)).exists());
    }
}
