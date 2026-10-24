//! 右侧工具面板的内置人工网页预览容器。
//!
//! 责任边界（对应[浏览器架构 §15] 与 [工作台 §50]）：
//! - 宿主只创建/驱动一个**子 WebView**，并提供导航事实；它不读 DOM、不截图、不点击、
//!   不向页面注入授权桥，也不向模型暴露任何内置页面能力。
//! - 页面 Cookie / LocalStorage / Service Worker 与工作台隔离：子 WebView 使用独立的
//!   WebView2 用户数据目录，并开启 InPrivate（不落盘持久化 Cookie）。
//! - 页面不得成为 Relay 自身来源：地址校验拒绝应用私有来源、本机 API 端口、开发前端
//!   来源以及非 http/https 协议；校验发生在**创建时**和**每一次导航**（含重定向）。
//!
//! 为什么必须在导航层再挡一次：Tauri 的能力解析用「窗口标签 + 当前 URL 来源」匹配
//! capability（`RuntimeAuthority::resolve_access`）。capability `main-window` 只约束窗口
//! 标签 `main`，因此**位于 main 窗口内的子 WebView 并不会因为换了 webview 标签而失去
//! 窗口级 capability**；真正的边界是 capability 里的 `remote.urls` 白名单。开发前端
//! 来源 `http://127.0.0.1:5173` 正在那份白名单里，一旦允许预览导航到它，页面就能拿到
//! 工作台的全部桌面命令。所以该来源在导航层被无条件拒绝（见 `PreviewUrlPolicy`）。
//!
//! 平台：Windows（WebView2）为交付目标。非 Windows 下创建会返回明确错误，不静默降级
//! 成外部窗口或 iframe。

use std::{
    collections::HashMap,
    net::{Ipv4Addr, Ipv6Addr},
    path::{Path, PathBuf},
    str::FromStr,
    sync::{Arc, Mutex},
};

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager, Url, Webview, WebviewUrl, webview::NewWindowResponse};

/// 宿主 → 工作台的唯一预览事件名。工作台用 `listen` 订阅，不接受页面侧事件。
pub const PREVIEW_EVENT: &str = "relay-preview-event";
/// 子 WebView 标签前缀。工作台主 webview 的标签是 `main`，二者不会相撞。
const PREVIEW_LABEL_PREFIX: &str = "relay-preview-";
/// 同时存在的预览实例上限：每个实例是一套独立 WebView2 环境，需要给资源一个上界。
const PREVIEW_INSTANCE_LIMIT: usize = 12;
/// 地址长度上限：超长地址多为粘贴事故，也避免把整段文档当 URL 传给解析器。
const PREVIEW_URL_LIMIT: usize = 4096;
/// 子 WebView 数据目录名（位于桌面数据根下，与工作台 WebView2 目录不同）。
const PREVIEW_PROFILE_DIR: &str = "preview-webview";

// ---------------------------------------------------------------------------
// URL 策略
// ---------------------------------------------------------------------------

/// 地址被拒绝的原因。每一种都对应一条可向用户解释的规则，不用一句话糊掉差异。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PreviewUrlRejection {
    Empty,
    TooLong,
    Unparsable,
    UnsupportedScheme,
    EmbeddedCredentials,
    MissingHost,
    /// 应用自身来源（`tauri.localhost` / `ipc.localhost`）：那里有桌面 IPC 与资源协议。
    ApplicationOrigin,
    /// 工作台前端开发服务器来源：它出现在 capability 的 `remote.urls` 白名单里。
    WorkbenchOrigin,
    /// 本机 Relay API 端口：bootstrap 与业务命令都在那里。
    RelayApiPort,
}

impl PreviewUrlRejection {
    /// 面向用户的中文说明。只描述规则，不暴露端口或内部实现细节以外的信息。
    pub fn message(self) -> &'static str {
        match self {
            Self::Empty => "请输入完整网址（以 http:// 或 https:// 开头）。",
            Self::TooLong => "网址过长，无法作为预览地址。",
            Self::Unparsable => "无法解析这个网址；请检查是否缺少协议或包含非法字符。",
            Self::UnsupportedScheme => "内置预览只接受 http 与 https 地址。",
            Self::EmbeddedCredentials => "网址里不能包含用户名或密码；请在页面里登录。",
            Self::MissingHost => "网址缺少主机名。",
            Self::ApplicationOrigin => "这是 Relay 应用自身的地址，不能作为预览页打开。",
            Self::WorkbenchOrigin => "这是工作台前端的开发服务器地址，不能作为预览页打开。",
            Self::RelayApiPort => "这是本机 Relay 服务的地址，不能作为预览页打开。",
        }
    }
}

/// 地址校验策略。`api_port` 是本次启动的本机 API 端口；它随启动变化，因此策略在运行时构造。
#[derive(Debug, Clone)]
pub struct PreviewUrlPolicy {
    api_port: u16,
}

/// 工作台前端开发服务器：同时是 capability `remote.urls` 的白名单来源。
/// 打包态并不使用它，但地址策略**始终**拒绝，避免「dev 挡、packaged 不挡」的漂移。
const WORKBENCH_DEV_HOST: &str = "127.0.0.1";
const WORKBENCH_DEV_PORT: u16 = 5173;

impl PreviewUrlPolicy {
    pub fn new(api_port: u16) -> Self {
        Self { api_port }
    }

    /// 校验并规范化地址。成功返回解析后的 `Url`，失败返回具体拒绝原因。
    pub fn check(&self, raw: &str) -> Result<Url, PreviewUrlRejection> {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return Err(PreviewUrlRejection::Empty);
        }
        if trimmed.len() > PREVIEW_URL_LIMIT {
            return Err(PreviewUrlRejection::TooLong);
        }
        // 用解析器判断来源，不用字符串前缀：`http://127.0.0.1.evil/` 这类前缀伪装必须落到
        // 真正的主机名比较上。`Url::parse` 还会把 `HTTP://` 之类归一成小写协议。
        let url = Url::parse(trimmed).map_err(|_| PreviewUrlRejection::Unparsable)?;
        if !matches!(url.scheme(), "http" | "https") {
            return Err(PreviewUrlRejection::UnsupportedScheme);
        }
        if !url.username().is_empty() || url.password().is_some() {
            return Err(PreviewUrlRejection::EmbeddedCredentials);
        }
        let Some(host) = url.host_str() else {
            return Err(PreviewUrlRejection::MissingHost);
        };
        // 应用私有来源：资源协议与 IPC 都在这里，任何一项都不能进预览。
        if host == "tauri.localhost" || host == "ipc.localhost" {
            return Err(PreviewUrlRejection::ApplicationOrigin);
        }
        let effective_port = url.port_or_known_default();
        if effective_port == Some(WORKBENCH_DEV_PORT)
            && matches!(host, WORKBENCH_DEV_HOST | "localhost" | "[::1]" | "0.0.0.0")
        {
            return Err(PreviewUrlRejection::WorkbenchOrigin);
        }
        // 本机 API 只监听回环地址；只比较端口会让任意公网站点的同号端口被误判，
        // 所以先确认主机确实是本机，再比端口。
        if is_loopback_host(host) && effective_port == Some(self.api_port) {
            return Err(PreviewUrlRejection::RelayApiPort);
        }
        Ok(url)
    }
}

/// 主机是否为「本机」。`Url::host_str` 对 IPv6 返回带方括号的文本（`[::1]`），
/// 因此先剥括号再交给 `std` 解析，避免自己写字符串前缀判断。
fn is_loopback_host(host: &str) -> bool {
    let bare = host.strip_prefix('[').and_then(|value| value.strip_suffix(']')).unwrap_or(host);
    if let Ok(address) = Ipv4Addr::from_str(bare) {
        return address.is_loopback() || address.is_unspecified();
    }
    if let Ok(address) = Ipv6Addr::from_str(bare) {
        return address.is_loopback() || address.is_unspecified();
    }
    let lower = bare.to_ascii_lowercase();
    lower == "localhost" || lower.ends_with(".localhost")
}

// ---------------------------------------------------------------------------
// 实例登记
// ---------------------------------------------------------------------------

/// 工作台持有的实例句柄。`id` 永不复用，`generation` 随创建递增，
/// 二者一起用来拒绝迟到请求。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewHandle {
    pub id: String,
    pub generation: u64,
}

/// 逻辑像素矩形，相对主窗口内容区左上角（与 DOM 的 `getBoundingClientRect` 同坐标系）。
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl PreviewBounds {
    fn valid(self) -> bool {
        [self.x, self.y, self.width, self.height]
            .iter()
            .all(|value| value.is_finite())
            && self.width > 0.0
            && self.height > 0.0
            && self.width <= 20_000.0
            && self.height <= 20_000.0
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewSnapshot {
    pub id: String,
    pub generation: u64,
    pub scope: String,
    pub url: String,
    pub title: String,
    pub loading: bool,
    pub can_go_back: bool,
    pub can_go_forward: bool,
}

/// 预览事件类别。工作台按类别决定更新地址栏、标题还是加载态。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum PreviewEventKind {
    /// 页面开始加载（可能是重定向后的新地址）。
    LoadStarted,
    /// 页面加载完成；`url` 是**实际**地址。
    LoadFinished,
    /// 文档标题变化。
    Title,
    /// 某次导航被策略拒绝（重定向、弹窗、子框架之外的跳转都走这里）。
    NavigationBlocked,
    /// 页面渲染进程异常退出。这是原生事实，不是工作台推断的。
    Crashed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewEventPayload {
    pub id: String,
    pub generation: u64,
    pub kind: PreviewEventKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

struct Instance {
    generation: u64,
    scope: String,
    url: String,
    title: String,
    loading: bool,
}

#[derive(Default)]
struct RegistryInner {
    instances: HashMap<String, Instance>,
    serial: u64,
    generation: u64,
}

/// 预览实例登记表。它是宿主侧唯一的事实来源：工作台只持有句柄，不自己宣称导航成功。
#[derive(Default)]
pub struct PreviewRegistry {
    inner: Mutex<RegistryInner>,
}

impl PreviewRegistry {
    fn reserve(&self, scope: &str, url: &str) -> Result<(PreviewHandle, u64), String> {
        let mut inner = self.inner.lock().expect("preview registry mutex poisoned");
        if inner.instances.len() >= PREVIEW_INSTANCE_LIMIT {
            return Err(format!("同时最多打开 {PREVIEW_INSTANCE_LIMIT} 个预览标签；请先关闭一些标签。"));
        }
        inner.serial += 1;
        inner.generation += 1;
        let id = format!("{PREVIEW_LABEL_PREFIX}{}", inner.serial);
        let generation = inner.generation;
        inner.instances.insert(
            id.clone(),
            Instance {
                generation,
                scope: scope.to_owned(),
                url: url.to_owned(),
                title: String::new(),
                loading: true,
            },
        );
        Ok((PreviewHandle { id, generation }, generation))
    }

    /// 撤销一次尚未成功创建的登记，避免失败的创建占住标签名额。
    fn discard(&self, id: &str) {
        let mut inner = self.inner.lock().expect("preview registry mutex poisoned");
        inner.instances.remove(id);
    }

    /// 校验句柄。句柄身份不符（过期 generation / 已关闭 / 从未创建）一律拒绝，
    /// 迟到请求不会作用到新实例上。
    fn verify(&self, handle: &PreviewHandle) -> Result<(), String> {
        let inner = self.inner.lock().expect("preview registry mutex poisoned");
        match inner.instances.get(&handle.id) {
            Some(instance) if instance.generation == handle.generation => Ok(()),
            Some(_) => Err("预览实例已被替换，请重新打开网页标签。".into()),
            None => Err("预览实例已关闭。".into()),
        }
    }

    fn update<F: FnOnce(&mut Instance)>(&self, id: &str, generation: u64, apply: F) {
        let mut inner = self.inner.lock().expect("preview registry mutex poisoned");
        if let Some(instance) = inner.instances.get_mut(id) {
            if instance.generation == generation {
                apply(instance);
            }
        }
    }

    fn snapshot(&self, handle: &PreviewHandle) -> Result<PreviewSnapshot, String> {
        let inner = self.inner.lock().expect("preview registry mutex poisoned");
        let instance = inner
            .instances
            .get(&handle.id)
            .filter(|instance| instance.generation == handle.generation)
            .ok_or_else(|| "预览实例已关闭。".to_owned())?;
        Ok(PreviewSnapshot {
            id: handle.id.clone(),
            generation: handle.generation,
            scope: instance.scope.clone(),
            url: instance.url.clone(),
            title: instance.title.clone(),
            loading: instance.loading,
            // 前进/后退可用性只有原生侧知道，由 `preview_state` 补齐。
            can_go_back: false,
            can_go_forward: false,
        })
    }

    fn take(&self, handle: &PreviewHandle) -> Result<(), String> {
        let mut inner = self.inner.lock().expect("preview registry mutex poisoned");
        match inner.instances.get(&handle.id) {
            Some(instance) if instance.generation == handle.generation => {
                inner.instances.remove(&handle.id);
                Ok(())
            }
            // 幂等关闭：已经关掉就当作成功，重复关闭不报错。
            None => Ok(()),
            Some(_) => Err("预览实例已被替换，请重新打开网页标签。".into()),
        }
    }

    #[cfg(test)]
    fn scope_ids(&self, scope: &str) -> Vec<String> {
        let inner = self.inner.lock().expect("preview registry mutex poisoned");
        inner
            .instances
            .iter()
            .filter(|(_, instance)| instance.scope == scope)
            .map(|(id, _)| id.clone())
            .collect()
    }

    /// 释放一个作用域：移除登记并返回被移除的实例标签，调用方据此关闭原生容器。
    fn release_scope(&self, scope: &str) -> Vec<String> {
        let mut inner = self.inner.lock().expect("preview registry mutex poisoned");
        let ids: Vec<String> = inner
            .instances
            .iter()
            .filter(|(_, instance)| instance.scope == scope)
            .map(|(id, _)| id.clone())
            .collect();
        for id in &ids {
            inner.instances.remove(id);
        }
        ids
    }

    /// 当前实例数量：仅供诊断与测试断言，不暴露给页面。
    pub fn len(&self) -> usize {
        self.inner.lock().expect("preview registry mutex poisoned").instances.len()
    }
}

// ---------------------------------------------------------------------------
// 宿主操作
// ---------------------------------------------------------------------------

fn preview_profile_dir(data_root: &Path) -> PathBuf {
    data_root.join(PREVIEW_PROFILE_DIR)
}

fn emit(app: &tauri::AppHandle, payload: &PreviewEventPayload) {
    // 只发给可信工作台主 webview：预览页自己收不到控制事件。
    let _ = app.emit_to(tauri::EventTarget::webview("main"), PREVIEW_EVENT, payload.clone());
}

/// 解析并校验地址；把拒绝原因转成可展示的字符串。
pub fn resolve_preview_url(policy: &PreviewUrlPolicy, raw: &str) -> Result<Url, String> {
    policy.check(raw).map_err(|reason| reason.message().to_owned())
}

#[cfg(windows)]
fn navigation_state(webview: &Webview) -> (bool, bool) {
    let state = Arc::new(Mutex::new((false, false)));
    let slot = Arc::clone(&state);
    // 只能在命令线程调用：`with_webview` 会投递到主线程并同步等待。
    let _ = webview.with_webview(move |platform| {
        let Ok(core) = (unsafe { platform.controller().CoreWebView2() }) else { return };
        let mut back = windows::core::BOOL(0);
        let mut forward = windows::core::BOOL(0);
        let back_ok = unsafe { core.CanGoBack(&mut back) }.is_ok() && back.as_bool();
        let forward_ok = unsafe { core.CanGoForward(&mut forward) }.is_ok() && forward.as_bool();
        *slot.lock().expect("navigation state mutex poisoned") = (back_ok, forward_ok);
    });
    *state.lock().expect("navigation state mutex poisoned")
}

#[cfg(not(windows))]
fn navigation_state(_webview: &Webview) -> (bool, bool) {
    (false, false)
}

/// 创建子 WebView 并导航到首个地址。
///
/// 失败时撤销登记：调用方拿不到句柄，也就不会出现「面板上有个标签但容器没建起来」。
pub fn open_preview(
    app: &tauri::AppHandle,
    window: &tauri::Window,
    registry: &Arc<PreviewRegistry>,
    policy: &PreviewUrlPolicy,
    data_root: &Path,
    scope: &str,
    raw_url: &str,
    bounds: PreviewBounds,
) -> Result<PreviewHandle, String> {
    if scope.trim().is_empty() {
        return Err("缺少预览作用域；不能把网页挂到未标识的会话上。".into());
    }
    if !bounds.valid() {
        return Err("预览区域尺寸无效，无法放置内置网页。".into());
    }
    let url = resolve_preview_url(policy, raw_url)?;
    let profile = preview_profile_dir(data_root);
    std::fs::create_dir_all(&profile)
        .map_err(|_| "无法创建内置网页的独立数据目录。".to_owned())?;

    let (handle, generation) = registry.reserve(scope, url.as_str())?;
    let label = handle.id.clone();

    let navigation_policy = policy.clone();
    let navigation_label = label.clone();
    let navigation_app = app.clone();
    let load_registry = Arc::clone(registry);
    let load_label = label.clone();
    let load_app = app.clone();
    let load_scope = scope.to_owned();
    let title_registry = Arc::clone(registry);
    let title_label = label.clone();
    let title_app = app.clone();

    let builder = tauri::webview::WebviewBuilder::new(label.clone(), WebviewUrl::External(url.clone()))
        // 独立 WebView2 用户数据目录：Cookie / LocalStorage / Service Worker 与工作台分开。
        .data_directory(profile)
        // 再叠一层 InPrivate：预览页的登录态不落盘，退出即失效，因此不需要「保留周期」设置。
        .incognito(true)
        .focused(false)
        .zoom_hotkeys_enabled(true)
        // 每一次导航（含服务端重定向、脚本跳转）都要重新过策略；不能只校验首地址。
        .on_navigation(move |target| {
            let rejection = navigation_policy.check(target.as_str()).err();
            if let Some(reason) = rejection {
                emit(&navigation_app, &PreviewEventPayload {
                    id: navigation_label.clone(),
                    generation,
                    kind: PreviewEventKind::NavigationBlocked,
                    url: Some(target.as_str().to_owned()),
                    title: None,
                    reason: Some(reason.message().to_owned()),
                });
            }
            rejection.is_none()
        })
        // 首版阻止自动弹窗：新窗口请求一律拒绝，需要时由用户显式在外部浏览器打开。
        .on_new_window(|_, _| NewWindowResponse::Deny)
        // 首版不静默保存下载。
        .on_download(|_, _| false)
        .on_page_load(move |webview, payload| {
            let started = matches!(payload.event(), tauri::webview::PageLoadEvent::Started);
            // 实际地址以原生侧为准：重定向之后 `webview.url()` 才是用户看到的那个。
            let actual = webview
                .url()
                .map(|value| value.as_str().to_owned())
                .unwrap_or_else(|_| payload.url().as_str().to_owned());
            load_registry.update(&load_label, generation, |instance| {
                instance.url = actual.clone();
                instance.loading = started;
            });
            let handle = PreviewHandle { id: load_label.clone(), generation };
            if started {
                emit(&load_app, &PreviewEventPayload {
                    id: load_label.clone(),
                    generation,
                    kind: PreviewEventKind::LoadStarted,
                    url: Some(actual),
                    title: None,
                    reason: None,
                });
                return;
            }
            // 注意：这里**不能**查询前进/后退可用性。`with_webview` 会把任务投回主线程并
            // 同步等待，而本回调本身就在主线程上执行，调用它会自锁。可用性改由工作台在
            // 收到 LoadFinished 后调用 `preview_state` 补取（见 `snapshot_with_history`）。
            let snapshot = load_registry.snapshot(&handle).unwrap_or(PreviewSnapshot {
                id: load_label.clone(),
                generation,
                scope: load_scope.clone(),
                url: actual,
                title: String::new(),
                loading: false,
                can_go_back: false,
                can_go_forward: false,
            });
            emit(&load_app, &PreviewEventPayload {
                id: load_label.clone(),
                generation,
                kind: PreviewEventKind::LoadFinished,
                url: Some(snapshot.url),
                title: Some(snapshot.title),
                reason: None,
            });
        })
        .on_document_title_changed(move |_webview, title| {
            title_registry.update(&title_label, generation, |instance| instance.title = title.clone());
            emit(&title_app, &PreviewEventPayload {
                id: title_label.clone(),
                generation,
                kind: PreviewEventKind::Title,
                url: None,
                title: Some(title),
                reason: None,
            });
        });

    match window.add_child(
        builder,
        tauri::LogicalPosition::new(bounds.x, bounds.y),
        tauri::LogicalSize::new(bounds.width, bounds.height),
    ) {
        Ok(created) => {
            #[cfg(windows)]
            install_crash_watch(app, &created, registry, &label, generation);
            Ok(handle)
        }
        Err(_) => {
            registry.discard(&label);
            Err("无法在当前窗口内创建内置网页容器（原生子 WebView 不可用）。".into())
        }
    }
}

/// 订阅渲染进程异常退出。WebView2 不会让加载事件报错，崩溃必须单独订阅，
/// 否则工作台只能看到「一直加载中」——那等于把崩溃说成慢。
#[cfg(windows)]
fn install_crash_watch(
    app: &tauri::AppHandle,
    webview: &Webview,
    registry: &Arc<PreviewRegistry>,
    label: &str,
    generation: u64,
) {
    use webview2_com::{Microsoft::Web::WebView2::Win32::COREWEBVIEW2_PROCESS_FAILED_KIND,
        ProcessFailedEventHandler};

    let app = app.clone();
    let registry = Arc::clone(registry);
    let label = label.to_owned();
    let _ = webview.with_webview(move |platform| {
        let Ok(core) = (unsafe { platform.controller().CoreWebView2() }) else { return };
        let handler_app = app.clone();
        let handler_registry = Arc::clone(&registry);
        let handler_label = label.clone();
        let handler = ProcessFailedEventHandler::create(Box::new(move |_, args| {
            let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
            if let Some(args) = args {
                let _ = unsafe { args.ProcessFailedKind(&mut kind) };
            }
            handler_registry.update(&handler_label, generation, |instance| instance.loading = false);
            emit(&handler_app, &PreviewEventPayload {
                id: handler_label.clone(),
                generation,
                kind: PreviewEventKind::Crashed,
                url: None,
                title: None,
                reason: Some(format!("{kind:?}")),
            });
            Ok(())
        }));
        let mut token = 0_i64;
        let _ = unsafe { core.add_ProcessFailed(&handler, &mut token) };
    });
}

#[cfg(windows)]
fn with_core<F>(webview: &Webview, apply: F) -> Result<(), String>
where
    F: FnOnce(&webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2) -> windows::core::Result<()>
        + Send + 'static,
{
    let outcome = Arc::new(Mutex::new(None::<bool>));
    let slot = Arc::clone(&outcome);
    webview
        .with_webview(move |platform| {
            let applied = (|| -> windows::core::Result<bool> {
                let core = unsafe { platform.controller().CoreWebView2() }?;
                apply(&core)?;
                Ok(true)
            })();
            *slot.lock().expect("preview navigation mutex poisoned") =
                Some(applied.unwrap_or(false));
        })
        .map_err(|_| "无法访问内置网页容器。".to_owned())?;
    let applied = outcome.lock().expect("preview navigation mutex poisoned").take();
    match applied {
        Some(true) => Ok(()),
        _ => Err("内置网页容器拒绝了这个操作。".to_owned()),
    }
}

/// 前进 / 后退 / 停止。三者都只有原生侧能表达，工作台不自己维护历史栈。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum PreviewNavAction {
    Back,
    Forward,
    Stop,
}

pub fn navigate_history(webview: &Webview, action: PreviewNavAction) -> Result<(), String> {
    #[cfg(windows)]
    {
        return with_core(webview, move |core| match action {
            PreviewNavAction::Back => unsafe { core.GoBack() },
            PreviewNavAction::Forward => unsafe { core.GoForward() },
            PreviewNavAction::Stop => unsafe { core.Stop() },
        });
    }
    #[cfg(not(windows))]
    {
        let _ = (webview, action);
        Err("内置网页容器只在 Windows 桌面宿主可用。".into())
    }
}

/// 计算实例的完整状态（含前进/后退可用性）。
pub fn snapshot_with_history(webview: &Webview, registry: &PreviewRegistry, handle: &PreviewHandle)
    -> Result<PreviewSnapshot, String> {
    let mut snapshot = registry.snapshot(handle)?;
    let (back, forward) = navigation_state(webview);
    snapshot.can_go_back = back;
    snapshot.can_go_forward = forward;
    Ok(snapshot)
}

// ---------------------------------------------------------------------------
// Tauri 命令面（最小契约）
// ---------------------------------------------------------------------------

/// 预览宿主状态：登记表、地址策略与数据根。由 `lib.rs` 在启动后托管。
pub struct PreviewHost {
    registry: Arc<PreviewRegistry>,
    policy: PreviewUrlPolicy,
    data_root: PathBuf,
}

impl PreviewHost {
    pub fn new(api_port: u16, data_root: PathBuf) -> Self {
        Self { registry: Arc::new(PreviewRegistry::default()), policy: PreviewUrlPolicy::new(api_port), data_root }
    }

    /// 供诊断读取当前实例数；当前没有调用方，保留为可观测入口。
    #[allow(dead_code)]
    pub fn instance_count(&self) -> usize {
        self.registry.len()
    }
}

/// 只有可信工作台主 webview 能驱动预览容器。
///
/// 说明：Tauri 的 capability 只按「窗口标签 + URL 来源」匹配，因此位于 main 窗口内的
/// 子 webview 在**来源匹配**时仍可能命中窗口级 capability；这里的标签检查是第二道闸，
/// 真正的来源闸是 `PreviewUrlPolicy`（拒绝工作台前端来源与 API 端口）。
fn trusted_caller(webview: &Webview) -> Result<(), String> {
    if webview.label() != "main" || webview.window().label() != "main" {
        return Err("内置网页预览只接受工作台主界面的调用。".into());
    }
    Ok(())
}

fn child(app: &tauri::AppHandle, handle: &PreviewHandle) -> Result<Webview, String> {
    app.get_webview(&handle.id).ok_or_else(|| "预览实例已关闭。".to_owned())
}

#[tauri::command]
pub fn preview_open(
    webview: Webview,
    app: tauri::AppHandle,
    host: tauri::State<'_, PreviewHost>,
    scope: String,
    url: String,
    bounds: PreviewBounds,
) -> Result<PreviewSnapshot, String> {
    trusted_caller(&webview)?;
    let window = webview.window();
    let handle = open_preview(&app, &window, &host.registry, &host.policy, &host.data_root,
        &scope, &url, bounds)?;
    host.registry.snapshot(&handle)
}

#[tauri::command]
pub fn preview_navigate(
    webview: Webview,
    app: tauri::AppHandle,
    host: tauri::State<'_, PreviewHost>,
    handle: PreviewHandle,
    url: String,
) -> Result<PreviewSnapshot, String> {
    trusted_caller(&webview)?;
    host.registry.verify(&handle)?;
    let target = resolve_preview_url(&host.policy, &url)?;
    let instance = child(&app, &handle)?;
    instance.navigate(target.clone()).map_err(|_| "内置网页容器拒绝了这次导航。".to_owned())?;
    host.registry.update(&handle.id, handle.generation, |state| {
        state.url = target.as_str().to_owned();
        state.loading = true;
    });
    host.registry.snapshot(&handle)
}

#[tauri::command]
pub fn preview_set_bounds(
    webview: Webview,
    app: tauri::AppHandle,
    host: tauri::State<'_, PreviewHost>,
    handle: PreviewHandle,
    bounds: PreviewBounds,
) -> Result<(), String> {
    trusted_caller(&webview)?;
    host.registry.verify(&handle)?;
    if !bounds.valid() {
        return Err("预览区域尺寸无效。".into());
    }
    let instance = child(&app, &handle)?;
    instance.set_position(tauri::LogicalPosition::new(bounds.x, bounds.y))
        .map_err(|_| "无法放置内置网页容器。".to_owned())?;
    instance.set_size(tauri::LogicalSize::new(bounds.width, bounds.height))
        .map_err(|_| "无法调整内置网页容器尺寸。".to_owned())
}

#[tauri::command]
pub fn preview_set_visible(
    webview: Webview,
    app: tauri::AppHandle,
    host: tauri::State<'_, PreviewHost>,
    handle: PreviewHandle,
    visible: bool,
) -> Result<(), String> {
    trusted_caller(&webview)?;
    host.registry.verify(&handle)?;
    let instance = child(&app, &handle)?;
    // 隐藏只是把容器从视野里拿开：它不等于停止加载，也不等于撤销已发出的请求。
    if visible { instance.show() } else { instance.hide() }
        .map_err(|_| "无法切换内置网页容器的可见状态。".to_owned())
}

#[tauri::command]
pub fn preview_nav(
    webview: Webview,
    app: tauri::AppHandle,
    host: tauri::State<'_, PreviewHost>,
    handle: PreviewHandle,
    action: PreviewNavAction,
) -> Result<PreviewSnapshot, String> {
    trusted_caller(&webview)?;
    host.registry.verify(&handle)?;
    let instance = child(&app, &handle)?;
    navigate_history(&instance, action)?;
    snapshot_with_history(&instance, &host.registry, &handle)
}

#[tauri::command]
pub fn preview_state(
    webview: Webview,
    app: tauri::AppHandle,
    host: tauri::State<'_, PreviewHost>,
    handle: PreviewHandle,
) -> Result<PreviewSnapshot, String> {
    trusted_caller(&webview)?;
    host.registry.verify(&handle)?;
    let instance = child(&app, &handle)?;
    snapshot_with_history(&instance, &host.registry, &handle)
}

#[tauri::command]
pub fn preview_close(
    webview: Webview,
    app: tauri::AppHandle,
    host: tauri::State<'_, PreviewHost>,
    handle: PreviewHandle,
) -> Result<(), String> {
    trusted_caller(&webview)?;
    // 幂等：已经关闭（或从未创建成功）都当作成功，重复关闭不制造错误弹层。
    if host.registry.verify(&handle).is_err() {
        return Ok(());
    }
    if let Some(instance) = app.get_webview(&handle.id) {
        let _ = instance.close();
    }
    host.registry.take(&handle)
}

/// 切换会话/任务时释放该作用域的全部实例。返回实际关闭的数量，供工作台如实显示。
#[tauri::command]
pub fn preview_release_scope(
    webview: Webview,
    app: tauri::AppHandle,
    host: tauri::State<'_, PreviewHost>,
    scope: String,
) -> Result<usize, String> {
    trusted_caller(&webview)?;
    // 先摘登记再关容器：摘掉之后迟到的命令会被身份检查拒绝，不会打到正在销毁的实例上。
    let ids = host.registry.release_scope(&scope);
    for id in &ids {
        if let Some(instance) = app.get_webview(id) {
            let _ = instance.close();
        }
    }
    Ok(ids.len())
}

/// 在系统默认浏览器打开。走 Windows Shell 的 URL 打开入口，不拼命令行字符串。
#[tauri::command]
pub fn preview_open_external(
    webview: Webview,
    host: tauri::State<'_, PreviewHost>,
    url: String,
) -> Result<(), String> {
    trusted_caller(&webview)?;
    let target = resolve_preview_url(&host.policy, &url)?;
    open_in_system_browser(target.as_str())
}

#[cfg(windows)]
fn open_in_system_browser(address: &str) -> Result<(), String> {
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    use windows::core::{HSTRING, PCWSTR};

    let operation = HSTRING::from("open");
    let target = HSTRING::from(address);
    // 只传 URL 本身，不经过 cmd.exe；返回值大于 32 才算成功（Win32 历史约定）。
    let result = unsafe {
        ShellExecuteW(None, &operation, &target, PCWSTR::null(), PCWSTR::null(), SW_SHOWNORMAL)
    };
    if result.0 as usize > 32 {
        Ok(())
    } else {
        Err("无法在系统浏览器中打开这个地址。".to_owned())
    }
}

#[cfg(not(windows))]
fn open_in_system_browser(_address: &str) -> Result<(), String> {
    Err("内置网页容器只在 Windows 桌面宿主可用。".into())
}

// ---------------------------------------------------------------------------
// 单元测试：策略与身份不变量（不需要窗口）
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    const API_PORT: u16 = 41234;

    fn policy() -> PreviewUrlPolicy {
        PreviewUrlPolicy::new(API_PORT)
    }

    #[test]
    fn accepts_ordinary_public_and_local_addresses() {
        for address in [
            "https://example.com/a/b?c=d#e",
            "http://example.com",
            "https://例子.中国/路径",
            // 本机自建服务是明确允许的场景，只要不是 Relay 自己的端口。
            "http://127.0.0.1:3000/",
            "http://localhost:8080/dashboard",
            "http://[::1]:9000/",
            "  https://example.com  ",
        ] {
            assert!(policy().check(address).is_ok(), "must accept: {address}");
        }
    }

    #[test]
    fn rejects_non_http_schemes_and_application_private_protocols() {
        for address in [
            "file:///C:/Windows/System32/drivers/etc/hosts",
            "javascript:alert(1)",
            "data:text/html,<script>alert(1)</script>",
            "about:blank",
            "tauri://localhost/index.html",
            "http://tauri.localhost/",
            "http://ipc.localhost/ipc",
            "ftp://example.com/",
        ] {
            assert!(policy().check(address).is_err(), "must reject: {address}");
        }
    }

    #[test]
    fn rejects_workbench_dev_origin_that_capability_allows() {
        // 这条规则是隔离的承重点：capability 的 remote.urls 白名单里有它。
        for address in [
            "http://127.0.0.1:5173/",
            "http://127.0.0.1:5173/agent?x=1",
            "http://localhost:5173/",
            "HTTP://127.0.0.1:5173/",
        ] {
            assert_eq!(
                policy().check(address),
                Err(PreviewUrlRejection::WorkbenchOrigin),
                "must reject workbench origin: {address}"
            );
        }
    }

    #[test]
    fn rejects_the_running_api_port_on_loopback_only() {
        for address in [
            "http://127.0.0.1:41234/",
            "http://localhost:41234/bootstrap",
            "http://[::1]:41234/",
        ] {
            assert_eq!(policy().check(address), Err(PreviewUrlRejection::RelayApiPort), "must reject: {address}");
        }
        // 公网的同号端口不是 Relay API，不能被端口相等误伤。
        assert!(policy().check("https://example.com:41234/").is_ok());
        // 前缀伪装的域名必须落到真正的主机比较上。
        assert!(policy().check("http://127.0.0.1.evil:41234/").is_ok());
    }

    #[test]
    fn rejects_embedded_credentials_and_degenerate_addresses() {
        assert_eq!(policy().check(""), Err(PreviewUrlRejection::Empty));
        assert_eq!(policy().check("   "), Err(PreviewUrlRejection::Empty));
        assert_eq!(policy().check("example.com"), Err(PreviewUrlRejection::Unparsable));
        assert_eq!(policy().check("http://user:pass@example.com/"), Err(PreviewUrlRejection::EmbeddedCredentials));
        assert_eq!(policy().check("http://user@example.com/"), Err(PreviewUrlRejection::EmbeddedCredentials));
        assert_eq!(policy().check(&format!("https://example.com/{}", "a".repeat(PREVIEW_URL_LIMIT))),
            Err(PreviewUrlRejection::TooLong));
    }

    #[test]
    fn handle_identity_rejects_stale_generation_and_unknown_ids() {
        let registry = PreviewRegistry::default();
        let (first, _) = registry.reserve("ws:conv", "https://example.com/").expect("reserve");
        assert!(registry.verify(&first).is_ok());

        // 同 id 不同代次：模拟迟到请求打到已被替换的实例。
        let stale = PreviewHandle { id: first.id.clone(), generation: first.generation + 1 };
        assert!(registry.verify(&stale).is_err());

        // 关闭幂等：重复关闭成功，之后任何命令都被拒绝。
        assert!(registry.take(&first).is_ok());
        assert!(registry.take(&first).is_ok());
        assert!(registry.verify(&first).is_err());
    }

    #[test]
    fn ids_are_never_reused_so_late_requests_cannot_hit_a_new_instance() {
        let registry = PreviewRegistry::default();
        let (first, _) = registry.reserve("ws:a", "https://example.com/").expect("reserve");
        registry.take(&first).expect("close");
        let (second, _) = registry.reserve("ws:a", "https://example.org/").expect("reserve");
        assert_ne!(first.id, second.id);
        // 旧句柄既不是新 id，也不会因为「id 相同」而误命中。
        assert!(registry.verify(&first).is_err());
        assert!(registry.verify(&second).is_ok());
    }

    #[test]
    fn instance_limit_and_scope_release_are_bounded() {
        let registry = PreviewRegistry::default();
        let mut handles = Vec::new();
        for index in 0..PREVIEW_INSTANCE_LIMIT {
            let (handle, _) = registry
                .reserve(&format!("ws:{}", index % 2), "https://example.com/")
                .expect("reserve within limit");
            handles.push(handle);
        }
        assert!(registry.reserve("ws:extra", "https://example.com/").is_err(), "limit must hold");
        let scope_a = registry.scope_ids("ws:0");
        assert_eq!(scope_a.len(), PREVIEW_INSTANCE_LIMIT / 2);
        assert_eq!(registry.len(), PREVIEW_INSTANCE_LIMIT);
    }

    #[test]
    fn bounds_must_be_finite_and_positive() {
        assert!(PreviewBounds { x: 0.0, y: 0.0, width: 320.0, height: 480.0 }.valid());
        assert!(!PreviewBounds { x: 0.0, y: 0.0, width: 0.0, height: 480.0 }.valid());
        assert!(!PreviewBounds { x: f64::NAN, y: 0.0, width: 320.0, height: 480.0 }.valid());
        assert!(!PreviewBounds { x: 0.0, y: 0.0, width: 40_000.0, height: 480.0 }.valid());
    }
}
