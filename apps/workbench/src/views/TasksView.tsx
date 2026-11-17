import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Info, ListTodo, Plus, RotateCcw, Search, SearchX, X } from "lucide-react";
import { RelayApiError, type RelayApiClient, type RelayProjectListItem, type RelayTaskSummary } from "../api/relayClient";
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
import { sampleReason, taskRowReason } from "../lib/waitingReasons";
import { describeLiveRead } from "../lib/liveErrors";
import { useRelayConnection } from "../lib/relayConnection";
import "./TasksView.css";
import type { ExecutorKind, InteractionMode, ProjectSummary, TaskStatus, TaskSummary } from "../types";
import { Button, Tabs } from "../ui";

/** 三个范围是不同路由（不是同页面板）；导航形态由当前 URL 自动判定激活项。 */
const taskScopeTabs = [
  { key: "all", label: "全部", href: "/tasks", testId: "tasks-tab-all", className: "subnav-item" },
  { key: "inbox", label: "收件箱", href: "/tasks?tab=inbox", testId: "tasks-tab-inbox", className: "subnav-item" },
  { key: "attention", label: "人工待处理", href: "/tasks?tab=attention", className: "subnav-item" }
] as const;

const statusOptions = Object.keys(taskStatusLabels) as TaskStatus[];
const modeOptions = Object.keys(interactionModeLabels) as InteractionMode[];

// 搜索框双层边框已在共享 .search-field 规则中归零内层输入，不再依赖行内补丁。

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

/* ── 统一呈现层（2026-11-11 UI-PAGE-TASKS-01）────────────────────────────
   fixture 与 live 各自把任务映射到同一行模型，共用一份表格标记；
   宽窗保持列对齐的表格语义，窄窗由页面 CSS 转成行卡片，不再各写一份 JSX。 */

/** 任务行呈现模型：项目名由调用方解析（live 批量读项目列表，fixture 读选项表），原因已翻译。 */
interface TaskRowModel {
  readonly id: string;
  readonly title: string;
  readonly revision: string;
  readonly projectLabel: string;
  readonly status: TaskStatus;
  readonly mode: InteractionMode;
  readonly executor: ExecutorKind;
  /** 原因短读法；只有 WAITING / BLOCKED 有（null 表示该状态不带原因）。 */
  readonly reason: string | null;
  /** 原因完整句子：悬停 title 与行可访问名称用，列表内只显示短读法。 */
  readonly reasonDetail: string | null;
}

/** 单个 Project ID 的名称事实；pending/failed 必须与 ready 分开，不能用全局状态代替。 */
type ProjectFactEntry =
  | { readonly status: "pending" }
  | { readonly status: "failed" }
  | { readonly status: "ready"; readonly title: string; readonly archived: boolean };
type ProjectFacts = Readonly<Record<string, ProjectFactEntry>>;

/**
 * 统一任务表：原生 `<table>` 语义。五列表头是 `<th scope="col">`，每行是 `<tr>`、每格是 `<td>`，
 * 读屏按「列标题 → 单元格」关联；任务标题是单元格里的真实链接（Tab/Enter 可达），
 * 整行的悬停与键盘焦点由 `tr:hover` / `tr:focus-within` 表达，不在行内嵌套交互元素。
 * 窄窗只改视觉布局（CSS），表格角色与列标题由浏览器继续保留。
 */
function TaskTable({ rows }: { rows: readonly TaskRowModel[] }) {
  return <div className="pv-card task-table-card"><div className="table-scroll">
    <table className="data-table task-table">
      <caption className="visually-hidden">任务列表：每行一个任务，列依次为任务、项目、工作状态、执行模式、当前执行者。</caption>
      <colgroup>
        <col className="task-col-title" /><col className="task-col-project" /><col className="task-col-state" />
        <col className="task-col-mode" /><col className="task-col-executor" />
      </colgroup>
      <thead><tr className="data-row--head data-row--tasks">
        <th scope="col" className="data-cell">任务</th>
        <th scope="col" className="data-cell">项目</th>
        <th scope="col" className="data-cell">工作状态</th>
        <th scope="col" className="data-cell">执行模式</th>
        <th scope="col" className="data-cell">当前执行者</th>
      </tr></thead>
      <tbody className="data-list">{rows.map((task) => <TaskTableRow key={task.id} task={task} />)}</tbody>
    </table>
  </div></div>;
}

function TaskTableRow({ task }: { task: TaskRowModel }) {
  return <tr className="data-row--tasks task-row" data-testid={`task-row-${task.id}`}>
    <td className="data-cell task-cell-main">
      <Link className="task-title-link" to={`/tasks/${task.id}`} data-testid={`task-row-link-${task.id}`}
        aria-label={`打开任务：${task.title}`}><strong title={task.title}>{task.title}</strong></Link>
      <small>任务修订 v{task.revision}</small>
    </td>
    <td className="data-cell data-cell--meta task-cell-project" data-label="项目">{task.projectLabel}</td>
    <td className="data-cell task-cell-state" data-label="工作状态"><StatusChip status={task.status} />{task.reason !== null && <small className="data-cell-reason" title={task.reasonDetail ?? task.reason}>{task.reason}</small>}</td>
    <td className="data-cell data-cell--meta" data-label="执行模式">{interactionModeLabels[task.mode]}</td>
    <td className="data-cell data-cell--meta" data-label="当前执行者">{executorLabels[task.executor]}</td>
  </tr>;
}

/** 当前生效筛选摘要：每条可单独移除，附一键清除；无筛选时不渲染，不占首屏。 */
function ActiveFilterBar({ filters, onClear }: {
  filters: readonly { key: string; label: string; onRemove: () => void }[];
  onClear: () => void;
}) {
  if (filters.length === 0) return null;
  return <div className="active-filters" data-testid="tasks-active-filters">
    <span className="active-filters-label">筛选生效中</span>
    <ul className="active-filters-list" role="list">
      {filters.map((filter) => <li key={filter.key} className="active-filter-chip">
        <span>{filter.label}</span>
        <button className="active-filter-remove" type="button" aria-label={`移除筛选：${filter.label}`} onClick={filter.onRemove}><X aria-hidden="true" /></button>
      </li>)}
    </ul>
    <Button variant="text" onClick={onClear}>清除筛选</Button>
  </div>;
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
  // 当前生效筛选：chips 逐项可移除，无筛选时不渲染（不占首屏）。
  const activeFilters = [
    ...(projectFilter !== "all" ? [{ key: "project", label: `项目：${projectFilter === "inbox" ? "未归属项目" : projectTitle(projectFilter)}`, onRemove: () => setProjectFilter("all") }] : []),
    ...(statusFilter !== "all" ? [{ key: "status", label: `状态：${taskStatusLabels[statusFilter]}`, onRemove: () => setStatusFilter("all") }] : []),
    ...(modeFilter !== "all" ? [{ key: "mode", label: `执行模式：${interactionModeLabels[modeFilter]}`, onRemove: () => setModeFilter("all") }] : []),
    ...(search !== "" ? [{ key: "search", label: `搜索“${search}”`, onRemove: () => setSearch("") }] : [])
  ];
  const taskRows: TaskRowModel[] = tasks.map((task) => {
    const reason = sampleReason(task.status, task.waitingReason, task.blockedReason);
    return {
      id: task.id, title: task.title, revision: task.revision, projectLabel: projectTitle(task.projectId),
      status: task.status, mode: task.mode, executor: task.executor,
      reason: reason?.short ?? null, reasonDetail: reason?.detail ?? null
    };
  });
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
  if (scope === "attention") return <section className="skill-page pv-page"><PageHeader title="人工待处理" lede="当前是示例预览，无法读取跨项目待处理事实。连接本机 API 后再查看。" /><Link className="text-link" to="/tasks">返回任务</Link></section>;
  if (loading) return <section className="page-state pv-page" aria-live="polite"><p className="eyebrow">Tasks</p><h1>正在读取任务列表</h1><p>示例数据正在加载，页面尚未提交任何变更。</p></section>;
  if (error) return <section className="page-state page-state--error pv-page" role="alert"><p className="eyebrow">Tasks</p><h1>暂时无法显示任务</h1><p>{error}</p><Button variant="secondary" onClick={() => void load()}><RotateCcw aria-hidden="true" />重新读取</Button></section>;
  return <section className="skill-page task-list-page pv-page"><div className="page-layout"><div className="page-primary">
    <PageHeader testId="tasks-page-head" title="任务" overline="Tasks"
      actions={<><Button variant="primary" data-testid="task-create-open" onClick={openLightweight}><Plus aria-hidden="true" />新建任务</Button>
        <Button variant="secondary" data-testid="task-create-full" onClick={openCreate}>填写完整定义</Button></>} />
    <div className="subnav-row task-scope-row">
      <Tabs label="任务范围" variant="page" className="subnav" items={taskScopeTabs} />
      {/* 范围说明入口与范围页签同行：宽屏不再先占一整行空白、落在页面底部，窄屏也不用滚到列表末。 */}
      <ResponsiveRail inline label="查看范围说明" title="当前范围"><div className="rail-content"><h2>当前范围</h2><p className="rail-intro">这里是整个工作空间的任务，不限定在某个项目内。</p><section className="rail-section"><h3>筛选保持作用域</h3><p>项目、状态与执行模式的筛选只作用于当前列表；切换“全部/收件箱”会重置项目筛选，避免把上一个范围的条件带到新范围。</p></section><section className="rail-section"><h3>未归属任务</h3><p>未归属项目的任务只允许人工事项；把它们关联到项目需要显式操作，不会自动创建 Project。<Link className="secondary-button secondary-button--wide" to="/tasks?tab=inbox">查看收件箱任务</Link></p></section><section className="rail-section"><h3>委托前确认</h3><p>AI 委托是执行意图，不是当前状态；只有满足执行条件后，单独的委托流程才能确认执行者。</p></section></div></ResponsiveRail>
    </div>
    <div className="list-toolbar list-toolbar--compact" data-testid="tasks-toolbar"><label className="search-field"><Search aria-hidden="true" /><span className="visually-hidden">按任务名称搜索</span><input value={search} onChange={(event) => setSearch(event.target.value)} type="search" name="task-search" placeholder="搜索任务" /></label><label className="filter-field">项目<select value={projectFilter} onChange={(event) => setProjectFilter(event.target.value)} name="task-filter-project"><option value="all">全部</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.title}</option>)}<option value="inbox">未归属项目</option></select></label><label className="filter-field">状态<select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as TaskStatus | "all")} name="task-filter-status"><option value="all">全部</option>{statusOptions.map((status) => <option key={status} value={status}>{taskStatusLabels[status]}</option>)}</select></label><label className="filter-field">执行模式<select value={modeFilter} onChange={(event) => setModeFilter(event.target.value as InteractionMode | "all")} name="task-filter-mode"><option value="all">全部</option>{modeOptions.map((item) => <option key={item} value={item}>{interactionModeLabels[item]}</option>)}</select></label></div>
    <ActiveFilterBar filters={activeFilters} onClear={clearFilters} />
    {refreshing && <p className="helper-text" role="status" data-testid="tasks-refreshing">正在按当前筛选更新列表，已显示的内容保持可见。</p>}
    {tasks.length === 0
      ? hasFilters
        // 筛选无匹配：只能说当前筛选下没有命中，不能说工作空间没有任务。
        ? <EmptyState size="compact" icon={SearchX} title="当前筛选没有匹配的任务"
          description="清除筛选后可以看到全部任务；筛选只作用于已加载范围，不代表工作空间里没有别的工作。"
          testId="tasks-fixture-no-match"
          actions={<Button variant="secondary" data-testid="task-clear-filters" onClick={clearFilters}>清除筛选</Button>} />
        : <EmptyState icon={ListTodo} as="h2" title="还没有任务"
          description="任务是一次可验收的工作：写清验收条件后即可开始，完成时留下确切产物版本。可以直接新建一条，也可以先建项目再在项目内拆任务。"
          testId="tasks-empty"
          actions={<><Button variant="primary" onClick={openLightweight}><Plus aria-hidden="true" />新建任务</Button>
            <Link className="secondary-button" to="/projects">打开项目</Link></>} />
      : <TaskTable rows={taskRows} />}
    <div className="task-list-foot">
      <p className="list-count-note" data-testid="tasks-fixture-count">{hasFilters ? `当前筛选显示 ${tasks.length} 项任务。` : `共 ${tasks.length} 项任务。`}</p>
      <p className="list-footer-note"><Info aria-hidden="true" />完成依据来自产物、验收与提交。</p>
    </div>
  </div></div></section>;
}

/** 本地时分秒；只用于「上次成功读取」标注，不参与任何业务判断。 */
function readClock(at: Date): string {
  return at.toLocaleTimeString("zh-CN", { hour12: false });
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
  // 显式刷新与首读分开：刷新时保留已显示内容，不让整页先空一下再回来。
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 刷新失败是局部状态：已读任务与游标都留着，只标明这次刷新没成功（禅道 #101 的同类处理）。
  const [refreshError, setRefreshError] = useState<string | null>(null);
  // 续页失败同样是局部状态：按原游标重试，不清空列表。
  const [moreError, setMoreError] = useState<string | null>(null);
  // 上次成功读取的时刻：刷新失败后仍能说清屏幕上的内容是什么时候读到的。
  const [lastReadAt, setLastReadAt] = useState<string | null>(null);
  const [projectFacts, setProjectFacts] = useState<ProjectFacts>({});
  const [projectFilter, setProjectFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<TaskStatus | "all">("all");
  const [modeFilter, setModeFilter] = useState<InteractionMode | "all">("all");
  const [search, setSearch] = useState("");
  const requestVersion = useRef(0);
  const busy = useRef(false);
  /**
   * Project 名称按 ID 独立记账：每个 ID 有自己的 pending / failed / ready 状态与请求令牌。
   * 分页批次可以并发返回，一批的完成不能取消另一批；只有 Workspace 作用域变化才整体失效。
   * projectFactsRef 是同步可读的事实源，避免 React 状态尚未提交时重复发同一 ID 的请求。
   */
  const projectFactsRef = useRef<ProjectFacts>({});
  const projectFactTokens = useRef(new Map<string, number>());
  const projectScopeEpoch = useRef(0);

  function commitProjectFacts(update: (current: ProjectFacts) => ProjectFacts): void {
    const next = update(projectFactsRef.current);
    projectFactsRef.current = next;
    setProjectFacts(next);
  }

  /**
   * 项目名称按当前页实际引用的 Project ID 集合批量读：不再依赖「项目列表第一页 100 条」，
   * 因而 >100 项目的工作空间、早期创建的项目、归档项目都能按 ID 取回；只读给定 ID，
   * 不返回其他 Workspace 的事实。读失败只影响名称列，不把任务列表整体读成失败。
   *
   * 并发规则：
   * - 每个 ID 独立令牌；新请求只取代同一 ID 的旧令牌，不影响其他 ID 的批次。
   * - `more` 只补未命中或已失败的 ID，已读取/正在读取的 ID 不重复请求。
   * - `refresh` 重新读取当前页全部 ID；已有成功名称在刷新期间继续显示，刷新失败也不回退成 ID。
   */
  async function loadProjectFacts(projectIds: readonly (string | null)[], mode: "refresh" | "more"): Promise<void> {
    const ids = [...new Set(projectIds.filter((id): id is string => id !== null))];
    const toRead = mode === "more"
      ? ids.filter((id) => {
        const entry = projectFactsRef.current[id];
        return entry === undefined || entry.status === "failed";
      })
      : ids;
    if (toRead.length === 0) return;

    const scope = projectScopeEpoch.current;
    const tokens = new Map<string, number>();
    for (const id of toRead) {
      const token = (projectFactTokens.current.get(id) ?? 0) + 1;
      projectFactTokens.current.set(id, token);
      tokens.set(id, token);
    }
    commitProjectFacts((current) => {
      const next = { ...current };
      for (const id of toRead) {
        // 刷新时保留已有的成功事实，避免正在看的中文名称先闪回「读取中」。
        if (mode === "refresh" && current[id]?.status === "ready") continue;
        next[id] = { status: "pending" };
      }
      return next;
    });

    let projects: readonly RelayProjectListItem[];
    try {
      projects = await client.getProjectSummariesByIds(toRead);
    } catch {
      if (scope !== projectScopeEpoch.current) return;
      commitProjectFacts((current) => {
        const next = { ...current };
        for (const id of toRead) {
          if (tokens.get(id) !== projectFactTokens.current.get(id)) continue;
          // 刷新失败时旧名称仍可核对；首次读取失败才显示 ID 兜底。
          if (current[id]?.status === "ready") continue;
          next[id] = { status: "failed" };
        }
        return next;
      });
      return;
    }
    if (scope !== projectScopeEpoch.current) return;
    const byId = new Map(projects.map((project) => [project.id, project]));
    commitProjectFacts((current) => {
      const next = { ...current };
      for (const id of toRead) {
        const currentToken = projectFactTokens.current.get(id);
        const isLatest = tokens.get(id) === currentToken;
        // 同一 ID 已有更新的读取结果时，旧批次的成功不再覆盖；但旧批次仍可补上「尚未成功」的空缺，
        // 避免「新请求失败 + 旧请求成功」时反而退回 UUID。
        if (!isLatest && current[id]?.status === "ready") continue;
        const project = byId.get(id);
        next[id] = project === undefined
          ? { status: "failed" }
          : { status: "ready", title: project.title, archived: project.archivedAt !== null };
      }
      return next;
    });
  }

  /**
   * 三种读取分开处理，失败后果不同：
   * - initial：首读，失败走全页错误态；
   * - manual：显式刷新，暂时失败保留旧数据并提示「这次没刷新成功」；失权仍然清空；
   * - more：续页，暂时失败保留游标就地重试。
   * `busy` 保证同一时刻只有一个在途读取，重复点击不会发第二次请求。
   */
  async function loadTasks(cursor: string | null, mode: "initial" | "manual" | "more") {
    if (busy.current) return;
    busy.current = true;
    const request = ++requestVersion.current;
    if (mode === "more") { setLoadingMore(true); setMoreError(null); }
    else if (mode === "manual") { setRefreshing(true); setError(null); setRefreshError(null); setMoreError(null); }
    else { setLoading(true); setError(null); setRefreshError(null); setMoreError(null); }
    try {
      const page = await client.getWorkspaceTasksPage(cursor);
      if (request !== requestVersion.current) return;
      // 续页按 ID 去重：同一游标重试成功也不会重复追加首屏已有项。
      setItems((current) => mode === "more"
        ? [...current, ...page.items.filter((item) => !current.some((seen) => seen.id === item.id))]
        : page.items);
      setNextCursor(page.nextCursor);
      setLastReadAt(readClock(new Date()));
      setError(null);
      void loadProjectFacts(page.items.map((item) => item.projectId), mode === "more" ? "more" : "refresh");
    } catch (caught) {
      if (request !== requestVersion.current) return;
      const message = describeLiveRead(caught);
      if (mode === "more" && !isAccessLost(caught)) {
        setMoreError(message);
        return;
      }
      if (mode === "manual" && !isAccessLost(caught)) {
        // 暂时不可用：保留已读任务与原游标，屏幕上的内容仍是上次成功读取的结果。
        setRefreshError(message);
        return;
      }
      // 首读失败，或任何模式下失权／作用域失效：不得保留已失权数据，回到全页错误态。
      setItems([]); setNextCursor(null); setLastReadAt(null);
      setError(message);
    } finally {
      if (request === requestVersion.current) {
        busy.current = false; setLoading(false); setRefreshing(false); setLoadingMore(false);
      }
    }
  }

  function refreshAll() {
    void loadTasks(null, "manual");
  }

  useEffect(() => {
    // 连接/Workspace 是唯一的整体作用域边界：先让旧作用域在途请求失效并清空旧映射，
    // 再启动新作用域首读；不要在每个分页批次里递增作用域 epoch。
    projectScopeEpoch.current += 1;
    projectFactsRef.current = {};
    projectFactTokens.current.clear();
    setProjectFacts({});
    void loadTasks(null, "initial");
    return () => { requestVersion.current++; projectScopeEpoch.current++; };
  }, [client]);

  const projectLabel = (projectId: string | null): string => {
    if (projectId === null) return "未归属项目";
    const fact = projectFacts[projectId];
    if (fact?.status === "ready") return fact.archived ? `${fact.title}（已归档）` : fact.title;
    if (fact?.status === "failed") return `项目 ${projectId}`;
    // 尚未读取或正在读取：明说在读取，不先摆 UUID，也不能让别的 Project 先完成就提前回退。
    return "项目名称读取中";
  };

  const needle = search.trim().toLocaleLowerCase();
  const loadedProjectIds = [...new Set(items.map((task) => task.projectId).filter((id): id is string => id !== null))];
  const visible = items.filter((task) =>
    (projectFilter === "all" || (projectFilter === "inbox" ? task.projectId === null : task.projectId === projectFilter)) &&
    (statusFilter === "all" || task.status === statusFilter) &&
    (modeFilter === "all" || task.mode === modeFilter) &&
    (!needle || task.title.toLocaleLowerCase().includes(needle)));
  const hasFilters = projectFilter !== "all" || statusFilter !== "all" || modeFilter !== "all" || needle !== "";
  const clearFilters = () => { setProjectFilter("all"); setStatusFilter("all"); setModeFilter("all"); setSearch(""); };
  // 当前生效筛选（live）：搜索按已去空白的关键词展示，与实际过滤口径一致。
  const activeFilters = [
    ...(projectFilter !== "all" ? [{ key: "project", label: `项目：${projectFilter === "inbox" ? "未归属项目" : projectLabel(projectFilter)}`, onRemove: () => setProjectFilter("all") }] : []),
    ...(statusFilter !== "all" ? [{ key: "status", label: `状态：${taskStatusLabels[statusFilter]}`, onRemove: () => setStatusFilter("all") }] : []),
    ...(modeFilter !== "all" ? [{ key: "mode", label: `执行模式：${interactionModeLabels[modeFilter]}`, onRemove: () => setModeFilter("all") }] : []),
    ...(needle !== "" ? [{ key: "search", label: `搜索“${needle}”`, onRemove: () => setSearch("") }] : [])
  ];
  const taskRows: TaskRowModel[] = visible.map((task) => {
    // 原因只按服务端事实读：WAITING 读 waiting_reason，BLOCKED 读前置任务与未解除阻塞；
    // 未知码保留原始码，没有原因时如实说「尚未登记」，不写「任务依赖未完成」这类含糊话。
    const reason = taskRowReason(task);
    return {
      id: task.id, title: task.title, revision: task.revision, projectLabel: projectLabel(task.projectId),
      status: task.status, mode: task.mode, executor: task.executor,
      reason: reason?.short ?? null, reasonDetail: reason?.detail ?? null
    };
  });
  return <section className="skill-page task-list-page pv-page" data-testid="tasks-live-all"><div className="page-layout">
    <div className="page-primary">
      <PageHeader testId="tasks-page-head" title="任务" overline="Tasks"
        lede="整个工作空间的任务；筛选只作用于已加载的页。"
        actions={<><Button variant="primary" data-testid="task-create-open" onClick={onCreateLightweight}><Plus aria-hidden="true" />新建任务</Button>
          <Button variant="secondary" data-testid="task-create-full" onClick={onCreate}>填写完整定义</Button></>} />
      <div className="subnav-row task-scope-row">
        <Tabs label="任务范围" variant="page" className="subnav" items={taskScopeTabs} />
        {/* 范围说明入口与范围页签同行：宽屏不占整行空白，窄屏也不必滚到列表末才看到入口。 */}
        <ResponsiveRail inline label="查看任务范围" title="已加载范围"><div className="rail-content"><h2>全工作空间范围</h2>
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
              <Button variant="secondary" type="submit" data-testid="tasks-live-open-project" disabled={!liveProjectId.trim()}>打开项目任务</Button></form>
            <form className="create-form" noValidate onSubmit={(event) => { event.preventDefault();
              if (liveTaskId.trim()) navigate(`/tasks/${encodeURIComponent(liveTaskId.trim())}`);
            }}><label className="field"><span className="field-label">任务 ID</span><input value={liveTaskId}
              onChange={(event) => setLiveTaskId(event.target.value)} name="live-task-id" autoComplete="off" placeholder="Task UUID" /></label>
              <Button variant="secondary" type="submit" data-testid="tasks-live-open-task" disabled={!liveTaskId.trim()}>打开任务详情</Button></form>
          </details>
        </div></ResponsiveRail>
      </div>
      <div className="list-toolbar list-toolbar--compact" data-testid="tasks-toolbar">
        <label className="search-field"><Search aria-hidden="true" /><span className="visually-hidden">在已加载任务中按名称搜索</span>
          <input value={search} onChange={(event) => setSearch(event.target.value)} type="search" name="task-search"
            placeholder="搜索已加载任务" /></label>
        <label className="filter-field">项目<select value={projectFilter}
        onChange={(event) => setProjectFilter(event.target.value)} name="task-filter-project">
        <option value="all">全部</option><option value="inbox">未归属项目</option>{loadedProjectIds.map((id) =>
          <option key={id} value={id}>{projectLabel(id)}</option>)}</select></label>
        <label className="filter-field">状态<select value={statusFilter}
        onChange={(event) => setStatusFilter(event.target.value as TaskStatus | "all")} name="task-filter-status">
        <option value="all">全部</option>{statusOptions.map((status) =>
          <option key={status} value={status}>{taskStatusLabels[status]}</option>)}</select></label>
        <label className="filter-field">执行模式<select value={modeFilter}
          onChange={(event) => setModeFilter(event.target.value as InteractionMode | "all")} name="task-filter-mode">
          <option value="all">全部</option>{modeOptions.map((item) =>
            <option key={item} value={item}>{interactionModeLabels[item]}</option>)}</select></label>
        <Button variant="secondary" data-testid="tasks-live-refresh"
          disabled={loading || loadingMore || refreshing} onClick={refreshAll}><RotateCcw aria-hidden="true" />刷新任务列表</Button></div>
      {refreshing && <p className="helper-text" role="status" data-testid="tasks-live-refreshing">正在刷新任务列表，已显示上次读取的内容。</p>}
      {refreshError && <p className="action-error" role="alert" data-testid="tasks-live-refresh-error">本次刷新没有成功：{refreshError}。{lastReadAt === null ? "屏幕上的内容是此前读取的结果。" : `屏幕上的内容仍是 ${lastReadAt} 读取的结果。`}核对后可再次刷新。</p>}
      {loading ? <div className="page-state" aria-live="polite"><p>正在从本机服务读取工作空间任务…</p></div> :
        error ? <div className="page-state page-state--error" role="alert"><p>{error}</p>
          <Button variant="secondary" onClick={() => void loadTasks(null, "initial")}><RotateCcw aria-hidden="true" />重新读取</Button></div> : <>
          <ActiveFilterBar filters={activeFilters} onClear={clearFilters} />
          {visible.length === 0
            ? items.length === 0
              // 空列表只说明服务端这一页返回 0 项，不代表工作空间一定没有任务；已到末页时才敢这么说。
              ? <EmptyState icon={ListTodo} as="h2" title="工作空间里还没有任务"
                description={nextCursor === null
                  ? "服务端返回 0 项任务且已到列表末页。任务是一次可验收的工作：写清验收条件后即可开始，完成时留下确切产物版本。"
                  : "这一页没有任务，但列表还有后续页；先加载更多再判断工作空间是否为空。"}
                testId="tasks-empty"
                actions={<><Button variant="primary" onClick={onCreateLightweight}><Plus aria-hidden="true" />新建任务</Button>
                  <Link className="secondary-button" to="/projects">打开项目</Link></>} />
              // 筛选无匹配与工作空间为空不同：只能说已加载范围内没有命中。
              : <EmptyState size="compact" icon={SearchX} title="已加载任务里没有匹配项"
                description={`已加载 ${items.length} 项，当前筛选显示 0 项。状态、模式与标题筛选只作用于已加载范围，后续页可能仍有匹配任务。`}
                testId="tasks-live-no-match"
                actions={hasFilters ? <Button variant="secondary" onClick={clearFilters}>清除筛选</Button> : undefined} />
            : <TaskTable rows={taskRows} />}
          <div className="task-list-foot">
            <p className="list-count-note" data-testid="tasks-live-count">已加载 {items.length} 项 · 当前筛选显示 {visible.length} 项
              {nextCursor ? " · 仍有后续页" : " · 已到列表末页"}。筛选只作用于已加载任务{lastReadAt === null ? "。" : ` · 上次成功读取 ${lastReadAt}。`}</p>
            {moreError && <p className="action-error" role="alert" data-testid="tasks-live-more-error">续页失败：{moreError}；已保留前面加载的结果，可按原游标重试。</p>}
            {nextCursor && <Button variant="secondary" data-testid="tasks-live-load-more"
              disabled={loadingMore || refreshing || loading} onClick={() => void loadTasks(nextCursor, "more")}>{loadingMore ? "正在加载" : moreError ? "重试加载后续页" : "加载更多"}</Button>}
          </div>
        </>}
    </div>
  </div></section>;
}
