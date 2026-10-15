import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { ArrowDown, ArrowUp, BookOpen, ChevronDown, Copy, FileText, MessageSquareText, RotateCcw } from "lucide-react";
import { createCommandId, RelayApiError, type RelayApiClient, type RelayAssistLivePreview,
  type RelayAssistMessage, type RelayAssistProposal,
  type RelayAssistSession, type RelayAssistSourceRef, type RelayAssistantProfile,
  type RelayCommandReceipt, type RelayConversationExecution, type RelayConversationMode,
  type RelaySkillDefinition, type RelaySkillInput, type RelayStateMaintenanceChange,
  type RelayStateMaintenanceRequest,
  type RelayTaskSkillProposal, type RelayUndoPlan,
  type RelayWorkingDirectory } from "../api/relayClient";
import AssistSkillOutput from "../components/AssistSkillOutput";
import ChatCommandInput from "../components/ChatCommandInput";
import PageHeader from "../components/PageHeader";
import AssistSourcePicker from "../components/AssistSourcePicker";
import ExecutionSummary from "../components/ExecutionSummary";
import ExecutionTrajectorySummary from "../components/ExecutionTrajectorySummary";
import SafeMarkdown from "../components/SafeMarkdown";
import LearningRecordsPanel, { learningRoundText } from "../components/LearningRecordsPanel";
import type { RelayLearningState } from "../api/resources/learning";
import TaskContractProposalPreview from "../components/TaskContractProposalPreview";
import { ConversationModeSwitch, type AssistantDraft } from "../components/ConversationModeSwitch";
import { describeLiveError } from "../lib/liveErrors";
import { modelErrorGuides } from "../lib/modelErrorGuides";
import { criterionMethodLabel, stateMaintenanceChangeKindLabel, stateMaintenanceChangeStatusLabel,
  stateMaintenanceStatusLabel } from "../lib/labels";
import { liveClient, useRelayConnection } from "../lib/relayConnection";
import { formatReadableDateTime, useDisplayPreferences } from "../lib/displayPreferences";
import { chatControlFromText } from "../lib/chatControls";
import { chatSessionResultFrom, type RelayChatSessionResult } from "../api/resources/chatControls";
import { RelayTransportError } from "../api/core/errors";
import "./AssistView.css";

type AssistTarget = { readonly kind: "PROJECT" | "TASK"; readonly id: string; readonly title: string;
  readonly revision: string; readonly projectId: string | null; readonly executor: string | null;
  readonly archivedAt: string | null | undefined };
type AssistIntent = "DISCUSS" | "PROPOSE_CANDIDATE" | "PROPOSE_TASK";
type PreviewReadError = { readonly message: string; readonly lastSuccessAt: string | null };
const intentLabels: Record<AssistIntent, string> = {
  DISCUSS: "发送讨论", PROPOSE_CANDIDATE: "请求文档候选", PROPOSE_TASK: "请求任务提案"
};
/** 任务定义提案载荷的中文显示：预期产物键、产物种类与目标类型。
 *  服务端枚举开放扩展，未知值回退原枚举展示，原值经 title/small 保留供核对。 */
const expectedOutputKeyLabels: Record<string, string> = {
  kind: "产物类型", description: "结果说明", artifacts: "产物清单"
};
const expectedOutputKindLabels: Record<string, string> = {
  MARKDOWN_DOCUMENT: "Markdown 文档"
};
const proposalTargetTypeLabels: Record<string, string> = {
  PROJECT: "项目", TASK: "任务"
};
function expectedOutputValueText(key: string, value: unknown): string {
  if (Array.isArray(value)) return value.map((item) => expectedOutputValueText(key, item)).join("、");
  // 产物种类枚举只按 kind 键映射；description 等自由文本原样展示。
  if (key === "kind" && typeof value === "string") return expectedOutputKindLabels[value] ?? value;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}
/** title 上的原始载荷值：标量原样，其余按 JSON 序列化，保证核对时能回到原始枚举。 */
function expectedOutputRawText(value: unknown): string {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value) : JSON.stringify(value);
}
function proposalTargetTypeText(targetType: string): ReactNode {
  const label = proposalTargetTypeLabels[targetType] ?? targetType;
  return <>{label}{label !== targetType && <small title={targetType}>（{targetType}）</small>}</>;
}
/** Esc Esc 两次按键的最大间隔。手势窗口不是动效时长，因此不用 motion.duration.*；与本文件既有的
    1500 消息轮询、400 预览轮询、32 滚动阈值一样是就地硬编码的交互常量。 */
const stopSequenceMs = 800;


const supportedSkillOutput: Readonly<Record<string, RelaySkillDefinition["outputKind"]>> = {
  "task-to-execution-contract": "TASK_DEFINITION_SUGGESTION",
  "project-resume": "PROJECT_RESUME",
  "verification-plan": "VERIFICATION_PLAN_SUGGESTION"
};
type PendingAction = { readonly kind: "send"; readonly commandId: string; readonly content: string;
  readonly intent: AssistIntent | null; readonly skillRef: { readonly id: string; readonly version: string } | null;
  readonly skillInput: RelaySkillInput | null; readonly sources: readonly RelayAssistSourceRef[];
  readonly recordLearning?: boolean } |
  { readonly kind: "restart"; readonly commandId: string; readonly content: string;
    readonly system: "clear" | "new" } |
  { readonly kind: "cancel" | "accept"; readonly commandId: string; readonly id: string } |
  { readonly kind: "acceptTask"; readonly commandId: string; readonly id: string;
    readonly taskId: string; readonly expectedTaskRevision: string;
    readonly expectedAcceptanceRevision: string; readonly payloadHash: string };
/**
 * 首条消息的未决命令：建会话与发消息是两个命令，各自保留原身份。
 * 这里保存首条消息那一条的命令身份、原始载荷与发送时绑定的确切目录资源，
 * 供响应丢失后按原 ID 核对或重试；不保存用户后来修改的输入，也不允许据此再建会话。
 *
 * resourceId 在命令产生时就固定下来：解释只能作用于这条消息原本所属的资源，
 * 不能在核对时从当前目录作用域重新取值，否则换目录后会把原消息解释到别的资源上。
 */
type PendingFirstMessage = { readonly sessionId: string; readonly commandId: string;
  readonly content: string; readonly conversationMode: RelayConversationMode;
  readonly recordLearning?: boolean;
  readonly sourceRefs?: readonly RelayAssistSourceRef[];
  /** 传输失败时的真实原因；null 表示命令已确认发出。 */
  readonly reason: string | null; readonly resourceId: string | null };
/**
 * 建会话命令连同首条原文：创建响应丢失后按原回执恢复时，交接的必须是这一份载荷。
 *
 * 模式与助手也在载荷里，不是 UI 状态：身份在建立时冻结，重试必须交回同一份身份，
 * 否则「按原命令重试」会变成「建一条身份不同的新会话」。
 */
type PendingCreate = { readonly commandId: string; readonly projectId: string | null;
  readonly taskId: string | null; readonly title: string;
  readonly firstContent: string; readonly resourceId: string | null;
  readonly conversationMode: RelayConversationMode; readonly assistantProfileId: string | null;
  readonly recordLearning?: boolean;
  readonly sourceRefs?: readonly RelayAssistSourceRef[] };

/** 建会话载荷：助手档的助手 id 允许显式 null（表示「还没选助手」）。 */
type CreateSessionInput = { commandId: string; projectId: string | null; taskId: string | null;
  title: string; conversationMode?: RelayConversationMode; assistantProfileId?: string | null };
/**
 * 首条消息过程的唯一 Owner。命令身份、在途阶段与已完成解释必须比任何一次
 * AssistView 挂载都活得久：建会话成功后协作页会按会话 key 重新挂载它，
 * 而迟到响应与回执核对都可能跨越这次重挂载。
 */
export type FirstMessageProcess = {
  /** 首条输入原文。未发送时它就是未保存保护的对象，不因重挂载或换目录消失。 */
  readonly draft: string;
  readonly pending: PendingFirstMessage | null;
  readonly busy: boolean;
  /** 已声明完成解释的原消息 command_id：同一命令只解释一次，迟到响应不得重复解释。 */
  readonly interpreted: string | null;
  /** 首条解释结果：交接给当前会话的既有摘要 Owner，不在旧实例留唯一事实。 */
  readonly execution: RelayConversationExecution | null;
  /**
   * 首条消息的状态维护解释结果（总纲 §0.8.1）。可选字段：协作页构造的初始过程
   * 不带它等同于 null，不破坏既有 Owner 字面量。
   */
  readonly maintenance?: RelayStateMaintenanceRequest | null;
};
export type FirstMessageOwner = {
  /** 同步读取权威记录。迟到回调据此判断自己是否仍是当前阶段，闭包里的旧值不作数。 */
  readonly read: () => FirstMessageProcess;
  readonly write: (next: FirstMessageProcess) => void;
};
const emptyFirstProcess: FirstMessageProcess = { draft: "", pending: null, busy: false,
  interpreted: null, execution: null };
export type { PendingFirstMessage };
export type AssistNavigationState = {
  readonly dirty: boolean;
  readonly discard?: () => void;
  readonly pending: { readonly commandId: string; readonly commandType: string;
    readonly sessionId: string | null } | null;
  /**
   * 「保留并继续编辑」的编辑焦点恢复：由页壳守卫在弹层关闭并完成默认回焦后调用。
   * 实现内部只作用于仍存活、可编辑的编辑器，失效时兜底或放弃（见 restoreComposerFocus）。
   */
  readonly restoreFocus?: () => void;
};
const cleanNavigationState: AssistNavigationState = { dirty: false, pending: null };

/**
 * 「保留并继续编辑」的编辑焦点恢复：光标/选区来自用户原来的编辑位置——
 * 编辑器在弹层期间保持挂载，选区仍在存活 DOM 上，回焦后按原位写回，
 * 用户不必重新点击定位。编辑器已卸载、不在文档中或不可编辑（disabled/readonly）时，
 * 退到输入器容器内第一个可聚焦元素；容器也不在时静默放弃：
 * 不聚焦已卸载节点、不抛错、不重试。
 */
function restoreComposerFocus(textarea: HTMLTextAreaElement | null, container: HTMLElement | null): void {
  if (textarea !== null && textarea.isConnected && !textarea.disabled && !textarea.readOnly) {
    const end = textarea.selectionEnd ?? textarea.value.length;
    const start = textarea.selectionStart ?? end;
    textarea.focus();
    textarea.setSelectionRange(start, end);
    return;
  }
  const host = container !== null && container.isConnected ? container : null;
  if (host === null) return;
  const focusable = Array.from(host.querySelectorAll<HTMLElement>(
    'button, a[href], input, textarea, select, summary, [tabindex]'
  )).find((item) => item.tabIndex >= 0 && !(item as HTMLButtonElement).disabled);
  focusable?.focus();
}

function targetMatches(session: RelayAssistSession, target: AssistTarget): boolean {
  return target.kind === "PROJECT" ? session.projectId === target.id && session.taskId === null
    : session.taskId === target.id && session.projectId === target.projectId;
}

function receiptMatches(receipt: RelayCommandReceipt, action: PendingAction, sessionId: string): boolean {
  if (action.kind === "restart") return receipt.commandId === action.commandId &&
    receipt.commandType === "ExecuteChatCommand" && receipt.result.source_session_id === sessionId &&
    receipt.result.system === action.system && receipt.result.kind === "NEW_SESSION";
  const commandType = action.kind === "send" ? "RequestAssistMessage" : action.kind === "cancel"
    ? "CancelAssistMessage" : "AcceptAssistProposal";
  if (receipt.commandId !== action.commandId || receipt.commandType !== commandType) return false;
  if (action.kind === "send") return receipt.result.session_id === sessionId &&
    typeof receipt.result.assistant_message_id === "string";
  if (action.kind === "cancel") return receipt.result.message_id === action.id;
  if (action.kind === "acceptTask") return receipt.result.proposal_id === action.id &&
    receipt.result.task_id === action.taskId &&
    receipt.result.previous_acceptance_revision === action.expectedAcceptanceRevision &&
    typeof receipt.result.acceptance_revision === "string" &&
    typeof receipt.result.revision === "string" &&
    typeof receipt.result.status === "string" &&
    typeof receipt.result.objective === "string" &&
    receipt.result.required_output_spec !== null &&
    typeof receipt.result.required_output_spec === "object" &&
    !Array.isArray(receipt.result.required_output_spec) &&
    Array.isArray(receipt.result.criteria) &&
    Array.isArray(receipt.result.added_criterion_ids);
  return true;
}

/** 项目与任务子页、独立 Agent 页共用同一个 Assist 业务入口。 */
export default function AssistView({ targetKind, targetId, preferredSessionId, onSessionCreated,
  standalone = false, onNavigationStateChange, onRequestNewSession, embedded = false,
  onRequestSessionChange, onSessionSelected, onActiveSessionChange,
  preferredSkillId, onTargetChanged, externalReadBlockedReason = null, externalWriteBlockedReason = null, proposalActionHost,
  deferSessionCreation = false, executionScope = null, onExecutionPrepared,
  firstMessageOwner, firstMessageProcess, workspaceLevel = false,
  conversationTarget, onConversationTargetChange, composerHeader }: {
  targetKind?: "PROJECT" | "TASK"; targetId?: string; preferredSessionId?: string | null;
  onSessionCreated?: (sessionId: string) => void;
  standalone?: boolean; onNavigationStateChange?: (state: AssistNavigationState) => void;
  onRequestNewSession?: (proceed: () => void) => void;
  onRequestSessionChange?: (proceed: () => void) => void;
  onSessionSelected?: (sessionId: string | null) => void;
  /**
   * 当前**实际展示**的会话，含应用自动续上的那一条。与 `onSessionSelected` 分开：
   * 后者是「用户显式选了哪条」，父级据此换 key 重挂载；本回调只做事实回报，
   * 父级接进 ref 即可，不得接进驱动 key 的 state。
   * 没有它，父级在「打开 /agent 自动续上最近讨论」这条最常见的路径上不知道当前会话，
   * 也就无法把这段讨论归入用户随后选择的项目。
   */
  onActiveSessionChange?: (sessionId: string | null) => void;
  embedded?: boolean; preferredSkillId?: string; onTargetChanged?: () => void;
  externalReadBlockedReason?: string | null;
  externalWriteBlockedReason?: string | null;
  proposalActionHost?: HTMLElement | null;
  /** 文件夹入口：首条发送时才建会话，不额外点「创建会话」。 */
  deferSessionCreation?: boolean;
  /** 只有目录作用域齐备时才允许从对话进入执行。 */
  executionScope?: RelayWorkingDirectory | null;
onExecutionPrepared?: (taskId: string) => void;
  /**
   * 首条消息过程由协作页持有：本组件会因会话切换重新挂载，
   * 命令身份、在途阶段、首条原文与解释结果都不能随之丢失。
   */
  firstMessageOwner?: FirstMessageOwner;
  /** 父级持有的当前过程投影；只在提供了 firstMessageOwner 时使用。 */
  firstMessageProcess?: FirstMessageProcess;
  /**
   * 工作空间级模式：没有项目也没有任务，只有 project_id 为空的会话。
   * 文件夹入口在未选目录时用它 —— 先能讨论，归属与执行准入另行决定。
   */
  workspaceLevel?: boolean;
  /**
   * 目标会话身份（工作台 §25）。由协作页持有而不是 URL 或本视图内部：
   * 本视图按会话 key 反复重挂载，而 App 又按 pathname+search 重新挂载整条路由，
   * 放进 URL 会连工作目录一起丢进垃圾桶。这里为 null 表示普通档（既有行为不变）。
   */
  conversationTarget?: { mode: RelayConversationMode; assistantProfileId: string | null } | null;
  onConversationTargetChange?: (next: { mode: RelayConversationMode; assistantProfileId: string | null }) => void;
  /**
   * 输入区上方的常驻槽位（协作页 §3.3 的文件夹作用域细条）。
   *
   * 细条必须紧贴输入区：它讲的是「执行写操作前先选目录」，离发送动作越近越可执行。
   * 但它由协作页持有（目录写命令、草稿保护、归属命令都只有一个 Owner），
   * 所以这里只开一个渲染槽，不把目录状态搬进本视图，也不在本视图内发任何目录命令。
   */
  composerHeader?: ReactNode;
} = {}) {
  const location = useLocation();
  const { timeZone } = useDisplayPreferences();
  const firstComposerFormId = useId();
  const params = useParams();
  const kind = targetKind ?? (location.pathname.startsWith("/projects/") ? "PROJECT" : "TASK");
  const id = targetId ?? params.id ?? "";
  const connection = useRelayConnection();
  const client = connection.client;
  const [target, setTarget] = useState<AssistTarget | null>(null);
  const [sessions, setSessions] = useState<readonly RelayAssistSession[]>([]);
  const [assistantProfiles, setAssistantProfiles] = useState<readonly RelayAssistantProfile[]>([]);
  // 「一次性问答」只作用于本次建会话，不进 URL：它不是身份的一部分。
  const [rememberNext, setRememberNext] = useState(true);
  const [recordLearning, setRecordLearning] = useState(true);
  const [sessionInflight, setSessionInflight] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  /**
   * 当前生效会话的同步镜像与「已回报给父级的那一条」。
   * 自动续上的会话也要能让父级读到（否则它不知道当前讨论属于哪个会话），
   * 而 setState 的 updater 闭包里拿不到「算出之后」的值，所以解析结果必须显式算出。
   */
  const sessionIdRef = useRef<string | null>(null);
  const reportedActiveSessionRef = useRef<string | null | undefined>(undefined);
  const applyActiveSession = useCallback((next: string | null) => {
    sessionIdRef.current = next; setSessionId(next);
    if (reportedActiveSessionRef.current === next) return;
    reportedActiveSessionRef.current = next;
    onActiveSessionChange?.(next);
  }, [onActiveSessionChange]);
  // 其余 setSessionId 调用点（用户显式切换、父级 preferredSessionId）继续按原样落地，
  // 这里只把镜像同步到最新值，保证「当前生效会话」始终可读。
  sessionIdRef.current = sessionId;
  const [selectedRefs, setSelectedRefs] = useState<readonly RelayAssistSourceRef[]>([]);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [pendingCreate, setPendingCreate] = useState<PendingCreate | null>(null);
  const [firstError, setFirstError] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  /**
   * 首条消息过程的 Owner。文件夹入口下由协作页持有并跨重挂载存活；
   * 独立使用时退回本实例的局部记录，语义不变。
   */
  const [localFirst, setLocalFirst] = useState<FirstMessageProcess>(emptyFirstProcess);
  const localFirstRef = useRef(localFirst); localFirstRef.current = localFirst;
  const localOwner = useMemo<FirstMessageOwner>(() => ({
    read: () => localFirstRef.current,
    write: (next) => { localFirstRef.current = next; setLocalFirst(next); },
  }), []);
  const firstOwner = firstMessageOwner ?? localOwner;
  const first = firstMessageOwner ? (firstMessageProcess ?? emptyFirstProcess) : localFirst;
  const pendingFirst = first.pending;
  // 在途阶段与命令身份同属一个 Owner：重挂载后的新实例据此知道原发送仍在途，
  // 不会再对同一条消息发起第二次解释。
  const updateFirst = useCallback((patch: Partial<FirstMessageProcess>) => {
    firstOwner.write({ ...firstOwner.read(), ...patch });
  }, [firstOwner]);
  // 首条发送期间禁用输入区；真正的在途判定在 first.busy 上，这里只是输入态。
  const firstBusy = first.busy;
  const [sessionNavigation, setSessionNavigation] = useState<AssistNavigationState>(cleanNavigationState);
  const requestVersion = useRef(0);
  const reportSessionNavigation = useCallback((state: AssistNavigationState) => setSessionNavigation(state), []);
  /**
   * 助手清单。与 Skill 清单一样是可失败的只读依赖：读不到就把「新建助手」这条路留着，
   * 不因此关掉整个输入器。
   */
  const [assistantProfilesError, setAssistantProfilesError] = useState<string | null>(null);
  const [assistantProfilesLoading, setAssistantProfilesLoading] = useState(true);
  const assistantProfilesRequestVersion = useRef(0);
  const reloadAssistantProfiles = useCallback(async () => {
    if (!client) { setAssistantProfilesLoading(false); return; }
    const version = ++assistantProfilesRequestVersion.current;
    setAssistantProfilesLoading(true); setAssistantProfilesError(null);
    try {
      const items = await client.getAssistantProfiles({ includeArchived: true });
      if (version === assistantProfilesRequestVersion.current && client === liveClient()) {
        setAssistantProfiles(items); setAssistantProfilesError(null);
      }
    } catch (caught) {
      if (version === assistantProfilesRequestVersion.current && client === liveClient()) {
        setAssistantProfilesError(describeLiveError(caught).message);
      }
    } finally {
      if (version === assistantProfilesRequestVersion.current) setAssistantProfilesLoading(false);
    }
  }, [client]);
  useEffect(() => {
    void reloadAssistantProfiles();
    return () => { assistantProfilesRequestVersion.current++; };
  }, [reloadAssistantProfiles]);
  /**
   * 深链：URL 指定的身份优先于列表默认选中的那条。
   * 列表默认取第一项，而用户从链接进来时心里认的是 URL 里那一条——
   * 两者的身份可能不同，不对齐就会把助手会话显示成普通会话。
   * 只在 URL 真的指名了身份时才动，普通入口的默认选择逻辑保持原样。
   */


  /**
   * 首条输入器的存活恢复目标：textarea 优先，输入器容器兜底（见 restoreComposerFocus）。
   * ref 在卸载时被 React 置空，因此用它判断「首条输入器当前是否就是触发保护的编辑器」。
   */
  const firstDraftRef = useRef<HTMLTextAreaElement | null>(null);
  const firstComposerBoxRef = useRef<HTMLDivElement | null>(null);
  const restoreFirstDraftFocus = useCallback(() => {
    restoreComposerFocus(firstDraftRef.current, firstComposerBoxRef.current);
  }, []);

useEffect(() => {
    if (!standalone && !embedded) return;
    // 首条草稿与已选资料是同一份未保存保护：未发送的首条输入离页同样要经过守卫，
    // 否则普通 Link 导航会静默丢掉它。存在未决命令时上层守卫会先拒绝 discard，这里照常投影即可。
    onNavigationStateChange?.({
      dirty: sessionNavigation.dirty || selectedRefs.length > 0 || first.draft.trim() !== "",
      discard: () => { sessionNavigation.discard?.(); setSelectedRefs([]); updateFirst({ draft: "" }); },
      pending: pendingFirst ? { commandId: pendingFirst.commandId,
          commandType: "RequestAssistMessage", sessionId: pendingFirst.sessionId }
        : pendingCreate ? { commandId: pendingCreate.commandId,
            commandType: "CreateAssistSession", sessionId: null }
          : sessionNavigation.pending,
      // 首条输入器挂载时它就是触发保护的编辑器；未挂载（已有会话/读被挡）时交给会话输入器的恢复回调。
      restoreFocus: firstDraftRef.current !== null ? restoreFirstDraftFocus : sessionNavigation.restoreFocus });
  }, [standalone, embedded, sessionNavigation, selectedRefs, pendingCreate, pendingFirst, first.draft,
    updateFirst, onNavigationStateChange, restoreFirstDraftFocus]);

  /**
   * 工作空间级会话：没有 target 可读，只有 project_id 为空的会话属于这里。
   * 服务端对不带过滤的列表请求不加任何条件，因此这里显式按归属筛一次，
   * 不能把别人的项目会话混进来。
   */
  async function loadUnassignedSessions(version: number, preferredSessionIdFromRefresh?: string) {
    setTarget(null); setSelectedRefs([]);
    setError(null); setLoading(client !== null);
    if (!client) return;
    try {
      const list = await client.getAssistSessions();
      if (version !== requestVersion.current || client !== liveClient()) return;
      const scoped = list.filter((item) => item.projectId === null && item.taskId === null);
      setSessions(scoped);
      const preferred = preferredSessionIdFromRefresh !== undefined
        ? preferredSessionIdFromRefresh : preferredSessionId;
      const current = sessionIdRef.current;
      // 显式算出结果再落地：自动续上的那一条也要回报给父级，否则父级不知道
      // 当前讨论属于哪个会话，随后的项目归属就无从发起。
      applyActiveSession(preferred === null
        ? current && scoped.some((item) => item.id === current) ? current : null
        : preferred ? scoped.some((item) => item.id === preferred) ? preferred : null
          : current && scoped.some((item) => item.id === current) ? current : scoped[0]?.id ?? null);
      if (preferred && !scoped.some((item) => item.id === preferred))
        setError("所选会话不属于当前工作空间级讨论，请刷新会话列表后重试。");
    } catch (caught) { if (version === requestVersion.current) setError(describeLiveError(caught).message); }
    finally { if (version === requestVersion.current) setLoading(false); }
  }

  async function loadTarget(preferredSessionIdFromRefresh?: string) {
    const version = ++requestVersion.current;
    if (workspaceLevel) { await loadUnassignedSessions(version, preferredSessionIdFromRefresh); return; }
    if (target?.id !== id || target.kind !== kind) {
      setTarget(null); setSessions([]); setSessionId(null); setSelectedRefs([]);
    }
    setError(null); setLoading(client !== null);
    if (!client) return;
    try {
      const targetPromise: Promise<AssistTarget> = kind === "PROJECT"
        ? client.getProject(id).then((project) => ({ kind, id: project.id, title: project.title,
          revision: project.revision, projectId: project.id, executor: null,
          archivedAt: project.archivedAt }))
        : client.getTask(id).then(async (task) => {
          let archivedAt: string | null | undefined = null;
          if (task.projectId) {
            archivedAt = undefined;
            try { const project = await client.getProject(task.projectId); if (project.id === task.projectId) archivedAt = project.archivedAt; }
            catch { /* 保留任务与历史会话读取，关闭新的写命令。 */ }
          }
          return { kind, id: task.id, title: task.title, revision: task.revision,
            projectId: task.projectId, executor: task.executor, archivedAt };
        });
      const [nextTarget, list] = await Promise.all([targetPromise,
        client.getAssistSessions(kind === "PROJECT" ? { projectId: id } : { taskId: id })]);
      if (version !== requestVersion.current || client !== liveClient()) return;
      const scoped = list.filter((item) => targetMatches(item, nextTarget));
      setTarget(nextTarget); setSessions(scoped);
      // null 表示从独立页开始新会话；undefined 保留项目/任务子页的默认最近会话行为。
      const preferred = preferredSessionIdFromRefresh !== undefined
        ? preferredSessionIdFromRefresh : preferredSessionId;
      const current = sessionIdRef.current;
      applyActiveSession(preferred === null
        ? current && scoped.some((item) => item.id === current) ? current : null
        : preferred ? scoped.some((item) => item.id === preferred) ? preferred : null
          : current && scoped.some((item) => item.id === current) ? current : scoped[0]?.id ?? null);
      if (preferred && !scoped.some((item) => item.id === preferred))
        setError("所选会话不属于当前目标，请刷新会话列表后重试。");
    } catch (caught) { if (version === requestVersion.current) setError(describeLiveError(caught).message); }
    finally { if (version === requestVersion.current) setLoading(false); }
  }
  useEffect(() => {
    setPendingCreate(null); setCreateError(null); setCreating(false);
    void loadTarget();
    return () => { requestVersion.current++; };
  }, [kind, id, client]);
  useEffect(() => {
    if (preferredSessionId === undefined) return;
    setSessionId(preferredSessionId !== null && sessions.some((item) => item.id === preferredSessionId)
      ? preferredSessionId : null);
    setSelectedRefs([]);
  }, [preferredSessionId]);

  /**
   * 首条消息成功（或回执核对成功）后走既有执行解释链。
   * 依据只能是真实回执里的 user message id 与该命令产生时绑定的确切目录资源；
   * 回执未确定时不猜 source_message_id，换目录后也不从当前作用域重新取值。
   * 解释结果写回共享 Owner，由会话面板既有 Owner 渲染与执行，不另建一套确认门。
   *
   * 同一原消息只解释一次：先在 Owner 上按 command_id 声明，重复或迟到的成功路径拿不到声明。
   */
  async function interpretFirstMessage(pending: PendingFirstMessage, sourceMessageId: string) {
    const current = firstOwner.read();
    if (current.interpreted === pending.commandId) return;
    if (current.pending?.commandId !== pending.commandId) return;
    firstOwner.write({ ...current, interpreted: pending.commandId, pending: null, draft: "" });
    if (pending.resourceId === null || pending.conversationMode !== "AGENT") return;
    // 状态维护与执行解释同一时机触发：项目绑定的普通档首条消息解释一次。
    // 彼此独立成败：维护解释失败不阻塞执行解释链，回执由会话面板按原回执重读恢复。
    //
    // 阶段 D（未实施）：服务端主流程现在能在同一次模型判定里落候选，因此这条命令在
    // 服务端会命中已保存的判定并直接重放，不再是第二次模型判定。但前端这条调用本身
    // 仍保留——`folderFirstConversation.spec.ts` 等规格按「前端发起解释」断言，改成
    // 「前端不再发起」需要连同这些反例一起迁移，属于阶段 D 的独立工作。
    void interpretFirstStateMaintenance(pending, sourceMessageId);
    try {
      const execution = await client!.interpretConversationMessage({ sessionId: pending.sessionId,
        sourceMessageId, resourceId: pending.resourceId, commandId: createCommandId() });
      if (client !== liveClient() || firstOwner.read().interpreted !== pending.commandId) return;
      if (execution.sessionId !== pending.sessionId || execution.sourceMessageId !== sourceMessageId ||
          execution.resourceId !== pending.resourceId) throw new Error("执行解释与原会话、消息或目录不匹配。");
      // 解释结果必须落在当前实例可见的 Owner 上：重挂载后的会话面板据此渲染摘要。
      firstOwner.write({ ...firstOwner.read(), execution });
    } catch (caught) {
      if (firstOwner.read().interpreted === pending.commandId) setFirstError(describeLiveError(caught).message);
    }
  }

/** 首条消息的状态维护解释：结果并入共享 Owner，由会话面板按 requestId 接手渲染。 */
  async function interpretFirstStateMaintenance(pending: PendingFirstMessage, sourceMessageId: string) {
    if (!client) return;
    try {
      const projection = await client.createStateMaintenanceRequest({ sessionId: pending.sessionId,
        sourceMessageId, commandId: createCommandId(), timezone: localTimezone() });
      if (client !== liveClient()) return;
      if (projection.sessionId !== pending.sessionId || projection.sourceMessageId !== sourceMessageId) return;
      if (firstOwner.read().interpreted !== pending.commandId) return;
      firstOwner.write({ ...firstOwner.read(), maintenance: projection });
    } catch { /* 与执行解释互相独立；已有请求行由会话面板的列表读取显示。 */ }
  }

  async function createSession(retry?: PendingCreate) {
    if ((!target && !workspaceLevel) || !client || creating || (!retry &&
      (pendingCreate || projectWriteBlockedReason || firstAssistantBlockedReason !== null))) return;
    // 首条原文与目录资源在建会话命令产生时就固定：创建响应丢失后按原回执恢复时，
    // 交接的必须是这一份，而不是用户后来修改的输入或当前作用域的资源。
    const content = retry ? retry.firstContent : firstOwner.read().draft.trim();
    // 工作空间级讨论没有 target：归属留空，标题只能来自这条消息本身。
    // CHECK (title <> '') 会拒绝空标题，而「新建会话」按钮绕过 sendFirst 的空内容早退，
    // 因此这条路径上 content 确实可能为空，必须单独兜底而不是直接取 target.title。
    const unassignedTitle = content.replace(/\s+/gu, " ").slice(0, 30);
    const action: PendingCreate = retry ?? { commandId: createCommandId(),
      projectId: target === null ? null : target.kind === "PROJECT" ? target.id : target.projectId,
      taskId: target === null ? null : target.kind === "TASK" ? target.id : null,
      title: target === null ? (unassignedTitle === "" ? "新讨论" : unassignedTitle)
        : `关于${target.title}`.slice(0, 200),
      firstContent: content, resourceId: executionScope?.association?.resourceId ?? null,
      conversationMode: wantedMode, assistantProfileId: wantedMode === "ASSISTANT" ? wantedAssistantId : null,
      ...(wantedMode === "LEARNING" ? { recordLearning } : {}) };
    const version = requestVersion.current;
    setCreating(true); setCreateError(null); setPendingCreate(action);
    try {
      const created = await client.createAssistSession(action satisfies CreateSessionInput);
      if (version !== requestVersion.current) return;
      setPendingCreate(null); setCreating(false); await loadTarget(created.id);
      if (requestVersion.current !== version + 1 || client !== liveClient()) return;
      onSessionCreated?.(created.id);
      // 首条只发一次：命令 ID 与原始载荷在发送前就固定。响应丢失时保留 pendingFirst，
      // 由「查询首条回执」按原 command_id 核对或「按原命令重试」，绝不重建会话，
      // 也不把后来修改的文本混入原载荷。
      if (action.firstContent !== "") {
        const first: PendingFirstMessage = { sessionId: created.id, commandId: createCommandId(),
          content: action.firstContent, conversationMode: action.conversationMode,
          reason: null, resourceId: action.resourceId,
          ...(action.sourceRefs === undefined ? {} : { sourceRefs: action.sourceRefs }),
          ...(action.recordLearning === undefined ? {} : { recordLearning: action.recordLearning }) };
        // 在途标记由 sendFirstMessage 自己在同一 Owner 上置位，这里只登记命令身份与载荷。
        firstOwner.write({ ...firstOwner.read(), pending: first, draft: action.firstContent });
        setFirstError(null);
        await sendFirstMessage(first);
      }
    } catch (caught) {
      if (version !== requestVersion.current) return;
      const described = describeLiveError(caught);
      if (described.kind !== "transport") setPendingCreate(null);
      setCreateError(described.message);
    } finally { if (version === requestVersion.current) setCreating(false); }
  }

  /**
   * 首条发送与同 ID 重试共用这一条路径：命令 ID 与载荷在发送前固定，
   * 重试不换 ID、不重建会话、不混入后来修改的文本。
   * 在途标记写在共享 Owner 上，跨重挂载有效：新实例不会再对同一条消息发第二次解释。
   */
async function sendFirstMessage(pending: PendingFirstMessage) {
    // 同步闸：在途标记必须读 Owner 而不是本实例的 ref，否则重挂载后的新实例会重发。
    const current = firstOwner.read();
    if (!client || current.busy) return;
    if (current.interpreted === pending.commandId) return;
    firstOwner.write({ ...current, pending, busy: true });
    setCreating(true); setFirstError(null);
    try {
      const sent = await client.requestAssistMessage(pending.conversationMode !== "AGENT"
        ? { sessionId: pending.sessionId, commandId: pending.commandId,
          content: pending.content, sourceRefs: pending.sourceRefs ?? [],
          ...(pending.recordLearning === undefined ? {} : { recordLearning: pending.recordLearning }) }
        : { sessionId: pending.sessionId, commandId: pending.commandId,
          content: pending.content, sourceRefs: pending.sourceRefs ?? [], intent: "DISCUSS" });
      // 回执核对或新对话已接续后，旧响应不再拥有这份过程，不能清掉新草稿或再次解释。
      if (firstOwner.read().pending?.commandId !== pending.commandId) return;
      // 连接已换时不猜结果：保留原命令与未决事实，等核对或同 ID 重试。
      if (client !== liveClient()) {
        firstOwner.write({ ...firstOwner.read(),
          pending: { ...pending, reason: "连接已变化，首条消息结果待核对。" } });
        return;
      }
      firstOwner.write({ ...firstOwner.read(), busy: false });
      setCreating(false);
      await interpretFirstMessage(pending, sent.userMessageId);
    } catch (caught) {
      // 传输失败不能推断成业务失败：原命令身份与真实原因一并保留，等核对或同 ID 重试。
      // 迟到失败不得复活已被核对清空的 pending：只有仍指向同一命令时才写回。
      const latest = firstOwner.read();
      if (latest.pending === null || latest.pending.commandId !== pending.commandId) return;
      firstOwner.write({ ...latest, busy: false, pending: { ...pending, reason: describeLiveError(caught).message } });
    } finally { setCreating(false); }
  }

  /**
   * 首条消息回执核对：只按原 command_id 查询，不重建会话、不改载荷、不猜测结果。
   * 核对成功后与迟到响应走同一个 interpretFirstMessage，由 Owner 上的 declared 决定谁真正解释。
   */
  async function checkFirstReceipt() {
    if (!client || !pendingFirst || creating) return;
    const pending = pendingFirst; const version = requestVersion.current;
    firstOwner.write({ ...firstOwner.read(), busy: true });
    setCreating(true); setFirstError(null);
    try {
      const receipt = await client.getCommandReceipt(pending.commandId);
      if (version !== requestVersion.current) return;
      const result = receipt.result as { session_id?: unknown; user_message_id?: unknown };
      if (receipt.commandId !== pending.commandId || receipt.commandType !== "RequestAssistMessage" ||
          result.session_id !== pending.sessionId || typeof result.user_message_id !== "string") {
        throw new Error("首条消息回执与原命令不匹配。");
      }
      // 回执不匹配时不得清 pending，也不得宣称已送达。
      firstOwner.write({ ...firstOwner.read(), busy: false });
      setCreating(false);
      await interpretFirstMessage(pending, result.user_message_id);
    } catch (caught) {
      const latest = firstOwner.read();
      firstOwner.write({ ...latest, busy: false });
      if (version === requestVersion.current) setFirstError(describeLiveError(caught).message);
    }
    finally { if (version === requestVersion.current) setCreating(false); }
  }
  /**
   * 创建回执恢复：按原 CreateAssistSession 回执取回确切会话，并把该命令携带的首条原文与
   * 目录资源交接回同一条用户过程。原载荷不会随恢复丢失，也不会被后来输入替换。
   */
  async function checkCreateReceipt() {
    if (!client || !pendingCreate || creating) return;
    const commandId = pendingCreate.commandId; const version = requestVersion.current;
    setCreating(true); setCreateError(null);
    try {
      const receipt = await client.getCommandReceipt(commandId);
      if (version !== requestVersion.current) return;
      if (receipt.commandId !== commandId || receipt.commandType !== "CreateAssistSession" ||
          typeof receipt.result.session_id !== "string") throw new Error("会话回执与原命令不匹配。");
      const action = pendingCreate;
      setPendingCreate(null); setCreating(false); await loadTarget(receipt.result.session_id);
      if (requestVersion.current !== version + 1 || client !== liveClient()) return;
      onSessionCreated?.(receipt.result.session_id);
      // 创建与发送是同一首条过程的两个命令：恢复出会话后必须续发原首条，
      // 否则用户只看到空白会话，原文与载荷就此丢失。
      if (action.firstContent !== "") {
        const first: PendingFirstMessage = { sessionId: receipt.result.session_id, commandId: createCommandId(),
          content: action.firstContent, conversationMode: action.conversationMode,
          reason: null, resourceId: action.resourceId,
          ...(action.sourceRefs === undefined ? {} : { sourceRefs: action.sourceRefs }),
          ...(action.recordLearning === undefined ? {} : { recordLearning: action.recordLearning }) };
        firstOwner.write({ ...firstOwner.read(), pending: first, draft: action.firstContent });
        setFirstError(null);
        await sendFirstMessage(first);
      }
    } catch (caught) { if (version === requestVersion.current) setCreateError(describeLiveError(caught).message); }
    finally { if (version === requestVersion.current) setCreating(false); }
  }

  if (connection.mode !== "live") return <section className="page-state" data-testid="assist-fixture-gap"><p className="eyebrow">Assist</p><h1>示例模式没有真实会话</h1><p>连接本机 API 后才能读取项目或任务会话；示例模式不生成模型回复或提案。</p></section>;
  if (!workspaceLevel && error && (target?.id !== id || target.kind !== kind)) return <section className="page-state page-state--error" role="alert"><p className="eyebrow">Assist</p><h1>暂时无法读取对话目标</h1><p>{error}</p><button className="secondary-button" type="button" onClick={() => void loadTarget()}><RotateCcw aria-hidden="true" />重新读取</button></section>;
  // 工作空间级模式没有 target 可核对，不能因此停在占位页 —— 那正是没选目录时用户看到的东西。
  if (!workspaceLevel && (target?.id !== id || target.kind !== kind)) return <section className="page-state" aria-live="polite"><p className="eyebrow">Assist</p><h1>正在核对对话目标与会话</h1></section>;
  if (!client || (!workspaceLevel && !target)) return null;
  // 工作空间级讨论还没有项目，因此没有归档或项目事实可失败；执行准入另由 executionScope 判定。
  const projectWriteBlockedReason = workspaceLevel ? (externalReadBlockedReason ?? externalWriteBlockedReason)
    : externalReadBlockedReason ?? externalWriteBlockedReason ?? (target!.projectId === null ? null : loading || error !== null || target!.archivedAt === undefined ?
    "Project 事实正在核对或读取失败，不能发送新的 Assist 命令。" : target!.archivedAt !== null ?
      "项目已归档，不能发送新的 Assist 命令。" : null);
  const session = sessions.find((item) => item.id === sessionId) ?? null;
  /**
   * 模式是**会话属性**：已在会话上的身份以会话为准；没有会话时由协作页持有的目标身份
   * 决定「新建哪一条」。目标身份缺省即普通档，不猜助手。
   */
  const wantedMode: RelayConversationMode = session?.conversationMode
    ?? conversationTarget?.mode ?? "AGENT";
  const wantedAssistantId = session?.conversationMode === "ASSISTANT"
    ? session.assistantProfileId : conversationTarget?.assistantProfileId ?? null;
  const activeAssistantProfiles = assistantProfiles.filter((item) => item.status === "ACTIVE");
  const selectedAssistantAvailable = wantedAssistantId !== null &&
    activeAssistantProfiles.some((item) => item.id === wantedAssistantId);
  const firstAssistantBlockedReason = wantedMode !== "ASSISTANT" ? null
    : assistantProfilesLoading ? "正在读取助手清单；读取完成后才能发送。"
      : assistantProfilesError !== null ? "助手清单读取失败，暂时不能发送；请重新读取或先新建助手。"
        : activeAssistantProfiles.length === 0 ? "当前没有可用助手，先新建一个或重新读取助手清单。"
          : wantedAssistantId === null ? "请选择一个可用助手后再发送。"
            : !selectedAssistantAvailable ? "所选助手已归档或不在当前可用清单中；请重新选择有效助手。"
              : null;
  /** 切档是导航：找到同身份的那条就切过去，找不到就回到「还没有会话」，等首条消息建。 */
  function switchConversation(nextMode: RelayConversationMode, nextAssistantId: string | null) {
    /**
     * 切到助手档而当前没记住助手时，按「最近的助手会话 → 唯一活跃助手」定一个。
     * 不这么做的话，单纯拨一下单选框会落进「有助手档但没有会话」的空态，
     * 用户得再选一次助手才看得到自己已有的那条助手会话。
     */
    const assistantId = nextMode !== "ASSISTANT" ? null : nextAssistantId
      ?? sessions.find((item) => item.conversationMode === "ASSISTANT")?.assistantProfileId
      ?? (assistantProfiles.filter((item) => item.status === "ACTIVE").length === 1
        ? assistantProfiles.find((item) => item.status === "ACTIVE")?.id ?? null : null);
    const match = sessions.find((item) => item.conversationMode === nextMode &&
      (nextMode !== "ASSISTANT" || item.assistantProfileId === assistantId));
    const nextSessionId = match?.id ?? null;
    const proceed = () => {
      onConversationTargetChange?.({ mode: nextMode, assistantProfileId: assistantId });
      setSessionId(nextSessionId); setSelectedRefs([]);
      onSessionSelected?.(nextSessionId);
    };
    // 只有真的换会话才是导航：这时有未发草稿必须先经同一离页守卫，草稿留在原会话，
    // 不能靠拨一下单选框静默丢掉它。没换会话（首条档内切档）仍即时生效，草稿本就不动。
    if (standalone && onRequestSessionChange && nextSessionId !== sessionId) onRequestSessionChange(proceed);
    else proceed();
  }
  /**
   * 助手清单里选中的那个助手可能是刚建的；新建成功后直接选中它，
   * 否则用户会看到「新助手已建但当前仍无身份」。
   */
  async function createAssistant(draft: AssistantDraft) {
    if (!client) throw new Error("尚未连接本机 API，无法新建助手。");
    const roots = draft.readRoots.split(/[;\n]/u).map((item) => item.trim()).filter((item) => item !== "");
    const created = await client.createAssistantProfile({ commandId: createCommandId(),
      name: draft.name, roleDescription: draft.roleDescription,
      ...(draft.tone.trim() === "" ? {} : { tone: draft.tone.trim() }),
      ...(roots.length === 0 ? {} : { readScope: { roots } }) });
    assistantProfilesRequestVersion.current++;
    setAssistantProfiles((current) => [...current.filter((item) => item.id !== created.id), created]);
    setAssistantProfilesError(null); setAssistantProfilesLoading(false);
    switchConversation("ASSISTANT", created.id);
  }
  // 文件夹入口：目录作用域齐备且候选可用时，明确的请求才会走真实执行链。
  const executionScopeReady = executionScope !== null && executionScope.status === "READY" &&
    executionScope.association !== null;
  const firstComposer = deferSessionCreation && session === null && externalReadBlockedReason === null;
  function sendFirst(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const content = first.draft.trim();
    if (content === "" || content.length > 32768 || firstBusy || creating ||
      projectWriteBlockedReason !== null || firstAssistantBlockedReason !== null) return;
    if (chatControlFromText(content) !== null) {
      setFirstError("当前还没有会话历史。先发送一条普通消息；会话命令需在已有会话中使用。");
      return;
    }
    setFirstError(null); updateFirst({ draft: content });
    void createSession();
  }
  /**
   * 模式控件在输入器这一列的左侧，两档共用同一处位置。
   * 锁定原因写清下一步：在途时切档不是停止，必须让人先停。
   */
  const modeLocked = firstBusy || creating || sessionInflight || sessionNavigation.pending !== null;
  const modeSwitch = <ConversationModeSwitch mode={wantedMode}
    assistantProfileId={wantedAssistantId} profiles={assistantProfiles}
    profilesError={assistantProfilesError} profilesLoading={assistantProfilesLoading}
    onReloadProfiles={() => { void reloadAssistantProfiles(); }} remember={rememberNext}
    disabled={modeLocked}
    lockedReason={modeLocked ? "正在生成，停止后才能切换会话模式。" : null}
    onChangeMode={(next) => switchConversation(next, next === "ASSISTANT" ? wantedAssistantId : null)}
    onChangeAssistant={(profileId) => switchConversation("ASSISTANT", profileId)}
    onChangeRemember={setRememberNext}
    recordLearning={recordLearning} onChangeRecordLearning={setRecordLearning}
    onCreateAssistant={createAssistant} />;
  const firstMessage = <section className="surface-panel agent-chat-conversation agent-chat-start" data-testid="assist-first-message">
    {/* 空态欢迎卡（协作页 §3.2）：标题用 compactPage 而不是 page——首屏标题 2.5rem
        会把下面真正要做的事（怎么把内容交给这次讨论）压出视线；副说明回到 body，
        引导收进一张底subtle的卡里，编号步骤因此能一次读完。 */}
    <div className="agent-assist-session-welcome">
      <h1>这次想聊些什么？</h1>
      <p className="agent-chat-welcome-lede">直接说想法。需要处理项目文件时，再选择文件夹。</p>
      <div className="agent-chat-guide" data-testid="assist-first-guide">
        <ol className="agent-chat-guide-steps">
          <li><span className="agent-chat-guide-step">选择或上传资料</span>在输入区点「资料」，添加文档、代码或日志；</li>
          <li><span className="agent-chat-guide-step">直接粘贴内容</span>内容较少时，直接粘到对话里也可以。</li>
        </ol>
        <p className="agent-chat-guide-note">添加资料后先确认读取范围，再继续分析。</p>
      </div>
    </div>
    {composerHeader}
    <div className="agent-chat-composer" data-inflight={firstBusy || creating} ref={firstComposerBoxRef}>
    <span className="agent-chat-composer-spark" aria-hidden="true" />
    <form id={firstComposerFormId} className="agent-chat-message-form" onSubmit={sendFirst}>
      <div className="field"><span className="visually-hidden">本次消息</span>
        <ChatCommandInput client={client} mode={wantedMode} hasSession={false}
          data-testid="assist-first-draft" ref={firstDraftRef} value={first.draft} maxLength={32768} rows={2}
          disabled={firstBusy || creating} placeholder="输入你的想法、修改意见或新的要求"
          onValueChange={(draft) => updateFirst({ draft })} onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
              event.preventDefault(); event.currentTarget.form?.requestSubmit();
            }
          }} /></div>
    </form>
    <div className="agent-chat-composer-actions">
      <div className="agent-chat-composer-tools">
        {modeSwitch}
        {firstAssistantBlockedReason !== null && <p className="disabled-reason"
          data-testid="assist-first-blocked">{firstAssistantBlockedReason}</p>}
        <button className="agent-chat-tool" type="button" disabled
          title="首条消息发送后，可在项目会话中选择资料" aria-label="资料 0，首条消息发送后可在项目会话中选择">
          <BookOpen aria-hidden="true" />资料 0<ChevronDown aria-hidden="true" className="agent-chat-chip-chevron" /></button>
        {wantedMode === "AGENT" && <details className="agent-chat-options">
          <summary>普通讨论<ChevronDown aria-hidden="true" className="agent-chat-chip-chevron" /></summary>
          <p className="helper-text">直接发送即可开始讨论。需要处理项目文件时，先选择文件夹。</p>
          <p className="helper-text">Enter 发送 · Shift + Enter 换行</p>
        </details>}
        <ContextMeter ratio={null} hitRate={null} call={null} limit={null} />
      </div>
      <button className="primary-button agent-chat-send" type="submit" data-testid="assist-first-send"
        aria-label={firstBusy || creating ? "正在发送首条消息" : "发送消息"}
        title={firstBusy || creating ? "正在发送首条消息" : firstAssistantBlockedReason ?? "发送消息"}
        form={firstComposerFormId}
        disabled={first.draft.trim() === "" || firstBusy || creating || projectWriteBlockedReason !== null || firstAssistantBlockedReason !== null}>
        <ArrowUp aria-hidden="true" /></button></div>
    </div>
    {(firstBusy || creating) && <p className="helper-text" role="status">正在发送首条消息…</p>}
    {projectWriteBlockedReason !== null && <p className="disabled-reason">{projectWriteBlockedReason}</p>}
  </section>;
  const sessionChangeBlocked = sessionNavigation.pending !== null || pendingCreate !== null ||
    (!standalone && (sessionNavigation.dirty || selectedRefs.length > 0));
  function selectSession(next: string | null) {
    if (next === sessionId || sessionChangeBlocked) return;
    const proceed = () => { setSessionId(next); setSelectedRefs([]); onSessionSelected?.(next); };
    if (standalone && onRequestSessionChange) onRequestSessionChange(proceed);
    else proceed();
  }
  function newSession() {
    if (!deferSessionCreation) { void createSession(); return; }
    setSessionId(null); setSelectedRefs([]);
    firstOwner.write(emptyFirstProcess);
    onSessionSelected?.(null);
  }
  // 协作页（standalone）的会话行引用全局横向 field 与紧凑按钮变体；skill 子页保持
  // 纵向布局与常规按钮密度，紧凑密度不再由 CollaborationView.css 页面压回。
  const sessionControls = <div className={`form-actions${standalone ? " agent-assist-session-controls" : ""}`}><label className={standalone ? "field field--row" : "field"}><span className={standalone ? "visually-hidden" : "field-label"}>当前会话</span><select data-testid="assist-session-select" aria-label="当前会话" disabled={creating || sessionChangeBlocked} value={sessionId ?? ""} onChange={(event) => selectSession(event.target.value || null)}><option value="">选择会话</option>{sessions.map((item) => <option key={item.id} value={item.id}>{item.title}{sessions.some((other) => other.id !== item.id && other.title === item.title) ? ` · 更新 ${formatReadableDateTime(item.updatedAt, timeZone)}${item.id === sessionId ? " · 当前" : ""}` : ""}{item.status !== "ACTIVE" ? " · 已结束" : ""}</option>)}</select></label><button className={standalone && !session ? "primary-button primary-button--compact" : `secondary-button${standalone ? " secondary-button--compact" : ""}`} type="button" data-testid="assist-new-session" disabled={creating || pendingCreate !== null || projectWriteBlockedReason !== null || sessionChangeBlocked} onClick={() => standalone && onRequestNewSession ? onRequestNewSession(newSession) : newSession()}>{creating ? "正在创建" : "新建会话"}</button><button className={`secondary-button${standalone ? " secondary-button--compact" : ""}`} type="button" disabled={sessionChangeBlocked} onClick={() => void loadTarget(sessionId ?? undefined)}>刷新会话</button></div>;
  // 工作空间级讨论没有项目，资料选择器无从谈起：没有项目就没有可选的项目资料。
  const sourcePicker = session?.status === "ACTIVE" && target !== null
    ? <AssistSourcePicker key={`${connection.epoch}:${session.id}:${target.projectId ?? "none"}`} projectId={target.projectId} selectedRefs={selectedRefs} onChange={setSelectedRefs} /> : null;
  // 有会话时收成一行摘要，给消息区让出高度；无会话仍按设计系统 5.1 展开说明与新建入口。
  /* 协作页只保留一条会话控制带：不再叠「会话：标题」details +「当前会话」下拉双层壳。 */
  const sessionSwitcher = sessionControls;
  return <section className={embedded ? "embedded-assist" : standalone ? "skill-page agent-assist" : "skill-page page-primary"} data-testid="assist-target"><div className={standalone ? "agent-assist-heading" : undefined}>{!embedded && !standalone && target !== null && <PageHeader testId="assist-page-head" title={target.title}
      meta={`${kind === "PROJECT" ? "项目 Assist" : "任务 Assist"} · ${id}`}
      lede={<>当前目标修订 v{target.revision}{target.executor && <> · 当前执行者 {target.executor}</>}</>}
      actions={<Link className="text-link" to={kind === "PROJECT" ? `/projects/${id}` : `/tasks/${id}`}>返回{kind === "PROJECT" ? "项目" : "任务"}</Link>}>
      <p className="helper-text">消息固定写入当前会话；切换目标后重新读取。Assist 建议不会自动修改业务事实。</p>
    </PageHeader>}{!embedded && standalone && <Link className="text-link" to={kind === "PROJECT" ? `/projects/${id}` : `/tasks/${id}`}>返回{kind === "PROJECT" ? "项目" : "任务"}</Link>}</div>{loading && <p className="loading-text" role="status">正在刷新目标与会话…</p>}{error && <p className="action-error" role="alert">{error}</p>}
    {projectWriteBlockedReason && <p className="disabled-reason" data-testid="assist-archive-reason">{projectWriteBlockedReason}</p>}
    {!externalReadBlockedReason && !(embedded && session) && !firstComposer && <section className={standalone ? `agent-assist-session-bar${!session ? " agent-assist-session-bar--empty" : ""}` : "surface-panel"}>{!standalone && <h2>会话</h2>}{standalone && !session && <div className="agent-session-welcome"><MessageSquareText aria-hidden="true" /><h2>开始讨论</h2></div>}{!session && preferredSessionId === null && <p className="helper-text" data-testid="assist-new-session-prompt">目标已选。可以新建会话，或在“当前会话”中返回已有讨论。</p>}{!sessions.length && preferredSessionId !== null && <p className="helper-text">当前目标还没有会话，先新建会话再发送消息。</p>}{sessionSwitcher}</section>}
    {firstComposer && firstMessage}
    {/* 首条消息的错误与未决命令渲染在首条输入区之外：建会话成功后协作页会切到该 Task，
        这条部分成功事实必须继续留在对话区可发现、可核对，不能随输入区一起卸载。 */}
    {firstError !== null && <p className="action-error" role="alert" data-testid="assist-first-error">{firstError}</p>}
    {pendingFirst !== null && <div className="agent-assist-session-status" data-testid="assist-first-pending">
      <p className="helper-text">会话已创建，消息结果待核对。原 command_id：{pendingFirst.commandId}</p>
      {pendingFirst.reason !== null && <p className="action-error" role="alert" data-testid="assist-first-error">{pendingFirst.reason}</p>}
      <p className="helper-text">两个出口都按原 command_id 与原载荷走，绝不重建会话或换新命令 ID；核对前这条消息不算已送达。</p>
      <button type="button" className="secondary-button" data-testid="assist-first-receipt" disabled={creating}
        onClick={() => void checkFirstReceipt()}>{creating ? "正在查询" : "查询首条回执"}</button>
      <button type="button" className="secondary-button" data-testid="assist-first-retry" disabled={creating}
        onClick={() => void sendFirstMessage(pendingFirst)}>{creating ? "正在重试" : "按原命令重试"}</button>
    </div>}
    {createError && <p className="action-error" role="alert">{createError}</p>}{pendingCreate && <div className="agent-assist-session-status"><p className="helper-text">创建结果待核对，原 command_id：{pendingCreate.commandId}</p><button type="button" className="secondary-button" disabled={creating} onClick={() => void checkCreateReceipt()}>查询创建回执</button><button type="button" className="secondary-button" data-testid="assist-first-create-retry" disabled={creating} onClick={() => void createSession(pendingCreate)}>以原命令重试</button></div>}
    {externalReadBlockedReason && selectedRefs.length > 0 && <button className="secondary-button" type="button" disabled={sessionNavigation.pending !== null} onClick={() => setSelectedRefs([])}>清空本次资料选择</button>}
    {session && <>{!externalReadBlockedReason && !standalone && !embedded && sourcePicker}
      <AssistSessionPanel key={`${connection.epoch}:${session.id}`} client={client} session={session} target={target} sources={selectedRefs}
        standalone={standalone} embedded={embedded} onNavigationStateChange={reportSessionNavigation}
        sourcePicker={sourcePicker}
        sourcesOpen={sourcesOpen} onToggleSources={() => setSourcesOpen((open) => !open)}
        preferredSkillId={preferredSkillId}
        initialExecution={first.execution?.sessionId === session.id ? first.execution : null}
        initialMaintenance={first.maintenance?.sessionId === session.id ? first.maintenance : null}
        confirmedFirstMessageCommandId={first.interpreted}
        proposalActionHost={proposalActionHost}
        externalReadBlockedReason={externalReadBlockedReason}
        writeBlockedReason={projectWriteBlockedReason}
        executionScope={executionScopeReady ? executionScope : null}
        onExecutionPrepared={onExecutionPrepared}
        refreshTarget={async () => { await loadTarget(session.id); onTargetChanged?.(); }}
        onChatSessionCreated={(created) => {
          setSessions((current) => [created, ...current.filter((item) => item.id !== created.id)]);
          applyActiveSession(created.id);
          onSessionCreated?.(created.id);
        }}
        clearSentSources={(sent) => setSelectedRefs((current) => JSON.stringify(current) === JSON.stringify(sent) ? [] : current)}
        modeSwitch={modeSwitch}
        recordLearning={recordLearning}
        onLearningTransfer={(instruction, background, sourceRefs) => {
          if (modeLocked || sessionNavigation.pending !== null) return;
          const content = `${instruction}\n\n学习衔接（背景资料，执行时重新核对）：\n目标：${session.title}\n来源会话：${session.id}\n${background}`;
          const proceed = () => {
            const action: PendingCreate = { commandId: createCommandId(), projectId: session.projectId,
              taskId: session.taskId, title: instruction.slice(0, 200), firstContent: content,
              resourceId: executionScope?.association?.resourceId ?? null,
              conversationMode: "AGENT", assistantProfileId: null, sourceRefs };
            onConversationTargetChange?.({ mode: "AGENT", assistantProfileId: null });
            firstOwner.write({ ...firstOwner.read(), draft: content });
            void createSession(action);
          };
          proceed();
        }}
        composerHeader={composerHeader}
        onInflightChange={setSessionInflight} />
      {!externalReadBlockedReason && embedded && <details className="embedded-assist-sources"><summary>会话与本次资料 · {session.title}</summary>{sessionControls}{sourcePicker}</details>}</>}
  </section>;
}

function canPreview(message: RelayAssistMessage): boolean {
  return message.role === "ASSISTANT" && message.intent === "DISCUSS" && message.skill === null &&
    !message.cancelRequested && (message.status === "PENDING" || message.status === "RUNNING");
}

const messageStatusLabels: Record<RelayAssistMessage["status"], string> = {
  PENDING: "等待生成", RUNNING: "正在生成", COMPLETED: "", FAILED: "生成失败", CANCELLED: "已取消"
};

function messageTime(value: string | null): string {
  const at = value === null ? Number.NaN : Date.parse(value);
  if (!Number.isFinite(at)) return "";
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(at));
}

function messageDay(value: string | null): string | null {
  const at = value === null ? Number.NaN : Date.parse(value);
  if (!Number.isFinite(at)) return null;
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(at)).replaceAll("/", "-");
}

/**
 * 把一个用量比例写成百分比文本，且不让未满的比例显示成 100%。
 * 满额（value === limit）就是 100%，那是真的；整数百分比会四舍五入进位到 100% 而实际未满时
 * 追加小数位，直到不再显示 100%——把 996/1000 说成 100% 会把未命中读成完美命中。
 * 超过上限的读数钳到 100%，不显示分母之外的比率。
 * @param value - 实际用量，Provider 报告的 token 数。
 * @param limit - 该用量的上限；必须是正数，调用方先排除无效上限。
 * @returns 不含 `%` 的百分比文本。
 */
function formatUsagePercent(value: number, limit: number): string {
  if (value >= limit) return "100";
  // Math.round 而非 floor：整数位进位到 100 正是要追加小数位的那种情况，
  // 差一位时（99.6%）追加小数位后仍会得到 100，需要在两位里退回。
  const whole = Math.round(value * 100 / limit);
  // 整数位已低于 100 时就是精确读数，不需要小数位。
  if (whole < 100) return String(whole);
  // 用整数运算判断每个小数位是否仍会进位到 100，避免浮点边界误差。
  for (let places = 1; places <= 2; places += 1) {
    const scale = 10 ** places;
    const scaled = Math.floor(value * 100 * scale / limit);
    if (scaled < 100 * scale) {
      const text = String(scaled).padStart(places + 1, "0");
      return `${text.slice(0, -places)}.${text.slice(-places)}`;
    }
  }
  return "99.99";
}

/**
 * 输入区底栏的用量指示：左文字是缓存命中率，右圆环是最近一次调用的上下文占用。
 * 三种状态必须能区分：没有调用、Provider 未上报、以及有真实读数。缺数据时写"未采集"，
 * 不把 null 画成 0%，也不拿配置值冒充实际用量。
 */
function ContextMeter({ ratio, hitRate, call, limit }: { ratio: number | null;
  hitRate: number | null; call: RelayAssistMessage | null; limit: number | null }) {
  const percent = ratio === null ? null : formatUsagePercent(ratio, 1);
  const high = ratio !== null && ratio >= 0.8;
  const meterText = call === null ? "尚无模型调用"
    : ratio === null ? `输入 ${call.usage.inputTokens ?? "未知"} tokens · 占用不可算`
      : `输入 ${call.usage.inputTokens} / ${limit} tokens（${percent}%）`;
  const hitText = hitRate === null ? "缓存未采集"
    : `缓存命中 ${formatUsagePercent(hitRate, 1)}%`;
  return <div className="agent-chat-usage">
    <span className="agent-chat-usage-text" data-testid="assist-cache-hit">{hitText}</span>
    <span className="agent-chat-context-meter" data-testid="assist-context-meter"
      data-state={ratio === null ? "unknown" : high ? "high" : "normal"}
      role="img" aria-label={`上下文占用 ${meterText}`} title={meterText}>
      <svg viewBox="0 0 36 36" aria-hidden="true" focusable="false">
        <circle className="agent-chat-context-meter-track" cx="18" cy="18" r="15" />
        <circle className="agent-chat-context-meter-fill" cx="18" cy="18" r="15"
          strokeDasharray={ratio === null ? undefined : `${(ratio * 94.25).toFixed(2)} 94.25`} />
      </svg>
      <span className="visually-hidden">{meterText}</span>
    </span>
  </div>;
}

/**
 * AI 消息内的文档候选卡：让"这条回复产出了什么"和正文一起被读到。
 * 只认服务端已存在的 CANDIDATE_MARKDOWN 提案，正文缺失时只显示身份与状态，
 * 不用本地缓存或推断补出候选内容；「查看候选」进入原提案区核对，不在此处接受。
 */
function AssistCandidateCard({ proposal }: { proposal: RelayAssistProposal }) {
  const markdown = proposal.kind === "CANDIDATE_MARKDOWN" && proposal.payloadAvailable
    ? proposal.payload : null;
  const title = markdown === null ? "候选正文暂不可读" : markdown.title;
  const status = proposal.status === "PENDING" ? "待确认"
    : proposal.status === "ACCEPTED" ? "已接受" : proposal.status === "REJECTED" ? "已拒绝" : "已失效";
  return <div className="assist-candidate-card" data-testid={`assist-candidate-${proposal.id}`}>
    <FileText aria-hidden="true" />
    <div className="assist-candidate-copy">
      <p className="assist-candidate-title">{title} · 候选</p>
      <p className="helper-text">{markdown === null ? "来源不可用" : markdown.mediaType} · {status}</p>
    </div>
    <span className="helper-text">查看候选</span>
  </div>;
}

function AssistMessageRow({ client, target, message, preview, previewError, onRetryPreview, writeBlocked, candidates, personaLabel }: { client: RelayApiClient;
  /** 助手档显示冻结人设（名字 · 修订），普通档为 null，仍显示「AI」。 */
  personaLabel: string | null;
  target: AssistTarget | null; message: RelayAssistMessage; writeBlocked: boolean;
  preview: RelayAssistLivePreview | null;
  previewError: PreviewReadError | null; onRetryPreview: () => void;
  candidates: readonly RelayAssistProposal[] }) {
  const user = message.role === "USER";
  const [copyDone, setCopyDone] = useState<string | null>(null);
  // 2026-10-04 按用户要求去掉左右两侧头像：角色已由「我 / AI」标签与气泡位置区分，
  // 头像只是重复占位，还把正文列挤窄。
  return <article className="agent-message" data-role={message.role}>
    <div className="agent-message-body">
    <p className="agent-message-meta"><span className="agent-message-role"
      {...(!user && personaLabel !== null ? { "data-testid": "assist-persona-label" } : {})}
      >{user ? "我" : personaLabel ?? "AI"}</span>
      {messageTime(message.createdAt) !== "" && <time dateTime={message.createdAt ?? undefined}>{messageTime(message.createdAt)}</time>}
      {/* 完成态不占位：正常完成不需要额外标注，未完成和失败必须显式说明。 */}
      {messageStatusLabels[message.status] !== "" && <span className="agent-message-status">
        {messageStatusLabels[message.status]}
        {message.cancelRequested && message.status === "RUNNING" ? "（正在取消）" : ""}</span>}</p>
    {/* 用户输入保持纯文本；只有 AI 最终正文走安全 Markdown，Skill 输出另由 AssistSkillOutput 渲染，避免同一正文出现两次。 */}
    {message.content !== null && user &&
      <p className="assist-message-content">{message.content}</p>}
    {message.content !== null && !user && message.skill === null &&
      <div className="assist-message-content assist-message-markdown"><SafeMarkdown source={message.content} /></div>}
    {canPreview(message) && preview?.previewAvailable && preview.previewText !== null &&
      <div data-testid={`assist-live-preview-${message.id}`}><p className="helper-text">生成中草稿 · 仅当前预览 v{preview.previewRevision}，不是完整消息或已接受产物{preview.previewTruncated ? " · 预览已截断" : ""}</p>
        <p className="assist-message-content">{preview.previewText}</p></div>}
    {canPreview(message) && previewError && <div className="assist-preview-error" role="alert"
      data-testid={`assist-preview-error-${message.id}`}>
      <p>生成预览读取失败：{previewError.message}</p>
      <p className="helper-text">后台回复状态仍以消息为准。{previewError.lastSuccessAt
        ? `最近成功读取：${messageTime(previewError.lastSuccessAt)}。` : "尚未成功读取预览。"}</p>
      <button className="text-link" type="button" disabled={writeBlocked} onClick={onRetryPreview}>重新读取预览</button>
    </div>}
    {message.errorCode && <p className="action-error">生成失败：{message.errorCode}</p>}
    {message.status === "FAILED" && message.providerErrorKind !== null &&
      <p className="helper-text" data-testid="assist-provider-error">模型服务：{modelErrorGuides[message.providerErrorKind]}</p>}
{message.skill && message.role === "ASSISTANT" && message.status === "COMPLETED" &&
      (message.skill.outputAvailability !== "HISTORICAL_SNAPSHOT" || message.skillOutput === null) &&
      <p className="helper-text">Skill 输出当前不可读取；不会展示失效的历史正文或来源引用。</p>}
    {/* 来源条紧跟正文：先回答"这次读了什么"，与正文的阅读顺序一致；诊断类 details 留在下方。 */}
    {message.sources.length > 0 && <details className="assist-source-summary" data-testid={`assist-sources-${message.id}`}>
      <summary><FileText aria-hidden="true" />已读取 {message.sources.length} 份资料
        {message.role === "ASSISTANT" && message.status === "COMPLETED" && " · 生成候选完成"}</summary>
      <ul>
      {message.sources.map((source, index) => {
        const available = source.sourceRef !== null && (message.skill
          ? source.status === "AVAILABLE" : source.status !== "UNAVAILABLE");
        const path = source.kind && source.rootId && source.version && available
          ? `/knowledge?kind=${encodeURIComponent(source.kind)}&item=${encodeURIComponent(source.rootId)}` : null;
        return <li key={index}>{available ? source.sourceRef : "来源不可用"} · {source.status}
          {path && <> · <Link className="inline-link" to={path}>打开来源条目</Link></>}
          {source.reason ? ` · ${source.reason}` : ""}</li>;
      })}
    </ul></details>}
    {/* 文档候选卡紧跟来源条：先说明读了什么，再说明产出了什么。接受仍在提案区，不在此处发生。 */}
    {candidates.map((proposal) => <AssistCandidateCard key={proposal.id} proposal={proposal} />)}
    {message.skillOutput && message.skill?.outputAvailability === "HISTORICAL_SNAPSHOT" &&
      message.role === "ASSISTANT" && message.status === "COMPLETED" &&
      target !== null && <AssistSkillOutput client={client} output={message.skillOutput} currentTarget={target} />}
    {message.skill && <details><summary>Skill 来源与定义</summary><p className="helper-text">
      {message.skill.id} v{message.skill.version}
      {message.skill.sha256 && <> · 定义摘要 {message.skill.sha256}</>}
      {message.skill.definitionAvailability === "HISTORICAL_ONLY" &&
        <> · 冻结历史定义仅可查阅；当前注册表不再提供此版本，不能新调用或接受，不会以新版替换历史来源</>}
      {message.skill.definitionAvailability === "UNAVAILABLE" && <> · 历史定义不可用</>}
      {message.skill.missingCapabilities.length > 0 && <> · 缺少能力 {message.skill.missingCapabilities.join("、")}</>}
    </p></details>}
    {/* 在途反馈只由 meta 行的状态标签与三点承担；停止入口在输入栏主按钮上。
        PENDING 同样算在途：它是「已提交、Worker 尚未领取」。
        三点是「这条还在跑」的持续信号，不再只承担首字前的占位：预览文本到达后
        继续显示，否则流式输出期间那个唯一的活体信号会整段消失，只剩一行静态
        草稿文字，看着像卡住了。取消中不显示——meta 行已经写明「正在取消」。
        「202 回执不等于完成」由 messageStatusLabels 的 COMPLETED:"" 状态机实现，不是聊天文案。 */}
    {message.role === "ASSISTANT" && (message.status === "RUNNING" || message.status === "PENDING") &&
      !message.cancelRequested &&
      <p className="assist-inflight-dots" role="status" data-testid={`assist-inflight-${message.id}`}
        aria-label={message.status === "PENDING" ? "已提交，等待处理，正在生成" : "正在生成"}>
        <i aria-hidden="true" /><i aria-hidden="true" /><i aria-hidden="true" /></p>}
    {message.role === "ASSISTANT" && message.status === "COMPLETED" && <div className="agent-message-footer">
      {/* 单行用量不折叠：只有一行事实；与复制键同排，少占竖直空白。 */}
      <p className="helper-text agent-message-usage" data-testid={`assist-usage-${message.id}`}>用量：输入 {message.usage.inputTokens ?? "未知"}、输出 {message.usage.outputTokens ?? "未知"} tokens</p>
      {/* 纯客户端剪贴板动作：不新增命令、不落库、不假装是已保存的反馈。只有图标，
          可读名称与完成状态都放在 aria-label / title 上。 */}
      <button className="icon-button agent-message-copy" type="button"
        data-testid={`assist-copy-${message.id}`}
        aria-label={copyDone === message.id ? "已复制这条回复" : "复制这条回复"}
        title={copyDone === message.id ? "已复制" : "复制这条回复"}
        onClick={() => void navigator.clipboard?.writeText(message.content ?? "").then(
          () => setCopyDone(message.id), () => setCopyDone(null))}>
        <Copy aria-hidden="true" />
      </button>
    </div>}
    </div>
  </article>;
}

/** 一条 user 消息的状态维护回执本地状态：projection 是服务端事实，其余是交互态。 */
type StateMaintenanceEntry = {
  readonly interpreting: boolean;
  readonly projection: RelayStateMaintenanceRequest | null;
  /** 解释命令身份：失败重试必须沿用同一 command_id。 */
  readonly commandId: string | null;
  readonly error: string | null;
  readonly applying: boolean;
  readonly applyError: string | null;
  readonly withdrawing: boolean;
  /** 撤回命令身份：响应丢失后按原回执核对的事实之一。 */
  readonly withdrawCommandId: string | null;
  readonly withdrawError: string | null;
  /** 两步撤回的第一步：已内联展开待确认。 */
  readonly confirmingUndo: boolean;
  /** 整组有不可撤回项时服务端事前预检的方案（只读）：范围由用户决定，不由客户端猜。 */
  readonly undoPlan: RelayUndoPlan | null;
  /** 用户在方案里勾选的补偿范围；空数组 = 还没决定，不允许提交。 */
  readonly undoScope: readonly string[];
  readonly undoPlanError: string | null;
  /**
   * 决定回复的命令身份（R5）：响应丢失后的重试沿用同一 command_id，
   * 不是每次点击都换新 ID；与展示版本绑定，版本变了才允许新身份。
   */
  readonly decisionCommandId: { readonly commandId: string;
    readonly revision: string } | null;
};
const emptyMaintenanceEntry: StateMaintenanceEntry = { interpreting: false, projection: null,
  commandId: null, error: null, applying: false, applyError: null, withdrawing: false,
  withdrawCommandId: null, withdrawError: null, confirmingUndo: false,
  undoPlan: null, undoScope: [], undoPlanError: null, decisionCommandId: null };

/** 变更行的错误载荷里是否是「与后续修改冲突」：冲突必须与普通失败分开表达。 */
function isConflictError(error: Readonly<Record<string, unknown>> | null): boolean {
  const code = error === null || typeof error.code !== "string" ? null : error.code;
  return code !== null && (code.endsWith("_CONFLICT") || code === "REVISION_CONFLICT");
}

/** 变更行的 error 载荷：常见 code/detail/message 直接读，其余按 JSON 原样核对，不猜语义。 */
function stateChangeErrorText(error: Readonly<Record<string, unknown>> | null): string {
  if (error === null) return "";
  const code = typeof error.code === "string" ? error.code : null;
  const detail = typeof error.detail === "string" ? error.detail
    : typeof error.message === "string" ? error.message : null;
  if (code !== null && detail !== null) return `${code}：${detail}`;
  return detail ?? code ?? JSON.stringify(error);
}

/** 摘要行的「改了什么」：按出现顺序列出变更种类，重复种类只出现一次。 */
function maintenanceKindsText(projection: RelayStateMaintenanceRequest): string {
  const kinds: string[] = [];
  for (const change of projection.changes ?? []) {
    const label = stateMaintenanceChangeKindLabel(change.changeKind);
    if (!kinds.includes(label)) kinds.push(label);
  }
  return kinds.length > 0 ? kinds.join("、") : "项目状态";
}

/** 外部成果核对结果（Slice B / NLS-04）的人话标签；未知值回退原串。 */
const externalSyncResultLabels: Record<string, string> = {
  COMPLETED: "已按原完成记录完成，无需再同步",
  VERIFIED: "验证通过且证据仍适用（完成仍需明确指令）",
  STALE_PASS: "旧的 PASS 已不适用，需要重新核对",
  VERIFICATION_FAILED: "检查未通过（未达 PASS），不判定完成",
  VERIFICATION_PENDING: "检查尚未得出结论，不判定完成",
  NEEDS_HUMAN_ACCEPTANCE: "仍需人工验收，未判定完成",
  EVIDENCE_MISSING: "缺少声明产物的证据，未判定完成",
  READY_FOR_COMPLETION: "既有条件已齐备，等待明确的完成指令"
};

function externalSyncResultText(change: RelayStateMaintenanceChange): string | null {
  if (change.changeKind !== "SYNC_EXTERNAL_RESULT") return null;
  const raw = change.afterRef?.check_result;
  const key = typeof raw === "string" ? raw : "UNKNOWN";
  return externalSyncResultLabels[key] ?? `核对结果：${key}`;
}

/** 自然语言撤回的执行结果（沿原撤回用例的状态词）。 */
function undoStatusLabel(status: unknown): string {
  const labels: Readonly<Record<string, string>> = {
    UNDONE: "原调整已整组撤回",
    UNDO_PARTIAL: "原调整部分撤回",
    UNDO_BLOCKED: "原调整撤回受阻，范围需在原回执上决定",
    DECLINED: "按决定未执行",
  };
  return typeof status === "string" ? labels[status] ?? status : "已执行";
}

/** 摘要行的「结果」：逐条结算如实计数，不给在途或失败编造成功。 */
function maintenanceResultText(projection: RelayStateMaintenanceRequest): string {
  const changes = projection.changes ?? [];
  const applied = changes.filter((change) => change.status === "APPLIED").length;
  const skipped = changes.filter((change) => change.status === "SKIPPED").length;
  const declined = changes.filter((change) => change.status === "DECLINED").length;
  const compensated = changes.filter((change) => change.status === "COMPENSATED").length;
  const failed = changes.filter((change) =>
    change.status === "FAILED" || change.status === "COMPENSATION_FAILED").length;
  const conflicted = changes.filter((change) =>
    (change.status === "FAILED" || change.status === "COMPENSATION_FAILED") &&
    isConflictError(change.error)).length;
  const countSuffix = changes.length > 0 ? ` ${changes.length} 条` : "";
  // 纯核对组不是业务「生效」：摘要如实说核对完成，结果见逐条明细。
  const syncOnly = changes.length > 0 && changes.every((change) =>
    change.changeKind === "SYNC_EXTERNAL_RESULT");
  switch (projection.status) {
    case "READY": return "已就绪，即将生效";
    case "APPLYING": return "正在生效…";
    case "APPLIED": return syncOnly
      ? "外部成果已核对，结果见下方明细"
      : skipped === changes.length && changes.length > 0
        ? "相关事实本来就已经成立，本次没有产生新的变化"
        : `${countSuffix || ""}已全部生效`.trim();
    case "DECLINED": return declined === changes.length
      ? `${countSuffix || ""}按你的决定未执行`.trim()
      : `已生效 ${applied + skipped} 条 · 按你的决定未执行 ${declined} 条`;
    case "PARTIAL": return declined > 0
      ? `已生效 ${applied + skipped} 条 · 按你的决定未执行 ${declined} 条`
      : conflicted > 0
        ? `已生效 ${applied + skipped} 条 · 与后续修改冲突 ${conflicted} 条`
        : `已生效 ${applied + skipped} 条 · 失败 ${failed} 条`;
    case "FAILED": return conflicted > 0 && conflicted === failed
      ? "与后续修改冲突，未生效（当前事实已保留）"
      : `${countSuffix || ""}未生效`.trim();
    case "UNDOING": return `正在撤回${countSuffix}…`;
    case "UNDONE": return `${countSuffix || ""}已整组撤回`.trim();
    case "UNDO_PARTIAL": return `已撤回 ${compensated} 条 · 撤回失败 ${failed} 条`;
    case "UNDO_BLOCKED": return "撤回受阻，已有事实保持原样";
    default: return stateMaintenanceStatusLabel(projection.status);
  }
}

/** 摘要行的「下一步」。 */
function maintenanceNextStepText(projection: RelayStateMaintenanceRequest): string | null {
  switch (projection.status) {
    case "APPLIED": case "PARTIAL": return "可整组撤回本次调整";
    case "DECISION_REQUIRED": return "需要你决定后才会生效";
    default: return null;
  }
}

/** 失败与部分撤回的事实必须在折叠态可见：这些行直接渲染在 details 之外。 */
function isFailedStatus(status: string): boolean {
  return status === "PARTIAL" || status === "FAILED" ||
    status === "UNDO_PARTIAL" || status === "UNDO_BLOCKED";
}

/** 客户端本机时区：只用于把「下周」落成确切 due_local_date，不参与任何授权判断。 */
function localTimezone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

/**
 * 状态维护回执（总纲 §0.8.1）：挂在触发它的 user 消息下方，与执行轨迹摘要同一位置语系。
 * 明确指令自动生效，这里没有「接受」按钮；只有解释重试、撤回确认与按原回执核对三个入口。
 */
function StateMaintenanceReceipt({ entry, onRetry, onWithdraw, onToggleUndoConfirm,
  onReload, onToggleUndoScope, onWithdrawScoped, onCancelUndoPlan, onAnswerDecision }: {
  entry: StateMaintenanceEntry; onRetry: () => void; onWithdraw: () => void;
  onToggleUndoConfirm: () => void; onReload: () => void;
  onToggleUndoScope: (changeId: string) => void; onWithdrawScoped: () => void;
  onCancelUndoPlan: () => void;
  onAnswerDecision: (resolution: "ACCEPT" | "DECLINE", answer: string) => void }) {
  const { projection } = entry;
  const [answer, setAnswer] = useState("");
  if (projection === null) {
    if (entry.interpreting) {
      return <p className="state-maintenance-pending" role="status"
        data-testid="state-maintenance-pending">正在核对状态变更…</p>;
    }
    if (entry.error !== null) {
      return <div className="state-maintenance state-maintenance--attention"
        data-testid="state-maintenance-failed">
        <p className="action-error" role="alert">状态变更核对失败：{entry.error}</p>
        <button className="text-link" type="button" data-testid="state-maintenance-retry"
          onClick={onRetry}>按原命令重试</button>
      </div>;
    }
    return null;
  }
  if (projection.decision === "DISCUSS") return null;
  if (projection.status === "INTERPRETING") {
    return <p className="state-maintenance-pending" role="status"
      data-testid="state-maintenance-pending">正在核对状态变更…</p>;
  }
  if (projection.decision === "CLARIFY") {
    return <div className="state-maintenance" data-testid="state-maintenance-clarify"
      data-status={projection.status}>
      <p className="state-maintenance-summary">这次消息是澄清问题，还没有修改任何项目状态。</p>
      {projection.questions.map((question, index) =>
        <p key={index} className="state-maintenance-question">{question}</p>)}
    </div>;
  }
  const decision = projection.decisionRequired;
  const changes = projection.changes ?? [];
  const failedChanges = changes.filter((change) =>
    (change.status === "FAILED" || change.status === "COMPENSATION_FAILED") &&
    !isConflictError(change.error));
  const conflictChanges = changes.filter((change) =>
    (change.status === "FAILED" || change.status === "COMPENSATION_FAILED") &&
    isConflictError(change.error));
  const skippedChanges = changes.filter((change) => change.status === "SKIPPED");
  const declinedChanges = changes.filter((change) => change.status === "DECLINED");
  const undoCount = changes.filter((change) => change.status === "APPLIED").length;
  // 撤回只接受请求行固化的 undo_command_id；身份未知（历史投影/解析缺失）就不提供入口，
  // 不由客户端新造命令身份绕过服务端校验。
  // 只读核对与自然语言撤回本身没有可补偿的业务效果：不提供「撤回本次调整」入口
  // （服务端计划同样会把它们排除/归为不可撤回，入口与计划保持同源）。
  const compensatableApplied = changes.some((change) => change.status === "APPLIED" &&
    change.changeKind !== "SYNC_EXTERNAL_RESULT" &&
    change.changeKind !== "UNDO_STATE_CHANGE");
  const canWithdraw = (projection.status === "APPLIED" || projection.status === "PARTIAL") &&
    projection.undoCommandId !== "" && compensatableApplied;
  return <div className={`state-maintenance${decision !== null || projection.status === "DECISION_REQUIRED"
    ? " state-maintenance--attention"
    : isFailedStatus(projection.status) ? " state-maintenance--failed" : ""}`}
    data-testid="state-maintenance-receipt" data-status={projection.status}>
    {/* 摘要行：改了什么 + 结果 + 下一步，折叠态可见。 */}
    <p className="state-maintenance-summary">{maintenanceKindsText(projection)} · {maintenanceResultText(projection)}{maintenanceNextStepText(projection) !== null && ` · ${maintenanceNextStepText(projection)}`}</p>
    {/* 待决承诺：只显示影响与那句具体问题，不自动应用；
        回答绑定原请求与展示版本，决定本身不写业务事实。 */}
    {decision !== null && <div data-testid="state-maintenance-decision">
      <p>{decision.summary}</p>
      <p className="state-maintenance-question">{decision.question}</p>
      {decision.affected.length > 0 && <p className="helper-text">涉及：{decision.affected.join("、")}</p>}
      <p className="helper-text">需要你决定后才会生效；这里不会替你回答。</p>
      {projection.status === "DECISION_REQUIRED" && <div className="state-maintenance-answer"
        data-testid="state-maintenance-decision-answer">
        <input type="text" value={answer} data-testid="state-maintenance-decision-input"
          placeholder="用一句话回答这个问题" aria-label="回答这个待决定"
          onChange={(event) => setAnswer(event.target.value)} />
        <button className="secondary-button" type="button"
          data-testid="state-maintenance-decision-accept" disabled={entry.applying ||
            answer.trim() === ""}
          onClick={() => onAnswerDecision("ACCEPT", answer)}>
          {entry.applying ? "正在提交…" : "按这个决定继续"}</button>
        <button className="text-link" type="button"
          data-testid="state-maintenance-decision-decline" disabled={entry.applying ||
            answer.trim() === ""}
          onClick={() => onAnswerDecision("DECLINE", answer)}>不调整</button>
      </div>}
    </div>}
    {(entry.applying || projection.status === "APPLYING") &&
      <p className="helper-text" role="status" data-testid="state-maintenance-applying">正在生效…</p>}
    {/* 冲突/失败/部分生效/部分撤回：折叠态也可见，条目保留在展开区之外。
        冲突是「确认之后又被修改、当前事实已保留」，与普通失败分开表达，绝不显示成全部生效。 */}
    {isFailedStatus(projection.status) && conflictChanges.map((change) =>
      <div key={`conflict-${change.ordinal}`} className="state-maintenance-conflict"
        data-testid={`state-maintenance-conflict-${change.ordinal}`} role="alert">
        <p className="action-error">
          第 {change.ordinal + 1} 条 {stateMaintenanceChangeKindLabel(change.changeKind)} ·
          {" "}与后续修改冲突，本次没有覆盖当前事实</p>
        <p className="helper-text">{stateChangeErrorText(change.error) || "未提供冲突详情"}</p>
      </div>)}
    {isFailedStatus(projection.status) && failedChanges.map((change) =>
      <p key={change.ordinal} className="action-error"
        data-testid={`state-maintenance-failure-${change.ordinal}`} role="alert">
        第 {change.ordinal + 1} 条 {stateMaintenanceChangeKindLabel(change.changeKind)} ·
        {" "}{stateMaintenanceChangeStatusLabel(change.status)}：{stateChangeErrorText(change.error) || "未提供原因"}
      </p>)}
    {skippedChanges.map((change) =>
      <p key={`skipped-${change.ordinal}`} className="helper-text"
        data-testid={`state-maintenance-skipped-${change.ordinal}`}>
        第 {change.ordinal + 1} 条 {stateMaintenanceChangeKindLabel(change.changeKind)} ·
        {" "}已存在，本次没有产生新变化（撤回也不会删除原关系）
      </p>)}
    {/* 拒绝的变更必须与「已生效 / 已存在」分开表达（R1）：折叠态也可见。 */}
    {declinedChanges.map((change) =>
      <p key={`declined-${change.ordinal}`} className="helper-text"
        data-testid={`state-maintenance-declined-${change.ordinal}`}>
        第 {change.ordinal + 1} 条 {stateMaintenanceChangeKindLabel(change.changeKind)} ·
        {" "}按你的决定未执行（没有写入，当前事实保持原样）
      </p>)}
    {/* 外部成果核对与完成（Slice B）：核对结果与完成凭据必须可见，不能并进「已生效」。 */}
    {changes.filter((change) => externalSyncResultText(change) !== null).map((change) =>
      <p key={`sync-${change.ordinal}`} className="helper-text"
        data-testid={`state-maintenance-sync-${change.ordinal}`}>
        第 {change.ordinal + 1} 条 {stateMaintenanceChangeKindLabel(change.changeKind)} ·
        {" "}{externalSyncResultText(change)}
      </p>)}
    {changes.filter((change) => change.changeKind === "COMPLETE_TASK" &&
      (change.status === "APPLIED" || change.status === "SKIPPED")).map((change) =>
      <p key={`complete-${change.ordinal}`} className="helper-text"
        data-testid={`state-maintenance-complete-${change.ordinal}`}>
        第 {change.ordinal + 1} 条 {stateMaintenanceChangeKindLabel(change.changeKind)} ·
        {" "}{change.status === "SKIPPED"
          ? "该任务已按原完成记录完成，本次没有重复完成"
          : "已沿原完成用例提交，完成凭据与人工接受已写入"}
      </p>)}
    {/* 自然语言撤回：结果绑定原调整与原撤回用例，展开明细与折叠态都如实呈现。 */}
    {changes.filter((change) => change.changeKind === "UNDO_STATE_CHANGE" &&
      (change.status === "APPLIED" || change.status === "FAILED")).map((change) =>
      <p key={`undo-${change.ordinal}`} className="helper-text"
        data-testid={`state-maintenance-undo-${change.ordinal}`}>
        第 {change.ordinal + 1} 条 {stateMaintenanceChangeKindLabel(change.changeKind)} ·
        {" "}{change.status === "FAILED"
          ? stateChangeErrorText(change.error) || "撤回未执行"
          : `已沿原撤回用例执行：${undoStatusLabel(
            change.afterRef?.undo_status)}`}
      </p>)}
    {entry.applyError !== null && <div>
      <p className="action-error" role="alert" data-testid="state-maintenance-apply-error">
        生效命令结果待核对：{entry.applyError}</p>
      <p className="helper-text">上面已展示的事实保持原样；请按原回执核对后重读。</p>
      <button className="text-link" type="button" data-testid="state-maintenance-reload"
        onClick={onReload}>按原回执核对</button>
    </div>}
    {entry.withdrawError !== null && <div>
      <p className="action-error" role="alert" data-testid="state-maintenance-withdraw-error">
        撤回命令结果待核对：{entry.withdrawError}。原 command_id：{entry.withdrawCommandId ?? "未登记"}。</p>
      <p className="helper-text">响应丢失不改变已生效事实；请按原回执核对后重读。</p>
      <button className="text-link" type="button" onClick={onReload}>按原回执核对</button>
    </div>}
    {/* 事前预检方案：整组里有不可撤回项时，服务端一项都没执行；
        这里逐条给出原因与影响，由用户勾选**具体范围**再提交——
        通用的「确认整组撤回」不授权后来缩小的方案。 */}
    {entry.undoPlan !== null && <div className="state-maintenance-confirm"
      data-testid="state-maintenance-undo-plan">
      <p className="action-error">这组调整无法整组撤回：以下 {entry.undoPlan.blockedCount} 项
        {" "}不能按原样撤回，刚才没有执行任何补偿。</p>
      {entry.undoPlan.items.filter((item) => !item.withdrawable).map((item) =>
        <div key={item.changeId} data-testid={`undo-plan-blocked-${item.ordinal}`}>
          <p>第 {item.ordinal + 1} 条 {stateMaintenanceChangeKindLabel(item.changeKind)}：
            {" "}{item.reason ?? item.reasonCode ?? "不可撤回"}</p>
          {item.impact !== null && <p className="helper-text">影响：{item.impact}</p>}
        </div>)}
      <p>要撤回哪些仍然可以撤回的变更？</p>
      {entry.undoPlan.items.filter((item) => item.withdrawable).map((item) =>
        <label key={item.changeId} data-testid={`undo-plan-option-${item.ordinal}`}>
          <input type="checkbox" checked={entry.undoScope.includes(item.changeId)}
            onChange={() => onToggleUndoScope(item.changeId)} />
          {" "}第 {item.ordinal + 1} 条 {stateMaintenanceChangeKindLabel(item.changeKind)}
        </label>)}
      {entry.undoPlanError !== null && <p className="action-error" role="alert"
        data-testid="state-maintenance-undo-plan-error">{entry.undoPlanError}</p>}
      <button className="secondary-button" type="button"
        data-testid="state-maintenance-withdraw-scope" disabled={entry.withdrawing ||
          entry.undoScope.length === 0}
        onClick={onWithdrawScoped}>{entry.withdrawing ? "正在撤回…" : "按所选范围撤回"}</button>
      {!entry.withdrawing && <button className="text-link" type="button"
        data-testid="state-maintenance-undo-plan-cancel" onClick={onCancelUndoPlan}>先不撤回</button>}
    </div>}
    {/* 两步撤回：第一步只展开清单，第二次点击确认才真正 POST；确认后按钮进入「正在撤回…」，
        直到结果落地——响应丢失时由 withdrawError 行接管，不在途与结果之间留空档。 */}
    {canWithdraw && entry.undoPlan === null && !entry.confirmingUndo && !entry.withdrawing &&
      <button className="secondary-button" type="button" data-testid="state-maintenance-withdraw"
        onClick={onToggleUndoConfirm}>撤回本次调整</button>}
    {canWithdraw && entry.undoPlan === null && (entry.confirmingUndo || entry.withdrawing) && <div className="state-maintenance-confirm"
      data-testid="state-maintenance-undo-confirm">
      <p>{undoCount > 0 ? `将撤回：${undoCount} 条变更（${changes
        .filter((change) => change.status === "APPLIED")
        .map((change) => stateMaintenanceChangeKindLabel(change.changeKind)).join("、")}）`
        : "将撤回：本次已生效的全部变更。"}</p>
      <p className="helper-text">已推进的部分可能撤回失败并逐条显示；补偿按原变更的逆序执行。</p>
      <button className="secondary-button" type="button" data-testid="state-maintenance-withdraw-confirm"
        disabled={entry.withdrawing} onClick={onWithdraw}>{entry.withdrawing ? "正在撤回…" : "确认撤回"}</button>
      {!entry.withdrawing && <button className="text-link" type="button"
        data-testid="state-maintenance-undo-cancel" onClick={onToggleUndoConfirm}>先不撤回</button>}
    </div>}
    <details className="state-maintenance-details">
      <summary>逐条明细与命令身份</summary>
      <p className="helper-text">请求 {projection.requestId} · 基准修订 v{projection.revision} ·
        {" "}状态 {stateMaintenanceStatusLabel(projection.status)}</p>
      {changes.length === 0 && <p className="helper-text">这次没有逐条变更事实可展示。</p>}
      <ul className="state-maintenance-items" data-testid="state-maintenance-items">
        {changes.map((change) => <li key={change.ordinal} data-status={change.status}
          data-testid={`state-maintenance-item-${change.ordinal}`}>
          第 {change.ordinal + 1} 条 · {stateMaintenanceChangeKindLabel(change.changeKind)} ·
          {" "}{stateMaintenanceChangeStatusLabel(change.status)}
          {change.beforeRef !== null && <pre className="state-maintenance-ref">变更前 {JSON.stringify(change.beforeRef)}</pre>}
          {change.afterRef !== null && <pre className="state-maintenance-ref">变更后 {JSON.stringify(change.afterRef)}</pre>}
          {change.error !== null && <p className="action-error">{stateChangeErrorText(change.error)}</p>}
          <p className="helper-text">命令 {change.commandId}</p>
        </li>)}
      </ul>
    </details>
  </div>;
}

function AssistSessionPanel({ client, session, target, sources, writeBlockedReason,
  refreshTarget, clearSentSources, standalone, onNavigationStateChange, sourcesOpen, onToggleSources,
  sourcePicker, preferredSkillId, embedded, externalReadBlockedReason, proposalActionHost,
  executionScope, onExecutionPrepared, initialExecution, confirmedFirstMessageCommandId,
  initialMaintenance, modeSwitch, onInflightChange, composerHeader, onLearningTransfer, recordLearning = true,
  onChatSessionCreated }: { client: RelayApiClient;
  session: RelayAssistSession; target: AssistTarget | null; sources: readonly RelayAssistSourceRef[];
  writeBlockedReason: string | null;
  refreshTarget: () => Promise<void>;
  onChatSessionCreated: (session: RelayAssistSession) => void;
  clearSentSources: (sent: readonly RelayAssistSourceRef[]) => void;
  standalone: boolean; onNavigationStateChange: (state: AssistNavigationState) => void;
  sourcesOpen: boolean; onToggleSources: () => void;
  sourcePicker: ReactNode; preferredSkillId?: string; embedded?: boolean;
  externalReadBlockedReason: string | null; proposalActionHost?: HTMLElement | null;
  executionScope?: RelayWorkingDirectory | null;
  onExecutionPrepared?: ((taskId: string) => void) | undefined;
  /** 首条消息的解释结果：交给本面板既有 Owner 渲染与执行，避免出现第二套确认门。 */
  initialExecution?: RelayConversationExecution | null;
  confirmedFirstMessageCommandId?: string | null;
  /** 首条消息的状态维护解释结果：同样由本面板按 requestId 接手渲染。 */
  initialMaintenance?: RelayStateMaintenanceRequest | null;
  /** 会话模式控件由外层持有（它才有会话与导航事实），面板只负责放在工具行左侧。 */
  modeSwitch?: ReactNode;
  onLearningTransfer?: (instruction: string, background: string, sourceRefs: readonly RelayAssistSourceRef[]) => void;
  recordLearning?: boolean;
  /**
   * 在途状态上报。切档不是停止，禁用判定必须在真正看得见在途的那一层做，
   * 所以由面板把事实送上去，而不是外层另猜一份。
   */
  onInflightChange?: (inflight: boolean) => void;
  /** 输入区上方的常驻槽位（文件夹作用域细条）。本面板只负责把它渲染在输入卡正上方。 */
  composerHeader?: ReactNode }) {
  /**
   * 助手档：只读回答。这一档没有 Task、没有提案、没有执行链，
   * 所以下面凡是「按这个执行」的出口都不渲染，而不是渲染成禁用加解释。
   */
  const assistantMode = session.conversationMode === "ASSISTANT";
  const learningMode = session.conversationMode === "LEARNING";
  const readonlyMode = session.conversationMode !== "AGENT";
  const [learningState, setLearningState] = useState<RelayLearningState | null>(null);
  const [learningNavigation, setLearningNavigation] = useState<AssistNavigationState>(cleanNavigationState);
  const [messages, setMessages] = useState<readonly RelayAssistMessage[] | null>(null);
  const [execution, setExecution] = useState<RelayConversationExecution | null>(initialExecution ?? null);
  // 首条解释结果可能在本面板挂载之后才到达（建会话后协作页按会话 key 重挂载过）。
  // 只在它确实换了 request_id 时接手，避免覆盖用户自己在本面板发起的解释。
  const adoptedRequestId = useRef<string | null>(initialExecution?.requestId ?? null);
  useEffect(() => {
    const incoming = initialExecution ?? null;
    if (incoming === null || adoptedRequestId.current === incoming.requestId) return;
    adoptedRequestId.current = incoming.requestId;
    setExecution(incoming);
  }, [initialExecution]);
  const [executionBusy, setExecutionBusy] = useState(false);
  const [executionError, setExecutionError] = useState<string | null>(null);
  const [previews, setPreviews] = useState<Readonly<Record<string, RelayAssistLivePreview>>>({});
  const [previewErrors, setPreviewErrors] = useState<Readonly<Record<string, PreviewReadError>>>({});
  const [previewRetry, setPreviewRetry] = useState(0);
  const [proposals, setProposals] = useState<readonly RelayAssistProposal[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [intent, setIntent] = useState<AssistIntent>("DISCUSS");
  const [skills, setSkills] = useState<readonly RelaySkillDefinition[]>([]);
  const [skillError, setSkillError] = useState<string | null>(null);
  const [selectedSkillKey, setSelectedSkillKey] = useState("");
  const [skillInputText, setSkillInputText] = useState("");
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [busy, setBusy] = useState(false);
  const composerFormId = useId();
  const requestVersion = useRef(0);
  const disposed = useRef(false);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const transcriptContentRef = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  const [atLatest, setAtLatest] = useState(true);
  const previewSuccessAt = useRef<Record<string, string>>({});
  /* 刚提交、尚未在消息列表里可见的那条 ASSISTANT 回复的 id。
     不用「有没有在途消息」推导：消息列表要等 refresh() 回来才带上新行，
     那之前输入器会短暂呈现「无在途」，随后又跳到在途，读起来就是一下闪。
     它只记 id，不缓存状态——真正在途与否仍读服务端那条消息的行。
     存在期间输入器保持在途，直到查询回来看见这条消息的终态。 */
  const [awaitingAssistantId, setAwaitingAssistantId] = useState<string | null>(null);
  useEffect(() => { setAwaitingAssistantId(null); }, [session.id]);
  const skillPreferenceApplied = useRef(false);
  /** Esc Esc 的第一次按键：记下它指向的那条 RUNNING 回复，超过间隔或换了回复就失效。 */
  const stopSequence = useRef<{ readonly messageId: string; readonly deadline: number } | null>(null);
  const [callLimit, setCallLimit] = useState<number | null>(null);
  useEffect(() => {
    let active = true;
    // 圆环分母只用于表达"这次调用占了多少预算"。读不到就留空，不拿别的数字顶替。
    void client.getModelPortStatus().then((status) => {
      if (active) setCallLimit(status.maxCallTokens);
    }).catch(() => { if (active) setCallLimit(null); });
    return () => { active = false; };
  }, [client]);
  const discardDraft = useCallback(() => {
    if (pending || busy) return;
    setDraft(""); setSkillInputText(""); setSelectedSkillKey(""); setIntent("DISCUSS");
  }, [pending, busy]);
  /** 会话输入器的存活恢复目标：textarea 优先，输入器容器兜底（见 restoreComposerFocus）。 */
  const draftRef = useRef<HTMLTextAreaElement | null>(null);
  const composerBoxRef = useRef<HTMLDivElement | null>(null);
  const restoreDraftFocus = useCallback(() => {
    restoreComposerFocus(draftRef.current, composerBoxRef.current);
  }, []);

  useLayoutEffect(() => {
    const transcript = transcriptRef.current;
    if (standalone && transcript && transcript.clientHeight > 0 && followLatest.current)
      transcript.scrollTop = transcript.scrollHeight;
  }, [standalone, messages, previews, proposals]);
  useLayoutEffect(() => {
    const transcript = transcriptRef.current;
    const content = transcriptContentRef.current;
    if (!standalone || !transcript || !content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      // 隐藏布局不能重置阅读意图；再次显示时由尺寸通知继续原来的跟随状态。
      if (followLatest.current && transcript.clientHeight > 0) transcript.scrollTop = transcript.scrollHeight;
    });
    observer.observe(transcript); observer.observe(content);
    return () => observer.disconnect();
  }, [standalone, externalReadBlockedReason]);
  useEffect(() => {
    if (!standalone && !embedded) return;
    onNavigationStateChange({ dirty: learningNavigation.dirty || Boolean(draft.trim() || skillInputText.trim() || (standalone && (selectedSkillKey || intent !== "DISCUSS"))),
      discard: () => { discardDraft(); learningNavigation.discard?.(); },
      pending: pending ? { commandId: pending.commandId,
        commandType: pending.kind === "send" ? "RequestAssistMessage" : pending.kind === "cancel"
          ? "CancelAssistMessage" : pending.kind === "restart" ? "ExecuteChatCommand"
            : "AcceptAssistProposal", sessionId: session.id } : learningNavigation.pending,
      restoreFocus: restoreDraftFocus });
  }, [standalone, embedded, draft, skillInputText, selectedSkillKey, intent, pending, session.id,
    onNavigationStateChange, discardDraft, restoreDraftFocus, learningNavigation]);

  /* 查询到终态就撤销本地在途标记：此时服务端消息已能说明真实状态，
     继续显示装饰等于用本地推断冒充事实。传输失败保留标记，
     因为那正是「结果待核对」而非「已结束」。 */
  async function refresh() {
    const version = ++requestVersion.current;
    try {
      const [nextMessages, nextProposals] = await Promise.all([
        client.getAssistMessages(session.id), client.getAssistProposals(session.id)]);
      if (disposed.current || version !== requestVersion.current || client !== liveClient()) return;
      if (nextMessages.some((item) => item.sessionId !== session.id) ||
          nextProposals.some((item) => item.sessionId !== session.id)) throw new Error("Assist 查询返回了其他会话的内容。");
      setMessages(nextMessages); setProposals(nextProposals); setError(null);
      // 成功读到权威状态后，等待标记只在该回复行真的出现时撤销：
      // 出现之前保持等待，避免提交瞬间出现空档。传输失败不撤销——
      // 那正是「结果待核对」，不是「已结束」。
      setAwaitingAssistantId((waiting) => waiting !== null &&
        nextMessages.some((item) => item.id === waiting) ? null : waiting);
    } catch (caught) { if (!disposed.current && version === requestVersion.current) {
      setMessages(null); setProposals([]); setPreviews({}); setPreviewErrors({}); setError(describeLiveError(caught).message);
    } }
  }
  useEffect(() => {
    disposed.current = false; void refresh();
    return () => { disposed.current = true; requestVersion.current++; };
  }, [client, session.id, confirmedFirstMessageCommandId]);
  async function loadSkills() {
    if (target === null || readonlyMode) { setSkills([]); setSkillError(null); return; }
    try {
      const items = await client.getFirstPartySkills();
      if (disposed.current || client !== liveClient()) return;
      const supported = items.filter((item) => item.target === target.kind &&
        supportedSkillOutput[item.id] === item.outputKind).sort((a, b) =>
        a.id === b.id ? b.version.localeCompare(a.version, undefined, { numeric: true }) :
          a.id.localeCompare(b.id));
      setSkills(supported); setSkillError(null);
      if (!skillPreferenceApplied.current && preferredSkillId) {
        const preferred = supported.find((item) => item.id === preferredSkillId && item.callSupported);
        if (preferred) setSelectedSkillKey(`${preferred.id}@${preferred.version}`);
        skillPreferenceApplied.current = true;
      }
    } catch (caught) {
      if (!disposed.current) { setSkills([]); setSkillError(describeLiveError(caught).message); }
    }
  }
  useEffect(() => { void loadSkills(); }, [client, target?.kind, readonlyMode]);
  useEffect(() => {
    if (!messages?.some((item) => item.role === "ASSISTANT" && (item.status === "PENDING" || item.status === "RUNNING"))) return;
    const timer = window.setInterval(() => { void refresh(); }, 1500);
    return () => window.clearInterval(timer);
  }, [messages, client, session.id]);

  const previewIds = messages?.filter(canPreview).map((item) => item.id).join("|") ?? "";
  useEffect(() => {
    const ids = new Set(previewIds ? previewIds.split("|") : []);
    setPreviews((current) => {
      const kept = Object.fromEntries(Object.entries(current).filter(([id]) => ids.has(id) && writeBlockedReason === null));
      return Object.keys(kept).length === Object.keys(current).length ? current : kept;
    });
    setPreviewErrors((current) => Object.fromEntries(Object.entries(current).filter(([id]) => ids.has(id))));
    if (ids.size === 0 || writeBlockedReason !== null) return;
    let active = true;
    let timer: number | undefined;
    async function poll() {
      await Promise.all([...ids].map(async (messageId) => {
        try {
          const next = await client.getAssistLivePreview(session.id, messageId);
          if (!active || disposed.current || client !== liveClient()) return;
          setPreviewErrors((current) => { const copy = { ...current }; delete copy[messageId]; return copy; });
          if (next.status !== "PENDING" && next.status !== "RUNNING") {
            ids.delete(messageId);
            setPreviews((current) => { const copy = { ...current }; delete copy[messageId]; return copy; });
            void refresh();
          } else if (!next.previewAvailable || next.previewText === null) {
            setPreviews((current) => { const copy = { ...current }; delete copy[messageId]; return copy; });
          } else {
            previewSuccessAt.current[messageId] = new Date().toISOString();
            setPreviews((current) => ({ ...current, [messageId]: next }));
          }
        } catch (caught) {
          if (!active || disposed.current) return;
          setPreviews((current) => { const copy = { ...current }; delete copy[messageId]; return copy; });
          setPreviewErrors((current) => ({ ...current, [messageId]: {
            message: describeLiveError(caught).message, lastSuccessAt: previewSuccessAt.current[messageId] ?? null
          } }));
          ids.delete(messageId);
          if (caught instanceof RelayApiError && (caught.problem.status === 404 || caught.problem.status === 403)) {
            void refresh();
          }
        }
      }));
      if (active && ids.size > 0) timer = window.setTimeout(() => { void poll(); }, 400);
    }
    void poll();
    return () => { active = false; if (timer !== undefined) window.clearTimeout(timer); };
  }, [previewIds, previewRetry, client, session.id, writeBlockedReason]);

  async function finishChatSession(result: RelayChatSessionResult) {
    try {
      const created = await client.getAssistSession(result.sessionId);
      if (created.id !== result.sessionId || created.projectId !== session.projectId ||
        created.taskId !== session.taskId || created.conversationMode !== session.conversationMode ||
        created.assistantProfileId !== session.assistantProfileId ||
        created.assistantProfileRevision !== session.assistantProfileRevision ||
        result.projectId !== created.projectId || result.taskId !== created.taskId ||
        result.conversationMode !== created.conversationMode || result.assistantProfileId !== created.assistantProfileId ||
        result.assistantProfileRevision !== created.assistantProfileRevision) throw new Error("session mismatch");
      if (disposed.current || client !== liveClient()) return;
      setPending(null); setDraft("");
      onNavigationStateChange(cleanNavigationState);
      onChatSessionCreated(created);
    } catch { throw new RelayTransportError("新会话已返回回执，但详情尚未核对。请查询原命令回执后接续。"); }
  }
  async function runAction(action: PendingAction, retry = false) {
    if (busy || (!retry && (pending !== null || writeBlockedReason !== null)) ||
      (retry && pending !== action)) return;
    setBusy(true); setPending(action); setActionError(null); setNotice(null);
    try {
      if (action.kind === "restart") {
        const result = await client.restartAssistSession({ sessionId: session.id, commandId: action.commandId,
          text: action.content, system: action.system });
        await finishChatSession(result);
        return;
      } else if (action.kind === "send") {
        followLatest.current = true; setAtLatest(true);
        const common = { sessionId: session.id, commandId: action.commandId,
          content: action.content, sourceRefs: action.sources,
          ...(action.recordLearning === undefined ? {} : { recordLearning: action.recordLearning }) };
        // 只有普通 DISCUSS 消息会被解释成执行候选；Skill 与提案意图保持原语义。
        const interpretable = !readonlyMode && (action.skillRef === null || action.skillRef === undefined);
        // 三条分支是排他的：助手档既没有 intent 也没有 skill_ref，载荷里两个都不出现。
        const sent = action.skillRef && action.skillInput
          ? await client.requestAssistMessage({ ...common, skillRef: action.skillRef, skillInput: action.skillInput })
          : action.intent
            ? await client.requestAssistMessage({ ...common, intent: action.intent })
            : readonlyMode
              ? await client.requestAssistMessage(common)
              : await client.requestAssistMessage({ ...common, intent: action.intent ?? "DISCUSS" });
        if (disposed.current) return;
        setDraft(""); clearSentSources(action.sources);
        // 202 只表示已提交，回复行可能还没出现在列表里。记下它的 id，
        // 让输入器从这一刻起就保持途，不等 refresh() 回来——
        // 否则会在「无在途」与「在途」之间跳一下，读起来是一下闪。
        if (sent.assistantMessageId !== null && sent.assistantMessageId !== undefined) {
          setAwaitingAssistantId(sent.assistantMessageId);
        }
        // 2026-10-04 按用户判断去掉「消息已排队」：这条只是复述已提交的 202 回执，
        // 不携带新事实；消息本身的 PENDING/RUNNING 状态已经在消息行里说明。
        // 其余 notice（取消、提案回执、原命令回执）仍保留，它们各自说明不同的结果。
        if (interpretable) void requestExecution(sent.userMessageId);
        // 状态维护解释与执行解释同一时机触发：项目绑定的普通档会话才解释，助手档完全不触发。
        if (interpretable && !readonlyMode && session.projectId !== null) {
          void requestStateMaintenance(sent.userMessageId);
        }
      } else if (action.kind === "cancel") {
        const status = await client.cancelAssistMessage(action.id, action.commandId);
        if (disposed.current) return;
        setNotice(status === "RUNNING" ? "取消意图已提交，等待生成安全结束。" : "消息已由服务端确认取消。");
      } else if (action.kind === "acceptTask") {
        const receipt = await client.acceptAssistProposal(action.id, action.commandId, {
          expectedTaskRevision: action.expectedTaskRevision,
          expectedAcceptanceRevision: action.expectedAcceptanceRevision,
          payloadHash: action.payloadHash });
        if (!receiptMatches({ ...receipt, commandType: "AcceptAssistProposal" }, action, session.id)) {
          throw new Error("Task 验收变更回执与原提案不匹配。");
        }
        if (disposed.current) return;
        setNotice(`提案已接受；Task v${receipt.result.revision} / 验收 v${receipt.result.acceptance_revision}。请重新读取当前准入预览。`);
        void refreshTarget();
      } else {
        await client.acceptAssistProposal(action.id, action.commandId);
        if (disposed.current) return;
        setNotice("提案接受回执已提交；业务结果以刷新后的目标与提案状态为准。");
      }
      setPending(null); await refresh();
    } catch (caught) {
      if (disposed.current) return;
      const described = describeLiveError(caught);
      if (described.kind !== "transport") setPending(null);
      setActionError(described.kind === "conflict" && action.kind === "acceptTask"
        ? `${described.message} 原提案仍保留供核对，不能覆盖当前验收；请重新生成提案。`
        : described.message);
      if (described.kind === "conflict" || described.kind === "transition") {
        void refresh(); void refreshTarget();
      }
    } finally { if (!disposed.current) setBusy(false); }
  }
  async function checkReceipt() {
    if (!pending || busy) return;
    setBusy(true); setActionError(null);
    try {
      const receipt = await client.getCommandReceipt(pending.commandId);
      if (disposed.current) return;
      if (!receiptMatches(receipt, pending, session.id)) throw new Error("回执与本次 Assist 命令不匹配。");
      if (pending.kind === "restart") {
        await finishChatSession(chatSessionResultFrom(receipt.result, session.id, pending.system));
        return;
      }
      if (pending.kind === "send") { setDraft(""); clearSentSources(pending.sources); }
      if (pending.kind === "acceptTask") void refreshTarget();
      setPending(null); setNotice("原命令回执已核对；正在读取服务端状态。"); await refresh();
    } catch (caught) { if (!disposed.current) setActionError(describeLiveError(caught).message); }
    finally { if (!disposed.current) setBusy(false); }
  }
  function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const content = draft.trim();
    if (!content || content.length > 32768 || pending || busy || writeBlockedReason !== null) return;
    const control = chatControlFromText(content);
    if (control !== null) {
      setActionError(null); setNotice(null);
      if (composerInflight) { setActionError("当前消息仍在生成，请先停止并等结算后使用会话命令。"); return; }
      if (control === "model" || control === "compact") { setActionError("模型切换与上下文压缩暂未接通。"); return; }
      if (/\s/u.test(content)) { setActionError("此会话命令不接受参数，请单独输入命令。"); return; }
      if (control === "undo") {
        setNotice(readonlyMode ? "此会话对项目只读；请回到原普通会话的调整回执撤回。"
          : "请在要撤回的消息下找到调整回执，点击「撤回本次调整」；按具体回执核对范围。文件不回退。");
        return;
      }
      if (sources.length > 0 || skillInputText.trim() || learningNavigation.dirty || learningNavigation.pending !== null) {
        setActionError("请先处理未发资料、补充输入或学习记录草稿，再新建会话。"); return;
      }
      if ([...maintenanceRef.current.values()].some((entry) => entry.applying || entry.withdrawing || entry.interpreting)) {
        setActionError("状态调整尚未结算，请等原回执完成后再新建会话。"); return;
      }
      void runAction({ kind: "restart", commandId: createCommandId(), content, system: control });
      return;
    }
    const skill = skills.find((item) => `${item.id}@${item.version}` === selectedSkillKey);
    if (selectedSkillKey && (!skill || !skill.callSupported || skill.missingCapabilities.length > 0)) return;
    const input = skillInputText.trim();
    if (input.length > 2000) return;
    const skillInput: RelaySkillInput | null = !skill ? null : skill.id === "task-to-execution-contract"
      ? input ? { desired_result: input } : {}
      : skill.id === "project-resume" ? input ? { focus: input } : {}
        : input ? { risk_focus: input } : {};
    const commandId = createCommandId();
    // 助手档不传 intent 也不传 skill_ref：服务端会以 409 拒绝这两者，
    // 客户端不把它们塞进载荷，省掉一次注定失败的往返。
    void runAction({ kind: "send", commandId, content,
      intent: readonlyMode || skill ? null : intent,
      skillRef: readonlyMode || !skill ? null : { id: skill.id, version: skill.version },
      skillInput: readonlyMode ? null : skillInput,
      ...(learningMode ? { recordLearning } : {}),
      sources: sources.map((ref) => ({ ...ref })) });
  }

  /** 整理一条刚发出的用户消息；结果只作为候选展示，缺关键信息时退回一个聚焦澄清。 */
  async function requestExecution(sourceMessageId: string) {
    const resourceId = executionScope?.association?.resourceId ?? null;
    if (readonlyMode || resourceId === null || disposed.current || executionBusy) return;
    setExecutionBusy(true); setExecutionError(null);
    try {
      const next = await client.interpretConversationMessage({ sessionId: session.id,
        sourceMessageId, resourceId, commandId: createCommandId() });
      if (!disposed.current) setExecution(next);
    } catch (caught) {
      if (!disposed.current) setExecutionError(describeLiveError(caught).message);
    } finally { if (!disposed.current) setExecutionBusy(false); }
  }

  /** 候选 → Task/READY/Delegate。按请求行固定的命令身份重放，不产生第二个 Task/Run。 */
  async function applyExecution(requestId: string) {
    if (disposed.current || executionBusy) return;
    setExecutionBusy(true); setExecutionError(null);
    async function refreshRequest() {
      const next = (await client.getConversationExecutionRequests(session.id))
        .find((item) => item.requestId === requestId) ?? null;
      if (!disposed.current && next !== null) setExecution((previous) => ({
        ...(previous?.requestId === requestId ? previous : {}), ...next,
        resourceId: executionScope?.association?.resourceId ?? "", sessionId: session.id }));
      return next;
    }
    try {
      await client.applyConversationExecution(requestId);
      const next = await refreshRequest();
      if (disposed.current) return;
      if (next === null) throw new Error("执行响应已返回，但尚未读到原请求，请稍后核对。");
      if (next?.status === "DELEGATED" && next.runId !== null && next.taskId !== null &&
          next.autoStart !== true) onExecutionPrepared?.(next.taskId);
    } catch (caught) {
      try {
        const next = await refreshRequest();
        if (!disposed.current) setExecutionError(next?.status === "DELEGATED" && next.runId !== null
          ? null : describeLiveError(caught).message);
      } catch {
        if (!disposed.current) setExecutionError(`${describeLiveError(caught).message} 原请求阶段尚未核对，请稍后继续原请求。`);
      }
    } finally { if (!disposed.current) setExecutionBusy(false); }
  }

  /**
   * 明确的只读执行请求直接启动（工作台 §18.2 / ADR-016）。
   *
   * 放这里而不是解释回调里：刷新或重挂载后读到同一条 READY 投影同样要补上启动，
   * 否则「已经明确要求查看」会在重新打开页面时退回等待确认。写意图的请求不在此列——
   * 判定由服务端那条与实际授予工具集同源的规则给出（`auto_start`），本组件不自己判断。
   * 幂等由原 `request_id` 与请求行固定的三个阶段命令身份保证：重复触发只重放原回执。
   */
  const autoStartedRequestIds = useRef<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const request = execution;
    if (request === null || request.autoStart !== true || executionBusy || executionError !== null) return;
    if (request.runId !== null || request.candidateStatus !== "READY") return;
    if (!["READY", "TASK_PREPARED", "FAILED"].includes(request.status)) return;
    if (autoStartedRequestIds.current.has(request.requestId)) return;
    autoStartedRequestIds.current = new Set([...autoStartedRequestIds.current, request.requestId]);
    void applyExecution(request.requestId);
  }, [execution, executionBusy, executionError]);

  /* ── 对话状态维护（总纲 §0.8.1）──────────────────────────────────
     触发与执行解释同一时机：项目绑定的普通档会话里一条 user 消息发送完成后解释一次。
     明确指令（MAINTAIN 且无 decision_required）自动沿 applications 入口生效，
     不弹确认框、不加接受按钮；带待决承诺只显示影响与问题；DISCUSS 静默。
     回执挂在原 user 消息下方，摘要＋展开；会话切换由 key 重挂载与 disposed 守卫兜住。 */
  const [maintenance, setMaintenance] = useState<ReadonlyMap<string, StateMaintenanceEntry>>(
    () => new Map());
  const maintenanceRef = useRef<ReadonlyMap<string, StateMaintenanceEntry>>(maintenance);
  /** 同步写 ref 与 state：在途判定读 ref，渲染读 state，两者不出现两套事实。 */
  function patchMaintenance(sourceMessageId: string, patch: Partial<StateMaintenanceEntry> | null) {
    const next = new Map(maintenanceRef.current);
    if (patch === null) next.delete(sourceMessageId);
    else next.set(sourceMessageId, { ...emptyMaintenanceEntry, ...next.get(sourceMessageId), ...patch });
    maintenanceRef.current = next;
    setMaintenance(next);
  }
  /** 会话已有的维护请求：按 source_message_id 归位到各条 user 消息下。助手档与未归属会话没有维护事实。 */
  useEffect(() => {
    if (readonlyMode || session.projectId === null) {
      maintenanceRef.current = new Map(); setMaintenance(new Map());
      return;
    }
    let active = true;
    void client.getConversationStateRequests(session.id).then((requests) => {
      if (!active) return;
      const next = new Map<string, StateMaintenanceEntry>();
      for (const projection of requests) {
        next.set(projection.sourceMessageId, { ...emptyMaintenanceEntry, projection });
      }
      maintenanceRef.current = next; setMaintenance(next);
    }).catch(() => {
      // 读不到就不显示既有回执，不猜「大概没有维护过」；新发送的解释不受影响。
      if (active) { maintenanceRef.current = new Map(); setMaintenance(new Map()); }
    });
    return () => { active = false; };
  }, [client, session.id, session.projectId, readonlyMode]);
  // 首条消息的解释结果可能在本面板挂载后才到达（建会话后按会话 key 重挂载过）。
  const adoptedMaintenanceRequestId = useRef<string | null>(initialMaintenance?.requestId ?? null);
  useEffect(() => {
    const incoming = initialMaintenance ?? null;
    if (incoming === null || adoptedMaintenanceRequestId.current === incoming.requestId) return;
    adoptedMaintenanceRequestId.current = incoming.requestId;
    patchMaintenance(incoming.sourceMessageId, { projection: incoming });
  }, [initialMaintenance]);

  async function requestStateMaintenance(sourceMessageId: string, retryCommandId: string | null = null) {
    if (client !== liveClient() || disposed.current || readonlyMode || session.projectId === null) return;
    const existing = maintenanceRef.current.get(sourceMessageId);
    // 同一原消息只解释一次：在途或已有投影时不再发第二条解释命令；服务端亦按原消息去重。
    if (existing !== undefined && (existing.interpreting || existing.projection !== null)) return;
    const commandId = retryCommandId ?? createCommandId();
    patchMaintenance(sourceMessageId, { interpreting: true, commandId, error: null });
    try {
      const projection = await client.createStateMaintenanceRequest({ sessionId: session.id,
        sourceMessageId, commandId, timezone: localTimezone() });
      if (disposed.current) return;
      if (projection.sessionId !== session.id || projection.sourceMessageId !== sourceMessageId) {
        patchMaintenance(sourceMessageId, { interpreting: false,
          error: "状态维护请求与原会话或消息不匹配。" });
        return;
      }
      patchMaintenance(sourceMessageId, { interpreting: false, projection, error: null });
    } catch (caught) {
      if (disposed.current) return;
      patchMaintenance(sourceMessageId, { interpreting: false, error: describeLiveError(caught).message });
    }
  }

  /** 解释失败的重试入口：沿用原解释 command_id，不产生第二个命令身份。 */
  function retryStateMaintenance(sourceMessageId: string) {
    const entry = maintenanceRef.current.get(sourceMessageId);
    if (entry === undefined || entry.commandId === null) return;
    void requestStateMaintenance(sourceMessageId, entry.commandId);
  }

  async function applyStateMaintenance(sourceMessageId: string, requestId: string) {
    if (disposed.current) return;
    const entry = maintenanceRef.current.get(sourceMessageId);
    if (entry === undefined || entry.applying || entry.withdrawing || entry.projection === null) return;
    patchMaintenance(sourceMessageId, { applying: true, applyError: null });
    try {
      const result = await client.applyConversationStateRequest(requestId);
      if (disposed.current) return;
      const projection = maintenanceRef.current.get(sourceMessageId)?.projection ?? null;
      patchMaintenance(sourceMessageId, { applying: false,
        projection: projection === null ? null : { ...projection, status: result.status,
          revision: result.revision, changes: result.changes ?? projection.changes,
          undoCommandId: result.undoCommandId } });
    } catch (caught) {
      if (disposed.current) return;
      // 生效结果待核对：不清空已展示的投影事实；按原回执核对后重读。
      patchMaintenance(sourceMessageId, { applying: false, applyError: describeLiveError(caught).message });
    }
  }

  // 明确指令自动生效：MAINTAIN 且还有未被连带决定挡住的 PENDING 变更时沿 applications 入口生效。
  // 放在 effect 里而不是解释回调里，恢复路径（重挂载后读到 READY）同样自动补上生效；
  // 被决定挡住的条目不触发调用，也不会因为 409 反复重试。
  useEffect(() => {
    for (const [sourceMessageId, entry] of maintenance) {
      const projection = entry.projection;
      if (projection === null || entry.applying || entry.withdrawing || entry.applyError !== null) continue;
      if (projection.decision !== "MAINTAIN") continue;
      if (projection.status !== "READY" && projection.status !== "DECISION_REQUIRED") continue;
      const decision = projection.decisionRequired;
      if (decision === null) {
        if (projection.status === "READY") {
          void applyStateMaintenance(sourceMessageId, projection.requestId);
        }
        continue;
      }
      // 有待决定：只有不在 blocked_changes 里的 PENDING 条目才解锁，
      // 被挡住的条目不触发调用，也不会因为 409 反复重试。
      const unblocked = (projection.changes ?? []).filter((change) =>
        change.status === "PENDING" && decision.blockedChanges !== null &&
        !decision.blockedChanges.includes(change.ordinal));
      if (unblocked.length > 0) {
        void applyStateMaintenance(sourceMessageId, projection.requestId);
      }
    }
  }, [maintenance]);

  /**
   * 对既有待决定的一句话续答：绑定原请求与用户看到答案时的版本；
   * 决定本身不写业务事实，落库后由上面的自动生效 effect 继续原请求。
   * 命令身份按展示版本复用（R5）：响应丢失后的重试仍沿原 command_id，
   * 读到已决定/版本已变的事实后清掉本地身份，不拿旧身份重发新决定。
   */
  async function answerStateDecision(sourceMessageId: string,
    resolution: "ACCEPT" | "DECLINE", answer: string) {
    if (disposed.current) return;
    const entry = maintenanceRef.current.get(sourceMessageId);
    const projection = entry?.projection ?? null;
    const trimmed = answer.trim();
    if (entry === undefined || projection === null || entry.applying || trimmed === "") return;
    const stored = entry.decisionCommandId;
    const commandId = stored !== null && stored.revision === projection.revision
      ? stored.commandId : createCommandId();
    patchMaintenance(sourceMessageId, { applying: true, applyError: null,
      decisionCommandId: { commandId, revision: projection.revision } });
    try {
      const result = await client.answerConversationStateDecision({
        requestId: projection.requestId, commandId, resolution,
        answer: trimmed, expectedRevision: projection.revision });
      if (disposed.current) return;
      const current = maintenanceRef.current.get(sourceMessageId)?.projection ?? null;
      patchMaintenance(sourceMessageId, { applying: false, decisionCommandId: null,
        projection: current === null ? null : { ...current, status: result.status,
          revision: result.revision, changes: result.changes ?? current.changes,
          decisionRequired: null } });
    } catch (caught) {
      if (disposed.current) return;
      // 冲突或失败都保留已展示的事实与原命令身份，按原回执核对，不把答案硬写进去；
      // 已决定 / 版本已变 / 载荷复用说明这个身份已经结算过，清掉旧身份再核对。
      const problem = caught instanceof RelayApiError ? caught.problem : null;
      const settled = problem !== null &&
        (problem.code === "INVALID_TRANSITION" || problem.code === "DECISION_STALE" ||
          problem.code === "COMMAND_ID_REUSED");
      patchMaintenance(sourceMessageId, { applying: false,
        decisionCommandId: settled ? null : { commandId, revision: projection.revision },
        applyError: describeLiveError(caught).message });
    }
  }

  async function withdrawStateMaintenance(sourceMessageId: string,
    scope?: { readonly planDigest: string; readonly changeIds: readonly string[] }) {
    if (disposed.current) return;
    const entry = maintenanceRef.current.get(sourceMessageId);
    const projection = entry?.projection ?? null;
    if (entry === undefined || projection === null || entry.withdrawing) return;
    // 撤回身份是请求行固化的 undo_command_id，不是新造命令：丢失就停下等原回执核对。
    const commandId = projection.undoCommandId;
    if (commandId === "") return;
    patchMaintenance(sourceMessageId, { withdrawing: true, withdrawCommandId: commandId,
      withdrawError: null, confirmingUndo: scope === undefined ? false : true,
      undoPlanError: null });
    try {
      const result = await client.withdrawConversationStateRequest({
        requestId: projection.requestId, commandId,
        ...(scope === undefined ? {}
          : { planDigest: scope.planDigest, confirmedChangeIds: scope.changeIds }) });
      if (disposed.current) return;
      const current = maintenanceRef.current.get(sourceMessageId)?.projection ?? null;
      patchMaintenance(sourceMessageId, { withdrawing: false, undoPlan: null, undoScope: [],
        projection: current === null ? null : { ...current, status: result.status,
          revision: result.revision, changes: result.changes ?? current.changes } });
    } catch (caught) {
      if (disposed.current) return;
      const problem = caught instanceof RelayApiError ? caught.problem : null;
      // 事前预检发现原范围里有不可撤回项：服务端一项都没执行，先取回方案交回用户决定范围。
      if (problem !== null && problem.code === "UNDO_SCOPE_REQUIRED") {
        try {
          const plan = await client.getConversationStateUndoPlan(projection.requestId);
          if (disposed.current) return;
          patchMaintenance(sourceMessageId, { withdrawing: false, confirmingUndo: true,
            undoPlan: plan, undoScope: [], undoPlanError: null, withdrawError: null });
          return;
        } catch (planCaught) {
          if (disposed.current) return;
          patchMaintenance(sourceMessageId, { withdrawing: false, confirmingUndo: false,
            undoPlanError: describeLiveError(planCaught).message });
          return;
        }
      }
      // 预检之后事实变了：方案过期，重新取一份再让用户确认，不拿旧摘要提交。
      if (problem !== null && problem.code === "UNDO_PLAN_STALE") {
        try {
          const plan = await client.getConversationStateUndoPlan(projection.requestId);
          if (disposed.current) return;
          patchMaintenance(sourceMessageId, { withdrawing: false, confirmingUndo: true,
            undoPlan: plan, undoScope: [], withdrawError: null,
            undoPlanError: "这组事实在你确认之后又变了，已重新读取方案；请按新的范围再确认一次。" });
          return;
        } catch (planCaught) {
          if (disposed.current) return;
          patchMaintenance(sourceMessageId, { withdrawing: false, confirmingUndo: false,
            undoPlanError: describeLiveError(planCaught).message });
          return;
        }
      }
      patchMaintenance(sourceMessageId, { withdrawing: false,
        withdrawError: describeLiveError(caught).message });
    }
  }

  /** 按原回执核对：重读会话的状态维护请求；在途解释与撤回的本地条目不被覆盖。 */
  function reloadMaintenance() {
    if (disposed.current || readonlyMode || session.projectId === null) return;
    void client.getConversationStateRequests(session.id).then((requests) => {
      if (disposed.current) return;
      const next = new Map(maintenanceRef.current);
      for (const projection of requests) {
        const existing = next.get(projection.sourceMessageId);
        if (existing !== undefined && (existing.interpreting || existing.withdrawing)) continue;
        next.set(projection.sourceMessageId, { ...emptyMaintenanceEntry, projection });
      }
      maintenanceRef.current = next; setMaintenance(next);
    }).catch(() => { /* 重读失败保持已展示事实；用户可再次核对。 */ });
  }

  const selectedSkill = skills.find((item) => `${item.id}@${item.version}` === selectedSkillKey) ?? null;
  function currentSkillAccepts(proposal: RelayTaskSkillProposal): boolean {
    const source = messages?.find((message) => message.id === proposal.messageId);
    const outputKind = proposal.kind === "TASK_CONTRACT_CHANGE"
      ? "TASK_DEFINITION_SUGGESTION" : "VERIFICATION_PLAN_SUGGESTION";
    if (source && (source.role !== "ASSISTANT" || source.status !== "COMPLETED" ||
      source.skill?.definitionAvailability !== "AVAILABLE" ||
      source.skill.outputAvailability !== "HISTORICAL_SNAPSHOT" ||
      source.skill.sha256 !== proposal.skillSha256 ||
      source.skillOutput?.targetId !== proposal.targetId ||
      source.skillOutput.kind !== outputKind)) return false;
    return skills.some((current) => current.target === "TASK" && current.outputKind === outputKind &&
      current.sha256 === proposal.skillSha256 && current.callSupported && current.acceptSupported &&
      (!source || current.id === source.skill?.id && current.version === source.skill.version));
  }

  // 执行请求按产生它的那条 user 消息归属：摘要只依据已结算的工具调用，不给在途计数。
  const [executionSummaries, setExecutionSummaries] = useState<
    ReadonlyMap<string, RelayConversationExecution>>(() => new Map());
  useEffect(() => {
    let active = true;
    setExecutionSummaries(new Map());
    if (target === null || readonlyMode) return () => { active = false; };
    void client.getConversationExecutionRequests(session.id).then((requests) => {
      if (!active) return;
      // 同一原消息只保留最新一次执行：服务端按「新 → 旧」返回，后写覆盖先写会留下
      // 最早的那次，重试时摘要就会挂到旧 Run 的轨迹上。这里按 revision 取最大，
      // 不依赖返回顺序。
      const latest = new Map<string, RelayConversationExecution>();
      for (const request of requests) {
        const seen = latest.get(request.sourceMessageId);
        if (seen === undefined || BigInt(request.revision) > BigInt(seen.revision)) {
          latest.set(request.sourceMessageId, request);
        }
      }
      setExecutionSummaries(latest);
      // 恢复：刷新后读到同一条「明确只读、尚未启动」的原请求时继续原启动。只接管这类请求，
      // 否则会把别的阶段重新显示成待确认。已经由本会话解释出的结果优先，不被覆盖。
      const resumable = [...latest.values()]
        .filter((item) => item.autoStart === true && item.runId === null &&
          item.candidateStatus === "READY" &&
          ["READY", "TASK_PREPARED", "FAILED"].includes(item.status))
        .sort((left, right) => (BigInt(right.revision) > BigInt(left.revision) ? 1 : -1))[0];
      if (resumable !== undefined) setExecution((previous) => previous ?? resumable);
    }).catch(() => {
      // 读不到就不显示摘要，不猜「大概执行过」。
      if (active) setExecutionSummaries(new Map());
    });
    return () => { active = false; };
  }, [client, session.id, target?.id]);

  const transcriptContent = <>
    {messages === null && !error && <p className="loading-text" role="status">正在读取会话消息…</p>}
    {error && <p className="action-error" role="alert">{error} <button type="button" className="text-link" onClick={() => void refresh()}>重读</button></p>}
    {messages?.length === 0 && <p className="helper-text">还没有消息。</p>}
    {!!messages?.length && <ol className="agent-message-list">{messages.map((message, index) => {
      const previous = index > 0 ? messages[index - 1] : undefined;
      const day = messageDay(message.createdAt);
      const newDay = day !== null && (previous === undefined || messageDay(previous.createdAt) !== day);
      return <li key={message.id} className="agent-message-slot">
        {newDay && <p className="agent-date-separator" role="separator" aria-label={`日期 ${day}`}><span>{day}</span></p>}
{/* busy / pending 已随消息内取消按钮一起移除；writeBlocked 只剩预览重读这一处只读入口。 */}
<AssistMessageRow client={client} target={target} message={message}
        personaLabel={learningMode ? "学习搭档" : session.personaLabel}
        preview={canPreview(message) && writeBlockedReason === null ? previews[message.id] ?? null : null}
        previewError={previewErrors[message.id] ?? null} onRetryPreview={() => setPreviewRetry((value) => value + 1)}
        writeBlocked={writeBlockedReason !== null}
        candidates={proposals.filter((proposal) => proposal.messageId === message.id &&
          proposal.kind === "CANDIDATE_MARKDOWN" && message.role === "ASSISTANT" &&
          message.status === "COMPLETED")} />
        {learningMode && message.role === "ASSISTANT" && learningState?.rounds.find((round) => round.messageId === message.id) &&
          <p className="receipt-message" data-testid="learning-round-receipt">{learningRoundText(learningState.rounds.find((round) => round.messageId === message.id)!)}</p>}
        {message.role === "USER" && (executionSummaries.get(message.id)?.runId ?? null) !== null && client &&
          <ExecutionTrajectorySummary client={client}
            runId={(executionSummaries.get(message.id)?.runId ?? "") as string}
            revision={target?.kind === "TASK" ? target.revision : null} />}
        {message.role === "USER" && maintenance.get(message.id) !== undefined &&
          <StateMaintenanceReceipt entry={maintenance.get(message.id) ?? emptyMaintenanceEntry}
            onRetry={() => retryStateMaintenance(message.id)}
            onWithdraw={() => void withdrawStateMaintenance(message.id)}
            onToggleUndoConfirm={() => {
              const current = maintenanceRef.current.get(message.id);
              if (current !== undefined) patchMaintenance(message.id,
                { confirmingUndo: !current.confirmingUndo, undoPlan: null, undoScope: [],
                  undoPlanError: null });
            }}
            onReload={reloadMaintenance}
            onToggleUndoScope={(changeId) => {
              const current = maintenanceRef.current.get(message.id);
              if (current === undefined) return;
              const selected = current.undoScope.includes(changeId)
                ? current.undoScope.filter((id) => id !== changeId)
                : [...current.undoScope, changeId];
              patchMaintenance(message.id, { undoScope: selected });
            }}
            onWithdrawScoped={() => {
              const current = maintenanceRef.current.get(message.id);
              const plan = current?.undoPlan ?? null;
              if (current === undefined || plan === null || current.undoScope.length === 0) return;
              void withdrawStateMaintenance(message.id,
                { planDigest: plan.planDigest, changeIds: current.undoScope });
            }}
            onCancelUndoPlan={() => {
              patchMaintenance(message.id, { confirmingUndo: false, undoPlan: null,
                undoScope: [], undoPlanError: null });
            }}
            onAnswerDecision={(resolution, answerText) => {
              void answerStateDecision(message.id, resolution, answerText);
            }} />}
      </li>;
    })}</ol>}</>;

  // 上下文占用与缓存命中率都取自最近一次有真实用量的 AI 回复。USER 消息没有模型
  // 调用，用量恒为 null；Provider 未上报缓存时显示"未采集"，不显示 0%。
  const lastCall = [...(messages ?? [])].reverse().find((message) =>
    message.role === "ASSISTANT" && (message.usage.inputTokens !== null ||
      message.usage.cacheReadTokens !== null || message.usage.cacheCreationTokens !== null)) ?? null;
  const contextRatio = lastCall?.usage.inputTokens !== null && lastCall?.usage.inputTokens !== undefined &&
    callLimit !== null && callLimit > 0
    ? Math.min(1, lastCall.usage.inputTokens / callLimit) : null;
  const cacheHitRate = lastCall !== null && lastCall.usage.cacheReadTokens !== null &&
    lastCall.usage.inputTokens !== null && lastCall.usage.inputTokens > 0
    ? lastCall.usage.cacheReadTokens / lastCall.usage.inputTokens : null;

  const visibleProposals = embedded ? proposals.filter((proposal) => preferredSkillId === "task-to-execution-contract"
    ? proposal.kind === "TASK_CONTRACT_CHANGE" : proposal.kind === "VERIFICATION_PLAN_CHANGE") : proposals;
  const featuredProposalId = visibleProposals.find((proposal) => proposal.status === "PENDING")?.id ?? visibleProposals[0]?.id;
  const ProposalContainer = embedded ? "section" : "details";
  const pendingProposalCount = visibleProposals.filter((proposal) => proposal.status === "PENDING").length;
  const proposalPanel = <ProposalContainer className={standalone ? "agent-chat-proposals" : embedded ? "embedded-assist-proposals" : "assist-options-expanded"} data-testid="assist-proposals" open={embedded ? undefined : !standalone || pendingProposalCount > 0}>
    {!embedded && <><summary>Assist 提案 · {visibleProposals.length}{pendingProposalCount > 0 ? ` · ${pendingProposalCount} 个待确认提议` : ""}</summary>{!standalone && <h3>Assist 提案</h3>}</>}
    {!visibleProposals.length && <p className="helper-text">当前会话没有待确认提案；Skill 历史输出仍可只读查看。</p>}
    {visibleProposals.map((proposal) => {
      if (target === null) return null;
      if ("baseAcceptanceRevision" in proposal) {
        const preview = <TaskContractProposalPreview key={`${proposal.id}:${proposal.status}:${target.revision}`} client={client} proposal={proposal}
          taskId={target.id} projectId={target.projectId} disabled={busy || pending !== null || writeBlockedReason !== null}
          acceptSupported={currentSkillAccepts(proposal)}
          actionHost={embedded && proposal.id === featuredProposalId ? proposalActionHost : undefined}
          onAccept={(selected: RelayTaskSkillProposal) => void runAction({ kind: "acceptTask",
            id: selected.id, taskId: selected.targetId, commandId: createCommandId(),
            expectedTaskRevision: selected.baseRevision,
            expectedAcceptanceRevision: selected.baseAcceptanceRevision,
            payloadHash: selected.payloadHash })} />;
        return standalone ? <article className="assist-proposal agent-chat-proposal-card" key={`${proposal.id}:${proposal.status}:${target.revision}`}>
          <div className="task-proposal-heading"><h4>{proposal.kind === "TASK_CONTRACT_CHANGE" ? "任务定义提议" : "验收方案提议"}</h4>
            <span className="task-proposal-state" data-status={proposal.status}>{proposal.status === "PENDING" ? "待确认" : proposal.status}</span></div>
          {proposal.payloadAvailable && proposal.targetId === target.id && proposal.payload
            ? <><p className="assist-proposal-summary">{proposal.payload.objective}</p><p className="helper-text">保留 {proposal.payload.preservedCriterionIds.length} 条验收条件，新增 {proposal.payload.addedCriterionIds.length} 条；接受后创建新版本。</p></>
            : <p className="helper-text">提议内容当前不可读，不能确认。</p>}
          <details className="agent-chat-proposal-details"><summary>{proposal.status === "PENDING" ? "查看提议与接受操作" : "查看完整提议"}</summary>{preview}</details>
        </article> : preview;
      }
      return <article className="assist-proposal agent-chat-proposal-card" key={proposal.id}>
        <div className="task-proposal-heading"><h4>{proposal.kind === "CANDIDATE_MARKDOWN" ? "Markdown 候选" : "任务定义提案"}</h4>
          <span className="task-proposal-state" data-status={proposal.status}>{proposal.status === "PENDING" ? "待确认" : proposal.status}</span></div>
        <p><strong>{proposal.kind === "CANDIDATE_MARKDOWN" ? "拟新增受管产物：" : "拟创建任务："}</strong>{proposal.payload.title}</p>
        {proposal.kind === "TASK_DEFINITION" && <p className="assist-proposal-summary">{proposal.payload.objective}</p>}
        <details className="agent-chat-proposal-details"><summary>{proposal.status === "PENDING" ? "查看提议与接受操作" : "查看完整提议"}</summary>
          {proposal.kind === "CANDIDATE_MARKDOWN" ? <><p className="helper-text">{proposal.payload.mediaType}</p><pre className="assist-proposal-payload">{proposal.payload.markdown}</pre></>
            : <><p>{proposal.payload.objective}</p><h5>验收条件</h5><ul>{proposal.payload.criteria.map((criterion, index) => {
              const methodLabel = criterionMethodLabel(criterion.method);
              return <li key={index}>{criterion.statement} · {criterion.required ? "必需" : "可选"} · 验证方式：{methodLabel}{methodLabel !== criterion.method && <small title={criterion.method}>（{criterion.method}）</small>}</li>;
            })}</ul>{Object.keys(proposal.payload.expectedOutputs).length === 0
              ? <p className="helper-text">未指定预期产物。</p>
              : <><p className="helper-text">预期产物</p><ul className="assist-proposal-outputs">{Object.entries(proposal.payload.expectedOutputs).map(([key, value]) =>
                <li key={key} className="assist-proposal-output-chip" title={`${key}: ${expectedOutputRawText(value)}`}>{expectedOutputKeyLabels[key] ?? key}：{expectedOutputValueText(key, value)}</li>)}</ul></>}</>}
          <details><summary>核对目标与内容摘要</summary><p className="helper-text">目标 {proposalTargetTypeText(proposal.targetType)} · {proposal.targetId} · 基于修订 v{proposal.baseRevision} · 内容摘要 {proposal.payloadHash}</p></details>
          {proposal.status === "PENDING" && <button className="primary-button" type="button" disabled={busy || pending !== null || writeBlockedReason !== null} onClick={() => void runAction({ kind: "accept", id: proposal.id, commandId: createCommandId() })}>接受此提案</button>}
        </details>
      </article>;
    })}
  </ProposalContainer>;

  const transcript = <div ref={transcriptRef} className={standalone ? "agent-chat-transcript" : undefined}
    role="region" aria-label="会话消息" tabIndex={0} data-testid="assist-transcript"
    onScroll={(event) => {
      const element = event.currentTarget;
      if (element.clientHeight === 0) return;
      const latest = element.scrollHeight - element.scrollTop - element.clientHeight < 32;
      followLatest.current = latest; setAtLatest(latest);
    }}><div ref={transcriptContentRef} className="agent-chat-content">{transcriptContent}{standalone && !externalReadBlockedReason && visibleProposals.length > 0 && proposalPanel}</div></div>;
  const frozenSkill = pending?.kind === "send" && pending.skillRef
    ? skills.find((item) => item.id === pending.skillRef?.id && item.version === pending.skillRef.version) : null;
  const sendLabel = pending?.kind === "send"
    ? pending.skillRef ? `运行 ${frozenSkill?.title ?? pending.skillRef.id}` : intentLabels[pending.intent ?? "DISCUSS"]
    : selectedSkill ? `运行 ${selectedSkill.title}` : intentLabels[intent];
  const lastLearningReply = learningMode ? [...(messages ?? [])].reverse()
    .find((item) => item.role === "ASSISTANT" && item.status === "COMPLETED") : undefined;
  const learningTransferSources: RelayAssistSourceRef[] = [];
  for (const source of lastLearningReply?.sources ?? []) {
    if ((source.kind === "KNOWLEDGE" || source.kind === "MEMORY" || source.kind === "DECISION") &&
      source.rootId !== null && source.version !== null && /^\d+$/u.test(source.version) &&
      (source.status === "AVAILABLE" || source.status === "FROZEN")) {
      learningTransferSources.push({ kind: source.kind, rootId: source.rootId, version: source.version });
    }
  }

  const sendOptions = <details className={standalone ? "agent-chat-options" : "assist-options-expanded"} open={!standalone || sourcesOpen}
        onKeyDown={(event) => {
          if (!standalone || !sourcesOpen || event.key !== "Escape" || event.nativeEvent.isComposing ||
            event.nativeEvent.keyCode === 229 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
          event.preventDefault(); event.stopPropagation();
          onToggleSources(); event.currentTarget.querySelector<HTMLElement>("summary")?.focus({ preventScroll: true });
        }}
        onToggle={(event) => { if (standalone && event.currentTarget.open !== sourcesOpen) onToggleSources(); }}><summary>{standalone ? <>{selectedSkill ? selectedSkill.title : intent === "DISCUSS" ? "普通讨论" : "提案"}</> : <>发送选项 · {selectedSkill ? selectedSkill.title : intent === "DISCUSS" ? "普通讨论" : "提案"}</>}<ChevronDown aria-hidden="true" className="agent-chat-chip-chevron" /></summary>
      {standalone && sourcePicker}
      <label className="field"><span className="field-label">生成方式</span><select data-testid="assist-skill"
        value={selectedSkillKey} onChange={(event) => { setSelectedSkillKey(event.target.value); setSkillInputText(""); }}
        disabled={pending !== null || busy}>
        <option value="">普通 Assist</option>
        {skills.map((skill) => <option key={`${skill.id}@${skill.version}`} value={`${skill.id}@${skill.version}`}
          disabled={!skill.callSupported || skill.missingCapabilities.length > 0}>{skill.title} v{skill.version} ·
          {!skill.callSupported ? "历史版本，仅可查阅" : skill.missingCapabilities.length > 0 ? "缺能力，当前不可调用" :
            skill.availability === "CALLABLE_READ_ONLY" ? "只读" : "仅建议"}</option>)}
      </select></label>
      {skillError && <p className="action-error" role="alert">Skill 清单暂不可读：{skillError}。
        普通 Assist 仍可用。<button className="text-link" type="button" onClick={() => void loadSkills()}>重读 Skill</button></p>}
      {selectedSkill ? <>
        <p className="helper-text">{selectedSkill.title} · {selectedSkill.id} v{selectedSkill.version} ·
          定义摘要 {selectedSkill.sha256} ·
          {selectedSkill.availability === "CALLABLE_READ_ONLY" ? "只读输出" : "仅生成建议"}。
          依赖：{selectedSkill.dependencies.map((dep) => `${dep.kind} ${dep.id}@${dep.version} (${dep.sha256})`).join("；")}。
          {selectedSkill.requiredCapabilities.length ? `需要能力：${selectedSkill.requiredCapabilities.join("、")}。` : "无额外 Connector 能力要求；模型服务仍须另行可用。"}
          {selectedSkill.missingCapabilities.length ? ` 缺少能力：${selectedSkill.missingCapabilities.join("、")}。` : ""}
          模型输出本身只读；可接受的 Task Skill 会另给服务端合并提案，需明确确认。</p>
        <label className="field"><span className="field-label">{selectedSkill.id === "task-to-execution-contract"
          ? "期望结果（可选）" : selectedSkill.id === "project-resume" ? "关注点（可选）" : "风险重点（可选）"}</span>
          <textarea data-testid="assist-skill-input" value={skillInputText}
            onChange={(event) => setSkillInputText(event.target.value)} maxLength={2000} rows={2}
            disabled={pending !== null || busy} /></label>
      </> : <label className="field"><span className="field-label">意图</span><select data-testid="assist-intent"
        value={intent} onChange={(event) => setIntent(event.target.value as AssistIntent)} disabled={pending !== null || busy}>
        <option value="DISCUSS">讨论</option>{target?.kind === "TASK" && <option value="PROPOSE_CANDIDATE">提出 Markdown 候选</option>}
        {session.projectId !== null && <option value="PROPOSE_TASK">提出任务定义</option>}
      </select></label>}
      <p className="helper-text">本次发送冻结已选的 {sources.length} 个资料版本。Assist 不能自行提交业务修改。</p></details>;

  /* 队列候选：所有 PENDING。是否真的构成队列取决于 runningMessage，见下。 */
  const pendingMessages = useMemo(() => messages?.filter((item) =>
    item.role === "ASSISTANT" && item.status === "PENDING") ?? [], [messages]);
  /* 在途回复：worker 正在处理的那条 RUNNING。PENDING 另有含义，见下。 */
  const runningMessage = useMemo(() => messages?.find((item) =>
    item.role === "ASSISTANT" && item.status === "RUNNING") ?? null, [messages]);
  /* PENDING 是「已提交、Worker 尚未领取」的初态，不是排队位置：空闲时发出的一条也是 PENDING，
     此时没有任何东西排在它前面，Worker 正要领取它。服务端 claimNextPendingMessage 才是
     PENDING → RUNNING 的唯一通道，所以只有存在 RUNNING 时，其余 PENDING 才真的构成队列。 */
  const inflightMessage = runningMessage ?? pendingMessages[0] ?? null;
  const stoppableMessage = inflightMessage !== null && !inflightMessage.cancelRequested ? inflightMessage : null;
  const stopPending = inflightMessage !== null && inflightMessage.cancelRequested;
  /* 输入器的在途呈现：服务端已有在途行，或刚提交、回复行尚未出现在列表里。 */
  const composerInflight = inflightMessage !== null || awaitingAssistantId !== null;
  useEffect(() => { onInflightChange?.(composerInflight || learningNavigation.pending !== null); }, [composerInflight, learningNavigation.pending, onInflightChange]);

  /* Esc Esc 停止：第一次按键只记录，不消费——单次 Esc 要留给资料面板关闭与焦点管理，
     所以放在 section 根用 React 冒泡而不是 window 监听。内层 <details> 的处理器先跑并
     preventDefault，这里看到 defaultPrevented 就放弃。第二次必须仍指向同一条在途回复：
     否则上一条恰好完成、下一条被提上来时，会停掉用户没打算停的那条。 */
  function onPanelKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key !== "Escape") return;
    const composing = event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229;
    if (composing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
      event.defaultPrevented || stoppableMessage === null) {
      stopSequence.current = null;
      return;
    }
    const first = stopSequence.current;
    stopSequence.current = null;
    if (first === null || first.messageId !== stoppableMessage.id || performance.now() > first.deadline) {
      stopSequence.current = { messageId: stoppableMessage.id, deadline: performance.now() + stopSequenceMs };
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    void runAction({ kind: "cancel", id: stoppableMessage.id, commandId: createCommandId() });
  }

  /** 队列里每条回复对应的用户原文：USER 紧邻其 ASSISTANT 之前一条，用于展示这排的是哪句话。 */
  const userTextBefore = (assistantId: string): string | null => {
    const index = messages?.findIndex((item) => item.id === assistantId) ?? -1;
    const before = index > 0 ? messages?.[index - 1] : undefined;
    return before?.role === "USER" ? before.content : null;
  };
  /* 只有存在 RUNNING 时，PENDING 才真的排在别人后面。没有 RUNNING 时唯一那条 PENDING 是
     「Worker 还没领取」，不是队列——显示成队列会让空闲发送看起来像被别的任务挡住。
     那种情况下它由消息行的「等待生成」与输入栏停止键表达。 */
  const waitingQueue = runningMessage !== null ? pendingMessages : [];
  /* 明细常驻，不用 details 折叠：队列面板在提交瞬间出现、在最后一条离开时消失，
     折叠控件的 summary 与展开箭头都会跟着一起闪现。内容本身只有几行，
     收起省下的高度不值得换一个会闪的控件。 */
  const queuePanel = waitingQueue.length === 0 ? null :
    <div className="assist-queue" data-empty="false" data-testid="assist-queue">
      <p className="assist-queue-summary">等待中 · {waitingQueue.length} 项，当前回复生成中</p>
      <p className="helper-text">按提交先后依次回复；每条都可单独取消，取消只影响这一条。</p>
      <ol className="assist-queue-list">{waitingQueue.map((item, index) => {
        const source = userTextBefore(item.id);
        return <li key={item.id} data-testid={`assist-queue-item-${index + 1}`}>
          <span className="assist-queue-position">第 {index + 1} 项</span>
          {source ? <span className="assist-queue-text">{source.length > 80 ? `${source.slice(0, 80)}…` : source}</span>
            : <span className="assist-queue-text helper-text">原文不可读</span>}
          {!item.cancelRequested && <button className="secondary-button" type="button"
            data-testid={`assist-queue-cancel-${index + 1}`} disabled={busy || pending !== null || writeBlockedReason !== null}
            onClick={() => void runAction({ kind: "cancel", id: item.id, commandId: createCommandId() })}>取消这条</button>}
          {item.cancelRequested && <span className="helper-text">取消中</span>}
        </li>;
      })}</ol>
    </div>;

  return <section className={standalone ? "surface-panel agent-chat-conversation" : "surface-panel"} data-testid="assist-session"
    onKeyDown={onPanelKeyDown}>
    {!externalReadBlockedReason && embedded && proposalPanel}
    {!externalReadBlockedReason && <div className={standalone ? "agent-chat-conversation-heading" : embedded ? "embedded-assist-session-heading" : undefined}><div>{!embedded && <h2>{standalone ? "对话" : "消息与提案"}</h2>}{standalone || embedded ? <details><summary>会话信息</summary><p className="helper-text">{session.title} · {session.status} · {session.id}</p></details> : <p className="helper-text">会话 {session.id} · {session.status}。生成与取消均以服务端状态为准。</p>}</div><button className="secondary-button" type="button" data-testid="assist-refresh" onClick={() => void refresh()}>{standalone ? "刷新" : "刷新消息与提案"}</button></div>}
    {!externalReadBlockedReason && (embedded ? <details className="embedded-assist-history"><summary>查看会话历史与原始建议</summary>{transcript}</details> : <div className={standalone ? "agent-chat-transcript-shell" : undefined}>{transcript}
      {/* 只有图标，没有可见文字：可读名称与状态都在 aria-label / title 上。 */}
    {standalone && !atLatest && <button className="icon-button agent-chat-latest" type="button" data-testid="assist-latest"
      aria-label="回到最新消息" title="回到最新消息"
      onClick={() => {
        const element = transcriptRef.current;
        followLatest.current = true; setAtLatest(true);
        if (element) { element.scrollTop = element.scrollHeight; element.focus({ preventScroll: true }); }
      }}><ArrowDown aria-hidden="true" /></button>}
    </div>)}

    {/* 队列只读投影放在转录区之后、输入器之前：不抢焦点，也不遮挡控制入口。
        嵌入式子页同样渲染：停止键只覆盖那条 RUNNING，队列项的逐条取消入口只能在这里，
        只在 standalone 渲染会让 ?skill=assist 上的排队回复没有取消路径。 */}
    {/* 空队列也留一个等高占位，避免 0↔1 的那一帧推动转录区高度。 */}
    {!externalReadBlockedReason && (queuePanel ??
      <div className="assist-queue" data-empty="true" aria-hidden="true" />)}

    {!readonlyMode && standalone && executionScope !== null && <ExecutionSummary execution={execution}
      busy={executionBusy} error={executionError}
      onApply={(requestId) => void applyExecution(requestId)}
      onOpenTask={(taskId) => onExecutionPrepared?.(taskId)} />}

    {/* 文件夹作用域细条紧贴输入卡上方：它说明的是「发送前」的前提，因此必须落在
        输入区这一侧，而不是消息区顶部。归属回执与它同属这一区，位置由协作页决定。 */}
    {composerHeader}
    {learningMode && <LearningRecordsPanel client={client} sessionId={session.id}
      refreshKey={(messages ?? []).map((item) => `${item.id}:${item.status}`).join("|")}
      blocked={externalReadBlockedReason !== null} inflight={composerInflight}
      writeBlocked={writeBlockedReason !== null}
      defaultBackground={lastLearningReply?.content?.slice(0, 4000) ?? ""}
      composerDirty={Boolean(draft.trim() || skillInputText.trim())}
      onStateChange={setLearningState} onNavigationChange={setLearningNavigation}
      onTransfer={onLearningTransfer ? (instruction, background) => onLearningTransfer(instruction, background, learningTransferSources) : undefined} />}

    {/* 命令回执留在输入器这一列内，不再作为整宽底栏：反馈不删，只是不占满页面。 */}
    {session.status === "ACTIVE" && <div className={standalone ? "agent-chat-composer" : "create-form"}
      data-inflight={composerInflight} data-testid="assist-composer" ref={composerBoxRef}>
      {/* 在途光点。装饰层跟随实际在输入的那个输入器，两种形态都渲染：
          aria-hidden 且不承载事实——在途状态由消息行的状态文字承担。 */}
      <span className="agent-chat-composer-spark" aria-hidden="true" />
      {notice && <p className="receipt-message" role="status" data-testid="assist-receipt-notice">{notice}</p>}
      <form id={composerFormId} className="agent-chat-message-form" onSubmit={send}>
      <div className="field"><span className={standalone ? "visually-hidden" : "field-label"}>本次消息</span><ChatCommandInput
        client={client} mode={session.conversationMode} hasSession={true} data-testid="assist-draft"
        ref={draftRef}
        placeholder={standalone ? "输入你的想法、修改意见或新的要求" : undefined}
        value={draft} onValueChange={setDraft} maxLength={32768} rows={standalone ? 2 : 4}
        onSelectCommand={(entry) => {
          if (entry.kind === "METHOD") { setSelectedSkillKey(""); setIntent("DISCUSS"); }
        }}
        disabled={pending !== null || busy} onKeyDown={(event) => {
          if (standalone && event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
            event.preventDefault(); event.currentTarget.form?.requestSubmit();
          }
        }} /></div>
      {/* 嵌入式 ?skill=assist 只有这一个文字提交键，所以它同样承载停止形态：
          删掉消息内的取消按钮后，这里是子页唯一的停止入口。图标键形态见 standalone 分支。 */}
      {!standalone && (stoppableMessage !== null || stopPending
        ? <button className="primary-button" data-testid="assist-stop" type="button"
          data-state={stopPending ? "stopping" : "stoppable"}
          aria-label={stopPending ? "正在停止生成" : "停止生成"} aria-keyshortcuts="Escape Escape"
          title={stopPending ? "正在停止，等待生成安全结束" : "停止生成 · 连按两次 Esc"}
          disabled={stopPending || busy || pending !== null || writeBlockedReason !== null}
          onClick={() => { if (stoppableMessage !== null)
            void runAction({ kind: "cancel", id: stoppableMessage.id, commandId: createCommandId() }); }}
        >{stopPending ? "正在停止生成" : "停止生成"}</button>
        : <button className="primary-button" data-testid="assist-send" type="submit"
          disabled={!draft.trim() || pending !== null || busy || writeBlockedReason !== null || Boolean(selectedSkillKey && !selectedSkill) ||
            Boolean(selectedSkill && (!selectedSkill.callSupported || selectedSkill.missingCapabilities.length > 0))}>{busy ? `正在提交 · ${sendLabel}` : sendLabel}</button>)}
    </form>
      {standalone && <div className="agent-chat-composer-actions">
        <div className="agent-chat-composer-tools">
          {modeSwitch}
          {!assistantMode && <button className="agent-chat-tool" type="button" data-testid="assist-open-sources"
            aria-expanded={sourcesOpen} onClick={onToggleSources}><BookOpen aria-hidden="true" />资料 {sources.length}<ChevronDown aria-hidden="true" className="agent-chat-chip-chevron" /></button>}
          {/* 助手档没有 intent 与 Skill 可选：隐藏「发送选项」而不是渲染成禁用，
              让「这一档没有这条选择」本身可见。 */}
          {readonlyMode || sendOptions}
          <ContextMeter ratio={contextRatio} hitRate={cacheHitRate} call={lastCall} limit={callLimit} />
        </div>
        {/* 主按钮二态：位置与配色不动，只在有 RUNNING 回复时把字形换成停止方块。
            形状参考 deepseek-harness InputBar 的 rect x=3 y=3 10×10 rx=3，与圆角键同心。 */}
        {stoppableMessage !== null || stopPending ? <button className="primary-button agent-chat-send"
          data-testid="assist-stop" type="button" data-state={stopPending ? "stopping" : "stoppable"}
          aria-label={stopPending ? "正在停止生成" : "停止生成"} aria-keyshortcuts="Escape Escape"
          title={stopPending ? "正在停止，等待生成安全结束" : "停止生成 · 连按两次 Esc"}
          disabled={stopPending || busy || pending !== null || writeBlockedReason !== null}
          onClick={() => { if (stoppableMessage !== null)
            void runAction({ kind: "cancel", id: stoppableMessage.id, commandId: createCommandId() }); }}>
          <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <rect x="3" y="3" width="10" height="10" rx="3" fill="currentColor" /></svg>
        </button> : <button className="primary-button agent-chat-send" data-testid="assist-send" type="submit" form={composerFormId}
          aria-label={busy ? `正在提交 · ${sendLabel}` : sendLabel} title={sendLabel}
          disabled={!draft.trim() || pending !== null || busy || writeBlockedReason !== null || Boolean(selectedSkillKey && !selectedSkill) ||
            Boolean(selectedSkill && (!selectedSkill.callSupported || selectedSkill.missingCapabilities.length > 0))}><ArrowUp aria-hidden="true" /></button>}
      </div>}
      {!standalone && !readonlyMode && sendOptions}
    </div>}    {actionError && <p className="action-error" role="alert">{actionError}</p>}{pending && <div className="assist-pending"><p className="helper-text">命令结果待核对，原 command_id：{pending.commandId}。先查回执；未找到时只能用原命令 ID 和原载荷重试。</p><button className="secondary-button" type="button" disabled={busy} onClick={() => void checkReceipt()}>查询原命令回执</button><button className="secondary-button" type="button" disabled={busy} onClick={() => void runAction(pending, true)}>以原命令重试</button></div>}
    {!readonlyMode && !externalReadBlockedReason && !embedded && !standalone && proposalPanel}
  </section>;
}
