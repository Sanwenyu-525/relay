import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Clock3, FileText, MessageSquareText, Plus, UserRound } from "lucide-react";
import AppDialog from "../components/AppDialog";
import AssistView, { type AssistNavigationState } from "./AssistView";
import ModelConnectionStrip from "../components/ModelConnectionStrip";
import RunControlPanel, { runLabels } from "../components/RunControlPanel";
import TaskDelegatePanel from "../components/TaskDelegatePanel";
import WorkspaceSidePanel from "../components/WorkspaceSidePanel";
import type { RelayApiClient, RelayControlRequest, RelayReview, RelayRun, RelayTaskDetail } from "../api/relayClient";
import { clearDraftGuard, setDraftGuard, type DraftGuard } from "../lib/draftGuard";
import { describeLiveError } from "../lib/liveErrors";
import { executorLabels, taskStatusLabels } from "../lib/labels";
import { useRelayConnection } from "../lib/relayConnection";
import { useRunDraftPreview } from "../lib/useRunDraftPreview";
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
  const [reviewsLoading, setReviewsLoading] = useState(false);
  const [reviewIndex, setReviewIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [sideTab, setSideTab] = useState<"DOCUMENT" | "CHECK" | "HISTORY">("DOCUMENT");
  const [devToolsOpen, setDevToolsOpen] = useState(false);
  const [narrowSideOpen, setNarrowSideOpen] = useState(false);
  const [transition, setTransition] = useState<{ kind: "dirty" | "pending"; proceed: () => void } | null>(null);
  const [recoveries, setRecoveries] = useState<readonly RecoveryRecord[]>(() => readRecovery(client));
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [checkingId, setCheckingId] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const taskRequest = useRef(0);
  const runRequest = useRef(0);
  const reviewRequest = useRef(0);
  const navigationRef = useRef<AssistNavigationState>(cleanNavigation);
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
  useEffect(() => {
    const guard: DraftGuard = {
      hasUnsavedChanges: () => navigationRef.current.dirty || navigationRef.current.pending !== null,
      discard: () => { navigationRef.current = cleanNavigation; }
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
      setTask(null); setRun(null); setReviews([]); setControlRecord(null);
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
      setReviews(all.filter((review) => review.taskId === current.id));
      setReviewError(null);
    } catch (caught) {
      if (reviewRequest.current === version) setReviewError(describeLiveError(caught).message);
    } finally {
      if (reviewRequest.current === version) setReviewsLoading(false);
    }
  }, [client]);

  useEffect(() => {
    taskRequest.current++; runRequest.current++; reviewRequest.current++;
    setTask(null); setRun(null); setControlRecord(null); setReviews([]); setReviewIndex(0); setReviewsLoading(false);
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

  const projectWriteBlockedReason = task === null || task.projectId === null ? null
    : loading || error !== null || projectArchivedAt === undefined
      ? `Project 事实正在核对或读取失败，不能提交新的任务命令。${projectReadError ?? ""}`
      : projectArchivedAt !== null ? "项目已归档，不能提交新的任务命令。" : null;
  const openReview = reviews[Math.min(reviewIndex, Math.max(reviews.length - 1, 0))] ?? null;
  const reviewWriteBlockedReason = openReview === null ? null
    : loading || error !== null || task === null || task.id !== workId
      ? "本工作区的 Review 判断需要先核对当前任务事实。"
      : projectWriteBlockedReason
        ?? (reviewsLoading ? "Review 正在核对，不能使用旧请求提交判断。"
          : reviewError !== null ? `Review 读取失败，不能使用旧请求提交判断：${reviewError}`
          : openReview.taskId !== task.id || openReview.projectId !== task.projectId
            ? "Review 归属与当前任务或项目不匹配，不能提交判断。" : null);
  const activeRun = run !== null && task !== null && task.executor === "AI" && task.executorRunId === run.id;
  const terminal = run !== null && ["COMPLETED", "FAILED", "CANCELLED"].includes(run.status);
  const runFailureReasons = [...new Set((run?.steps ?? []).map((step) => step.reason)
    .filter((reason): reason is string => typeof reason === "string" && reason !== ""))];
  const refreshFacts = useCallback(() => { setReloadKey((value) => value + 1); void reloadAll(); void reloadRun(); void reloadReviews(); },
    [reloadAll, reloadRun, reloadReviews]);

  function requestTransition(proceed: () => void) {
    const state = navigationRef.current;
    if (state.pending) setTransition({ kind: "pending", proceed });
    else if (state.dirty) setTransition({ kind: "dirty", proceed });
    else proceed();
  }

  async function checkRecovery(record: RecoveryRecord) {
    setCheckingId(record.commandId); setRecoveryError(null);
    try {
      const receipt = await client.getCommandReceipt(record.commandId);
      if (receipt.commandId !== record.commandId || receipt.commandType !== record.commandType ||
        record.commandType === "RequestAssistMessage" && receipt.result.session_id !== record.sessionId) {
        throw new Error("原命令回执与记录的身份不匹配。");
      }
      updateRecoveries((current) => current.filter((item) => item.commandId !== record.commandId));
      setSessionId(record.sessionId);
      setSearch({ work: record.targetId });
    } catch (caught) {
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


      <div className="collab-columns" data-pane={sideTab} data-narrow-side={narrowSideOpen ? "open" : "closed"}>
        {task === null
          ? <>
              <section className="collab-center" aria-label="工作主区" data-testid="collab-center">
                <div className="collab-empty" data-testid="collab-empty">
                  <MessageSquareText aria-hidden="true" />
                  <h1>这次想推进什么</h1>
                  <p>从左栏「近期工作」选一项可以恢复同一目标、实际进展、确切产物与待判断项；也可以先选定一个确切任务再开始讨论。打开这个页面不会新建任务、不会调用模型。</p>
                  <TargetPicker client={client} onOpen={(next) => requestTransition(() => { setSessionId(next.sessionId); setSearch({ work: next.taskId }); setSideTab("DOCUMENT"); })} />
                  {workId !== null && error && <p className="action-error" role="alert" data-testid="collab-task-error">{error}</p>}
                </div>
              </section>
              <aside className="collab-side" aria-label="产物与判断" data-testid="collab-side">
                <div className="collab-side-empty" data-testid="collab-side-empty">
                  <h2>产物</h2>
                  <p className="helper-text">选定工作后，这里显示确切产物版本、正文与版本比较。生成中的草稿会标为未保存，不冒充已保存版本。</p>
                  <h2>判断</h2>
                  <p className="helper-text">只有验证或动作准入确实需要人工决定时，这里才出现请求；不会为了填满页面制造待办。</p>
                  <h2>完成</h2>
                  <p className="helper-text">完成是一次独立确认：对照确切产物与验收条件提交，模型回复结束、检查通过和批准动作都不等于任务完成。</p>
                </div>
              </aside>
            </>
          : <>
            <section className="collab-center" aria-label="工作主区" data-testid="collab-center">
      {task !== null && <header className="collab-goal" data-testid="collab-goal">
        <div className="collab-goal-main">
          <div className="collab-goal-context"><p className="eyebrow">{projectTitle ?? (task.projectId === null ? "无项目" : "项目标题暂不可读取")}</p>
            <span className="status-chip">{taskStatusLabels[task.status] ?? task.status}</span></div>
          <div className="collab-goal-title"><h1>{task.title}</h1></div>
          {task.acceptance.objective && <p className="page-lede">{task.acceptance.objective}</p>}
        </div>
        <ul className="collab-factbar" data-testid="collab-facts">
          <li><span className="collab-factbar-label"><UserRound aria-hidden="true" />{run?.unresolvedOperationIds.length
            ? "外部结果待核对"
            : reviews.length > 0 ? "等待人工判断"
            : run === null ? "尚未启动 Run" : runLabels[run.status] ?? run.status}</span>
            <span className="collab-factbar-note">{run?.unresolvedOperationIds.length
              ? `${run.unresolvedOperationIds.length} 项动作结果未知；沿原 operation_id 核对，不盲重试。`
              : reviews.length > 0
              ? `${reviews.length} 项待决定；等待判断不等于已暂停。`
              : runFailureReasons.length > 0 ? `失败原因：${runFailureReasons.join("、")}`
              : run === null ? `当前执行者：${executorLabels[task.executor]}`
              : `Run ${run.id.slice(0, 8)}`}</span></li>
          <li><span className="collab-factbar-label"><Clock3 aria-hidden="true" />任务 / 验收</span>
            <span className="collab-factbar-note">任务 v{task.revision} / 验收 v{task.acceptance.acceptanceRevision} · 绑定确切版本</span></li>
          <li><span className="collab-factbar-label"><FileText aria-hidden="true" />证据：检查记录</span>
            <button className="text-link" type="button" data-testid="collab-open-checks"
              onClick={() => { setSideTab("CHECK"); setNarrowSideOpen(true); }}>查看运行与检查详情 →</button></li>
        </ul>
        {/* 状态、模型端口与工具入口合并为一条工具带；控制与模型事实常驻可见，不各自占一行。 */}
        <div className="collab-goal-toolbar">
          {run && <details className="collab-run-disclosure" data-testid="collab-run-disclosure"
            open={run.pendingControlRequest !== null || run.unresolvedOperationIds.length > 0 || run.status === "FAILED"}>
            <summary>执行控制 · {runLabels[run.status] ?? run.status}
              {run.pendingControlRequest !== null ? " · 已提交控制请求，等待安全点" : ""}
              {run.unresolvedOperationIds.length > 0 ? " · 有未结清动作" : ""}</summary>
            <RunControlPanel compact state={{ run, task, controlRecord, activeRun, terminal, projectWriteBlockedReason }}
              onReload={refreshFacts} />
          </details>}
          {task.projectId !== null && <button className="secondary-button collab-tools-toggle" type="button"
            data-testid="collab-devtools-toggle" aria-expanded={devToolsOpen}
            onClick={() => setDevToolsOpen((open) => !open)}>
            {devToolsOpen ? "收起工具面板" : "文件与运行工具"}</button>}
          <ModelConnectionStrip client={client} compact />
        </div>
      </header>}
      {task !== null && <div className="collab-notices">
        {loading && <p className="helper-text" role="status">正在更新任务事实，已显示的内容保持可见。</p>}
        {runError && <p className="action-error" role="alert" data-testid="collab-run-error">{runError} 已保存的产物与判断仍可继续阅读。</p>}
        {projectWriteBlockedReason && <p className="disabled-reason" data-testid="collab-project-archive-reason">{projectWriteBlockedReason}</p>}
      </div>}

              <nav className="collab-narrow-tabs" aria-label="工作区视图">
                <button type="button" className={`collab-side-tab${!narrowSideOpen ? " collab-side-tab--active" : ""}`}
                  data-testid="collab-narrow-DISCUSSION" aria-pressed={!narrowSideOpen} onClick={() => { setDevToolsOpen(false); setNarrowSideOpen(false); }}>讨论</button>
                {([ ["DOCUMENT", "文档"], ["CHECK", "检查"], ["HISTORY", "版本历史"] ] as const).map(([key, label]) =>
                  <button key={key} type="button" className={`collab-side-tab${narrowSideOpen && sideTab === key ? " collab-side-tab--active" : ""}`}
                    data-testid={`collab-narrow-${key}`} aria-pressed={narrowSideOpen && sideTab === key}
                    onClick={() => { setDevToolsOpen(false); setSideTab(key); setNarrowSideOpen(true); }}>{label}</button>)}
              </nav>
              {task.executorRunId === null && task.projectId !== null && <TaskDelegatePanel compact client={client}
                task={{ id: task.id, projectId: task.projectId, status: task.status, executor: task.executor,
                  revision: task.revision, executorRunId: null, allowedActions: task.allowedActions }}
                projectWriteBlockedReason={projectWriteBlockedReason} onDelegated={refreshFacts} />}

              <AssistView key={`${task.id}:${sessionId === undefined ? "auto" : sessionId}`}
                targetKind="TASK" targetId={task.id}
                preferredSessionId={sessionId} standalone
                onNavigationStateChange={reportNavigation}
                onRequestNewSession={requestTransition}
                onSessionCreated={(created) => setSessionId(created)} />
            </section>

            <WorkspaceSidePanel client={client} task={task} run={run} draft={draft}
              tab={sideTab} onTabChange={setSideTab}
              devToolsOpen={devToolsOpen} onCloseDevTools={() => setDevToolsOpen(false)}
              reviews={reviews} reviewIndex={reviewIndex} onReviewIndexChange={setReviewIndex}
              openReview={openReview} reviewError={reviewError}
              reviewWriteBlockedReason={reviewWriteBlockedReason}
              projectWriteBlockedReason={projectWriteBlockedReason}
              onRefresh={refreshFacts} />
          </>}
      </div>
    </div>

    <AppDialog open={transition !== null} title={transition?.kind === "pending" ? "命令结果待核对" : "未发送的内容"}
      onClose={() => setTransition(null)}>
      <p>{transition?.kind === "pending"
        ? `原命令 ${navigationRef.current.pending?.commandId ?? ""} 的结果仍待核对。请留在当前会话查询回执；不会以新命令重试。`
        : "当前会话有未发送的消息或已选资料。切换后这些内容会丢失。"}</p>
      <div className="form-actions">
        <button className="secondary-button" type="button" onClick={() => setTransition(null)}>留在当前会话</button>
        {transition?.kind === "dirty" && <button className="primary-button" type="button" data-testid="collab-discard-draft"
          onClick={() => { const proceed = transition.proceed; setTransition(null); navigationRef.current = cleanNavigation; proceed(); }}>丢弃并继续</button>}
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
  return <section className="collab-picker surface-panel" data-testid="collab-target-picker">
    <h2>先确认归属</h2>
    <p className="helper-text">新目标必须归属于一个确切任务后才发送；这里只读取列表，不创建任务。</p>
    {loading && <p className="helper-text" role="status">正在读取任务…</p>}
    {error && <p className="action-error" role="alert">{error}</p>}
    {!loading && !error && tasks.length === 0 && <p className="helper-text">当前工作空间还没有任务。
      <Link className="text-link" to="/tasks?view=create">前往新建任务</Link></p>}
    <label className="field"><span className="field-label">任务</span>
      <select data-testid="collab-target-select" value={selected} onChange={(event) => setSelected(event.target.value)}>
        <option value="">请选择</option>
        {tasks.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
      </select></label>
    <div className="form-actions">
      <button className="primary-button" type="button" data-testid="collab-target-open" disabled={!selected || loading}
        onClick={() => { if (selected) onOpen({ taskId: selected, sessionId: undefined }); }}>打开这项工作</button>
      <button className="secondary-button" type="button" onClick={() => setOpen(false)}>取消</button>
    </div>
    <p className="helper-text">讨论、委托、批准与完成是四个独立动作；聊天里的“开始”不构成委托授权。</p>
  </section>;
}
