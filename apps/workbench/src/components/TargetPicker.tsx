import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { RelayApiClient } from "../api/relayClient";
import { describeLiveError } from "../lib/liveErrors";

/**
 * 「查找更多任务 / 会话」的**就地面板**（协作页 §3.1）。
 *
 * 与原 CollaborationView 内部的 TargetPicker 有三点不同：
 * - 它不再自带头部触发按钮，触发按钮由宿主（左栏）持有 `aria-expanded`；
 *   面板只负责读取与选择，这样「就地展开」的语义落在宿主身上，Esc 收起后
 *   焦点也能由宿主交还给那个按钮。
 * - 选项来自同一个下拉里的两组：任务（服务端第一页）与工作区级会话。
 *   会话是左栏新增的一类入口，它没有任务身份，因此用 `session:` 前缀区分。
 * - 选择结果不再直接改协作页的组件状态，而是回给宿主换成一条 URL；
 *   会话草稿与目录作用域仍只有协作页一个 Owner，这里不发任何业务命令。
 */
export interface TargetPickerSelection {
  readonly taskId: string | null;
  readonly sessionId: string | null;
}

interface Option { readonly value: string; readonly label: string }

export default function TargetPicker({ client, onOpen, onClose }: {
  client: RelayApiClient;
  onOpen: (next: TargetPickerSelection) => void;
  onClose: () => void;
}) {
  const [tasks, setTasks] = useState<readonly { id: string; title: string }[]>([]);
  const [sessions, setSessions] = useState<readonly { id: string; title: string }[]>([]);
  const [selected, setSelected] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const selectRef = useRef<HTMLSelectElement>(null);

  useEffect(() => {
    const version = ++request.current;
    setLoading(true); setError(null);
    void Promise.all([client.getWorkspaceTasksPage(null), client.getAssistSessions()]).then(([page, all]) => {
      if (version !== request.current) return;
      setTasks(page.items.map((item) => ({ id: item.id, title: item.title })));
      // 只列工作区级会话：挂在任务上的会话已经由那一行任务承担，再列一遍只是噪声。
      setSessions(all.filter((session) => session.taskId === null)
        .map((session) => ({ id: session.id, title: session.title })));
      setLoading(false);
    }, (caught: unknown) => {
      if (version !== request.current) return;
      setError(describeLiveError(caught).message); setLoading(false);
    });
    return () => { request.current++; };
  }, [client]);

  // 焦点移入面板：展开是用户主动动作，落在第一个可操作控件上，Tab 顺序自然接续。
  useEffect(() => { if (!loading && error === null) selectRef.current?.focus(); }, [loading, error]);

  const options: readonly Option[] = [
    ...tasks.map((task) => ({ value: `task:${task.id}`, label: task.title })),
    ...sessions.map((session) => ({ value: `session:${session.id}`, label: session.title }))
  ];
  const blocked = loading || error !== null || options.length === 0;

  function open() {
    if (selected === "") return;
    const [kind, id] = [selected.slice(0, selected.indexOf(":")), selected.slice(selected.indexOf(":") + 1)];
    onOpen(kind === "task" ? { taskId: id, sessionId: null } : { taskId: null, sessionId: id });
  }

  return <section className="rail-picker" data-testid="collab-target-picker" aria-label="查找更多任务或会话"
    onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}>
    <p className="helper-text">讨论会留在选中的任务或会话里，方便下次继续。</p>
    {loading && <p className="helper-text" role="status">正在读取…</p>}
    {error && <p className="action-error" role="alert">{error}</p>}
    {!loading && error === null && options.length === 0 && <p className="helper-text">当前工作空间还没有任务或会话。
      <Link className="text-link" to="/tasks?view=create">前往新建任务</Link></p>}
    <label className="field"><span className="field-label">任务或会话</span>
      <select ref={selectRef} data-testid="collab-target-select" value={selected} disabled={blocked}
        onChange={(event) => setSelected(event.target.value)}>
        <option value="">{loading ? "正在读取…" : "请选择"}</option>
        {tasks.length > 0 && <optgroup label="任务">
          {tasks.map((task) => <option key={task.id} value={`task:${task.id}`}>{task.title}</option>)}</optgroup>}
        {sessions.length > 0 && <optgroup label="会话">
          {sessions.map((session) => <option key={session.id} value={`session:${session.id}`}>{session.title}</option>)}</optgroup>}
      </select></label>
    <div className="form-actions">
      <button className="primary-button" type="button" data-testid="collab-target-open"
        disabled={selected === "" || blocked} onClick={open}>打开</button>
      <button className="secondary-button" type="button" data-testid="collab-target-close" onClick={onClose}>收起</button>
    </div>
  </section>;
}
