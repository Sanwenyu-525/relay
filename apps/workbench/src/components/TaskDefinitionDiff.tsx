import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { RelayApiClient, RelayAssistSkillOutput, RelayTaskDetail } from "../api/relayClient";
import { describeLiveError } from "../lib/liveErrors";

type Criterion = { readonly statement: string; readonly required: boolean; readonly method: string };

function criterion(value: unknown): Criterion | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  return typeof item.statement === "string" && typeof item.required === "boolean" &&
    typeof item.method === "string" ? { statement: item.statement, required: item.required,
      method: item.method } : null;
}

function signature(value: Criterion): string {
  return JSON.stringify([value.statement, value.required, value.method]);
}

function describeCriterion(value: Criterion): string {
  return `${value.statement} · ${value.required ? "必需" : "可选"} · ${value.method}`;
}

function resultKind(task: RelayTaskDetail): string {
  if (task.acceptance.expectedOutputs === null) return "此 Task 响应未提供结果类型";
  const kind = task.acceptance.expectedOutputs.kind;
  if (typeof kind === "string") return kind;
  const artifacts = task.acceptance.expectedOutputs.artifacts;
  return Array.isArray(artifacts) && artifacts.every((value) => typeof value === "string")
    ? artifacts.join("、") || "当前验收未声明结果类型" : "当前验收未声明结果类型";
}

export default function TaskDefinitionDiff({ client, output, projectId }: {
  client: RelayApiClient; output: RelayAssistSkillOutput; projectId: string | null;
}) {
  const baseline = output.baseline;
  const baselineValid = output.targetKind === "TASK" && baseline.task_id === output.targetId &&
    baseline.project_id === projectId && typeof baseline.task_revision === "string" &&
    /^\d+$/u.test(baseline.task_revision) && typeof baseline.acceptance_revision === "string" &&
    /^\d+$/u.test(baseline.acceptance_revision);
  const [task, setTask] = useState<RelayTaskDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const requestVersion = useRef(0);

  useEffect(() => {
    const request = ++requestVersion.current;
    setTask(null); setError(null); setLoading(baselineValid);
    if (!baselineValid) {
      setError("建议的目标或基线与当前会话不一致，不能生成事实比较。");
      return () => { requestVersion.current++; };
    }
    void client.getTask(output.targetId).then((current) => {
      if (request !== requestVersion.current) return;
      if (current.id !== output.targetId || current.projectId !== projectId) {
        throw new Error("当前 Task 与建议的目标或项目不一致。");
      }
      setTask(current);
    }).catch((caught: unknown) => {
      if (request === requestVersion.current) {
        setTask(null); setError(`当前 Task 不可读取，无法比较建议：${describeLiveError(caught).message}`);
      }
    }).finally(() => { if (request === requestVersion.current) setLoading(false); });
    return () => { requestVersion.current++; };
  }, [client, output, projectId, reload]);

  const suggested = Array.isArray(output.payload.criteria)
    ? output.payload.criteria.map(criterion).filter((item): item is Criterion => item !== null) : [];
  const current = task?.acceptance.criteria ?? [];
  const remaining = new Map<string, number>();
  for (const item of current) remaining.set(signature(item), (remaining.get(signature(item)) ?? 0) + 1);
  const suggestedOnly: Criterion[] = [];
  let exactMatches = 0;
  for (const item of suggested) {
    const key = signature(item);
    if ((remaining.get(key) ?? 0) > 0) { remaining.set(key, (remaining.get(key) ?? 0) - 1); exactMatches++; }
    else suggestedOnly.push(item);
  }
  const currentOnly = current.filter((item) => {
    const key = signature(item);
    if ((remaining.get(key) ?? 0) === 0) return false;
    remaining.set(key, (remaining.get(key) ?? 0) - 1);
    return true;
  });
  const stale = task !== null && (task.revision !== baseline.task_revision ||
    task.acceptance.acceptanceRevision !== baseline.acceptance_revision);
  const proposedKind = typeof (output.payload.expected_outputs as Record<string, unknown> | undefined)?.kind === "string"
    ? String((output.payload.expected_outputs as Record<string, unknown>).kind) : "建议未声明结果类型";
  const proposedObjective = typeof output.payload.objective === "string" ? output.payload.objective : "—";
  const proposedMode = typeof output.payload.suggested_mode === "string" ? output.payload.suggested_mode : "—";
  const currentDescription = typeof task?.acceptance.expectedOutputs?.description === "string"
    ? task.acceptance.expectedOutputs.description : "未填写";
  const expectedOutputs = output.payload.expected_outputs as Record<string, unknown> | undefined;
  const proposedDescription = typeof expectedOutputs?.description === "string"
    ? expectedOutputs.description : "未填写";

  return <section className="assist-proposal" data-testid="assist-skill-output">
    <h4>任务定义建议 · 只读字段比较</h4>
    {loading && <p role="status">正在读取当前 Task 以核对建议基线…</p>}
    {error && <p className="action-error" role="alert">{error}</p>}
    {task && <>
      <p>建议摘要：{typeof output.payload.summary === "string" ? output.payload.summary : "—"}</p>
      <p className="helper-text">目标 <Link className="inline-link" to={`/tasks/${encodeURIComponent(task.id)}`}>{task.id}</Link> ·
        生成依据时间 {output.asOf} · 基线 Task v{String(baseline.task_revision)} / 验收 v{String(baseline.acceptance_revision)} ·
        当前 Task v{task.revision} / 验收 v{task.acceptance.acceptanceRevision}</p>
      <p className={stale ? "action-error" : "helper-text"} data-testid="assist-task-diff-status">
        {stale ? "建议基线已过期：当前 Task 或验收版本发生变化。以下仍是字段对照，不能视为可应用变更。" :
          "建议基线与当前 Task/验收版本一致；这只确认读取版本，不表示建议已接受。"}</p>
      <p className="helper-text">事实摘要 {output.basisSha256} · 输出摘要 {output.payloadSha256}</p>
      <h5>目标</h5><p>当前验收：{task.acceptance.objective || "未填写"}</p><p>模型建议：{proposedObjective}</p>
      <p className="helper-text">{task.acceptance.objective === proposedObjective ? "文字相同" : "文字不同"}</p>
      <h5>结果类型</h5><p>当前验收：{resultKind(task)}</p><p>模型建议：{proposedKind}</p>
      <h5>期望结果说明</h5><p>当前验收：{currentDescription}</p><p>模型建议：{proposedDescription}</p>
      <h5>任务模式</h5><p>当前 Task：{task.mode}</p><p>模型建议：{proposedMode}</p>
      <h5>验收条件</h5><p>当前 {current.length} 条，建议 {suggested.length} 条；字段完全相同 {exactMatches} 条。</p>
      {currentOnly.length > 0 && <><strong>当前条件中未被建议逐字重复</strong><ul>{currentOnly.map((item, index) =>
        <li key={index}>{describeCriterion(item)}</li>)}</ul></>}
      {suggestedOnly.length > 0 && <><strong>建议条件中未与当前字段完全相同</strong><ul>{suggestedOnly.map((item, index) =>
        <li key={index}>{describeCriterion(item)}</li>)}</ul></>}
      <p className="helper-text">此处仅按条件文字、必需性和方法逐字段比较；当前条件未重复不表示将被删除，建议条件未匹配不表示最终新增。实际合并结果须以后端 Task Owner 的预览为准；此处没有接受入口。</p>
    </>}
    <button className="secondary-button" type="button" disabled={loading || !baselineValid}
      onClick={() => { setTask(null); setError(null); setReload((value) => value + 1); }}>重新读取当前 Task</button>
  </section>;
}
