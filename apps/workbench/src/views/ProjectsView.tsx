import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Archive, ArrowRight, Check, Folder, FolderPlus, Info, LayoutGrid, List,
  MoreHorizontal, Package, Plus, RotateCcw, Search, Sparkles, Target, TriangleAlert } from "lucide-react";
import { createCommandId, projectArchiveResultFrom, RelayApiError, RelayTransportError,
  type RelayApiClient, type RelayCommandEnvelope,
  type RelayProjectArchiveResult, type RelayProjectListItem } from "../api/relayClient";
import AppDialog from "../components/AppDialog";
import { escalateFeedback, openUndoFeedback } from "../components/Feedback";
import EmptyState from "../components/EmptyState";
import PageHeader from "../components/PageHeader";
import CreateGoalView from "./CreateGoalView";
import CreateProjectView from "./CreateProjectView";
import { fixtureAdapter } from "../fixtures/fixtureAdapter";
import { fixtureModeFromQuery } from "../lib/fixtureMode";
import { formatReadableDateTime, useDisplayPreferences } from "../lib/displayPreferences";
import { phaseLabel, projectTypeLabels } from "../lib/labels";
import { describeLiveError } from "../lib/liveErrors";
import { takeCreationFlash } from "../lib/navigationFlash";
import { useRelayConnection } from "../lib/relayConnection";
import type { DecimalRevision, ProjectSummary, ProjectType } from "../types";
import "./ProjectsView.css";

function message(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message.trim() : fallback;
}

/**
 * 读取失败是否意味着「这些数据已经不能再展示」。
 *
 * 临时故障（503、传输失败）只是没读到下一页，已读的前页仍然是有效事实；
 * 失权或作用域失效（403、404、RESOURCE_NOT_FOUND）则说明前页也不再属于当前作用域，
 * 这种失败不能按「保留前页」处理，否则等于把已失权的数据留在屏幕上（禅道 #110 验收口径）。
 */
function isScopeLost(caught: unknown): boolean {
  if (!(caught instanceof RelayApiError)) return false;
  const { status, code } = caught.problem;
  return status === 403 || status === 404 || code === "RESOURCE_NOT_FOUND";
}

// 全局控件规则会给所有文本输入统一底色与边框；搜索框的外观由外层 .search-field 提供，
// 这里在行内归零内层输入，避免出现双层边框与高度溢出（共享层修复前先由页面自行约束）。
const searchInputStyle = { appearance: "none", background: "transparent", border: "none",
  padding: 0, minHeight: 0 } as const;

/**
 * 项目列表的三个范围。页签是路由链接（沿用既有 `aria-current`），
 * 不用 `role=tablist`——设计系统 §6 规定「路由用链接，同页 Tab 才用 tablist」。
 *
 * 默认范围是「全部项目」，对齐本次原型首屏：`/projects` 不带参数即全部，
 * 进行中与已归档各自显式带 `?scope=`。live 模式一次只加载一个范围，
 * 因此页签计数只显示已加载的那个范围，其余不造数。
 */
type ProjectScope = "all" | "active" | "archived";

const scopeTabs: readonly { scope: ProjectScope; label: string; testId: string; to: string }[] = [
  { scope: "all", label: "全部项目", testId: "projects-tab-all", to: "/projects" },
  { scope: "active", label: "进行中", testId: "projects-tab-active", to: "/projects?scope=active" },
  { scope: "archived", label: "已归档", testId: "projects-tab-archived", to: "/projects?scope=archived" }
];

/** 历史深链接 `?archived=1` 继续可用；未给范围时落在「全部项目」。 */
function scopeFromQuery(query: URLSearchParams): ProjectScope {
  const scope = query.get("scope");
  if (scope === "all" || scope === "active" || scope === "archived") return scope;
  return query.get("archived") === "1" ? "archived" : "all";
}

function scopeLabel(scope: ProjectScope): string {
  return scope === "all" ? "全部" : scope === "archived" ? "已归档" : "进行中";
}

interface PendingArchive {
  readonly commandId: string;
  readonly projectId: string;
  readonly expectedRevision: string;
}
const archiveBlockerLabels: Readonly<Record<string, string>> = {
  TASK_ACTIVE: "仍有进行中的任务；先处理任务的完成、取消或交接状态。",
  RUN_UNSETTLED: "仍有未结清的运行；先核对运行的停止或完成结果。",
  GATEWAY_UNSETTLED: "仍有未结清的外部动作；先核对原动作与调用结果。",
  UNKNOWN_EFFECT: "存在结果不明的外部效果；按原动作身份核对，不能盲重试。",
  RESOURCE_CLAIM_UNSETTLED: "资源占用尚未结清；核对实际进程和资源，租约过期不等于安全释放。",
  IMPORT_IN_FLIGHT: "资料导入仍在途；先核对导入 Job 的终态。",
  ASSIST_IN_FLIGHT: "Assist 生成仍在途；先核对生成或取消结果。",
  MODEL_CALL_STARTED: "模型调用已开始且未结清；先核对原调用结果。",
  REVIEW_OPEN: "仍有待审事项；先作出明确的人工判断。"
};
function archiveKey(client: RelayApiClient): string {
  return `relay:archive-project:${client.baseUrl}:${client.workspaceId}`;
}
function readPendingArchive(key: string): PendingArchive | null {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(key) ?? "null");
    if (!value || typeof value !== "object") return null;
    const row = value as Record<string, unknown>;
    if (typeof row.commandId !== "string" || typeof row.projectId !== "string" ||
      typeof row.expectedRevision !== "string" ||
      !/^(0|[1-9][0-9]*)$/u.test(row.expectedRevision)) return null;
    return { commandId: row.commandId, projectId: row.projectId,
      expectedRevision: row.expectedRevision };
  } catch { return null; }
}
function savePendingArchive(key: string, pending: PendingArchive | null): boolean {
  try {
    if (pending) sessionStorage.setItem(key, JSON.stringify(pending));
    else sessionStorage.removeItem(key);
    return true;
  } catch { return false; }
}
function confirmedArchive(envelope: RelayCommandEnvelope, pending: PendingArchive,
  receipt = false): RelayProjectArchiveResult {
  if (envelope.commandId !== pending.commandId || receipt &&
    (!("commandType" in envelope) || envelope.commandType !== "ArchiveProject")) {
    throw new RelayTransportError("归档回执的命令身份不匹配，请保留原命令继续核对。");
  }
  let result: RelayProjectArchiveResult;
  try { result = projectArchiveResultFrom(envelope.result); }
  catch { throw new RelayTransportError("归档回执内容无法核对，请保留原命令继续查询。"); }
  if (result.projectId !== pending.projectId ||
    BigInt(result.revision) <= BigInt(pending.expectedRevision)) {
    throw new RelayTransportError("归档回执的 Project 或修订与原命令不匹配，请保留原命令继续核对。");
  }
  return result;
}

/* ── 共享呈现层 ─────────────────────────────────────────────────────────── */

interface ProjectCardModel {
  readonly id: string;
  readonly title: string;
  readonly typeLabel: string;
  readonly phase: string;
  readonly nextAction: string | null;
  readonly archived: boolean;
}

/**
 * 摘要计数的覆盖范围。
 *
 * - full：已经读完全部页，可以给全量结论；
 * - partial：只读到一部分（例如还有后续页，或续页失败），只能说「已加载范围内」；
 * - unknown：连首屏都没读到，数量与「是否都已明确」都是未知，不给任何数量结论。
 */
type SummaryCoverage = "full" | "partial" | "unknown";

/**
 * 推进摘要条：正在推进数 + 尚未明确下一步数。
 * 计数口径随数据来源不同——fixture 为全量精确值，live 只覆盖已加载项，
 * 后者由 `coverage` 与 `note` 显式限定，不把部分计数冒充全量
 * （禅道 #110：续页 503 清空列表后曾误报「0 个项目正在推进」「所有项目的下一步都已明确」）。
 */
function ProjectsSummary({ activeCount, missingCount, coverage = "full", note, onFix }: {
  readonly activeCount: number;
  readonly missingCount: number;
  readonly coverage?: SummaryCoverage;
  readonly note?: string | null;
  readonly onFix?: () => void;
}) {
  const partial = coverage === "partial";
  const unknown = coverage === "unknown";
  const main = unknown ? "项目列表尚未确认"
    : partial ? `已加载范围内 ${activeCount} 个项目正在推进`
    : `${activeCount} 个项目正在推进`;
  return <section className="projects-summary" data-testid="projects-summary" aria-label="推进摘要">
    <div className="projects-summary__left">
      <span className="projects-summary__symbol" aria-hidden="true"><Sparkles /></span>
      <div className="projects-summary__text">
        <p className="projects-summary__main">{main}</p>
        <p className="projects-summary__desc">{note ?? (unknown
          ? "尚未读到项目列表，数量与下一步状态都还不能确认。"
          : "聚焦下一步，把计划变成可执行的行动。")}</p>
      </div>
    </div>
    <div className="projects-summary__right">
      {unknown
        ? <><TriangleAlert className="projects-summary__alert" aria-hidden="true" />
          <span className="projects-summary__hint">尚未读到项目列表，不能断定下一步是否都已明确</span></>
        : missingCount > 0
          ? <><TriangleAlert className="projects-summary__alert" aria-hidden="true" />
            <span className="projects-summary__hint">{partial ? `已加载范围内 ${missingCount} 个项目尚未明确下一步` : `${missingCount} 个项目尚未明确下一步`}</span>
            {onFix && <button className="projects-summary__link" type="button" data-testid="projects-summary-fix" onClick={onFix}>去完善 <span aria-hidden="true">→</span></button>}</>
          : partial
            ? <><Info aria-hidden="true" />
              <span className="projects-summary__hint">已加载范围内没有尚未明确下一步的项目，后续页尚未读完</span></>
            : <><Check className="projects-summary__ok" aria-hidden="true" />
              <span className="projects-summary__hint">所有项目的下一步都已明确</span></>}
    </div>
  </section>;
}

function ProjectsToolbar({ scope, counts, search, onSearch, view, onView, searchName, tools }: {
  readonly scope: ProjectScope;
  readonly counts: Readonly<Record<ProjectScope, number | null>>;
  readonly search: string;
  readonly onSearch: (value: string) => void;
  readonly view: "grid" | "list";
  readonly onView: (view: "grid" | "list") => void;
  /** 示例与 live 各自沿用历史字段名，避免深链接与既有测试口径被无关改名打断。 */
  readonly searchName: string;
  readonly tools?: ReactNode;
}) {
  return <div className="projects-toolbar">
    <nav className="subnav" aria-label="项目范围">
      {scopeTabs.map((tab) => {
        const count = counts[tab.scope];
        return <Link key={tab.scope} className={`subnav-item${scope === tab.scope ? " subnav-item--active" : ""}`}
          to={tab.to} data-testid={tab.testId} aria-current={scope === tab.scope ? "page" : undefined}>
          {tab.label}{count === null ? null : <> <span className="subnav-count">({count})</span></>}
        </Link>;
      })}
    </nav>
    <div className="projects-tools">
      {tools}
      <label className="search-field"><Search aria-hidden="true" />
        <span className="visually-hidden">按项目名称搜索</span>
        <input value={search} onChange={(event) => onSearch(event.target.value)} type="search"
          name={searchName} placeholder="搜索项目名称…" style={searchInputStyle} /></label>
      <div className="projects-view-toggle" role="group" aria-label="项目显示方式">
        <button className={`projects-view-toggle__btn${view === "grid" ? " is-active" : ""}`} type="button"
          aria-pressed={view === "grid"} data-testid="projects-view-grid" title="网格视图" onClick={() => onView("grid")}><LayoutGrid aria-hidden="true" /></button>
        <button className={`projects-view-toggle__btn${view === "list" ? " is-active" : ""}`} type="button"
          aria-pressed={view === "list"} data-testid="projects-view-list" title="列表视图" onClick={() => onView("list")}><List aria-hidden="true" /></button>
      </div>
    </div>
  </div>;
}

/**
 * V5.28 复刻卡：图标块 + 状态点 + 标题 + 说明 + 事实行 + 底部双钮。
 * 数据仍来自真实接口：说明行展示类型/阶段，事实行展示下一步与待审数；
 * 原型里的「N 个任务/N 个成果文件」在列表接口没有对应事实，不造假数据。
 */
function ProjectCard({ project, onOpen, onNavigate }: {
  readonly project: ProjectCardModel; readonly onOpen: () => void; readonly onNavigate: () => void;
}) {
  const unset = project.nextAction === null;
  return <article className={`pv-pcard${project.archived ? " pv-pcard--archived" : ""}`}
    data-testid={`project-row-${project.id}`} onClick={onNavigate}>
    <div className="pv-pcard__top">
      <span className="pv-illustration" aria-hidden="true"><Folder aria-hidden="true" /></span>
      <span className={`pv-pcard__status${project.archived ? " is-archived" : ""}`}>
        <span className="pv-pcard__status-dot" aria-hidden="true" />{project.archived ? "已归档" : project.phase}</span>
      <button className="pv-pcard__control" type="button" data-testid={`project-card-more-${project.id}`}
        aria-label={`查看「${project.title}」的详情与操作`}
        onClick={(event) => { event.stopPropagation(); onOpen(); }}><MoreHorizontal aria-hidden="true" /></button>
    </div>
    <h3 className="pv-pcard__name">
      <button className="pv-pcard__name-button" type="button"
        data-testid={`project-card-open-${project.id}`} onClick={onNavigate}>{project.title}</button>
    </h3>
    <p className="pv-pcard__caption">{project.typeLabel}项目</p>
    <div className="pv-pcard__metrics">
      <span className={unset ? "is-unset" : undefined}>下一步：{unset ? "尚未明确" : project.nextAction}</span>
    </div>
    <div className="pv-pcard__footer">
      <button className="pv-pcard__ghost" type="button"
        onClick={(event) => { event.stopPropagation(); onOpen(); }}>项目详情 →</button>
      <button className="secondary-button" type="button"
        onClick={(event) => { event.stopPropagation(); onNavigate(); }}>进入项目</button>
    </div>
  </article>;
}

function NewProjectCard({ onCreate }: { readonly onCreate: () => void }) {
  return <button className="project-card project-card--new" type="button" data-testid="projects-new-card" onClick={onCreate}>
    <span className="project-card__new-icon" aria-hidden="true"><Plus aria-hidden="true" /></span>
    <span className="project-card__new-title">开启一个新项目</span>
    <span className="project-card__new-desc">为下一个想法建立专属空间，从目标开始逐步推进。</span>
    <span className="project-card__new-action"><Plus aria-hidden="true" />新建项目</span>
  </button>;
}

/** 网格与列表共用同一份卡片标记，只有容器类决定单列还是多列（对齐原型）。 */
function ProjectsGrid({ view, children }: { readonly view: "grid" | "list"; readonly children: ReactNode }) {
  return <div className={`projects-grid${view === "list" ? " is-list" : ""}`}>{children}</div>;
}

/** 项目详情抽屉：宽屏不再常驻右栏，统一由「查看项目」打开。 */
function ProjectDetailDialog({ open, onClose, children }: {
  readonly open: boolean; readonly onClose: () => void; readonly children: ReactNode;
}) {
  return <AppDialog open={open} title="项目详情" variant="drawer" onClose={onClose}>{children}</AppDialog>;
}

function DetailRows({ rows }: { readonly rows: readonly { label: string; value: ReactNode }[] }) {
  return <dl className="projects-detail__rows">
    {rows.map((row) => <div className="projects-detail__row" key={row.label}>
      <dt>{row.label}</dt><dd>{row.value}</dd></div>)}
  </dl>;
}

/* ── 页面 ───────────────────────────────────────────────────────────────── */

export default function ProjectsView() {
  const navigate = useNavigate();
  const [query] = useSearchParams();
  const mode = fixtureModeFromQuery(query);
  const creating = query.get("view") === "create";
  // Goal 是 Workspace 级事实，轻量入口独立于「新建项目」表单：不用先建项目再重复抄目标。
  const goalView = query.get("view") === "goal";
  const scope = scopeFromQuery(query);
  const connection = useRelayConnection();
  const live = connection.mode === "live";
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [view, setView] = useState<"grid" | "list">("grid");
  const [receipt, setReceipt] = useState<string | null>(null);
  const [importStatus, setImportStatus] = useState<"none" | "SUCCEEDED" | "FAILED">("none");
  const [actionError, setActionError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const requestVersion = useRef(0);
  const hasLoaded = useRef(false);
  const disposed = useRef(false);

  async function load() {
    const request = ++requestVersion.current;
    if (hasLoaded.current) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const response = await fixtureAdapter.listProjects(mode);
      if (disposed.current || request !== requestVersion.current) return;
      setProjects(response);
      hasLoaded.current = true;
      const flash = takeCreationFlash();
      if (flash) {
        setReceipt(flash.receipt);
        setImportStatus(flash.importStatus);
      }
    } catch (caught) {
      if (!disposed.current && request === requestVersion.current) setError(message(caught, "读取示例项目时发生未知错误。"));
    } finally {
      if (!disposed.current && request === requestVersion.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }

  useEffect(() => {
    disposed.current = false;
    if (!live) void load();
    return () => { disposed.current = true; requestVersion.current++; };
  }, [mode, live]);

  const activeProjects = projects.filter((project) => !project.archived);
  const archivedProjects = projects.filter((project) => project.archived);
  const scopedProjects = scope === "all" ? projects : scope === "active" ? activeProjects : archivedProjects;
  const needle = search.trim().toLowerCase();
  const visibleProjects = scopedProjects.filter((project) => !needle || project.title.toLowerCase().includes(needle));
  const selected = projects.find((project) => project.id === detailId) ?? null;
  const missingNext = activeProjects.filter((project) => project.nextAction === null);

  function openDetail(projectId: string) {
    setDetailId(projectId);
    setReceipt(null);
    setImportStatus("none");
    setActionError(null);
  }
  function closeDetail() { setDetailId(null); }
  function openFirstMissing() {
    const target = missingNext[0];
    if (target) openDetail(target.id);
  }

  async function archiveSelected() {
    if (!selected || submitting || selected.archiveBlockedReason) return;
    const request = ++requestVersion.current;
    setSubmitting(true);
    setActionError(null);
    setReceipt(null);
    try {
      const result = await fixtureAdapter.archiveProject(selected.id, mode);
      if (disposed.current || request !== requestVersion.current) return;
      setDetailId(null);
      await load();
      if (!disposed.current) setReceipt(result.description);
    } catch (caught) {
      if (!disposed.current) setActionError(message(caught, "归档示例项目时发生未知错误。"));
    } finally {
      if (!disposed.current) setSubmitting(false);
    }
  }

  if (goalView) return live && connection.client
    ? <CreateGoalView client={connection.client} onCancel={() => navigate("/projects")} />
    // 示例模式没有真实 Goal：如实说明，不生成假目标冒充已保存事实。
    : <section className="page-state" data-testid="goal-fixture-gap"><p className="eyebrow">目标</p>
      <h1>示例模式不能保存目标</h1><p>Goal 是工作空间级事实，需要连接本机 API 才能创建。示例模式不生成目标、任务或执行记录。</p></section>;

  if (creating) return <section className="skill-page"><CreateProjectView onCancel={() => navigate("/projects")} /></section>;

  if (live && connection.client) return <LiveProjectsListView
    key={`${connection.epoch}:${scope}`} client={connection.client} scope={scope}
    onCreate={() => navigate("/projects?view=create")} />;

  if (loading) return <section className="page-state pv-page" aria-live="polite"><p className="eyebrow">Projects</p><h1>正在读取项目列表</h1><p>数据正在加载，页面尚未提交任何变更。</p></section>;
  if (error) return <section className="page-state page-state--error pv-page" role="alert"><p className="eyebrow">Projects</p><h1>暂时无法显示项目</h1><p>{error}</p><button className="secondary-button" type="button" onClick={() => void load()}><RotateCcw aria-hidden="true" />重新读取</button></section>;

  const counts: Record<ProjectScope, number | null> = {
    all: projects.length, active: activeProjects.length, archived: archivedProjects.length };

  return <section className="skill-page projects-page pv-page">
    <div className="projects-inner">
      <PageHeader title="项目" testId="projects-page-head" overline="Projects"
        lede="长期工作以项目为上下文，关联会话、任务、目标和成果。"
        actions={<><Link className="secondary-button" data-testid="goal-list-open" to="/goals"><Target aria-hidden="true" />目标列表</Link>
          <Link className="secondary-button" data-testid="goal-create-open" to="/projects?view=goal"><Target aria-hidden="true" />记录目标</Link>
          <button className="primary-button" type="button" data-testid="project-create-open" onClick={() => navigate("/projects?view=create")}><Plus aria-hidden="true" />新建项目</button></>} />
      <ProjectsSummary activeCount={activeProjects.length} missingCount={missingNext.length}
        onFix={missingNext.length > 0 ? openFirstMissing : undefined} />
      <ProjectsToolbar scope={scope} counts={counts} search={search} onSearch={setSearch} view={view} onView={setView}
        searchName="project-search" />
      {refreshing && <p className="helper-text" role="status">正在更新项目列表，已显示的内容保持可见。</p>}
      {receipt && <p className="receipt-message" role="status">{receipt}</p>}
      {importStatus !== "none" && <p className="helper-text" data-testid="project-import-status"><Info aria-hidden="true" />初始资料导入：{importStatus === "SUCCEEDED" ? "已完成登记，导入成功不代表内容已经验证。" : "失败，项目仍然保留，可稍后重新导入。"}</p>}
      {actionError && <p className="action-error" role="alert">{actionError}</p>}
      {visibleProjects.length === 0
        ? search.trim()
          ? <EmptyState size="compact" title={`当前范围没有匹配“${search.trim()}”的项目`}
            description="示例数据的名称搜索只作用于已加载范围；清除搜索可回到完整列表。"
            testId="projects-fixture-no-match"
            actions={<button className="secondary-button" type="button" onClick={() => setSearch("")}>清除搜索</button>} />
          : scope === "archived"
            ? <EmptyState size="compact" icon={Package} title="还没有已归档的项目"
              description="归档只改变项目状态并保留历史事实；没有项目归档过时，这个范围就是空的。"
              testId="projects-archived-empty"
              actions={<Link className="secondary-button" to="/projects">回到进行中</Link>} />
            : <EmptyState icon={FolderPlus} as="h2" title="还没有进行中的项目"
              description="项目是长期目标的容器：当前阶段、下一步、任务和产物版本都记在它下面。示例模式可以浏览布局，创建前需先连接本机 API。"
              testId="projects-empty"
              actions={<button className="primary-button" type="button" onClick={() => navigate("/projects?view=create")}>新建项目</button>} />
        : <>
          <ProjectsGrid view={view}>
            {visibleProjects.map((project) => <ProjectCard key={project.id} onOpen={() => openDetail(project.id)}
              onNavigate={() => navigate(`/projects/${project.id}`)}
              project={{ id: project.id, title: project.title, typeLabel: projectTypeLabels[project.projectType],
                phase: phaseLabel(project.phase), nextAction: project.nextAction, archived: project.archived }} />)}
            {!search.trim() && scope !== "archived" &&
              <NewProjectCard onCreate={() => navigate("/projects?view=create")} />}
          </ProjectsGrid>
          <p className="projects-note"><Check aria-hidden="true" />已加载 {visibleProjects.length} 个项目 · 点卡片进入项目，点「⋯」查看详情与归档</p>
        </>}
      <details className="page-explanation"><summary>列表范围与状态来源</summary>
        <p className="helper-text">下一步来自项目状态；项目阶段由你显式设置，系统不按任务完成数量自动跳阶段。归档只改变项目状态并保留历史，不会删除任务、产物或验收记录。</p></details>
    </div>
    <ProjectDetailDialog open={selected !== null} onClose={closeDetail}>
      {selected && <FixtureDetail project={selected} submitting={submitting} onArchive={() => void archiveSelected()} />}
    </ProjectDetailDialog>
  </section>;
}

/** 示例模式的项目详情：只读事实 + 归档入口，不制造示例模式没有的能力。 */
function FixtureDetail({ project, submitting, onArchive }: {
  readonly project: ProjectSummary; readonly submitting: boolean; readonly onArchive: () => void;
}) {
  return <div className="projects-detail">
    <p className={`projects-detail__status${project.archived ? " is-archived" : ""}`}>
      {project.archived ? "已归档的项目" : "进行中的项目"}</p>
    <h2 className="projects-detail__title">{project.title}</h2>
    <p className="projects-detail__desc">{project.summary}</p>
    <div className="projects-detail__actions">
      {!project.archived
        ? <Link className="primary-button" data-testid="project-open" to={`/projects/${project.id}`}>打开项目<ArrowRight aria-hidden="true" /></Link>
        : <button className="primary-button" type="button" disabled>打开项目</button>}
    </div>
    {project.archived && <p className="disabled-reason" data-testid="project-archived-reason"><Info aria-hidden="true" />已归档项目在本轮交互预览中只读；恢复入口尚未接入。</p>}
    <div className="projects-detail__divider" />
    <h3 className="projects-detail__heading">项目概况</h3>
    <DetailRows rows={[
      { label: "项目类型", value: projectTypeLabels[project.projectType] },
      { label: "当前阶段", value: phaseLabel(project.phase) }
    ]} />
    <p className="helper-text">状态修订 v{project.stateRevision} · 待审 {project.pendingReviewCount} 项</p>
    <div className="projects-detail__divider" />
    <h3 className="projects-detail__heading">项目目标</h3>
    <p className="projects-detail__text">{project.goal}</p>
    {!project.archived && <>
      <div className="projects-detail__divider" />
      <button className="secondary-button secondary-button--wide" type="button" data-testid="project-archive"
        disabled={submitting || Boolean(project.archiveBlockedReason)} onClick={onArchive}>
        <Archive aria-hidden="true" />{submitting ? "正在归档" : "归档项目"}</button>
      {project.archiveBlockedReason
        ? <p className="disabled-reason" data-testid="project-archive-reason"><Info aria-hidden="true" />{project.archiveBlockedReason}</p>
        : <p className="helper-text">归档只改变项目状态并保留历史；不会删除任务、产物或验收记录。</p>}
    </>}
  </div>;
}

/* ── live 列表 ──────────────────────────────────────────────────────────── */

function LiveProjectsListView({ client, scope, onCreate }: {
  client: RelayApiClient; scope: ProjectScope; onCreate: () => void }) {
  const navigate = useNavigate();
  const [items, setItems] = useState<readonly RelayProjectListItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [knownId, setKnownId] = useState("");
  const [view, setView] = useState<"grid" | "list">("grid");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 续页失败单独成态：首屏错误走全页错误态，续页错误只就地提示，已读内容保留（禅道 #110）。 */
  const [moreError, setMoreError] = useState<string | null>(null);
  const [checkingArchive, setCheckingArchive] = useState(false);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [pendingArchive, setPendingArchive] = useState<PendingArchive | null>(() => readPendingArchive(archiveKey(client)));
  const [mayRetryArchive, setMayRetryArchive] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [archiveBlockers, setArchiveBlockers] = useState<readonly string[]>([]);
  const [archiveSuccess, setArchiveSuccess] = useState<{ id: string; archivedAt: string } | null>(null);
  const requestVersion = useRef(0);
  const busy = useRef(false);
  const archiveFlight = useRef(false);
  const disposed = useRef(false);
  // 详情抽屉在刷新期间保留最后一次可读事实：列表重读会短暂清空 items，
  // 只按 id 查会让抽屉闪一下；这里存最近一次读到的对象，数据回来后按 id 覆盖。
  const detailSnapshot = useRef<RelayProjectListItem | null>(null);
  const pendingStorageKey = archiveKey(client);
  // 归档时间用本设备显示时区渲染；原始 ISO 串仍放在 time.dateTime 里保留机器可读凭据。
  const { timeZone } = useDisplayPreferences();
  const archivedScope = scope === "archived";

  async function loadPage(cursor: string | null, force = false) {
    if (busy.current && !force) return;
    busy.current = true;
    const request = ++requestVersion.current;
    if (cursor === null) {
      // 重新读取列表时下一步标题缓存一并失效，避免继续显示过期标题。
      // 详情抽屉不在这里强制关闭：普通刷新保留已知内容（设计系统「组件状态补充」），
      // 抽屉内容在数据回来后按 id 重新对齐；确实已不在范围内才在下方收口。
      invalidateTaskTitles();
      setItems([]); setNextCursor(null); setLoading(true);
      setMoreError(null);
    } else {
      setLoadingMore(true);
      // 续页重试沿用同一个游标；重试前先撤掉上一轮的续页失败提示。
      setMoreError(null);
    }
    setError(null);
    try {
      const page = await client.getProjectsPage(scope, cursor);
      if (disposed.current || request !== requestVersion.current) return;
      // 归档范围必须与请求一致；「全部」范围同时允许两种状态，因此只在单范围时校验。
      const expected = scope === "all" ? null : archivedScope ? "ARCHIVED" : "ACTIVE";
      if (expected !== null &&
        page.items.some((project) => project.archiveStatus !== expected)) {
        throw new Error("项目列表响应与当前归档范围不匹配，已停止显示。");
      }
      // 续页按分页语义追加：同一条项目只保留一份，重试成功不会重复已读行。
      setItems((current) => cursor === null ? page.items
        : [...current, ...page.items.filter((item) => !current.some((seen) => seen.id === item.id))]);
      setNextCursor(page.nextCursor);
      // 只有在列表已到末页时才能断言「这个项目不在了」；仍有后续页时保持抽屉不动。
      if (cursor === null && page.nextCursor === null) {
        setDetailId((current) => current !== null &&
          !page.items.some((project) => project.id === current) ? null : current);
      }
    } catch (caught) {
      if (!disposed.current && request === requestVersion.current) {
        const described = describeLiveError(caught);
        if (cursor === null) {
          // 首读失败：整页错误态。此时没有任何已确认事实，不能拿空列表当全量 0。
          setItems([]); setNextCursor(null); setDetailId(null);
          setError(described.message);
        } else if (isScopeLost(caught)) {
          // 失权或作用域失效：已读内容已经不可再读，不能为了留住前页而继续展示它。
          setItems([]); setNextCursor(null); setDetailId(null);
          setError("项目列表当前不可读：权限或作用域已失效，已清除之前读到的项目。请核对当前工作空间与访问权限后重新读取。");
        } else {
          // 续页失败保留已读项目、原游标与当前详情，只就地提示并允许按同一游标重试
          // （对齐 ActivityView 的续页恢复口径；禅道 #110）。
          setMoreError(described.message);
        }
      }
    } finally {
      if (!disposed.current && request === requestVersion.current) {
        busy.current = false; setLoading(false); setLoadingMore(false);
      }
    }
  }
  useEffect(() => {
    disposed.current = false;
    void loadPage(null);
    return () => { disposed.current = true; requestVersion.current++; };
  }, [client, scope]);

  useEffect(() => {
    if (detailId === null) { detailSnapshot.current = null; return; }
    const found = items.find((project) => project.id === detailId);
    if (found) detailSnapshot.current = found;
  }, [items, detailId]);

  async function prepareArchive(project: RelayProjectListItem) {
    if (archivedScope || loading || loadingMore || error || checkingArchive || archiveBusy || pendingArchive ||
      project.archiveStatus !== "ACTIVE" || project.archivedAt !== null) return;
    setCheckingArchive(true); setArchiveError(null); setArchiveBlockers([]); setArchiveSuccess(null);
    try {
      const current = await client.getProject(project.id);
      if (disposed.current) return;
      if (current.id !== project.id) throw new Error("Project 单读与所选项目不匹配。");
      if (current.archivedAt !== null) {
        setArchiveError("该项目已归档，已重新读取列表；可在“已归档”范围打开历史事实。");
        void loadPage(null, true); return;
      }
      // 撤销条替代确认框（工作台 §13.2）：单击即发，8 秒反悔窗口在提交之后。
      // 单读仍保留——它挡的是「界面看的是旧修订就按下归档」，不是二次确认。
      await sendArchive({ commandId: createCommandId(), projectId: current.id,
        expectedRevision: current.revision });
    } catch (caught) {
      if (!disposed.current) {
        setArchiveError(describeLiveError(caught).message);
        if (caught instanceof RelayApiError && (caught.problem.status === 403 || caught.problem.status === 404))
          void loadPage(null, true);
      }
    } finally { if (!disposed.current) setCheckingArchive(false); }
  }

  async function sendArchive(command: PendingArchive, retry = false) {
    if (archiveFlight.current || archiveBusy || (!retry && pendingArchive !== null) ||
      (retry && (!mayRetryArchive || pendingArchive?.commandId !== command.commandId))) return;
    if (!retry && !savePendingArchive(pendingStorageKey, command)) {
      setArchiveError("无法暂存原归档命令，尚未发送。请检查浏览器会话存储后重试。"); return;
    }
    archiveFlight.current = true;
    setPendingArchive(command); setArchiveBusy(true);
    setMayRetryArchive(false); setArchiveError(null); setArchiveBlockers([]); setArchiveSuccess(null);
    try {
      const envelope = await client.archiveProject({ projectId: command.projectId,
        commandId: command.commandId, expectedRevision: command.expectedRevision });
      if (disposed.current) return;
      const result = confirmedArchive(envelope, command);
      savePendingArchive(pendingStorageKey, null); setPendingArchive(null);
      setArchiveSuccess({ id: result.projectId, archivedAt: result.archivedAt });
      setDetailId(null);
      // 归档成功即给 8 秒反悔窗口；撤销是**新的**命令，修订取归档回执推进后的那一版。
      openUndoFeedback(`archive-project:${result.projectId}`, {
        text: "已归档这个项目", actionLabel: "撤销",
        testId: `project-archive-undo-${result.projectId}`,
        onUndo: () => { void undoArchiveProject(result.projectId, result.revision); },
      });
      await loadPage(null, true);
    } catch (caught) {
      if (disposed.current) return;
      const uncertain = caught instanceof RelayTransportError ||
        caught instanceof RelayApiError && (caught.problem.status >= 500 || caught.problem.code === "COMMAND_ID_REUSED");
      if (uncertain) {
        setArchiveError("归档响应尚不能确认。先查询原 command ID 回执；只有明确未找到后才可原样重试。");
      } else {
        savePendingArchive(pendingStorageKey, null); setPendingArchive(null);
        if (caught instanceof RelayApiError && caught.problem.code === "PROJECT_ARCHIVE_BLOCKED") {
          setArchiveError("服务端拒绝归档，请先处理下列未结清事实，再重新读取项目并确认归档。");
          setArchiveBlockers(caught.problem.blockingReasons ?? []);
        } else if (caught instanceof RelayApiError && caught.problem.code === "REVISION_CONFLICT") {
          setArchiveError(`Project 修订已变化${caught.problem.actualRevision ? `（当前 v${caught.problem.actualRevision}）` : ""}；已重新读取列表，请再次明确确认。`);
          void loadPage(null, true);
        } else if (caught instanceof RelayApiError && caught.problem.code === "PROJECT_ARCHIVED") {
          setArchiveError("服务端确认项目已经归档；已重新读取列表，可在“已归档”范围查看历史事实。");
          void loadPage(null, true);
        } else setArchiveError(describeLiveError(caught).message);
      }
    } finally { archiveFlight.current = false; if (!disposed.current) setArchiveBusy(false); }
  }

  /**
   * 撤销项目归档（工作台 §13.2）：再发一条**前向补偿命令**，把 `archived_at` 写回 NULL。
   *
   * 修订取归档回执推进后的那一版，不读列表里可能还没刷新的行。撤销失败不悄悄消失：
   * 同一条浮层升级成停留到关闭的 Notice，并指向「已归档」范围里仍然存在的项目。
   * 归档成功那条就地回执一并撤掉——撤销成功后再说「已归档」就是假话。
   */
  async function undoArchiveProject(projectId: string, revision: DecimalRevision) {
    try {
      await client.unarchiveProject({ projectId, commandId: createCommandId(),
        expectedRevision: revision });
      setArchiveSuccess(null);
      await loadPage(null, true);
    } catch (caught) {
      const described = describeLiveError(caught);
      escalateFeedback(`archive-project:${projectId}`, {
        testId: `project-archive-undo-${projectId}`,
        text: described.kind === "conflict"
          ? "撤销没成功：项目刚被别处改过。在「已归档」范围仍能重新打开它。"
          : `撤销没成功：${described.message}`,
      });
    }
  }

  async function checkArchiveReceipt() {
    if (!pendingArchive || archiveFlight.current || archiveBusy) return;
    archiveFlight.current = true;
    setArchiveBusy(true); setArchiveError(null); setMayRetryArchive(false);
    try {
      const receipt = await client.getCommandReceipt(pendingArchive.commandId);
      if (disposed.current) return;
      const result = confirmedArchive(receipt, pendingArchive, true);
      savePendingArchive(pendingStorageKey, null); setPendingArchive(null);
      setArchiveSuccess({ id: result.projectId, archivedAt: result.archivedAt });
      setDetailId(null);
      await loadPage(null, true);
    } catch (caught) {
      if (disposed.current) return;
      if (caught instanceof RelayApiError && caught.problem.code === "COMMAND_NOT_FOUND") {
        setMayRetryArchive(true);
        setArchiveError("服务端明确未找到原命令；只能用原 command ID、Project 和修订重试。");
      } else setArchiveError(describeLiveError(caught).message);
    } finally { archiveFlight.current = false; if (!disposed.current) setArchiveBusy(false); }
  }

  const needle = search.trim().toLocaleLowerCase();
  const visible = items.filter((project) => !needle || project.title.toLocaleLowerCase().includes(needle));
  const selected = detailId === null ? null
    : items.find((project) => project.id === detailId) ?? detailSnapshot.current;
  // 页签计数与示例版一致；live 一次只加载一个范围，计数只来自已成功加载的数据，另一范围不造数。
  const loadedCount = loading || error ? null : items.length;
  // 下一步只拿到 Task ID；按 ID 单读真实标题。缓存仅在请求结束后写入；
  // 显式刷新列表时整批失效并重读，失败结果也可在下次刷新时重试。
  const [taskTitles, setTaskTitles] = useState<Record<string, string | null>>({});
  const [titleReloadToken, setTitleReloadToken] = useState(0);
  const resolvedTasks = useRef<Set<string>>(new Set());
  const inFlightTitles = useRef<Set<string>>(new Set());
  const titleEpoch = useRef(0);
  const invalidateTaskTitles = () => {
    titleEpoch.current++;
    resolvedTasks.current.clear();
    inFlightTitles.current.clear();
    setTaskTitles({});
    setTitleReloadToken((token) => token + 1);
  };
  useEffect(() => {
    const missing = [...new Set(visible.map((project) => project.nextActionTaskId)
      .filter((id): id is string => id !== null))]
      .filter((id) => !resolvedTasks.current.has(id) && !inFlightTitles.current.has(id));
    if (missing.length === 0) return;
    for (const id of missing) inFlightTitles.current.add(id);
    const epoch = titleEpoch.current;
    void Promise.all(missing.map(async (id) => {
      try { const task = await client.getTask(id); return [id, task.title] as const; }
      catch { return [id, null] as const; }
    })).then((entries) => {
      for (const [id] of entries) inFlightTitles.current.delete(id);
      if (disposed.current || epoch !== titleEpoch.current) return;
      for (const [id] of entries) resolvedTasks.current.add(id);
      setTaskTitles((current) => ({ ...current, ...Object.fromEntries(entries) }));
    });
  }, [client, visible, titleReloadToken]);
  const nextLabel = (project: RelayProjectListItem): string =>
    project.nextActionTaskId === null ? "尚未明确"
      : taskTitles[project.nextActionTaskId] ?? "标题暂不可读";

  const counts: Record<ProjectScope, number | null> = {
    all: scope === "all" ? loadedCount : null,
    active: scope === "active" ? loadedCount : null,
    archived: scope === "archived" ? loadedCount : null };
  // 摘要条只统计已加载项；有后续页时用 note 限定，不把部分计数冒充全量。
  const loadedActive = items.filter((project) => project.archiveStatus === "ACTIVE");
  const missingNext = loadedActive.filter((project) => project.nextActionTaskId === null);
  // 摘要的覆盖范围：只有读完全部页才给全量结论；还有后续页（含续页失败）时只说已加载范围，
  // 首屏就没读到时数量与「是否都已明确」都未知，不给任何数量结论（禅道 #110）。
  const coverage: SummaryCoverage = error !== null || loading ? "unknown"
    : nextCursor !== null ? "partial" : "full";
  const summaryNote = coverage === "unknown"
    ? (loading ? "正在读取项目列表，尚未确认项目数量与下一步状态。" : "项目列表读取失败，数量与下一步状态都还不能确认。")
    : nextCursor !== null
      ? "按已加载项目统计；后续页尚未读完，不能当作全部项目。"
      : undefined;
  const openFirstMissing = () => {
    const target = missingNext[0];
    if (target) setDetailId(target.id);
  };

  return <section className="skill-page projects-page pv-page" data-testid="projects-live-list">
    <div className="projects-inner">
      <PageHeader title="项目" testId="projects-page-head" overline="Projects"
        lede="长期工作以项目为上下文，关联会话、任务、目标和成果。"
        actions={<><Link className="secondary-button" data-testid="goal-list-open" to="/goals"><Target aria-hidden="true" />目标列表</Link>
          <Link className="secondary-button" data-testid="goal-create-open" to="/projects?view=goal"><Target aria-hidden="true" />记录目标</Link>
          <button className="primary-button" type="button" data-testid="project-create-open" onClick={onCreate}><Plus aria-hidden="true" />新建项目</button></>} />
      <ProjectsSummary activeCount={loadedActive.length} missingCount={missingNext.length}
        coverage={coverage} note={summaryNote} onFix={missingNext.length > 0 ? openFirstMissing : undefined} />
      <ProjectsToolbar scope={scope} counts={counts} search={search} onSearch={setSearch} view={view} onView={setView}
        searchName="live-project-search"
        tools={<button className="secondary-button secondary-button--compact" type="button" data-testid="projects-live-refresh"
          disabled={loading || loadingMore} onClick={() => void loadPage(null)}><RotateCcw aria-hidden="true" />刷新当前范围</button>} />
      {archiveSuccess && <p className="receipt-message" role="status" data-testid="project-archive-success">已归档项目（<time dateTime={archiveSuccess.archivedAt}>{formatReadableDateTime(archiveSuccess.archivedAt, timeZone)}</time>）。<Link className="inline-link" to={`/projects/${archiveSuccess.id}`}>查看历史项目</Link> · <Link className="inline-link" to="/projects?scope=archived">查看已归档列表</Link> <small>Project ID：{archiveSuccess.id}</small></p>}
      {archiveError && <p className="action-error" role="alert" data-testid="project-archive-error">{archiveError}</p>}
      {archiveBlockers.length > 0 && <div className="warning-callout" data-testid="project-archive-blockers"><strong>归档阻断原因</strong><ul>{archiveBlockers.map((reason, index) => <li key={`${reason}-${index}`}><strong>{reason}</strong>：{archiveBlockerLabels[reason] ?? "服务端报告未识别的阻断事实；请重新读取项目并核对当前状态。"}</li>)}</ul></div>}
      {pendingArchive && <div className="warning-callout" data-testid="project-archive-pending"><strong>归档命令待核对</strong><p>原 command ID：{pendingArchive.commandId} · Project {pendingArchive.projectId} · 基于修订 v{pendingArchive.expectedRevision}。核对前不会创建另一条归档命令。</p><button className="secondary-button" type="button" data-testid="project-archive-receipt" disabled={archiveBusy} onClick={() => void checkArchiveReceipt()}>查询原命令回执</button>{mayRetryArchive && <button className="secondary-button" type="button" data-testid="project-archive-retry" disabled={archiveBusy} onClick={() => void sendArchive(pendingArchive, true)}>用原 ID 和修订重试</button>}</div>}
      {loading ? <div className="page-state" aria-live="polite"><p>正在读取{scopeLabel(scope)}项目…</p></div> :
        error ? <div className="page-state page-state--error" role="alert"><p>{error}</p>
          <button className="secondary-button" type="button" onClick={() => void loadPage(null)}><RotateCcw aria-hidden="true" />重新读取</button></div> : <>
          <p className="list-footer-note" data-testid="projects-live-count">已加载 {items.length} 项 · 当前搜索显示 {visible.length} 项
            {nextCursor ? " · 仍有后续页" : " · 已到列表末页"}。名称搜索只作用于已加载项目。</p>
          {/* 续页失败只就地提示：已读项目、原游标与当前详情都保留，可按同一游标重试。 */}
          {moreError && <p className="action-error" role="alert" data-testid="projects-live-more-error">
            续页失败：{moreError}；已保留前面加载的结果。
            {nextCursor && <button className="text-button" type="button" data-testid="projects-live-more-retry"
              disabled={loadingMore} onClick={() => void loadPage(nextCursor)}>按原游标重试</button>}</p>}
          {visible.length === 0
            ? items.length === 0
              ? archivedScope
                // 归档范围为空说明的是范围本身的状态，与主区首装空态不是同一件事：
                // 归档后仍保留历史事实，这里只负责把人带回进行中范围，不提供无效的新建入口。
                ? <EmptyState size="compact" icon={Package} title="当前没有已归档的项目"
                  description="归档只改变项目状态，历史事实仍会保留；没有项目归档过时，这个范围就是空的。"
                  testId="projects-archived-empty"
                  actions={<Link className="secondary-button" to="/projects">回到进行中</Link>} />
                // 首装状态：本页还没有任何 Project 事实。把「项目是什么」和「建完能做什么」说清，
                // 并在这里给出主操作——页头的「新建项目」是常驻入口，这里是离内容最近的那一个。
                : <EmptyState icon={FolderPlus} as="h2" title="还没有进行中的项目"
                  description="项目是长期目标的容器：当前阶段、下一步、任务和产物版本都记在它下面。先建一个项目，再从它拆出第一条任务；不建项目也可以先记一条独立任务。"
                  testId="projects-empty"
                  actions={<><button className="primary-button" type="button" onClick={onCreate}>新建项目</button>
                    <Link className="secondary-button" to="/projects?view=goal">记录目标</Link></>} />
              // 搜索无匹配与工作空间为空不同：只能说已加载范围内没有命中，不能暗示整个工作空间为空。
              : <EmptyState size="compact" title="已加载项目里没有匹配项"
                description={`已加载 ${items.length} 项，当前搜索显示 0 项。名称搜索只作用于已加载范围，后续页可能仍有匹配项目。`}
                testId="projects-live-no-match"
                actions={<button className="secondary-button" type="button" onClick={() => setSearch("")}>清除搜索</button>} />
            : <ProjectsGrid view={view}>
              {visible.map((project) => <ProjectCard key={project.id} onOpen={() => setDetailId(project.id)}
                onNavigate={() => navigate(`/projects/${project.id}`)}
                project={{ id: project.id, title: project.title,
                  typeLabel: projectTypeLabels[project.projectType as ProjectType] ?? project.projectType,
                  phase: phaseLabel(project.phaseKey),
                  nextAction: project.nextActionTaskId === null ? null : nextLabel(project),
                  archived: project.archiveStatus === "ARCHIVED" }} />)}
              {!needle && !archivedScope && <NewProjectCard onCreate={onCreate} />}
            </ProjectsGrid>}
          {/* 加载更多是续页入口：续页失败后原游标仍在，这颗键就是按同一游标重试的入口。 */}
          {nextCursor && <button className="secondary-button" type="button" data-testid="projects-live-load-more"
            disabled={loadingMore} onClick={() => void loadPage(nextCursor)}>{loadingMore ? "正在加载" : "加载更多"}</button>}
        </>}
      <footer className="projects-footnote">
        <p className="projects-footnote__note">下一步来自项目状态，显示对应任务的标题；任务的确切 ID、修订与打开入口在选中项目后的详情抽屉中。归档前会单读当前 Project；服务端会检查未结清任务、运行与外部效果。</p>
        {/* 按 ID 打开是深度链接的备用入口：正常按名称选项目即可，只有从别处拿到确切 ID（链接、日志）时才粘贴使用，
            故收成一条安静的「高级」折叠、按钮走 text 层级，不与主流程抢注意力。 */}
        <details className="page-explanation projects-footnote__advanced"><summary>高级：粘贴项目 ID 打开任务</summary>
          <form className="projects-footnote__idform" noValidate onSubmit={(event) => { event.preventDefault();
            if (knownId.trim()) navigate(`/projects/${encodeURIComponent(knownId.trim())}/tasks`);
          }}><input value={knownId} onChange={(event) => setKnownId(event.target.value)}
            name="live-project-id" autoComplete="off" placeholder="粘贴 Project ID（UUID）" aria-label="项目 ID" />
            <button className="text-button" type="submit" data-testid="projects-live-open" disabled={!knownId.trim()}>打开</button></form></details>
      </footer>
    </div>
    <ProjectDetailDialog open={selected !== null} onClose={() => setDetailId(null)}>
      {selected && <div className="projects-detail">
        <p className={`projects-detail__status${selected.archiveStatus === "ARCHIVED" ? " is-archived" : ""}`}>
          {selected.archiveStatus === "ARCHIVED" ? "已归档的项目" : "进行中的项目"}</p>
        <h2 className="projects-detail__title">{selected.title}</h2>
        <p className="projects-detail__desc">在这里查看项目阶段、修订与下一步；打开项目后可以继续安排任务与产物。</p>
        <div className="projects-detail__actions">
          <Link className="primary-button" data-testid="project-open" to={`/projects/${selected.id}`}>打开项目<ArrowRight aria-hidden="true" /></Link>
        </div>
        <div className="projects-detail__divider" />
        <h3 className="projects-detail__heading">项目概况</h3>
        {/* 2026-10-24 用户指令：归档状态由抽屉状态行（844 行）承载，概况里不再重复一行。 */}
        <DetailRows rows={[
          { label: "项目类型", value: projectTypeLabels[selected.projectType as ProjectType] ?? selected.projectType },
          { label: "项目阶段", value: phaseLabel(selected.phaseKey) },
          { label: "修订", value: `Project v${selected.revision} · State v${selected.stateRevision}` }
        ]} />
        <div className="projects-detail__divider" />
        <h3 className="projects-detail__heading">下一步</h3>
        <p className="projects-detail__text">{selected.nextActionTaskId === null ? "尚未明确"
          : <Link className="inline-link" to={`/tasks/${selected.nextActionTaskId}`}>
            {taskTitles[selected.nextActionTaskId] ?? "打开任务"}</Link>}</p>
        {!archivedScope && selected.archiveStatus === "ACTIVE" && <>
          <div className="projects-detail__divider" />
          <button className="secondary-button secondary-button--wide" type="button" data-testid="project-archive"
            disabled={checkingArchive || archiveBusy || pendingArchive !== null || loading || loadingMore || error !== null}
            onClick={() => void prepareArchive(selected)}><Archive aria-hidden="true" />{checkingArchive ? "正在核对 Project" : "归档项目"}</button>
          <p className="helper-text">归档后可立即在提示条里撤销；历史事实仍可读取。</p>
        </>}
        <div className="projects-detail__divider" />
        <h3 className="projects-detail__heading">项目身份</h3>
        <p className="helper-text hash-code">Project ID：{selected.id}</p>
        <p className="helper-text">原始阶段键：{selected.phaseKey}</p>
        {selected.nextActionTaskId && <p className="helper-text">任务 ID：{selected.nextActionTaskId}</p>}
      </div>}
    </ProjectDetailDialog>
  </section>;
}
