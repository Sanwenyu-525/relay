import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { RelayApiClient, RelayTaskDetail, RelayTaskSkillProposal } from "../api/relayClient";
import { describeLiveError } from "../lib/liveErrors";

export default function TaskContractProposalPreview({ client, proposal, taskId, projectId,
  disabled, acceptSupported, onAccept }: {
  client: RelayApiClient; proposal: RelayTaskSkillProposal; taskId: string; projectId: string | null;
  disabled: boolean; acceptSupported: boolean; onAccept: (proposal: RelayTaskSkillProposal) => void;
}) {
  const [task, setTask] = useState<RelayTaskDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const version = useRef(0);

  async function load() {
    const current = ++version.current;
    setLoading(true); setTask(null); setError(null); setConfirming(false);
    try {
      const result = await client.getTask(taskId);
      if (result.id !== taskId || result.projectId !== projectId) throw new Error("提案目标与当前任务不一致。");
      if (current === version.current) setTask(result);
    } catch (caught) {
      if (current === version.current) setError(describeLiveError(caught).message);
    } finally { if (current === version.current) setLoading(false); }
  }
  useEffect(() => { void load(); return () => { version.current++; }; }, [client, taskId, projectId, proposal.id]);

  const targetMatches = proposal.targetId === taskId && proposal.targetType === "TASK";
  const current = targetMatches && task !== null && task.revision === proposal.baseRevision &&
    task.acceptance.acceptanceRevision === proposal.baseAcceptanceRevision;
  const payload = proposal.payloadAvailable && task !== null ? proposal.payload : null;
  return <article className="assist-proposal" data-testid="task-skill-proposal">
    <h4>{proposal.kind === "TASK_CONTRACT_CHANGE" ? "任务定义变更" : "验收方案变更"} · {proposal.status}</h4>
    <p className="helper-text">目标 Task <Link className="inline-link" to={`/tasks/${taskId}`}>{taskId}</Link> ·
      基于 Task v{proposal.baseRevision} / 验收 v{proposal.baseAcceptanceRevision} ·
      服务端合并摘要 {proposal.payloadHash} · Skill {proposal.skillSha256} · 输出 {proposal.skillOutputSha256}</p>
    {!targetMatches && <p role="alert">提案目标与当前会话不一致，不能展示或确认。</p>}
    {targetMatches && !proposal.payloadAvailable && <p role="alert">提案来源当前不可读；合并内容已隐藏，不能确认。</p>}
    {targetMatches && proposal.payloadAvailable && loading && <p role="status">正在核对当前 Task 与验收版本…</p>}
    {targetMatches && proposal.payloadAvailable && error && <p className="action-error" role="alert">当前 Task 不可读取，合并内容已隐藏：{error}</p>}
    {targetMatches && proposal.payloadAvailable && <button className="secondary-button" type="button"
      disabled={loading} onClick={() => void load()}>重读当前版本</button>}
    {targetMatches && payload && task && <>
      <p data-testid="task-skill-proposal-status">{current
        ? "提案基线与当前 Task/验收版本一致。" :
          `提案已过期：当前 Task v${task.revision} / 验收 v${task.acceptance.acceptanceRevision}；请重新生成提案。`}</p>
      <h5>目标</h5><p>当前：{task.acceptance.objective || "空"}</p><p>合并后：{payload.objective}</p>
        <h5>结果契约</h5><p>当前：{JSON.stringify(task.acceptance.expectedOutputs ?? {})}</p>
        <p>合并后：{JSON.stringify(payload.requiredOutputSpec)}</p>
        <p>期望结果说明：{typeof task.acceptance.expectedOutputs?.description === "string"
          ? task.acceptance.expectedOutputs.description : "当前未填写"} →
          {typeof payload.requiredOutputSpec.description === "string"
            ? payload.requiredOutputSpec.description : "合并后未填写"}</p>
      <h5>服务端最终合并的验收条件</h5>
      <p className="helper-text">保留 {payload.preservedCriterionIds.length} 条；新增 {payload.addedCriterionIds.length} 条。来源标签由服务端给出，不从模型原文推断删除或覆盖。</p>
      <ol>{payload.criteria.map((criterion) => <li key={criterion.criterionId}>
        <strong>{criterion.source === "PRESERVED" ? "保留" : "新增"}：</strong>{criterion.statement} ·
        {criterion.required ? "必需" : "可选"} · {criterion.method} · {criterion.criterionId}
      </li>)}</ol>
      {payload.suggestedMode && <p className="helper-text">建议模式 {payload.suggestedMode}；本次接受只变更验收契约，不切换执行模式。</p>}
      <p className="helper-text">接受将创建新的 Task 验收版本。当前 CheckPlan 准入预览需在接受后重新读取；此提案不是 Run 冻结计划或检查结果。</p>
      {!acceptSupported && proposal.status === "PENDING" &&
        <p className="helper-text">当前注册表或冻结来源未确认此版本可接受；提案只读，不能确认。</p>}
      {proposal.status === "PENDING" && current && acceptSupported && !confirming && <button className="primary-button" type="button"
        disabled={disabled} onClick={() => setConfirming(true)}>查看确认操作</button>}
      {proposal.status === "PENDING" && current && acceptSupported && confirming && <div className="form-actions">
        <p>确认接受以上服务端合并结果，并写入新的 Task 验收版本？</p>
        <button className="primary-button" type="button" data-testid="task-skill-accept" disabled={disabled}
          onClick={() => onAccept(proposal)}>确认接受验收变更</button>
        <button className="secondary-button" type="button" disabled={disabled} onClick={() => setConfirming(false)}>取消</button>
      </div>}
    </>}
  </article>;
}
