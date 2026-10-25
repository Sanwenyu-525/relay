import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Info } from "lucide-react";
import PageHeader from "../components/PageHeader";
import { createCommandId, RelayApiError, type RelayScheduledTaskDetail,
  type RelayScheduledTaskOccurrence, type RelayScheduledTaskOccurrenceResolution,
  type RelayScheduledTaskStatusInput } from "../api/relayClient";
import { clearDraftGuard, setDraftGuard, type DraftGuard } from "../lib/draftGuard";
import { describeLiveError, needsReceiptCheck } from "../lib/liveErrors";
import { liveClient, useRelayConnection } from "../lib/relayConnection";
import { describeRepeat, formatInZone } from "./ScheduledTasksView";
import "./ScheduledTasksView.css";

/** 结果未知时冻结的那一条命令：状态变更与时段处理共用同一个待核对位。 */
type FrozenCommand = { readonly kind: "status"; readonly input: RelayScheduledTaskStatusInput }
  | { readonly kind: "resolve"; readonly input: RelayScheduledTaskOccurrenceResolution };

interface PendingCommand {
  readonly command: FrozenCommand;
  readonly scope: string;
}

const occurrenceLabels: Record<RelayScheduledTaskOccurrence["status"], string> = {
  DISPATCHING: "正在启动", DISPATCHED: "已启动", BLOCKED: "待处理", SKIPPED: "已跳过", RESOLVED: "已忽略",
};

/** 已知原因给出可读说明；未知原因原样显示，不假装成成功。 */
const reasonLabels: Record<string, string> = {
  BUDGET_EXHAUSTED: "执行次数已用尽",
  AUTHORIZATION_EXPIRED: "授权已到期",
  MISSED: "应用关闭期间错过，未自动执行",
  PREVIOUS_TASK_NOT_ACCEPTED: "上一轮任务还没有验收",
  SCHEDULE_UNAVAILABLE: "定时任务已不可读取",
  PLAN_NOT_ENABLED: "计划已暂停、停用或到期，这次触发没有启动",
  SCHEDULE_GENERATION_STALE: "规则已变更，这次触发属于旧代次",
  PROJECT_ARCHIVED: "所属项目已归档",
  EXECUTION_SCOPE_DRIFT: "触发时冻结的执行范围已失效",
};

function describeReason(reason: string | null): string {
  if (reason === null) return "—";
  const known = reasonLabels[reason];
  if (known !== undefined) return known;
  const [code, ...rest] = reason.split(": ");
  const label = reasonLabels[code];
  return label === undefined ? reason : `${label}${rest.length === 0 ? "" : `（${rest.join(": ")}）`}`;
}

export default function ScheduledTaskDetailView() {
  const { id = "" } = useParams();
  const connection = useRelayConnection();
  const navigate = useNavigate();
  const [task, setTask] = useState<RelayScheduledTaskDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingCommand | null>(null);
  const [pendingNote, setPendingNote] = useState<string | null>(null);
  const [mayRetry, setMayRetry] = useState(false);
  const pendingRef = useRef<PendingCommand | null>(null);
  const holdPending = (next: PendingCommand | null) => {
    pendingRef.current = next; setPending(next); setPendingNote(null);
  };
  const version = useRef(0);
  const disposed = useRef(false);
  const frozen = busy || pending !== null;

  const guard = useRef<DraftGuard>({
    // 本页没有可丢弃的草稿：未决命令只能靠核对回执收口，不能靠离页丢掉。
    hasUnsavedChanges: () => pendingRef.current !== null,
    discard: () => {},
    pendingCommandId: () => pendingRef.current?.command.input.commandId ?? null
  });
  useEffect(() => {
    setDraftGuard(guard.current);
    return () => clearDraftGuard(guard.current);
  }, []);

  const load = useCallback(async () => {
    const client = liveClient();
    const token = ++version.current;
    if (!client) { setError("未连接本机 API：定时任务需要读取真实数据。"); setLoading(false); return; }
    setLoading(true);
    try {
      const next = await client.getScheduledTask(id);
      if (token !== version.current || disposed.current) return;
      setTask(next); setError(null);
    } catch (caught) {
      if (token !== version.current || disposed.current) return;
      setTask(null); setError(describeLiveError(caught).message);
    } finally {
      if (token === version.current && !disposed.current) setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    disposed.current = false;
    void load();
    return () => { disposed.current = true; version.current++; };
  }, [load, connection.epoch, connection.mode]);

  /** 发送一份冻结的命令：结果未知就保留原命令与载荷，明确业务拒绝才解锁。 */
  async function sendCommand(client: NonNullable<ReturnType<typeof liveClient>>, command: FrozenCommand) {
    setBusy(true); setNotice(null); setError(null);
    try {
      if (command.kind === "status") await client.setScheduledTaskStatus(command.input);
      else await client.resolveScheduledTaskOccurrence(command.input);
      await load();
      holdPending(null); setMayRetry(false);
      setNotice(command.kind === "status" ? "状态已更新。"
        : command.input.action === "RETRY" ? "已登记补跑：下一次扫描会按当前准入重新尝试。" : "这一次时段已忽略。");
    } catch (caught) {
      if (disposed.current) return;
      const described = describeLiveError(caught);
      const label = command.kind === "status" ? "状态修改"
        : command.input.action === "RETRY" ? "补跑" : "忽略";
      if (needsReceiptCheck(caught)) {
        holdPending({ command, scope: `${client.baseUrl}\n${client.workspaceId}` }); setMayRetry(false);
        setError(`${label}结果未确认：${described.message}`);
        return;
      }
      holdPending(null); setMayRetry(false);
      setError(`${label}失败：${described.message}`);
    } finally { if (!disposed.current) setBusy(false); }
  }

  async function changeStatus(status: "ENABLED" | "PAUSED" | "DISABLED") {
    const client = liveClient();
    if (!client || task === null || frozen) return;
    await sendCommand(client, { kind: "status", input: {
      commandId: createCommandId(), scheduledTaskId: task.scheduledTaskId,
      expectedRevision: task.revision, status,
      reason: status === "ENABLED" ? "用户在定时任务详情恢复调度"
        : status === "PAUSED" ? "用户在定时任务详情暂停调度" : "用户在定时任务详情停用调度",
    } });
  }

  async function resolveOccurrence(occurrence: RelayScheduledTaskOccurrence, action: "RETRY" | "DISMISS") {
    const client = liveClient();
    if (!client || frozen) return;
    await sendCommand(client, { kind: "resolve", input: {
      commandId: createCommandId(), occurrenceId: occurrence.occurrenceId,
      expectedRevision: occurrence.revision, action,
      reason: action === "RETRY" ? "用户选择补跑这一次时段" : "用户忽略这一次时段",
    } });
  }

  /** 回执必须落回发起时的那一条命令与那一个对象；对不上就继续待核对，不放行。 */
  async function checkReceipt() {
    const held = pendingRef.current;
    const client = liveClient();
    if (client === null || held === null || busy) return;
    const scope = `${client.baseUrl}\n${client.workspaceId}`;
    if (held.scope !== scope) {
      setPendingNote("原命令属于之前的 API 或 Workspace：当前连接不同，请切回原连接后再查询回执，不要在新连接下重新提交。");
      return;
    }
    const command = held.command;
    const expected = command.kind === "status"
      ? { commandType: "SetScheduledTaskStatus", field: "scheduled_task_id", objectId: command.input.scheduledTaskId }
      : { commandType: "ResolveScheduledTaskOccurrence", field: "occurrence_id", objectId: command.input.occurrenceId };
    setBusy(true);
    try {
      const receipt = await client.getCommandReceipt(command.input.commandId);
      if (receipt.commandId !== command.input.commandId || receipt.commandType !== expected.commandType
        || receipt.result[expected.field] !== expected.objectId) {
        throw new Error("原命令回执的类型或对象不匹配，仍需核对。");
      }
      await load();
      holdPending(null); setMayRetry(false);
      setNotice("已按原命令回执确认这一次提交。");
    } catch (caught) {
      if (disposed.current) return;
      if (caught instanceof RelayApiError && caught.problem.code === "COMMAND_NOT_FOUND") {
        setMayRetry(true);
        setPendingNote("原命令暂未查到回执；未确认前不要重复提交，可确认原内容后按同一 ID 重试。");
      } else setPendingNote(`原命令仍未核对：${describeLiveError(caught).message}`);
    } finally { if (!disposed.current) setBusy(false); }
  }

  async function retryOriginal() {
    const held = pendingRef.current;
    const client = liveClient();
    if (client === null || held === null || busy) return;
    if (held.scope !== `${client.baseUrl}\n${client.workspaceId}`) {
      setPendingNote("原命令属于之前的 API 或 Workspace：当前连接不同，不能在这里重试；请切回原连接。");
      return;
    }
    await sendCommand(client, held.command);
  }

  if (loading) return <div className="page-layout scheduled-tasks-page pv-page"><div className="page-primary">
    <p role="status">正在读取定时任务…</p></div></div>;
  if (task === null) return <div className="page-layout scheduled-tasks-page pv-page"><div className="page-primary">
    <PageHeader testId="scheduled-task-detail-head" title="定时任务" meta="读取失败" lede="这条定时任务当前无法读取。" />
    {error && <p className="action-error" role="alert">{error}</p>}
    <div className="form-actions">
      <Link className="secondary-button" to="/scheduled-tasks">返回列表</Link>
      <button className="secondary-button" type="button" onClick={() => void load()} data-testid="scheduled-task-detail-reread">重新读取</button>
    </div>
  </div></div>;

  // 待处理触发以服务端 pending_occurrences（不受最近 20 条窗口限制）为准，
  // 再并入窗口内仍为 BLOCKED 的时段；按 occurrence_id 去重，避免同一时段出现两次。
  const blocked = (() => {
    const merged = new Map<string, RelayScheduledTaskOccurrence>();
    for (const occurrence of [...task.pendingOccurrences, ...task.occurrences]) {
      if (occurrence.status === "BLOCKED") merged.set(occurrence.occurrenceId, occurrence);
    }
    return [...merged.values()];
  })();
  return <div className="page-layout scheduled-tasks-page pv-page"><div className="page-primary">
    <PageHeader testId="scheduled-task-detail-head" title={task.title} overline="Schedule Details" meta={`定时任务 · ${describeRepeat(task)}`}
      lede={`每次触发新建一个任务并交给 AI 执行；当前时区 ${task.timezone}，本地时刻 ${task.localTime}。`} />
    <div className="form-actions">
      <button className="secondary-button" type="button" onClick={() => void load()} disabled={frozen}>刷新</button>
      <Link className="secondary-button" to={`/scheduled-tasks/${task.scheduledTaskId}/edit`}
        aria-disabled={frozen} onClick={frozen ? (event) => event.preventDefault() : undefined}
        data-testid="scheduled-task-edit-entry">编辑</Link>
      {task.status === "ENABLED" && <button className="secondary-button" type="button" disabled={frozen}
        onClick={() => void changeStatus("PAUSED")}>暂停</button>}
      {(task.status === "PAUSED" || task.status === "EXPIRED") && <button className="secondary-button" type="button" disabled={frozen}
        data-testid="scheduled-task-resume"
        onClick={() => void changeStatus("ENABLED")}>继续</button>}
      {task.status !== "DISABLED" && task.status !== "EXPIRED" && <button className="secondary-button" type="button" disabled={frozen}
        onClick={() => void changeStatus("DISABLED")}>停用</button>}
      <button className="text-button" type="button" onClick={() => navigate("/scheduled-tasks")}>返回列表</button>
    </div>
    {task.status === "EXPIRED" && <p className="warning-callout" role="alert">
      <Info aria-hidden="true" />
      这条定时任务已到期（授权到期或次数用尽），不会产生新的触发。先「编辑」延长授权或提高次数上限——保存后仍保持已到期——
      再回到这里点「继续」显式重新启用。
    </p>}
    {error && <p className="action-error" role="alert">{error}</p>}
    {notice && <p className="receipt-message" role="status">{notice}</p>}
    {pending && <div className="warning-callout" role="alert" data-testid="scheduled-detail-pending">
      <Info aria-hidden="true" />
      <div>
        <p>这一次提交结果未确认，本次提交是否生效尚未确定。原 command_id：<code>{pending.command.input.commandId}</code>。
          先查询回执；在确认之前不要重复提交，同页其它操作也已禁用。</p>
        {pendingNote && <p>{pendingNote}</p>}
        <div className="form-actions">
          <button className="secondary-button" type="button" disabled={busy}
            onClick={() => void checkReceipt()}>核对原命令回执</button>
          {mayRetry && <button className="secondary-button" type="button" disabled={busy}
            onClick={() => void retryOriginal()}>按原 ID 重试同一命令</button>}
        </div>
      </div>
    </div>}

    <section className="surface-panel" aria-label="定时任务设置">
      <h2>设置与授权</h2>
      <dl className="rail-definition-list">
        <div><dt>项目</dt><dd>{task.project?.archived === true ? `${task.project.title}（已归档）` : task.project?.title ?? task.projectId}</dd></div>
        <div><dt>状态</dt><dd>{task.status === "ENABLED" ? "启用中" : task.status === "PAUSED" ? "已暂停" : task.status === "DISABLED" ? "已停用" : "已到期"}</dd></div>
        <div><dt>下次触发</dt><dd>{task.nextDueAt === null ? "—" : formatInZone(task.nextDueAt, task.timezone)}</dd></div>
        <div><dt>已启动次数</dt><dd>{task.runsStarted} / {task.maxRuns}</dd></div>
        <div><dt>授权到期</dt><dd>{formatInZone(task.authorizationExpiresAt, task.timezone)}</dd></div>
        <div><dt>每次任务标题</dt><dd>{task.template.taskTitle}</dd></div>
        <div><dt>每次任务目标</dt><dd>{task.template.objective}</dd></div>
        <div><dt>验收标准</dt><dd>{task.template.criteria.length === 0 ? "—" : task.template.criteria.join("；")}</dd></div>
      </dl>
      <p className="helper-text"><Info aria-hidden="true" />
        上一轮任务进入等待验收后，本轮时段会记「已跳过」；验收或取消后下一轮才会继续启动。关闭应用期间的时段不会自动执行。</p>
    </section>

    {blocked.length > 0 && <section className="surface-panel" aria-label="待处理的触发" data-testid="scheduled-task-blocked">
      <h2>待处理的触发</h2>
      <p className="helper-text">这些时段没有启动。补跑会按当前准入重新尝试；忽略只关掉这一条，不改动后续排期。</p>
      <ul className="data-list">{blocked.map((occurrence) => <li key={occurrence.occurrenceId} className="data-row">
        <span className="data-cell"><strong>{formatInZone(occurrence.dueAt, occurrence.timezone)}</strong>
          <small>{describeReason(occurrence.reason)}</small></span>
        <span className="scheduled-task-actions">
          <button className="text-button" type="button" disabled={frozen} data-testid={`scheduled-task-retry-${occurrence.occurrenceId}`}
            onClick={() => void resolveOccurrence(occurrence, "RETRY")}>补跑一次</button>
          <button className="text-button" type="button" disabled={frozen} data-testid={`scheduled-task-dismiss-${occurrence.occurrenceId}`}
            onClick={() => void resolveOccurrence(occurrence, "DISMISS")}>忽略</button>
        </span>
      </li>)}</ul>
    </section>}

    <section className="surface-panel" aria-label="触发历史" data-testid="scheduled-task-occurrences">
      <h2>触发历史</h2>
      {task.occurrences.length === 0 ? <p>还没有触发记录。</p> : <table className="data-table">
        <thead><tr><th scope="col">时段</th><th scope="col">结果</th><th scope="col">任务 / 执行</th><th scope="col">说明</th></tr></thead>
        <tbody>{task.occurrences.map((occurrence) => <tr key={occurrence.occurrenceId} data-testid={`scheduled-task-occurrence-${occurrence.occurrenceId}`}>
          <td>{formatInZone(occurrence.dueAt, occurrence.timezone)}{occurrence.missed && <small>应用关闭期间错过</small>}</td>
          <td>{occurrenceLabels[occurrence.status]}</td>
          <td>{occurrence.taskId === null ? "—" : <Link className="text-link" to={`/tasks/${occurrence.taskId}`}>{occurrence.taskId.slice(0, 8)}</Link>}
            {occurrence.runId !== null && <> · <Link className="text-link" to={`/runs/${occurrence.runId}`}>执行 {occurrence.runId.slice(0, 8)}</Link></>}</td>
          <td>{describeReason(occurrence.reason)}</td>
        </tr>)}</tbody>
      </table>}
    </section>
  </div></div>;
}
