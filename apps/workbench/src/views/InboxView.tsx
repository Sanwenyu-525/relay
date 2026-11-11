import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ChevronRight, Inbox, Info, Plus, RotateCcw, Search, SearchX, X } from "lucide-react";
import type { RelayApiClient, RelayTaskSummary } from "../api/relayClient";
import EmptyState from "../components/EmptyState";
import { taskStatusIcons } from "../components/StatusChip";
import { fixtureAdapter } from "../fixtures/fixtureAdapter";
import { fixtureModeFromQuery } from "../lib/fixtureMode";
import { executorLabels, interactionModeLabels, taskStatusLabels, taskStatusTone } from "../lib/labels";
import { describeLiveError } from "../lib/liveErrors";
import "./InboxView.css";
import type { InteractionMode, ProjectSummary, TaskStatus, TaskSummary } from "../types";

const statusOptions = Object.keys(taskStatusLabels) as TaskStatus[];
const modeOptions = Object.keys(interactionModeLabels) as InteractionMode[];

/** 收件箱页的任务行模型：fixture 与 live 两种来源映射到同一呈现。 */
interface InboxTaskRow {
  readonly id: string;
  readonly title: string;
  readonly status: TaskStatus;
  readonly mode: InteractionMode;
  readonly executor: "HUMAN" | "AI";
  readonly revision: string;
  readonly waitingReason: string | null;
  readonly blockedReason: string | null;
}

/** 三张统计卡对应收件箱里最需要人工过目的三个桶；其余状态只进列表，不单独计数。 */
const statCards: readonly { status: TaskStatus; hint: string }[] = [
  { status: "INBOX", hint: "还未挂到项目，等待整理定义" },
  { status: "READY", hint: "验收条件已具备，可直接开始" },
  { status: "BLOCKED", hint: "有未解决的阻塞依据，需人工处理" }
];

function statusCounts(rows: readonly InboxTaskRow[]): Record<TaskStatus, number> {
  const counts: Record<TaskStatus, number> = { INBOX: 0, READY: 0, IN_PROGRESS: 0, WAITING: 0, BLOCKED: 0, DONE: 0, CANCELLED: 0 };
  for (const row of rows) counts[row.status] += 1;
  return counts;
}

function fixtureRow(task: TaskSummary): InboxTaskRow {
  return { id: task.id, title: task.title, status: task.status, mode: task.mode, executor: task.executor,
    revision: task.revision, waitingReason: task.waitingReason, blockedReason: task.blockedReason };
}

function liveRow(task: RelayTaskSummary): InboxTaskRow {
  return { id: task.id, title: task.title, status: task.status, mode: task.mode, executor: task.executor,
    revision: task.revision, waitingReason: task.waitingReason, blockedReason: null };
}

/* ── 共享呈现层 ─────────────────────────────────────────────────────────── */

function InboxHead({ onCreate, onCreateLightweight }: { onCreate: () => void; onCreateLightweight: () => void }) {
  return <header className="inbox-head">
    <div className="inbox-head-main">
      <p className="inbox-kicker">Inbox</p>
      <h1>收件箱</h1>
      <p className="inbox-lede">未归属项目的人工任务先集中在这里；需要你做决定的事项在「待处理」。</p>
    </div>
    <div className="inbox-head-actions">
      <button className="secondary-button" type="button" onClick={onCreateLightweight}><Plus aria-hidden="true" />轻量起步</button>
      <button className="primary-button" type="button" onClick={onCreate}><Plus aria-hidden="true" />新建任务</button>
    </div>
  </header>;
}

/** 范围页签：全部 / 收件箱 / 人工待处理是三个不同范围，不是同页 Tab，因此沿用路由链接。 */
function InboxScopeNav() {
  return <nav className="subnav" aria-label="任务范围">
    <Link className="subnav-item" to="/tasks" data-testid="tasks-tab-all">全部</Link>
    <Link className="subnav-item subnav-item--active" to="/tasks?tab=inbox" data-testid="tasks-tab-inbox" aria-current="page">收件箱</Link>
    <Link className="subnav-item" to="/tasks?tab=attention">人工待处理</Link>
  </nav>;
}

function InboxStats({ rows, basis }: { rows: readonly InboxTaskRow[]; basis: string }) {
  const counts = statusCounts(rows);
  return <ul className="inbox-stats" aria-label={`收件箱状态统计（${basis}）`}>
    {statCards.map((card) => <li key={card.status} className="inbox-stat">
      {/* 数字与状态名基线对齐成一行，提示独占下一行：三张卡更紧凑，口径写在 aria-label 里。 */}
      <span className="inbox-stat-figure"><span className="inbox-stat-value">{counts[card.status]}</span><span className="inbox-stat-label">{taskStatusLabels[card.status]}</span></span>
      <span className="inbox-stat-hint">{card.hint}</span>
    </li>)}
  </ul>;
}

/** 行首状态图标：与 StatusChip 同一套图标与语气，只换成卡片行里的色块形态。 */
function InboxRowIcon({ status }: { status: TaskStatus }) {
  const Icon = taskStatusIcons[status];
  return <span className={`inbox-row-icon inbox-row-icon--${taskStatusTone(status)}`} aria-hidden="true"><Icon /></span>;
}

function InboxTaskRow({ task }: { task: InboxTaskRow }) {
  const reason = task.waitingReason ?? task.blockedReason;
  // 待整理的行还没有人工过目，用原型「未读」的浅绿底标出；其余状态保持纸面。
  const untriaged = task.status === "INBOX" ? " inbox-row--untriaged" : "";
  return <Link className={`inbox-row${untriaged}`} to={`/tasks/${task.id}`} data-testid={`task-row-${task.id}`}>
    <InboxRowIcon status={task.status} />
    <span className="inbox-row-main">
      {/* 单行省略的标题挂完整名称：键盘与读屏拿不到悬停文本，需要真实属性承载。 */}
      <span className="inbox-row-title" title={task.title}>{task.title}</span>
      <span className="inbox-row-facts">未归属项目 · {taskStatusLabels[task.status]} · {interactionModeLabels[task.mode]} · {executorLabels[task.executor]} · 任务修订 v{task.revision}</span>
      {reason !== null && <span className="inbox-row-reason">{reason}</span>}
    </span>
    <ChevronRight className="inbox-row-arrow" aria-hidden="true" />
  </Link>;
}

function InboxTaskCard({ count, children }: { count: number; children: ReactNode }) {
  return <section className="inbox-card" aria-label="收件箱任务">
    <div className="inbox-card-head">
      <strong><Inbox aria-hidden="true" />收件箱任务</strong>
      <small>{count} 条</small>
    </div>
    <div className="inbox-card-body">{children}</div>
  </section>;
}

function InboxEmptyState({ hasFilters, onClearFilters, onCreate }: {
  hasFilters: boolean; onClearFilters: () => void; onCreate: () => void }) {
  // 收件箱范围自身的空不等于「筛选无匹配」：范围没变，清除筛选也回不到别的任务。
  if (hasFilters) return <EmptyState size="compact" icon={SearchX} title="当前筛选没有匹配的任务"
    description="清除筛选后可以看到收件箱里的全部任务；筛选只作用于当前范围，不代表没有别的人工事项。"
    testId="inbox-no-match"
    actions={<button className="secondary-button" type="button" onClick={onClearFilters}>清除筛选</button>} />;
  return <EmptyState size="compact" icon={Inbox} title="收件箱里没有任务"
    description="收件箱只收未归属项目的人工任务。把任务挂到项目下，它就不再出现在这里；也可以直接在这里新建一条。"
    testId="inbox-empty"
    actions={<button className="primary-button" type="button" onClick={onCreate}>新建任务</button>} />;
}

/** 当前生效筛选摘要：与任务页同一套 chips 语言，写在页面私有 CSS 里（不抽全局组件）。 */
function InboxFilterSummary({ filters, onClear }: {
  filters: readonly { key: string; label: string; onRemove: () => void }[];
  onClear: () => void;
}) {
  if (filters.length === 0) return null;
  return <div className="active-filters" data-testid="inbox-active-filters">
    <span className="active-filters-label">筛选生效中</span>
    <ul className="active-filters-list" role="list">
      {filters.map((filter) => <li key={filter.key} className="active-filter-chip">
        <span>{filter.label}</span>
        <button className="active-filter-remove" type="button" aria-label={`移除筛选：${filter.label}`} onClick={filter.onRemove}><X aria-hidden="true" /></button>
      </li>)}
    </ul>
    <button className="text-button" type="button" onClick={onClear}>清除筛选</button>
  </div>;
}

/** 范围说明：折叠块收拢「这个范围是什么、统计覆盖到哪」，不占首屏高度。
    统计口径按数据链分句：live 保持原句（每页 50 项 + 加载更多），fixture 说示例行口径。 */
function InboxScopeNote({ mode }: { mode: "fixture" | "live" }) {
  return <details className="page-explanation" data-testid="inbox-scope-note">
    <summary>收件箱范围说明</summary>
    <p>收件箱只包含未归属项目的人工任务：服务端只返回未归属 Project 且由人工执行的事项；把任务挂到项目下，它就不再出现在这里。</p>
    {mode === "live"
      ? <p>统计与列表都只覆盖已加载范围，不代表工作空间全量；本机服务每页最多 50 项，后续页用「加载更多」继续。需要人工判断的事项（开放 Review、未决操作与控制请求）在「人工待处理」。</p>
      : <p>当前是示例数据：统计基于全部示例行，不代表真实工作空间；需要人工判断的事项（开放 Review、未决操作与控制请求）在「人工待处理」，连接本机 API 后查看。</p>}
  </details>;
}

/* ── 示例数据面板 ───────────────────────────────────────────────────────── */

function FixtureInboxBoard() {
  const navigate = useNavigate();
  const [query] = useSearchParams();
  const mode = fixtureModeFromQuery(query);
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
      // 收件箱范围由服务端口径固定：projectId=inbox 与页面上的项目筛选互不影响。
      const listQuery = { projectId: "inbox", status: statusFilter, mode: modeFilter, query: search };
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
  useEffect(() => { void load(); return () => { requestVersion.current++; }; }, [mode, statusFilter, modeFilter, search]);
  const hasFilters = statusFilter !== "all" || modeFilter !== "all" || search !== "";
  const clearFilters = () => { setStatusFilter("all"); setModeFilter("all"); setSearch(""); };
  const openCreate = () => navigate("/tasks?view=create&tab=inbox");
  const openLightweight = () => navigate("/tasks?view=create&light=1&tab=inbox");
  if (loading) return <section className="page-state pv-page" aria-live="polite"><p className="eyebrow">Task Inbox</p><h1>正在读取收件箱任务</h1><p>示例数据正在加载，页面尚未提交任何变更。</p></section>;
  if (error) return <section className="page-state page-state--error pv-page" role="alert"><p className="eyebrow">Task Inbox</p><h1>暂时无法显示收件箱</h1><p>{error}</p><button className="secondary-button" type="button" onClick={() => void load()}><RotateCcw aria-hidden="true" />重新读取</button></section>;
  const rows = tasks.map(fixtureRow);
  // 生效筛选摘要（fixture）：项目筛选停用且不产生生效条件，chips 只列状态、模式与搜索。
  const activeFilters = [
    ...(statusFilter !== "all" ? [{ key: "status", label: `状态：${taskStatusLabels[statusFilter]}`, onRemove: () => setStatusFilter("all") }] : []),
    ...(modeFilter !== "all" ? [{ key: "mode", label: `执行模式：${interactionModeLabels[modeFilter]}`, onRemove: () => setModeFilter("all") }] : []),
    ...(search !== "" ? [{ key: "search", label: `搜索“${search}”`, onRemove: () => setSearch("") }] : [])
  ];
  return <section className="skill-page inbox-page pv-page"><div className="inbox-inner">
    <InboxHead onCreate={openCreate} onCreateLightweight={openLightweight} />
    <InboxScopeNav />
    <InboxStats rows={rows} basis="基于全部示例行" />
    <div className="list-toolbar list-toolbar--compact" data-testid="inbox-toolbar">
      {/* 工具条降噪（UI-PAGE-INBOX-01）：搜索在前、筛选次之；项目筛选保留但停用并在控件旁说明原因。 */}
      <label className="search-field"><Search aria-hidden="true" /><span className="visually-hidden">按任务名称搜索</span><input value={search} onChange={(event) => setSearch(event.target.value)} type="search" name="task-search" placeholder="搜索任务" /></label>
      <label className="filter-field">状态<select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as TaskStatus | "all")} name="task-filter-status"><option value="all">全部</option>{statusOptions.map((status) => <option key={status} value={status}>{taskStatusLabels[status]}</option>)}</select></label>
      <label className="filter-field">执行模式<select value={modeFilter} onChange={(event) => setModeFilter(event.target.value as InteractionMode | "all")} name="task-filter-mode"><option value="all">全部</option>{modeOptions.map((item) => <option key={item} value={item}>{interactionModeLabels[item]}</option>)}</select></label>
      {/* 收件箱范围没有项目维度，筛选框保留但停用：明说「这里不按项目筛」，不留一个能点却无效的控件。 */}
      <label className="filter-field inbox-filter-project">项目<select value={projectFilter} onChange={(event) => setProjectFilter(event.target.value)} name="task-filter-project" disabled title="收件箱不按项目筛选：这里只收未归属项目的人工任务"><option value="all">全部</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.title}</option>)}<option value="inbox">未归属项目</option></select><small className="inbox-filter-project-note">收件箱不按项目筛选：这里只收未归属项目的人工任务。</small></label>
    </div>
    <InboxFilterSummary filters={activeFilters} onClear={clearFilters} />
    {refreshing && <p className="helper-text" role="status" data-testid="tasks-refreshing">正在按当前筛选更新列表，已显示的内容保持可见。</p>}
    <InboxTaskCard count={rows.length}>
      {rows.length === 0
        ? <InboxEmptyState hasFilters={hasFilters} onClearFilters={clearFilters} onCreate={openCreate} />
        : rows.map((task) => <InboxTaskRow key={task.id} task={task} />)}
    </InboxTaskCard>
    <div className="task-list-foot">
      <p className="list-count-note" data-testid="inbox-fixture-count">{hasFilters ? `当前筛选显示 ${rows.length} 项任务。` : `共 ${rows.length} 项任务。`}</p>
      <p className="list-footer-note"><Info aria-hidden="true" />完成依据来自产物、验收与提交。</p>
    </div>
    <InboxScopeNote mode="fixture" />
  </div></section>;
}

/* ── 本机服务面板 ───────────────────────────────────────────────────────── */

function LiveInboxBoard({ client }: { client: RelayApiClient }) {
  const navigate = useNavigate();
  const [items, setItems] = useState<readonly RelayTaskSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<TaskStatus | "all">("all");
  const [modeFilter, setModeFilter] = useState<InteractionMode | "all">("all");
  const [search, setSearch] = useState("");
  const requestVersion = useRef(0);
  const busy = useRef(false);

  async function loadPage(cursor: string | null) {
    if (busy.current) return;
    busy.current = true;
    const request = ++requestVersion.current;
    if (cursor === null) { setItems([]); setNextCursor(null); setLoading(true); } else setLoadingMore(true);
    setError(null);
    try {
      const page = await client.getInboxTasksPage(cursor);
      if (request !== requestVersion.current) return;
      // 收件箱是服务端口径：响应里出现有 Project 或非人工执行的任务就停止显示，不猜数据。
      if (page.items.some((task) => task.projectId !== null || task.mode !== "ME" || task.executor !== "HUMAN"))
        throw new Error("收件箱响应包含非未归属人工任务，已停止显示。");
      setItems((current) => cursor === null ? page.items : [...current, ...page.items]);
      setNextCursor(page.nextCursor);
    } catch (caught) {
      if (request === requestVersion.current) {
        setItems([]); setNextCursor(null);
        setError(describeLiveError(caught).message);
      }
    } finally {
      if (request === requestVersion.current) { busy.current = false; setLoading(false); setLoadingMore(false); }
    }
  }
  useEffect(() => { void loadPage(null); return () => { requestVersion.current++; }; }, [client]);

  const needle = search.trim().toLocaleLowerCase();
  const rows = items.map(liveRow);
  const visible = rows.filter((task) =>
    (statusFilter === "all" || task.status === statusFilter) &&
    (modeFilter === "all" || task.mode === modeFilter) &&
    (!needle || task.title.toLocaleLowerCase().includes(needle)));
  const hasFilters = statusFilter !== "all" || modeFilter !== "all" || needle !== "";
  const clearFilters = () => { setStatusFilter("all"); setModeFilter("all"); setSearch(""); };
  // 生效筛选摘要（live）：搜索按已去空白的关键词展示，与实际过滤口径一致。
  const activeFilters = [
    ...(statusFilter !== "all" ? [{ key: "status", label: `状态：${taskStatusLabels[statusFilter]}`, onRemove: () => setStatusFilter("all") }] : []),
    ...(modeFilter !== "all" ? [{ key: "mode", label: `执行模式：${interactionModeLabels[modeFilter]}`, onRemove: () => setModeFilter("all") }] : []),
    ...(needle !== "" ? [{ key: "search", label: `搜索“${needle}”`, onRemove: () => setSearch("") }] : [])
  ];
  const openCreate = () => navigate("/tasks?view=create&tab=inbox");
  const openLightweight = () => navigate("/tasks?view=create&light=1&tab=inbox");
  return <section className="skill-page inbox-page pv-page" data-testid="tasks-live-inbox"><div className="inbox-inner">
    <InboxHead onCreate={openCreate} onCreateLightweight={openLightweight} />
    <InboxScopeNav />
    <InboxStats rows={visible} basis="基于当前筛选可见行" />
    <div className="list-toolbar list-toolbar--compact" data-testid="inbox-toolbar">
      {/* 工具条降噪（UI-PAGE-INBOX-01）：搜索在前、筛选次之、刷新独立在末尾。 */}
      <label className="search-field"><Search aria-hidden="true" /><span className="visually-hidden">在已加载任务中按名称搜索</span><input value={search} onChange={(event) => setSearch(event.target.value)} type="search" name="task-search" placeholder="搜索已加载任务" /></label>
      <label className="filter-field">状态<select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as TaskStatus | "all")} name="task-filter-status"><option value="all">全部</option>{statusOptions.map((status) => <option key={status} value={status}>{taskStatusLabels[status]}</option>)}</select></label>
      <label className="filter-field">执行模式<select value={modeFilter} onChange={(event) => setModeFilter(event.target.value as InteractionMode | "all")} name="task-filter-mode"><option value="all">全部</option>{modeOptions.map((item) => <option key={item} value={item}>{interactionModeLabels[item]}</option>)}</select></label>
      <button className="secondary-button" type="button" data-testid="inbox-refresh" disabled={loading || loadingMore} onClick={() => void loadPage(null)}><RotateCcw aria-hidden="true" />刷新收件箱</button>
    </div>
    <InboxFilterSummary filters={activeFilters} onClear={clearFilters} />
    {loading ? <div className="page-state" aria-live="polite"><p>正在从本机服务读取收件箱任务…</p></div> :
      error ? <div className="page-state page-state--error" role="alert"><p>{error}</p><button className="secondary-button" type="button" onClick={() => void loadPage(null)}><RotateCcw aria-hidden="true" />重新读取</button></div> : <>
        <InboxTaskCard count={visible.length}>
          {visible.length === 0
            ? items.length === 0
              // 收件箱是「未归属项目的人工任务」这一范围，它的空与筛选无匹配不是同一件事。
              ? <InboxEmptyState hasFilters={false} onClearFilters={clearFilters} onCreate={openCreate} />
              : <EmptyState size="compact" icon={SearchX} title="已加载任务里没有匹配项"
                description={`已加载 ${items.length} 项，当前筛选显示 0 项。状态、模式与标题筛选只作用于已加载范围，后续页可能仍有匹配任务。`}
                testId="inbox-live-no-match"
                actions={hasFilters ? <button className="secondary-button" type="button" onClick={clearFilters}>清除筛选</button> : undefined} />
            : visible.map((task) => <InboxTaskRow key={task.id} task={task} />)}
        </InboxTaskCard>
        <div className="inbox-card-foot">
          <p className="list-count-note" data-testid="inbox-count">已加载 {items.length} 项 · 当前筛选显示 {visible.length} 项{nextCursor ? " · 仍有后续页" : " · 已到列表末页"}。筛选只作用于已加载任务。</p>
          {nextCursor && <button className="secondary-button" type="button" data-testid="inbox-load-more" disabled={loadingMore} onClick={() => void loadPage(nextCursor)}>{loadingMore ? "正在加载" : "加载更多"}</button>}
        </div>
      </>}
    <p className="list-footer-note"><Info aria-hidden="true" />完成依据来自产物、验收与提交。</p>
    <InboxScopeNote mode="live" />
  </div></section>;
}

/**
 * 收件箱页（/tasks?tab=inbox，/inbox 别名）。
 *
 * 页面语义未变：只收未归属项目的人工任务，live 模式按服务端 `GET /tasks?inbox=true`
 * 分页读取，fixture 模式读同一范围的示例数据。UI-PAGE-INBOX-01（2026-11-11）在既有
 * board 结构上收紧呈现层：工具条「搜索 → 筛选 → 刷新」、fixture 停用的项目筛选旁说明
 * 原因、统计卡数字与状态名同行并标注口径（fixture 全部示例行 / live 当前筛选可见行）、
 * 生效筛选 chips 摘要、行标题挂完整名称；数据来源、筛选口径、守卫与测试锚点不变。
 */
export default function InboxView({ client }: { client: RelayApiClient | null }) {
  return client ? <LiveInboxBoard client={client} /> : <FixtureInboxBoard />;
}
