import { useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { useNavigate } from "react-router-dom";
import { Bell, BellRing } from "lucide-react";
import { type RelayApiClient, type RelayInterventionItem } from "../api/relayClient";
import { describeLiveError } from "../lib/liveErrors";

const AGGREGATION_MS = 3_000;
const POLL_MS = 10_000;

export default function InterventionNotifications({ client }:
  { readonly client: RelayApiClient }) {
  const navigate = useNavigate();
  const [items, setItems] = useState<readonly RelayInterventionItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">(
    typeof Notification === "undefined" ? "unsupported" : Notification.permission);
  const disclosure = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && disclosure.current && !disclosure.current.contains(event.target)) {
        disclosure.current.open = false;
      }
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, []);
  useEffect(() => {
    let active = true;
    let checking = false;
    let collecting = false;
    let timer: number | null = null;
    async function refresh() {
      if (!active || checking) return;
      checking = true;
      try {
        const latest = await client.getInterventions();
        if (!active) return;
        setItems(latest); setError(null);
        if (!isTauri() || collecting || latest.length === 0) return;
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        if (!active || await getCurrentWindow().isFocused()) return;
        collecting = true;
        timer = window.setTimeout(() => { timer = null; void deliver(); }, AGGREGATION_MS);
      } catch (caught) { if (active) setError(describeLiveError(caught).message); }
      finally { checking = false; }
    }
    async function deliver() {
      try {
        if (!active) return;
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        if (await getCurrentWindow().isFocused()) return;
        const claimed = await client.claimInterventionNotifications();
        if (!active || claimed.length === 0) return;
        const status = typeof Notification === "undefined" ? "unsupported" : Notification.permission;
        setPermission(status);
        if (status !== "granted") {
          await Promise.all(claimed.map((item) => client.settleInterventionNotification(item, "DENIED")));
          return;
        }
        const target = claimed.length === 1 ? claimed[0]!.targetUrl : "/tasks?tab=attention";
        try {
          const notification = new Notification(claimed.length === 1 ? claimed[0]!.title
            : `${claimed.length} 个事项需要你处理`, {
            body: claimed.length === 1 ? claimed[0]!.reason : "打开人工待处理列表，逐项核对原事项。" });
          notification.onclick = () => {
            void getCurrentWindow().show().then(() => getCurrentWindow().unminimize())
              .then(() => getCurrentWindow().setFocus());
            navigate(target); notification.close();
          };
          await Promise.all(claimed.map((item) => client.settleInterventionNotification(item, "DISPATCHED")));
        } catch {
          await Promise.all(claimed.map((item) => client.settleInterventionNotification(item, "FAILED")));
        }
      } catch (caught) { if (active) setError(describeLiveError(caught).message); }
      finally { collecting = false; }
    }
    void refresh();
    const interval = window.setInterval(() => { void refresh(); }, POLL_MS);
    return () => { active = false; window.clearInterval(interval); if (timer !== null) window.clearTimeout(timer); };
  }, [client, navigate]);

  async function enableNotifications() {
    if (typeof Notification === "undefined") return;
    try { setPermission(await Notification.requestPermission()); }
    catch (caught) { setError(describeLiveError(caught).message); }
  }

  const label = `${items.length > 0 ? `通知与待处理，需人工介入 ${items.length} 项` : "通知与待处理"}${error ? "，状态读取暂不可用" : ""}`;
  const permissionLabel = permission === "granted" ? "已允许 Windows 通知"
    : permission === "denied" ? "Windows 通知已被阻止；应用内待处理列表仍可使用。"
    : permission === "unsupported" ? "当前环境不支持 Windows 通知。" : "Windows 通知尚未开启";
  return <details ref={disclosure} className="intervention-notifications" data-testid="intervention-notifications"
    onKeyDown={(event) => {
      if (event.key !== "Escape" || !event.currentTarget.open) return;
      event.preventDefault(); event.currentTarget.open = false;
      event.currentTarget.querySelector("summary")?.focus();
    }}>
    <summary className={`icon-button intervention-notifications-trigger${error ? " intervention-notifications-trigger--error" : ""}`}
      data-testid="intervention-notifications-open" aria-label={label} title={label}>
      <Bell aria-hidden="true" />
      {items.length > 0 && <span className="intervention-notifications-count" aria-hidden="true">{items.length}</span>}
    </summary>
    <div className="intervention-notifications-panel">
      <a className="text-link" href="/tasks?tab=attention" onClick={(event) => {
        event.preventDefault(); if (disclosure.current) disclosure.current.open = false;
        navigate("/tasks?tab=attention");
      }}>{items.length > 0 ? `需人工介入 ${items.length} 项` : "打开人工待处理列表"}</a>
      {isTauri() && <div className="intervention-notifications-permission">
        <p>{permissionLabel}</p>
        {permission === "default" && <button type="button" className="icon-button"
          aria-label="开启 Windows 通知" title="开启 Windows 通知" onClick={() => void enableNotifications()}>
          <BellRing aria-hidden="true" />
        </button>}
      </div>}
      {error && <p className="action-error" role="status">人工介入状态暂不可刷新：{error}</p>}
    </div>
  </details>;
}
