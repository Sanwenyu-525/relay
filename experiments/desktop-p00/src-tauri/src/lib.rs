use std::{
    fs,
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use tauri::{Manager, WebviewWindow, WindowEvent, path::BaseDirectory};
use uuid::Uuid;

#[cfg(windows)]
use std::{ffi::c_void, os::windows::io::AsRawHandle};
#[cfg(windows)]
use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2_4, ICoreWebView2Frame2};
#[cfg(windows)]
use webview2_com::{FrameCreatedEventHandler, FrameNavigationStartingEventHandler, take_pwstr};
#[cfg(windows)]
use windows::{
    Win32::{
        Foundation::{CloseHandle, ERROR_ALREADY_EXISTS, GetLastError, HANDLE},
        System::{
            JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
                JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
                SetInformationJobObject,
            },
            Threading::CreateMutexW,
        },
        UI::WindowsAndMessaging::{FindWindowW, SetForegroundWindow},
    },
    core::{HSTRING, Interface, PCWSTR},
};

const TRUSTED_ORIGIN: &str = "http://tauri.localhost";
const WINDOW_TITLE: &str = "Relay P00 Desktop — Tauri WebView";
const SINGLE_INSTANCE_EXIT_CODE: i32 = 23;
#[cfg(windows)]
const SINGLE_INSTANCE_MUTEX: &str = "Local\\RelayDesktopP00SingleInstance";

struct ManagedSidecar {
    child: Child,
    stdin: ChildStdin,
    #[cfg(windows)]
    _job: SidecarJob,
}

#[derive(Clone, Copy)]
struct SidecarExit {
    graceful: bool,
    reaped: bool,
}

#[derive(Clone, Deserialize, Serialize)]
struct Verification {
    bad_host_status: u16,
    bad_origin_status: u16,
    no_token_status: u16,
}

#[derive(Deserialize)]
struct SidecarReadiness {
    fake_worker_ready: bool,
    worker_instance_valid: bool,
    node_version: String,
    port: u16,
    #[serde(rename = "type")]
    kind: String,
    verification: Verification,
}

#[derive(Serialize)]
struct BootstrapResponse {
    automated: bool,
    endpoint: String,
    frame_probe_control: bool,
    sidecar_node_version: String,
    token: String,
    verification: Verification,
}

#[derive(Serialize)]
struct AutomatedResult {
    dynamic_loopback_port: bool,
    fake_worker_ready: bool,
    node_resource_resolved: bool,
    run_id: String,
    sidecar_node_version: String,
    sidecar_graceful_exit: bool,
    sidecar_reaped: bool,
    status: &'static str,
    same_origin_frame_probe_executed: bool,
    same_origin_frame_probe_bootstrap_succeeded: bool,
    same_origin_frame_probe_bridge_available: bool,
    same_origin_frame_probe_bridge_reported: bool,
    same_origin_frame_probe_completion_reported: bool,
    same_origin_frame_probe_bootstrap_invocation_attempted: bool,
    same_origin_frame_probe_navigation_blocked: bool,
    same_origin_frame_navigation_blocked: bool,
    verification: Verification,
    webview_reloaded_handshake: bool,
    worker_instance_valid: bool,
}

struct RuntimeState {
    automated: bool,
    endpoint: String,
    fake_worker_ready: bool,
    frame_navigation_rejections: Arc<AtomicUsize>,
    frame_probe_navigation_rejections: Arc<AtomicUsize>,
    frame_probe_control: bool,
    #[cfg(windows)]
    _single_instance: SingleInstanceGuard,
    node_resource_resolved: bool,
    node_version: String,
    result_path: Option<PathBuf>,
    run_id: Option<String>,
    sidecar: Mutex<Option<ManagedSidecar>>,
    shutdown_result: Mutex<Option<SidecarExit>>,
    token: String,
    verification: Verification,
    worker_instance_valid: bool,
}

impl RuntimeState {
    fn shutdown_sidecar(&self) -> SidecarExit {
        if let Some(result) = *self
            .shutdown_result
            .lock()
            .expect("P00 sidecar shutdown result mutex poisoned")
        {
            return result;
        }

        let sidecar = self
            .sidecar
            .lock()
            .expect("P00 sidecar mutex poisoned")
            .take();
        let result = match sidecar {
            None => SidecarExit {
                graceful: true,
                reaped: true,
            },
            Some(mut sidecar) => stop_sidecar(&mut sidecar),
        };
        *self
            .shutdown_result
            .lock()
            .expect("P00 sidecar shutdown result mutex poisoned") = Some(result);
        result
    }

    fn write_automated_result(
        &self,
        webview_reloaded_handshake: bool,
        frame_probe_executed: bool,
        frame_probe_bridge_available: bool,
        frame_probe_bridge_reported: bool,
        frame_probe_bootstrap_succeeded: bool,
        frame_probe_completion_reported: bool,
        frame_probe_bootstrap_invocation_attempted: bool,
    ) -> Result<(), String> {
        let Some(path) = &self.result_path else {
            return Err("P00 automated result path is unavailable".into());
        };
        let Some(run_id) = &self.run_id else {
            return Err("P00 automated run id is unavailable".into());
        };
        let sidecar_exit = self.shutdown_sidecar();
        let frame_probe_navigation_blocked = self
            .frame_probe_navigation_rejections
            .load(Ordering::SeqCst)
            > 0;
        let frame_probe_behavior_verified = if self.frame_probe_control {
            frame_probe_executed
        } else {
            !frame_probe_executed && frame_probe_navigation_blocked
        };
        let passed = webview_reloaded_handshake
            && sidecar_exit.graceful
            && sidecar_exit.reaped
            && self.fake_worker_ready
            && self.worker_instance_valid
            && frame_probe_behavior_verified
            && self.verification.no_token_status == 401
            && self.verification.bad_host_status == 421
            && self.verification.bad_origin_status == 403;
        let result = AutomatedResult {
            dynamic_loopback_port: true,
            fake_worker_ready: self.fake_worker_ready,
            node_resource_resolved: self.node_resource_resolved,
            run_id: run_id.clone(),
            sidecar_node_version: self.node_version.clone(),
            sidecar_graceful_exit: sidecar_exit.graceful,
            sidecar_reaped: sidecar_exit.reaped,
            status: if passed {
                "AWAITING_PARENT_EXIT"
            } else {
                "FAILED"
            },
            same_origin_frame_probe_executed: frame_probe_executed,
            same_origin_frame_probe_bootstrap_succeeded: frame_probe_bootstrap_succeeded,
            same_origin_frame_probe_bridge_available: frame_probe_bridge_available,
            same_origin_frame_probe_bridge_reported: frame_probe_bridge_reported,
            same_origin_frame_probe_completion_reported: frame_probe_completion_reported,
            same_origin_frame_probe_bootstrap_invocation_attempted:
                frame_probe_bootstrap_invocation_attempted,
            same_origin_frame_probe_navigation_blocked: frame_probe_navigation_blocked,
            same_origin_frame_navigation_blocked: self
                .frame_navigation_rejections
                .load(Ordering::SeqCst)
                > 0,
            verification: self.verification.clone(),
            webview_reloaded_handshake,
            worker_instance_valid: self.worker_instance_valid,
        };
        let body = serde_json::to_vec_pretty(&result)
            .map_err(|error| format!("could not serialize P00 result: {error}"))?;
        fs::write(path, body).map_err(|error| format!("could not write P00 result: {error}"))
    }
}

#[tauri::command]
fn desktop_bootstrap(
    window: WebviewWindow,
    state: tauri::State<'_, RuntimeState>,
) -> Result<BootstrapResponse, String> {
    ensure_trusted_main_window(&window)?;
    Ok(BootstrapResponse {
        automated: state.automated,
        endpoint: state.endpoint.clone(),
        frame_probe_control: state.frame_probe_control,
        sidecar_node_version: state.node_version.clone(),
        token: state.token.clone(),
        verification: state.verification.clone(),
    })
}

#[tauri::command]
fn complete_automated_test(
    app: tauri::AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, RuntimeState>,
    frame_probe_executed: bool,
    frame_probe_bridge_available: bool,
    frame_probe_bridge_reported: bool,
    frame_probe_bootstrap_succeeded: bool,
    frame_probe_completion_reported: bool,
    frame_probe_bootstrap_invocation_attempted: bool,
) -> Result<(), String> {
    ensure_trusted_main_window(&window)?;
    if !state.automated {
        return Err("P00 automated completion is disabled for normal launches".into());
    }
    state.write_automated_result(
        true,
        frame_probe_executed,
        frame_probe_bridge_available,
        frame_probe_bridge_reported,
        frame_probe_bootstrap_succeeded,
        frame_probe_completion_reported,
        frame_probe_bootstrap_invocation_attempted,
    )?;
    app.exit(0);
    Ok(())
}

fn ensure_trusted_main_window(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("only the bundled main window may request desktop bootstrap".into());
    }
    let url = window
        .url()
        .map_err(|error| format!("could not inspect invoking window: {error}"))?;
    if url.scheme() != "http" || url.host_str() != Some("tauri.localhost") || url.port().is_some() {
        return Err("desktop bootstrap is restricted to the bundled local main frame".into());
    }
    Ok(())
}

fn start_sidecar(
    app: &tauri::AppHandle,
    frame_navigation_rejections: Arc<AtomicUsize>,
    frame_probe_navigation_rejections: Arc<AtomicUsize>,
    #[cfg(windows)] single_instance: SingleInstanceGuard,
) -> Result<RuntimeState, String> {
    let node_path = app
        .path()
        .resolve("node.exe", BaseDirectory::Resource)
        .map_err(|error| format!("could not resolve bundled Node resource: {error}"))?;
    let script_path = app
        .path()
        .resolve("sidecar.mjs", BaseDirectory::Resource)
        .map_err(|error| format!("could not resolve bundled sidecar resource: {error}"))?;
    if !node_path.is_file() || !script_path.is_file() {
        return Err("the packaged Node sidecar resources are unavailable".into());
    }

    let automated = std::env::args().any(|argument| argument == "--p00-automated");
    let frame_probe_control =
        std::env::args().any(|argument| argument == "--p00-frame-probe-control");
    if frame_probe_control && !automated {
        return Err("P00 frame probe control is available only with --p00-automated".into());
    }
    let result_path = automated
        .then(|| std::env::var_os("P00_RESULT_PATH").map(PathBuf::from))
        .flatten();
    let run_id = automated
        .then(|| std::env::var("P00_RUN_ID").ok())
        .flatten();
    if automated && (result_path.is_none() || run_id.is_none()) {
        return Err("P00 automated launch requires P00_RESULT_PATH and P00_RUN_ID".into());
    }

    let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let mut child = Command::new(&node_path)
        .arg(&script_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("could not start bundled Node sidecar: {error}"))?;
    #[cfg(windows)]
    let job = match SidecarJob::assign(&child) {
        Ok(job) => job,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
    };
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "could not open the sidecar private pipe".to_owned())?;
    let config = serde_json::json!({
      "expectedOrigin": TRUSTED_ORIGIN,
      "token": token,
    });
    let config_line = serde_json::to_vec(&config)
        .map_err(|error| format!("could not encode private sidecar bootstrap: {error}"))?;
    if stdin.write_all(&config_line).is_err()
        || stdin.write_all(b"\n").is_err()
        || stdin.flush().is_err()
    {
        let _ = child.kill();
        let _ = child.wait();
        return Err("could not deliver private sidecar bootstrap through its pipe".into());
    }

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "could not read sidecar readiness pipe".to_owned())?;
    let readiness = match read_readiness(stdout) {
        Ok(readiness) => readiness,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
    };
    if readiness.kind != "ready"
        || readiness.port == 0
        || !readiness.fake_worker_ready
        || !readiness.worker_instance_valid
    {
        let _ = child.kill();
        let _ = child.wait();
        return Err("sidecar readiness did not bind its own dynamic loopback port".into());
    }
    if readiness.verification.no_token_status != 401
        || readiness.verification.bad_host_status != 421
        || readiness.verification.bad_origin_status != 403
    {
        let _ = child.kill();
        let _ = child.wait();
        return Err("sidecar startup identity probes did not pass".into());
    }

    Ok(RuntimeState {
        automated,
        endpoint: format!("http://127.0.0.1:{}", readiness.port),
        fake_worker_ready: readiness.fake_worker_ready,
        frame_navigation_rejections,
        frame_probe_navigation_rejections,
        frame_probe_control,
        #[cfg(windows)]
        _single_instance: single_instance,
        node_resource_resolved: true,
        node_version: readiness.node_version,
        result_path,
        run_id,
        sidecar: Mutex::new(Some(ManagedSidecar {
            child,
            stdin,
            #[cfg(windows)]
            _job: job,
        })),
        shutdown_result: Mutex::new(None),
        token,
        verification: readiness.verification,
        worker_instance_valid: readiness.worker_instance_valid,
    })
}

#[cfg(windows)]
struct SingleInstanceGuard {
    handle: HANDLE,
}

#[cfg(windows)]
impl Drop for SingleInstanceGuard {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.handle);
        }
    }
}

// Windows HANDLE values can be used from multiple threads. This guard only closes the
// mutex at RuntimeState teardown, after Tauri has stopped dispatching commands.
#[cfg(windows)]
unsafe impl Send for SingleInstanceGuard {}
#[cfg(windows)]
unsafe impl Sync for SingleInstanceGuard {}

#[cfg(windows)]
struct SidecarJob {
    handle: HANDLE,
}

#[cfg(windows)]
impl SidecarJob {
    fn assign(child: &Child) -> Result<Self, String> {
        unsafe {
            let handle = CreateJobObjectW(None, PCWSTR::null())
                .map_err(|error| format!("could not create P00 sidecar Job Object: {error}"))?;
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if let Err(error) = SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) {
                let _ = CloseHandle(handle);
                return Err(format!(
                    "could not configure P00 sidecar Job Object: {error}"
                ));
            }
            let process_handle = HANDLE(child.as_raw_handle() as *mut c_void);
            if let Err(error) = AssignProcessToJobObject(handle, process_handle) {
                let _ = CloseHandle(handle);
                return Err(format!(
                    "could not assign P00 sidecar to its Job Object: {error}"
                ));
            }
            Ok(Self { handle })
        }
    }
}

#[cfg(windows)]
impl Drop for SidecarJob {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.handle);
        }
    }
}

// The Job Object handle is kept inside ManagedSidecar's mutex and is only closed
// after the child was reaped or when the host process terminates.
#[cfg(windows)]
unsafe impl Send for SidecarJob {}
#[cfg(windows)]
unsafe impl Sync for SidecarJob {}

#[cfg(windows)]
fn acquire_single_instance() -> Result<SingleInstanceGuard, String> {
    unsafe {
        let name = HSTRING::from(SINGLE_INSTANCE_MUTEX);
        let handle = CreateMutexW(None, false, &name)
            .map_err(|error| format!("could not create P00 single-instance mutex: {error}"))?;
        if GetLastError() == ERROR_ALREADY_EXISTS {
            let title = HSTRING::from(WINDOW_TITLE);
            if let Ok(window) = FindWindowW(None, &title) {
                let _ = SetForegroundWindow(window);
            }
            let _ = CloseHandle(handle);
            return Err("another Relay P00 Desktop instance is already running".into());
        }
        Ok(SingleInstanceGuard { handle })
    }
}

#[cfg(windows)]
fn install_subframe_blocker(
    window: WebviewWindow,
    frame_navigation_rejections: Arc<AtomicUsize>,
    frame_probe_navigation_rejections: Arc<AtomicUsize>,
) -> Result<(), String> {
    let setup_result = Arc::new(Mutex::new(None));
    let setup_result_for_webview = Arc::clone(&setup_result);
    window
        .with_webview(move |webview| {
            let result = configure_subframe_blocker(
                webview.controller(),
                Arc::clone(&frame_navigation_rejections),
                Arc::clone(&frame_probe_navigation_rejections),
            );
            *setup_result_for_webview
                .lock()
                .expect("P00 frame blocker setup mutex poisoned") = Some(result);
        })
        .map_err(|error| format!("could not access the P00 WebView2 host: {error}"))?;
    setup_result
        .lock()
        .expect("P00 frame blocker result mutex poisoned")
        .take()
        .ok_or_else(|| "P00 frame blocker setup did not return a result".to_owned())
        .and_then(|result| {
            result.map_err(|error| {
                format!("could not install P00 WebView2 subframe blocker: {error}")
            })
        })
}

#[cfg(windows)]
fn configure_subframe_blocker(
    controller: webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller,
    frame_navigation_rejections: Arc<AtomicUsize>,
    frame_probe_navigation_rejections: Arc<AtomicUsize>,
) -> windows::core::Result<()> {
    unsafe {
        let core = controller.CoreWebView2()?.cast::<ICoreWebView2_4>()?;
        let counter_for_frames = Arc::clone(&frame_navigation_rejections);
        let probe_counter_for_frames = Arc::clone(&frame_probe_navigation_rejections);
        let frame_created = FrameCreatedEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else {
                return Ok(());
            };
            let frame = args.Frame()?.cast::<ICoreWebView2Frame2>()?;
            let counter_for_navigation = Arc::clone(&counter_for_frames);
            let probe_counter_for_navigation = Arc::clone(&probe_counter_for_frames);
            let navigation_starting =
                FrameNavigationStartingEventHandler::create(Box::new(move |_, navigation| {
                    if let Some(navigation) = navigation {
                        let mut uri = windows::core::PWSTR::null();
                        navigation.Uri(&mut uri)?;
                        let uri = take_pwstr(uri);
                        navigation.SetCancel(true)?;
                        if uri.ends_with("/frame-probe.html") {
                            probe_counter_for_navigation.fetch_add(1, Ordering::SeqCst);
                        }
                        counter_for_navigation.fetch_add(1, Ordering::SeqCst);
                    }
                    Ok(())
                }));
            let mut token = 0_i64;
            frame.add_NavigationStarting(&navigation_starting, &mut token)?;
            Ok(())
        }));
        let mut token = 0_i64;
        core.add_FrameCreated(&frame_created, &mut token)
    }
}

fn read_readiness(stdout: impl std::io::Read + Send + 'static) -> Result<SidecarReadiness, String> {
    let (sender, receiver) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let mut line = String::new();
        let result = BufReader::new(stdout)
            .read_line(&mut line)
            .map(|_| line)
            .map_err(|error| error.to_string());
        let _ = sender.send(result);
    });
    let line = receiver
        .recv_timeout(Duration::from_secs(5))
        .map_err(|_| "timed out waiting for sidecar readiness from the spawned process".to_owned())?
        .map_err(|_| "could not read sidecar readiness from the spawned process".to_owned())?;
    serde_json::from_str(&line).map_err(|_| "sidecar sent invalid readiness data".to_owned())
}

fn stop_sidecar(sidecar: &mut ManagedSidecar) -> SidecarExit {
    if sidecar.stdin.write_all(b"shutdown\n").is_ok() && sidecar.stdin.flush().is_ok() {
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            match sidecar.child.try_wait() {
                Ok(Some(status)) => {
                    return SidecarExit {
                        graceful: status.success(),
                        reaped: true,
                    };
                }
                Ok(None) => thread::sleep(Duration::from_millis(25)),
                Err(_) => break,
            }
        }
    }
    let reaped = sidecar.child.kill().is_ok() && sidecar.child.wait().is_ok();
    SidecarExit {
        graceful: false,
        reaped,
    }
}

pub fn run() {
    #[cfg(windows)]
    let single_instance = acquire_single_instance().unwrap_or_else(|error| {
        eprintln!("P00 desktop startup rejected: {error}");
        std::process::exit(SINGLE_INSTANCE_EXIT_CODE);
    });
    let frame_navigation_rejections = Arc::new(AtomicUsize::new(0));
    let frame_probe_navigation_rejections = Arc::new(AtomicUsize::new(0));
    tauri::Builder::default()
        .setup(move |app| {
            app.manage(start_sidecar(
                app.handle(),
                Arc::clone(&frame_navigation_rejections),
                Arc::clone(&frame_probe_navigation_rejections),
                #[cfg(windows)]
                single_instance,
            )?);
            #[cfg(windows)]
            {
                let state = app.state::<RuntimeState>();
                if !state.frame_probe_control {
                    let window = app
                        .get_webview_window("main")
                        .ok_or_else(|| "P00 bundled main window is unavailable".to_owned())?;
                    install_subframe_blocker(
                        window,
                        Arc::clone(&frame_navigation_rejections),
                        Arc::clone(&frame_probe_navigation_rejections),
                    )?;
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            desktop_bootstrap,
            complete_automated_test
        ])
        .on_window_event(|window, event| {
            if matches!(event, WindowEvent::CloseRequested { .. }) && window.label() == "main" {
                window.state::<RuntimeState>().shutdown_sidecar();
            }
        })
        .run(tauri::generate_context!())
        .expect("P00 desktop host failed to run");
}
