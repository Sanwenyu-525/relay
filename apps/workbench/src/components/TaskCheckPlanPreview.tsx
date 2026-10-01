import { useEffect, useRef, useState } from "react";
import type { RelayApiClient, RelayTaskCheckPlanPreview } from "../api/relayClient";
import { describeLiveError } from "../lib/liveErrors";
import "./TaskCheckPlanPreview.css";

/** 当前验收和规则的读时派生；不会把它包装成 Run 证据。 */
export default function TaskCheckPlanPreview({ client, taskId, taskRevision, acceptanceRevision }: {
  client: RelayApiClient; taskId: string; taskRevision?: string; acceptanceRevision?: string;
}) {
  const [preview, setPreview] = useState<RelayTaskCheckPlanPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const version = useRef(0);

  async function load() {
    const current = ++version.current;
    setLoading(true); setPreview(null); setError(null);
    try {
      const result = await client.getTaskCheckPlanPreview(taskId);
      if (current === version.current) setPreview(result);
    } catch (caught) {
      if (current === version.current) setError(describeLiveError(caught).message);
    } finally { if (current === version.current) setLoading(false); }
  }
  useEffect(() => { void load(); return () => { version.current++; }; }, [client, taskId]);
  const sameTaskSnapshot = preview !== null &&
    (taskRevision === undefined || preview.sources.taskRevision === taskRevision) &&
    (acceptanceRevision === undefined || preview.sources.acceptanceRevision === acceptanceRevision);
  return <section className="surface-panel task-check-plan" data-testid="task-check-plan-preview">
    <div className="task-check-plan-heading"><h3>当前检查方案</h3>
      <button className="secondary-button" type="button" disabled={loading} onClick={() => void load()}>刷新准入预览</button></div>
    <p className="helper-text">由读取时的 Task 验收与规则派生；不是活动 Run 的冻结计划，也没有执行检查或得出 PASS。</p>
    {loading && <p role="status">正在读取当前准入预览…</p>}
    {error && <p className="action-error" role="alert">预览不可读取：{error}</p>}
    {preview && <>
      <p className="metadata-row">Task v{preview.sources.taskRevision} · 验收 v{preview.sources.acceptanceRevision} ·
        {preview.admissionAvailable && sameTaskSnapshot ? "当前查询可准入" : "当前不可据此准入"}</p>
      {!sameTaskSnapshot && <p role="alert">Task 与预览读取期间版本已变化，请刷新当前事实。</p>}
      {preview.checkPlan && sameTaskSnapshot && <div className="task-check-plan-scroll" role="region" aria-label="当前检查项表格" tabIndex={0}><table className="task-check-plan-table">
        <caption className="visually-hidden">当前派生检查项与检查方式，尚未执行</caption>
        <thead><tr><th scope="col">检查项</th><th scope="col">方式</th><th scope="col">当前状态</th></tr></thead>
        <tbody>{preview.checkPlan.entries.map((entry) => <tr key={entry.criterionId}>
          <th scope="row"><span>{entry.statement}</span><small>{entry.required ? "必需检查" : "可选检查"}</small></th>
          <td>{entry.method === "HUMAN" ? "人工判断" : entry.method}</td>
          <td><span className="task-check-plan-state"><span aria-hidden="true" className="task-check-plan-dot" />
            {entry.method === "HUMAN" ? "待人工检查" : "未运行"}</span></td>
        </tr>)}</tbody>
      </table></div>}
      {preview.status === "UNAVAILABLE" && <p className="warning-callout">当前检查方案不可用，不能据此准入。请核对下方来源与原因；不能跳过必需检查。</p>}
      <details className="task-check-plan-details"><summary>查看准入原因与技术来源</summary>
        <p className="helper-text">状态 {preview.status} · 规则 v{preview.sources.ruleRevision ?? "不可用"} · Workflow {preview.sources.workflowKey} v{preview.sources.workflowVersion}</p>
        <p className="helper-text">规则来源：{preview.sources.ruleRefs.length
          ? preview.sources.ruleRefs.map((ref) => `${ref.ruleId} v${ref.version}`).join("；") : "无可列出的规则引用"}</p>
        <p className="helper-text">原因代码：{preview.reasonCodes.length ? preview.reasonCodes.join("、") : "无"}</p>
        {preview.checkPlan && sameTaskSnapshot && <>
          <p className="helper-text">派生计划摘要 <code className="hash-code">{preview.checkPlanSha256}</code> · 策略 {preview.checkPlan.policyVersion}</p>
          <ul>{preview.checkPlan.entries.map((entry) => <li key={entry.criterionId}>
            {entry.criterionId} · {entry.checkerId} v{entry.checkerVersion} · {entry.severity}
          </li>)}</ul>
        </>}
        <p className="helper-text">frozen_run_plan=false · executed=false；实际 Run 的冻结和验证只看该 Run 证据。</p>
      </details>
    </>}
  </section>;
}
