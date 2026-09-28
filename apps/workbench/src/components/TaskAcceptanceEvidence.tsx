import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { RelayApiClient, RelayCompletionEvidence, RelayRunTrace, RelayTaskAcceptance,
  RelayTaskArtifacts, RelayTaskCheckPlanPreview } from "../api/relayClient";
import { describeLiveError } from "../lib/liveErrors";

interface EvidenceSnapshot {
  readonly plan: RelayTaskCheckPlanPreview | null;
  readonly artifacts: RelayTaskArtifacts | null;
  readonly trace: RelayRunTrace | null;
  readonly completion: RelayCompletionEvidence | null;
  readonly stale: boolean;
  readonly errors: readonly string[];
}

function matchingSession(snapshot: EvidenceSnapshot, acceptanceRevision: string) {
  const { plan, artifacts, trace } = snapshot;
  if (snapshot.stale || snapshot.errors.length || !plan?.checkPlanSha256 || !artifacts || !trace) return null;
  const latest = new Map(artifacts.items.filter((item) => item.latestVersionId !== null).map((item) => {
    const version = item.versions.find((candidate) => candidate.artifactVersionId === item.latestVersionId);
    return [item.latestVersionId!, version?.sha256 ?? null] as const;
  }));
  if (!latest.size || [...latest.values()].some((sha) => sha === null)) return null;
  return [...trace.verifications].reverse().find((session) => session.finalizedAt !== null &&
    session.acceptanceRevision === acceptanceRevision &&
    session.checkPlanHash === plan.checkPlanSha256 && session.targets.length === latest.size &&
    session.targets.every((target) => latest.get(target.artifactVersionId) === target.contentSha256)) ?? null;
}

export default function TaskAcceptanceEvidence({ client, taskId, taskRevision, acceptance, runId, completionId }: {
  readonly client: RelayApiClient; readonly taskId: string; readonly taskRevision: string;
  readonly acceptance: RelayTaskAcceptance; readonly runId: string | null; readonly completionId: string | null;
}) {
  const [snapshot, setSnapshot] = useState<EvidenceSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const version = useRef(0);
  async function load() {
    const request = ++version.current;
    setLoading(true); setSnapshot(null);
    const [planResult, artifactResult, traceResult, completionResult] = await Promise.allSettled([
      client.getTaskCheckPlanPreview(taskId), client.getTaskArtifacts(taskId),
      runId ? client.getRunTrace(runId) : Promise.resolve(null),
      completionId ? client.getCompletionEvidence(completionId) : Promise.resolve(null)
    ]);
    const errors: string[] = [];
    const plan = planResult.status === "fulfilled" ? planResult.value : null;
    const artifacts = artifactResult.status === "fulfilled" ? artifactResult.value : null;
    const trace = traceResult.status === "fulfilled" ? traceResult.value : null;
    const completion = completionResult.status === "fulfilled" ? completionResult.value : null;
    if (planResult.status === "rejected") errors.push(`CheckPlan 读取失败：${describeLiveError(planResult.reason).message}`);
    if (artifactResult.status === "rejected") errors.push(`产物版本读取失败：${describeLiveError(artifactResult.reason).message}`);
    if (traceResult.status === "rejected") errors.push(`Run 验证证据读取失败：${describeLiveError(traceResult.reason).message}`);
    if (completionResult.status === "rejected") errors.push(`完成凭据读取失败：${describeLiveError(completionResult.reason).message}`);
    if (plan && (plan.taskId !== taskId || plan.sources.taskRevision !== taskRevision ||
      plan.sources.acceptanceRevision !== acceptance.acceptanceRevision)) errors.push("CheckPlan 与当前 Task/验收版本不一致。");
    if (trace && (trace.taskId !== taskId || trace.runId !== runId)) errors.push("Run Trace 与当前 Task/Run 身份不一致。");
    if (completion && (completion.taskId !== taskId || completion.completionId !== completionId)) errors.push("完成凭据与当前 Task/Completion 身份不一致。");
    let stale = false;
    try {
      const current = await client.getTask(taskId);
      stale = current.revision !== taskRevision || current.acceptance.acceptanceRevision !== acceptance.acceptanceRevision ||
        current.executorRunId !== runId || current.currentCompletionId !== completionId;
    } catch (caught) { errors.push(`Task 当前版本复核失败：${describeLiveError(caught).message}`); }
    if (request === version.current) { setSnapshot({ plan, artifacts, trace, completion, stale, errors }); setLoading(false); }
  }
  useEffect(() => { void load(); return () => { version.current++; }; }, [client, taskId, taskRevision, acceptance.acceptanceRevision, runId, completionId]);

  const session = snapshot ? matchingSession(snapshot, acceptance.acceptanceRevision) : null;
  const completed = snapshot?.completion?.isCurrent === true && !snapshot.stale && !snapshot.errors.length &&
    snapshot.completion.acceptanceRevision === acceptance.acceptanceRevision &&
    snapshot.completion.acceptance.availability === "AVAILABLE" &&
    snapshot.completion.artifactVersions.every((version) => version.availability === "AVAILABLE");
  const historicalSessions = snapshot?.trace?.verifications ?? [];
  const expectedOutputs = acceptance.expectedOutputs === null ? [] : Object.entries(acceptance.expectedOutputs);
  return <section className="surface-panel" data-testid="task-acceptance-evidence"><h2>验收依据</h2>
    <p className="helper-text">接受这个任务前，这里汇总它与当前版本的验收目标、检查计划和 Run 证据；计划只是准入预览，不代表已经执行或通过。</p>
    <button className="secondary-button" type="button" disabled={loading} onClick={() => void load()}>刷新验收依据</button>
    <p>目标：{acceptance.objective || "当前验收目标为空。"} · 验收 v{acceptance.acceptanceRevision} · 来源 {acceptance.source}</p>
    <p>预期产物：{expectedOutputs.length
      ? expectedOutputs.map(([name, kind]) => <span key={name} className="expected-output-chip">{name}：{String(kind)}</span>)
      : "当前响应未提供"}</p>
    {loading && <p role="status">正在核对计划、产物、Run 与完成凭据…</p>}
    {snapshot?.stale && <p role="alert">Task 或验收版本在读取期间变化；以下结果不能视为当前证据，请刷新任务详情。</p>}
    {snapshot && snapshot.errors.length > 0 && <div className="warning-callout" role="alert"><strong>证据读取不完整，不能判定当前通过</strong><ul>{snapshot.errors.map((error) => <li key={error}>{error}</li>)}</ul></div>}
    {snapshot && <><p>当前 CheckPlan：{snapshot.plan?.status ?? "不可用"}<code className="hash-code">{snapshot.plan?.checkPlanSha256 ?? "无计划摘要"}</code>。这是读时预览，尚未执行。</p>
      <p>当前 Run 验证会话：{historicalSessions.length} 项；版本与计划匹配的历史会话：{session ? session.id : "无"}。Trace 不含当前适用性或撤销事实，匹配也不能证明当前有效。</p>
      {completionId && <p>完成凭据 {completionId}：{completed ? "当前周期、验收与产物来源已核对" : "不适用、来源缺失或读取未完成"}；
        验证 {snapshot.completion?.verificationSession?.status ?? "未关联"} / {snapshot.completion?.verificationSession?.verdict ?? "无判定"}；
        当前适用性 {snapshot.completion?.verificationSession?.applicable === true ? "服务端确认为适用" : "未确认或不适用"}。</p>}
      {historicalSessions.length > 0 && !session && <p>已有历史检查，但验收版本、计划摘要或当前产物版本未全部匹配；旧结果不适用于本次判定。</p>}
      <ul className="criteria-list">{acceptance.criteria.map((criterion) => {
        const entry = snapshot.plan?.checkPlan?.entries.find((candidate) => candidate.criterionId === criterion.criterionId);
        const check = session?.checks.find((candidate) => candidate.criterionId === criterion.criterionId);
        const humanAccepted = completed && snapshot.completion?.humanAcceptance?.availability === "AVAILABLE" &&
          snapshot.completion.humanAcceptance.acceptedCriterionIds.includes(criterion.criterionId);
        const result = check?.result === "ERROR" ? "历史检查器错误，当前适用性未核实" : check?.result === "PASS" ? "版本匹配的历史检查 PASS，当前适用性未核实" :
          check ? `检查结果 ${check.result}` : historicalSessions.length && !session ? "旧结果不适用" :
            snapshot.completion?.verificationSession ? "完成凭据关联验证会话；本页无逐项检查" : "检查未运行或未关联";
        return <li key={criterion.criterionId} className="criteria-row" data-testid={`acceptance-criterion-${criterion.criterionId}`}>
          <span className="criteria-copy"><strong>{criterion.statement}</strong><small>{criterion.required ? "必需" : "可选"} · 条件 {criterion.criterionId} · 方式 {criterion.method}</small>
            <small>受验对象：{criterion.targetSpec === null ? "当前响应未提供 target_spec" : JSON.stringify(criterion.targetSpec)}</small>
            <small>计划关联：{entry ? `${entry.checkerId} v${entry.checkerVersion}` : "未关联当前 CheckPlan"}；实际证据：{result}；人工证据：{humanAccepted ? "当前完成凭据已接受" : "无当前完成凭据关联"}</small>
            <small>下一步：{check?.result === "ERROR" ? "在原 Run 核对检查器错误" : !entry ? "在验收方案核对检查关联" : !check ? "运行或核对原 Run 的当前版本检查" : check.result !== "PASS" && !humanAccepted ? "在原任务或 Review 核对缺口" : "核对完成凭据与组合版本"}。</small></span>
        </li>;
      })}</ul>
      {!acceptance.criteria.length && <p>当前验收版本没有重要行为条件；不能据此宣称需求已覆盖。</p>}
      <p>覆盖完整性：未知。测试通过数量不说明必需行为已全部列出；多个 Task 分别通过也不证明最终组合版本通过。</p>
      <p>组合版本证据：当前接口没有可核对的组合版本与验证会话绑定，显示为未验证。</p>
      {runId && <Link className="inline-link" to={`/runs/${runId}`}>打开原 Run 检查与人工决定</Link>}
      {completionId && <p><Link className="inline-link" to={`/completion-records/${completionId}`}>查看确切完成凭据</Link></p>}
      <p><Link className="inline-link" to={`/tasks/${taskId}?skill=verification`}>打开验收方案</Link>；<Link className="inline-link" to={`/tasks/${taskId}?tab=artifacts`}>查看产物版本</Link></p>
    </>}
  </section>;
}
