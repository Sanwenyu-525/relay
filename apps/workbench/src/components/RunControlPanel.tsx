import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { createCommandId, RelayApiError, RelayTransportError,
  type RelayControlRequest, type RelayControlType, type RelayRun, type RelayTaskDetail } from "../api/relayClient";
import { describeLiveError } from "../lib/liveErrors";
import { executorLabels, taskStatusLabels } from "../lib/labels";
import { liveClient } from "../lib/relayConnection";

export const controlLabels: Record<RelayControlType, string> = {
  PAUSE: "请求暂停 Run", CANCEL: "请求停止 Run", HANDOFF: "请求交接给人工", CANCEL_TASK: "请求取消任务"
};
export const runLabels: Record<string, string> = {
  CREATED: "待启动", CONTEXT_BUILDING: "构建上下文", PLANNING: "规划中", RUNNING: "执行中",
  WAITING_APPROVAL: "等待人工判断", VERIFYING: "验证中", RETRYING: "修正中", PAUSED: "已暂停",
  COMPLETED: "已完成", FAILED: "失败", CANCELLED: "已停止"
};
export const stepLabels: Record<string, string> = {
  BUILD_CONTEXT: "构建上下文", DRAFT: "生成草稿", PERSIST_CANDIDATE: "保存候选产物",
  VERIFY: "验证", COMPLETE: "提交完成"
};
export const stepStatusLabels: Record<string, string> = {
  PENDING: "待执行", RUNNING: "执行中", SUCCEEDED: "已完成", FAILED: "失败", CANCELLED: "已取消", SKIPPED: "已跳过"
};
const controlPendingNotes: Record<RelayControlType, string> = {
  PAUSE: "Run 尚未暂停", CANCEL: "Run 尚未停止", HANDOFF: "尚未交接，人工编辑入口未开放", CANCEL_TASK: "任务尚未取消"
};

export interface RunControlState {
  readonly run: RelayRun;
  readonly task: RelayTaskDetail;
  readonly controlRecord: RelayControlRequest | null;
  readonly activeRun: boolean;
  readonly terminal: boolean;
  readonly projectWriteBlockedReason: string | null;
}

/**
 * Run 控制请求的唯一写路径：运行页与协作工作区共用同一组件，
 * 保证“请求受理 / 已暂停 / 已交接”三者在任何入口都读同一组服务端事实。
 */
export default function RunControlPanel({ state, onReload, compact, taskHref, onControlAccepted }: {
  state: RunControlState; onReload: () => Promise<void> | void; compact?: boolean; taskHref?: string | null;
  onControlAccepted?: (controlRequestId: string | null) => void;
}) {
  const { run, task, controlRecord, activeRun, terminal, projectWriteBlockedReason } = state;
  const [acceptedControl, setAcceptedControl] = useState<{ id: string; type: RelayControlType } | null>(null);
  const acceptedControlRef = useRef(acceptedControl); acceptedControlRef.current = acceptedControl;
  const report = useRef(onControlAccepted); report.current = onControlAccepted;
  const [pendingCommand, setPendingCommand] = useState<{ id: string; kind: "control" | "resume"; type?: RelayControlType } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const targetVersion = useRef(0);
  const runKey = `${run.id}:${run.revision}`;

  useEffect(() => {
    targetVersion.current++;
    setPendingCommand(null); setActionError(null); setActionMessage(null); setSubmitting(false);
  }, [runKey, task.revision]);

  const canControl = activeRun && !terminal && projectWriteBlockedReason === null &&
    run.pendingControlRequest === null && pendingCommand === null && !submitting;
  const handoffApplied = controlRecord !== null && controlRecord.type === "HANDOFF" && controlRecord.status === "APPLIED";

  async function reload() {
    setRefreshing(true);
    try { await onReload(); } finally { setRefreshing(false); }
  }

  async function submitControl(type: RelayControlType) {
    const client = liveClient();
    if (!client || !canControl || (type === "PAUSE" && run.status === "PAUSED")) return;
    const commandId = createCommandId(); const context = targetVersion.current;
    setPendingCommand({ id: commandId, kind: "control", type }); setSubmitting(true); setActionError(null); setActionMessage(null);
    try {
      const result = await client.requestRunControl({ runId: run.id, commandId, expectedTaskRevision: task.revision,
        expectedRunRevision: run.revision, type });
      if (context !== targetVersion.current) return;
      if (result.taskId !== task.id) throw new RelayTransportError("控制回执的任务与当前 Run 不匹配。");
      setPendingCommand(null);
      const accepted = { id: result.controlRequestId, type };
      setAcceptedControl(accepted); acceptedControlRef.current = accepted; report.current?.(accepted.id);
      setActionMessage(`${controlLabels[type]}提交回执为 202 / PENDING；下方 Run 与控制请求状态是随后查询的当前事实。`);
      await onReload();
    } catch (caught) {
      if (context !== targetVersion.current) return;
      if (caught instanceof RelayTransportError) setActionError("响应丢失或无法核对，控制请求是否入库尚未确定。请查询原 command_id 回执，不能换 ID 再提交。");
      else { setPendingCommand(null); setActionError(describeLiveError(caught).message);
        if (caught instanceof RelayApiError && ["REVISION_CONFLICT", "CONTROL_CONFLICT", "INVALID_TRANSITION", "RUN_TERMINAL", "UNKNOWN_ACTION_BLOCKED"].includes(caught.problem.code)) await onReload(); }
    } finally { if (context === targetVersion.current) setSubmitting(false); }
  }

  async function resume() {
    const client = liveClient();
    if (!client || !canControl || run.status !== "PAUSED") return;
    const commandId = createCommandId(); const context = targetVersion.current;
    setPendingCommand({ id: commandId, kind: "resume" }); setSubmitting(true); setActionError(null); setActionMessage(null);
    try {
      await client.resumeRun({ runId: run.id, commandId, expectedTaskRevision: task.revision, expectedRunRevision: run.revision });
      if (context !== targetVersion.current) return;
      setPendingCommand(null);
      setActionMessage("恢复命令已受理（202）。已重新读取 Run；实际状态以服务端查询为准。");
      await onReload();
    } catch (caught) {
      if (context !== targetVersion.current) return;
      if (caught instanceof RelayTransportError) setActionError("响应丢失或无法核对，恢复是否受理尚未确定。请查询原 command_id 回执，不能换 ID 再提交。");
      else { setPendingCommand(null); setActionError(describeLiveError(caught).message);
        if (caught instanceof RelayApiError && ["REVISION_CONFLICT", "CONTROL_CONFLICT", "INVALID_TRANSITION", "UNKNOWN_ACTION_BLOCKED"].includes(caught.problem.code)) await onReload(); }
    } finally { if (context === targetVersion.current) setSubmitting(false); }
  }

  async function checkReceipt() {
    const pending = pendingCommand; const client = liveClient();
    if (!pending || !client || submitting) return;
    const context = targetVersion.current; setSubmitting(true);
    try {
      const receipt = await client.getCommandReceipt(pending.id);
      if (context !== targetVersion.current) return;
      const result = receipt.result;
      const matchesRun = receipt.commandId === pending.id && result.run_id === run.id;
      const matchesCommand = pending.kind === "control"
        ? receipt.commandType === "RequestRunControl" && result.task_id === task.id && result.type === pending.type &&
          result.status === "PENDING" && typeof result.control_request_id === "string" && result.control_request_id.length > 0
        : receipt.commandType === "ResumeRun" && typeof result.status === "string" && result.status.length > 0;
      if (!matchesRun || !matchesCommand || typeof result.run_revision !== "string" || !/^\d+$/.test(result.run_revision)) {
        setActionError("原命令回执与当前 Run 或命令类型不匹配，结果仍未确定。请保留原 command_id 核对。");
        return;
      }
      if (pending.kind === "control") {
        const accepted = { id: result.control_request_id as string, type: pending.type as RelayControlType };
        setAcceptedControl(accepted); acceptedControlRef.current = accepted; report.current?.(accepted.id);
      }
      setPendingCommand(null); setActionError(null);
      setActionMessage("已找到原命令回执；正在核对 Run 与控制请求的最新状态。");
      await onReload();
    } catch (caught) {
      if (context !== targetVersion.current) return;
      setActionError(caught instanceof RelayApiError && caught.problem.code === "COMMAND_NOT_FOUND"
        ? "暂未找到原命令回执，结果仍未确定。请稍后继续用同一个 command_id 核对。"
        : describeLiveError(caught).message);
    } finally { if (context === targetVersion.current) setSubmitting(false); }
  }

  return <section className={compact ? "collaboration-run-control" : "surface-panel"} data-testid="run-control">
    {!compact && <h2>控制请求</h2>}
    <p className="helper-text">控制提交回执表示 PENDING；安全点可能随后处理请求。Run、任务执行者与控制状态以重新查询为准。</p>
    {projectWriteBlockedReason && <p className="disabled-reason" data-testid="run-project-archive-reason">{projectWriteBlockedReason}</p>}
    {run.pendingControlRequest && <p className="receipt-message" role="status" data-testid="run-control-pending">{controlLabels[run.pendingControlRequest.type]}：{run.pendingControlRequest.status}。{controlPendingNotes[run.pendingControlRequest.type]}，等待安全点处理；当前执行者仍为 {executorLabels[task.executor]}。请求 {run.pendingControlRequest.id}。</p>}
    {controlRecord && <p className="helper-text" data-testid="run-control-status">控制请求 {controlRecord.id}：{controlRecord.status}{controlRecord.decidedAt && <> · 处理时间 {controlRecord.decidedAt}</>}</p>}
    {terminal && controlRecord?.status === "PENDING" && <p className="helper-text" data-testid="run-terminal-race" role="status">Run 已按服务端结果进入「{runLabels[run.status] ?? run.status}」终态；停止与完成发生竞争时以服务端查询结果为准，提交意图不改写事实。控制请求 {controlRecord.id} 的实际处理结果同样以服务端为准。</p>}
    {(handoffApplied || (task.executor === "HUMAN" && terminal)) && <p className="receipt-message" data-testid="run-handoff-edit" role="status">{handoffApplied ? "已交接，可编辑。" : "任务当前执行者为人工（服务端事实）；本 Run 已结束且只读。"}人工编辑与保存版本在 {taskHref ? <Link className="text-link" to={taskHref}>任务详情</Link> : "本工作区的产物区"}进行；接手完成前的历史产物与原 Run 保持可追溯。任务状态：{taskStatusLabels[task.status] ?? task.status}。</p>}
    {actionError && <p className="action-error" role="alert">{actionError}</p>}
    {actionMessage && <p className="receipt-message" role="status">{actionMessage}</p>}
    {pendingCommand && <p className="helper-text">原 command_id：{pendingCommand.id}</p>}
    <div className="run-actions">
      {pendingCommand ? <button className="secondary-button" type="button" data-testid="run-check-receipt" disabled={submitting} onClick={() => void checkReceipt()}>核对原命令回执</button> : <>
        {run.status === "PAUSED"
          ? <button className="primary-button" type="button" data-testid="run-resume" disabled={!canControl} onClick={() => void resume()}>恢复 Run</button>
          : <button className="secondary-button" type="button" data-testid="run-control-PAUSE" disabled={!canControl} onClick={() => void submitControl("PAUSE")}>{controlLabels.PAUSE}</button>}
        <button className="secondary-button" type="button" data-testid="run-control-CANCEL" disabled={!canControl} onClick={() => void submitControl("CANCEL")}>{controlLabels.CANCEL}</button>
        <button className="secondary-button" type="button" data-testid="run-control-HANDOFF" disabled={!canControl} onClick={() => void submitControl("HANDOFF")}>{controlLabels.HANDOFF}</button>
        <button className="danger-button" type="button" data-testid="run-control-CANCEL_TASK" disabled={!canControl} onClick={() => void submitControl("CANCEL_TASK")}>{controlLabels.CANCEL_TASK}</button>
      </>}
      <button className="secondary-button" type="button" data-testid="run-refresh" disabled={refreshing || submitting} onClick={() => void reload()}>刷新状态</button>
    </div>
  </section>;
}
