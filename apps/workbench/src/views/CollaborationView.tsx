import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { CheckCheck, FileText, MessageSquareText, Plus, Scale } from "lucide-react";
import AppDialog from "../components/AppDialog";
import AssistView, { type AssistNavigationState } from "./AssistView";
import FactBar from "../components/FactBar";
import ModelConnectionStrip from "../components/ModelConnectionStrip";
import PageHeader from "../components/PageHeader";
import RunControlPanel, { runLabels, stepLabels } from "../components/RunControlPanel";
import TaskDelegatePanel from "../components/TaskDelegatePanel";
import type { ReviewNavigationState } from "../components/ReviewDecisionPanel";
import WorkspaceSidePanel from "../components/WorkspaceSidePanel";
import CollaborationSplitter from "../components/CollaborationSplitter";
import type { RelayApiClient, RelayControlRequest, RelayReview, RelayRun, RelayTaskDetail } from "../api/relayClient";
import { clearDraftGuard, currentDraftGuard, setDraftGuard, type DraftGuard } from "../lib/draftGuard";
import { describeLiveError } from "../lib/liveErrors";
import { executorLabels, taskStatusLabels } from "../lib/labels";
import { useRelayConnection } from "../lib/relayConnection";
import { useRunDraftPreview } from "../lib/useRunDraftPreview";
import { readCollaborationLayoutPreferences, saveCollaborationLayoutPreferences,
  type CollaborationLayoutMode } from "../lib/collaborationLayoutPreferences";
import "./CollaborationView.css";

const cleanNavigation: AssistNavigationState = { dirty: false, pending: null };

function recoveryKey(client: RelayApiClient): string {
  return `relay-agent-chat-pending:${client.baseUrl}:${client.workspaceId}`;
}

type RecoveryRecord = { readonly commandId: string; readonly commandType: string;
  readonly sessionId: string | null; readonly targetKind: "PROJECT" | "TASK"; readonly targetId: string };

function readRecovery(client: RelayApiClient): readonly RecoveryRecord[] {
  try {
    const value: unknown = JSON.parse(window.sessionStorage.getItem(recoveryKey(client)) ?? "[]");
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is RecoveryRecord => item && typeof item === "object" &&
      typeof item.commandId === "string" && typeof item.commandType === "string" &&
      (item.sessionId === null || typeof item.sessionId === "string") &&
      (item.targetKind === "PROJECT" || item.targetKind === "TASK") && typeof item.targetId === "string");
  } catch { return []; }
}

export default function CollaborationView() {
  const connection = useRelayConnection();
  if (connection.mode !== "live" || !connection.client) {
    return <section className="page-state" data-testid="collab-fixture-gap">
      <p className="eyebrow">协作工作区</p><h1>示例模式没有真实工作</h1>
      <p>连接本机 API 后，可以在这里恢复近期工作、讨论目标、显式委托 Agent、阅读产物并作出判断。示例模式不生成模型回复、执行记录或完成凭据。</p>
      <Link className="text-link" to="/projects">返回项目列表</Link>
    </section>;
  }
  return <CollaborationLive key={connection.epoch} client={connection.client} />;
}

function CollaborationLive({ client }: { client: RelayApiClient }) {
  // 选中的工作由 URL ?work={taskId} 承担，左栏、面包屑和深链接因此指向同一个确切任务。
  const [search, setSearch] = useSearchParams();
  const workId = search.get("work");
  const [sessionId, setSessionId] = useState<string | null | undefined>(undefined);
  // undefined = 未指定会话（沿用该任务最近会话）；null = 用户显式要求新建会话。
  const [task, setTask] = useState<RelayTaskDetail | null>(null);
  const [projectTitle, setProjectTitle] = useState<string | null>(null);
  const [projectArchivedAt, setProjectArchivedAt] = useState<string | null | undefined>(undefined);
  const [projectReadError, setProjectReadError] = useState<string | null>(null);
  const [run, setRun] = useState<RelayRun | null>(null);
  const [controlRecord, setControlRecord] = useState<RelayControlRequest | null>(null);
  const [reviews, setReviews] = useState<readonly RelayReview[]>([]);
  const [retainedReview, setRetainedReview] = useState<RelayReview | null>(null);
  const [reviewsLoading, setReviewsLoading] = useState(false);
  const [selectedReviewId, setSelectedReviewId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [sideTab, setSideTab] = useState<"DOCUMENT" | "CHECK" | "HISTORY">("DOCUMENT");
  const [layout, setLayout] = useState(readCollaborationLayoutPreferences);
  const [devToolsOpen, setDevToolsOpen] = useState(false);
  const [narrowSideOpen, setNarrowSideOpen] = useState(false);
  const [transition, setTransition] = useState<{ kind: "dirty" | "pending"; proceed: () => void; commandId: string | null } | null>(null);
  const [recoveries, setRecoveries] = useState<readonly RecoveryRecord[]>(() => readRecovery(client));
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [checkingId, setCheckingId] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const taskRequest = useRef(0);
  const runRequest = useRef(0);
  const reviewRequest = useRef(0);
  const navigationRef = useRef<AssistNavigationState>(cleanNavigation);
  const reviewNavigationRef = useRef<ReviewNavigationState | null>(null);
  const reviewRef = useRef<RelayReview | null>(null);
  const workIdRef = useRef(workId);
  workIdRef.current = workId;
  const taskRef = useRef(task);
  taskRef.current = task;

  const updateRecoveries = useCallback((update: (current: readonly RecoveryRecord[]) => readonly RecoveryRecord[]) => {
    setRecoveries((current) => {
      const next = update(current);
      try { window.sessionStorage.setItem(recoveryKey(client), JSON.stringify(next)); } catch { /* 会话内仍保留原 ID。 */ }
      return next;
    });
  }, [client]);
  const reportNavigation = useCallback((state: AssistNavigationState) => {
    const previous = navigationRef.current.pending;
    navigationRef.current = state;
    if (previous && !state.pending) updateRecoveries((current) => current.filter((item) => item.commandId !== previous.commandId));
    if (state.pending && workIdRef.current) {
      const targetId = workIdRef.current;
      updateRecoveries((current) => current.some((item) => item.commandId === state.pending?.commandId)
        ? current : [...current, { ...state.pending!, targetKind: "TASK", targetId }]);
    }
  }, [updateRecoveries]);
  const reportReviewNavigation = useCallback((state: ReviewNavigationState) => {
    reviewNavigationRef.current = state;
  }, []);
  useEffect(() => {
    const guard: DraftGuard = {
      hasUnsavedChanges: () => navigationRef.current.dirty || navigationRef.current.pending !== null,
      pendingCommandId: () => navigationRef.current.pending?.commandId ?? null,
      discard: () => { navigationRef.current.discard?.(); navigationRef.current = cleanNavigation; }
    };
    setDraftGuard(guard);
    return () => clearDraftGuard(guard);
  }, []);

  const reloadAll = useCallback(async () => {
    const targetId = workIdRef.current;
    if (!targetId) { setTask(null); setRun(null); setReviews([]); return; }
    const version = ++taskRequest.current;
    setLoading(true); setError(null);
    try {
      const loaded = await client.getTask(targetId);
      if (version !== taskRequest.current) return;
      if (loaded.id !== targetId) throw new Error("Task 读取结果与所选工作不匹配。");
      setTask(loaded);
    } catch (caught) {
      if (version !== taskRequest.current) return;
      // 已挂载的判断 Owner 保留原命令；失败事实关闭新写入，不能用刷新错误卸载回执核对入口。
      if (taskRef.current?.id !== targetId) { setTask(null); setReviews([]); setRetainedReview(null); }
      setRun(null); setControlRecord(null);
      setError(describeLiveError(caught).message);
    } finally { if (version === taskRequest.current) setLoading(false); }
  }, [client]);

  const reloadRun = useCallback(async () => {
    const current = taskRef.current;
    const runId = current?.executorRunId ?? null;
    if (!runId) { runRequest.current++; setRun(null); setControlRecord(null); setRunError(null); return; }
    const version = ++runRequest.current;
    setRunError(null);
    try {
      const loadedRun = await client.getRun(runId);
      if (version !== runRequest.current || taskRef.current?.executorRunId !== runId) return;
      if (loadedRun.taskId !== current!.id) throw new Error("Run 与当前任务不匹配。");
      setRun(loadedRun);
      const controlId = loadedRun.pendingControlRequest?.id ?? null;
      if (controlId) {
        const loadedControl = await client.getControlRequest(runId, controlId);
        if (version !== runRequest.current) return;
        setControlRecord(loadedControl);
      } else setControlRecord(null);
    } catch (caught) {
      if (version !== runRequest.current) return;
      setRun(null); setControlRecord(null);
      setRunError(describeLiveError(caught).message);
    }
  }, [client]);

  const reloadReviews = useCallback(async () => {
    const current = taskRef.current;
    if (!current) { reviewRequest.current++; setReviews([]); setReviewsLoading(false); return; }
    const version = ++reviewRequest.current;
    setReviewsLoading(true);
    try {
      const all = await client.getReviews();
      if (reviewRequest.current !== version || taskRef.current?.id !== current.id) return;
      const scoped = all.filter((review) => review.taskId === current.id);
      const previous = reviewRef.current;
      const navigation = reviewNavigationRef.current;
      const protectedReview = previous && previous.id === navigation?.reviewId && (navigation.dirty || navigation.pendingCommandId)
        ? previous : null;
      setReviews(scoped);
      setRetainedReview(protectedReview && !scoped.some((review) => review.id === protectedReview.id) ? protectedReview : null);
      setSelectedReviewId((selected) => scoped.some((review) => review.id === selected) ? selected
        : protectedReview?.id ?? scoped[0]?.id ?? null);
      setReviewError(null);
    } catch (caught) {
      if (reviewRequest.current === version) setReviewError(describeLiveError(caught).message);
    } finally {
      if (reviewRequest.current === version) setReviewsLoading(false);
    }
  }, [client]);

  useEffect(() => {
    taskRequest.current++; runRequest.current++; reviewRequest.current++;
    setTask(null); setRun(null); setControlRecord(null); setReviews([]); setRetainedReview(null); setSelectedReviewId(null); setReviewsLoading(false);
    reviewNavigationRef.current = null; reviewRef.current = null;
    setProjectTitle(null); setProjectArchivedAt(undefined); setProjectReadError(null);
    setError(null); setRunError(null); setReviewError(null);
    setSessionId(undefined); setNarrowSideOpen(false);
    void reloadAll();
    return () => { taskRequest.current++; runRequest.current++; reviewRequest.current++; };
  }, [workId, reloadAll]);

  useEffect(() => { void reloadRun(); void reloadReviews(); },
    // 任务事实到达后才认得它的 Run 与待判断项；换任务、换执行权或手动刷新都重新读取。
    [task?.id, task?.executorRunId, task?.revision, reloadKey]);

  useEffect(() => {
    if (!task?.projectId) { setProjectTitle(null); setProjectArchivedAt(null); return; }
    let active = true;
    setProjectArchivedAt(undefined);
    void client.getProject(task.projectId).then((project) => {
      if (!active || taskRef.current?.projectId !== task.projectId) return;
      if (project.id !== task.projectId) return;
      setProjectTitle(project.title); setProjectArchivedAt(project.archivedAt); setProjectReadError(null);
    }, (caught: unknown) => {
      if (!active) return;
      setProjectTitle(null); setProjectArchivedAt(undefined); setProjectReadError(describeLiveError(caught).message);
    });
    return () => { active = false; };
  }, [client, task?.projectId]);

  const canReadDraft = run !== null && task !== null && run.status === "RUNNING" &&
    task.executor === "AI" && task.executorRunId === run.id &&
    run.steps.find((step) => step.id === run.currentStepId)?.kind === "DRAFT" &&
    run.pendingControlRequest === null && error === null && runError === null;
  const draft = useRunDraftPreview({ client, runId: run?.id ?? "", revision: run?.revision ?? "",
    currentStepId: run?.currentStepId ?? null, enabled: canReadDraft, onSettled: () => { void reloadRun(); } });

  const projectWriteBlockedReason = loading || error !== null ? "任务事实正在核对或读取失败，不能提交新的任务命令。"
    : task === null || task.projectId === null ? null
    : projectArchivedAt === undefined
      ? `Project 事实正在核对或读取失败，不能提交新的任务命令。${projectReadError ?? ""}`
      : projectArchivedAt !== null ? "项目已归档，不能提交新的任务命令。" : null;
  const visibleReviews = retainedReview ? [...reviews, retainedReview] : reviews;
  const reviewIndex = visibleReviews.findIndex((review) => review.id === selectedReviewId);
  const openReview = visibleReviews[reviewIndex] ?? null;
  reviewRef.current = openReview;
  const reviewWriteBlockedReason = openReview === null ? null
    : loading || error !== null || task === null || task.id !== workId
      ? "本工作区的 Review 判断需要先核对当前任务事实。"
      : projectWriteBlockedReason
        ?? (reviewsLoading ? "Review 正在核对，不能使用旧请求提交判断。"
          : reviewError !== null ? `Review 读取失败，不能使用旧请求提交判断：${reviewError}`
          : retainedReview?.id === openReview.id ? "原判断请求未出现在最新列表中，已保留说明与原命令核对入口；不能按旧请求提交新决定。"
          : openReview.taskId !== task.id || openReview.projectId !== task.projectId
            ? "Review 归属与当前任务或项目不匹配，不能提交判断。" : null);
  const activeRun = run !== null && task !== null && task.executor === "AI" && task.executorRunId === run.id;
  const terminal = run !== null && ["COMPLETED", "FAILED", "CANCELLED"].includes(run.status);
  const runFailureReasons = [...new Set((run?.steps ?? []).map((step) => step.reason)
    .filter((reason): reason is string => typeof reason === "string" && reason !== ""))];
const currentStep = run?.steps.find((step) => step.id === run.currentStepId);
  const waitReason = run?.waitReason ?? task?.waitingReason ?? null;
  // 这三类状态一旦收进「更多操作」就不再可发现，因此 Run 控制留在页头常驻。
  const runNeedsAttention = (run?.unresolvedOperationIds.length ?? 0) > 0 || run?.pendingControlRequest != null || runFailureReasons.length > 0;
  const setLayoutMode = (mode: CollaborationLayoutMode) => {
    setLayout((current) => saveCollaborationLayoutPreferences({ ...current, mode }));
  };
  const refreshFacts = useCallback(() => { setReloadKey((value) => value + 1); void reloadAll(); void reloadRun(); void reloadReviews(); },
    [reloadAll, reloadRun, reloadReviews]);
  const runControl = run !== null && task !== null
    ? <RunControlPanel compact state={{ run, task, controlRecord, activeRun, terminal, projectWriteBlockedReason }} onReload={refreshFacts} />
    : null;
  // 事实条是页头的按需细节：首屏只留「当前需要什么」，完整事实进展开区。
  const factCells = task === null ? [] : [
    { label: "当前执行状态", value: run?.unresolvedOperationIds.length ? "外部结果待核对"
      : reviews.length > 0 ? "等待人工判断"
      : run === null ? "尚未启动 Run" : runLabels[run.status] ?? run.status,
      note: run?.unresolvedOperationIds.length
        ? `${run.unresolvedOperationIds.length} 项动作结果未知；沿原 operation_id 核对，不盲重试。`
        : reviews.length > 0 ? `${reviews.length} 项待决定；等待判断不等于已暂停。`
        : runFailureReasons.length > 0 ? `失败原因：${runFailureReasons.join("、")}`
        : run === null ? `当前执行者：${executorLabels[task.executor]}`
        : `Run ${run.id.slice(0, 8)}` },
    { label: "任务 / 验收", note: `任务 v${task.revision} / 验收 v${task.acceptance.acceptanceRevision}` },
    { label: "证据：检查记录", action: <button className="text-link" type="button" data-testid="collab-open-checks"
      onClick={() => { setSideTab("CHECK"); setNarrowSideOpen(true); if (layout.mode === "chat") setLayoutMode("result"); }}>查看运行与检查详情 →</button> }
  ];

  function requestTransition(proceed: () => void) {
    const state = navigationRef.current;
    const guard = currentDraftGuard();
    const commandId = guard?.pendingCommandId?.() ?? state.pending?.commandId ?? null;
    if (commandId) setTransition({ kind: "pending", proceed, commandId });
    else if (guard?.hasUnsavedChanges() || state.dirty) setTransition({ kind: "dirty", proceed, commandId: null });
    else proceed();
  }

  async function checkRecovery(record: RecoveryRecord) {
    const version = taskRequest.current; const currentWorkId = workIdRef.current;
    setCheckingId(record.commandId); setRecoveryError(null);
    try {
      const receipt = await client.getCommandReceipt(record.commandId);
      if (version !== taskRequest.current || currentWorkId !== workIdRef.current) return;
      if (receipt.commandId !== record.commandId || receipt.commandType !== record.commandType ||
        record.commandType === "RequestAssistMessage" && receipt.result.session_id !== record.sessionId) {
        throw new Error("原命令回执与记录的身份不匹配。");
      }
      updateRecoveries((current) => current.filter((item) => item.commandId !== record.commandId));
      requestTransition(() => {
        setSessionId(record.sessionId); setSearch({ work: record.targetId });
      });
    } catch (caught) {
      if (version === taskRequest.current && currentWorkId === workIdRef.current)
        setRecoveryError(`${describeLiveError(caught).message} 原载荷未保存，不能换命令 ID 重试；请继续核对服务端结果。`);
    } finally { setCheckingId(null); }
  }

  return <section className="collab-page" data-testid="collab-page">
    <div className="collab-main">
      {recoveries.length > 0 && <section className="collab-recovery" role="status" data-testid="collab-recovery">
        <strong>待核对的原命令</strong>
        {recoveries.map((record) => <div key={record.commandId}>
          <span>{record.commandType} · {record.targetKind === "PROJECT" ? "项目" : "任务"} {record.targetId} · {record.commandId}</span>
          <button className="secondary-button" type="button" disabled={checkingId !== null}
            data-testid={`collab-recovery-${record.commandId}`} onClick={() => void checkRecovery(record)}>
            {checkingId === record.commandId ? "正在查询" : "查询原命令回执"}</button></div>)}
        {recoveryError && <p className="action-error" role="alert">{recoveryError}</p>}
        <p className="helper-text">离开页面后只保留命令身份；回执查不到时不能换新 ID 重试。</p>
      </section>}


{task !== null && <header className="collab-goal" data-testid="collab-goal">
        <PageHeader title={task.title} testId="collab-page-head"
          status={<span className="status-chip">{taskStatusLabels[task.status] ?? task.status}</span>}
          meta={<span>项目：{projectTitle ?? (task.projectId === null ? "无项目" : "项目标题暂不可读取")}</span>}
          lede={task.acceptance.objective ?? undefined}
          actions={<>
            {reviews.length > 0 && <button className="secondary-button" type="button" data-testid="collab-open-judgment"
              onClick={() => {
                setDevToolsOpen(false); setSideTab("DOCUMENT"); setNarrowSideOpen(true);
                if (layout.mode === "chat") setLayoutMode("result");
                window.requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-testid="collab-judgment"]')?.focus());
              }}>查看待处理 {reviews.length}</button>}
            {task.executorRunId === null && task.projectId !== null && <TaskDelegatePanel compact client={client}
              task={{ id: task.id, projectId: task.projectId, status: task.status, executor: task.executor,
                revision: task.revision, executorRunId: null, allowedActions: task.allowedActions }}
              projectWriteBlockedReason={projectWriteBlockedReason} onDelegated={refreshFacts} />}
          </>}
          more={<>
            <div className="collab-layout-modes" role="group" aria-label="协作工作区布局">
              {([["split", "双栏"], ["chat", "对话"], ["result", "成果"]] as const).map(([mode, label]) =>
                <button key={mode} className="secondary-button" type="button" data-testid={`collab-layout-${mode}`}
                  aria-pressed={layout.mode === mode} onClick={() => setLayoutMode(mode)}>{label}</button>)}
            </div>
            {/* Run 控制只有一个 Owner：需要人工介入时移进页头常驻，否则留在这个默认收起的展开区。 */}
            {!runNeedsAttention && <details className="collab-facts-disclosure">
              <summary>任务与执行详情</summary>
              {runControl}
              <FactBar label="任务与执行事实" testId="collab-facts" cells={factCells} />
              <p className="helper-text">控制提交回执表示 PENDING；等待安全点期间，Run 与任务执行者仍以重新查询的事实为准。</p>
            </details>}
            {task.projectId !== null && <button className="secondary-button collab-tools-toggle" type="button"
              data-testid="collab-devtools-toggle" aria-expanded={devToolsOpen}
              onClick={() => {
                setDevToolsOpen((open) => !open);
                if (!devToolsOpen) { setNarrowSideOpen(true); if (layout.mode === "chat") setLayoutMode("result"); }
              }}>
              {devToolsOpen ? "收起工具面板" : "文件与运行工具"}</button>}
            <ModelConnectionStrip client={client} compact />
          </>}
        >
          <p className="collab-current-need" data-testid="collab-current-need">
            {run?.unresolvedOperationIds.length ? `${run.unresolvedOperationIds.length} 项外部动作结果待核对；沿原 operation_id 核对，不盲重试。`
              : run?.pendingControlRequest ? "已提交控制请求，等待安全点；请求受理不代表已停止或交接。"
              : reviews.length > 0 ? `${reviews.length} 项等待人工判断；等待判断不等于已暂停。`
              : run === null ? `当前执行者：${executorLabels[task.executor]}` : runLabels[run.status] ?? run.status}
            {currentStep && <> · 当前步骤：{stepLabels[currentStep.kind] ?? currentStep.kind}</>}
            {waitReason && <> · 等待原因：{waitReason}</>}
          </p>
          {/* UNKNOWN、控制请求与失败原因不折叠：这三类一旦收进「更多操作」就不再可发现。 */}
          {runNeedsAttention && <div className="collab-run-controls" data-testid="collab-run-disclosure">{runControl}</div>}
        </PageHeader>
      </header>}
      {task !== null && <div className="collab-notices">
        {loading && <p className="helper-text" role="status">正在更新任务事实，已显示的内容保持可见。</p>}
        {error && <p className="action-error" role="alert" data-testid="collab-task-error">{error} 任务事实尚未重新核对，不能提交新的判断或任务命令。</p>}
        {runError && <p className="action-error" role="alert" data-testid="collab-run-error">{runError} 已保存的产物与判断仍可继续阅读。</p>}
        {projectWriteBlockedReason && <p className="disabled-reason" data-testid="collab-project-archive-reason">{projectWriteBlockedReason}</p>}
      </div>}

      {task !== null && <div className="collab-narrow-tabs" aria-label="工作区视图" hidden={layout.mode !== "split"}>
        <button type="button" className={`collab-side-tab${!narrowSideOpen ? " collab-side-tab--active" : ""}`}
          data-testid="collab-narrow-DISCUSSION" aria-pressed={!narrowSideOpen} onClick={() => setNarrowSideOpen(false)}>讨论</button>
        <button type="button" className={`collab-side-tab${narrowSideOpen ? " collab-side-tab--active" : ""}`}
          data-testid="collab-narrow-DOCUMENT" aria-pressed={narrowSideOpen} onClick={() => setNarrowSideOpen(true)}>成果与判断</button>
      </div>}

      <div className={`collab-columns${task === null ? " collab-columns--empty" : ""}`} data-pane={sideTab}
        data-layout-mode={task === null ? "split" : layout.mode} data-narrow-side={narrowSideOpen ? "open" : "closed"}
        style={{ "--relay-collab-chat-column": `${layout.chatRatio}fr`, "--relay-collab-result-column": `${1 - layout.chatRatio}fr` } as CSSProperties}>
        {task === null
          ? <>
              <section className="collab-center collab-center--empty" aria-label="工作主区" data-testid="collab-center">
                <div className="collab-empty" data-testid="collab-empty">
                  <div className="collab-empty-mark"><MessageSquareText aria-hidden="true" /></div>
                  <p className="eyebrow">协作工作区</p>
                  <h1>这次想推进什么</h1>
                  <p className="collab-empty-lede">从左侧「近期工作」继续，或选择一个任务开始讨论。目标、进展与成果会回到同一张工作桌。</p>
                  <TargetPicker client={client} onOpen={(next) => requestTransition(() => { setSessionId(next.sessionId); setSearch({ work: next.taskId }); setSideTab("DOCUMENT"); })} />
                  <p className="collab-empty-note helper-text">打开工作区后，再分别确认讨论或委托。</p>
                  {workId !== null && loading && <p className="helper-text" role="status">正在恢复这项工作…</p>}
                  {workId !== null && error && <p className="action-error" role="alert" data-testid="collab-task-error">{error}</p>}
                </div>
              </section>
              <aside className="collab-side collab-side--intro" aria-label="产物与判断" data-testid="collab-side">
                <div className="collab-side-empty" data-testid="collab-side-empty">
                  <header className="collab-intro-heading">
                    <p className="eyebrow">产物与判断</p>
                    <h2>讨论之外，成果也在这里</h2>
                    <p className="helper-text">选定任务后，沿着确切版本查看与确认。</p>
                  </header>
                  <div className="collab-intro-item"><FileText aria-hidden="true" /><div>
                    <h3>阅读产物</h3>
                    <p>查看已保存版本的正文与修改。生成中的草稿会单独标记。</p>
                  </div></div>
                  <div className="collab-intro-item"><Scale aria-hidden="true" /><div>
                    <h3>处理判断</h3>
                    <p>需要你决定时，对照版本与依据，接受或提出修改意见。</p>
                  </div></div>
                  <div className="collab-intro-item"><CheckCheck aria-hidden="true" /><div>
                    <h3>确认完成</h3>
                    <p>对照产物与验收条件独立确认，回复结束不等于任务完成。</p>
                  </div></div>
                </div>
              </aside>
            </>
          : <>
            <section className="collab-center" aria-label="工作主区" data-testid="collab-center" hidden={layout.mode === "result"}>
              <AssistView key={`${task.id}:${sessionId === undefined ? "auto" : sessionId}`}
                targetKind="TASK" targetId={task.id}
                preferredSessionId={sessionId} standalone
                externalWriteBlockedReason={projectWriteBlockedReason}
                onNavigationStateChange={reportNavigation}
                onRequestNewSession={requestTransition}
                onRequestSessionChange={requestTransition} onSessionSelected={setSessionId}
                onSessionCreated={(created) => setSessionId(created)} />
            </section>

            <CollaborationSplitter ratio={layout.chatRatio} hidden={layout.mode !== "split"}
              onRatioChange={(chatRatio, commit) => setLayout((current) => {
                const next = { ...current, chatRatio };
                return commit ? saveCollaborationLayoutPreferences(next) : next;
              })} />
            <div className="collab-result-pane" hidden={layout.mode === "chat"}>
            <WorkspaceSidePanel client={client} task={task} run={run} draft={draft}
              tab={sideTab} onTabChange={setSideTab}
              devToolsOpen={devToolsOpen} onCloseDevTools={() => setDevToolsOpen(false)}
              reviews={visibleReviews} reviewIndex={reviewIndex} onReviewIndexChange={(next) => {
                const selected = visibleReviews[next];
                if (selected && selected.id !== selectedReviewId) requestTransition(() => {
                  setSelectedReviewId(selected.id); setRetainedReview(null);
                });
              }}
              openReview={openReview} reviewError={reviewError}
              reviewWriteBlockedReason={reviewWriteBlockedReason}
              projectWriteBlockedReason={projectWriteBlockedReason}
              onReviewNavigationStateChange={reportReviewNavigation}
              onRefresh={refreshFacts} />
            </div>
          </>}
      </div>
    </div>

    <AppDialog open={transition !== null} title={transition?.kind === "pending" ? "命令结果待核对" : "未发送的内容"}
      onClose={() => setTransition(null)}>
      <p>{transition?.kind === "pending"
        ? `原命令 ${transition.commandId ?? ""} 的结果仍待核对。请留在当前工作区查询回执；不会以新命令重试。`
        : "当前工作区有未发送的消息、已选资料或判断说明。切换前请确认是否丢弃这些内容。"}</p>
      <div className="form-actions">
        <button className="secondary-button" type="button" onClick={() => setTransition(null)}>留在当前工作区</button>
        {transition?.kind === "dirty" && <button className="primary-button" type="button" data-testid="collab-discard-draft"
          onClick={() => {
            const commandId = currentDraftGuard()?.pendingCommandId?.() ?? navigationRef.current.pending?.commandId ?? null;
            if (commandId) { setTransition({ ...transition, kind: "pending", commandId }); return; }
            const proceed = transition.proceed;
            currentDraftGuard()?.discard(); setTransition(null); proceed();
          }}>丢弃并继续</button>}
      </div>
    </AppDialog>
  </section>;
}

function TargetPicker({ client, onOpen }: {  client: RelayApiClient;
  onOpen: (next: { readonly taskId: string; readonly sessionId: string | null | undefined }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [tasks, setTasks] = useState<readonly { id: string; title: string }[]>([]);
  const [selected, setSelected] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);

  useEffect(() => {
    if (!open) return;
    const version = ++request.current;
    setLoading(true); setError(null);
    void client.getWorkspaceTasksPage(null).then((page) => {
      if (version !== request.current) return;
      setTasks(page.items.map((item) => ({ id: item.id, title: item.title }))); setLoading(false);
    }, (caught: unknown) => {
      if (version !== request.current) return;
      setError(describeLiveError(caught).message); setLoading(false);
    });
    return () => { request.current++; };
  }, [open, client]);

  if (!open) return <button className="primary-button" type="button" data-testid="collab-pick-target" onClick={() => setOpen(true)}>
    <Plus aria-hidden="true" />选择要推进的任务</button>;
  return <section className="collab-picker" data-testid="collab-target-picker">
    <h2>选择要推进的任务</h2>
    <p className="helper-text">讨论会留在这项任务中，方便下次继续。</p>
    {loading && <p className="helper-text" role="status">正在读取任务…</p>}
    {error && <p className="action-error" role="alert">{error}</p>}
    {!loading && !error && tasks.length === 0 && <p className="helper-text">当前工作空间还没有任务。
      <Link className="text-link" to="/tasks?view=create">前往新建任务</Link></p>}
    <label className="field"><span className="field-label">任务</span>
      <select data-testid="collab-target-select" value={selected} disabled={loading || error !== null || tasks.length === 0}
        onChange={(event) => setSelected(event.target.value)}>
        <option value="">{loading ? "正在读取任务…" : "请选择任务"}</option>
        {tasks.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
      </select></label>
    <div className="form-actions">
      <button className="primary-button" type="button" data-testid="collab-target-open" disabled={!selected || loading || error !== null}
        onClick={() => { if (selected) onOpen({ taskId: selected, sessionId: undefined }); }}>打开这项工作</button>
      <button className="secondary-button" type="button" onClick={() => setOpen(false)}>取消</button>
    </div>
  </section>;
}
