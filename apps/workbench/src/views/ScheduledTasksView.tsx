import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Info } from "lucide-react";
import PageHeader from "../components/PageHeader";
import { createCommandId, type RelayScheduledTask, type RelayScheduledTaskStatus } from "../api/relayClient";
import { describeLiveError } from "../lib/liveErrors";
import { liveClient, useRelayConnection } from "../lib/relayConnection";
import "./ScheduledTasksView.css";

const statusLabels: Record<RelayScheduledTaskStatus, string> = {
  ENABLED: "启用中", PAUSED: "已暂停", DISABLED: "已停用", EXPIRED: "已到期",
};

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
  const version = useRef(0);
  const disposed = useRef(false);

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

  async function changeStatus(task: RelayScheduledTask, status: "ENABLED" | "PAUSED" | "DISABLED") {
    const client = liveClient();
    if (!client || busyId !== null) return;
    const reason = status === "ENABLED" ? "用户在定时任务列表恢复调度"
      : status === "PAUSED" ? "用户在定时任务列表暂停调度" : "用户在定时任务列表停用调度";
    setBusyId(task.scheduledTaskId); setNotice(null);
    try {
      await client.setScheduledTaskStatus({
        commandId: createCommandId(), scheduledTaskId: task.scheduledTaskId,
        expectedRevision: task.revision, status, reason,
      });
      await load();
      setNotice(status === "ENABLED" ? "已恢复调度。" : status === "PAUSED" ? "已暂停：不会再产生新的触发。" : "已停用：不会再产生新的触发。");
    } catch (caught) {
      setError(`状态修改失败：${describeLiveError(caught).message}`);
    } finally {
      if (!disposed.current) setBusyId(null);
    }
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
              {task.status === "ENABLED" && <button className="text-button" type="button" disabled={busyId !== null}
                onClick={() => void changeStatus(task, "PAUSED")}>暂停</button>}
              {task.status === "PAUSED" && <button className="text-button" type="button" disabled={busyId !== null}
                onClick={() => void changeStatus(task, "ENABLED")}>继续</button>}
              {task.status !== "DISABLED" && task.status !== "EXPIRED" && <button className="text-button" type="button" disabled={busyId !== null}
                onClick={() => void changeStatus(task, "DISABLED")}>停用</button>}
            </td>
          </tr>)}</tbody>
        </table>
      </section>}
    </div>
  </div>;
}
