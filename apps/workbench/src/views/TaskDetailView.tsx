import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Info, RotateCcw } from "lucide-react";
import ArtifactPanel from "../components/ArtifactPanel";
import PageHeader from "../components/PageHeader";
import TaskAcceptanceEvidence from "../components/TaskAcceptanceEvidence";
import TaskAcceptanceEditPanel from "../components/TaskAcceptanceEditPanel";
import TaskDelegatePanel from "../components/TaskDelegatePanel";
import StatusChip from "../components/StatusChip";
import { RelayApiError, type RelayAcceptanceCriterion, type RelayApiClient, type RelayTaskAcceptance } from "../api/relayClient";
import { fixtureAdapter } from "../fixtures/fixtureAdapter";
import { fixtureModeFromQuery } from "../lib/fixtureMode";
import { acceptanceSourceLabels, criterionMethodLabel, executorLabels, interactionModeLabels, taskStatusLabels } from "../lib/labels";
import { describeLiveError } from "../lib/liveErrors";
import { useRelayConnection } from "../lib/relayConnection";
import { handleTabListKeyDown } from "../lib/tabNavigation";
import type { DecimalRevision, ExecutorKind, FixtureError, InteractionMode, TaskStatus } from "../types";
import "./TaskDetailView.css";

interface TaskDetailResult {
  readonly source: "fixture" | "live";
  readonly projectArchivedAt: string | null | undefined;
  readonly projectReadError: string | null;
  readonly projectTitle: string | null;
  readonly task: { readonly id: string; readonly title: string; readonly status: TaskStatus; readonly mode: InteractionMode; readonly executor: ExecutorKind; readonly revision: DecimalRevision; readonly acceptanceRevision: DecimalRevision; readonly currentCompletionId: string | null; readonly projectId: string | null; readonly runId: string | null; readonly allowedActions: readonly string[] | null };
  readonly objective: string | null;
  readonly acceptance: RelayTaskAcceptance | null;
  readonly criteria: readonly RelayAcceptanceCriterion[];
  readonly criteriaNote: string;
  readonly dependencies: readonly { readonly id: string; readonly title: string; readonly status: TaskStatus }[];
}
const tabs = [{ key: "overview", label: "概览" }, { key: "artifacts", label: "产物" }, { key: "runs", label: "执行记录" }] as const;

/** 验收来源说明：已知枚举显示中文与原枚举，未知开放扩展值只显示一次，不重复。 */
function criteriaNoteFrom(source: string): string {
  const label = acceptanceSourceLabels[source];
  return label === undefined ? `来源：${source}。` : `来源：${label}（${source}）。`;
}

export default function TaskDetailView() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const [query] = useSearchParams();
  const mode = fixtureModeFromQuery(query);
  const connection = useRelayConnection();
  const live = connection.mode === "live";
  const targetKey = `${connection.epoch}:${id}:${mode}`;
  const [result, setResult] = useState<TaskDetailResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [taskUnavailable, setTaskUnavailable] = useState(false);
  const [tab, setTab] = useState<"overview" | "artifacts" | "runs">(() => {
    const requested = query.get("tab");
    return requested === "artifacts" || requested === "runs" ? requested : "overview";
  });
  const [refreshing, setRefreshing] = useState(false);
  const [artifactVisited, setArtifactVisited] = useState(query.get("tab") === "artifacts");
  const routeTab = query.get("tab");
  useEffect(() => {
    const next = routeTab === "artifacts" || routeTab === "runs" ? routeTab : "overview";
    setTab(next); if (next === "artifacts") setArtifactVisited(true);
  }, [routeTab, id]);
  const requestVersion = useRef(0);
  const disposed = useRef(false);
  const loadedTarget = useRef<string | null>(null);
  const activeTarget = useRef(targetKey);
  activeTarget.current = targetKey;
  async function loadFixture(): Promise<TaskDetailResult | null> {
    const snapshot = await fixtureAdapter.loadTask(id, mode);
    if (!snapshot) return null;
    const record = snapshot.task;
    return { source: "fixture", projectArchivedAt: null, projectReadError: null, projectTitle: null, task: { id: record.id, title: record.title, status: record.status, mode: record.mode, executor: record.executor, revision: record.revision, acceptanceRevision: snapshot.verification.acceptanceRevision, currentCompletionId: null, projectId: snapshot.id, runId: null, allowedActions: null }, objective: record.definition.objective, acceptance: null, criteria: snapshot.verification.checks.map((check) => ({ criterionId: check.id, statement: check.title, required: check.required, method: check.method, targetSpec: null })), criteriaNote: "示例验收方案，不代表服务端当前验收版本。", dependencies: [] };
  }
  async function loadLive(client: RelayApiClient): Promise<TaskDetailResult> {
    const task = await client.getTask(id);
    if (task.id !== id) throw new Error("Task 单读与当前目标不匹配。");
    let projectArchivedAt: string | null | undefined = null;
    let projectReadError: string | null = null;
    let projectTitle: string | null = null;
    if (task.projectId !== null) {
      projectArchivedAt = undefined;
      try {
        const project = await client.getProject(task.projectId);
        if (project.id !== task.projectId) throw new Error("Project 单读与当前 Task 不匹配。");
        projectArchivedAt = project.archivedAt;
        projectTitle = project.title;
      } catch (caught) { projectReadError = describeLiveError(caught).message; }
    }
    return { source: "live", projectArchivedAt, projectReadError, projectTitle, task: { id: task.id, title: task.title, status: task.status, mode: task.mode, executor: task.executor, revision: task.revision, acceptanceRevision: task.acceptance.acceptanceRevision, currentCompletionId: task.currentCompletionId, projectId: task.projectId, runId: task.executorRunId, allowedActions: task.allowedActions }, objective: task.acceptance.objective || null, acceptance: task.acceptance, criteria: task.acceptance.criteria, criteriaNote: criteriaNoteFrom(task.acceptance.source), dependencies: task.dependencies.map((dependency) => ({ id: dependency.taskId, title: dependency.title, status: dependency.status })) };
  }
  async function load() {
    const request = ++requestVersion.current;
    if (loadedTarget.current !== targetKey) { loadedTarget.current = targetKey; setResult(null); setTaskUnavailable(false); setLoading(true); setRefreshing(false); }
    else if (result) setRefreshing(true); else setLoading(true);
    setError(null);
    try { const client = connection.client; const loaded = client ? await loadLive(client) : await loadFixture(); if (request === requestVersion.current && !disposed.current && activeTarget.current === targetKey) { setResult(loaded); setTaskUnavailable(false); } }
    catch (caught) { if (request !== requestVersion.current || disposed.current || activeTarget.current !== targetKey) return; if (caught instanceof RelayApiError && (caught.problem.status === 403 || caught.problem.status === 404)) setTaskUnavailable(true); setError(live ? (caught instanceof RelayApiError && (caught.problem.status === 403 || caught.problem.status === 404) ? "任务暂不可读，请核对权限后重试。" : describeLiveError(caught).message) : caught instanceof Error && "kind" in caught ? (caught as FixtureError).message.trim() : caught instanceof Error ? caught.message.trim() : "读取示例任务时发生未知错误。"); }
    finally { if (request === requestVersion.current && !disposed.current && activeTarget.current === targetKey) { setLoading(false); setRefreshing(false); } }
  }
  useEffect(() => {
    disposed.current = false;
    void load();
    return () => { disposed.current = true; requestVersion.current++; };
  }, [targetKey]);
  const projectWriteBlockedReason = result?.source !== "live" ? null :
    refreshing || loading || error !== null ? "任务事实正在核对或读取失败，不能提交新的任务命令。" :
    result.task.projectId === null ? null : result.projectArchivedAt === undefined ?
      // `undefined` 是「项目事实还没读到」：不写成读取失败，避免任务详情先闪一句红字再消失。
      result.projectReadError === null ? null : `Project 事实读取失败，不能提交新的任务命令。${result.projectReadError}` :
      result.projectArchivedAt !== null ? "项目已归档，不能提交新的任务命令。" : null;
  // UI-10：AI 持有执行权时，人工不能直接编辑产物或验收；页头主操作改为“请求接手”，接手在运行页生效后再编辑。
  const aiHolds = result?.source === "live" && result.task.executor === "AI";
  const acceptanceBlockedReason = projectWriteBlockedReason ?? (taskUnavailable ? "当前任务不可读，请先重新核对。"
    : aiHolds || result?.task.runId ? "当前仍有 AI 执行，请先安全收敛执行权后再补验收条件。"
    : result && !["INBOX", "READY", "IN_PROGRESS"].includes(result.task.status)
      ? "当前任务周期不可编辑；已完成的任务需先重开。" : null);
  if (loadedTarget.current !== targetKey || loading) return <section className="page-state pv-page" aria-live="polite"><p className="eyebrow">任务详情</p><h1>正在读取任务</h1><p>{live ? "正在从本机 API 读取真实任务事实。" : "示例数据正在加载。"}</p></section>;
  if (error && !result) return <section className="page-state page-state--error pv-page" role="alert"><p className="eyebrow">任务详情</p><h1>暂时无法读取这个任务</h1><p>{error}</p><button className="secondary-button" type="button" onClick={() => void load()}><RotateCcw aria-hidden="true" />重新读取</button></section>;
  if (!result) return <section className="page-state pv-page"><p className="eyebrow">任务详情</p><h1>{live ? "服务端没有返回这个任务" : "示例数据没有这个任务"}</h1><p>{live ? "跨作用域或已删除的任务按不可见处理；页面不会据此创建任务。" : "示例数据里只有“确定实验评价指标”这一个任务，其他任务不显示示例内容。"}</p><Link className="text-link" to="/tasks">返回任务列表</Link></section>;
  const taskAlerts = taskUnavailable ? <p className="disabled-reason">任务来源暂不可读；本页不显示缓存或推断的任务事实。</p>
    : <>{refreshing && <p className="helper-text" role="status">正在更新任务事实，已显示的内容保持可见。</p>}{projectWriteBlockedReason && <p className="disabled-reason" data-testid="task-project-archive-reason">{projectWriteBlockedReason}</p>}</>;
  // 右栏事实列：状态语义分开呈现，可开始≠执行中、人工判断≠交接完成、方案可用≠检查已运行。
  const statusFacts = <section className="task-detail-status" aria-labelledby="task-detail-status-heading"><h3 id="task-detail-status-heading" className="visually-hidden">当前状态</h3><dl className="rail-definition-list task-detail-facts"><div><dt>工作状态</dt><dd><StatusChip status={result.task.status} /></dd></div><div><dt>执行模式</dt><dd>{interactionModeLabels[result.task.mode]}</dd></div><div><dt>当前执行者</dt><dd>{executorLabels[result.task.executor]}</dd></div><div><dt>当前 Run</dt><dd>{result.task.runId ? <Link className="inline-link" to={`/runs/${result.task.runId}`}>查看 Run</Link> : "无活动 Run"}</dd></div></dl>{result.source === "live" && result.task.currentCompletionId && <Link className="inline-link" to={`/completion-records/${result.task.currentCompletionId}`}>查看当前完成凭据</Link>}</section>;
  const statusNote = aiHolds ? "当前由 AI 持有执行权：不能在这里直接编辑产物或修改验收；请先请求人工接手，接手在运行页生效后再编辑，在此之前只能只读查看任务定义与验收方案。"
    : result.task.status === "DONE" ? "该任务本轮已完成：编辑前需要先重开，界面不会悄悄改旧版本。"
    : result.task.status === "INBOX" ? "任务尚未整理：先完善定义与验收方案，整理后才可开始执行。"
    : result.task.status === "READY" ? "任务可以开始：可进入协作工作区人工执行，或委托给 AI；可开始不等于已在执行。"
    : result.task.status === "IN_PROGRESS" ? "任务进行中：产物在「产物」页签编辑；完成后提交人工验收，人工验收通过才算完成。"
    : result.task.status === "WAITING" ? "等待人工验收：需要人工核对验收条件与证据后接受；人工判断完成前不算交接完成。"
    : result.task.status === "BLOCKED" ? "任务被阻塞：先处理前置依赖或阻塞原因。"
    : "任务已取消。";
  // 标题行：主标题+状态 chip 同行，meta 只放既有事实（所属项目/任务编号/修订），目标说明下沉到主区“任务目标”。
  // 元信息分组而不是一整句「·」串：换行只发生在组之间，「修订 v2」这类标签+数字不会被拆到两行。
  // 36 字符任务 ID 不再占据普通元信息长句（design-system §9.5：长 UUID 保留可核对性但降为 code 小字或折叠 details），
  // 只显示可读缩略，完整值由同处一个可展开核对入口给出，信息不隐藏。
  const headerProject = result.source === "live" ? result.projectTitle : "示例数据";
  // 只有 UUID / 长哈希形状的技术 ID 才降级为缩略；本身就是短可读标识（例如示例数据的
  // task-evaluation-metrics）原样显示——缩略那种标识反而更难核对。
  const technicalTaskId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(result.task.id)
    || /^[0-9a-f]{32,}$/iu.test(result.task.id);
  const headerTaskId = technicalTaskId
    ? `${result.task.id.slice(0, 8)}…${result.task.id.slice(-4)}` : result.task.id;
  const headerMeta = <span className="task-detail-head-meta" data-testid="task-detail-head-meta">
    {headerProject !== null && <span className="task-detail-head-meta-item" data-testid="task-detail-head-project">{headerProject}</span>}
    <span className="task-detail-head-meta-item"><code className="hash-code" data-testid="task-detail-head-id">{headerTaskId}</code></span>
    <span className="task-detail-head-meta-item task-detail-head-meta-fact" data-testid="task-detail-head-revision">修订 v{result.task.revision}</span>
  </span>;
  const headerIdentity = <details className="task-detail-head-identity" data-testid="task-detail-head-identity">
    <summary>完整任务 ID</summary>
    <code className="hash-code" data-testid="task-detail-head-id-full">{result.task.id}</code>
  </details>;
  const headerActions = result.source !== "live" ? undefined
    : aiHolds && result.task.runId
      ? <Link className="primary-button" to={`/runs/${result.task.runId}`} data-testid="task-request-handoff">前往运行页请求接手</Link>
      : <Link className="primary-button" data-testid="task-open-collaboration" to={`/agent?work=${encodeURIComponent(result.task.id)}`}>进入协作工作区</Link>;
  const taskTitleBlock = taskUnavailable ? null
    : <PageHeader testId="task-detail-page-head" title={result.task.title} status={<StatusChip status={result.task.status} />}
      meta={headerMeta} actions={headerActions}>{headerIdentity}</PageHeader>;
  const taskReadError = error && <div className="warning-callout" role="alert" data-testid="task-refresh-error"><p>刷新任务事实失败：{error} 草稿与原命令反馈仍保留，核对成功前不能提交新的命令。</p><button className="secondary-button" type="button" data-testid="task-refresh-retry" onClick={() => void load()}><RotateCcw aria-hidden="true" />重新读取任务</button></div>;
  // 页签行右侧的辅助文字入口：路由与准入逻辑不变，只移动呈现位置。
  const taskTabRow = <div className="task-detail-tabrow" data-testid="task-detail-tabrow"><nav className="skill-tabs" role="tablist" aria-label="任务详情页签" onKeyDown={handleTabListKeyDown}>{tabs.map((item) => <button key={item.key} className={`skill-tab${tab === item.key ? " skill-tab--active" : ""}`} type="button" role="tab" id={`task-detail-tab-${item.key}`} aria-controls="task-detail-content" aria-selected={tab === item.key} tabIndex={tab === item.key ? 0 : -1} data-testid={`task-detail-tab-${item.key}`} onClick={() => { setTab(item.key); if (item.key === "artifacts") setArtifactVisited(true); }}>{item.label}</button>)}</nav><div className="task-detail-quick-links"><Link className="task-detail-quick-link" to={`/tasks/${result.task.id}?skill=definition`}>{aiHolds ? "只读查看任务定义" : "完善定义"}</Link><Link className="task-detail-quick-link" to={`/tasks/${result.task.id}?skill=verification`}>{aiHolds ? "只读查看验收方案" : "验收方案"}</Link><Link className="task-detail-quick-link" to={`/tasks/${result.task.id}?skill=assist`}>AI 讨论</Link></div></div>;
  const objectiveSection = <section className="task-detail-section" aria-labelledby="task-objective-heading"><div className="task-detail-section-heading"><h2 id="task-objective-heading">任务目标</h2></div>{result.objective ? <p className="task-detail-objective">{result.objective}</p> : <p className="helper-text">当前响应未提供任务目标。</p>}</section>;
  // 验收条件区块跨页签常驻（隐藏），保证补充条件草稿与未决命令 Owner 在切换页签后仍然保留。
  const criteriaSection = <section className="task-detail-section task-detail-criteria" hidden={tab !== "overview"} aria-labelledby="task-criteria-heading" data-testid="task-detail-criteria">
    {tab === "overview" && !taskUnavailable && <><div className="task-detail-section-heading"><h2 id="task-criteria-heading">验收条件{result.criteria.length > 0 && <span className="task-detail-section-meta">（{result.criteria.length}）</span>}</h2><span className="task-detail-section-meta">验收版本 v{result.task.acceptanceRevision}</span></div>
      <p className="helper-text">{result.criteriaNote}</p>
      {result.criteria.length ? <ol className="task-detail-criteria-list">{result.criteria.map((criterion, index) => {
        const methodLabel = criterionMethodLabel(criterion.method);
        return <li key={criterion.criterionId} className="task-detail-criterion" data-testid={`task-criterion-${criterion.criterionId}`}><span className="task-detail-criterion-index" aria-hidden="true">{index + 1}</span><div className="task-detail-criterion-body"><p className="task-detail-criterion-statement">{criterion.statement}</p><p className="task-detail-criterion-meta"><span className={`status-chip${criterion.required ? "" : " status-chip--neutral"}`}>{criterion.required ? "必需" : "可选"}</span><span>验证方式：{methodLabel}{methodLabel !== criterion.method && <small title={criterion.method}>（{criterion.method}）</small>}</span><small>条件 {criterion.criterionId}</small></p></div></li>;
      })}</ol> : <p className="helper-text">当前验收版本没有条件。</p>}
      <p className="helper-text"><Info aria-hidden="true" />可在下方人工补充完成条件；调整目标或生成检查方案，请使用页签行右侧对应入口并核对提案。</p></>}
    {result.source === "live" && result.acceptance && connection.client && <TaskAcceptanceEditPanel key={`${connection.epoch}:${result.task.id}`} client={connection.client}
      taskId={result.task.id} taskRevision={result.task.revision} acceptance={result.acceptance}
      blockedReason={acceptanceBlockedReason} onSaved={load} />}
  </section>;
  const dependenciesSection = <section className="task-detail-section" aria-labelledby="task-dependencies-heading"><div className="task-detail-section-heading"><h2 id="task-dependencies-heading">前置依赖</h2></div>{result.source === "fixture" ? <p className="helper-text">示例数据没有提供该任务的依赖事实；项目任务页展示的依赖来自示例项目范围。</p> : result.dependencies.length === 0 ? <p className="helper-text">没有前置依赖。</p> : <ul className="task-detail-dependency-list">{result.dependencies.map((dependency) => <li key={dependency.id}><span className="task-detail-dependency-title">{dependency.title}</span><span className="task-detail-dependency-status">{taskStatusLabels[dependency.status]}</span><Link className="text-link" to={`/tasks/${dependency.id}`}>打开</Link></li>)}</ul>}</section>;
  const basicsSection = <section className="task-detail-section" aria-labelledby="task-basics-heading" data-testid="task-detail-basics"><div className="task-detail-section-heading"><h2 id="task-basics-heading">基本信息</h2></div><dl className="definition-list task-detail-basic-list"><div><dt>任务 ID</dt><dd>{result.task.id}</dd></div><div><dt>所属项目</dt><dd>{result.projectTitle ?? result.task.projectId ?? "无"}</dd></div><div><dt>任务修订</dt><dd>v{result.task.revision}</dd></div><div><dt>执行模式</dt><dd>{interactionModeLabels[result.task.mode]}</dd></div><div><dt>当前执行者</dt><dd>{executorLabels[result.task.executor]}</dd></div><div><dt>验收版本</dt><dd>v{result.task.acceptanceRevision}</dd></div></dl>{result.source === "live" && result.task.currentCompletionId && <p className="task-detail-basic-links">当前完成凭据：<Link className="inline-link" to={`/completion-records/${result.task.currentCompletionId}`}>查看当前完成凭据</Link>（历史凭据在重开后仍保留）。</p>}</section>;
  const runsSection = <section className="task-detail-section" data-testid="task-runs"><div className="task-detail-section-heading"><h2>执行记录</h2></div>{result.source === "live" && result.task.runId ? <><p className="helper-text">当前 AI 执行记录：{result.task.runId}</p><Link className="secondary-button" to={`/runs/${result.task.runId}`}>查看 Run 步骤与控制</Link></> : <p className="helper-text">{result.source === "fixture" ? "示例数据不提供真实 Run。" : "当前任务没有 AI Run；本页不推断历史执行记录。"}</p>}{result.task.currentCompletionId && <p className="helper-text">当前完成凭据：<Link className="inline-link" to={`/completion-records/${result.task.currentCompletionId}`}>{result.task.currentCompletionId}</Link>（历史凭据在重开后仍保留）。</p>}</section>;
  // 产物页签把同一批任务事实收进按需展开区，标题由 summary 承担，不重复一个 h1。
  const artifactTaskHeader = <>{taskReadError}<details className="artifact-task-context"><summary>{taskUnavailable ? "任务来源暂不可读" : `任务：${result.task.title} · ${taskStatusLabels[result.task.status]} · 验收 v${result.task.acceptanceRevision}`}</summary>{taskUnavailable ? <p className="disabled-reason">任务来源暂不可读；本页不显示缓存或推断的任务事实。</p> : <>{taskAlerts}{statusFacts}{result.source === "live" && <div className="form-actions"><Link className="secondary-button" data-testid="task-open-collaboration" to={`/agent?work=${encodeURIComponent(result.task.id)}`}>进入协作工作区</Link></div>}</>}</details></>;
  return <section className={`skill-page task-detail-page pv-page${tab !== "overview" ? " task-detail-page--full-width" : ""}${tab === "artifacts" ? " task-detail-page--artifact" : ""}`} data-testid="task-detail"><div className="page-layout"><div className="page-primary">{tab !== "artifacts" && <>{taskTitleBlock}{taskAlerts}{taskReadError}</>}{taskTabRow}<div role="tabpanel" id="task-detail-content" aria-labelledby={`task-detail-tab-${tab}`} tabIndex={0}>
    {tab === "runs" && !taskUnavailable && result.source === "live" && connection.client && !result.task.runId &&
      <TaskDelegatePanel client={connection.client} task={{ id: result.task.id, projectId: result.task.projectId,
        status: result.task.status, executor: result.task.executor, revision: result.task.revision,
        executorRunId: result.task.runId, allowedActions: result.task.allowedActions ?? [] }}
        projectWriteBlockedReason={projectWriteBlockedReason} onDelegated={(runId) => navigate(`/runs/${runId}`)} />}
    {tab === "overview" && !taskUnavailable && objectiveSection}
    {criteriaSection}
    {tab === "overview" && !taskUnavailable && result.source === "live" && result.acceptance && connection.client &&
      <TaskAcceptanceEvidence client={connection.client} taskId={result.task.id} taskRevision={result.task.revision}
        acceptance={result.acceptance} runId={result.task.runId} completionId={result.task.currentCompletionId} />}
    {tab === "overview" && !taskUnavailable && dependenciesSection}
    {tab === "overview" && !taskUnavailable && basicsSection}
    {tab === "runs" && !taskUnavailable && runsSection}
    {artifactVisited && <div hidden={tab !== "artifacts"}><ArtifactPanel sourceUnavailable={taskUnavailable} documentHeader={tab === "artifacts" ? artifactTaskHeader : undefined} key={`${connection.epoch}:${result.task.id}`} taskId={result.task.id} projectId={result.task.projectId} taskStatus={result.task.status} taskRevision={result.task.revision} acceptanceRevision={result.task.acceptanceRevision} criteria={result.criteria} allowedActions={result.task.allowedActions} writeBlockedReason={projectWriteBlockedReason} onRefresh={() => { if (!disposed.current) void load(); }} /></div>}
  </div></div>{tab === "overview" && !taskUnavailable && <aside className="review-rail task-detail-rail" aria-label="任务状态与下一步">{statusFacts}<p className="task-detail-rail-note">{statusNote}</p></aside>}</div></section>;
}
