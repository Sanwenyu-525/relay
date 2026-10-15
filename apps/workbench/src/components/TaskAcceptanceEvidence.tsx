import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { RelayApiClient, RelayCompletionEvidence, RelayRunTrace, RelayTaskAcceptance,
  RelayTaskArtifacts, RelayTaskCheckPlanPreview } from "../api/relayClient";
import { acceptanceSourceLabels, availabilityLabel, checkResultLabel, criterionMethodLabel } from "../lib/labels";
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
  const sourceLabel = acceptanceSourceLabels[acceptance.source] ?? acceptance.source;
  const sourceRaw = acceptanceSourceLabels[acceptance.source] !== undefined;
  // 主阅读位按四种事实给结论：是否运行、是否关联、版本是否匹配、结果是否仍适用。
  // 尚未加载（loading 提示）/ 确认没有 / 字段缺失三种状态使用不同文案，不互相冒充。
  // 无 Run 分支按真实 runId prop 判定：只陈述「当前未关联执行记录」，不由空验证数组、
  // 页面标题或任务状态反推「尚未运行检查」，也不声称任务从未有过历史执行；
  // 读取失败与读取期间版本变化各自保留不确定文案，不冒充「没有运行」。
  const runFact = snapshot === null ? null : snapshot.stale
    ? "读取期间任务或验收版本已变化，当前关联的执行记录需刷新后再判定。"
    : snapshot.errors.length > 0 ? "证据读取不完整，不能判定是否运行。"
    : !snapshot.plan ? "当前响应未提供检查计划。"
    : runId === null ? "当前任务未关联执行记录（Run）。"
    : historicalSessions.length === 0 ? "尚未运行检查：当前 Run 没有已完成的验证会话。"
    : `已出结果：共 ${historicalSessions.length} 项验证会话记录。`;
  const linkedCount = snapshot?.plan?.checkPlan
    ? acceptance.criteria.filter((criterion) => snapshot.plan!.checkPlan!.entries.some((entry) => entry.criterionId === criterion.criterionId)).length
    : 0;
  const linkFact = snapshot === null ? null : !snapshot.plan?.checkPlan ? "当前响应未提供检查计划关联。"
    : !acceptance.criteria.length ? "当前验收版本没有条件。"
    : linkedCount === acceptance.criteria.length ? "全部条件已关联检查计划的检查项。"
    : linkedCount > 0 ? "只有部分条件已关联检查计划；未关联条件需要人工核对。"
    : "条件未关联当前 CheckPlan。";
  const matchFact = snapshot === null ? null : snapshot.errors.length > 0 ? "读取不完整，不能判定版本匹配。"
    : session ? "存在与当前验收版本、计划摘要和产物版本都匹配的历史会话。"
    : historicalSessions.length > 0 ? "没有匹配当前验收版本与产物版本的历史会话。"
    : "尚无可比对的验证会话。";
  const applyFact = snapshot === null ? null : snapshot.stale ? "读取期间版本已变化，结果不能视为当前证据。"
    : snapshot.errors.length > 0 ? "证据读取不完整，适用性未确认。"
    : completionId && snapshot.completion ? (snapshot.completion.verificationSession?.applicable === true ? "服务端确认为适用。" : "未确认或不适用。")
    : completionId ? "完成凭据读取未完成，适用性未确认。"
    : "未确认：当前没有完成凭据可核对。";
  return <section className="task-detail-section task-detail-evidence" data-testid="task-acceptance-evidence">
    <div className="task-detail-section-heading">
      <h2>验收依据</h2>
      <button className="task-detail-text-button" type="button" disabled={loading} onClick={() => void load()}>刷新验收依据</button>
    </div>
    <p className="helper-text">接受这个任务前，这里汇总它与当前版本的验收目标、检查计划和 Run 证据；计划只是准入预览，不代表已经执行或通过。</p>
    <p className="task-detail-evidence-line">目标：{acceptance.objective || "当前验收目标为空。"} · 来源 {sourceLabel}{sourceRaw && <small title={acceptance.source}>（{acceptance.source}）</small>} · 验收 v{acceptance.acceptanceRevision}</p>
    <p className="task-detail-evidence-line">预期产物：{expectedOutputs.length
      ? expectedOutputs.map(([name, kind]) => <span key={name} className="expected-output-chip">{name}：{String(kind)}</span>)
      : "当前响应未提供"}</p>
    {loading && <p role="status">{runId === null ? "正在核对计划、产物与完成凭据…" : "正在核对计划、产物、Run 与完成凭据…"}</p>}
    {snapshot?.stale && <p role="alert">Task 或验收版本在读取期间变化；以下结果不能视为当前证据，请刷新任务详情。</p>}
    {snapshot && snapshot.errors.length > 0 && <div className="warning-callout" role="alert"><strong>证据读取不完整，不能判定当前通过</strong><ul>{snapshot.errors.map((error) => <li key={error}>{error}</li>)}</ul></div>}
    {snapshot && <><dl className="rail-definition-list task-detail-evidence-facts">
      <div><dt>检查是否运行</dt><dd>{runFact}</dd></div>
      <div><dt>证据是否关联</dt><dd>{linkFact}</dd></div>
      <div><dt>版本是否匹配</dt><dd>{matchFact}</dd></div>
      <div><dt>当前结果是否适用</dt><dd>{applyFact}</dd></div>
    </dl>
    <details className="task-detail-tech">
      <summary>技术细节：计划摘要、验证会话与完成凭据</summary>
      <p>当前 CheckPlan：{availabilityLabel(snapshot.plan?.status)}<code className="hash-code">{snapshot.plan?.checkPlanSha256 ?? "无计划摘要"}</code>。这是读时预览，尚未执行。</p>
      {runId === null
        ? <p>当前任务未关联执行记录（Run）；本页没有可核对的运行验证会话，版本与计划匹配的历史会话：无。Trace 不含当前适用性或撤销事实，匹配也不能证明当前有效。</p>
        : <p>当前 Run 验证会话：{historicalSessions.length} 项；版本与计划匹配的历史会话：{session ? session.id : "无"}。Trace 不含当前适用性或撤销事实，匹配也不能证明当前有效。</p>}
      {completionId && <p>完成凭据 {completionId}：{completed ? "当前周期、验收与产物来源已核对" : "不适用、来源缺失或读取未完成"}；
        验证 {snapshot.completion?.verificationSession?.status ?? "未关联"} / {snapshot.completion?.verificationSession?.verdict ?? "无判定"}；
        当前适用性 {snapshot.completion?.verificationSession?.applicable === true ? "服务端确认为适用" : "未确认或不适用"}。</p>}
    </details></>}
    {snapshot && historicalSessions.length > 0 && !session && <p>已有历史检查，但验收版本、计划摘要或当前产物版本未全部匹配；旧结果不适用于本次判定。</p>}
    {/* 验收依据的这份条件列表是 <ul>：没有编号元素，行内只有正文一个子节点。
        它与「验收条件」的有编号 <ol> 行类同名但结构不同，因此带专属修饰类
        （task-detail-criteria-list--evidence）让 CSS 显式声明单列；不复用两列网格，
        否则正文会自动落进编号列宽度，被挤成竖排窄条。 */}
    {snapshot && <ul className="task-detail-criteria-list task-detail-criteria-list--evidence" data-testid="acceptance-evidence-criteria">{acceptance.criteria.map((criterion) => {
      const entry = snapshot.plan?.checkPlan?.entries.find((candidate) => candidate.criterionId === criterion.criterionId);
      const check = session?.checks.find((candidate) => candidate.criterionId === criterion.criterionId);
      const humanAccepted = completed && snapshot.completion?.humanAcceptance?.availability === "AVAILABLE" &&
        snapshot.completion.humanAcceptance.acceptedCriterionIds.includes(criterion.criterionId);
      const result = check?.result === "ERROR" ? "历史检查器错误，当前适用性未核实" : check?.result === "PASS" ? "版本匹配的历史检查 PASS，当前适用性未核实" :
        check ? `检查结果 ${checkResultLabel(check.result)}（${check.result}）` : historicalSessions.length && !session ? "旧结果不适用" :
          snapshot.completion?.verificationSession ? "完成凭据关联验证会话；本页无逐项检查" : "检查未运行或未关联";
      const nextStep = check?.result === "ERROR" ? "在原 Run 核对检查器错误" : !entry ? "在验收方案核对检查关联"
        // 无 Run 时下一步指向任务工作区/验收方案中可实际完成的人工操作，不引导核对不存在的 Run。
        : !check ? (runId === null ? "人工核对本条件，并在任务工作区补充人工证据" : "运行或核对原 Run 的当前版本检查")
        : check.result !== "PASS" && !humanAccepted ? "在原任务或 Review 核对缺口" : "核对完成凭据与组合版本";
      const methodLabel = criterionMethodLabel(criterion.method);
      const targetSpecText = criterion.targetSpec === null ? "当前响应未提供"
        : Object.keys(criterion.targetSpec).length === 0 ? "未提供具体检查对象" : "已提供，展开查看技术 JSON";
      return <li key={criterion.criterionId} className="task-detail-criterion" data-testid={`acceptance-criterion-${criterion.criterionId}`}>
        <div className="task-detail-criterion-body">
          <p className="task-detail-criterion-statement">{criterion.statement}</p>
          <p className="task-detail-criterion-meta">
            <span className={`status-chip${criterion.required ? "" : " status-chip--neutral"}`}>{criterion.required ? "必需" : "可选"}</span>
            <span>验证方式：{methodLabel}{methodLabel !== criterion.method && <small title={criterion.method}>（{criterion.method}）</small>}</span>
            <small>条件 {criterion.criterionId}</small>
            <small>计划关联：{entry ? `${entry.checkerId} v${entry.checkerVersion}` : "未关联当前 CheckPlan"}</small>
            <small>人工证据：{humanAccepted ? "当前完成凭据已接受" : "无当前完成凭据关联"}</small>
          </p>
          <p className="task-detail-criterion-result">实际证据：{result}</p>
          <p className="task-detail-criterion-next">下一步：{nextStep}。</p>
          <p className="task-detail-criterion-meta"><small>受验对象：{targetSpecText}</small></p>
          {criterion.targetSpec !== null && Object.keys(criterion.targetSpec).length > 0 &&
            <details className="task-detail-tech"><summary>受验对象 JSON</summary><code>{JSON.stringify(criterion.targetSpec)}</code></details>}
        </div>
      </li>;
    })}</ul>}
    {snapshot && !acceptance.criteria.length && <p>当前验收版本没有重要行为条件；不能据此宣称需求已覆盖。</p>}
    <p className="helper-text">覆盖完整性：未知。测试通过数量不说明必需行为已全部列出；多个 Task 分别通过也不证明最终组合版本通过。</p>
    <p className="helper-text">组合版本证据：当前接口没有可核对的组合版本与验证会话绑定，显示为未验证。</p>
    {runId && <Link className="inline-link" to={`/runs/${runId}`}>打开原 Run 检查与人工决定</Link>}
    {completionId && <p><Link className="inline-link" to={`/completion-records/${completionId}`}>查看确切完成凭据</Link></p>}
    <p><Link className="inline-link" to={`/tasks/${taskId}?skill=verification`}>打开验收方案</Link>；<Link className="inline-link" to={`/tasks/${taskId}?tab=artifacts`}>查看产物版本</Link></p>
  </section>;
}
