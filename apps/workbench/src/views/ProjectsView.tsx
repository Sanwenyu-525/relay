import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ArrowRight, Archive, Info, Plus, RotateCcw, Search } from "lucide-react";
import { createCommandId, projectArchiveResultFrom, RelayApiError, RelayTransportError,
  type RelayApiClient, type RelayCommandEnvelope, type RelayProject,
  type RelayProjectArchiveResult, type RelayProjectListItem } from "../api/relayClient";
import AppDialog from "../components/AppDialog";
import ResponsiveRail from "../components/ResponsiveRail";
import CreateProjectView from "./CreateProjectView";
import { fixtureAdapter } from "../fixtures/fixtureAdapter";
import { fixtureModeFromQuery } from "../lib/fixtureMode";
import { phaseLabel, projectTypeLabels } from "../lib/labels";
import { describeLiveError } from "../lib/liveErrors";
import { takeCreationFlash } from "../lib/navigationFlash";
import { useRelayConnection } from "../lib/relayConnection";
import type { ProjectSummary, ProjectType } from "../types";

function message(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message.trim() : fallback;
}

// 全局控件规则会给所有文本输入统一底色与边框；搜索框的外观由外层 .search-field 提供，
// 这里在行内归零内层输入，避免出现双层边框与高度溢出（共享层修复前先由页面自行约束）。
const searchInputStyle = { appearance: "none", background: "transparent", border: "none",
  padding: 0, minHeight: 0 } as const;

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

export default function ProjectsView() {
  const navigate = useNavigate();
  const [query] = useSearchParams();
  const mode = fixtureModeFromQuery(query);
  const creating = query.get("view") === "create";
  const archivedTab = query.get("archived") === "1";
  const connection = useRelayConnection();
  const live = connection.mode === "live";
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
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
      setSelectedId((current) =>
        (flash && response.some((project) => project.id === flash.projectId) ? flash.projectId : null) ??
        (response.some((project) => project.id === current) ? current : null) ??
        response.find((project) => !project.archived)?.id ?? null
      );
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
  const needle = search.trim().toLowerCase();
  const visibleProjects = (archivedTab ? archivedProjects : activeProjects).filter((project) => !needle || project.title.toLowerCase().includes(needle));
  const selected = projects.find((project) => project.id === selectedId) ?? null;

  function selectProject(project: ProjectSummary) {
    setSelectedId(project.id);
    setReceipt(null);
    setImportStatus("none");
    setActionError(null);
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
      await load();
      if (!disposed.current) setReceipt(result.description);
    } catch (caught) {
      if (!disposed.current) setActionError(message(caught, "归档示例项目时发生未知错误。"));
    } finally {
      if (!disposed.current) setSubmitting(false);
    }
  }

  if (creating) return <section className="skill-page"><CreateProjectView onCancel={() => navigate("/projects")} /></section>;

  if (live && connection.client) return <LiveProjectsListView
    key={`${connection.epoch}:${archivedTab}`} client={connection.client} archived={archivedTab}
    onCreate={() => navigate("/projects?view=create")} />;

  if (loading) return <section className="page-state" aria-live="polite"><p className="eyebrow">项目</p><h1>正在读取项目列表</h1><p>示例数据正在加载，页面尚未提交任何变更。</p></section>;
  if (error) return <section className="page-state page-state--error" role="alert"><p className="eyebrow">项目</p><h1>暂时无法显示项目</h1><p>{error}</p><button className="secondary-button" type="button" onClick={() => void load()}><RotateCcw aria-hidden="true" />重新读取</button></section>;

  return <section className="skill-page"><div className="page-layout">
    <div className="page-primary">
      <div className="list-header"><div><h1>项目</h1><p className="page-lede">每一个长期目标，都有可继续的下一步。</p></div><button className="primary-button" type="button" data-testid="project-create-open" onClick={() => navigate("/projects?view=create")}><Plus aria-hidden="true" />新建项目</button></div>
      <nav className="subnav" aria-label="项目范围"><Link className={`subnav-item${archivedTab ? "" : " subnav-item--active"}`} to="/projects" data-testid="projects-tab-active" aria-current={archivedTab ? undefined : "page"}>进行中 ({activeProjects.length})</Link><Link className={`subnav-item${archivedTab ? " subnav-item--active" : ""}`} to="/projects?archived=1" data-testid="projects-tab-archived" aria-current={archivedTab ? "page" : undefined}>已归档 ({archivedProjects.length})</Link></nav>
      <div className="list-toolbar"><label className="search-field"><Search aria-hidden="true" /><span className="visually-hidden">按项目名称搜索</span><input value={search} onChange={(event) => setSearch(event.target.value)} type="search" name="project-search" placeholder="搜索项目" style={searchInputStyle} /></label></div>
      {refreshing && <p className="helper-text" role="status">正在更新项目列表，已显示的内容保持可见。</p>}
      {visibleProjects.length === 0 ? <div className="page-state"><p>{search.trim() ? `当前范围没有匹配“${search.trim()}”的项目。` : archivedTab ? "还没有已归档的项目；归档后仍会保留历史事实。" : "还没有进行中的项目。"}</p>{!archivedTab && !search.trim() ? <button className="primary-button" type="button" onClick={() => navigate("/projects?view=create")}><Plus aria-hidden="true" />新建项目</button> : <button className="secondary-button" type="button" onClick={() => setSearch("")}>清除搜索</button>}</div> :
        <div className="table-scroll"><div className="data-table"><div className="data-row data-row--head data-row--projects" aria-hidden="true"><span className="data-cell">项目</span><span className="data-cell">类型</span><span className="data-cell">当前阶段</span><span className="data-cell">下一步</span></div><ul className="data-list">{visibleProjects.map((project) => <li key={project.id}><button className={`data-row data-row--projects data-row--interactive${project.id === selectedId ? " data-row--selected" : ""}`} type="button" aria-current={project.id === selectedId ? "true" : undefined} data-testid={`project-row-${project.id}`} onClick={() => selectProject(project)}><span className="data-cell"><strong>{project.title}</strong><small>{project.goal}</small></span><span className="data-cell data-cell--meta">{projectTypeLabels[project.projectType]}</span><span className="data-cell data-cell--meta">{phaseLabel(project.phase)}</span><span className="data-cell data-cell--meta">{project.nextAction ?? "尚未明确"}</span></button></li>)}</ul></div></div>}
      <p className="list-footer-note"><Info aria-hidden="true" />项目阶段由你显式设置，系统不按任务完成数量自动跳阶段；列表中的下一步来自项目状态。</p>
    </div>
    <ResponsiveRail label="查看项目摘要" title={selected?.title ?? "项目摘要"}><div className="rail-content"><h2>{selected?.title ?? "项目摘要"}</h2>{selected ? <><p className="project-summary-kicker">当前项目</p><p className="rail-intro">{selected.summary}</p><section className="project-state-summary" aria-label="项目当前状态"><span>当前阶段</span><strong>{phaseLabel(selected.phase)}</strong><small>状态修订 v{selected.stateRevision} · 待审 {selected.pendingReviewCount} 项</small></section><section className="rail-section"><h3>明确目标</h3><p>{selected.goal}</p></section>
      {receipt && <p className="receipt-message" role="status">{receipt}</p>}{importStatus !== "none" && <p className="helper-text" data-testid="project-import-status"><Info aria-hidden="true" />初始资料导入：{importStatus === "SUCCEEDED" ? "已完成登记，导入成功不代表内容已经验证。" : "失败，项目仍然保留，可稍后重新导入。"}</p>}{actionError && <p className="action-error" role="alert">{actionError}</p>}
      {!selected.archived ? <Link className="primary-button primary-button--wide" data-testid="project-open" to={`/projects/${selected.id}`}>打开项目<ArrowRight aria-hidden="true" /></Link> : <><button className="primary-button primary-button--wide" type="button" disabled>打开项目</button><p className="disabled-reason" data-testid="project-archived-reason"><Info aria-hidden="true" />已归档项目在本轮交互预览中只读；恢复入口尚未接入。</p></>}
      {!selected.archived && <><button className="secondary-button secondary-button--wide" type="button" data-testid="project-archive" disabled={submitting || Boolean(selected.archiveBlockedReason)} onClick={() => void archiveSelected()}><Archive aria-hidden="true" />{submitting ? "正在归档" : "归档项目"}</button>{selected.archiveBlockedReason ? <p className="disabled-reason" data-testid="project-archive-reason"><Info aria-hidden="true" />{selected.archiveBlockedReason}</p> : <p className="helper-text">归档只改变项目状态并保留历史；不会删除任务、产物或验收记录。</p>}</>}</> : <p className="rail-intro">请先在列表中选择一个项目，这里会显示它的目标与当前状态。</p>}</div></ResponsiveRail>
  </div></section>;
}

function LiveProjectsListView({ client, archived, onCreate }: {
  client: RelayApiClient; archived: boolean; onCreate: () => void }) {
  const navigate = useNavigate();
  const [items, setItems] = useState<readonly RelayProjectListItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [knownId, setKnownId] = useState("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmProject, setConfirmProject] = useState<RelayProject | null>(null);
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
  const status = archived ? "archived" : "active";
  const pendingStorageKey = archiveKey(client);

  async function loadPage(cursor: string | null, force = false) {
    if (busy.current && !force) return;
    busy.current = true;
    const request = ++requestVersion.current;
    if (cursor === null) {
      // 重新读取列表时下一步标题缓存一并失效，避免继续显示过期标题。
      invalidateTaskTitles();
      setItems([]); setNextCursor(null); setSelectedId(null); setLoading(true);
    } else setLoadingMore(true);
    setError(null);
    try {
      const page = await client.getProjectsPage(status, cursor);
      if (disposed.current || request !== requestVersion.current) return;
      if (page.items.some((project) => project.archiveStatus !== (archived ? "ARCHIVED" : "ACTIVE"))) {
        throw new Error("项目列表响应与当前归档范围不匹配，已停止显示。");
      }
      setItems((current) => cursor === null ? page.items : [...current, ...page.items]);
      if (cursor === null) setSelectedId(page.items[0]?.id ?? null);
      setNextCursor(page.nextCursor);
    } catch (caught) {
      if (!disposed.current && request === requestVersion.current) {
        setItems([]); setNextCursor(null); setSelectedId(null);
        setError(describeLiveError(caught).message);
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
  }, [client, status]);

  async function prepareArchive(project: RelayProjectListItem) {
    if (archived || loading || loadingMore || error || checkingArchive || archiveBusy || pendingArchive ||
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
      setConfirmProject(current);
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
    setPendingArchive(command); setConfirmProject(null); setArchiveBusy(true);
    setMayRetryArchive(false); setArchiveError(null); setArchiveBlockers([]); setArchiveSuccess(null);
    try {
      const envelope = await client.archiveProject({ projectId: command.projectId,
        commandId: command.commandId, expectedRevision: command.expectedRevision });
      if (disposed.current) return;
      const result = confirmedArchive(envelope, command);
      savePendingArchive(pendingStorageKey, null); setPendingArchive(null);
      setArchiveSuccess({ id: result.projectId, archivedAt: result.archivedAt });
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
  const selected = visible.find((project) => project.id === selectedId) ?? null;
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
  return <section className="skill-page" data-testid="projects-live-list"><div className="page-layout">
    <div className="page-primary">
      <div className="list-header"><div><h1>项目</h1><p className="page-lede">连接本机 API 后，按当前归档范围读取真实项目；列表、下一步与计数只显示服务端已返回的事实。</p></div>
        <button className="primary-button" type="button" data-testid="project-create-open" onClick={onCreate}><Plus aria-hidden="true" />新建项目</button></div>
      <nav className="subnav" aria-label="项目范围"><Link className={`subnav-item${archived ? "" : " subnav-item--active"}`}
        to="/projects" data-testid="projects-tab-active" aria-current={archived ? undefined : "page"}>进行中</Link>
        <Link className={`subnav-item${archived ? " subnav-item--active" : ""}`} to="/projects?archived=1"
          data-testid="projects-tab-archived" aria-current={archived ? "page" : undefined}>已归档</Link></nav>
      <div className="list-toolbar">
        <button className="secondary-button" type="button" data-testid="projects-live-refresh" disabled={loading || loadingMore}
          onClick={() => void loadPage(null)}><RotateCcw aria-hidden="true" />刷新当前范围</button>
        <label className="search-field"><Search aria-hidden="true" /><span className="visually-hidden">在已加载项目中按名称搜索</span>
          <input value={search} onChange={(event) => setSearch(event.target.value)} type="search" name="live-project-search"
            placeholder="搜索已加载项目" style={searchInputStyle} /></label></div>
      {archiveSuccess && <p className="receipt-message" role="status" data-testid="project-archive-success">已归档 Project {archiveSuccess.id}（{archiveSuccess.archivedAt}）。<Link className="inline-link" to={`/projects/${archiveSuccess.id}`}>查看历史项目</Link> · <Link className="inline-link" to="/projects?archived=1">查看已归档列表</Link></p>}
      {archiveError && <p className="action-error" role="alert" data-testid="project-archive-error">{archiveError}</p>}
      {archiveBlockers.length > 0 && <div className="warning-callout" data-testid="project-archive-blockers"><strong>归档阻断原因</strong><ul>{archiveBlockers.map((reason, index) => <li key={`${reason}-${index}`}><strong>{reason}</strong>：{archiveBlockerLabels[reason] ?? "服务端报告未识别的阻断事实；请重新读取项目并核对当前状态。"}</li>)}</ul></div>}
      {pendingArchive && <div className="warning-callout" data-testid="project-archive-pending"><strong>归档命令待核对</strong><p>原 command ID：{pendingArchive.commandId} · Project {pendingArchive.projectId} · 基于修订 v{pendingArchive.expectedRevision}。核对前不会创建另一条归档命令。</p><button className="secondary-button" type="button" data-testid="project-archive-receipt" disabled={archiveBusy} onClick={() => void checkArchiveReceipt()}>查询原命令回执</button>{mayRetryArchive && <button className="secondary-button" type="button" data-testid="project-archive-retry" disabled={archiveBusy} onClick={() => void sendArchive(pendingArchive, true)}>用原 ID 和修订重试</button>}</div>}
      {loading ? <div className="page-state" aria-live="polite"><p>正在读取{archived ? "已归档" : "进行中"}项目…</p></div> :
        error ? <div className="page-state page-state--error" role="alert"><p>{error}</p>
          <button className="secondary-button" type="button" onClick={() => void loadPage(null)}><RotateCcw aria-hidden="true" />重新读取</button></div> : <>
          <p className="list-footer-note" data-testid="projects-live-count">已加载 {items.length} 项 · 当前搜索显示 {visible.length} 项
            {nextCursor ? " · 仍有后续页" : " · 已到列表末页"}。名称搜索只作用于已加载项目。</p>
          {visible.length === 0 ? <div className="page-state"><p>{items.length === 0
            ? archived ? "当前没有已归档项目。" : "当前没有进行中项目。"
            : "已加载项目中没有匹配项；后续页可能仍有匹配项目。"}</p>
            {needle && <button className="secondary-button" type="button" onClick={() => setSearch("")}>清除搜索</button>}</div> :
            <div className="table-scroll"><div className="data-table"><div className="data-row data-row--head data-row--projects" aria-hidden="true"><span className="data-cell">项目</span><span className="data-cell">类型</span><span className="data-cell">当前阶段</span><span className="data-cell">下一步</span></div>
              <ul className="data-list">{visible.map((project) => <li key={project.id}><button className={`data-row data-row--projects data-row--interactive${project.id === selectedId ? " data-row--selected" : ""}`}
                type="button" aria-current={project.id === selectedId ? "true" : undefined} data-testid={`project-row-${project.id}`}
                onClick={() => setSelectedId(project.id)}><span className="data-cell"><strong>{project.title}</strong></span>
                <span className="data-cell data-cell--meta">{projectTypeLabels[project.projectType as ProjectType] ?? project.projectType}</span>
                <span className="data-cell data-cell--meta">{phaseLabel(project.phaseKey)}</span>
                <span className="data-cell data-cell--meta">{nextLabel(project)}</span></button></li>)}</ul></div></div>}
          {nextCursor && <button className="secondary-button" type="button" data-testid="projects-live-load-more"
            disabled={loadingMore} onClick={() => void loadPage(nextCursor)}>{loadingMore ? "正在加载" : "加载更多"}</button>}
        </>}
      <p className="list-footer-note"><Info aria-hidden="true" />下一步来自项目状态，显示对应任务的标题；任务的确切 ID、修订与打开入口在选中项目后的右侧摘要中。</p>
    </div><ResponsiveRail label="查看项目摘要" title={selected?.title ?? "项目摘要"}><div className="rail-content">
      <h2>{selected?.title ?? "项目摘要"}</h2>{selected ? <><p className="rail-intro">Project ID：{selected.id}</p>
        <section className="project-state-summary" aria-label="项目当前状态"><span>项目阶段</span>
          <strong>{phaseLabel(selected.phaseKey)}</strong><small>Project v{selected.revision} · State v{selected.stateRevision}</small></section>
        <section className="rail-section"><h3>下一步</h3><p>{selected.nextActionTaskId
          ? <Link className="inline-link" to={`/tasks/${selected.nextActionTaskId}`}>
            {taskTitles[selected.nextActionTaskId] ?? "打开任务"}</Link>
          : "尚未明确"}</p>
          {selected.nextActionTaskId && <small>任务 ID：{selected.nextActionTaskId}</small>}</section>
        <Link className="primary-button primary-button--wide" data-testid="project-open" to={`/projects/${selected.id}`}>打开项目<ArrowRight aria-hidden="true" /></Link>
        {!archived && <><button className="secondary-button secondary-button--wide" type="button" data-testid="project-archive"
          disabled={checkingArchive || archiveBusy || pendingArchive !== null || loading || loadingMore || error !== null ||
            selected.archiveStatus !== "ACTIVE" || selected.archivedAt !== null}
          onClick={() => void prepareArchive(selected)}><Archive aria-hidden="true" />{checkingArchive ? "正在核对 Project" : "归档项目"}</button>
          <p className="helper-text">归档前会单读当前 Project 并再次要求确认；服务端会检查未结清任务、运行与外部效果。归档保留历史事实。</p></>}</> :
        <p className="rail-intro">选择已加载项目查看确切 ID、阶段和修订。</p>}
      <form className="create-form" noValidate onSubmit={(event) => { event.preventDefault();
        if (knownId.trim()) navigate(`/projects/${encodeURIComponent(knownId.trim())}/tasks`);
      }}><label className="field"><span className="field-label">用项目 ID 打开任务</span><input value={knownId}
        onChange={(event) => setKnownId(event.target.value)} name="live-project-id" autoComplete="off" placeholder="Project UUID" /></label>
        <button className="secondary-button" type="submit" data-testid="projects-live-open" disabled={!knownId.trim()}>打开项目任务</button></form>
    </div></ResponsiveRail>
  </div>
  <AppDialog open={confirmProject !== null} title="确认归档项目" initialFocusSelector='[data-testid="project-archive-cancel"]'
    onClose={() => setConfirmProject(null)}>
    {confirmProject && <><p>确定归档“{confirmProject.title}”？</p><p className="helper-text">Project {confirmProject.id} · 当前修订 v{confirmProject.revision}。提交后由服务端核对所有阻断事实；历史仍可读取，当前没有恢复项目命令。</p>
      <div className="form-actions"><button className="secondary-button" type="button" data-testid="project-archive-cancel"
        onClick={() => setConfirmProject(null)}>暂不归档</button><button className="danger-button" type="button"
        data-testid="project-archive-confirm" disabled={archiveBusy}
        onClick={() => void sendArchive({ commandId: createCommandId(), projectId: confirmProject.id,
          expectedRevision: confirmProject.revision })}>确认归档</button></div></>}
  </AppDialog></section>;
}
