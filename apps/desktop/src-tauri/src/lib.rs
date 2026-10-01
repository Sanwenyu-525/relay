use std::{
    collections::HashMap,
    fs,
    io::{BufRead, BufReader},
    path::PathBuf,
    sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}, mpsc},
    thread,
    time::Duration,
};
#[cfg(not(windows))]
use std::{io::Write, process::{Child, ChildStdin, Command, Stdio}, time::Instant};

use serde::{Deserialize, Serialize};
use tauri::{Manager, WebviewWindow, WindowEvent, path::BaseDirectory, webview::NewWindowResponse};
use tauri::utils::config::{Csp, CspDirectiveSources};
use uuid::Uuid;

#[cfg(windows)]
mod job_sidecar;
#[cfg(windows)]
mod maintenance_session;
mod restore_isolation;
#[cfg(windows)]
use job_sidecar::{ManagedProcess, StoppedLaunch, arm_launch, recover_old_launches,
    remove_reconciled_launches};

#[cfg(windows)]
use std::ffi::OsString;
#[cfg(windows)]
use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2_4, ICoreWebView2Frame2,
    COREWEBVIEW2_PERMISSION_KIND, COREWEBVIEW2_PERMISSION_KIND_NOTIFICATIONS,
    COREWEBVIEW2_PERMISSION_STATE_ALLOW, COREWEBVIEW2_PERMISSION_STATE_DENY};
#[cfg(windows)]
use webview2_com::{FrameCreatedEventHandler, FrameNavigationStartingEventHandler,
    PermissionRequestedEventHandler, take_pwstr};
#[cfg(windows)]
use windows::{
    Win32::{
        Foundation::{CloseHandle, ERROR_ALREADY_EXISTS, GetLastError, HANDLE},
        System::Threading::CreateMutexW,
        UI::WindowsAndMessaging::{FindWindowW, SetForegroundWindow, MessageBoxW, MB_ICONERROR, MB_OK},
    },
    core::{HSTRING, Interface, PWSTR},
};

const TRUSTED_ORIGIN: &str = "http://tauri.localhost";
/// tauri dev 模式加载的前端开发服务器；打包产物不受此常量影响。
const DEV_ORIGIN: &str = "http://127.0.0.1:5173";

fn frontend_origin() -> &'static str {
    if tauri::is_dev() { DEV_ORIGIN } else { TRUSTED_ORIGIN }
}

fn is_dev_frontend_origin(url: &tauri::Url) -> bool {
    url.scheme() == "http" && url.host_str() == Some("127.0.0.1") && url.port() == Some(5173)
}

fn is_allowed_frontend_navigation(url: &tauri::Url) -> bool {
    if url.as_str() == "about:blank" { return true; }
    if url.scheme() != "http" { return false; }
    if tauri::is_dev() {
        return is_dev_frontend_origin(url);
    }
    url.host_str() == Some("tauri.localhost") && url.port().is_none()
}
const WINDOW_TITLE: &str = "Relay Agent";
const NODE_VERSION: &str = "v24.21.0";
#[cfg(windows)]
const SUPERVISOR_PROTOCOL_MARKER: &str = "relay-desktop-supervisor-v1";

#[cfg(windows)]
fn verify_supervisor_protocol(entry: &std::path::Path) -> Result<(), String> {
    let metadata = fs::metadata(entry).map_err(|_| "cannot inspect the bundled supervisor")?;
    if metadata.len() > 2_000_000 {
        return Err("the bundled supervisor exceeds the protocol check size limit".into());
    }
    let source = fs::read_to_string(entry)
        .map_err(|_| "cannot read the bundled supervisor protocol version")?;
    if !source.contains(SUPERVISOR_PROTOCOL_MARKER) {
        return Err("the bundled supervisor lacks the required desktop recovery protocol".into());
    }
    Ok(())
}
const SINGLE_INSTANCE_EXIT_CODE: i32 = 23;
#[cfg(windows)]
const SINGLE_INSTANCE_MUTEX: &str = "Local\\RelayAgentDesktopSingleInstance";

#[derive(Deserialize)]
#[serde(tag = "type")]
enum StartupEvent {
    #[serde(rename = "desktop_ready")]
    Ready {
        nonce: String,
        port: u16,
        #[serde(rename = "workspaceId")]
        workspace_id: String,
        #[serde(rename = "nodeVersion")]
        node_version: String,
    },
    #[serde(rename = "desktop_error")]
    Error { nonce: String, code: String },
}

#[cfg(windows)]
#[derive(Deserialize)]
#[serde(tag = "type")]
enum SupervisorEvent {
    #[serde(rename = "supervisor_ready")]
    Ready {
        nonce: String,
        #[serde(rename = "launchId")]
        launch_id: String,
        #[serde(rename = "nodeVersion")]
        node_version: String,
    },
    #[serde(rename = "launch_recovery_ack")]
    RecoveryAck {
        nonce: String,
        #[serde(rename = "launchId")]
        launch_id: String,
        #[serde(rename = "retainedClaims")]
        retained_claims: u64,
    },
    #[serde(rename = "dispatch_ready")]
    DispatchReady {
        nonce: String,
        #[serde(rename = "launchId")]
        launch_id: String,
        #[serde(rename = "requeuedRunIds")]
        requeued_run_ids: Vec<String>,
        #[serde(rename = "blockedRunIds")]
        blocked_run_ids: Vec<String>,
    },
    #[serde(rename = "worker_started")]
    WorkerStarted,
    #[serde(rename = "worker_exit")]
    WorkerExit,
    #[serde(rename = "worker_recovery_required")]
    WorkerRecoveryRequired,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BootstrapResponse {
    base_url: String,
    workspace_id: String,
    bearer_token: String,
}

#[cfg(not(windows))]
struct ManagedApi {
    child: Child,
    stdin: ChildStdin,
}
#[cfg(windows)]
type ManagedApi = ManagedProcess;

struct RuntimeState {
    base_url: String,
    workspace_id: String,
    bearer_token: String,
    frame_created: Arc<AtomicBool>,
    #[cfg(windows)]
    _single_instance: SingleInstanceGuard,
    api: Mutex<Option<ManagedApi>>,
    #[cfg(windows)]
    supervisor: Arc<Mutex<Option<ManagedProcess>>>,
    /// Set when shutdown began so the supervisor watcher stops restarting.
    stopping: Arc<AtomicBool>,
}

impl RuntimeState {
    fn stop(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        #[cfg(windows)]
        {
            if let Some(mut supervisor) = self.supervisor.lock().expect("supervisor mutex poisoned").take() {
                if let Err(error) = supervisor.stop(Duration::from_secs(5)) { eprintln!("Relay Agent supervisor stop: {error}"); }
            }
            if let Some(mut api) = self.api.lock().expect("API mutex poisoned").take() {
                if let Err(error) = api.stop(Duration::from_secs(5)) { eprintln!("Relay Agent API stop: {error}"); }
            }
        }
        #[cfg(not(windows))]
        {
        if let Some(mut api) = self.api.lock().expect("API mutex poisoned").take() {
            // EOF is the only normal shutdown signal; no secret is written to the pipe.
            drop(api.stdin);
            let deadline = Instant::now() + Duration::from_secs(5);
            while Instant::now() < deadline {
                match api.child.try_wait() {
                    Ok(Some(_)) => return,
                    Ok(None) => thread::sleep(Duration::from_millis(25)),
                    Err(_) => break,
                }
            }
            let _ = api.child.kill();
            let _ = api.child.wait();
        }
        }
    }
}

#[tauri::command]
fn desktop_bootstrap(window: WebviewWindow, state: tauri::State<'_, RuntimeState>) -> Result<BootstrapResponse, String> {
    if window.label() != "main" || state.frame_created.load(Ordering::SeqCst) {
        return Err("desktop bootstrap is limited to the packaged main frame".into());
    }
    let url = window.url().map_err(|_| "cannot verify the desktop window".to_owned())?;
    let origin_allowed = if tauri::is_dev() {
        is_dev_frontend_origin(&url)
    } else {
        url.scheme() == "http" && url.host_str() == Some("tauri.localhost")
            && url.port().is_none() && url.username().is_empty() && url.password().is_none()
    };
    if !origin_allowed {
        return Err("desktop bootstrap is limited to the packaged local origin".into());
    }
    let mut api = state.api.lock().expect("API mutex poisoned");
    #[cfg(windows)]
    let stopped = match api.as_mut() {
        Some(managed) => !matches!(managed.try_wait(), Ok(None)),
        None => true,
    };
    #[cfg(not(windows))]
    let stopped = match api.as_mut() {
        Some(managed) => !matches!(managed.child.try_wait(), Ok(None)),
        None => true,
    };
    if stopped {
        api.take();
        drop(api);
        #[cfg(windows)]
        state.stop();
        return Err("desktop API is no longer running".into());
    }
    // supervisor 失效不再让 bootstrap 永久失败（D1）：宿主 watcher 按有界策略
    // 重启 supervisor；重启预算耗尽时本地 API 仍可用，worker 是否真正在派发由
    // supervisor 进程事实决定，这里不伪装存活。
    Ok(BootstrapResponse {
        base_url: state.base_url.clone(),
        workspace_id: state.workspace_id.clone(),
        bearer_token: state.bearer_token.clone(),
    })
}

#[cfg(windows)]
struct SingleInstanceGuard { handle: HANDLE }
#[cfg(windows)]
impl Drop for SingleInstanceGuard {
    fn drop(&mut self) { unsafe { let _ = CloseHandle(self.handle); } }
}
#[cfg(windows)]
unsafe impl Send for SingleInstanceGuard {}
#[cfg(windows)]
unsafe impl Sync for SingleInstanceGuard {}

#[cfg(windows)]
fn acquire_single_instance() -> Result<SingleInstanceGuard, String> {
    acquire_single_instance_named(SINGLE_INSTANCE_MUTEX, true).map_err(|error| match error {
        SingleInstanceError::Busy => "Relay Agent is already open".to_owned(),
        SingleInstanceError::Unavailable => "cannot create the desktop single-instance guard".to_owned(),
    })
}

#[cfg(windows)]
enum SingleInstanceError { Busy, Unavailable }

#[cfg(windows)]
fn acquire_single_instance_named(name: &str, foreground: bool)
    -> Result<SingleInstanceGuard, SingleInstanceError> {
    unsafe {
        let name = HSTRING::from(name);
        let handle = CreateMutexW(None, false, &name)
            .map_err(|_| SingleInstanceError::Unavailable)?;
        if GetLastError() == ERROR_ALREADY_EXISTS {
            if foreground {
                let title = HSTRING::from(WINDOW_TITLE);
                if let Ok(window) = FindWindowW(None, &title) {
                    let _ = SetForegroundWindow(window);
                }
            }
            let _ = CloseHandle(handle);
            return Err(SingleInstanceError::Busy);
        }
        Ok(SingleInstanceGuard { handle })
    }
}

fn config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let path = std::env::var_os("RELAY_DESKTOP_CONFIG_PATH")
        .map(PathBuf::from)
        .unwrap_or(app.path().app_config_dir()
            .map_err(|_| "cannot locate the desktop configuration directory".to_owned())?
            .join("desktop.env"));
    if !path.is_file() {
        return Err(format!("desktop.env is missing at {}. Create it as documented in README.", path.display()));
    }
    if !path.is_absolute() { return Err("desktop.env path must be absolute".into()); }
    let metadata = fs::metadata(&path).map_err(|_| "cannot inspect desktop.env")?;
    if metadata.len() > 65_536 { return Err("desktop.env exceeds the size limit".into()); }
    let config = fs::read_to_string(&path).map_err(|_| "cannot read desktop.env")?;
    validate_desktop_config_keys(&config)?;
    Ok(path)
}

/// desktop.env 键白名单：四个运行时字段由启动脚本/宿主管理，RELAY_MODEL_* 为
/// 用户模型配置（密钥只留在该本地文件，经 --env-file 传给 API/Supervisor/Worker，
/// 不入库、不进 UI、不写日志）。其余键一律拒绝，防止注入任意环境变量。
fn validate_desktop_config_keys(config: &str) -> Result<(), String> {
    for line in config.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') { continue; }
        let Some((key, _)) = line.split_once('=') else { return Err("desktop.env contains an invalid setting".into()); };
        if !matches!(key.trim(), "RELAY_DB_URL" | "RELAY_DB_POOL_MAX" |
            "RELAY_DB_CONNECT_TIMEOUT_MS" | "RELAY_DESKTOP_WORKSPACE_ID" |
            "RELAY_MODEL_PROVIDER" | "RELAY_MODEL_NAME" | "RELAY_MODEL_API_KEY" |
            "RELAY_MODEL_BASE_URL" | "RELAY_MODEL_TIMEOUT_MS" |
            "RELAY_MODEL_MAX_OUTPUT_TOKENS" | "RELAY_MODEL_MAX_CALL_TOKENS" |
            "RELAY_MODEL_MAX_SCOPE_CALLS" | "RELAY_MODEL_MAX_SCOPE_TOKENS") {
            return Err("desktop.env contains an unsupported setting".into());
        }
    }
    Ok(())
}

/// supervisor/worker 诊断日志路径：跟随桌面数据目录约定（`<data-root>/logs`）。
/// 只写 supervisor 协议事件（worker 启动/退出/恢复请求）与宿主诊断（launch、
/// 退出码、重启决策）；不写 desktop.env 内容、模型密钥或 Bearer Token。
fn worker_log_path(data_root: &std::path::Path) -> PathBuf {
    data_root.join("logs").join("worker-supervisor.log")
}

/// 超过大小上限时尽力把当前日志轮转为 `<name>.old.log`（仅保留一代）。
/// 子进程继承的日志句柄可能暂时锁住重命名；轮转失败不阻塞写入，待其退出后
/// 下一次写入会再次尝试轮转。
fn rotate_worker_log_if_large(path: &std::path::Path, rotate_bytes: u64) {
    if let Ok(metadata) = fs::metadata(path) {
        if metadata.len() > rotate_bytes {
            let mut rotated = path.as_os_str().to_os_string();
            rotated.push(".old.log");
            let _ = fs::rename(path, PathBuf::from(rotated));
        }
    }
}

/// 追加一行带 UTC 时间戳的诊断日志；目录不存在则创建。写入失败静默忽略：
/// 诊断日志不得影响宿主可用性。
fn append_worker_log_capped(path: &std::path::Path, line: &str, rotate_bytes: u64) {
    rotate_worker_log_if_large(path, rotate_bytes);
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let stamped = format!("{} {}", iso_utc_timestamp(), line);
    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(path) {
        use std::io::Write;
        let _ = file.write_all(stamped.as_bytes()).and_then(|_| file.write_all(b"\n"));
    }
}

fn append_worker_log(path: &std::path::Path, line: &str) {
    append_worker_log_capped(path, line, WORKER_LOG_ROTATE_BYTES);
}

/// UTC ISO-8601（毫秒）时间戳；civil-from-days（Howard Hinnant 算法）免依赖。
fn iso_utc_timestamp() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let (days, rest) = ((now.as_secs() / 86_400) as i64, now.as_secs() % 86_400);
    let (hour, minute, second) = (rest / 3_600, (rest % 3_600) / 60, rest % 60);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < 10 { month_index + 3 } else { month_index - 9 };
    let year = if month <= 2 { year_of_era + era * 400 + 1 } else { year_of_era + era * 400 };
    format!(
        "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z",
        millis = now.subsec_millis()
    )
}

fn read_startup(stdout: impl std::io::Read + Send + 'static, nonce: &str) -> Result<(u16, String), String> {
    read_startup_with_timeout(stdout, nonce, Duration::from_secs(30))
}

fn read_startup_with_timeout(
    stdout: impl std::io::Read + Send + 'static,
    nonce: &str,
    timeout: Duration,
) -> Result<(u16, String), String> {
    let expected = nonce.to_owned();
    let (sender, receiver) = mpsc::sync_channel(1);
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            // Fastify output is never surfaced as a handshake or in an error dialog.
            let Ok(event) = serde_json::from_str::<StartupEvent>(&line) else { continue };
            match event {
                StartupEvent::Ready { nonce, port, workspace_id, node_version } if nonce == expected => {
                    let _ = sender.send(if port > 0 && node_version == NODE_VERSION {
                        Ok((port, workspace_id))
                    } else { Err("the bundled API reported an invalid port or Node version".into()) });
                    // Keep draining stdout for the lifetime of the sidecar.
                }
                StartupEvent::Error { nonce, code } if nonce == expected => {
                    let explanation = match code.as_str() {
                        "DATABASE_UNAVAILABLE" => "PostgreSQL is unavailable; check desktop.env and start the existing PostgreSQL service",
                        "SCHEMA_UNAVAILABLE" => "PostgreSQL schema is incompatible; run the documented migrations",
                        "WORKSPACE_UNAVAILABLE" => "the configured workspace does not exist; initialize it first",
                        "CONFIG_INVALID" => "desktop.env is incomplete or invalid; check README",
                        "DESKTOP_BOUNDARY_FAILED" => "the API loopback identity check failed",
                        _ => "the API could not finish desktop startup",
                    };
                    let _ = sender.send(Err(explanation.into()));
                    return;
                }
                _ => {}
            }
        }
        let _ = sender.send(Err("the bundled API exited before its private readiness handshake".into()));
    });
    receiver.recv_timeout(timeout)
        .map_err(|_| "the bundled API did not become ready before the deadline".to_owned())?
}

#[cfg(windows)]
const SUPERVISOR_LINE_LIMIT: usize = 64 * 1024;
#[cfg(windows)]
const SUPERVISOR_FRAME_LIMIT: usize = 1024 * 1024;
#[cfg(windows)]
const STOPPED_LAUNCH_LIMIT: usize = 4096;
#[cfg(windows)]
const JS_SAFE_INTEGER_MAX: u64 = 9_007_199_254_740_991;
#[cfg(windows)]
const RECOVERY_IDLE_TIMEOUT: Duration = Duration::from_secs(120);
#[cfg(windows)]
const RECOVERY_TOTAL_TIMEOUT: Duration = Duration::from_secs(20 * 60);
/// Supervisor 重启预算：同一稳定期内最多连续重启次数；超过后本轮运行放弃重启，
/// 保留 API 可用（D1），桌面应用重启后预算重置。
#[cfg(windows)]
const SUPERVISOR_RESTART_LIMIT: u32 = 3;
#[cfg(windows)]
const SUPERVISOR_RESTART_BASE_BACKOFF_MS: u64 = 2_000;
/// supervisor 达到 dispatch_ready 后稳定运行超过该时长，其后的退出视为独立事件，
/// 重启预算重新计满（长期运行中的偶发故障不会被历史崩溃次数耗尽预算）。
#[cfg(windows)]
const SUPERVISOR_STABILITY_WINDOW: Duration = Duration::from_secs(300);
/// supervisor/worker 诊断日志超过该大小时轮转保留一代（约 2x 上限）。
const WORKER_LOG_ROTATE_BYTES: u64 = 8 * 1024 * 1024;

#[cfg(windows)]
enum SupervisorProgress {
    Ready,
    RecoveryAck,
    DispatchReady(Vec<String>),
}

#[cfg(windows)]
fn supervisor_startup_frame(
    nonce: &str, launch_id: &str, stopped_launches: &[StoppedLaunch],
) -> Result<String, String> {
    if stopped_launches.len() > STOPPED_LAUNCH_LIMIT {
        return Err("too many prior desktop launches for the supervisor recovery frame".into());
    }
    let frame = serde_json::json!({
        "nonce": nonce, "launchId": launch_id, "stoppedLaunches": stopped_launches,
    }).to_string();
    if frame.len() + 1 > SUPERVISOR_FRAME_LIMIT {
        return Err("supervisor recovery frame exceeds the private input limit".into());
    }
    Ok(frame)
}

#[cfg(windows)]
fn read_supervisor_line(reader: &mut impl BufRead) -> Result<Option<String>, String> {
    let mut bytes = Vec::new();
    loop {
        let (count, newline) = {
            let available = reader.fill_buf().map_err(|_| "cannot read supervisor private output")?;
            if available.is_empty() {
                return if bytes.is_empty() { Ok(None) }
                    else { Err("supervisor private output ended mid-line".into()) };
            }
            let newline = available.iter().position(|byte| *byte == b'\n');
            let count = newline.map_or(available.len(), |position| position + 1);
            if bytes.len() + count > SUPERVISOR_LINE_LIMIT {
                return Err("supervisor private output line exceeds the limit".into());
            }
            bytes.extend_from_slice(&available[..count]);
            (count, newline.is_some())
        };
        reader.consume(count);
        if newline {
            bytes.pop();
            if bytes.last() == Some(&b'\r') { bytes.pop(); }
            return String::from_utf8(bytes).map(Some)
                .map_err(|_| "supervisor private output is not UTF-8".into());
        }
    }
}

#[cfg(windows)]
fn read_supervisor_startup(
    stdout: impl std::io::Read + Send + 'static, nonce: &str, launch_id: &str,
    stopped_launches: &[StoppedLaunch],
    failed: Arc<AtomicBool>, worker_log: Option<PathBuf>,
) -> Result<Vec<String>, String> {
    read_supervisor_startup_with_timeouts(stdout, nonce, launch_id, stopped_launches, failed,
        worker_log, Duration::from_secs(30), RECOVERY_IDLE_TIMEOUT, RECOVERY_TOTAL_TIMEOUT)
}

#[cfg(windows)]
fn read_supervisor_startup_with_timeouts(
    stdout: impl std::io::Read + Send + 'static, nonce: &str, launch_id: &str,
    stopped_launches: &[StoppedLaunch], failed: Arc<AtomicBool>, worker_log: Option<PathBuf>,
    ready_timeout: Duration, idle_timeout: Duration, total_timeout: Duration,
) -> Result<Vec<String>, String> {
    let expected_nonce = nonce.to_owned();
    let expected_launch = launch_id.to_owned();
    let old_launch_ids = stopped_launches.iter().map(|launch| launch.launch_id.clone())
        .collect::<Vec<_>>();
    let (sender, receiver) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut stage = 0;
        let mut next_ack = 0;
        let mut reconciled = Vec::new();
        loop {
            let line = match read_supervisor_line(&mut reader) {
                Ok(Some(line)) => line,
                Ok(None) => {
                    if stage < 2 { let _ = sender.send(Err("supervisor exited before completing private readiness".into())); }
                    break;
                }
                Err(error) => {
                    if stage < 2 { let _ = sender.send(Err(error)); }
                    break;
                }
            };
            // D2：supervisor 协议事件逐行落盘；崩溃时日志保留 worker 生命周期证据。
            if let Some(log) = worker_log.as_ref() { append_worker_log(log, &line); }
            let event = match serde_json::from_str::<SupervisorEvent>(&line) {
                Ok(event) => event,
                Err(_) => {
                    if stage < 2 { let _ = sender.send(Err("supervisor private readiness event is invalid".into())); }
                    break;
                }
            };
            match (stage, event) {
                (0, SupervisorEvent::Ready { nonce, launch_id, node_version })
                    if nonce == expected_nonce && launch_id == expected_launch
                        && node_version == NODE_VERSION => {
                    stage = 1;
                    if sender.send(Ok(SupervisorProgress::Ready)).is_err() { break; }
                }
                (1, SupervisorEvent::RecoveryAck { nonce, launch_id, retained_claims })
                    if nonce == expected_nonce
                        && old_launch_ids.get(next_ack) == Some(&launch_id)
                        && retained_claims <= JS_SAFE_INTEGER_MAX => {
                    next_ack += 1;
                    if retained_claims == 0 { reconciled.push(launch_id); }
                    if sender.send(Ok(SupervisorProgress::RecoveryAck)).is_err() { break; }
                }
                (1, SupervisorEvent::DispatchReady { nonce, launch_id, requeued_run_ids, blocked_run_ids })
                    if nonce == expected_nonce && launch_id == expected_launch
                        && next_ack == old_launch_ids.len() => {
                    let _ = (requeued_run_ids, blocked_run_ids);
                    stage = 2;
                    if sender.send(Ok(SupervisorProgress::DispatchReady(std::mem::take(&mut reconciled)))).is_err() { break; }
                }
                (2, SupervisorEvent::WorkerStarted | SupervisorEvent::WorkerExit |
                    SupervisorEvent::WorkerRecoveryRequired) => {
                    // Runtime events are intentionally drained after the startup channel is gone.
                }
                _ => {
                    if stage < 2 { let _ = sender.send(Err("supervisor private readiness identity or order is invalid".into())); }
                    break;
                }
            }
        }
        failed.store(true, Ordering::SeqCst);
    });
    match receiver.recv_timeout(ready_timeout)
        .map_err(|_| "supervisor did not report private readiness before the deadline".to_owned())?? {
        SupervisorProgress::Ready => {},
        _ => return Err("supervisor private readiness is out of order".into()),
    }
    let start = std::time::Instant::now();
    let total_deadline = start + total_timeout;
    let mut idle_deadline = start + idle_timeout;
    loop {
        let now = std::time::Instant::now();
        if now >= idle_deadline || now >= total_deadline {
            return Err("supervisor recovery did not complete before the deadline".into());
        }
        let wait = idle_deadline.min(total_deadline).saturating_duration_since(now);
        match receiver.recv_timeout(wait)
            .map_err(|_| "supervisor recovery did not complete before the deadline".to_owned())?? {
            SupervisorProgress::RecoveryAck => idle_deadline = std::time::Instant::now() + idle_timeout,
            SupervisorProgress::DispatchReady(reconciled) => return Ok(reconciled),
            SupervisorProgress::Ready => return Err("supervisor private readiness is out of order".into()),
        }
    }
}

/// D1 重启预算：快速连续崩溃受连续重启次数约束；稳定运行超过稳定窗的
/// supervisor 死亡视为独立事件，预算重新计满（长期偶发故障仍可自愈）。
#[cfg(windows)]
fn supervisor_restart_allowed(consecutive_restarts: u32, supervisor_uptime: Duration) -> bool {
    supervisor_uptime >= SUPERVISOR_STABILITY_WINDOW || consecutive_restarts < SUPERVISOR_RESTART_LIMIT
}

/// 连续重启的指数退避：2s、4s、8s，之后封顶增长。
#[cfg(windows)]
fn supervisor_restart_backoff(consecutive_restarts: u32) -> Duration {
    let shift = consecutive_restarts.saturating_sub(1).min(4);
    Duration::from_millis(SUPERVISOR_RESTART_BASE_BACKOFF_MS << shift)
}

/// 重启 supervisor 所需的静态启动参数（由 start_api 解析一次）。
#[cfg(windows)]
struct SupervisorSpawnContext {
    node: PathBuf,
    supervisor_entry: PathBuf,
    env_file: OsString,
    data_root: PathBuf,
    file_io_helper: OsString,
    worker_log: PathBuf,
    /// 仍在运行的 API 所属 launch：重启恢复时其 API Job 不得被终止。
    api_launch_id: String,
}

/// 以新的 launch（新 Job、新 ARMED 记录）重启 supervisor：恢复既有 launch
/// 记录、两段式握手、清理已收敛记录。失败时丢弃半武装记录；任何已派生的
/// 进程树随 ManagedProcess 丢弃由 Job kill-on-close 终止。
#[cfg(windows)]
fn spawn_supervisor(context: &SupervisorSpawnContext)
    -> Result<(ManagedProcess, Arc<AtomicBool>), String> {
    restore_isolation::assert_not_restore_isolated(&context.data_root)?;
    let stopped_launches = job_sidecar::recover_supervisor_restart_launches(
        &context.data_root, &context.api_launch_id)?;
    let launch = job_sidecar::arm_launch(&context.data_root)?;
    let record = context.data_root.join("runtime-launches").join(format!("{}.json", launch.id));
    let attempt = (|| {
        let nonce = Uuid::new_v4().to_string();
        let frame = supervisor_startup_frame(&nonce, &launch.id, &stopped_launches)?;
        let mut supervisor = ManagedProcess::spawn(&context.node,
            &[context.env_file.clone(), context.supervisor_entry.clone().into_os_string()],
            &[
                ("RELAY_DATA_ROOT".into(), context.data_root.as_os_str().to_os_string()),
                ("RELAY_FILE_IO_HELPER".into(), context.file_io_helper.clone()),
                ("RELAY_SUPERVISOR_DESKTOP_MODE".into(), "true".into()),
            ],
            launch.supervisor_job, Some(&context.worker_log))?;
        supervisor.write_frame(&frame)?;
        let failure = Arc::new(AtomicBool::new(false));
        let reconciled = read_supervisor_startup(supervisor.take_stdout()?, &nonce, &launch.id,
            &stopped_launches, Arc::clone(&failure), Some(context.worker_log.clone()))?;
        if failure.load(Ordering::SeqCst) || !matches!(supervisor.try_wait(), Ok(None)) {
            return Err("supervisor private output or process failed after readiness".into());
        }
        Ok((supervisor, failure, reconciled))
    })();
    match attempt {
        Ok((supervisor, failure, reconciled)) => {
            // 已收敛记录的清理属于卫生工作而非可用性：即使删除失败也保留
            // 已就绪的 supervisor，残留记录会在下次启动协调中再次被收敛。
            if let Err(error) = job_sidecar::remove_reconciled_launches(&context.data_root, &reconciled) {
                append_worker_log(&context.worker_log,
                    &format!("host: reconciled launch record cleanup failed: {error}"));
            }
            Ok((supervisor, failure))
        }
        Err(error) => {
            let _ = fs::remove_file(&record);
            Err(error)
        }
    }
}

/// supervisor 存活 watcher：退出（无论退出码，D1）后先终止其进程树，再按
/// 有界预算与指数退避重启；预算耗尽则写明诊断并放弃（API 保持可用）。
#[cfg(windows)]
fn spawn_supervisor_watcher(
    context: SupervisorSpawnContext,
    supervisor: Arc<Mutex<Option<ManagedProcess>>>,
    failure: Arc<AtomicBool>,
    stopping: Arc<AtomicBool>,
    ready_at: std::time::Instant,
) {
    thread::spawn(move || {
        let mut failure = failure;
        let mut consecutive_restarts = 0_u32;
        let mut ready_at = Some(ready_at);
        loop {
            if stopping.load(Ordering::SeqCst) { break; }
            thread::sleep(Duration::from_millis(100));
            let exited = {
                let guard = supervisor.lock().expect("supervisor mutex poisoned");
                match guard.as_ref() {
                    // stop() 已接管进程槽；关闭流程拥有其生命周期。
                    None => break,
                    Some(managed) =>
                        failure.load(Ordering::SeqCst) || !matches!(managed.try_wait(), Ok(None)),
                }
            };
            if !exited { continue; }
            let process = supervisor.lock().expect("supervisor mutex poisoned").take()
                .expect("supervisor was present");
            if let Err(error) = process.job.terminate_and_wait(Duration::from_secs(10)) {
                append_worker_log(&context.worker_log,
                    &format!("host: supervisor process tree stop failed: {error}"));
            }
            drop(process);
            let uptime = ready_at.map_or(Duration::ZERO, |started| started.elapsed());
            if uptime >= SUPERVISOR_STABILITY_WINDOW { consecutive_restarts = 0; }
            let mut restarted = None;
            while supervisor_restart_allowed(consecutive_restarts, uptime)
                && !stopping.load(Ordering::SeqCst) {
                consecutive_restarts += 1;
                let backoff = supervisor_restart_backoff(consecutive_restarts);
                append_worker_log(&context.worker_log, &format!(
                    "host: supervisor exited after {} s; restart {}/{} in {} ms",
                    uptime.as_secs(), consecutive_restarts, SUPERVISOR_RESTART_LIMIT,
                    backoff.as_millis()));
                let deadline = std::time::Instant::now() + backoff;
                while std::time::Instant::now() < deadline && !stopping.load(Ordering::SeqCst) {
                    thread::sleep(Duration::from_millis(50));
                }
                if stopping.load(Ordering::SeqCst) { break; }
                match spawn_supervisor(&context) {
                    Ok((managed, next_failure)) => { restarted = Some((managed, next_failure)); break; }
                    Err(error) => append_worker_log(&context.worker_log, &format!(
                        "host: supervisor restart {}/{} failed: {error}",
                        consecutive_restarts, SUPERVISOR_RESTART_LIMIT)),
                }
            }
            match restarted {
                Some((managed, next_failure)) => {
                    *supervisor.lock().expect("supervisor mutex poisoned") = Some(managed);
                    failure = next_failure;
                    ready_at = Some(std::time::Instant::now());
                    append_worker_log(&context.worker_log,
                        "host: supervisor restarted; worker dispatch resumes");
                }
                None => {
                    if stopping.load(Ordering::SeqCst) { break; }
                    failure.store(true, Ordering::SeqCst);
                    append_worker_log(&context.worker_log,
                        "host: supervisor restart budget exhausted; worker dispatch stays stopped while the local API remains available; restart the desktop app to retry");
                    break;
                }
            }
        }
    });
}

#[cfg(windows)]
fn start_api(app: &tauri::AppHandle, single_instance: SingleInstanceGuard) -> Result<RuntimeState, String> {
    let config = config_path(app)?;
    let node = app.path().resolve("node.exe", BaseDirectory::Resource)
        .map_err(|_| "cannot locate the bundled Node runtime".to_owned())?;
    let entry = app.path().resolve("api/dist/src/main.js", BaseDirectory::Resource)
        .map_err(|_| "cannot locate the bundled API".to_owned())?;
    let supervisor_entry = app.path().resolve("api/dist/src/worker/supervisor-main.js", BaseDirectory::Resource)
        .map_err(|_| "cannot locate the bundled supervisor".to_owned())?;
    let worker_entry = app.path().resolve("api/dist/src/worker/main.js", BaseDirectory::Resource)
        .map_err(|_| "cannot locate the bundled Worker".to_owned())?;
    let file_io_helper = app.path().resolve("relay-file-io-helper.exe", BaseDirectory::Resource)
        .map_err(|_| "cannot locate the bundled file I/O helper".to_owned())?;
    if !node.is_file() || !entry.is_file() || !supervisor_entry.is_file() ||
        !worker_entry.is_file() || !file_io_helper.is_file() {
        return Err("the release directory is incomplete (Node, API, Worker or file I/O helper missing)".into());
    }
    verify_supervisor_protocol(&supervisor_entry)?;
    let data_root = match std::env::var_os("RELAY_DESKTOP_DATA_ROOT") {
        Some(path) => {
            let path = PathBuf::from(path);
            if !path.is_absolute() || path.to_string_lossy().starts_with("\\\\") {
                return Err("RELAY_DESKTOP_DATA_ROOT must be a local absolute path".into());
            }
            path
        }
        None => app.path().app_data_dir()
            .map_err(|_| "cannot locate the desktop data directory".to_owned())?.join("data"),
    };
    restore_isolation::assert_not_restore_isolated(&data_root)?;
    fs::create_dir_all(&data_root).map_err(|_| "cannot create the desktop data directory".to_owned())?;
    let stopped_launches = recover_old_launches(&data_root)?;
    if stopped_launches.len() > STOPPED_LAUNCH_LIMIT {
        return Err("too many prior desktop launches for the supervisor recovery frame".into());
    }
    let launch = arm_launch(&data_root)?;
    let launch_id = launch.id;
    let worker_log = worker_log_path(&data_root);
    let nonce = Uuid::new_v4().simple().to_string();
    let supervisor_nonce = Uuid::new_v4().to_string();
    let supervisor_frame = supervisor_startup_frame(&supervisor_nonce, &launch_id, &stopped_launches)?;
    let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let env_file = OsString::from(format!("--env-file={}", config.display()));
    let api_args = [env_file.clone(), entry.into_os_string(), "--desktop-child".into()];
    // 打包构建不注入该变量；tauri dev 时允许开发服务器来源访问本机 API。
    let mut api_env: Vec<(String, OsString)> = vec![
        ("RELAY_DATA_ROOT".into(), data_root.as_os_str().to_os_string()),
        ("RELAY_FILE_IO_HELPER".into(), file_io_helper.as_os_str().to_os_string()),
    ];
    if tauri::is_dev() { api_env.push(("RELAY_DESKTOP_EXTRA_ORIGIN".into(), DEV_ORIGIN.into())); }
    let mut api = ManagedProcess::spawn(&node, &api_args, &api_env, launch.api_job, None)?;
    let frame = serde_json::json!({ "nonce": nonce, "bearerToken": token });
    api.write_frame(&frame.to_string())?;
    let (port, workspace_id) = read_startup(api.take_stdout()?, &nonce)?;
    let supervisor_args = [env_file.clone(), supervisor_entry.clone().into_os_string()];
    let mut supervisor = ManagedProcess::spawn(&node, &supervisor_args, &[
        ("RELAY_DATA_ROOT".into(), data_root.as_os_str().to_os_string()),
        ("RELAY_FILE_IO_HELPER".into(), file_io_helper.as_os_str().to_os_string()),
        ("RELAY_SUPERVISOR_DESKTOP_MODE".into(), "true".into()),
    ], launch.supervisor_job, Some(&worker_log))?;
    supervisor.write_frame(&supervisor_frame)?;
    let supervisor_failed = Arc::new(AtomicBool::new(false));
    let reconciled = read_supervisor_startup(supervisor.take_stdout()?, &supervisor_nonce,
        &launch_id, &stopped_launches, Arc::clone(&supervisor_failed), Some(worker_log.clone()))?;
    if supervisor_failed.load(Ordering::SeqCst) || !matches!(supervisor.try_wait(), Ok(None)) {
        return Err("supervisor private output or process failed after readiness".into());
    }
    remove_reconciled_launches(&data_root, &reconciled)?;
    append_worker_log(&worker_log, &format!("host: supervisor ready (launch {launch_id})"));
    let supervisor = Arc::new(Mutex::new(Some(supervisor)));
    let stopping = Arc::new(AtomicBool::new(false));
    // D1：supervisor 与 API 进程解耦——API 存活期间 supervisor 意外退出由
    // watcher 按有界预算重启，不再把桌面 bootstrap 拖入永久失败。
    spawn_supervisor_watcher(SupervisorSpawnContext {
        node, supervisor_entry, env_file, data_root,
        file_io_helper: file_io_helper.as_os_str().to_os_string(),
        worker_log, api_launch_id: launch_id,
    }, Arc::clone(&supervisor), supervisor_failed, Arc::clone(&stopping),
        std::time::Instant::now());
    Ok(RuntimeState {
        base_url: format!("http://127.0.0.1:{port}"), workspace_id,
        bearer_token: token, frame_created: Arc::new(AtomicBool::new(false)),
        _single_instance: single_instance,
        api: Mutex::new(Some(api)), supervisor, stopping,
    })
}

#[cfg(not(windows))]
fn start_api(app: &tauri::AppHandle) -> Result<RuntimeState, String> {
    let config = config_path(app)?;
    let node = app.path().resolve("node.exe", BaseDirectory::Resource)
        .map_err(|_| "cannot locate the bundled Node runtime".to_owned())?;
    let entry = app.path().resolve("api/dist/src/main.js", BaseDirectory::Resource)
        .map_err(|_| "cannot locate the bundled API".to_owned())?;
    if !node.is_file() || !entry.is_file() { return Err("the release directory is incomplete".into()); }
    let data_root = app.path().app_data_dir().map_err(|_| "cannot locate desktop data")?.join("data");
    restore_isolation::assert_not_restore_isolated(&data_root)?;
    fs::create_dir_all(&data_root).map_err(|_| "cannot create desktop data directory")?;
    let nonce = Uuid::new_v4().simple().to_string();
    let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let mut child = Command::new(&node).arg(format!("--env-file={}", config.display()))
        .arg(&entry).arg("--desktop-child").env("RELAY_DATA_ROOT", &data_root)
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null())
        .spawn().map_err(|_| "cannot start bundled Node API")?;
    let mut stdin = child.stdin.take().ok_or("cannot open API private pipe")?;
    let frame = serde_json::json!({ "nonce": nonce, "bearerToken": token });
    writeln!(stdin, "{frame}").and_then(|_| stdin.flush()).map_err(|_| "cannot send API startup frame")?;
    let stdout = child.stdout.take().ok_or("cannot read API readiness pipe")?;
    let (port, workspace_id) = read_startup(stdout, &nonce)?;
    Ok(RuntimeState { base_url: format!("http://127.0.0.1:{port}"), workspace_id,
        bearer_token: token, frame_created: Arc::new(AtomicBool::new(false)),
        api: Mutex::new(Some(ManagedApi { child, stdin })),
        stopping: Arc::new(AtomicBool::new(false)) })
}

#[cfg(windows)]
fn trusted_notification_uri(uri: &str) -> bool {
    tauri::Url::parse(uri).is_ok_and(|url| url.scheme() == "http"
        && url.host_str() == Some("tauri.localhost") && url.port().is_none()
        && url.username().is_empty() && url.password().is_none())
}

#[cfg(windows)]
fn install_frame_guard(window: &WebviewWindow, tainted: Arc<AtomicBool>) -> Result<(), String> {
    let result = Arc::new(Mutex::new(None));
    let result_for_webview = Arc::clone(&result);
    window.with_webview(move |webview| {
        let setup = (|| -> windows::core::Result<()> {
            unsafe {
                let core = webview.controller().CoreWebView2()?;
                let on_permission = PermissionRequestedEventHandler::create(Box::new(|_, args| {
                    let Some(args) = args else { return Ok(()); };
                    let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
                    args.PermissionKind(&mut kind)?;
                    if kind == COREWEBVIEW2_PERMISSION_KIND_NOTIFICATIONS {
                        let mut uri = PWSTR::null();
                        args.Uri(&mut uri)?;
                        let state = if trusted_notification_uri(&take_pwstr(uri)) {
                            COREWEBVIEW2_PERMISSION_STATE_ALLOW
                        } else { COREWEBVIEW2_PERMISSION_STATE_DENY };
                        args.SetState(state)?;
                    }
                    Ok(())
                }));
                let mut permission_token = 0_i64;
                core.add_PermissionRequested(&on_permission, &mut permission_token)?;
                let core = core.cast::<ICoreWebView2_4>()?;
                let on_frame = FrameCreatedEventHandler::create(Box::new(move |_, args| {
                    // Any child frame permanently revokes IPC for this launch, including about:blank/srcdoc.
                    tainted.store(true, Ordering::SeqCst);
                    if let Some(args) = args {
                        let frame = args.Frame()?.cast::<ICoreWebView2Frame2>()?;
                        let on_navigation = FrameNavigationStartingEventHandler::create(Box::new(|_, navigation| {
                            if let Some(navigation) = navigation { navigation.SetCancel(true)?; }
                            Ok(())
                        }));
                        let mut token = 0_i64;
                        frame.add_NavigationStarting(&on_navigation, &mut token)?;
                    }
                    Ok(())
                }));
                let mut token = 0_i64;
                core.add_FrameCreated(&on_frame, &mut token)
            }
        })();
        *result_for_webview.lock().expect("frame guard result mutex poisoned") = Some(setup);
    }).map_err(|_| "cannot access WebView2 to restrict child frames".to_owned())?;
    result.lock().expect("frame guard result mutex poisoned").take()
        .ok_or("WebView2 frame guard was not installed".to_owned())?
        .map_err(|_| "WebView2 frame guard could not be installed".to_owned())
}

fn csp_with_api(existing: &str, port: u16) -> Option<String> {
    let mut directives: HashMap<String, CspDirectiveSources> = Csp::Policy(existing.to_owned()).into();
    let connect = directives.get_mut("connect-src")?;
    if !connect.contains("'self'") || !connect.contains("http://ipc.localhost") {
        return None;
    }
    connect.push(format!("http://127.0.0.1:{port}"));
    Some(Csp::from(directives).to_string())
}

fn is_packaged_asset_request(uri: &tauri::http::Uri) -> bool {
    uri.scheme_str() == Some("tauri") && uri.authority().is_some_and(|authority| authority.as_str() == "localhost")
}

fn create_window(app: &tauri::AppHandle, state: &RuntimeState) -> Result<(), String> {
    let port: u16 = state.base_url.rsplit(':').next().unwrap_or_default().parse()
        .map_err(|_| "invalid API port".to_owned())?;
    let window = tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::External(
        "about:blank".parse().map_err(|_| "invalid blank startup URL".to_owned())?
    ))
        .title(WINDOW_TITLE).decorations(false).inner_size(1160.0, 780.0).visible(false)
        .zoom_hotkeys_enabled(true)
        .on_navigation(|url| is_allowed_frontend_navigation(&url))
        .on_new_window(|_, _| NewWindowResponse::Deny)
        .on_web_resource_request(move |request, response| {
            // Wry maps the visible http://tauri.localhost URL back to tauri://localhost
            // before calling Tauri's asset protocol handler.
            if is_packaged_asset_request(request.uri()) {
                if let Some(existing) = response.headers().get(tauri::http::header::CONTENT_SECURITY_POLICY)
                    .and_then(|value| value.to_str().ok()) {
                    if let Some(policy) = csp_with_api(existing, port) {
                        if let Ok(value) = tauri::http::HeaderValue::from_str(&policy) {
                            response.headers_mut().insert(tauri::http::header::CONTENT_SECURITY_POLICY, value);
                        }
                    }
                }
            }
        })
        .build().map_err(|_| "cannot create the Relay Agent window".to_owned())?;
    #[cfg(windows)]
    install_frame_guard(&window, Arc::clone(&state.frame_created))?;
    window.navigate(frontend_origin().parse().map_err(|_| "invalid frontend URL".to_owned())?)
        .map_err(|_| "cannot load the workbench".to_owned())?;
    window.show().map_err(|_| "cannot show the Relay Agent window".to_owned())?;
    Ok(())
}

#[cfg(windows)]
fn show_error(message: &str) {
    unsafe {
        let title = HSTRING::from("Relay Agent startup");
        let body = HSTRING::from(message);
        let _ = MessageBoxW(None, &body, &title, MB_OK | MB_ICONERROR);
    }
}

pub fn run() {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.iter().any(|argument| argument == "--maintenance-session") {
        #[cfg(windows)]
        {
            std::process::exit(maintenance_session::run(args.len() == 1));
        }
        #[cfg(not(windows))]
        {
            eprintln!("{{\"type\":\"maintenance_error\",\"version\":1,\"nonce\":null,\"code\":\"MAINTENANCE_SESSION_UNSUPPORTED\"}}");
            std::process::exit(1);
        }
    }
    #[cfg(windows)]
    let single_instance = acquire_single_instance().unwrap_or_else(|error| {
        eprintln!("Relay Agent: {error}");
        std::process::exit(SINGLE_INSTANCE_EXIT_CODE);
    });
    let result = tauri::Builder::default()
        .setup(move |app| {
            let state = start_api(app.handle(), #[cfg(windows)] single_instance)?;
            app.manage(state);
            let handle = app.handle().clone();
            let state = app.state::<RuntimeState>();
            create_window(&handle, &state)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![desktop_bootstrap])
        .on_window_event(|window, event| {
            if window.label() == "main" && matches!(event, WindowEvent::Destroyed) {
                window.state::<RuntimeState>().stop();
            }
        })
        .run(tauri::generate_context!());
    if let Err(error) = result {
        let message = error.to_string();
        eprintln!("Relay Agent startup failed: {message}");
        #[cfg(windows)]
        show_error(&message);
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::{csp_with_api, is_packaged_asset_request, read_startup, read_startup_with_timeout,
        validate_desktop_config_keys};
    #[cfg(windows)]
    use super::trusted_notification_uri;
    use std::{io::{Cursor, Read}, thread, time::Duration};
    #[cfg(windows)]
    use std::sync::{Arc, atomic::{AtomicBool, AtomicUsize, Ordering}, mpsc};

    struct SlowPipe;
    impl Read for SlowPipe {
        fn read(&mut self, _buffer: &mut [u8]) -> std::io::Result<usize> {
            thread::sleep(Duration::from_millis(50));
            Ok(0)
        }
    }

    #[test]
    fn private_readiness_rejects_wrong_nonce_and_early_exit() {
        let wrong = Cursor::new(b"{\"type\":\"desktop_ready\",\"nonce\":\"other\",\"port\":32123,\"workspaceId\":\"workspace\",\"nodeVersion\":\"v24.21.0\"}\n".to_vec());
        assert!(read_startup(wrong, "expected").is_err());
        let ready = Cursor::new(b"{\"type\":\"desktop_ready\",\"nonce\":\"expected\",\"port\":32123,\"workspaceId\":\"workspace\",\"nodeVersion\":\"v24.21.0\"}\n".to_vec());
        assert_eq!(read_startup(ready, "expected"), Ok((32123, "workspace".to_owned())));
        let wrong_version = Cursor::new(b"{\"type\":\"desktop_ready\",\"nonce\":\"expected\",\"port\":32123,\"workspaceId\":\"workspace\",\"nodeVersion\":\"v22.0.0\"}\n".to_vec());
        assert!(read_startup(wrong_version, "expected").is_err());
        let zero_port = Cursor::new(b"{\"type\":\"desktop_ready\",\"nonce\":\"expected\",\"port\":0,\"workspaceId\":\"workspace\",\"nodeVersion\":\"v24.21.0\"}\n".to_vec());
        assert!(read_startup(zero_port, "expected").is_err());
        assert!(read_startup(Cursor::new(Vec::<u8>::new()), "expected").is_err());
    }

    #[test]
    fn private_readiness_times_out_without_an_event() {
        assert!(read_startup_with_timeout(SlowPipe, "expected", Duration::from_millis(1)).is_err());
    }

    #[test]
    fn desktop_config_accepts_runtime_and_model_keys_and_rejects_others() {
        assert!(validate_desktop_config_keys(
            "# comment\n\nRELAY_DB_URL=postgresql://x\nRELAY_DB_POOL_MAX=4\n\
             RELAY_DB_CONNECT_TIMEOUT_MS=3000\nRELAY_DESKTOP_WORKSPACE_ID=00000000-0000-4000-8000-000000000000\n\
             RELAY_MODEL_PROVIDER=openai-compatible\nRELAY_MODEL_NAME=test-model\n\
             RELAY_MODEL_API_KEY=sk-local-only\nRELAY_MODEL_BASE_URL=https://api.example.cn/v1\n").is_ok());
        for text in ["RELAY_DB_URL=x\nNODE_OPTIONS=--import=evil\n",
            "RELAY_DB_URL=x\nRELAY_MODEL_PROVIDER=openai-compatible\nRELAY_SOMETHING=1\n",
            "RELAY_DB_URL=x\nmalformed"] {
            assert!(validate_desktop_config_keys(text).is_err(), "must reject: {text}");
        }
    }

    #[test]
    fn csp_keeps_tauri_script_sources_and_limits_api_port() {
        let original = "default-src 'self'; connect-src 'self' http://ipc.localhost; script-src 'self' 'nonce-test' 'sha256-test'; frame-src 'none'";
        let updated = csp_with_api(original, 32123).expect("valid Tauri CSP");
        assert!(updated.contains("http://127.0.0.1:32123"));
        assert!(!updated.contains("http://127.0.0.1:32124"));
        assert!(updated.contains("'nonce-test'"));
        assert!(updated.contains("'sha256-test'"));
        assert!(updated.contains("http://ipc.localhost"));
        assert!(updated.contains("frame-src 'none'"));
        assert!(csp_with_api("connect-src 'self'; script-src 'self'", 32123).is_none());
    }

    #[test]
    fn csp_hook_accepts_only_tauri_internal_asset_origin() {
        for address in ["tauri://localhost/", "tauri://localhost/projects"] {
            assert!(is_packaged_asset_request(&address.parse().unwrap()));
        }
        for address in ["http://tauri.localhost/", "tauri://localhost.evil/", "tauri://user@localhost/"] {
            assert!(!is_packaged_asset_request(&address.parse().unwrap()));
        }
    }

    #[cfg(windows)]
    #[test]
    fn notification_permission_is_limited_to_the_packaged_page_origin() {
        for uri in ["http://tauri.localhost/", "http://tauri.localhost/tasks?tab=attention"] {
            assert!(trusted_notification_uri(uri));
        }
        for uri in ["https://tauri.localhost/", "http://tauri.localhost.evil/",
            "http://user@tauri.localhost/", "http://tauri.localhost:8080/",
            "tauri://localhost/", "http://127.0.0.1/"] {
            assert!(!trusted_notification_uri(uri));
        }
    }

    #[cfg(windows)]
    #[test]
    fn old_supervisor_entry_is_rejected_before_node_launch() {
        if let Some(previous_entry) = std::env::var_os("RELAY_TEST_OLD_SUPERVISOR_ENTRY") {
            assert!(super::verify_supervisor_protocol(std::path::Path::new(&previous_entry)).is_err());
        }
        let path = std::env::temp_dir().join(format!("relay-old-supervisor-{}.js", uuid::Uuid::new_v4()));
        std::fs::write(&path, "process.stdout.write('supervisor_ready');\n")
            .expect("write old entry fixture");
        assert!(super::verify_supervisor_protocol(&path).is_err());
        std::fs::write(&path, "const protocol = 'relay-desktop-supervisor-v1';\n")
            .expect("write versioned entry fixture");
        assert!(super::verify_supervisor_protocol(&path).is_ok());
        std::fs::remove_file(&path).expect("remove isolated fixture");
    }

    #[cfg(windows)]
    #[test]
    fn supervisor_requires_matching_two_stage_private_handshake() {
        let valid = Cursor::new(b"{\"type\":\"supervisor_ready\",\"nonce\":\"nonce\",\"launchId\":\"launch\",\"nodeVersion\":\"v24.21.0\"}\n{\"type\":\"dispatch_ready\",\"nonce\":\"nonce\",\"launchId\":\"launch\",\"requeuedRunIds\":[],\"blockedRunIds\":[]}\n".to_vec());
        assert!(super::read_supervisor_startup(valid, "nonce", "launch", &[], Arc::new(AtomicBool::new(false)), None).is_ok());
        let wrong_launch = Cursor::new(b"{\"type\":\"supervisor_ready\",\"nonce\":\"nonce\",\"launchId\":\"old\",\"nodeVersion\":\"v24.21.0\"}\n".to_vec());
        assert!(super::read_supervisor_startup(wrong_launch, "nonce", "launch", &[], Arc::new(AtomicBool::new(false)), None).is_err());
        let wrong_nonce = Cursor::new(b"{\"type\":\"supervisor_ready\",\"nonce\":\"other\",\"launchId\":\"launch\",\"nodeVersion\":\"v24.21.0\"}\n".to_vec());
        assert!(super::read_supervisor_startup(wrong_nonce, "nonce", "launch", &[], Arc::new(AtomicBool::new(false)), None).is_err());
        let wrong_node = Cursor::new(b"{\"type\":\"supervisor_ready\",\"nonce\":\"nonce\",\"launchId\":\"launch\",\"nodeVersion\":\"v22.0.0\"}\n".to_vec());
        assert!(super::read_supervisor_startup(wrong_node, "nonce", "launch", &[], Arc::new(AtomicBool::new(false)), None).is_err());
        let out_of_order = Cursor::new(b"{\"type\":\"dispatch_ready\",\"nonce\":\"nonce\",\"launchId\":\"launch\",\"requeuedRunIds\":[],\"blockedRunIds\":[]}\n".to_vec());
        assert!(super::read_supervisor_startup(out_of_order, "nonce", "launch", &[], Arc::new(AtomicBool::new(false)), None).is_err());
        let missing_dispatch = Cursor::new(b"{\"type\":\"supervisor_ready\",\"nonce\":\"nonce\",\"launchId\":\"launch\",\"nodeVersion\":\"v24.21.0\"}\n".to_vec());
        assert!(super::read_supervisor_startup(missing_dispatch, "nonce", "launch", &[], Arc::new(AtomicBool::new(false)), None).is_err());
        let oversized = Cursor::new(vec![b'x'; super::SUPERVISOR_LINE_LIMIT + 1]);
        assert!(super::read_supervisor_startup(oversized, "nonce", "launch", &[], Arc::new(AtomicBool::new(false)), None).is_err());
    }

    #[cfg(windows)]
    fn stopped(launch_id: &str) -> super::job_sidecar::StoppedLaunch {
        super::job_sidecar::StoppedLaunch {
            launch_id: launch_id.into(),
            stop_evidence: "armed_job_absent_after_last_handle_closed".into(),
        }
    }

    #[cfg(windows)]
    fn supervisor_events(events: &[serde_json::Value], old: &[super::job_sidecar::StoppedLaunch])
        -> Result<Vec<String>, String> {
        let mut bytes = Vec::new();
        for event in events {
            bytes.extend_from_slice(event.to_string().as_bytes());
            bytes.push(b'\n');
        }
        super::read_supervisor_startup_with_timeouts(Cursor::new(bytes), "n", "current", old,
            Arc::new(AtomicBool::new(false)), None, Duration::from_secs(1),
            Duration::from_secs(2), Duration::from_secs(3))
    }

    #[cfg(windows)]
    #[test]
    fn supervisor_recovery_ack_is_ordered_complete_and_safe_integer_bounded() {
        let ready = serde_json::json!({"type":"supervisor_ready","nonce":"n",
            "launchId":"current","nodeVersion":"v24.21.0"});
        let ack = |id: &str, count: serde_json::Value| serde_json::json!({
            "type":"launch_recovery_ack","nonce":"n","launchId":id,"retainedClaims":count,
        });
        let done = serde_json::json!({"type":"dispatch_ready","nonce":"n",
            "launchId":"current","requeuedRunIds":[],"blockedRunIds":[]});
        let old = [stopped("first"), stopped("second")];
        let valid = [ready.clone(), ack("first", 0.into()), ack("second", 3.into()), done.clone()];
        assert_eq!(supervisor_events(&valid, &old).unwrap(), vec!["first"]);
        for invalid in [
            vec![ready.clone(), done.clone()],
            vec![ready.clone(), ack("first", 0.into()), done.clone()],
            vec![ready.clone(), ack("second", 0.into()), ack("first", 0.into()), done.clone()],
            vec![ready.clone(), ack("first", 0.into()), ack("first", 0.into()), done.clone()],
            vec![ready.clone(), ack("foreign", 0.into()), done.clone()],
            vec![ready.clone(), ack("first", (-1).into()), done.clone()],
            vec![ready.clone(), ack("first", serde_json::json!(1.5)), done.clone()],
            vec![ready.clone(), ack("first", (super::JS_SAFE_INTEGER_MAX + 1).into()), done.clone()],
            vec![ready.clone(), serde_json::json!({"type":"launch_recovery_ack",
                "nonce":"wrong","launchId":"first","retainedClaims":0}), done.clone()],
            vec![ready.clone(), ack("first", 0.into())],
        ] {
            assert!(supervisor_events(&invalid, &old).is_err(), "accepted invalid ack sequence: {invalid:?}");
        }
    }

    #[cfg(windows)]
    #[test]
    fn supervisor_consumes_4096_ack_frames_without_blocking_private_stdout() {
        let old = (0..super::STOPPED_LAUNCH_LIMIT)
            .map(|index| stopped(&format!("old-{index}"))).collect::<Vec<_>>();
        let mut events = vec![serde_json::json!({"type":"supervisor_ready","nonce":"n",
            "launchId":"current","nodeVersion":"v24.21.0"})];
        for launch in &old {
            events.push(serde_json::json!({"type":"launch_recovery_ack","nonce":"n",
                "launchId":launch.launch_id,"retainedClaims":0}));
        }
        events.push(serde_json::json!({"type":"dispatch_ready","nonce":"n",
            "launchId":"current","requeuedRunIds":[],"blockedRunIds":[]}));
        let clean = supervisor_events(&events, &old).expect("bounded ack stream must drain");
        assert_eq!(clean.len(), super::STOPPED_LAUNCH_LIMIT);
    }

    #[cfg(windows)]
    #[test]
    fn missing_final_dispatch_does_not_remove_an_acked_armed_record() {
        let root = std::env::temp_dir()
            .join(format!("relay-desktop-unfinished-ack-{}", uuid::Uuid::new_v4()));
        let launch = super::job_sidecar::arm_launch(&root).expect("arm old launch");
        let old_id = launch.id.clone();
        drop(launch);
        let old = super::job_sidecar::recover_old_launches(&root).expect("old Job stopped");
        let events = [
            serde_json::json!({"type":"supervisor_ready","nonce":"n",
                "launchId":"current","nodeVersion":"v24.21.0"}),
            serde_json::json!({"type":"launch_recovery_ack","nonce":"n",
                "launchId":old_id,"retainedClaims":0}),
        ];
        assert!(supervisor_events(&events, &old).is_err());
        assert!(root.join("runtime-launches").join(format!("{old_id}.json")).exists());
        let root_prefix = std::env::temp_dir().canonicalize().expect("temp root");
        assert!(root.canonicalize().expect("test root").starts_with(&root_prefix));
        std::fs::remove_dir_all(&root).expect("remove isolated record root");
    }

    #[cfg(windows)]
    #[test]
    fn supervisor_recovery_idle_and_absolute_deadlines_are_independent() {
        let (sender, receiver) = mpsc::channel();
        let output = StagedSupervisorOutput {
            receiver, current: Cursor::new(Vec::new()), chunks_read: Arc::new(AtomicUsize::new(0)),
        };
        sender.send(b"{\"type\":\"supervisor_ready\",\"nonce\":\"n\",\"launchId\":\"current\",\"nodeVersion\":\"v24.21.0\"}\n".to_vec()).unwrap();
        assert!(super::read_supervisor_startup_with_timeouts(output, "n", "current",
            &[stopped("first")], Arc::new(AtomicBool::new(false)), None,
            Duration::from_millis(50), Duration::from_millis(15), Duration::from_millis(100)).is_err());
        drop(sender);

        let (sender, receiver) = mpsc::channel();
        let output = StagedSupervisorOutput {
            receiver, current: Cursor::new(Vec::new()), chunks_read: Arc::new(AtomicUsize::new(0)),
        };
        sender.send(b"{\"type\":\"supervisor_ready\",\"nonce\":\"n\",\"launchId\":\"current\",\"nodeVersion\":\"v24.21.0\"}\n".to_vec()).unwrap();
        let writer = thread::spawn(move || {
            for index in 0..20 {
                thread::sleep(Duration::from_millis(15));
                if sender.send(format!("{{\"type\":\"launch_recovery_ack\",\"nonce\":\"n\",\"launchId\":\"old-{index}\",\"retainedClaims\":0}}\n").into_bytes()).is_err() { break; }
            }
        });
        let old = (0..20).map(|index| stopped(&format!("old-{index}"))).collect::<Vec<_>>();
        let started = std::time::Instant::now();
        assert!(super::read_supervisor_startup_with_timeouts(output, "n", "current", &old,
            Arc::new(AtomicBool::new(false)), None, Duration::from_millis(100),
            Duration::from_millis(100), Duration::from_millis(60)).is_err());
        assert!(started.elapsed() < Duration::from_millis(200), "absolute deadline did not interrupt ack progress");
        writer.join().unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn supervisor_frame_rejects_record_count_and_byte_overflow_before_node_start() {
        let normal = super::job_sidecar::StoppedLaunch {
            launch_id: "00000000-0000-4000-8000-000000000000".into(),
            stop_evidence: "armed_job_absent_after_last_handle_closed".into(),
        };
        let launches = (0..super::STOPPED_LAUNCH_LIMIT)
            .map(|_| super::job_sidecar::StoppedLaunch {
                launch_id: normal.launch_id.clone(),
                stop_evidence: normal.stop_evidence.clone(),
            }).collect::<Vec<_>>();
        assert!(super::supervisor_startup_frame("n", "l", &launches).is_ok());
        let mut too_many = launches;
        too_many.push(normal);
        assert!(super::supervisor_startup_frame("n", "l", &too_many).is_err());
        let oversized = [super::job_sidecar::StoppedLaunch {
            launch_id: "x".repeat(super::SUPERVISOR_FRAME_LIMIT),
            stop_evidence: "armed_job_absent_after_last_handle_closed".into(),
        }];
        assert!(super::supervisor_startup_frame("n", "l", &oversized).is_err());
    }

    #[cfg(windows)]
    struct StagedSupervisorOutput {
        receiver: mpsc::Receiver<Vec<u8>>,
        current: Cursor<Vec<u8>>,
        chunks_read: Arc<AtomicUsize>,
    }

    #[cfg(windows)]
    impl Read for StagedSupervisorOutput {
        fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
            loop {
                let count = self.current.read(output)?;
                if count > 0 { return Ok(count); }
                let Ok(next) = self.receiver.recv() else { return Ok(0) };
                self.current = Cursor::new(next);
                self.chunks_read.fetch_add(1, Ordering::SeqCst);
            }
        }
    }

    #[cfg(windows)]
    #[test]
    fn supervisor_continues_draining_multiple_runtime_events_after_dispatch_ready() {
        let (sender, receiver) = mpsc::channel();
        let chunks_read = Arc::new(AtomicUsize::new(0));
        let failed = Arc::new(AtomicBool::new(false));
        let output = StagedSupervisorOutput {
            receiver, current: Cursor::new(Vec::new()), chunks_read: Arc::clone(&chunks_read),
        };
        sender.send(b"{\"type\":\"supervisor_ready\",\"nonce\":\"n\",\"launchId\":\"l\",\"nodeVersion\":\"v24.21.0\"}\n".to_vec()).unwrap();
        sender.send(b"{\"type\":\"dispatch_ready\",\"nonce\":\"n\",\"launchId\":\"l\",\"requeuedRunIds\":[],\"blockedRunIds\":[]}\n".to_vec()).unwrap();
        super::read_supervisor_startup(output, "n", "l", &[], Arc::clone(&failed), None)
            .expect("two-stage readiness");
        sender.send(b"{\"type\":\"worker_started\",\"pid\":10,\"worker_id\":\"worker:desktop:l:x\"}\n".to_vec()).unwrap();
        sender.send(b"{\"type\":\"worker_exit\",\"code\":0,\"requeued_run_ids\":[],\"blocked_run_ids\":[]}\n".to_vec()).unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while chunks_read.load(Ordering::SeqCst) < 4 {
            assert!(std::time::Instant::now() < deadline, "supervisor reader stopped after dispatch_ready");
            thread::sleep(Duration::from_millis(5));
        }
        assert!(!failed.load(Ordering::SeqCst));
        drop(sender);
        while !failed.load(Ordering::SeqCst) {
            assert!(std::time::Instant::now() < deadline, "supervisor EOF was not reported");
            thread::sleep(Duration::from_millis(5));
        }
    }

    #[cfg(windows)]
    #[test]
    fn supervisor_rejects_unknown_runtime_event_without_waiting_for_eof() {
        let (sender, receiver) = mpsc::channel();
        let failed = Arc::new(AtomicBool::new(false));
        let output = StagedSupervisorOutput {
            receiver, current: Cursor::new(Vec::new()), chunks_read: Arc::new(AtomicUsize::new(0)),
        };
        sender.send(b"{\"type\":\"supervisor_ready\",\"nonce\":\"n\",\"launchId\":\"l\",\"nodeVersion\":\"v24.21.0\"}\n".to_vec()).unwrap();
        sender.send(b"{\"type\":\"dispatch_ready\",\"nonce\":\"n\",\"launchId\":\"l\",\"requeuedRunIds\":[],\"blockedRunIds\":[]}\n".to_vec()).unwrap();
        super::read_supervisor_startup(output, "n", "l", &[], Arc::clone(&failed), None)
            .expect("two-stage readiness");
        sender.send(b"{\"type\":\"unexpected_event\"}\n".to_vec()).unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while !failed.load(Ordering::SeqCst) {
            assert!(std::time::Instant::now() < deadline, "invalid event did not fail the supervisor");
            thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn supervisor_restart_policy_bounds_rapid_loops_and_recovers_stable_runs() {
        assert_eq!(super::supervisor_restart_backoff(1), Duration::from_secs(2));
        assert_eq!(super::supervisor_restart_backoff(2), Duration::from_secs(4));
        assert_eq!(super::supervisor_restart_backoff(3), Duration::from_secs(8));
        assert_eq!(super::supervisor_restart_backoff(9), Duration::from_secs(32));
        assert!(super::supervisor_restart_allowed(0, Duration::ZERO));
        assert!(super::supervisor_restart_allowed(2, Duration::from_secs(10)));
        assert!(!super::supervisor_restart_allowed(3, Duration::from_secs(10)),
            "rapid crash loop must exhaust the bounded restart budget");
        assert!(super::supervisor_restart_allowed(5, super::SUPERVISOR_STABILITY_WINDOW),
            "a stable supervisor death resets the budget");
    }

    #[test]
    fn worker_log_appends_rotates_and_keeps_one_generation() {
        let root = std::env::temp_dir()
            .join(format!("relay-worker-log-{}", uuid::Uuid::new_v4()));
        let log = root.join("logs").join("worker-supervisor.log");
        super::append_worker_log_capped(&log, "first {\"type\":\"worker_started\"}", u64::MAX);
        super::append_worker_log_capped(&log, "second", u64::MAX);
        let content = std::fs::read_to_string(&log).expect("log written");
        assert!(content.contains("first {\"type\":\"worker_started\"}"));
        assert!(content.contains("second"));
        assert_eq!(content.lines().count(), 2);
        super::append_worker_log_capped(&log, "after rotate", 0);
        let rotated = root.join("logs").join("worker-supervisor.log.old.log");
        assert!(rotated.exists(), "rotated generation must be kept");
        assert!(std::fs::read_to_string(&rotated).expect("rotated log").contains("second"));
        let fresh = std::fs::read_to_string(&log).expect("fresh log");
        assert_eq!(fresh.lines().count(), 1);
        assert!(fresh.contains("after rotate"));
        std::fs::remove_dir_all(&root).expect("remove isolated log root");
    }

    #[test]
    fn iso_utc_timestamp_shape_is_sortable() {
        let first = super::iso_utc_timestamp();
        assert_eq!(first.len(), 24);
        let bytes = first.as_bytes();
        for position in [4, 7] { assert_eq!(bytes[position], b'-'); }
        assert_eq!(bytes[10], b'T');
        for position in [13, 16] { assert_eq!(bytes[position], b':'); }
        assert_eq!(bytes[19], b'.');
        assert_eq!(bytes[23], b'Z');
        assert!(first.as_str() <= super::iso_utc_timestamp().as_str(),
            "same-format timestamps sort chronologically");
    }

    #[cfg(windows)]
    #[test]
    fn supervisor_reader_streams_runtime_events_into_the_worker_log() {
        let root = std::env::temp_dir()
            .join(format!("relay-reader-log-{}", uuid::Uuid::new_v4()));
        let log = root.join("logs").join("worker-supervisor.log");
        let (sender, receiver) = mpsc::channel();
        let failed = Arc::new(AtomicBool::new(false));
        let output = StagedSupervisorOutput {
            receiver, current: Cursor::new(Vec::new()), chunks_read: Arc::new(AtomicUsize::new(0)),
        };
        sender.send(b"{\"type\":\"supervisor_ready\",\"nonce\":\"n\",\"launchId\":\"l\",\"nodeVersion\":\"v24.21.0\"}\n".to_vec()).unwrap();
        sender.send(b"{\"type\":\"dispatch_ready\",\"nonce\":\"n\",\"launchId\":\"l\",\"requeuedRunIds\":[],\"blockedRunIds\":[]}\n".to_vec()).unwrap();
        super::read_supervisor_startup_with_timeouts(output, "n", "l", &[], Arc::clone(&failed),
            Some(log.clone()), Duration::from_secs(1), Duration::from_secs(2), Duration::from_secs(3))
            .expect("two-stage readiness");
        sender.send(b"{\"type\":\"worker_started\",\"pid\":10,\"worker_id\":\"worker:desktop:l:x\"}\n".to_vec()).unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while !std::fs::read_to_string(&log)
            .map(|content| content.contains("\"type\":\"worker_started\""))
            .unwrap_or(false) {
            assert!(std::time::Instant::now() < deadline, "runtime event was not logged");
            thread::sleep(Duration::from_millis(5));
        }
        assert!(!std::fs::read_to_string(&log).expect("log").contains("sk-local-only"),
            "the diagnostic log must not collect configuration values");
        drop(sender);
        std::fs::remove_dir_all(&root).expect("remove isolated log root");
    }
}
