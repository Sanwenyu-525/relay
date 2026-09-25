import { useEffect, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { ChevronRight, FileText, Info, Plus, RotateCcw, Search } from "lucide-react";
import ProjectNav from "../components/ProjectNav";
import ResponsiveRail from "../components/ResponsiveRail";
import StatusChip from "../components/StatusChip";
import { createCommandId, taskMutationFrom, type RelayApiClient, type RelayTaskSummary } from "../api/relayClient";
import { fixtureAdapter, type ProjectTasksResult } from "../fixtures/fixtureAdapter";
import { fixtureModeFromQuery } from "../lib/fixtureMode";
import { executorLabels, interactionModeLabels, taskStatusLabels } from "../lib/labels";
import { describeLiveError, type LiveActionError } from "../lib/liveErrors";
import { liveClient, useRelayConnection } from "../lib/relayConnection";
import type { DecimalRevision, ExecutorKind, FixtureError, InteractionMode, TaskStatus } from "../types";

interface ProjectTasksViewResult {
  readonly project: { readonly id: string; readonly title: string; readonly goal: string | null };
  readonly tasks: readonly ProjectTaskRow[];
  readonly dependencies: readonly ProjectTaskDependencyRow[];
  readonly source: "fixture" | "live";
}
interface ProjectTaskRow {
  readonly id: string; readonly title: string; readonly status: TaskStatus; readonly mode: InteractionMode;
  readonly executor: ExecutorKind; readonly revision: DecimalRevision; readonly dependencyIds: readonly string[];
  readonly allowedActions: readonly string[] | null; readonly blockedReason: string | null;
}
interface ProjectTaskDependencyRow {
  readonly id: string; readonly title: string; readonly status: TaskStatus; readonly executor: ExecutorKind | null;
  readonly reason: string | null; readonly downstreamNote: string | null;
}
function fromFixture(response: ProjectTasksResult | null): ProjectTasksViewResult | null {
  if (!response) return null;
  return { project: { id: response.project.id, title: response.project.title, goal: response.project.goal }, tasks: response.tasks.map((task) => ({ id: task.id, title: task.title, status: task.status, mode: task.mode, executor: task.executor, revision: task.revision, dependencyIds: [...task.dependencyIds], allowedActions: null, blockedReason: task.blockedReason })), dependencies: response.dependencies.map((note) => ({ id: note.id, title: note.title, status: note.status, executor: note.executor, reason: note.reason, downstreamNote: note.downstreamNote })), source: "fixture" };
}
function liveTaskRow(task: RelayTaskSummary): ProjectTaskRow {
  const blockedReason = task.unresolvedBlockerIds.length > 0 ? `存在 ${task.unresolvedBlockerIds.length} 个未解除的阻塞项，服务端未投影 START 动作。` : task.blockingTaskIds.length > 0 ? "前置任务尚未完成，服务端未投影 START 动作。" : null;
  return { id: task.id, title: task.title, status: task.status, mode: task.mode, executor: task.executor, revision: task.revision, dependencyIds: [...task.blockingTaskIds], allowedActions: [...task.allowedActions], blockedReason };
}
async function loadLive(client: RelayApiClient, id: string): Promise<ProjectTasksViewResult> {
  const [project, tasks] = await Promise.all([client.getProject(id), client.getProjectTasks(id)]);
  return { project: { id: project.id, title: project.title, goal: null }, tasks: tasks.map(liveTaskRow), dependencies: [], source: "live" };
}

export default function ProjectTasksView() {
  const { id = "" } = useParams();
  const [query] = useSearchParams();
  const mode = fixtureModeFromQuery(query);
  const live = useRelayConnection().mode === "live";
  const [result, setResult] = useState<ProjectTasksViewResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const selectedTaskIdRef = useRef<string | null>(null);
  selectedTaskIdRef.current = selectedTaskId;
  const [submitting, setSubmitting] = useState(false);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [liveFailure, setLiveFailure] = useState<LiveActionError | null>(null);
  const [liveDependencies, setLiveDependencies] = useState<readonly ProjectTaskDependencyRow[]>([]);
  const requestVersion = useRef(0);
  const dependencyVersion = useRef(0);
  const disposed = useRef(false);
  const hasLoaded = useRef(false);
  const pendingStart = useRef<{ taskId: string; commandId: string } | null>(null);
  const needle = search.trim().toLowerCase();
  const tasks = (result?.tasks ?? []).filter((task) => !needle || task.title.toLowerCase().includes(needle));
  const selectedTask = tasks.find((task) => task.id === selectedTaskId) ?? null;
  const notes = result?.source === "live" ? liveDependencies : result?.dependencies ?? [];
  const selectedDependencies = selectedTask ? notes.filter((note) => selectedTask.dependencyIds.includes(note.id)) : [];
  const canStart = selectedTask !== null && (selectedTask.allowedActions === null ? selectedTask.status === "READY" : selectedTask.allowedActions.includes("START"));
  const startBlockedReason = !selectedTask ? "" : selectedTask.allowedActions === null ? `仅“可开始”的任务可以开始；当前状态是${taskStatusLabels[selectedTask.status]}。` : `服务端未投影 START 动作：${[`当前状态是${taskStatusLabels[selectedTask.status]}`, ...(selectedTask.dependencyIds.length ? [`有 ${selectedTask.dependencyIds.length} 个前置任务尚未完成`] : []), ...(selectedTask.blockedReason ? [selectedTask.blockedReason] : [])].join("；")}。`;
  const dependencyLabel = (task: ProjectTaskRow) => !task.dependencyIds.length ? "无" : notes.find((note) => note.id === task.dependencyIds[0])?.title ?? (task.dependencyIds.length === 1 ? "1 个前置任务" : `${task.dependencyIds.length} 个前置任务`);

  async function load() {
    const request = ++requestVersion.current;
    if (hasLoaded.current) setRefreshing(true); else setLoading(true);
    setError(null); setLiveFailure(null);
    try {
      const client = liveClient();
      const response = client ? await loadLive(client, id) : fromFixture(await fixtureAdapter.loadProjectTasks(id, mode));
      if (request !== requestVersion.current || disposed.current) return;
      setResult(response); setLiveDependencies([]); hasLoaded.current = true;
      const next = response?.tasks.find((task) => task.blockedReason !== null)?.id ?? response?.tasks[0]?.id ?? null;
      setSelectedTaskId(next); selectedTaskIdRef.current = next;
    } catch (caught) {
      if (request !== requestVersion.current || disposed.current) return;
      if (live) { const described = describeLiveError(caught); setLiveFailure(described); setError(described.message); }
      else { const fixtureError = caught as FixtureError; setError(caught instanceof Error && "kind" in caught ? fixtureError.message.trim() : caught instanceof Error ? caught.message.trim() : "读取示例项目任务时发生未知错误。"); }
    } finally { if (request === requestVersion.current && !disposed.current) { setLoading(false); setRefreshing(false); } }
  }
  useEffect(() => { disposed.current = false; void load(); return () => { disposed.current = true; requestVersion.current++; dependencyVersion.current++; }; }, [id, mode, live]);
  useEffect(() => {
    if (!live || !selectedTaskId) return;
    const taskId = selectedTaskId;
    const client = liveClient();
    if (!client) return;
    const token = ++dependencyVersion.current;
    void client.getTask(taskId).then((detail) => { if (token === dependencyVersion.current && selectedTaskIdRef.current === taskId && !disposed.current) setLiveDependencies(detail.dependencies.map((dependency) => ({ id: dependency.taskId, title: dependency.title, status: dependency.status, executor: null, reason: null, downstreamNote: null }))); }).catch(() => { if (token === dependencyVersion.current && !disposed.current) setLiveDependencies([]); });
  }, [live, selectedTaskId]);
  function selectTask(task: ProjectTaskRow) { setSelectedTaskId(task.id); setReceipt(null); setActionError(null); }
  async function startSelected() {
    const task = selectedTask;
    if (!task || submitting || !canStart) return;
    const client = liveClient();
    setSubmitting(true); setActionError(null); setLiveFailure(null); setReceipt(null);
    try {
      if (!client) { const command = await fixtureAdapter.startTask(task.id, mode); if (disposed.current) return; await load(); if (disposed.current) return; setSelectedTaskId(task.id); setReceipt(command.description); return; }
      const commandId = pendingStart.current?.taskId === task.id ? pendingStart.current.commandId : createCommandId();
      pendingStart.current = { taskId: task.id, commandId };
      const mutation = await client.startHumanTask({ taskId: task.id, commandId, expectedRevision: task.revision });
      if (disposed.current) return;
      pendingStart.current = null;
      await load(); if (disposed.current) return;
      setSelectedTaskId(task.id); setReceipt(`已开始：任务状态为${taskStatusLabels[mutation.status]}，任务修订 v${mutation.revision}。开始不等于完成。`);
    } catch (caught) {
      if (disposed.current) return;
      const described = describeLiveError(caught); setLiveFailure(described); setActionError(described.message);
      if (described.kind !== "transport") pendingStart.current = null;
    } finally { if (!disposed.current) setSubmitting(false); }
  }
  async function lookupStartReceipt() {
    const client = liveClient(); const pending = pendingStart.current;
    if (!client || !pending || submitting) return;
    setSubmitting(true); setActionError(null); setLiveFailure(null);
    try { const body = await client.getCommandReceipt(pending.commandId); if (disposed.current) return; const mutation = taskMutationFrom(body.result); pendingStart.current = null; await load(); if (disposed.current) return; setSelectedTaskId(pending.taskId); setReceipt(`回执确认已提交：任务状态为${taskStatusLabels[mutation.status]}，任务修订 v${mutation.revision}。开始不等于完成。`); }
    catch (caught) { if (disposed.current) return; const described = describeLiveError(caught); setLiveFailure(described); setActionError(described.kind === "unknown" && described.message === "服务端返回 HTTP 404。" ? "没有找到这次提交的回执：该命令尚未提交，可以用同一个 command ID 重新提交。" : described.message); }
    finally { if (!disposed.current) setSubmitting(false); }
  }
  if (loading) return <section className="page-state" aria-live="polite"><p className="eyebrow">项目任务</p><h1>正在读取项目任务</h1><p>{live ? "正在从本机 API 读取真实数据，页面尚未提交任何变更。" : "示例数据正在加载，页面尚未提交任何变更。"}</p></section>;
  if (error) return <section className="page-state page-state--error" role="alert"><p className="eyebrow">项目任务</p><h1>{live ? "暂时无法读取这个项目" : "暂时无法显示项目任务"}</h1><p>{error}</p><button className="secondary-button" type="button" onClick={() => void load()}><RotateCcw aria-hidden="true" />重新读取</button></section>;
  if (!result) return <section className="page-state"><p className="eyebrow">项目任务</p><h1>{live ? "服务端没有返回这个项目" : "没有这个示例项目"}</h1><p>{live ? "跨作用域或已删除的项目按不可见处理；工作台不会据此创建项目或任务。" : "示例数据里没有该项目的任务，页面不会据此创建项目或任务。"}</p><Link className="text-link" to="/projects">返回项目列表</Link></section>;
  return <section className="skill-page"><div className="page-layout"><div className="page-primary"><p className="eyebrow">{result.project.title}</p>{result.project.goal !== null && <p className="page-lede">{result.project.goal}</p>}<h1>项目任务</h1><ProjectNav projectId={id} active="tasks" /><div className="list-toolbar"><label className="search-field"><Search aria-hidden="true" /><span className="visually-hidden">搜索任务（标题、状态、执行者）</span><input value={search} onChange={(event) => setSearch(event.target.value)} type="search" name="project-task-search" placeholder="搜索任务（标题、状态、执行者）" /></label><Link className="primary-button" to={`/tasks?view=create&project=${encodeURIComponent(id)}`}><Plus aria-hidden="true" />新建任务</Link></div>{refreshing && <p className="helper-text" role="status">正在更新项目任务，已显示的内容保持可见。</p>}
    {tasks.length === 0 ? <div className="page-state"><p>{search.trim() ? "当前项目没有匹配该关键词的任务。" : live ? "这个项目还没有任务。" : "这个示例项目还没有任务。"}</p>{search.trim() && <button className="secondary-button" type="button" onClick={() => setSearch("")}>清除搜索</button>}</div> : <div className="table-scroll"><div className="data-table"><div className="data-row data-row--head data-row--project-tasks" aria-hidden="true"><span className="data-cell">任务</span><span className="data-cell">状态</span><span className="data-cell">执行模式</span><span className="data-cell">依赖</span></div><ul className="data-list">{tasks.map((task) => <li key={task.id}><button className={`data-row data-row--project-tasks data-row--interactive${task.id === selectedTaskId ? " data-row--selected" : ""}`} type="button" aria-current={task.id === selectedTaskId ? "true" : undefined} data-testid={`project-task-row-${task.id}`} onClick={() => selectTask(task)}><span className="data-cell"><strong>{task.title}</strong><small>任务修订 v{task.revision}</small></span><span className="data-cell"><StatusChip status={task.status} /></span><span className="data-cell data-cell--meta">{interactionModeLabels[task.mode]}</span><span className="data-cell data-cell--meta">{dependencyLabel(task)}</span></button></li>)}</ul></div></div>}
    <p className="list-footer-note"><Info aria-hidden="true" />{live ? "该页面固定在当前项目范围内；可开始性来自服务端 allowed_actions，界面不自行推断授权。" : "该页面固定在当前项目范围内；依赖是否成环由服务端判断，界面不自行推断。"}</p></div>
    <ResponsiveRail label="查看任务判断" title="任务判断"><div className="rail-content">{selectedTask ? <><h2>{selectedTask.title}</h2><p className="rail-intro">任务修订 v{selectedTask.revision}</p><section className="rail-section"><h3>三个独立事实</h3><dl className="rail-definition-list"><div><dt>任务状态</dt><dd><StatusChip status={selectedTask.status} /></dd></div><div><dt>执行模式</dt><dd>{interactionModeLabels[selectedTask.mode]}</dd></div><div><dt>当前执行者</dt><dd>{executorLabels[selectedTask.executor]}</dd></div></dl></section>{selectedTask.blockedReason && <section className="rail-section"><h3>为什么暂不能开始</h3><p>{selectedTask.blockedReason}</p></section>}{selectedDependencies.length > 0 && <section className="rail-section"><h3>前置依赖</h3><p>完成以下前置任务后，方可开始本任务。</p>{selectedDependencies.map((note) => <Link key={note.id} className="dependency-card" to={`/tasks/${note.id}`}><FileText aria-hidden="true" /><span className="dependency-card-copy"><strong>{note.title}</strong><small>状态：{taskStatusLabels[note.status]}{note.executor && <> · 执行者：{executorLabels[note.executor]}</>}</small></span><ChevronRight aria-hidden="true" /></Link>)}{selectedDependencies[0].reason && <p className="helper-text">{selectedDependencies[0].reason}</p>}</section>}{selectedDependencies.length > 0 && selectedDependencies[0].downstreamNote && <section className="rail-section"><h3>后续影响</h3><p>{selectedDependencies[0].downstreamNote}</p></section>}{receipt && <p className="receipt-message" role="status">{receipt}</p>}{actionError && <p className="action-error" role="alert">{actionError}</p>}{liveFailure?.kind === "transport" && <><button className="secondary-button secondary-button--wide" type="button" data-testid="project-task-receipt" disabled={submitting} onClick={() => void lookupStartReceipt()}>查询本次回执</button><p className="helper-text">提交结果不确定时先查回执，不要换 command ID 重新提交。</p></>}<button className="primary-button primary-button--wide" type="button" data-testid="project-task-start" disabled={submitting || !canStart} onClick={() => void startSelected()}>{submitting ? "正在开始" : "开始任务"}</button>{!canStart && <p className="disabled-reason" data-testid="project-task-start-reason"><Info aria-hidden="true" />{startBlockedReason}</p>}{selectedDependencies.length ? selectedDependencies.map((note) => <Link key={`link-${note.id}`} className="secondary-button secondary-button--wide" to={`/tasks/${note.id}`}>查看前置任务</Link>) : <Link className="secondary-button secondary-button--wide" to={`/tasks/${selectedTask.id}`}>打开任务详情</Link>}</> : <p className="rail-intro">请先在列表中选择一个任务，这里会显示它的依赖与阻塞原因。</p>}</div></ResponsiveRail></div></section>;
}
