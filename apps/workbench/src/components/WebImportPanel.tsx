import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import {
  createCommandId, RelayApiError, RelayTransportError,
  type RelayApiClient, type RelayGatewayConnection, type RelayKnowledge,
  type RelayKnowledgeVersion, type RelayReview, type RelayWebImportJob,
  type RelayWebImportOperation
} from "../api/relayClient";
import { describeLiveError } from "../lib/liveErrors";

interface PendingImport {
  readonly commandId: string;
  readonly projectId: string;
  readonly connectionId: string;
  readonly url: string;
}

interface ImportResult {
  readonly knowledge: RelayKnowledge;
  readonly version: RelayKnowledgeVersion;
}

const statusText: Record<RelayWebImportJob["status"], string> = {
  QUEUED: "已排队，尚未抓取",
  RUNNING: "处理中，等待 Gateway 结算",
  SUCCEEDED: "导入成功，Knowledge 版本已落库",
  FAILED: "导入失败"
};

function validPublicUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") &&
      url.username === "" && url.password === "" && url.hash === "";
  } catch { return false; }
}

function reviewForOperation(reviews: readonly RelayReview[], operation: RelayWebImportOperation,
  jobId: string): RelayReview | null {
  return reviews.find((review) => review.kind === "ACTION_APPROVAL" && review.status === "OPEN" &&
    review.target.operation_id === operation.id && review.target.import_job_id === jobId) ?? null;
}

export default function WebImportPanel({ client, projectId, onOpenKnowledge }: {
  readonly client: RelayApiClient;
  readonly projectId: string;
  readonly onOpenKnowledge: (id: string) => void;
}) {
  const [connections, setConnections] = useState<readonly RelayGatewayConnection[]>([]);
  const [connectionId, setConnectionId] = useState("");
  const [url, setUrl] = useState("");
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [loadingConnections, setLoadingConnections] = useState(true);
  const [projectArchivedAt, setProjectArchivedAt] = useState<string | null | undefined>(undefined);
  const [projectReadError, setProjectReadError] = useState<string | null>(null);
  const [projectReload, setProjectReload] = useState(0);
  const [pending, setPending] = useState<PendingImport | null>(null);
  const [mayRetry, setMayRetry] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [jobIdInput, setJobIdInput] = useState("");
  const [currentJobId, setCurrentJobId] = useState<string | null>(null);
  const [job, setJob] = useState<RelayWebImportJob | null>(null);
  const [operations, setOperations] = useState<readonly RelayWebImportOperation[]>([]);
  const [review, setReview] = useState<RelayReview | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const active = useRef(true);
  const projectReadVersion = useRef(0);
  const readVersion = useRef(0);
  const readingId = useRef<string | null>(null);

  useEffect(() => {
    active.current = true;
    const projectRead = ++projectReadVersion.current;
    setProjectArchivedAt(undefined); setProjectReadError(null);
    setConnections([]); setConnectionId(""); setLoadingConnections(true); setConnectionError(null);
    void client.getProject(projectId).then((project) => {
      if (!active.current || projectRead !== projectReadVersion.current) return;
      if (project.id !== projectId) throw new RelayTransportError("Project 读取结果与导入目标不匹配。");
      setProjectArchivedAt(project.archivedAt);
    }).catch((caught: unknown) => { if (active.current && projectRead === projectReadVersion.current) setProjectReadError(describeLiveError(caught).message); });
    void client.getGatewayConnections(projectId).then((items) => {
      if (!active.current || projectRead !== projectReadVersion.current) return;
      const available = items.filter((item) => item.status === "ACTIVE" && item.capabilities.includes("WEB_FETCH"));
      setConnections(available);
      setConnectionId((current) => available.some((item) => item.id === current) ? current : (available[0]?.id ?? ""));
      setConnectionError(null);
    }).catch((caught) => {
      if (active.current && projectRead === projectReadVersion.current) { setConnections([]); setConnectionId(""); setConnectionError(describeLiveError(caught).message); }
    }).finally(() => { if (active.current && projectRead === projectReadVersion.current) setLoadingConnections(false); });
    return () => { active.current = false; projectReadVersion.current++; readVersion.current++; };
  }, [client, projectId, projectReload]);

  async function resolveKnowledge(importJob: RelayWebImportJob): Promise<ImportResult | null> {
    if (importJob.knowledgeVersionId === null) return null;
    const list = await client.getKnowledge(projectId);
    // P17 writes the original normalized URL as the Knowledge root title. Match
    // the exact immutable version ID, since importing the same URL twice is valid.
    for (const knowledge of list.filter((item) => item.projectId === projectId && item.title === importJob.sourceUri)) {
      const versions = await client.getKnowledgeVersions(knowledge.id);
      const version = versions.find((item) => item.id === importJob.knowledgeVersionId);
      if (version) return { knowledge, version };
    }
    return null;
  }

  async function readJob(id: string, expected?: PendingImport): Promise<void> {
    if (readingId.current === id) return;
    readingId.current = id;
    const version = ++readVersion.current;
    setReading(true); setReadError(null);
    try {
      const latest = await client.getWebImportJob(id);
      if (!active.current || version !== readVersion.current) return;
      if (latest.id !== id || latest.projectId !== projectId ||
          (expected !== undefined && (latest.requestCommandId !== expected.commandId ||
            latest.sourceUri !== new URL(expected.url).toString()))) {
        throw new Error("Job 与当前项目或原命令不匹配。");
      }
      if (expected !== undefined) setPending(null);
      setJob(latest); setCurrentJobId(id); setResult(null);
      const nextOperations = await client.getWebImportOperations(id);
      if (!active.current || version !== readVersion.current) return;
      setOperations(nextOperations);
      const waiting = nextOperations.find((operation) => operation.status === "WAITING_APPROVAL");
      if (waiting) {
        const reviews = await client.getReviews();
        if (!active.current || version !== readVersion.current) return;
        setReview(reviewForOperation(reviews, waiting, id));
      } else setReview(null);
      if (latest.status === "SUCCEEDED") {
        const imported = await resolveKnowledge(latest);
        if (!active.current || version !== readVersion.current) return;
        setResult(imported);
        if (imported === null) setReadError("Job 已成功，但当前资料列表未定位到对应版本；请稍后刷新，保留原版本 ID 核对。");
      }
    } catch (caught) {
      if (active.current && version === readVersion.current) {
        setJob(null); setOperations([]); setReview(null); setResult(null);
        setReadError(describeLiveError(caught).message);
      }
    } finally {
      if (readingId.current === id) readingId.current = null;
      if (active.current && version === readVersion.current) setReading(false);
    }
  }

  useEffect(() => {
    if (currentJobId === null || job?.status === "SUCCEEDED" || job?.status === "FAILED") return;
    const timer = window.setInterval(() => { void readJob(currentJobId); }, 2000);
    return () => window.clearInterval(timer);
  }, [currentJobId, job?.status]);

  async function sendImport(command: PendingImport): Promise<void> {
    setSubmitting(true); setActionError(null);
    try {
      const submission = await client.createWebImportJob(command);
      if (!active.current) return;
      setCurrentJobId(null); setJobIdInput(submission.importJobId);
      setJob(null); setOperations([]); setReview(null); setResult(null);
      await readJob(submission.importJobId, command);
    } catch (caught) {
      if (!active.current) return;
      if (caught instanceof RelayTransportError) {
        setActionError("响应丢失或回执无法核对。请查询原 command_id，或只用相同 ID 和载荷重试。");
      } else if (caught instanceof RelayApiError && caught.problem.status === 409) {
        setActionError(describeLiveError(caught).message);
      } else {
        setPending(null);
        setActionError(describeLiveError(caught).message);
      }
    } finally { if (active.current) setSubmitting(false); }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending !== null || submitting || connectionId === "" || projectArchivedAt !== null) return;
    const sourceUrl = url.trim();
    if (!validPublicUrl(sourceUrl)) {
      setActionError("请输入无用户信息、无片段的 http(s) URL。公共地址及连接边界由服务端核验。");
      return;
    }
    setSubmitting(true);
    try {
      const project = await client.getProject(projectId);
      if (!active.current) return;
      if (project.id !== projectId) throw new RelayTransportError("Project 读取结果与导入目标不匹配。");
      setProjectArchivedAt(project.archivedAt); setProjectReadError(null);
      if (project.archivedAt !== null) { setActionError("项目已归档，不能提交新的网页导入。"); return; }
      const command = { commandId: createCommandId(), projectId, connectionId, url: sourceUrl };
      setPending(command); setMayRetry(false);
      await sendImport(command);
    } catch (caught) {
      if (active.current) { setProjectArchivedAt(undefined); setProjectReadError(describeLiveError(caught).message); setActionError("关联 Project 无法确认可写，网页导入尚未提交。"); }
    } finally { if (active.current) setSubmitting(false); }
  }

  async function checkReceipt() {
    if (pending === null || submitting) return;
    setSubmitting(true); setActionError(null); setMayRetry(false);
    try {
      const receipt = await client.getCommandReceipt(pending.commandId);
      const result = receipt.result;
      if (receipt.commandId !== pending.commandId || receipt.commandType !== "CreateWebImportJob" ||
          result.project_id !== projectId || result.connection_id !== pending.connectionId ||
          result.status !== "QUEUED" || typeof result.import_job_id !== "string") {
        throw new RelayTransportError("原命令回执与当前导入目标不匹配。");
      }
      const id = result.import_job_id;
      if (!active.current) return;
      setMayRetry(false);
      setCurrentJobId(null); setJobIdInput(id); setJob(null);
      setOperations([]); setReview(null); setResult(null);
      await readJob(id, pending);
    } catch (caught) {
      if (!active.current) return;
      if (caught instanceof RelayApiError && caught.problem.code === "COMMAND_NOT_FOUND") setMayRetry(true);
      setActionError(caught instanceof RelayApiError && caught.problem.code === "COMMAND_NOT_FOUND"
        ? "尚未找到原命令回执。稍后继续查询，或用相同 command_id 和载荷重试。"
        : describeLiveError(caught).message);
    } finally { if (active.current) setSubmitting(false); }
  }

  function restoreJob(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const id = jobIdInput.trim();
    if (!id) return;
    readVersion.current++;
    setCurrentJobId(null); setJob(null); setOperations([]); setReview(null); setResult(null);
    void readJob(id);
  }

  const waiting = operations.find((operation) => operation.status === "WAITING_APPROVAL");
  const projectWriteBlockedReason = projectReadError ? `Project 读取失败：${projectReadError}`
    : projectArchivedAt === undefined ? "正在核对 Project 归档状态。"
      : projectArchivedAt !== null ? "项目已归档，不能提交新的网页导入。" : null;
  return <section className="surface-panel knowledge-import" aria-label="网页导入" data-testid="web-import-panel">
    <h2>导入公共网页</h2>
    <p className="helper-text">选择本项目的 WEB_FETCH 连接，提交后由后台经 Gateway 抓取；排队回执不代表导入成功。</p>
    {projectWriteBlockedReason && <p className="disabled-reason" data-testid="web-import-project-write-blocked">{projectWriteBlockedReason} <button type="button" className="text-button" onClick={() => setProjectReload((value) => value + 1)}>重读项目状态</button></p>}
    {loadingConnections && <p role="status">正在读取可用连接…</p>}
    {connectionError && <p className="action-error" role="alert">{connectionError}</p>}
    {!loadingConnections && !connectionError && connections.length === 0 &&
      <p className="helper-text">本项目没有可用的 ACTIVE WEB_FETCH 连接。请先配置允许抓取该主机的连接与权限。</p>}
    <form onSubmit={submit} data-testid="web-import-form">
      <label className="field"><span className="field-label">WEB_FETCH 连接</span>
        <select data-testid="web-import-connection" value={connectionId} onChange={(event) => setConnectionId(event.target.value)}
          disabled={connections.length === 0 || pending !== null || submitting} required>
          {connections.length === 0 && <option value="">无可用连接</option>}
          {connections.map((item) => <option key={item.id} value={item.id}>{item.allowedHost ? `${item.allowedHost} · ${item.id}` : item.id}</option>)}
        </select></label>
      <label className="field"><span className="field-label">公共网页 URL</span>
        <input data-testid="web-import-url" type="url" value={url} onChange={(event) => setUrl(event.target.value)}
          maxLength={2048} required disabled={pending !== null || submitting} placeholder="https://example.org/article" /></label>
      <div className="knowledge-actions"><button type="submit" className="primary-button" data-testid="web-import-submit"
        disabled={projectWriteBlockedReason !== null || connectionId === "" || pending !== null || submitting}>{submitting ? "正在提交…" : "提交导入"}</button></div>
    </form>
    {actionError && <p className="action-error" role="alert">{actionError}</p>}
    {pending && <div className="knowledge-import-receipt" data-testid="web-import-pending">
      <p>提交结果待核对 · 原 command_id：<code>{pending.commandId}</code></p>
      <div className="knowledge-actions"><button type="button" className="secondary-button" disabled={submitting}
        data-testid="web-import-check-receipt" onClick={() => { void checkReceipt(); }}>查询原命令回执</button>
        <button type="button" className="secondary-button" disabled={submitting || !mayRetry}
          data-testid="web-import-retry" onClick={() => { if (mayRetry) void sendImport(pending); }}>用原 ID 重试</button></div>
    </div>}
    <form className="knowledge-import-restore" onSubmit={restoreJob}>
      <label className="field"><span className="field-label">按 Job ID 恢复查询</span>
        <input data-testid="web-import-job-id" value={jobIdInput} onChange={(event) => setJobIdInput(event.target.value)}
          placeholder="导入 Job ID" /></label>
      <button type="submit" className="secondary-button" disabled={reading || !jobIdInput.trim()} data-testid="web-import-restore">查询 Job</button>
    </form>
    {reading && <p role="status">正在核对导入状态…</p>}
    {readError && <p className="action-error" role="alert">{readError} {currentJobId &&
      <button type="button" className="text-button" onClick={() => { void readJob(currentJobId); }}>重新读取</button>}</p>}
    {job && <div className="knowledge-import-status" data-testid="web-import-status">
      <p><strong>{statusText[job.status]}</strong> · {job.status}</p>
      <p className="helper-text">Job ID：<code>{job.id}</code> · 修订 v{job.revision}</p>
      <p className="helper-text">来源：{job.sourceUri}</p>
      {job.error && <p className="action-error">失败原因：{job.error}</p>}
      {operations.map((operation) => <p key={operation.id} className="helper-text">
        Gateway 动作 <code>{operation.id}</code> · {operation.actionType} · {operation.status}
        {operation.invocationStatuses.length > 0 && <> · Invocation {operation.invocationStatuses.join("、")}</>}
      </p>)}
      {waiting && <p>原 Gateway 动作正在等待批准。
        {review ? <> <Link className="text-link" to={`/reviews?id=${encodeURIComponent(review.id)}`}>查看关联 Review</Link></>
          : <> <Link className="text-link" to="/reviews">查看待审入口</Link></>}
      </p>}
      {job.status === "SUCCEEDED" && <>
        <p>Knowledge 版本 ID：<code>{job.knowledgeVersionId ?? "服务端未返回"}</code></p>
        {result && <div data-testid="web-import-result"><p><strong>{result.knowledge.title}</strong> · WEB_PAGE v{result.version.version}</p>
          <p className="knowledge-body">{result.version.excerpt ?? "正文摘录未返回，可在资料详情中核对版本与来源。"}</p>
          <button type="button" className="secondary-button" onClick={() => onOpenKnowledge(result.knowledge.id)}>查看 Knowledge 详情</button></div>}
      </>}
    </div>}
  </section>;
}
