import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ArrowLeft, ArrowRight, ExternalLink, Globe, Loader, Plus, RotateCw, ShieldAlert, Square, X } from "lucide-react";
import {
  eventBelongsTo, type PreviewBridge, type PreviewHandle, type PreviewNavAction, type PreviewSnapshot
} from "../lib/previewBridge";
import { localPreviewRestoreStore, type PreviewRestoreStore } from "../lib/previewRestore";
import { checkPreviewUrl, previewDisplayUrl, previewOriginOf } from "../lib/previewUrl";
import { handleTabListKeyDown } from "../lib/tabNavigation";
import "./BrowserPreviewPanel.css";

/**
 * 内置人工网页预览。
 *
 * 边界（[工作台 §50]、[浏览器架构 §15]）：
 * - 页面是**原生子 WebView**，不是 iframe。React 这一层只提供一块量好尺寸的占位区，
 *   容器由桌面宿主创建、导航、隐藏与销毁；地址/标题/加载态/崩溃全部来自宿主事件。
 * - 首版不读 DOM、不截图、不点击、不填表、不提交；也不向模型暴露任何页面能力。
 * - 只有用户显式输入地址或点击「重新打开」才导航；Agent 回复里的链接仍是候选，不自动加载。
 * - 关闭标签或收起面板**不等于**撤销已经发出的网页请求；隐藏与停止加载是两件事，分开呈现。
 */

type TabStatus = "BLANK" | "LOADING" | "READY" | "STOPPED" | "CRASHED";

interface PreviewTab {
  /** 本地标签键，永不复用；它不等同于宿主实例 id（容器在首次导航时才创建）。 */
  readonly key: string;
  readonly handle: PreviewHandle | null;
  readonly input: string;
  readonly url: string;
  readonly title: string;
  readonly status: TabStatus;
  /** 失败、被拒绝或崩溃的说明；与 status 分开，因为被拒绝的跳转不影响当前页面继续显示。 */
  readonly notice: string | null;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
}

export interface BrowserPreviewPanelProps {
  /** null 表示当前不是桌面宿主：面板必须如实说明不可用，不退化成为 iframe。 */
  readonly bridge: PreviewBridge | null;
  /** 作用域：workspace + conversation。切作用域释放旧实例。 */
  readonly scope: string;
  readonly restoreStore?: PreviewRestoreStore;
  /** 面板被其他界面收起时传 false：只隐藏容器，不停止加载。 */
  readonly active?: boolean;
}

let tabSerial = 0;
function blankTab(input = ""): PreviewTab {
  tabSerial += 1;
  return { key: `preview-tab-${tabSerial}`, handle: null, input, url: "", title: "", status: "BLANK",
    notice: null, canGoBack: false, canGoForward: false };
}

/** 对话框与抽屉是 DOM 层，原生子窗口永远在它上面；弹层出现时先把容器藏起来。 */
function useOccludingOverlay(active: boolean): boolean {
  const [occluded, setOccluded] = useState(false);
  useEffect(() => {
    if (!active) { setOccluded(false); return; }
    const evaluate = () => setOccluded(document.querySelector('[role="dialog"], .dialog-backdrop') !== null);
    evaluate();
    const observer = new MutationObserver(evaluate);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [active]);
  return occluded;
}

export default function BrowserPreviewPanel({ bridge, scope, restoreStore, active = true }: BrowserPreviewPanelProps) {
  // 默认存储必须稳定：`localPreviewRestoreStore()` 每次调用都返回新对象，
  // 直接放进依赖数组会让「写恢复描述 → 重渲染 → 又当成换了存储」自激成死循环。
  const fallbackStore = useMemo(() => localPreviewRestoreStore(), []);
  const store = restoreStore ?? fallbackStore;
  const tabId = useId();
  const [tabs, setTabs] = useState<readonly PreviewTab[]>(() => [blankTab()]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [restorable, setRestorable] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState(false);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const addressRef = useRef<HTMLInputElement | null>(null);
  const bridgeRef = useRef(bridge);
  bridgeRef.current = bridge;
  /**
   * 「未触碰」标记：首次挂载与作用域切换后的空白态**不写盘**。
   * 此时写空 entries 会删掉该作用域已有的恢复描述；作用域切换瞬间还会拿旧作用域的
   * 标签把来源瞬写进新作用域（串页）。只有用户真的打开过页面、或关掉了带页面的
   * 标签，才允许持久化——后者同时覆盖「关闭全部后的显式清空」。
   */
  const untouchedRef = useRef(true);
  const current = tabs[Math.min(activeIndex, tabs.length - 1)] ?? tabs[0]!;
  const occluded = useOccludingOverlay(active);

  /** 只改当前标签；标签键变化时不动别的标签（异步回调里不能依赖 index）。 */
  const patchTab = useCallback((key: string, apply: (tab: PreviewTab) => PreviewTab) => {
    setTabs((currentTabs) => currentTabs.map((tab) => (tab.key === key ? apply(tab) : tab)));
  }, []);

  const snapshotInto = useCallback((key: string, snapshot: PreviewSnapshot) => {
    patchTab(key, (tab) => ({ ...tab, url: snapshot.url || tab.url, title: snapshot.title || tab.title,
      canGoBack: snapshot.canGoBack, canGoForward: snapshot.canGoForward }));
  }, [patchTab]);

  const refreshHistory = useCallback((handle: PreviewHandle) => {
    const target = bridgeRef.current;
    if (target === null) return;
    void target.state(handle).then((snapshot) => {
      setTabs((currentTabs) => currentTabs.map((tab) =>
        eventBelongsTo(tab.handle, { id: snapshot.id, generation: snapshot.generation, kind: "LOAD_FINISHED" })
          ? { ...tab, canGoBack: snapshot.canGoBack, canGoForward: snapshot.canGoForward } : tab));
    }).catch(() => { /* 实例已关闭：状态不再更新，也不影响别的标签 */ });
  }, []);

  // 宿主事件是唯一成功/失败事实源：超时不代表成功，迟到事件不能覆盖新页面。
  useEffect(() => {
    const target = bridge;
    if (target === null) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void target.subscribe((payload) => {
      setTabs((currentTabs) => currentTabs.map((tab) => {
        if (!eventBelongsTo(tab.handle, payload)) return tab;
        switch (payload.kind) {
          case "LOAD_STARTED":
            return { ...tab, status: "LOADING", notice: null, url: payload.url ?? tab.url };
          case "LOAD_FINISHED":
            return { ...tab, status: "READY", notice: null, url: payload.url ?? tab.url,
              title: payload.title && payload.title !== "" ? payload.title : tab.title };
          case "TITLE":
            return { ...tab, title: payload.title ?? tab.title };
          case "NAVIGATION_BLOCKED":
            // 被拒绝的只是那一次跳转：当前页面继续显示，因此不改 status。
            return { ...tab, notice: payload.reason ?? "这次跳转被地址策略拒绝。" };
          case "CRASHED":
            return { ...tab, status: "CRASHED", notice: "页面进程异常退出；可以重新加载这个地址。" };
          default:
            return tab;
        }
      }));
      if (payload.kind === "LOAD_FINISHED") refreshHistory({ id: payload.id, generation: payload.generation });
    }).then((stop) => { if (disposed) stop(); else unlisten = stop; })
      .catch(() => { /* 事件通道不可用时只少了实时更新，命令结果仍会回填 */ });
    return () => { disposed = true; unlisten?.(); };
  }, [bridge, refreshHistory]);

  // 作用域切换：释放旧作用域的原生实例。网页请求不因此撤销，工作台也不宣称已停止。
  useEffect(() => {
    untouchedRef.current = true;
    setTabs([blankTab()]);
    setActiveIndex(0);
    setRestorable(store.read(scope).entries.map((entry) => entry.origin));
    return () => {
      const target = bridgeRef.current;
      if (target !== null) void target.releaseScope(scope).catch(() => { /* 宿主已退出时无需处理 */ });
    };
  }, [scope, store]);

  // 待恢复描述：只写来源，不写 path / query / fragment / 正文。
  useEffect(() => {
    // 初始化空态与作用域切换都不写盘：写空会删掉该作用域已有的恢复描述，
    // 切换瞬间还会把旧作用域的来源写进新作用域。用户打开页面或关闭带页面的
    // 标签后 untouchedRef 置 false，此后才持久化（含关闭全部后的显式清空）。
    if (untouchedRef.current) return;
    const origins: string[] = [];
    for (const tab of tabs) {
      const origin = previewOriginOf(tab.url);
      if (origin !== null && !origins.includes(origin)) origins.push(origin);
    }
    const selected = Math.min(Math.max(activeIndex, 0), Math.max(origins.length - 1, 0));
    store.write(scope, { entries: origins.map((origin) => ({ origin })), selected });
  }, [tabs, activeIndex, scope, store]);

  const containerVisible = active && !occluded && current.handle !== null
    && (current.status === "LOADING" || current.status === "READY");

  // 容器几何：原生子窗口不会跟着 DOM 走，必须由这里量好矩形再交给宿主。
  useEffect(() => {
    const target = bridge;
    const handle = current.handle;
    if (target === null || handle === null) return;
    if (!containerVisible) {
      void target.setVisible(handle, false).catch(() => { /* 实例已关闭 */ });
      return;
    }
    let frame = 0;
    const push = () => {
      frame = 0;
      const element = surfaceRef.current;
      if (element === null) return;
      const rect = element.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      void target.setBounds(handle, { x: rect.left, y: rect.top, width: rect.width, height: rect.height })
        .catch(() => { /* 实例已关闭或窗口正在销毁 */ });
    };
    const schedule = () => { if (frame === 0) frame = requestAnimationFrame(push); };
    void target.setVisible(handle, true).then(schedule).catch(() => { /* 实例已关闭 */ });
    const observer = new ResizeObserver(schedule);
    if (surfaceRef.current !== null) observer.observe(surfaceRef.current);
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [bridge, current.handle?.id, current.handle?.generation, containerVisible]);

  async function navigate(tab: PreviewTab, raw: string) {
    const target = bridge;
    if (target === null) return;
    const checked = checkPreviewUrl(raw);
    if (!checked.ok) {
      patchTab(tab.key, (value) => ({ ...value, status: value.url === "" ? "BLANK" : value.status,
        notice: checked.message, input: raw }));
      addressRef.current?.focus();
      return;
    }
    setBusy(true);
    try {
      if (tab.handle === null) {
        const bounds = surfaceRef.current?.getBoundingClientRect();
        const snapshot = await target.open({
          scope,
          url: checked.url,
          bounds: { x: bounds?.left ?? 0, y: bounds?.top ?? 0,
            width: Math.max(bounds?.width ?? 0, 1), height: Math.max(bounds?.height ?? 0, 1) }
        });
        untouchedRef.current = false;
        patchTab(tab.key, (value) => ({ ...value, handle: { id: snapshot.id, generation: snapshot.generation },
          input: checked.url, url: snapshot.url || checked.url, status: "LOADING", notice: null }));
      } else {
        const snapshot = await target.navigate(tab.handle, checked.url);
        untouchedRef.current = false;
        patchTab(tab.key, (value) => ({ ...value, input: checked.url, url: snapshot.url || checked.url,
          status: "LOADING", notice: null }));
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      patchTab(tab.key, (value) => ({ ...value, status: value.url === "" ? "BLANK" : "READY", notice: message }));
    } finally {
      setBusy(false);
    }
  }

  function submitAddress() {
    if (busy) return;
    void navigate(current, current.input);
  }

  async function closeTab(key: string) {
    const tab = tabs.find((item) => item.key === key);
    const target = bridge;
    // 关掉带页面的标签才算「用户主动清空」：此后允许写盘（含关闭全部后删描述）。
    // 关空白标签不置位——那不该抹掉上次会话留下的恢复描述。
    if (tab?.handle != null) {
      untouchedRef.current = false;
      if (target !== null) {
        // 关闭只销毁容器，不承诺撤销页面已经发出的请求。
        await target.close(tab.handle).catch(() => { /* 已关闭 */ });
      }
    }
    setTabs((currentTabs) => {
      const next = currentTabs.filter((item) => item.key !== key);
      if (next.length > 0) return next;
      return [blankTab()];
    });
    setActiveIndex((index) => {
      const remaining = Math.max(tabs.length - 1, 1);
      return Math.min(index, remaining - 1);
    });
    if (tab !== undefined && tab.key === current.key) window.requestAnimationFrame(() => addressRef.current?.focus());
  }

  function openNewTab() {
    setTabs((currentTabs) => [...currentTabs, blankTab()]);
    setActiveIndex(tabs.length);
    window.requestAnimationFrame(() => addressRef.current?.focus());
  }

  async function navAction(action: PreviewNavAction) {
    const target = bridge;
    if (target === null || current.handle === null) return;
    if (action === "STOP") {
      patchTab(current.key, (tab) => ({ ...tab, status: tab.url === "" ? "BLANK" : "STOPPED",
        notice: "已停止加载；这不代表撤销页面已经发出的请求。" }));
    }
    try {
      const snapshot = await target.nav(current.handle, action);
      if (action !== "STOP") snapshotInto(current.key, snapshot);
    } catch (caught) {
      patchTab(current.key, (tab) => ({ ...tab, notice: caught instanceof Error ? caught.message : String(caught) }));
    }
  }

  function reload() {
    if (current.url === "") { submitAddress(); return; }
    void navigate(current, current.url);
  }

  function handleAddressKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key !== "Enter") return;
    event.preventDefault();
    submitAddress();
  }

  if (bridge === null) {
    // 浏览器预览模式没有原生容器：这是一条能力边界，不是警报。
    // 与「终端未接入」「尚未关联项目」同一档排版——说明文字直接落在纸面上，
    // 不再用一整块琥珀色警示区占住页签的大部分高度（2026-10-30 一致性检查）。
    return <section className="preview-panel" data-testid="browser-preview" aria-label="内置网页预览">
      <p className="preview-unavailable" data-testid="browser-preview-unavailable">
        内置网页预览需要桌面应用提供原生网页容器。当前运行在浏览器预览模式，因此这里不提供网页标签，
        也不会用 iframe 假装可用——外页放进 iframe 既拿不到真实地址，也无法保证与工作台隔离。
      </p>
      <p className="preview-unavailable-note">要在内置面板里查看网页，请用 Relay Agent 桌面应用打开工作台。</p>
    </section>;
  }

  return <section className="preview-panel" data-testid="browser-preview" aria-label="内置网页预览"
    data-preview-status={current.status}>
    <header className="preview-tabs" role="tablist" aria-label="网页标签" onKeyDown={handleTabListKeyDown}>
      {tabs.map((tab, index) => <div key={tab.key} className={`preview-tab${index === activeIndex ? " preview-tab--active" : ""}`}>
        <button type="button" role="tab" id={`${tabId}-tab-${tab.key}`} aria-controls={`${tabId}-panel`}
          aria-selected={index === activeIndex} tabIndex={index === activeIndex ? 0 : -1}
          className="preview-tab-label" data-testid={`preview-tab-${index}`}
          title={tab.url !== "" ? previewDisplayUrl(tab.url) : "新标签页"}
          onClick={() => setActiveIndex(index)}>
          <Globe size={13} aria-hidden="true" />
          <span className="preview-tab-text">{tab.title !== "" ? tab.title : tab.url !== "" ? previewDisplayUrl(tab.url) : "新标签页"}</span>
        </button>
        <button type="button" className="preview-tab-close" data-testid={`preview-tab-close-${index}`}
          aria-label={`关闭标签 ${tab.title !== "" ? tab.title : index + 1}`} onClick={() => void closeTab(tab.key)}>
          <X size={12} aria-hidden="true" />
        </button>
      </div>)}
      <button type="button" className="preview-tab-new" data-testid="preview-tab-new" aria-label="新建网页标签"
        title="新建网页标签" onClick={openNewTab}><Plus size={14} aria-hidden="true" /></button>
    </header>

    <div className="preview-toolbar">
      <button type="button" className="preview-icon-button" data-testid="preview-back" aria-label="后退"
        title="后退" disabled={!current.canGoBack} onClick={() => void navAction("BACK")}><ArrowLeft size={15} aria-hidden="true" /></button>
      <button type="button" className="preview-icon-button" data-testid="preview-forward" aria-label="前进"
        title="前进" disabled={!current.canGoForward} onClick={() => void navAction("FORWARD")}><ArrowRight size={15} aria-hidden="true" /></button>
      {current.status === "LOADING"
        ? <button type="button" className="preview-icon-button" data-testid="preview-stop" aria-label="停止加载"
          title="停止加载" onClick={() => void navAction("STOP")}><Square size={13} aria-hidden="true" /></button>
        : <button type="button" className="preview-icon-button" data-testid="preview-reload" aria-label="重新加载"
          title="重新加载" disabled={current.url === ""} onClick={reload}><RotateCw size={15} aria-hidden="true" /></button>}
      <label className="preview-address">
        <span className="visually-hidden">网页地址</span>
        <input ref={addressRef} type="text" inputMode="url" spellCheck={false} autoComplete="off"
          data-testid="preview-address" value={current.input} placeholder="输入完整网址，例如 https://example.com"
          onChange={(event) => patchTab(current.key, (tab) => ({ ...tab, input: event.target.value, notice: null }))}
          onKeyDown={handleAddressKeyDown} />
      </label>
      <button type="button" className="secondary-button secondary-button--compact" data-testid="preview-go"
        disabled={busy} onClick={submitAddress}>{busy ? "打开中" : "打开"}</button>
      <button type="button" className="preview-icon-button" data-testid="preview-external" aria-label="在系统浏览器打开"
        title="在系统浏览器打开" disabled={current.url === ""}
        onClick={() => { void bridge.openExternal(current.url).catch((caught: unknown) => {
          patchTab(current.key, (tab) => ({ ...tab, notice: caught instanceof Error ? caught.message : String(caught) }));
        }); }}><ExternalLink size={15} aria-hidden="true" /></button>
    </div>

    <p className="preview-status-line" role="status" data-testid="preview-status-line">
      {current.status === "LOADING" && <><Loader size={12} aria-hidden="true" /> 正在加载 {previewDisplayUrl(current.url)}</>}
      {current.status === "READY" && <span data-testid="preview-actual-url">实际地址：{previewDisplayUrl(current.url)}</span>}
      {current.status === "STOPPED" && <>已停止加载。</>}
      {current.status === "CRASHED" && <>页面进程异常退出。</>}
      {current.status === "BLANK" && <>尚未打开网页。</>}
    </p>
    {current.notice !== null && <p className="preview-notice" role="alert" data-testid="preview-notice">
      <ShieldAlert size={13} aria-hidden="true" /> {current.notice}</p>}

    <div className="preview-surface" ref={surfaceRef} id={`${tabId}-panel`} role="tabpanel"
      aria-labelledby={`${tabId}-tab-${current.key}`} data-testid="preview-surface">
      {current.status === "BLANK" && <div className="preview-start">
        <h3>在工具面板里查看网页</h3>
        <p className="helper-text">只接受完整的 http 与 https 地址。内置预览使用独立浏览环境，不共享 Chrome 或工作台的登录态；
          页面里的表单提交是真实的网站行为。</p>
        <p className="helper-text">这里不会自动加载对话里的链接，也不会启动开发服务器。本地服务没起时会显示网页自己的错误页，
          可以重新加载或在系统浏览器打开。</p>
        {restorable.length > 0 && <div className="preview-restore" data-testid="preview-restore">
          <p className="preview-restore-head">上次在这个会话打开过 {restorable.length} 个网站</p>
          <p className="helper-text">只记住了来源，没有保存路径与参数。点一下会填进地址栏，按「打开」才加载。</p>
          <div className="preview-restore-list">
            {restorable.map((origin) => <button key={origin} type="button" className="preview-restore-chip"
              data-testid={`preview-restore-${origin}`}
              onClick={() => {
                patchTab(current.key, (tab) => ({ ...tab, input: origin, notice: null }));
                window.requestAnimationFrame(() => addressRef.current?.focus());
              }}>{origin}</button>)}
          </div>
        </div>}
      </div>}
      {current.status === "STOPPED" && <div className="preview-start" data-testid="preview-stopped">
        <h3>已停止加载</h3>
        <p className="helper-text">停止只影响本次加载，不撤销页面已经发出的请求。可以重新加载，或在系统浏览器打开。</p>
        <button type="button" className="secondary-button" onClick={reload}>重新加载</button>
      </div>}
      {current.status === "CRASHED" && <div className="preview-start" data-testid="preview-crashed">
        <h3>页面进程异常退出</h3>
        <p className="helper-text">这是宿主报告的渲染进程故障，不是加载超时。可以重新加载；若反复发生，请在系统浏览器打开。</p>
        <button type="button" className="secondary-button" onClick={reload}>重新加载</button>
      </div>}
      {(current.status === "LOADING" || current.status === "READY") && <p className="preview-native-hint">
        网页由桌面应用的原生子窗口渲染，位于这块区域上方；它不接受工作台的样式与脚本注入。
      </p>}
    </div>
  </section>;
}
