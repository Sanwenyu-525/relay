import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { createCommandId, RelayApiError, RelayTransportError,
  type RelayApiClient, type RelayControlRequest, type RelayControlType, type RelayRun, type RelayTaskDetail } from "../api/relayClient";
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
/** 「已受理」与「已生效」是两件事：服务端目前不提供「全部 Windows 进程已停止」的证明，
 *  因此停止类请求只能说到 Run 与任务事实为止，残留进程仍需人工处理。 */
const processStopLimitation =
  "后端没有提供停机证明：Run 进入终态只说明 Run 与任务事实，不等于全部 Windows 进程已停止，也不等于工作目录已释放；"
  + "若仍有进程占用该工作目录，需要人工处理后再发起新的执行。";

export interface RunControlState {
  readonly run: RelayRun;
  readonly task: RelayTaskDetail;
  readonly controlRecord: RelayControlRequest | null;
  readonly activeRun: boolean;
  readonly terminal: boolean;
  readonly projectWriteBlockedReason: string | null;
}

/**
 * 结果未知的控制命令要跨页面重读保留：原 command_id、冻结的请求类型与「核对原命令回执」
 * 入口是恢复这件事身份的唯一凭据，组件内存状态在刷新或断线后就没有了。
 *
 * 持久化按 (连接, 工作空间, Run) 分键，所以同 Run 的事实修订、事件刷新与整页重读都保留它，
 * 换 Run 仍各自独立——不把上一 Run 的命令身份带过去。sessionStorage 只是本机恢复线索，
 * 不是业务事实：核对结论仍以服务端按原 command_id 给出的回执为准（同 FileWriteDispositionPanel
 * 与协作页未决命令的既有做法）。
 */
interface PendingRunControl {
  readonly runId: string;
  readonly id: string;
  readonly kind: "control" | "resume";
  readonly type?: RelayControlType;
}

function pendingCommandKey(client: RelayApiClient | null, runId: string): string {
  return `relay:run-control-pending:${client?.baseUrl ?? ""}:${client?.workspaceId ?? ""}:${runId}`;
}

function readPendingCommand(key: string, runId: string): PendingRunControl | null {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(key) ?? "null");
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>;
    if (row["runId"] !== runId || typeof row["commandId"] !== "string" || row["commandId"] === "") return null;
    if (row["kind"] === "resume") return { runId, id: row["commandId"], kind: "resume" };
    if (row["kind"] !== "control" || typeof row["type"] !== "string") return null;
    if (!Object.prototype.hasOwnProperty.call(controlLabels, row["type"])) return null;
    return { runId, id: row["commandId"], kind: "control", type: row["type"] as RelayControlType };
  } catch { return null; }
}

function writePendingCommand(key: string, pending: PendingRunControl | null): void {
  try {
    if (pending === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, JSON.stringify({ runId: pending.runId, commandId: pending.id,
      kind: pending.kind, type: pending.type ?? null }));
  } catch { /* 本机存储写不进去也不影响本次页面会话内的核对入口。 */ }
}

function samePendingCommand(left: PendingRunControl | null, right: PendingRunControl | null): boolean {
  if (left === null || right === null) return left === right;
  return left.runId === right.runId && left.id === right.id && left.kind === right.kind &&
    left.type === right.type;
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
  // 本地只记「我提交过哪条命令、服务端回了哪个控制请求 ID」。它不是状态来源：
  // 只要服务端自己的控制记录已经覆盖这次请求，本地记录就退出显示，改由服务端事实说话。
  const [accepted, setAccepted] = useState<{ runId: string; commandId: string;
    controlRequestId: string; type: RelayControlType } | null>(null);
  const report = useRef(onControlAccepted); report.current = onControlAccepted;
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // Run 身份键只含 Run ID，不含 revision：同 Run 的事实修订（revision 变化）只触发数据刷新，
  // 不代表原命令已结算，不得清掉结果未知的 command_id、冻结载荷与「核对原命令回执」入口。
  const runKey = run.id;
  // 渲染期就同步的版本标记。只在 effect 里自增会让「换 Run 的那一帧」与「迟到回包」之间留一个
  // 微任务级窗口：迟到回包会写进已经属于另一个 Run 的界面。渲染期赋值不留这个窗口。
  // 该标记也保证同 Run 的迟到 202 回执仍能落账：revision 更新不改变它。
  const facts = useRef(runKey);
  facts.current = runKey;
  // 未确认命令按 (连接, 工作空间, Run) 分键持久化，因此换连接或换 Run 各读各的，
  // 同 Run 的刷新、事件补读与整页重读都取回同一条命令身份。
  const pendingKey = pendingCommandKey(liveClient(), run.id);
  const [pendingCommand, setPendingCommand] = useState<PendingRunControl | null>(
    () => readPendingCommand(pendingCommandKey(liveClient(), run.id), run.id));
  const pendingRef = useRef(pendingCommand); pendingRef.current = pendingCommand;

  useEffect(() => {
    // 换 Run（或换连接）时读回**这个** Run 自己的未确认命令：既不丢同一条命令的恢复入口，
    // 也不把上一 Run 的 command_id 带过来；受理记录仍按次重读清空。
    const restored = readPendingCommand(pendingKey, run.id);
    setPendingCommand((current) => samePendingCommand(current, restored) ? current : restored);
    setActionError(null); setActionMessage(null); setSubmitting(false); setAccepted(null);
  }, [runKey, pendingKey]);

  useEffect(() => {
    if (pendingCommand !== null) writePendingCommand(pendingCommandKey(liveClient(), pendingCommand.runId),
      pendingCommand);
  }, [pendingCommand]);

  /** 命令已结算或被服务端明确拒绝：本地身份与持久化线索一起收口，之后才允许再提交。 */
  function settlePendingCommand() {
    const current = pendingRef.current;
    if (current !== null) writePendingCommand(pendingCommandKey(liveClient(), current.runId), null);
    setPendingCommand(null);
  }

  const canControl = activeRun && !terminal && projectWriteBlockedReason === null &&
    run.pendingControlRequest === null && pendingCommand === null && !submitting;
  const handoffApplied = controlRecord !== null && controlRecord.type === "HANDOFF" && controlRecord.status === "APPLIED";
  // 服务端记录还没覆盖这次提交时才显示本地受理记录；覆盖之后立刻交回服务端事实。
  const awaitingServer = accepted !== null && accepted.runId === run.id &&
    (controlRecord === null || controlRecord.id !== accepted.controlRequestId);

  async function reload() {
    setRefreshing(true);
    try { await onReload(); } finally { setRefreshing(false); }
  }

  async function submitControl(type: RelayControlType) {
    const client = liveClient();
    if (!client || !canControl || (type === "PAUSE" && run.status === "PAUSED")) return;
    const commandId = createCommandId(); const context = facts.current;
    setPendingCommand({ runId: run.id, id: commandId, kind: "control", type }); setSubmitting(true); setActionError(null); setActionMessage(null);
    try {
      const result = await client.requestRunControl({ runId: run.id, commandId, expectedTaskRevision: task.revision,
        expectedRunRevision: run.revision, type });
      if (context !== facts.current) return;
      if (result.taskId !== task.id) throw new RelayTransportError("控制回执的任务与当前 Run 不匹配。");
      settlePendingCommand();
      const record = { runId: run.id, commandId, controlRequestId: result.controlRequestId, type };
      setAccepted(record); report.current?.(result.controlRequestId);
      setActionMessage(`${controlLabels[type]}提交回执为 202 / PENDING；下方 Run 与控制请求状态是随后查询的当前事实。`);
      await onReload();
    } catch (caught) {
      if (context !== facts.current) return;
      if (caught instanceof RelayTransportError) setActionError("响应丢失或无法核对，控制请求是否入库尚未确定。请查询原 command_id 回执，不能换 ID 再提交。");
      else { settlePendingCommand(); setActionError(describeLiveError(caught).message);
        if (caught instanceof RelayApiError && ["REVISION_CONFLICT", "CONTROL_CONFLICT", "INVALID_TRANSITION", "RUN_TERMINAL", "UNKNOWN_ACTION_BLOCKED"].includes(caught.problem.code)) await onReload(); }
    } finally { if (context === facts.current) setSubmitting(false); }
  }

  async function resume() {
    const client = liveClient();
    if (!client || !canControl || run.status !== "PAUSED") return;
    const commandId = createCommandId(); const context = facts.current;
    setPendingCommand({ runId: run.id, id: commandId, kind: "resume" }); setSubmitting(true); setActionError(null); setActionMessage(null);
    try {
      await client.resumeRun({ runId: run.id, commandId, expectedTaskRevision: task.revision, expectedRunRevision: run.revision });
      if (context !== facts.current) return;
      settlePendingCommand();
      setAccepted((current) => current === null || current.runId !== run.id ? current : null);
      setActionMessage("恢复命令已受理（202）。已重新读取 Run；实际状态以服务端查询为准。");
      await onReload();
    } catch (caught) {
      if (context !== facts.current) return;
      if (caught instanceof RelayTransportError) setActionError("响应丢失或无法核对，恢复是否受理尚未确定。请查询原 command_id 回执，不能换 ID 再提交。");
      else { settlePendingCommand(); setActionError(describeLiveError(caught).message);
        if (caught instanceof RelayApiError && ["REVISION_CONFLICT", "CONTROL_CONFLICT", "INVALID_TRANSITION", "UNKNOWN_ACTION_BLOCKED"].includes(caught.problem.code)) await onReload(); }
    } finally { if (context === facts.current) setSubmitting(false); }
  }

  async function checkReceipt() {
    const pending = pendingCommand; const client = liveClient();
    if (!pending || !client || submitting) return;
    const context = facts.current; setSubmitting(true);
    try {
      const receipt = await client.getCommandReceipt(pending.id);
      if (context !== facts.current) return;
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
        const controlRequestId = result.control_request_id as string;
        setAccepted({ runId: run.id, commandId: pending.id, controlRequestId, type: pending.type as RelayControlType });
        report.current?.(controlRequestId);
      }
      settlePendingCommand(); setActionError(null);
      setActionMessage("已找到原命令回执；正在核对 Run 与控制请求的最新状态。");
      await onReload();
    } catch (caught) {
      if (context !== facts.current) return;
      setActionError(caught instanceof RelayApiError && caught.problem.code === "COMMAND_NOT_FOUND"
        ? "暂未找到原命令回执，结果仍未确定。请稍后继续用同一个 command_id 核对。"
        : describeLiveError(caught).message);
    } finally { if (context === facts.current) setSubmitting(false); }
  }

  return <section className={compact ? "collaboration-run-control" : "surface-panel"} data-testid="run-control">
    {!compact && <h2>控制请求</h2>}
    <p className="helper-text">控制提交回执表示 PENDING；安全点可能随后处理请求。Run、任务执行者与控制状态以重新查询为准。</p>
    {projectWriteBlockedReason && <p className="disabled-reason" data-testid="run-project-archive-reason">{projectWriteBlockedReason}</p>}
    {/* 在途窗口：按钮已受理 ≠ 动作已停止。这里只说「正在处理」，Run 状态一律读服务端。 */}
    {submitting && pendingCommand && <p className="helper-text" role="status" data-testid="run-control-inflight">
      正在处理 {pendingCommand.kind === "resume" ? "恢复命令" : controlLabels[pendingCommand.type ?? "PAUSE"]}：
      {pendingCommand.kind === "resume" ? "Run 尚未恢复执行" : controlPendingNotes[pendingCommand.type ?? "PAUSE"]}。
      真实状态与等待原因以下方服务端查询为准；界面不会先把它改写成已暂停或已停止。
    </p>}
    {run.pendingControlRequest && <p className="receipt-message" role="status" data-testid="run-control-pending">{controlLabels[run.pendingControlRequest.type]}：{run.pendingControlRequest.status}。{controlPendingNotes[run.pendingControlRequest.type]}，等待安全点处理；当前执行者仍为 {executorLabels[task.executor]}。请求 {run.pendingControlRequest.id}{run.waitReason === null ? "" : ` · 服务端等待原因 ${run.waitReason}`}。</p>}
    {awaitingServer && accepted && <p className="helper-text" role="status" data-testid="run-control-accepted">
      本地提交记录（尚未被服务端记录覆盖）：{controlLabels[accepted.type]} · 原 command_id {accepted.commandId}
      · 控制请求 {accepted.controlRequestId}。回执只说明受理，实际是否暂停/停止/交接以下方服务端状态为准。
    </p>}
    {controlRecord && <p className="helper-text" data-testid="run-control-status">控制请求 {controlRecord.id}：{controlRecord.status}{controlRecord.decidedAt && <> · 处理时间 {controlRecord.decidedAt}</>}</p>}
    {terminal && controlRecord?.status === "PENDING" && <p className="helper-text" data-testid="run-terminal-race" role="status">Run 已按服务端结果进入「{runLabels[run.status] ?? run.status}」终态；停止与完成发生竞争时以服务端查询结果为准，提交意图不改写事实。控制请求 {controlRecord.id} 的实际处理结果同样以服务端为准。</p>}
    {terminal && <p className="warning-callout" data-testid="run-stop-limitation">{processStopLimitation}</p>}
    {(handoffApplied || (task.executor === "HUMAN" && terminal)) && <p className="receipt-message" data-testid="run-handoff-edit" role="status">{handoffApplied ? "已交接，可编辑。" : "任务当前执行者为人工（服务端事实）；本 Run 已结束且只读。"}人工编辑与保存版本在 {taskHref ? <Link className="text-link" to={taskHref}>任务详情</Link> : "本工作区的产物区"}进行；接手完成前的历史产物与原 Run 保持可追溯。任务状态：{taskStatusLabels[task.status] ?? task.status}。</p>}
    {actionError && <p className="action-error" role="alert">{actionError}</p>}
    {actionMessage && <p className="receipt-message" role="status">{actionMessage}</p>}
    {/* 整页重读后取回的命令身份：说明它仍未核对，并继续锁住新的控制提交。 */}
    {pendingCommand && !submitting && <p className="helper-text" role="status" data-testid="run-control-recheck">
      仍在等原命令回执：{pendingCommand.kind === "resume" ? "恢复命令" : controlLabels[pendingCommand.type ?? "PAUSE"]}已提交，
      但结果尚未核对（页面重读后仍保留这条命令身份）。真实状态以下方服务端查询为准；核对完成前不提交新的控制命令。
    </p>}
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
    {/* 按钮变亮只说明「当前没有被本地拦住的理由」，不代表服务端已确认安全或授权仍然有效。 */}
    <p className="helper-text" data-testid="run-control-resume-note">
      恢复 Run 时服务端会重新检查契约、权限与资源占用；这里按钮可用不等于已经确认安全，也不等于已获得新授权。
    </p>
  </section>;
}
