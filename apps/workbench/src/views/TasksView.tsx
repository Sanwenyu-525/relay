import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Info, Plus, RotateCcw, Search } from "lucide-react";
import ResponsiveRail from "../components/ResponsiveRail";
import StatusChip from "../components/StatusChip";
import CreateTaskView from "./CreateTaskView";
import { fixtureAdapter, type TaskListQuery } from "../fixtures/fixtureAdapter";
import { fixtureModeFromQuery } from "../lib/fixtureMode";
import { executorLabels, interactionModeLabels, taskStatusLabels } from "../lib/labels";
import { useRelayConnection } from "../lib/relayConnection";
import type { InteractionMode, ProjectSummary, TaskStatus, TaskSummary } from "../types";

const statusOptions = Object.keys(taskStatusLabels) as TaskStatus[];
const modeOptions = Object.keys(interactionModeLabels) as InteractionMode[];

export default function TasksView() {
  const navigate = useNavigate();
  const [query] = useSearchParams();
  const mode = fixtureModeFromQuery(query);
  const creating = query.get("view") === "create";
  const scope = query.get("tab") === "inbox" ? "inbox" : "all";
  const live = useRelayConnection().mode === "live";
  const [liveProjectId, setLiveProjectId] = useState("");
  const [liveTaskId, setLiveTaskId] = useState("");
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [projectFilter, setProjectFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<TaskStatus | "all">("all");
  const [modeFilter, setModeFilter] = useState<InteractionMode | "all">("all");
  const [search, setSearch] = useState("");
  const requestVersion = useRef(0);
  const hasLoaded = useRef(false);

  async function load() {
    const request = ++requestVersion.current;
    if (hasLoaded.current) setRefreshing(true); else setLoading(true);
    setError(null);
    try {
      const listQuery: TaskListQuery = { projectId: scope === "inbox" ? "inbox" : projectFilter, status: statusFilter, mode: modeFilter, query: search };
      const [list, options] = await Promise.all([fixtureAdapter.listTasks(listQuery, mode), fixtureAdapter.loadTaskOptions(mode)]);
      if (request !== requestVersion.current) return;
      setTasks(list);
      setProjects(options.projects);
      hasLoaded.current = true;
    } catch (caught) {
      if (request === requestVersion.current) setError(caught instanceof Error ? caught.message.trim() : "读取示例任务时发生未知错误。");
    } finally {
      if (request === requestVersion.current) { setLoading(false); setRefreshing(false); }
    }
  }
  useEffect(() => { if (!live) void load(); return () => { requestVersion.current++; }; }, [live, mode, scope, projectFilter, statusFilter, modeFilter, search]);
  useEffect(() => { setProjectFilter("all"); }, [scope]);
  const hasFilters = projectFilter !== "all" || statusFilter !== "all" || modeFilter !== "all" || search !== "";
  const anyFilterActive = hasFilters || scope === "inbox";
  const clearFilters = () => { setProjectFilter("all"); setStatusFilter("all"); setModeFilter("all"); setSearch(""); };
  const projectTitle = (projectId: string | null) => projectId === null ? "未归属项目" : projects.find((project) => project.id === projectId)?.title ?? projectId;
  const openCreate = () => navigate(`/tasks?view=create${scope === "inbox" ? "&tab=inbox" : ""}`);
  const closeCreate = () => navigate(scope === "inbox" ? "/tasks?tab=inbox" : "/tasks");
  if (creating) return <section className="skill-page"><CreateTaskView inboxScope={scope === "inbox"} onCancel={closeCreate} /></section>;
  if (live) return <section className="skill-page" data-testid="tasks-live-gap"><div className="page-layout"><div className="page-primary">
    <div className="list-header"><div><h1>任务</h1><p className="page-lede">已连接本机 API。当前界面尚未接入全工作空间与收件箱任务列表。</p></div><button className="primary-button" type="button" data-testid="task-create-open" onClick={openCreate}><Plus aria-hidden="true" />新建任务</button></div>
    <nav className="subnav" aria-label="任务范围"><Link className={`subnav-item${scope === "all" ? " subnav-item--active" : ""}`} to="/tasks" data-testid="tasks-tab-all" aria-current={scope === "all" ? "page" : undefined}>全部</Link><Link className={`subnav-item${scope === "inbox" ? " subnav-item--active" : ""}`} to="/tasks?tab=inbox" data-testid="tasks-tab-inbox" aria-current={scope === "inbox" ? "page" : undefined}>收件箱</Link></nav>
    <p className="warning-callout" role="status"><Info aria-hidden="true" />{scope === "inbox" ? "当前界面尚未接入真实收件箱列表。" : "真实 API 尚无全工作空间任务列表端点。"}这里不会显示示例任务；可以按项目 ID 打开真实项目任务，或按任务 ID 打开真实任务。</p>
    <form className="create-form" noValidate onSubmit={(event) => { event.preventDefault(); if (liveProjectId.trim()) navigate(`/projects/${encodeURIComponent(liveProjectId.trim())}/tasks`); }}>
      <label className="field"><span className="field-label">用项目 ID 打开任务</span><input value={liveProjectId} onChange={(event) => setLiveProjectId(event.target.value)} name="live-task-project-id" autoComplete="off" placeholder="Project UUID" /></label>
      <div className="form-actions"><button className="primary-button" type="submit" data-testid="tasks-live-open-project" disabled={!liveProjectId.trim()}>打开项目任务</button></div>
    </form>
    <form className="create-form" noValidate onSubmit={(event) => { event.preventDefault(); if (liveTaskId.trim()) navigate(`/tasks/${encodeURIComponent(liveTaskId.trim())}`); }}>
      <label className="field"><span className="field-label">用任务 ID 打开详情</span><input value={liveTaskId} onChange={(event) => setLiveTaskId(event.target.value)} name="live-task-id" autoComplete="off" placeholder="Task UUID" /></label>
      <div className="form-actions"><button className="secondary-button" type="submit" data-testid="tasks-live-open-task" disabled={!liveTaskId.trim()}>打开真实任务</button></div>
    </form>
  </div><ResponsiveRail label="查看接入边界" title="当前范围"><div className="rail-content"><h2>真实任务入口</h2><p className="rail-intro">项目内任务可通过项目 ID 读取；任务详情可通过任务 ID 读取。当前页不把示例列表混入真实连接。</p></div></ResponsiveRail></div></section>;
  if (loading) return <section className="page-state" aria-live="polite"><p className="eyebrow">任务</p><h1>正在读取任务列表</h1><p>示例数据正在加载，页面尚未提交任何变更。</p></section>;
  if (error) return <section className="page-state page-state--error" role="alert"><p className="eyebrow">任务</p><h1>暂时无法显示任务</h1><p>{error}</p><button className="secondary-button" type="button" onClick={() => void load()}><RotateCcw aria-hidden="true" />重新读取</button></section>;
  return <section className="skill-page"><div className="page-layout"><div className="page-primary">
    <div className="list-header"><div><h1>任务</h1><p className="page-lede">将研究目标拆解为可执行的任务，明确状态、执行模式与责任人，并以产物和验收作为完成依据。</p></div><button className="primary-button" type="button" data-testid="task-create-open" onClick={openCreate}><Plus aria-hidden="true" />新建任务</button></div>
    <nav className="subnav" aria-label="任务范围"><Link className={`subnav-item${scope === "all" ? " subnav-item--active" : ""}`} to="/tasks" data-testid="tasks-tab-all" aria-current={scope === "all" ? "page" : undefined}>全部</Link><Link className={`subnav-item${scope === "inbox" ? " subnav-item--active" : ""}`} to="/tasks?tab=inbox" data-testid="tasks-tab-inbox" aria-current={scope === "inbox" ? "page" : undefined}>收件箱</Link></nav>
    <div className="list-toolbar"><label className="filter-field">项目<select value={projectFilter} onChange={(event) => setProjectFilter(event.target.value)} name="task-filter-project" disabled={scope === "inbox"}><option value="all">全部</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.title}</option>)}<option value="inbox">未归属项目</option></select></label><label className="filter-field">状态<select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as TaskStatus | "all")} name="task-filter-status"><option value="all">全部</option>{statusOptions.map((status) => <option key={status} value={status}>{taskStatusLabels[status]}</option>)}</select></label><label className="filter-field">执行模式<select value={modeFilter} onChange={(event) => setModeFilter(event.target.value as InteractionMode | "all")} name="task-filter-mode"><option value="all">全部</option>{modeOptions.map((item) => <option key={item} value={item}>{interactionModeLabels[item]}</option>)}</select></label><label className="search-field"><Search aria-hidden="true" /><span className="visually-hidden">按任务名称搜索</span><input value={search} onChange={(event) => setSearch(event.target.value)} type="search" name="task-search" placeholder="搜索任务" /></label></div>
    {refreshing && <p className="helper-text" role="status" data-testid="tasks-refreshing">正在按当前筛选更新列表，已显示的内容保持可见。</p>}
    {tasks.length === 0 ? <div className="page-state"><p>{anyFilterActive ? "当前筛选没有匹配的任务；清除筛选后可以看到全部任务。" : "还没有任务。可以先新建一项任务，或从项目页创建项目内任务。"}</p>{anyFilterActive ? <button className="secondary-button" type="button" data-testid="task-clear-filters" onClick={clearFilters}>清除筛选</button> : <button className="primary-button" type="button" onClick={openCreate}><Plus aria-hidden="true" />新建任务</button>}</div> : <div className="table-scroll"><div className="data-table"><div className="data-row data-row--head data-row--tasks" aria-hidden="true"><span className="data-cell">任务</span><span className="data-cell">项目</span><span className="data-cell">工作状态</span><span className="data-cell">执行模式</span><span className="data-cell">当前执行者</span></div><ul className="data-list">{tasks.map((task) => <li key={task.id}><Link className="data-row data-row--tasks data-row--interactive" to={`/tasks/${task.id}`} data-testid={`task-row-${task.id}`}><span className="data-cell"><strong>{task.title}</strong><small>任务修订 v{task.revision}</small></span><span className="data-cell data-cell--meta">{projectTitle(task.projectId)}</span><span className="data-cell"><StatusChip status={task.status} />{(task.waitingReason ?? task.blockedReason) && <small>{task.waitingReason ?? task.blockedReason}</small>}</span><span className="data-cell data-cell--meta">{interactionModeLabels[task.mode]}</span><span className="data-cell data-cell--meta">{executorLabels[task.executor]}</span></Link></li>)}</ul></div></div>}
    <p className="list-footer-note"><Info aria-hidden="true" />完成依据来自产物、验收与提交；工作状态、执行模式与当前执行者是三个独立事实，不能用一枚标签合并。</p>
  </div><ResponsiveRail label="查看范围说明" title="当前范围"><div className="rail-content"><h2>当前范围</h2><p className="rail-intro">{scope === "inbox" ? "收件箱只包含未归属项目的人工任务。" : "这里是整个工作空间的任务，不限定在某个项目内。"}</p><section className="rail-section"><h3>筛选保持作用域</h3><p>项目、状态与执行模式的筛选只作用于当前列表；切换“全部/收件箱”会重置项目筛选，避免把上一个范围的条件带到新范围。</p></section><section className="rail-section"><h3>未归属任务</h3><p>未归属项目的任务只允许人工事项；把它们关联到项目需要显式操作，不会自动创建 Project。</p><Link className="secondary-button secondary-button--wide" to="/tasks?tab=inbox">查看收件箱任务</Link></section><section className="rail-section"><h3>委托前确认</h3><p>AI 委托是执行意图，不是当前状态；只有满足执行条件后，单独的委托流程才能确认执行者。</p></section></div></ResponsiveRail></div></section>;
}
