import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { ArrowDown, ArrowUp, Bug, Check, ChevronDown, ChevronRight, CircleCheck, Compass, Copy, FileCode, FileSearch, FileText, Folder, History, Lightbulb, ListChecks, ListTree, MessageSquareText, NotebookPen, Package, Paperclip, Plug, Plus, RotateCcw, Search, Settings, Sparkles, Terminal, Wrench } from "lucide-react";
import { createCommandId, RelayApiError, type RelayApiClient, type RelayArtifact, type RelayAssistLivePreview,
  type RelayAssistMessage, type RelayAssistMessageRecall, type RelayAssistMessageRecallSummary,
  type RelayAssistProposal,
  type RelayAssistSession, type RelayAssistSourceRef, type RelayAssistantProfile,
  type RelayCommandReceipt, type RelayConversationExecution, type RelayConversationMode,
  type RelayDirectoryEntry,
  type RelayGatewayConnection, type RelayKnowledge, type RelaySkillDefinition, type RelaySkillInput, type RelayStateMaintenanceChange,
  type RelayStateMaintenanceRequest,
  type RelayChatMode, type RelayGoalView, type RelayPlanView,
  type RelayTaskSkillProposal, type RelayUndoPlan,
  type RelayWorkingDirectory, type RelayWorkingDirectorySource,
  type RelayWorkspaceDefaultDirectory } from "../api/relayClient";
import AssistSkillOutput from "../components/AssistSkillOutput";
import ModelSelector from "../components/ModelSelector";
import { sessionModelSelectionFrom } from "../api/resources/modelSelection";
import ChatTimelineNav from "../components/ChatTimelineNav";
import ChatCommandInput, { chatCommandScope, chatCommandStatus } from "../components/ChatCommandInput";
import PluginIcon from "../components/PluginIcon";
import { findPluginMentions } from "../lib/pluginMentions";
import ComposerAttachmentChips from "../components/ComposerAttachmentChips";
import MessageAttachments from "../components/MessageAttachments";
import { formatAttachmentBytes, uploadCandidateFrom, uploadStagedAttachments } from "../components/composerAttachments";
import { useStagedAttachments } from "../components/useStagedAttachments";
import { ComposerDraftBar, ComposerPolishButton, useComposerDraftAssist } from "../components/ComposerDraftAssist";
import PageHeader from "../components/PageHeader";
import AssistSourcePicker from "../components/AssistSourcePicker";
import ExecutionSummary from "../components/ExecutionSummary";
import ChatModeSwitch, { ChatModeHint } from "../components/ChatModeSwitch";
import PlanCard from "../components/PlanCard";
import GoalCard from "../components/GoalCard";
import { chatModeCommandFromText } from "../lib/chatModeCommand";
import ExecutionTrajectorySummary from "../components/ExecutionTrajectorySummary";
import ConversationDiffSummary from "../components/ConversationDiffSummary";
import { RecentActivitySummary } from "../components/RecentActivitySummary";
import { PendingWorkStrip } from "../components/PendingWorkStrip";
import { SessionRoundTrace } from "../components/SessionRoundTrace";
import WritePermissionControl, { tierLabels, type Tier } from "../components/WritePermissionControl";
import ComposerTargetPicker, { type ComposerTargetChoice } from "../components/ComposerTargetPicker";
import SafeMarkdown from "../components/SafeMarkdown";
import LearningRecordsPanel, { learningRoundText } from "../components/LearningRecordsPanel";
import type { RelayLearningState } from "../api/resources/learning";
import TaskContractProposalPreview from "../components/TaskContractProposalPreview";
import { ConversationModeSwitch, ConversationModeHints, type AssistantDraft } from "../components/ConversationModeSwitch";
import { Notice, Toast } from "../components/Feedback";
import { UnresolvedCommandDialog, UnresolvedCommandStrip } from "../components/UnresolvedCommandDialog";
import { describeLiveError, needsReceiptCheck } from "../lib/liveErrors";
import { bumpActiveConversationActivity } from "../lib/activeConversation";
import { assistActivityLanded } from "../lib/sessionActivity";
import { useDetailsMenu, useMenuDismiss, useMenuExclusive, usePopupFlip } from "../lib/popoverMenu";
import { usePathTooltip } from "../lib/pathTooltip";
import { modelErrorGuides } from "../lib/modelErrorGuides";
import { criterionMethodLabel, stateMaintenanceChangeKindLabel, stateMaintenanceChangeStatusLabel,
  stateMaintenanceStatusLabel, assistSourceKindLabels, gatewayCapabilityLabel } from "../lib/labels";
import { liveClient, useRelayConnection } from "../lib/relayConnection";
import { handleRosterKeyDown } from "../lib/tabNavigation";
import { waitForEventRetry } from "../lib/eventRetry";
import type { PendingContext } from "../lib/usePendingWork";
import { rememberSourceRefs, readRecentSourceRefs } from "../lib/recentSourceRefs";
import { readComposerDraft, writeComposerDraft } from "../lib/composerDrafts";
import { readLastModel, writeLastModel } from "../lib/modelPreferences";
import { useDelayedVisible } from "../lib/useDelayedVisible";
import { formatReadableDateTime, useDisplayPreferences } from "../lib/displayPreferences";
import { chatControlFromText } from "../lib/chatControls";
import { chatSessionResultFrom, type RelayChatSessionResult } from "../api/resources/chatControls";
import type { RelayChatCommand } from "../api/resources/chatControls";
import { RelayTransportError } from "../api/core/errors";
import "./AssistView.css";

export type AssistTarget = { readonly kind: "PROJECT" | "TASK"; readonly id: string; readonly title: string;
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
/** 新会话空态欢迎（按页面原型 empty-work 复刻）：居中符号 + 一句「有什么想一起完成的？」
    + 一排覆盖软件工程全流程的快捷卡，点击把一条完整提示词预填进输入框。首条输入区（尚未建会话）
   与会话内空态（已建会话、尚无消息）共用同一视觉与同一组卡片，保证不同入口的新会话
   首屏一致；文案差异只体现在说明句上，由调用方传入。
   2026-10-18：提示词改为「即拿即用」——不再留「现象：」「总目标：」这类要用户自己填的空，
   2026-10-19：优先围绕用户指定目标，缺少目标时先澄清；测试与重构仅从相关改动收敛范围。
   前缀图标按每个快捷语的功能单独选型（11 个不重样），并按功能族分色（见 AssistView.css 的 tone 规则）：
   plan=构思与规划、purple=核心交付强调（实现/测试）、build=实施质量与接续。图标纯装饰，
   不承担语义，可访问名仍由卡片文字提供。
   2026-10-23 二轮：实现功能图标对齐原型 file-code（文件+代码括号）；配色从五档（plan/build/
   fix/doc/purple）收敛为三族——排查、文档接续并入墨绿 build，紫调降饱和（#7C5CFF→#5F3DC4）
   与琥珀/墨绿同一档柔和度，三色块在两行里成整段（琥珀×4 → 紫×2 → 墨绿×5），避免小尺寸图标
   处五色并置发花。 */
const emptyWorkSuggestions = [
  { key: "idea", icon: Lightbulb, tone: "plan", label: "讨论一个想法", text: "帮我把一个想法讨论清楚。先问我想解决什么问题，再结合我的回答逐步明确使用场景、价值和边界。每次只问最关键的一个问题，信息足够后给出建议。" },
  { key: "requirement", icon: ListChecks, tone: "plan", label: "梳理需求", text: "根据我提供的描述和当前项目资料，梳理使用者、场景、核心需求、非目标与验收标准。先复用已有决定，区分已确认和待确认内容；没有具体需求时先问我，不自行挑选。" },
  { key: "design", icon: Compass, tone: "plan", label: "设计方案", text: "针对我提出的问题，先核对现有实现与约束，再比较有实际意义的方案，给出推荐、理由、影响范围和验证方式。优先复用现有机制；本轮先讨论方案。" },
  { key: "task", icon: ListTree, tone: "plan", label: "拆解任务", text: "将当前明确的目标拆成可逐项验收的任务，说明范围、依赖、产物和验收方式，并推荐第一步。先核对已有进度，避免重复安排；目标不明确时先问我。" },
  { key: "implement", icon: FileCode, tone: "purple", label: "实现功能", text: "围绕我指定的功能，先核对需求、相关代码和未提交改动，再完成最小实现、必要验证与相关文档同步。缺少具体目标或存在关键业务歧义时先澄清，保留他人改动。" },
  { key: "test", icon: CircleCheck, tone: "purple", label: "补充测试", text: "优先针对我指定的模块；未指定时，检查当前改动涉及的关键路径。识别有实际风险的测试缺口，补充必要测试并运行，说明覆盖范围与未验证项。" },
  { key: "review", icon: FileSearch, tone: "build", label: "代码审查", text: "审查当前未提交改动，重点检查正确性、边界、安全和回归风险。只报告有依据、可处理的问题，标明位置、触发条件和影响，按严重程度排序；没有发现也直接说明。" },
  { key: "refactor", icon: Wrench, tone: "build", label: "重构优化", text: "检查我指定的模块；未指定时，先从当前改动涉及的代码中推荐一处值得简化的问题。说明收益、最小修改范围和行为保持方式，确认范围后再实施。" },
  { key: "debug", icon: Bug, tone: "build", label: "排查问题", text: "帮我定位并修复问题。先确认现象、预期和复现条件，再结合日志、代码与最近改动验证原因，完成最小修复和回归检查。缺少关键现象时先问我，推测要明确标注。" },
  { key: "docs", icon: NotebookPen, tone: "build", label: "写技术文档", text: "根据当前目标和实际实现，优先补充或修正已有技术文档。先确定读者和用途，只记录有依据的内容，标明限制和待确认项，避免创建重复文档。" },
  { key: "resume", icon: History, tone: "build", label: "接续上次工作", text: "读取当前项目的进度入口、相关任务记录和最近改动，说明已完成什么、停在哪里、还有哪些阻塞，并推荐一个最小接续任务。无法读取历史时明确说明，不猜测上次经过。" }
] as const;
function EmptyWorkWelcome({ testId, suggestTestIdPrefix, lede, onSuggest }: {
  testId: string; suggestTestIdPrefix: string; lede: string; onSuggest: (text: string) => void;
}) {
  return <div className="agent-chat-empty-work" data-testid={testId}>
    <div className="agent-chat-empty-symbol" aria-hidden="true"><img src="/logo.png" alt="" /></div>
    <h1>有什么想一起完成的？</h1>
    <p className="agent-chat-empty-lede">{lede}</p>
    <div className="agent-chat-suggestions">
      {/* 分隔板只落在功能族边界（规划→实施→排查→文档接续），说出顺序而不占卡片宽度；
          逐卡加箭头会把并列入口读成必须走完的链，且 10 枚箭头的宽度会让两行掉回三行。 */}
      {emptyWorkSuggestions.flatMap((suggestion, index) => [
        index > 0 && emptyWorkSuggestions[index - 1].tone !== suggestion.tone
          ? <span key={`sep-${suggestion.key}`} className="agent-chat-suggestion-sep" aria-hidden="true" /> : null,
        <button key={suggestion.key} type="button"
          className="agent-chat-suggestion" data-tone={suggestion.tone} data-testid={`${suggestTestIdPrefix}-${suggestion.key}`}
          onClick={() => onSuggest(suggestion.text)}><suggestion.icon aria-hidden="true" />{suggestion.label}</button>
      ])}
    </div>
  </div>;
}
type PendingAction = { readonly kind: "send"; readonly commandId: string; readonly content: string;
  readonly intent: AssistIntent | null; readonly skillRef: { readonly id: string; readonly version: string } | null;
  readonly skillInput: RelaySkillInput | null; readonly sources: readonly RelayAssistSourceRef[];
  /** 0093：随这条消息发送的图片身份，上传完成、命令产生前固定；重试沿同一组 id 重放。 */
  readonly attachmentIds?: readonly string[];
  /**
   * 0093：上传成功后命令被拒时把暂存内容还给输入框（§33.2「失败保留附件」）。
   * 不参与请求载荷；传输失败不还原——那种情况下命令可能已入库，不能诱导重发。
   */
  readonly attachmentFiles?: readonly File[];
  readonly recordLearning?: boolean;
  /** 0127：这条消息按哪种模式受理（`/plan 内容`、`/goal 内容` 会带上它）。 */
  readonly chatMode?: RelayChatMode } |
  { readonly kind: "restart"; readonly commandId: string; readonly content: string;
    readonly system: "clear" | "new" } |
  /** `/compact`：与 restart 共用 chat-commands 通道，但只申请整理工作窗口，不新建会话。 */
  { readonly kind: "compact"; readonly commandId: string; readonly content: string } |
  { readonly kind: "model"; readonly commandId: string; readonly model: string } |
  /** 0127：只切模式、不发消息（`/plan` 后面没有内容时走这条）。 */
  { readonly kind: "chatMode"; readonly commandId: string; readonly mode: RelayChatMode } |
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
  readonly modelSelection?: { readonly model: string; readonly commandId: string };
  readonly modelSelectionConfirmed?: boolean;
  readonly content: string; readonly conversationMode: RelayConversationMode;
  /** 0127：首条消息按哪种模式受理；缺省沿用会话的持久模式。 */
  readonly chatMode?: RelayChatMode | undefined;
  readonly recordLearning?: boolean;
  readonly sourceRefs?: readonly RelayAssistSourceRef[];
  /** 首条消息直接以 Skill 调用发出（服务端同一命令本就接受 skill_ref；带它时不再传 intent）。 */
  readonly skillRef?: { readonly id: string; readonly version: string };
  /**
   * 0093：随首条消息发送的图片。**文件**在会话建好之前无法上传（上传端点以会话为作用域），
   * 所以这里留的是暂存的 File；上传成功后把得到的 `attachmentIds` 写回同一份 pending，
   * 「按原命令重试」因此不会换一组 id（换 id 就是换载荷）。
   */
  readonly attachmentFiles?: readonly File[];
  readonly attachmentIds?: readonly string[];
  /** 传输失败时的真实原因；null 表示命令已确认发出。 */
  readonly reason: string | null; readonly resourceId: string | null;
  readonly directoryCommandId?: string };
/**
 * 建会话命令连同首条原文：创建响应丢失后按原回执恢复时，交接的必须是这一份载荷。
 *
 * 模式与助手也在载荷里，不是 UI 状态：身份在建立时冻结，重试必须交回同一份身份，
 * 否则「按原命令重试」会变成「建一条身份不同的新会话」。
 */
type PendingCreate = { readonly commandId: string; readonly projectId: string | null;
  readonly modelSelection?: { readonly model: string; readonly commandId: string };
  readonly taskId: string | null; readonly title: string;
  readonly firstContent: string; readonly resourceId: string | null;
  readonly conversationMode: RelayConversationMode; readonly assistantProfileId: string | null;
  /** 0127：空会话里 `/plan 内容` 直接建带模式的会话。 */
  readonly chatMode?: RelayChatMode | undefined;
  readonly recordLearning?: boolean;
  /** 0093：首条消息随附的图片文件；创建回执恢复时沿同一份载荷续发，不重新挑图。 */
  readonly attachmentFiles?: readonly File[];
  readonly sourceRefs?: readonly RelayAssistSourceRef[] };

/** 建会话载荷：助手档的助手 id 允许显式 null（表示「还没选助手」）。 */
type CreateSessionInput = { commandId: string; projectId: string | null; taskId: string | null;
  title: string; conversationMode?: RelayConversationMode; chatMode?: RelayChatMode;
  assistantProfileId?: string | null };
/**
 * 首条消息过程的唯一 Owner。命令身份、在途阶段与已完成解释必须比任何一次
 * AssistView 挂载都活得久：建会话成功后协作页会按会话 key 重新挂载它，
 * 而迟到响应与回执核对都可能跨越这次重挂载。
 */
export type FirstMessageProcess = {
  /** 首条发送前的选择草稿；发送过程使用 PendingCreate 固定的选择命令。 */
  readonly model?: string;
  /** 首条输入原文。未发送时它就是未保存保护的对象，不因重挂载或换目录消失。 */
  readonly draft: string;
  readonly pending: PendingFirstMessage | null;
  readonly busy: boolean;
  /**
   * 服务端明确拒绝首条命令时的可读原因。与 `pending.reason` 分开：明确拒绝说明命令
   * 没有落库、也没有可核对的结果，未决身份必须清空；这条原因仍要跨重挂载可见，
   * 因此和 pending 一样住在共享 Owner 上。会话归属用于防止换会话后残留。
   */
  readonly failure?: string | null;
  readonly failureSessionId?: string | null;
  /** 已声明完成解释的原消息 command_id：同一命令只解释一次，迟到响应不得重复解释。 */
  readonly interpreted: string | null;
  /**
   * 上面那条命令所属的会话。解释声明比会话面板活得久，协作页也会在换会话时
   * 复用同一个 Owner：不带归属的话，command_id 会被交给另一条空会话的面板，
   * 让它误以为「首条消息已确认、只是还没读回」而不再显示欢迎空态。
   */
  readonly interpretedSessionId?: string | null;
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
  /**
   * 不可恢复的未保存事实（2026-10-24 P0-2）：暂存/上传中的附件、首条草稿、技能输入、
   * 来源选择等**不在本机草稿持久化里**、离页即丢的输入。`dirty` 仍表示「有任何输入」
   * （含可按会话恢复的正文草稿），两者语义分开：离页守卫只拦 `unsaved`，
   * 可恢复的正文不重复弹确认（2026-10-19 用户指令）。
   */
  readonly unsaved: boolean;
  readonly discard?: () => void;
  readonly pending: { readonly commandId: string; readonly commandType: string;
    readonly sessionId: string | null } | null;
  /**
   * 「保留并继续编辑」的编辑焦点恢复：由页壳守卫在弹层关闭并完成默认回焦后调用。
   * 实现内部只作用于仍存活、可编辑的编辑器，失效时兜底或放弃（见 restoreComposerFocus）。
   */
  readonly restoreFocus?: () => void;
};
const cleanNavigationState: AssistNavigationState = { dirty: false, unsaved: false, pending: null };

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

/**
 * 插件 mention 插入（DEV-0099）：点「+ → 连接器与插件 → 某个插件」把 `@标签 ` 写进草稿，
 * 位置取当前光标/选区；没有光标时追加到末尾。前置缺分隔符就补一个空格，
 * 不改写既有正文、不发送消息。插件仍只是提示，执行准入照旧由权限链裁决。
 *
 * 文件与产物二级同样只把 `@路径 ` / `@产物 vN ` 插进草稿，因此与这里共用同一条插入规则：
 * mention 是用户写下的文字提示，不是消息附件，也不授予读取或执行权限。
 */
export function insertMention(draft: string, label: string,
  textarea: Pick<HTMLTextAreaElement, "selectionStart" | "selectionEnd"> | null): string {
  const start = textarea?.selectionStart ?? draft.length;
  const end = textarea?.selectionEnd ?? draft.length;
  const before = draft.slice(0, start);
  const lead = before === "" || /\s$/u.test(before) ? "" : " ";
  return `${before}${lead}@${label} ${draft.slice(end)}`;
}

/** 保持既有导出名：插件入口与契约测试都按这个名字调用。 */
export function insertPluginMention(draft: string, label: string,
  textarea: Pick<HTMLTextAreaElement, "selectionStart" | "selectionEnd"> | null): string {
  return insertMention(draft, label, textarea);
}

function targetMatches(session: RelayAssistSession, target: AssistTarget): boolean {
  return target.kind === "PROJECT" ? session.projectId === target.id && session.taskId === null
    : session.taskId === target.id && session.projectId === target.projectId;
}

function receiptMatches(receipt: RelayCommandReceipt, action: PendingAction, sessionId: string): boolean {
  if (action.kind === "model") return receipt.commandId === action.commandId &&
    receipt.commandType === "SelectSessionModel" && receipt.result.session_id === sessionId && receipt.result.model === action.model;
  if (action.kind === "restart") return receipt.commandId === action.commandId &&
    receipt.commandType === "ExecuteChatCommand" && receipt.result.source_session_id === sessionId &&
    receipt.result.system === action.system && receipt.result.kind === "NEW_SESSION";
  /* `/compact` 的底层 Owner 是 RequestMemoryCompaction：回执只带会话与 request_id，
     不要求服务端再套一层前端包装的 kind/system（重放回执可能只有原始结果）。 */
  if (action.kind === "compact") return receipt.commandId === action.commandId &&
    receipt.commandType === "RequestMemoryCompaction" && receipt.result.session_id === sessionId &&
    typeof receipt.result.request_id === "string" && receipt.result.status === "PENDING";
  // 0127：模式切换回执只核对会话与结果档位；revision 由刷新按服务端状态落实。
  if (action.kind === "chatMode") return receipt.commandId === action.commandId &&
    receipt.commandType === "SetChatMode" && receipt.result.session_id === sessionId &&
    receipt.result.chat_mode === action.mode;
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
  deferSessionCreation = standalone, executionScope = null, onExecutionPrepared,
  pendingDirectory = null, initialTarget, initialSession, creationPending = false,
  firstMessageOwner, firstMessageProcess, workspaceLevel = false,
  conversationTarget, onConversationTargetChange, composerHeader,
  conversationToolbar = false, toolbarRight,
  sessionContextEpoch = 0, onRequestSkillTarget, onSessionScopeResolved }: {
  targetKind?: "PROJECT" | "TASK"; targetId?: string; preferredSessionId?: string | null;
  /**
   * 第二个参数是创建时已读回的同一条服务端投影。协作页会因会话 ID 变化重挂载本视图，
   * 新实例拿它作首帧种子，避免先卸载面板、再等列表读回才重新出现（DEV-0110 闪烁）。
   */
  onSessionCreated?: (sessionId: string, session?: RelayAssistSession) => void;
  standalone?: boolean; onNavigationStateChange?: (state: AssistNavigationState) => void;
  onRequestNewSession?: (proceed: () => void) => void;
  onRequestSessionChange?: (proceed: () => void) => void;
  onSessionSelected?: (sessionId: string | null) => void;
  /**
   * 建会话成功后由服务端决定的作用域（运行架构 §2.8）。
   *
   * 只有**未显式指定项目/任务**的普通会话才可能继承 Workspace 默认目录：那时回执里的
   * `project_id` 不是空串，而是默认目录所属项目。这个事实只来自回执 session_id 的读回，
   * 前端不按本地「最近目录」或配置投影推断。宿主据此把讨论切到那个项目作用域，
   * 并在目录细条上标出来源；本视图不自行补一次目录绑定。
   */
  onSessionScopeResolved?: (scope: { readonly sessionId: string; readonly projectId: string;
    readonly workingDirectory: { readonly resourceId: string; readonly canonicalRoot: string | null;
      readonly source: RelayWorkingDirectorySource | null } | null }) => void;
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
  /**
   * 顶栏只读的一份「本次新对话已选择的目录」（2026-10-21，R3-02）。
   *
   * 它与 `executionScope` 是两个用途：后者参与执行准入（ READY 且归属成立才传），
   * 这一份只回答「用户此刻选了哪个目录、还没随首条消息绑上去」，因此目录未就绪时
   * 也要能如实显示，不参与任何准入判断。
   */
  pendingDirectory?: RelayWorkingDirectory | null;
  /**
   * 新对话首帧的目标种子（2026-10-22，DEV-0104）。
   *
   * 只在这一拍还没有会话（`deferSessionCreation`）且明确从空白起步
   * （`preferredSessionId === null`）时生效：目录或任务事实已经由宿主读到，
   * 本视图先用它渲染首条输入器，再照常向服务端核对完整工作对象与会话。
   * 不传时行为不变——项目/任务子页仍先等目标读回，不清空。
   * `revision` 只在非独立页页头展示，种子阶段取占位值，读回后替换。
   */
  initialTarget?: AssistTarget;
  /**
   * 刚创建的会话投影（DEV-0110）：重挂载的首帧直接按它渲染会话面板，
   * 不再等会话列表读回。只在 `preferredSessionId` 与它同 ID 时用作当前会话；
   * 列表读回后仍以服务端列表为准。
   */
  initialSession?: RelayAssistSession;
  /**
   * 目录种子仍在打开（`?dir=`）：输入器先在屏上，发送等作用域落定。
   * 不渲染整页在途态，避免「旧会话 → 在途页 → 新输入器」的整块替换。
   */
  creationPending?: boolean;
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
   * 工作对象会话身份（工作台 §25）。由协作页持有而不是 URL 或本视图内部：
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
  /**
   * 会话视图（/agent 未关联任务）的顶栏重构（效果图 V4.2 renderToolbar）。
   * 打开后本视图用三区工具栏取代旧的单条会话控制带：
   * 左＝面包屑 + 当前会话标题、中＝会话下拉与新建（沿用本视图自持的 sessionControls）、
   * 右＝由协作页注入的 toolbarRight 槽（工作详情入口等，归属仍只有一个 Owner）。
   * 默认关闭：项目/任务子页、Skill 页、嵌入态一律维持既有渲染。
   */
  conversationToolbar?: boolean;
  /** 工具栏右区插槽：由协作页传入，本视图不持有其内部状态。 */
  toolbarRight?: ReactNode;
  /**
   * 需要在某个项目/任务的上下文里使用 Skill 时的交接口（工作台 §32.11）。
   *
   * 归属在建会话时确定并冻结，所以「选一个工作对象」不能在本视图里伪造：本视图只把用户
   * 选中的工作对象交给宿主，由宿主把这条讨论带到该工作对象的真实作用域（协作页写 `?work=` /
   * `?project=`）。没有这个回调时（如嵌入态），缺上下文的 Skill 行保持禁用并写明原因。
   */
  onRequestSkillTarget?: (target: ComposerTargetChoice & { readonly skillId: string | null }) => void;
  /**
   * 协作页确认这段讨论的服务端作用域事实已变（换目录成功）后的变化计数。
   *
   * 顶栏的「会话目录」读的是本视图自己的会话清单，而目录绑定命令由协作页发起，本视图
   * 不会因为一次绑定自己醒过来；没有这个计数，顶栏会停在绑定发生前读到的那一份事实，
   * 与输入卡上方「当前的工作目录是 X」撞成两个说法。这里只按计数重读服务端，不在本地拼。
   */
  sessionContextEpoch?: number;
} = {}) {
  const location = useLocation();
  const { timeZone } = useDisplayPreferences();
  const firstComposerFormId = useId();
  const params = useParams();
  const kind = targetKind ?? (location.pathname.startsWith("/projects/") ? "PROJECT" : "TASK");
  const id = targetId ?? params.id ?? "";
  const connection = useRelayConnection();
  const client = connection.client;
  // 目标种子只服务「从空白开始」的这一拍；有会话或子页默认续写时仍按服务端读回再渲染。
  const seedTarget = deferSessionCreation && preferredSessionId === null && initialTarget !== undefined
    ? initialTarget : null;
  const [target, setTarget] = useState<AssistTarget | null>(seedTarget);
  // 种子只代表宿主刚读到的作用域事实；完整工作对象与会话列表仍要核对，核对完成前不写「已刷新」。
  const [targetSettled, setTargetSettled] = useState(seedTarget === null);
  const provisionalTarget = seedTarget !== null && !targetSettled;
  const [sessions, setSessions] = useState<readonly RelayAssistSession[]>(() =>
    initialSession === undefined ? [] : [initialSession]);
  const [assistantProfiles, setAssistantProfiles] = useState<readonly RelayAssistantProfile[]>([]);
  // 「一次性问答」只作用于本次建会话，不进 URL：它不是身份的一部分。
  const [rememberNext, setRememberNext] = useState(true);
  const [recordLearning, setRecordLearning] = useState(true);
  const [sessionInflight, setSessionInflight] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(() =>
    initialSession !== undefined && preferredSessionId === initialSession.id ? initialSession.id : null);
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
  /**
   * 「+」二级菜单里引用行的开关：只改**本次消息的候选输入**，不发送、不落库、不授予权限。
   * 上限与资料选择器一致（菜单里超限项已是禁用态，这里再兜一层，避免任何路径突破上限）。
   */
  const toggleSourceRef = useCallback((ref: RelayAssistSourceRef) => {
    setSelectedRefs((current) => {
      const same = (item: RelayAssistSourceRef) =>
        item.kind === ref.kind && item.rootId === ref.rootId && item.version === ref.version;
      if (current.some(same)) return current.filter((item) => !same(item));
      return current.length >= attachSourceLimit ? current : [...current, ref];
    });
  }, []);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [pendingCreate, setPendingCreate] = useState<PendingCreate | null>(null);
  /**
   * 未决命令的正文只留一行状态，核对弹窗由用户点开：传输失败当场弹模态会抢焦点，
   * 也可能和已有的离开守卫叠成两层；原因、command_id 与恢复出口都在那一层里。
   */
  const [firstPendingDialogOpen, setFirstPendingDialogOpen] = useState(false);
  const [createPendingDialogOpen, setCreatePendingDialogOpen] = useState(false);
  const [firstError, setFirstError] = useState<string | null>(null);
  /** 回执核对自身失败：它属于未决命令，显示在核对弹窗里，不与输入器的即时校验混在一起。 */
  const [firstPendingError, setFirstPendingError] = useState<string | null>(null);
  const [firstModelPickerOpen, setFirstModelPickerOpen] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  /**
   * 顶栏「切换讨论」浮层。只在同一作用域读出 ≥2 条讨论时才挂出来（见 sessionSwitcherNode），
   * 单条讨论的顶栏就是用户要的形：左边只有会话名，没有第二套切换控件。
   * 收起有三个出口：选中一条、点到浮层之外、Esc 后把焦点还给触发键——与左栏行内菜单同一套规矩。
   */
  const [sessionSwitcherOpen, setSessionSwitcherOpen] = useState(false);
  const sessionSwitcherRef = useRef<HTMLDivElement | null>(null);
  const sessionSwitcherTriggerRef = useRef<HTMLButtonElement | null>(null);
  // 收起有三个出口：选中一条、点到浮层之外、Esc 后把焦点还给触发键——与左栏行内菜单
  // 同一套规矩。Esc 与焦点归浮层节点上的内联 onKeyDown，外部按下与「打开别的浮层时
  // 独占」收口在 lib/popoverMenu。
  useMenuDismiss(sessionSwitcherOpen, () => setSessionSwitcherOpen(false), sessionSwitcherRef);
  // 会话从别处换了（近期工作栏、恢复回执）就把浮层收掉：浮层里列的是上一个作用域的行。
  useEffect(() => { setSessionSwitcherOpen(false); }, [sessionId]);
  /** 首条输入器的中文组词状态：草稿辅助据此保证组词期间零请求（工作台 §30.2）。 */
  const [firstComposing, setFirstComposing] = useState(false);  /**
   * 首条消息过程的 Owner。文件夹入口下由协作页持有并跨重挂载存活；
   * 独立使用时退回本实例的局部记录，语义不变。
   * 模型选择带本机偏好（2026-10-20 用户指令「记住上一次选择的模型」）：独立使用时
   * 这里也要种子化，否则只有协作页路径能记住上次选择。协作页路径由它的 firstMessage
   * 初始状态负责（见 CollaborationView），本条只覆盖没有 Owner 的用法。
   */
  const [localFirst, setLocalFirst] = useState<FirstMessageProcess>(() => ({
    ...emptyFirstProcess,
    model: client === null ? undefined : readLastModel(client.workspaceId) ?? undefined }));
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
  /**
   * 首条消息的图片附件暂存（工作台 §33）。会话输入器有自己的一份（在 AssistSessionPanel 里），
   * 两者不共享状态：首条消息属于"还没有会话"的那个过程，切过去之后它就该空了。
   * 上传发生在**发送时**——首条要等会话建好才有上传目标，因此暂存期间不发请求。
   */
  const stagedFirst = useStagedAttachments();
  const [firstAttaching, setFirstAttaching] = useState(false);
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
   * 首条消息的 Skill 清单与选择。服务端的首条消息命令本就接受 skill_ref（与后续消息同一命令）。
   *
   * 2026-10-18 改口径：清单**不再按会话工作对象的 kind 过滤**，也不再要求「有项目/任务归属才加载」。
   * 原因：`target` 描述的是这次调用要读谁的事实，不是入口门禁——上游（OpenCode 的
   * `skill` 工具只有权限位、Codex 的 `SkillScope` 只是来源分层）都不把 Skill 绑在项目上。
   * 缺上下文的那一类由 `ComposerTargetPicker` 在输入器里补齐，选中后按工作对象进入对应作用域。
   */
  const [firstSkills, setFirstSkills] = useState<readonly RelaySkillDefinition[]>([]);
  const [firstSkillKey, setFirstSkillKey] = useState("");
  useEffect(() => {
    if (client === null) { setFirstSkills([]); return; }
    let live = true;
    void client.getFirstPartySkills().then((items) => {
      if (!live || client !== liveClient()) return;
      setFirstSkills([...items.filter((item) => supportedSkillOutput[item.id] === item.outputKind)]
        .sort((a, b) => a.target === b.target
          ? a.id === b.id ? b.version.localeCompare(a.version, undefined, { numeric: true })
            : a.id.localeCompare(b.id)
          : a.target.localeCompare(b.target)));
    }).catch(() => { if (live) setFirstSkills([]); });
    return () => { live = false; };
  }, [client]);
  /**
   * Workspace 默认工作目录的只读投影（工作台 §18.1.5）。
   *
   * 只用于**空态说明**：设置过默认目录时，告诉用户新会话会落在哪里；没有设置时保留
   * 「要读文件再选目录」的原话。它不参与会话绑定推断——这段讨论实际属于哪个目录，
   * 以创建后的会话上下文为准（见 `createSession` 的读回）。读失败就按未设置措辞，
   * 不编造一个默认目录。这里只发 GET，零写入。
   */
  const [workspaceDefault, setWorkspaceDefault] = useState<RelayWorkspaceDefaultDirectory | null>(null);
  useEffect(() => {
    if (!workspaceLevel || client === null) { setWorkspaceDefault(null); return; }
    let live = true;
    void client.getWorkspaceDefaultDirectory().then((value) => { if (live) setWorkspaceDefault(value); },
      () => { if (live) setWorkspaceDefault(null); });
    return () => { live = false; };
  }, [client, workspaceLevel]);
  /** 深链 `?skill=` 预选（宿主切到工作对象作用域时带上，省掉用户再选一次）。只应用一次。 */
  const firstSkillPreference = useRef(false);
  /**
   * 0127：首条输入里 `/plan 内容`、`/goal 内容` 解析出的模式。
   * sendFirst 解析、createSession 消费；模式随建会话命令一起落库，空会话因此不需要
   * 「先建会话再切模式」的两次往返。用 ref 而不是 state：只在发送那一刻被读一次。
   */
  const firstChatModeRef = useRef<RelayChatMode | null>(null);
  useEffect(() => {
    if (firstSkillPreference.current || !preferredSkillId || firstSkills.length === 0) return;
    const preferred = firstSkills.find((item) => item.id === preferredSkillId && item.callSupported);
    if (preferred) setFirstSkillKey(`${preferred.id}@${preferred.version}`);
    firstSkillPreference.current = true;
  }, [firstSkills, preferredSkillId]);
  const firstSkill = firstSkills.find((item) => `${item.id}@${item.version}` === firstSkillKey &&
    item.callSupported && item.missingCapabilities.length === 0) ?? null;
  /**
   * 这条首条消息**当前能证明的**上下文：深链工作对象优先，其次目录所属项目。
   * 不推断：目录只是目录，只有服务端给过 association 才算项目归属。
   */
  const firstScope = {
    projectId: target?.projectId ?? executionScope?.association?.projectId ?? null,
    taskId: target?.kind === "TASK" ? target.id : null,
  };
  /** 选中的 Skill 需要的上下文是否已经具备；缺的时候由输入器的工作对象芯片补齐。 */
  const firstSkillScopeMissing = firstSkill !== null && (firstSkill.target === "TASK"
    ? firstScope.taskId === null : firstScope.projectId === null);
  /** 首条消息的写档位：由底栏 [权限] 芯片同源上报，上方状态行只读显示。 */
  const [firstWriteTier, setFirstWriteTier] = useState<Tier | null>(null);
  // 种子先让输入器上屏，真正的核对几乎总在几十毫秒内结束；等待超过 200ms 才把提示摆出来，
  // 不把一次快读成「闪一句正在核对」。目录打开与目标核对同理（DEV-0104）。
  const provisionalFactsVisible = useDelayedVisible(provisionalTarget && error === null, 200);
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
  // 首条输入器的发送选项与资料合成一枚浮层（2026-10-24 用户指令「这两个合成一个芯片就好了」）：
  // 关闭语义（点外面、Esc 还焦点、互斥）与翻面量算（贴芯片锚定，右缘越界时翻面）各归一个钩子。
  const firstOptionsRef = useRef<HTMLDetailsElement>(null);
  useDetailsMenu(firstOptionsRef);
  usePopupFlip(firstOptionsRef);
  const restoreFirstDraftFocus = useCallback(() => {
    restoreComposerFocus(firstDraftRef.current, firstComposerBoxRef.current);
  }, []);

  /**
   * 首条草稿的发送前辅助（工作台 §30）。正文仍是 `first.draft` 一份；这里是纯辅助状态，
   * 提示行渲染在输入卡上方、润色键渲染在输入卡工具行内（与原型 `#polishBtn` 同一位置）。
   * 来源身份带 connection.epoch：重连后即使草稿一字未改，旧结果也必须失效。
   */
  const firstAssist = useComposerDraftAssist({
    client, sourceKey: `${connection.epoch}:first`,
    value: first.draft, onChange: (next) => updateFirst({ draft: next }),
    disabled: firstBusy || creating,
    inflight: firstBusy || creating || pendingFirst !== null,
    composing: firstComposing, onRequestFocus: restoreFirstDraftFocus,
  });

  useEffect(() => {
    if (!standalone && !embedded) return;
    /**
     * 首条草稿已按作用域留在本机（`firstDraftScope`，CollaborationView 写入
     * composerDrafts，离开再回来原文仍在），与正文草稿同一待遇：进 `dirty` 不进
     * `unsaved`。来源选择、技能选择与暂存附件没有持久化，离页即丢，必须保护。
     * 未决命令在途时上层守卫先拒绝 discard，这里照常投影。
     */
    onNavigationStateChange?.({
      dirty: sessionNavigation.dirty || selectedRefs.length > 0 || first.draft.trim() !== "" || firstSkillKey !== ""
        // 未发送的图片同样算未保存内容（§33.2）：它们不在草稿持久化里，离页即丢。
        || stagedFirst.items.length > 0,
      unsaved: sessionNavigation.unsaved || firstSkillKey !== ""
        || selectedRefs.length > 0 || stagedFirst.items.length > 0,
      discard: () => { sessionNavigation.discard?.(); setSelectedRefs([]); setFirstSkillKey("");
        stagedFirst.clear(); updateFirst({ draft: "" }); },
      pending: pendingFirst ? { commandId: pendingFirst.modelSelection && !pendingFirst.modelSelectionConfirmed
          ? pendingFirst.modelSelection.commandId : pendingFirst.commandId,
          commandType: pendingFirst.modelSelection && !pendingFirst.modelSelectionConfirmed
            ? "SelectSessionModel" : "RequestAssistMessage", sessionId: pendingFirst.sessionId }
        : pendingCreate ? { commandId: pendingCreate.commandId,
            commandType: "CreateAssistSession", sessionId: null }
          : sessionNavigation.pending,
      // 首条输入器挂载时它就是触发保护的编辑器；未挂载（已有会话/读被挡）时交给会话输入器的恢复回调。
      restoreFocus: firstDraftRef.current !== null ? restoreFirstDraftFocus : sessionNavigation.restoreFocus });
  }, [standalone, embedded, sessionNavigation, selectedRefs, pendingCreate, pendingFirst, first.draft, firstSkillKey,
    stagedFirst, updateFirst, onNavigationStateChange, restoreFirstDraftFocus]);

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
      const list = await client.getAssistSessions({ includeContext: conversationToolbar });
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
    // 工作空间级没有 target 要核对，但「列表已读过一次」同样要落地：
    // 指定会话的重挂载靠它结束待读占位，读不到时才显示「还没有会话」。
    finally { if (version === requestVersion.current) { setLoading(false); setTargetSettled(true); } }
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
        client.getAssistSessions(kind === "PROJECT" ? { projectId: id, includeContext: conversationToolbar } : { taskId: id, includeContext: conversationToolbar })]);
      if (version !== requestVersion.current || client !== liveClient()) return;
      const scoped = list.filter((item) => targetMatches(item, nextTarget));
      setTarget(nextTarget); setTargetSettled(true); setSessions(scoped);
      // null 表示从独立页开始新会话；undefined 保留项目/任务子页的默认最近会话行为。
      const preferred = preferredSessionIdFromRefresh !== undefined
        ? preferredSessionIdFromRefresh : preferredSessionId;
      const current = sessionIdRef.current;
      applyActiveSession(preferred === null
        ? current && scoped.some((item) => item.id === current) ? current : null
        : preferred ? scoped.some((item) => item.id === preferred) ? preferred : null
          : current && scoped.some((item) => item.id === current) ? current : scoped[0]?.id ?? null);
      if (preferred && !scoped.some((item) => item.id === preferred))
        setError("所选会话不属于当前工作对象，请刷新会话列表后重试。");
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
   * 协作页报来一次已确认的作用域变化 → 重读当前这一条的服务端事实。
   * 首挂载由 `loadTarget` 负责，因此第 0 拍不读；换会话时计数没动也不读。
   * 读失败保留上一份读数：宁可顶栏停在旧事实，也不把没读到的写成已绑定。
   */
  const contextEpochSeen = useRef(sessionContextEpoch);
  useEffect(() => {
    if (contextEpochSeen.current === sessionContextEpoch) return;
    contextEpochSeen.current = sessionContextEpoch;
    const current = sessionId;
    if (current === null || client === null) return;
    let alive = true;
    void client.getAssistSession(current, true).then((next) => {
      if (!alive || next.id !== current) return;
      setSessions((items) => items.map((item) => item.id === current ? next : item));
    }).catch(() => { /* 交给下一次整列读取收敛，不在这里改口径。 */ });
    return () => { alive = false; };
  }, [sessionContextEpoch, client, sessionId]);

  /**
   * 首条消息成功（或回执核对成功）后走既有执行解释链。
   * 依据只能是真实回执里的 user message id 与该命令产生时绑定的确切目录资源；
   * 回执未确定时不猜 source_message_id，换目录后也不从当前作用域重新取值。
   * 解释结果写回共享 Owner，由会话面板既有 Owner 渲染与执行，不另建一套确认门。
   *
   * 同一原消息只解释一次：先在 Owner 上按 command_id 声明，重复或迟到的成功路径拿不到声明。
   */
  async function confirmFirstMessage(pending: PendingFirstMessage) {
    const current = firstOwner.read();
    if (current.interpreted === pending.commandId || current.pending?.commandId !== pending.commandId) return;
    // 主流程保存执行/维护候选；前端只确认原消息发送，不再抢先解释或建立执行。
    firstOwner.write({ ...current, interpreted: pending.commandId,
      interpretedSessionId: pending.sessionId, pending: null, draft: "" });
    setFirstPendingDialogOpen(false);
  }

  /**
   * 建会话回执 → 读回作用域（运行架构 §2.8）。
   *
   * 「新普通会话落在哪」由服务端在建会话事务里决定：没指定项目/任务时可能继承
   * Workspace 默认目录，回执因此带 project_id。这里只按回执 session_id 读回上下文，
   * 不从本地最近目录或配置投影推断。两个入口（首次响应与创建回执恢复）共用这一条读法。
   *
   * 继承默认作用域的会话不属于工作区级会话：交回宿主切到那个项目作用域，并带出来源，
   * 不在这里补第二次目录绑定。返回 null 表示这一次读取已被更新的请求取代，调用方停止；
   * 返回值里的 `session` 是创建后读回的投影，交给宿主作为重挂载首帧的种子。
   */
  async function adoptCreatedSession(sessionId: string, projectIdHint: string | null,
    version: number): Promise<{ session: RelayAssistSession | null } | null> {
    if (client === null) return null;
    let resolved: RelayAssistSession | null = null;
    let directory: { resourceId: string; canonicalRoot: string | null;
      source: RelayWorkingDirectorySource | null } | null = null;
    try {
      const read = await client.getAssistSession(sessionId, true);
      if (read.id === sessionId) { resolved = read; directory = read.context?.workingDirectory ?? null; }
    } catch { /* 读回失败：退回回执本身的事实，不猜目录来源。 */ }
    if (version !== requestVersion.current) return null;
    const projectId = resolved?.projectId ?? projectIdHint;
    if (target === null && projectId !== null) {
      if (resolved !== null) {
        const created = resolved;
        setSessions((current) => current.some((item) => item.id === sessionId)
          ? current.map((item) => item.id === sessionId ? created : item) : [created, ...current]);
      }
      applyActiveSession(sessionId);
      onSessionScopeResolved?.({ sessionId, projectId, workingDirectory: directory });
    } else {
      await loadTarget(sessionId);
      if (requestVersion.current !== version + 1) return null;
    }
    return client === liveClient() ? { session: resolved } : null;
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
      ...(firstChatModeRef.current === null ? {} : { chatMode: firstChatModeRef.current }),
      ...(firstOwner.read().model ? { modelSelection: { model: firstOwner.read().model!, commandId: createCommandId() } } : {}),
      conversationMode: wantedMode, assistantProfileId: wantedMode === "ASSISTANT" ? wantedAssistantId : null,
      // 图片随建会话载荷一起固定：重试按同一份文件重传，不会捡用户后来新加的图。
      ...(stagedFirst.items.length === 0 ? {} : { attachmentFiles: stagedFirst.items.map((item) => item.file) }),
      /* 资料版本与图片同一时刻固定：重试发送的是这一组 kind/rootId/version，
         不读用户之后改过的选择。只有普通档允许选资料（助手/学习档没有资料入口）。 */
      ...(wantedMode !== "AGENT" || selectedRefs.length === 0 ? {} : { sourceRefs: [...selectedRefs] }),
      ...(wantedMode === "LEARNING" ? { recordLearning } : {}) };
    // 模式已随 action 固定；清掉 ref，下一次建会话不带上一次的 /plan /goal。
    firstChatModeRef.current = null;
    const version = requestVersion.current;
    // 新一轮创建不继承上一次的核对弹窗；按原命令重试时保持原样，失败原因仍留在那一层。
    if (!retry) setCreatePendingDialogOpen(false);
    setCreating(true); setCreateError(null); setPendingCreate(action);
    try {
      const created = await client.createAssistSession(action satisfies CreateSessionInput);
      if (version !== requestVersion.current) return;
      setPendingCreate(null); setCreating(false); setCreatePendingDialogOpen(false);
      // 作用域由服务端决定：读回上下文后再决定这条会话属于哪一份清单。
      const adopted = await adoptCreatedSession(created.id, created.projectId, version);
      if (adopted === null) return;
      onSessionCreated?.(created.id, adopted.session ?? undefined);
      // 首条只发一次：命令 ID 与原始载荷在发送前就固定。响应丢失时保留 pendingFirst，
      // 由「查询首条回执」按原 command_id 核对或「按原命令重试」，绝不重建会话，
      // 也不把后来修改的文本混入原载荷。
      // 只有图片、没有文字的首条同样要发（§33 / HTTP §10.85）：判据是「有正文或有附件」。
      if (action.firstContent !== "" || (action.attachmentFiles?.length ?? 0) > 0) {
        const first: PendingFirstMessage = { sessionId: created.id, commandId: createCommandId(),
          ...(action.modelSelection === undefined ? {} : { modelSelection: action.modelSelection }),
          content: action.firstContent, conversationMode: action.conversationMode,
          ...(action.chatMode === undefined ? {} : { chatMode: action.chatMode }),
          reason: null, resourceId: action.resourceId,
          ...(action.sourceRefs === undefined ? {} : { sourceRefs: action.sourceRefs }),
          ...(action.attachmentFiles === undefined ? {} : { attachmentFiles: action.attachmentFiles }),
          ...(firstSkill === null ? {} : { skillRef: { id: firstSkill.id, version: firstSkill.version } }),
          ...(action.recordLearning === undefined ? {} : { recordLearning: action.recordLearning }) };
        // 在途标记由 sendFirstMessage 自己在同一 Owner 上置位，这里只登记命令身份与载荷。
        firstOwner.write({ ...firstOwner.read(), pending: first, draft: action.firstContent });
        setFirstError(null);
        await sendFirstMessage(first);
      }
    } catch (caught) {
      if (version !== requestVersion.current) return;
      // 原因随结果类型换通道：未决时留在核对弹窗里，明确拒绝时由 pendingCreate 为空走 Notice。
      setCreateError(describeLiveError(caught).message);
      // 明确拒绝才说明会话没建出来；传输失败与 5xx 都可能已经落库，留给回执弹窗。
      if (!needsReceiptCheck(caught)) {
        setPendingCreate(null); setCreatePendingDialogOpen(false);
      }
    } finally { if (version === requestVersion.current) setCreating(false); }
  }

  /**
   * 首条发送与同 ID 重试共用这一条路径：命令 ID 与载荷在发送前固定，
   * 重试不换 ID、不重建会话、不混入后来修改的文本。
   * 在途标记写在共享 Owner 上，跨重挂载有效：新实例不会再对同一条消息发第二次解释。
   */
async function sendFirstMessage(pending: PendingFirstMessage, retry = false) {
    // 同步闸：在途标记必须读 Owner 而不是本实例的 ref，否则重挂载后的新实例会重发。
    const current = firstOwner.read();
    if (!client || current.busy) return;
    if (current.interpreted === pending.commandId) return;
    // 目录先持久绑定，再发送首条。固定绑定命令身份，响应丢失后仍沿原命令重放。
    if (pending.resourceId !== null && pending.directoryCommandId === undefined) {
      pending = { ...pending, directoryCommandId: createCommandId() };
    }
    // 按原命令重试时核对弹窗保持打开（按钮显示在途）；新一轮发送不继承上一轮的弹窗。
    if (!retry) setFirstPendingDialogOpen(false);
    // 重试开始时清掉上一次的未决原因：在途不是「结果待核对」。
    pending = { ...pending, reason: null };
    firstOwner.write({ ...current, pending, busy: true, failure: null });
    setCreating(true); setFirstError(null); setFirstPendingError(null);
    try {
      let expectedModelSelectionRevision: string | undefined;
      if (pending.modelSelection !== undefined) {
        const selection = await client.selectSessionModel({ sessionId: pending.sessionId, ...pending.modelSelection });
        expectedModelSelectionRevision = selection.revision;
        if (firstOwner.read().pending?.commandId !== pending.commandId || client !== liveClient()) return;
        pending = { ...pending, modelSelectionConfirmed: true };
        firstOwner.write({ ...firstOwner.read(), pending });
      }
      if (pending.resourceId !== null && pending.directoryCommandId !== undefined) {
        await client.bindAssistSessionDirectory({ sessionId: pending.sessionId,
          commandId: pending.directoryCommandId, resourceId: pending.resourceId });
        if (firstOwner.read().pending?.commandId !== pending.commandId || client !== liveClient()) return;
        await loadTarget(pending.sessionId);
        onActiveSessionChange?.(pending.sessionId);
      }
      // 0093：会话此刻才存在，图片只能在这里上传。上传成功立刻把 ids 写回同一份 pending：
      // 之后无论回执核对还是「按原命令重试」，发的都是同一组 id（换 id 就是换载荷，
      // 服务端会按 COMMAND_ID_REUSED 拒绝）。上传失败不动 pending 的命令身份——
      // 消息尚未发出，重试会重新上传再发送。
      if (pending.attachmentIds === undefined && (pending.attachmentFiles?.length ?? 0) > 0) {
        setFirstAttaching(true);
        try {
          const ids = await uploadStagedAttachments(client, pending.sessionId,
            pending.attachmentFiles!.map(uploadCandidateFrom));
          if (firstOwner.read().pending?.commandId !== pending.commandId || client !== liveClient()) return;
          pending = { ...pending, attachmentIds: ids };
          firstOwner.write({ ...firstOwner.read(), pending });
          stagedFirst.clear();
        } finally { setFirstAttaching(false); }
      }
      // skill_ref 决定意图，服务端禁止与 intent 混用：带 Skill 的首条消息不传 intent，
      // 普通/学习档保持 intent，助手档两者都不传（服务端对助手档拒绝这两者）。
      const skillIntentPayload: { intent?: never; skillRef?: never; skillInput?: never } |
        { intent: "DISCUSS" } |
        { skillRef: { id: string; version: string }; skillInput: RelaySkillInput } =
        pending.skillRef !== undefined ? { skillRef: pending.skillRef, skillInput: {} }
          : pending.conversationMode === "AGENT" ? { intent: "DISCUSS" } : {};
      await client.requestAssistMessage({ sessionId: pending.sessionId, commandId: pending.commandId,
        ...(expectedModelSelectionRevision === undefined ? {} : { expectedModelSelectionRevision }),
        ...(pending.chatMode === undefined ? {} : { chatMode: pending.chatMode }),
        content: pending.content, sourceRefs: pending.sourceRefs ?? [],
        ...(pending.attachmentIds === undefined ? {} : { attachmentIds: pending.attachmentIds }),
        ...(pending.recordLearning === undefined ? {} : { recordLearning: pending.recordLearning }),
        ...skillIntentPayload });
      // 回执核对或新对话已接续后，旧响应不再拥有这份过程，不能清掉新草稿或再次解释。
      if (firstOwner.read().pending?.commandId !== pending.commandId) return;
      // 连接已换时不猜结果：保留原命令与未决事实，等核对或同 ID 重试。
      if (client !== liveClient()) {
        firstOwner.write({ ...firstOwner.read(),
          pending: { ...pending, reason: "连接已变化，首条消息结果待核对。" } });
        return;
      }
      firstOwner.write({ ...firstOwner.read(), busy: false });
      // 服务端已受理这条首条消息：把它用过的资料版本记进本机「最近引用」
      // （只记 kind/rootId/version 三元组，不缓存任何资料内容）。
      rememberSourceRefs(pending.sourceRefs ?? []);
      setCreating(false);
      await confirmFirstMessage(pending);
    } catch (caught) {
      // 迟到失败不得复活已被核对清空的 pending：只有仍指向同一命令时才写回。
      const latest = firstOwner.read();
      if (latest.pending === null || latest.pending.commandId !== pending.commandId) return;
      const described = describeLiveError(caught);
      /**
       * 传输失败与 5xx 不能推断成业务失败：原命令身份与真实原因一并保留，等核对或同 ID 重试。
       * 服务端明确拒绝（422、409 版本冲突等）相反：命令没有落库，也不存在可核对的结果，
       * 继续保留未决身份会把明确失败读成「结果待核对」，并永久锁住输入卡
       * （2026-10-24 用户截图：422 attachment_ids 拒绝仍显示 command_id 与两个核对出口）。
       */
      if (!needsReceiptCheck(caught)) {
        setFirstPendingDialogOpen(false);
        firstOwner.write({ ...latest, busy: false, pending: null,
          failure: described.message, failureSessionId: pending.sessionId });
        return;
      }
      firstOwner.write({ ...latest, busy: false, pending: { ...pending, reason: described.message } });
    } finally { setCreating(false); }
  }

  /**
   * 首条消息回执核对：只按原 command_id 查询，不重建会话、不改载荷、不猜测结果。
   * 核对成功后与迟到响应走同一个 confirmFirstMessage，由共享 Owner 确认原发送过程。
   */
  async function checkFirstReceipt() {
    if (!client || !pendingFirst || creating) return;
    const pending = pendingFirst; const version = requestVersion.current;
    firstOwner.write({ ...firstOwner.read(), busy: true });
    setCreating(true); setFirstPendingError(null);
    try {
      const selectingModel = pending.modelSelection !== undefined && !pending.modelSelectionConfirmed;
      const receipt = await client.getCommandReceipt(selectingModel ? pending.modelSelection!.commandId : pending.commandId);
      if (version !== requestVersion.current) return;
      if (selectingModel) {
        const selection = sessionModelSelectionFrom(receipt.result);
        if (receipt.commandId !== pending.modelSelection!.commandId || receipt.commandType !== "SelectSessionModel" ||
            selection.sessionId !== pending.sessionId || selection.model !== pending.modelSelection!.model) {
          throw new Error("首条模型选择回执与原命令不匹配。");
        }
        const continued = { ...pending, modelSelectionConfirmed: true };
        firstOwner.write({ ...firstOwner.read(), busy: false, pending: continued });
        setCreating(false);
        await sendFirstMessage(continued, true);
        return;
      }
      const result = receipt.result as { session_id?: unknown; user_message_id?: unknown };
      if (receipt.commandId !== pending.commandId || receipt.commandType !== "RequestAssistMessage" ||
          result.session_id !== pending.sessionId || typeof result.user_message_id !== "string") {
        throw new Error("首条消息回执与原命令不匹配。");
      }
      // 回执不匹配时不得清 pending，也不得宣称已送达。
      firstOwner.write({ ...firstOwner.read(), busy: false });
      setCreating(false);
      await confirmFirstMessage(pending);
    } catch (caught) {
      const latest = firstOwner.read();
      firstOwner.write({ ...latest, busy: false });
      if (version === requestVersion.current) setFirstPendingError(describeLiveError(caught).message);
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
      setPendingCreate(null); setCreating(false); setCreatePendingDialogOpen(false);
      const createdSessionId = receipt.result.session_id;
      // 回执里的 project_id 也是服务端事实（可能来自默认目录继承），但目录来源仍要读回。
      const createdProjectId = typeof receipt.result.project_id === "string" ? receipt.result.project_id : null;
      const adopted = await adoptCreatedSession(createdSessionId, createdProjectId, version);
      if (adopted === null) return;
      onSessionCreated?.(createdSessionId, adopted.session ?? undefined);
      // 创建与发送是同一首条过程的两个命令：恢复出会话后必须续发原首条，
      // 否则用户只看到空白会话，原文与载荷就此丢失。
      if (action.firstContent !== "") {
        const first: PendingFirstMessage = { sessionId: createdSessionId, commandId: createCommandId(),
          ...(action.modelSelection === undefined ? {} : { modelSelection: action.modelSelection }),
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

  // 目录名悬停提示：hooks 必须早于下面几处提前 return，因此这里只放取值函数，
  // 真正的路径在组件体后段算出后写进这个 ref（2026-10-20）。
  const directoryPathRef = useRef<string | null>(null);
  const { tooltipHandlers: directoryTooltipHandlers, tooltipNode: directoryTooltipNode } =
    usePathTooltip(() => directoryPathRef.current);

  if (connection.mode !== "live") return <section className="page-state" data-testid="assist-fixture-gap"><p className="eyebrow">Assist</p><h1>示例模式没有真实会话</h1><p>连接本机 API 后才能读取项目或任务会话；示例模式不生成模型回复或提案。</p></section>;
  // 种子目标只替首帧占位，不替服务端宣布核对通过：真读失败仍落到可重试的错误页。
  if (!workspaceLevel && error && (provisionalTarget || target?.id !== id || target.kind !== kind)) return <section className="page-state page-state--error" role="alert"><p className="eyebrow">Assist</p><h1>暂时无法读取对话工作对象</h1><p>{error}</p><button className="secondary-button" type="button" onClick={() => void loadTarget()}><RotateCcw aria-hidden="true" />重新读取</button></section>;
  // 工作空间级模式没有 target 可核对，不能因此停在占位页 —— 那正是没选目录时用户看到的东西。
  if (!workspaceLevel && (target?.id !== id || target.kind !== kind)) return <section className="page-state" aria-live="polite"><p className="eyebrow">Assist</p><h1>正在核对对话作用域与会话</h1></section>;
  if (!client || (!workspaceLevel && !target)) return null;
  // 工作空间级讨论还没有项目，因此没有归档或项目事实可失败；执行准入另由 executionScope 判定。
  // 种子阶段宿主刚读到的目录/任务事实已足够建会话（项目 ID 与归档位都来自同一次服务端读数），
  // 不再因为「项目详情还在读」把发送键按住；读回后以完整事实替换，失败另走错误页。
  const projectWriteBlockedReason = workspaceLevel ? (externalReadBlockedReason ?? externalWriteBlockedReason)
    : externalReadBlockedReason ?? externalWriteBlockedReason ?? (target!.projectId === null ? null
      : provisionalTarget ? (target!.archivedAt ? "项目已归档，不能发送新的 Assist 命令。" : null)
      : loading || error !== null || target!.archivedAt === undefined ?
    "Project 事实正在核对或读取失败，不能发送新的 Assist 命令。" : target!.archivedAt !== null ?
      "项目已归档，不能发送新的 Assist 命令。" : null);
  // 种子阶段的「正在核对」只在真的等出来时才说；错误原因立即可见，不走延迟。
  const projectWriteBlockedReasonShown = projectWriteBlockedReason !== null &&
    (!provisionalTarget || error !== null || provisionalFactsVisible) ? projectWriteBlockedReason : null;
  const session = sessions.find((item) => item.id === sessionId) ?? null;
  // 明确拒绝的原因住在共享 Owner 上：建会话成功后本实例会被重挂载，本地 firstError 随之丢失。
  // 只在该命令所属会话（或尚未选会话的首条输入器）上显示，换会话后不残留。
  const sharedFailure = first.failure !== undefined && first.failure !== null &&
    (session === null || session.id === first.failureSessionId) ? first.failure : null;
  /**
   * `reason` 只在传输失败等「结果不明」时写入，重试一开始就清掉；因此它同时是
   * 「要收起在途行、换成未决状态与核对弹窗」的判据，不需要第二份布尔状态。
   */
  const firstPendingUnresolved = pendingFirst !== null && pendingFirst.reason !== null;
  const firstPendingOpen = pendingFirst !== null && firstPendingDialogOpen;
  // 明确失败没有可核对的结果，走停留到关闭的 Notice；它的原因住在弹窗里，不混进这里。
  const firstNotice = firstError ?? sharedFailure;
  /**
   * 模式是**会话属性**：已在会话上的身份以会话为准；没有会话时由协作页持有的工作对象身份
   * 决定「新建哪一条」。工作对象身份缺省即普通档，不猜助手。
   */
  const wantedMode: RelayConversationMode = session?.conversationMode
    ?? conversationTarget?.mode ?? "AGENT";
  const wantedAssistantId = session?.conversationMode === "ASSISTANT"
    ? session.assistantProfileId : conversationTarget?.assistantProfileId ?? null;
  /* 首条消息的资料入口（DEV-0100）：资料按项目版本解析，没有项目归属就没有可核对的候选；
     助手档与学习档没有资料入口。这里只决定「入口是否可选」，真正发送时仍由服务端复核版本。 */
  const firstSourcesSelectable = wantedMode === "AGENT" && firstScope.projectId !== null;
  const firstSourcesNote = firstSourcesSelectable ? null : wantedMode === "AGENT"
    ? "选择项目或指定目录后可选资料"
    : wantedMode === "ASSISTANT" ? "助手档没有资料；切到普通档后可选" : "学习档没有资料；切到普通档后可选";
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
    // 换会话不再询问是否丢弃草稿：原文按会话留在本机，回到原会话时原样恢复。
    // 只有未决命令（结果待核对）仍必须先核对，不能靠切走绕过。
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
  /**
   * 建会话成功后协作页会把新会话 ID 交回来并重挂载本视图：读回前（`targetSettled`
   * 为假）不显示「当前工作对象还没有会话」这类尚未核实的结论。首条输入器本身仍保留为
   * 兜底：创建投影读不回来时，它是唯一还持有原草稿、可继续编辑的入口；投影能读回时
   * 首帧就有会话（`initialSession`），不会经过它（DEV-0110 闪烁修复见会话种子）。
   */
  const preferredSessionLookup = session === null && preferredSessionId !== undefined &&
    preferredSessionId !== null && !targetSettled;
  const firstComposer = deferSessionCreation && session === null && externalReadBlockedReason === null;
  function sendFirst(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const content = first.draft.trim();
    // 带图片时可以没有文字（§33 / HTTP §10.85）：只有图片也是合法的一条输入。
    const withImages = stagedFirst.items.length > 0;
    if ((content === "" && !withImages) || content.length > 32768 || firstBusy || creating ||
      creationPending || projectWriteBlockedReason !== null || firstAssistantBlockedReason !== null) return;
    // 选中的 Skill 缺上下文时不能发：服务端会按作用域不匹配拒绝，发出去只是把问题推给用户。
    if (firstSkillScopeMissing) {
      setFirstError(`这个 Skill 需要${firstSkill?.target === "TASK" ? "任务" : "项目"}上下文；先在工具行指定任务或项目。`);
      return;
    }
    // 0127：`/plan 内容`、`/goal 内容` 在空会话里直接建带模式的会话——命令与正文是
    // 同一条消息，不是「先切模式再发送」两次操作。只写命令不写正文时不新建会话：
    // 空会话没有「当前模式」可供切换，提示里说清缺的是内容。
    const modeCommand = chatModeCommandFromText(content);
    if (modeCommand !== null) {
      if (modeCommand.rest === "") {
        setFirstError(modeCommand.mode === "PLAN"
          ? "先写要规划的内容：输入 /plan 加内容，一起发送。"
          : "先写目标：输入 /goal 加内容，一起发送。");
        return;
      }
      firstChatModeRef.current = modeCommand.mode;
      setFirstError(null); updateFirst({ draft: modeCommand.rest });
      void createSession();
      return;
    }
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
   * 原因与档位说明都渲染在**输入卡之外**（卡下方这一列）：输入卡是用户正在打字的那个框，
   * 它一随状态长高、变矮，光标与工具行就跟着跳——卡内恒定只有正文、工具行与发送键。
   */
  const modeLocked = firstBusy || creating || sessionInflight || sessionNavigation.pending !== null;
  const modeLockedReason = modeLocked ? "正在生成，停止后才能切换会话模式。" : null;
  const modeSwitch = <ConversationModeSwitch mode={wantedMode}
    assistantProfileId={wantedAssistantId} profiles={assistantProfiles}
    profilesError={assistantProfilesError} profilesLoading={assistantProfilesLoading}
    onReloadProfiles={() => { void reloadAssistantProfiles(); }} remember={rememberNext}
    disabled={modeLocked} lockedReason={modeLockedReason}
    onChangeMode={(next) => switchConversation(next, next === "ASSISTANT" ? wantedAssistantId : null)}
    onChangeAssistant={(profileId) => switchConversation("ASSISTANT", profileId)}
    onChangeRemember={setRememberNext}
    recordLearning={recordLearning} onChangeRecordLearning={setRecordLearning}
    onCreateAssistant={createAssistant} />;
  // 「待你处理」按工作区取数：项目看目标与归属本项目的待判断，文件夹看未读讨论，其余看全局。
  const pendingProjectId = target === null ? (executionScope?.association?.projectId ?? null)
    : target.kind === "PROJECT" ? target.id : target.projectId;
  const pendingResourceId = target === null ? (executionScope?.association?.resourceId ?? null) : null;
  const pendingContext: PendingContext = pendingProjectId !== null
    ? { scope: "PROJECT", projectId: pendingProjectId }
    : pendingResourceId !== null ? { scope: "FOLDER", resourceId: pendingResourceId }
      : { scope: "GLOBAL" };
  /**
   * 空态说明句（工作台 §18.1.5 / 测试计划 DD-10）：两种状态必须说清各自的事实。
   * 未设置仍保留「不需要先创建项目、任务」，但不再承诺「不需要目录也能读文件」；
   * 默认生效时说清新会话会用它，失效时必须说清它不会生效——不能显示成已有可读目录。
   */
  const firstLede = workspaceDefault?.status === "READY"
    ? `可以直接讨论或描述目标。不需要先创建项目、任务；新会话会使用设置里的默认目录「${workspaceDefault.displayName ?? "默认目录"}」。`
    : workspaceDefault?.status === "UNAVAILABLE"
      ? "可以直接讨论或描述目标。不需要先创建项目、任务；设置里的默认目录当前不可用，新会话不会使用它，读取文件前需要选择目录。"
      : "可以直接讨论或描述目标。不需要先创建项目、任务；要读取文件时再选择工作目录。";
  const firstMessage = <section className="surface-panel agent-chat-conversation agent-chat-start" data-testid="assist-first-message">
    {/* 不再用编号步骤引导——那会把首屏最该被看到的输入框挤下去。
        目前是通用模板，之后可随工作区上下文动态变化。 */}
    <EmptyWorkWelcome testId="assist-first-welcome" suggestTestIdPrefix="assist-first-suggest"
      lede={firstLede}
      onSuggest={(text) => { updateFirst({ draft: text });
        firstComposerBoxRef.current?.querySelector("textarea")?.focus(); }} />
    <RecentActivitySummary client={client} />
    {/* 目录细条（嵌入态是状态行）与「待你处理」共用一行（2026-10-18 用户指令）：
        细条按内容收、待处理紧跟其后；归属回执仍各自占整行，不与这一行挤在一起。 */}
    <div className="agent-chat-prereq-row">
      {composerHeader}
      {/* 状态行与目录细条合并（2026-10-18 用户指令「这两行的功能重复了」）：有细条时
          这一行不再渲染——工作目录与「更换目录」只由细条一处承担（目录名即入口）。
          嵌入态没有细条，也没有目录操作入口，只留这段只读摘要。 */}
      {composerHeader === undefined && <ComposerStatusBar directory={executionScope ?? null}
        writeTier={firstWriteTier} showWrite={wantedMode === "AGENT"} />}
      <PendingWorkStrip client={client} context={pendingContext} />
    </div>
    {/* 发送前草稿辅助（工作台 §30）：提示行紧贴输入卡上方，正文仍归本处 Owner，辅助只申请替换。 */}
    <ComposerDraftBar assist={firstAssist} value={first.draft} />
    <div className="agent-chat-composer" data-inflight={firstBusy || creating}
      data-busy={firstBusy || creating ? "true" : undefined} ref={firstComposerBoxRef}>
    <span className="agent-chat-composer-spark-clip" aria-hidden="true"><span className="agent-chat-composer-spark" aria-hidden="true" /></span>
    <form id={firstComposerFormId} className="agent-chat-message-form" onSubmit={sendFirst}>
      {/* 附件芯片在卡片顶部、正文上方（2026-10-24 用户指令）：悬停预览默认贴锚点上方
          浮出，芯片在正文下方时预览正好盖住刚输入的文字；挪到顶部后预览浮在卡外。
          它仍是这条消息的组成部分，不与「档位说明/回执」那类卡外状态混在一起（§33.2）。 */}
      <ComposerAttachmentChips items={stagedFirst.items} error={stagedFirst.error}
        uploading={firstAttaching} disabled={firstBusy || creating} onRemove={stagedFirst.remove} />
      <div className="field"><span className="visually-hidden">本次消息</span>
        <ChatCommandInput client={client} mode={wantedMode} hasSession={false}
          data-testid="assist-first-draft" ref={firstDraftRef} value={first.draft} maxLength={32768} rows={2}
          disabled={firstBusy || creating} placeholder="输入你的想法、修改意见或新的要求"
          onCompositionChange={setFirstComposing}
          onAttachFiles={(files) => stagedFirst.add(files)}
          pluginChips
          onValueChange={(draft) => updateFirst({ draft })} onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
              event.preventDefault(); event.currentTarget.form?.requestSubmit();
            }
          }} /></div>
    </form>
    <div className="agent-chat-composer-actions">
      <div className="agent-chat-composer-tools">
        <ComposerAttach
          client={client} mode={wantedMode} hasSession={false}
          onCommand={() => { updateFirst({ draft: first.draft.startsWith("/") ? first.draft : `/${first.draft}` });
            firstComposerBoxRef.current?.querySelector("textarea")?.focus(); }}
          onPickCommand={(name) => { updateFirst({ draft: `${first.draft.match(/^\s*/u)?.[0] ?? ""}/${name} ` });
            firstComposerBoxRef.current?.querySelector("textarea")?.focus(); }}
          onPickPlugin={(label) => { updateFirst({ draft: insertPluginMention(first.draft, label, firstDraftRef.current) });
            firstDraftRef.current?.focus(); }}
          onUploadAttachments={(files) => { stagedFirst.add(files); firstDraftRef.current?.focus(); }}
          uploadDisabled={firstBusy || creating || pendingFirst !== null || firstAttaching}
          workspace={executionScope?.association === null || executionScope?.association === undefined ? null
            : { projectId: executionScope.association.projectId,
              resourceId: executionScope.association.resourceId, displayName: executionScope.displayName }}
          artifactTaskId={firstScope.taskId}
          onInsertMention={(label) => { updateFirst({ draft: insertMention(first.draft, label, firstDraftRef.current) });
            firstDraftRef.current?.focus(); }}
          projectId={firstScope.projectId}
          /* 首条消息也能选资料（DEV-0100）：候选来自项目资料与最近引用，
             选中项随建会话载荷冻结，发送后由新会话的资料选择器清空本次选择。 */
          selectedRefs={firstSourcesSelectable ? selectedRefs : []}
          recentRefs={firstSourcesSelectable ? readRecentSourceRefs() : []}
          onToggleSourceRef={firstSourcesSelectable ? toggleSourceRef : undefined}
          /* 清单恒定全量（2026-10-18）：助手档与学习档服务端拒绝 skill_ref，只有这两个档不传。 */
          skills={wantedMode === "AGENT" ? firstSkills : undefined}
          skillContext={{ projectId: firstScope.projectId, taskId: firstScope.taskId,
            resolveInPlace: onRequestSkillTarget !== undefined }}
          selectedSkillKey={firstSkillKey || null}
          onPickSkill={setFirstSkillKey}
          notes={[...(firstSourcesNote === null ? [] : [{ text: firstSourcesNote, keys: ["sources"] }]),
            /* 助手档与学习档服务端拒绝 skill_ref：清单根本不传，面板里要说明这是档位事实，
               而不是「当前没有可用的 Skill」。 */
            ...(wantedMode === "AGENT" ? [] : [{ text: wantedMode === "ASSISTANT"
              ? "助手档没有 Skill；切到普通档后可选" : "学习档没有 Skill；切到普通档后可选",
              keys: ["skill"] }]),
            /* 缺上下文的 Skill 现在可点开、可选中，缺口由输入器里的工作对象芯片补齐；
               这句只做悬停 title，说明「选中之后会发生什么」，不再宣称整类不可用。 */
            ...(firstSkillScopeMissing && onRequestSkillTarget !== undefined
              ? [{ text: "这个 Skill 需要任务或项目上下文；选完后在工具行指定任务或项目", keys: ["skill"] }] : []),
            ...(firstSkillScopeMissing && onRequestSkillTarget === undefined
              ? [{ text: "这个 Skill 需要任务或项目上下文；从对应任务或项目进入对话后可用", keys: ["skill"] }] : []),
            /* 连接器按项目登记：没有项目归属时入口仍可点开，但菜单底就该先说明去哪看。 */
            ...((executionScope?.association?.projectId ?? null) === null && client !== null
              ? [{ text: connectorScopeNote, keys: ["connectors"] }] : [])]} />
        {/* 本目录写档位（§18.1.3）：紧挨「+」常驻；没有绑定目录时显示未绑定态并说明缺什么。
            档位同源上报给上方状态行。 */}
        {wantedMode === "AGENT" && <WritePermissionControl client={client}
          projectId={executionScope?.association?.projectId ?? null}
          resourceId={executionScope?.association?.resourceId ?? null}
          canonicalRoot={executionScope?.canonicalRoot ?? null}
          disabled={firstBusy || creating || pendingFirst !== null || projectWriteBlockedReason !== null}
          onTier={setFirstWriteTier} />}
        {/* 选中的 Skill 缺上下文时，工具行直接给出补齐入口（工作台 §32.11）：不能让「选了
            用不了」停在输入框里，也不能伪造归属——选定工作对象后由宿主把讨论带到该工作对象作用域。 */}
        {firstSkill !== null && firstSkillScopeMissing && onRequestSkillTarget !== undefined &&
          <ComposerTargetPicker client={client} need={firstSkill.target}
            disabled={firstBusy || creating}
            onPick={(choice) => onRequestSkillTarget({ ...choice, skillId: firstSkill.id })} />}
        {modeSwitch}
        <ComposerPolishButton assist={firstAssist} />
        {/* 首条输入器的发送选项与资料合成一颗芯片一片浮层（2026-10-24 用户指令「这两个合成
            一个芯片就好了」）：上为默认目录说明与快捷键，下为资料选择（DEV-0100，选中项随
            建会话载荷冻结）。此前「普通讨论」说明与资料各是一枚 chip 一片浮层（2026-10-18
            拆分），合并后多开从构造上不可能。没有项目归属时资料节换成一句禁用说明，
            不再摆一颗点了不亮的芯片。 */}
        {wantedMode === "AGENT" && <details className="agent-chat-options" ref={firstOptionsRef}
          data-testid="assist-first-send-options">
          <summary>普通讨论<ChevronDown aria-hidden="true" className="agent-chat-chip-chevron" /></summary>
          <div className="agent-chat-options-panel">
          {/* 2026-10-24 用户指令：默认目录就绪时不再复述（欢迎语与目录细条已承载）；
              默认目录不可用与未选目录是用户无从预知的受阻/空态事实，保留。 */}
          {workspaceDefault?.status !== "READY" && <p className="helper-text">
            {workspaceDefault?.status === "UNAVAILABLE"
              ? "直接发送即可开始讨论。设置里的默认目录当前不可用，读取文件前先选择文件夹。"
              : "直接发送即可开始讨论。需要读取项目文件时，先选择文件夹。"}</p>}
          <p className="helper-text">Enter 发送 · Shift + Enter 换行</p>
          {firstSourcesSelectable
            ? <div className="agent-chat-options-section">
                <AssistSourcePicker projectId={firstScope.projectId} selectedRefs={selectedRefs}
                  onChange={setSelectedRefs} disabled={firstBusy || creating || pendingFirst !== null} />
              </div>
            : firstSourcesNote !== null && <div className="agent-chat-options-section">
                <p className="helper-text">{firstSourcesNote}</p>
              </div>}
          </div>
        </details>}
      </div>
      {/* 工具行右端一组（2026-10-20 用户指令「上下文和模型下拉按钮整体移动到发送按钮的左边」）：
          上下文计量环与模型下拉收在发送键左边，两枚同进同退；这一档取代 2026-10-19 的「行左端两枚」。
          收成一组而不是散在工具行里，是为了窄栏换行时它们不跟发送键拆开。 */}
      <div className="agent-chat-composer-tail">
        <ContextMeter ratio={null} hitRate={null} call={null} limit={null} />
        <ModelSelector client={client} open={firstModelPickerOpen} onOpenChange={setFirstModelPickerOpen}
          selectedModel={first.model ?? null}
          onChoose={(model) => { updateFirst({ model });
            // 2026-10-20 用户指令「记住上一次选择的模型」：选中的那一刻就记住，
            // 下一个新对话的芯片直接显示它，不再从「模型」两个字开始。
            if (client !== null) writeLastModel(client.workspaceId, model); }}
          firstMessage disabled={firstBusy || creating || pendingFirst !== null} />
      </div>
      <button className="primary-button agent-chat-send" type="submit" data-testid="assist-first-send"
        data-busy={firstBusy || creating || pendingFirst !== null ? "true" : undefined}
        aria-label={firstBusy || creating ? "正在发送首条消息" : "发送消息"}
        title={firstBusy || creating ? "正在发送首条消息"
          : firstSkillScopeMissing ? `这个 Skill 需要${firstSkill?.target === "TASK" ? "任务" : "项目"}上下文；先在工具行指定任务或项目`
          : creationPending ? "正在打开目录，完成后才能发送首条消息"
          : firstAssistantBlockedReason ?? projectWriteBlockedReason ?? "发送消息"}
        form={firstComposerFormId}
        disabled={first.draft.trim() === "" && stagedFirst.items.length === 0 || firstBusy || creating ||
          firstAttaching || firstSkillScopeMissing || creationPending ||
          projectWriteBlockedReason !== null || firstAssistantBlockedReason !== null}>
        <ArrowUp aria-hidden="true" /></button></div>
    </div>
    {/* 卡外说明区（2026-10-16 用户指令「这些都导致输入框变化了」）：档位说明、禁用原因、
        发送状态与目录阻塞一律在输入卡之外，卡片本体在空闲/在途/回执/各档下形状一致。 */}
    <ConversationModeHints mode={wantedMode} lockedReason={modeLockedReason} />
    {firstAssistantBlockedReason !== null && <p className="disabled-reason"
      data-testid="assist-first-blocked">{firstAssistantBlockedReason}</p>}
    {/* 目录在途不再在卡外另起一行禁用原因：细条已经在同一屏写「正在打开目录…」，
        发送键 title 也说明要等完成；多这一行会在 200ms 后把输入卡顶高 41px。
        超过 4 秒的取消出口由协作页以浮层给出，不参与流式布局（DEV-0104）。 */}
    {/* 这条状态只给辅助技术：可见反馈由主色发送键、在途光点与首条回执行承担。
        它曾以 helper-text 占一行流式高度，出现/消失时把输入卡抬高又放下 33px
        （DEV-0110 四相位实测），正是用户说的「发送时界面会闪一下」。 */}
    {creating && pendingFirst === null && <p className="visually-hidden" role="status"
      data-testid="assist-first-sending-status">正在发送首条消息…</p>}
    {projectWriteBlockedReasonShown !== null && <p className="disabled-reason">{projectWriteBlockedReasonShown}</p>}
  </section>;
  /**
   * 只有「命令结果待核对」才拦住切换。未发送草稿已按会话留在本机（composerDrafts），
   * 换工作区不再需要用户先确认丢弃（2026-10-19 用户指令：直接切，消息留着）。
   */
  const sessionChangeBlocked = sessionNavigation.pending !== null || pendingCreate !== null;
  function selectSession(next: string | null) {
    if (next === sessionId || sessionChangeBlocked) return;
    const proceed = () => { setSessionId(next); setSelectedRefs([]); onSessionSelected?.(next); };
    if (standalone && onRequestSessionChange) onRequestSessionChange(proceed);
    else proceed();
  }
  function newSession() {
    if (!deferSessionCreation) { void createSession(); return; }
    setSessionId(null); setSelectedRefs([]); setFirstSkillKey("");
    // 新对话只空白草稿与在途状态；模型选择是本设备偏好，重置时按上次选择重新种子化
    // （2026-10-20 用户指令「记住上一次选择的模型」），否则同页第二条新对话又显示「模型」。
    firstOwner.write({ ...emptyFirstProcess,
      model: client === null ? undefined : readLastModel(client.workspaceId) ?? undefined });
    onSessionSelected?.(null);
  }
  // 协作页（standalone）的会话行引用全局横向 field 与紧凑按钮变体；skill 子页保持
  // 纵向布局与常规按钮密度，紧凑密度不再由 CollaborationView.css 页面压回。
  const newSessionLabel = creating ? "正在创建" : "新建会话";
  /** 一条讨论在列表里的完整说法：同名时用更新时刻分开，非活动的一律标「已结束」。
     下拉与顶栏浮层共用这一份措辞，两处不会出现「看到的和选到的不是同一句话」。 */
  const sessionOptionLabel = (item: RelayAssistSession): string =>
    `${item.title}${sessions.some((other) => other.id !== item.id && other.title === item.title)
      ? ` · 更新 ${formatReadableDateTime(item.updatedAt, timeZone)}${item.id === sessionId ? " · 当前" : ""}` : ""}${
      item.status !== "ACTIVE" ? " · 已结束" : ""}`;
  /* 会话选择与「新建会话」拆成两个节点：非工具栏的会话带（?skill=assist 等子页）按原样并排，
     顶栏不再放切换控件。select 与按钮各只有一份定义，由容器决定摆不摆。 */
  const sessionSelectNode = <select data-testid="assist-session-select" aria-label="当前会话" title={session?.title ?? "选择会话"} disabled={creating || sessionChangeBlocked} value={sessionId ?? ""} onChange={(event) => selectSession(event.target.value || null)}><option value="">选择会话</option>{sessions.map((item) => <option key={item.id} value={item.id}>{sessionOptionLabel(item)}</option>)}</select>;
  const newSessionButton = <button className={standalone && !session ? "primary-button primary-button--compact" : `secondary-button${standalone ? " secondary-button--compact" : ""}`} type="button" data-testid="assist-new-session" aria-label={newSessionLabel} title={newSessionLabel} disabled={creating || pendingCreate !== null || projectWriteBlockedReason !== null || sessionChangeBlocked} onClick={() => standalone && onRequestNewSession ? onRequestNewSession(newSession) : newSession()}>{standalone && <Plus size={14} aria-hidden="true" />}<span className="agent-assist-new-session-label">{newSessionLabel}</span></button>;
  const sessionControls = <div className={`form-actions${standalone ? " agent-assist-session-controls" : ""}`}><label className={standalone ? "field field--row" : "field"}><span className={standalone ? "visually-hidden" : "field-label"}>当前会话</span>{sessionSelectNode}</label>{newSessionButton}</div>;
  /**
   * 顶栏右翼的「切换讨论」（2026-10-17）。左翼按用户指令只留会话名，不再有下拉框。
   * 但一个作用域里确实能有多条讨论（目录细条「新对话」按同一目录另开、或历史遗留），而
   * 近期工作栏只列 `taskId` 为空的会话、且新写出来的那条要等下一次读取才成行。没有这一颗键，
   * 刚用细条另开的会话就回不到同作用域的另一条讨论。
   * 因此浮层只在「本作用域读出 ≥2 条讨论」时出现：单条讨论的顶栏仍是纯净一行，
   * 不多一套切换控件。走的是与旧下拉同一个 `selectSession`，未发送草稿的离开保护语义不改。
   */
  const sessionSwitcherNode = conversationToolbar && !firstComposer && session !== null && sessions.length > 1
    ? <div className="collab-session-switcher" ref={sessionSwitcherRef} onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault(); event.stopPropagation();
        setSessionSwitcherOpen(false); sessionSwitcherTriggerRef.current?.focus();
      }}>
        <button type="button" className="secondary-button secondary-button--compact collab-toolbar-icon-button collab-session-switcher-trigger"
          ref={sessionSwitcherTriggerRef} data-testid="collab-session-switcher" aria-label="切换讨论" title="切换讨论"
          aria-haspopup="true" aria-expanded={sessionSwitcherOpen} aria-controls="collab-session-switcher-panel"
          disabled={sessionChangeBlocked}
          onClick={() => setSessionSwitcherOpen((open) => !open)}>
          <MessageSquareText size={18} aria-hidden="true" />
        </button>
        {sessionSwitcherOpen && <div className="collab-session-switcher-panel" id="collab-session-switcher-panel"
          data-testid="collab-session-switcher-panel"
          role="menu" aria-label="当前作用域的讨论"
          onKeyDown={(event) => handleRosterKeyDown(event, ".collab-session-switcher-option")}>
          {sessions.map((item) => <button key={item.id} type="button" role="menuitem"
            className="collab-session-switcher-option" data-testid={`collab-session-option-${item.id}`}
            title={item.title} aria-current={item.id === sessionId ? "true" : undefined}
            disabled={item.id === sessionId || sessionChangeBlocked}
            onClick={() => { setSessionSwitcherOpen(false); selectSession(item.id); }}>{sessionOptionLabel(item)}</button>)}
        </div>}
      </div>
    : null;
  // 工作空间级讨论没有项目，资料选择器无从谈起：没有项目就没有可选的项目资料。
  const sourcePicker = session?.status === "ACTIVE" && target !== null
    ? <AssistSourcePicker key={`${connection.epoch}:${session.id}:${target.projectId ?? "none"}`} projectId={target.projectId} selectedRefs={selectedRefs} onChange={setSelectedRefs} /> : null;
  // 有会话时收成一行摘要，给消息区让出高度；无会话仍按设计系统 5.1 展开说明与新建入口。
  /* 协作页只保留一条会话控制带：不再叠「会话：标题」details +「当前会话」下拉双层壳。 */
  const sessionSwitcher = sessionControls;
  /**
   * 会话视图顶栏（2026-10-16 改左右两翼；2026-10-17 收成单行）。
   * 左侧＝会话身份（会话名纯文字，完整标题留在 title）＋同一行的真实作用域（关联目标文字 / 会话目录文件夹图标）；
   * 右侧＝动作区：「切换讨论」（本作用域有多条时）＋「工作详情」开关。
   * 只读取本视图已持有的真实事实（target、session），绝不臆造项目名或运行状态。
   * 新对话（firstComposer）没有会话，左侧只剩作用域两行——空白起步刻意不继承旧讨论。
   * 2026-10-17 用户指令：左侧只显示会话名，不再放下拉框。跨作用域挑讨论走近期工作栏
   * （行内 `recent-work-<会话 id>`，与路由切换同一套离开保护）；当前作用域里读出多条讨论时，
   * 右翼才出现一颗「切换讨论」（见 sessionSwitcherNode），单条讨论的顶栏不多一套切换控件。
   * 2026-10-18 用户指令：右翼不再放「新建会话」，任何作用域都不放。另开会话留在左栏
   * 「新对话」与目录细条里的「新对话」（带目录归属）两条路径，顶栏只负责身份与开关。
   */
  const relatedGoals = session?.context?.projectGoals;
  const entryGoalId = new URLSearchParams(location.search).get("goal");
  const entryGoal = relatedGoals?.find((goal) => goal.goalId === entryGoalId);
  const goalDescription = relatedGoals === undefined ? session ? "目标关联待核对" : "尚未关联目标"
    : entryGoal ? entryGoal.title : relatedGoals.length > 0 ? relatedGoals.map((goal) => goal.title).join("、") : "尚未关联目标";
  /*
   * 顶栏这一项必须与输入卡上方那条细条读同一件事（2026-10-21，R3-02）。此前它只读会话，
   * 而首条对话合法地还没有会话（`deferSessionCreation`），于是同一目录出现两种结论：细条
   * 已经写出目录名与「已归入项目」，顶栏仍说「尚未绑定目录」。
   * 这里分清两个事实，不合并、也不提前建会话：
   * - 会话已存在 → 读服务端持久化的绑定（原样）。
   * - 还没有会话 → 读**本次新对话已选择的目录**（`executionScope`，与细条同源），并说明
   *   发送后才绑定；目录没打开成功时跟着读「未就绪」，不复述细条的告警也不否定它。
   */
  const pendingDirectoryForToolbar = session === null ? pendingDirectory : null;
  const directoryDescription = session !== null
    ? session.context === undefined ? "目录待核对"
      : session.context.workingDirectory === null ? "未绑定目录"
        : session.context.workingDirectory.canonicalRoot ?? "目录暂不可读取"
    : pendingDirectoryForToolbar === null ? "尚未绑定目录"
      : pendingDirectoryForToolbar.status === "READY"
        ? `${pendingDirectoryForToolbar.canonicalRoot}（已选，发送后绑定）`
        : pendingDirectoryForToolbar.status === "NOT_READY" ? "目录未就绪" : "目录待确认";
  /* 绑定状态要说得出，不能只留在悬停里：顶栏光显一个目录名会被读成「已经绑好了」，
     与细条那句「发送后绑定」就又是两种结论。没会话时这一枚标记就是那句区别本身。 */
  const directoryBindingMarker = pendingDirectoryForToolbar === null ? null
    : pendingDirectoryForToolbar.status === "READY" ? "发送后绑定"
      : pendingDirectoryForToolbar.status === "NOT_READY" ? "未就绪" : "待确认";
  /* 可见面写目录名，完整路径留在 title 与可访问名称：2026-10-17 把这一项收成纯图标之后，
     用户 2026-10-18 指认「看不出当前会话在哪个目录」——图标只说得出「这是个目录」，
     说不出是哪一个。名字与输入卡上方细条同一档省略规则，占位说法照旧显示不隐藏。 */
  const directoryName = session?.context?.workingDirectory?.canonicalRoot
    ?.replace(/[\\/]+$/u, "").split(/[\\/]/u).at(-1) ?? pendingDirectoryForToolbar?.displayName ?? null;
  /* 占位状态不是取值：待核对／尚未关联／未绑定这些是「还没有事实」的说法，
     顶栏按 muted 档呈现，避免与目录名这类真实取值同重（视觉归设计系统 §9.13）。 */
  const goalIsPlaceholder = relatedGoals === undefined || (entryGoal === undefined && relatedGoals.length === 0);
  const directoryIsPlaceholder = session !== null
    ? session.context === undefined || session.context.workingDirectory === null
      || session.context.workingDirectory.canonicalRoot === null
    : pendingDirectoryForToolbar === null || pendingDirectoryForToolbar.status !== "READY";
  /**
   * 2026-10-20 用户指令「只显示目录名」：来源不再以文案标注。目录名本身就是用户要核对的事实，
   * 「（来自设置）」这类后缀在默认目录会自动登记之后也不再准确——来源仍保留在
   * `data-source` 上供核对，不进可见文案与可访问名称。绝对路径在悬停/聚焦时浮出。
   */
  const directoryAccessibleName = `${session !== null ? "会话目录" : "本次选择的目录"}：${directoryDescription}`;
  directoryPathRef.current = directoryIsPlaceholder ? null : directoryDescription;
  const scopeValueClass = (placeholder: boolean): string => placeholder
    ? "collab-toolbar-scope-value collab-toolbar-scope-value--placeholder" : "collab-toolbar-scope-value";
  const conversationToolbarNode = conversationToolbar
    ? <section className="collab-conversation-toolbar" data-testid="collab-conversation-toolbar">
        <div className="collab-toolbar-info">
          {session === null ? null : <p className="collab-toolbar-session" data-testid="collab-session-title" title={session.title}>{session.title}</p>}
          <div className="collab-toolbar-crumb collab-toolbar-crumb--scope" data-testid="collab-conversation-scope"
            title={`目标（项目关联）：${goalDescription}；会话目录：${directoryDescription}`}>
            <span data-testid="collab-current-goal" title={goalDescription}><span className="collab-toolbar-scope-label">关联目标：</span><span className={scopeValueClass(goalIsPlaceholder)}>{goalDescription}</span></span>
            <span className={`collab-toolbar-directory${directoryIsPlaceholder ? " collab-toolbar-directory--placeholder" : ""}`}
              data-testid="collab-current-directory" role="img"
              data-source={session?.context?.workingDirectory?.source ?? "UNKNOWN"}
              {...directoryTooltipHandlers}
              aria-label={directoryAccessibleName}>
              <Folder aria-hidden="true" />
              <span className="collab-toolbar-directory-name" aria-hidden="true">{directoryName ?? directoryDescription}</span>
              {directoryBindingMarker !== null && <span className="collab-toolbar-directory-state"
                aria-hidden="true">{directoryBindingMarker}</span>}
            </span>
            {directoryTooltipNode}
          </div>
        </div>
        <div className="collab-toolbar-right">
          {sessionSwitcherNode}
          {toolbarRight}
        </div>
      </section>
    : null;
  return <section className={embedded ? "embedded-assist" : standalone ? "skill-page agent-assist" : "skill-page page-primary"} data-testid="assist-target"><div className={standalone ? "agent-assist-heading" : undefined}>{!embedded && !standalone && target !== null && <PageHeader testId="assist-page-head" title={target.title}
      meta={`${kind === "PROJECT" ? "项目 Assist" : "任务 Assist"} · ${id}`}
      lede={<>当前工作对象修订 v{target.revision}{target.executor && <> · 当前执行者 {target.executor}</>}</>}
      actions={<Link className="text-link" to={kind === "PROJECT" ? `/projects/${id}` : `/tasks/${id}`}>返回{kind === "PROJECT" ? "项目" : "任务"}</Link>}>
      {/* 2026-10-24 用户指令：全局信任宣告（「Assist 建议不会自动修改业务事实」）不再常驻上屏。 */}
      <p className="helper-text">消息固定写入当前会话；切换工作对象后重新读取。</p>
    </PageHeader>}{!embedded && standalone && <Link className="text-link" to={kind === "PROJECT" ? `/projects/${id}` : `/tasks/${id}`}>返回{kind === "PROJECT" ? "项目" : "任务"}</Link>}</div>{loading && target !== null && !provisionalTarget && <p className="loading-text" role="status">正在刷新工作对象与会话…</p>}{error && <p className="action-error" role="alert">{error}</p>}
    {projectWriteBlockedReasonShown !== null && <p className="disabled-reason" data-testid="assist-archive-reason">{projectWriteBlockedReasonShown}</p>}
    {conversationToolbarNode}
    {!externalReadBlockedReason && !(embedded && session) && !firstComposer && !preferredSessionLookup && !conversationToolbar && <section className={standalone ? `agent-assist-session-bar${!session ? " agent-assist-session-bar--empty" : ""}` : "surface-panel"}>{!standalone && <h2>会话</h2>}{standalone && !session && <div className="agent-session-welcome"><MessageSquareText aria-hidden="true" /><h2>开始讨论</h2></div>}{!session && preferredSessionId === null && <p className="helper-text" data-testid="assist-new-session-prompt">工作对象已选。可以新建会话，或在“当前会话”中返回已有讨论。</p>}{!sessions.length && preferredSessionId !== null && <p className="helper-text">当前工作对象还没有会话，先新建会话再发送消息。</p>}{sessionSwitcher}</section>}
    {firstComposer && firstMessage}
    {/* 首条消息的提示渲染在首条输入区之外：建会话成功后协作页会切到该 Task，
        明确失败与未决命令都必须继续留在对话区可发现、可核对。
        2026-10-24 用户指令：提示按类型走通道——明确失败是停留到关闭的 Notice；
        未决命令在正文只留一行状态，完整原因、原 command_id 与两个恢复出口进弹窗。 */}
    {firstNotice !== null && <Notice testId="assist-first-error">{firstNotice}</Notice>}
    {pendingFirst !== null && (firstPendingUnresolved
      ? <UnresolvedCommandStrip testId="assist-first-pending" busy={creating}
          label="会话已创建，首条消息结果待核对。"
          onOpen={() => setFirstPendingDialogOpen(true)} />
      : <p className="helper-text" role="status" data-testid="assist-first-pending" data-state="sending">
          正在发送首条消息…
          <button type="button" className="text-link" data-testid="assist-first-receipt" disabled={creating}
            onClick={() => void checkFirstReceipt()}>{creating ? "正在查询" : "查询回执"}</button></p>)}
    <UnresolvedCommandDialog open={firstPendingOpen} testId="assist-first"
      title="首条消息结果待核对"
      summary="会话已创建，但还没有拿到这条消息的送达回执。先查询回执；查不到时按原命令重试。"
      commandId={pendingFirst?.commandId ?? ""}
      detail="两个出口都按原 command_id 与原载荷走，绝不重建会话或换新命令 ID；核对前这条消息不算已送达。"
      reason={firstPendingError ?? pendingFirst?.reason ?? null}
      busy={creating} checkLabel="查询首条回执" retryLabel="按原命令重试"
      onCheck={() => void checkFirstReceipt()}
      onRetry={() => { if (pendingFirst !== null) void sendFirstMessage(pendingFirst, true); }}
      onClose={() => setFirstPendingDialogOpen(false)} />
    {createError !== null && pendingCreate === null && <Notice testId="assist-create-error">{createError}</Notice>}
    {pendingCreate !== null && !creating && <UnresolvedCommandStrip testId="assist-first-create-pending"
      busy={creating} label="会话创建结果待核对。" onOpen={() => setCreatePendingDialogOpen(true)} />}
    <UnresolvedCommandDialog open={pendingCreate !== null && createPendingDialogOpen}
      testId="assist-first-create"
      title="会话创建结果待核对"
      summary="会话可能已经创建，但还没有拿到创建回执。先查询创建回执；查不到时按原命令重试。"
      commandId={pendingCreate?.commandId ?? ""}
      detail="按原命令重试不会创建第二个会话，也不会改用后来修改的输入。"
      reason={createError}
      busy={creating} checkLabel="查询创建回执" retryLabel="以原命令重试"
      onCheck={() => void checkCreateReceipt()}
      onRetry={() => { if (pendingCreate !== null) void createSession(pendingCreate); }}
      onClose={() => setCreatePendingDialogOpen(false)} />
    {externalReadBlockedReason && selectedRefs.length > 0 && <button className="secondary-button" type="button" disabled={sessionNavigation.pending !== null} onClick={() => setSelectedRefs([])}>清空本次资料选择</button>}
    {session && <>{!externalReadBlockedReason && !standalone && !embedded && sourcePicker}
      <AssistSessionPanel key={`${connection.epoch}:${session.id}`} client={client} session={session} target={target} sources={selectedRefs}
        standalone={standalone} embedded={embedded} onNavigationStateChange={reportSessionNavigation}
        sourcePicker={sourcePicker}
        firstMessageInflight={firstBusy || creating || pendingFirst !== null}
        preferredSkillId={preferredSkillId}
        initialExecution={first.execution?.sessionId === session.id ? first.execution : null}
        initialMaintenance={first.maintenance?.sessionId === session.id ? first.maintenance : null}
        confirmedFirstMessageCommandId={first.interpretedSessionId === session.id ? first.interpreted : null}
        proposalActionHost={proposalActionHost}
        externalReadBlockedReason={externalReadBlockedReason}
        writeBlockedReason={projectWriteBlockedReason}
        onExecutionPrepared={onExecutionPrepared}
        refreshTarget={async () => { await loadTarget(session.id); onTargetChanged?.(); }}
        onChatSessionCreated={(created) => {
          setSessions((current) => [created, ...current.filter((item) => item.id !== created.id)]);
          applyActiveSession(created.id);
          onSessionCreated?.(created.id, created);
        }}
        clearSentSources={(sent) => setSelectedRefs((current) => JSON.stringify(current) === JSON.stringify(sent) ? [] : current)}
        modeSwitch={modeSwitch}
        modeHints={<ConversationModeHints mode={wantedMode} lockedReason={modeLockedReason} />}
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
        onToggleSourceRef={toggleSourceRef}
        onInflightChange={setSessionInflight} />
      {!externalReadBlockedReason && embedded && <details className="embedded-assist-sources"><summary>会话与本次资料 · {session.title}</summary>{sessionControls}{sourcePicker}</details>}</>}
  </section>;
}

/**
 * 输入器左侧的「+」上下文入口（效果图 V4.2 的 attach 按钮）。
 *
 * 一级回答「用户想做什么」，二级回答「具体选什么」：四项已存在的入口不再平铺成一张面板，
 * 而是各自带一个向右展开的二级面板。所有内容都接入**已有**能力，不新造业务：
 * 资料检索走既有资料选择器与真实对话来源，目录走协作页持有的目录条与真实近期目录，
 * 命令清单复用 `getChatCommands` 与输入框内联菜单同一份登记。
 *
 * 一级与二级共用同一套 `AttachRow`，四项能力不各写一份菜单；禁用项如实禁用，原因只放在
 * 悬停 `title` 里，绝不给出点了没反应或会臆造状态的入口。
 *
 * 交互：**指针悬停一级行即展开二级**（2026-10-17 用户指令：参考菜单是 hover 展开），
 * 点击一级行仍是显式开关——hover 打开后再点同一行不会把它关掉，而是把它固定住，之后
 * 指针移开也不收；二级本身在指针进入时取消收起、离开后延时收起，延时足够指针跨过
 * 一级与二级之间那条 `space.2` 缝隙，因此不需要在缝隙上铺一块透明桥接。
 * 二级执行后收起两级并保留草稿；点击弹层外部关闭；Esc 先收二级再收一级；
 * ↑↓ 在当前层内移动，→ 展开二级并聚焦其首行，← 收二级回到原一级行，Enter 激活。
 * 二级在右侧放不下时翻到左侧、下方放不下时按底部对齐，都不放不下时面板内滚动。
 */
type AttachSection = "files" | "artifacts" | "sources" | "skill" | "command" | "connectors";

/**
 * 输入卡上方的状态行（2026-10-17 用户指定的布局；2026-10-18 合并后只服务嵌入态）：
 * 左侧「工作目录：xx」，右侧「写入权限：xx」。状态是摘要——目录与写档位的**操作**仍在
 * 底栏（[权限] 芯片）与协作页目录细条，这里不复制第二套操作，只把事实摆在眼前。
 * 协作页（standalone）有目录细条（`composerHeader`），目录显示与「更换目录」入口由它
 * 一处承担（2026-10-18 用户指令两行合并），本行在那里不再渲染；嵌入态没有细条，
 * 也没有目录操作入口，只留这段只读摘要。
 */
function ComposerStatusBar({ directory, writeTier, showWrite }: {
  /** 首条传完整 RelayWorkingDirectory，会话传上下文投影：这里只读 displayName（回退路径尾段）。 */
  directory: { readonly displayName?: string; readonly canonicalRoot?: string | null } | null;
  /** 写档位：来自底栏 [权限] 芯片的同源上报；null 表示该档不显示写权限（助手档）。 */
  writeTier: Tier | null;
  showWrite: boolean;
}) {
  const directoryName = directory === null ? null
    : directory.displayName ?? directory.canonicalRoot?.replace(/[\\/]+$/u, "").split(/[\\/]/u).at(-1) ?? null;
  return <div className="composer-status-bar" data-testid="composer-status">
    <span className="composer-status-item">工作目录：{directoryName ?? "未选择"}</span>
    {showWrite && <span className="composer-status-item" data-testid="composer-write-status">
      写入权限：{writeTierSummary(writeTier)}
    </span>}
  </div>;
}

/** 摘要行只负责「已就绪」这一层措辞，档位名一律取芯片同一份 tierLabels，不维护第二套枚举。 */
function writeTierSummary(tier: Tier | null): string {
  if (tier === null || tier === "unknown") return "待核对";
  if (tier === "blocked") return "未就绪";
  if (tier === "unbound") return "未就绪（未绑定目录）";
  if (tier === "full" || tier === "auto" || tier === "ask") return `已就绪（${tierLabels[tier]}）`;
  return tierLabels[tier];
}

const attachSectionLabels: Record<AttachSection, string> = {
  files: "文件", artifacts: "我的产物",
  sources: "选择文件与资料", skill: "选择 Skill 生成",
  command: "输入命令", connectors: "连接器与插件"
};

/**
 * 连接器的作用域事实：连接与权限都按项目登记，没有项目归属时没有任何清单可读。
 *
 * 只有这一份措辞，取两种长度——二级面板首句只说「缺口本身」，去向就在下一行
 * 「管理连接与权限」；一级行 title 用完整一句（2026-10-19 用户指认「为什么这里需要
 * 项目中授权……这些都是过度设计」）。
 */
const connectorScope = "连接器随项目配置";
const connectorScopeNote = `${connectorScope}；进入项目后可查看授权状态`;

/**
 * 尚未接入的能力如实禁用即可：行内 `hint` 写「暂未接入」，原因与替代路径放 `title`。
 * 2026-10-19 用户指认「每个菜单下面都有文字……这个文字很影响体验」，菜单不再渲染整段脚注
 * （上游同类菜单也没有）：解释只在悬停时出现，不占面板高度、不与选项名争权重。
 */

/** 每次消息可选资料版本的上限：与 `AssistSourcePicker` 同一条既有约束，不另立第二套。 */
const attachSourceLimit = 10;

/** 二级资料面板里直接平铺的项目资料条数上限；超出部分指向检索，避免一次渲染上百行。 */
const attachProjectSourceLimit = 20;

/** 「文件」二级的渐进展示批大小：一层最多 200 条（HTTP §10.112），首批 30 行，
 * 滚到面板近底自动追加下一批；尾部「显示更多」行兜底键盘与超高视口（无内部滚动）的路径。 */
const attachFilesPageSize = 30;

/** 「文件」二级的失败码 → 人话（HTTP §10.112 的码表）；未知码原样回显，不猜语义。 */
const fileListingFailureLabels: Record<string, string> = {
  GATEWAY_TARGET_DENIED: "目标不可读取（路径不存在、不是目录或受保护）",
  GATEWAY_CONNECTION_DENIED: "文件浏览连接不可用（缺 FILE_QUERY 能力或已停用）",
  GATEWAY_PERMISSION_DENIED: "当前项目没有授予目录浏览权限",
  RESOURCE_OCCUPIED: "目录正被在途写入占用，请稍后重试",
  GATEWAY_ORIGIN_DENIED: "该动作不在人工只读入口词表"
};

type AttachRowSpec = {
  readonly testId: string;
  readonly level: 1 | 2;
  readonly label: string;
  readonly icon?: ReactNode;
  /** 右侧轻量状态：计数用文本，布尔态用 `selected` 的对勾。 */
  readonly hint?: string;
  readonly title?: string;
  readonly disabled?: boolean;
  readonly selected?: boolean;
  /** 一级条目的二级面板身份；只有能展开的行才有。 */
  readonly section?: AttachSection;
  readonly expanded?: boolean;
  readonly onSelect: () => void;
  /** 指针进入：一级行据此展开二级（hover 语义），二级行不传。 */
  readonly onHover?: () => void;
};

/**
 * 一行菜单项：一级与二级共用同一实现。图标、提示、选中标记、chevron 全由数据驱动，
 * 因此「选择文件与资料」等四项不各写一份菜单。
 */
function AttachRow({ testId, level, label, icon, hint, title, disabled, selected,
  section, expanded, onSelect, onHover }: AttachRowSpec) {
  /* 禁用的行不提供展开：显示 chevron / aria-expanded 等于承诺一个点不开的二级面板。 */
  const disclosure = section !== undefined && disabled !== true ? section : undefined;
  return <button type="button" className="agent-chat-attach-item" data-testid={testId}
    data-level={level} data-active={disclosure !== undefined && expanded === true ? "true" : "false"}
    disabled={disabled} data-section={disclosure}
    aria-expanded={disclosure === undefined ? undefined : expanded === true}
    title={title} onPointerEnter={onHover} onClick={onSelect}>
    <span className="agent-chat-attach-item-icon" aria-hidden="true">{icon ?? null}</span>
    <span className="agent-chat-attach-item-label">{label}</span>
    {/* 尾组：状态位与 chevron 由它整组右对齐（`margin-left: auto`），短行多出来的空间因此落在
        文字与尾组之间，行与面板的两条内边距才对称（设计系统 §9.14）。 */}
    {(hint !== undefined || selected === true || disclosure !== undefined) &&
      <span className="agent-chat-attach-item-tail">
        {hint !== undefined && <span className="agent-chat-attach-item-hint">{hint}</span>}
        {selected === true && <Check className="agent-chat-attach-item-check" aria-hidden="true" />}
        {disclosure !== undefined && <ChevronRight className="agent-chat-attach-item-chevron" aria-hidden="true" />}
      </span>}
  </button>;
}

/**
 * 用户消息正文的展示层增强（2026-10-25）：已知插件 mention 显示成「小图标 + 短名」，
 * **不带 `@`**（2026-10-25 用户指认「这里不应该显示 @」；与输入器芯片同一种读法）。
 * 纯文本协议不变——消息仍按原文保存（含 `@`），复制、撤回、历史读取都拿
 * message.content；这里只把「哪一段是 mention」画出来。识别规则见 lib/pluginMentions：
 * 邮箱、路径、未知 mention 与更长词的一部分都不算。
 *
 * 导出给契约测试直接挂载（同 ComposerAttach）：消息展示层的分词与原文保全
 * 不依赖整条 /agent 路由。
 */
export function UserMessageContent({ content }: { content: string }) {
  const mentions = findPluginMentions(content);
  if (mentions.length === 0) return <>{content}</>;
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const mention of mentions) {
    if (mention.start > cursor) nodes.push(content.slice(cursor, mention.start));
    nodes.push(<span key={`${mention.key}-${mention.start}`} className="assist-plugin-mention"
      data-plugin-mention={mention.key}>
      <PluginIcon plugin={mention.key} className="assist-plugin-mention-icon" />
      <span className="assist-plugin-mention-label">{mention.label}</span>
    </span>);
    cursor = mention.end;
  }
  if (cursor < content.length) nodes.push(content.slice(cursor));
  return <>{nodes}</>;
}

/** 导出给契约测试直接挂载：菜单框架（两级开合、键盘、翻转）不依赖整条 /agent 路由。 */

export function ComposerAttach({
  onCommand, onSources, onSkill, onPickCommand, onPickPlugin, onUploadAttachments,
  uploadDisabled = false, workspace = null, artifactTaskId = null, onInsertMention,
  client = null, mode = "AGENT", hasSession = false,
  selectedRefs = [], conversationRefs = [], recentRefs = [], onToggleSourceRef,
  skillSelected = false, notes,
  projectId = null, skills, selectedSkillKey = null, onPickSkill, skillContext = null
}: {
  onCommand: () => void;
  onSources?: () => void; onSkill?: () => void;
  /** 把某个登记命令填进草稿（只编辑草稿，不发送）。 */
  onPickCommand?: (name: string) => void;
  /** 把插件 mention（`@标签 `）插进草稿（DEV-0099）：只编辑草稿，不发送、不授予任何能力。 */
  onPickPlugin?: (label: string) => void;
  /** 上传附件：把本机图片交给既有的暂存链路；这里不上传、不发送。 */
  onUploadAttachments?: (files: readonly File[]) => void;
  /** 输入器当前不接受新附件（在途/发送中）：上传行如实禁用。 */
  uploadDisabled?: boolean;
  /** 当前工作目录：「文件」二级按它读取受管目录的一层条目。 */
  workspace?: { readonly projectId: string; readonly resourceId: string; readonly displayName: string } | null;
  /** 当前任务：「我的产物」二级按它读取任务已保存的产物版本。 */
  artifactTaskId?: string | null;
  /** 把文件路径 / 产物版本作为 mention 插进草稿：只编辑草稿，不发送、不授予任何能力。 */
  onInsertMention?: (label: string) => void;
  client?: RelayApiClient | null;
  /** 命令清单按档过滤 METHOD 项：与输入框内联菜单同一条规则。 */
  mode?: RelayConversationMode;
  hasSession?: boolean;
  selectedRefs?: readonly RelayAssistSourceRef[];
  /** 当前会话里真实出现过的资料引用（来自消息来源，不是推断）。 */
  conversationRefs?: readonly RelayAssistSourceRef[];
  /** 本机最近引用过的资料版本（本地偏好，见 recentSourceRefs）。 */
  recentRefs?: readonly RelayAssistSourceRef[];
  onToggleSourceRef?: (ref: RelayAssistSourceRef) => void;
  skillSelected?: boolean;
  /** 禁用行的原因（只做悬停 `title`，不渲染成脚注；见上「菜单不再渲染整段脚注」）。 */
  notes?: { text: string; keys: string[] }[];
  /** 当前项目：二级「项目资料」按它读取可引用资料；缺省时不发请求也不显示该节。 */
  projectId?: string | null;
  /** 发送选项里同一份 Skill 清单（全量；是否可用由 `skillContext` 判定）。 */
  skills?: readonly RelaySkillDefinition[];
  /** 发送选项里当前选中的 Skill 键（`id@version`），用于二级里的对勾。 */
  selectedSkillKey?: string | null;
  /** 在二级里直接选中某个 Skill：与发送选项的 select 走同一处状态，不新造第二套选择。 */
  onPickSkill?: (key: string) => void;
  /**
   * 这条消息当前能证明的上下文（工作台 §32.11）。缺省表示「这一层不判定上下文」：
   * 助手档、无工作对象的老调用保持原样，不做任何基于 target 的禁用。
   * `resolveInPlace` 为真表示选中缺上下文的 Skill 之后可以在输入器里补齐（有工作对象芯片），
   * 因此此时**不禁用**这些行，只标注 `需任务 / 需项目`。
   */
  skillContext?: { readonly projectId: string | null; readonly taskId: string | null;
    readonly resolveInPlace: boolean } | null;
}) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const subRef = useRef<HTMLDivElement>(null);
  const [sub, setSub] = useState<AttachSection | null>(null);
  const [flip, setFlip] = useState(false);
  /** 二级面板相对一级菜单的纵向位置：贴住当前那一行，越界时向上收。 */
  const [subTop, setSubTop] = useState<number | null>(null);
  /** 视口真的放不下时的高度上限（px）：面板内部滚动，不把底边推出屏幕。 */
  const [subMaxHeight, setSubMaxHeight] = useState<number | null>(null);
  /** 命令清单只在二级命令面板打开时读取一次；与输入框内联菜单共用同一份登记响应。 */
  const [catalog, setCatalog] = useState<{ client: RelayApiClient;
    items: readonly RelayChatCommand[] | null; error: string | null } | null>(null);
  /** 项目资料只在二级资料面板打开时读取一次，读取成功才缓存（失败下次打开重试）。 */
  const [library, setLibrary] = useState<{ client: RelayApiClient; projectId: string;
    items: readonly RelayKnowledge[] | null; error: string | null } | null>(null);
  const libraryLoaded = useRef<{ client: RelayApiClient; projectId: string } | null>(null);
  /** 连接器清单：打开二级连接器面板时按项目读取一次（连接的登记在服务端，前端不写死）。 */
  const [connectors, setConnectors] = useState<{ client: RelayApiClient; projectId: string;
    items: readonly RelayGatewayConnection[] | null; error: string | null } | null>(null);
  const connectorsLoaded = useRef<{ client: RelayApiClient; projectId: string } | null>(null);
  /** 本机图片选择器：「上传附件」直接动作，文件只交给既有暂存链路。 */
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  /** 工作目录的一层条目：每次打开/进目录都是新的读取命令（新 command_id），不缓存内容。 */
  const [fileView, setFileView] = useState<{ client: RelayApiClient; projectId: string;
    resourceId: string; path: string; entries: readonly RelayDirectoryEntry[] | null;
    loading: boolean; error: string | null; truncated: boolean; skipped: number } | null>(null);
  const fileRequest = useRef(0);
  /** 文件二级当前画到第几条：渐进展示的可见计数，随每次目录读取重置回首批。 */
  const [filesVisible, setFilesVisible] = useState(attachFilesPageSize);
  /** 当前任务的产物清单：打开二级时按需读取一次，失败如实说明。 */
  const [artifactView, setArtifactView] = useState<{ client: RelayApiClient; taskId: string;
    items: readonly RelayArtifact[] | null; error: string | null } | null>(null);
  /** hover 收起二级的延时器：指针跨过一级与二级之间的缝隙时会被二级的 pointerenter 取消。 */
  const hoverCloseTimer = useRef<number | null>(null);
  /** 二级是「hover 打开」的这一事实：只有它随指针移开自动收起，点击打开的固定下来不收。 */
  const hoverOpened = useRef<AttachSection | null>(null);

  const cancelHoverClose = () => {
    if (hoverCloseTimer.current === null) return;
    window.clearTimeout(hoverCloseTimer.current);
    hoverCloseTimer.current = null;
  };
  const scheduleHoverClose = () => {
    if (hoverOpened.current === null) return;
    cancelHoverClose();
    hoverCloseTimer.current = window.setTimeout(() => {
      hoverCloseTimer.current = null; hoverOpened.current = null; setSub(null);
    }, 220);
  };
  useEffect(() => cancelHoverClose, []);
  const hoverSub = (section: AttachSection) => () => {
    cancelHoverClose();
    if (sub === section) return;
    setSub(section); hoverOpened.current = section;
  };

  /**
   * 「管理连接与权限」的去向（2026-10-21，R3-01）：站内导航，并把当前范围一起带过去。
   * 已知项目时直达**这个项目**的连接与权限页；没有项目归属时仍到真实的项目
   * 选择页，不替用户猜一个项目。`from` 记下点击时所在的位置，连接页据此给出返回入口。
   * 这里只导航、只读状态：不创建连接、不写策略，授权仍要在连接页由用户显式提交。
   */
  const navigate = useNavigate();
  const attachLocation = useLocation();
  const openConnectionsManager = () => {
    const params = new URLSearchParams();
    params.set("from", `${attachLocation.pathname}${attachLocation.search}`);
    void navigate(`${projectId === null ? "/settings/connections"
      : `/projects/${projectId}/connections`}?${params.toString()}`);
  };

  const close = (returnFocus: boolean) => {
    const node = detailsRef.current;
    if (!node) return;
    cancelHoverClose(); hoverOpened.current = null;
    node.open = false;
    setSub(null);
    if (returnFocus) node.querySelector("summary")?.focus({ preventScroll: true });
  };
  /* Esc 只收起弹层并回到「+」，不触碰输入框草稿。必须 preventDefault + stopPropagation 并先于
     section 的 onPanelKeyDown 跑完，否则这次 Esc 会被 Esc Esc 停止序列记成第一下。组词期间的 Esc 归输入法。
     二级打开时第一次 Esc 只收二级，把焦点还给一级那一行。 */
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDetailsElement>) => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 ||
      event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const node = detailsRef.current;
    if (!node?.open) return;
    /** 键盘事件来自当前聚焦的行：层级与行序都按它算，不另猜一份焦点事实。 */
    const source = event.target instanceof HTMLElement ? event.target : null;
    const inSub = source !== null && source.closest("[data-submenu]") !== null;
    const rowsIn = (level: 1 | 2) => {
      const scope = level === 1 ? menuRef.current : subRef.current;
      return Array.from(scope?.querySelectorAll<HTMLButtonElement>(
        `button.agent-chat-attach-item[data-level="${level}"]:not(:disabled)`) ?? []);
    };
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (sub !== null && inSub) {
        const owner = sub;
        setSub(null);
        window.requestAnimationFrame(() => menuRef.current
          ?.querySelector<HTMLButtonElement>(`[data-testid="assist-attach-${owner}"]`)?.focus({ preventScroll: true }));
        return;
      }
      close(true);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const rows = rowsIn(inSub ? 2 : 1);
      if (rows.length === 0) return;
      event.preventDefault();
      const index = source === null ? -1 : rows.indexOf(source as HTMLButtonElement);
      const step = event.key === "ArrowDown" ? 1 : -1;
      const next = rows[index < 0 ? (step > 0 ? 0 : rows.length - 1) : (index + step + rows.length) % rows.length];
      next?.focus({ preventScroll: true });
      return;
    }
    if (event.key === "ArrowRight" && !inSub) {
      const owner = source?.closest<HTMLButtonElement>("button[data-section]");
      const section = owner?.dataset.section as AttachSection | undefined;
      if (owner === null || owner === undefined || section === undefined || owner.disabled) return;
      event.preventDefault();
      setSub(section);
      window.requestAnimationFrame(() => rowsIn(2)[0]?.focus({ preventScroll: true }));
      return;
    }
    if (event.key === "ArrowLeft" && inSub) {
      const owner = sub;
      event.preventDefault();
      setSub(null);
      window.requestAnimationFrame(() => {
        if (owner !== null) menuRef.current
          ?.querySelector<HTMLButtonElement>(`[data-testid="assist-attach-${owner}"]`)?.focus({ preventScroll: true });
      });
    }
  };
  // 原生 details 不会因为点击别处而收起，弹层得自己处理外部按下；同时把二级一并收掉。
  // 左键右键都算「点了别处」——此前这里只处理左键，收口后统一；其余语义（Esc、二级
  // 方向键、打开别的浮层时独占）见 lib/popoverMenu。
  useDetailsMenu(detailsRef, { onClosed: () => { hoverOpened.current = null; setSub(null); } });
  /* 二级方向在挂载后按实际空间定：右侧放不下翻到左侧；垂直方向默认**相对一级弹层居中**
     （2026-10-19 用户指令，取代此前的「贴住当前那一行」：贴行会让二级随 hover 的行上下跳，
     看起来像两个各自漂的浮层）。一级贴近视口底部、居中对不齐时，改为二级底边与一级底边对齐。
     面板尺寸变化（项目资料异步到达、滚动条出现）时用 ResizeObserver 重算，不靠猜。
     面板宽度由 CSS 固定，因此量的宽高不会随方向再变，不会来回抖。 */
  useLayoutEffect(() => {
    if (sub === null) { setFlip(false); setSubTop(null); setSubMaxHeight(null); return; }
    const menu = menuRef.current; const panel = subRef.current;
    if (!menu || !panel) return;
    const measure = () => {
      const rect = menu.getBoundingClientRect();
      const width = panel.offsetWidth; const height = panel.offsetHeight;
      const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
      const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
      const gap = 8;
      setFlip(rect.right + gap + width > viewportWidth && rect.left - gap - width >= 0);
      /* 纵向默认按一级弹层居中（2026-10-19 用户指令「二级要以一级的高度居中」）：
         贴行的做法让二级随 hover 的行上下跳，看起来像两个各自漂的浮层。
         二级比一级高时「居中」意味着上探出一级顶边（用户截图里就是这副样子），
         所以这里不设 0 下限，唯一的硬边是视口顶边——上探到屏幕外才夹回 0。
         一级贴近视口底部时居中会把二级顶出视口——这时改为二级底边与一级底边对齐
         （用户：「如果一级太下面就底部跟一级对齐」）；两者都放不下才交给高度上限滚动。 */
      const menuHeight = menu.offsetHeight;
      const centered = Math.round((menuHeight - height) / 2);
      const bottomAligned = menuHeight - height;
      /* 二级比一级高时「居中」意味着上探出一级顶边（用户截图里的样子），所以不设 0 下限；
         唯一的硬边是视口顶边：上探到屏幕外才夹回 `gap - 一级顶边`（可为负）。 */
      const minTop = gap - rect.top;
      const maxTop = viewportHeight - rect.top - height - gap;
      let top = Math.max(minTop, centered);
      if (top > maxTop) top = bottomAligned;
      if (top > maxTop) top = maxTop;
      setSubTop(top);
      /* 内容自然高度按「行区 scrollHeight + 内边距」算：行区自己滚动后，
         面板的 scrollHeight 只等于它当前的可见高度，拿它判断会让上限一设一清来回抖。 */
      const body = panel.querySelector<HTMLElement>(".agent-chat-attach-subbody");
      const style = window.getComputedStyle(panel);
      const padding = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
      const natural = (body?.scrollHeight ?? 0) + padding + 4;
      const available = viewportHeight - rect.top - top - gap;
      setSubMaxHeight(natural > available ? Math.max(140, available) : null);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(panel);
    return () => observer.disconnect();
  }, [sub]);
  useEffect(() => {
    if (sub !== "command" || !client || catalog?.client === client && catalog.items !== null) return;
    let live = true;
    setCatalog({ client, items: null, error: null });
    void client.getChatCommands().then((items) => {
      if (live) setCatalog({ client, items, error: null });
    }).catch(() => {
      if (live) setCatalog({ client, items: null, error: "命令清单读取失败，草稿与输入不受影响。" });
    });
    return () => { live = false; };
  }, [sub, client]);
  /* 项目资料：打开二级资料面板时读一次项目的启用知识，列表直接平铺出来（不再要求先检索）。
     与命令清单同一口径——按需读取、失败如实说、不预取。 */
  useEffect(() => {
    if (sub !== "sources" || client === null || !projectId) return;
    const cached = libraryLoaded.current;
    if (cached?.client === client && cached.projectId === projectId) return;
    let live = true;
    libraryLoaded.current = { client, projectId };
    setLibrary({ client, projectId, items: null, error: null });
    void client.getKnowledge(projectId).then((items) => {
      if (live) setLibrary({ client, projectId, items, error: null });
    }).catch(() => {
      if (live) {
        libraryLoaded.current = null;
        setLibrary({ client, projectId, items: null, error: "项目资料读取失败，可用下方检索与已有引用。" });
      }
    });
    return () => { live = false; };
  }, [sub, client, projectId]);
  /* 连接器：打开二级面板时读一次项目已登记的连接（GitHub / 浏览器 / 电脑等能力都在其中）。
     清单由服务端决定，前端只做能力键 → 中文名的映射；失败时如实说明，不影响其他面板。 */
  useEffect(() => {
    if (sub !== "connectors" || client === null || !projectId) return;
    const cached = connectorsLoaded.current;
    if (cached?.client === client && cached.projectId === projectId) return;
    let live = true;
    connectorsLoaded.current = { client, projectId };
    setConnectors({ client, projectId, items: null, error: null });
    void client.getGatewayConnections(projectId).then((items) => {
      if (live) setConnectors({ client, projectId, items, error: null });
    }).catch(() => {
      if (live) {
        connectorsLoaded.current = null;
        setConnectors({ client, projectId, items: null, error: "连接器清单读取失败，可在「连接与同步」页查看。" });
      }
    });
    return () => { live = false; };
  }, [sub, client, projectId]);
  /**
   * 「文件」二级：列受管目录的一层条目（HTTP §10.112）。
   *
   * 每次打开面板、每次进入子目录都是一次**新的读取命令**（新 `command_id`）——刷新就是
   * 重新读当前目录，不缓存目录内容，也不把截断列表当完整目录。连接按项目登记：
   * 打开目录时服务端已确保 FILE_QUERY 连接与只读策略，因此这里只取一条 ACTIVE 连接；
   * 一条都没有时如实说明缺口，不伪造条目。
   */
  const loadFiles = (path: string) => {
    if (client === null || workspace === null) return;
    const request = ++fileRequest.current;
    /* 新的读取命令就是新的清单：可见计数回首批，不把上一个目录的展开量带过来。 */
    setFilesVisible(attachFilesPageSize);
    const projectId = workspace.projectId;
    const resourceId = workspace.resourceId;
    const show = (patch: { entries?: readonly RelayDirectoryEntry[] | null; loading: boolean;
      error: string | null; truncated?: boolean; skipped?: number }) => {
      if (request !== fileRequest.current) return;
      setFileView({ client, projectId, resourceId, path, entries: patch.entries ?? null,
        loading: patch.loading, error: patch.error, truncated: patch.truncated ?? false,
        skipped: patch.skipped ?? 0 });
    };
    const failure = (message: string) => show({ loading: false, error: message });
    show({ loading: true, error: null });
    let reading = false;
    void (async () => {
      try {
        const connections = await client.getGatewayConnections(projectId);
        if (request !== fileRequest.current) return;
        const connection = connections.find((item) => item.status === "ACTIVE" &&
          item.capabilities.includes("FILE_QUERY"));
        if (connection === undefined) {
          failure("这个目录没有可用的文件浏览连接；先到「管理连接与权限」配置 FILE_QUERY。");
          return;
        }
        reading = true;
        const response = await client.readManagedFileState({ projectId, resourceId,
          connectionId: connection.id, commandId: createCommandId(), actionType: "LIST_DIRECTORY",
          ...(path === "" ? {} : { relativePath: path }), limit: 200 });
        const outcome = response.outcome;
        if (!("result" in outcome)) {
          failure(outcome.reason || "目录读取等待批准或结果未决。");
          return;
        }
        if (outcome.result.kind === "FAILURE") {
          const reason = outcome.result.reason;
          const known = fileListingFailureLabels[reason];
          failure(`${reason}${known === undefined ? "" : `：${known}`}` +
            `${outcome.result.detail === null ? "" : `（服务端原文：${outcome.result.detail}）`}`);
          return;
        }
        if (outcome.result.kind !== "LISTING") {
          failure("目录读取返回的不是目录列表。");
          return;
        }
        show({ entries: outcome.result.entries, loading: false, error: null,
          truncated: outcome.result.truncated, skipped: outcome.result.skipped });
      } catch (caught) {
        failure(reading && needsReceiptCheck(caught) ? "文件读取结果无法核对，请稍后重新打开这个目录。"
          : describeLiveError(caught).message);
      }
    })();
  };
  /** 渐进展示的下一批：尾部「显示更多」行点击时追加一批，到全部条目为止（行随之消失）。 */
  const revealMoreFiles = () => {
    const total = (fileView?.entries ?? []).length;
    setFilesVisible((count) => Math.min(Math.max(total, count), count + attachFilesPageSize));
  };
  /* 同一触发点的滚动版：所有二级共用行区滚动容器，只在「文件」面板且滚到近底
     （剩约三行）时追加下一批；读条目本身仍是一次读取命令，这里只决定画多少。 */
  const onSubbodyScroll = (event: React.UIEvent<HTMLDivElement>) => {
    if (sub !== "files") return;
    const total = (fileView?.entries ?? []).length;
    if (filesVisible >= total) return;
    const box = event.currentTarget;
    if (box.scrollTop + box.clientHeight < box.scrollHeight - 96) return;
    setFilesVisible(Math.min(total, filesVisible + attachFilesPageSize));
  };
  useEffect(() => {
    if (sub !== "files" || client === null || workspace === null) return;
    loadFiles("");
    return () => { fileRequest.current++; };
    // 只在打开「文件」二级时读一次；目录内导航由 loadFiles 自己发起。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sub, client, workspace?.projectId, workspace?.resourceId]);
  /* 我的产物：打开二级时读一次当前任务的产物。产物按任务归属，没有任务就不猜一个，
     在面板里说明从任务进入对话后可选；读取失败不显示为空清单。 */
  useEffect(() => {
    if (sub !== "artifacts" || client === null || artifactTaskId === null || artifactTaskId === undefined) return;
    const taskId = artifactTaskId;
    let live = true;
    setArtifactView({ client, taskId, items: null, error: null });
    void client.getTaskArtifacts(taskId).then((result) => {
      if (live) setArtifactView({ client, taskId, items: result.items, error: null });
    }).catch(() => {
      if (live) setArtifactView({ client, taskId, items: null, error: "任务产物读取失败；可在任务的工作详情里查看。" });
    });
    return () => { live = false; };
  }, [sub, client, artifactTaskId]);
  const run = (fn?: () => void) => () => { close(true); fn?.(); };
  /**
   * 点击一级行：显式开关。
   * hover 已经把它打开时，这一次点击是「固定」而不是「关掉」——指针刚移上去就看到列表，
   * 顺手点一下却让它消失，是 hover 展开后最容易踩的反直觉。固定之后指针移开也不收。
   */
  const toggleSub = (section: AttachSection) => () => {
    cancelHoverClose();
    if (sub === section) {
      if (hoverOpened.current === section) { hoverOpened.current = null; return; }
      setSub(null); return;
    }
    hoverOpened.current = null; setSub(section);
  };
  const refKey = (ref: RelayAssistSourceRef) => `${ref.kind}:${ref.rootId}:${ref.version}`;
  const refSelected = (ref: RelayAssistSourceRef) =>
    selectedRefs.some((selected) => refKey(selected) === refKey(ref));
  /** 已选满时未选中项不可再选：上限与资料选择器一致，超限不静默吞掉点击。 */
  const sourceTogglesBlocked = onToggleSourceRef !== undefined && selectedRefs.length >= attachSourceLimit;
  /** 引用行只是「本次消息的候选输入」开关：选中/取消都不关闭面板，方便连续多选。 */
  const sourceRefRow = (ref: RelayAssistSourceRef, index: number) => {
    const selected = refSelected(ref);
    return <AttachRow key={`${refKey(ref)}:${index}`} level={2} testId={`assist-attach-ref-${index}`}
      icon={<FileText />} label={`${assistSourceKindLabels[ref.kind]} · v${ref.version}`}
      title={`${ref.kind} · v${ref.version} · ${ref.rootId}`} selected={selected}
      disabled={sourceTogglesBlocked && !selected} onSelect={() => onToggleSourceRef?.(ref)} />;
  };
  const catalogItems = catalog?.client === client ? catalog.items : null;
  const commandEntries = (catalogItems ?? []).filter((entry) => entry.kind !== "METHOD" || mode === "AGENT");
  /** 项目资料一节直接平铺：与发送选项 select 同一批知识版本，只在超长时截断并指向检索。 */
  const libraryItems = library !== null && library.client === client && library.projectId === projectId
    ? library.items : null;
  const activeKnowledge = (libraryItems ?? []).filter((item) => item.status === "ACTIVE");
  const shownKnowledge = activeKnowledge.slice(0, attachProjectSourceLimit);
  const knowledgeRef = (item: RelayKnowledge): RelayAssistSourceRef =>
    ({ kind: "KNOWLEDGE", rootId: item.id, version: item.currentVersion });
  /** Skill 只列每个 id 的最新版本：历史版本不可调用，列出来只会让列表变长。 */
  const skillEntries = (skills ?? []).filter((skill, index, all) =>
    all.findIndex((item) => item.id === skill.id) === index);
  const sectionLabel = (text: string) => <p className="agent-chat-attach-section">{text}</p>;
  const emptyLine = (text: string) => <p className="agent-chat-attach-empty">{text}</p>;
  /** 一级四项：身份与排序固定，状态提示来自真实事实（已选资料数、已绑目录、已选 Skill）。 */
  /** 调用方给的禁用/缺口原因：既做悬停 title，也做二级面板里那句「为什么现在选不了」。 */
  const noteFor = (key: AttachSection): string | undefined =>
    (notes ?? []).find((item) => item.keys.includes(key))?.text;
  /** 没有项目/任务归属时 Skill 与连接器都不可选，但**仍然可点开**（用户 2026-10-18 指认
   *  「选择skill和连接器与插件点击不了」）：一级行不再禁用，缺口由二级面板第一句说明。
   *  资料行只要有勾选入口就可展开（首条消息也能先选资料，DEV-0100）；两个入口都没有时
   *  才真的没有二级可讲，保留禁用。 */
  const skillNeedsTarget = skills === undefined;
  const connectorsNeedProject = projectId === null || projectId === undefined;
  const level1Row = (key: AttachSection, spec: Omit<AttachRowSpec, "testId" | "level" | "section" | "expanded" | "onSelect" | "onHover">): AttachRowSpec =>
    ({ ...spec, testId: `assist-attach-${key}`, level: 1, section: key,
      expanded: sub === key, onSelect: toggleSub(key),
      title: spec.disabled === true ? noteFor(key) : spec.title,
      /* 禁用行没有二级，hover 也不能把它打开：与 chevron / aria-expanded 同一条约束。 */
      onHover: spec.disabled === true ? undefined : hoverSub(key) });
  const level1: readonly AttachRowSpec[] = [
    /* 上传附件是对标参考菜单的直接动作（2026-10-24 用户指令）：不做二级，点开本机图片
       选择器，选中即进既有暂存链路；这里不上传、不发送，附件芯片负责后续状态。 */
    { testId: "assist-attach-upload", level: 1, icon: <Paperclip />, label: "上传附件",
      disabled: onUploadAttachments === undefined || uploadDisabled,
      title: onUploadAttachments === undefined ? "当前输入器不支持附件"
        : uploadDisabled ? "当前消息在途或正在发送，稍后再上传附件"
          : "从本机选择图片作为本次消息的附件（PNG/JPEG/GIF/WebP，单张 ≤ 2MB）",
      onSelect: () => uploadInputRef.current?.click() },
    /* 工作目录的文件与我的产物各自带二级；没有目录/任务时仍可点开，缺口由面板第一句说明，
       不让入口点了没反应。 */
    level1Row("files", { icon: <Folder />, label: workspace === null ? "文件" : `${workspace.displayName}的文件`,
      title: workspace === null ? "先绑定工作目录后再浏览文件；目录归协作页目录细条"
        : `浏览 ${workspace.displayName} 根目录的一层文件；点文件把相对路径插入草稿` }),
    level1Row("artifacts", { icon: <Package />, label: attachSectionLabels.artifacts,
      title: artifactTaskId === null || artifactTaskId === undefined
        ? "当前会话没有关联任务；产物按任务归属，从任务进入对话后可选择"
        : "列出当前任务已保存的产物版本；点一项把标题与版本插入草稿" }),
    level1Row("sources", { icon: <FileText />, label: attachSectionLabels.sources,
      hint: selectedRefs.length > 0 ? String(selectedRefs.length) : undefined,
      disabled: onSources === undefined && onToggleSourceRef === undefined }),
    /* 目录入口不在「+」里（2026-10-19）：目录有常驻 Owner（协作页目录细条），
       既重复又读成「用之前必须先选目录」。见 §32.3。 */
    level1Row("skill", { icon: <Sparkles />, label: attachSectionLabels.skill,
      selected: skillSelected || (selectedSkillKey !== null && selectedSkillKey !== ""),
      title: skillNeedsTarget
        ? noteFor("skill") ?? "Skill 需要项目或任务归属；从项目或任务进入后可预选" : undefined }),
    level1Row("command", { icon: <Terminal />, label: attachSectionLabels.command }),
    /* 连接器按项目登记：首条消息（无项目归属）没有任何清单可读，但入口仍可点开——
       面板里说明原因并保留「管理连接与权限」，不让这一行点了没反应。 */
    level1Row("connectors", { icon: <Plug />, label: attachSectionLabels.connectors,
      title: client === null ? "连接本机 API 后才能读取连接器与授权状态"
        : connectorsNeedProject ? connectorScopeNote : undefined })
  ];

  const submenu = (section: AttachSection) => {
    if (section === "files") {
      /* 只读一层：目录行进入子目录（在同一片二级面板里换内容，不出现第三级），
         文件行把相对路径插进草稿。截断、跳过与失败各有明确说法，失败不显示成空目录。 */
      const view = fileView !== null && fileView.client === client &&
        fileView.projectId === workspace?.projectId && fileView.resourceId === workspace?.resourceId
        ? fileView : null;
      const joinPath = (base: string, name: string) => base === "" ? name : `${base}/${name}`;
      const parentPath = (path: string) => path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      return <>
        {sectionLabel(workspace === null ? "文件" : `${workspace.displayName} 根目录`)}
        {workspace === null ? emptyLine("当前对话还没有绑定工作目录；先在目录细条选择目录。")
          : client === null ? emptyLine("连接本机 API 后才能浏览工作目录文件。")
          : view === null || view.loading ? emptyLine("正在读取目录…")
          : view.error !== null ? emptyLine(view.error)
          : <>
            {view.path !== "" && <AttachRow level={2} testId="assist-attach-files-up" icon={<Folder />}
              label="返回上级" hint={view.path} onSelect={() => loadFiles(parentPath(view.path))} />}
            {(view.entries ?? []).length === 0 ? emptyLine("这个目录里没有可列出的文件。")
              : <>
                {/* 渐进展示（2026-10-25 用户指认「文件菜单无限滚动」）：一次全画 200 行
                   既拖长滚动也没有意义；首批 30 行，滚到行区近底自动追加。面板没有触发
                   内部滚动（超高视口）时，滚动事件不来，尾部「显示更多」行就是兜底入口，
                   键盘 ↓ 也能走到它。 */}
                {(view.entries ?? []).slice(0, filesVisible).map((entry, index) => {
                const fullPath = joinPath(view.path, entry.path);
                if (entry.kind === "directory") {
                  return <AttachRow key={`${entry.path}:${index}`} level={2}
                    testId={`assist-attach-file-${index}`} icon={<Folder />}
                    label={entry.path} hint="目录" title={`进入 ${fullPath}`}
                    onSelect={() => loadFiles(fullPath)} />;
                }
                if (entry.kind === "file") {
                  return <AttachRow key={`${entry.path}:${index}`} level={2}
                    testId={`assist-attach-file-${index}`} icon={<FileText />}
                    label={entry.path}
                    hint={entry.size === null ? undefined : formatAttachmentBytes(entry.size)}
                    title={onInsertMention === undefined ? "当前输入器不支持把文件插入草稿"
                      : `把 @${fullPath} 插入草稿`}
                    disabled={onInsertMention === undefined}
                    onSelect={run(() => onInsertMention?.(fullPath))} />;
                }
                return <AttachRow key={`${entry.path}:${index}`} level={2}
                  testId={`assist-attach-file-${index}`} icon={<FileText />}
                  label={entry.path} hint="其他" disabled onSelect={() => {}} />;
              })}
                {(view.entries ?? []).length > filesVisible &&
                  <AttachRow level={2} testId="assist-attach-files-more" icon={<ChevronDown />}
                    label="显示更多" hint={`剩余 ${(view.entries ?? []).length - filesVisible} 项`}
                    title="再显示下一批条目；滚动到面板底部也会自动加载"
                    onSelect={revealMoreFiles} />}
              </>}
            {view.truncated && emptyLine(`已截断：只列出前 ${(view.entries ?? []).length} 项。`)}
            {view.skipped > 0 && emptyLine(`已跳过 ${view.skipped} 个受保护或构建目录。`)}
          </>}
      </>;
    }
    if (section === "artifacts") {
      /* 产物按任务归属：没有任务时只说明去向，不跨任务猜一份清单。 */
      const view = artifactView !== null && artifactView.client === client &&
        artifactView.taskId === artifactTaskId ? artifactView : null;
      const artifactItems = view === null ? null : view.items;
      const artifactError = view === null ? null : view.error;
      return <>
        {sectionLabel("当前任务产物")}
        {client === null ? emptyLine("连接本机 API 后才能列出任务产物。")
          : artifactTaskId === null || artifactTaskId === undefined
            ? emptyLine("当前会话没有关联任务；产物按任务归属，从任务进入对话后可选择。")
            : artifactError !== null ? emptyLine(artifactError)
              : artifactItems === null ? emptyLine("正在读取任务产物…")
                : artifactItems.length === 0 ? emptyLine("这个任务还没有保存的产物。")
                  : artifactItems.map((artifact, index) => {
                    const latest = artifact.versions.at(-1);
                    const mention = latest === undefined ? artifact.title
                      : `${artifact.title} v${latest.versionNumber}`;
                    return <AttachRow key={artifact.id} level={2}
                      testId={`assist-attach-artifact-${index}`} icon={<Package />}
                      label={artifact.title}
                      hint={latest === undefined ? "无版本" : `v${latest.versionNumber}`}
                      title={onInsertMention === undefined ? "当前输入器不支持把产物插入草稿"
                        : `把 @${mention} 插入草稿`}
                      disabled={latest === undefined || onInsertMention === undefined}
                      onSelect={run(() => onInsertMention?.(mention))} />;
                  })}
      </>;
    }
    if (section === "sources") return <>
      {/* 列表优先：项目资料 → 对话中的资料 → 最近引用，都是可直接勾选的条目；
          检索与「选择本地文件」这两个动作行放到列表之后，不挡在第一条目前面。 */}
      {projectId !== null && <>
        {sectionLabel("项目资料")}
        {client === null ? emptyLine("连接本机 API 后才能列出项目资料")
          : library?.error != null ? emptyLine(library.error)
          : libraryItems === null ? emptyLine("正在读取项目资料…")
          : shownKnowledge.length === 0 ? emptyLine("这个项目还没有可引用的资料")
          : shownKnowledge.map((item, index) => <AttachRow key={item.id} level={2}
            testId={`assist-attach-project-${index}`} icon={<FileText />} label={item.title}
            hint={`v${item.currentVersion}`}
            title={`${item.title} · KNOWLEDGE v${item.currentVersion} · ${item.id}`}
            selected={refSelected(knowledgeRef(item))}
            disabled={onToggleSourceRef === undefined || sourceTogglesBlocked && !refSelected(knowledgeRef(item))}
            onSelect={() => onToggleSourceRef?.(knowledgeRef(item))} />)}
        {activeKnowledge.length > shownKnowledge.length &&
          emptyLine(`另有 ${activeKnowledge.length - shownKnowledge.length} 条资料，用下方检索按关键词查找`)}
      </>}
      {sectionLabel("对话中的资料")}
      {conversationRefs.length === 0 ? emptyLine("当前对话还没有可引用的资料")
        : conversationRefs.map(sourceRefRow)}
      {sectionLabel("最近引用")}
      {recentRefs.length === 0 ? emptyLine("本机还没有最近引用")
        : recentRefs.map((ref, index) => sourceRefRow(ref, conversationRefs.length + index))}
      {/* 检索开放面（点击穿透任务书 CT-02）：只有调用方给了浮层面板入口才展示。
          首条消息没有会话级的检索面板，但上方已平铺项目资料与最近引用，仍可直接勾选；
          留一枚点不动的「检索项目资料」只会被读成坏了（DEV-0100）。 */}
      {onSources !== undefined && <AttachRow level={2} testId="assist-attach-search" icon={<Search />} label="检索项目资料"
        onSelect={run(onSources)} />}
      {/* 2026-10-20（P2）：「选择本地文件」在这里长期禁用——桌面宿主只有目录选择器，
          没有任何真实去向。占着一个动作行的位置，只会让人以为「再点一次就好了」。
          需要本机文件时走目录（目录即作用域）与上方检索；附件能力仍是待实现需求，
          记录在《工作台交互设计》§32 的未接入清单里，不靠这个禁用行承载。 */}
    </>;
    if (section === "skill") return <>
      {/* Skill 也直接列出来：与发送选项的「生成方式」同一份清单、同一处状态，点一行即选中。
          生成类入口当前没有后端，仍按 §32.5 如实禁用并排在列表之后。
          **清单是全部内置 Skill**（2026-10-18）：`target` 只决定它需要什么上下文，
          需要而当前没有时标注「需任务 / 需项目」；能在输入器里补齐（`resolveInPlace`）
          就仍然可选，补不了（会话归属已冻结）才禁用并说明。 */}
      {skills !== undefined ? <>
        {sectionLabel("可用 Skill")}
        {skillEntries.length === 0 ? emptyLine("当前没有可用的 Skill")
          : skillEntries.map((skill, index) => {
            const key = `${skill.id}@${skill.version}`;
            const blocked = !skill.callSupported || skill.missingCapabilities.length > 0;
            const scope = skill.target === "TASK" ? "任务" : "项目";
            const missingScope = skillContext !== null && (skill.target === "TASK"
              ? skillContext.taskId === null : skillContext.projectId === null);
            const scopeFixed = missingScope && skillContext !== null && !skillContext.resolveInPlace;
            return <AttachRow key={key} level={2} testId={`assist-attach-skill-${index}`}
              icon={<Sparkles />} label={skill.title}
              hint={blocked ? "不可调用" : missingScope ? `需${scope}` : `v${skill.version}`}
              title={`${key} · ${!skill.callSupported ? "历史版本，仅可查阅"
                : skill.missingCapabilities.length > 0 ? `缺能力：${skill.missingCapabilities.join("、")}`
                : skill.availability === "CALLABLE_READ_ONLY" ? "只读输出" : "仅生成建议"}${
                missingScope ? ` · 需要${scope}上下文` : ""}`}
              selected={selectedSkillKey === key}
              disabled={blocked || onPickSkill === undefined || scopeFixed}
              onSelect={run(() => onPickSkill?.(key))} />;
          })}
        {skillContext !== null && skillEntries.some((skill) => skill.target === "TASK"
          ? skillContext.taskId === null : skillContext.projectId === null) &&
          emptyLine(skillContext.resolveInPlace
            ? "带「需任务 / 需项目」的 Skill 选中后，先在工具行指定任务或项目。"
            : "这条会话没有任务或项目归属；带标记的 Skill 要回到对应任务或项目开始对话。")}
      </> : emptyLine(noteFor("skill") ?? "当前没有可用的 Skill 清单")}
      <AttachRow level={2} testId="assist-attach-skill-describe" icon={<Sparkles />} label="从描述生成 Skill"
        title="Skill 生成尚未接入；可在下方选择已有 Skill 送入当前消息。"
        hint="暂未接入" disabled onSelect={() => {}} />
      <AttachRow level={2} testId="assist-attach-skill-file" icon={<FileText />} label="从文件生成 Skill"
        title="Skill 生成尚未接入；可在下方选择已有 Skill 送入当前消息。"
        hint="暂未接入" disabled onSelect={() => {}} />
      <AttachRow level={2} testId="assist-attach-skill-existing" icon={<ListTree />} label="在发送选项里选择"
        disabled={onSkill === undefined} onSelect={run(onSkill)} />
    </>;
    if (section === "connectors") {
      /* 连接器是动态读取的服务端登记（GitHub / 浏览器 / 电脑等能力族都在其中），
         前端只做能力键 → 中文名映射；行是状态展示不是按钮——连接器的准入语义在
         执行时的权限链里，不在消息附件里，点了也不能「选进消息」。 */
      const connectorItems = connectors?.client === client && connectors.projectId === projectId
        ? connectors.items : null;
      /* 授权状态只在「已连 API 且有项目归属」时才有来源；另两种情况读不到任何登记，
         面板顶部只说一次原因，三个插件行不再逐条重复「需在项目中授权」
         （2026-10-19 用户指认「为什么这里需要项目中授权……这些都是过度设计」）。 */
      const scopeKnown = client !== null && !connectorsNeedProject;
      /* 停用/撤销的连接也列出来并如实标注状态——「有哪些插件、各自什么状态」本身就是信息，
         只列 ACTIVE 会让人以为电脑插件这类停用连接不存在。 */
      const connectionStatusText = (status: string): string =>
        status === "ACTIVE" ? "已连接" : status === "DISABLED" ? "已停用" : status === "REVOKED" ? "已撤销" : status;
      const totalCapabilities = (connectorItems ?? []).reduce((count, item) => count + item.capabilities.length, 0);
      /**
       * 三个内置插件固定成行（2026-10-19 用户指认「加号的菜单看不到这三个插件」）。
       *
       * 此前它们只随项目连接登记出现在「已连接能力」里：没有项目归属、或项目还没登记连接时
       * 整块是空的，看起来像插件不存在。这里把「有哪些插件」与「本会话是否已授权」分开：
       * 插件行恒在，状态仍只取自服务端连接登记（ACTIVE/DISABLED/REVOKED），不猜运行时能力，
       * 也不把「能装」冒充「已可用」。
       */
      const builtinPlugins: readonly { readonly key: string; readonly icon: ReactNode;
        readonly label: string; readonly purpose: string;
        readonly capabilities: readonly string[] }[] = [
        /* 图标用用户提供的薄荷绿插件图（2026-10-25，assets/plugin-icons）：
            稳定 key 选图，尺寸走 `.agent-chat-attach-item-icon` 的既有规则，
            Lucide 仍服务其他通用操作。 */
        { key: "computer", icon: <PluginIcon plugin="computer" />, label: "电脑操控",
          purpose: "截图 · 窗口 · 鼠标键盘", capabilities: ["COMPUTER_READ", "COMPUTER_INPUT"] },
        { key: "browser", icon: <PluginIcon plugin="browser" />, label: "浏览器操控",
          purpose: "页面读取 · 点击 · 填表", capabilities: ["BROWSER_READ", "BROWSER_ACTION", "BROWSER_COMMIT"] },
        { key: "github", icon: <PluginIcon plugin="github" />, label: "GitHub",
          purpose: "仓库 · PR · Issue 只读", capabilities: ["GITHUB_READ"] }
      ];
      /* 读不到登记时**不写状态**：不是「未授权」而是「无从判断」，行上留空比编一个状态诚实；
         原因由面板顶部那一句统一说明，去向仍在 title 与点击里。 */
      const pluginState = (capabilities: readonly string[]): { hint?: string; title: string } => {
        const where = "授权在「连接与同步」页按项目登记";
        if (!scopeKnown) return { title: where };
        if (connectors?.error != null) return { hint: "状态未知", title: `${connectors.error}；${where}` };
        if (connectorItems === null) return { hint: "读取中…", title: where };
        const states = connectorItems.flatMap((connection) =>
          connection.capabilities.filter((capability) => capabilities.includes(capability))
            .map(() => connection.status));
        if (states.length === 0) return { hint: "未授权", title: `${where}` };
        if (states.every((status) => status === "ACTIVE")) return { hint: "已连接", title: where };
        if (states.some((status) => status === "ACTIVE")) return { hint: "部分已连接", title: where };
        return { hint: states.includes("DISABLED") ? "已停用" : "已撤销", title: where };
      };
      /* 插件行是插入入口（DEV-0099，取代 2026-10-20 的原地详情）：点击只把 `@标签 `
         写进输入框，不弹状态菜单、不发送消息；连接状态仍显示在行尾，授权与运行时诊断
         归「管理连接与权限」页。 */
      let factIndex = 0;
      return <>
        {/* 面板首句说明缺口（读不到登记时的唯一一句原因），紧随其后才是插件身份行。 */}
        {!scopeKnown && emptyLine(client === null
          ? "连接本机 API 后才能读取连接器与授权状态" : connectorScope)}
        {sectionLabel("内置插件")}
        {builtinPlugins.map((plugin) => {
          const state = pluginState(plugin.capabilities);
          return <AttachRow key={plugin.key} level={2}
            testId={`assist-attach-plugin-${plugin.key}`} icon={plugin.icon} label={plugin.label}
            hint={state.hint}
            title={`${plugin.purpose} · 能力：${plugin.capabilities.map(gatewayCapabilityLabel).join("、")} · ${state.title} · 点击把 @${plugin.label} 插入输入框`}
            disabled={onPickPlugin === undefined}
            onSelect={run(() => onPickPlugin?.(plugin.label))} />;
        })}
        {/* 没有项目归属时这一节必然为空，再列一遍「按项目登记」就是同一句话的第三次重复：
            整节不渲染，缺口已在顶部说明。 */}
        {scopeKnown && <>
          {sectionLabel("已连接能力")}
          {connectors?.error != null ? emptyLine(connectors.error)
            : connectorItems === null ? emptyLine("正在读取连接器…")
            : totalCapabilities === 0 ? emptyLine("这个项目还没有已连接的插件；到「连接与同步」页或项目工作台添加")
            : (connectorItems ?? []).map((connection) => connection.capabilities.map((capability) => {
              const index = factIndex++;
              return <p key={`${connection.id}:${capability}`} className="agent-chat-attach-fact"
                data-testid={`assist-attach-connector-${index}`}>
                <span className="agent-chat-attach-item-icon" aria-hidden="true"><Plug /></span>
                <span className="agent-chat-attach-item-label">{gatewayCapabilityLabel(capability)}</span>
                <span className="agent-chat-attach-item-tail">
                  <span className="agent-chat-attach-item-hint">{connectionStatusText(connection.status)}</span>
                </span>
              </p>;
            }))}
        </>}
        <AttachRow level={2} testId="assist-attach-connectors-manage" icon={<Settings />} label="管理连接与权限"
          title={projectId === null ? "先选择项目：连接与权限按项目登记" : "在当前项目的连接与权限页查看与配置"}
          onSelect={run(openConnectionsManager)} />
      </>;
    }
    return <>
      <AttachRow level={2} testId="assist-attach-command-focus" icon={<Terminal />} label="输入命令"
        onSelect={run(onCommand)} />
      {sectionLabel("登记命令")}
      {client === null ? emptyLine("连接本机 API 后才能读取命令清单")
        : catalog?.error != null ? emptyLine(catalog.error)
        : catalogItems === null ? emptyLine("正在读取命令…")
        : commandEntries.length === 0 ? emptyLine("没有可用的登记命令")
        : commandEntries.map((entry) => <AttachRow key={entry.name} level={2}
          testId={`assist-attach-command-${entry.name}`} icon={<Terminal />}
          label={`/${entry.name} · ${entry.title}`}
          hint={chatCommandStatus(entry, hasSession) ?? undefined}
          title={`${entry.summary} · 用法：${entry.usage} · 范围：${chatCommandScope(entry)}`}
          disabled={onPickCommand === undefined}
          onSelect={run(() => onPickCommand?.(entry.name))} />)}
    </>;
  };

  return <details className="agent-chat-attach" ref={detailsRef} onKeyDown={onKeyDown}
    onToggle={(event) => { if (!(event.currentTarget as HTMLDetailsElement).open) { hoverOpened.current = null; setSub(null); } }}>
    <summary className="agent-chat-attach-btn" data-testid="assist-attach" aria-label="添加上下文与附件" title="添加上下文与附件">
      <Plus aria-hidden="true" /></summary>
    {/* 「上传附件」的宿主：原生文件选择器，格式与服务端暂存上限一致；选中后交给调用方的
        既有暂存链路，菜单立即收起，不在菜单里上传或发送。放在 summary 之后、菜单之前：
        summary 仍是 details 的第一个子件（原生开合依赖它），工具行子件序也不变。 */}
    <input ref={uploadInputRef} type="file" hidden multiple
      accept="image/png,image/jpeg,image/gif,image/webp"
      data-testid="assist-attach-upload-input"
      onChange={(event) => {
        const files = Array.from(event.currentTarget.files ?? []);
        // 清空 value，同一张图片再选一次也会触发 change。
        event.currentTarget.value = "";
        if (files.length === 0 || onUploadAttachments === undefined) return;
        onUploadAttachments(files);
        close(false);
      }} />
    <div className="agent-chat-attach-menu" ref={menuRef} data-level="1" onPointerLeave={scheduleHoverClose}>
      {level1.map((row) => <AttachRow key={row.testId} {...row} />)}
      {sub !== null && <div className="agent-chat-attach-submenu" ref={subRef} data-submenu="true"
        data-level="2" data-section={sub} data-flip={flip ? "left" : "right"}
        style={subTop === null && subMaxHeight === null ? undefined
          : { top: subTop ?? undefined, maxHeight: subMaxHeight ?? undefined }}
        role="group" aria-label={attachSectionLabels[sub]}
        onPointerEnter={cancelHoverClose} onPointerLeave={scheduleHoverClose}>
        <div className="agent-chat-attach-subbody" onScroll={onSubbodyScroll}>{submenu(sub)}</div>
      </div>}
    </div>
  </details>;
}

function canPreview(message: RelayAssistMessage): boolean {
  return message.role === "ASSISTANT" && message.intent === "DISCUSS" && message.skill === null &&
    !message.cancelRequested && (message.status === "PENDING" || message.status === "RUNNING");
}

function isInFlight(message: RelayAssistMessage): boolean {
  return message.status === "PENDING" || message.status === "RUNNING";
}

/**
 * 「过程已经结束、最终正文还没核对完」这一段的过渡读数（2026-10-25 综合优化）。
 *
 * 服务端在 `settleGeneration` 的同一句 UPDATE 里写 status 与 content，所以终态预览帧一到，
 * 消息行其实已经有终态与正文；差的只是那一次 `GET messages` 往返（几毫秒到一次超时）。
 * 这段空档此前直接把草稿删掉：先露出一行三点、再换成正文，读起来是「草稿突然消失又长出来」。
 * 这里把最后一次草稿原样留在**同一个阅读区**，旁边写明「最终正文核对中」，等权威消息行
 * 带着正文回来才交接。它不新造业务状态：`SETTLING` / `UNVERIFIED` 都是本机呈现态，
 * 权威状态仍只读 `message.status`。
 */
type ReplySettling = {
  /** 最后一次草稿；失败与取消一律为空串——那两种终态要求立即清内容。 */
  readonly text: string;
  readonly revision: string;
  readonly truncated: boolean;
  /** 预览帧报告的终态。它只说明「这次生成结束了」，不冒充消息行的权威状态。 */
  readonly outcome: "COMPLETED" | "FAILED" | "CANCELLED";
  /** SETTLING = 正在重读消息行；UNVERIFIED = 那次重读失败，状态待核对。 */
  readonly stage: "SETTLING" | "UNVERIFIED";
};

/** 空字符串表示 meta 行不标状态词。PENDING 与 COMPLETED 同档：在途由正文前的三点、
 *  meta 行耗时与输入栏停止键表达，不写「等待生成」（2026-10-21 用户指令）。 */
const messageStatusLabels: Record<RelayAssistMessage["status"], string> = {
  PENDING: "", RUNNING: "正在生成", COMPLETED: "", FAILED: "生成失败", CANCELLED: "已取消"
};

/** 0132：撤回回执里的逐文件状态；未知枚举原样回显，不猜语义。 */
const recallFileStatusLabels: Record<string, string> = {
  PLANNED: "计划中", RESTORED: "已恢复", ALREADY_RESTORED: "本来已是发送前状态",
  CONFLICT: "冲突", UNAVAILABLE: "不可恢复", FAILED: "恢复失败",
  SKIPPED: "未执行", UNCERTAIN: "结果未决"
};

function recallSummaryText(recall: RelayAssistMessageRecallSummary): string {
  switch (recall.status) {
    case "RUNNING": return `正在回退文件（${recall.restoredFiles}/${recall.plannedFiles}）。`;
    case "COMPLETED": return recall.plannedFiles === 0
      ? "已撤回；这条消息之后没有需要回退的文件修改。"
      : `已回退 ${recall.restoredFiles} 个文件到该轮发送前。`;
    case "PARTIAL": return `撤回已生效：${recall.restoredFiles}/${recall.plannedFiles} 个文件已回退，`
      + `${recall.skippedFiles} 个未恢复；逐项原因见回执。`;
    case "FAILED": return `撤回未生效：${recall.skippedFiles} 个文件未恢复，消息未标记撤回；逐项原因见回执。`;
  }
}

/**
 * 0132：撤回回执。摘要随消息列表读回；逐文件结果按需读取，不把每条历史消息都变成
 * 一次额外查询。错误显示在同一层，不弹窗。
 */
function AssistRecallNote({ recall, receipt, reading, busy, error, onRead, onResume }: {
  recall: RelayAssistMessageRecallSummary; receipt: RelayAssistMessageRecall | null;
  reading: boolean; busy: boolean; error: string | null;
  onRead: () => void; onResume: () => void;
}) {
  return <div className="assist-recall-note" data-testid={`assist-recall-${recall.id}`}
    data-status={recall.status}>
    <p className="assist-recall-headline"><RotateCcw aria-hidden="true" />
      <span>{recallSummaryText(recall)}</span></p>
    {receipt !== null
      ? <details className="tech-details">
        <summary>逐文件结果（{receipt.files.length}）</summary>
        <p className="helper-text">工作目录：{receipt.rootPath ?? "无（没有文件修改）"}</p>
        <ul className="assist-recall-files">
          {receipt.files.map((file) => <li key={file.path} data-status={file.status}>
            <code>{file.path}</code>
            <span>{recallFileStatusLabels[file.status] ?? file.status}</span>
            <span className="helper-text">发送前{file.baseline === "PRESENT" ? "存在" : "不存在"}
              {file.reason ? ` · ${file.reason}` : ""}</span>
          </li>)}
        </ul>
      </details>
      : recall.status === "RUNNING"
        // 进程中断会留下 RUNNING：服务端只允许过期的 RUNNING 被接续，这里给回一个入口，
        // 否则这条消息永远停在「正在回退」，而撤回按钮因已存在回执不再出现。
        ? <button className="text-link" type="button" disabled={busy} onClick={onResume}
          title="服务重启或连接中断后，继续未结算的文件恢复">
          {busy ? "正在继续…" : "继续回退"}</button>
        : <button className="text-link" type="button" disabled={reading} onClick={onRead}>
          {reading ? "正在读取回执…" : "查看逐文件回执"}</button>}
    {error !== null && <p className="action-error" role="alert">{error}</p>}
  </div>;
}

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

/** 秒级耗时文本：不足一分钟只报秒，分钟档带两位秒数，小时档不再展开秒。 */
function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1_000));
  if (total < 1) return "不到 1 秒";
  if (total < 60) return `${total} 秒`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes} 分 ${String(total % 60).padStart(2, "0")} 秒`;
  return `${Math.floor(minutes / 60)} 小时 ${String(minutes % 60).padStart(2, "0")} 分`;
}

/**
 * 消息头部的任务耗时：从消息提交时刻（createdAt）起算，在途每秒走一次；
 * 终态改用服务端结算时刻（updatedAt）冻结，刷新后仍是同一结果。
 * 在途消息的 updatedAt 是心跳，不能拿来当起点或终点。
 */
export function MessageElapsed({ message }: { message: RelayAssistMessage }) {
  const start = message.createdAt === null ? Number.NaN : Date.parse(message.createdAt);
  const running = message.status === "PENDING" || message.status === "RUNNING";
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running || !Number.isFinite(start)) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [running, start]);
  if (message.role !== "ASSISTANT" || !Number.isFinite(start)) return null;
  const end = running ? now : message.updatedAt === null ? Number.NaN : Date.parse(message.updatedAt);
  if (!Number.isFinite(end)) return null;
  return <span className="agent-message-elapsed" data-testid={`assist-elapsed-${message.id}`}>
    {running ? "已用" : "耗时"} {formatElapsed(end - start)}</span>;
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
 * 命中率只在 Provider 真的上报缓存读数时出现；没有读数时这一格直接留空，
 * 既不写"未采集"也不把 null 画成 0%，更不拿配置值冒充实际用量。占用圆环始终在。
 * 读数文案说「上下文」不说「输入」（2026-10-24 用户反馈）：input_tokens 是该次调用
 * 重发的完整上下文（含全部历史），写成「输入」会被读成本轮新增或会话累计出错账。
 * 悬停即浮出一句话（2026-10-22 用户指令）；点击圆环打开详情浮层（2026-10-25 用户指令
 * 「上下文圆圈点击打开展示会话窗口的菜单」）：浮层列出最近一次调用的上下文 / 输出 /
 * 缓存命中与口径说明，读数仍是同一份 props，不新增第二份用量来源。浮层与模型下拉
 * 同一套弹层语言：向上锚定、独占（useMenuExclusive）、点外即收、Esc 收起还焦点。
 */
function ContextMeter({ ratio, hitRate, call, limit }: { ratio: number | null;
  hitRate: number | null; call: RelayAssistMessage | null; limit: number | null }) {
  const percent = ratio === null ? null : formatUsagePercent(ratio, 1);
  const high = ratio !== null && ratio >= 0.8;
  const meterText = call === null ? "尚无模型调用"
    : ratio === null ? `上下文 ${call.usage.inputTokens ?? "未知"} tokens · 占用不可算`
      : `上下文 ${call.usage.inputTokens} / ${limit} tokens（${percent}%）`;
  const hitText = hitRate === null ? null : `缓存命中 ${formatUsagePercent(hitRate, 1)}%`;
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  // 打开别的浮层（「+」菜单、模型下拉）时收起本浮层；自身的外部按下与 Esc 由下面 effect 负责。
  useMenuExclusive(open, () => setOpen(false));
  // 收起语义与模型下拉同一套：点浮层外一次即收；Esc 收并把焦点还给圆环。
  useEffect(() => {
    if (!open) return;
    function close(): void {
      setOpen(false);
      triggerRef.current?.focus();
    }
    function onPointerDown(event: PointerEvent): void {
      if (rootRef.current?.contains(event.target as Node) ?? false) return;
      close();
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") close();
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);
  // 原生 `title` 在 Chromium/WebView2 要等约一秒、样式不可控，圆环又只有 24px，扫过去时
  // 读不到东西。这里与目录细条共用 `usePathTooltip` 那一套（fixed + portal，不被输入卡与
  // 工具行裁掉），悬停即浮出；浮层打开时取 null——同一句话已在浮层里可见，提示再叠在
  // 浮层底上就成了两层。原生 title 一并去掉，不留两套提示叠着。
  const { tooltipHandlers, tooltipNode, dismissTooltip } = usePathTooltip(
    () => (open ? null : meterText), "context-meter-tooltip");
  const usage = call?.usage ?? null;
  const contextValue = call === null || usage === null ? null
    : ratio === null ? `${usage.inputTokens?.toLocaleString() ?? "未知"} tokens · 占用不可算`
      : `${usage.inputTokens?.toLocaleString() ?? "未知"} / ${limit?.toLocaleString()} tokens（${percent}%）`;
  const outputValue = usage === null || usage.outputTokens === null
    ? "未知" : `${usage.outputTokens.toLocaleString()} tokens`;
  return <div className="agent-chat-usage">
    {hitText !== null && <span className="agent-chat-usage-text" data-testid="assist-cache-hit">{hitText}</span>}
    <div className="agent-chat-context-meter-group" ref={rootRef}>
      <button type="button" ref={triggerRef} className="agent-chat-context-meter"
        data-testid="assist-context-meter"
        data-state={ratio === null ? "unknown" : high ? "high" : "normal"}
        aria-label={meterText} aria-haspopup="dialog" aria-expanded={open} aria-controls={panelId}
        onClick={() => { setOpen((wasOpen) => !wasOpen); dismissTooltip(); }} {...tooltipHandlers}>
        <svg viewBox="0 0 36 36" aria-hidden="true" focusable="false">
          <circle className="agent-chat-context-meter-track" cx="18" cy="18" r="15" />
          <circle className="agent-chat-context-meter-fill" cx="18" cy="18" r="15"
            strokeDasharray={ratio === null ? undefined : `${(ratio * 94.25).toFixed(2)} 94.25`} />
        </svg>
        <span className="visually-hidden">{meterText}</span>
      </button>
      {open && <div className="agent-chat-context-meter-menu" id={panelId}
        data-testid="assist-context-meter-panel" role="dialog" aria-label="上下文用量详情">
        {call === null
          ? <p className="agent-chat-context-meter-note" data-testid="assist-context-meter-empty">
            尚无模型调用。发送消息并收到回复后，这里显示该次调用的上下文占用。</p>
          : <>
            <p className="agent-chat-context-meter-note">最近一次模型调用</p>
            <p className="agent-chat-context-meter-row"><span>上下文</span><span>{contextValue}</span></p>
            <p className="agent-chat-context-meter-row"><span>输出</span><span>{outputValue}</span></p>
            {/* 命中率与底栏同一口径：Provider 未上报时整行不渲染，不写「未采集」也不画成 0%。 */}
            {hitRate !== null && <p className="agent-chat-context-meter-row"><span>缓存命中</span>
              <span>{formatUsagePercent(hitRate, 1)}%</span></p>}
          </>}
        <p className="agent-chat-context-meter-note">上下文按该次调用重发的完整历史计（含缓存）；
          占用上限取应用配置的单次预算（max_call_tokens），不是模型物理窗口。</p>
      </div>}
      {tooltipNode}
    </div>
  </div>;
}

/** 来源条状态词：服务端枚举翻中文；未知枚举原样回显（可读名放 title），不编造解释。 */
function sourceStatusLabel(status: string): string {
  if (status === "AVAILABLE") return "可用";
  if (status === "UNAVAILABLE") return "不可用";
  return status;
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
      <p className="helper-text">{markdown === null ? "来源不可用" : markdown.mediaType} · <span
        className="assist-candidate-state" data-status={proposal.status}>{status}</span></p>
    </div>
    <span className="helper-text">查看候选</span>
  </div>;
}

/**
 * 在途三点。两种落位，语义相同、位置不同：
 *   * `inline`：草稿已经出现，三点贴在草稿最后一行末尾，读成「还在往下写」；
 *   * 非 inline：首字未到，它独占正文起始位，作为唯一的等待信号。
 * 不画在整块正文的下方——截图里那一行省略号会被读成正文的一部分。
 * 取消中由 meta 行说明，终态与过渡态另由状态词说明，都不在这里画。
 */
function InflightDots({ message, inline = false }: {
  readonly message: RelayAssistMessage; readonly inline?: boolean;
}) {
  return <span className="assist-inflight-dots" data-inline={inline ? "true" : undefined}
    role="status" data-testid={`assist-inflight-${message.id}`}
    aria-label={message.status === "PENDING" ? "已提交，等待处理，正在生成" : "正在生成"}>
    <i aria-hidden="true" /><i aria-hidden="true" /><i aria-hidden="true" /></span>;
}

function AssistMessageRow({ client, target, message, preview, previewError, onRetryPreview, settling,
  handover, onVerifyFinal, writeBlocked, candidates, personaLabel,
  recallReceipt, recallBusy, recallReading, recallError, recallDisabledReason, onRecall, onReadRecall }: { client: RelayApiClient;
  /** 助手档显示冻结人设（名字 · 修订），普通档为 null，仍显示「AI」。 */
  personaLabel: string | null;
  target: AssistTarget | null; message: RelayAssistMessage; writeBlocked: boolean;
  preview: RelayAssistLivePreview | null;
  previewError: PreviewReadError | null; onRetryPreview: () => void;
  /** 预览已转终态、最终正文尚未核对的过渡读数；null 表示没有这段空档。 */
  settling: ReplySettling | null;
  /** 本次刚由草稿交接为最终正文：只驱动一次轻量淡入，历史消息不带这个标记。 */
  handover: boolean;
  /** 过渡态下显式重读消息行；失败后给用户的恢复入口。 */
  onVerifyFinal: () => void;
  candidates: readonly RelayAssistProposal[];
  /** 0132：逐文件回执（按需读取或刚提交的结果）；摘要本身在 message.recall 上。 */
  recallReceipt: RelayAssistMessageRecall | null;
  recallBusy: boolean; recallReading: boolean; recallError: string | null;
  recallDisabledReason: string | null;
  onRecall: () => void; onReadRecall: () => void;
}) {
  const user = message.role === "USER";
  const [copyDone, setCopyDone] = useState<string | null>(null);
  const withdrawn = message.withdrawnAt !== null;
  const canRecall = user && message.status === "COMPLETED" && !withdrawn && message.recall === null;
  /* 0132 悬停提示：动作说明与禁用原因共用这一处出口（2026-10-24 用户指令：说明句改成 tooltip）。
     提示挂在外层 span 上而不是按钮上——disabled 的 <button> 不派发鼠标事件，挂在按钮身上时
     「为什么现在点不了」恰好会在最需要的时候看不到。 */
  const recallHint = recallDisabledReason ?? "这会将改动回滚到这条消息之前";
  const { tooltipHandlers: recallTooltipHandlers, tooltipNode: recallTooltipNode } =
    usePathTooltip(() => (canRecall ? recallHint : null), "assist-recall-tooltip", { arrow: true });
  /* 取消意图要在行内一直可读：PENDING 已不标状态词，三点又在取消中隐藏，
     不补这一句就变成整行没有任何状态。RUNNING 的呈现逐字沿用原「正在生成（正在取消）」。 */
  const inFlight = isInFlight(message);
  /* 过渡态压过消息行状态：预览已判终态、消息行还没读回，此时继续写「正在生成」就是拿旧读数
     冒充事实（它的三点也已撤掉）。UNVERIFIED 是那次重读失败——状态待核对，不是还在跑。 */
  const settlingText = settling === null ? ""
    : settling.stage === "UNVERIFIED" ? "状态待核对"
      : settling.outcome === "COMPLETED" ? "正在核对最终回复"
        : settling.outcome === "CANCELLED" ? "已取消，正在核对" : "生成失败，正在核对";
  const statusText = withdrawn ? "已撤回"
    : settling !== null ? settlingText
      : message.cancelRequested && inFlight
        ? (message.status === "RUNNING" ? "正在生成（正在取消）" : "正在取消")
        : messageStatusLabels[message.status];
  /**
   * 回复正文与草稿共用的那**一个**阅读区（2026-10-25 综合优化）。
   * 三种取值互斥，避免同一份内容出现两次、也避免切换瞬间整块消失：
   *   final    —— 服务端已给出正文（`content` 只在结算那一句里写入，因此有正文即已核实）；
   *   verifying—— 终态已到、正文还没读回，把最后一次草稿留在原位并标明待核对；
   *   draft    —— 生成中草稿，纯文本，带轻量未完成标记。
   */
  const finalContent = !user && !withdrawn && message.skill === null && message.content !== null
    ? message.content : null;
  const draftText = preview?.previewAvailable === true && preview.previewText !== null ? preview.previewText : null;
  const replyState = finalContent !== null && finalContent !== "" ? "final"
    // 只有确实还留着草稿文字时才摆「核对中」；失败/取消那一格草稿已被清掉，
    // 这里什么都不留，状态由 meta 行说明。
    : settling !== null && settling.text !== "" ? "verifying"
      : draftText !== null ? "draft" : null;
  // 2026-10-04 按用户要求去掉左右两侧头像：角色已由「我 / AI」标签与气泡位置区分，
  // 头像只是重复占位，还把正文列挤窄。
  return <article className="agent-message" data-role={message.role}>
    <div className="agent-message-body">
    <p className="agent-message-meta"><span className="agent-message-role"
      {...(!user && personaLabel !== null ? { "data-testid": "assist-persona-label" } : {})}
      >{user ? "我" : personaLabel ?? "AI"}</span>
      {messageTime(message.createdAt) !== "" && <time dateTime={message.createdAt ?? undefined}>{messageTime(message.createdAt)}</time>}
      <MessageElapsed message={message} />
      {/* 完成态与「已提交、Worker 尚未领取」都不占位：正常完成不需要额外标注，
          在途与失败必须显式说明。 */}
      {statusText !== "" && <span className="agent-message-status">{statusText}</span>}</p>
    {/* 0132：回执只挂在被撤回的那条用户消息上；直接回复行只标「已撤回」，不重复同一份回执。 */}
    {message.recall !== null && user && <AssistRecallNote recall={message.recall}
      receipt={recallReceipt} reading={recallReading} busy={recallBusy}
      error={recallError} onRead={onReadRecall} onResume={onRecall} />}
    {withdrawn && message.recall === null &&
      <p className="assist-withdrawn-note">这条消息已撤回；原文与当时的文件效果不再作为当前事实。</p>}
    {/* 2026-10-21 用户指认「ai 的思考过程看不到」：§18.10 要求原消息下展示实际阶段，
        而每轮工具调用此前只落库、界面只剩三点。轮次账本紧跟 meta 行，
        在途时它是唯一能看出「这一轮在做什么」的活体信号。 */}
    {!user && !withdrawn && <SessionRoundTrace client={client} message={message} />}
    {/* 用户输入保持纯文本；只有 AI 最终正文走安全 Markdown，Skill 输出另由 AssistSkillOutput 渲染，避免同一正文出现两次。 */}
    {/* 0093：图片在上、文字在下——先看见"我发了哪张图"，再读当时写的话（§33.3）。 */}
    {!withdrawn && message.attachments.length > 0 && <MessageAttachments client={client}
      sessionId={message.sessionId} attachments={message.attachments} />}
    {!withdrawn && message.content !== null && message.content !== "" && user &&
      <p className="assist-message-content"><UserMessageContent content={message.content} /></p>}
    {/* 0132：撤回不删除原文，但原文只是历史。默认收起，避免它继续被当作当前结论。 */}
    {withdrawn && message.content !== null && message.content !== "" &&
      <details className="tech-details" data-testid={`assist-withdrawn-original-${message.id}`}>
        <summary>查看已撤回原文（仅历史）</summary>
        {user ? <p className="assist-message-content"><UserMessageContent content={message.content} /></p>
          : <div className="assist-message-content assist-message-markdown">
            <SafeMarkdown source={message.content} codeCopy /></div>}
      </details>}
    {!withdrawn && user && ((message.content !== null && message.content !== "") || canRecall) &&
      <div className="agent-message-footer">
      {/* 0132：回退键与复制键同排，回退在左（2026-10-24 用户指令）。两枚都是纯图标键，
          随页脚收起，悬停或聚焦才出现（页面原型 V5.0 的悬停操作）。
          复制是纯客户端剪贴板动作，与助手回复的复制同一语义；失败只还原按钮，不发成功回执。 */}
      {canRecall && <span className="assist-recall-button-wrap" {...recallTooltipHandlers}>
        <button className="icon-button" type="button"
          data-testid={`assist-recall-action-${message.id}`}
          aria-label={recallBusy ? "正在回退文件" : "回退文件"}
          aria-busy={recallBusy || undefined}
          disabled={recallBusy || recallDisabledReason !== null}
          onClick={onRecall}>
          <RotateCcw aria-hidden="true" />
        </button>
      </span>}
      {message.content !== null && message.content !== "" &&
        <button className="icon-button agent-message-copy" type="button"
          data-testid={`assist-copy-user-${message.id}`}
          aria-label={copyDone === message.id ? "已复制这条消息" : "复制这条消息"}
          title={copyDone === message.id ? "已复制" : "复制这条消息"}
          onClick={() => void navigator.clipboard?.writeText(message.content ?? "").then(
            () => setCopyDone(message.id), () => setCopyDone(null))}>
          <Copy aria-hidden="true" />
        </button>}
      {recallTooltipNode}
    </div>}
    {recallError !== null && <p className="action-error" role="alert"
      data-testid={`assist-recall-error-${message.id}`}>{recallError}</p>}
    {/* 一个阅读区，三种状态互斥（见 replyState）：最终正文 / 最终正文核对中 / 生成中草稿。
        2026-10-25：此前最终正文与草稿是两个并列块，终态一到草稿被整块删掉，正文还没读回，
        中间那一瞬既没有正文也没有草稿——读起来是「跳了一下」。
        草稿不再是一张带底色的独立卡片：它与正文同一档字号与行高，只在上面挂一行未完成标记，
        交接时的行高差因此只剩 Markdown 块距，不产生明显滚动跳跃。 */}
    {replyState !== null && <div className="assist-reply" data-state={replyState}
      data-handover={handover ? "true" : undefined}
      data-testid={replyState === "final" ? `assist-reply-final-${message.id}`
        : replyState === "verifying" ? `assist-reply-verify-${message.id}` : `assist-live-preview-${message.id}`}>
      {replyState === "final"
        ? <div className="assist-message-content assist-message-markdown"><SafeMarkdown source={finalContent ?? ""} codeCopy /></div>
        : <>
          <p className="assist-reply-note">
            {replyState === "verifying"
              ? (settling?.stage === "UNVERIFIED"
                ? "最终正文尚未读回 · 以下仍是草稿，状态待核对"
                : "以下仍是草稿 · 正在核对最终正文")
              : `生成中草稿 · 仅当前预览 v${preview?.previewRevision ?? "0"}，不是完整消息或已接受产物`
                + (preview?.previewTruncated === true ? " · 预览已截断" : "")}
          </p>
          {/* 草稿是纯文本：不提前渲染 Markdown，也就不会把草稿读成已经确认的最终排版。
              在途三点跟着**这一行文字的末尾**走（2026-10-25）：此前它独占正文下方一整块，
              截图里读成「正文下面多了一行省略号」。贴住文字的末尾才是「还在往下写」的意思，
              而且不额外占一块版面、不动阅读位置。 */}
          <p className="assist-message-content assist-reply-draft">{settling?.text ?? draftText}{replyState === "draft" && <InflightDots message={message} inline />}</p>
          {replyState === "verifying" && settling?.stage === "UNVERIFIED" &&
            <button className="text-link" type="button" data-testid={`assist-verify-final-${message.id}`}
              disabled={writeBlocked} onClick={onVerifyFinal}>重读最终回复</button>}
        </>}
    </div>}
    {/* 屏幕阅读器的状态播报（工作台 §18 的一致性要求）：只播**粗粒度状态**，
        不播每次预览修订——那一行字号会随帧变化，逐帧播报等于噪音。
        在途阶段由三点自己的 role=status 播「正在生成」，这里留空，避免两处同时说话；
        交接与核对完成各播一次，用户因此仍能听到「已完成」而不必回看视觉。 */}
    {!user && !withdrawn && <p className="visually-hidden" role="status" aria-live="polite"
      data-testid={`assist-reply-announce-${message.id}`}>
      {replyState === "final" ? "回复已完成"
        : settling !== null ? (settling.stage === "UNVERIFIED"
          ? "回复已结束，最终正文状态待核对" : "回复已结束，正在核对最终正文")
          : ""}
    </p>}
    {/* 终态是真的、正文确实是空的时候，明说一句，不留一块解释不清的空白。 */}
    {!user && !withdrawn && replyState === null && message.status === "COMPLETED" &&
      message.skill === null && <p className="helper-text" data-testid={`assist-empty-reply-${message.id}`}>
        这条回复已结束，没有可显示的正文。</p>}
    {!withdrawn && canPreview(message) && previewError && <div className="assist-preview-error" role="alert"
      data-testid={`assist-preview-error-${message.id}`}>
      <p>生成预览读取失败：{previewError.message}</p>
      <p className="helper-text">后台回复状态仍以消息为准。{previewError.lastSuccessAt
        ? `最近成功读取：${messageTime(previewError.lastSuccessAt)}。` : "尚未成功读取预览。"}</p>
      <button className="text-link" type="button" disabled={writeBlocked} onClick={onRetryPreview}>重新读取预览</button>
    </div>}
    {!withdrawn && message.errorCode && <p className="action-error">生成失败：{message.errorCode}</p>}
    {!withdrawn && message.status === "FAILED" && message.providerErrorKind !== null &&
      <p className="helper-text" data-testid="assist-provider-error">模型服务：{modelErrorGuides[message.providerErrorKind]}</p>}
{!withdrawn && message.skill && message.role === "ASSISTANT" && message.status === "COMPLETED" &&
      (message.skill.outputAvailability !== "HISTORICAL_SNAPSHOT" || message.skillOutput === null) &&
      <p className="helper-text">Skill 输出当前不可读取；不会展示失效的历史正文或来源引用。</p>}
    {/* 来源条紧跟正文：先回答"这次读了什么"，与正文的阅读顺序一致；诊断类 details 留在下方。 */}
    {!withdrawn && message.sources.length > 0 && <details className="assist-source-summary" data-testid={`assist-sources-${message.id}`}>
      <summary><FileText aria-hidden="true" />已读取 {message.sources.length} 份资料
        {message.role === "ASSISTANT" && message.status === "COMPLETED" && " · 生成候选完成"}</summary>
      <ul className="assist-source-list">
      {message.sources.map((source, index) => {
        const available = source.sourceRef !== null && (message.skill
          ? source.status === "AVAILABLE" : source.status !== "UNAVAILABLE");
        const path = source.kind && source.rootId && source.version && available
          ? `/knowledge?kind=${encodeURIComponent(source.kind)}&item=${encodeURIComponent(source.rootId)}` : null;
        return <li key={index} className="assist-source-row" data-available={available}>
          {/* 引用是主文字，状态收进徽牌；状态词翻成中文，未知枚举原样回显不编造。 */}
          <span className="assist-source-ref">{available ? source.sourceRef : "来源不可用"}</span>
          <span className="assist-source-state" data-state={available ? "available" : "unavailable"}
            title={source.status}>{sourceStatusLabel(source.status)}</span>
          {path && <Link className="inline-link" to={path}>打开来源条目</Link>}
          {source.reason && <span className="assist-source-reason">{source.reason}</span>}
        </li>;
      })}
    </ul></details>}
    {/* 文档候选卡紧跟来源条：先说明读了什么，再说明产出了什么。接受仍在提案区，不在此处发生。 */}
    {!withdrawn && candidates.map((proposal) => <AssistCandidateCard key={proposal.id} proposal={proposal} />)}
    {!withdrawn && message.skillOutput && message.skill?.outputAvailability === "HISTORICAL_SNAPSHOT" &&
      message.role === "ASSISTANT" && message.status === "COMPLETED" &&
      target !== null && <AssistSkillOutput client={client} output={message.skillOutput} currentTarget={target} />}
    {!withdrawn && message.skill && <details className="tech-details"><summary>Skill 来源与定义</summary><p className="helper-text">
      {message.skill.id} v{message.skill.version}
      {message.skill.sha256 && <> · 定义摘要 {message.skill.sha256}</>}
      {message.skill.definitionAvailability === "HISTORICAL_ONLY" &&
        <> · 冻结历史定义仅可查阅；当前注册表不再提供此版本，不能新调用或接受，不会以新版替换历史来源</>}
      {message.skill.definitionAvailability === "UNAVAILABLE" && <> · 历史定义不可用</>}
      {message.skill.missingCapabilities.length > 0 && <> · 缺少能力 {message.skill.missingCapabilities.join("、")}</>}
    </p></details>}
    {/* 在途反馈由正文前的三点、meta 行的耗时与状态标签共同承担，PENDING 只有前两项；
        停止入口在输入栏主按钮上。PENDING 同样算在途：它是「已提交、Worker 尚未领取」。
        三点是「这条还在跑」的持续信号，不再只承担首字前的占位：预览文本到达后
        继续显示，否则流式输出期间那个唯一的活体信号会整段消失，只剩一行静态
        草稿文字，看着像卡住了。取消中不显示——meta 行已经写明「正在取消」。
        「202 回执不等于完成」由 messageStatusLabels 的 COMPLETED:"" 状态机实现，不是聊天文案。 */}
    {/* 在途反馈由正文前的三点、meta 行的耗时与状态标签共同承担，PENDING 只有前两项；
        停止入口在输入栏主按钮上。PENDING 同样算在途：它是「已提交、Worker 尚未领取」。
        三点是「这条还在跑」的持续信号，不再只承担首字前的占位：预览文本到达后
        继续显示，否则流式输出期间那个唯一的活体信号会整段消失，只剩一行静态
        草稿文字，看着像卡住了。取消中不显示——meta 行已经写明「正在取消」。
        「202 回执不等于完成」由 messageStatusLabels 的 COMPLETED:"" 状态机实现，不是聊天文案。
        过渡态（settling）也不显示：预览已判终态，再画进度点就是假装还在生成，
        那一格由 meta 行的「正在核对最终回复 / 状态待核对」说明。 */}
    {message.role === "ASSISTANT" && isInFlight(message) && settling === null &&
      !message.cancelRequested && replyState === null &&
      <p className="assist-inflight-dots" role="status" data-testid={`assist-inflight-${message.id}`}
        aria-label={message.status === "PENDING" ? "已提交，等待处理，正在生成" : "正在生成"}>
        <i aria-hidden="true" /><i aria-hidden="true" /><i aria-hidden="true" /></p>}
    {/* 2026-10-20 用户指认：消息级的记忆 UI（「保存为长期记忆」「记忆来源」）与
        输入卡上方的「会话记忆」条都是聊天里的噪音，已全部移除（工作台 §40）。
        记忆本身仍由服务端自动捕获与召回；查看与撤销在资料页与设置页。 */}
    {!withdrawn && message.role === "ASSISTANT" && message.status === "COMPLETED" && <div className="agent-message-footer">
      {/* 复制键在左、用量在右（2026-10-16 用户指令）：键是行首第一项，左缘因此与原用量起点
          对齐；用量仍是不折叠的单行事实，与复制键同排，少占竖直空白。 */}
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
      {/* 用量口径：input_tokens 是该次调用重发的完整上下文（含全部历史），故叫「上下文」
          不叫「输入」——2026-10-24 用户把「输入 4757」读成了会话累计的错账。 */}
      <p className="helper-text agent-message-usage" data-testid={`assist-usage-${message.id}`}>用量：上下文 {message.usage.inputTokens ?? "未知"}、输出 {message.usage.outputTokens ?? "未知"} tokens</p>
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
  refreshTarget, clearSentSources, standalone, onNavigationStateChange,
  sourcePicker, preferredSkillId, embedded, externalReadBlockedReason, proposalActionHost,
  onExecutionPrepared, initialExecution, confirmedFirstMessageCommandId,
  initialMaintenance, modeSwitch, modeHints, onInflightChange, composerHeader, onLearningTransfer, recordLearning = true,
  firstMessageInflight = false, onToggleSourceRef,
  onChatSessionCreated }: { client: RelayApiClient;
  session: RelayAssistSession; target: AssistTarget | null; sources: readonly RelayAssistSourceRef[];
  writeBlockedReason: string | null;
  refreshTarget: () => Promise<void>;
  onChatSessionCreated: (session: RelayAssistSession) => void;
  clearSentSources: (sent: readonly RelayAssistSourceRef[]) => void;
  standalone: boolean; onNavigationStateChange: (state: AssistNavigationState) => void;
  sourcePicker: ReactNode; preferredSkillId?: string; embedded?: boolean;
  externalReadBlockedReason: string | null; proposalActionHost?: HTMLElement | null;
  onExecutionPrepared?: ((taskId: string) => void) | undefined;
  /** 首条消息的解释结果：交给本面板既有 Owner 渲染与执行，避免出现第二套确认门。 */
  initialExecution?: RelayConversationExecution | null;
  confirmedFirstMessageCommandId?: string | null;
  /** 首条消息的状态维护解释结果：同样由本面板按 requestId 接手渲染。 */
  initialMaintenance?: RelayStateMaintenanceRequest | null;
  /** 会话模式控件由外层持有（它才有会话与导航事实），面板只负责放在工具行左侧。 */
  modeSwitch?: ReactNode;
  /** 档位说明区（在途锁定原因、学习档说明、助手档只读说明）同由外层持有，面板只负责放在**卡片下方**。 */
  modeHints?: ReactNode;
  /** 「+」二级菜单里引用行的开关：只改本次消息的候选输入，不发送、不授予权限。 */
  onToggleSourceRef?: (ref: RelayAssistSourceRef) => void;
  onLearningTransfer?: (instruction: string, background: string, sourceRefs: readonly RelayAssistSourceRef[]) => void;
  recordLearning?: boolean;
  /** 首条消息在建/在途/待核对：此间空会话不渲染欢迎空态，也不摆「还没有消息。」——
      在途事实由输入卡上方的发送状态行独自承担，空态行会把在途读成空会话
      （2026-10-23 用户截图指认「先显示空页之后才是对话」）。 */
  firstMessageInflight?: boolean;
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
  /** 本设备的计划执行方式：候选就绪后是自动沿原入口应用，还是保留一次「按这份计划执行」。 */
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
  const [projectionReload, setProjectionReload] = useState(0);
  const [previews, setPreviews] = useState<Readonly<Record<string, RelayAssistLivePreview>>>({});
  /**
   * 终态预览帧已到、最终正文还没核对的回复（按消息 id）。草稿因此在交接空档里继续可读，
   * 而不是先被删掉再等正文长出来；服务端一旦给出终态消息行就清掉这一项。
   */
  const [settling, setSettling] = useState<Readonly<Record<string, ReplySettling>>>({});
  /** 本次挂载里刚完成「草稿 → 最终正文」的消息：只驱动一次轻量淡入，刷新后的历史不带它。 */
  const [handovers, setHandovers] = useState<Readonly<Record<string, true>>>({});
  const [previewErrors, setPreviewErrors] = useState<Readonly<Record<string, PreviewReadError>>>({});
  const [previewRetry, setPreviewRetry] = useState(0);
  /* 0132：撤回逐文件回执。按用户消息 id 与其直接回复 id 各存一份同值，
     这样无论从哪一行打开都能读到同一份已核对结果；摘要仍在 message.recall 上。 */
  const [recallReceipts, setRecallReceipts] =
    useState<Readonly<Record<string, RelayAssistMessageRecall>>>({});
  const [recallBusyId, setRecallBusyId] = useState<string | null>(null);
  const [recallReadingId, setRecallReadingId] = useState<string | null>(null);
  const [recallErrors, setRecallErrors] = useState<Readonly<Record<string, string>>>({});
  const [proposals, setProposals] = useState<readonly RelayAssistProposal[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /**
   * 会话消息的首屏加载提示延迟出现：换工作区或换会话时本面板按 key 重挂载，
   * 消息通常在几十毫秒内到达；立即显示「正在读取会话消息…」再换成列表，读起来是闪一下。
   * 真的读得慢时提示照常出现，不把等待藏掉（见 lib/useDelayedVisible）。
   */
  const showMessagesLoading = useDelayedVisible(messages === null && error === null);
  /**
   * 未发送草稿按会话留在本机（2026-10-19 用户指令）：切换工作区不再弹「未发送的内容」，
   * 回到这条会话时原样恢复。只存文本——已选资料、技能与判断说明仍是本次请求的候选输入，
   * 不能被本机草稿说成已确认。
   */
  const draftScope = `session:${session.id}`;
  const [draft, setDraft] = useState(() => readComposerDraft(client.workspaceId, `session:${session.id}`));
  /** 本机最近引用过的资料版本（展示偏好）：「+」二级菜单的「最近引用」直接读它。 */
  const [recentRefs, setRecentRefs] = useState<readonly RelayAssistSourceRef[]>(() => readRecentSourceRefs());
  /** 会话输入器的中文组词状态：草稿辅助据此保证组词期间零请求（工作台 §30.2）。 */
  const [composing, setComposing] = useState(false);
  const [intent, setIntent] = useState<AssistIntent>("DISCUSS");
  const [skills, setSkills] = useState<readonly RelaySkillDefinition[]>([]);
  const [skillError, setSkillError] = useState<string | null>(null);
  const [selectedSkillKey, setSelectedSkillKey] = useState("");
  const [skillInputText, setSkillInputText] = useState("");
  const [pending, setPending] = useState<PendingAction | null>(null);
  /**
   * `pending` 有两段意思：命令已发出但还没回执（在途），以及回执不明、结果待核对。
   * 只有后者才该把「命令结果待核对」那一块摆出来——前者在正常发送的几百毫秒里出现再消失，
   * 会把输入区的列撑高又收回，读起来就是界面闪一下（2026-10-19 用户反馈「发送消息界面会闪一下」）。
   * 因此单独记一个「已确认结果不明」的标记，只在传输失败保留 pending 时置真。
   */
  const [pendingUnresolved, setPendingUnresolved] = useState(false);
  /** 未决命令的核对弹窗由用户从正文状态行点开；重试期间保持打开，失败原因更新在同一层。 */
  const [pendingDialogOpen, setPendingDialogOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  /**
   * 会话输入器的图片附件暂存（工作台 §33）。切换会话时整份重挂载，因此这里不需要
   * 「换会话就清空」的额外逻辑；上传在点发送后、命令产生前完成，`attachment_ids`
   * 一旦固定就不再变化（重试沿同一组 id 重放）。
   */
  const stagedSession = useStagedAttachments();
  const [uploadingAttachments, setUploadingAttachments] = useState(false);
  /* 0127：计划与目标投影。只保存服务端读回的事实，不在本地推断「能不能暂停」——
     actions 由服务端给；切换会话按 key 重挂载后重读，不跨会话残留。 */
  const [planView, setPlanView] = useState<RelayPlanView | null>(null);
  const [goalView, setGoalView] = useState<RelayGoalView | null>(null);
  const [goalPlanBusy, setGoalPlanBusy] = useState(false);
  const [goalPlanError, setGoalPlanError] = useState<string | null>(null);
  /**
   * 计划/目标投影的读取失败（#122）：失败不是「无目标」。清空投影时目标卡连同
   * 暂停/取消一起消失，但必须同时给出读取错误与页内重试，且页内刷新也要覆盖这块投影，
   * 否则短暂 503 后用户既看不到目标状态也失去控制入口，只能离开会话再进来。
   */
  const [projectionReadError, setProjectionReadError] = useState<string | null>(null);
  const composerFormId = useId();
  const requestVersion = useRef(0);
  const disposed = useRef(false);
  /* 末条消息的上一次权威读数：只在它换 id 或转终态时递活动计数（lib/sessionActivity）。
     切会话与首条消息确认时随重读基线一起清零，不跨会话残留。 */
  const activityLast = useRef<RelayAssistMessage | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  /* 目标状态字符串进依赖：状态不变不重读，状态变化（含 PAUSING→PAUSED）才重读。 */
  const goalStatus = goalView?.goal?.status ?? null;
  /* 0127：计划与目标投影随会话与推进重读。目标仍在推进时每 15 秒轮询一次：
     推进器在服务端 tick 里工作，界面不参与推进，只把它的结果读出来。
     首条消息确认（202 回执落定）也要重读一次：/goal 开会话时目标行由那条消息的
     命令建立，本次挂载时它还不存在（2026-10-24 实机验收抓到：目标卡直到下一次
     手动操作才出现）。 */
  useEffect(() => {
    if (client === null) return;
    let alive = true;
    const load = async () => {
      try {
        const [plans, goal] = await Promise.all([
          client.getSessionPlans(session.id), client.getSessionGoal(session.id)]);
        if (!alive || disposed.current) return;
        setPlanView(plans); setGoalView(goal);
        // 读取成功即结清旧失败：错误只描述最近一次读取，成功后不得继续冒充当前不可读。
        setProjectionReadError(null);
      } catch (caught) {
        if (!alive || disposed.current) return;
        // 读取失败不冒充「无目标」（#122）：投影照旧清空（目标卡撤下，避免旧状态冒充当前
        // 事实），但语义落在这条错误上——「确实无目标」只在读取成功且为空时成立。
        // 403/404 按失权/不存在说明，与暂时性失败区分；alive/disposed 守卫保证
        // 切换会话或连接后的迟到响应不会把错误串到新会话。
        const denied = caught instanceof RelayApiError && [403, 404].includes(caught.problem.status);
        setPlanView(null); setGoalView(null);
        setProjectionReadError(denied ? "目标与计划状态当前不可见或无权读取；如果刚换过会话，请重新进入后再读。"
          : `目标与计划状态读取失败：${describeLiveError(caught).message}`);
      }
    };
    void load();
    const live = goalStatus !== null && (goalStatus === "ACTIVE" || goalStatus === "PAUSING"
      || goalStatus === "CANCELLING");
    const timer = live ? window.setInterval(() => void load(), 15000) : null;
    return () => { alive = false; if (timer !== null) window.clearInterval(timer); };
  }, [client, session.id, projectionReload, goalStatus, confirmedFirstMessageCommandId]);
  const transcriptContentRef = useRef<HTMLDivElement>(null);
  /** 时间线导航只认这一个正文滚动容器：它读位置、它执行跳转，不新增第二个消息流滚动区。 */
  const getTranscriptOwner = useCallback(() => transcriptRef.current, []);
  const followLatest = useRef(true);
  const [atLatest, setAtLatest] = useState(true);
  /* 正文是否已滚过转录区上下缘：只在「真的有内容被边缘切走」时挂渐隐遮罩
     （上缘那条带在协作页顶栏下方，下缘那条在目录细条上方）。
     与 atLatest 一样按同值短路，滚动本身不重复渲染。 */
  const [awayFromTop, setAwayFromTop] = useState(false);
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  /** 上下缘渐隐的唯一判定：滚动、内容换掉与自动跟到底都走这里，不留第二套推断。
     只看尺寸不碰阅读意图（followLatest 仍只由真实滚动决定）。 */
  function syncEdgeFades(element: HTMLDivElement) {
    if (element.clientHeight === 0) return;
    const remaining = element.scrollHeight - element.scrollTop - element.clientHeight;
    // 阈值取 1px 而不是 0：高 DPI 下 scrollTop 是小数，停在底部时 remaining 可能是 0.4，
    // 那样会把渐变永久压在最后一条消息上——读起来像渲染坏了。
    setAwayFromTop(element.scrollTop > 0);
    setAwayFromBottom(remaining > 1);
  }
  const previewSuccessAt = useRef<Record<string, string>>({});
  /* 每帧草稿的镜像：终态帧到达时要把「最后一次草稿」原样交接过去。读 state 会慢一帧，
     而空档里正需要这一帧之前的文字；因此写到 ref 上，不参与渲染。 */
  const latestPreview = useRef<Record<string, RelayAssistLivePreview>>({});
  /* 这段空档出现在哪些消息上：交接完成后据此判断「这次终态是草稿换来的」，
     从而只给真正发生过的交接加一次性淡入，刷新历史不会集体闪一下。 */
  const draftedIds = useRef<Set<string>>(new Set());
  /* 换会话时清掉上一条会话的过渡读数与交接标记：消息列表整批换掉，旧 id 不再有意义。 */
  const replySession = useRef(session.id);
  /** 当前是否正显示一份已读成功的消息列表；决定一次读取失败该清屏还是只标待核对。 */
  const hasTranscript = useRef(false);
  useEffect(() => {
    if (replySession.current === session.id) return;
    replySession.current = session.id;
    latestPreview.current = {}; draftedIds.current = new Set();
    hasTranscript.current = false;
    setSettling({}); setHandovers({});
  }, [session.id]);
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
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  /** 会话档写档位：由底栏 [权限] 芯片同源上报，上方状态行只读显示（助手档不显示写权限段）。 */
  const [sessionWriteTier, setSessionWriteTier] = useState<Tier | null>(null);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setSelectedModel(null);
    void client.getSessionModelSelection(session.id).then((selection) => {
      if (active) setSelectedModel(selection?.model ?? null);
    }).catch(() => { /* 打开选择器时仍重新读取目录；不据此变更服务端选择。 */ });
    return () => { active = false; };
  }, [client, session.id]);
  useEffect(() => {
    let active = true;
    // 圆环分母只用于表达"这次调用占了多少预算"。读不到就留空，不拿别的数字顶替。
    void client.getModelPortStatus().then((status) => {
      if (active) setCallLimit(status.maxCallTokens);
    }).catch(() => { if (active) setCallLimit(null); });
    return () => { active = false; };
  }, [client]);
  /**
   * 每次文本变化都写回本机：离开这条会话不丢内容，回到它时按同一作用域恢复。
   * 发送成功、执行清空与「丢弃草稿」都会把 draft 置空，这里随之删除，不留空记录。
   */
  useEffect(() => { writeComposerDraft(client.workspaceId, draftScope, draft); },
    [client.workspaceId, draftScope, draft]);
  const discardDraft = useCallback(() => {
    if (pending || busy) return;
    setDraft(""); setSkillInputText(""); setSelectedSkillKey(""); setIntent("DISCUSS");
    // 未发送的图片同样属于这次输入：丢弃草稿时一并回收，不能只清文字留下一组孤儿芯片。
    stagedSession.clear();
  }, [pending, busy, stagedSession]);
  /** 会话输入器的存活恢复目标：textarea 优先，输入器容器兜底（见 restoreComposerFocus）。 */
  const draftRef = useRef<HTMLTextAreaElement | null>(null);
  const composerBoxRef = useRef<HTMLDivElement | null>(null);
  const restoreDraftFocus = useCallback(() => {
    restoreComposerFocus(draftRef.current, composerBoxRef.current);
  }, []);
  /**
   * 提交成功后把焦点接回正文：textarea 在提交窗口里 disabled，焦点掉到 body，
   * 回执一到输入卡就停在未聚焦的灰边档（DEV-0110：发送前绿边、发送后灰边的变色）。
   * 只收回仍落在 body 或输入卡内的焦点；用户已经点到别处时不抢。
   */
  const restoreFocusAfterSend = useRef(false);
  useEffect(() => {
    if (busy || pending !== null || !restoreFocusAfterSend.current) return;
    restoreFocusAfterSend.current = false;
    const active = document.activeElement;
    if (active === null || active === document.body || composerBoxRef.current?.contains(active))
      restoreDraftFocus();
  }, [busy, pending, restoreDraftFocus]);

  useLayoutEffect(() => {
    const transcript = transcriptRef.current;
    if (standalone && transcript && transcript.clientHeight > 0 && followLatest.current)
      transcript.scrollTop = transcript.scrollHeight;
    // 换会话、消息整批替换都可能让溢出消失而滚动值原地不动（不触发 scroll）：
    // 渐隐必须跟着重算，否则上一条长会话留下的遮罩会永久压在短会话的第一条消息上。
    if (transcript) syncEdgeFades(transcript);
  }, [standalone, messages, previews, proposals]);
  useLayoutEffect(() => {
    const transcript = transcriptRef.current;
    const content = transcriptContentRef.current;
    if (!standalone || !transcript || !content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      // 隐藏布局不能重置阅读意图；再次显示时由尺寸通知继续原来的跟随状态。
      if (followLatest.current && transcript.clientHeight > 0) transcript.scrollTop = transcript.scrollHeight;
      // 视口自己变矮（队列面板出现、窗口变高）不产生 scroll 事件，但底缘切掉的确实变多了。
      syncEdgeFades(transcript);
    });
    observer.observe(transcript); observer.observe(content);
    return () => observer.disconnect();
  }, [standalone, externalReadBlockedReason]);
  useEffect(() => {
    if (!standalone && !embedded) return;
    // `dirty` 与 `unsaved` 分开（2026-10-24 P0-2）：正文草稿已按会话留在本机、可恢复，
    // 不进 `unsaved`；暂存/上传中的附件、技能输入与意图没有持久化，离页即丢，必须保护。
    onNavigationStateChange({ dirty: learningNavigation.dirty || stagedSession.items.length > 0 ||
        Boolean(draft.trim() || skillInputText.trim() || (standalone && (selectedSkillKey || intent !== "DISCUSS"))),
      unsaved: learningNavigation.unsaved || uploadingAttachments || stagedSession.items.length > 0 ||
        Boolean(skillInputText.trim() || (standalone && (selectedSkillKey || intent !== "DISCUSS"))),
      discard: () => { discardDraft(); learningNavigation.discard?.(); },
      pending: pending ? { commandId: pending.commandId,
        commandType: pending.kind === "send" ? "RequestAssistMessage" : pending.kind === "cancel"
          ? "CancelAssistMessage" : pending.kind === "restart" ? "ExecuteChatCommand"
          : pending.kind === "model" ? "SelectSessionModel"
          : "AcceptAssistProposal", sessionId: session.id } : learningNavigation.pending,
      restoreFocus: restoreDraftFocus });
  }, [standalone, embedded, draft, skillInputText, selectedSkillKey, intent, pending, session.id,
    stagedSession.items.length, uploadingAttachments, onNavigationStateChange, discardDraft,
    restoreDraftFocus, learningNavigation]);

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
      hasTranscript.current = true;
      // 成功读到权威状态后，等待标记只在该回复行真的出现时撤销：
      // 出现之前保持等待，避免提交瞬间出现空档。传输失败不撤销——
      // 那正是「结果待核对」，不是「已结束」。
      setAwaitingAssistantId((waiting) => waiting !== null &&
        nextMessages.some((item) => item.id === waiting) ? null : waiting);
      // 消息落地即排序收敛（2026-10-23 用户选定「立即发生」）：左栏按最后消息时间
      // 排序，服务端在 insertMessage／settleGeneration 推进 last_message_at。这里观察
      // 权威投影的末条消息，落地就递一个活动计数，左栏据此定向重读这一行——不轮询、
      // 不在本地猜时刻；首读基线跟在途心跳都不递（判定见 lib/sessionActivity）。
      const lastMessage = nextMessages.length > 0 ? nextMessages[nextMessages.length - 1] : null;
      if (assistActivityLanded(activityLast.current, lastMessage)) bumpActiveConversationActivity(session.id);
      activityLast.current = lastMessage;
    } catch (caught) { if (!disposed.current && version === requestVersion.current) {
      const described = describeLiveError(caught);
      // 失权与「读不到」不是一件事（2026-10-25）：403/404 表示这些内容不该再展示，
      // 立即清空消息、提案与过渡草稿；网络不明或 5xx 时保留上一次成功读取的列表，
      // 只把状态标成待核对——把整段会话清成空屏是拿一次超时冒充「没有消息」。
      const denied = caught instanceof RelayApiError &&
        (caught.problem.status === 403 || caught.problem.status === 404);
      if (denied || !hasTranscript.current) {
        setMessages(null); setProposals([]); setPreviews({}); setPreviewErrors({});
        latestPreview.current = {}; draftedIds.current.clear();
        setSettling({}); setHandovers({});
        hasTranscript.current = false;
      } else {
        // 这份过渡草稿仍留在原位，但状态改成「待核对」并给出重读入口（行内按钮）。
        setSettling((current) => {
          const next: Record<string, ReplySettling> = {};
          for (const [id, entry] of Object.entries(current))
            next[id] = entry.stage === "SETTLING" ? { ...entry, stage: "UNVERIFIED" } : entry;
          return next;
        });
      }
      setError(described.message);
    } }
  }
  useEffect(() => {
    disposed.current = false; activityLast.current = null; void refresh();
    return () => { disposed.current = true; requestVersion.current++; };
  }, [client, session.id, confirmedFirstMessageCommandId]);
  async function loadSkills() {
    /* 清单全量（2026-10-18）：`target` 只决定这次调用需要什么上下文，不是可见性。
       会话归属在建会话时冻结，所以本面板不解上下文，只在选项上标注并向 AT 说明原因。 */
    if (readonlyMode) { setSkills([]); setSkillError(null); return; }
    try {
      const items = await client.getFirstPartySkills();
      if (disposed.current || client !== liveClient()) return;
      const supported = [...items.filter((item) => supportedSkillOutput[item.id] === item.outputKind)]
        .sort((a, b) => a.target === b.target
          ? a.id === b.id ? b.version.localeCompare(a.version, undefined, { numeric: true })
            : a.id.localeCompare(b.id)
          : a.target.localeCompare(b.target));
      setSkills(supported); setSkillError(null);
      if (!skillPreferenceApplied.current && preferredSkillId) {
        // 深链预选也要过上下文：工作对象对不上的 Skill 不能被悄悄选中，否则发送时才被服务端拒绝。
        const preferred = supported.find((item) => item.id === preferredSkillId && item.callSupported &&
          (item.target === "TASK" ? session.taskId !== null : session.projectId !== null));
        if (preferred) setSelectedSkillKey(`${preferred.id}@${preferred.version}`);
        skillPreferenceApplied.current = true;
      }
    } catch (caught) {
      if (!disposed.current) { setSkills([]); setSkillError(describeLiveError(caught).message); }
    }
  }
  useEffect(() => { void loadSkills(); }, [client, session.taskId, session.projectId, readonlyMode]);
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
    // 失权（写栅栏）时连同过渡草稿一起撤掉：不能为了保留一段淡入继续展示已失效的内容。
    if (writeBlockedReason !== null) {
      latestPreview.current = {}; draftedIds.current.clear();
      setSettling({}); setHandovers({});
    }
    if (ids.size === 0 || writeBlockedReason !== null) return;
    let active = true;
    const abort = new AbortController();
    const timers = new Map<string, number>();
    const done = new Set<string>();

    function apply(messageId: string, next: RelayAssistLivePreview): void {
      if (!active || disposed.current || client !== liveClient()) return;
      setPreviewErrors((current) => { const copy = { ...current }; delete copy[messageId]; return copy; });
      if (next.status !== "PENDING" && next.status !== "RUNNING") {
        /* 终态帧（2026-10-25）：这一帧说明「生成已经结束」，正文还差一次 GET messages。
           它不再直接把草稿删掉——删掉会露出一段空白再长出新正文。改为把最后一次草稿
           交接给 settling：同一个阅读区、同一档字号，标记换成「正在核对最终正文」，
           等权威消息行带着正文回来（见下面按 messages 对账的 effect）才真正换掉。
           失败与取消不交接：那两种终态要求立即清内容，多留一帧草稿就是把失效内容当结论。 */
        done.add(messageId);
        const held = latestPreview.current[messageId];
        delete latestPreview.current[messageId];
        setPreviews((current) => { const copy = { ...current }; delete copy[messageId]; return copy; });
        if (next.status === "COMPLETED" && held !== undefined && held.previewText !== null) {
          draftedIds.current.add(messageId);
          setSettling((current) => ({ ...current, [messageId]: { text: held.previewText ?? "",
            revision: held.previewRevision, truncated: held.previewTruncated,
            outcome: "COMPLETED", stage: "SETTLING" } }));
        } else {
          draftedIds.current.delete(messageId);
          // 失败与取消没有草稿要交接，但仍记下「这次生成已经结束」：消息列表可能还停在
          // RUNNING（结算与读取之间），那一格绝不能继续画进度点说自己还在生成。
          setSettling((current) => ({ ...current, [messageId]: { text: "", revision: "0",
            truncated: false, outcome: next.status === "CANCELLED" ? "CANCELLED" : "FAILED",
            stage: "SETTLING" } }));
        }
        void refresh();
      } else if (!next.previewAvailable || next.previewText === null) {
        delete latestPreview.current[messageId];
        setPreviews((current) => { const copy = { ...current }; delete copy[messageId]; return copy; });
      } else {
        previewSuccessAt.current[messageId] = new Date().toISOString();
        latestPreview.current[messageId] = next;
        setPreviews((current) => ({ ...current, [messageId]: next }));
      }
    }

    function handleError(messageId: string, caught: unknown): void {
      if (!active || disposed.current) return;
      setPreviews((current) => { const copy = { ...current }; delete copy[messageId]; return copy; });
      delete latestPreview.current[messageId];
      // 读取失败就不是「还在生成」：过渡草稿一并撤掉，交给消息列表的权威状态说明。
      draftedIds.current.delete(messageId);
      setSettling((current) => {
        if (!(messageId in current)) return current;
        const copy = { ...current }; delete copy[messageId]; return copy;
      });
      setPreviewErrors((current) => ({ ...current, [messageId]: {
        message: describeLiveError(caught).message, lastSuccessAt: previewSuccessAt.current[messageId] ?? null
      } }));
      if (caught instanceof RelayApiError && (caught.problem.status === 404 || caught.problem.status === 403)) {
        void refresh();
      }
    }

    async function pollOne(messageId: string): Promise<void> {
      let read = false;
      try {
        apply(messageId, await client.getAssistLivePreview(session.id, messageId));
        read = true;
      } catch (caught) {
        if (active) handleError(messageId, caught);
      }
      // 与旧轮询一致：读取失败即停这条消息的轮询，等用户显式重读（previewRetry）再启。
      if (read && active && !done.has(messageId)) {
        timers.set(messageId, window.setTimeout(() => { void pollOne(messageId); }, 400));
      }
    }

    async function streamOne(messageId: string): Promise<void> {
      let connectedOnce = false;
      let retryMs = 1_000;
      while (active && !abort.signal.aborted && !done.has(messageId)) {
        try {
          await client.readAssistLivePreviewStream(session.id, messageId, abort.signal,
            (next) => { connectedOnce = true; retryMs = 1_000; apply(messageId, next); }, () => {});
        } catch (caught) {
          if (!active || abort.signal.aborted || done.has(messageId)) return;
          if (caught instanceof RelayApiError && [401, 403, 404].includes(caught.problem.status)) {
            handleError(messageId, caught); return;
          }
          // 初次连接即失败（网络/反代）直接切到权威 GET 轮询；连上过一次后再掉线则重连。
          if (!connectedOnce) { void pollOne(messageId); return; }
          connectedOnce = false;
        }
        if (!active || abort.signal.aborted || done.has(messageId)) return;
        await pollOne(messageId); // 流关闭后确认权威态；终态会标记 done 并停止重连
        if (!active || abort.signal.aborted || done.has(messageId)) return;
        await waitForEventRetry(retryMs, abort.signal);
        retryMs = Math.min(retryMs * 2, 15_000);
      }
    }

    for (const messageId of ids) void streamOne(messageId);
    return () => {
      active = false;
      abort.abort();
      for (const timer of timers.values()) window.clearTimeout(timer);
    };
  }, [previewIds, previewRetry, client, session.id, writeBlockedReason]);

  /**
   * 草稿 → 最终正文的交接对账（2026-10-25）。
   *
   * 唯一依据是 `GET messages` 读回的那一行：它带终态**且**带正文，交接才算成立；
   * 只在预览帧里看到终态时草稿继续可读（settling），不给「已确认」的样子。
   * 这里用 layout effect：交接那一帧要在绘制前就带上 `data-handover`，否则会先以不透明画一帧、
   * 再补一次淡入，反而多闪一下。
   */
  useLayoutEffect(() => {
    if (messages === null) return;
    const byId = new Map(messages.map((item) => [item.id, item]));
    const arrived: string[] = [];
    for (const id of draftedIds.current) {
      const message = byId.get(id);
      if (message === undefined || isInFlight(message)) continue;
      draftedIds.current.delete(id);
      // 只有真的读到正文才算交接成功；取消/失败/空正文都不交接（见下面 settling 的清理）。
      if (message.status === "COMPLETED" && message.content !== null && message.content !== "")
        arrived.push(id);
    }
    if (arrived.length > 0) setHandovers((current) => {
      let changed = false;
      const next = { ...current };
      for (const id of arrived) if (next[id] !== true) { next[id] = true; changed = true; }
      return changed ? next : current;
    });
    setSettling((current) => {
      let changed = false;
      const next: Record<string, ReplySettling> = {};
      for (const [id, entry] of Object.entries(current)) {
        const message = byId.get(id);
        // 仍是同一条在途消息就继续留着（那说明这次重读没读到终态，状态待核对）；
        // 一旦读回终态、被撤回或这条消息已不在列表里，过渡草稿就不再代表任何事实。
        if (message !== undefined && isInFlight(message) && message.withdrawnAt === null) { next[id] = entry; continue; }
        changed = true;
      }
      return changed ? next : current;
    });
  }, [messages]);

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
      setPending(null); setPendingUnresolved(false); setDraft("");
      onNavigationStateChange(cleanNavigationState);
      onChatSessionCreated(created);
    } catch { throw new RelayTransportError("新会话已返回回执，但详情尚未核对。请查询原命令回执后接续。"); }
  }
  async function runAction(action: PendingAction, retry = false) {
    if (busy || (!retry && (pending !== null || writeBlockedReason !== null)) ||
      (retry && pending !== action)) return;
    // 新一轮动作不继承上一轮的未决弹窗；按原命令重试时保持打开，按钮显示在途。
    setBusy(true); setPending(action);
    if (retry) setPendingUnresolved(true);
    else { setPendingUnresolved(false); setPendingDialogOpen(false); }
    setActionError(null); setNotice(null);
    try {
      if (action.kind === "model") {
        const selection = await client.selectSessionModel({ sessionId: session.id, commandId: action.commandId, model: action.model });
        if (disposed.current) return;
        setSelectedModel(selection.model); setDraft((current) => chatControlFromText(current) === "model" ? "" : current);
        setNotice(`后续新消息首选 ${selection.model}；活动 Run 保留原策略。`);
      } else if (action.kind === "restart") {
        const result = await client.restartAssistSession({ sessionId: session.id, commandId: action.commandId,
          text: action.content, system: action.system });
        await finishChatSession(result);
        return;
      } else if (action.kind === "compact") {
        const accepted = await client.compactAssistSession({ sessionId: session.id,
          commandId: action.commandId, text: action.content });
        if (disposed.current) return;
        setDraft("");
        // 202 只表示受理：完成与否以服务端读回的整理记录为准，不在文案里宣称已整理。
        setNotice(`已受理整理请求（${accepted.status}）。完成状态以服务端整理记录为准。`);
      } else if (action.kind === "send") {
        followLatest.current = true; setAtLatest(true);
        const common = { sessionId: session.id, commandId: action.commandId,
          content: action.content, sourceRefs: action.sources,
          ...(action.attachmentIds === undefined ? {} : { attachmentIds: action.attachmentIds }),
          ...(action.recordLearning === undefined ? {} : { recordLearning: action.recordLearning }),
          // 0127：模式随消息提交；回执里的 chat_mode 是服务端实际受理的那一档。
          ...(action.chatMode === undefined ? {} : { chatMode: action.chatMode }) };
        // 只有普通 DISCUSS 消息会被解释成执行候选；Skill 与提案意图保持原语义。
        // 三条分支是排他的：助手档既没有 intent 也没有 skill_ref，载荷里两个都不出现。
        const sent = action.skillRef && action.skillInput
          ? await client.requestAssistMessage({ ...common, skillRef: action.skillRef, skillInput: action.skillInput })
          : action.intent
            ? await client.requestAssistMessage({ ...common, intent: action.intent })
            : readonlyMode
              ? await client.requestAssistMessage(common)
              : await client.requestAssistMessage({ ...common, intent: action.intent ?? "DISCUSS" });
        if (disposed.current) return;
        // 202 已受理：回执落地后把焦点接回正文（见 restoreFocusAfterSend 的注释）。
        restoreFocusAfterSend.current = true;
        setDraft(""); clearSentSources(action.sources);
        // 已受理：这次用过的资料版本进入本机「最近引用」。
        setRecentRefs(rememberSourceRefs(action.sources));
        setProjectionReload((value) => value + 1);
        // 202 只表示已提交，回复行可能还没出现在列表里。记下它的 id，
        // 让输入器从这一刻起就保持途，不等 refresh() 回来——
        // 否则会在「无在途」与「在途」之间跳一下，读起来是一下闪。
        if (sent.assistantMessageId !== null && sent.assistantMessageId !== undefined) {
          setAwaitingAssistantId(sent.assistantMessageId);
        }
        // 0127：这条消息建立了目标或带了模式——目标卡与模式说明按服务端事实重读。
        if (sent.goalId !== null || action.chatMode !== undefined) {
          void refreshGoalPlan();
        }
        // 2026-10-04 按用户判断去掉「消息已排队」：这条只是复述已提交的 202 回执，
        // 不携带新事实；消息本身的 PENDING/RUNNING 状态已经在消息行里说明。
        // 其余 notice（取消、提案回执、原命令回执）仍保留，它们各自说明不同的结果。
        // 普通消息由服务端主流程处理；结果经终态后的只读投影恢复。
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
      } else if (action.kind === "chatMode") {
        const transition = await client.setChatMode({ sessionId: session.id,
          commandId: action.commandId, mode: action.mode });
        if (disposed.current) return;
        setNotice(transition.chatMode === "PLAN"
          ? "已切换到计划模式：接下来先出方案，不改项目。"
          : transition.chatMode === "GOAL"
            ? "已切换到目标模式：描述目标后由服务端逐轮推进。"
            : transition.goalStopping
              ? "已切换回普通模式；活动目标正在安全停止，停下前不恢复推进。"
              : "已切换回普通模式。");
        // 会话上的 chat_mode 与目标卡都以服务端读回为准：徽标读的是外层持有的会话投影，
        // 只重读消息不会更新它。回执成功后走既有 refreshTarget 重读会话列表，否则退出后
        // 仍停在旧模式（DEV-0105 真实 Chromium 探针发现：提示已是普通模式，徽标还是目标模式）。
        await refreshTarget();
        if (disposed.current) return;
        setProjectionReload((value) => value + 1);
      } else {
        await client.acceptAssistProposal(action.id, action.commandId);
        if (disposed.current) return;
        setNotice("提案接受回执已提交；业务结果以刷新后的工作对象与提案状态为准。");
      }
      setPending(null); setPendingUnresolved(false); setPendingDialogOpen(false); await refresh();
    } catch (caught) {
      if (disposed.current) return;
      const described = describeLiveError(caught);
      // 传输失败与 5xx 都可能已经落库：pending 原样保留，原因进核对弹窗；
      // 明确拒绝才清空未决身份，按普通失败走停留到关闭的 toast。
      const unresolved = needsReceiptCheck(caught);
      if (unresolved) setPendingUnresolved(true);
      else { setPending(null); setPendingUnresolved(false); setPendingDialogOpen(false); }
      // 未决时这条原因是核对弹窗里的说明；明确拒绝时同一份文本改走停留到关闭的 Notice。
      setActionError(described.kind === "conflict" && action.kind === "acceptTask"
        ? `${described.message} 原提案仍保留供核对，不能覆盖当前验收；请重新生成提案。`
        : described.message);
      // §33.2：上传成功但命令被明确拒绝时，把暂存图片还给输入框；传输失败不还原——
      // 那时命令可能已入库，恢复芯片会诱导同一组文件被再次发送。
      const rejectedFiles = action.kind === "send" ? action.attachmentFiles : undefined;
      if (!unresolved && rejectedFiles !== undefined && rejectedFiles.length > 0)
        stagedSession.add(rejectedFiles);
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
      if (pending.kind === "model") setSelectedModel(sessionModelSelectionFrom(receipt.result).model);
      if (pending.kind === "restart") {
        await finishChatSession(chatSessionResultFrom(receipt.result, session.id, pending.system));
        return;
      }
      if (pending.kind === "send") { setDraft(""); clearSentSources(pending.sources);
        setRecentRefs(rememberSourceRefs(pending.sources)); }
      if (pending.kind === "acceptTask") void refreshTarget();
      setPending(null); setPendingUnresolved(false); setPendingDialogOpen(false);
      setNotice("原命令回执已核对；正在读取服务端状态。"); await refresh();
    } catch (caught) { if (!disposed.current) setActionError(describeLiveError(caught).message); }
    finally { if (!disposed.current) setBusy(false); }
  }
  /** 0127：计划与目标投影重读；操作后的刷新与轮询共用。 */
  async function refreshGoalPlan() {
    if (client === null) return;
    try {
      const [plans, goal] = await Promise.all([
        client.getSessionPlans(session.id), client.getSessionGoal(session.id)]);
      if (disposed.current) return;
      setPlanView(plans); setGoalView(goal);
    } catch { /* 读回失败保留现有投影；操作错误另有 goalPlanError。 */ }
  }

  /** 四条控制命令只提交意图；回执里的状态经重读落实（PAUSING 不等于已暂停）。 */
  async function runGoalControl(goalAction: "pause" | "cancel" | "resume" | "complete") {
    const goalId = goalView?.goal?.goalId;
    if (client === null || goalId === undefined || goalPlanBusy) return;
    setGoalPlanBusy(true); setGoalPlanError(null);
    try {
      await client.controlGoal({ goalId, commandId: createCommandId(), action: goalAction });
      if (disposed.current) return;
      await refreshGoalPlan();
      setProjectionReload((value) => value + 1);
    } catch (caught) {
      if (!disposed.current) setGoalPlanError(describeLiveError(caught).message);
    } finally { if (!disposed.current) setGoalPlanBusy(false); }
  }

  /** 「按此计划执行」：绑定确切的一版计划启动目标。 */
  async function startGoalFromPlanVersion(planId: string) {
    if (client === null || goalPlanBusy) return;
    setGoalPlanBusy(true); setGoalPlanError(null);
    try {
      await client.startGoalFromPlan({ sessionId: session.id, commandId: createCommandId(), planId });
      if (disposed.current) return;
      await refreshGoalPlan();
      setProjectionReload((value) => value + 1);
    } catch (caught) {
      if (!disposed.current) setGoalPlanError(describeLiveError(caught).message);
    } finally { if (!disposed.current) setGoalPlanBusy(false); }
  }

  function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const content = draft.trim();
    // 带图片时正文可以为空（§33 / HTTP §10.85）；两者都没有才是空输入。
    if ((!content && stagedSession.items.length === 0) || content.length > 32768 || pending || busy ||
      uploadingAttachments || writeBlockedReason !== null) return;
    // 0127：`/plan 内容`、`/goal 内容` 是「命令 + 正文」——模式随消息进同一命令，
    // 服务端在同一事务里切模式并受理消息。只有命令没有正文时只切模式。
    const modeCommand = chatModeCommandFromText(content);
    if (modeCommand !== null) {
      setActionError(null); setNotice(null);
      if (composerInflight) { setActionError("当前消息仍在生成，请先停止并等结算后使用会话命令。"); return; }
      if (modeCommand.rest === "") {
        void runAction({ kind: "chatMode", commandId: createCommandId(), mode: modeCommand.mode });
        return;
      }
      const staged = stagedSession.items;
      const payload: PendingAction = { kind: "send", commandId: createCommandId(),
        content: modeCommand.rest, intent: null, skillRef: null, skillInput: null,
        chatMode: modeCommand.mode,
        sources: sources.map((ref) => ({ ...ref })),
        ...(staged.length === 0 ? {} : { attachmentFiles: staged.map((item) => item.file) }) };
      if (staged.length === 0) { void runAction(payload); return; }
      if (client === null) return;
      // 图片先上传再发命令：与普通消息同一条纪律，ids 在命令产生前固定。
      void (async () => {
        setUploadingAttachments(true);
        try {
          const attachmentIds = await uploadStagedAttachments(client, session.id, staged);
          if (disposed.current || client !== liveClient()) return;
          stagedSession.clear();
          void runAction({ ...payload, attachmentIds });
        } catch (caught) {
          if (!disposed.current) setActionError(`图片上传失败，这条消息没有发送：${describeLiveError(caught).message}`);
        } finally { if (!disposed.current) setUploadingAttachments(false); }
      })();
      return;
    }
    const control = chatControlFromText(content);
    if (control !== null) {
      setActionError(null); setNotice(null);
      if (composerInflight) { setActionError("当前消息仍在生成，请先停止并等结算后使用会话命令。"); return; }
      if (control === "model") {
        const model = content.replace(/^\/\S+\s*/u, "").trim();
        if (model === "") setModelPickerOpen(true);
        else void runAction({ kind: "model", commandId: createCommandId(), model });
        return;
      }
      if (control === "compact") {
        // 菜单选择只插草稿，真正执行在发送这一步；这里只做「不接受参数」这一条本地预检。
        if (/\s/u.test(content.trim())) { setActionError("此会话命令不接受参数，请单独输入命令。"); return; }
        if (readonlyMode) {
          setActionError("只有普通 Agent 会话可以整理工作记忆；助手档与学习档没有工作窗口控制。"); return;
        }
        void runAction({ kind: "compact", commandId: createCommandId(), content: content.trim() });
        return;
      }
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
    // 只有图片、没有正文是合法的一条输入（§33 / HTTP §10.85），但只限普通讨论：
    // Skill 以正文为输入，提案意图也要正文说明——这两条路径空正文会被服务端拒绝，
    // 客户端先说明清楚，不让人点一次注定失败的发送。
    const staged = stagedSession.items;
    if (content === "" && (skill !== undefined || intent !== "DISCUSS") && !readonlyMode) {
      setActionError("图片可以只随讨论发送；使用 Skill 或提案意图时请补一句说明。");
      return;
    }
    const skillInput: RelaySkillInput | null = !skill ? null : skill.id === "task-to-execution-contract"
      ? input ? { desired_result: input } : {}
      : skill.id === "project-resume" ? input ? { focus: input } : {}
        : input ? { risk_focus: input } : {};
    const commandId = createCommandId();
    // 助手档不传 intent 也不传 skill_ref：服务端会以 409 拒绝这两者，
    // 客户端不把它们塞进载荷，省掉一次注定失败的往返。
    const payload: PendingAction = { kind: "send", commandId, content,
      intent: readonlyMode || skill ? null : intent,
      skillRef: readonlyMode || !skill ? null : { id: skill.id, version: skill.version },
      skillInput: readonlyMode ? null : skillInput,
      ...(learningMode ? { recordLearning } : {}),
      sources: sources.map((ref) => ({ ...ref })),
      ...(staged.length === 0 ? {} : { attachmentFiles: staged.map((item) => item.file) }) };
    if (staged.length === 0) { void runAction(payload); return; }
    // 先上传、再发命令：`attachment_ids` 是命令载荷的一部分，ids 必须在命令产生前固定，
    // 否则「重试」会拿另一组 id 去重放同一条 command_id，服务端按异载荷拒绝。
    // 上传失败时这条命令根本没发出去，附件留在框里等人重试，不假装发送成功。
    if (client === null) return;
    void (async () => {
      setUploadingAttachments(true);
      try {
        const attachmentIds = await uploadStagedAttachments(client, session.id, staged);
        if (disposed.current || client !== liveClient()) return;
        stagedSession.clear();
        void runAction({ ...payload, attachmentIds });
      } catch (caught) {
        if (!disposed.current) setActionError(`图片上传失败，这条消息没有发送：${describeLiveError(caught).message}`);
      } finally { if (!disposed.current) setUploadingAttachments(false); }
    })();
  }

  /**
   * 用户显式「继续原请求」：沿原 Task/READY/Delegate 入口再推进一次。
   *
   * 只有自动推进失败（服务端已把具体原因写回原请求）或用户在本页主动重试时才走到这里；
   * 正常路径由服务端 tick 推进，本组件不参与。提交的仍是同一条 `request_id`，幂等由
   * 请求行固定的三个阶段命令身份保证——重复或迟到提交只重放原回执。
   */
  async function applyExecution(requestId: string) {
    if (disposed.current || executionBusy) return;
    setExecutionBusy(true); setExecutionError(null);
    async function refreshRequest() {
      const next = (await client.getConversationExecutionRequests(session.id))
        .find((item) => item.requestId === requestId) ?? null;
      if (!disposed.current && next !== null) {
        setExecution((previous) => ({
          ...(previous?.requestId === requestId ? previous : {}), ...next,
          title: next.title ?? (previous?.requestId === requestId ? previous.title : null),
          objective: next.objective ?? (previous?.requestId === requestId ? previous.objective : null),
          resourceId: next.resourceId ?? (previous?.requestId === requestId ? previous.resourceId : ""),
          sessionId: session.id }));
        // Apply 后的读回也必须同步更新按原 user message 挂接的 Run 轨迹投影；
        // 不能等待消息列表变化再次触发加载，否则原聊天会漏掉刚创建的 Run 结果反馈。
        setExecutionSummaries((previous) => {
          const current = previous.get(next.sourceMessageId);
          if (current !== undefined && BigInt(current.revision) > BigInt(next.revision)) return previous;
          const updated = new Map(previous);
          updated.set(next.sourceMessageId, next);
          return updated;
        });
      }
      return next;
    }
    try {
      await client.applyConversationExecution(requestId);
      const next = await refreshRequest();
      if (disposed.current) return;
      if (next === null) throw new Error("执行响应已返回，但尚未读到原请求，请稍后核对。");
      if (next?.status === "DELEGATED" && next.runId !== null && next.taskId !== null) {
        onExecutionPrepared?.(next.taskId);
      }
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
   * 明确且就绪的执行请求由**服务端**沿原 Task/Run 应用入口推进（工作台 §43）。
   *
   * 2026-10-20 第二轮：这里不再有任何自动推进。此前是「本设备读到 READY 投影 → effect
   * 调 applications」，于是页面关掉、刷新错过时机或请求由另一台设备发起时，一条已经
   * 明确授权的工作会停在 READY 等一次没有信息量的点击；同时前端与后台各自都在推进，
   * 责任落在两个 Owner 上。现在唯一的推进者是 Worker 的 `conversation-execution-autostart`
   * tick，它按原请求行上固定的三个阶段命令身份重放，幂等且可恢复。
   *
   * 本组件只保留两件事：把阶段如实显示出来；自动推进**失败**时给一次显式「继续原请求」，
   * 修好缺的连接或目录后由用户决定再试一次。`applyExecution(requestId)` 仍然复用同一组
   * 命令身份，因此人工重试也不会产生第二个 Task/Run。
   */

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
  const settledMessageKey = messages?.filter((item) => item.role === "ASSISTANT" &&
    !["PENDING", "RUNNING"].includes(item.status)).map((item) => `${item.id}:${item.status}`).join("|") ?? "";
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
  }, [client, session.id, session.projectId, readonlyMode, settledMessageKey, projectionReload, confirmedFirstMessageCommandId]);
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
      const currentCandidate = [...latest.values()].find((item) =>
        item.candidateStatus === "READY" || item.status === "CLARIFY" || item.status === "DECISION_REQUIRED");
      if (currentCandidate !== undefined) setExecution((previous) =>
        previous?.requestId === currentCandidate.requestId && BigInt(previous.revision) > BigInt(currentCandidate.revision)
          ? previous : currentCandidate);
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
  }, [client, session.id, target?.id, settledMessageKey, projectionReload, confirmedFirstMessageCommandId]);

  // 空会话首屏按会话归属取「待你处理」：项目会话看项目，目录会话看未读，其余看全局。
  const pendingEmptyContext: PendingContext = session.projectId !== null
    ? { scope: "PROJECT", projectId: session.projectId }
    : session.workingResourceId !== null ? { scope: "FOLDER", resourceId: session.workingResourceId }
      : { scope: "GLOBAL" };
  /**
   * 空会话说明句按**服务端给的作用域来源**收（工作台 §18.1.5）：继承默认目录的会话
   * 必须说清这一点；缺字段（旧服务端）不编造来源，沿用未设置措辞。
   */
  const sessionDirectorySource = session.context?.workingDirectory?.source ?? null;
  const sessionDirectoryName = session.context?.workingDirectory?.canonicalRoot
    ?.replace(/[\\/]+$/u, "").split(/[\\/]/u).at(-1) ?? null;
  /**
   * 首条消息已由 202 回执确认，但这次读回还没看到它（DEV-0110：回执后 ~43ms
   * 欢迎空态闪回）。命令 id 已按会话归属过滤，只对本面板的会话成立。
   */
  const firstMessageAwaitingProjection = confirmedFirstMessageCommandId != null &&
    messages !== null && messages.length === 0;
  /* 0132：撤回回执写回两行（用户消息与直接回复）。服务端只返回一份终态，
     界面不在本地推算「回退了几条」，逐文件结果仍以回执为准。 */
  function storeRecallReceipt(recall: RelayAssistMessageRecall) {
    setRecallReceipts((current) => ({ ...current, [recall.messageId]: recall,
      [recall.assistantMessageId]: recall }));
  }
  /* 撤回执行期间不接受新写入：在途生成可能还在改文件，恢复与它交错会把回执变成假事实。
     服务端也会拒（INVALID_TRANSITION），这里先禁用，不让人点一次注定失败的操作。 */
  const recallInFlight = messages?.some((item) => item.role === "ASSISTANT" &&
    (item.status === "PENDING" || item.status === "RUNNING")) ?? false;
  const recallDisabledReason = writeBlockedReason !== null ? writeBlockedReason
    : recallInFlight ? "这条消息之后仍有在途生成；完成或停止后再撤回。"
      : busy || pending !== null ? "有命令正在提交，等它结算后再回退。" : null;
  async function recallMessage(message: RelayAssistMessage) {
    if (recallBusyId !== null || recallDisabledReason !== null) return;
    setRecallBusyId(message.id);
    setRecallErrors((current) => {
      if (!(message.id in current)) return current;
      const next = { ...current }; delete next[message.id]; return next;
    });
    try {
      const recall = await client.recallAssistMessage(message.id, createCommandId());
      if (disposed.current || client !== liveClient()) return;
      storeRecallReceipt(recall);
      setNotice(recallSummaryText(recall));
      await refresh();
    } catch (caught) {
      if (disposed.current || client !== liveClient()) return;
      // 提交结果不明时先按原消息读回执：读到了就以服务端事实为准，不把已生效的撤回报成失败。
      if (needsReceiptCheck(caught)) {
        try {
          const receipt = await client.getAssistMessageRecall(message.id);
          if (disposed.current || client !== liveClient()) return;
          storeRecallReceipt(receipt);
          setNotice(recallSummaryText(receipt));
          await refresh();
          return;
        } catch { /* 回执也不可读：保留原错误说明，不猜结果。 */ }
      }
      setRecallErrors((current) => ({ ...current,
        [message.id]: describeLiveError(caught).message }));
    } finally {
      if (!disposed.current) setRecallBusyId(null);
    }
  }
  async function readRecallReceipt(message: RelayAssistMessage) {
    const summary = message.recall;
    if (summary === null || recallReadingId !== null) return;
    setRecallReadingId(summary.messageId);
    setRecallErrors((current) => {
      if (!(message.id in current)) return current;
      const next = { ...current }; delete next[message.id]; return next;
    });
    try {
      const receipt = await client.getAssistMessageRecall(summary.messageId);
      if (disposed.current || client !== liveClient()) return;
      storeRecallReceipt(receipt);
    } catch (caught) {
      if (disposed.current || client !== liveClient()) return;
      setRecallErrors((current) => ({ ...current,
        [message.id]: describeLiveError(caught).message }));
    } finally {
      if (!disposed.current) setRecallReadingId(null);
    }
  }
  const transcriptContent = <>
    {messages === null && !error && showMessagesLoading && <p className="loading-text" role="status">正在读取会话消息…</p>}
    {error && <p className="action-error" role="alert" data-testid="assist-transcript-error">
      {/* 列表还在（网络不明/5xx）时说清「这份是旧的」，不把一次超时读成「没有消息」。 */}
      {messages !== null ? `会话消息读取失败：${error} 下面显示的是上次成功读取的内容，可能已过期。` : error}
      {" "}<button type="button" className="text-link" onClick={() => void refresh()}>重读</button></p>}
    {/* 协作页空会话与全局新对话同一欢迎空态：不同入口新建会话首屏一致。说明句按工作对象
        归属收敛——任务/项目作用域已有所属，不再宣称「不需要先创建项目、任务」。
        首条消息在途/待核对时两种空态都不摆：欢迎不出现（DEV-0110 起就不闪回），
        「还没有消息。」也删掉——那一行把在途读成空会话，而发送状态行已经说明事实。 */}
    {messages?.length === 0 && (standalone && !firstMessageInflight && !firstMessageAwaitingProjection
      ? <EmptyWorkWelcome testId="assist-empty-welcome" suggestTestIdPrefix="assist-empty-suggest"
          lede={sessionDirectorySource === "WORKSPACE_DEFAULT"
            ? `这段会话使用设置里的默认目录「${sessionDirectoryName ?? "默认目录"}」，可以直接讨论或描述目标。`
            : target === null
              ? "可以直接讨论或描述目标。不需要先创建项目、任务；要读取文件时再选择工作目录。"
              : target.kind === "TASK" ? "围绕当前任务直接讨论，或描述新的要求。"
                : "围绕当前项目直接讨论，或描述新的要求。"}
          onSuggest={(text) => { setDraft(text); draftRef.current?.focus(); }} />
      : firstMessageInflight || firstMessageAwaitingProjection ? null
        : <p className="helper-text">还没有消息。</p>)}
    {!!messages?.length && <ol className="agent-message-list">{messages.map((message, index) => {
      const previous = index > 0 ? messages[index - 1] : undefined;
      const day = messageDay(message.createdAt);
      const newDay = day !== null && (previous === undefined || messageDay(previous.createdAt) !== day);
      return <li key={message.id} className="agent-message-slot" data-chat-timeline-slot="true"
        data-timeline-session={session.id} data-message-id={message.id}>
        {newDay && <p className="agent-date-separator" role="separator" aria-label={`日期 ${day}`}><span>{day}</span></p>}
{/* busy / pending 已随消息内取消按钮一起移除；writeBlocked 只剩预览重读这一处只读入口。 */}
<AssistMessageRow client={client} target={target} message={message}
        personaLabel={learningMode ? "学习搭档" : session.personaLabel}
        preview={canPreview(message) && writeBlockedReason === null ? previews[message.id] ?? null : null}
        previewError={previewErrors[message.id] ?? null} onRetryPreview={() => setPreviewRetry((value) => value + 1)}
        settling={settling[message.id] ?? null}
        handover={handovers[message.id] === true}
        onVerifyFinal={() => void refresh()}
        writeBlocked={writeBlockedReason !== null}
        candidates={proposals.filter((proposal) => proposal.messageId === message.id &&
          proposal.kind === "CANDIDATE_MARKDOWN" && message.role === "ASSISTANT" &&
          message.status === "COMPLETED")}
        recallReceipt={recallReceipts[message.id] ?? null}
        recallBusy={recallBusyId === message.id}
        recallReading={recallReadingId === (message.recall?.messageId ?? message.id)}
        recallError={recallErrors[message.id] ?? null}
        recallDisabledReason={recallDisabledReason}
        onRecall={() => void recallMessage(message)}
        onReadRecall={() => void readRecallReceipt(message)} />
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
  // 调用，用量恒为 null；Provider 未上报缓存时命中率那一格不渲染（见 ContextMeter）。
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
          <details className="tech-details"><summary>核对工作对象与内容摘要</summary><p className="helper-text">工作对象 {proposalTargetTypeText(proposal.targetType)} · {proposal.targetId} · 基于修订 v{proposal.baseRevision} · 内容摘要 {proposal.payloadHash}</p></details>
          {proposal.status === "PENDING" && <button className="primary-button" type="button" disabled={busy || pending !== null || writeBlockedReason !== null} onClick={() => void runAction({ kind: "accept", id: proposal.id, commandId: createCommandId() })}>接受此提案</button>}
        </details>
      </article>;
    })}
  </ProposalContainer>;

  const emptyStandaloneWelcome = standalone && firstMessageInflight === false &&
    !firstMessageAwaitingProjection && messages !== null && messages.length === 0;
  const transcript = <div ref={transcriptRef} className={standalone ? "agent-chat-transcript" : undefined}
    role="region" aria-label="会话消息" tabIndex={0} data-testid="assist-transcript"
    onScroll={(event) => {
      const element = event.currentTarget;
      if (element.clientHeight === 0) return;
      const latest = element.scrollHeight - element.scrollTop - element.clientHeight < 32;
      followLatest.current = latest; setAtLatest(latest);
      syncEdgeFades(element);
    }}><div ref={transcriptContentRef}
      className={emptyStandaloneWelcome ? "agent-chat-content agent-chat-content--empty" : "agent-chat-content"}>{transcriptContent}{standalone && !externalReadBlockedReason && visibleProposals.length > 0 && proposalPanel}</div></div>;
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

  /**
   * 「+」二级菜单里「对话中的资料」的真实来源：当前会话消息上已出现过的资料引用。
   * 只收本选择器支持的三类（KNOWLEDGE/MEMORY/DECISION）且三元组齐全的条目，按最近出现去重
   * （越新的越靠前）；不推断、不补全缺失字段，也不把标题/摘要当身份。
   */
  const conversationRefs = useMemo<readonly RelayAssistSourceRef[]>(() => {
    const seen = new Set<string>();
    const collected: RelayAssistSourceRef[] = [];
    for (const message of [...(messages ?? [])].reverse()) {
      for (const source of message.sources) {
        if (source.kind !== "KNOWLEDGE" && source.kind !== "MEMORY" && source.kind !== "DECISION") continue;
        if (source.rootId === null || source.version === null) continue;
        const ref: RelayAssistSourceRef = { kind: source.kind, rootId: source.rootId, version: source.version };
        const key = `${ref.kind}:${ref.rootId}:${ref.version}`;
        if (seen.has(key)) continue;
        seen.add(key); collected.push(ref);
      }
    }
    return collected;
  }, [messages]);

  // 发送选项与资料合成一枚浮层（2026-10-24 用户指令「这两个合成一个芯片就好了」）：
  // 2026-10-18 曾按用户指令「两个弹窗怎么是一样的」拆成两颗芯片两片浮层；本轮合回
  // 「一颗芯片一片浮层、两节内容」（上发送选项、下资料），多开从构造上不可能。互斥由
  // useMenuDismiss 的独占注册承担（打开即收起其余已注册浮层），Esc 由 details 上的内联
  // onKeyDown 处理并还焦点给 summary，外部按下归钩子。内嵌/普通态不是浮层（常驻展开面板
  // 或面板上方块），两段内容同屏呈现。
  const sendOptionsRef = useRef<HTMLDetailsElement>(null);
  // 浮层贴芯片锚定，右缘越界时翻面（芯片在窄窗会随工具行换行移位，静态规则不适用）。
  usePopupFlip(sendOptionsRef);
  const [sendOptionsOpen, setSendOptionsOpen] = useState(false);
  useMenuDismiss(standalone && sendOptionsOpen, () => setSendOptionsOpen(false), sendOptionsRef);
  /* 浮层 Esc 收口：裸 Esc 收面板并把焦点还给触发 chip；组词（isComposing / keyCode 229）与
     带修饰键的组合不消费。内联处理器先于 document 监听消费事件（stopPropagation），
     useMenuDismiss 的 Esc 只兜焦点落在面板之外的情况。 */
  const popoverEscape = (open: boolean, close: () => void) => (event: ReactKeyboardEvent<HTMLDetailsElement>) => {
    if (!open || event.key !== "Escape" || event.nativeEvent.isComposing ||
      event.nativeEvent.keyCode === 229 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    event.preventDefault(); event.stopPropagation();
    close(); event.currentTarget.querySelector<HTMLElement>("summary")?.focus({ preventScroll: true });
  };
  const summaryLabel = selectedSkill ? selectedSkill.title : intent === "DISCUSS" ? "普通讨论" : "提案";
  const sendOptionsFields = <>
      <label className="field"><span className="field-label">生成方式</span><select data-testid="assist-skill"
        value={selectedSkillKey} onChange={(event) => { setSelectedSkillKey(event.target.value); setSkillInputText(""); }}
        disabled={pending !== null || busy}>
        <option value="">普通 Assist</option>
        {skills.map((skill) => {
          /* 清单全量：需要的上下文对不上这条会话时如实标注并不可选，不让用户选了再被服务端拒绝。 */
          const missingScope = skill.target === "TASK" ? session.taskId === null : session.projectId === null;
          const scopeLabel = skill.target === "TASK" ? "任务" : "项目";
          return <option key={`${skill.id}@${skill.version}`} value={`${skill.id}@${skill.version}`}
            disabled={!skill.callSupported || skill.missingCapabilities.length > 0 || missingScope}>{skill.title} v{skill.version} ·
            {!skill.callSupported ? "历史版本，仅可查阅" : skill.missingCapabilities.length > 0 ? "缺能力，当前不可调用"
              : missingScope ? `需${scopeLabel}上下文，本会话没有`
              : skill.availability === "CALLABLE_READ_ONLY" ? "只读" : "仅建议"}</option>;
        })}
      </select></label>
      {/* 上下文缺口说清去哪补：会话归属建会话时冻结，本会话补不了，只能换一条从工作对象进入的会话。 */}
      {skills.some((skill) => skill.target === "TASK" ? session.taskId === null : session.projectId === null) &&
        <p className="helper-text">带「需任务 / 需项目上下文」的 Skill 要回到对应任务或项目开始对话；这条会话的归属已在建立时固定。</p>}
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
      <p className="helper-text">本次发送冻结已选的 {sources.length} 个资料版本。</p></>;
  /* 独立态一枚合体浮层（2026-10-24 用户指令「这两个合成一个芯片就好了」）：发送选项与资料
     合成一颗芯片（标签＝当前意图）一片浮层，上节发送选项、下节资料。此前是两颗芯片两片
     浮层（2026-10-18 按用户指令「两个弹窗怎么是一样的」拆分）；合并后多开从构造上不可能——
     一片浮层一个入口，互斥注册表仍旧挂着（与「+」、模式、档位、模型等照旧互斥）。
     资料入口的 data-testid 与 aria-expanded 留在 summary 上，既有断言与 Playwright 直点不换 Owner。 */
  const sendOptionsPopup = standalone ? <details ref={sendOptionsRef}
    className="agent-chat-options agent-chat-send-options" open={sendOptionsOpen}
    onKeyDown={popoverEscape(sendOptionsOpen, () => setSendOptionsOpen(false))}
    onToggle={(event) => { if (event.currentTarget.open !== sendOptionsOpen) setSendOptionsOpen(event.currentTarget.open); }}>
    <summary data-testid="assist-open-sources" aria-expanded={sendOptionsOpen}
      title={`这条消息的发送选项与资料 · 已选 ${sources.length} 个资料版本`}>
      {summaryLabel}<ChevronDown aria-hidden="true" className="agent-chat-chip-chevron" /></summary>
    <div className="agent-chat-options-panel">
      {sendOptionsFields}
      <div className="agent-chat-options-section">{sourcePicker}</div>
    </div></details> : null;
  /* 非独立态：常驻展开面板（内嵌）或面板上方静态块，两段内容同屏，不参与浮层拆分。 */
  const sendOptionsExpanded = standalone ? null : <details className="assist-options-expanded" open>
    <summary>发送选项 · {summaryLabel}</summary>{sendOptionsFields}</details>;

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

  /**
   * 会话草稿的发送前辅助（工作台 §30）。来源身份用 session.id：本面板已按
   * `${connection.epoch}:${session.id}` 挂载 key，连接或会话变化会重挂载，因此
   * 面板存活期内 session.id 就是稳定且唯一的来源。
   * 提示行渲染在输入卡上方，润色键渲染在工具行内（原型 `#polishBtn` 的位置）；
   * 没有工具行的子页/嵌入态由提示行自带（inlinePolish）。
   */
  const assistant = useComposerDraftAssist({
    client, sourceKey: `${session.id}`,
    value: draft, onChange: setDraft,
    disabled: pending !== null || busy,
    inflight: composerInflight,
    composing, onRequestFocus: restoreDraftFocus,
  });
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
     那种情况下它由正文前的三点、meta 行耗时与输入栏停止键表达，不标状态词。 */
  const waitingQueue = runningMessage !== null ? pendingMessages : [];
  /* 0122：可插话的排队项。带图片的不能插话——插话通道只送用户原文，图片会被悄悄丢掉，
     服务端也会拒绝；这里先剔掉，不让人点一次注定失败的操作。 */
  const steerableQueue = waitingQueue.filter((item) =>
    !item.cancelRequested && item.attachments.length === 0);
  /* 上游 Queue/Steer 的 Steer 半边（`InputBar.tsx:155` 的 `canSteerQueue`）：
     输入框为空 + 正在生成 + 队列非空，此时空草稿的 Enter 不再是一次空提交。 */
  const canSteerQueue = !busy && pending === null && writeBlockedReason === null &&
    draft.trim() === "" && stagedSession.items.length === 0 && steerableQueue.length > 0;
  /**
   * 0122：把排队消息插话到正在生成的那一轮。
   *
   * 逐条提交、各自一个 command_id：一条被拒不影响已提交的那些。回执只表示意图已受理
   * （`STEER_REQUESTED`），真正并入由生成方在下一次模型请求前完成——所以文案说的是
   * 「已请求」，不宣称「已并入」。
   */
  async function steerQueued(items: readonly RelayAssistMessage[]) {
    if (items.length === 0 || busy || pending !== null || writeBlockedReason !== null) return;
    setBusy(true); setActionError(null); setNotice(null);
    let accepted = 0;
    try {
      for (const item of items) {
        await client.steerAssistMessage(item.id, createCommandId());
        accepted += 1;
        if (disposed.current || client !== liveClient()) return;
      }
      setNotice(accepted === 1
        ? "已请求插话：生成方会在下一次模型请求前把这条并入当前回复。"
        : `已请求插话 ${accepted} 条：生成方会在下一次模型请求前把它们并入当前回复。`);
    } catch (caught) {
      if (disposed.current) return;
      const described = describeLiveError(caught);
      // 传输失败时这一条是否已落库无法判定：如实说「未核对」，不自动重发；
      // 再按一次 Enter 是用户明确的重发（服务端对已置位的行幂等）。
      setActionError(described.kind === "transport"
        ? `已受理 ${accepted} 条插话；下一条结果未核对。${described.message}`
        : `插话未生效：${described.message}`);
    } finally {
      if (!disposed.current) { setBusy(false); await refresh(); }
    }
  }
  /* 明细常驻，不用 details 折叠：队列面板在提交瞬间出现、在最后一条离开时消失，
     折叠控件的 summary 与展开箭头都会跟着一起闪现。内容本身只有几行，
     收起省下的高度不值得换一个会闪的控件。 */
  /* 2026-10-20 用户指认后按 tasteskill 收敛（弹层不放整段说明的同一条纪律）：
     面板只承担事实与动作——一行摘要 + 每行一项；说明句整段移出可视层，由原生
     title 承担；Enter 插话手势保留为摘要行右侧的一枚短标签（仅在有可插话项时）。 */
  const queueTitle = steerableQueue.length > 0
    ? "按提交先后依次回复，每条都可单独取消；输入框为空时按 Enter 可插话发送，把它并入当前回复。"
    : "按提交先后依次回复；每条都可单独取消，取消只影响这一条。带图片的消息按顺序发送，不插话。";
  const queuePanel = waitingQueue.length === 0 ? null :
    <div className="assist-queue" data-empty="false" data-testid="assist-queue" title={queueTitle}>
      <div className="assist-queue-head">
        <p className="assist-queue-summary">等待中 · {waitingQueue.length} 项，当前回复生成中</p>
        {steerableQueue.length > 0 && <p className="assist-queue-gesture">输入框为空时按 Enter 插话</p>}
      </div>
      <ol className="assist-queue-list">{waitingQueue.map((item, index) => {
        const source = userTextBefore(item.id);
        const steerable = !item.cancelRequested && item.attachments.length === 0;
        return <li key={item.id} data-testid={`assist-queue-item-${index + 1}`}>
          <span className="assist-queue-position">第 {index + 1} 项</span>
          {source ? <span className="assist-queue-text">{source.length > 80 ? `${source.slice(0, 80)}…` : source}</span>
            : <span className="assist-queue-text helper-text">原文不可读</span>}
          {/* 插话待生效：意图已受理、生成方还没走到下一次模型请求。它不是完成态。 */}
          {item.steerRequested && !item.cancelRequested &&
            <span className="helper-text" data-testid={`assist-queue-steer-pending-${index + 1}`}>插话待生效</span>}
          {steerable && !item.steerRequested && <button className="text-button" type="button"
            data-testid={`assist-queue-steer-${index + 1}`}
            disabled={busy || pending !== null || writeBlockedReason !== null}
            onClick={() => void steerQueued([item])}>插话</button>}
          {!item.cancelRequested && <button className="text-button" type="button"
            data-testid={`assist-queue-cancel-${index + 1}`} disabled={busy || pending !== null || writeBlockedReason !== null}
            onClick={() => void runAction({ kind: "cancel", id: item.id, commandId: createCommandId() })}>取消这条</button>}
          {item.cancelRequested && <span className="helper-text">取消中</span>}
        </li>;
      })}</ol>
    </div>;

  /* 2026-10-25 用户指令（参照 Codex 的目标行）：目标状态收成输入框上方的一行，
     步骤/进展/成功条件/停止原因在行内展开；不再在转录区顶部占一张常驻大卡。
     计划卡仍收进 details：只在要挑版本执行时展开，不常驻占高。 */
  const goalCardBlock = !externalReadBlockedReason && <GoalCard view={goalView}
    busy={goalPlanBusy} error={goalPlanError}
    onPause={() => void runGoalControl("pause")} onCancel={() => void runGoalControl("cancel")}
    onResume={() => void runGoalControl("resume")}
    onConfirm={() => void runGoalControl("complete")} />;
  const planCardBlock = planView === null || planView.latest === null ? null :
    <details className="goal-plan-details" data-testid="plan-card-details">
      <summary>计划（{planView.versions.length} 版）</summary>
      <PlanCard view={planView} busy={goalPlanBusy} error={goalPlanError}
        onExecute={(planId) => void startGoalFromPlanVersion(planId)}
        onExport={(markdown) => { void navigator.clipboard?.writeText(markdown); }}
        onDismiss={() => setPlanView(null)} />
    </details>;

  return <section className={standalone ? "surface-panel agent-chat-conversation" : "surface-panel"} data-testid="assist-session"
    onKeyDown={onPanelKeyDown}>
    {!externalReadBlockedReason && embedded && proposalPanel}
    {!externalReadBlockedReason && <div className={standalone ? "agent-chat-conversation-heading" : embedded ? "embedded-assist-session-heading" : undefined}><div>{!embedded && <h2>{standalone ? "对话" : "消息与提案"}</h2>}{standalone || embedded ? <details><summary>会话信息</summary><p className="helper-text">{session.title} · {session.status} · {session.id}</p></details> : <p className="helper-text">会话 {session.id} · {session.status}。生成与取消均以服务端状态为准。</p>}</div><button className="secondary-button" type="button" data-testid="assist-refresh" onClick={() => { void refresh(); /* 刷新同时覆盖计划/目标投影（#122）：投影读取失败后，页内刷新就是恢复入口之一。 */ setProjectionReload((value) => value + 1); }}>{standalone ? "刷新" : "刷新消息与提案"}</button></div>}
    {!externalReadBlockedReason && projectionReadError !== null && <div className="warning-callout" role="alert" data-testid="goal-projection-read-error"><p>{projectionReadError}读取恢复前不显示目标状态行，也不宣称这个会话没有目标。</p><button className="secondary-button" type="button" data-testid="goal-projection-retry" onClick={() => setProjectionReload((value) => value + 1)}>重试读取目标状态</button></div>}
    {!externalReadBlockedReason && planCardBlock}
    {!externalReadBlockedReason && (embedded ? <details className="embedded-assist-history"><summary>查看会话历史与原始建议</summary>{transcript}</details> : <div className={standalone ? "agent-chat-transcript-shell" : undefined} data-top-fade={awayFromTop ? "on" : undefined}
        data-bottom-fade={awayFromBottom ? "on" : undefined}>{transcript}
      {/* 时间线只消费已加载消息与消息流容器；嵌入态的转录区在 details 里没有自己的滚动容器，
          因此只在 standalone 接入，避免第二个滚动 Owner（工作台 §31.1）。 */}
      {standalone && <ChatTimelineNav sessionId={session.id} messages={messages ?? []}
        getScrollOwner={getTranscriptOwner} />}
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

    {/* 2026-10-20 用户指认：输入卡上方的「会话记忆」控制带已移除（工作台 §40）。
        它原来回答「模型下次能看到什么」，但常态只有一个「无摘要」徽牌，占了发送前
        最后一行位置却不改变任何发送决定。整理仍可走 `/compact`；「清除工作记忆」与
        「一次性模式」暂时没有界面入口，需要时按 §40.1 把面板接回来。 */}

    {!readonlyMode && standalone && execution !== null && execution.status !== "DELEGATED" && <ExecutionSummary execution={execution}
      busy={executionBusy} error={executionError}
      onApply={(requestId) => void applyExecution(requestId)}
      onOpenTask={(taskId) => onExecutionPrepared?.(taskId)} />}

    {/* 文件夹作用域细条紧贴输入卡上方：它说明的是「发送前」的前提，因此必须落在
        输入区这一侧，而不是消息区顶部。归属回执与它同属这一区，位置由协作页决定。
        空会话的「待你处理」与细条同一行、紧跟其后，和首条输入器一致。 */}
    <div className="agent-chat-prereq-row">
      {composerHeader}
      {emptyStandaloneWelcome && <PendingWorkStrip client={client} context={pendingEmptyContext} />}
      {/* 会话总 diff（工作台 §34.2）：与目录细条同处输入卡**外**上方这一行（2026-10-18 用户指令
          「diff 摘要把左侧目录信息顶到上一行」）。外壳 `display: contents` 让入口直接成为本行的
          flex 项：目录保持左对齐，入口在剩余空间里居中，窄窗放不下时整行换行而不是互相挤压。
          它仍在卡片**外**，所以数字位数变化、路径变长都不撑高输入卡、不挤掉发送/停止键；
          总数只反映已落盘内容，生成中的预览不进这里（§34.4）。 */}
      {session.status === "ACTIVE" && <ConversationDiffSummary client={client} sessionId={session.id}
        enabled={externalReadBlockedReason === null}
        directoryBound={session.workingResourceId !== null && session.workingResourceId !== undefined} />}
    </div>
    {learningMode && <LearningRecordsPanel client={client} sessionId={session.id}
      refreshKey={(messages ?? []).map((item) => `${item.id}:${item.status}`).join("|")}
      blocked={externalReadBlockedReason !== null} inflight={composerInflight}
      writeBlocked={writeBlockedReason !== null}
      defaultBackground={lastLearningReply?.content?.slice(0, 4000) ?? ""}
      composerDirty={Boolean(draft.trim() || skillInputText.trim())}
      onStateChange={setLearningState} onNavigationChange={setLearningNavigation}
      onTransfer={onLearningTransfer ? (instruction, background) => onLearningTransfer(instruction, background, learningTransferSources) : undefined} />}

    {/* 发送前草稿辅助（工作台 §30）。提示行在输入卡上方；润色键跟着工具行走，
        原型三方案共用那一处键位。没有工具行的子页由提示行自带润色键。 */}
    {/* 状态行与目录细条合并（2026-10-18）：有细条时只由细条显示目录与更换入口；
        嵌入态没有细条，仍显示只读摘要。 */}
    {session.status === "ACTIVE" && composerHeader === undefined &&
      <ComposerStatusBar directory={session.context?.workingDirectory ?? null}
        writeTier={sessionWriteTier} showWrite={!assistantMode} />}
    {session.status === "ACTIVE" && <ComposerDraftBar assist={assistant} value={draft}
      inlinePolish={!standalone} />}
    {/* 目标单行状态条紧贴输入卡上方（2026-10-25 用户指令，参照 Codex）：进行中的事实
        常驻可见但不占消息流；无目标时整条不渲染，不占位。仍在输入卡**外**，
        展开/收起与内容变化都不改变输入卡自己的形状（同回执那一列的裁定）。 */}
    {!externalReadBlockedReason && goalCardBlock}
    {/* 命令回执留在输入器这一列内，不再作为整宽底栏：反馈不删，只是不占满页面。
        2026-10-16：回执同样搬出**卡片本体**，与档位说明一起排在卡下方的这一列——
        留在卡内会让卡片随「有没有回执」长高变矮（用户截图指认「这些都导致输入框变化了」）。 */}
    {session.status === "ACTIVE" && <div className={standalone ? "agent-chat-composer" : "create-form"}
      data-inflight={composerInflight} data-busy={busy || pending !== null ? "true" : undefined}
      data-testid="assist-composer" ref={composerBoxRef}>
      {/* 在途光点。装饰层跟随实际在输入的那个输入器，两种形态都渲染：
          aria-hidden 且不承载事实——在途状态由消息行的状态文字承担。 */}
      <span className="agent-chat-composer-spark-clip" aria-hidden="true"><span className="agent-chat-composer-spark" aria-hidden="true" /></span>
      <form id={composerFormId} className="agent-chat-message-form" onSubmit={send}>
      {/* 附件芯片：卡片顶部、正文上方（2026-10-24 用户指令，理由同首条消息输入器）。
          图片是这条输入的组成部分，因此跟着正文一起在卡片里；档位说明与回执那类
          「状态」仍在卡外。 */}
      <ComposerAttachmentChips items={stagedSession.items} error={stagedSession.error}
        uploading={uploadingAttachments}
        disabled={pending !== null || busy || uploadingAttachments}
        onRemove={stagedSession.remove} />
      <div className="field"><span className={standalone ? "visually-hidden" : "field-label"}>本次消息</span><ChatCommandInput
        client={client} mode={session.conversationMode} hasSession={true} data-testid="assist-draft"
        ref={draftRef}
        placeholder={standalone ? "输入你的想法、修改意见或新的要求" : undefined}
        value={draft} onValueChange={setDraft} maxLength={32768} rows={standalone ? 2 : 4}
        onCompositionChange={setComposing}
        onAttachFiles={(files) => stagedSession.add(files)}
        pluginChips
        onSelectCommand={(entry) => {
          if (entry.kind === "METHOD") { setSelectedSkillKey(""); setIntent("DISCUSS"); }
        }}
        disabled={pending !== null || busy || uploadingAttachments} onKeyDown={(event) => {
          if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return;
          /* 0122：空草稿 + 正在生成 + 队列非空时，Enter 是「插话」而不是空提交。
             与上游 `canSteerQueue` 同一判据；非空草稿仍走原来的发送。 */
          if (canSteerQueue) {
            event.preventDefault();
            void steerQueued(steerableQueue);
            return;
          }
          if (standalone) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); }
        }} /></div>
      {/* 嵌入式 ?skill=assist 只有这一个文字提交键，所以它同样承载停止形态：
          删掉消息内的取消按钮后，这里是子页唯一的停止入口。图标键形态见 standalone 分支。 */}
      {/* 发送键与停止键分开挂载（key）：二者同位置同类型，复用 DOM 会让浏览器从
          发送键的禁用灰用 120ms 过渡到停止键的主色，读起来又是一次闪变（DEV-0110）。 */}
      {!standalone && (stoppableMessage !== null || stopPending
        ? <button key="stop" className="primary-button" data-testid="assist-stop" type="button"
          data-state={stopPending ? "stopping" : "stoppable"}
          data-busy={!stopPending && (busy || pending !== null) ? "true" : undefined}
          aria-label={stopPending ? "正在停止生成" : "停止生成"} aria-keyshortcuts="Escape Escape"
          title={stopPending ? "正在停止，等待生成安全结束" : "停止生成 · 连按两次 Esc"}
          disabled={stopPending || busy || pending !== null || writeBlockedReason !== null}
          onClick={() => { if (stoppableMessage !== null)
            void runAction({ kind: "cancel", id: stoppableMessage.id, commandId: createCommandId() }); }}
        >{stopPending ? "正在停止生成" : "停止生成"}</button>
        : <button key="send" className="primary-button" data-testid="assist-send" type="submit"
          data-busy={busy || pending !== null ? "true" : undefined}
          disabled={(!draft.trim() && stagedSession.items.length === 0) || pending !== null || busy ||
            uploadingAttachments || writeBlockedReason !== null || Boolean(selectedSkillKey && !selectedSkill) ||
            Boolean(selectedSkill && (!selectedSkill.callSupported || selectedSkill.missingCapabilities.length > 0))}>{busy ? `正在提交 · ${sendLabel}` : sendLabel}</button>)}
    </form>
      {standalone && <div className="agent-chat-composer-actions">
        <div className="agent-chat-composer-tools">
          <ComposerAttach
            client={client} mode={session.conversationMode} hasSession
            selectedRefs={sources} conversationRefs={conversationRefs} recentRefs={recentRefs}
            /* 助手档与只读档没有资料：把勾选入口一并收起，一级行才会保持禁用并给出原因。 */
            onToggleSourceRef={!assistantMode && !readonlyMode ? onToggleSourceRef : undefined}
            skillSelected={selectedSkill !== null}
            onCommand={() => { setDraft(draft.startsWith("/") ? draft : `/${draft}`);
              composerBoxRef.current?.querySelector("textarea")?.focus(); }}
            onPickCommand={(name) => { setDraft(`${draft.match(/^\s*/u)?.[0] ?? ""}/${name} `);
              composerBoxRef.current?.querySelector("textarea")?.focus(); }}
            onPickPlugin={(label) => { setDraft(insertPluginMention(draft, label, draftRef.current));
              draftRef.current?.focus(); }}
            onUploadAttachments={(files) => { stagedSession.add(files); draftRef.current?.focus(); }}
            uploadDisabled={pending !== null || busy || uploadingAttachments}
            workspace={session.projectId === null || session.context?.workingDirectory === null ||
              session.context?.workingDirectory === undefined ? null
              : { projectId: session.projectId,
                resourceId: session.context.workingDirectory.resourceId,
                displayName: session.context.workingDirectory.canonicalRoot
                  ?.replace(/[\\/]+$/u, "").split(/[\\/]/u).at(-1) ?? "工作目录" }}
            artifactTaskId={session.taskId}
            onInsertMention={(label) => { setDraft(insertMention(draft, label, draftRef.current));
              draftRef.current?.focus(); }}
            /* 「+」二级里的两个入口都开同一枚合体浮层（2026-10-24 合并）：检索项目资料与
               选择 Skill 分别是这片浮层的下节与上节，入口合一后不再有两颗芯片可分别打开。 */
            onSources={!assistantMode && !readonlyMode ? () => setSendOptionsOpen(true) : undefined}
            onSkill={!assistantMode && !readonlyMode ? () => setSendOptionsOpen(true) : undefined}
            projectId={session.projectId}
            skills={assistantMode || readonlyMode ? undefined : skills}
            /* 会话归属已冻结：缺上下文的 Skill 只标注不可选，不在本面板里「补工作对象」。 */
            skillContext={assistantMode || readonlyMode ? null
              : { projectId: session.projectId, taskId: session.taskId, resolveInPlace: false }}
            selectedSkillKey={selectedSkillKey}
            onPickSkill={(key) => { setSelectedSkillKey(key); setSkillInputText(""); }}
            notes={[
              ...(assistantMode || readonlyMode ? [{ text: assistantMode
                ? "助手档没有资料与 Skill" : "只读会话不能选资料与 Skill", keys: ["sources", "skill"] }] : []),
            ]} />
          {/* 会话档：档位属于「项目 × 这个目录」，所以只在智能体档、会话有项目归属时出现；
              只读会话不写文件，不摆一颗点了没用的芯片。档位同源上报给上方状态行。 */}
          {!assistantMode && !readonlyMode && <WritePermissionControl client={client}
            projectId={session.projectId}
            resourceId={session.context?.workingDirectory?.resourceId ?? null}
            canonicalRoot={session.context?.workingDirectory?.canonicalRoot ?? null}
            disabled={busy || pending !== null || writeBlockedReason !== null}
            onTier={setSessionWriteTier} />}
          {/* 0127 / DEV-0105：聊天行为模式只显示当前状态，不再摆下拉框（入口在「+ → 命令」
              与 `/plan`、`/goal` 命令里）。普通模式不占位；计划/目标模式显示徽标与「退出」。 */}
          <ChatModeSwitch mode={session.chatMode} busy={busy || pending !== null}
            disabled={externalReadBlockedReason !== null}
            lockedReason={null}
            onChange={(next) => {
              if (next === session.chatMode) return;
              if (composerInflight) { setActionError("当前消息仍在生成，请先停止并等结算后再切换模式。"); return; }
              void runAction({ kind: "chatMode", commandId: createCommandId(), mode: next });
            }} />
          {modeSwitch}
          {/* 润色键与资料同一行（原型 #polishBtn 的位置）：同一键位三态，不另起一行。 */}
          <ComposerPolishButton assist={assistant} />
          {/* 助手档没有 intent 与 Skill 可选：隐藏「发送选项」而不是渲染成禁用，
              让「这一档没有这条选择」本身可见。2026-10-24 起这枚芯片同时是资料入口
              （合体浮层下节），助手档/只读档服务端对 skill_ref 与资料选择另有约束，
              因此整枚隐藏，不摆一颗点了没用的芯片。 */}
          {readonlyMode || sendOptionsPopup}
        </div>
        {/* 工具行右端一组（2026-10-20 用户指令「上下文和模型下拉按钮整体移动到发送按钮的左边」）：
            上下文计量环与模型下拉收在发送键左边，两枚同进同退，窄栏换行时不拆开；与首条输入器同位。 */}
        <div className="agent-chat-composer-tail">
          <ContextMeter ratio={contextRatio} hitRate={cacheHitRate} call={lastCall} limit={callLimit} />
          <ModelSelector client={client} open={modelPickerOpen} onOpenChange={setModelPickerOpen}
            sessionId={session.id}
            selectedModel={selectedModel} disabled={busy || pending !== null || writeBlockedReason !== null}
            onChoose={(model) => {
              // 会话级选择仍走原命令落服务端（唯一事实）；同时记住到本机偏好，
              // 下一个新对话的芯片初始就是它（2026-10-20 用户指令）。
              writeLastModel(client.workspaceId, model);
              void runAction({ kind: "model", commandId: createCommandId(), model });
            }} />
        </div>
        {/* 主按钮二态：位置与配色不动，只在有 RUNNING 回复时把字形换成停止方块。
            形状参考 deepseek-harness InputBar 的 rect x=3 y=3 10×10 rx=3，与圆角键同心。 */}
        {stoppableMessage !== null || stopPending ? <button key="stop" className="primary-button agent-chat-send"
          data-testid="assist-stop" type="button" data-state={stopPending ? "stopping" : "stoppable"}
          data-busy={!stopPending && (busy || pending !== null) ? "true" : undefined}
          aria-label={stopPending ? "正在停止生成" : "停止生成"} aria-keyshortcuts="Escape Escape"
          title={stopPending ? "正在停止，等待生成安全结束" : "停止生成 · 连按两次 Esc"}
          disabled={stopPending || busy || pending !== null || writeBlockedReason !== null}
          onClick={() => { if (stoppableMessage !== null)
            void runAction({ kind: "cancel", id: stoppableMessage.id, commandId: createCommandId() }); }}>
          <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <rect x="3" y="3" width="10" height="10" rx="3" fill="currentColor" /></svg>
        </button> : <button key="send" className="primary-button agent-chat-send" data-testid="assist-send" type="submit" form={composerFormId}
          data-busy={busy || pending !== null ? "true" : undefined}
          aria-label={busy ? `正在提交 · ${sendLabel}` : sendLabel} title={sendLabel}
          disabled={(!draft.trim() && stagedSession.items.length === 0) || pending !== null || busy ||
            uploadingAttachments || writeBlockedReason !== null || Boolean(selectedSkillKey && !selectedSkill) ||
            Boolean(selectedSkill && (!selectedSkill.callSupported || selectedSkill.missingCapabilities.length > 0))}><ArrowUp aria-hidden="true" /></button>}
      </div>}
      {!standalone && !readonlyMode && sendOptionsExpanded}
    </div>}
    {/* 卡外说明区（2026-10-16 用户指令「这些都导致输入框变化了」）：档位说明、在途锁定原因与
        命令回执都渲染在输入卡之外，卡内恒定只有正文、工具行与发送键——卡片在空闲、在途、
        收到回执与各档下形状一致，打字时光标与工具行不跳。
        2026-10-17 追加（用户指认执行中「不要弹出这个东西，整个布局都被他打乱了」）：这一列在
        空闲与在途之间不再增减可见行——锁定原因转为视觉隐藏（AT 仍可读，title 在禁用的模式盒上），
        模型调用信息移入最近一条 AI 回复的消息行。执行时输入卡与它下方的列形状恒定。 */}
    {session.status === "ACTIVE" && <>
      {modeHints}
      {/* 0127：模式说明只在非普通模式出现一行（CHAT 返回 null），不常驻占高。
          停止中的目标按服务端目标状态投影（DEV-0105 退回项修复）：PAUSING/CANCELLING
          说明安全停止，不按会话模式宣称停下后进入哪一档——切走 GOAL 时会话模式已先落定。 */}
      <ChatModeHint mode={session.chatMode}
        goalStatus={goalView?.goal?.status === "PAUSING" || goalView?.goal?.status === "CANCELLING"
          ? goalView.goal.status : null} />
      {notice && <Toast testId="assist-receipt-notice">{notice}</Toast>}
    </>}
    {actionError && !pendingUnresolved && <Notice testId="assist-action-error">{actionError}</Notice>}
    {pending && pendingUnresolved && <UnresolvedCommandStrip testId="assist-pending"
      className="assist-pending unresolved-command-strip" busy={busy} label="命令结果待核对。"
      onOpen={() => setPendingDialogOpen(true)} />}
    <UnresolvedCommandDialog open={pending !== null && pendingDialogOpen} testId="assist-pending"
      title="命令结果待核对"
      summary="这次命令没有拿到回执。先查询原命令回执；查不到时按原命令重试。"
      commandId={pending?.commandId ?? ""}
      detail="先查回执；未找到时只能用原命令 ID 和原载荷重试。核对前不重复提交，也不换命令 ID。"
      reason={actionError}
      busy={busy} checkLabel="查询原命令回执" retryLabel="以原命令重试"
      onCheck={() => void checkReceipt()}
      onRetry={() => { if (pending !== null) void runAction(pending, true); }}
      onClose={() => setPendingDialogOpen(false)} />
    {!readonlyMode && !externalReadBlockedReason && !embedded && !standalone && proposalPanel}
  </section>;
}
