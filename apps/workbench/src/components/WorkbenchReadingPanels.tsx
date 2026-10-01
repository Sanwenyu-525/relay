import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { FileText } from "lucide-react";
import { RelayTransportError, type RelayApiClient, type RelayKnowledgeVersionContent, type RelayRun, type RelayRunTrace,
  type RelayTaskArtifacts, type RelayTaskDetail } from "../api/relayClient";
import { describeLiveError } from "../lib/liveErrors";
import { executorLabels, interactionModeLabels } from "../lib/labels";
import { liveClient } from "../lib/relayConnection";
import SafeMarkdown from "./SafeMarkdown";
import StatusChip from "./StatusChip";
import { runLabels, stepLabels, stepStatusLabels } from "./RunControlPanel";

function readError(caught: unknown): string {
  return caught instanceof RelayTransportError ? "读取失败，请检查本机服务连接后重新读取。" : describeLiveError(caught).message;
}

export type WorkbenchReadingTarget = {
  readonly kind: "artifact"; readonly id: string; readonly artifactId: string;
  readonly taskId: string; readonly title: string; readonly version: string;
  readonly sha256: string;
} | {
  readonly kind: "knowledge"; readonly id: string; readonly title: string;
  readonly sourceProjectId: string | null;
  readonly version: string; readonly sha256: string;
};

/** 工作台仅阅读确切版本；来源丢失不能用最新版补齐。 */
export function WorkbenchDocumentReader({ client, projectId, target }: {
  readonly client: RelayApiClient; readonly projectId: string;
  readonly target: WorkbenchReadingTarget | null;
}) {
  const [reading, setReading] = useState<{ title: string; body: string; mediaType: string; partial: boolean;
    owner: RelayApiClient; targetKey: string; taskTitle?: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const epoch = useRef(0);
  const targetKey = `${projectId}:${target?.kind}:${target?.id}:${target?.version}:${target?.sha256}`;
  const currentReading = reading?.owner === client && reading.targetKey === targetKey ? reading : null;
  useEffect(() => {
    const request = ++epoch.current;
    setReading(null); setError(null); setLoading(target !== null);
    if (!target) return;
    async function read() {
      if (!target) return;
      if (target.kind === "knowledge") {
        const content: RelayKnowledgeVersionContent = await client.getKnowledgeVersionContent(target.id, target.version);
        if (content.knowledgeId !== target.id || content.version !== target.version ||
          content.projectId !== target.sourceProjectId ||
          (target.sourceProjectId !== null && target.sourceProjectId !== projectId) || content.contentSha256 !== target.sha256)
          throw new Error("资料正文与所选项目、版本或摘要不一致，已停止展示。");
        if (content.content === null || (content.contentStatus !== "FULL" && content.contentStatus !== "PARTIAL"))
          throw new Error(`所选资料正文不可读（${content.contentStatus}），请到资料页核对来源。`);
        return { title: content.title, body: content.content, mediaType: content.mediaType,
          partial: content.contentStatus === "PARTIAL" };
      }
      const [artifact, task] = await Promise.all([client.getArtifact(target.artifactId), client.getTask(target.taskId)]);
      const version = artifact.versions.find((item) => item.artifactVersionId === target.id);
      if (artifact.id !== target.artifactId || artifact.taskId !== target.taskId || task.id !== target.taskId ||
        task.projectId !== projectId || !version || version.versionNumber !== target.version || version.sha256 !== target.sha256)
        throw new Error("产物与所选项目、任务或确切版本不一致，已停止展示。");
      const body = await client.getArtifactVersionContent(target.id);
      return { title: artifact.title, body, mediaType: version.mediaType, partial: false, taskTitle: task.title };
    }
    void read().then((result) => {
      if (request === epoch.current && client === liveClient() && result) setReading({ ...result, owner: client, targetKey });
    }).catch((caught: unknown) => {
      if (request === epoch.current && client === liveClient()) setError(readError(caught));
    }).finally(() => { if (request === epoch.current) setLoading(false); });
    return () => { epoch.current++; };
  }, [client, projectId, target?.kind, target?.id, target?.version, target?.sha256,
    target?.kind === "knowledge" ? target.sourceProjectId : target?.taskId, reload]);

  return <article className="workbench-paper" data-testid="workbench-document-reader" aria-busy={loading}>
    <header className="workbench-paper-heading"><span>{target?.kind === "knowledge" ? "资料原文" : "已保存草稿"}</span>
      {target && <span>v{target.version} · 只读</span>}</header>
    {!target ? <div className="workbench-paper-empty"><FileText aria-hidden="true" /><h2>选择一份资料或草稿</h2><p>从左侧目录选择确切版本后，在这里阅读全文。</p></div> : <>
      {loading && <p role="status">正在读取所选版本正文…</p>}
      {error && <div className="workbench-paper-empty" role="alert"><h2>正文暂时不可读</h2><p>{error}</p><button className="secondary-button" type="button" onClick={() => setReload((value) => value + 1)}>重新读取正文</button></div>}
      {currentReading && <><h2 className="workbench-document-title">{currentReading.title}</h2>
        {currentReading.partial && <p className="warning-callout">当前来源只提供部分正文，不能视为完整资料。</p>}
        <div className="workbench-document-body" data-testid="workbench-document-body">{currentReading.mediaType.includes("markdown") ? <SafeMarkdown source={currentReading.body} /> : <pre>{currentReading.body}</pre>}</div>
        <footer className="workbench-paper-footer"><span>确切版本 v{target.version}{currentReading.taskTitle ? ` · 归属任务：${currentReading.taskTitle}` : ""}</span>
          <Link className="text-link" to={target.kind === "artifact" ? `/tasks/${target.taskId}?tab=artifacts` : `/projects/${projectId}/knowledge?kind=KNOWLEDGE&item=${target.id}&version=${target.version}`}>打开原内容入口</Link>
        </footer></>}
    </>}
  </article>;
}

interface TaskFacts { readonly task: RelayTaskDetail; readonly artifacts: RelayTaskArtifacts | null;
  readonly run: RelayRun | null; readonly errors: readonly string[] }

export function WorkbenchTaskFacts({ client, projectId, taskId }: {
  readonly client: RelayApiClient; readonly projectId: string; readonly taskId: string;
}) {
  const [facts, setFacts] = useState<TaskFacts | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const epoch = useRef(0);
  useEffect(() => {
    const request = ++epoch.current;
    setFacts(null); setError(null); setLoading(true);
    void client.getTask(taskId).then(async (task) => {
      if (task.id !== taskId || task.projectId !== projectId) throw new Error("任务不属于当前项目，已停止展示。");
      const [artifactResult, runResult] = await Promise.allSettled([
        client.getTaskArtifacts(taskId), task.executorRunId ? client.getRun(task.executorRunId) : Promise.resolve(null)
      ]);
      const errors: string[] = [];
      const artifacts = artifactResult.status === "fulfilled" ? artifactResult.value : null;
      const run = runResult.status === "fulfilled" ? runResult.value : null;
      if (artifactResult.status === "rejected") errors.push(`产物读取失败：${readError(artifactResult.reason)}`);
      if (artifacts?.items.some((item) => item.taskId !== taskId)) throw new Error("产物关联了其他任务，已停止展示。");
      if (runResult.status === "rejected") errors.push(`Run 读取失败：${readError(runResult.reason)}`);
      if (run && (run.taskId !== taskId || run.id !== task.executorRunId)) throw new Error("Run 关联了其他任务，已停止展示。");
      if (request === epoch.current && client === liveClient()) setFacts({ task, artifacts, run, errors });
    }).catch((caught: unknown) => {
      if (request === epoch.current && client === liveClient()) setError(readError(caught));
    }).finally(() => { if (request === epoch.current) setLoading(false); });
    return () => { epoch.current++; };
  }, [client, projectId, taskId]);
  if (loading) return <p role="status">正在读取任务目标与当前版本…</p>;
  if (error) return <p className="action-error" role="alert">{error}</p>;
  if (!facts) return null;
  const { task, artifacts, run } = facts;
  return <div data-testid="workbench-task-facts">
    <div className="workbench-task-meta"><StatusChip status={task.status} /><span>执行模式：{interactionModeLabels[task.mode]}</span><span>当前执行者：{executorLabels[task.executor]}</span><span>Task v{task.revision}</span></div>
    {artifacts?.items.map((artifact) => <div className="workbench-artifact-card" key={artifact.id}><FileText aria-hidden="true" /><div><strong>{artifact.title}</strong><small>{artifact.versions.length} 个已保存版本 · 最新版本由服务端指定</small></div><Link className="text-link" to={`/tasks/${taskId}?tab=artifacts`}>查看版本历史</Link></div>)}
    <section className="workbench-section workbench-objective"><h2>任务目标</h2><p>{task.acceptance.objective || "当前验收版本没有目标正文，请在任务详情核对。"}</p>
      {task.acceptance.criteria.length > 0 && <ul>{task.acceptance.criteria.map((criterion) => <li key={criterion.criterionId}>{criterion.statement}<small>{criterion.required ? "必需" : "可选"} · {criterion.method}</small></li>)}</ul>}</section>
    <section className="workbench-section"><h2>执行步骤</h2>{run?.steps.length ? <ol className="workbench-step-list">{[...run.steps].sort((a, b) => a.index - b.index).map((step) => <li key={step.id}><span className="workbench-step-number">{step.index + 1}</span><div><strong title={step.kind}>{stepLabels[step.kind] ?? "其他执行步骤"}</strong><p>{step.reason ?? "来自当前关联 Run 的步骤记录"}</p></div><span className="workbench-step-status" title={step.status}>{stepStatusLabels[step.status] ?? "状态待核对"}</span></li>)}</ol> : <p>当前任务没有可读取的 Run 步骤。人工处理过程未登记为执行步骤。</p>}
      {run && <Link className="text-link" to={`/runs/${run.id}`}>查看执行记录</Link>}</section>
    {facts.errors.map((message) => <p className="action-error" role="alert" key={message}>{message}</p>)}
    <Link className="primary-button workbench-save-entry" to={`/tasks/${taskId}?tab=artifacts`}>打开任务保存结果</Link>
  </div>;
}

export function WorkbenchRunEvidence({ client, projectId, taskId, runId, selectedVersion }: {
  readonly client: RelayApiClient; readonly projectId: string; readonly taskId: string;
  readonly runId: string; readonly selectedVersion: { readonly id: string; readonly sha256: string } | null;
}) {
  const [trace, setTrace] = useState<RelayRunTrace | null>(null);
  const [error, setError] = useState<string | null>(null);
  const epoch = useRef(0);
  useEffect(() => {
    const request = ++epoch.current;
    setTrace(null); setError(null);
    void client.getRunTrace(runId).then((result) => {
      if (result.runId !== runId || result.taskId !== taskId || result.projectId !== projectId)
        throw new Error("执行证据不属于当前项目与任务。");
      if (request === epoch.current && client === liveClient()) setTrace(result);
    }).catch((caught: unknown) => {
      if (request === epoch.current && client === liveClient()) setError(readError(caught));
    });
    return () => { epoch.current++; };
  }, [client, projectId, taskId, runId]);
  return <section className="rail-section" data-testid="workbench-run-evidence"><h3>运行检查证据</h3>
    {error ? <p className="action-error" role="alert">{error}</p> : !trace ? <p role="status">正在读取运行证据…</p> : <>
      <p title={trace.status}>{runLabels[trace.status] ?? "运行状态待核对"} · {trace.verifications.length} 个验证会话</p>
      {trace.verifications.flatMap((session) => session.checks.map((check) => <div className="workbench-check" key={check.id}><strong>条件 {check.criterionId}</strong><span title={check.result}>{({ PASS: "通过", FAIL: "未通过", ERROR: "检查器错误", SKIP: "未执行" } as Record<string, string>)[check.result] ?? "待核对"}</span><small>{selectedVersion && session.targets.some((target) => target.artifactVersionId === selectedVersion.id && target.contentSha256 === selectedVersion.sha256) ? "绑定所选产物版本；当前适用性仍需核对" : "历史记录，未绑定所选产物版本"}</small></div>))}
      {!trace.verifications.length && <p>没有已登记的验证会话。</p>}
    </>}
    <Link className="text-link" to={`/runs/${runId}`}>查看原 Run 证据</Link>
  </section>;
}
