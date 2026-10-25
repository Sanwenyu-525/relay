import { useEffect, useRef, useState } from "react";
import { Outlet, useBlocker, useLocation } from "react-router-dom";
import { isTauri, invoke } from "@tauri-apps/api/core";
import type { RelayApiConnection } from "./api/relayClient";
import { RelayApiClient } from "./api/relayClient";
import AppDialog from "./components/AppDialog";
import AppShell from "./components/AppShell";
import DesktopTitleBar from "./components/DesktopTitleBar";
import { currentDraftGuard, hasUnsavedDraft } from "./lib/draftGuard";
import { activateRelayConnection, useFixtureData, useRelayConnection } from "./lib/relayConnection";

function isConnection(value: unknown): value is RelayApiConnection {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return typeof row.baseUrl === "string" && row.baseUrl.length > 0
    && typeof row.workspaceId === "string" && row.workspaceId.length > 0
    && typeof row.bearerToken === "string" && row.bearerToken.length > 0;
}

export default function App() {
  const location = useLocation();
  const connection = useRelayConnection();
  /**
   * 页面级草稿守卫仍按各页登记的事实工作：任务创建、蓝图、产物编辑等没有本机草稿存储，
   * 离开时照旧询问。协作页的讨论草稿已按会话留在本机（见 CollaborationView 的守卫），
   * 因此换工作区时它不再把「有草稿」报成未保存（2026-10-19 用户指令）。
   */
  const blocker = useBlocker(() => hasUnsavedDraft());
  const [desktopStatus, setDesktopStatus] = useState<"idle" | "connecting" | "error">(() => isTauri() ? "connecting" : "idle");
  const [closeDialogOpen, setCloseDialogOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const allowClose = useRef(false);

  useEffect(() => {
    window.scrollTo(0, 0);
    const main = document.getElementById("main-content");
    if (main) main.scrollTop = 0;
  }, [location.pathname, location.search]);

  useEffect(() => {
    if (!isTauri()) return;
    document.documentElement.classList.add("app-desktop");
    return () => document.documentElement.classList.remove("app-desktop");
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    setDesktopStatus("connecting");
    void (async () => {
      try {
        const input = await invoke<unknown>("desktop_bootstrap");
        if (!isConnection(input)) throw new Error("invalid desktop bootstrap");
        await new RelayApiClient(input).getHealthReady();
        if (!active) return;
        activateRelayConnection(input);
        setDesktopStatus("idle");
      } catch {
        if (!active) return;
        useFixtureData();
        setDesktopStatus("error");
      }
    })();
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!hasUnsavedDraft()) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    let unlisten: (() => void) | undefined;
    void import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
      const off = await getCurrentWindow().onCloseRequested((event) => {
        if (!allowClose.current && hasUnsavedDraft()) {
          event.preventDefault();
          setCloseDialogOpen(true);
        }
      });
      if (active) unlisten = off;
      else off();
    });
    return () => { active = false; unlisten?.(); };
  }, []);

  function discardAndContinue(): void {
    if (currentDraftGuard()?.pendingCommandId?.()) return;
    currentDraftGuard()?.discard();
    blocker.proceed?.();
  }

  /**
   * 「保留并继续编辑」的编辑焦点恢复状态机：点击时先登记意图，再由弹层关闭触发
   * blocked → unblocked 迁移，在迁移效果里执行恢复。AppDialog 的关闭清理（默认回焦到
   * 「打开导航」按钮）与这里的迁移效果同处一轮 passive flush，React 保证先执行全部
   * 清理再执行新建效果，因此恢复发生在默认回焦之后、不会被覆盖——不用定时器猜时序。
   * 组件卸载或未点击「保留并继续编辑」（Escape、丢弃）时意图为空，默认回焦保持原行为。
   */
  const keepEditingFocus = useRef(false);
  const wasBlocked = useRef(false);
  useEffect(() => {
    const blocked = blocker.state === "blocked";
    if (wasBlocked.current && !blocked && keepEditingFocus.current) {
      keepEditingFocus.current = false;
      // 命令结果待核对时没有可续写的编辑器，「保留并继续编辑」只是留在当前工作区，
      // 维持弹层默认回焦，不把焦点塞进禁用的输入区。
      if (currentDraftGuard()?.pendingCommandId?.() == null) currentDraftGuard()?.restoreFocus?.();
    }
    wasBlocked.current = blocked;
  }, [blocker.state]);

  async function discardAndClose(): Promise<void> {
    if (currentDraftGuard()?.pendingCommandId?.()) return;
    currentDraftGuard()?.discard();
    allowClose.current = true;
    setCloseDialogOpen(false);
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().destroy();
  }

  /**
   * 待核对未收口仍要关窗：命令已经发出，关窗不取消它；用户已从弹层知晓
   * 「重新打开后不再提醒、生效结果去列表确认」，这是显式的人工决定，
   * 不属于应用侧盲重试。与丢弃关闭不同，这里不清任何守卫状态。
   */
  async function closeWithPending(): Promise<void> {
    allowClose.current = true;
    setCloseDialogOpen(false);
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().destroy();
  }

  if (desktopStatus !== "idle") {
    return <div className="desktop-window"><DesktopTitleBar available={false} onSearch={() => setCommandOpen(true)} /><main className="page-state" data-testid={desktopStatus === "error" ? "desktop-service-unavailable" : "desktop-service-connecting"} role="status">
      {desktopStatus === "error" ? <>
        <h1>本机服务不可用</h1>
        <p>无法连接桌面工作空间。请关闭并重新启动 Relay Agent；如果问题持续，请检查 PostgreSQL 和桌面配置。</p>
      </> : <>
        <h1>正在连接本机服务</h1>
        <p>正在核对桌面工作空间与 API 就绪状态。</p>
      </>}
    </main></div>;
  }

  /**
   * 创建表单在连接切换时保持挂载：待核对命令必须留在原 API/Workspace 的作用域里，
   * 不能在重连后把局部状态丢掉（尚无本机草稿存储可恢复它）。
   */
  const preserveDraftCreation = (location.pathname === "/tasks" && new URLSearchParams(location.search).get("view") === "create")
    || (location.pathname === "/scheduled-tasks" && new URLSearchParams(location.search).get("view") === "create");
  const pendingCommandId = currentDraftGuard()?.pendingCommandId?.() ?? null;
  const pendingRecovers = pendingCommandId !== null && (currentDraftGuard()?.pendingRecoversAfterLeave?.() ?? false);
  return <div className="desktop-window">
    {/* 跳转链接由窗口框架持有并排在标题栏之前：它 position:fixed，视觉位置不变，
        但必须是第一个 Tab 站位，否则键盘用户先落在标题栏按钮上（WCAG 2.4.1）。 */}
    <a className="skip-link" href="#main-content" onClick={(event) => { event.preventDefault(); document.getElementById("main-content")?.focus(); }}>跳到主要内容</a>
    <DesktopTitleBar available onSearch={() => setCommandOpen(true)} />
    <AppShell desktopStatus={desktopStatus} commandOpen={commandOpen} onCommandOpen={() => setCommandOpen(true)} onCommandClose={() => setCommandOpen(false)}>
      <div key={`${preserveDraftCreation ? "draft-creation" : connection.epoch}:${location.pathname}${location.search}`}><Outlet /></div>
    </AppShell>
    <AppDialog open={blocker.state === "blocked"} title={pendingCommandId ? "命令结果待核对" : "保留未保存的修改"}
      subtitle={pendingCommandId ? "离开不会取消这条命令" : undefined}
      onClose={() => blocker.reset?.()}>
      {pendingCommandId
        ? <>
          <p>{pendingRecovers
            ? "这条命令已发给服务端，结果还没有确认。留在本页可以立即查询回执收口；离开也不会取消它——本页会保留原命令 ID，回来可继续核对，期间不会创建第二个。"
            : "这条命令已发给服务端，结果还没有确认。现在离开会丢失这条命令的核对入口，之后无法确认它是否已生效，容易造成重复创建。请留在本页查询回执收口后再离开。"}</p>
          <p className="dialog-command-id">原命令 ID <code className="hash-code">{pendingCommandId}</code></p>
        </>
        : <p>即将离开的页面还有未保存的修改。你可以继续编辑，或丢弃草稿后离开。</p>}
      <div className="dialog-actions">
        <button className={pendingCommandId ? "primary-button" : "secondary-button"} type="button"
          onClick={() => { keepEditingFocus.current = true; blocker.reset?.(); }}>
          {pendingCommandId ? "留在本页核对回执" : "保留并继续编辑"}</button>
        {pendingCommandId && pendingRecovers && <button className="secondary-button" type="button"
          data-testid="pending-keep-and-leave" onClick={() => blocker.proceed?.()}>离开并保留待核对</button>}
        {!pendingCommandId && <button className="danger-button" type="button" data-testid="discard-draft-leave" onClick={discardAndContinue}>丢弃草稿并离开</button>}
      </div>
    </AppDialog>
    <AppDialog open={closeDialogOpen} title={pendingCommandId ? "命令结果待核对" : "保留未保存的修改"}
      subtitle={pendingCommandId ? "关闭不会取消这条命令" : undefined}
      onClose={() => setCloseDialogOpen(false)}>
      {pendingCommandId
        ? <>
          <p>这条命令已发给服务端，结果还没有确认。关闭窗口不会取消它；重新打开后这里不再提醒。
            如果命令已在服务端生效，请先在对应列表里确认结果，不要重复创建。</p>
          <p className="dialog-command-id">原命令 ID <code className="hash-code">{pendingCommandId}</code></p>
        </>
        : <p>窗口里还有未保存的修改。你可以继续编辑，或丢弃草稿后关闭窗口。</p>}
      <div className="dialog-actions">
        <button className={pendingCommandId ? "primary-button" : "secondary-button"} type="button"
          onClick={() => setCloseDialogOpen(false)}>
          {pendingCommandId ? "留在本页核对回执" : "保留并继续编辑"}</button>
        {pendingCommandId && <button className="danger-button" type="button"
          data-testid="pending-close-anyway" onClick={() => void closeWithPending()}>仍要关闭窗口</button>}
        {!pendingCommandId && <button className="danger-button" type="button" onClick={() => void discardAndClose()}>丢弃草稿并关闭</button>}
      </div>
    </AppDialog>
  </div>;
}
