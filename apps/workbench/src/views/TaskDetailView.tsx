import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Info, RotateCcw } from "lucide-react";
import ArtifactPanel from "../components/ArtifactPanel";
import TaskAcceptanceEvidence from "../components/TaskAcceptanceEvidence";
import TaskDelegatePanel from "../components/TaskDelegatePanel";
import StatusChip from "../components/StatusChip";
import type { RelayAcceptanceCriterion, RelayApiClient, RelayTaskAcceptance } from "../api/relayClient";
import { fixtureAdapter } from "../fixtures/fixtureAdapter";
import { fixtureModeFromQuery } from "../lib/fixtureMode";
import { executorLabels, interactionModeLabels, taskStatusLabels } from "../lib/labels";
import { describeLiveError } from "../lib/liveErrors";
import { useRelayConnection } from "../lib/relayConnection";
import type { DecimalRevision, ExecutorKind, FixtureError, InteractionMode, TaskStatus } from "../types";
import "./TaskDetailView.css";

interface TaskDetailResult {
  readonly source: "fixture" | "live";
  readonly projectArchivedAt: string | null | undefined;
  readonly projectReadError: string | null;
  readonly task: { readonly id: string; readonly title: string; readonly status: TaskStatus; readonly mode: InteractionMode; readonly executor: ExecutorKind; readonly revision: DecimalRevision; readonly acceptanceRevision: DecimalRevision; readonly currentCompletionId: string | null; readonly projectId: string | null; readonly runId: string | null; readonly allowedActions: readonly string[] | null };
  readonly objective: string | null;
  readonly acceptance: RelayTaskAcceptance | null;
  readonly criteria: readonly RelayAcceptanceCriterion[];
  readonly criteriaNote: string;
  readonly dependencies: readonly { readonly id: string; readonly title: string; readonly status: TaskStatus }[];
}
const tabs = [{ key: "overview", label: "概览" }, { key: "artifacts", label: "产物" }, { key: "runs", label: "执行记录" }] as const;

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
  const [tab, setTab] = useState<"overview" | "artifacts" | "runs">(() => {
    const requested = query.get("tab");
    return requested === "artifacts" || requested === "runs" ? requested : "overview";
  });
  const [refreshing, setRefreshing] = useState(false);
  const requestVersion = useRef(0);
  const disposed = useRef(false);
  const loadedTarget = useRef<string | null>(null);
  const activeTarget = useRef(targetKey);
  activeTarget.current = targetKey;
  async function loadFixture(): Promise<TaskDetailResult | null> {
    const snapshot = await fixtureAdapter.loadTask(id, mode);
    if (!snapshot) return null;
    const record = snapshot.task;
    return { source: "fixture", projectArchivedAt: null, projectReadError: null, task: { id: record.id, title: record.title, status: record.status, mode: record.mode, executor: record.executor, revision: record.revision, acceptanceRevision: snapshot.verification.acceptanceRevision, currentCompletionId: null, projectId: snapshot.id, runId: null, allowedActions: null }, objective: record.definition.objective, acceptance: null, criteria: snapshot.verification.checks.map((check) => ({ criterionId: check.id, statement: check.title, required: check.required, method: check.method, targetSpec: null })), criteriaNote: "示例验收方案，不代表服务端当前验收版本。", dependencies: [] };
  }
  async function loadLive(client: RelayApiClient): Promise<TaskDetailResult> {
    const task = await client.getTask(id);
    if (task.id !== id) throw new Error("Task 单读与当前目标不匹配。");
    let projectArchivedAt: string | null | undefined = null;
    let projectReadError: string | null = null;
    if (task.projectId !== null) {
      projectArchivedAt = undefined;
      try {
        const project = await client.getProject(task.projectId);
        if (project.id !== task.projectId) throw new Error("Project 单读与当前 Task 不匹配。");
        projectArchivedAt = project.archivedAt;
      } catch (caught) { projectReadError = describeLiveError(caught).message; }
    }
    return { source: "live", projectArchivedAt, projectReadError, task: { id: task.id, title: task.title, status: task.status, mode: task.mode, executor: task.executor, revision: task.revision, acceptanceRevision: task.acceptance.acceptanceRevision, currentCompletionId: task.currentCompletionId, projectId: task.projectId, runId: task.executorRunId, allowedActions: task.allowedActions }, objective: task.acceptance.objective || null, acceptance: task.acceptance, criteria: task.acceptance.criteria, criteriaNote: `来源：${task.acceptance.source}；验收版本 v${task.acceptance.acceptanceRevision}。`, dependencies: task.dependencies.map((dependency) => ({ id: dependency.taskId, title: dependency.title, status: dependency.status })) };
  }
  async function load() {
    const request = ++requestVersion.current;
    if (loadedTarget.current !== targetKey) { loadedTarget.current = targetKey; setResult(null); setLoading(true); setRefreshing(false); }
    else if (result) setRefreshing(true); else setLoading(true);
    setError(null);
    try { const client = connection.client; const loaded = client ? await loadLive(client) : await loadFixture(); if (request === requestVersion.current && !disposed.current && activeTarget.current === targetKey) setResult(loaded); }
    catch (caught) { if (request !== requestVersion.current || disposed.current || activeTarget.current !== targetKey) return; setError(live ? describeLiveError(caught).message : caught instanceof Error && "kind" in caught ? (caught as FixtureError).message.trim() : caught instanceof Error ? caught.message.trim() : "读取示例任务时发生未知错误。"); }
    finally { if (request === requestVersion.current && !disposed.current && activeTarget.current === targetKey) { setLoading(false); setRefreshing(false); } }
  }
  useEffect(() => {
    disposed.current = false;
    void load();
    return () => { disposed.current = true; requestVersion.current++; };
  }, [targetKey]);
  const projectWriteBlockedReason = result?.source !== "live" || result.task.projectId === null ? null :
    refreshing || loading || error !== null || result.projectArchivedAt === undefined ?
      `Project 事实正在核对或读取失败，不能提交新的任务命令。${result.projectReadError ?? ""}` :
      result.projectArchivedAt !== null ? "项目已归档，不能提交新的任务命令。" : null;
  // UI-10：AI 持有执行权时，人工不能直接编辑产物或验收；编辑入口改为“请求接手”，接手在运行页生效后再编辑。
  const aiHolds = result?.source === "live" && result.task.executor === "AI";
  if (loadedTarget.current !== targetKey || loading) return <section className="page-state" aria-live="polite"><p className="eyebrow">任务详情</p><h1>正在读取任务</h1><p>{live ? "正在从本机 API 读取真实任务事实。" : "示例数据正在加载。"}</p></section>;
  if (error) return <section className="page-state page-state--error" role="alert"><p className="eyebrow">任务详情</p><h1>暂时无法读取这个任务</h1><p>{error}</p><button className="secondary-button" type="button" onClick={() => void load()}><RotateCcw aria-hidden="true" />重新读取</button></section>;
  if (!result) return <section className="page-state"><p className="eyebrow">任务详情</p><h1>{live ? "服务端没有返回这个任务" : "示例数据没有这个任务"}</h1><p>{live ? "跨作用域或已删除的任务按不可见处理；页面不会据此创建任务。" : "示例数据里只有“确定实验评价指标”这一个任务，其他任务不显示示例内容。"}</p><Link className="text-link" to="/tasks">返回任务列表</Link></section>;
  return <section className="skill-page task-detail-page" data-testid="task-detail"><div className="page-layout"><div className="page-primary"><p className="eyebrow">{live ? "任务" : "示例任务"}</p><h1>{result.task.title}</h1>{result.objective && <p className="page-lede">{result.objective}</p>}{refreshing && <p className="helper-text" role="status">正在更新任务事实，已显示的内容保持可见。</p>}{projectWriteBlockedReason && <p className="disabled-reason" data-testid="task-project-archive-reason">{projectWriteBlockedReason}</p>}
    <section className="task-detail-status" aria-labelledby="task-detail-status-heading"><h3 id="task-detail-status-heading" className="visually-hidden">当前状态</h3><dl className="rail-definition-list task-detail-facts"><div><dt>工作状态</dt><dd><StatusChip status={result.task.status} /></dd></div><div><dt>执行模式</dt><dd>{interactionModeLabels[result.task.mode]}</dd></div><div><dt>当前执行者</dt><dd>{executorLabels[result.task.executor]}</dd></div><div><dt>任务修订</dt><dd>v{result.task.revision}</dd></div><div><dt>验收版本</dt><dd>v{result.task.acceptanceRevision}</dd></div></dl>{result.source === "live" && result.task.currentCompletionId && <Link className="inline-link" to={`/completion-records/${result.task.currentCompletionId}`}>查看当前完成凭据</Link>}</section>
    <nav className="skill-tabs" aria-label="任务详情页签">{tabs.map((item) => <button key={item.key} className={`skill-tab${tab === item.key ? " skill-tab--active" : ""}`} type="button" aria-current={tab === item.key ? "page" : undefined} data-testid={`task-detail-tab-${item.key}`} onClick={() => setTab(item.key)}>{item.label}</button>)}</nav>
    {tab === "runs" && result.source === "live" && connection.client && !result.task.runId &&
      <TaskDelegatePanel client={connection.client} task={{ id: result.task.id, projectId: result.task.projectId,
        status: result.task.status, executor: result.task.executor, revision: result.task.revision,
        executorRunId: result.task.runId, allowedActions: result.task.allowedActions ?? [] }}
        projectWriteBlockedReason={projectWriteBlockedReason} onDelegated={(runId) => navigate(`/runs/${runId}`)} />}
    {tab === "overview" && result.source === "live" && result.acceptance && connection.client &&
      <TaskAcceptanceEvidence client={connection.client} taskId={result.task.id} taskRevision={result.task.revision}
        acceptance={result.acceptance} runId={result.task.runId} completionId={result.task.currentCompletionId} />}
    {tab === "overview" ? <><section className="surface-panel"><h2>验收标准</h2><p className="helper-text">{result.criteriaNote}</p>{result.criteria.length ? <ul className="criteria-list">{result.criteria.map((criterion) => <li key={criterion.criterionId} className="criteria-row"><span className="criteria-copy"><strong>{criterion.statement}</strong><small>标识 {criterion.criterionId} · 验证方式 {criterion.method} · {criterion.required ? "必需" : "可选"}</small></span>{criterion.required && <span className="status-chip">必需</span>}</li>)}</ul> : <div className="page-state"><p>当前验收版本没有条件。</p></div>}<p className="helper-text"><Info aria-hidden="true" />修改验收标准需要专用命令，当前 API 还没有该入口（待接入）；本页只读取，不在这里改写验收。</p></section></> : tab === "artifacts" ? <ArtifactPanel key={`${connection.epoch}:${result.task.id}`} taskId={result.task.id} projectId={result.task.projectId} taskStatus={result.task.status} taskRevision={result.task.revision} acceptanceRevision={result.task.acceptanceRevision} criteria={result.criteria} allowedActions={result.task.allowedActions} writeBlockedReason={projectWriteBlockedReason} onRefresh={() => { if (!disposed.current) void load(); }} /> : <section className="surface-panel" data-testid="task-runs"><h2>执行记录</h2>{result.source === "live" && result.task.runId ? <><p className="helper-text">当前 AI 执行记录：{result.task.runId}</p><Link className="secondary-button" to={`/runs/${result.task.runId}`}>查看 Run 步骤与控制</Link></> : <p className="helper-text">{result.source === "fixture" ? "示例数据不提供真实 Run。" : "当前任务没有 AI Run；本页不推断历史执行记录。"}</p>}{result.task.currentCompletionId && <p className="helper-text">当前完成凭据：<Link className="inline-link" to={`/completion-records/${result.task.currentCompletionId}`}>{result.task.currentCompletionId}</Link>（历史凭据在重开后仍保留）。</p>}</section>}
  </div><aside className="review-rail task-detail-rail" aria-label="任务编辑与依赖">{tab === "overview" && <><section className="surface-panel"><h2>编辑入口</h2><p className="helper-text">{result.task.status === "DONE" ? "该任务本轮已完成：编辑前需要先重开，界面不会悄悄改旧版本。" : aiHolds ? "当前由 AI 持有执行权：不能在这里直接编辑产物或修改验收。请先请求人工接手，接手在运行页生效后再编辑。" : "完善定义与验收方案沿用已有的 Skill 页面；产物编辑在“产物”页签里进行。"}</p><div className="form-actions">{aiHolds && result.task.runId ? <Link className="primary-button" to={`/runs/${result.task.runId}`} data-testid="task-request-handoff">前往运行页请求接手</Link> : null}<Link className="secondary-button" to={`/tasks/${result.task.id}?skill=definition`}>{aiHolds ? "只读查看任务定义" : "完善任务定义"}</Link><Link className="secondary-button" to={`/tasks/${result.task.id}?skill=verification`}>{aiHolds ? "只读查看验收方案" : "验收方案"}</Link><Link className="secondary-button" to={`/tasks/${result.task.id}?skill=assist`}>打开 Assist</Link></div></section><section className="surface-panel"><h2>前置依赖</h2>{result.source === "fixture" ? <p className="helper-text">示例数据没有提供该任务的依赖事实；项目任务页展示的依赖来自示例项目范围。</p> : result.dependencies.length === 0 ? <div className="helper-text">没有前置依赖。</div> : <ul className="criteria-list">{result.dependencies.map((dependency) => <li key={dependency.id} className="criteria-row"><span className="criteria-copy"><strong>{dependency.title}</strong><small>状态：{taskStatusLabels[dependency.status]}</small></span><Link className="text-link" to={`/tasks/${dependency.id}`}>打开</Link></li>)}</ul>}</section></>}</aside></div></section>;
}
