import { useEffect, useRef, useState } from "react";
import { Check, Info, RotateCcw } from "lucide-react";
import { completionFrom, createCommandId, reopenFrom, type RelayAcceptanceCriterion } from "../api/relayClient";
import { describeLiveError, type LiveActionError } from "../lib/liveErrors";
import { liveClient } from "../lib/relayConnection";
import type { DecimalRevision, TaskStatus } from "../types";

const wrongReceipt = (commandType: string, action: string): LiveActionError => ({
  kind: "unknown", message: `回执的命令类型是 ${commandType}，不是本次${action}；请核对 command ID。`, fieldErrors: []
});

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
  const command = useRef({ complete: null as string | null, reopen: null as string | null });
  const round = useRef({ taskId, revision: acceptanceRevision });
  const done = taskStatus === "DONE";
  const requiredCriteria = criteria.filter((criterion) => criterion.required);
  const canComplete = live && writeBlockedReason === null && allowedActions.includes("COMPLETE") &&
    requiredCriteria.every((criterion) => acceptedCriterionIds.includes(criterion.criterionId)) &&
    Boolean(statement.trim()) && !completing;
  const canReopen = live && writeBlockedReason === null && allowedActions.includes("REOPEN") &&
    Boolean(reopenReason.trim()) && !reopening;

  // 验收版本变化即新一轮，旧勾选不继承，避免用旧依据完成新版本。
  useEffect(() => {
    if (round.current.taskId === taskId && round.current.revision === acceptanceRevision) return;
    round.current = { taskId, revision: acceptanceRevision };
    setAcceptedCriterionIds([]);
  }, [taskId, acceptanceRevision]);
  useEffect(() => {
    command.current.complete = null; command.current.reopen = null;
    setReceipt(null); setFailure(null); setReopenReceipt(null); setReopenFailure(null);
  }, [taskId]);

  function toggleCriterion(criterionId: string, checked: boolean) {
    setAcceptedCriterionIds((current) => checked ? [...current, criterionId] : current.filter((id) => id !== criterionId));
  }

  async function completeTask() {
    const client = liveClient();
    if (!client || !canComplete) return;
    setCompleting(true); setFailure(null); setReceipt(null);
    try {
      command.current.complete ??= createCommandId();
      const result = await client.completeHumanTask({ taskId, commandId: command.current.complete,
        expectedRevision: taskRevision, acceptanceRevision,
        artifactVersionIds: acceptedVersion ? [acceptedVersion.artifactVersionId] : [],
        statement: statement.trim(), acceptedCriterionIds, reason: reason.trim() || null });
      command.current.complete = null;
      setReceipt(`已完成本轮：完成凭据 ${result.completionId}，任务修订 v${result.revision}，验收版本 v${result.acceptanceRevision}${result.stateRevision === null ? "" : `，项目 State 修订 v${result.stateRevision}`}。历史凭据保留；再次编辑需要重开。`);
      await onRefresh();
    } catch (caught) {
      const described = describeLiveError(caught);
      setFailure(described);
      if (described.kind !== "transport") command.current.complete = null;
    } finally { setCompleting(false); }
  }

  async function lookupCompleteReceipt() {
    const pending = command.current.complete; const client = liveClient();
    if (!client || !pending || completing) return;
    setCompleting(true); setFailure(null);
    try {
      const body = await client.getCommandReceipt(pending);
      if (body.commandId !== pending) { setFailure({ kind: "unknown", message: "回执 command_id 与原完成命令不符；请继续核对原 ID。", fieldErrors: [] }); return; }
      if (body.commandType !== "CompleteHumanTask") { setFailure(wrongReceipt(body.commandType, "完成")); return; }
      const result = completionFrom(body.result);
      command.current.complete = null;
      setReceipt(`回执确认已完成：完成凭据 ${result.completionId}，任务修订 v${result.revision}。`);
      await onRefresh();
    } catch (caught) { setFailure(describeLiveError(caught)); }
    finally { setCompleting(false); }
  }

  async function reopenTask() {
    const active = liveClient();
    if (!active || !canReopen) return;
    setReopening(true); setReopenFailure(null); setReopenReceipt(null);
    try {
      command.current.reopen ??= createCommandId();
      const result = await active.reopenTask({ taskId, commandId: command.current.reopen, expectedRevision: taskRevision, reason: reopenReason.trim() });
      if (result.taskId !== taskId) throw new Error("重开结果与当前任务不符，请核对原 command_id。");
      command.current.reopen = null;
      setReopenReceipt(`已重开：回到${result.status}，新验收版本 v${result.acceptanceRevision}（原 v${result.previousAcceptanceRevision} 的历史凭据仍保留）。编辑前需要重新开始任务。`);
      setReopenReason(""); setAcceptedCriterionIds([]);
      await onRefresh();
    } catch (caught) {
      const described = describeLiveError(caught);
      setReopenFailure(described);
      if (described.kind !== "transport") command.current.reopen = null;
    } finally { setReopening(false); }
  }

  async function lookupReopenReceipt() {
    const pending = command.current.reopen; const client = liveClient();
    if (!client || !pending || reopening) return;
    setReopening(true); setReopenFailure(null);
    try {
      const body = await client.getCommandReceipt(pending);
      if (body.commandId !== pending) { setReopenFailure({ kind: "unknown", message: "回执 command_id 与原重开命令不符；请继续核对原 ID。", fieldErrors: [] }); return; }
      if (body.commandType !== "ReopenTask") { setReopenFailure(wrongReceipt(body.commandType, "重开")); return; }
      const result = reopenFrom(body.result);
      if (result.taskId !== taskId) { setReopenFailure({ kind: "unknown", message: "重开回执与当前任务不符；请核对原 command_id。", fieldErrors: [] }); return; }
      command.current.reopen = null; setAcceptedCriterionIds([]);
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
      {failure?.kind === "transport" && <button className="secondary-button" type="button" disabled={completing} onClick={() => void lookupCompleteReceipt()}>查询本次完成回执</button>}
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
      {reopenFailure?.kind === "transport" && <button className="secondary-button" type="button" data-testid="task-reopen-receipt-query" disabled={reopening} onClick={() => void lookupReopenReceipt()}>查询本次重开回执</button>}
    </section>}
  </>;
}
