import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useParams, useSearchParams } from "react-router-dom";
import { ArrowRight, CircleCheck, CircleDashed, FileText } from "lucide-react";
import AssistView from "./AssistView";
import BlueprintView from "./BlueprintView";
import ProjectResumeView from "./ProjectResumeView";
import ResponsiveRail from "../components/ResponsiveRail";
import type { RelayProjectGoal } from "../api/blueprintDtos";
import type { RelayApiClient, RelayDecision, RelayProject, RelayProjectState, RelayReview, RelayTaskSummary } from "../api/relayClient";
import { fixtureAdapter } from "../fixtures/fixtureAdapter";
import { fixtureModeFromQuery } from "../lib/fixtureMode";
import { executorLabels, interactionModeLabels, phaseLabel, projectTypeLabels, taskStatusLabels } from "../lib/labels";
import { describeLiveError } from "../lib/liveErrors";
import { useRelayConnection } from "../lib/relayConnection";
import type { ProjectSnapshot, ProjectSummary, SourceReference } from "../types";
import type { ProjectType } from "../types";

const tabs = [["overview", "总览"], ["blueprint", "蓝图预览"], ["resume", "继续项目"], ["assist", "Assist"]] as const;
type TabKey = typeof tabs[number][0];

export default function ProjectSkillView() {
  const location = useLocation();
  const query = new URLSearchParams(location.search);
  const requested = query.get("skill");
  const active: TabKey = requested === "blueprint" || requested === "resume" || requested === "assist" ? requested : "overview";
  function href(skill: string) { const next = new URLSearchParams(query); next.set("skill", skill); return `${location.pathname}?${next}`; }
  const projectId = /^\/projects\/([^/]+)$/u.exec(location.pathname)?.[1];
  return <div className="skill-shell">{projectId && <div className="project-workbench-entry"><Link className="secondary-button" to={`/projects/${projectId}/workbench`}>打开项目工作台</Link></div>}<nav className="skill-tabs" aria-label="项目内页面">{tabs.map(([key, label]) => <Link key={key} className={`skill-tab${active === key ? " skill-tab--active" : ""}`} to={href(key)} aria-current={active === key ? "page" : undefined}>{label}</Link>)}</nav>{active === "overview" ? <ProjectOverview /> : active === "blueprint" ? <BlueprintView /> : active === "resume" ? <ProjectResumeView /> : <AssistView targetKind="PROJECT" />}</div>;
}

/** UI-02 项目总览：只按真实 State revision / phase / Next Action 呈现，来源不可用不以摘要当真相。 */
function ProjectOverview() {
  const { id = "" } = useParams();
  const connection = useRelayConnection();
  return connection.client ? <LiveProjectOverview key={`${connection.epoch}:${id}`} id={id} client={connection.client} />
    : <FixtureProjectOverview />;
}

interface OverviewArtifact {
  readonly versionId: string; readonly version: string; readonly title: string | null;
  readonly taskId: string | null; readonly sourceRef: string;
}
interface OverviewFacts {
  readonly project: RelayProject; readonly state: RelayProjectState;
  readonly goals: readonly RelayProjectGoal[] | null;
  readonly nextAction: RelayTaskSummary | null; readonly nextActionFailed: boolean;
  readonly reviews: readonly RelayReview[] | null;
  readonly decisions: readonly RelayDecision[] | null;
  readonly artifacts: readonly OverviewArtifact[];
}

async function readOverviewFacts(client: RelayApiClient, id: string): Promise<OverviewFacts> {
  const [project, state] = await Promise.all([client.getProject(id), client.getProjectState(id)]);
  if (project.id !== id || state.projectId !== id) throw new Error("总览查询返回了其他项目的事实。");
  const [goalResult, reviewResult, decisionResult, nextResult, ...artifactResults] = await Promise.allSettled([
    client.getProjectGoals(id), client.getReviews(), client.getDecisions(id),
    state.nextActionTaskId ? client.getTask(state.nextActionTaskId) : Promise.resolve(null),
    ...state.selectedArtifactVersionRefs.map((ref) => client.getArtifact(ref.artifactId))
  ]);
  const nextAction = nextResult.status === "fulfilled" && nextResult.value && nextResult.value.projectId === id ? nextResult.value : null;
  const artifacts: OverviewArtifact[] = state.selectedArtifactVersionRefs.map((ref, index) => {
    const settled = artifactResults[index];
    const artifact = settled && settled.status === "fulfilled" ? settled.value : null;
    const matched = artifact && artifact.versions.some((version) => version.artifactVersionId === ref.artifactVersionId) ? artifact : null;
    return { versionId: ref.artifactVersionId, version: ref.versionNumber, title: matched?.title ?? null,
      taskId: matched?.taskId ?? null, sourceRef: ref.sourceRef };
  });
  return { project, state,
    goals: goalResult.status === "fulfilled" ? goalResult.value : null,
    nextAction, nextActionFailed: state.nextActionTaskId !== null && nextAction === null,
    reviews: reviewResult.status === "fulfilled" ? reviewResult.value.filter((review) => review.projectId === id) : null,
    decisions: decisionResult.status === "fulfilled" ? decisionResult.value.filter((decision) => decision.projectId === id) : null,
    artifacts };
}

function LiveProjectOverview({ id, client }: { id: string; client: RelayApiClient }) {
  const [facts, setFacts] = useState<OverviewFacts | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const version = useRef(0);
  useEffect(() => {
    const request = ++version.current;
    setFacts(null); setLoading(true); setError(null);
    void readOverviewFacts(client, id).then((next) => { if (request === version.current) setFacts(next); })
      .catch((caught: unknown) => { if (request === version.current) setError(describeLiveError(caught).message); })
      .finally(() => { if (request === version.current) setLoading(false); });
    return () => { version.current++; };
  }, [client, id, reload]);

  if (loading) return <section className="page-state" role="status"><p className="eyebrow">项目</p><h1>正在读取项目当前状态</h1><p>只读查询 Project 与 State 事实，不会开始任务或恢复执行。</p></section>;
  if (error || !facts) return <section className="page-state page-state--error" role="alert"><p className="eyebrow">项目</p><h1>暂时无法读取项目总览</h1><p>{error ?? "项目事实不可用。"}</p><button className="secondary-button" type="button" onClick={() => setReload((value) => value + 1)}>重新读取</button></section>;

  const { project, state, goals, nextAction, reviews, decisions, artifacts } = facts;
  const type = project.projectType in projectTypeLabels ? projectTypeLabels[project.projectType as ProjectType] : project.projectType;
  const activeGoals = goals?.filter((goal) => goal.status === "ACTIVE") ?? null;
  return <section className="skill-page project-overview" data-testid="project-overview-live"><div className="page-layout"><div className="page-primary">
    <p className="eyebrow">项目</p><h1>{project.title}</h1>
    <p className="page-lede">{activeGoals && activeGoals.length ? activeGoals.map((goal) => goal.title).join("；") : `${type}项目 · ${phaseLabel(state.phaseKey)}`}</p>
    {project.archivedAt !== null && <p className="warning-callout" role="status">项目已归档，本页只读；不能再提交新的写命令。</p>}
    <section className="resume-section"><h2>项目当前状态</h2>
      <p className="metadata-row">State revision v{state.revision}<span aria-hidden="true"> · </span>{type}<span aria-hidden="true"> · </span>Project v{project.revision}</p>
      <p className="disabled-reason"><CircleDashed aria-hidden="true" />State 的确认人与确认时间、以及「已确认 / 仍需明确」清单字段服务端尚未提供（待接入）；本页只呈现 revision、阶段、下一步、选用产物与 Decision 等真实事实，不推断状态由任务数量决定。</p>
      <dl className="rail-definition-list">
        <div><dt>当前阶段</dt><dd>{phaseLabel(state.phaseKey)}</dd></div>
        <div><dt>当前目标</dt><dd>{goals === null ? <span className="warning-callout">Goal 关系本次读取失败，目标范围待核对。</span>
          : activeGoals && activeGoals.length ? activeGoals.map((goal) => goal.title).join("；") : "当前没有关联 Goal；不据此推断项目没有目标。"}</dd></div>
      </dl>
    </section>
    <section className="resume-section"><h2>关键产物与决定</h2>
      <p className="helper-text">产物只列 State 当前选用的版本引用，不代表最新版本；决定来自项目 Decision 查询。</p>
      {artifacts.length ? <ul className="run-list">{artifacts.map((artifact) => <li key={artifact.versionId}>
        {artifact.title ? <><strong>{artifact.title}</strong> · v{artifact.version}{artifact.taskId && <> · <Link className="inline-link" to={`/tasks/${artifact.taskId}?tab=artifacts`}>打开任务产物</Link> · <Link className="inline-link" to={`/artifact-versions/${artifact.versionId}/lineage`}>查看来源</Link></>}</>
          : <>版本 <code className="hash-code">{artifact.versionId}</code> · v{artifact.version}（产物详情当前不可读取）</>}
        <small>来源 {artifact.sourceRef}</small></li>)}</ul> : <p className="helper-text">State 当前没有选用的产物版本。</p>}
      {decisions === null ? <p className="warning-callout">Decision 本次读取失败，决定清单待核对。</p>
        : decisions.length ? <ul className="run-list">{decisions.slice(0, 5).map((decision) => <li key={decision.id}><strong>{decision.title}</strong> · {decision.status} · v{decision.currentVersion}<small><Link className="inline-link" to={`/projects/${id}/knowledge?kind=DECISION&item=${decision.id}`}>查看依据</Link> · 更新于 {new Date(decision.updatedAt).toLocaleDateString("zh-CN")}</small></li>)}</ul>
          : <p className="helper-text">本次查询未返回项目 Decision。</p>}
    </section>
    <p className="list-footer-note">项目状态来自人工确认的 State；AI 提案不会自动改写 State，摘要可追溯到对应版本。</p>
  </div><ResponsiveRail label="查看下一步与待判断" title="下一步">
    <div className="rail-content">
      <h2>State 指定的下一步</h2>
      {state.nextActionTaskId === null ? <p className="helper-text">Project State 尚未指定下一步 Task。</p>
        : nextAction ? <><p><Link className="inline-link" to={`/tasks/${nextAction.id}`}>{nextAction.title}</Link></p>
          <dl className="rail-definition-list">
            <div><dt>任务状态</dt><dd>{taskStatusLabels[nextAction.status]}</dd></div>
            <div><dt>执行模式</dt><dd>{interactionModeLabels[nextAction.mode]}</dd></div>
            <div><dt>当前执行者</dt><dd>{executorLabels[nextAction.executor]}</dd></div>
          </dl>
          <Link className="primary-button primary-button--wide" to={`/tasks/${nextAction.id}`}>继续任务<ArrowRight aria-hidden="true" /></Link>
          <p className="disabled-reason"><CircleDashed aria-hidden="true" />「继续任务」只打开任务详情，不会在此开始、恢复或改写执行。</p></>
          : <p className="warning-callout">{facts.nextActionFailed ? `State 引用 Task ${state.nextActionTaskId}，本次单读失败；不以其他任务替代。` : "State 引用的下一步当前不可确认。"}</p>}
      <hr />
      <h2>需要你的判断</h2>
      <p className="helper-text">来源：当前 OPEN Review 查询；不据此推断其他任务或历史判断。</p>
      {reviews === null ? <p className="warning-callout">Review 本次读取失败，待处理项未知。</p>
        : reviews.length ? <ul className="run-list">{reviews.slice(0, 5).map((review) => <li key={review.id}><Link className="inline-link" to={`/reviews?id=${review.id}`}>{review.kind} · {review.reason}</Link><small>Review v{review.revision}</small></li>)}</ul>
          : <p className="helper-text">本次 OPEN Review 查询未返回本项目待判断项。</p>}
      {reviews !== null && reviews.length > 5 && <p className="helper-text">只显示前 5 项；其余请到待审页面查看。</p>}
    </div>
  </ResponsiveRail></div></section>;
}

function FixtureProjectOverview() {
  const { id = "" } = useParams();
  const [query] = useSearchParams();
  const mode = fixtureModeFromQuery(query);
  const [data, setData] = useState<{ summary: ProjectSummary; snapshot: ProjectSnapshot | null } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const version = useRef(0);
  useEffect(() => {
    const request = ++version.current;
    setLoading(true); setError(null);
    void (async () => {
      const [summaries, snapshot] = await Promise.all([fixtureAdapter.listProjects(mode), fixtureAdapter.loadProject(id, mode)]);
      if (request !== version.current) return;
      const summary = summaries.find((item) => item.id === id) ?? null;
      if (!summary) { setError("该路由对象没有对应的项目示例事实；页面不会回退读取其他项目。"); return; }
      setData({ summary, snapshot });
    })().catch((caught: unknown) => { if (request === version.current) setError(caught instanceof Error ? caught.message : "读取项目总览失败。"); })
      .finally(() => { if (request === version.current) setLoading(false); });
    return () => { version.current++; };
  }, [id, mode]);

  if (loading) return <section className="page-state" aria-live="polite"><p className="eyebrow">项目</p><h1>正在读取项目当前状态</h1><p>读取示例事实不会开始任务或恢复执行。</p></section>;
  if (error || !data) return <section className="page-state page-state--error" role="alert"><p className="eyebrow">项目</p><h1>暂时无法显示项目总览</h1><p>{error ?? "没有对应的项目示例事实。"}</p></section>;
  const { summary, snapshot } = data;
  const sources: readonly SourceReference[] = snapshot?.sources ?? [];
  const typeLabel = summary.projectType in projectTypeLabels ? projectTypeLabels[summary.projectType as ProjectType] : summary.projectType;
  const phaseText = phaseLabel(summary.phase);
  return <section className="skill-page project-overview" data-testid="project-overview-fixture"><div className="page-layout"><div className="page-primary">
    <p className="eyebrow">项目 · 示例数据</p><h1>{summary.title}</h1>
    <p className="page-lede">{summary.goal}</p>
    <section className="resume-section"><h2>项目当前状态</h2>
      <p className="metadata-row">状态 v{summary.stateRevision}<span aria-hidden="true"> · </span>{typeLabel}<span aria-hidden="true"> · </span>阶段：{phaseText}</p>
      <p className="disabled-reason"><CircleDashed aria-hidden="true" />示例视图：确认人、确认时间与「已确认 / 仍需明确」清单为设计概念，服务端接口待接入。</p>
      <dl className="rail-definition-list"><div><dt>当前阶段</dt><dd>{phaseText}</dd></div>
        <div><dt>当前目标</dt><dd>{summary.goal}</dd></div></dl>
    </section>
    <section className="resume-section"><h2>关键产物与摘要</h2>
      <p className="helper-text">来源可追溯；来源不可用时不以摘要当真相。</p>
      {sources.length ? <ul className="run-list">{sources.map((source) => <li key={source.id}>
        <span><FileText aria-hidden="true" /> <strong>{source.title}</strong> {source.version}</span>
        {source.availability === "available" ? <small>{source.excerpt}</small> : <small className="warning-callout"><CircleDashed aria-hidden="true" />来源不可用，摘要不作为事实。</small>}</li>)}</ul>
        : <p className="helper-text">示例项目没有可列出的产物来源。</p>}
    </section>
    <p className="list-footer-note">项目状态来自人工确认；摘要可追溯到对应版本。AI 提案不会自动改写 State。</p>
  </div><ResponsiveRail label="查看下一步与待判断" title="下一步"><div className="rail-content">
    <h2>下一步</h2>
    {summary.nextAction ? <><p><CircleCheck aria-hidden="true" /> {summary.nextAction}</p>
      <Link className="primary-button primary-button--wide" to={`/projects/${id}/tasks`}>查看项目任务</Link>
      <p className="disabled-reason"><CircleDashed aria-hidden="true" />示例数据：不会在此开始、恢复或改写执行。</p></>
      : <p className="helper-text">示例项目当前没有指定下一步。</p>}
    <hr />
    <h2>需要你的判断</h2>
    {summary.pendingReviewCount > 0 ? <p><Link className="inline-link" to="/reviews">{summary.pendingReviewCount} 项待审</Link></p>
      : <p className="helper-text">没有待判断项。</p>}
  </div></ResponsiveRail></div></section>;
}
