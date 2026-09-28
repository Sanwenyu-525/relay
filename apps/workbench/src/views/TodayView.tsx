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

function TodayTask({ item, eligible, busy, queryTimezone, queryDate, onSelection, onFocus, onPlanning }: {
  item: RelayTodayItem; eligible: boolean; busy: boolean; queryTimezone: string; queryDate: string;
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
    if (!laterDate || !validTimezone(laterZone)) { setFieldError("Later 需要有效日期和 IANA 时区。"); return; }
    setFieldError(null);
    onSelection(item, item.pin, laterDate, laterZone);
  }

  function submitPlanning(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (dueDate && !validTimezone(dueZone)) { setFieldError("截止日期需要有效 IANA 时区。"); return; }
    setFieldError(null);
    onPlanning(item, priority || null, dueDate || null, dueDate ? dueZone : null);
  }

  return <li className="today-task">
    <div className="today-task-heading"><div><Link to={`/tasks/${item.taskId}`}>{item.title}</Link>
      <span className="today-task-meta">{taskStatusLabels[item.status]} · Task revision v{item.taskRevision}{item.projectId && <> · <Link to={`/projects/${item.projectId}/tasks`}>所属项目</Link></>}</span></div>
      <span className={eligible ? "today-eligibility today-eligibility--ready" : "today-eligibility"}>{eligible ? "服务端判定可开始/继续" : "当前不可开始"}</span></div>
    <p className="today-task-facts">优先级：{item.priority ?? "未设"}；截止：{item.dueLocalDate ? `${item.dueLocalDate}（${item.timezone}）` : "未设"}；
      Pin：{item.pin ? "是" : "否"}；Later：{item.laterLocalDate ? `${item.laterLocalDate}（${item.laterTimezone}）` : "未设"}</p>
    <div className="today-task-actions">
      {eligible && actions.has("START") && <Link className="inline-link" to={`/tasks/${item.taskId}`}>打开任务并确认开始</Link>}
      {actions.has(item.pin ? "UNPIN" : "PIN") && <button className="secondary-button" type="button" disabled={busy}
        onClick={() => onSelection(item, !item.pin, item.laterLocalDate, item.laterTimezone)}>{item.pin ? "取消 Pin" : "Pin"}</button>}
      {actions.has("SET_FOCUS") && <button className="secondary-button" type="button" disabled={busy} onClick={() => onFocus(item)}>设为本日 Focus</button>}
      {actions.has("CLEAR_LATER") && <button className="secondary-button" type="button" disabled={busy}
        onClick={() => onSelection(item, item.pin, null, null)}>清除 Later</button>}
    </div>
    <div className="today-task-forms">
      {actions.has("SET_LATER") && <form onSubmit={submitLater}>
        <strong>Later</strong><label>日期<input type="date" value={laterDate} onChange={(event) => setLaterDate(event.target.value)} min={queryDate} disabled={busy} required /></label>
        <label>时区<input value={laterZone} onChange={(event) => setLaterZone(event.target.value)} disabled={busy} required /></label>
        <button className="secondary-button" type="submit" disabled={busy}>保存 Later</button>
      </form>}
      <form onSubmit={submitPlanning}>
        <strong>任务计划</strong><label>优先级<select value={priority} onChange={(event) => setPriority(event.target.value as RelayTodayPriority | "") } disabled={busy}>
          <option value="">未设</option><option value="LOW">LOW</option><option value="NORMAL">NORMAL</option><option value="HIGH">HIGH</option></select></label>
        <label>截止日期<input type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} disabled={busy} /></label>
        <label>截止时区<input value={dueZone} onChange={(event) => setDueZone(event.target.value)} disabled={busy || !dueDate} /></label>
        <button className="secondary-button" type="submit" disabled={busy}>保存计划</button>
      </form>
    </div>
    {fieldError && <p className="action-error" role="alert">{fieldError}</p>}
    <details><summary>排序依据、证据与允许操作</summary><p>依据：{item.reasonCodes.length ? item.reasonCodes.join(" · ") : "服务端未给出 reason_codes"}</p>
      <p>证据：{item.evidenceRefs.length ? item.evidenceRefs.join(" · ") : "服务端未给出 evidence_refs"}</p>
      <p>允许操作：{item.allowedActions.length ? item.allowedActions.join(" · ") : "无"}</p></details>
  </li>;
}

export default function TodayView() {
  const connection = useRelayConnection();
  const client = connection.mode === "live" ? connection.client : null;
  const initialTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const [date, setDate] = useState(() => localDate(initialTimezone));
  const [timezone, setTimezone] = useState(initialTimezone);
  const [timezoneDraft, setTimezoneDraft] = useState(initialTimezone);
  const [snapshot, setSnapshot] = useState<RelayToday | null>(null);
  const [loading, setLoading] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [pending, setPending] = useState<TodayCommand | null>(null);
  const [mayRetry, setMayRetry] = useState(false);
  const [failedCommandId, setFailedCommandId] = useState<string | null>(null);
  const [timezoneError, setTimezoneError] = useState<string | null>(null);
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
    return () => { viewScope.current++; requestVersion.current++; pendingRef.current = null; };
  }, [client, connection.epoch]);
  useEffect(() => {
    if (client !== null) void loadToday(client, date, timezone);
    return () => { requestVersion.current++; };
  }, [client, date, timezone, connection.epoch]);

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
      pendingRef.current = null; setPending(null); setMessage(`原 command_id ${command.id} 已由服务端确认；正在重读 Today。`);
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
      setMessage(`原 command_id ${command.id} 的提交回执已确认；正在重读 Today。`);
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
    setTimezoneError(null); setTimezone(next);
  }
  function renderList(items: readonly RelayTodayItem[], eligible: boolean) {
    return items.length ? <ul className="today-list">{items.map((item) => <TodayTask key={`${date}|${timezone}|${item.taskId}`} item={item}
      eligible={eligible} busy={busy} queryTimezone={timezone} queryDate={date}
      onSelection={select} onFocus={focus} onPlanning={plan} />)}</ul>
      : <p className="helper-text">当前查询中没有此类任务。</p>;
  }

  return <section className="today-page">
    <p className="eyebrow">今日</p><h1>Today</h1>
    <p className="page-lede">任务资格、排序与依据由服务端给出。Pin、Later、Focus 是用户选择，不会跳过任务准入。</p>
    <p className="helper-text"><Link to="/tasks?tab=attention">查看跨项目人工待处理</Link>。Later 与 Focus 不会处理或隐藏待审决定；Today 仍按服务端资格展示任务。</p>
    {client === null ? <div className="warning-callout" role="status">当前为示例数据预览，没有真实 Today 投影。<Link to="/projects">打开项目</Link> 或 <Link to="/tasks">打开任务</Link> 继续人工工作。</div> : <>
      <div className="surface-panel today-query"><label>查询日期<input type="date" value={date} onChange={(event) => { if (event.target.value) setDate(event.target.value); }} /></label>
        <form onSubmit={applyTimezone}><label>查询时区（IANA）<input value={timezoneDraft} onChange={(event) => setTimezoneDraft(event.target.value)} /></label>
          <button className="secondary-button" type="submit">应用时区</button></form>
        <button className="secondary-button" type="button" disabled={loading} onClick={() => { void loadToday(client, date, timezone); }}>刷新</button>
        {timezoneError && <p className="action-error" role="alert">{timezoneError}</p>}</div>
      {loading && <p role="status">正在读取 {date} · {timezone} 的服务端 Today…</p>}
      {readError && <p className="action-error" role="alert">读取失败：{readError}</p>}
      {message && <p className="success-callout" role="status">{message}</p>}
      {actionError && <p className="action-error" role="alert">{actionError}</p>}
      {failedCommandId && <p className="helper-text">上次失败命令 ID：{failedCommandId}</p>}
      {pending && <div className="warning-callout" data-testid="today-pending"><strong>提交结果待核对</strong>
        <p>原 command_id：{pending.id}；expected_revision：{pending.expectedRevision}。保留原内容与 ID，不提交其他 Today 变更。</p>
        <p>原内容：{commandSummary(pending)}。</p>
        <button className="secondary-button" type="button" disabled={submitting} onClick={() => { void checkReceipt(); }}>查询原命令回执</button>
        {mayRetry && <button className="secondary-button" type="button" disabled={submitting} onClick={() => { void sendFrozen(pending, true); }}>用原 ID 和内容重试</button>}
      </div>}
      {current && <>
        <div className="surface-panel today-focus"><div><h2>Focus</h2><p>查询：{current.date} · {current.timezone}；选择版本 v{current.selectionRevision}</p></div>
          {current.focus ? <div><p>已选 {current.focus.targetKind}：{current.focus.targetId}</p>
            <p>选择原时区：{current.focus.timezone}；查询时区：{current.timezone}；{current.focus.activeInQuery ? "本次查询生效" : "本次查询不生效"}。</p>
            <p>{current.focusHasEligibleCandidate ? "有符合 Focus 的可执行任务" : "当前没有符合 Focus 的可执行任务"}；Focus 不改变资格。</p>
            <button className="secondary-button" type="button" disabled={busy} onClick={clearFocus}>清除本日 Focus</button></div>
            : <p>本日尚未选择 Focus。可在任务行明确设置。</p>}</div>
        <section className="today-group"><h2>可开始或继续 · {current.eligibleItems.length}</h2>{renderList(current.eligibleItems, true)}</section>
        <section className="today-group"><h2>Pin 但仍受阻 · {current.blockedPinnedItems.length}</h2>
          <p className="helper-text">这组是等待任务的子集，Pin 不改变服务端准入。</p>{renderList(current.blockedPinnedItems, false)}</section>
        <section className="today-group"><h2>其他等待 · {waitingOther.length}</h2>
          <p className="helper-text">等待总数 {current.waitingItems.length}，其中 {current.blockedPinnedItems.length} 项已在上方显示。</p>{renderList(waitingOther, false)}</section>
      </>}
    </>}
  </section>;
}
