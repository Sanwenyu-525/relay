import { useEffect, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { RotateCcw } from "lucide-react";
import type {
  RelayApiClient, RelayGatewayConnection, RelayKnowledge, RelayKnowledgeVersion,
  RelayReview, RelayRun, RelayTaskSummary
} from "../api/relayClient";
import ProjectNav from "../components/ProjectNav";
import ViewConfigurationPanel from "../components/ViewConfigurationPanel";
import ResponsiveRail from "../components/ResponsiveRail";
import StatusChip from "../components/StatusChip";
import { fixtureAdapter } from "../fixtures/fixtureAdapter";
import { fixtureModeFromQuery } from "../lib/fixtureMode";
import { phaseLabel, projectTypeLabels } from "../lib/labels";
import { describeLiveError } from "../lib/liveErrors";
import { useRelayConnection } from "../lib/relayConnection";
import type { ProjectType, TaskStatus } from "../types";
import "./ProjectWorkbenchView.css";

type WorkbenchKind = "general" | "thesis" | "development";
const kinds: readonly { kind: WorkbenchKind; label: string }[] = [
  { kind: "general", label: "通用" },
  { kind: "thesis", label: "论文" },
  { kind: "development", label: "开发" }
];

interface WorkbenchTask {
  readonly id: string;
  readonly title: string;
  readonly status: TaskStatus;
  readonly revision: string;
  readonly runId: string | null;
}
interface WorkbenchArtifact {
  readonly id: string;
  readonly title: string | null;
  readonly version: string;
  readonly taskId: string | null;
  readonly sourceRef: string;
}
interface Snapshot {
  readonly source: "live" | "fixture";
  readonly projectId: string;
  readonly title: string;
  readonly archivedAt: string | null;
  readonly projectType: string;
  readonly phaseKey: string;
  readonly stateRevision: string;
  readonly nextAction: { readonly id: string | null; readonly title: string | null } | null;
  readonly tasks: readonly WorkbenchTask[];
  readonly nextCursor: string | null;
  readonly artifacts: readonly WorkbenchArtifact[];
  readonly completedHighlights: readonly { readonly completionId: string; readonly taskId: string;
    readonly acceptanceRevision: string }[];
  readonly fixtureSources: readonly { readonly id: string; readonly title: string; readonly version: string; readonly excerpt: string }[];
}
interface ThesisKnowledge {
  readonly row: RelayKnowledge;
  readonly version: RelayKnowledgeVersion | null;
  readonly readFailed: boolean;
}
interface ThesisDraft {
  readonly taskId: string;
  readonly taskTitle: string;
  readonly artifactId: string;
  readonly title: string;
  readonly versionId: string;
  readonly version: string;
  readonly accepted: boolean;
}
type Extra =
  | { readonly kind: "thesis"; readonly knowledge: readonly ThesisKnowledge[];
      readonly knowledgeCount: number; readonly drafts: readonly ThesisDraft[];
      readonly draftTaskCount: number; readonly failedDraftReads: number }
  | { readonly kind: "development"; readonly connections: readonly RelayGatewayConnection[];
      readonly reviews: readonly RelayReview[];
      readonly runs: readonly { readonly id: string; readonly taskTitle: string; readonly run: RelayRun | null }[];
      readonly runCount: number };

function taskFromLive(task: RelayTaskSummary): WorkbenchTask {
  return { id: task.id, title: task.title, status: task.status,
    revision: task.revision, runId: task.executorRunId };
}

async function loadLive(client: RelayApiClient, id: string): Promise<Snapshot> {
  const [project, state, page] = await Promise.all([
    client.getProject(id), client.getProjectState(id), client.getProjectTasksPage(id)
  ]);
  if (project.id !== id || state.projectId !== id) throw new Error("项目工作台查询返回了其他项目的事实。");
  const listedNext = page.items.find((task) => task.id === state.nextActionTaskId);
  const nextDetail = state.nextActionTaskId !== null && listedNext === undefined
    ? await client.getTask(state.nextActionTaskId).catch(() => null) : null;
  const artifacts = await Promise.all(state.selectedArtifactVersionRefs.map(async (ref): Promise<WorkbenchArtifact> => {
    const artifact = await client.getArtifact(ref.artifactId).catch(() => null);
    const matching = artifact?.id === ref.artifactId &&
      artifact.versions.some((version) => version.artifactVersionId === ref.artifactVersionId) ? artifact : null;
    return { id: ref.artifactVersionId, title: matching?.title ?? null,
      version: ref.versionNumber, taskId: matching?.taskId ?? null, sourceRef: ref.sourceRef };
  }));
  return { source: "live", projectId: id, title: project.title, archivedAt: project.archivedAt,
    projectType: project.projectType,
    phaseKey: state.phaseKey, stateRevision: state.revision,
    nextAction: state.nextActionTaskId === null ? null : {
      id: state.nextActionTaskId,
      title: listedNext?.title ?? (nextDetail?.id === state.nextActionTaskId && nextDetail.projectId === id ? nextDetail.title : null)
    },
    tasks: page.items.map(taskFromLive), nextCursor: page.nextCursor,
    artifacts, completedHighlights: state.completedHighlightRefs, fixtureSources: [] };
}

async function loadFixture(id: string, mode: ReturnType<typeof fixtureModeFromQuery>): Promise<Snapshot | null> {
  const [projects, result, skill] = await Promise.all([
    fixtureAdapter.listProjects(mode), fixtureAdapter.loadProjectTasks(id, mode), fixtureAdapter.loadProject(id, mode)
  ]);
  const project = projects.find((row) => row.id === id);
  if (!project || !result) return null;
  return { source: "fixture", projectId: id, title: project.title, archivedAt: null,
    projectType: project.projectType,
    phaseKey: project.phase, stateRevision: project.stateRevision,
    nextAction: project.nextAction === null ? null : { id: null, title: project.nextAction },
    tasks: result.tasks.map((task) => ({ id: task.id, title: task.title, status: task.status,
      revision: task.revision, runId: null })), nextCursor: null,
    artifacts: skill?.sources.filter((source) => source.kind === "artifact").map((source) => ({
      id: source.id, title: source.title, version: source.version, taskId: null, sourceRef: source.id
    })) ?? [],
    completedHighlights: [], fixtureSources: skill?.sources.filter((source) => source.kind === "note" || source.kind === "artifact")
      .map((source) => ({ id: source.id, title: source.title, version: source.version, excerpt: source.excerpt })) ?? [] };
}

async function loadThesis(client: RelayApiClient, snapshot: Snapshot): Promise<Extra> {
  const knowledge = await client.getKnowledge(snapshot.projectId);
  const visibleKnowledge = knowledge.slice(0, 6);
  const versions = await Promise.all(visibleKnowledge.map(async (row): Promise<ThesisKnowledge> => {
    try {
      const all = await client.getKnowledgeVersions(row.id);
      return { row, version: all.find((version) => version.knowledgeId === row.id && version.version === row.currentVersion) ?? null,
        readFailed: false };
    } catch {
      return { row, version: null, readFailed: true };
    }
  }));
  const draftTasks = snapshot.tasks.filter((task) => task.status === "IN_PROGRESS" || task.status === "WAITING");
  const next = snapshot.nextAction?.id;
  if (next !== null && next !== undefined && !draftTasks.some((task) => task.id === next)) {
    draftTasks.unshift({ id: next, title: snapshot.nextAction?.title ?? next,
      status: "READY", revision: "0", runId: null });
  }
  const selectedTasks = draftTasks.slice(0, 6);
  const draftResults = await Promise.all(selectedTasks.map(async (task) => {
    try {
      const artifacts = await client.getTaskArtifacts(task.id);
      return { task, artifacts, failed: false };
    } catch {
      return { task, artifacts: null, failed: true };
    }
  }));
  const drafts = draftResults.flatMap(({ task, artifacts }): ThesisDraft[] =>
    artifacts?.items.flatMap((artifact) => {
      const latest = artifact.versions.find((version) => version.artifactVersionId === artifact.latestVersionId);
      return latest ? [{ taskId: task.id, taskTitle: task.title, artifactId: artifact.id,
        title: artifact.title, versionId: latest.artifactVersionId, version: latest.versionNumber,
        accepted: artifacts.currentAcceptedVersionIds.includes(latest.artifactVersionId) }] : [];
    }) ?? []);
  return { kind: "thesis", knowledge: versions, knowledgeCount: knowledge.length, drafts,
    draftTaskCount: draftTasks.length, failedDraftReads: draftResults.filter((item) => item.failed).length };
}

async function loadDevelopment(client: RelayApiClient, snapshot: Snapshot): Promise<Extra> {
  const runTasks = snapshot.tasks.filter((task) => task.runId !== null);
  const [connections, reviews, runs] = await Promise.all([
    client.getGatewayConnections(snapshot.projectId), client.getReviews(),
    Promise.all(runTasks.slice(0, 8).map(async (task) => ({ id: task.runId!, taskTitle: task.title,
      run: await client.getRun(task.runId!).then((run) => run.taskId === task.id ? run : null).catch(() => null) })))
  ]);
  return { kind: "development", connections, reviews: reviews.filter((review) => review.projectId === snapshot.projectId),
    runs, runCount: runTasks.length };
}

function typeLabel(projectType: string): string {
  return projectType in projectTypeLabels ? projectTypeLabels[projectType as ProjectType] : projectType;
}

export default function ProjectWorkbenchView() {
  const { id = "", kind: routeKind = "" } = useParams();
  const kind = kinds.find((item) => item.kind === routeKind)?.kind ?? null;
  const [query] = useSearchParams();
  const fixtureMode = fixtureModeFromQuery(query);
  const connection = useRelayConnection();
  const client = connection.client;
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [pageLoading, setPageLoading] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [extra, setExtra] = useState<Extra | null>(null);
  const [extraLoading, setExtraLoading] = useState(false);
  const [extraError, setExtraError] = useState<string | null>(null);
  const epoch = useRef(0);

  useEffect(() => {
    const request = ++epoch.current;
    setSnapshot(null); setLoading(true); setError(null); setPageError(null);
    void (client ? loadLive(client, id) : loadFixture(id, fixtureMode)).then((result) => {
      if (request === epoch.current) setSnapshot(result);
    }).catch((caught: unknown) => {
      if (request === epoch.current) setError(client ? describeLiveError(caught).message :
        caught instanceof Error ? caught.message : "读取示例项目失败。");
    }).finally(() => { if (request === epoch.current) setLoading(false); });
    return () => { epoch.current++; };
  }, [id, client, fixtureMode, reloadKey]);

  useEffect(() => {
    let active = true;
    setExtra(null); setExtraError(null);
    if (!snapshot || !client || kind === "general" || kind === null) { setExtraLoading(false); return; }
    setExtraLoading(true);
    void (kind === "thesis" ? loadThesis(client, snapshot) : loadDevelopment(client, snapshot))
      .then((result) => { if (active) setExtra(result); })
      .catch((caught: unknown) => { if (active) setExtraError(describeLiveError(caught).message); })
      .finally(() => { if (active) setExtraLoading(false); });
    return () => { active = false; };
  }, [snapshot, client, kind]);

  async function loadMore() {
    if (!client || !snapshot?.nextCursor || pageLoading) return;
    const cursor = snapshot.nextCursor;
    const request = epoch.current;
    setPageLoading(true); setPageError(null);
    try {
      const page = await client.getProjectTasksPage(id, cursor);
      if (request !== epoch.current) return;
      setSnapshot((current) => current?.nextCursor === cursor ? {
        ...current, tasks: [...current.tasks, ...page.items.map(taskFromLive).filter(
          (task) => !current.tasks.some((existing) => existing.id === task.id))],
        nextCursor: page.nextCursor
      } : current);
    } catch (caught) {
      if (request === epoch.current) setPageError(describeLiveError(caught).message);
    } finally { if (request === epoch.current) setPageLoading(false); }
  }

  if (kind === null) return <section className="page-state"><h1>没有这个工作台</h1><p>当前只提供通用、论文和开发三种内置视图。</p><Link className="text-link" to={`/projects/${id}/workbench/general`}>打开通用工作台</Link></section>;
  if (loading) return <section className="page-state" aria-live="polite"><h1>正在读取项目工作台</h1><p>{client ? "正在读取本机 API 的项目事实。" : "正在读取示例数据。"}</p></section>;
  if (error) return <section className="page-state page-state--error" role="alert"><h1>暂时无法读取项目工作台</h1><p>{error}</p><button className="secondary-button" type="button" onClick={() => setReloadKey((value) => value + 1)}><RotateCcw aria-hidden="true" />重新读取</button></section>;
  if (!snapshot) return <section className="page-state"><h1>没有这个项目</h1><p>当前数据来源中没有该项目，页面不会自行创建项目或复制其他项目资料。</p><Link className="text-link" to="/projects">返回项目入口</Link></section>;

  return <section className="skill-page project-workbench"><div className="page-layout"><div className="page-primary">
    <p className="eyebrow">{snapshot.title}</p><div className="workbench-heading"><div><h1>项目工作台</h1><p className="page-lede">{snapshot.source === "live" ? "同一项目事实的只读视图" : "示例数据预览"} · 项目类型：{typeLabel(snapshot.projectType)} · 当前阶段：{phaseLabel(snapshot.phaseKey)}</p></div><button className="secondary-button" type="button" onClick={() => setReloadKey((value) => value + 1)}><RotateCcw aria-hidden="true" />刷新事实</button></div>
    <ProjectNav projectId={id} active="workbench" />
    <nav className="subnav" aria-label="工作台视图">{kinds.map((item) => <Link key={item.kind} className={`subnav-item${item.kind === kind ? " subnav-item--active" : ""}`} aria-current={item.kind === kind ? "page" : undefined} to={`/projects/${id}/workbench/${item.kind}${snapshot.source === "fixture" && query.toString() ? `?${query.toString()}` : ""}`}>{item.label}</Link>)}</nav>
    <p className="helper-text">上方切换仅供浏览。保存默认视图需明确提交；项目阶段仍由项目类型和服务端 State 决定，不会开始、暂停或改写任务与 Run。</p>
    <ViewConfigurationPanel client={client} projectId={id} browseKind={kind}
      projectArchivedAt={snapshot.archivedAt} />
    {snapshot.source === "live" && kind !== "general" && <div className="workbench-page-note"><p className="helper-text">当前已读取 {snapshot.tasks.length} 条项目任务；{snapshot.nextCursor ? "还有后续页，下面的任务关联投影并非项目全量。" : "服务端未返回下一页游标。"}</p>{pageError && <p className="action-error" role="alert">{pageError}</p>}{snapshot.nextCursor && <button className="secondary-button" type="button" disabled={pageLoading} onClick={() => void loadMore()}>{pageLoading ? "正在读取下一页" : "继续加载任务"}</button>}</div>}
    {kind === "general" && <>
      <section className="workbench-section" aria-labelledby="workbench-next"><h2 id="workbench-next">项目下一步</h2>{snapshot.nextAction ? <div className="workbench-item"><strong>{snapshot.nextAction.title ?? "目标任务暂不可读取"}</strong>{snapshot.nextAction.id && <Link className="text-link" to={`/tasks/${snapshot.nextAction.id}`}>打开任务</Link>}</div> : <p>Project State 尚未指定下一步。任务列表可供人工选择；此处不自动生成建议。</p>}</section>
      {snapshot.source === "live" && <section className="workbench-section" aria-labelledby="workbench-completions"><h2 id="workbench-completions">State 当前完成引用</h2>{snapshot.completedHighlights.length ? <ul className="workbench-list">{snapshot.completedHighlights.map((ref) => <li key={ref.completionId}><span>Task {ref.taskId} · 当时验收 v{ref.acceptanceRevision}</span><Link to={`/completion-records/${ref.completionId}`}>查看完成凭据</Link></li>)}</ul> : <p>State 当前没有完成引用；历史凭据可从该任务 Activity 查阅。</p>}</section>}
      <section className="workbench-section" aria-labelledby="workbench-tasks"><h2 id="workbench-tasks">项目任务</h2>{snapshot.tasks.length === 0 ? <p>{snapshot.nextCursor ? "本页暂无任务，可继续读取。" : "当前项目没有任务。"}</p> : <ul className="workbench-list">{snapshot.tasks.map((task) => <li key={task.id}><Link to={`/tasks/${task.id}`}>{task.title}</Link><StatusChip status={task.status} /><small>v{task.revision}</small></li>)}</ul>}{snapshot.source === "live" && <p className="helper-text">当前已读取 {snapshot.tasks.length} 条；{snapshot.nextCursor ? "还有后续页，当前列表并非项目全量。" : "服务端未返回下一页游标。"}</p>}{pageError && <p className="action-error" role="alert">{pageError}</p>}{snapshot.nextCursor && <button className="secondary-button" type="button" disabled={pageLoading} onClick={() => void loadMore()}>{pageLoading ? "正在读取下一页" : "继续加载任务"}</button>}</section>
      <section className="workbench-section" aria-labelledby="workbench-artifacts"><h2 id="workbench-artifacts">{snapshot.source === "live" ? "项目当前选用产物" : "示例产物来源"}</h2>{snapshot.artifacts.length === 0 ? <p>当前视图没有{snapshot.source === "live" ? "由 Project State 选用的产物版本" : "示例产物来源"}；各任务的全部版本可从任务详情读取。</p> : <ul className="workbench-list">{snapshot.artifacts.map((artifact) => <li key={artifact.id}><span><strong>{artifact.title ?? `产物 ${artifact.id}`}</strong> v{artifact.version}<small>来源：{artifact.sourceRef}</small></span>{artifact.taskId && <Link to={`/tasks/${artifact.taskId}`}>查看任务产物</Link>}</li>)}</ul>}</section>
    </>}
    {kind === "thesis" && <>
      <section className="workbench-section" aria-labelledby="workbench-knowledge"><h2 id="workbench-knowledge">资料与引用证据</h2>{snapshot.source === "fixture" ? <>{snapshot.fixtureSources.length ? <ul className="workbench-list">{snapshot.fixtureSources.map((source) => <li key={source.id}><span><strong>{source.title}</strong> {source.version}<small>{source.excerpt}</small></span></li>)}</ul> : <p>此示例项目没有资料来源投影。</p>}</> : extraLoading ? <p role="status">正在读取资料与版本来源…</p> : extra?.kind === "thesis" ? <>{extra.knowledge.length ? <ul className="workbench-list">{extra.knowledge.map(({ row, version, readFailed }) => <li key={row.id}><span><strong>{row.title}</strong> v{row.currentVersion}<small>{row.projectId === null ? "Workspace 资料" : "项目资料"} · {row.status}</small>{readFailed ? <small>版本来源暂时无法读取。</small> : version ? <><small>来源类型：{version.sourceKind} · 可用性：{version.availability} · SHA-256：{version.contentSha256}</small><small>引用字段：{Object.keys(version.sourceRefs).length ? JSON.stringify(version.sourceRefs) : "未登记"}</small></> : <small>当前版本未返回来源记录。</small>}</span></li>)}</ul> : <p>当前范围没有资料记录。</p>}{extra.knowledgeCount > extra.knowledge.length && <p className="helper-text">这里只展开前 {extra.knowledge.length} 项版本来源；其余资料请到资料页查看。</p>}</> : <p>{extraError ?? "资料尚未就绪。"}</p>}<Link className="text-link" to={`/projects/${id}/knowledge`}>打开项目资料</Link></section>
      <section className="workbench-section" aria-labelledby="workbench-drafts"><h2 id="workbench-drafts">下一步及进行中任务的草稿版本</h2>{snapshot.source === "fixture" ? <p>示例来源见上方；真实草稿版本需连接本机 API 后按任务读取。</p> : extraLoading ? <p role="status">正在读取任务产物版本…</p> : extra?.kind === "thesis" ? <>{extra.drafts.length ? <ul className="workbench-list">{extra.drafts.map((draft) => <li key={draft.versionId}><span><strong>{draft.title}</strong> v{draft.version}<small>{draft.taskTitle} · {draft.accepted ? "当前完成凭据已接受" : "未列入当前完成凭据"}</small></span><Link to={`/tasks/${draft.taskId}`}>查看版本</Link></li>)}</ul> : <p>已读取的重点任务没有产物版本；这不代表项目其他任务没有草稿。</p>}{extra.failedDraftReads > 0 && <p className="action-error" role="alert">有 {extra.failedDraftReads} 个任务的产物版本暂时无法读取。</p>}<p className="helper-text">本区只读取 State 下一步及当前已加载的进行中/待审任务，最多前 6 个；{extra.draftTaskCount > 6 || snapshot.nextCursor ? "其余任务及版本请继续加载任务或到任务页查看。" : "各任务的完整版本仍以任务详情为准。"}</p></> : <p>{extraError ?? "草稿尚未就绪。"}</p>}<Link className="text-link" to={`/projects/${id}/tasks`}>打开项目任务</Link></section>
    </>}
    {kind === "development" && <>
      <section className="workbench-section" aria-labelledby="workbench-capability"><h2 id="workbench-capability">Connection 能力声明</h2>{snapshot.source === "fixture" ? <p>示例模式没有真实 Connection 状态。</p> : extraLoading ? <p role="status">正在读取 Connection 与 Run…</p> : extra?.kind === "development" ? extra.connections.length ? <ul className="workbench-list">{extra.connections.map((item) => <li key={item.id}><span><strong>{item.id}</strong><small>状态：{item.status} · 能力：{item.capabilities.join("、") || "无"}</small></span></li>)}</ul> : <p>当前项目没有 Connection。</p> : <p>{extraError ?? "Connection 尚未就绪。"}</p>}<p className="helper-text">能力声明不等于 Permission 已准许，也不表示工具已经实际连通。</p><Link className="text-link" to={`/projects/${id}/connections`}>配置项目连接与权限</Link></section>
      <section className="workbench-section" aria-labelledby="workbench-runs"><h2 id="workbench-runs">Run 与待审</h2>{snapshot.source === "fixture" ? <p>示例模式不创建真实 Run 或审批。</p> : extraLoading ? <p role="status">正在读取 Run 与待审…</p> : extra?.kind === "development" ? <>{extra.runs.length ? <ul className="workbench-list">{extra.runs.map((item) => <li key={item.id}><span><strong>{item.taskTitle}</strong><small>Run：{item.id} · {item.run ? `状态：${item.run.status}` : "状态暂不可读取"}</small></span><Link to={`/runs/${item.id}`}>查看 Run</Link></li>)}</ul> : <p>当前已加载的任务没有关联 Run。</p>}{extra.runCount > extra.runs.length && <p className="helper-text">这里只展开前 {extra.runs.length} 个 Run；其他任务请继续加载或到任务页查看。</p>}{extra.reviews.length ? <ul className="workbench-list">{extra.reviews.map((review) => <li key={review.id}><span><strong>{review.kind}</strong><small>待审 {review.id} · {review.reason}</small></span><Link to="/reviews">前往待审</Link></li>)}</ul> : <p>当前没有项目范围内的待审记录。</p>}</> : <p>{extraError ?? "Run 与待审尚未就绪。"}</p>}<Link className="text-link" to="/reviews">打开待审入口</Link></section>
      <section className="workbench-section" aria-labelledby="workbench-tools"><h2 id="workbench-tools">变化集与检查</h2><p>真实 Git diff、受控测试和 Coding CLI 尚未接入此工作台，当前不可用。这里不生成变化集或检查结果。</p></section>
    </>}
  </div><ResponsiveRail label="查看工作台状态" title="项目事实"><div className="rail-content"><h2>{snapshot.title}</h2><p className="rail-intro">{snapshot.source === "live" ? "本机 API 当前查询投影" : "仅供预览的示例事实"}</p><section className="rail-section"><h3>项目状态</h3><dl className="rail-definition-list"><div><dt>项目类型</dt><dd>{typeLabel(snapshot.projectType)}</dd></div><div><dt>阶段</dt><dd>{phaseLabel(snapshot.phaseKey)}</dd></div><div><dt>State 修订</dt><dd>v{snapshot.stateRevision}</dd></div></dl></section><section className="rail-section"><h3>已有入口</h3><Link className="secondary-button secondary-button--wide" to={`/projects/${id}`}>返回原项目页</Link><Link className="secondary-button secondary-button--wide" to={`/projects/${id}/tasks`}>项目任务</Link><Link className="secondary-button secondary-button--wide" to={`/projects/${id}/knowledge`}>项目资料</Link></section><p className="helper-text">任务与执行事实在此只读；默认视图由上方显式配置，按独立 View 修订保存。</p></div></ResponsiveRail></div></section>;
}
