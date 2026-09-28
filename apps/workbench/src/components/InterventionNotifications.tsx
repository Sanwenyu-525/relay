import { useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { useNavigate } from "react-router-dom";
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

  return <div className="intervention-notifications" data-testid="intervention-notifications">
    {items.length > 0 && <a href="/tasks?tab=attention" onClick={(event) => {
      event.preventDefault(); navigate("/tasks?tab=attention");
    }}>需人工介入 {items.length} 项</a>}
    {isTauri() && permission === "default" && <button type="button" className="secondary-button"
      onClick={() => void enableNotifications()}>开启 Windows 通知</button>}
    {error && <span role="status">人工介入状态暂不可刷新：{error}</span>}
  </div>;
}
