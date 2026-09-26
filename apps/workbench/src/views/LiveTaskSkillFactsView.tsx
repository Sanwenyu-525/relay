import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { RelayApiClient, RelayRunTrace, RelayTaskDetail } from "../api/relayClient";
import TaskCheckPlanPreview from "../components/TaskCheckPlanPreview";
import { executorLabels, interactionModeLabels, taskStatusLabels } from "../lib/labels";
import { describeLiveError } from "../lib/liveErrors";

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
  const requestVersion = useRef(0);

  useEffect(() => {
    const request = ++requestVersion.current;
    setTask(null); setTrace(null); setError(null); setTraceError(null); setProjectArchivedAt(undefined); setProjectReadError(null);
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
      if (request === requestVersion.current) setError(describeLiveError(caught).message);
    }).finally(() => { if (request === requestVersion.current) setLoading(false); });
    return () => { requestVersion.current++; };
  }, [client, id, reload]);

  const title = kind === "definition" ? "完善任务定义" : "生成验收方案";
  return <section className="skill-page" data-testid={`live-${kind}`}>
    <p className="eyebrow">{title} · 当前事实</p><h1>{kind === "definition" ? "当前任务定义" : "当前验收与验证来源"}</h1>
    <p className="page-lede">此页读取已保存的任务事实；可确认的 Skill 合并提案请在该任务的 Assist 会话中查看。</p>
    <button className="secondary-button" type="button" disabled={loading || traceLoading} onClick={() => setReload((value) => value + 1)}>刷新当前事实</button>
    {loading && <p role="status">正在读取任务与验收事实…</p>}
    {error && <p className="action-error" role="alert">{error}</p>}
    {task && <>
      {task.projectId && <p className="helper-text" data-testid="task-skill-project-status">{projectReadError
        ? `Project 状态无法核对：${projectReadError}；本页仍可阅读已取得的 Task 事实。`
        : projectArchivedAt === undefined ? "正在核对所属 Project 的归档状态…"
          : projectArchivedAt !== null ? "项目已归档；这里只保留已接受事实和历史证据的阅读入口。"
            : "所属 Project 正在进行中。"}</p>}
      <section className="surface-panel" data-testid="live-task-accepted-facts"><h2>已接受的当前事实</h2>
        <p><strong>{task.title}</strong> · 任务 v{task.revision} · {taskStatusLabels[task.status]} · {interactionModeLabels[task.mode]} · 执行者 {executorLabels[task.executor]}</p>
        <p>验收版本 v{task.acceptance.acceptanceRevision} · 来源 {task.acceptance.source}</p>
        <h3>目标</h3><p>{task.acceptance.objective || "当前验收目标为空。"}</p>
        <h3>当前验收条件</h3>{task.acceptance.criteria.length ? <ol>{task.acceptance.criteria.map((criterion) =>
          <li key={criterion.criterionId}><strong>{criterion.statement}</strong><small>条件 ID {criterion.criterionId} · {criterion.required ? "必需" : "可选"} · 方式 {criterion.method}</small></li>)}</ol>
          : <p className="helper-text">当前版本没有验收条件。</p>}
        <p className="helper-text">{kind === "definition"
          ? `当前验收预期产物类型：${task.acceptance.expectedOutputs === null ? "此响应未提供" :
            typeof task.acceptance.expectedOutputs.kind === "string" ? task.acceptance.expectedOutputs.kind :
              Array.isArray(task.acceptance.expectedOutputs.artifacts) ?
                task.acceptance.expectedOutputs.artifacts.join("、") : "未声明"}。当前 Task 单读未提供输入资料绑定；不从示例提案补造字段。`
          : "验收条件中的方式是当前 Task 事实，不等于已应用的 CheckPlan 或检查结果。"}</p>
        <Link className="text-link" to={`/tasks/${id}`}>打开任务详情</Link>
      </section>
      <section className="surface-panel" data-testid="live-task-skill-gap"><h2>Skill 建议</h2>
        <p>{kind === "definition" ? "当前没有针对这项已有任务、可在此确认的任务定义 Skill 提案。"
          : "此页不直接接受建议；如有服务端合并提案，请在该任务的 Assist 会话中确认。"}</p>
        <p className="helper-text">Assist 可讨论当前任务；进入会话或发送消息不会修改任务、验收标准、检查方案或执行权。</p>
        <Link className="text-link" to={`/tasks/${id}?skill=assist`}>打开此任务的 Assist</Link>
      </section>
      {kind === "verification" && <TaskCheckPlanPreview key={`${id}:${reload}`} client={client} taskId={id}
        taskRevision={task.revision} acceptanceRevision={task.acceptance.acceptanceRevision} />}
      <section className="surface-panel" data-testid="live-task-verification-source"><h2>确切 Run / Verification 来源</h2>
        {task.executorRunId ? <><p>当前 Task 指向 Run <Link className="inline-link" to={`/runs/${task.executorRunId}`}>{task.executorRunId}</Link>。</p>
          {traceLoading && <p role="status">正在读取该 Run 的验证证据…</p>}
          {traceError && <p className="action-error" role="alert">{traceError}</p>}
          {trace && (trace.verifications.length ? <ul>{trace.verifications.map((session) => <li key={session.id}>
            <strong>Verification Session {session.id} · {session.status} · 判定 {session.verdict ?? "尚无"}</strong>
            <small>验收 v{session.acceptanceRevision} · CheckPlan hash {session.checkPlanHash} · {session.createdAt}</small>
            <p>{session.checks.length ? session.checks.map((check) => `${check.criterionId}: ${check.result}`).join("；") : "该会话没有检查结果。"}</p>
            {session.targets.map((target) => <p key={target.artifactVersionId}>目标产物版本 <Link className="inline-link" to={`/artifact-versions/${target.artifactVersionId}/lineage`}>{target.artifactVersionId}</Link> · sha256 {target.contentSha256}</p>)}</li>)}</ul>
            : <p className="helper-text">该 Run 的 Trace 未记录验证会话。</p>)}
          <p className="helper-text">Run Trace 是历史证据；版本号或 PASS 不单独证明当前验收仍有效，也不表示任务已完成。</p></>
          : <p className="helper-text">当前 Task 没有指向 Run；本接口不提供历史 Run 列表，不能由任务状态推断曾运行过验证。</p>}
      </section>
    </>}
  </section>;
}
