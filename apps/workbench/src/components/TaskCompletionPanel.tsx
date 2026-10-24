import { useEffect, useRef, useState } from "react";
import { Check, Info, RotateCcw } from "lucide-react";
import { completionFrom, createCommandId, reopenFrom, type RelayAcceptanceCriterion, type RelayCompletion } from "../api/relayClient";
import { describeLiveError, needsReceiptCheck, type LiveActionError } from "../lib/liveErrors";
import { liveClient } from "../lib/relayConnection";
import type { DecimalRevision, TaskStatus } from "../types";

const wrongReceipt = (commandType: string, action: string): LiveActionError => ({
  kind: "unknown", message: `回执的命令类型是 ${commandType}，不是本次${action}；请核对 command ID。`, fieldErrors: []
});

/**
 * 完成结果与原冻结请求的可证事实核对（禅道 #28，DEV-0132）：解析成功不代表关联正确。
 * 完成提交绑定确切 Task、验收版本与产物集合（R4 验收版本绑定）；任何一项对不上都不能
 * 宣告成功、不能清原 ID，保持待核对等待回执。原样返回 null。
 */
function completionMismatch(result: RelayCompletion, request: PendingCompletion): string | null {
  if (result.taskId !== request.taskId) return `完成结果属于任务 ${result.taskId}，不是本次任务 ${request.taskId}；请核对原 command ID，本次完成保持待核对。`;
  if (result.status !== "DONE") return `完成结果显示任务状态是 ${result.status}，不是完成；请核对原 command ID，本次完成保持待核对。`;
  if (result.acceptanceRevision !== request.acceptanceRevision) return `完成结果依据的验收版本是 v${result.acceptanceRevision}，本次命令基于 v${request.acceptanceRevision}；请核对原 command ID，本次完成保持待核对。`;
  const committed = [...result.artifactVersionIds].sort().join("\n");
  const requested = [...request.artifactVersionIds].sort().join("\n");
  if (committed !== requested) return `完成结果接受的产物版本集合与本次命令不一致；请核对原 command ID，本次完成保持待核对。`;
  return null;
}

/**
 * 结果未知时冻结的完整原请求（禅道 #29，DEV-0131）：只保留 command ID 不够——
 * 用户随后编辑的说明／原因是新草稿，不能借旧 ID 组出新载荷；原样重试只发冻结对象。
 */
interface PendingCompletion {
  readonly commandId: string;
  readonly taskId: string;
  readonly expectedRevision: DecimalRevision;
  readonly acceptanceRevision: DecimalRevision;
  readonly artifactVersionIds: readonly string[];
  readonly statement: string;
  readonly acceptedCriterionIds: readonly string[];
  readonly reason: string | null;
}

interface PendingReopen {
  readonly commandId: string;
  readonly taskId: string;
  readonly expectedRevision: DecimalRevision;
  readonly reason: string;
}

export interface CompletionTarget {
  readonly taskId: string;
  readonly taskStatus: TaskStatus;
  readonly taskRevision: DecimalRevision;
  readonly acceptanceRevision: DecimalRevision;
  readonly allowedActions: readonly string[];
  readonly criteria: readonly RelayAcceptanceCriterion[];
  /** 随完成提交的产物版本；null 表示该任务未声明产物要求，允许空集合。 */
  readonly acceptedVersion: { readonly artifactVersionId: string; readonly versionNumber: DecimalRevision } | null;
  readonly writeBlockedReason: string | null;
}

export interface CompletionResult {
  readonly completionId: string;
  readonly revision: DecimalRevision;
  readonly acceptanceRevision: DecimalRevision;
}

/**
 * 完成是独立的短事务用例：任务状态、完成凭据与项目 State 一起提交。
 * 任务详情页与协作工作区共用本组件；模型回复结束、检查 PASS 和批准都不走这条路径。
 */
export default function TaskCompletionPanel({ live, target, onRefresh, compact }: {
  live: boolean;
  target: CompletionTarget;
  onRefresh: () => void | Promise<void>;
  compact?: boolean;
}) {
  const { taskId, taskStatus, taskRevision, acceptanceRevision, allowedActions, criteria, acceptedVersion, writeBlockedReason } = target;
  const [statement, setStatement] = useState("按当前验收标准完成，并接受所选产物版本。");
  const [reason, setReason] = useState("");
  const [acceptedCriterionIds, setAcceptedCriterionIds] = useState<string[]>([]);
  const [completing, setCompleting] = useState(false);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [failure, setFailure] = useState<LiveActionError | null>(null);
  const [reopenReason, setReopenReason] = useState("");
  const [reopening, setReopening] = useState(false);
  const [reopenReceipt, setReopenReceipt] = useState<string | null>(null);
  const [reopenFailure, setReopenFailure] = useState<LiveActionError | null>(null);
  /** 冻结的原命令（state 驱动渲染，ref 供回执查询与重试读取），未知结果收口前不换 ID。 */
  const [pendingComplete, setPendingComplete] = useState<PendingCompletion | null>(null);
  const [pendingReopen, setPendingReopen] = useState<PendingReopen | null>(null);
  const pendingCompleteRef = useRef<PendingCompletion | null>(null);
  const pendingReopenRef = useRef<PendingReopen | null>(null);
  // 人工条件勾选绑定 Task＋验收版本＋确切接受产物版本（禅道 #27，DEV-0133）：
  // 从一个确切接受版本换到另一个不同版本、或退回未选，都作废旧勾选，要求重新确认。
  // 首轮尚未选定任何版本时的既有勾选（例如保存首个产物后该版被自动选中）不因此作废，
  // 即 null→A 不清——那些勾选不是为另一个版本做的；A→B / A→null 仍清，堵住绕道继承。
  const acceptedVersionKey = acceptedVersion?.artifactVersionId ?? "";
  const round = useRef({ taskId, revision: acceptanceRevision, lastVersionKey: acceptedVersionKey });
  useEffect(() => {
    const current = round.current;
    const sameRound = current.taskId === taskId && current.revision === acceptanceRevision;
    const invalidate = !sameRound ||
      (current.lastVersionKey !== "" && current.lastVersionKey !== acceptedVersionKey);
    round.current = { taskId, revision: acceptanceRevision, lastVersionKey: acceptedVersionKey };
    if (!invalidate) return;
    setAcceptedCriterionIds([]);
  }, [taskId, acceptanceRevision, acceptedVersionKey]);
  const done = taskStatus === "DONE";
  const requiredCriteria = criteria.filter((criterion) => criterion.required);
  const canComplete = live && writeBlockedReason === null && !completing && (pendingComplete !== null ||
    (allowedActions.includes("COMPLETE") &&
      requiredCriteria.every((criterion) => acceptedCriterionIds.includes(criterion.criterionId)) &&
      Boolean(statement.trim())));
  const canReopen = live && writeBlockedReason === null && !reopening && (pendingReopen !== null ||
    (allowedActions.includes("REOPEN") && Boolean(reopenReason.trim())));

  useEffect(() => {
    pendingCompleteRef.current = null; pendingReopenRef.current = null;
    setPendingComplete(null); setPendingReopen(null);
    setReceipt(null); setFailure(null); setReopenReceipt(null); setReopenFailure(null);
  }, [taskId]);

  function toggleCriterion(criterionId: string, checked: boolean) {
    setAcceptedCriterionIds((current) => checked ? [...current, criterionId] : current.filter((id) => id !== criterionId));
  }

  async function completeTask() {
    const client = liveClient();
    if (!client || completing) return;
    // 结果未知时重按完成＝按冻结的原请求原样重试；表单里的后续编辑是新草稿，不进旧命令。
    let request = pendingCompleteRef.current;
    if (request === null) {
      if (!canComplete) return;
      request = { commandId: createCommandId(), taskId, expectedRevision: taskRevision, acceptanceRevision,
        artifactVersionIds: acceptedVersion ? [acceptedVersion.artifactVersionId] : [],
        statement: statement.trim(), acceptedCriterionIds, reason: reason.trim() || null };
      pendingCompleteRef.current = request; setPendingComplete(request);
    }
    setCompleting(true); setFailure(null); setReceipt(null);
    try {
      const result = await client.completeHumanTask(request);
      // client 已核对回包 command_id 与确切 Task；这里再按原冻结请求核对验收版本、
      // 完成状态与产物集合（#28）。错配抛错走 catch：保持冻结、不清原 ID、不宣告成功、
      // 不当作业务完成刷新。
      const mismatch = completionMismatch(result, request);
      if (mismatch !== null) throw new Error(mismatch);
      pendingCompleteRef.current = null;
      setPendingComplete(null);
      setReceipt(`已完成本轮：完成凭据 ${result.completionId}，任务修订 v${result.revision}，验收版本 v${result.acceptanceRevision}${result.stateRevision === null ? "" : `，项目 State 修订 v${result.stateRevision}`}。历史凭据保留；再次编辑需要重开。`);
      await onRefresh();
    } catch (caught) {
      const described = describeLiveError(caught);
      setFailure(described);
      // 只有服务端明确业务拒绝才释放原命令；传输失败与 5xx／核对型错误保持冻结，等待回执或原样重试。
      if (pendingCompleteRef.current === request && described.kind !== "transport" && !needsReceiptCheck(caught)) {
        pendingCompleteRef.current = null; setPendingComplete(null);
      }
    } finally { setCompleting(false); }
  }

  async function lookupCompleteReceipt() {
    const pending = pendingCompleteRef.current; const client = liveClient();
    if (!client || !pending || completing) return;
    setCompleting(true); setFailure(null);
    try {
      const body = await client.getCommandReceipt(pending.commandId);
      if (body.commandId !== pending.commandId) { setFailure({ kind: "unknown", message: "回执 command_id 与原完成命令不符；请继续核对原 ID。", fieldErrors: [] }); return; }
      if (body.commandType !== "CompleteHumanTask") { setFailure(wrongReceipt(body.commandType, "完成")); return; }
      const result = completionFrom(body.result);
      // 回执不只核对 ID 与命令类型：还要按原冻结请求核对确切 Task、验收版本、完成状态
      // 与产物集合（#28）。错配时归结果未知：保持待核对、不清原 ID、不显示成功、不刷新。
      const mismatch = completionMismatch(result, pending);
      if (mismatch !== null) { setFailure({ kind: "unknown", message: mismatch, fieldErrors: [] }); return; }
      pendingCompleteRef.current = null; setPendingComplete(null);
      setReceipt(`回执确认已完成：完成凭据 ${result.completionId}，任务修订 v${result.revision}。`);
      await onRefresh();
    } catch (caught) { setFailure(describeLiveError(caught)); }
    finally { setCompleting(false); }
  }

  async function reopenTask() {
    const active = liveClient();
    if (!active || reopening) return;
    let request = pendingReopenRef.current;
    if (request === null) {
      if (!canReopen) return;
      request = { commandId: createCommandId(), taskId, expectedRevision: taskRevision, reason: reopenReason.trim() };
      pendingReopenRef.current = request; setPendingReopen(request);
    }
    setReopening(true); setReopenFailure(null); setReopenReceipt(null);
    try {
      const result = await active.reopenTask(request);
      if (result.taskId !== request.taskId) throw new Error("重开结果与当前任务不符，请核对原 command_id。");
      pendingReopenRef.current = null; setPendingReopen(null);
      setReopenReceipt(`已重开：回到${result.status}，新验收版本 v${result.acceptanceRevision}（原 v${result.previousAcceptanceRevision} 的历史凭据仍保留）。编辑前需要重新开始任务。`);
      setReopenReason(""); setAcceptedCriterionIds([]);
      await onRefresh();
    } catch (caught) {
      const described = describeLiveError(caught);
      setReopenFailure(described);
      if (pendingReopenRef.current === request && described.kind !== "transport" && !needsReceiptCheck(caught)) {
        pendingReopenRef.current = null; setPendingReopen(null);
      }
    } finally { setReopening(false); }
  }

  async function lookupReopenReceipt() {
    const pending = pendingReopenRef.current; const client = liveClient();
    if (!client || !pending || reopening) return;
    setReopening(true); setReopenFailure(null);
    try {
      const body = await client.getCommandReceipt(pending.commandId);
      if (body.commandId !== pending.commandId) { setReopenFailure({ kind: "unknown", message: "回执 command_id 与原重开命令不符；请继续核对原 ID。", fieldErrors: [] }); return; }
      if (body.commandType !== "ReopenTask") { setReopenFailure(wrongReceipt(body.commandType, "重开")); return; }
      const result = reopenFrom(body.result);
      if (result.taskId !== pending.taskId) { setReopenFailure({ kind: "unknown", message: "重开回执与当前任务不符；请核对原 command_id。", fieldErrors: [] }); return; }
      pendingReopenRef.current = null; setPendingReopen(null); setAcceptedCriterionIds([]);
      setReopenReceipt(`回执确认已重开：回到${result.status}，新验收版本 v${result.acceptanceRevision}。`);
      setReopenReason(""); await onRefresh();
    } catch (caught) { setReopenFailure(describeLiveError(caught)); }
    finally { setReopening(false); }
  }

  return <>
    <section className={compact ? "collaboration-completion" : "surface-panel"} data-testid="task-completion">
      <h2>检查与完成</h2>
      <p className="helper-text">完成是一次短事务：任务状态、完成凭据与项目 State 一起提交。检查通过不等于完成，完成也不等于执行成功。</p>
      {writeBlockedReason && <p className="disabled-reason">{writeBlockedReason}</p>}
      <fieldset className="field" disabled={done || !allowedActions.includes("COMPLETE")}>
        <legend className="field-label">必需验收条件（全部勾选才能完成）</legend>
        {!requiredCriteria.length && <p className="field-hint">当前验收版本没有必需条件。</p>}
        {requiredCriteria.map((criterion) => <label key={criterion.criterionId} className="choice-option">
          <input type="checkbox" checked={acceptedCriterionIds.includes(criterion.criterionId)}
            data-testid={`criterion-${criterion.criterionId}`} onChange={(event) => toggleCriterion(criterion.criterionId, event.target.checked)} />
          <span>{criterion.statement}<small>方式：{criterion.method}</small></span></label>)}
      </fieldset>
      <label className="field"><span className="field-label">接受说明</span><input value={statement} onChange={(event) => setStatement(event.target.value)} name="completion-statement" disabled={done} /></label>
      <label className="field"><span className="field-label">补充理由（可选）</span><input value={reason} onChange={(event) => setReason(event.target.value)} name="completion-reason" disabled={done} /></label>
      <p className="helper-text">将随完成提交的产物版本：{acceptedVersion ? `v${acceptedVersion.versionNumber}` : "无（该任务未声明产物要求时允许为空集合）"}</p>
      <div className="form-actions"><button className="primary-button" type="button" data-testid="task-complete" disabled={!canComplete} onClick={() => void completeTask()}>
        <Check aria-hidden="true" />{completing ? "正在提交" : "完成本轮"}</button></div>
      {!done && !allowedActions.includes("COMPLETE") && <p className="disabled-reason" data-testid="task-complete-reason"><Info aria-hidden="true" />服务端未投影 COMPLETE：只有进行中的人工任务可以完成。</p>}
      {done && <p className="disabled-reason" data-testid="task-complete-done"><Info aria-hidden="true" />该任务当前已完成；需要再次编辑请先重开。</p>}
      {receipt && <p className="receipt-message" role="status" data-testid="task-complete-receipt">{receipt}</p>}
      {failure && <p className="action-error" role="alert">{failure.message}</p>}
      {pendingComplete && <p className="helper-text" data-testid="task-complete-pending">上一次完成提交（原 command_id：{pendingComplete.commandId}）结果未核实。再次点击「完成本轮」会按原命令 ID 与原内容原样重发；表单中的新修改不会进入原命令。</p>}
      {pendingComplete && <button className="secondary-button" type="button" disabled={completing} onClick={() => void lookupCompleteReceipt()}>查询本次完成回执</button>}
    </section>
    {(done || allowedActions.includes("REOPEN") || reopenReceipt) && <section className={compact ? "collaboration-completion" : "surface-panel"} data-testid="task-reopen">
      <h2>重开任务</h2>
      <p className="helper-text">重开会建立新的验收版本并回到可开始；旧完成凭据与历史版本都保留，不会被删除或改写。</p>
      <label className="field"><span className="field-label">重开原因<span className="field-required" aria-hidden="true">*</span></span>
        <input value={reopenReason} onChange={(event) => setReopenReason(event.target.value)} name="reopen-reason" /></label>
      <div className="form-actions"><button className="secondary-button" type="button" data-testid="task-reopen-submit" disabled={!canReopen} onClick={() => void reopenTask()}>
        <RotateCcw aria-hidden="true" />{reopening ? "正在重开" : "重开任务"}</button></div>
      {reopenReceipt && <p className="receipt-message" role="status" data-testid="task-reopen-receipt">{reopenReceipt}</p>}
      {reopenFailure && <p className="action-error" role="alert">{reopenFailure.message}</p>}
      {pendingReopen && <p className="helper-text" data-testid="task-reopen-pending">上一次重开提交（原 command_id：{pendingReopen.commandId}）结果未核实。再次点击「重开任务」会按原命令 ID 与原原因原样重发；输入框中的新原因不会进入原命令。</p>}
      {pendingReopen && <button className="secondary-button" type="button" data-testid="task-reopen-receipt-query" disabled={reopening} onClick={() => void lookupReopenReceipt()}>查询本次重开回执</button>}
    </section>}
  </>;
}
