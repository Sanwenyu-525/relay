//! Windows-only Node sidecars. The process enters its Job before its first thread runs.

use std::{
    ffi::{c_void, OsStr, OsString},
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    mem::size_of,
    os::windows::{
        ffi::OsStrExt,
        io::{AsRawHandle, FromRawHandle, OwnedHandle},
    },
    path::{Path, PathBuf},
    ptr, thread,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use uuid::Uuid;
use windows::{
    core::{BOOL, HSTRING, PCWSTR, PWSTR},
    Win32::{
        Foundation::{
            GetLastError, SetHandleInformation, ERROR_ALREADY_EXISTS, ERROR_FILE_NOT_FOUND,
            GENERIC_WRITE, HANDLE, HANDLE_FLAG_INHERIT, WAIT_OBJECT_0, WAIT_TIMEOUT,
        },
        Security::SECURITY_ATTRIBUTES,
        Storage::FileSystem::{
            CreateFileW, MoveFileExW, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_READ, FILE_SHARE_WRITE,
            MOVEFILE_WRITE_THROUGH, OPEN_EXISTING,
        },
        System::{
            JobObjects::{
                CreateJobObjectW, IsProcessInJob, JobObjectBasicAccountingInformation,
                JobObjectExtendedLimitInformation, OpenJobObjectW, QueryInformationJobObject,
                SetInformationJobObject, TerminateJobObject,
                JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            },
            Pipes::CreatePipe,
            SystemServices::{JOB_OBJECT_QUERY, JOB_OBJECT_TERMINATE},
            Threading::{
                CreateProcessW, DeleteProcThreadAttributeList, GetExitCodeProcess,
                InitializeProcThreadAttributeList, UpdateProcThreadAttribute, WaitForSingleObject,
                CREATE_NO_WINDOW, CREATE_UNICODE_ENVIRONMENT, EXTENDED_STARTUPINFO_PRESENT,
                LPPROC_THREAD_ATTRIBUTE_LIST, PROCESS_INFORMATION,
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST, PROC_THREAD_ATTRIBUTE_JOB_LIST,
                STARTF_USESTDHANDLES, STARTUPINFOEXW,
            },
        },
    },
};

fn raw(handle: &OwnedHandle) -> HANDLE {
    HANDLE(handle.as_raw_handle())
}

unsafe fn own(handle: HANDLE) -> OwnedHandle {
    // Each Win32 call transferring this handle to us is checked before conversion.
    unsafe { OwnedHandle::from_raw_handle(handle.0) }
}

pub struct Job {
    handle: OwnedHandle,
}

impl Job {
    pub fn create(name: String) -> Result<Self, String> {
        let wide = HSTRING::from(name.as_str());
        let handle = unsafe { CreateJobObjectW(None, &wide) }
            .map_err(|_| "cannot create the desktop process Job".to_owned())?;
        if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
            let _ = unsafe { windows::Win32::Foundation::CloseHandle(handle) };
            return Err("desktop process Job name already exists".into());
        }
        let job = Self {
            handle: unsafe { own(handle) },
        };
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        unsafe {
            SetInformationJobObject(
                raw(&job.handle),
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        }
        .map_err(|_| "cannot configure the desktop process Job".to_owned())?;
        Ok(job)
    }

    pub fn open_old(name: &str) -> Result<Option<Self>, String> {
        let wide = HSTRING::from(name);
        let handle = match unsafe {
            OpenJobObjectW(JOB_OBJECT_QUERY | JOB_OBJECT_TERMINATE, false, &wide)
        } {
            Ok(handle) => handle,
            Err(_) if unsafe { GetLastError() } == ERROR_FILE_NOT_FOUND => return Ok(None),
            Err(_) => return Err("cannot inspect an earlier desktop process Job".into()),
        };
        let job = Self {
            handle: unsafe { own(handle) },
        };
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        unsafe {
            QueryInformationJobObject(
                Some(raw(&job.handle)),
                JobObjectExtendedLimitInformation,
                (&mut limits as *mut JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                None,
            )
        }
        .map_err(|_| "cannot verify an earlier desktop process Job".to_owned())?;
        if limits.BasicLimitInformation.LimitFlags.0 & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE.0 == 0 {
            return Err("earlier desktop process Job lacks kill-on-close".into());
        }
        Ok(Some(job))
    }

    fn active_count(&self) -> Result<u32, String> {
        let mut accounting = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
        unsafe {
            QueryInformationJobObject(
                Some(raw(&self.handle)),
                JobObjectBasicAccountingInformation,
                (&mut accounting as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                None,
            )
        }
        .map_err(|_| "cannot count desktop Job processes".to_owned())?;
        Ok(accounting.ActiveProcesses)
    }

    pub fn terminate_and_wait(&self, timeout: Duration) -> Result<(), String> {
        if self.active_count()? == 0 {
            return Ok(());
        }
        unsafe { TerminateJobObject(raw(&self.handle), 1) }
            .map_err(|_| "cannot terminate desktop Job processes".to_owned())?;
        let deadline = Instant::now() + timeout;
        loop {
            if self.active_count()? == 0 {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err("desktop Job processes did not stop before deadline".into());
            }
            thread::sleep(Duration::from_millis(25));
        }
    }
}

const RECORD_INVARIANT: &str = "job-list-v1-kill-on-close-no-breakaway-no-job-handle-inheritance";

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ArmedRecord {
    version: u8,
    state: String,
    invariant: String,
    launch_id: String,
    api_job: String,
    supervisor_job: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoppedLaunch {
    pub launch_id: String,
    pub stop_evidence: String,
}

pub struct Launch {
    pub id: String,
    pub api_job: Job,
    pub supervisor_job: Job,
}

fn names(id: &str) -> (String, String) {
    (
        format!("Local\\RelayAgentApi-{id}"),
        format!("Local\\RelayAgentWorker-{id}"),
    )
}

fn records_dir(data_root: &Path) -> PathBuf {
    data_root.join("runtime-launches")
}

fn read_armed_record(path: &Path) -> Result<ArmedRecord, String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| "cannot inspect prior desktop launch record")?;
    if !metadata.file_type().is_file() {
        return Err("desktop launch record is not a regular file".into());
    }
    if metadata.len() > 16_384 {
        return Err("desktop launch record exceeds the size limit".into());
    }
    let bytes = fs::read(path).map_err(|_| "cannot read prior desktop launch record")?;
    let record: ArmedRecord = serde_json::from_slice(&bytes)
        .map_err(|_| "prior desktop launch record is incomplete or invalid")?;
    let id = Uuid::parse_str(&record.launch_id)
        .map_err(|_| "prior desktop launch ID is invalid")?;
    let (api_name, supervisor_name) = names(&id.to_string());
    if record.version != 1
        || record.state != "ARMED"
        || record.invariant != RECORD_INVARIANT
        || record.launch_id != id.to_string()
        || record.api_job != api_name
        || record.supervisor_job != supervisor_name
        || path.file_stem().and_then(|stem| stem.to_str()) != Some(record.launch_id.as_str())
    {
        return Err("prior desktop launch record fails its identity or safety invariant".into());
    }
    Ok(record)
}

pub fn recover_old_launches(data_root: &Path) -> Result<Vec<StoppedLaunch>, String> {
    let directory = records_dir(data_root);
    if !directory.exists() {
        return Ok(Vec::new());
    }
    let mut records = Vec::new();
    for item in
        fs::read_dir(&directory).map_err(|_| "cannot inspect prior desktop launch records")?
    {
        let item = item.map_err(|_| "cannot inspect prior desktop launch records")?;
        let path = item.path();
        if path.extension().is_none_or(|extension| extension != "json") {
            continue;
        }
        let record = read_armed_record(&path)?;
        // Absence is meaningful only because this durable ARMED record predates every sidecar
        // launch, JOB_LIST attaches before execution, handles are noninheritable, and breakaway
        // is disabled. A surviving named Job is explicitly terminated and queried to zero.
        let worker = Job::open_old(&record.supervisor_job)?;
        let worker_present = worker.is_some();
        if let Some(worker) = worker {
            worker.terminate_and_wait(Duration::from_secs(10))?;
        }
        let api = Job::open_old(&record.api_job)?;
        let api_present = api.is_some();
        if let Some(api) = api {
            api.terminate_and_wait(Duration::from_secs(10))?;
        }
        let proof = if worker_present || api_present {
            "armed_job_terminated_and_active_count_zero"
        } else {
            "armed_job_absent_after_last_handle_closed"
        };
        records.push(StoppedLaunch {
            launch_id: record.launch_id,
            stop_evidence: proof.into(),
        });
    }
    records.sort_by(|a, b| a.launch_id.cmp(&b.launch_id));
    Ok(records)
}

pub fn remove_reconciled_launches(data_root: &Path, launch_ids: &[String]) -> Result<(), String> {
    let directory = records_dir(data_root);
    for launch_id in launch_ids {
        let id = Uuid::parse_str(launch_id)
            .map_err(|_| "reconciled desktop launch ID is invalid")?;
        if id.to_string() != *launch_id {
            return Err("reconciled desktop launch ID is not canonical".into());
        }
        let path = directory.join(format!("{launch_id}.json"));
        let record = read_armed_record(&path)?;
        if record.launch_id != *launch_id {
            return Err("reconciled desktop launch record identity changed".into());
        }
    }
    for launch_id in launch_ids {
        fs::remove_file(directory.join(format!("{launch_id}.json")))
            .map_err(|_| "cannot remove reconciled desktop launch record")?;
    }
    Ok(())
}

pub fn arm_launch(data_root: &Path) -> Result<Launch, String> {
    let id = Uuid::new_v4().to_string();
    let (api_name, supervisor_name) = names(&id);
    let api_job = Job::create(api_name.clone())?;
    let supervisor_job = Job::create(supervisor_name.clone())?;
    let record = ArmedRecord {
        version: 1,
        state: "ARMED".into(),
        invariant: RECORD_INVARIANT.into(),
        launch_id: id.clone(),
        api_job: api_name,
        supervisor_job: supervisor_name,
    };
    let directory = records_dir(data_root);
    fs::create_dir_all(&directory).map_err(|_| "cannot create desktop launch record directory")?;
    let temporary = directory.join(format!("{id}.tmp"));
    let target = directory.join(format!("{id}.json"));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|_| "cannot create desktop ARMED launch record")?;
    let bytes =
        serde_json::to_vec(&record).map_err(|_| "cannot encode desktop ARMED launch record")?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "cannot persist desktop ARMED launch record")?;
    drop(file);
    let source = HSTRING::from(temporary.as_os_str());
    let destination = HSTRING::from(target.as_os_str());
    unsafe { MoveFileExW(&source, &destination, MOVEFILE_WRITE_THROUGH) }
        .map_err(|_| "cannot atomically publish desktop ARMED launch record")?;
    Ok(Launch {
        id,
        api_job,
        supervisor_job,
    })
}

struct Attributes(LPPROC_THREAD_ATTRIBUTE_LIST);
impl Drop for Attributes {
    fn drop(&mut self) {
        unsafe {
            DeleteProcThreadAttributeList(self.0);
        }
    }
}

fn create_pipe() -> Result<(OwnedHandle, OwnedHandle), String> {
    let mut attributes = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: ptr::null_mut(),
        bInheritHandle: BOOL(1),
    };
    let (mut read, mut write) = (HANDLE::default(), HANDLE::default());
    unsafe { CreatePipe(&mut read, &mut write, Some(&mut attributes), 0) }
        .map_err(|_| "cannot create a desktop private pipe".to_owned())?;
    Ok((unsafe { own(read) }, unsafe { own(write) }))
}

fn quote_arg(value: &OsStr) -> Vec<u16> {
    let units: Vec<u16> = value.encode_wide().collect();
    let mut quoted = vec![b'"' as u16];
    let mut slashes = 0;
    for unit in units {
        if unit == b'\\' as u16 {
            slashes += 1;
            continue;
        }
        if unit == b'"' as u16 {
            quoted.extend(std::iter::repeat_n(b'\\' as u16, slashes * 2 + 1));
        } else {
            quoted.extend(std::iter::repeat_n(b'\\' as u16, slashes));
        }
        slashes = 0;
        quoted.push(unit);
    }
    quoted.extend(std::iter::repeat_n(b'\\' as u16, slashes * 2));
    quoted.push(b'"' as u16);
    quoted
}

fn command_line(program: &Path, args: &[OsString]) -> Vec<u16> {
    let mut line = quote_arg(program.as_os_str());
    for arg in args {
        line.push(b' ' as u16);
        line.extend(quote_arg(arg));
    }
    line.push(0);
    line
}

fn environment(overrides: &[(String, OsString)]) -> Result<Vec<u16>, String> {
    let mut vars: Vec<(OsString, OsString)> = std::env::vars_os()
        .filter(|(key, _)| {
            let name = key.to_string_lossy();
            !name.to_ascii_uppercase().starts_with("RELAY_")
                && !name.to_ascii_uppercase().starts_with("NODE_")
        })
        .collect();
    vars.retain(|(key, _)| {
        !overrides
            .iter()
            .any(|(name, _)| key.to_string_lossy().eq_ignore_ascii_case(name))
    });
    vars.extend(
        overrides
            .iter()
            .map(|(key, value)| (OsString::from(key), value.clone())),
    );
    vars.sort_by_key(|(key, _)| key.to_string_lossy().to_ascii_lowercase());
    let mut block = Vec::new();
    for (key, value) in vars {
        if key.encode_wide().any(|unit| unit == 0) || value.encode_wide().any(|unit| unit == 0) {
            return Err("desktop process environment contains NUL".into());
        }
        block.extend(key.encode_wide());
        block.push(b'=' as u16);
        block.extend(value.encode_wide());
        block.push(0);
    }
    if block.is_empty() {
        block.push(0);
    }
    block.push(0);
    Ok(block)
}

pub struct ManagedProcess {
    process: OwnedHandle,
    pub stdin: Option<File>,
    pub stdout: Option<File>,
    pub job: Job,
}

impl ManagedProcess {
    pub fn spawn(
        node: &Path,
        args: &[OsString],
        overrides: &[(String, OsString)],
        job: Job,
    ) -> Result<Self, String> {
        let (child_stdin, parent_stdin) = create_pipe()?;
        let (parent_stdout, child_stdout) = create_pipe()?;
        unsafe {
            SetHandleInformation(
                raw(&parent_stdin),
                HANDLE_FLAG_INHERIT.0,
                Default::default(),
            )
            .map_err(|_| "cannot secure the desktop stdin pipe".to_owned())?;
            SetHandleInformation(
                raw(&parent_stdout),
                HANDLE_FLAG_INHERIT.0,
                Default::default(),
            )
            .map_err(|_| "cannot secure the desktop stdout pipe".to_owned())?;
        }
        let mut attributes = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: ptr::null_mut(),
            bInheritHandle: BOOL(1),
        };
        let nul = unsafe {
            CreateFileW(
                windows::core::w!("NUL"),
                GENERIC_WRITE.0,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                Some(&mut attributes),
                OPEN_EXISTING,
                FILE_ATTRIBUTE_NORMAL,
                None,
            )
        }
        .map_err(|_| "cannot create the desktop null error stream".to_owned())?;
        let nul = unsafe { own(nul) };

        let mut bytes = 0;
        let _ = unsafe { InitializeProcThreadAttributeList(None, 2, None, &mut bytes) };
        if bytes == 0 {
            return Err("cannot size Windows process attributes".into());
        }
        let mut storage = vec![0_usize; bytes.div_ceil(size_of::<usize>())];
        let list = LPPROC_THREAD_ATTRIBUTE_LIST(storage.as_mut_ptr().cast());
        unsafe { InitializeProcThreadAttributeList(Some(list), 2, None, &mut bytes) }
            .map_err(|_| "cannot initialize Windows process attributes".to_owned())?;
        let _attributes = Attributes(list);
        let job_handle = raw(&job.handle);
        let child_handles = [raw(&child_stdin), raw(&child_stdout), raw(&nul)];
        unsafe {
            UpdateProcThreadAttribute(
                list,
                0,
                PROC_THREAD_ATTRIBUTE_JOB_LIST as usize,
                Some((&job_handle as *const HANDLE).cast()),
                size_of::<HANDLE>(),
                None,
                None,
            )
        }
        .map_err(|_| "cannot bind the desktop Job at process creation".to_owned())?;
        unsafe {
            UpdateProcThreadAttribute(
                list,
                0,
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                Some(child_handles.as_ptr().cast()),
                size_of_val(&child_handles),
                None,
                None,
            )
        }
        .map_err(|_| "cannot limit inherited desktop pipe handles".to_owned())?;

        let mut startup = STARTUPINFOEXW::default();
        startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdInput = child_handles[0];
        startup.StartupInfo.hStdOutput = child_handles[1];
        startup.StartupInfo.hStdError = child_handles[2];
        startup.lpAttributeList = list;
        let mut information = PROCESS_INFORMATION::default();
        let mut line = command_line(node, args);
        let program: Vec<u16> = node.as_os_str().encode_wide().chain([0]).collect();
        let env = environment(overrides)?;
        unsafe {
            CreateProcessW(
                PCWSTR(program.as_ptr()),
                Some(PWSTR(line.as_mut_ptr())),
                None,
                None,
                true,
                CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
                Some(env.as_ptr().cast::<c_void>()),
                PCWSTR::null(),
                &startup.StartupInfo,
                &mut information,
            )
        }
        .map_err(|_| "cannot start the Job-bound desktop Node process".to_owned())?;
        let process = unsafe { own(information.hProcess) };
        let _thread = unsafe { own(information.hThread) };
        let mut inside = BOOL(0);
        unsafe { IsProcessInJob(raw(&process), Some(job_handle), &mut inside) }
            .map_err(|_| "cannot verify desktop process Job membership".to_owned())?;
        if !inside.as_bool() {
            return Err("desktop Node process escaped its Job".into());
        }
        drop(child_stdin);
        drop(child_stdout);
        drop(nul);
        Ok(Self {
            process,
            stdin: Some(File::from(parent_stdin)),
            stdout: Some(File::from(parent_stdout)),
            job,
        })
    }

    pub fn try_wait(&self) -> Result<Option<u32>, String> {
        match unsafe { WaitForSingleObject(raw(&self.process), 0) } {
            WAIT_TIMEOUT => Ok(None),
            WAIT_OBJECT_0 => {
                let mut code = 0;
                unsafe { GetExitCodeProcess(raw(&self.process), &mut code) }
                    .map_err(|_| "cannot read desktop child exit status".to_owned())?;
                Ok(Some(code))
            }
            _ => Err("cannot wait for desktop child process".into()),
        }
    }

    #[cfg(test)]
    fn id(&self) -> u32 {
        unsafe { windows::Win32::System::Threading::GetProcessId(raw(&self.process)) }
    }

    pub fn stop(&mut self, timeout: Duration) -> Result<(), String> {
        self.stdin.take();
        let deadline = Instant::now() + timeout;
        loop {
            if self.try_wait()?.is_some() && self.job.active_count()? == 0 {
                return Ok(());
            }
            if Instant::now() >= deadline {
                break;
            }
            thread::sleep(Duration::from_millis(25));
        }
        self.job.terminate_and_wait(timeout)
    }

    pub fn write_frame(&mut self, frame: &str) -> Result<(), String> {
        let stdin = self
            .stdin
            .as_mut()
            .ok_or("desktop private pipe is closed")?;
        writeln!(stdin, "{frame}")
            .and_then(|_| stdin.flush())
            .map_err(|_| "cannot send the desktop startup frame".to_owned())
    }

    pub fn take_stdout(&mut self) -> Result<impl Read + Send + 'static, String> {
        self.stdout
            .take()
            .ok_or("desktop readiness pipe is closed".into())
    }
}

#[cfg(test)]
mod tests {
    use super::{arm_launch, command_line, quote_arg, recover_old_launches,
        remove_reconciled_launches, Job, ManagedProcess};
    use std::{
        ffi::{OsStr, OsString},
        io::BufRead,
        path::Path,
        time::Duration,
    };
    use windows::{
        core::BOOL,
        Win32::System::{JobObjects::IsProcessInJob, Threading::GetCurrentProcess},
    };

    #[test]
    fn windows_command_line_quotes_spaces_and_trailing_slashes() {
        let quoted = quote_arg(OsStr::new("a b\\"));
        assert_eq!(String::from_utf16_lossy(&quoted), "\"a b\\\\\"");
        let line = command_line(
            Path::new("C:\\Program Files\\node.exe"),
            &["--env-file=C:\\a b\\desktop.env".into()],
        );
        assert_eq!(
            String::from_utf16_lossy(&line[..line.len() - 1]),
            "\"C:\\Program Files\\node.exe\" \"--env-file=C:\\a b\\desktop.env\""
        );
    }

    #[test]
    fn node_child_inherits_the_job_and_stops_with_its_parent() {
        let Some(node) = std::env::var_os("RELAY_TEST_NODE") else {
            return;
        };
        if std::env::var("RELAY_EXPECT_OUTER_JOB").as_deref() == Ok("true") {
            let mut inside = BOOL(0);
            unsafe { IsProcessInJob(GetCurrentProcess(), None, &mut inside) }
                .expect("query outer Job");
            assert!(
                inside.as_bool(),
                "test process must be attached to the outer Job"
            );
        }
        let name = format!("Local\\RelayAgentJobTest-{}", uuid::Uuid::new_v4());
        let job = Job::create(name).expect("create test Job");
        let args = [OsString::from("-e"), OsString::from(
            "require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});setInterval(()=>{},1000)"
        )];
        let process =
            ManagedProcess::spawn(Path::new(&node), &args, &[], job).expect("start Job-bound Node");
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            if process.job.active_count().expect("inspect Job") >= 2 {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "Node child did not inherit the Job"
            );
            std::thread::sleep(Duration::from_millis(25));
        }
        process
            .job
            .terminate_and_wait(Duration::from_secs(5))
            .expect("stop process tree");
        assert_eq!(process.job.active_count().expect("inspect stopped Job"), 0);
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while process.try_wait().expect("wait Node").is_none() {
            assert!(
                std::time::Instant::now() < deadline,
                "Job parent did not exit"
            );
            std::thread::sleep(Duration::from_millis(25));
        }
    }

    #[test]
    fn armed_record_recovery_stops_a_live_old_job() {
        let Some(node) = std::env::var_os("RELAY_TEST_NODE") else {
            return;
        };
        let root =
            std::env::temp_dir().join(format!("relay-desktop-job-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).expect("create isolated test root");
        let launch = arm_launch(&root).expect("persist ARMED record");
        let old_id = launch.id.clone();
        let args = [
            OsString::from("-e"),
            OsString::from("setInterval(()=>{},1000)"),
        ];
        let process = ManagedProcess::spawn(Path::new(&node), &args, &[], launch.supervisor_job)
            .expect("start old Worker group");
        let stopped = recover_old_launches(&root).expect("verify and stop old Job");
        assert_eq!(stopped.len(), 1);
        assert_eq!(stopped[0].launch_id, old_id);
        assert_eq!(
            stopped[0].stop_evidence,
            "armed_job_terminated_and_active_count_zero"
        );
        assert_eq!(process.job.active_count().expect("old Job query"), 0);
        drop(process);
        drop(launch.api_job);
        let stopped_again = recover_old_launches(&root).expect("verify old Job absence");
        assert_eq!(
            stopped_again[0].stop_evidence,
            "armed_job_absent_after_last_handle_closed"
        );
        let root_prefix = std::env::temp_dir().canonicalize().expect("temp root");
        assert!(root
            .canonicalize()
            .expect("test root")
            .starts_with(&root_prefix));
        std::fs::remove_dir_all(&root).expect("remove isolated test root");
    }

    #[test]
    fn incomplete_armed_record_blocks_recovery() {
        let root =
            std::env::temp_dir().join(format!("relay-desktop-bad-record-{}", uuid::Uuid::new_v4()));
        let records = root.join("runtime-launches");
        std::fs::create_dir_all(&records).expect("create isolated record directory");
        std::fs::write(
            records.join(format!("{}.json", uuid::Uuid::new_v4())),
            b"{\"state\":\"ARMED\"}",
        )
        .expect("write incomplete record");
        assert!(recover_old_launches(&root).is_err());
        let root_prefix = std::env::temp_dir().canonicalize().expect("temp root");
        assert!(root
            .canonicalize()
            .expect("test root")
            .starts_with(&root_prefix));
        std::fs::remove_dir_all(&root).expect("remove isolated record root");
    }

    #[test]
    fn reconciled_record_removal_rechecks_identity_and_preserves_uncleared_launches() {
        let root = std::env::temp_dir()
            .join(format!("relay-desktop-reconciled-{}", uuid::Uuid::new_v4()));
        let clean = arm_launch(&root).expect("arm clean launch");
        let retained = arm_launch(&root).expect("arm retained launch");
        let clean_id = clean.id.clone();
        let retained_id = retained.id.clone();
        drop(clean);
        drop(retained);
        assert_eq!(recover_old_launches(&root).unwrap().len(), 2);
        let clean_path = root.join("runtime-launches").join(format!("{clean_id}.json"));
        let original = std::fs::read(&clean_path).unwrap();
        std::fs::write(&clean_path, b"{\"state\":\"ARMED\"}").unwrap();
        assert!(remove_reconciled_launches(&root, &[clean_id.clone()]).is_err());
        assert!(clean_path.exists());
        std::fs::write(&clean_path, original).unwrap();
        remove_reconciled_launches(&root, &[clean_id]).expect("remove durable zero-claim launch");
        assert!(!clean_path.exists());
        assert!(root.join("runtime-launches").join(format!("{retained_id}.json")).exists());
        assert_eq!(recover_old_launches(&root).unwrap().len(), 1);
        let root_prefix = std::env::temp_dir().canonicalize().expect("temp root");
        assert!(root.canonicalize().expect("test root").starts_with(&root_prefix));
        std::fs::remove_dir_all(&root).expect("remove isolated record root");
    }

    #[test]
    fn host_crash_probe() {
        if std::env::var("RELAY_JOB_PROBE_MODE").as_deref() != Ok("hold") {
            return;
        }
        let root =
            std::path::PathBuf::from(std::env::var_os("RELAY_JOB_PROBE_ROOT").expect("probe root"));
        let node =
            std::path::PathBuf::from(std::env::var_os("RELAY_TEST_NODE").expect("probe Node"));
        let launch = arm_launch(&root).expect("arm crash probe");
        let args = [OsString::from("-e"), OsString::from(
            "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(c.pid);setInterval(()=>{},1000)"
        )];
        let mut process = ManagedProcess::spawn(&node, &args, &[], launch.supervisor_job)
            .expect("start crash probe process tree");
        let mut reader = std::io::BufReader::new(process.take_stdout().expect("probe stdout"));
        let mut child_pid = String::new();
        reader.read_line(&mut child_pid).expect("read child PID");
        let child_pid: u32 = child_pid.trim().parse().expect("child PID");
        std::fs::write(
            root.join("probe-ready"),
            format!("{} {child_pid}", process.id()),
        )
        .expect("publish probe PIDs");
        loop {
            std::thread::sleep(Duration::from_secs(1));
        }
    }

    #[test]
    fn host_crash_recovery_probe() {
        if std::env::var("RELAY_JOB_PROBE_MODE").as_deref() != Ok("recover") {
            return;
        }
        let root =
            std::path::PathBuf::from(std::env::var_os("RELAY_JOB_PROBE_ROOT").expect("probe root"));
        let stopped = recover_old_launches(&root).expect("verify killed host Job");
        assert_eq!(stopped.len(), 1);
        assert_eq!(
            stopped[0].stop_evidence,
            "armed_job_absent_after_last_handle_closed"
        );
    }
}
