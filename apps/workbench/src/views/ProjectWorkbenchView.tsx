import { reviewReasonText } from "../components/ReviewDecisionPanel";
import { useEffect, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { BookOpen, FileText, MessageSquareText, RotateCcw } from "lucide-react";
import type {
  RelayApiClient, RelayGatewayConnection, RelayKnowledge, RelayKnowledgeVersion,
  RelayReview, RelayRun, RelayTaskSummary
} from "../api/relayClient";
import ProjectNav from "../components/ProjectNav";
import ViewConfigurationPanel from "../components/ViewConfigurationPanel";
import ResponsiveRail from "../components/ResponsiveRail";
import StatusChip from "../components/StatusChip";
import ArtifactReaderPanel from "../components/ArtifactReaderPanel";
import { runLabels } from "../components/RunControlPanel";
import { WorkbenchDocumentReader, WorkbenchRunEvidence, WorkbenchTaskFacts,
  type WorkbenchReadingTarget } from "../components/WorkbenchReadingPanels";
import { fixtureAdapter } from "../fixtures/fixtureAdapter";
import { fixtureModeFromQuery } from "../lib/fixtureMode";
import { phaseLabel, projectTypeLabels, reviewKindLabels } from "../lib/labels";
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
  readonly artifactId: string;
  readonly sha256: string | null;
  readonly latest: boolean;
  readonly title: string | null;
  readonly version: string;
  readonly taskId: string | null;
  readonly sourceRef: string;
}
interface Snapshot {
  readonly client: RelayApiClient | null;
  readonly source: "live" | "fixture";
  readonly projectId: string;
  readonly title: string;
  readonly archivedAt: string | null;
  readonly projectType: string;
  readonly phaseKey: string;
  readonly stateRevision: string;
  readonly fixtureGoal: string | null;
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
  readonly sha256: string;
  readonly latest: boolean;
}
interface ReadingExtra { readonly knowledge: readonly ThesisKnowledge[];
      readonly knowledgeCount: number; readonly drafts: readonly ThesisDraft[];
      readonly draftTaskCount: number; readonly failedDraftReads: number }
type Extra = ReadingExtra & (
  | { readonly kind: "thesis" }
  | { readonly kind: "development"; readonly connections: readonly RelayGatewayConnection[];
      readonly reviews: readonly RelayReview[];
      readonly runs: readonly { readonly id: string; readonly taskId: string; readonly taskTitle: string; readonly run: RelayRun | null }[];
      readonly runCount: number });

function taskFromLive(task: RelayTaskSummary): WorkbenchTask {
  return { id: task.id, title: task.title, status: task.status,
    revision: task.revision, runId: task.executorRunId };
}

async function loadLive(client: RelayApiClient, id: string): Promise<Snapshot> {
  const [project, state, page] = await Promise.all([
    client.getProject(id), client.getProjectState(id), client.getProjectTasksPage(id)
  ]);
  if (project.id !== id || state.projectId !== id) throw new Error("项目工作台查询返回了其他项目的事实。");
  if (page.items.some((task) => task.projectId !== id)) throw new Error("项目任务查询返回了其他项目的事实。");
  const listedNext = page.items.find((task) => task.id === state.nextActionTaskId);
  const nextDetail = state.nextActionTaskId !== null && listedNext === undefined
    ? await client.getTask(state.nextActionTaskId).catch(() => null) : null;
  const artifacts = await Promise.all(state.selectedArtifactVersionRefs.map(async (ref): Promise<WorkbenchArtifact> => {
    const artifact = await client.getArtifact(ref.artifactId).catch(() => null);
    const matching = artifact?.id === ref.artifactId &&
      artifact.versions.some((version) => version.artifactVersionId === ref.artifactVersionId) ? artifact : null;
    return { id: ref.artifactVersionId, artifactId: ref.artifactId,
      sha256: matching?.versions.find((version) => version.artifactVersionId === ref.artifactVersionId)?.sha256 ?? null,
      latest: matching?.latestVersionId === ref.artifactVersionId, title: matching?.title ?? null,
      version: ref.versionNumber, taskId: matching?.taskId ?? null, sourceRef: ref.sourceRef };
  }));
  return { client, source: "live", projectId: id, title: project.title, archivedAt: project.archivedAt,
    projectType: project.projectType,
    phaseKey: state.phaseKey, stateRevision: state.revision, fixtureGoal: null,
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
  return { client: null, source: "fixture", projectId: id, title: project.title, archivedAt: null,
    projectType: project.projectType,
    phaseKey: project.phase, stateRevision: project.stateRevision, fixtureGoal: project.goal,
    nextAction: project.nextAction === null ? null : { id: null, title: project.nextAction },
    tasks: result.tasks.map((task) => ({ id: task.id, title: task.title, status: task.status,
      revision: task.revision, runId: null })), nextCursor: null,
    artifacts: skill?.sources.filter((source) => source.kind === "artifact").map((source) => ({
      id: source.id, artifactId: source.id, sha256: null, latest: false,
      title: source.title, version: source.version, taskId: null, sourceRef: source.id
    })) ?? [],
    completedHighlights: [], fixtureSources: skill?.sources.filter((source) => source.kind === "note" || source.kind === "artifact")
      .map((source) => ({ id: source.id, title: source.title, version: source.version, excerpt: source.excerpt })) ?? [] };
}

async function loadThesis(client: RelayApiClient, snapshot: Snapshot): Promise<ReadingExtra & { readonly kind: "thesis" }> {
  const knowledge = await client.getKnowledge(snapshot.projectId);
  const visibleKnowledge = knowledge.filter((item) => item.projectId === snapshot.projectId || item.projectId === null).slice(0, 6);
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
  if (next !== null && next !== undefined && snapshot.nextAction?.title !== null && !draftTasks.some((task) => task.id === next)) {
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
      if (artifact.taskId !== task.id) return [];
      return [...artifact.versions].sort((a, b) => Number(b.artifactVersionId === artifact.latestVersionId) - Number(a.artifactVersionId === artifact.latestVersionId))
        .map((version) => ({ taskId: task.id, taskTitle: task.title, artifactId: artifact.id,
          title: artifact.title, versionId: version.artifactVersionId, version: version.versionNumber,
          sha256: version.sha256, latest: version.artifactVersionId === artifact.latestVersionId,
          accepted: artifacts.currentAcceptedVersionIds.includes(version.artifactVersionId) }));
    }) ?? []);
  return { kind: "thesis", knowledge: versions, knowledgeCount: knowledge.length, drafts,
    draftTaskCount: draftTasks.length, failedDraftReads: draftResults.filter((item) => item.failed).length };
}

async function loadDevelopment(client: RelayApiClient, snapshot: Snapshot): Promise<Extra> {
  const runTasks = snapshot.tasks.filter((task) => task.runId !== null);
  const [connections, reviews, runs, reading] = await Promise.all([
    client.getGatewayConnections(snapshot.projectId), client.getReviews(),
    Promise.all(runTasks.slice(0, 8).map(async (task) => ({ id: task.runId!, taskId: task.id, taskTitle: task.title,
      run: await client.getRun(task.runId!).then((run) => run.taskId === task.id && run.id === task.runId ? run : null).catch(() => null) }))),
    loadThesis(client, snapshot)
  ]);
  return { ...reading, kind: "development", connections, reviews: reviews.filter((review) => review.projectId === snapshot.projectId && review.status === "OPEN"),
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
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedReadingKey, setSelectedReadingKey] = useState<string | null>(null);
  const epoch = useRef(0);

  useEffect(() => {
    const request = ++epoch.current;
    setSnapshot(null); setLoading(true); setError(null); setPageError(null); setPageLoading(false);
    setSelectedTaskId(null); setSelectedReadingKey(null);
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
    if (!snapshot || snapshot.projectId !== id || snapshot.client !== client || !client || kind === null) { setExtraLoading(false); return; }
    setExtraLoading(true);
    void (kind === "development" ? loadDevelopment(client, snapshot) : loadThesis(client, snapshot))
      .then((result) => { if (active) setExtra(result); })
      .catch((caught: unknown) => { if (active) setExtraError(describeLiveError(caught).message); })
      .finally(() => { if (active) setExtraLoading(false); });
    return () => { active = false; };
  }, [snapshot, client, kind, id]);

  useEffect(() => { setSelectedReadingKey(null); }, [kind]);

  async function loadMore() {
    if (!client || !snapshot?.nextCursor || pageLoading) return;
    const cursor = snapshot.nextCursor;
    const request = epoch.current;
    setPageLoading(true); setPageError(null);
    try {
      const page = await client.getProjectTasksPage(id, cursor);
      if (request !== epoch.current) return;
      if (page.items.some((task) => task.projectId !== id)) throw new Error("后续任务页返回了其他项目的事实。");
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
  if (loading || (snapshot !== null && (snapshot.projectId !== id || snapshot.client !== client))) return <section className="page-state" aria-live="polite"><h1>正在读取项目工作台</h1><p>{client ? "正在读取本机 API 的项目事实。" : "正在读取示例数据。"}</p></section>;
  if (error) return <section className="page-state page-state--error" role="alert"><h1>暂时无法读取项目工作台</h1><p>{error}</p><button className="secondary-button" type="button" onClick={() => setReloadKey((value) => value + 1)}><RotateCcw aria-hidden="true" />重新读取</button></section>;
  if (!snapshot) return <section className="page-state"><h1>没有这个项目</h1><p>当前数据来源中没有该项目，页面不会自行创建项目或复制其他项目资料。</p><Link className="text-link" to="/projects">返回项目入口</Link></section>;

  const focusedTaskId = selectedTaskId ?? snapshot.nextAction?.id ?? snapshot.tasks[0]?.id ?? null;
  const focusedTask = snapshot.tasks.find((task) => task.id === focusedTaskId) ?? null;
  const focusedTitle = focusedTask?.title ?? snapshot.nextAction?.title ?? "选择一个项目任务";
  const stateDrafts = snapshot.artifacts.flatMap((artifact) => artifact.taskId !== null && artifact.sha256 !== null && artifact.title !== null ? [{
    taskId: artifact.taskId, taskTitle: snapshot.tasks.find((task) => task.id === artifact.taskId)?.title ?? "State 当前选用产物",
    artifactId: artifact.artifactId, title: artifact.title, versionId: artifact.id, version: artifact.version,
    sha256: artifact.sha256, latest: artifact.latest, accepted: null
  }] : []);
  const drafts = [...(extra?.drafts ?? []), ...stateDrafts.filter((draft) => !extra?.drafts.some((item) => item.versionId === draft.versionId))];
  const readings: readonly { key: string; target: WorkbenchReadingTarget }[] = [
    ...drafts.map((draft) => ({ key: `artifact:${draft.versionId}`,
      target: { kind: "artifact" as const, id: draft.versionId, artifactId: draft.artifactId,
        taskId: draft.taskId, title: draft.title, version: draft.version, sha256: draft.sha256 } })),
    ...(kind === "development" ? [] : (extra?.knowledge ?? []).flatMap(({ row, version }) => version ? [{
      key: `knowledge:${row.id}:${version.version}`,
      target: { kind: "knowledge" as const, id: row.id, title: row.title, sourceProjectId: row.projectId,
        version: version.version, sha256: version.contentSha256 }
    }] : []))
  ];
  const defaultReading = readings.find((item) => snapshot.artifacts.some((ref) => ref.id === item.target.id))
    ?? readings[0] ?? null;
  const reading = selectedReadingKey === null ? defaultReading : readings.find((item) => item.key === selectedReadingKey) ?? null;
  const fixtureReading = snapshot.fixtureSources.find((item) => item.id === selectedReadingKey)
    ?? snapshot.fixtureSources[0] ?? null;
  const development = extra?.kind === "development" ? extra : null;
  const selectedRun = development?.runs.find((run) => run.taskId === (reading?.target.kind === "artifact" ? reading.target.taskId : focusedTaskId))
    ?? null;
  const assistTaskId = kind === "general" ? focusedTaskId : reading?.target.kind === "artifact" ? reading.target.taskId : focusedTaskId;
  const assistTaskTitle = snapshot.tasks.find((task) => task.id === assistTaskId)?.title
    ?? (snapshot.nextAction?.id === assistTaskId ? snapshot.nextAction?.title : null)
    ?? "所选产物关联任务（标题待读取）";
  const assistHref = assistTaskId ? `/tasks/${assistTaskId}?skill=assist` : `/projects/${id}?skill=assist`;
  const taskPager = <div className="workbench-page-note">
    {snapshot.source === "live" && <p className="helper-text">当前已读取 {snapshot.tasks.length} 条；{snapshot.nextCursor ? "还有后续页，当前列表并非项目全量。" : "服务端未返回下一页游标。"}</p>}
    {pageError && <p className="action-error" role="alert">{pageError}</p>}
    {snapshot.nextCursor && <button className="secondary-button" type="button" disabled={pageLoading} onClick={() => void loadMore()}>{pageLoading ? "正在读取下一页" : "继续加载任务"}</button>}
  </div>;
  const taskDirectory = <section className="workbench-section" aria-labelledby="workbench-tasks"><h2 id="workbench-tasks">项目任务</h2>
    {snapshot.tasks.length === 0 ? <p>{snapshot.nextCursor ? "本页暂无任务，可继续读取。" : "当前项目没有任务。"}</p> :
      <ul className="workbench-list workbench-task-directory">{snapshot.tasks.map((task) => <li key={task.id}>
        <button type="button" className={task.id === focusedTaskId ? "workbench-task-choice workbench-task-choice--active" : "workbench-task-choice"}
          aria-pressed={task.id === focusedTaskId} onClick={() => { setSelectedTaskId(task.id); setSelectedReadingKey(null); }}>{task.title}</button>
        <StatusChip status={task.status} /><small>v{task.revision}</small><Link className="text-link" to={`/tasks/${task.id}`}>打开任务</Link>
      </li>)}</ul>}{taskPager}</section>;
  const knowledgeDirectory = <section className="workbench-directory-group"><h2>资料与引用证据</h2>
    {snapshot.source === "fixture" ? <>{snapshot.fixtureSources.map((source) => <button className={fixtureReading?.id === source.id ? "workbench-source-choice workbench-source-choice--active" : "workbench-source-choice"}
      type="button" key={source.id} aria-pressed={fixtureReading?.id === source.id} onClick={() => setSelectedReadingKey(source.id)}>
      <BookOpen aria-hidden="true" /><span><strong>{source.title} {source.version}</strong><small>{source.excerpt}</small></span></button>)}</> :
      extraLoading ? <p role="status">正在读取资料与版本来源…</p> : extra ? <>
        {extra.knowledge.length ? extra.knowledge.map(({ row, version, readFailed }) => <div key={row.id}>
          <button type="button" className={reading?.target.kind === "knowledge" && reading.target.id === row.id ? "workbench-source-choice workbench-source-choice--active" : "workbench-source-choice"}
            disabled={!version || readFailed} aria-pressed={reading?.target.kind === "knowledge" && reading.target.id === row.id}
            onClick={() => setSelectedReadingKey(`knowledge:${row.id}:${version?.version}`)}>
            <BookOpen aria-hidden="true" /><span><strong>{row.title} · v{row.currentVersion}</strong><small>{version?.excerpt ?? (readFailed ? "版本来源暂时无法读取。" : "当前版本未返回来源记录。")}</small></span>
          </button>
          {version && <details className="workbench-source-metadata"><summary>来源与引用</summary><p>{row.projectId === null ? "Workspace 资料" : "项目资料"} · {row.status}</p><p>来源类型：{version.sourceKind} · 可用性：{version.availability}</p><p>SHA-256：{version.contentSha256}</p><p>引用字段：{Object.keys(version.sourceRefs).length ? JSON.stringify(version.sourceRefs) : "未登记"}</p></details>}
        </div>) : <p>当前范围没有资料记录。</p>}
        {extra.knowledgeCount > extra.knowledge.length && <p className="helper-text">这里只展开前 {extra.knowledge.length} 项版本来源；其余资料请到资料页查看。</p>}
      </> : <p>{extraError ?? "资料尚未就绪。"}</p>}
    <Link className="text-link" to={`/projects/${id}/knowledge`}>打开项目资料</Link>
  </section>;
  const draftDirectory = <section className="workbench-directory-group"><h2>{kind === "development" ? "产物版本" : "草稿版本"}</h2>
    {snapshot.source === "fixture" ? <p>真实草稿版本需连接本机 API 后按任务读取。</p> : <>
      {extraLoading && <p role="status">正在读取任务产物版本…</p>}
      {drafts.length ? drafts.map((draft) => <button className={reading?.target.kind === "artifact" && reading.target.id === draft.versionId ? "workbench-source-choice workbench-source-choice--active" : "workbench-source-choice"}
        type="button" key={draft.versionId} aria-pressed={reading?.target.kind === "artifact" && reading.target.id === draft.versionId} onClick={() => setSelectedReadingKey(`artifact:${draft.versionId}`)}>
        <FileText aria-hidden="true" /><span><strong>{draft.title} · v{draft.version}</strong><small>{draft.taskTitle}</small><small>{draft.latest ? "最新版本" : "历史版本"} · {draft.accepted === null ? "当前完成凭据关联未核对" : draft.accepted ? "当前完成凭据已接受" : "未列入当前完成凭据"}</small></span>
      </button>) : !extraLoading && <p>已读取的重点任务没有产物版本；这不代表项目其他任务没有草稿。</p>}
      {extra && extra.failedDraftReads > 0 && <p className="action-error" role="alert">有 {extra.failedDraftReads} 个任务的产物版本暂时无法读取。</p>}
      <p className="helper-text">本区包含 State 当前选用版本，另读取 State 下一步及当前已加载的进行中/待审任务，最多前 6 个；{(extra?.draftTaskCount ?? 0) > 6 || snapshot.nextCursor ? "其余任务及版本请继续加载任务或到任务页查看。" : "各任务的完整版本仍以任务详情为准。"}</p>
      {extraError && <p className="action-error" role="alert">{extraError}</p>}
    </>}
  </section>;

  return <section className={`skill-page project-workbench project-workbench--${kind}`}><div className="page-layout"><div className="page-primary">
    <div className="workbench-context-bar"><p className="eyebrow">{snapshot.title}</p>
      <nav className="subnav" aria-label="工作台视图">{kinds.map((item) => <Link key={item.kind} className={`subnav-item${item.kind === kind ? " subnav-item--active" : ""}`} aria-current={item.kind === kind ? "page" : undefined} to={`/projects/${id}/workbench/${item.kind}${snapshot.source === "fixture" && query.toString() ? `?${query.toString()}` : ""}`}>{item.label}</Link>)}</nav>
      <button className="workbench-refresh" type="button" aria-label="刷新事实" onClick={() => setReloadKey((value) => value + 1)}><RotateCcw aria-hidden="true" /></button>
    </div>
    <div className="workbench-heading"><div><h1>{kind === "general" ? focusedTitle : kind === "thesis" ? "从资料到论证" : "审查本轮变更"}</h1>
      <p className="workbench-subtitle">{kind === "general" ? snapshot.fixtureGoal ?? "围绕当前任务，核对目标、产物与下一步。" : kind === "thesis" ? "为下一版草稿选择可追溯的依据。" : "核对确切产物版本与运行证据，再到原任务处理。"}</p>
      <p className="workbench-scope-note">{snapshot.source === "live" ? "只读工作视图" : "示例数据预览"} · 项目类型：{typeLabel(snapshot.projectType)} · 当前阶段：{phaseLabel(snapshot.phaseKey)}</p>
    </div></div>
    {kind === "general" && <>
      <div className="workbench-next-context"><span id="workbench-next">{snapshot.nextAction?.id === focusedTaskId && selectedTaskId === null ? "项目下一步" : "当前浏览任务"}</span>
        <span>{focusedTitle}{focusedTaskId && <Link className="text-link" to={`/tasks/${focusedTaskId}`}>打开任务</Link>}</span>
        {snapshot.nextAction && snapshot.nextAction.id !== focusedTaskId ? <small>项目下一步：{snapshot.nextAction.title ?? "目标任务暂不可读取"}{snapshot.nextAction.id && <Link className="text-link" to={`/tasks/${snapshot.nextAction.id}`}>打开下一步</Link>}</small> : !snapshot.nextAction && <small>Project State 尚未指定下一步。</small>}
      </div>
      <details className="workbench-detail-section"><summary>选择项目任务 · {snapshot.tasks.length}{snapshot.nextCursor ? " · 还有后续页" : ""}</summary>{taskDirectory}</details>
      {client && focusedTaskId ? <>
        <details className="workbench-detail-section"><summary>任务目标、验收与执行概览</summary><WorkbenchTaskFacts key={`${id}:${focusedTaskId}:${reloadKey}`} client={client} projectId={id} taskId={focusedTaskId} /></details>
        {selectedReadingKey !== null && reading ? <><div className="workbench-reading-label"><span>正在阅读：{reading.target.title} · v{reading.target.version}</span><button className="text-button" type="button" onClick={() => setSelectedReadingKey(null)}>回到任务产物</button></div><WorkbenchDocumentReader key={`${id}:general:${reloadKey}`} client={client} projectId={id} target={reading.target} /></>
          : <ArtifactReaderPanel key={`${id}:${focusedTaskId}:${reloadKey}:reader`} client={client} taskId={focusedTaskId} projectId={id}
            selectedVersionId={snapshot.artifacts.find((artifact) => artifact.taskId === focusedTaskId)?.id ?? null} draft={null} />}
      </> : snapshot.source === "live" ? <p>当前项目没有可供阅读的任务，可到项目任务页创建或选择。</p> : <>
        {snapshot.artifacts.map((artifact) => <div className="workbench-artifact-card" key={artifact.id}><FileText aria-hidden="true" /><div><strong>{artifact.title}</strong><small>{artifact.version} · 示例来源</small></div><span>示例摘要</span></div>)}
        <section className="workbench-section workbench-objective"><h2>任务目标</h2><p>{snapshot.fixtureGoal ?? "选择任务后，可在原任务页核对目标。"}</p><small>上方目标来自示例项目，仅用于布局预览。</small></section>
        <section className="workbench-section"><h2>执行步骤</h2><p>示例未登记真实 Run 步骤；选择下方任务可进入已有详情。</p></section>
      </>}
      <details className="workbench-detail-section"><summary>项目当前选用产物与完成引用</summary>
        <section className="workbench-section" aria-labelledby="workbench-artifacts"><h2 id="workbench-artifacts">{snapshot.source === "live" ? "项目当前选用产物" : "示例产物来源"}</h2>
          {snapshot.artifacts.length ? <ul className="workbench-list">{snapshot.artifacts.map((artifact) => <li key={artifact.id}><span><strong>{artifact.title ?? "产物标题暂不可读"}</strong> v{artifact.version}<small>来源：{artifact.sourceRef}</small></span>{artifact.taskId && <Link to={`/tasks/${artifact.taskId}?tab=artifacts`}>查看任务产物</Link>}</li>)}</ul> : <p>当前视图没有由 Project State 选用的产物版本。</p>}
        </section>
        {snapshot.source === "live" && <section className="workbench-section" aria-labelledby="workbench-completions"><h2 id="workbench-completions">State 当前完成引用</h2>{snapshot.completedHighlights.length ? <ul className="workbench-list">{snapshot.completedHighlights.map((ref) => <li key={ref.completionId}><span>Task {ref.taskId} · 当时验收 v{ref.acceptanceRevision}</span><Link to={`/completion-records/${ref.completionId}`}>查看完成凭据</Link></li>)}</ul> : <p>State 当前没有完成引用；历史凭据可从该任务 Activity 查阅。</p>}</section>}
      </details>
    </>}
    {kind !== "general" && <>
      <div className="workbench-reading-label"><span>{kind === "thesis" ? "资料与草稿" : "版本与执行证据"}</span><span>{reading?.target ? `正在阅读：${reading.target.title} · v${reading.target.version}` : snapshot.source === "fixture" ? "演示摘要 · 无真实正文" : "请选择确切版本"}</span></div>
      <div className="workbench-reading-desk" data-testid={`workbench-${kind}-desk`}>
        <aside className="workbench-source-directory" aria-label={kind === "thesis" ? "资料与草稿目录" : "产物版本目录"}>
          {kind === "thesis" && knowledgeDirectory}{draftDirectory}
        </aside>
        {client ? <WorkbenchDocumentReader key={`${id}:${kind}:${reloadKey}`} client={client} projectId={id} target={reading?.target ?? null} /> :
          <article className="workbench-paper workbench-paper--fixture"><header className="workbench-paper-heading"><span>示例资料摘要</span><span>仅供预览</span></header>
            {fixtureReading ? <><h2 className="workbench-document-title">{fixtureReading.title}</h2><p className="workbench-document-body">{fixtureReading.excerpt}</p><div className="workbench-paper-empty"><BookOpen aria-hidden="true" /><p>此处呈现已有示例摘要。连接本机 API 后可阅读确切资料或产物版本正文。</p></div></> : <div className="workbench-paper-empty"><FileText aria-hidden="true" /><h2>尚无示例正文</h2><p>本示例没有可供阅读的产物或来源。</p></div>}
          </article>}
      </div>
      {kind === "development" && <section className="workbench-section" aria-labelledby="workbench-runs"><h2 id="workbench-runs">Run 与待审</h2>
        {snapshot.source === "fixture" ? <p>示例模式不创建真实 Run 或审批。</p> : extraLoading ? <p role="status">正在读取 Run 与待审…</p> : development ? <>
          {development.runs.length ? <ul className="workbench-list">{development.runs.map((run) => <li key={run.id}><span><strong>{run.taskTitle}</strong><small>{run.run ? `状态：${runLabels[run.run.status] ?? "状态待核对"}` : "状态暂不可读取"}</small><details className="workbench-source-metadata"><summary>运行标识</summary><p>Run：{run.id} · {run.run?.status ?? "不可读取"}</p></details></span><Link to={`/runs/${run.id}`}>查看 Run</Link></li>)}</ul> : <p>当前已加载的任务没有关联 Run。</p>}
          {development.runCount > development.runs.length && <p className="helper-text">这里只展开前 {development.runs.length} 个 Run；其他任务请继续加载或到任务页查看。</p>}
        </> : <p>{extraError ?? "Run 与待审尚未就绪。"}</p>}
      </section>}
      {kind === "development" && <section className="workbench-section workbench-unavailable" aria-labelledby="workbench-tools"><h2 id="workbench-tools">变化集与检查</h2><p>真实 Git diff、受控测试和 Coding CLI 尚未接入此工作台，当前不可用。这里不生成变化集或检查结果。</p></section>}
      <details className="workbench-detail-section"><summary>项目任务与读取范围</summary>{taskDirectory}</details>
    </>}
    <details className="workbench-view-configuration" data-testid="workbench-view-configuration"><summary>默认视图与页面配置</summary>
      <ProjectNav projectId={id} active="workbench" />
      <p className="helper-text">上方切换仅供浏览。保存默认视图需明确提交；项目阶段仍由项目类型和服务端 State 决定，不会开始、暂停或改写任务与 Run。</p>
      <ViewConfigurationPanel client={client} projectId={id} browseKind={kind} projectArchivedAt={snapshot.archivedAt} />
    </details>
  </div><ResponsiveRail label={kind === "development" ? "查看运行证据与待审" : "打开 AI 辅助与资料"} title={kind === "development" ? "等待你的判断" : "AI 辅助"}><div className="rail-content workbench-assist-rail">
    <h2>{kind === "development" ? "等待你的判断" : "AI 辅助 · 只读建议"}</h2>
    <p className="rail-intro">{kind === "thesis" ? "基于明确选择的资料，讨论论证与草稿候选。" : kind === "development" ? "核对版本、检查和范围，再进入原业务入口。" : "围绕当前任务讨论、核对来源与整理下一步。"}</p>
    <div className="workbench-rail-context"><p>项目：{snapshot.title}</p>{assistTaskId && <p>任务：{assistTaskTitle}</p>}{kind !== "general" && reading?.target.kind === "artifact" && <small>Assist 目标为当前所读产物的归属任务。</small>}</div>
    {kind === "general" && <section className="rail-section"><h3>可参考的来源</h3>{knowledgeDirectory}</section>}
    {kind === "thesis" && <section className="rail-section"><h3>当前阅读</h3><p>{reading ? `${reading.target.title} · v${reading.target.version}` : fixtureReading ? `${fixtureReading.title} ${fixtureReading.version} · 示例` : "尚未选择"}</p><p className="helper-text">阅读选择仅影响本页。发送给 AI 的来源需在 Assist 中明确选择，版本由原入口固定。</p></section>}
    {kind === "development" && <>
      {client && selectedRun?.run && <WorkbenchRunEvidence key={`${id}:${selectedRun.id}:${reloadKey}`} client={client} projectId={id} taskId={selectedRun.taskId} runId={selectedRun.id} selectedVersion={reading?.target.kind === "artifact" ? { id: reading.target.id, sha256: reading.target.sha256 } : null} />}
      <section className="rail-section"><h3>项目待审</h3>{development?.reviews.length ? development.reviews.map((review) => <div className="workbench-review-card" key={review.id}><strong>{reviewKindLabels[review.kind]}</strong><p>{reviewReasonText(review.reason)}</p><small>请求 v{review.revision}</small><Link className="text-link" to={`/reviews?id=${review.id}`}>前往待审</Link><details className="workbench-source-metadata"><summary>请求身份</summary><p>{review.id}</p></details></div>) : <p>{snapshot.source === "fixture" ? "示例没有真实待审。" : extraLoading ? "正在读取待审…" : extraError ?? "当前没有项目范围内的待审记录。"}</p>}</section>
      <section className="rail-section"><h3>Connection 能力声明</h3>{development?.connections.length ? development.connections.map((item) => <div className="workbench-connection" key={item.id}><strong>{item.id}</strong><small>状态：{item.status} · 能力：{item.capabilities.join("、") || "无"}</small></div>) : <p>{snapshot.source === "fixture" ? "示例模式没有真实 Connection 状态。" : extraLoading ? "正在读取 Connection…" : extraError ?? "当前项目没有 Connection。"}</p>}<p className="helper-text">能力声明不等于 Permission 已准许，也不表示工具已经实际连通。</p><Link className="text-link" to={`/projects/${id}/connections`}>配置项目连接与权限</Link></section>
    </>}
    <section className="rail-section workbench-assist-entry"><h3>{kind === "thesis" ? "请求候选草稿" : "继续讨论"}</h3><p>在已有 Assist 中选择资料、发送消息并核对候选。</p>
      <Link className="primary-button" to={assistHref}><MessageSquareText aria-hidden="true" />{kind === "thesis" ? "打开 Assist 请求候选" : "打开 AI 辅助"}</Link>
      <p className="helper-text">候选需人工保存为产物版本；打开入口不会自动生成、保存或完成任务。</p>
    </section>
    <details className="workbench-detail-section"><summary>项目事实与已有入口</summary><section className="rail-section"><h3>项目状态</h3><dl className="rail-definition-list"><div><dt>项目类型</dt><dd>{typeLabel(snapshot.projectType)}</dd></div><div><dt>阶段</dt><dd>{phaseLabel(snapshot.phaseKey)}</dd></div><div><dt>State 修订</dt><dd>v{snapshot.stateRevision}</dd></div></dl></section>
      <section className="rail-section"><h3>已有入口</h3><Link className="secondary-button secondary-button--wide" to={`/projects/${id}`}>返回原项目页</Link><Link className="secondary-button secondary-button--wide" to={`/projects/${id}/tasks`}>项目任务</Link><Link className="secondary-button secondary-button--wide" to={`/projects/${id}/knowledge`}>项目资料</Link></section>
    </details>
  </div></ResponsiveRail></div></section>;
}
