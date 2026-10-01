import { Link } from "react-router-dom";
import type { RelayApiClient, RelayAssistSkillOutput } from "../api/relayClient";
import TaskDefinitionDiff from "./TaskDefinitionDiff";
import TaskCheckPlanPreview from "./TaskCheckPlanPreview";

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function text(value: unknown): string { return typeof value === "string" ? value : "—"; }

function sourcePath(kind: unknown, id: unknown): string | null {
  if (typeof id !== "string") return null;
  if (kind === "PROJECT") return `/projects/${encodeURIComponent(id)}`;
  if (kind === "TASK") return `/tasks/${encodeURIComponent(id)}`;
  if (kind === "DECISION") return `/knowledge?kind=DECISION&item=${encodeURIComponent(id)}`;
  return null;
}

export default function AssistSkillOutput({ client, output, currentTarget }: { client: RelayApiClient;
  output: RelayAssistSkillOutput;
  currentTarget: { readonly kind: "PROJECT" | "TASK"; readonly id: string; readonly projectId: string | null };
}) {
  if (output.targetKind !== currentTarget.kind || output.targetId !== currentTarget.id) {
    return <section className="assist-proposal" data-testid="assist-skill-output" role="alert">
      消息目标与当前会话不一致，不能展示此建议。</section>;
  }
  if (output.kind === "TASK_DEFINITION_SUGGESTION") {
    return <section className="assist-skill-summary">
      <h4>任务定义建议 · {output.status}</h4>
      <p>{text(output.payload.summary)}</p>
      <p className="helper-text">只读建议；接受操作请查看会话中的服务端提议。</p>
      <details className="assist-skill-details"><summary>查看完整建议与字段比较</summary>
        <TaskDefinitionDiff client={client} output={output} projectId={currentTarget.projectId} />
      </details>
    </section>;
  }
  if (output.kind === "PROJECT_BLUEPRINT_SUGGESTION") {
    return <section className="assist-proposal" data-testid="assist-skill-output">
      <h4>项目蓝图建议 · {output.status}</h4>
      <p>{text(output.payload.summary)}</p>
      <p className="helper-text">模型输出只读，尚未应用。请在
        <Link className="inline-link" to={`/projects/${output.targetId}?skill=blueprint`}>项目蓝图</Link>
        中核对对应服务端提案、基线和 Diff 后显式确认。</p>
    </section>;
  }
  const payload = output.payload;
  const targetPath = sourcePath(output.targetKind, output.targetId);
  const highlights = Array.isArray(payload.highlights) ? payload.highlights : [];
  const nextSteps = Array.isArray(payload.next_steps) ? payload.next_steps : [];
  const checks = Array.isArray(payload.checks) ? payload.checks : [];
  const additionalChecks = Array.isArray(payload.additional_checks) ? payload.additional_checks : [];
  return <section className="assist-proposal" data-testid="assist-skill-output">
    <h4>{output.kind === "VERIFICATION_PLAN_SUGGESTION" ? "验收方案建议" : "项目速览（生成时快照）"} · {output.status}</h4>
    <p>{text(payload.summary)}</p>
    <p className="helper-text">{output.kind === "VERIFICATION_PLAN_SUGGESTION"
      ? `只读建议 · ${additionalChecks.length > 0 ? additionalChecks.length : checks.length} 项检查；接受操作请查看会话中的服务端提议。`
      : `只读速览 · ${highlights.length} 个事实要点，${nextSteps.length} 条下一步建议。`}</p>
    <details className="assist-skill-details"><summary>查看完整{output.kind === "VERIFICATION_PLAN_SUGGESTION" ? "验收建议与当前准入" : "速览与来源"}</summary>
    {output.kind === "PROJECT_RESUME" && <>
      <h5>事实要点</h5><ul>{highlights.map((value, index) => { const item = record(value);
        const path = sourcePath(item?.ref_kind, item?.ref_id);
        return <li key={index}>{text(item?.statement)} · 来源 {text(item?.ref_kind)} {path
          ? <Link className="inline-link" to={path}>{text(item?.ref_id)}</Link> : text(item?.ref_id)}</li>;
      })}</ul>
      <h5>模型文字建议的下一步</h5><ul>{nextSteps.map((value, index) => <li key={index}>{text(value)}</li>)}</ul>
      <p className="helper-text">这些文字不是 Today 判定的合格 Task，也不是启动动作。只读速览没有比较基线，不表示自上次以来发生了变化。</p>
    </>}
    {output.kind === "VERIFICATION_PLAN_SUGGESTION" && <>
      {additionalChecks.length > 0 ? <><h5>建议追加的检查</h5><ul>{additionalChecks.map((value, index) => {
        const item = record(value);
        return <li key={index}>{text(item?.statement)} · {item?.required === true ? "必需" : "可选"} · {text(item?.method)}</li>;
      })}</ul><p className="helper-text">这些是模型建议；服务端合并提案另列保留条件和最终追加项，需明确确认后才可能修改 Task 验收。</p></>
        : <><h5>历史建议检查</h5><ul>{checks.map((value, index) => { const item = record(value);
          return <li key={index}>条件 {text(item?.criterion_id)} · 检查器 {text(item?.checker_id)} v{text(item?.checker_version)} · {item?.required === true ? "必需" : "可选"}</li>;
        })}</ul><p className="helper-text">此历史输出只读，不提供接受入口。</p></>}
      <TaskCheckPlanPreview client={client} taskId={output.targetId} />
      <p className="helper-text">当前准入预览与建议及历史 Run Trace 分属不同事实；建议本身不是有效计划或验证结果。</p>
    </>}
      <details><summary>生成依据与内容摘要</summary>
        <p className="helper-text">目标 {output.targetKind} · {targetPath
          ? <Link className="inline-link" to={targetPath}>{output.targetId}</Link> : output.targetId} · 生成依据时间 {output.asOf}</p>
        <p className="helper-text">基线 {JSON.stringify(output.baseline)} · 事实摘要 {output.basisSha256} · 输出摘要 {output.payloadSha256}</p>
      </details>
    </details>
  </section>;
}
