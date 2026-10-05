import { useEffect, useState } from "react";
import { useLocation, useNavigate, useNavigationType } from "react-router-dom";
import { ArrowLeft, ArrowRight, Plus, Search } from "lucide-react";

export default function WorkbenchActions({ onSearch }: { onSearch: () => void }) {
  const location = useLocation();
  const navigate = useNavigate();
  const navigationType = useNavigationType();
  const [routeHistory, setRouteHistory] = useState(() => ({ keys: [location.key], index: 0 }));

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

  const project = /^\/projects\/([^/]+)(?:\/|$)/u.exec(location.pathname);
  const createTaskPath = project ? `/tasks?view=create&project=${encodeURIComponent(decodeURIComponent(project[1]!))}` : "/tasks?view=create";

  return <div className="workbench-actions" aria-label="常用操作">
    <button className="icon-button" type="button" aria-label="后退" title="后退" data-testid="titlebar-back"
      disabled={routeHistory.index === 0} onClick={() => void navigate(-1)}><ArrowLeft aria-hidden="true" /></button>
    <button className="icon-button" type="button" aria-label="前进" title="前进" data-testid="titlebar-forward"
      disabled={routeHistory.index >= routeHistory.keys.length - 1} onClick={() => void navigate(1)}><ArrowRight aria-hidden="true" /></button>
    <button className="icon-button" type="button" aria-label="搜索资料，快捷键 Ctrl+K" title="搜索资料 · Ctrl+K"
      data-testid="titlebar-search" onClick={onSearch}><Search aria-hidden="true" /></button>
    <button className="icon-button" type="button" aria-label="新建任务" title="新建任务" data-testid="titlebar-create-task"
      onClick={() => void navigate(createTaskPath)}><Plus aria-hidden="true" /></button>
  </div>;
}
