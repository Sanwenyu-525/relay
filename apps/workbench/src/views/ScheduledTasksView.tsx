import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Info } from "lucide-react";
import PageHeader from "../components/PageHeader";
import { createCommandId, RelayApiError, type RelayScheduledTask, type RelayScheduledTaskStatus,
  type RelayScheduledTaskStatusInput } from "../api/relayClient";
import { clearDraftGuard, setDraftGuard, type DraftGuard } from "../lib/draftGuard";
import { describeLiveError, needsReceiptCheck } from "../lib/liveErrors";
import { liveClient, useRelayConnection } from "../lib/relayConnection";
import "./ScheduledTasksView.css";

const statusLabels: Record<RelayScheduledTaskStatus, string> = {
  ENABLED: "启用中", PAUSED: "已暂停", DISABLED: "已停用", EXPIRED: "已到期",
};

/** 结果未知时冻结的状态变更：命令 ID、载荷与发起时的 API/Workspace 必须一起保留。 */
interface PendingStatusChange {
  readonly input: RelayScheduledTaskStatusInput;
  readonly scope: string;
}

function clientScope(client: NonNullable<ReturnType<typeof liveClient>>): string {
  return `${client.baseUrl}\n${client.workspaceId}`;
}

export function describeRepeat(task: RelayScheduledTask): string {
  if (task.repeat.kind === "DAILY") return task.repeat.intervalDays === 1 ? "每天" : `每 ${task.repeat.intervalDays} 天`;
  const names = ["", "周一", "周二", "周三", "周四", "周五", "周六", "周日"];
  return `每周 ${task.repeat.weekdays.map((day) => names[day]).join("、")}`;
}

/** 按任务自身时区显示，避免浏览器时区把「每天 09:00」显示成别的钟点。 */
export function formatInZone(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(iso));
}

export default function ScheduledTasksView() {
  const connection = useRelayConnection();
  const [items, setItems] = useState<readonly RelayScheduledTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingStatusChange | null>(null);
  const [pendingNote, setPendingNote] = useState<string | null>(null);
  const [mayRetry, setMayRetry] = useState(false);
  const pendingRef = useRef<PendingStatusChange | null>(null);
  const holdPending = (next: PendingStatusChange | null) => {
    pendingRef.current = next; setPending(next); setPendingNote(null);
  };
  const version = useRef(0);
  const disposed = useRef(false);
  const frozen = busyId !== null || pending !== null;

  const guard = useRef<DraftGuard>({
    // 本页没有可丢弃的草稿：未决命令只能靠核对回执收口，不能靠离页丢掉。
    hasUnsavedChanges: () => pendingRef.current !== null,
    discard: () => {},
    pendingCommandId: () => pendingRef.current?.input.commandId ?? null
  });
  useEffect(() => {
    setDraftGuard(guard.current);
    return () => clearDraftGuard(guard.current);
  }, []);

  const load = useCallback(async () => {
    const client = liveClient();
    const token = ++version.current;
    setLoading(true);
    if (!client) { setItems([]); setError("未连接本机 API：定时任务需要读取真实数据。"); setLoading(false); return; }
    try {
      const next = await client.getScheduledTasks();
      if (token !== version.current || disposed.current) return;
      setItems(next); setError(null);
    } catch (caught) {
      if (token !== version.current || disposed.current) return;
      setItems([]); setError(describeLiveError(caught).message);
    } finally {
      if (token === version.current && !disposed.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    disposed.current = false;
    void load();
    return () => { disposed.current = true; version.current++; };
  }, [load, connection.epoch, connection.mode]);

  const successNotice = (status: RelayScheduledTaskStatusInput["status"]) =>
    status === "ENABLED" ? "已恢复调度。"
      : status === "PAUSED" ? "已暂停：不会再产生新的触发。" : "已停用：不会再产生新的触发。";

  /** 发送一份冻结的状态变更：结果未知就保留原命令与载荷，明确业务拒绝才解锁。 */
  async function sendChange(client: NonNullable<ReturnType<typeof liveClient>>, input: RelayScheduledTaskStatusInput) {
    setBusyId(input.scheduledTaskId); setNotice(null); setError(null);
    try {
      await client.setScheduledTaskStatus(input);
      await load();
      holdPending(null); setMayRetry(false);
      setNotice(successNotice(input.status));
    } catch (caught) {
      if (disposed.current) return;
      const described = describeLiveError(caught);
      if (needsReceiptCheck(caught)) {
        holdPending({ input, scope: clientScope(client) }); setMayRetry(false);
        setError(`状态修改结果未确认：${described.message}`);
        return;
      }
      holdPending(null); setMayRetry(false);
      setError(`状态修改失败：${described.message}`);
    } finally {
      if (!disposed.current) setBusyId(null);
    }
  }

  async function changeStatus(task: RelayScheduledTask, status: "ENABLED" | "PAUSED" | "DISABLED") {
    const client = liveClient();
    if (!client || frozen || pendingRef.current !== null) return;
    const reason = status === "ENABLED" ? "用户在定时任务列表恢复调度"
      : status === "PAUSED" ? "用户在定时任务列表暂停调度" : "用户在定时任务列表停用调度";
    await sendChange(client, {
      commandId: createCommandId(), scheduledTaskId: task.scheduledTaskId,
      expectedRevision: task.revision, status, reason,
    });
  }

  async function checkReceipt() {
    const held = pendingRef.current;
    const client = liveClient();
    if (client === null || held === null || busyId !== null) return;
    if (held.scope !== clientScope(client)) {
      setPendingNote("原命令属于之前的 API 或 Workspace：当前连接不同，请切回原连接后再查询回执，不要在新连接下重新提交。");
      return;
    }
    setBusyId(held.input.scheduledTaskId);
    try {
      const receipt = await client.getCommandReceipt(held.input.commandId);
      if (receipt.commandId !== held.input.commandId || receipt.commandType !== "SetScheduledTaskStatus"
        || receipt.result.scheduled_task_id !== held.input.scheduledTaskId) {
        throw new Error("原命令回执的 ID、类型或定时任务不匹配，仍需核对。");
      }
      await load();
      holdPending(null); setMayRetry(false);
      setNotice(successNotice(held.input.status));
    } catch (caught) {
      if (disposed.current) return;
      if (caught instanceof RelayApiError && caught.problem.code === "COMMAND_NOT_FOUND") {
        setMayRetry(true);
        setPendingNote("原命令暂未查到回执；未确认前不要重复提交，可确认原内容后按同一 ID 重试。");
      } else setPendingNote(`原命令仍未核对：${describeLiveError(caught).message}`);
    } finally {
      if (!disposed.current) setBusyId(null);
    }
  }

  async function retryOriginal() {
    const held = pendingRef.current;
    const client = liveClient();
    if (client === null || held === null || busyId !== null) return;
    if (held.scope !== clientScope(client)) {
      setPendingNote("原命令属于之前的 API 或 Workspace：当前连接不同，不能在这里重试；请切回原连接。");
      return;
    }
    await sendChange(client, held.input);
  }

  return <div className="page-layout scheduled-tasks-page">
    <div className="page-primary">
      <PageHeader testId="scheduled-tasks-head" title="定时任务" meta="到点自动创建并启动任务"
        lede="按天或按周重复：每次到点新建一个任务并交给 AI 执行。上一轮没有验收时，本轮不会启动。" />
      <div className="form-actions">
        <Link className="primary-button" to="/scheduled-tasks?view=create" data-testid="scheduled-tasks-create">新建定时任务</Link>
        <button className="secondary-button" type="button" onClick={() => void load()} disabled={loading}>刷新</button>
      </div>
      <p className="helper-text" data-testid="scheduled-tasks-scope"><Info aria-hidden="true" />
        只在应用运行期间生效：关闭应用后不会触发，错过的时段只形成一条待处理，由你决定是否补跑。</p>
      {loading && <p role="status">正在读取定时任务…</p>}
      {error && <p className="action-error" role="alert">{error}</p>}
      {notice && <p className="receipt-message" role="status">{notice}</p>}
      {pending && <div className="warning-callout" role="alert" data-testid="scheduled-status-pending">
        <Info aria-hidden="true" />
        <div>
          <p>状态修改结果未确认，本次提交是否生效尚未确定。原 command_id：<code>{pending.input.commandId}</code>。
            先查询回执；在确认之前不要重复提交，其它操作也已禁用。</p>
          {pendingNote && <p>{pendingNote}</p>}
          <div className="form-actions">
            <button className="secondary-button" type="button" disabled={busyId !== null}
              onClick={() => void checkReceipt()}>核对原命令回执</button>
            {mayRetry && <button className="secondary-button" type="button" disabled={busyId !== null}
              onClick={() => void retryOriginal()}>按原 ID 重试同一变更</button>}
          </div>
        </div>
      </div>}
      {!loading && !error && items.length === 0 && <section className="surface-panel" data-testid="scheduled-tasks-empty">
        <h2>还没有定时任务</h2>
        <p>新建一条：选定项目、写下这次要完成什么、设置重复规则与执行次数上限。</p>
      </section>}
      {items.length > 0 && <section className="surface-panel" aria-label="定时任务列表">
        <table className="data-table" data-testid="scheduled-tasks-table">
          <thead><tr><th scope="col">定时任务</th><th scope="col">项目</th><th scope="col">重复</th>
            <th scope="col">下次触发</th><th scope="col">已执行</th><th scope="col">状态</th><th scope="col">操作</th></tr></thead>
          <tbody>{items.map((task) => <tr key={task.scheduledTaskId} data-testid={`scheduled-task-row-${task.scheduledTaskId}`}>
            <td><Link className="text-link" to={`/scheduled-tasks/${task.scheduledTaskId}`}>{task.title}</Link>
              <small>{task.localTime} · {task.timezone}</small></td>
            <td>{task.project?.title ?? task.projectId}</td>
            <td>{describeRepeat(task)}</td>
            <td>{task.nextDueAt === null ? "—" : formatInZone(task.nextDueAt, task.timezone)}</td>
            <td>{task.runsStarted} / {task.maxRuns}</td>
            <td><span className={`status-chip status-chip--${task.status.toLowerCase()}`}>{statusLabels[task.status]}</span></td>
            <td className="scheduled-task-actions">
              {task.status === "ENABLED" && <button className="text-button" type="button" disabled={frozen}
                onClick={() => void changeStatus(task, "PAUSED")}>暂停</button>}
              {task.status === "PAUSED" && <button className="text-button" type="button" disabled={frozen}
                onClick={() => void changeStatus(task, "ENABLED")}>继续</button>}
              {task.status !== "DISABLED" && task.status !== "EXPIRED" && <button className="text-button" type="button" disabled={frozen}
                onClick={() => void changeStatus(task, "DISABLED")}>停用</button>}
            </td>
          </tr>)}</tbody>
        </table>
      </section>}
    </div>
  </div>;
}

