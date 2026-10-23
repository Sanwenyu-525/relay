import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { AlertTriangle, Check, CircleDot, RotateCcw, X } from "lucide-react";
import ResponsiveRail from "../components/ResponsiveRail";
import PageHeader from "../components/PageHeader";
import RunSourcesPanel from "../components/RunSourcesPanel";
import RunTracePanel from "../components/RunTracePanel";
import RunControlPanel, { runLabels, stepLabels, stepStatusLabels } from "../components/RunControlPanel";
import FileWriteDispositionPanel from "../components/FileWriteDispositionPanel";
import { RelayApiError, RelayRunEventHttpError, RelayTransportError, type RelayControlRequest, type RelayContextBuild, type RelayContextManifestDetail, type RelayContextManifestSummary, type RelayReview, type RelayRun, type RelayRunGatewayOperation, type RelayTaskDetail } from "../api/relayClient";
import { createCommandId } from "../api/core/command-id";
import { describeLiveError } from "../lib/liveErrors";
import { formatReadableDateTime, useDisplayPreferences } from "../lib/displayPreferences";
import { executorLabels, taskStatusLabels } from "../lib/labels";
import { reviewReasonText } from "../components/ReviewDecisionPanel";
import { liveClient, useRelayConnection } from "../lib/relayConnection";
import { useRunDraftPreview } from "../lib/useRunDraftPreview";
import "./RunView.css";

function sourceReadError(caught: unknown): string {
  if (caught instanceof RelayApiError && [403, 404].includes(caught.problem.status)) return "来源已不可读取或当前范围无权查看。旧片段已清除，请重新核对权限。";
  return describeLiveError(caught).message;
}

/** Gateway 动作历史的三组枚举中文文案（服务端词表见 docs/database/physical-design-postgresql.md）。
 *  未知值回退原枚举展示；原枚举以 small/title 降级保留，供按原身份核对。 */
const gatewayActionLabels: Record<string, string> = {
  WRITE_FILE: "写入文件", APPLY_CHANGESET: "应用变更集", CLI_RUN: "运行命令", PUBLISH_CANDIDATE: "发布候选产物"
};
const gatewayOperationStatusLabels: Record<string, string> = {
  WAITING_APPROVAL: "等待批准", PREPARED: "已准备", DISPATCHING: "派发中", SUCCEEDED: "已成功",
  FAILED: "已失败", UNKNOWN: "结果未知", DENIED: "已拒绝", MANUALLY_CLOSED: "已人工处置"
};
const gatewayInvocationStatusLabels: Record<string, string> = {
  PREPARED: "已准备", DISPATCHING: "派发中", SUCCEEDED: "已成功", FAILED: "已失败",
  UNKNOWN: "结果未知", NOT_EXECUTED: "未执行"
};
/** DEV-0054：可手动核对（安全重读）的能力族。与服务端 SAFE_REREAD_CAPABILITIES 同一名单；
 * 写能力有外部效果，只能走停机恢复路径或可信停机证明下的人工处置。 */
const READONLY_RECONCILE_CAPABILITIES: readonly string[] =
  ["FILE_READ", "FILE_QUERY", "WEB_FETCH", "GIT_READ", "GITHUB_READ"];
const RECONCILE_STATUS_LABELS: Record<string, string> = {
  SUCCEEDED: "已核对：目标证据与冻结输入一致",
  NOT_EXECUTED: "已核对：调用未开始（PREPARED）",
  FAILED: "已核对：读取失败（明确失败，非未知）"
};
function gatewayEnumText(labels: Record<string, string>, value: string): ReactNode {
  const label = labels[value] ?? value;
  return <>{label}{label !== value && <small title={value}>（{value}）</small>}</>;
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
  const { timeZone } = useDisplayPreferences();
  const live = connection.mode === "live";
  const [run, setRun] = useState<RelayRun | null>(null);
  const runRef = useRef(run); runRef.current = run;
  const [task, setTask] = useState<RelayTaskDetail | null>(null);
  const [projectArchivedAt, setProjectArchivedAt] = useState<string | null | undefined>(undefined);
  const [projectReadError, setProjectReadError] = useState<string | null>(null);
  const [reviews, setReviews] = useState<readonly RelayReview[]>([]);
  const [controlRecord, setControlRecord] = useState<RelayControlRequest | null>(null);
  // 控制面板在同一次提交里先回传 ID 再触发重读；用 ref 承接，避免重读读到上一帧的 null。
  const acceptedControlIdRef = useRef<string | null>(null);
  const reportControlAccepted = useCallback((controlRequestId: string | null) => {
    acceptedControlIdRef.current = controlRequestId;
  }, []);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [eventStatus, setEventStatus] = useState<"connecting" | "connected" | "reconnecting" | "unauthorized" | null>(null);
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
  // DEV-0054：未决只读动作的手动核对。结论以服务端重读为准，本地只展示与转发错误。
  const [reconcileBusyId, setReconcileBusyId] = useState<string | null>(null);
  const [reconcileError, setReconcileError] = useState<string | null>(null);
  const [reconcileResults, setReconcileResults] = useState<readonly { readonly operationId: string; readonly status: string; readonly reconciliation: string }[]>([]);
  const gatewayRequestVersion = useRef(0);
  const requestVersion = useRef(0);
  const targetVersion = useRef(0);
  const sourceRequestVersion = useRef(0);
  const sourceDetailVersion = useRef(0);
  const activeRun = run !== null && task?.executor === "AI" && task.executorRunId === run.id;
  const terminal = run !== null && ["COMPLETED", "FAILED", "CANCELLED"].includes(run.status);
  const draftStep = run?.steps.find((step) => step.id === run.currentStepId);
  const lastSucceededSteps = run?.steps.filter((step) => step.status === "SUCCEEDED") ?? [];
  const lastSettledStep = lastSucceededSteps.length ? lastSucceededSteps[lastSucceededSteps.length - 1] : null;
  const failedReasons = [...new Set((run?.steps ?? []).map((step) => step.reason)
    .filter((reason): reason is string => typeof reason === "string" && reason !== ""))];
  const inFlightGateway = gatewayOperations.filter((operation) => ["PREPARED", "DISPATCHING", "UNKNOWN"].includes(operation.status));
  // 起止时间为空是业务状态（未开始/未结束），与不可解析的原串分开表达；原始 UTC 仍留在 time.dateTime。
  const stepTime = (value: string | null, missing: string) => value === null ? missing
    : <time dateTime={value} title={timeZone}>{formatReadableDateTime(value, timeZone)}</time>;
  const canReadDraft = live && run?.id === id && run.status === "RUNNING" && activeRun &&
    draftStep?.kind === "DRAFT" && draftStep.status === "RUNNING" &&
    run.pendingControlRequest === null && error === null && eventStatus !== "unauthorized";
  const projectWriteBlockedReason = !task || task.projectId === null ? null
    : projectArchivedAt === undefined
      // `undefined` 是「项目事实还没读到」，不是读取失败：不写成阻塞原因，避免切页时闪一句红字。
      ? projectReadError === null ? null : `Project 事实读取失败，不能提交新的 Run 控制命令。${projectReadError}`
      : refreshing || loading || error !== null
        ? `Project 事实正在核对或读取失败，不能提交新的 Run 控制命令。${projectReadError ?? ""}`
        : projectArchivedAt !== null ? "项目已归档，不能提交新的 Run 控制命令。" : null;
  const draftPreview = useRunDraftPreview({ client: connection.client, runId: id, revision: run?.revision ?? "",
    currentStepId: run?.currentStepId ?? null, enabled: canReadDraft, onSettled: () => { void load(false); } });
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
    // 刷新时先让旧账本失效：动作账本是 UNKNOWN 处置的依据，读取失败后仍按上一份列表渲染
    // 处置面板，等于让人对着过期账本做人工核对。
    setGatewayLoading(true); setGatewayError(null); setGatewayOperations([]);
    try {
      const operations = await client.getRunGatewayOperations(runId);
      if (version === gatewayRequestVersion.current && context === targetVersion.current && runRef.current?.id === runId) setGatewayOperations(operations);
    } catch (caught) {
      if (version === gatewayRequestVersion.current && context === targetVersion.current) setGatewayError(describeLiveError(caught).message);
    } finally { if (version === gatewayRequestVersion.current && context === targetVersion.current) setGatewayLoading(false); }
  }
  /**
   * DEV-0054：手动核对一个未决只读动作。服务端按同一冻结输入安全重读并落库，
   * 结论以回执为准；成功后重读 Run 与动作账本，让「需核对」条目按新事实消失或变化。
   */
  async function reconcileOperation(operationId: string) {
    const client = liveClient(); if (!client) return;
    const commandId = createCommandId();
    const context = targetVersion.current;
    setReconcileBusyId(operationId); setReconcileError(null);
    try {
      const result = await client.reconcileGatewayOperation({ operationId, commandId });
      if (context !== targetVersion.current) return;
      setReconcileResults((current) => [...current.filter((item) => item.operationId !== operationId),
        { operationId: result.operationId, status: result.status, reconciliation: result.reconciliation }]);
      await load(false);
      await loadGatewayOperations(runRef.current?.id ?? id);
    } catch (caught) {
      if (context === targetVersion.current) setReconcileError(describeLiveError(caught).message);
    } finally {
      if (context === targetVersion.current) setReconcileBusyId(null);
    }
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
      const controlId = loadedRun.pendingControlRequest?.id ?? acceptedControlIdRef.current;
      if (controlId) { const loadedControl = await client.getControlRequest(loadedRun.id, controlId); if (version !== requestVersion.current) return; setControlRecord(loadedControl); }
      else setControlRecord(null);
    } catch (caught) { if (version === requestVersion.current) setError(describeLiveError(caught).message); }
    finally { if (version === requestVersion.current) { setLoading(false); setRefreshing(false); } }
  }
  useEffect(() => {
    targetVersion.current++; requestVersion.current++; runRef.current = null; setRun(null); setTask(null); setProjectArchivedAt(undefined); setProjectReadError(null); setReviews([]); setControlRecord(null); reportControlAccepted(null);
    gatewayRequestVersion.current++; setGatewayOpen(false); setGatewayOperations([]); setGatewayLoading(false); setGatewayError(null);
    setTraceOpen(false);
    sourceRequestVersion.current++; sourceDetailVersion.current++; setSourceBuild(null); setSourceManifests([]); sourceManifestsRef.current = []; setSourceSelectedId(null); selectedSourceRef.current = null; setSourceDetail(null); setSourceLoading(false); setSourceDetailLoading(false); setSourceError(null);
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
  if (loading) return <section className="page-state" aria-live="polite"><p className="eyebrow">Run</p><h1>正在读取执行记录</h1></section>;
  if (!live) return <section className="page-state" data-testid="run-fixture-gap"><p className="eyebrow">Run</p><h1>示例模式没有真实 Run</h1><p>连接本机 API 后才能读取步骤、未决请求和控制状态。示例数据不生成执行记录。</p><Link className="text-link" to="/tasks">返回任务列表</Link></section>;
  if (error) return <section className="page-state page-state--error" role="alert"><p className="eyebrow">Run</p><h1>暂时无法读取执行记录</h1><p>{error}</p><button className="secondary-button" type="button" onClick={() => void load()}><RotateCcw aria-hidden="true" />重新读取</button></section>;
  // 不静默返回 null：没有 run/task 时给明确的不可用说明与重读入口，而不是渲染空白文档。
  if (!run || !task) return <section className="page-state" data-testid="run-record-unavailable"><p className="eyebrow">Run</p><h1>暂时没有可显示的执行记录</h1><p>这次没有读到完整的 Run 与任务事实，因此不展示步骤、控制与轨迹；这不代表执行成功或已停止。请重新读取核对。</p><button className="secondary-button" type="button" onClick={() => void load()}><RotateCcw aria-hidden="true" />重新读取</button></section>;
  // COMPLETED 是服务端提交完成的确定事实，用成功色调；CREATED/RUNNING 等在途状态保持中性，不靠颜色暗示进展。
  return <section className="skill-page run-detail-page" data-testid="run-detail"><div className="page-layout"><div className="page-primary"><PageHeader testId="run-page-head" title={task.title} meta="执行记录"
    lede={`${runLabels[run.status] ?? run.status} · Run 修订 v${run.revision} · 任务修订 v${task.revision}`}
    status={<span className={`status-chip status-chip--${run.status === "FAILED" ? "danger" : run.status === "PAUSED" ? "warning" : run.status === "COMPLETED" ? "success" : "neutral"}`}>{runLabels[run.status] ?? run.status}</span>}>
    <p className="helper-text">任务状态：{taskStatusLabels[task.status]} · 当前执行者：{executorLabels[task.executor]}</p>
    <Link className="text-link" to={`/tasks/${run.taskId}`}>返回关联任务</Link>
  </PageHeader>{eventStatus === "connecting" && <p className="helper-text" data-testid="run-events-status" role="status">正在连接执行事件；页面仍以服务端查询为准。</p>}{eventStatus === "reconnecting" && <p className="helper-text" data-testid="run-events-status" role="status">事件连接中断，正在补读历史；页面仍定期重新查询。</p>}{eventStatus === "unauthorized" && <p className="action-error" data-testid="run-events-status" role="alert">执行事件订阅无权访问，请检查连接权限；页面将重新查询当前事实。</p>}{refreshing && <p className="helper-text" role="status">正在读取最新执行事实。</p>}{!activeRun && <p className="helper-text">这是历史 Run，任务当前执行权已变化；本页只保留查询。</p>}{run.waitReason && <p className="helper-text">等待原因：{run.waitReason}</p>}
    {!!run.unresolvedOperationIds.length && <section className="surface-panel" data-testid="run-unknown"><h2>执行结果未知或待核对</h2><p className="warning-callout" role="status"><AlertTriangle aria-hidden="true" />以下动作的结果未知或尚未结清。先按原 operation_id 核对目标状态与效果证据；证据不足时保持待核对，不得盲重试、换 ID 或恢复写入。本页没有直接标记成功的入口。</p><ul className="run-list">{run.unresolvedOperationIds.map((operationId) => {
      const operation = gatewayOperations.find((item) => item.id === operationId);
      const capabilityKey = operation?.capabilityKey ?? null;
      const readonlyReconcilable = capabilityKey !== null && READONLY_RECONCILE_CAPABILITIES.includes(capabilityKey);
      const result = reconcileResults.find((item) => item.operationId === operationId);
      return <li key={operationId} data-testid="run-unknown-item"><strong>需核对</strong> · 原 operation_id：{operationId}{capabilityKey !== null && <> · {capabilityKey}</>}{readonlyReconcilable
        ? <div className="run-actions"><button className="secondary-button" type="button" data-testid="run-unknown-reconcile-button" disabled={!live || reconcileBusyId === operationId} onClick={() => { void reconcileOperation(operationId); }}>{reconcileBusyId === operationId ? "正在核对" : "核对执行结果（只读重读）"}</button></div>
        : <p className="helper-text">该动作有外部效果，不能在本页手动结清：请经停机恢复路径核对，或由负责人在可信停机证明下人工处置（见「Gateway 动作历史」中的文件写入处置面板）。</p>}{result !== undefined && <p className="helper-text" data-testid="run-unknown-reconcile-result">本次核对结论：{RECONCILE_STATUS_LABELS[result.status] ?? result.status}（{result.reconciliation}）。结论以服务端回执为准，重读 Run 与动作账本可见最新状态。</p>}</li>;
    })}</ul>{reconcileError !== null && <p className="action-error" role="alert" data-testid="run-unknown-reconcile-error">{reconcileError}</p>}<p className="helper-text" data-testid="run-unknown-timeline">执行时间线：动作发出并持久化 → 结果回执未保存或无法确定 → 等待核对执行结果。已知：以上原 operation_id 已入库并绑定目标；尚未知：动作是否实际执行、目标当前状态与效果证据。断连或重开本页不会改变这一事实，仍保持待核对。</p><p className="helper-text" data-testid="run-unknown-reconcile">核对与重试不同：核对是对原动作目标与效果的只读查证并保存证据，不换动作 ID、不换 Adapter、不重复执行；只有在证据确定动作未执行后，才以新的动作身份重新执行。只读能力（读取文件、列目录、网页与 Git/GitHub 只读）可在本页直接核对：服务端按同一冻结输入安全重读，落库结论为「一致 / 调用未开始 / 读取失败」三选一，不猜成功；有外部效果的动作（写入、命令、电脑与浏览器操作）只能经停机恢复路径核对。本页不自建成功开关，结清以服务端落账为准。</p><p className="helper-text">目标与资源保护：在结果核对完成前，相关资源保持隔离，不发放新的冲突写入（见「资源与租约」面板）。</p><div className="run-actions"><button className="secondary-button" type="button" data-testid="run-unknown-open-gateway" onClick={() => { if (!gatewayOpen) setGatewayOpen(true); }}>打开动作历史（只读）</button><button className="secondary-button" type="button" data-testid="run-unknown-open-trace" onClick={() => setTraceOpen(true)}>查看 Run Trace 证据</button></div></section>}
    <section className="surface-panel" data-testid="run-gateway-operations"><h2>Gateway 动作历史</h2><p className="helper-text">按当前权限读取本次 Run 的动作历史；批准请求和实际写入状态分别核对。</p><button className="secondary-button" type="button" onClick={() => { if (gatewayOpen) { setGatewayOpen(false); gatewayRequestVersion.current++; } else setGatewayOpen(true); }}>{gatewayOpen ? "收起动作历史" : "查看动作历史"}</button>{gatewayOpen && <><button className="secondary-button" type="button" disabled={gatewayLoading} onClick={() => void loadGatewayOperations(run.id)}>刷新动作历史</button>{gatewayLoading && <p className="helper-text" role="status">正在读取动作历史。</p>}{gatewayError && <p className="action-error" role="alert">{gatewayError}</p>}{!gatewayLoading && !gatewayError && (gatewayOperations.length ? <ul className="run-list">{gatewayOperations.map((operation) => <li key={operation.id}><strong>{gatewayEnumText(gatewayActionLabels, operation.actionType)} · {gatewayEnumText(gatewayOperationStatusLabels, operation.status)}</strong><div>原 operation_id：{operation.id}</div><div>目标：{operation.normalizedTarget}</div><div>调用状态：{operation.invocationStatuses.length ? operation.invocationStatuses.map((invocationStatus, index) => <span key={`${invocationStatus}-${index}`}>{index > 0 ? "、" : ""}{gatewayEnumText(gatewayInvocationStatusLabels, invocationStatus)}</span>) : "尚未调用"}</div></li>)}</ul> : <p className="helper-text">本次 Run 暂无文件动作记录。</p>)}</>}</section>
    {gatewayOpen && connection.client && gatewayOperations.filter((operation) => ["APPLY_CHANGESET", "WRITE_FILE"].includes(operation.actionType)).map((operation) => <section className="surface-panel" key={operation.id} data-testid="run-file-write-operation"><h2>{gatewayEnumText(gatewayActionLabels, operation.actionType)} 原动作 · {gatewayEnumText(gatewayOperationStatusLabels, operation.status)}</h2><p className="helper-text">原 operation_id：{operation.id}。逐文件账本和当前文件状态分别读取；人工处置只结束旧 Run，不确认所有文件均已写入。</p><FileWriteDispositionPanel client={connection.client!} operationId={operation.id} runId={run.id} runRevision={run.revision} onFactsChanged={async () => { await load(); await loadGatewayOperations(run.id); }} /></section>)}
    {run.status === "PAUSED" && <section className="surface-panel" data-testid="run-paused-summary"><h2>已暂停摘要</h2><p className="helper-text">服务端事实：Run 已在安全边界内暂停（PAUSED）{run.waitReason ? ` · 等待原因：${run.waitReason}` : ""}。当前执行者仍为 {executorLabels[task.executor]}；暂停不自动转移执行权，人工确认不等于接手。</p><ul className="run-list"><li><strong>恢复点</strong> · {lastSettledStep ? `最后完成步骤：${stepLabels[lastSettledStep.kind] ?? lastSettledStep.kind}` : "尚无已完成步骤"} · 服务端 current_step_id：{run.currentStepId ?? "无"}。Resume 将重新检查契约、权限与资源后从服务端恢复点继续；恢复时原阻塞 Review 仍未解决会先返回等待判断，不提前继续执行。</li><li><strong>已保存产物</strong> · Run 级产物清单接口待接入；本 Run 已保存的候选产物版本请从 <Link className="text-link" to={`/tasks/${run.taskId}`}>任务详情</Link> 的产物区按确切版本核对，不在此页推断已保存内容。</li><li><strong>资源占用</strong> · 见「资源与租约」面板；已暂停不等于进程已停或资源已释放。</li></ul></section>}
    {run.status === "FAILED" && <section className="surface-panel" data-testid="run-failed" role="status"><h2>执行失败</h2><p className="helper-text">Run 已按服务端结果进入失败终态；已保存的步骤证据、候选产物版本与动作账本保留，可通过下方步骤时间线、动作历史与 Run Trace 继续查看。</p>{failedReasons.length > 0 && <p className="helper-text" data-testid="run-failed-reasons">服务端给出的失败原因：{failedReasons.join("、")}。原因由步骤结果原样带出；模型端口可用性与账本证据见「模型连接」。</p>}<p className="helper-text">重试会创建新的 Run，不复用本 Run，也不改写本页历史；请从 <Link className="text-link" to={`/tasks/${run.taskId}`}>任务详情</Link> 重新委托。本页不提供重试或改成功按钮；存在未结清动作时先按上方核对流程处理。</p></section>}
    <section className="surface-panel" data-testid="run-steps"><h2>步骤时间线与最近尝试</h2>{!run.steps.length ? <p className="helper-text">尚无步骤记录。</p> : <ol className="run-step-timeline" role="list">{run.steps.map((step) => <li className="run-step" data-step-status={step.status} key={step.id}>
      <span className="run-step-marker" aria-hidden="true">{step.status === "SUCCEEDED" ? <Check /> : step.status === "FAILED" ? <X /> : step.status === "RUNNING" ? <CircleDot /> : step.index + 1}</span>
      <div className="run-step-body">
        <div className="run-step-title"><strong>{stepLabels[step.kind] ?? step.kind}</strong>{step.id === run.currentStepId && <small className="helper-text">当前步骤</small>}</div>
        <div className="run-step-time">{stepTime(step.startedAt, "未开始")} → {stepTime(step.finishedAt, "未结束")}</div>
        <span className="run-step-status">{stepStatusLabels[step.status] ?? step.status}</span>
        {step.reason !== null && <p className="run-step-reason">原因 {step.reason}</p>}
      </div>
    </li>)}</ol>}{draftStep && <p className="helper-text" data-testid="run-current-action">当前动作：{stepLabels[draftStep.kind] ?? draftStep.kind} · {stepStatusLabels[draftStep.status] ?? draftStep.status}{run.pendingControlRequest ? "；控制请求将在安全点处理，实际状态以服务端查询为准。" : "；状态以服务端查询为准。"}</p>}{!!run.recentAttempts.length && <><p className="helper-text">最近尝试</p><ul className="run-list">{run.recentAttempts.map((attempt) => <li key={attempt.id}>{stepLabels[attempt.stepKind] ?? attempt.stepKind} · 第 {attempt.number} 次 · {stepStatusLabels[attempt.status] ?? attempt.status}</li>)}</ul></>}</section>
    {canReadDraft && draftPreview?.previewAvailable && draftPreview.previewText !== null && <section className="surface-panel" data-testid="run-draft-preview"><h2>生成中草稿</h2><p className="helper-text">Run DRAFT 当前轮次 · 预览 v{draftPreview.previewRevision} · 尚非受管产物、验证 PASS 或任务完成{draftPreview.previewTruncated ? " · 预览已截断" : ""}</p><pre className="run-draft-preview-text">{draftPreview.previewText}</pre></section>}
    <div className="run-actions"><button className="secondary-button" type="button" data-testid="run-trace-toggle" onClick={() => setTraceOpen((open) => !open)}>{traceOpen ? "收起完整 Run Trace" : "查看完整 Run Trace"}</button></div>
    {traceOpen && connection.client && <RunTracePanel client={connection.client} runId={run.id} taskId={task.id} runRevision={run.revision} />}
    <RunSourcesPanel loading={sourceLoading} detailLoading={sourceDetailLoading} error={sourceError} build={sourceBuild} manifests={sourceManifests} selectedId={sourceSelectedId} detail={sourceDetail} onRefresh={() => void loadSources(run.id)} onSelect={(manifestId) => void selectSource(manifestId)} />
    <section className="surface-panel" data-testid="run-reviews"><h2>未决 Review</h2>{!openReviews.length ? <p className="helper-text">当前没有未决 Review。</p> : <ul className="run-list">{openReviews.map((review) => <li key={review.id}>{reviewReasonText(review.reason)} · <Link className="text-link" to={`/reviews?id=${review.id}`}>查看请求与判断依据</Link></li>)}</ul>}</section>
  </div>
    <ResponsiveRail label="查看运行信息与控制" title="运行信息与控制"><div className="rail-content run-detail-rail-content">
      <section className="surface-panel" data-testid="run-info"><h2>运行信息</h2><dl className="rail-definition-list">
        
        <div><dt>运行状态</dt><dd>{runLabels[run.status] ?? run.status} · Run 修订 v{run.revision}</dd></div>
        <div><dt>任务状态</dt><dd>{taskStatusLabels[task.status] ?? task.status}</dd></div>
        <div><dt>当前执行者</dt><dd>{executorLabels[task.executor]}</dd></div>
        {run.waitReason && <div><dt>等待原因</dt><dd>{run.waitReason}</dd></div>}
      </dl><details className="page-explanation"><summary>运行身份与事实来源</summary><p className="hash-code">Run ID：{run.id}</p><p className="helper-text">本栏与主列引用同一服务端事实；Run、任务执行者与控制状态以重新查询为准。</p></details></section>
    <RunControlPanel state={{ run, task, controlRecord, activeRun, terminal, projectWriteBlockedReason }} onReload={() => load(false)} onControlAccepted={reportControlAccepted} taskHref={`/tasks/${run.taskId}`} />
    {/* 资源与租约没有独立查询接口：按要点分行，关键结论前置为正文，限定说明降级为辅文；事实内容不增删。 */}
    <section className="surface-panel" data-testid="run-resources"><h2>资源与租约</h2><p className="helper-text">Run 级资源占有与租约没有独立查询接口（待接入）；以下只按服务端已返回的 Run 终态、未结清动作与已读取的动作历史如实显示，不推断旧进程是否停止。</p><ul className="run-resource-points"><li><strong>工作目录排他</strong><p>{terminal && run.unresolvedOperationIds.length === 0 ? "Run 已终态且无未结清动作；占有释放以服务端完成/失败提交事实为准。" : "Run 未终态或存在未结清动作：不能宣称资源已释放。"}</p><small>{terminal && run.unresolvedOperationIds.length === 0 ? "本页不据此宣称外部进程已停止。" : "同一实际工作目录跨 Task 也必须保持排他保护。"}</small></li>{run.unresolvedOperationIds.length > 0 && <li><strong>未结清动作</strong><p>相关资源保持隔离，不发放新的冲突写入。</p></li>}{gatewayOpen && !gatewayLoading && !gatewayError && inFlightGateway.length > 0 && <li><strong>在途或未知动作</strong><p>{inFlightGateway.length} 项（{inFlightGateway.map((operation) => operation.id).join("、")}）</p><small>DISPATCHING 既不能证明已执行也不能证明未执行。</small></li>}{run.status === "PAUSED" && <li><strong>已暂停</strong><p>资源可能仍被占有。</p><small>只有无在途动作、无未知结果且有安全检查点时才可能释放；Resume 须重新获得资源并校验期间变化。</small></li>}<li><strong>租约</strong><p>租约过期只说明旧 Worker 不再被信任，不能推断旧子进程已经停止。</p><small>不能仅凭租约到期启动新的冲突命令。</small></li></ul></section>
    </div></ResponsiveRail>
  </div></section>;
}
