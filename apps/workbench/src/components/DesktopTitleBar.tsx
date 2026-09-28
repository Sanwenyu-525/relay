import { useEffect, useState, type MouseEvent } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useLocation, useNavigate, useNavigationType } from "react-router-dom";
import { ArrowLeft, ArrowRight, Copy, Minus, Plus, Search, Square, X } from "lucide-react";

export default function DesktopTitleBar({ available, onSearch }: { available: boolean; onSearch: () => void }) {
  const desktop = isTauri();
  const location = useLocation();
  const navigate = useNavigate();
  const navigationType = useNavigationType();
  const [routeHistory, setRouteHistory] = useState(() => ({ keys: [location.key], index: 0 }));
  const [maximized, setMaximized] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    setRouteHistory((current) => {
      const known = current.keys.indexOf(location.key);
      if (navigationType === "POP") return known < 0 ? { keys: [location.key], index: 0 } : { ...current, index: known };
      if (navigationType === "REPLACE") {
        const keys = [...current.keys];
        keys[current.index] = location.key;
        return { keys, index: current.index };
      }
      const keys = [...current.keys.slice(0, current.index + 1), location.key];
      return { keys, index: keys.length - 1 };
    });
  }, [location.key, navigationType]);

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

  if (!desktop) return null;
  const current = getCurrentWindow();
  const run = async (action: () => Promise<void>) => {
    try {
      setError(false);
      await action();
    } catch {
      setError(true);
    }
  };
  const toggleMaximized = () => run(async () => {
    await current.toggleMaximize();
    setMaximized(await current.isMaximized());
  });
  const onDragMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    if (event.detail === 2) void toggleMaximized();
    else void run(() => current.startDragging());
  };
  const project = /^\/projects\/([^/]+)(?:\/|$)/u.exec(location.pathname);
  const createTaskPath = project ? `/tasks?view=create&project=${encodeURIComponent(decodeURIComponent(project[1]!))}` : "/tasks?view=create";

  return <div className="desktop-titlebar" data-testid="desktop-titlebar">
    <div className="desktop-titlebar__actions" aria-label="常用操作">
      <button className="desktop-titlebar__action desktop-titlebar__action--icon" type="button" aria-label="后退" title="后退" data-testid="titlebar-back" disabled={!available || routeHistory.index === 0} onClick={() => void navigate(-1)}><ArrowLeft aria-hidden="true" /></button>
      <button className="desktop-titlebar__action desktop-titlebar__action--icon" type="button" aria-label="前进" title="前进" data-testid="titlebar-forward" disabled={!available || routeHistory.index >= routeHistory.keys.length - 1} onClick={() => void navigate(1)}><ArrowRight aria-hidden="true" /></button>
      <span className="desktop-titlebar__separator" aria-hidden="true" />
      <button className="desktop-titlebar__action" type="button" aria-label="搜索，快捷键 Ctrl+K" data-testid="titlebar-search" disabled={!available} onClick={onSearch}><Search aria-hidden="true" /><span className="desktop-titlebar__action-label">搜索</span><kbd>Ctrl K</kbd></button>
      <span className="desktop-titlebar__separator" aria-hidden="true" />
      <button className="desktop-titlebar__action" type="button" aria-label="新建任务" data-testid="titlebar-create-task" disabled={!available} onClick={() => void navigate(createTaskPath)}><Plus aria-hidden="true" /><span className="desktop-titlebar__action-label">新建任务</span></button>
    </div>
    <div className="desktop-titlebar__drag" onMouseDown={onDragMouseDown}>
      {error && <span className="desktop-titlebar__error" role="alert">窗口操作失败</span>}
    </div>
    <div className="desktop-titlebar__controls" aria-label="窗口控制">
      <button className="desktop-titlebar__button" type="button" aria-label="最小化" onClick={() => void run(() => current.minimize())}><Minus aria-hidden="true" /></button>
      <button className="desktop-titlebar__button" type="button" aria-label={maximized ? "还原窗口" : "最大化"} onClick={() => void toggleMaximized()}>
        {maximized ? <Copy aria-hidden="true" /> : <Square aria-hidden="true" />}
      </button>
      <button className="desktop-titlebar__button desktop-titlebar__button--close" type="button" aria-label="关闭窗口" onClick={() => void run(() => current.close())}><X aria-hidden="true" /></button>
    </div>
  </div>;
}
