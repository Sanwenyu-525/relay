import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Info } from "lucide-react";
import PageHeader from "../components/PageHeader";
import { createCommandId, type RelayScheduledTaskDetail, type RelayScheduledTaskOccurrence } from "../api/relayClient";
import { describeLiveError } from "../lib/liveErrors";
import { liveClient, useRelayConnection } from "../lib/relayConnection";
import { describeRepeat, formatInZone } from "./ScheduledTasksView";
import "./ScheduledTasksView.css";

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
  const version = useRef(0);
  const disposed = useRef(false);

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

  async function changeStatus(status: "ENABLED" | "PAUSED" | "DISABLED") {
    const client = liveClient();
    if (!client || task === null || busy) return;
    setBusy(true); setNotice(null);
    try {
      await client.setScheduledTaskStatus({
        commandId: createCommandId(), scheduledTaskId: task.scheduledTaskId,
        expectedRevision: task.revision, status,
        reason: status === "ENABLED" ? "用户在定时任务详情恢复调度"
          : status === "PAUSED" ? "用户在定时任务详情暂停调度" : "用户在定时任务详情停用调度",
      });
      await load();
      setNotice("状态已更新。");
    } catch (caught) {
      setError(`状态修改失败：${describeLiveError(caught).message}`);
    } finally { if (!disposed.current) setBusy(false); }
  }

  async function resolveOccurrence(occurrence: RelayScheduledTaskOccurrence, action: "RETRY" | "DISMISS") {
    const client = liveClient();
    if (!client || busy) return;
    setBusy(true); setNotice(null);
    try {
      await client.resolveScheduledTaskOccurrence({
        commandId: createCommandId(), occurrenceId: occurrence.occurrenceId,
        expectedRevision: occurrence.revision, action,
        reason: action === "RETRY" ? "用户选择补跑这一次时段" : "用户忽略这一次时段",
      });
      await load();
      setNotice(action === "RETRY" ? "已登记补跑：下一次扫描会按当前准入重新尝试。" : "这一次时段已忽略。");
    } catch (caught) {
      setError(`${action === "RETRY" ? "补跑" : "忽略"}失败：${describeLiveError(caught).message}`);
    } finally { if (!disposed.current) setBusy(false); }
  }

  if (loading) return <div className="page-layout scheduled-tasks-page"><div className="page-primary">
    <p role="status">正在读取定时任务…</p></div></div>;
  if (task === null) return <div className="page-layout scheduled-tasks-page"><div className="page-primary">
    <PageHeader testId="scheduled-task-detail-head" title="定时任务" meta="读取失败" lede="这条定时任务当前无法读取。" />
    {error && <p className="action-error" role="alert">{error}</p>}
    <div className="form-actions"><Link className="secondary-button" to="/scheduled-tasks">返回列表</Link></div>
  </div></div>;

  const blocked = task.occurrences.filter((occurrence) => occurrence.status === "BLOCKED");
  return <div className="page-layout scheduled-tasks-page"><div className="page-primary">
    <PageHeader testId="scheduled-task-detail-head" title={task.title} meta={`定时任务 · ${describeRepeat(task)}`}
      lede={`每次触发新建一个任务并交给 AI 执行；当前时区 ${task.timezone}，本地时刻 ${task.localTime}。`} />
    <div className="form-actions">
      <button className="secondary-button" type="button" onClick={() => void load()} disabled={busy}>刷新</button>
      {task.status === "ENABLED" && <button className="secondary-button" type="button" disabled={busy}
        onClick={() => void changeStatus("PAUSED")}>暂停</button>}
      {task.status === "PAUSED" && <button className="secondary-button" type="button" disabled={busy}
        onClick={() => void changeStatus("ENABLED")}>继续</button>}
      {task.status !== "DISABLED" && task.status !== "EXPIRED" && <button className="secondary-button" type="button" disabled={busy}
        onClick={() => void changeStatus("DISABLED")}>停用</button>}
      <button className="text-button" type="button" onClick={() => navigate("/scheduled-tasks")}>返回列表</button>
    </div>
    {error && <p className="action-error" role="alert">{error}</p>}
    {notice && <p className="receipt-message" role="status">{notice}</p>}

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
          <button className="text-button" type="button" disabled={busy} data-testid={`scheduled-task-retry-${occurrence.occurrenceId}`}
            onClick={() => void resolveOccurrence(occurrence, "RETRY")}>补跑一次</button>
          <button className="text-button" type="button" disabled={busy} data-testid={`scheduled-task-dismiss-${occurrence.occurrenceId}`}
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
