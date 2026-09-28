import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import {
  createCommandId, RelayApiError, selectionRevisionFrom, taskMutationFrom,
  type RelayApiClient, type RelayCommandEnvelope, type RelayToday, type RelayTodayItem,
  type RelayTodayPriority
} from "../api/relayClient";
import { describeLiveError } from "../lib/liveErrors";
import { taskStatusLabels } from "../lib/labels";
import { useRelayConnection } from "../lib/relayConnection";
import "./TodayView.css";

type TodayCommand = (
  { readonly kind: "selection"; readonly taskId: string; readonly pin: boolean;
    readonly laterLocalDate: string | null; readonly timezone: string | null } |
  { readonly kind: "focus"; readonly date: string; readonly timezone: string;
    readonly targetKind: "TASK" | null; readonly targetId: string | null } |
  { readonly kind: "planning"; readonly taskId: string; readonly priority: RelayTodayPriority | null;
    readonly dueLocalDate: string | null; readonly timezone: string | null }
) & { readonly id: string; readonly expectedRevision: string; readonly queryDate: string;
  readonly queryTimezone: string; readonly projectId?: string | null };

function localDate(timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone,
    year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function validTimezone(value: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone: value }); return true; }
  catch { return false; }
}

function commandType(command: TodayCommand): string {
  return command.kind === "selection" ? "SetTaskSelection"
    : command.kind === "focus" ? "SetFocusSelection" : "SetTaskPlanningMetadata";
}

function commandSummary(command: TodayCommand): string {
  if (command.kind === "selection") return `Task ${command.taskId}；Pin ${command.pin ? "开" : "关"}；Later ${command.laterLocalDate ? `${command.laterLocalDate}（${command.timezone}）` : "清除"}`;
  if (command.kind === "focus") return `日期 ${command.date}（${command.timezone}）；Focus ${command.targetKind ? `${command.targetKind} ${command.targetId}` : "清除"}`;
  return `Task ${command.taskId}；优先级 ${command.priority ?? "未设"}；截止 ${command.dueLocalDate ? `${command.dueLocalDate}（${command.timezone}）` : "清除"}`;
}

function confirmResult(envelope: RelayCommandEnvelope, command: TodayCommand): void {
  if (envelope.commandId !== command.id) throw new Error("回执 command_id 与原命令不符。");
  if (command.kind === "planning") {
    const result = taskMutationFrom(envelope.result);
    if (result.taskId !== command.taskId || BigInt(result.revision) <= BigInt(command.expectedRevision)) {
      throw new Error("任务计划回执的目标或修订无法核对。");
    }
  } else if (BigInt(selectionRevisionFrom(envelope.result)) <= BigInt(command.expectedRevision)) {
    throw new Error("Today 选择回执的修订无法核对。");
  }
}

/** 服务端 reason_codes 的展示文案；未收录的代码原样显示，不编造含义。 */
const todayReasonLabels: Record<string, string> = {
  FOCUS_ALIGNED: "今日焦点对齐",
  PINNED: "已置顶",
  OVERDUE: "已过截止",
  DUE_TODAY: "今日截止",
  PRIORITY_HIGH: "优先级高",
  PRIORITY_LOW: "优先级低",
  PROJECT_NEXT_ACTION: "项目下一步",
  HUMAN_IN_PROGRESS: "进行中",
  AI_OCCUPIED: "AI 执行中",
  TASK_NOT_READY: "任务未就绪",
  REQUIRED_CRITERION_MISSING: "缺必需验收条件",
  DEPENDENCY_UNSATISFIED: "依赖未完成",
  TASK_BLOCKED: "有阻塞事项",
  LATER_ACTIVE: "已延后",
  READY_TO_START: "可开始"
};

const priorityLabels: Record<RelayTodayPriority, string> = { LOW: "低", NORMAL: "中", HIGH: "高" };

function TodayTask({ item, eligible, busy, queryTimezone, queryDate, projectTitle, onSelection, onFocus, onPlanning }: {
  item: RelayTodayItem; eligible: boolean; busy: boolean; queryTimezone: string; queryDate: string;
  projectTitle: string | null;
  onSelection: (item: RelayTodayItem, pin: boolean, laterLocalDate: string | null, timezone: string | null) => void;
  onFocus: (item: RelayTodayItem) => void;
  onPlanning: (item: RelayTodayItem, priority: RelayTodayPriority | null, dueLocalDate: string | null, timezone: string | null) => void;
}) {
  const [laterDate, setLaterDate] = useState(item.laterLocalDate ?? "");
  const [laterZone, setLaterZone] = useState(item.laterTimezone ?? queryTimezone);
  const [priority, setPriority] = useState<RelayTodayPriority | "">(item.priority ?? "");
  const [dueDate, setDueDate] = useState(item.dueLocalDate ?? "");
  const [dueZone, setDueZone] = useState(item.timezone ?? queryTimezone);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const actions = new Set(item.allowedActions);

  function submitLater(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!laterDate || !validTimezone(laterZone)) { setFieldError("延后需要有效日期和 IANA 时区。"); return; }
    setFieldError(null);
    onSelection(item, item.pin, laterDate, laterZone);
  }

  function submitPlanning(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (dueDate && !validTimezone(dueZone)) { setFieldError("截止日期需要有效 IANA 时区。"); return; }
    setFieldError(null);
    onPlanning(item, priority || null, dueDate || null, dueDate ? dueZone : null);
  }

  const statusLabel = taskStatusLabels[item.status] ?? item.status;
  return <li className="today-task">
    <div className="today-task__main">
      <div className="today-task__heading">
        <Link className="today-task__title" to={`/tasks/${item.taskId}`}>{item.title}</Link>
        <span className={eligible ? "today-eligibility today-eligibility--ready" : "today-eligibility"}>
          {eligible ? (item.status === "IN_PROGRESS" ? "可继续" : "可开始") : "待处理"}</span>
      </div>
      <p className="today-task__meta">
        <span>{statusLabel}</span>
        {item.projectId && <><span className="today-task__dot" aria-hidden="true">·</span>
          <Link to={`/projects/${item.projectId}/tasks`}>{projectTitle ?? "所属项目"}</Link></>}
        {item.priority && <><span className="today-task__dot" aria-hidden="true">·</span><span>优先级 {priorityLabels[item.priority] ?? item.priority}</span></>}
        {item.dueLocalDate && <><span className="today-task__dot" aria-hidden="true">·</span><span>截止 {item.dueLocalDate}</span></>}
        {item.pin && <><span className="today-task__dot" aria-hidden="true">·</span><span>已置顶</span></>}
        {item.laterLocalDate && <><span className="today-task__dot" aria-hidden="true">·</span><span>延后至 {item.laterLocalDate}</span></>}
      </p>
    </div>
    <div className="today-task__actions">
      {eligible && actions.has("START") && <Link className="inline-link" to={`/tasks/${item.taskId}`}>打开任务</Link>}
      {actions.has(item.pin ? "UNPIN" : "PIN") && <button className="text-button" type="button" disabled={busy}
        onClick={() => onSelection(item, !item.pin, item.laterLocalDate, item.laterTimezone)}>{item.pin ? "取消置顶" : "置顶"}</button>}
      {actions.has("SET_FOCUS") && <button className="text-button" type="button" disabled={busy} onClick={() => onFocus(item)}>设为今日焦点</button>}
      {actions.has("CLEAR_LATER") && <button className="text-button" type="button" disabled={busy}
        onClick={() => onSelection(item, item.pin, null, null)}>取消延后</button>}
    </div>
    <details className="today-task__plans">
      <summary>延后与计划</summary>
      <div className="today-task__forms">
      {actions.has("SET_LATER") && <form onSubmit={submitLater}>
        <strong>延后</strong><label>日期<input type="date" value={laterDate} onChange={(event) => setLaterDate(event.target.value)} min={queryDate} disabled={busy} required /></label>
        <label>时区<input value={laterZone} onChange={(event) => setLaterZone(event.target.value)} disabled={busy} required /></label>
        <button className="secondary-button" type="submit" disabled={busy}>保存延后</button>
      </form>}
      <form onSubmit={submitPlanning}>
        <strong>任务计划</strong><label>优先级<select value={priority} onChange={(event) => setPriority(event.target.value as RelayTodayPriority | "") } disabled={busy}>
          <option value="">未设</option><option value="LOW">低</option><option value="NORMAL">中</option><option value="HIGH">高</option></select></label>
        <label>截止日期<input type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} disabled={busy} /></label>
        <label>截止时区<input value={dueZone} onChange={(event) => setDueZone(event.target.value)} disabled={busy || !dueDate} /></label>
        <button className="secondary-button" type="submit" disabled={busy}>保存计划</button>
      </form>
      </div>
    </details>
    {fieldError && <p className="action-error" role="alert">{fieldError}</p>}
    <details className="today-task__trace"><summary>排序依据与允许操作</summary>
      <p>依据：{item.reasonCodes.length ? item.reasonCodes.map((code) => `${todayReasonLabels[code] ?? code}（${code}）`).join(" · ") : "服务端未给出 reason_codes"}</p>
      <p>证据：{item.evidenceRefs.length ? item.evidenceRefs.join(" · ") : "服务端未给出 evidence_refs"}</p>
      <p>允许操作：{item.allowedActions.length ? item.allowedActions.join(" · ") : "无"}</p>
      <p>任务修订 v{item.taskRevision}</p></details>
  </li>;
}

export default function TodayView() {
  const connection = useRelayConnection();
  const client = connection.mode === "live" ? connection.client : null;
  const initialTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const [date, setDate] = useState(() => localDate(initialTimezone));
  const [timezone, setTimezone] = useState(initialTimezone);
  const [timezoneDraft, setTimezoneDraft] = useState(initialTimezone);
  const [zoneEditorOpen, setZoneEditorOpen] = useState(false);
  const zoneSummaryRef = useRef<HTMLButtonElement | null>(null);
  const [snapshot, setSnapshot] = useState<RelayToday | null>(null);
  const [loading, setLoading] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [lastReceiptId, setLastReceiptId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [pending, setPending] = useState<TodayCommand | null>(null);
  const [mayRetry, setMayRetry] = useState(false);
  const [failedCommandId, setFailedCommandId] = useState<string | null>(null);
  const [timezoneError, setTimezoneError] = useState<string | null>(null);
  const [projectTitles, setProjectTitles] = useState<Record<string, string | null>>({});
  const requestedProjectIds = useRef<Set<string>>(new Set());
  const requestVersion = useRef(0);
  const viewScope = useRef(0);
  const pendingRef = useRef<TodayCommand | null>(null);
  const queryRef = useRef(`${date}|${timezone}`);
  queryRef.current = `${date}|${timezone}`;

  async function loadToday(activeClient: RelayApiClient, targetDate: string, targetTimezone: string) {
    const request = ++requestVersion.current;
    const scope = viewScope.current;
    setLoading(true); setReadError(null);
    try {
      const next = await activeClient.getToday(targetDate, targetTimezone);
      if (next.date !== targetDate || next.timezone !== targetTimezone) throw new Error("Today 返回的日期或时区与查询不符。");
      if (scope !== viewScope.current || request !== requestVersion.current || queryRef.current !== `${targetDate}|${targetTimezone}`) return;
      setSnapshot(next);
    } catch (caught) {
      if (scope === viewScope.current && request === requestVersion.current && queryRef.current === `${targetDate}|${targetTimezone}`) {
        setSnapshot(null);
        setReadError(describeLiveError(caught).message);
      }
    } finally {
      if (scope === viewScope.current && request === requestVersion.current && queryRef.current === `${targetDate}|${targetTimezone}`) setLoading(false);
    }
  }

  useEffect(() => {
    viewScope.current++;
    pendingRef.current = null; setPending(null); setMayRetry(false); setSnapshot(null);
    requestedProjectIds.current = new Set(); setProjectTitles({});
    return () => { viewScope.current++; requestVersion.current++; pendingRef.current = null; };
  }, [client, connection.epoch]);
  useEffect(() => {
    if (client !== null) void loadToday(client, date, timezone);
    return () => { requestVersion.current++; };
  }, [client, date, timezone, connection.epoch]);

  // 项目标题按确切 Project 单读补充；读取失败显示中性回退，不编造名称。
  useEffect(() => {
    if (client === null || snapshot === null) return;
    const missing = new Set<string>();
    for (const item of [...snapshot.eligibleItems, ...snapshot.waitingItems, ...snapshot.blockedPinnedItems]) {
      if (item.projectId && !requestedProjectIds.current.has(item.projectId)) missing.add(item.projectId);
    }
    if (missing.size === 0) return;
    for (const id of missing) requestedProjectIds.current.add(id);
    const scope = viewScope.current;
    void Promise.all([...missing].map(async (id) => {
      try {
        const project = await client.getProject(id);
        return [id, project.archivedAt === null ? project.title : null] as const;
      } catch { return [id, null] as const; }
    })).then((entries) => {
      if (scope !== viewScope.current) return;
      setProjectTitles((current) => ({ ...current, ...Object.fromEntries(entries) }));
    });
  }, [client, snapshot]);

  async function confirmTodayTarget(api: RelayApiClient, command: TodayCommand): Promise<void> {
    if (command.kind === "focus" && command.targetId === null) return;
    const targetTaskId = command.kind === "focus" ? command.targetId : command.taskId;
    const current = snapshot?.date === command.queryDate && snapshot.timezone === command.queryTimezone ? snapshot : null;
    const item = [...(current?.eligibleItems ?? []), ...(current?.waitingItems ?? []),
      ...(current?.blockedPinnedItems ?? [])].find((candidate) => candidate.taskId === targetTaskId);
    if (!item || item.projectId !== command.projectId || queryRef.current !== `${command.queryDate}|${command.queryTimezone}`)
      throw new Error("Today 候选已变化，请重读当前范围后再选择。");
    const task = await api.getTask(targetTaskId!);
    if (task.id !== targetTaskId || task.projectId !== item.projectId)
      throw new Error("Task 归属已变化，请重读 Today；旧候选不能继续提交。");
    if (task.projectId === null) return;
    const project = await api.getProject(task.projectId);
    if (project.id !== task.projectId) throw new Error("Project 读取结果与 Task 归属不匹配。");
    if (project.archivedAt !== null) throw new Error("任务所属项目已归档，不能提交新的 Today 选择或计划。");
  }

  async function sendFrozen(command: TodayCommand, retry = false) {
    if (client === null || submitting || (pendingRef.current !== null && (!retry || pendingRef.current !== command))) return;
    const scope = viewScope.current;
    pendingRef.current = command; setPending(command); setMayRetry(false); setSubmitting(true);
    setActionError(null); setMessage(null); setFailedCommandId(null);
    let sent = false;
    try {
      if (!retry) {
        await confirmTodayTarget(client, command);
        if (scope !== viewScope.current) return;
        if (queryRef.current !== `${command.queryDate}|${command.queryTimezone}`) {
          pendingRef.current = null; setPending(null);
          setActionError("Today 查询范围已变化，原选择尚未发送；请在新范围重新确认。");
          return;
        }
      }
      sent = true;
      const envelope = command.kind === "selection"
        ? await client.setTaskSelection({ taskId: command.taskId, commandId: command.id,
          expectedRevision: command.expectedRevision, pin: command.pin,
          laterLocalDate: command.laterLocalDate, timezone: command.timezone })
        : command.kind === "focus"
          ? await client.setFocusSelection({ commandId: command.id, expectedRevision: command.expectedRevision,
            date: command.date, timezone: command.timezone, targetKind: command.targetKind, targetId: command.targetId })
          : await client.setTaskPlanningMetadata({ taskId: command.taskId, commandId: command.id,
            expectedRevision: command.expectedRevision, priority: command.priority,
            dueLocalDate: command.dueLocalDate, timezone: command.timezone });
      if (scope !== viewScope.current) return;
      confirmResult(envelope, command);
      pendingRef.current = null; setPending(null);
      setMessage("操作已由服务端确认，今日安排已更新。"); setLastReceiptId(command.id);
      const [currentDate, currentTimezone] = queryRef.current.split("|");
      await loadToday(client, currentDate!, currentTimezone!);
    } catch (caught) {
      if (scope !== viewScope.current) return;
      if (!sent) {
        pendingRef.current = null; setPending(null);
        setActionError(`关联任务或 Project 状态未确认，Today 命令尚未提交：${describeLiveError(caught).message}`);
        const [currentDate, currentTimezone] = queryRef.current.split("|");
        await loadToday(client, currentDate!, currentTimezone!);
      } else if (caught instanceof RelayApiError && caught.problem.status < 500 && caught.problem.code !== "COMMAND_ID_REUSED") {
        pendingRef.current = null; setPending(null); setFailedCommandId(command.id);
        setActionError(`${describeLiveError(caught).message} 原 command_id：${command.id}。保留表单；请核对最新修订后明确重新提交。`);
        if (caught.problem.code === "REVISION_CONFLICT") {
          const [currentDate, currentTimezone] = queryRef.current.split("|");
          await loadToday(client, currentDate!, currentTimezone!);
        }
      } else {
        setActionError(`命令响应不明：${describeLiveError(caught).message} 请查询原 command_id，不要生成新命令。`);
      }
    } finally { if (scope === viewScope.current) setSubmitting(false); }
  }

  async function checkReceipt() {
    const command = pendingRef.current;
    if (client === null || command === null || submitting) return;
    const scope = viewScope.current;
    setSubmitting(true); setActionError(null);
    try {
      const receipt = await client.getCommandReceipt(command.id);
      if (scope !== viewScope.current) return;
      if (receipt.commandId !== command.id || receipt.commandType !== commandType(command)) {
        throw new Error("原命令回执的 ID 或类型不匹配，仍需核对。");
      }
      confirmResult(receipt, command);
      pendingRef.current = null; setPending(null); setMayRetry(false);
      setMessage("提交回执已核对，今日安排已更新。"); setLastReceiptId(command.id);
      const [currentDate, currentTimezone] = queryRef.current.split("|");
      await loadToday(client, currentDate!, currentTimezone!);
    } catch (caught) {
      if (scope !== viewScope.current) return;
      if (caught instanceof RelayApiError && caught.problem.code === "COMMAND_NOT_FOUND") {
        setMayRetry(true);
        setActionError(`原 command_id ${command.id} 暂未查到回执；可用同一 ID 和原内容重试。`);
      } else setActionError(`原 command_id ${command.id} 仍未核对：${describeLiveError(caught).message}`);
    } finally { if (scope === viewScope.current) setSubmitting(false); }
  }

  const current = snapshot?.date === date && snapshot.timezone === timezone ? snapshot : null;
  const busy = submitting || pending !== null || loading;
  const waitingOther = current?.waitingItems.filter((item) => !current.blockedPinnedItems.some((blocked) => blocked.taskId === item.taskId)) ?? [];
  const weekday = new Intl.DateTimeFormat("zh-CN", { timeZone: timezone, weekday: "long" }).format(new Date(`${date}T12:00:00`));
  const focusTaskId = current?.focus?.targetKind === "TASK" ? current.focus.targetId : null;
  const focusTask = focusTaskId
    ? [...(current?.eligibleItems ?? []), ...(current?.waitingItems ?? [])].find((item) => item.taskId === focusTaskId) ?? null
    : null;
  const allEmpty = current !== null && current.eligibleItems.length === 0
    && current.blockedPinnedItems.length === 0 && waitingOther.length === 0;
  const hasCandidates = current !== null && current.eligibleItems.length > 0;

  function select(item: RelayTodayItem, pin: boolean, laterLocalDate: string | null, laterTimezone: string | null) {
    if (!current || busy) return;
    void sendFrozen({ kind: "selection", id: createCommandId(), expectedRevision: current.selectionRevision,
      queryDate: date, queryTimezone: timezone, projectId: item.projectId,
      taskId: item.taskId, pin, laterLocalDate, timezone: laterTimezone });
  }
  function focus(item: RelayTodayItem) {
    if (!current || busy) return;
    void sendFrozen({ kind: "focus", id: createCommandId(), expectedRevision: current.selectionRevision,
      queryDate: date, queryTimezone: timezone, projectId: item.projectId,
      date, timezone, targetKind: "TASK", targetId: item.taskId });
  }
  function clearFocus() {
    if (!current || !current.focus || busy) return;
    void sendFrozen({ kind: "focus", id: createCommandId(), expectedRevision: current.selectionRevision,
      queryDate: date, queryTimezone: timezone, date: current.focus.date,
      timezone: current.focus.timezone, targetKind: null, targetId: null });
  }
  function plan(item: RelayTodayItem, priority: RelayTodayPriority | null, dueLocalDate: string | null, dueTimezone: string | null) {
    if (!current || busy) return;
    void sendFrozen({ kind: "planning", id: createCommandId(), expectedRevision: item.taskRevision,
      queryDate: date, queryTimezone: timezone, projectId: item.projectId,
      taskId: item.taskId, priority, dueLocalDate, timezone: dueTimezone });
  }
  function applyTimezone(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next = timezoneDraft.trim();
    if (!validTimezone(next)) { setTimezoneError("请输入有效 IANA 时区，如 Asia/Shanghai。"); return; }
    setTimezoneError(null);
    setTimezone(next);
    setZoneEditorOpen(false);
    zoneSummaryRef.current?.focus();
  }
  function cancelTimezoneEdit() {
    setTimezoneDraft(timezone);
    setTimezoneError(null);
    setZoneEditorOpen(false);
    zoneSummaryRef.current?.focus();
  }
  function renderList(items: readonly RelayTodayItem[], eligible: boolean) {
    return <ul className="today-list">{items.map((item) => <TodayTask key={`${date}|${timezone}|${item.taskId}`} item={item}
      eligible={eligible} busy={busy} queryTimezone={timezone} queryDate={date}
      projectTitle={item.projectId ? projectTitles[item.projectId] ?? null : null}
      onSelection={select} onFocus={focus} onPlanning={plan} />)}</ul>;
  }
  function renderGroup(title: string, count: number, list: readonly RelayTodayItem[], eligible: boolean) {
    if (count === 0) return <p className="today-group__empty">{title} · 0 项</p>;
    return <section className="today-group"><h2>{title} · {count}</h2>{renderList(list, eligible)}</section>;
  }

  return <section className="today-page">
    <p className="eyebrow">{date} · {weekday}</p>
    <h1>把今天留给重要的事</h1>
    <p className="page-lede">从上次停下的地方，继续推进。</p>
    <p className="page-note">置顶和今日焦点帮助安排今天；受阻任务需先处理阻碍。<details className="today-arrange-note">
      <summary>安排说明</summary>
      <p>任务能否开始、如何排序由服务端按当前事实判定；置顶、延后和今日焦点只表达你的安排，不会绕过任务准入。等待中的任务里，已置顶的会单独列在「已置顶，待处理」。</p>
      <p>跨项目的人工待处理事项在 <Link to="/tasks?tab=attention">人工待处理</Link> 列表中查看。</p>
      {current && <p>当前选择版本 v{current.selectionRevision}。</p>}
    </details></p>
    {client === null ? <div className="warning-callout" role="status">当前为示例数据预览，没有真实 Today 投影。<Link to="/projects">打开项目</Link> 或 <Link to="/tasks">打开任务</Link> 继续人工工作。</div> : <>
      <div className="today-query" data-testid="today-query">
        <label className="today-query__field"><span className="today-query__label">日期</span>
          <input type="date" value={date} onChange={(event) => { if (event.target.value) setDate(event.target.value); }} /></label>
        <div className="today-query__timezone">
          <span className="today-query__label">时区</span>
          <span className="today-query__zone">{timezone}</span>
          <button className="today-query__adjust-toggle" type="button" aria-expanded={zoneEditorOpen}
            ref={zoneSummaryRef}
            onClick={() => { if (zoneEditorOpen) cancelTimezoneEdit(); else { setTimezoneDraft(timezone); setTimezoneError(null); setZoneEditorOpen(true); } }}>调整时区</button>
        </div>
        <button className="secondary-button" type="button" disabled={loading} onClick={() => { void loadToday(client, date, timezone); }}>刷新</button>
        {loading && <p role="status" className="today-query__status">{current ? "正在刷新…" : "正在读取…"}</p>}
        {zoneEditorOpen && <form className="today-query__editor" onSubmit={applyTimezone}>
          <label><span>IANA 时区</span>
            <input value={timezoneDraft} onChange={(event) => setTimezoneDraft(event.target.value)} aria-label="时区名称" /></label>
          <button className="secondary-button" type="submit">应用</button>
          <button className="text-button" type="button" onClick={cancelTimezoneEdit}>取消</button>
          {timezoneError && <p className="action-error" role="alert">{timezoneError}</p>}
        </form>}
      </div>
      {readError && <p className="action-error" role="alert">读取失败：{readError}</p>}
      {message && <div className="success-callout" role="status">{message}
        {lastReceiptId && <details className="today-receipt-note"><summary>核对信息</summary>
          <p>原 command_id：{lastReceiptId}</p></details>}</div>}
      {actionError && <p className="action-error" role="alert">{actionError}</p>}
      {failedCommandId && <p className="helper-text">上次失败命令 ID：{failedCommandId}</p>}
      {pending && <div className="warning-callout" data-testid="today-pending"><strong>提交结果待核对</strong>
        <p>原 command_id：{pending.id}；expected_revision：{pending.expectedRevision}。保留原内容与 ID，不提交其他 Today 变更。</p>
        <p>原内容：{commandSummary(pending)}。</p>
        <button className="secondary-button" type="button" disabled={submitting} onClick={() => { void checkReceipt(); }}>查询原命令回执</button>
        {mayRetry && <button className="secondary-button" type="button" disabled={submitting} onClick={() => { void sendFrozen(pending, true); }}>用原 ID 和内容重试</button>}
      </div>}
      {loading && current === null && <p className="today-loading" role="status">正在读取今日安排…</p>}
      {current && <>
        <div className="today-focus" data-testid="today-focus">
          <h2>今日焦点</h2>
          {current.focus ? (focusTask
            ? <div className="today-focus__target">
              <p className="today-focus__project">{focusTask.projectId
                ? <>项目：<Link to={`/projects/${focusTask.projectId}/tasks`}>{projectTitles[focusTask.projectId] ?? "所属项目"}</Link></>
                : "未归属项目的人工任务"}</p>
              <p className="today-focus__title"><Link to={`/tasks/${focusTask.taskId}`}>{focusTask.title}</Link></p>
              <p className="today-focus__meta">{taskStatusLabels[focusTask.status] ?? focusTask.status}
                {focusTask.priority && <> · 优先级 {priorityLabels[focusTask.priority] ?? focusTask.priority}</>}
                {focusTask.dueLocalDate && <> · 截止 {focusTask.dueLocalDate}</>}</p>
              <div className="today-focus__actions">
                <Link className="inline-link" to={`/tasks/${focusTask.taskId}`}>打开任务</Link>
                <button className="text-button" type="button" disabled={busy} onClick={clearFocus}>清除今日焦点</button>
              </div>
            </div>
            : <div className="today-focus__target">
              <p className="today-focus__missing">所选焦点任务不在当前查询结果中，本次未参与排序；下方不因此显示可执行状态。</p>
              <details className="today-task__trace"><summary>焦点详情</summary>
                <p>目标：{current.focus.targetKind} {current.focus.targetId}</p>
                <p>选择原时区：{current.focus.timezone}；查询时区：{current.timezone}；{current.focus.activeInQuery ? "本次查询生效" : "本次查询不生效"}。</p>
              </details>
              <div className="today-focus__actions">
                <button className="text-button" type="button" disabled={busy} onClick={clearFocus}>清除今日焦点</button>
              </div>
            </div>)
            : <p className="today-focus__empty">还未选择今日焦点。{hasCandidates
              ? "可从下方任务中选择一件最重要的事。"
              : "创建或查看任务后，可在这里置顶今天最重要的一件事。"}</p>}
          {current.focus && <details className="today-task__trace today-focus__facts"><summary>焦点详情</summary>
            <p>选择原时区：{current.focus.timezone}；查询时区：{current.timezone}；{current.focus.activeInQuery ? "本次查询生效" : "本次查询不生效"}。</p>
            <p>{current.focusHasEligibleCandidate ? "今日焦点有符合资格的任务" : "当前没有符合今日焦点资格的任务"}；焦点不改变任务资格。</p>
          </details>}
        </div>
        <aside className="today-review-entry" data-testid="today-review-entry">
          <div className="today-review-entry__copy">
            <h2>待审与人工判断</h2>
            <p>需要人工验收、动作批准或决定的事项集中在待审中心逐项处理。今日页只帮你安排任务，不在此完成判断，也不会改变待审状态。</p>
          </div>
          <Link className="secondary-button" to="/reviews">打开待审中心</Link>
        </aside>
        {allEmpty
          ? <div className="today-empty" data-testid="today-empty">
            <p className="today-empty__title">当前日期下没有可安排的任务。</p>
            <p className="today-empty__hint">这一天没有符合条件的人工任务；可创建新任务，或查看其他日期。</p>
            <div className="today-empty__actions">
              <Link className="primary-button" to="/tasks?view=create">新建任务</Link>
              <Link className="secondary-button" to="/tasks">查看全部任务</Link>
            </div>
          </div>
          : <>
            {renderGroup("可开始或继续", current.eligibleItems.length, current.eligibleItems, true)}
            {renderGroup("已置顶，待处理", current.blockedPinnedItems.length, current.blockedPinnedItems, false)}
            {renderGroup("其他等待", waitingOther.length, waitingOther, false)}
          </>}
      </>}
    </>}
  </section>;
}
