import { useEffect, useState, type MouseEvent } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Link } from "react-router-dom";
import { Copy, Inbox, Link2, Minus, Square, X } from "lucide-react";
import InterventionNotifications from "./InterventionNotifications";
import RelayConnectionDialog from "./RelayConnectionDialog";
import WorkbenchActions from "./WorkbenchActions";
import { useDisplayPreferences } from "../lib/displayPreferences";
import { useRelayConnection } from "../lib/relayConnection";

export default function DesktopTitleBar({ available, onSearch }: { available: boolean; onSearch: () => void }) {
  const desktop = isTauri();
  const connection = useRelayConnection();
  const { timeZone } = useDisplayPreferences();
  const [maximized, setMaximized] = useState(false);
  const [error, setError] = useState(false);
  const [connectionOpen, setConnectionOpen] = useState(false);

  useEffect(() => {
    if (!desktop) return;
    const current = getCurrentWindow();
    let active = true;
    let unlisten: (() => void)[] = [];
    const syncMaximized = async () => {
      const value = await current.isMaximized();
      if (active) setMaximized(value);
    };
    void syncMaximized().catch(() => setError(true));
    void Promise.all([
      current.onResized(() => { void syncMaximized().catch(() => setError(true)); }),
      current.onFocusChanged(() => { void syncMaximized().catch(() => setError(true)); })
    ]).then((listeners) => {
      if (active) unlisten = listeners;
      else listeners.forEach((off) => off());
    }).catch(() => setError(true));
    return () => { active = false; unlisten.forEach((off) => off()); };
  }, [desktop]);

  const current = desktop ? getCurrentWindow() : null;
  const run = async (action: () => Promise<void>) => {
    try {
      setError(false);
      await action();
    } catch {
      setError(true);
    }
  };
  const toggleMaximized = () => run(async () => {
    if (!current) return;
    await current.toggleMaximize();
    setMaximized(await current.isMaximized());
  });
  const onDragMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    if (!current || event.button !== 0) return;
    event.preventDefault();
    if (event.detail === 2) void toggleMaximized();
    else void run(() => current.startDragging());
  };
  // 常用状态与入口与窗口控制同处一条标题带：应用顶栏不再重复承载日期、收件箱与通知。
  const now = new Date();
  const date = new Intl.DateTimeFormat("zh-CN", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now).replaceAll("/", "-");
  const weekday = new Intl.DateTimeFormat("zh-CN", { timeZone, weekday: "long" }).format(now);
  const dataSourceLabel = connection.mode === "live" ? "已连接本机 API" : "示例数据";

  return <>
    <div className="desktop-titlebar" data-testid="desktop-titlebar">
      {/* 常用操作回到标题带左侧：这一组属于常驻窗口外壳，应用顶栏不再重复承载。
          连接中与服务失败页没有可用的应用内路由与命令面板，因此不渲染。 */}
      {available && <WorkbenchActions onSearch={onSearch} />}
      <div className="desktop-titlebar__drag" onMouseDown={onDragMouseDown}>
        {error && <span className="desktop-titlebar__error" role="alert">窗口操作失败</span>}
      </div>
      {/* 连接中与服务失败页只保留真实窗口控制：数据来源与通知此时没有可核对的事实，不显示。 */}
      {available && <div className="desktop-titlebar__cluster">
        <time className="desktop-titlebar__date" dateTime={date} title={`界面时区：${timeZone}`}>{date}　{weekday}</time>
        <Link className="icon-button" to="/inbox" aria-label="打开任务收件箱" title="任务收件箱"
          data-testid="inbox-open"><Inbox aria-hidden="true" /></Link>
        <button className={`data-source-button${connection.mode === "live" ? " data-source-button--live" : ""}`} type="button"
          data-testid="relay-connection-open" aria-label={`数据来源：${dataSourceLabel}，打开连接设置`} onClick={() => setConnectionOpen(true)}>
          <Link2 aria-hidden="true" /><span className="visually-hidden">{dataSourceLabel}</span>
        </button>
        {connection.mode === "live" && connection.client && <InterventionNotifications
          key={connection.epoch} client={connection.client} />}
      </div>}
      {current && <div className="desktop-titlebar__controls" aria-label="窗口控制">
        <button className="desktop-titlebar__button" type="button" aria-label="最小化" title="最小化" onClick={() => void run(() => current.minimize())}><Minus aria-hidden="true" /></button>
        <button className="desktop-titlebar__button" type="button" aria-label={maximized ? "还原窗口" : "最大化"} onClick={() => void toggleMaximized()}>
          {maximized ? <Copy aria-hidden="true" /> : <Square aria-hidden="true" />}
        </button>
        <button className="desktop-titlebar__button desktop-titlebar__button--close" type="button" aria-label="关闭窗口" onClick={() => void run(() => current.close())}><X aria-hidden="true" /></button>
      </div>}
    </div>
    <RelayConnectionDialog open={connectionOpen} onClose={() => setConnectionOpen(false)} />
  </>;
}
