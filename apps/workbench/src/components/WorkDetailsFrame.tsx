import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { X } from "lucide-react";

export type WorkDetailsTab = "PROGRESS" | "RESULTS" | "RECORDS";
const tabs = [{ id: "PROGRESS", label: "进展" }, { id: "RESULTS", label: "成果" },
  { id: "RECORDS", label: "记录" }] as const;

/** 会话和任务共用的工作详情外壳；内容仍由各自事实 Owner 提供。 */
export default function WorkDetailsFrame({ id, testId, className, tab, onTabChange, onClose, children }: {
  id: string; testId: string; className: string; tab: WorkDetailsTab;
  onTabChange: (tab: WorkDetailsTab) => void; onClose: () => void; children: ReactNode;
}) {
  const refs = useRef<Partial<Record<WorkDetailsTab, HTMLButtonElement>>>({});
  function handleKey(event: KeyboardEvent, current: WorkDetailsTab) {
    if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
    const index = tabs.findIndex((item) => item.id === current);
    const next = event.key === "ArrowRight" || event.key === "ArrowDown" ? (index + 1) % tabs.length
      : event.key === "ArrowLeft" || event.key === "ArrowUp" ? (index + tabs.length - 1) % tabs.length
      : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault();
    const nextTab = tabs[next]!.id;
    onTabChange(nextTab);
    refs.current[nextTab]?.focus();
  }
  return <aside className={className} id={id} data-testid={testId} aria-label="工作详情">
    <div className="inspector-head">
      <div className="inspector-head-copy"><strong>工作详情</strong><small>按需查看，不影响协作</small></div>
      <button type="button" className="inspector-close" title="收起工作详情" data-testid={`${testId}-close`} onClick={onClose}>
        <X size={15} aria-hidden="true" /></button>
    </div>
    <div className="inspector-tabs" role="tablist" aria-label="工作详情分类">
      {tabs.map((item) => <button key={item.id} type="button" role="tab"
        id={`${id}-tab-${item.id}`} aria-controls={`${id}-panel`} aria-selected={tab === item.id}
        tabIndex={tab === item.id ? 0 : -1} ref={(element) => { if (element) refs.current[item.id] = element; }}
        className={tab === item.id ? "active" : ""} data-testid={`${testId}-tab-${item.id}`}
        onKeyDown={(event) => handleKey(event, item.id)} onClick={() => onTabChange(item.id)}>{item.label}</button>)}
    </div>
    <div className="inspector-body" id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-tab-${tab}`}
      tabIndex={0} data-testid={`${testId}-panel-${tab}`}>{children}</div>
  </aside>;
}
