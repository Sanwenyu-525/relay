import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { RelayApiClient, RelayRunTrace, RelayTaskDetail } from "../api/relayClient";
import TaskCheckPlanPreview from "../components/TaskCheckPlanPreview";
import { executorLabels, interactionModeLabels, taskStatusLabels } from "../lib/labels";
import { describeLiveError } from "../lib/liveErrors";
import { clearDraftGuard, setDraftGuard, type DraftGuard } from "../lib/draftGuard";
import AssistView, { type AssistNavigationState } from "./AssistView";
import "./LiveTaskSkillFactsView.css";

export default function LiveTaskSkillFactsView({ client, kind }: {
  client: RelayApiClient; kind: "definition" | "verification";
}) {
  const { id = "" } = useParams();
  const [task, setTask] = useState<RelayTaskDetail | null>(null);
  const [trace, setTrace] = useState<RelayRunTrace | null>(null);
  const [loading, setLoading] = useState(true);
  const [traceLoading, setTraceLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [traceError, setTraceError] = useState<string | null>(null);
  const [projectArchivedAt, setProjectArchivedAt] = useState<string | null | undefined>(undefined);
  const [projectReadError, setProjectReadError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [assistNavigation, setAssistNavigation] = useState<AssistNavigationState>({ dirty: false, pending: null });
  const [proposalActionHost, setProposalActionHost] = useState<HTMLDivElement | null>(null);
  const requestVersion = useRef(0);
  const factsRefreshVersion = useRef(0);
  const targetScope = useRef<{ client: RelayApiClient; id: string } | null>(null);
  const navigationRef = useRef(assistNavigation);
  navigationRef.current = assistNavigation;
  useEffect(() => {
    const guard: DraftGuard = { hasUnsavedChanges: () => navigationRef.current.dirty || navigationRef.current.pending !== null,
      pendingCommandId: () => navigationRef.current.pending?.commandId ?? null,
      discard: () => { navigationRef.current = { dirty: false, pending: null }; } };
    setDraftGuard(guard);
    return () => clearDraftGuard(guard);
  }, []);

  useEffect(() => {
    const request = ++requestVersion.current;
    if (targetScope.current?.client !== client || targetScope.current.id !== id) setTask(null);
    targetScope.current = { client, id };
    setTrace(null); setError(null); setTraceError(null); setProjectArchivedAt(undefined); setProjectReadError(null);
    setLoading(true); setTraceLoading(false);
    void client.getTask(id).then(async (next) => {
      if (next.id !== id) throw new Error("返回的任务与当前页面不匹配。");
      if (request !== requestVersion.current) return;
      setTask(next); setLoading(false);
      if (next.projectId) void client.getProject(next.projectId).then((project) => {
        if (project.id !== next.projectId) throw new Error("Project 读取结果与当前任务归属不匹配。");
        if (request === requestVersion.current) setProjectArchivedAt(project.archivedAt);
      }).catch((caught: unknown) => {
        if (request === requestVersion.current) setProjectReadError(describeLiveError(caught).message);
      });
      if (!next.executorRunId) return;
      setTraceLoading(true);
      try {
        const evidence = await client.getRunTrace(next.executorRunId);
        if (evidence.taskId !== id || evidence.runId !== next.executorRunId || evidence.projectId !== next.projectId) {
          throw new Error("Run Trace 与当前任务不匹配。");
        }
        if (request === requestVersion.current) setTrace(evidence);
      } catch (caught) {
        if (request === requestVersion.current) setTraceError(`当前 Run 的验证来源不可读取：${describeLiveError(caught).message}`);
      } finally {
        if (request === requestVersion.current) setTraceLoading(false);
      }
    }).catch((caught: unknown) => {
      if (request === requestVersion.current) { setError(describeLiveError(caught).message); }
    }).finally(() => { if (request === requestVersion.current) setLoading(false); });
    return () => { requestVersion.current++; };
  }, [client, id, reload]);

  const title = kind === "definition" ? "完善任务定义" : "生成验收方案";
  const factsReadable = !loading && error === null;
  async function refreshAcceptedFacts() {
    const request = requestVersion.current;
    const refresh = ++factsRefreshVersion.current;
    try {
      const current = await client.getTask(id);
      if (current.id !== id) throw new Error("返回的任务与当前页面不匹配。");
      if (request === requestVersion.current && refresh === factsRefreshVersion.current) { setTask(current); setError(null); }
    } catch (caught) {
      if (request === requestVersion.current && refresh === factsRefreshVersion.current) { setTrace(null); setError(describeLiveError(caught).message); }
    }
  }
  return <section className="skill-page task-skill-facts" data-testid={`live-${kind}`}>
    <div className="page-layout"><div className="page-primary">
    <p className="eyebrow">{factsReadable && task ? task.title : title}</p><h1>{kind === "definition" ? "先说清楚，怎样才算完成" : "把验收依据列清楚"}</h1>
    <p className="page-lede">先核对当前事实，再生成建议并确认本次变更。</p>
    {task && factsReadable && <p className="metadata-row">任务状态：{taskStatusLabels[task.status]} ·
      执行模式：{interactionModeLabels[task.mode]} · 当前执行者：{executorLabels[task.executor]} ·
      Task v{task.revision} / 验收 v{task.acceptance.acceptanceRevision}</p>}
    <button className="secondary-button" type="button" data-testid="task-skill-refresh" disabled={loading || traceLoading || assistNavigation.dirty || assistNavigation.pending !== null} onClick={() => setReload((value) => value + 1)}>刷新当前事实</button>
    {(assistNavigation.dirty || assistNavigation.pending !== null) && <p className="helper-text">建议区有未发送输入或待核对命令，请先发送、清空输入或核对原命令回执，再刷新当前事实。</p>}
    {loading && <p role="status">正在读取任务与验收事实…</p>}
    {error && <p className="action-error" role="alert">{error}</p>}
    {task && factsReadable && (kind === "definition"
      ? <section className="task-skill-current-objective"><h2>当前任务目标</h2><blockquote>{task.acceptance.objective || "当前验收目标为空。"}</blockquote></section>
      : <TaskCheckPlanPreview key={`${id}:${reload}:${task.revision}:${task.acceptance.acceptanceRevision}`} client={client} taskId={id}
        taskRevision={task.revision} acceptanceRevision={task.acceptance.acceptanceRevision} />)}
    {task && <AssistView key={`skill-assist:${id}`} targetKind="TASK" targetId={id} embedded
      onNavigationStateChange={setAssistNavigation}
      proposalActionHost={proposalActionHost}
      externalReadBlockedReason={loading ? "正在核对当前任务事实，旧事实、资料与提案暂时隐藏；读取成功后才能发送新命令。"
        : error ? "当前任务事实读取失败，旧事实、资料与提案已隐藏；请先核对原命令或清空未发送输入，再重新读取。" : null}
      preferredSkillId={kind === "definition" ? "task-to-execution-contract" : "verification-plan"}
      onTargetChanged={() => void refreshAcceptedFacts()} />}
    {task && factsReadable && <>
      {task.projectId && <p className="helper-text" data-testid="task-skill-project-status">{projectReadError
        ? `Project 状态无法核对：${projectReadError}；本页仍可阅读已取得的 Task 事实。`
        : projectArchivedAt === undefined ? "正在核对所属 Project 的归档状态…"
          : projectArchivedAt !== null ? "项目已归档；这里只保留已接受事实和历史证据的阅读入口。"
            : "所属 Project 正在进行中。"}</p>}
      <details className="surface-panel" data-testid="live-task-accepted-facts"><summary>已接受的当前事实 · {task.title} · 任务 v{task.revision} / 验收 v{task.acceptance.acceptanceRevision}</summary>
        <p className="metadata-row"><strong>{task.title}</strong>
          <span aria-hidden="true"> · </span>任务 v{task.revision}
          <span aria-hidden="true"> · </span>{taskStatusLabels[task.status]}
          <span aria-hidden="true"> · </span>{interactionModeLabels[task.mode]}
          <span aria-hidden="true"> · </span>执行者 {executorLabels[task.executor]}</p>
        <p className="metadata-row">验收版本 v{task.acceptance.acceptanceRevision}
          <span aria-hidden="true"> · </span>来源 {task.acceptance.source}</p>
        <h3>目标</h3><p>{task.acceptance.objective || "当前验收目标为空。"}</p>
        <h3>当前验收条件</h3>{task.acceptance.criteria.length ? <ul className="criteria-list">{task.acceptance.criteria.map((criterion) =>
          <li className="criteria-row" key={criterion.criterionId}><span className="criteria-copy">
            <strong>{criterion.statement}</strong>
            <small>条件 ID {criterion.criterionId} · {criterion.required ? "必需" : "可选"} · 方式 {criterion.method}</small>
          </span></li>)}</ul>
          : <p className="helper-text">当前版本没有验收条件。</p>}
        <p className="helper-text">{kind === "definition"
          ? `当前验收预期产物类型：${task.acceptance.expectedOutputs === null ? "此响应未提供" :
            typeof task.acceptance.expectedOutputs.kind === "string" ? task.acceptance.expectedOutputs.kind :
              Array.isArray(task.acceptance.expectedOutputs.artifacts) ?
                task.acceptance.expectedOutputs.artifacts.join("、") : "未声明"}。当前 Task 单读未提供输入资料绑定；不从示例提案补造字段。`
          : "验收条件中的方式是当前 Task 事实，不等于已应用的 CheckPlan 或检查结果。"}</p>
        <Link className="text-link" to={`/tasks/${id}`}>打开任务详情</Link>
      </details>
    </>}
    </div>
      <aside className="review-rail task-skill-confirmation" data-testid="task-skill-confirmation" aria-label="确认与来源" hidden={!task || !factsReadable}>
      <h2>{kind === "definition" ? "确认任务定义" : "先确认检查方式"}</h2>
      <p className="page-lede">{kind === "definition" ? "核对任务目标、预期结果与验收条件。" : "核对每项检查方式，再确认服务端合并方案。"}</p>
      <div ref={setProposalActionHost} className="task-skill-action-host" />
      {task && factsReadable && <div className="rail-content">
      <details className="surface-panel" data-testid="live-task-skill-gap"><summary>来源与建议</summary>
        <p>{kind === "definition" ? "在本页建议与确认区生成任务定义提案，逐项核对目标、结果和验收条件。"
          : "在本页建议与确认区生成验收方案，核对保留条件、新增检查和缺少的能力。"}</p>
        <p className="helper-text">模型文字建议与可接受的服务端合并提案分别展示；接受前会重新核对 Task 与验收版本。</p>
        <p className="helper-text">Assist 可讨论当前任务；进入会话或发送消息不会修改任务、验收标准、检查方案或执行权。</p>
        <Link className="text-link" to={`/tasks/${id}?skill=assist`}>打开此任务的 Assist</Link>
      </details>
      <details className="surface-panel" data-testid="live-task-verification-source"><summary>确切 Run / Verification 来源</summary>
        {task.executorRunId ? <><p>当前 Task 指向 Run <Link className="inline-link" to={`/runs/${task.executorRunId}`}>{task.executorRunId}</Link>。</p>
          {traceLoading && <p role="status">正在读取该 Run 的验证证据…</p>}
          {traceError && <p className="action-error" role="alert">{traceError}</p>}
          {trace && (trace.verifications.length ? <ul>{trace.verifications.map((session) => <li key={session.id}>
            <strong>Verification Session {session.id} · {session.status} · 判定 {session.verdict ?? "尚无"}</strong>
            <small>验收 v{session.acceptanceRevision} · CheckPlan hash <code className="hash-code">{session.checkPlanHash}</code> · {session.createdAt}</small>
            <p>{session.checks.length ? session.checks.map((check) => `${check.criterionId}: ${check.result}`).join("；") : "该会话没有检查结果。"}</p>
            {session.targets.map((target) => <p key={target.artifactVersionId}>目标产物版本 <Link className="inline-link" to={`/artifact-versions/${target.artifactVersionId}/lineage`}>{target.artifactVersionId}</Link> · sha256 <code className="hash-code">{target.contentSha256}</code></p>)}</li>)}</ul>
            : <p className="helper-text">该 Run 的 Trace 未记录验证会话。</p>)}
          <p className="helper-text">Run Trace 是历史证据；版本号或 PASS 不单独证明当前验收仍有效，也不表示任务已完成。</p></>
          : <p className="helper-text">当前 Task 没有指向 Run；本接口不提供历史 Run 列表，不能由任务状态推断曾运行过验证。</p>}
      </details>
      </div>}
      </aside>
    </div>
  </section>;
}
