import { useEffect, useRef, useState } from "react";
import { Outlet, useBlocker, useLocation } from "react-router-dom";
import { isTauri, invoke } from "@tauri-apps/api/core";
import type { RelayApiConnection } from "./api/relayClient";
import { RelayApiClient } from "./api/relayClient";
import AppDialog from "./components/AppDialog";
import AppShell from "./components/AppShell";
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
  const blocker = useBlocker(() => hasUnsavedDraft());
  const [desktopStatus, setDesktopStatus] = useState<"idle" | "connecting" | "error">(() => isTauri() ? "connecting" : "idle");
  const [closeDialogOpen, setCloseDialogOpen] = useState(false);
  const allowClose = useRef(false);

  useEffect(() => { window.scrollTo(0, 0); }, [location.pathname, location.search]);

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
    currentDraftGuard()?.discard();
    blocker.proceed?.();
  }

  async function discardAndClose(): Promise<void> {
    currentDraftGuard()?.discard();
    allowClose.current = true;
    setCloseDialogOpen(false);
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().destroy();
  }

  if (desktopStatus !== "idle") {
    return <main className="page-state" data-testid={desktopStatus === "error" ? "desktop-service-unavailable" : "desktop-service-connecting"} role="status">
      {desktopStatus === "error" ? <>
        <h1>本机服务不可用</h1>
        <p>无法连接桌面工作空间。请关闭并重新启动 Relay Agent；如果问题持续，请检查 PostgreSQL 和桌面配置。</p>
      </> : <>
        <h1>正在连接本机服务</h1>
        <p>正在核对桌面工作空间与 API 就绪状态。</p>
      </>}
    </main>;
  }

  return <>
    <AppShell desktopStatus={desktopStatus}>
      <div key={`${connection.epoch}:${location.pathname}${location.search}`}><Outlet /></div>
    </AppShell>
    <AppDialog open={blocker.state === "blocked"} title="保留未保存的修改" onClose={() => blocker.reset?.()}>
      <p>即将离开的页面还有未保存的修改。你可以继续编辑，或丢弃草稿后离开。</p>
      <div className="dialog-actions">
        <button className="secondary-button" type="button" onClick={() => blocker.reset?.()}>保留并继续编辑</button>
        <button className="danger-button" type="button" onClick={discardAndContinue}>丢弃草稿并离开</button>
      </div>
    </AppDialog>
    <AppDialog open={closeDialogOpen} title="保留未保存的修改" onClose={() => setCloseDialogOpen(false)}>
      <p>窗口里还有未保存的修改。你可以继续编辑，或丢弃草稿并关闭窗口。</p>
      <div className="dialog-actions">
        <button className="secondary-button" type="button" onClick={() => setCloseDialogOpen(false)}>保留并继续编辑</button>
        <button className="danger-button" type="button" onClick={() => void discardAndClose()}>丢弃草稿并关闭</button>
      </div>
    </AppDialog>
  </>;
}
