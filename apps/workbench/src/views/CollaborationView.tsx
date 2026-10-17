import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ChevronRight, LayoutGrid, MessageSquare, PanelRightClose, PanelRightOpen } from "lucide-react";
import AppDialog from "../components/AppDialog";
import AssistView, { type AssistNavigationState, type FirstMessageOwner, type FirstMessageProcess } from "./AssistView";
import FactBar from "../components/FactBar";
import ModelConnectionStrip from "../components/ModelConnectionStrip";
import PageHeader from "../components/PageHeader";
import RunControlPanel, { runLabels, stepLabels } from "../components/RunControlPanel";
import TaskDelegatePanel, { type DelegateTarget } from "../components/TaskDelegatePanel";
import type { ReviewNavigationState } from "../components/ReviewDecisionPanel";
import WorkspaceSidePanel from "../components/WorkspaceSidePanel";
import TaskViewDashboard from "../components/TaskViewDashboard";
import WorkDetailsFrame, { type WorkDetailsTab } from "../components/WorkDetailsFrame";
import TaskInspectorPanel from "../components/TaskInspectorPanel";
import CollaborationSplitter from "../components/CollaborationSplitter";
import { createCommandId, RelayApiError, type RelayApiClient, type RelayControlRequest, type RelayReview,
  type RelayArtifact, type RelayArtifactVersionSummary, type RelayConversationMode, type RelayRun, type RelayTaskDetail,
  type RelayWorkingDirectory } from "../api/relayClient";
import { rememberOpened } from "../components/FolderScope";
import FolderScopeBar from "../components/FolderScopeBar";
import { clearActiveConversation, publishActiveConversation } from "../lib/activeConversation";
import { clearDraftGuard, currentDraftGuard, setDraftGuard, type DraftGuard } from "../lib/draftGuard";
import { describeLiveError } from "../lib/liveErrors";
import { executorLabels, taskStatusLabels } from "../lib/labels";
import { readRecentWorkingDirectories, type RecentWorkingDirectory } from "../lib/recentWorkingDirectories";
import { useRelayConnection } from "../lib/relayConnection";
import { useRunDraftPreview } from "../lib/useRunDraftPreview";
import { readCollaborationLayoutPreferences, saveCollaborationLayoutPreferences,
  type CollaborationLayoutMode } from "../lib/collaborationLayoutPreferences";
import "./CollaborationView.css";

const cleanNavigation: AssistNavigationState = { dirty: false, pending: null };

/** 工作详情是纯图标开关键：可访问名称与悬停提示都按展开态说清下一次点击做什么。 */
function inspectorToggleLabel(open: boolean): string {
  return open ? "收起工作详情" : "展开工作详情";
}

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

/**
 * 同会话接续：把先前的普通讨论（尚未归属的既有会话）归入刚打开的项目。
 *
 * 这条命令只改归属，不新建第二个会话，也不授予任何执行权或提案入口。
 * 结果未知时保留原 command_id 供核对，绝不换 ID 重试；迟到响应只更新它原本那次绑定。
 */
type BindingNotice = { readonly sessionId: string; readonly projectId: string; readonly commandId: string;
  /** PENDING 在途；UNKNOWN 结果未知待按原 command_id 核对；CONFIRMED 服务端确认；FAILED 服务端明确拒绝。 */
  readonly status: "PENDING" | "UNKNOWN" | "CONFIRMED" | "FAILED"; readonly error: string | null };

/**
 * 工作目录绑定的在途提示（0087）。
 *
 * 与归属同一套在途/未知/失败语义，但**分开记账**：两条命令的身份、回执与撤回入口都不同，
 * 合成一条提示会让「目录没绑上」显示成「归属失败」，而这两件事的处置方式完全不同。
 */
type DirectoryNotice = { readonly sessionId: string; readonly resourceId: string;
  readonly displayName: string; readonly commandId: string;
  readonly status: "PENDING" | "UNKNOWN" | "CONFIRMED" | "FAILED"; readonly error: string | null };

/** 目录绑定的拒绝文案与归属同类但换成本次动作的说法，不复用「归入项目」的措辞。 */
function describeDirectoryRejection(caught: unknown): string {
  if (caught instanceof RelayApiError) {
    if (caught.problem.status === 409) return `服务端拒绝绑定这个目录（409）：${caught.problem.detail}`;
    if (caught.problem.status === 404) return `会话或该目录在当前作用域不可见（404）：${caught.problem.detail}`;
    if (caught.problem.status === 403) return `目录绑定请求未被允许（403）：${caught.problem.detail}`;
  }
  return describeLiveError(caught).message;
}

/**
 * 归属失败按 HTTP 状态分类，而不是复用通用错误文案：
 * 409 是「当前事实不允许」（已归属/在途/已归档），404 是会话或项目不可见，
 * 403 是来源或权限被拒。三类都要如实说明，不能让用户以为归属成功或失败原因含糊。
 */
function describeBindingRejection(caught: unknown): string {
  if (caught instanceof RelayApiError) {
    if (caught.problem.status === 409) return `服务端拒绝归属（409）：${caught.problem.detail}`;
    if (caught.problem.status === 404) return `会话或项目在当前作用域不可见（404）：${caught.problem.detail}`;
    if (caught.problem.status === 403) return `归属请求未被允许（403）：${caught.problem.detail}`;
  }
  return describeLiveError(caught).message;
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
  const newConversationKey = search.get("new");
  /**
   * `?session=` 是**一次性深链接种子**，不是持续 Owner（与 `?new=` 同一类）：
   * 左栏把工作区级会话列成可点入口，点了就要能回到那条讨论；而会话身份本身
   * 仍住在协作页状态里——写回 URL 会因 App 按 pathname+search 重挂载整条路由，
   * 连目录作用域与首条草稿一起丢掉。种子只在挂载时读一次。
   */
  const sessionSeed = search.get("session");
  const [sessionId, setSessionId] = useState<string | null | undefined>(() =>
    search.has("new") ? null : sessionSeed ?? undefined);
  const [sessionEntry, setSessionEntry] = useState<{ id: string; projectId: string | null; error: string | null } | null>(null);
  const [sessionEntryReload, setSessionEntryReload] = useState(0);
  // URL 只定位原会话；项目归属必须由服务端核对，不能把目录名或目标入口当成归属。
  useEffect(() => {
    if (workId !== null || sessionSeed === null || newConversationKey !== null) return;
    let current = true;
    void client.getAssistSession(sessionSeed, true).then((session) => {
      if (!current) return;
      if (session.id !== sessionSeed) throw new Error("会话读取结果与入口身份不匹配。");
      if (session.taskId !== null) { setSearch({ work: session.taskId, session: session.id }, { replace: true }); return; }
      setSessionEntry({ id: sessionSeed, projectId: session.projectId, error: null });
    }).catch((caught: unknown) => {
      if (current) setSessionEntry({ id: sessionSeed, projectId: null, error: describeLiveError(caught).message });
    });
    return () => { current = false; };
  }, [client, workId, sessionSeed, newConversationKey, sessionEntryReload]);
  // 首条消息的完整过程住在协作页：文件夹入口的 AssistView 会按会话切换重新挂载，
  // 命令身份、在途阶段、首条原文与解释结果都不能随它卸载。迟到响应与回执核对
  // 可能跨越同一次重挂载，因此 busy 与「已解释」也必须是同一份共享事实。
  const [firstMessage, setFirstMessage] = useState<FirstMessageProcess>({
    draft: "", pending: null, busy: false, interpreted: null, execution: null });
  const firstMessageRef = useRef(firstMessage); firstMessageRef.current = firstMessage;
  const firstMessageOwner = useMemo<FirstMessageOwner>(() => ({
    read: () => firstMessageRef.current,
    write: (next) => { firstMessageRef.current = next; setFirstMessage(next); },
  }), []);
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
  const [workbenchView, setWorkbenchView] = useState<"chat" | "task">("chat");
  const [inspectorOpen, setInspectorOpen] = useState(false);
  /**
   * 会话视图（未关联任务）的「工作详情」抽屉开关，默认关闭。
   * 与任务视图的 inspectorOpen（默认开）分开：新对话首屏要让位给欢迎与输入区，
   * 不能在进入时就用一个诚实空态盖住；任务视图既有体验也因此完全不变。
   */
  const [conversationInspectorOpen, setConversationInspectorOpen] = useState(false);
  const conversationInspectorToggleRef = useRef<HTMLButtonElement | null>(null);
  const [conversationInspectorTab, setConversationInspectorTab] = useState<WorkDetailsTab>("PROGRESS");
  const [selectedPreviewArtifact, setSelectedPreviewArtifact] = useState<{
    readonly artifact: RelayArtifact; readonly version: RelayArtifactVersionSummary
  } | null>(null);
  const previewFocusTarget = useRef<{ readonly taskId: string; readonly artifactId: string; readonly trigger: HTMLButtonElement } | null>(null);
  const inspectorToggleRef = useRef<HTMLButtonElement | null>(null);
  const [sidePanelRevealed, setSidePanelRevealed] = useState(false);
  const [layout, setLayout] = useState(readCollaborationLayoutPreferences);
  const [devToolsOpen, setDevToolsOpen] = useState(false);
  const [narrowSideOpen, setNarrowSideOpen] = useState(false);
  const [transition, setTransition] = useState<{ kind: "dirty" | "pending"; proceed: () => void; commandId: string | null } | null>(null);
  const [recoveries, setRecoveries] = useState<readonly RecoveryRecord[]>(() => readRecovery(client));
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [checkingId, setCheckingId] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // 文件夹作用域：目录是当前工作目录，不是新 Workspace。空目录时保持未打开状态。
  /**
   * 目标会话身份（工作台 §25、ADR-018）。住在这里而不是 URL：
   * App 按 pathname+search 给路由出口重新挂载，工作目录又是本页的组件状态，
   * 把身份写进查询串会连工作目录一起丢。默认普通档，既有行为不变。
   */
  const [conversationTarget, setConversationTarget] = useState<
    { mode: RelayConversationMode; assistantProfileId: string | null }>({ mode: "AGENT", assistantProfileId: null });
  const [folder, setFolder] = useState<RelayWorkingDirectory | null>(null);
  const folderRef = useRef(folder); folderRef.current = folder;
  const [boundDirectory, setBoundDirectory] = useState<{ sessionId: string; projectId: string | null; path: string | null } | null>(null);
  const sessionContextRequest = useRef(0);
  const [folderError, setFolderError] = useState<string | null>(null);
  const [folderBusy, setFolderBusy] = useState(false);
  // 归属成功后让目录作用域的会话面板按项目身份重读一次，续读同一条历史而不是留一个空会话。
  const [folderReloadKey, setFolderReloadKey] = useState(0);
  const [binding, setBinding] = useState<BindingNotice | null>(null);
  const [bindingChecking, setBindingChecking] = useState(false);
  // 0087：目录绑定是服务端事实，界面只呈现它的在途与结果，不自己推算「现在读哪个目录」。
  const [directoryNotice, setDirectoryNotice] = useState<DirectoryNotice | null>(null);
  const directoryGateRef = useRef<string | null>(null);
  const directoryRef = useRef<DirectoryNotice | null>(null);
  const [recents, setRecents] = useState<readonly RecentWorkingDirectory[]>(() => readRecentWorkingDirectories());
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
  // 归属在 openFolder 的异步闭包里读取当前会话，不能只靠渲染时捕获的 state。
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  /**
   * AssistView **实际展示**的会话（含应用自动续上的那一条）。
   * 只做事实回报、接进 ref 而不是 state：接进 state 会改变 AssistView 的 key，
   * 换来一次多余的重挂载与重复读取。没有它，用户打开 /agent 自动续上最近讨论后
   * 再选目录时，协作页不知道当前会话，归属命令就发不出去。
   */
  const activeSessionRef = useRef<string | null | undefined>(undefined);
  const bindingRef = useRef<BindingNotice | null>(null);
  // 同步闸：同一会话的在途归属只允许一条，重复点击/重挂载不会发出第二条命令。
  const bindingGateRef = useRef<string | null>(null);

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
      discard: () => { navigationRef.current.discard?.(); navigationRef.current = cleanNavigation; },
      // 「保留并继续编辑」的焦点恢复交给编辑器登记的存活恢复目标（AssistView 上报）；
      // 恢复由 App 守卫弹层在关闭与默认回焦之后调用，这里只做转发。
      restoreFocus: () => { navigationRef.current.restoreFocus?.(); }
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
    setSelectedPreviewArtifact(null); previewFocusTarget.current = null; setSidePanelRevealed(false);
    setSessionId(newConversationKey !== null ? null : sessionSeed ?? undefined); setNarrowSideOpen(false);
    publishActiveConversation({ taskId: workId, sessionId: null });
    if (newConversationKey !== null) firstMessageOwner.write({
      draft: "", pending: null, busy: false, interpreted: null, execution: null });
    void reloadAll();
    return () => { taskRequest.current++; runRequest.current++; reviewRequest.current++; };
  }, [workId, newConversationKey, sessionSeed, reloadAll, firstMessageOwner]);

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

  // 会话恢复路径（无任务）：归属行不能停在「当前项目」占位——目录绑定的 projectId
  // 是服务端事实，项目标题沿它解析；任务路径由上一 effect 负责，这里不重复读。
  const sessionDirectoryProjectId = task?.projectId ? null : boundDirectory?.projectId ?? null;
  useEffect(() => {
    if (sessionDirectoryProjectId === null) { setProjectTitle(null); setProjectReadError(null); return; }
    let active = true;
    void client.getProject(sessionDirectoryProjectId).then((project) => {
      if (!active) return;
      if (project.id !== sessionDirectoryProjectId) return;
      setProjectTitle(project.title); setProjectReadError(null);
    }, (caught: unknown) => {
      if (!active) return;
      setProjectTitle(null); setProjectReadError(describeLiveError(caught).message);
    });
    return () => { active = false; };
  }, [client, sessionDirectoryProjectId]);

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
  const renderedLayoutMode: CollaborationLayoutMode = workbenchView === "chat" && !sidePanelRevealed
    ? "chat" : workbenchView === "chat" && sidePanelRevealed && layout.mode !== "result" ? "split" : layout.mode;
  function revealSidePanel(tab: "DOCUMENT" | "CHECK" | "HISTORY" = "DOCUMENT") {
    setSidePanelRevealed(workbenchView === "chat");
    if (workbenchView === "chat") setInspectorOpen(false);
    setSideTab(tab);
    setNarrowSideOpen(true);
  }
  function focusPreviewReturnTarget() {
    const target = previewFocusTarget.current;
    if (target?.trigger.isConnected && target.trigger.closest("[hidden]") === null) {
      target.trigger.focus();
      return;
    }
    if (target?.taskId === workIdRef.current) {
      document.getElementById(`collab-inspector-asset-${target.artifactId}`)?.focus();
    }
  }
  function selectArtifactVersion(artifact: RelayArtifact, version: RelayArtifactVersionSummary, trigger: HTMLButtonElement) {
    previewFocusTarget.current = { taskId: artifact.taskId, artifactId: artifact.id, trigger };
    setSelectedPreviewArtifact({ artifact, version });
    setSidePanelRevealed(false);
    setInspectorOpen(true);
  }
  function closeInspector() {
    setSelectedPreviewArtifact(null);
    setInspectorOpen(false);
    window.requestAnimationFrame(() => (workbenchView === "chat" ? conversationInspectorToggleRef : inspectorToggleRef).current?.focus());
  }
  function closeConversationInspector() {
    setConversationInspectorOpen(false);
    window.requestAnimationFrame(() => conversationInspectorToggleRef.current?.focus());
  }
  /**
   * 2026-10-17 点击验收整改 CT-01：工作详情在宽容器里是常驻分栏，在容器放不下时是覆盖抽屉。
   * 两种形态由 CollaborationView.css 的容器查询决定，这里不复制阈值——打开后读一次计算样式
   * （抽屉态的面板是 position:absolute）再决定行为：
   * · 抽屉：遮罩挡住其余内容，焦点送进面板，Esc 与点按遮罩都能收起，收起后回触发键；
   * · 分栏：常驻内容、非模态，不抢焦点，Esc 仍留给输入器与资料面板。
   */
  const inspectorPanelTestId = task === null ? "collab-conversation-inspector" : "collab-inspector";
  const inspectorOpenForView = task === null ? conversationInspectorOpen : inspectorOpen;
  const closeOpenInspectorRef = useRef<() => void>(closeInspector);
  closeOpenInspectorRef.current = task === null ? closeConversationInspector : closeInspector;
  const drawerFocusHandled = useRef<string | null>(null);
  useEffect(() => {
    if (!inspectorOpenForView) { drawerFocusHandled.current = null; return; }
    const frame = window.requestAnimationFrame(() => {
      const panel = document.querySelector<HTMLElement>(`[data-testid="${inspectorPanelTestId}"]`);
      if (panel === null || getComputedStyle(panel).position !== "absolute") return;
      // 同一层内容换版本（预览内切 v1/v2）不动焦点：用户刚点的是面板里的版本键。
      const layer = `${inspectorPanelTestId}:${selectedPreviewArtifact?.artifact.id ?? "details"}`;
      if (drawerFocusHandled.current === layer) return;
      drawerFocusHandled.current = layer;
      panel.querySelector<HTMLElement>(".inspector-close")?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [inspectorOpenForView, inspectorPanelTestId, selectedPreviewArtifact]);
  useEffect(() => {
    if (!inspectorOpenForView) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
      // 顶层弹窗（AppDialog）自己消费 Esc：抽屉不抢弹窗的关闭权。
      if (document.querySelector('[role="dialog"][aria-modal="true"]') !== null) return;
      const panel = document.querySelector<HTMLElement>(`[data-testid="${inspectorPanelTestId}"]`);
      // 分栏是常驻内容：没有遮挡要撤，Esc 不是它的关闭路径。
      if (panel === null || getComputedStyle(panel).position !== "absolute") return;
      event.preventDefault();
      // 预览是抽屉里的第二层：Esc 先退回工作详情，再按一次才收起整个抽屉。
      if (task !== null && selectedPreviewArtifact !== null) {
        setSelectedPreviewArtifact(null);
        window.requestAnimationFrame(focusPreviewReturnTarget);
        return;
      }
      closeOpenInspectorRef.current();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [inspectorOpenForView, inspectorPanelTestId, selectedPreviewArtifact, task]);
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
      onClick={() => revealSidePanel("CHECK")}>查看运行与检查详情 →</button> }
  ];
  // 验收目标属于任务说明：按选定稿收进按需展开区，不再占首屏一行。两种页头分支都渲染它，
  // 因此「展开不推高页头」的同时不会因为 Run 需要介入而让它从页面消失。
  const taskObjective = task?.acceptance.objective
    ? <p className="collab-task-objective" data-testid="collab-task-objective">
      <span className="collab-task-objective-label">验收目标</span>{task.acceptance.objective}</p>
    : null;

  // 委托面板按选定稿收进「更多操作」；准入判定仍只有一份，禁用原因留在页头常驻。
  const delegateTarget: DelegateTarget | null = task !== null && task.executorRunId === null && task.projectId !== null
    ? { id: task.id, projectId: task.projectId, status: task.status, executor: task.executor,
        revision: task.revision, executorRunId: null, allowedActions: task.allowedActions }
    : null;
  const folderProjectId = folder?.status === "READY" ? folder.association?.projectId ?? null : null;
  /**
   * 目录打开成功 ≠ 会话绑定成功：归属未确认（在途/结果未知/被拒）时，这段讨论
   * 仍是未归属会话，保持工作区级视图按原会话身份读取，历史、消息身份与草稿
   * 原地保留，不因目录已打开就切到项目作用域把原历史藏掉；只有归属确认后
   * 才切项目作用域重读同一条历史。
   */
  const bindingUnconfirmed = binding !== null && binding.status !== "CONFIRMED";
  const entryPending = sessionSeed !== null && newConversationKey === null && sessionEntry?.id !== sessionSeed;
  const entryError = sessionEntry !== null && sessionEntry.id === sessionSeed ? sessionEntry.error : null;
  const entryProjectId = sessionEntry !== null && sessionEntry.id === sessionSeed && entryError === null ? sessionEntry.projectId : null;
  const conversationProjectId = entryProjectId ?? boundDirectory?.projectId ?? folderProjectId ?? search.get("project");
  const projectScopeActive = conversationProjectId !== null && !bindingUnconfirmed;
  function startFolderConversation() {
    requestTransition(() => { setSessionId(null); setSearch({ new: createCommandId() }); });
  }
  // 真实任务建立后把工作台切到那个 Task：执行摘要、Run 控制与判断入口仍是原来的 Owner。
  function openExecutionTask(taskId: string) {
    requestTransition(() => { setFolder(null); setSearch({ work: taskId }); });
  }
  function requestTransition(proceed: () => void) {
    const state = navigationRef.current;
    const guard = currentDraftGuard();
    const commandId = guard?.pendingCommandId?.() ?? state.pending?.commandId ?? null;
    if (commandId) setTransition({ kind: "pending", proceed, commandId });
    else if (guard?.hasUnsavedChanges() || state.dirty) setTransition({ kind: "dirty", proceed, commandId: null });
    else proceed();
  }

  /**
   * 输入区上方的常驻槽位（协作页 §3.2/§3.3）：文件夹作用域细条 + 归属回执。
   *
   * 两者讲的都是「发送前」的前提，因此挂在输入卡正上方，而不是消息区顶部——
   * 目录是执行准入的前提，不是发送选项；离发送动作越近，告警才越可执行。
   * 归属回执紧贴细条下方、不折叠：在途、结果未知与服务端拒绝都必须能直接看见，
   * 否则用户会以为讨论已随目录一起归入项目。
   * 目录写命令、草稿守卫与归属命令仍只有本页一个 Owner，细条只做呈现与转发。
   */
  const folderAssociationLabel = folder === null || folder.association === null ? (boundDirectory?.projectId || task?.projectId ? `已归入项目：${projectTitle ?? "当前项目"}` : "未归属")
    : `已归入项目：${folder.association.projectTitle}${folder.createdProject ? "（本次新建的最小项目）" : ""}`;
  // 告警优先报更具体的那一条：目录没就绪时不再叠一句「先选目录」，两句话讲的是同一件事。
  const folderScopeWarning = folder !== null && folder.status === "NOT_READY"
    ? `目录尚未就绪：${folder.reason ?? "UNKNOWN"}。仍可普通讨论，但不能对项目文件执行写操作。`
    : !projectScopeActive && task?.projectId == null
      ? "这段讨论还没有归入项目，不能进入执行。先选目录并把它归入项目。"
      : null;
  const composerHeader = <>
    <FolderScopeBar directory={folder} boundDirectoryPath={boundDirectory?.path ?? null} recents={recents} busy={folderBusy} error={folderError}
      associationLabel={folderAssociationLabel} warning={folderScopeWarning}
      onOpen={requestFolderTransition} onNewConversation={startFolderConversation} />
    {binding !== null && <section className="collab-binding" data-testid="collab-binding"
      data-status={binding.status} data-session={binding.sessionId}
      role={binding.status === "FAILED" || binding.status === "UNKNOWN" ? "alert" : "status"}>
      {binding.status === "PENDING" && <p className="helper-text">正在把这段讨论归入项目（原命令 {binding.commandId}）…</p>}
      {binding.status === "CONFIRMED" && <p className="helper-text">这段讨论已归入项目；原会话、历史与原消息身份都保留。</p>}
      {binding.status === "UNKNOWN" && <>
        <p className="action-error">{binding.error} 原命令 {binding.commandId} 待核对，不会换 ID 重试；期间原讨论与历史保持可读。</p>
        <div className="form-actions"><button className="secondary-button" type="button"
          data-testid="collab-binding-receipt" disabled={bindingChecking}
          onClick={() => void checkBindingReceipt()}>{bindingChecking ? "正在查询" : "查询原命令回执"}</button></div>
      </>}
      {binding.status === "FAILED" && <p className="action-error">{binding.error} 讨论原文与历史保留，未归入项目；可重新选择目录再归属，或继续这段无归属讨论。</p>}
    </section>}
    {directoryNotice !== null && <section className="collab-binding" data-testid="collab-directory-binding"
      data-status={directoryNotice.status} data-session={directoryNotice.sessionId}
      data-resource={directoryNotice.resourceId}
      role={directoryNotice.status === "FAILED" || directoryNotice.status === "UNKNOWN" ? "alert" : "status"}>
      {directoryNotice.status === "PENDING" &&
        <p className="helper-text">正在把这段讨论绑定到目录 {directoryNotice.displayName}（原命令 {directoryNotice.commandId}）…</p>}
      {directoryNotice.status === "CONFIRMED" &&
        <p className="helper-text">这段讨论当前的工作目录是 {directoryNotice.displayName}；目录只提供作用域，不授予写权限。</p>}
      {directoryNotice.status === "UNKNOWN" &&
        <p className="action-error">{directoryNotice.error} 原命令 {directoryNotice.commandId} 待核对，不会换 ID 重试；核对期间读取按未绑定目录处理。</p>}
      {directoryNotice.status === "FAILED" &&
        <p className="action-error">{directoryNotice.error} 对话仍可继续；这一轮如需读取文件会明确说明缺的是目录。</p>}
    </section>}
  </>;

  const writeBinding = useCallback((next: BindingNotice | null) => {
    bindingRef.current = next; setBinding(next);
  }, []);
  /**
   * AssistView 的事实回报入口：只写 ref，不触发渲染，也不改变会话 key。
   * 同时把「当前正在看哪条会话」发布给左栏——左栏与协作页在组件树上是并列的，
   * 没有父子通道；发布的是本页已经收到的同一份事实，不是第二套业务状态。
   */
  const reportActiveSession = useCallback((id: string | null) => {
    const previous = activeSessionRef.current;
    const version = ++sessionContextRequest.current;
    activeSessionRef.current = id;
    publishActiveConversation({ taskId: workIdRef.current, sessionId: id });
    // 同一项目内的新会话仍保留用户选定的目录；全局新对话由路由重新挂载清空。
    if (id === null) return;
    // 换会话先清除旧目录展示，但保留导航所属项目，避免退回工作区空会话并卸载原 Owner。
    setBoundDirectory((current) => ({ sessionId: id,
      projectId: current?.projectId ?? folderRef.current?.association?.projectId ?? null, path: null }));
    if (previous !== null && previous !== id) setFolder(null);
    void client.getAssistSession(id, true).then((session) => {
      if (activeSessionRef.current !== id || version !== sessionContextRequest.current) return;
      setBoundDirectory({ sessionId: id, projectId: session.projectId,
        path: session.context?.workingDirectory?.canonicalRoot ?? null });
    }).catch((caught: unknown) => {
      if (activeSessionRef.current === id && version === sessionContextRequest.current) setFolderError(describeLiveError(caught).message);
    });
  }, [client]);
  // 离开协作页时清掉高亮，避免左栏停在一条已经不在看的会话上。
  useEffect(() => () => { activeSessionRef.current = null; sessionContextRequest.current++; clearActiveConversation(); }, []);

  /**
   * 把一段尚未归属的既有讨论归入项目。
   *
   * 归属是服务端事实：先按真实身份读回该会话确认它确实还没归属，才发起绑定命令；
   * 回执只改 project_id，不产生执行、权限或提案。闸按会话身份加锁，重复点击与
   * 重挂载都不会发出第二条命令；结果未知时保留原 command_id 等核对，不换 ID 重试；
   * 迟到响应只写它原本那次绑定，绝不改当前会话或当前项目。
   */
  async function bindSessionToProject(targetSessionId: string, targetProjectId: string) {
    if (bindingGateRef.current !== null) return;
    bindingGateRef.current = targetSessionId;
    const commandId = createCommandId();
    writeBinding({ sessionId: targetSessionId, projectId: targetProjectId, commandId, status: "PENDING", error: null });
    try {
      const existing = await client.getAssistSession(targetSessionId);
      if (bindingGateRef.current !== targetSessionId) return;
      if (existing.id !== targetSessionId) throw new Error("会话读取结果与原会话不匹配。");
      if (existing.projectId !== null) {
        // 已归属的会话不重复绑定，也不改写归属：同一项目就当作已接续，别的项目就保持原样。
        bindingGateRef.current = null;
        if (existing.projectId === targetProjectId) {
          writeBinding({ sessionId: targetSessionId, projectId: targetProjectId, commandId, status: "CONFIRMED", error: null });
          setSessionId(targetSessionId);
          setFolderReloadKey((value) => value + 1);
        } else writeBinding(null);
        return;
      }
      const result = await client.bindAssistSessionProject({ sessionId: targetSessionId, commandId, projectId: targetProjectId });
      if (bindingGateRef.current !== targetSessionId || bindingRef.current?.commandId !== commandId) return;
      bindingGateRef.current = null;
      writeBinding({ sessionId: result.sessionId, projectId: result.projectId, commandId, status: "CONFIRMED", error: null });
      setSessionId(result.sessionId);
      setFolderReloadKey((value) => value + 1);
    } catch (caught) {
      if (bindingGateRef.current !== targetSessionId || bindingRef.current?.commandId !== commandId) return;
      const described = describeLiveError(caught);
      if (described.kind === "transport") {
        // 结果未知：保留原命令身份，闸继续锁住该会话，等按原 command_id 核对。
        writeBinding({ sessionId: targetSessionId, projectId: targetProjectId, commandId, status: "UNKNOWN",
          error: "归属命令结果未知：请按原 command_id 查询回执，不要换 ID 重试。" });
        return;
      }
      bindingGateRef.current = null;
      writeBinding({ sessionId: targetSessionId, projectId: targetProjectId, commandId, status: "FAILED",
        error: describeBindingRejection(caught) });
    }
  }

  /** 归属回执核对：只按原 command_id 查询，不换 ID、不改载荷、不猜结果。 */
  async function checkBindingReceipt() {
    const record = bindingRef.current;
    if (record === null || record.status !== "UNKNOWN" || bindingChecking) return;
    setBindingChecking(true);
    try {
      const receipt = await client.getCommandReceipt(record.commandId);
      if (bindingRef.current?.commandId !== record.commandId) return;
      const result = receipt.result as { session_id?: unknown; project_id?: unknown };
      if (receipt.commandId !== record.commandId || receipt.commandType !== "BindAssistSessionProject" ||
        result.session_id !== record.sessionId || result.project_id !== record.projectId) {
        throw new Error("归属回执与原命令不匹配。");
      }
      bindingGateRef.current = null;
      writeBinding({ ...record, status: "CONFIRMED", error: null });
      setSessionId(record.sessionId);
      setFolderReloadKey((value) => value + 1);
    } catch (caught) {
      if (bindingRef.current?.commandId !== record.commandId) return;
      writeBinding({ ...record, error: `${describeLiveError(caught).message} 原归属命令未换新 ID，不能另发命令重试。` });
    } finally { setBindingChecking(false); }
  }

  /**
   * 把当前会话绑定到这个受管目录（0087 / 运行架构 §2.7.1）。
   *
   * 这一步把「这次读哪个目录」变成**服务端事实**：普通 Agent 的读取动作只按会话行上的
   * 绑定解析目标，界面里那份目录状态刷新后就丢，不能作为来源。
   *
   * 接续规则与归属同形但独立记账：闸按会话身份加锁，重复点击与重挂载不会发出第二条命令；
   * 结果未知时保留原 command_id 等核对，不换 ID 重试；迟到响应只写它原本那次绑定，
   * 绝不改当前会话或当前目录。绑定是**作用域**，不授予任何权限——因此失败也不阻断对话。
   */
  async function bindSessionDirectory(targetSessionId: string, resourceId: string,
    displayName: string) {
    if (directoryGateRef.current !== null) return;
    directoryGateRef.current = targetSessionId;
    const commandId = createCommandId();
    const pending: DirectoryNotice = { sessionId: targetSessionId, resourceId, displayName,
      commandId, status: "PENDING", error: null };
    directoryRef.current = pending; setDirectoryNotice(pending);
    try {
      const existing = await client.getAssistSession(targetSessionId);
      if (directoryGateRef.current !== targetSessionId) return;
      if (existing.id !== targetSessionId) throw new Error("会话读取结果与原会话不匹配。");
      if (existing.workingResourceId === resourceId) {
        // 已经绑到这个目录：不重复发命令，也不把一次没有必要的写入说成「已绑定」。
        directoryGateRef.current = null;
        directoryRef.current = null; setDirectoryNotice(null);
        return;
      }
      const result = await client.bindAssistSessionDirectory({ sessionId: targetSessionId,
        commandId, resourceId });
      if (directoryGateRef.current !== targetSessionId ||
          directoryRef.current?.commandId !== commandId) return;
      directoryGateRef.current = null;
      const confirmed: DirectoryNotice = { sessionId: result.sessionId, resourceId,
        displayName, commandId, status: "CONFIRMED", error: null };
      directoryRef.current = confirmed; setDirectoryNotice(confirmed);
    } catch (caught) {
      if (directoryGateRef.current !== targetSessionId ||
          directoryRef.current?.commandId !== commandId) return;
      const described = describeLiveError(caught);
      directoryGateRef.current = null;
      const failed: DirectoryNotice = { sessionId: targetSessionId, resourceId, displayName,
        commandId, status: described.kind === "transport" ? "UNKNOWN" : "FAILED",
        error: described.kind === "transport"
          ? "目录绑定结果未知：请按原 command_id 查询回执，不要换 ID 重试。"
          : describeDirectoryRejection(caught) };
      directoryRef.current = failed; setDirectoryNotice(failed);
    }
  }

  async function openFolder(rootPath: string, projectId?: string | null) {
    setFolderBusy(true); setFolderError(null);
    let directory: RelayWorkingDirectory;
    try {
      directory = await client.openWorkingDirectory({ commandId: createCommandId(), rootPath,
        ...(projectId === undefined ? {} : { projectId }) });
    } catch (caught) {
      setFolderError(describeLiveError(caught).message); setFolderBusy(false); return;
    }
    setFolder(directory);
    setRecents((current) => rememberOpened(directory, current));
    // 目录已归入项目且当前存在一段尚未归属的既有讨论时，把它接续到该项目：
    // 只改归属、不新建第二个会话，也不产生任何执行或权限。绑定随目录命令一起
    // 走同一条 requestTransition 守卫，未保存草稿与未决命令会先被拦下；
    // 归属有自己的在途/未知/失败呈现，因此不把目录打开卡在归属完成上。
    setFolderBusy(false);
    const boundProjectId = directory.status === "READY" ? directory.association?.projectId ?? null : null;
    const pendingSessionId = activeSessionRef.current ?? sessionIdRef.current;
    if (boundProjectId !== null && pendingSessionId != null) {
      if (workIdRef.current === null) await bindSessionToProject(pendingSessionId, boundProjectId);
    }
    // 0087：目录就绪后把这条目录绑到当前会话。绑定是作用域不是准入，失败只如实呈现，
    // 不阻断对话——服务端会按「未绑定目录」以类型化原因拒掉读取，而不是假装有权限。
    const boundResourceId = directory.status === "READY"
      ? directory.association?.resourceId ?? null : null;
    const afterBinding = activeSessionRef.current ?? sessionIdRef.current;
    if (boundResourceId !== null && afterBinding != null) {
      await bindSessionDirectory(afterBinding, boundResourceId, directory.displayName);
    }
  }

  /**
   * 换目录与选会话、切任务共用同一条守卫：未发送草稿要先明确保留或放弃，
   * 未决消息在核对前不得换目录。守卫必须先于 OpenWorkingDirectory，
   * 不能先登记新作用域再询问，也不能由「仅选择或取消」吞掉原文。
   */
  function requestFolderTransition(rootPath: string, projectId?: string | null) {
    requestTransition(() => { void openFolder(rootPath, projectId); });
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

  // 会话视图顶栏右区与「工作详情」抽屉（均只在 task===null 时出现）。
  const conversationInspectorVisible = task === null ? conversationInspectorOpen : inspectorOpen;
  const conversationInspectorLabel = inspectorToggleLabel(conversationInspectorVisible);
  const conversationToolbarRight = <>{task !== null && <button type="button"
    className="secondary-button secondary-button--compact collab-toolbar-icon-button"
    data-testid="collab-open-task-view" title="任务视图" aria-label="任务视图"
    onClick={() => setWorkbenchView("task")}><LayoutGrid size={18} aria-hidden="true" /></button>}<button type="button"
    className={`secondary-button secondary-button--compact collab-inspector-toggle-btn collab-toolbar-icon-button${conversationInspectorVisible ? " active" : ""}`}
    data-testid="collab-conversation-inspector-toggle" ref={conversationInspectorToggleRef}
    title={conversationInspectorLabel} aria-label={conversationInspectorLabel}
    aria-expanded={conversationInspectorVisible} aria-controls={task === null ? "collab-conversation-inspector" : `collab-inspector-${task.id}`}
    onClick={() => { if (task === null) setConversationInspectorOpen((open) => !open); else setInspectorOpen((open) => !open); }}>
    {conversationInspectorVisible ? <PanelRightClose size={18} aria-hidden="true" /> : <PanelRightOpen size={18} aria-hidden="true" />}
  </button></>;
  /**
   * 输入框「+」里的「选择工作文件夹」不新建选择器：它把用户带回常驻的目录细条，
   * 并直接触发细条自带的「更换目录」弹层（同一个 Owner）。细条在忙时按钮禁用，
   * 退回到把细条滚入视野并聚焦，让用户自己决定何时点开，绝不绕过禁用态。
   */
  const requestFocusFolder = useCallback(() => {
    const strip = document.querySelector<HTMLElement>('[data-testid="folder-scope-strip"]');
    strip?.scrollIntoView({ block: "center" });
    const change = document.querySelector<HTMLButtonElement>('[data-testid="folder-scope-change"]');
    if (change !== null && !change.disabled) change.click();
  }, []);
  const conversationInspector = <WorkDetailsFrame className="task-inspector" id="collab-conversation-inspector"
    testId="collab-conversation-inspector" tab={conversationInspectorTab} onTabChange={setConversationInspectorTab}
    onClose={closeConversationInspector}>
      {conversationInspectorTab === "PROGRESS" && <>
        <p className="inspector-overline">当前工作</p>
        <h3 className="inspector-title">暂无关联任务</h3>
        <p className="inspector-sub">这是一段独立讨论，尚未关联任务，也没有正在执行的运行。</p>
        <p className="inspector-note">进展、成果与执行记录会在创建任务并开始执行后出现在这里。读取目录与文件只需绑定目录并通过读取权限检查，无需创建任务或 Run。</p>
      </>}
      {conversationInspectorTab === "RESULTS" && <>
        <p className="inspector-overline">工作成果</p>
        <h3 className="inspector-title">已保存的成果版本</h3>
        <p className="inspector-sub">请选择已保存的成果，阅读对应的确切版本正文。</p>
        <p className="inspector-note">当前讨论没有已保存的成果版本。</p>
      </>}
      {conversationInspectorTab === "RECORDS" && <>
        <p className="inspector-overline">运行记录</p>
        <h3 className="inspector-title">执行与验证依据</h3>
        <p className="inspector-sub">步骤状态、失败原因与运行身份集中在这里。</p>
        <p className="inspector-note">当前讨论没有任务运行记录。会话中的目录与文件读取结果仍以原消息的实际工具回执为准。</p>
      </>}
  </WorkDetailsFrame>;

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


{task !== null && <header hidden={workbenchView === "chat"} className="collab-goal" data-testid="collab-goal">
        <div className="collab-breadcrumbs">
          <span>工作台</span>
          <ChevronRight size={12} aria-hidden="true" />
          <strong>{projectTitle ?? (task.projectId === null ? "无项目" : "项目")}</strong>
          <ChevronRight size={12} aria-hidden="true" />
          <span>{task.title}</span>
        </div>
        <PageHeader title={task.title} testId="collab-page-head" titleHref={`/tasks/${task.id}`}
          status={<span className="status-chip">{taskStatusLabels[task.status] ?? task.status}</span>}
          actions={<>
            {reviews.length > 0 && <button className="secondary-button secondary-button--compact" type="button" data-testid="collab-open-judgment"
              onClick={() => {
                setDevToolsOpen(false); revealSidePanel("DOCUMENT");
                window.requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-testid="collab-judgment"]')?.focus());
              }}>查看待处理 {reviews.length}</button>}
            <button
              type="button"
              className={`secondary-button secondary-button--compact collab-inspector-toggle-btn ${inspectorOpen ? "active" : ""}`}
              data-testid="collab-inspector-toggle"
              ref={inspectorToggleRef}
              title={inspectorToggleLabel(inspectorOpen)}
              aria-label={inspectorToggleLabel(inspectorOpen)}
              aria-expanded={inspectorOpen}
              aria-controls={`collab-inspector-${task.id}`}
              onClick={() => {
                if (!inspectorOpen) setSidePanelRevealed(false);
                setInspectorOpen((open) => !open);
              }}
            >
              {inspectorOpen ? <PanelRightClose size={18} aria-hidden="true" /> : <PanelRightOpen size={18} aria-hidden="true" />}
            </button>
          </>}
          more={<>
            {delegateTarget !== null && <TaskDelegatePanel compact client={client} task={delegateTarget}
              projectWriteBlockedReason={projectWriteBlockedReason} onDelegated={refreshFacts} />}
            <div className="collab-layout-modes" role="group" aria-label="协作工作区布局">
              {([["split", "双栏"], ["chat", "对话"], ["result", "成果"]] as const).map(([mode, label]) =>
                <button key={mode} className="secondary-button" type="button" data-testid={`collab-layout-${mode}`}
                aria-pressed={layout.mode === mode} onClick={() => {
                  setSidePanelRevealed(workbenchView === "chat" && mode !== "chat");
                  if (workbenchView === "chat" && mode !== "chat") setInspectorOpen(false);
                  setLayoutMode(mode);
                }}>{label}</button>)}
            </div>
            {/* Run 控制只有一个 Owner：需要人工介入时移进页头常驻，否则留在这个默认收起的展开区。 */}
            {!runNeedsAttention && <details className="collab-facts-disclosure">
              <summary>任务与执行详情</summary>
              {taskObjective}
              {runControl}
              <FactBar label="任务与执行事实" testId="collab-facts" cells={factCells} />
              <p className="helper-text">控制提交回执表示 PENDING；等待安全点期间，Run 与任务执行者仍以重新查询的事实为准。</p>
            </details>}
            {task.projectId !== null && <button className="secondary-button secondary-button--compact collab-tools-toggle" type="button"
              data-testid="collab-devtools-toggle" aria-expanded={devToolsOpen}
              onClick={() => {
                setDevToolsOpen((open) => !open);
                if (!devToolsOpen) revealSidePanel(sideTab);
              }}>
              {devToolsOpen ? "收起工具面板" : "文件与运行工具"}</button>}
            <ModelConnectionStrip client={client} compact />
          </>}
        >
          <p className="collab-current-need" data-testid="collab-current-need">
            {/* 项目归属与「当前需要什么」同行，不再单独占一行 meta。 */}
            <span>项目：{projectTitle ?? (task.projectId === null ? "无项目" : "项目标题暂不可读取")}</span>
            <span aria-hidden="true"> · </span>
            {run?.unresolvedOperationIds.length ? `${run.unresolvedOperationIds.length} 项外部动作结果待核对；沿原 operation_id 核对，不盲重试。`
              : run?.pendingControlRequest ? "已提交控制请求，等待安全点；请求受理不代表已停止或交接。"
              : reviews.length > 0 ? `${reviews.length} 项等待人工判断；等待判断不等于已暂停。`
              : run === null ? `当前执行者：${executorLabels[task.executor]}` : runLabels[run.status] ?? run.status}
            {currentStep && <> · 当前步骤：{stepLabels[currentStep.kind] ?? currentStep.kind}</>}
            {waitReason && <> · 等待原因：{waitReason}</>}
          </p>
          <div className="collab-views-line">
            <div className="collab-viewtabs" role="tablist" aria-label="工作台双视图">
              <button
                type="button"
                role="tab"
                className={`collab-viewtab ${workbenchView === "chat" ? "active" : ""}`}
                data-testid="collab-viewtab-chat"
                aria-selected={workbenchView === "chat"}
                onClick={() => { setWorkbenchView("chat"); setSidePanelRevealed(false); setInspectorOpen(true); }}
              >
                <MessageSquare size={14} aria-hidden="true" />
                <span>聊天视图</span>
              </button>
              <button
                type="button"
                role="tab"
                className={`collab-viewtab ${workbenchView === "task" ? "active" : ""}`}
                data-testid="collab-viewtab-task"
                aria-selected={workbenchView === "task"}
                onClick={() => { setWorkbenchView("task"); setSidePanelRevealed(false); }}
              >
                <LayoutGrid size={14} aria-hidden="true" />
                <span>任务视图</span>
              </button>
            </div>
          </div>
          {/* UNKNOWN、控制请求与失败原因不折叠：这三类一旦收进「更多操作」就不再可发现。
              事实条同步移出展开区，否则「无法确认的执行结果」只剩展开后才可见。 */}
          {runNeedsAttention && <div className="collab-run-controls" data-testid="collab-run-disclosure">
            {taskObjective}
            {runControl}
            <FactBar label="任务与执行事实" testId="collab-facts" cells={factCells} /></div>}
        </PageHeader>
      </header>}
      {task !== null && workbenchView === "chat" && runNeedsAttention && <div className="collab-run-controls">
        {runControl}<FactBar label="任务与执行事实" testId="collab-chat-facts" cells={factCells} />
      </div>}
      {task !== null && <div className="collab-notices">
        {loading && <p className="helper-text" role="status">正在更新任务事实，已显示的内容保持可见。</p>}
        {error && <p className="action-error" role="alert" data-testid="collab-task-error">{error} 任务事实尚未重新核对，不能提交新的判断或任务命令。</p>}
        {runError && <p className="action-error" role="alert" data-testid="collab-run-error">{runError} 已保存的产物与判断仍可继续阅读。</p>}
        {projectWriteBlockedReason && <p className="disabled-reason" data-testid="collab-project-archive-reason">{projectWriteBlockedReason}</p>}
      </div>}

      {task !== null && <div className="collab-narrow-tabs" aria-label="工作区视图" hidden={renderedLayoutMode !== "split"}>
        <button type="button" className={`collab-side-tab${!narrowSideOpen ? " collab-side-tab--active" : ""}`}
          data-testid="collab-narrow-DISCUSSION" aria-pressed={!narrowSideOpen} onClick={() => {
            setNarrowSideOpen(false);
            if (workbenchView === "chat" && sidePanelRevealed) { setSidePanelRevealed(false); setInspectorOpen(true); }
          }}>讨论</button>
        <button type="button" className={`collab-side-tab${narrowSideOpen ? " collab-side-tab--active" : ""}`}
          data-testid="collab-narrow-DOCUMENT" aria-pressed={narrowSideOpen} onClick={() => revealSidePanel("DOCUMENT")}>成果与判断</button>
      </div>}

      <div className={`collab-columns${task === null ? " collab-columns--empty" : ""}`} data-pane={sideTab}
        data-layout-mode={task === null ? "chat" : renderedLayoutMode} data-narrow-side={narrowSideOpen ? "open" : "closed"}
        style={{ "--relay-collab-chat-column": `${layout.chatRatio}fr`, "--relay-collab-result-column": `${1 - layout.chatRatio}fr` } as CSSProperties}>
{task === null
          ? <>
          <section className="collab-center" aria-label="工作主区" data-testid="collab-center">
              {/* 顶部两个 details 大块（选择文件夹、接续已有任务）已删除：它们压在首屏最显眼处，
                  展开体量大、折叠后又只剩一行摘要。功能全部保留并换位——文件夹作用域收成输入卡
                  上方的常驻细条（composerHeader），「接续已有任务」迁到左栏就地展开区。 */}
              {/* 归属未确认时继续用工作区级会话面板：原历史与消息身份留在原地，
                  讨论输入不受限，依赖归属的执行入口由细条告警与空 executionScope 关闭。 */}
              {entryPending ? <p className="helper-text" role="status">正在核对原会话归属…</p>
                : entryError ? <div role="alert" className="page-state page-state--error" data-testid="collab-session-entry-error">
                  <p>会话暂不可读取：{entryError}</p><button type="button" className="secondary-button" onClick={() => {
                    setSessionEntry(null); setSessionEntryReload((value) => value + 1);
                  }}>重新读取</button>
                </div> : !projectScopeActive
                ? <AssistView key={`unassigned:${newConversationKey ?? ""}:${sessionId === undefined ? "auto" : sessionId}`}
                  workspaceLevel deferSessionCreation
                  preferredSessionId={sessionId} standalone
                  composerHeader={composerHeader}
                  onNavigationStateChange={reportNavigation}
                  onRequestNewSession={requestTransition}
                  onRequestSessionChange={requestTransition} onSessionSelected={setSessionId}
                  onSessionCreated={(created) => setSessionId(created)}
                  onActiveSessionChange={reportActiveSession}
                  firstMessageOwner={firstMessageOwner} firstMessageProcess={firstMessage}
                  conversationTarget={conversationTarget} onConversationTargetChange={setConversationTarget}
                  conversationToolbar toolbarRight={conversationToolbarRight}
                  onRequestFolder={requestFocusFolder} recentFolders={recents}
                  onOpenRecentFolder={(canonicalRoot) => requestFolderTransition(canonicalRoot)} />
                : <AssistView key={`folder:${conversationProjectId}:${folderReloadKey}:${newConversationKey ?? ""}:${sessionId === undefined ? "auto" : sessionId}`}
                  targetKind="PROJECT" targetId={conversationProjectId ?? undefined}
                  preferredSessionId={sessionId} standalone deferSessionCreation
                  executionScope={folderProjectId === conversationProjectId ? folder : null}
                  composerHeader={composerHeader}
                  onNavigationStateChange={reportNavigation}
                  onRequestNewSession={requestTransition}
                  onRequestSessionChange={requestTransition} onSessionSelected={setSessionId}
                  onSessionCreated={(created) => setSessionId(created)}
                  onActiveSessionChange={reportActiveSession}
                  onExecutionPrepared={(taskId) => void openExecutionTask(taskId)}
                  conversationTarget={conversationTarget} onConversationTargetChange={setConversationTarget}
                  firstMessageOwner={firstMessageOwner} firstMessageProcess={firstMessage}
                  conversationToolbar toolbarRight={conversationToolbarRight}
                  onRequestFolder={requestFocusFolder} recentFolders={recents}
                  onOpenRecentFolder={(canonicalRoot) => requestFolderTransition(canonicalRoot)} />}
            </section>
            {conversationInspectorOpen && <>
              {/* 抽屉遮罩：分栏态由 CSS 收成 display:none，不产生第二套关闭语义。 */}
              <div className="collab-inspector-scrim" data-testid="collab-conversation-inspector-scrim"
                aria-hidden="true" onMouseDown={closeConversationInspector} />
              {conversationInspector}
            </>}
          </>
          : <>
            <section className="collab-center" aria-label="工作主区" data-testid="collab-center" hidden={renderedLayoutMode === "result"}>
              <div className="collab-task-view-container" hidden={workbenchView !== "task"}>
                <TaskViewDashboard
                  client={client}
                  task={task}
                  run={run}
                  projectTitle={projectTitle}
                  reviews={reviews}
                  openReview={openReview}
                  reviewError={reviewError}
                  reviewWriteBlockedReason={reviewWriteBlockedReason}
                  projectWriteBlockedReason={projectWriteBlockedReason}
                  onReviewNavigationStateChange={reportReviewNavigation}
                  onRefresh={refreshFacts}
                  onSelectFileForPreview={selectArtifactVersion}
                  onSwitchToChat={() => setWorkbenchView("chat")}
                  onOpenInspector={() => setInspectorOpen(true)}
                />
              </div>
              <div className="collab-chat-view-container" hidden={workbenchView !== "chat"}>
                <AssistView key={`${task.id}:${sessionId === undefined ? "auto" : sessionId}`}
                  targetKind="TASK" targetId={task.id}
                  preferredSessionId={sessionId} standalone deferSessionCreation
                  firstMessageOwner={firstMessageOwner} firstMessageProcess={firstMessage}
                  composerHeader={composerHeader}
                  executionScope={folder?.association?.projectId === task.projectId ? folder : null}
                  onActiveSessionChange={reportActiveSession}
                  conversationToolbar toolbarRight={conversationToolbarRight} onRequestFolder={requestFocusFolder}
                  recentFolders={recents}
                  onOpenRecentFolder={(canonicalRoot) => requestFolderTransition(canonicalRoot)}
                  conversationTarget={conversationTarget} onConversationTargetChange={setConversationTarget}
                  externalWriteBlockedReason={projectWriteBlockedReason}
                  onNavigationStateChange={reportNavigation}
                  onRequestNewSession={requestTransition}
                  onRequestSessionChange={requestTransition} onSessionSelected={setSessionId}
                  onSessionCreated={(created) => setSessionId(created)} />
              </div>
            </section>

            <CollaborationSplitter ratio={layout.chatRatio} hidden={renderedLayoutMode !== "split"}
              onRatioChange={(chatRatio, commit) => setLayout((current) => {
                const next = { ...current, chatRatio };
                return commit ? saveCollaborationLayoutPreferences(next) : next;
              })} />
            <div className="collab-result-pane" hidden={renderedLayoutMode === "chat"}>
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

            {inspectorOpen && <>
              {/* 抽屉遮罩：分栏态由 CSS 收成 display:none；点按遮罩＝收起详情，与关闭键、Esc 同一条路径。 */}
              <div className="collab-inspector-scrim" data-testid="collab-inspector-scrim"
                aria-hidden="true" onMouseDown={closeInspector} />
              <TaskInspectorPanel
                key={task.id}
                client={client}
                task={task}
                run={run}
                projectTitle={projectTitle}
                folder={folder}
                workingDirectoryPath={boundDirectory?.path ?? null}
                mode={conversationTarget.mode}
                selectedArtifact={selectedPreviewArtifact?.artifact.taskId === task.id ? selectedPreviewArtifact : null}
                onSelectArtifactVersion={selectArtifactVersion}
                onSelectVersion={(version) => {
                  // 预览内换确切版本：沿用已登记的打开成果（任务必须还是那一条），返回焦点仍是原成果按钮。
                  const current = selectedPreviewArtifact;
                  if (current === null || current.artifact.taskId !== task.id) return;
                  setSelectedPreviewArtifact({ artifact: current.artifact, version });
                }}
                onCloseFilePreview={() => {
                  setSelectedPreviewArtifact(null);
                  window.requestAnimationFrame(focusPreviewReturnTarget);
                }}
                onClose={closeInspector}
                onSwitchToTask={() => setWorkbenchView("task")}
                isChatView={workbenchView === "chat"}
              />
            </>}
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
