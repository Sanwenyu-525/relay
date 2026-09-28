import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { AlertTriangle, RotateCcw } from "lucide-react";
import RunSourcesPanel from "../components/RunSourcesPanel";
import RunTracePanel from "../components/RunTracePanel";
import FileWriteDispositionPanel from "../components/FileWriteDispositionPanel";
import { createCommandId, RelayApiError, RelayRunEventHttpError, RelayTransportError, type RelayControlRequest, type RelayControlType, type RelayContextBuild, type RelayContextManifestDetail, type RelayContextManifestSummary, type RelayReview, type RelayRun, type RelayRunDraftPreview, type RelayRunGatewayOperation, type RelayTaskDetail } from "../api/relayClient";
import { describeLiveError } from "../lib/liveErrors";
import { executorLabels, taskStatusLabels } from "../lib/labels";
import { liveClient, useRelayConnection } from "../lib/relayConnection";

const controlLabels: Record<RelayControlType, string> = { PAUSE: "请求暂停 Run", CANCEL: "请求停止 Run", HANDOFF: "请求交接给人工", CANCEL_TASK: "请求取消任务" };
const runLabels: Record<string, string> = { CREATED: "待启动", CONTEXT_BUILDING: "构建上下文", PLANNING: "规划中", RUNNING: "执行中", WAITING_APPROVAL: "等待人工判断", VERIFYING: "验证中", RETRYING: "修正中", PAUSED: "已暂停", COMPLETED: "已完成", FAILED: "失败", CANCELLED: "已停止" };
const stepLabels: Record<string, string> = { BUILD_CONTEXT: "构建上下文", DRAFT: "生成草稿", PERSIST_CANDIDATE: "保存候选产物", VERIFY: "验证", COMPLETE: "提交完成" };
function sourceReadError(caught: unknown): string {
  if (caught instanceof RelayApiError && [403, 404].includes(caught.problem.status)) return "来源已不可读取或当前范围无权查看。旧片段已清除，请重新核对权限。";
  return describeLiveError(caught).message;
}

function waitForEventRetry(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const finish = () => { window.clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
    const timer = window.setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
  });
}

export default function RunView() {
  const { id = "" } = useParams();
  const connection = useRelayConnection();
  const live = connection.mode === "live";
  const [run, setRun] = useState<RelayRun | null>(null);
  const runRef = useRef(run); runRef.current = run;
  const [task, setTask] = useState<RelayTaskDetail | null>(null);
  const [projectArchivedAt, setProjectArchivedAt] = useState<string | null | undefined>(undefined);
  const [projectReadError, setProjectReadError] = useState<string | null>(null);
  const [reviews, setReviews] = useState<readonly RelayReview[]>([]);
  const [controlRecord, setControlRecord] = useState<RelayControlRequest | null>(null);
  const [acceptedControl, setAcceptedControl] = useState<{ id: string; type: RelayControlType } | null>(null);
  const acceptedControlRef = useRef(acceptedControl); acceptedControlRef.current = acceptedControl;
  const [pendingCommand, setPendingCommand] = useState<{ id: string; kind: "control" | "resume"; type?: RelayControlType } | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [eventStatus, setEventStatus] = useState<"connecting" | "connected" | "reconnecting" | "unauthorized" | null>(null);
  const [draftPreview, setDraftPreview] = useState<RelayRunDraftPreview | null>(null);
  const draftPreviewRef = useRef<RelayRunDraftPreview | null>(null);
  const previewIdentity = useRef<string | null>(null);
  const [sourceBuild, setSourceBuild] = useState<RelayContextBuild | null>(null);
  const [sourceManifests, setSourceManifests] = useState<readonly RelayContextManifestSummary[]>([]);
  const sourceManifestsRef = useRef<readonly RelayContextManifestSummary[]>([]);
  const [sourceSelectedId, setSourceSelectedId] = useState<string | null>(null);
  const selectedSourceRef = useRef<string | null>(null); selectedSourceRef.current = sourceSelectedId;
  const [sourceDetail, setSourceDetail] = useState<RelayContextManifestDetail | null>(null);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [sourceDetailLoading, setSourceDetailLoading] = useState(false);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [gatewayOpen, setGatewayOpen] = useState(false);
  const [traceOpen, setTraceOpen] = useState(false);
  const [gatewayOperations, setGatewayOperations] = useState<readonly RelayRunGatewayOperation[]>([]);
  const [gatewayLoading, setGatewayLoading] = useState(false);
  const [gatewayError, setGatewayError] = useState<string | null>(null);
  const gatewayRequestVersion = useRef(0);
  const requestVersion = useRef(0);
  const targetVersion = useRef(0);
  const sourceRequestVersion = useRef(0);
  const sourceDetailVersion = useRef(0);
  const activeRun = run !== null && task?.executor === "AI" && task.executorRunId === run.id;
  const terminal = run !== null && ["COMPLETED", "FAILED", "CANCELLED"].includes(run.status);
  const draftStep = run?.steps.find((step) => step.id === run.currentStepId);
  const canReadDraft = live && run?.id === id && run.status === "RUNNING" && activeRun &&
    draftStep?.kind === "DRAFT" && draftStep.status === "RUNNING" &&
    run.pendingControlRequest === null && error === null && eventStatus !== "unauthorized";
  const projectWriteBlockedReason = !task || task.projectId === null ? null
    : projectArchivedAt === undefined || refreshing || loading || error !== null
      ? `Project 事实正在核对或读取失败，不能提交新的 Run 控制命令。${projectReadError ?? ""}`
      : projectArchivedAt !== null ? "项目已归档，不能提交新的 Run 控制命令。" : null;
  const canControl = live && run?.id === id && activeRun && !terminal && projectWriteBlockedReason === null && run?.pendingControlRequest === null && pendingCommand === null && !submitting;
  const openReviews = reviews.filter((review) => review.status === "OPEN");

  async function selectSource(manifestId: string, runId = runRef.current?.id) {
    const client = liveClient();
    if (!client || !runId || !sourceManifestsRef.current.some((item) => item.id === manifestId)) return;
    const version = ++sourceDetailVersion.current;
    const context = targetVersion.current;
    setSourceSelectedId(manifestId); selectedSourceRef.current = manifestId; setSourceDetail(null); setSourceError(null); setSourceDetailLoading(true);
    try { const detail = await client.getRunContextManifest(runId, manifestId); if (version === sourceDetailVersion.current && context === targetVersion.current && runRef.current?.id === runId) setSourceDetail(detail); }
    catch (caught) { if (version === sourceDetailVersion.current && context === targetVersion.current) setSourceError(sourceReadError(caught)); }
    finally { if (version === sourceDetailVersion.current && context === targetVersion.current) setSourceDetailLoading(false); }
  }
  async function loadSources(runId: string) {
    const client = liveClient(); if (!client) return;
    const version = ++sourceRequestVersion.current;
    const context = targetVersion.current;
    const preferredId = selectedSourceRef.current;
    sourceDetailVersion.current++;
    setSourceDetail(null); setSourceManifests([]); sourceManifestsRef.current = []; setSourceBuild(null); setSourceError(null); setSourceLoading(true); setSourceDetailLoading(false);
    try {
      const result = await client.getRunContextManifests(runId);
      if (version !== sourceRequestVersion.current || context !== targetVersion.current || runRef.current?.id !== runId) return;
      setSourceBuild(result.build); setSourceManifests(result.items); sourceManifestsRef.current = result.items;
      const chosenId = result.items.some((item) => item.id === preferredId) ? preferredId : result.items[0]?.id ?? null;
      setSourceSelectedId(chosenId); selectedSourceRef.current = chosenId; setSourceLoading(false);
      if (chosenId) await selectSource(chosenId, runId);
    } catch (caught) { if (version === sourceRequestVersion.current && context === targetVersion.current) setSourceError(sourceReadError(caught)); }
    finally { if (version === sourceRequestVersion.current && context === targetVersion.current) setSourceLoading(false); }
  }
  async function loadGatewayOperations(runId: string) {
    const client = liveClient(); if (!client) return;
    const version = ++gatewayRequestVersion.current;
    const context = targetVersion.current;
    setGatewayLoading(true); setGatewayError(null);
    try {
      const operations = await client.getRunGatewayOperations(runId);
      if (version === gatewayRequestVersion.current && context === targetVersion.current && runRef.current?.id === runId) setGatewayOperations(operations);
    } catch (caught) {
      if (version === gatewayRequestVersion.current && context === targetVersion.current) setGatewayError(describeLiveError(caught).message);
    } finally { if (version === gatewayRequestVersion.current && context === targetVersion.current) setGatewayLoading(false); }
  }
  async function load(includeSources = true) {
    const version = ++requestVersion.current;
    if (includeSources) {
      sourceRequestVersion.current++; sourceDetailVersion.current++;
      setSourceDetail(null); setSourceManifests([]); sourceManifestsRef.current = []; setSourceBuild(null); setSourceError(null); setSourceLoading(true); setSourceDetailLoading(false);
    }
    if (!runRef.current) setLoading(true); else setRefreshing(true);
    setError(null);
    setProjectArchivedAt(undefined); setProjectReadError(null);
    try {
      const client = liveClient();
      if (!client) { setRun(null); runRef.current = null; setTask(null); setReviews([]); return; }
      const loadedRun = await client.getRun(id);
      const [loadedTask, loadedReviews] = await Promise.all([client.getTask(loadedRun.taskId), client.getRunReviews(loadedRun.id)]);
      if (loadedRun.id !== id || loadedTask.id !== loadedRun.taskId) throw new RelayTransportError("Run 与任务读取结果不匹配。");
      let archivedAt: string | null | undefined = null;
      let projectFailure: string | null = null;
      if (loadedTask.projectId) {
        archivedAt = undefined;
        try { const project = await client.getProject(loadedTask.projectId); if (project.id !== loadedTask.projectId) throw new RelayTransportError("Project 读取结果与任务归属不匹配。"); archivedAt = project.archivedAt; }
        catch (caught) { projectFailure = describeLiveError(caught).message; }
      }
      if (version !== requestVersion.current) return;
      setRun(loadedRun); runRef.current = loadedRun; setTask(loadedTask); setReviews(loadedReviews); setProjectArchivedAt(archivedAt); setProjectReadError(projectFailure);
      if (includeSources) void loadSources(loadedRun.id);
      const controlId = loadedRun.pendingControlRequest?.id ?? acceptedControlRef.current?.id;
      if (controlId) { const loadedControl = await client.getControlRequest(loadedRun.id, controlId); if (version !== requestVersion.current) return; setControlRecord(loadedControl); }
      else setControlRecord(null);
    } catch (caught) { if (version === requestVersion.current) setError(describeLiveError(caught).message); }
    finally { if (version === requestVersion.current) { setLoading(false); setRefreshing(false); } }
  }
  useEffect(() => {
    targetVersion.current++; requestVersion.current++; runRef.current = null; setRun(null); setTask(null); setProjectArchivedAt(undefined); setProjectReadError(null); setReviews([]); setControlRecord(null); setAcceptedControl(null); acceptedControlRef.current = null; setPendingCommand(null);
    draftPreviewRef.current = null; previewIdentity.current = null; setDraftPreview(null);
    gatewayRequestVersion.current++; setGatewayOpen(false); setGatewayOperations([]); setGatewayLoading(false); setGatewayError(null);
    setTraceOpen(false);
    sourceRequestVersion.current++; sourceDetailVersion.current++; setSourceBuild(null); setSourceManifests([]); sourceManifestsRef.current = []; setSourceSelectedId(null); selectedSourceRef.current = null; setSourceDetail(null); setSourceLoading(false); setSourceDetailLoading(false); setSourceError(null); setSubmitting(false); setActionError(null); setActionMessage(null);
    void load();
    return () => { targetVersion.current++; requestVersion.current++; sourceRequestVersion.current++; sourceDetailVersion.current++; gatewayRequestVersion.current++; };
  }, [id, connection.client]);
  useEffect(() => {
    if (gatewayOpen && run?.id === id) void loadGatewayOperations(id);
  }, [gatewayOpen, run?.id, run?.revision, id, connection.client]);
  useEffect(() => {
    if (!live || run?.id !== id || !connection.client) return;
    const client = connection.client;
    const abort = new AbortController();
    let active = true;
    let after = "0";
    let retryMs = 1_000;
    let refreshQueued = false;
    let refreshInFlight = false;
    let sourceRefreshQueued = false;
    let refreshTimer: number | null = null;
    setEventStatus("connecting");
    const refreshFacts = (includeSources = false) => {
      if (!active) return;
      refreshQueued = true;
      sourceRefreshQueued ||= includeSources;
      if (refreshInFlight || refreshTimer !== null) return;
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        if (!active) return;
        const sources = sourceRefreshQueued;
        refreshQueued = false;
        sourceRefreshQueued = false;
        refreshInFlight = true;
        void load(sources).finally(() => {
          refreshInFlight = false;
          if (refreshQueued) refreshFacts(sourceRefreshQueued);
        });
      }, 200);
    };
    const interval = window.setInterval(() => refreshFacts(true), 15_000);
    void (async () => {
      while (active && !abort.signal.aborted) {
        let receivedEvent = false;
        try {
          await client.readRunEvents(id, after, abort.signal, (seq) => {
            if (!active) return;
            after = seq;
            receivedEvent = true;
            refreshFacts();
          }, () => { if (active) setEventStatus("connected"); });
        } catch (caught) {
          if (!active || abort.signal.aborted) break;
          if (caught instanceof RelayRunEventHttpError && [401, 403].includes(caught.status)) {
            setEventStatus("unauthorized");
            refreshFacts();
            break;
          }
        }
        if (!active || abort.signal.aborted) break;
        setEventStatus("reconnecting");
        refreshFacts();
        await waitForEventRetry(retryMs, abort.signal);
        retryMs = receivedEvent ? 1_000 : Math.min(retryMs * 2, 15_000);
      }
    })();
    return () => { active = false; abort.abort(); window.clearInterval(interval); if (refreshTimer !== null) window.clearTimeout(refreshTimer); };
  }, [id, connection.client, run?.id]);
  useEffect(() => {
    draftPreviewRef.current = null; previewIdentity.current = null; setDraftPreview(null);
    if (!canReadDraft || !connection.client) return;
    const client = connection.client;
    const scope = targetVersion.current;
    let active = true;
    let timer: number | undefined;
    async function poll() {
      let delay = 400;
      try {
        const next = await client.getRunDraftPreview(id);
        if (!active || scope !== targetVersion.current || runRef.current?.id !== id || client !== liveClient()) return;
        if (next.runStatus !== "RUNNING" || !next.previewAvailable) {
          draftPreviewRef.current = null; previewIdentity.current = null; setDraftPreview(null);
          if (next.runStatus === "COMPLETED" || next.runStatus === "FAILED" || next.runStatus === "CANCELLED") {
            active = false; void load(false);
          }
        } else {
          const identity = `${next.stepAttemptId}:${next.attemptClaimEpoch}:${next.modelCallId ?? "none"}`;
          if (identity !== previewIdentity.current) {
            const hadText = draftPreviewRef.current !== null;
            draftPreviewRef.current = null; setDraftPreview(null); previewIdentity.current = identity;
            if (hadText) { timer = window.setTimeout(() => { void poll(); }, 400); return; }
          }
          if (next.previewText === null) { draftPreviewRef.current = null; setDraftPreview(null); }
          else if (draftPreviewRef.current === null ||
            BigInt(next.previewRevision) >= BigInt(draftPreviewRef.current.previewRevision)) {
            draftPreviewRef.current = next; setDraftPreview(next);
          }
        }
      } catch (caught) {
        if (!active || scope !== targetVersion.current) return;
        draftPreviewRef.current = null; previewIdentity.current = null; setDraftPreview(null);
        if (caught instanceof RelayApiError && (caught.problem.status === 404 || caught.problem.status === 403)) {
          active = false; void load(false);
        } else delay = 1000;
      }
      if (active) timer = window.setTimeout(() => { void poll(); }, delay);
    }
    void poll();
    return () => { active = false; if (timer !== undefined) window.clearTimeout(timer); };
  }, [canReadDraft, id, connection.client, run?.revision, run?.currentStepId]);
  async function submitControl(type: RelayControlType) {
    const client = liveClient();
    if (!client || !run || !task || !canControl || (type === "PAUSE" && run.status === "PAUSED")) return;
    const commandId = createCommandId(); const context = targetVersion.current;
    setPendingCommand({ id: commandId, kind: "control", type }); setSubmitting(true); setActionError(null); setActionMessage(null);
    try { const result = await client.requestRunControl({ runId: run.id, commandId, expectedTaskRevision: task.revision, expectedRunRevision: run.revision, type }); if (context !== targetVersion.current) return; if (result.taskId !== task.id) throw new RelayTransportError("控制回执的任务与当前 Run 不匹配。"); setPendingCommand(null); const accepted = { id: result.controlRequestId, type }; setAcceptedControl(accepted); acceptedControlRef.current = accepted; setActionMessage(`${controlLabels[type]}提交回执为 202 / PENDING；下方 Run 与控制请求状态是随后查询的当前事实。`); await load(); }
    catch (caught) { if (context !== targetVersion.current) return; if (caught instanceof RelayTransportError) setActionError("响应丢失或无法核对，控制请求是否入库尚未确定。请查询原 command_id 回执，不能换 ID 再提交。"); else { setPendingCommand(null); setActionError(describeLiveError(caught).message); if (caught instanceof RelayApiError && ["REVISION_CONFLICT", "CONTROL_CONFLICT", "INVALID_TRANSITION", "RUN_TERMINAL", "UNKNOWN_ACTION_BLOCKED"].includes(caught.problem.code)) await load(); } }
    finally { if (context === targetVersion.current) setSubmitting(false); }
  }
  async function resume() {
    const client = liveClient(); if (!client || !run || !task || !canControl || run.status !== "PAUSED") return;
    const commandId = createCommandId(); const context = targetVersion.current;
    setPendingCommand({ id: commandId, kind: "resume" }); setSubmitting(true); setActionError(null); setActionMessage(null);
    try { await client.resumeRun({ runId: run.id, commandId, expectedTaskRevision: task.revision, expectedRunRevision: run.revision }); if (context !== targetVersion.current) return; setPendingCommand(null); setActionMessage("恢复命令已受理（202）。已重新读取 Run；实际状态以服务端查询为准。"); await load(); }
    catch (caught) { if (context !== targetVersion.current) return; if (caught instanceof RelayTransportError) setActionError("响应丢失或无法核对，恢复是否受理尚未确定。请查询原 command_id 回执，不能换 ID 再提交。"); else { setPendingCommand(null); setActionError(describeLiveError(caught).message); if (caught instanceof RelayApiError && ["REVISION_CONFLICT", "CONTROL_CONFLICT", "INVALID_TRANSITION", "UNKNOWN_ACTION_BLOCKED"].includes(caught.problem.code)) await load(); } }
    finally { if (context === targetVersion.current) setSubmitting(false); }
  }
  async function checkReceipt() {
    const pending = pendingCommand; const client = liveClient(); if (!pending || !client || submitting) return;
    const context = targetVersion.current; setSubmitting(true);
    try {
      const receipt = await client.getCommandReceipt(pending.id); if (context !== targetVersion.current) return;
      const result = receipt.result;
      const matchesRun = receipt.commandId === pending.id && result.run_id === id;
      const matchesCommand = pending.kind === "control" ? receipt.commandType === "RequestRunControl" && result.task_id === task?.id && result.type === pending.type && result.status === "PENDING" && typeof result.control_request_id === "string" && result.control_request_id.length > 0 : receipt.commandType === "ResumeRun" && typeof result.status === "string" && result.status.length > 0;
      if (!matchesRun || !matchesCommand || typeof result.run_revision !== "string" || !/^\d+$/.test(result.run_revision)) { setActionError("原命令回执与当前 Run 或命令类型不匹配，结果仍未确定。请保留原 command_id 核对。"); return; }
      if (pending.kind === "control") { const accepted = { id: result.control_request_id as string, type: pending.type as RelayControlType }; setAcceptedControl(accepted); acceptedControlRef.current = accepted; }
      setPendingCommand(null); setActionError(null); setActionMessage("已找到原命令回执；正在核对 Run 与控制请求的最新状态。"); await load();
    } catch (caught) { if (context === targetVersion.current) setActionError(caught instanceof RelayApiError && caught.problem.code === "COMMAND_NOT_FOUND" ? "暂未找到原命令回执，结果仍未确定。请稍后继续用同一个 command_id 核对。" : describeLiveError(caught).message); }
    finally { if (context === targetVersion.current) setSubmitting(false); }
  }
  if (loading) return <section className="page-state" aria-live="polite"><p className="eyebrow">Run</p><h1>正在读取执行记录</h1></section>;
  if (!live) return <section className="page-state" data-testid="run-fixture-gap"><p className="eyebrow">Run</p><h1>示例模式没有真实 Run</h1><p>连接本机 API 后才能读取步骤、未决请求和控制状态。示例数据不生成执行记录。</p><Link className="text-link" to="/tasks">返回任务列表</Link></section>;
  if (error) return <section className="page-state page-state--error" role="alert"><p className="eyebrow">Run</p><h1>暂时无法读取执行记录</h1><p>{error}</p><button className="secondary-button" type="button" onClick={() => void load()}><RotateCcw aria-hidden="true" />重新读取</button></section>;
  if (!run || !task) return null;
  return <section className="skill-page" data-testid="run-detail"><div className="page-layout"><div className="page-primary"><p className="eyebrow">真实 Run · {run.id}</p><h1>{task.title}</h1><p className="page-lede">{runLabels[run.status] ?? run.status} · Run 修订 v{run.revision} · 任务修订 v{task.revision}</p><p className="helper-text">任务状态：{taskStatusLabels[task.status]} · 当前执行者：{executorLabels[task.executor]}</p><Link className="text-link" to={`/tasks/${run.taskId}`}>返回关联任务</Link>{eventStatus === "connecting" && <p className="helper-text" data-testid="run-events-status" role="status">正在连接执行事件；页面仍以服务端查询为准。</p>}{eventStatus === "reconnecting" && <p className="helper-text" data-testid="run-events-status" role="status">事件连接中断，正在补读历史；页面仍定期重新查询。</p>}{eventStatus === "unauthorized" && <p className="action-error" data-testid="run-events-status" role="alert">执行事件订阅无权访问，请检查连接权限；页面将重新查询当前事实。</p>}{refreshing && <p className="helper-text" role="status">正在读取最新执行事实。</p>}{!activeRun && <p className="helper-text">这是历史 Run，任务当前执行权已变化；本页只保留查询。</p>}{run.waitReason && <p className="helper-text">等待原因：{run.waitReason}</p>}
    {!!run.unresolvedOperationIds.length && <section className="surface-panel" data-testid="run-unknown"><h2>执行结果未知或待核对</h2><p className="warning-callout" role="status"><AlertTriangle aria-hidden="true" />以下动作的结果未知或尚未结清。先按原 operation_id 核对目标状态与效果证据；证据不足时保持待核对，不得盲重试、换 ID 或恢复写入。本页没有直接标记成功的入口。</p><ul className="run-list">{run.unresolvedOperationIds.map((operationId) => <li key={operationId}><strong>需核对</strong> · 原 operation_id：{operationId}</li>)}</ul></section>}
    <section className="surface-panel" data-testid="run-gateway-operations"><h2>Gateway 动作历史</h2><p className="helper-text">按当前权限读取本次 Run 的动作历史；批准请求和实际写入状态分别核对。</p><button className="secondary-button" type="button" onClick={() => { if (gatewayOpen) { setGatewayOpen(false); gatewayRequestVersion.current++; } else setGatewayOpen(true); }}>{gatewayOpen ? "收起动作历史" : "查看动作历史"}</button>{gatewayOpen && <><button className="secondary-button" type="button" disabled={gatewayLoading} onClick={() => void loadGatewayOperations(run.id)}>刷新动作历史</button>{gatewayLoading && <p className="helper-text" role="status">正在读取动作历史。</p>}{gatewayError && <p className="action-error" role="alert">{gatewayError}</p>}{!gatewayLoading && !gatewayError && (gatewayOperations.length ? <ul className="run-list">{gatewayOperations.map((operation) => <li key={operation.id}><strong>{operation.actionType} · {operation.status}</strong><div>原 operation_id：{operation.id}</div><div>目标：{operation.normalizedTarget}</div><div>Invocation：{operation.invocationStatuses.length ? operation.invocationStatuses.join("、") : "尚未调用"}</div></li>)}</ul> : <p className="helper-text">本次 Run 暂无文件动作记录。</p>)}</>}</section>
    {gatewayOpen && connection.client && gatewayOperations.filter((operation) => ["APPLY_CHANGESET", "WRITE_FILE"].includes(operation.actionType)).map((operation) => <section className="surface-panel" key={operation.id} data-testid="run-file-write-operation"><h2>FILE_WRITE 原动作 · {operation.status}</h2><p className="helper-text">原 operation_id：{operation.id}。逐文件账本和当前文件状态分别读取；人工处置只结束旧 Run，不确认所有文件均已写入。</p><FileWriteDispositionPanel client={connection.client!} operationId={operation.id} runId={run.id} runRevision={run.revision} onFactsChanged={async () => { await load(); await loadGatewayOperations(run.id); }} /></section>)}
    <section className="surface-panel" data-testid="run-control"><h2>控制请求</h2><p className="helper-text">控制提交回执表示 PENDING；安全点可能随后处理请求。Run、任务执行者与控制状态以重新查询为准。</p>{projectWriteBlockedReason && <p className="disabled-reason" data-testid="run-project-archive-reason">{projectWriteBlockedReason}</p>}{run.pendingControlRequest && <p className="receipt-message" role="status">{controlLabels[run.pendingControlRequest.type]}：{run.pendingControlRequest.status}。等待安全点处理；请求 {run.pendingControlRequest.id}。</p>}{controlRecord && <p className="helper-text" data-testid="run-control-status">控制请求 {controlRecord.id}：{controlRecord.status}{controlRecord.decidedAt && <> · 处理时间 {controlRecord.decidedAt}</>}</p>}{actionError && <p className="action-error" role="alert">{actionError}</p>}{actionMessage && <p className="receipt-message" role="status">{actionMessage}</p>}{pendingCommand && <p className="helper-text">原 command_id：{pendingCommand.id}</p>}<div className="run-actions">{pendingCommand ? <button className="secondary-button" type="button" data-testid="run-check-receipt" disabled={submitting} onClick={() => void checkReceipt()}>核对原命令回执</button> : <>{run.status === "PAUSED" ? <button className="primary-button" type="button" data-testid="run-resume" disabled={!canControl} onClick={() => void resume()}>恢复 Run</button> : <button className="secondary-button" type="button" data-testid="run-control-PAUSE" disabled={!canControl} onClick={() => void submitControl("PAUSE")}>{controlLabels.PAUSE}</button>}<button className="secondary-button" type="button" data-testid="run-control-CANCEL" disabled={!canControl} onClick={() => void submitControl("CANCEL")}>{controlLabels.CANCEL}</button><button className="secondary-button" type="button" data-testid="run-control-HANDOFF" disabled={!canControl} onClick={() => void submitControl("HANDOFF")}>{controlLabels.HANDOFF}</button><button className="danger-button" type="button" data-testid="run-control-CANCEL_TASK" disabled={!canControl} onClick={() => void submitControl("CANCEL_TASK")}>{controlLabels.CANCEL_TASK}</button></>}<button className="secondary-button" type="button" data-testid="run-refresh" disabled={refreshing || submitting} onClick={() => void load()}>刷新状态</button></div></section>
    <section className="surface-panel" data-testid="run-steps"><h2>步骤与最近尝试</h2>{!run.steps.length ? <p className="helper-text">尚无步骤记录。</p> : <ol className="run-list">{run.steps.map((step) => <li key={step.id}><strong>{step.index + 1}. {stepLabels[step.kind] ?? step.kind}</strong> · {step.status}{step.id === run.currentStepId && <> · 当前步骤</>}</li>)}</ol>}{!!run.recentAttempts.length && <><p className="helper-text">最近尝试</p><ul className="run-list">{run.recentAttempts.map((attempt) => <li key={attempt.id}>{stepLabels[attempt.stepKind] ?? attempt.stepKind} · 第 {attempt.number} 次 · {attempt.status}</li>)}</ul></>}</section>
    {canReadDraft && draftPreview?.previewAvailable && draftPreview.previewText !== null && <section className="surface-panel" data-testid="run-draft-preview"><h2>生成中草稿</h2><p className="helper-text">Run DRAFT 当前轮次 · 预览 v{draftPreview.previewRevision} · 尚非受管产物、验证 PASS 或任务完成{draftPreview.previewTruncated ? " · 预览已截断" : ""}</p><pre className="run-draft-preview-text">{draftPreview.previewText}</pre></section>}
    <div className="run-actions"><button className="secondary-button" type="button" data-testid="run-trace-toggle" onClick={() => setTraceOpen((open) => !open)}>{traceOpen ? "收起完整 Run Trace" : "查看完整 Run Trace"}</button></div>
    {traceOpen && connection.client && <RunTracePanel client={connection.client} runId={run.id} taskId={task.id} runRevision={run.revision} />}
    <RunSourcesPanel loading={sourceLoading} detailLoading={sourceDetailLoading} error={sourceError} build={sourceBuild} manifests={sourceManifests} selectedId={sourceSelectedId} detail={sourceDetail} onRefresh={() => void loadSources(run.id)} onSelect={(manifestId) => void selectSource(manifestId)} />
    <section className="surface-panel" data-testid="run-reviews"><h2>未决 Review</h2>{!openReviews.length ? <p className="helper-text">当前没有未决 Review。</p> : <ul className="run-list">{openReviews.map((review) => <li key={review.id}>{review.reason} · <Link className="text-link" to={`/reviews?id=${review.id}`}>查看请求与判断依据</Link></li>)}</ul>}</section>
  </div></div></section>;
}
