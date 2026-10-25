import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Info, ListTodo, Plus, RotateCcw, Search, SearchX } from "lucide-react";
import { RelayApiError, type RelayApiClient, type RelayTaskSummary } from "../api/relayClient";
import EmptyState from "../components/EmptyState";
import ResponsiveRail from "../components/ResponsiveRail";
import AttentionQueue from "../components/AttentionQueue";
import InboxView from "./InboxView";
import PageHeader from "../components/PageHeader";
import StatusChip from "../components/StatusChip";
import CreateTaskView from "./CreateTaskView";
import { fixtureAdapter, type TaskListQuery } from "../fixtures/fixtureAdapter";
import { fixtureModeFromQuery } from "../lib/fixtureMode";
import { executorLabels, interactionModeLabels, taskStatusLabels } from "../lib/labels";
import { describeLiveError } from "../lib/liveErrors";
import { useRelayConnection } from "../lib/relayConnection";
import "./TasksView.css";
import type { InteractionMode, ProjectSummary, TaskStatus, TaskSummary } from "../types";

const statusOptions = Object.keys(taskStatusLabels) as TaskStatus[];
const modeOptions = Object.keys(interactionModeLabels) as InteractionMode[];

// 搜索框双层边框已在共享 .search-field 规则中归零内层输入，不再依赖行内补丁。
// 任务整行是链接：行的可点性由 hover 背景与独立动作表达，去掉链接默认下划线，
// 与按钮行（.data-row）及 .dependency-card 的既有观感保持一致。
const rowLinkStyle = { textDecoration: "none" } as const;

/**
 * 失权或作用域失效：这类错误说明已经读到的内容不再属于可见范围，不能按「暂时不可用」保留。
 * 401/403/404 与 AUTH_REQUIRED／RESOURCE_NOT_FOUND 都按此判定，口径与项目列表页（#110）
 * 和 ActivityView 的续页处理一致：暂时不可用保留前页，已失权清空并报无权。
 */
function isAccessLost(caught: unknown): boolean {
  if (!(caught instanceof RelayApiError)) return false;
  const { status, code } = caught.problem;
  return status === 401 || status === 403 || status === 404
    || code === "AUTH_REQUIRED" || code === "RESOURCE_NOT_FOUND";
}

export default function TasksView() {
  const navigate = useNavigate();
  const [query] = useSearchParams();
  const mode = fixtureModeFromQuery(query);
  const creating = query.get("view") === "create";
  const scope = query.get("tab") === "inbox" ? "inbox" : query.get("tab") === "attention" ? "attention" : "all";
  const connection = useRelayConnection();
  const live = connection.mode === "live";
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
      const listQuery: TaskListQuery = { projectId: projectFilter, status: statusFilter, mode: modeFilter, query: search };
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
  // 收件箱范围由 InboxView 自己读（fixture 与 live 两条数据链都在那里），这里不再为它加载。
  useEffect(() => { if (!live && scope !== "inbox") void load(); return () => { requestVersion.current++; }; }, [live, mode, scope, projectFilter, statusFilter, modeFilter, search]);
  useEffect(() => { setProjectFilter("all"); }, [scope]);
  const hasFilters = projectFilter !== "all" || statusFilter !== "all" || modeFilter !== "all" || search !== "";
  const clearFilters = () => { setProjectFilter("all"); setStatusFilter("all"); setModeFilter("all"); setSearch(""); };
  const projectTitle = (projectId: string | null) => projectId === null ? "未归属项目" : projects.find((project) => project.id === projectId)?.title ?? projectId;
  const openCreate = () => navigate(`/tasks?view=create${scope === "inbox" ? "&tab=inbox" : ""}`);
  /**
   * 「新建任务」默认走一句话登记（工作台 §18.7）：先记下要完成什么，验收标准、项目与委托
   * 之后再补；完整定义仍在，只是不再作为默认入口挡在第一步。
   */
  const openLightweight = () => navigate(`/tasks?view=create&light=1${scope === "inbox" ? "&tab=inbox" : ""}`);
  const closeCreate = () => navigate(scope === "inbox" ? "/tasks?tab=inbox" : "/tasks");
  if (creating) return <section className="skill-page"><CreateTaskView inboxScope={scope === "inbox"} onCancel={closeCreate} /></section>;
  // 收件箱是独立页（/tasks?tab=inbox，/inbox 别名）：fixture 与 live 两种数据链都收在 InboxView。
  // key 带连接代号：切换 Workspace 后旧在途响应不能覆盖新范围的数据。
  if (scope === "inbox") return <InboxView key={connection.epoch} client={live ? connection.client : null} />;
  if (live && connection.client && scope === "attention") return <AttentionQueue key={connection.epoch} client={connection.client} />;
  if (live && connection.client) return <LiveTaskListView key={connection.epoch} client={connection.client} onCreate={openCreate} onCreateLightweight={openLightweight} />;
  if (scope === "attention") return <section className="skill-page"><h1>人工待处理</h1><p>当前是示例预览，无法读取跨项目待处理事实。连接本机 API 后再查看。</p><Link to="/tasks">返回任务</Link></section>;
  if (loading) return <section className="page-state pv-page" aria-live="polite"><p className="eyebrow">Tasks</p><h1>正在读取任务列表</h1><p>示例数据正在加载，页面尚未提交任何变更。</p></section>;
  if (error) return <section className="page-state page-state--error pv-page" role="alert"><p className="eyebrow">Tasks</p><h1>暂时无法显示任务</h1><p>{error}</p><button className="secondary-button" type="button" onClick={() => void load()}><RotateCcw aria-hidden="true" />重新读取</button></section>;
  return <section className="skill-page task-list-page pv-page"><div className="page-layout"><div className="page-primary">
    <PageHeader testId="tasks-page-head" title="任务" overline="Tasks"
      lede="把目标拆成可执行的任务；完成依据是产物与验收。"
      actions={<><button className="primary-button" type="button" data-testid="task-create-open" onClick={openLightweight}><Plus aria-hidden="true" />新建任务</button>
        <button className="secondary-button" type="button" data-testid="task-create-full" onClick={openCreate}>填写完整定义</button></>} />
    <nav className="subnav" aria-label="任务范围"><Link className="subnav-item subnav-item--active" to="/tasks" data-testid="tasks-tab-all" aria-current="page">全部</Link><Link className="subnav-item" to="/tasks?tab=inbox" data-testid="tasks-tab-inbox">收件箱</Link><Link className="subnav-item" to="/tasks?tab=attention">人工待处理</Link></nav>
    <div className="list-toolbar list-toolbar--compact"><label className="filter-field">项目<select value={projectFilter} onChange={(event) => setProjectFilter(event.target.value)} name="task-filter-project"><option value="all">全部</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.title}</option>)}<option value="inbox">未归属项目</option></select></label><label className="filter-field">状态<select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as TaskStatus | "all")} name="task-filter-status"><option value="all">全部</option>{statusOptions.map((status) => <option key={status} value={status}>{taskStatusLabels[status]}</option>)}</select></label><label className="filter-field">执行模式<select value={modeFilter} onChange={(event) => setModeFilter(event.target.value as InteractionMode | "all")} name="task-filter-mode"><option value="all">全部</option>{modeOptions.map((item) => <option key={item} value={item}>{interactionModeLabels[item]}</option>)}</select></label><label className="search-field"><Search aria-hidden="true" /><span className="visually-hidden">按任务名称搜索</span><input value={search} onChange={(event) => setSearch(event.target.value)} type="search" name="task-search" placeholder="搜索任务" /></label></div>
    {refreshing && <p className="helper-text" role="status" data-testid="tasks-refreshing">正在按当前筛选更新列表，已显示的内容保持可见。</p>}
    {tasks.length === 0
      ? hasFilters
        // 筛选无匹配：只能说当前筛选下没有命中，不能说工作空间没有任务。
        ? <EmptyState size="compact" icon={SearchX} title="当前筛选没有匹配的任务"
          description="清除筛选后可以看到全部任务；筛选只作用于已加载范围，不代表工作空间里没有别的工作。"
          testId="tasks-fixture-no-match"
          actions={<button className="secondary-button" type="button" data-testid="task-clear-filters" onClick={clearFilters}>清除筛选</button>} />
        : <EmptyState icon={ListTodo} as="h2" title="还没有任务"
          description="任务是一次可验收的工作：写清验收条件后即可开始，完成时留下确切产物版本。可以直接新建一条，也可以先建项目再在项目内拆任务。"
          testId="tasks-empty"
          actions={<><button className="primary-button" type="button" onClick={openLightweight}><Plus aria-hidden="true" />新建任务</button>
            <Link className="secondary-button" to="/projects">打开项目</Link></>} />
      : <div className="table-scroll"><div className="data-table"><div className="data-row data-row--head data-row--tasks" aria-hidden="true"><span className="data-cell">任务</span><span className="data-cell">项目</span><span className="data-cell">工作状态</span><span className="data-cell">执行模式</span><span className="data-cell">当前执行者</span></div><ul className="data-list">{tasks.map((task) => <li key={task.id}><Link className="data-row data-row--tasks data-row--interactive" to={`/tasks/${task.id}`} data-testid={`task-row-${task.id}`} style={rowLinkStyle}><span className="data-cell"><strong title={task.title}>{task.title}</strong><small>任务修订 v{task.revision}</small></span><span className="data-cell data-cell--meta">{projectTitle(task.projectId)}</span><span className="data-cell"><StatusChip status={task.status} />{(task.waitingReason ?? task.blockedReason) && <small>{task.waitingReason ?? task.blockedReason}</small>}</span><span className="data-cell data-cell--meta">{interactionModeLabels[task.mode]}</span><span className="data-cell data-cell--meta">{executorLabels[task.executor]}</span></Link></li>)}</ul></div></div>}
    <p className="list-footer-note"><Info aria-hidden="true" />完成依据来自产物、验收与提交。</p>
  </div><ResponsiveRail label="查看范围说明" title="当前范围"><div className="rail-content"><h2>当前范围</h2><p className="rail-intro">这里是整个工作空间的任务，不限定在某个项目内。</p><section className="rail-section"><h3>筛选保持作用域</h3><p>项目、状态与执行模式的筛选只作用于当前列表；切换“全部/收件箱”会重置项目筛选，避免把上一个范围的条件带到新范围。</p></section><section className="rail-section"><h3>未归属任务</h3><p>未归属项目的任务只允许人工事项；把它们关联到项目需要显式操作，不会自动创建 Project。<Link className="secondary-button secondary-button--wide" to="/tasks?tab=inbox">查看收件箱任务</Link></p></section><section className="rail-section"><h3>委托前确认</h3><p>AI 委托是执行意图，不是当前状态；只有满足执行条件后，单独的委托流程才能确认执行者。</p></section></div></ResponsiveRail></div></section>;
}

/** 全工作空间任务列表（live）：只服务「全部」范围，收件箱范围由 InboxView 负责。 */
function LiveTaskListView({ client, onCreate, onCreateLightweight }: {
  client: RelayApiClient; onCreate: () => void; onCreateLightweight: () => void }) {
  const navigate = useNavigate();
  const [liveProjectId, setLiveProjectId] = useState("");
  const [liveTaskId, setLiveTaskId] = useState("");
  const [items, setItems] = useState<readonly RelayTaskSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 续页失败是局部状态：已读任务与原游标都要留着，按原游标重试（禅道 #101）。
  const [moreError, setMoreError] = useState<string | null>(null);
  const [projectFilter, setProjectFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<TaskStatus | "all">("all");
  const [modeFilter, setModeFilter] = useState<InteractionMode | "all">("all");
  const [search, setSearch] = useState("");
  const [projectTitles, setProjectTitles] = useState<Record<string, string | null>>({});
  const resolvedProjects = useRef<Set<string>>(new Set());
  const requestVersion = useRef(0);
  const busy = useRef(false);

  async function loadPage(cursor: string | null) {
    if (busy.current) return;
    busy.current = true;
    const request = ++requestVersion.current;
    if (cursor === null) {
      // 首读：从头开始，失败时走全页错误态。
      setItems([]); setNextCursor(null); setLoading(true); setError(null); setMoreError(null);
    } else {
      // 续页：已读任务与原游标都留着，失败只就地提示（禅道 #101）。
      setLoadingMore(true); setMoreError(null);
    }
    try {
      const page = await client.getWorkspaceTasksPage(cursor);
      if (request !== requestVersion.current) return;
      // 续页按 ID 去重：同一游标重试成功也不会重复追加首屏已有项。
      setItems((current) => cursor === null ? page.items
        : [...current, ...page.items.filter((item) => !current.some((seen) => seen.id === item.id))]);
      setNextCursor(page.nextCursor);
    } catch (caught) {
      if (request !== requestVersion.current) return;
      if (cursor !== null && !isAccessLost(caught)) {
        // 暂时不可用：保留已读任务与原游标，按原游标重试即可，不清空列表。
        setMoreError(describeLiveError(caught).message);
        return;
      }
      // 首读失败，或续页时失权／作用域失效：不得保留已失权数据，回到全页错误态。
      setItems([]); setNextCursor(null);
      setError(describeLiveError(caught).message);
    } finally {
      if (request === requestVersion.current) {
        busy.current = false; setLoading(false); setLoadingMore(false);
      }
    }
  }
  useEffect(() => {
    void loadPage(null);
    return () => { requestVersion.current++; };
  }, [client]);

  // 项目列按确切 Project 单读标题；读取失败回退显示 ID，不编造名称（与收件箱页同模式）。
  useEffect(() => {
    const missing = [...new Set(items.map((task) => task.projectId).filter((id): id is string => id !== null))]
      .filter((id) => !resolvedProjects.current.has(id));
    if (missing.length === 0) return;
    for (const id of missing) resolvedProjects.current.add(id);
    void Promise.all(missing.map(async (id) => {
      try { const project = await client.getProject(id); return [id, project.archivedAt === null ? project.title : null] as const; }
      catch { return [id, null] as const; }
    })).then((entries) => setProjectTitles((current) => ({ ...current, ...Object.fromEntries(entries) })));
  }, [client, items]);

  const needle = search.trim().toLocaleLowerCase();
  const loadedProjectIds = [...new Set(items.map((task) => task.projectId).filter((id): id is string => id !== null))];
  const visible = items.filter((task) =>
    (projectFilter === "all" || (projectFilter === "inbox" ? task.projectId === null : task.projectId === projectFilter)) &&
    (statusFilter === "all" || task.status === statusFilter) &&
    (modeFilter === "all" || task.mode === modeFilter) &&
    (!needle || task.title.toLocaleLowerCase().includes(needle)));
  const hasFilters = projectFilter !== "all" || statusFilter !== "all" || modeFilter !== "all" || needle !== "";
  return <section className="skill-page task-list-page pv-page" data-testid="tasks-live-all"><div className="page-layout">
    <div className="page-primary">
      <PageHeader testId="tasks-page-head" title="任务" overline="Tasks"
        lede="整个工作空间的任务；筛选只作用于已加载的页。"
        actions={<><button className="primary-button" type="button" data-testid="task-create-open" onClick={onCreateLightweight}><Plus aria-hidden="true" />新建任务</button>
          <button className="secondary-button" type="button" data-testid="task-create-full" onClick={onCreate}>填写完整定义</button></>} />
      <nav className="subnav" aria-label="任务范围"><Link className="subnav-item subnav-item--active" to="/tasks"
        data-testid="tasks-tab-all" aria-current="page">全部</Link>
        <Link className="subnav-item" to="/tasks?tab=inbox"
          data-testid="tasks-tab-inbox">收件箱</Link>
        <Link className="subnav-item" to="/tasks?tab=attention">人工待处理</Link></nav>
      <div className="list-toolbar list-toolbar--compact">
        <button className="secondary-button" type="button" data-testid="tasks-live-refresh"
          disabled={loading || loadingMore} onClick={() => void loadPage(null)}><RotateCcw aria-hidden="true" />刷新任务列表</button>
        <label className="filter-field">项目<select value={projectFilter}
        onChange={(event) => setProjectFilter(event.target.value)} name="task-filter-project">
        <option value="all">全部</option><option value="inbox">未归属项目</option>{loadedProjectIds.map((id) =>
          <option key={id} value={id}>{projectTitles[id] ?? `项目 ${id}`}</option>)}</select></label>
        <label className="filter-field">状态<select value={statusFilter}
        onChange={(event) => setStatusFilter(event.target.value as TaskStatus | "all")} name="task-filter-status">
        <option value="all">全部</option>{statusOptions.map((status) =>
          <option key={status} value={status}>{taskStatusLabels[status]}</option>)}</select></label>
        <label className="filter-field">执行模式<select value={modeFilter}
          onChange={(event) => setModeFilter(event.target.value as InteractionMode | "all")} name="task-filter-mode">
          <option value="all">全部</option>{modeOptions.map((item) =>
            <option key={item} value={item}>{interactionModeLabels[item]}</option>)}</select></label>
        <label className="search-field"><Search aria-hidden="true" /><span className="visually-hidden">在已加载任务中按名称搜索</span>
          <input value={search} onChange={(event) => setSearch(event.target.value)} type="search" name="task-search"
            placeholder="搜索已加载任务" /></label></div>
      {loading ? <div className="page-state" aria-live="polite"><p>正在从本机服务读取工作空间任务…</p></div> :
        error ? <div className="page-state page-state--error" role="alert"><p>{error}</p>
          <button className="secondary-button" type="button" onClick={() => void loadPage(null)}><RotateCcw aria-hidden="true" />重新读取</button></div> : <>
          <p className="list-count-note" data-testid="tasks-live-count">已加载 {items.length} 项 · 当前筛选显示 {visible.length} 项
            {nextCursor ? " · 仍有后续页" : " · 已到列表末页"}。筛选只作用于已加载任务。</p>
          {visible.length === 0
            ? items.length === 0
              ? <EmptyState icon={ListTodo} as="h2" title="还没有任务"
                description="任务是一次可验收的工作：写清验收条件后即可开始，完成时留下确切产物版本。可以直接新建一条，也可以先建项目再在项目内拆任务。"
                testId="tasks-empty"
                actions={<><button className="primary-button" type="button" onClick={onCreateLightweight}><Plus aria-hidden="true" />新建任务</button>
                  <Link className="secondary-button" to="/projects">打开项目</Link></>} />
              // 筛选无匹配与工作空间为空不同：只能说已加载范围内没有命中。
              : <EmptyState size="compact" icon={SearchX} title="已加载任务里没有匹配项"
                description={`已加载 ${items.length} 项，当前筛选显示 0 项。状态、模式与标题筛选只作用于已加载范围，后续页可能仍有匹配任务。`}
                testId="tasks-live-no-match"
                actions={hasFilters ? <button className="secondary-button" type="button" onClick={() => {
                  setProjectFilter("all"); setStatusFilter("all"); setModeFilter("all"); setSearch("");
                }}>清除筛选</button> : undefined} />
            :
            <div className="table-scroll"><div className="data-table"><div className="data-row data-row--head data-row--tasks" aria-hidden="true"><span className="data-cell">任务</span><span className="data-cell">项目</span><span className="data-cell">工作状态</span><span className="data-cell">执行模式</span><span className="data-cell">当前执行者</span></div>
              <ul className="data-list">{visible.map((task) => <li key={task.id}><Link className="data-row data-row--tasks data-row--interactive"
                to={`/tasks/${task.id}`} data-testid={`task-row-${task.id}`}><span className="data-cell"><strong title={task.title}>{task.title}</strong><small>任务修订 v{task.revision}</small></span>
                <span className="data-cell data-cell--meta">{task.projectId === null ? "未归属项目"
                  : projectTitles[task.projectId] ?? `项目 ${task.projectId}`}</span><span className="data-cell"><StatusChip status={task.status} />
                  {task.waitingReason && <small>{task.waitingReason}</small>}</span><span className="data-cell data-cell--meta">{interactionModeLabels[task.mode]}</span>
                <span className="data-cell data-cell--meta">{executorLabels[task.executor]}</span></Link></li>)}</ul></div></div>}
          {moreError && <p className="action-error" role="alert" data-testid="tasks-live-more-error">续页失败：{moreError}；已保留前面加载的结果，可按原游标重试。</p>}
          {nextCursor && <button className="secondary-button" type="button" data-testid="tasks-live-load-more"
            disabled={loadingMore} onClick={() => void loadPage(nextCursor)}>{loadingMore ? "正在加载" : moreError ? "重试加载后续页" : "加载更多"}</button>}
        </>}
    </div><ResponsiveRail label="查看任务范围" title="已加载范围"><div className="rail-content"><h2>全工作空间范围</h2>
      <p className="rail-intro">服务端返回当前工作空间的项目内与未归属任务。每页最多 50 项；状态、模式和标题筛选只处理已加载的页，不代表全量任务总数。</p>
      {/* 按 ID 打开是折叠的辅助入口：只有拿到确切 UUID（如从别处复制）才需要，
          不与列表、筛选这些主流程抢层级；表单与路由语义保持不变。 */}
      <details className="page-explanation" data-testid="tasks-live-id-open">
        <summary>按 ID 打开任务</summary>
        <p className="helper-text">知道确切 ID 时可直接定位：项目 ID 打开该项目的任务列表，任务 ID 打开任务详情。日常浏览用列表与筛选即可，不需要粘贴 ID。</p>
        <form className="create-form" noValidate onSubmit={(event) => { event.preventDefault();
          if (liveProjectId.trim()) navigate(`/projects/${encodeURIComponent(liveProjectId.trim())}/tasks`);
        }}><label className="field"><span className="field-label">项目 ID</span><input value={liveProjectId}
          onChange={(event) => setLiveProjectId(event.target.value)} name="live-task-project-id" autoComplete="off" placeholder="Project UUID" /></label>
          <button className="secondary-button" type="submit" data-testid="tasks-live-open-project" disabled={!liveProjectId.trim()}>打开项目任务</button></form>
        <form className="create-form" noValidate onSubmit={(event) => { event.preventDefault();
          if (liveTaskId.trim()) navigate(`/tasks/${encodeURIComponent(liveTaskId.trim())}`);
        }}><label className="field"><span className="field-label">任务 ID</span><input value={liveTaskId}
          onChange={(event) => setLiveTaskId(event.target.value)} name="live-task-id" autoComplete="off" placeholder="Task UUID" /></label>
          <button className="secondary-button" type="submit" data-testid="tasks-live-open-task" disabled={!liveTaskId.trim()}>打开任务详情</button></form>
      </details>
    </div></ResponsiveRail>
  </div></section>;
}
