import { reviewReasonText } from "../components/ReviewDecisionPanel";
import { useEffect, useRef, useState } from "react";
import { Link, Navigate, useLocation, useParams, useSearchParams } from "react-router-dom";
import { ArrowRight, CircleCheck, CircleDashed, FileText, Info, RotateCcw, TriangleAlert } from "lucide-react";
import BlueprintView from "./BlueprintView";
import ProjectResumeView from "./ProjectResumeView";
import ResponsiveRail from "../components/ResponsiveRail";
import PageHeader from "../components/PageHeader";
import DailyContinuationCard from "../components/DailyContinuationCard";
import ProjectStatePanel from "../components/ProjectStatePanel";
import ProjectTitleEditor from "../components/ProjectTitleEditor";
import type { RelayProjectGoal } from "../api/blueprintDtos";
import type { RelayActivityItem, RelayApiClient, RelayDecision, RelayProject, RelayProjectState, RelayReview, RelayTaskSummary } from "../api/relayClient";
import { fixtureAdapter } from "../fixtures/fixtureAdapter";
import { fixtureModeFromQuery } from "../lib/fixtureMode";
import { executorLabels, interactionModeLabels, phaseLabel, projectTypeLabels, reviewKindLabels, taskStatusLabels } from "../lib/labels";
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
  if (active === "assist" && projectId) {
    query.delete("skill"); query.set("project", projectId);
    return <Navigate to={`/agent?${query}`} replace />;
  }
  return <div className="skill-shell">{projectId && <div className="project-workbench-entry"><Link className="secondary-button" to={`/projects/${projectId}/workbench`}>打开项目工作台</Link></div>}<nav className="skill-tabs" aria-label="项目内页面">{tabs.map(([key, label]) => <Link key={key} className={`skill-tab${active === key ? " skill-tab--active" : ""}`} to={href(key)} aria-current={active === key ? "page" : undefined}>{label}</Link>)}</nav>{active === "overview" ? <ProjectOverview /> : active === "blueprint" ? <BlueprintView /> : <ProjectResumeView />}</div>;
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
  /** 项目任务首分页：总览「任务」区与阻塞提示的唯一数据来源，读取失败时 tasks 为空并由 tasksReadFailed 如实标注。 */
  readonly tasks: readonly RelayTaskSummary[];
  readonly tasksNextCursor: string | null;
  readonly tasksReadFailed: boolean;
}

/**
 * 不可开始/等待的原因：口径与 ProjectTasksView 的 blockedReason 一致——
 * 未解除阻塞项优先，其次是前置任务，再其次才是服务端投影的等待原因；
 * 三者都没有时只报「原因待核对」，不替服务端补一个解释。
 */
function overviewTaskReason(task: RelayTaskSummary): string {
  if (task.unresolvedBlockerIds.length > 0) return `存在 ${task.unresolvedBlockerIds.length} 个未解除的阻塞项，服务端未投影 START 动作。`;
  if (task.blockingTaskIds.length > 0) return "前置任务尚未完成，服务端未投影 START 动作。";
  if (task.waitingReason) return task.waitingReason;
  return "服务端报告该状态，具体原因本次未返回；请按原任务核对。";
}

async function readOverviewFacts(client: RelayApiClient, id: string): Promise<OverviewFacts> {
  const [project, state] = await Promise.all([client.getProject(id), client.getProjectState(id)]);
  if (project.id !== id || state.projectId !== id) throw new Error("总览查询返回了其他项目的事实。");
  const [goalResult, reviewResult, decisionResult, nextResult, taskPageResult,
    ...artifactResults] = await Promise.allSettled([
    client.getProjectGoals(id), client.getReviews(), client.getDecisions(id),
    state.nextActionTaskId ? client.getTask(state.nextActionTaskId) : Promise.resolve(null),
    client.getProjectTasksPage(id),
    ...state.selectedArtifactVersionRefs.map((ref) => client.getArtifact(ref.artifactId))
  ]);
  const nextAction = nextResult.status === "fulfilled" && nextResult.value && nextResult.value.projectId === id ? nextResult.value : null;
  const taskPage = taskPageResult.status === "fulfilled" &&
    taskPageResult.value.items.every((task) => task.projectId === id) ? taskPageResult.value : null;
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
    artifacts,
    tasks: taskPage?.items ?? [],
    tasksNextCursor: taskPage?.nextCursor ?? null,
    tasksReadFailed: taskPage === null };
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
  const { tasks, tasksNextCursor, tasksReadFailed } = facts;
  const type = project.projectType in projectTypeLabels ? projectTypeLabels[project.projectType as ProjectType] : project.projectType;
  const activeGoals = goals?.filter((goal) => goal.status === "ACTIVE") ?? null;
  const archived = project.archivedAt !== null;
  // 阻塞来自真实任务事实：BLOCKED 状态、前置未完成或未解除阻塞项（口径同 ProjectTasksView）。
  const blockedTasks = tasks.filter((task) => task.status === "BLOCKED" ||
    task.blockingTaskIds.length > 0 || task.unresolvedBlockerIds.length > 0);
  const stateBlockers = state.blockers.filter((blocker) => blocker.resolvedAt === null);
  const blockerNotes = [
    facts.nextActionFailed ? `State 引用的下一步 Task ${state.nextActionTaskId} 本次单读失败。` : null,
    ...blockedTasks.map((task) => `「${task.title}」${overviewTaskReason(task)}`),
    ...stateBlockers.map((blocker) => `State 登记阻塞「${blocker.reason}」（${blocker.targetKind} ${blocker.targetId}）`)
  ].filter(Boolean) as readonly string[];
  return <section className="skill-page project-overview" data-testid="project-overview-live"><div className="page-layout"><div className="page-primary">
    <p className="metadata-row"><Link className="inline-link" to="/projects">← 全部项目</Link></p>
    <PageHeader testId="project-overview-page-head" title={project.title} meta={`${type} · ${phaseLabel(state.phaseKey)}`}
      status={<span className={`status-chip ${archived ? "status-chip--neutral" : "status-chip--success"}`}>{archived ? "已归档" : phaseLabel(state.phaseKey)}</span>}
      lede={activeGoals && activeGoals.length ? activeGoals.map((goal) => goal.title).join("；") : `${type}项目 · ${phaseLabel(state.phaseKey)}`}
      actions={<button className="secondary-button" type="button" onClick={() => setReload((value) => value + 1)}><RotateCcw aria-hidden="true" />刷新</button>} />
    {archived && <p className="warning-callout" role="status">项目已归档，本页只读；不能再提交新的写命令。</p>}
    {/* V43-04 接续摘要主入口：真实接续卡（当前事实、相对基线变化、在途与阻塞）+ 两个动作。
        「继续工作」只做导航——有 State 下一步时去该任务详情，否则回项目工作台；
        不自动委托、不创建 Task/Run/会话、不写业务状态。「查看动态」带原项目过滤。 */}
    <section className="resume-section" data-testid="project-resume-card" aria-label="接续摘要">
      <h2>接续摘要</h2>
      <DailyContinuationCard client={client} projectId={id} />
      <div className="project-resume-actions">
        {archived ? <>
          <button className="primary-button" type="button" disabled data-testid="project-resume-continue">继续工作</button>
          <p className="disabled-reason" data-testid="project-resume-archived-reason"><Info aria-hidden="true" />项目已归档：只能阅读历史，恢复归档后才能继续。</p>
        </> : state.nextActionTaskId !== null && nextAction
          ? <Link className="primary-button" data-testid="project-resume-continue" to={`/tasks/${nextAction.id}`}>继续工作<ArrowRight aria-hidden="true" /></Link>
          : <Link className="primary-button" data-testid="project-resume-continue" to={`/projects/${id}/workbench`}>继续工作<ArrowRight aria-hidden="true" /></Link>}
        <Link className="secondary-button" data-testid="project-resume-activity" to={`/activity?project_id=${encodeURIComponent(id)}`}>查看动态</Link>
      </div>
    </section>
    {blockerNotes.length > 0 && <div className="warning-callout" role="status" data-testid="project-overview-blockers"><TriangleAlert aria-hidden="true" /><p><strong>阻塞</strong>：{blockerNotes.join("；")}</p></div>}
    {goals === null && <p className="warning-callout" role="alert">Goal 关系本次读取失败，目标范围待核对。</p>}
    <section className="resume-section" data-testid="project-overview-facts"><h2>已确认事实</h2>
      <dl className="rail-definition-list">
        <div><dt>状态版本</dt><dd>State v{state.revision} · Project v{project.revision}</dd></div>
        <div><dt>当前阶段</dt><dd>{phaseLabel(state.phaseKey)}</dd></div>
        <div><dt>当前目标</dt><dd>{goals === null ? <span className="warning-callout">Goal 关系本次读取失败，目标范围待核对。</span>
          : activeGoals && activeGoals.length ? activeGoals.map((goal, index) => <span key={goal.goalId}>
            {index > 0 ? "；" : null}<Link className="inline-link" to={`/goals/${goal.goalId}`}>{goal.title}</Link>
          </span>) : "当前没有关联 Goal；不据此推断项目没有目标。"}</dd></div>
        <div><dt>下一步</dt><dd>{state.nextActionTaskId === null ? "尚未指定" : nextAction
          ? <Link className="inline-link" to={`/tasks/${nextAction.id}`}>{nextAction.title}</Link>
          : `State 引用 Task ${state.nextActionTaskId}，本次单读失败；不以其他任务替代。`}</dd></div>
        {archived && <div><dt>归档时间</dt><dd>{new Date(project.archivedAt!).toLocaleString("zh-CN")}</dd></div>}
      </dl>
      {/* 2026-10-24 用户指令：服务端待接入字段收成开发注记；页面呈现原则归代码与文档，不再上屏。 */}
      <p className="disabled-reason" aria-label="开发注记"><CircleDashed aria-hidden="true" />开发注记：State 的确认人与确认时间、「已确认 / 仍需明确」清单字段服务端尚未提供（待接入）；本页只呈现 revision、阶段、下一步、任务、选用产物与 Decision。</p>
      <ProjectTitleEditor client={client} project={project} archived={archived}
        onChanged={() => setReload((value) => value + 1)} />
    </section>
    <ProjectStatePanel client={client} projectId={id} projectType={project.projectType}
      state={state} tasks={tasks} goals={goals} archived={archived}
      onChanged={() => setReload((value) => value + 1)} />
    <section className="resume-section" data-testid="project-overview-tasks"><h2>任务</h2>
      {tasksReadFailed ? <p className="warning-callout">任务列表本次读取失败，无法列出项目任务；State 下一步仍单独核对。</p>
        : <>
          <p className="helper-text">已读取项目任务首分页 {tasks.length} 项{tasksNextCursor ? "；还有后续页，此处不是全量" : "；本次查询未返回后续游标"}。</p>
          {tasks.length ? <ul className="run-list">{tasks.map((task) => {
            const notStartable = task.status === "BLOCKED" || task.blockingTaskIds.length > 0 || task.unresolvedBlockerIds.length > 0;
            const waiting = task.status === "WAITING" && task.waitingReason !== null;
            return <li key={task.id}>
              <strong>{task.title}</strong> · {taskStatusLabels[task.status]} · {interactionModeLabels[task.mode]} · {executorLabels[task.executor]} · v{task.revision}
              {" "}<Link className="inline-link" to={`/tasks/${task.id}`}>打开任务</Link>
              {notStartable && <p className="project-task-reason">不可开始原因：{overviewTaskReason(task)}</p>}
              {waiting && <p className="project-task-reason">等待原因：{task.waitingReason}</p>}
            </li>;
          })}</ul> : <p className="helper-text">已读首分页没有任务。</p>}
          {tasksNextCursor && <Link className="inline-link" to={`/projects/${id}/tasks`}>打开项目任务并继续加载</Link>}
        </>}
    </section>
    <section className="resume-section" data-testid="project-overview-outputs"><h2>关键成果</h2>
      <p className="helper-text">项目当前完成凭据、选用的确切版本与已记录决定。</p>
      {state.completedHighlightRefs.length ? <ul className="run-list">{state.completedHighlightRefs.map((ref) => <li key={ref.completionId}>
        <Link className="inline-link" to={`/completion-records/${ref.completionId}`}>查看完成凭据</Link> · Task {ref.taskId} · 当时验收 v{ref.acceptanceRevision}</li>)}</ul> : null}
      {artifacts.length ? <ul className="run-list">{artifacts.map((artifact) => <li key={artifact.versionId}>
        {artifact.title ? <><strong>{artifact.title}</strong> · v{artifact.version}{artifact.taskId && <> · <Link className="inline-link" to={`/tasks/${artifact.taskId}?tab=artifacts`}>打开任务产物</Link> · <Link className="inline-link" to={`/artifact-versions/${artifact.versionId}/lineage`}>查看来源</Link></>}</>
          : <>版本 <code className="hash-code">{artifact.versionId}</code> · v{artifact.version}（产物详情当前不可读取）</>}
        <details className="tech-details"><summary>版本来源</summary><small>版本 ID：{artifact.versionId} · 来源 {artifact.sourceRef}</small></details></li>)}</ul> : <p className="helper-text">State 当前没有选用的产物版本。</p>}
      {decisions === null ? <p className="warning-callout">Decision 本次读取失败，决定清单待核对。</p>
        : decisions.length ? <ul className="run-list">{decisions.slice(0, 5).map((decision) => <li key={decision.id}><strong>{decision.title}</strong> · {decision.status} · v{decision.currentVersion}<small><Link className="inline-link" to={`/projects/${id}/knowledge?kind=DECISION&item=${decision.id}`}>查看依据</Link> · 更新于 {new Date(decision.updatedAt).toLocaleDateString("zh-CN")}</small></li>)}</ul>
          : <p className="helper-text">本次查询未返回项目 Decision。</p>}
      {state.risks.length > 0 && <><h3>已确认风险</h3>
        <ul className="run-list">{state.risks.map((risk) => <li key={risk.riskId}>
          <strong>{risk.statement}</strong><small>确认引用 {risk.confirmationRef} · 来源 {risk.sourceRef}</small></li>)}</ul></>}
    </section>
    <ProjectRecentActivity client={client} projectId={id} />
    <details className="page-explanation"><summary>状态与版本说明</summary><p className="helper-text">项目状态来自人工确认的 State；AI 提案不会自动改写 State，摘要可追溯到对应版本。产物只列 State 当前选用的版本引用，不代表最新版本；决定来自项目 Decision 查询。</p></details>
  </div><ResponsiveRail label="查看待判断与项目入口" title="待判断与入口">
    <div className="rail-content">
      <h2>需要你的判断</h2>
      {reviews === null ? <p className="warning-callout">Review 本次读取失败，待处理项未知。</p>
        : reviews.length ? <ul className="run-list">{reviews.slice(0, 5).map((review) => <li key={review.id}><Link className="inline-link" to={`/reviews?id=${review.id}`}>{reviewKindLabels[review.kind]} · {reviewReasonText(review.reason)}</Link><small>请求 v{review.revision}</small></li>)}</ul>
          : <p className="helper-text">本次 OPEN Review 查询未返回本项目待判断项。</p>}
      {reviews !== null && reviews.length > 5 && <p className="helper-text">只显示前 5 项；其余请到待审页面查看。</p>}
      <section className="rail-section"><h3>项目入口</h3><Link className="secondary-button secondary-button--wide" to={`/projects/${id}/tasks`}>项目任务</Link><Link className="secondary-button secondary-button--wide" to={`/projects/${id}/knowledge`}>项目资料</Link><Link className="secondary-button secondary-button--wide" to={`/projects/${id}/workbench`}>项目工作台</Link></section>
    </div>
  </ResponsiveRail></div></section>;
}

/** 最近活动单独读取：失败只影响本区，不拖慢或改写接续摘要与状态事实。 */
function ProjectRecentActivity({ client, projectId }: { client: RelayApiClient; projectId: string }) {
  const [items, setItems] = useState<readonly RelayActivityItem[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const version = useRef(0);
  useEffect(() => {
    const request = ++version.current;
    void client.getActivities({ projectId, limit: 5 }).then((page) => {
      if (request !== version.current) return;
      setItems(page.items); setNextCursor(page.nextCursor);
    }).catch(() => {
      if (request === version.current) { setItems(null); setFailed(true); }
    });
    return () => { version.current++; };
  }, [client, projectId]);
  return <section className="resume-section" data-testid="project-overview-activity"><h2>最近活动</h2>
    <p className="helper-text">只读最近 5 条项目活动{nextCursor ? "；还有更早记录未读，不能当作完整历史"
      : "；本次查询未返回更早记录"}。</p>
    {failed ? <p className="warning-callout">活动本次读取失败，最近进展待核对。</p>
      : items === null ? <p className="helper-text">正在读取最近活动…</p>
      : items.length ? <ul className="run-list">{items.map((item) => <li key={item.id}>
        <strong>{item.summary}</strong><small>{new Date(item.createdAt).toLocaleString("zh-CN")} · {item.eventType}</small>
      </li>)}</ul> : <p className="helper-text">本次读取的最近 5 条中没有活动记录。</p>}
    <Link className="inline-link" to={`/activity?project_id=${encodeURIComponent(projectId)}`}>查看完整动态</Link>
  </section>;
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
    <p className="metadata-row"><Link className="inline-link" to="/projects">← 全部项目</Link></p>
    <PageHeader testId="project-overview-page-head" title={summary.title} meta="项目 · 示例数据" lede={summary.goal} />
    {/* V43-04：总览是接续摘要主入口；示例模式同样只导航，不创建任何执行事实。 */}
    <div className="project-resume-actions" data-testid="project-resume-card">
      {summary.archived ? <>
        <button className="primary-button" type="button" disabled data-testid="project-resume-continue">继续工作</button>
        <p className="disabled-reason" data-testid="project-resume-archived-reason"><Info aria-hidden="true" />项目已归档：只能阅读历史，恢复归档后才能继续。</p>
      </> : <>
        {snapshot?.tasks.some((task) => task.status === "IN_PROGRESS")
          ? <Link className="primary-button" data-testid="project-resume-continue"
            to={`/tasks/${snapshot.tasks.find((task) => task.status === "IN_PROGRESS")!.id}`}>继续工作<ArrowRight aria-hidden="true" /></Link>
          : <Link className="primary-button" data-testid="project-resume-continue" to={`/projects/${id}/workbench`}>继续工作<ArrowRight aria-hidden="true" /></Link>}
        <Link className="secondary-button" data-testid="project-resume-activity" to={`/activity?project_id=${encodeURIComponent(id)}`}>查看动态</Link>
      </>}
    </div>
    <section className="resume-section"><h2>项目当前状态</h2>
      <p className="metadata-row">状态 v{summary.stateRevision}<span aria-hidden="true"> · </span>{typeLabel}<span aria-hidden="true"> · </span>阶段：{phaseText}</p>
      <p className="disabled-reason" aria-label="开发注记"><CircleDashed aria-hidden="true" />开发注记：确认人、确认时间与「已确认 / 仍需明确」清单为设计概念，服务端接口待接入。</p>
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
