import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { CheckCircle2, ChevronRight, Circle, CircleEllipsis, FileText, Info, RotateCcw, TriangleAlert } from "lucide-react";
import ResponsiveRail from "../components/ResponsiveRail";
import SourceDetailDialog from "../components/SourceDetailDialog";
import type { RelayApiClient, RelayDecision, RelayProject, RelayProjectState, RelayReview, RelayTaskSummary } from "../api/relayClient";
import type { RelayProjectGoal } from "../api/blueprintDtos";
import { fixtureAdapter } from "../fixtures/fixtureAdapter";
import { fixtureModeFromQuery } from "../lib/fixtureMode";
import { phaseLabel, projectTypeLabels, taskStatusLabels } from "../lib/labels";
import { describeLiveError } from "../lib/liveErrors";
import { useRelayConnection } from "../lib/relayConnection";
import type { ProjectType } from "../types";
import type { ProjectSnapshot, ResumeProgressItem, ResumeSuggestion, SourceReference } from "../types";

const resumeSourceIds = ["project-state-v4", "task-list-v1", "literature-review-v3", "acceptance-v2", "review-record-v1"];

export default function ProjectResumeView() {
  const { id = "" } = useParams();
  const connection = useRelayConnection();
  return connection.client ? <LiveProjectResumeView key={`${connection.epoch}:${id}`} id={id} client={connection.client} />
    : <FixtureProjectResumeView />;
}

interface LiveSnapshot {
  readonly queriedAt: string;
  readonly project: RelayProject;
  readonly state: RelayProjectState;
  readonly goals: readonly RelayProjectGoal[] | null;
  readonly tasks: readonly RelayTaskSummary[];
  readonly nextCursor: string | null;
  readonly taskReadFailed: boolean;
  readonly nextAction: RelayTaskSummary | null;
  readonly reviews: readonly RelayReview[] | null;
  readonly decisions: readonly RelayDecision[] | null;
  readonly selectedArtifacts: readonly { readonly versionId: string; readonly version: string;
    readonly title: string | null; readonly taskId: string | null; readonly sourceRef: string }[];
}

async function readLiveSnapshot(client: RelayApiClient, id: string): Promise<LiveSnapshot> {
  const [project, state] = await Promise.all([client.getProject(id), client.getProjectState(id)]);
  if (project.id !== id || state.projectId !== id) {
    throw new Error("恢复速览查询返回了其他项目的事实。");
  }
  const [goalResult, pageResult, reviewResult, decisionResult] = await Promise.allSettled([
    client.getProjectGoals(id), client.getProjectTasksPage(id), client.getReviews(), client.getDecisions(id)
  ]);
  const page = pageResult.status === "fulfilled" && pageResult.value.items.every((task) => task.projectId === id)
    ? pageResult.value : null;
  const listed = page?.items.find((task) => task.id === state.nextActionTaskId) ?? null;
  const detail = state.nextActionTaskId && !listed ? await client.getTask(state.nextActionTaskId).catch(() => null) : null;
  const nextAction = listed ?? (detail?.projectId === id ? detail : null);
  const selectedArtifacts = await Promise.all(state.selectedArtifactVersionRefs.map(async (ref) => {
    const artifact = await client.getArtifact(ref.artifactId).catch(() => null);
    const matching = artifact?.versions.some((version) => version.artifactVersionId === ref.artifactVersionId) ? artifact : null;
    return { versionId: ref.artifactVersionId, version: ref.versionNumber, title: matching?.title ?? null,
      taskId: matching?.taskId ?? null, sourceRef: ref.sourceRef };
  }));
  return { queriedAt: new Date().toISOString(), project, state,
    goals: goalResult.status === "fulfilled" ? goalResult.value : null,
    tasks: page?.items ?? [], nextCursor: page?.nextCursor ?? null, taskReadFailed: page === null, nextAction,
    reviews: reviewResult.status === "fulfilled" ? reviewResult.value.filter((review) => review.projectId === id) : null,
    decisions: decisionResult.status === "fulfilled" ? decisionResult.value.filter((decision) => decision.projectId === id) : null,
    selectedArtifacts };
}

function LiveProjectResumeView({ id, client }: { id: string; client: RelayApiClient }) {
  const [snapshot, setSnapshot] = useState<LiveSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const requestVersion = useRef(0);
  useEffect(() => {
    const request = ++requestVersion.current;
    setSnapshot(null); setLoading(true); setError(null);
    void readLiveSnapshot(client, id).then((next) => {
      if (request === requestVersion.current) setSnapshot(next);
    }).catch((caught: unknown) => {
      if (request === requestVersion.current) setError(describeLiveError(caught).message);
    }).finally(() => { if (request === requestVersion.current) setLoading(false); });
    return () => { requestVersion.current++; };
  }, [client, id, reload]);

  if (loading) return <section className="page-state" role="status"><p className="eyebrow">继续这个项目</p><h1>正在读取当前项目事实</h1><p>只读查询不会开始或恢复执行。</p></section>;
  if (error || !snapshot) return <section className="page-state page-state--error" role="alert"><p className="eyebrow">继续这个项目</p><h1>暂时无法读取当前事实</h1><p>{error ?? "项目事实不可用。"}</p><button className="secondary-button" type="button" onClick={() => setReload((value) => value + 1)}>重新读取</button></section>;
  const { project, state, goals, tasks, nextAction, reviews, decisions, selectedArtifacts } = snapshot;
  const type = project.projectType in projectTypeLabels
    ? projectTypeLabels[project.projectType as ProjectType] : project.projectType;
  return <section className="skill-page" data-testid="project-resume-live"><div className="page-layout"><div className="page-primary">
    <p className="eyebrow">真实项目 · {project.id}</p><h1>当前事实速览</h1>
    <p className="page-lede">{project.title} · {type} · {phaseLabel(state.phaseKey)} · State revision v{state.revision}</p>
    <p className="metadata-row">本次查询于 <time dateTime={snapshot.queriedAt}>{new Date(snapshot.queriedAt).toLocaleString("zh-CN")}</time> 完成；各来源可能在查询期间变化，非原子项目快照。</p>
    <p className="helper-text">这是现时只读查询；没有上次查看基线，不显示变化对比、进度判断或模型建议，也不会启动 Task 或 Run。</p>
    <button className="secondary-button" type="button" onClick={() => setReload((value) => value + 1)}><RotateCcw aria-hidden="true" />刷新当前事实</button>
    <section className="resume-section"><h2>项目目标</h2><p className="helper-text">项目标题来自 Project；以下仅列已关联的 Goal，不把标题解释为已确认目标。</p>
      {goals === null ? <p className="warning-callout">Goal 关系本次读取失败，目标范围待核对。</p>
        : goals.length ? <ul className="run-list">{goals.map((goal) => <li key={goal.goalId}>{goal.title} · {goal.status} · Goal v{goal.revision}<small>来源 Goal {goal.goalId}，由 Project Goal 关系查询确认。</small></li>)}</ul>
          : <p className="helper-text">当前没有关联 Goal；不推断项目没有目标。</p>}</section>
    <section className="resume-section"><h2>State 指定的下一步</h2>{state.nextActionTaskId === null
      ? <p className="helper-text">Project State 尚未指定下一步 Task。</p>
      : nextAction ? <p><Link className="inline-link" to={`/tasks/${nextAction.id}`}>{nextAction.title}</Link> · {taskStatusLabels[nextAction.status]} · Task revision v{nextAction.revision}</p>
        : <p className="helper-text">State 引用 Task {state.nextActionTaskId}，当前单读未能确认其详情；不以列表中其他任务替代。</p>}</section>
    <section className="resume-section"><h2>当前任务</h2>{snapshot.taskReadFailed ? <p className="warning-callout">任务列表本次读取失败或项目范围不符，无法判断任务总量；State 下一步仍单独核对。</p> : <p className="helper-text">已读取本项目任务首分页 {tasks.length} 项{snapshot.nextCursor ? "；还有后续页" : "；本次查询未返回后续游标"}。以下最多展示前 8 项，不能当作全部项目任务。</p>}
      {tasks.length ? <ul className="run-list">{tasks.slice(0, 8).map((task) => <li key={task.id}><Link className="inline-link" to={`/tasks/${task.id}`}>{task.title}</Link> · {taskStatusLabels[task.status]} · v{task.revision}</li>)}</ul>
        : !snapshot.taskReadFailed && <p className="helper-text">已读首分页没有任务。</p>}<Link className="inline-link" to={`/projects/${id}/tasks`}>打开项目任务并继续加载</Link></section>
    <section className="resume-section"><h2>State 当前完成引用</h2><p className="helper-text">只列 Project State 的 completed_highlight_refs；重开后的旧凭据可从该任务 Activity 历史进入。</p>
      {state.completedHighlightRefs.length ? <ul className="run-list">{state.completedHighlightRefs.map((ref) => <li key={ref.completionId}>
        <Link className="inline-link" to={`/completion-records/${ref.completionId}`}>查看完成凭据 {ref.completionId}</Link> · Task {ref.taskId} · 当时验收 v{ref.acceptanceRevision}
      </li>)}</ul> : <p className="helper-text">State 当前没有完成引用。</p>}</section>
    <section className="resume-section"><h2>待判断</h2><p className="helper-text">来源：当前 OPEN Review 查询；不会据此推断其他任务或历史判断。</p>
      {reviews === null ? <p className="warning-callout">Review 本次读取失败，待处理项未知。</p>
        : reviews.length ? <ul className="run-list">{reviews.slice(0, 5).map((review) => <li key={review.id}><Link className="inline-link" to={`/reviews?id=${review.id}`}>{review.kind} · {review.reason}</Link> · Review v{review.revision}</li>)}</ul>
          : <p className="helper-text">本次 OPEN Review 查询未返回本项目待判断项。</p>}{reviews !== null && reviews.length > 5 && <p className="helper-text">只显示前 5 项；其余请到待审页面查看。</p>}</section>
    <section className="resume-section"><h2>当前选用产物版本</h2><p className="helper-text">只来自 Project State selected_artifact_version_refs；不代表最新版本或本轮接受。</p>
      {selectedArtifacts.length ? <ul className="run-list">{selectedArtifacts.map((artifact) => <li key={artifact.versionId}>{artifact.taskId
        ? <><span>{artifact.title} · v{artifact.version}</span> · <Link className="inline-link" to={`/tasks/${artifact.taskId}?tab=artifacts`}>打开任务产物列表</Link> · <Link className="inline-link" to={`/artifact-versions/${artifact.versionId}/lineage`}>查看版本来源</Link></>
        : <span>版本 {artifact.versionId} · v{artifact.version}（产物详情当前不可读取）</span>}
        <small>来源 {artifact.sourceRef} · Version ID {artifact.versionId}</small></li>)}</ul>
        : <p className="helper-text">State 没有当前选用的产物版本。</p>}</section>
  </div><ResponsiveRail label="查看项目上下文" title="项目上下文"><div className="rail-content"><h2>项目 Decision</h2>
    <p className="helper-text">项目 Decision 当前查询{decisions === null ? "失败" : ` ${decisions.length} 项`}；仅显示前 5 项，不作完整历史声明。</p>
    {decisions === null ? <p className="warning-callout">Decision 来源缺口，需重新读取。</p>
      : decisions.length ? <ul className="run-list">{decisions.slice(0, 5).map((decision) => <li key={decision.id}><Link className="inline-link" to={`/projects/${id}/knowledge?kind=DECISION&item=${decision.id}`}>{decision.title}</Link> · {decision.status} · v{decision.currentVersion}</li>)}</ul>
        : <p className="helper-text">本次查询未返回项目 Decision。</p>}
    <p className="helper-text">来源是 Project、State、Task、OPEN Review、Artifact 与 Decision 的现时查询。没有可用的上次查看基线。</p>
  </div></ResponsiveRail></div></section>;
}

function FixtureProjectResumeView() {
  const navigate = useNavigate();
  const { id = "" } = useParams();
  const [query] = useSearchParams();
  const mode = fixtureModeFromQuery(query);
  const [project, setProject] = useState<ProjectSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedSource, setSelectedSource] = useState<SourceReference | null>(null);
  const [sourceOpen, setSourceOpen] = useState(false);
  const version = useRef(0);
  const resume = project?.resume ?? null;
  const railSources = resumeSourceIds.map((sourceId) => project?.sources.find((source) => source.id === sourceId) ?? null).filter((source): source is SourceReference => source !== null);

  async function load() {
    const request = ++version.current;
    setLoading(true);
    setError(null);
    try { const response = await fixtureAdapter.loadProject(id, mode); if (request === version.current) setProject(response); }
    catch (caught) { if (request === version.current) setError(caught instanceof Error ? caught.message.trim() : "读取恢复摘要失败。"); }
    finally { if (request === version.current) setLoading(false); }
  }
  useEffect(() => { void load(); return () => { version.current++; }; }, [id, mode]);

  async function refreshSummary() {
    if (refreshing) return;
    const request = ++version.current;
    setRefreshing(true);
    setError(null);
    try { const response = await fixtureAdapter.refreshResume(id, mode); if (request === version.current) setProject(response); }
    catch (caught) { if (request === version.current) setError(caught instanceof Error ? caught.message.trim() : "刷新摘要失败。"); }
    finally { if (request === version.current) setRefreshing(false); }
  }
  function showSource(sourceId: string) {
    const source = project?.sources.find((candidate) => candidate.id === sourceId);
    if (source) { setSelectedSource(source); setSourceOpen(true); }
  }
  function openTarget(target: ResumeProgressItem["target"] | ResumeSuggestion["target"]) {
    if (target.kind === "task") navigate(`/tasks/${target.taskId}?skill=definition`);
    else showSource(target.sourceId);
  }
  if (loading) return <section className="page-state" aria-live="polite"><p className="eyebrow">继续这个项目</p><h1>正在读取项目上下文</h1><p>读取只读摘要不会开始或恢复执行，也不会改变当前执行者。</p></section>;
  if (error && !project) return <section className="page-state page-state--error" role="alert"><p className="eyebrow">继续这个项目</p><h1>暂时无法显示恢复摘要</h1><p>{error}</p><button className="secondary-button" type="button" onClick={() => void load()}><RotateCcw aria-hidden="true" />重新读取</button></section>;
  if (!project || !resume) return <section className="page-state"><p className="eyebrow">继续这个项目</p><h1>尚未提供项目恢复摘要示例</h1><p>这个路由对象没有对应的 Skill fixture，页面不会回退读取其他项目的历史或下一步。</p></section>;
  return <section className="skill-page"><div className="page-layout"><div className="page-primary"><p className="eyebrow">{project.name}</p><h1>从这里，接着往前。</h1><p className="metadata-row">只读摘要 <span aria-hidden="true">·</span> 更新于 {resume.updatedAt}</p>{error && <p className="action-error" role="alert">{error}</p>}
    <section className="resume-section" aria-labelledby="progress-heading"><h2 id="progress-heading">当前进展</h2><div className="progress-list">{resume.progress.map((item) => { const Icon = item.state === "completed" ? CheckCircle2 : item.state === "review" ? CircleEllipsis : Circle; return <div key={item.id} className={`progress-row progress-row--${item.state}`}><Icon aria-hidden="true" /><strong>{item.state === "completed" ? "已完成" : item.state === "review" ? "待你判断" : "可开始"}</strong><span>{item.label}</span><button className="inline-link" type="button" onClick={() => openTarget(item.target)}>{item.action}<ChevronRight aria-hidden="true" /></button></div>; })}</div></section>
    <section className="resume-section" aria-labelledby="risk-heading"><h2 id="risk-heading">需要留意</h2>{resume.risks.map((risk) => <div key={risk.text} className="warning-callout" role="status"><TriangleAlert aria-hidden="true" /><p>{risk.text}</p><button className="inline-link" type="button" onClick={() => showSource(risk.sourceId)}>查看来源<ChevronRight aria-hidden="true" /></button></div>)}</section>
    <section className="resume-section" aria-labelledby="next-heading"><h2 id="next-heading">建议的下一步</h2><div className="suggestion-list">{resume.suggestions.map((suggestion, index) => <button key={suggestion.id} className="resume-suggestion" type="button" onClick={() => openTarget(suggestion.target)}><span className="suggestion-index">{String(index + 1).padStart(2, "0")}</span><strong>{suggestion.text}</strong><small>{suggestion.basis}</small><ChevronRight aria-hidden="true" /></button>)}</div><p className="helper-text">以上为建议，尚未执行；摘要不会开始或恢复执行。</p></section>
  </div><ResponsiveRail label="查看项目上下文" title="找回项目上下文"><div className="rail-content"><h2>找回项目上下文</h2><div className="summary-card summary-card--source-list">{railSources.map((source) => <button key={source.id} className="source-button source-button--row" type="button" onClick={() => showSource(source.id)}><FileText aria-hidden="true" /><span className="source-button-copy"><strong>{source.title} {source.version}</strong><small>{source.availability === "available" ? "查看来源" : "来源不可用"}</small></span><ChevronRight aria-hidden="true" /></button>)}</div><hr />{!resume.hasBaseline && <p className="helper-text">本次没有可用的上次查看基线，不展示变化对比。</p>}<button className="primary-button primary-button--wide" type="button" onClick={() => showSource("literature-review-v3")}>查看待审产物</button><button className="secondary-button secondary-button--wide" type="button" disabled={refreshing} onClick={() => void refreshSummary()}><RotateCcw aria-hidden="true" />{refreshing ? "正在刷新摘要" : "刷新摘要"}</button><p className="disabled-reason"><Info aria-hidden="true" />摘要不会自动开始任务或恢复执行。</p></div></ResponsiveRail></div><SourceDetailDialog open={sourceOpen} onClose={() => setSourceOpen(false)} source={selectedSource} /></section>;
}
