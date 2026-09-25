import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ArrowRight, Archive, Info, Plus, RotateCcw, Search } from "lucide-react";
import ResponsiveRail from "../components/ResponsiveRail";
import CreateProjectView from "./CreateProjectView";
import { fixtureAdapter } from "../fixtures/fixtureAdapter";
import { fixtureModeFromQuery } from "../lib/fixtureMode";
import { phaseLabel, projectTypeLabels } from "../lib/labels";
import { takeCreationFlash } from "../lib/navigationFlash";
import { useRelayConnection } from "../lib/relayConnection";
import type { ProjectSummary } from "../types";

function message(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message.trim() : fallback;
}

export default function ProjectsView() {
  const navigate = useNavigate();
  const [query] = useSearchParams();
  const mode = fixtureModeFromQuery(query);
  const creating = query.get("view") === "create";
  const archivedTab = query.get("archived") === "1";
  const live = useRelayConnection().mode === "live";
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
  const [liveProjectId, setLiveProjectId] = useState("");
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

  if (live) return <section className="skill-page"><div className="page-layout">
    <div className="page-primary">
      <div className="list-header"><div><h1>项目</h1><p className="page-lede">已连接本机 API。真实读取的项目列表端点尚未实现。</p></div>
        <button className="primary-button" type="button" data-testid="project-create-open" onClick={() => navigate("/projects?view=create")}><Plus aria-hidden="true" />新建项目</button></div>
      <p className="warning-callout" role="status" data-testid="projects-live-gap"><Info aria-hidden="true" />真实 API 目前只有 <code>GET /projects/&#123;id&#125;</code> 与 <code>POST /projects</code>，没有项目列表、归档与资料导入端点。因此这里既不显示示例项目，也不伪造一个列表；请用项目 ID 打开，或先创建项目。</p>
      <form className="create-form" noValidate onSubmit={(event) => { event.preventDefault(); if (liveProjectId.trim()) navigate(`/projects/${encodeURIComponent(liveProjectId.trim())}/tasks`); }}>
        <label className="field"><span className="field-label">用项目 ID 打开</span><input value={liveProjectId} onChange={(event) => setLiveProjectId(event.target.value)} name="live-project-id" autoComplete="off" placeholder="Project UUID" /><span className="field-hint">项目 ID 来自创建回执，或数据库中的 projects.id。</span></label>
        <div className="form-actions"><button className="primary-button" type="submit" data-testid="projects-live-open" disabled={!liveProjectId.trim()}>打开项目任务</button></div>
      </form>
    </div>
    <ResponsiveRail label="查看接入边界" title="已接入与未接入"><div className="rail-content"><h2>已接入与未接入</h2><p className="rail-intro">这里说明当前 API 的能力边界；示例项目不会混入真实连接。</p><section className="rail-section"><h3>已接入真实操作</h3><p>创建项目和任务、人工任务产物版本与完成、Run 详情及控制请求、Review 判断、资料读取与写入，以及按原 command ID 核对回执。</p></section><section className="rail-section"><h3>仍未接入的列表与提案</h3><p>项目列表与归档、资料导入、全空间任务筛选，以及四项 Skill 的真实提案与写入。</p></section></div></ResponsiveRail>
  </div></section>;

  if (loading) return <section className="page-state" aria-live="polite"><p className="eyebrow">项目</p><h1>正在读取项目列表</h1><p>示例数据正在加载，页面尚未提交任何变更。</p></section>;
  if (error) return <section className="page-state page-state--error" role="alert"><p className="eyebrow">项目</p><h1>暂时无法显示项目</h1><p>{error}</p><button className="secondary-button" type="button" onClick={() => void load()}><RotateCcw aria-hidden="true" />重新读取</button></section>;

  return <section className="skill-page"><div className="page-layout">
    <div className="page-primary">
      <div className="list-header"><div><h1>项目</h1><p className="page-lede">每一个长期目标，都有可继续的下一步。</p></div><button className="primary-button" type="button" data-testid="project-create-open" onClick={() => navigate("/projects?view=create")}><Plus aria-hidden="true" />新建项目</button></div>
      <nav className="subnav" aria-label="项目范围"><Link className={`subnav-item${archivedTab ? "" : " subnav-item--active"}`} to="/projects" data-testid="projects-tab-active" aria-current={archivedTab ? undefined : "page"}>进行中 ({activeProjects.length})</Link><Link className={`subnav-item${archivedTab ? " subnav-item--active" : ""}`} to="/projects?archived=1" data-testid="projects-tab-archived" aria-current={archivedTab ? "page" : undefined}>已归档 ({archivedProjects.length})</Link></nav>
      <div className="list-toolbar"><label className="search-field"><Search aria-hidden="true" /><span className="visually-hidden">按项目名称搜索</span><input value={search} onChange={(event) => setSearch(event.target.value)} type="search" name="project-search" placeholder="搜索项目" /></label></div>
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
