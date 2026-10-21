import type { DecimalRevision } from "../../types";
import type { RelayGatewayDecision, RelayWriteTier } from "./gateway";
import type { RelayModelVerifyErrorCategory } from "./information";

export interface RelayAssistSourceRef {
  readonly kind: "KNOWLEDGE" | "MEMORY" | "DECISION";
  readonly rootId: string;
  readonly version: DecimalRevision;
}

/** 会话身份在建立时冻结；切换模式等于换会话，不在会话中途改写。 */
export type RelayConversationMode = "AGENT" | "ASSISTANT" | "LEARNING";

/** 0127：会话行为模式（不改变身份与权限）。 */
export type RelayChatMode = "CHAT" | "PLAN" | "GOAL";

/**
 * 人设助手配置（ADR-018、命令契约 §10.60）。
 *
 * 这里只有配置文本：能力、连接与权限不出现在这个类型里，助手能读什么由当前连接与
 * Gateway 准入决定。`readScope` 只能缩小受管根。
 */
export interface RelayAssistantProfile {
  readonly id: string;
  readonly name: string;
  readonly roleDescription: string;
  readonly tone: string | null;
  readonly readScope: Readonly<Record<string, unknown>>;
  readonly status: "ACTIVE" | "ARCHIVED";
  readonly revision: DecimalRevision;
  /** 下拉里的选项文案；归档项带「已归档」，让界面能如实说明它已冻结。 */
  readonly optionLabel: string;
}

export interface RelayAssistSession {
  readonly id: string;
  readonly projectId: string | null;
  readonly taskId: string | null;
  readonly title: string;
  readonly status: string;
  /**
   * 置顶时刻（0090）。null 表示未置顶；缺字段只来自 0090 之前的响应，同样读成未置顶。
   *
   * 它是**导航排序键**，不是业务事实：归档与否、能不能发消息、绑哪个目录都不看这一列。
   */
  readonly pinnedAt: string | null;
  /**
   * 未读标记时刻（0104）。null = 已读；缺字段只来自 0104 之前的响应，同样读成已读。
   *
   * 它和置顶一样只是**导航标记**：不改变能不能发消息、绑哪个目录，也不参与列表排序。
   */
  readonly unreadAt: string | null;
  /**
   * 最后一条消息落库或生成结算的时刻（0111）。null = 这段会话还没有消息。
   *
   * 它和置顶一样只是**导航排序键**，不是业务事实：左栏按 `lastMessageAt ?? createdAt`
   * 倒序排，与列表读法的 `coalesce(last_message_at, created_at)` 同一口径。缺字段只来自
   * 0111 之前的响应，同样读成「还没有消息」，回落到创建时间。
   */
  readonly lastMessageAt: string | null;
  readonly revision: DecimalRevision;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly conversationMode: RelayConversationMode;
  /**
   * 行为模式（0127）：普通讨论 / 只读规划 / 持续目标。
   *
   * 与会话身份分开：身份在建会话时冻结，模式可随命令切换。界面只读这一个字段决定
   * 显示哪种模式，不在本地保存运行状态——刷新与会话重开都按服务端读回。
   */
  readonly chatMode: RelayChatMode;
  readonly assistantProfileId: string | null;
  /** 建会话时冻结的助手修订；普通会话恒为 null。 */
  readonly assistantProfileRevision: DecimalRevision | null;
  /** 消息行上的角色标签；普通会话为 null。 */
  readonly personaLabel: string | null;
  /** 「一次性问答」：false 时该轮不作为可续读历史。 */
  readonly remember: boolean;
  /**
   * 本会话当前绑定的受管工作目录；未绑定为 null。
   *
   * 0087 起这是**服务端事实**，不是组件里那份目录状态：普通 Agent 的读取动作按这一列
   * 解析目标，刷新或换设备不会丢。它是作用域，不是准入——读到读不到仍由服务端按连接与
   * 权限判定，界面不得据此显示「已获读取权限」。
   */
  readonly workingResourceId: string | null;
  /** 只读导航依据；Goal 经项目关联，不代表会话直接绑定或获得目录权限。 */
  readonly context?: {
    readonly projectGoals: readonly { readonly goalId: string; readonly title: string }[];
    readonly workingDirectory: { readonly resourceId: string; readonly canonicalRoot: string | null;
      /** 作用域来源（运行架构 §2.8）。null＝历史未知，不得据此编造来源。 */
      readonly source: RelayWorkingDirectorySource | null } | null;
  };
}

/**
 * 会话工作目录的来源（0117 / 运行架构 §2.8）。
 *
 * `USER_PICKED`＝用户在这段会话里当场选过目录；`WORKSPACE_DEFAULT`＝创建时由服务端
 * 继承设置里的默认目录。它是**作用域**的来源说明，不是权限：两种来源的读写准入
 * 仍由连接、策略与目录档位判定。
 */
export type RelayWorkingDirectorySource = "USER_PICKED" | "WORKSPACE_DEFAULT";

export type RelayWorkspaceDefaultDirectoryStatus = "UNSET" | "READY" | "UNAVAILABLE";

/**
 * Workspace 默认工作目录的只读投影（HTTP §10.96）。
 *
 * 无配置时 `revision` 为 "0"，其余字段为 null；`UNAVAILABLE` 是「配置存在但当前
 * 不可用」，与 `UNSET` 不是同一件事——界面必须分开显示，不能把它读成「没设置」。
 * `write_tier` 只是该目录现状，配置默认目录不授予任何写能力。
 */
export interface RelayWorkspaceDefaultDirectory {
  readonly resourceId: string | null;
  readonly canonicalRoot: string | null;
  readonly displayName: string | null;
  readonly writeTier: RelayWriteTier | null;
  readonly status: RelayWorkspaceDefaultDirectoryStatus;
  readonly reason: string | null;
  readonly revision: DecimalRevision;
}

/** 设置/清除默认目录的回执结果：只改这一条 Workspace 配置事实。 */
export interface RelayWorkspaceDefaultDirectoryResult {
  readonly workspaceId: string;
  readonly resourceId: string | null;
  readonly revision: DecimalRevision;
}

/**
 * 归入项目的回执：只有会话身份、项目归属与确切修订。
 *
 * 这里刻意**不含任何执行权字段**：绑定只改 project_id，目录是否就绪、
 * 文件写入身份与命令执行准入仍由各自的服务端入口判定。
 * 目录身份是本地事实，与这条服务端事实不是一回事，因此这个类型里没有它的位置。
 */
export interface RelayAssistSessionBinding {
  readonly sessionId: string;
  readonly projectId: string;
  readonly revision: DecimalRevision;
}

/**
 * 绑定工作目录的回执：只有会话身份、受管资源身份与确切修订。
 *
 * 与归属回执同样**不含任何执行权字段**：目录绑定只确定「这次读哪个目录」，
 * 能不能读、能不能写仍由服务端按连接与权限逐次判定。
 */
export interface RelayAssistSessionDirectoryBinding {
  readonly sessionId: string;
  readonly workingResourceId: string;
  readonly revision: DecimalRevision;
}

/**
 * 会话行内控制的回执（0090）。改名/置顶/归档/重开各自只回它真正改过的那一项。
 *
 * 三条回执都只带会话身份、修订与更新时间，**不含任何执行权字段**：置顶只是排序键，
 * 归档只是不再接收新消息，都不改变这条会话能不能读目录、能不能写文件。
 */
export interface RelayAssistSessionTitle {
  readonly sessionId: string;
  readonly title: string;
  readonly revision: DecimalRevision;
  readonly updatedAt: string;
}

export interface RelayAssistSessionPin {
  readonly sessionId: string;
  readonly pinned: boolean;
  readonly pinnedAt: string | null;
  readonly revision: DecimalRevision;
  readonly updatedAt: string;
}

/** 未读回执（0104）：与置顶同一条形状，`unread` 是本次提交后的状态。 */
export interface RelayAssistSessionUnread {
  readonly sessionId: string;
  readonly unread: boolean;
  readonly unreadAt: string | null;
  readonly revision: DecimalRevision;
  readonly updatedAt: string;
}

export interface RelayAssistSessionState {
  readonly sessionId: string;
  readonly status: string;
  readonly revision: DecimalRevision;
  readonly updatedAt: string;
}

/**
 * 删除回执（ADR-027）：`revision` 是删除前核对过的那个修订；会话行已不存在，
 * 因此回执没有 status、updatedAt 或标题。删除不可撤销，客户端不得据此提供恢复入口。
 */
export interface RelayAssistSessionDelete {
  readonly sessionId: string;
  readonly revision: DecimalRevision;
  readonly deletedMessages: number;
  readonly deletedAttachments: number;
  readonly deletedAt: string;
}

/**
 * 分叉回执（0113）。
 *
 * 与上面几条不同：`sessionId` 是**新建的子会话**，不是命令目标那条源会话——源会话一行都没改。
 * 界面据此把左栏刷新后定位到新会话，标题里的「（1）」由服务端决定，客户端不自己拼编号。
 * `copiedMessages` 为 0 只说明这段讨论还没有可搬的历史，不是失败。
 */
export interface RelayAssistSessionFork {
  readonly sessionId: string;
  readonly title: string;
  readonly revision: DecimalRevision;
  readonly updatedAt: string;
  readonly copiedMessages: number;
}

/** 文件夹入口的结果：目录是当前工作目录，不是新 Workspace，也不隐含任何权限。 */
export interface RelayWorkingDirectoryCandidate {
  readonly projectId: string;
  readonly projectTitle: string;
  readonly projectArchived: boolean;
  readonly resourceId: string;
  readonly resourceStatus: string;
  readonly fileWriteIdentityBound: boolean;
}

export interface RelayWorkingDirectory {
  readonly canonicalRoot: string;
  readonly displayName: string;
  readonly status: "READY" | "AMBIGUOUS" | "NOT_READY";
  readonly reason: string | null;
  readonly association: RelayWorkingDirectoryCandidate | null;
  readonly createdProject: boolean;
  readonly createdResource: boolean;
  readonly candidates: readonly RelayWorkingDirectoryCandidate[];
  /**
   * Git 只读投影（2026-10-20，P1-3）。缺字段（旧服务端/旧回执）落为 null，表示「未核对」，
   * 不能当成「不是仓库」——两者的下一步完全不同。
   */
  readonly gitRead: { readonly state: string; readonly repoRoot: string | null;
    readonly detail: string } | null;
  /**
   * 写档位以服务端投影为准：policyDecision 是该目录上 APPLY_CHANGESET 的生效策略档位
   * （排序已在准入同一处完成，界面不再自己判定）；policyId / policyRevision 是改档位
   * 需要的乐观锁坐标。旧回执里没有这组字段，一律为 null，表示「未核对」而不是「未授权」。
   */
  readonly writeReadiness: { readonly status: string; readonly detail: string;
    readonly policyDecision: RelayGatewayDecision | null;
    readonly policyId: string | null; readonly policyRevision: string | null;
    readonly policyTargetPrefix: string | null;
    readonly writeTier: RelayWriteTier | null;
    readonly accessRevision: string };
}

/** 一次 Run 的工具调用轨迹（GET /runs/{id}/tool-calls）。
 *  arguments 与 resultRef 是服务端原样透出的有界内容，不是这里整理过的摘要：
 * 界面展示的必须与模型当时读到的是同一份，才能对账。 */
export type RelayToolCallStatus = "REQUESTED" | "PREPARED" | "WAITING_APPROVAL" | "SETTLED" | "REJECTED" | "ABANDONED";

export interface RelayRunToolCall {
  /** 行身份，同时是该行 logical_operations 的 id（未派发行除外）。用作 React key。 */
  readonly id: string;
  readonly round: number;
  readonly ordinal: number;
  readonly toolName: string;
  readonly status: RelayToolCallStatus;
  readonly args: Readonly<Record<string, unknown>>;
  readonly argsSha256: string;
  /** Provider 的轮内标签，跨 Run 可重名，因此不得用作 key。 */
  readonly providerToolCallId: string;
  readonly operationId: string | null;
  readonly adaptationOf: string | null;
  readonly adaptedPath: string | null;
  readonly resultRef: Readonly<Record<string, unknown>> | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** 写类工具的逐文件结算账本（工作台 §34.2）；无可核对证据时为空数组。 */
  readonly fileChanges: readonly RelayRunToolCallFileChange[];
}

/**
 * 写类工具里单个文件的结算账本：`status` 来自适配器回执，
 * `added`/`removed` 来自冻结的两份文本，-1 表示待核对。
 */
export interface RelayRunToolCallFileChange {
  readonly path: string;
  readonly action: "CREATE" | "MODIFY" | "DELETE";
  readonly status: "APPLIED" | "CONFLICT" | "FAILED" | "UNKNOWN";
  readonly added: number;
  readonly removed: number;
  readonly unavailableReason: string | null;
}

export interface RelayRunToolCalls {
  readonly runId: string;
  readonly runStatus: string;
  readonly waitReason: string | null;
  readonly rounds: readonly {
    readonly round: number;
    readonly modelCallId: string;
    readonly calls: readonly RelayRunToolCall[];
  }[];
}

/**
 * 会话工具轮次（GET /assist-sessions/{id}/messages/{message_id}/tool-calls，工作台 §18.10）。
 *
 * 与 Run 轨迹刻意分成两套类型：两张表、两种身份，会话轮次没有 Task 也没有 Run，
 * 而且词表不同——会话侧会给出 `UNKNOWN`（结果未知、等人工核对），不会给出 Run 侧的
 * `PREPARED` / `WAITING_APPROVAL`。`args` 是服务端原样透出的那一份，界面自己算一行摘要。
 */
export type RelaySessionToolCallStatus = "REQUESTED" | "SETTLED" | "REJECTED" | "ABANDONED" | "UNKNOWN";

export interface RelaySessionToolCall {
  readonly id: string;
  readonly round: number;
  readonly ordinal: number;
  readonly toolName: string;
  readonly status: RelaySessionToolCallStatus;
  readonly args: Readonly<Record<string, unknown>>;
  /** 派发前被拒或被放弃时的确切原因；其余状态为 null。 */
  readonly rejectionReason: string | null;
  readonly rejectionDetail: string | null;
  readonly requestedAt: string;
  readonly settledAt: string | null;
}

export interface RelaySessionToolCalls {
  readonly sessionId: string;
  readonly messageId: string;
  readonly messageStatus: string;
  readonly rounds: readonly {
    readonly round: number;
    readonly calls: readonly RelaySessionToolCall[];
  }[];
}

/**
 * 生成中的工具预览（工作台 §34.4）：可丢弃的临时证据，不进入总数。
 * `added`/`removed` 为 -1 表示待核对。
 */
export interface RelayRunToolCallPreviewFile {
  readonly path: string;
  readonly action: "CREATE" | "MODIFY" | "DELETE" | "UNKNOWN";
  readonly added: number;
  readonly removed: number;
  readonly targetComplete: boolean;
}

export interface RelayRunToolCallPreview {
  readonly modelCallId: string;
  readonly ordinal: number;
  readonly toolName: string;
  readonly revision: string;
  readonly truncated: boolean;
  readonly updatedAt: string;
  readonly files: readonly RelayRunToolCallPreviewFile[];
}

export interface RelayRunToolCallPreviews {
  readonly runId: string;
  readonly previews: readonly RelayRunToolCallPreview[];
}

/** 对话里的执行请求：原消息身份、模型整理出的候选摘要与阶段事实。 */
export interface RelayConversationCheck {
  readonly executable: string;
  readonly args: readonly string[];
}

/** 候选声明的文件动作：只描述意图，正文与基线仍由 Run 内读取后决定。 */
export interface RelayConversationCandidateFileChange {
  readonly path: string;
  readonly action: "CREATE" | "MODIFY" | "DELETE";
}

export interface RelayConversationExecution {
  readonly requestId: string;
  readonly sessionId: string;
  readonly sourceMessageId: string;
  readonly decision: string;
  readonly resourceId?: string;
  readonly status: string;
  readonly candidateStatus: string;
  readonly rootPath: string;
  readonly questions: readonly string[];
  readonly title?: string | null;
  readonly objective?: string | null;
  /**
   * 这次会真正执行的那一次检查，原样取自解释候选。
   *
   * 用户点确认前必须能看见它：候选正文是模型的自然语言解释，而执行的是这条命令。
   * 不显示就等于让用户在不知情下同意。准入判定在服务端，这里不做本地猜测。
   */
  readonly check?: RelayConversationCheck | null;
  /**
   * 候选声明的文件动作，供确认前看清将要新建 / 修改 / 删除哪些相对路径。
   * 旧服务端没有这个字段时为空数组，不据此推断「本次不改文件」。
   */
  readonly fileChanges: readonly RelayConversationCandidateFileChange[];
  /**
   * 服务端已判定这次是明确的只读执行请求（无写意图、候选就绪）。
   *
   * 客户端不自己判断「这次是不是只读」：同一判定必须只存在于服务端那条与实际授予工具集
   * 同源的规则里，两处各写一遍就会各自漂移。缺失（旧投影）按 false 处理——那等于退回
   * 保留一次确认，是保守方向。
   */
  readonly autoStart?: boolean | undefined;
  readonly taskId: string | null;
  readonly runId: string | null;
  readonly revision: DecimalRevision;
}

export interface RelayConversationExecutionStage {
  readonly requestId: string;
  readonly status: string;
  readonly taskId: string | null;
  readonly runId: string | null;
  readonly revision: DecimalRevision;
}

export interface RelaySkillDefinition {
  readonly id: string;
  readonly version: string;
  readonly sha256: string;
  readonly title: string;
  readonly target: "PROJECT" | "TASK";
  readonly outputKind: "TASK_DEFINITION_SUGGESTION" | "PROJECT_RESUME" | "VERIFICATION_PLAN_SUGGESTION" |
    "PROJECT_BLUEPRINT_SUGGESTION";
  readonly availability: "CALLABLE_SUGGESTION_ONLY" | "CALLABLE_READ_ONLY" | "HISTORICAL_ONLY";
  readonly callSupported: boolean;
  readonly requiredCapabilities: readonly string[];
  readonly missingCapabilities: readonly string[];
  readonly acceptSupported: boolean;
  readonly dependencies: readonly { readonly kind: string; readonly id: string;
    readonly version: string; readonly sha256: string }[];
}

export interface RelayPackDefinition {
  readonly id: string;
  readonly version: string;
  readonly sha256: string;
  readonly title: string;
  readonly hostContract: string;
  readonly availability: string;
  readonly members: readonly { readonly kind: "SKILL"; readonly id: string;
    readonly version: string; readonly sha256: string; readonly target: "PROJECT" | "TASK";
    readonly availability: string; readonly requiredCapabilities: readonly string[];
    readonly missingCapabilities: readonly string[]; readonly acceptSupported: boolean }[];
}

export type RelaySkillInput = { readonly desired_result?: string } |
  { readonly focus?: string } | { readonly risk_focus?: string } |
  { readonly desired_outcome?: string; readonly goal_id?: string | null;
    readonly pack_ref?: { readonly id: string; readonly version: string } | null };

export interface RelayAssistSkillOutput {
  readonly kind: RelaySkillDefinition["outputKind"];
  readonly status: "SUGGESTED" | "READ_ONLY";
  readonly targetKind: "PROJECT" | "TASK";
  readonly targetId: string;
  readonly asOf: string;
  readonly baseline: Readonly<Record<string, unknown>>;
  readonly basisSha256: string;
  readonly payloadSha256: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface RelayAssistMessage {
  readonly id: string;
  readonly sessionId: string;
  readonly seq: DecimalRevision;
  readonly role: "USER" | "ASSISTANT";
  readonly status: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
  /** 服务端既有字段，用于对话流的日期分隔线与消息时间；缺失只影响展示，不影响消息内容。 */
  readonly createdAt: string | null;
  /** 服务端写入时间：终态消息上等于结算时刻，在途时是心跳，不能当作执行起点。 */
  readonly updatedAt: string | null;
  readonly intent: string;
  readonly content: string | null;
  readonly errorCode: string | null;
  readonly providerErrorKind: RelayModelVerifyErrorCategory | null;
  readonly sources: readonly { readonly sourceRef: string | null; readonly kind: string | null;
    readonly rootId: string | null; readonly version: string | null;
    readonly status: string; readonly reason: string | null;
    /** 0125：记忆来源是人工确认还是自动记住；非记忆来源为 null。 */
    readonly origin: "HUMAN_CONFIRMED" | "AUTO_CAPTURE" | null }[];
  readonly skill: ({ readonly id: string; readonly version: string; readonly sha256: string | null;
    readonly definitionAvailability: "AVAILABLE" | "HISTORICAL_ONLY" | "UNAVAILABLE";
    readonly outputAvailability: "PENDING" | "HISTORICAL_SNAPSHOT" | "NO_OUTPUT" | "UNAVAILABLE";
    readonly target: "PROJECT" | "TASK" | null; readonly availability: string | null;
    readonly missingCapabilities: readonly string[] }) | null;
  readonly skillInput: Readonly<Record<string, unknown>> | null;
  readonly skillOutput: RelayAssistSkillOutput | null;
  /** cache*Tokens 为 null 表示 Provider 未上报，不能读成 0。 */
  readonly usage: { readonly inputTokens: number | null; readonly outputTokens: number | null;
    readonly cacheReadTokens: number | null; readonly cacheCreationTokens: number | null };
  readonly cancelRequested: boolean;
  /**
   * 0122：这条排队消息已被请求「插话」到正在生成的那一轮。缺字段（旧服务端）
   * 读成 false——旧服务端没有这个动作，队列照旧按顺序回复。
   */
  readonly steerRequested: boolean;
  /**
   * 0093：随这条消息发送的图片附件元数据。缺字段（旧服务端）读成空数组——
   * 没有附件与「服务端不报附件」在展示上是同一件事，不能因此判整条响应非法。
   */
  readonly attachments: readonly RelayAssistMessageAttachment[];
}

/**
 * 0093：附件元数据（不含内容字节）。内容按单张另行读取，列表投影不带 bytea。
 */
export interface RelayAssistMessageAttachment {
  readonly id: string;
  readonly name: string;
  readonly mediaType: string;
  readonly byteLength: number;
}

/** 上传回执：附件身份，不改变任何业务状态（暂存行，随消息命令绑定）。 */
export interface RelayAssistMessageAttachmentUpload {
  readonly attachmentId: string;
  readonly byteLength: number;
  readonly contentHash: string;
}

/** 单张附件内容（历史消息缩略图）。 */
export interface RelayAssistMessageAttachmentContent {
  readonly attachmentId: string;
  readonly name: string;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly dataBase64: string;
}

export interface RelayAssistLivePreview {
  readonly sessionId: string;
  readonly messageId: string;
  readonly status: RelayAssistMessage["status"];
  readonly previewRevision: DecimalRevision;
  readonly previewText: string | null;
  readonly previewTruncated: boolean;
  readonly previewAvailable: boolean;
}

export interface RelayAssistProposalBase {
  readonly id: string;
  readonly sessionId: string;
  readonly messageId: string;
  readonly targetId: string;
  readonly baseRevision: DecimalRevision;
  readonly payloadHash: string;
  readonly payloadAvailable: boolean;
  readonly status: "PENDING" | "ACCEPTED" | "REJECTED" | "EXPIRED";
}

export type RelayTaskSkillProposal = RelayAssistProposalBase &
  { readonly kind: "TASK_CONTRACT_CHANGE" | "VERIFICATION_PLAN_CHANGE";
    readonly targetType: "TASK"; readonly baseAcceptanceRevision: DecimalRevision;
    readonly skillSha256: string; readonly skillOutputSha256: string;
    readonly payload: { readonly objective: string;
      readonly requiredOutputSpec: Readonly<Record<string, unknown>>;
      readonly criteria: readonly { readonly criterionId: string; readonly statement: string;
        readonly required: boolean; readonly method: string;
        readonly targetSpec: Readonly<Record<string, unknown>>;
        readonly source: "PRESERVED" | "SUGGESTED" }[];
      readonly addedCriterionIds: readonly string[];
      readonly preservedCriterionIds: readonly string[];
      readonly suggestedMode: string | null } | null };

export type RelayAssistProposal = RelayAssistProposalBase & (
  { readonly kind: "CANDIDATE_MARKDOWN"; readonly targetType: "TASK";
    readonly payload: { readonly title: string; readonly mediaType: string; readonly markdown: string } } |
  { readonly kind: "TASK_DEFINITION"; readonly targetType: "PROJECT";
    readonly payload: { readonly title: string; readonly objective: string;
      readonly criteria: readonly { readonly statement: string; readonly required: boolean;
        readonly method: string }[]; readonly expectedOutputs: Readonly<Record<string, unknown>> } }
) | RelayTaskSkillProposal;

/** 单文件净变化（工作台 §34 / 设计系统 §9.15）。局部 diff 与总数都来自同一套统计。 */
export type RelayConversationFileAction = "CREATE" | "MODIFY" | "DELETE" | "SAME";

export interface RelayConversationFileDiff {
  readonly path: string;
  readonly action: RelayConversationFileAction;
  readonly added: number;
  readonly removed: number;
  /** 二进制/超限/读取失败等不可统计原因；非 null 时该文件不计入总数。 */
  readonly unavailableReason: string | null;
}

/**
 * 会话总 diff 的只读投影：基线（本轮对话起点）到当前已落盘内容的净变化。
 *
 * 不可用（无目录 / 无基线 / 根非 git / 资源不可用）时只给原因，不给伪造的零值。
 */
export type RelayConversationDiffUnavailableReason =
  "NO_RESOURCE" | "NO_BASELINE" | "ROOT_NOT_GIT" | "RESOURCE_UNAVAILABLE";

/** 一侧扫描的覆盖情况：`complete=false` 时 `reason` 说明扫描停在哪里。 */
export interface RelayConversationDiffScanSide {
  readonly complete: boolean;
  readonly reason: string | null;
  /** 实际逐条核对到的文件数。 */
  readonly files: number;
  /** 本轮列到的文件总数；基线侧没有持久化清单，故为 null。 */
  readonly listed: number | null;
}

/**
 * 统计范围：`SESSION` 只算本会话写过的路径（对话入口用的就是这一档），
 * `DIRECTORY` 是整段目录净变化（含同期外部修改）。旧服务端不带这个字段时按 `DIRECTORY` 解析。
 */
export type RelayConversationDiffScope = "SESSION" | "DIRECTORY";

/**
 * 「不完整」的具体成因与条数。
 *
 * `uncheckedFiles` 是起点有、本轮没核对到的文件（不能算删除）；`unverifiedFiles` 是本轮有、
 * 起点没覆盖到且已被 Git 跟踪的文件（不能证明是本会话新增）；`unverifiableFiles` 是两侧都在、
 * 内容摘要读不到（超过单文件上限或采集时读失败）且字节数相同的文件（无法核对，不计变化）；
 * `unscannedFiles` 是会话口径下「本会话写过的路径两端都没扫到」的条数。
 * null 表示服务端未提供该投影。
 */
export interface RelayConversationDiffCoverage {
  readonly baseline: RelayConversationDiffScanSide;
  readonly current: RelayConversationDiffScanSide;
  readonly uncheckedFiles: number;
  readonly unverifiedFiles: number;
  readonly unverifiableFiles: number;
  readonly unscannedFiles: number;
}

export type RelayConversationDiff =
  | {
      readonly available: true;
      readonly scope: RelayConversationDiffScope;
      readonly baselineCapturedAt: string;
      readonly baselineRevision: DecimalRevision;
      readonly rootPath: string;
      readonly resourceId: string;
      readonly incomplete: boolean;
      readonly coverage: RelayConversationDiffCoverage | null;
      readonly totalFiles: number;
      readonly totalAdded: number;
      readonly totalRemoved: number;
      readonly files: readonly RelayConversationFileDiff[];
    }
  | {
      readonly available: false;
      readonly reason: "NO_RESOURCE" | "NO_BASELINE" | "ROOT_NOT_GIT" | "RESOURCE_UNAVAILABLE";
    };

/** 展开阅读的单文件正文行；行号在该侧不存在时为 null。 */
export interface RelayConversationDiffFileRow {
  readonly kind: "CONTEXT" | "ADD" | "REMOVE";
  readonly oldLine: number | null;
  readonly newLine: number | null;
  readonly text: string;
}

/**
 * 展开阅读的单文件完整 diff（工作台 §34.2）。行数与总数同源；
 * `rows` 为 null 时看 `rowsUnavailableReason`，不编造正文。
 */
export type RelayConversationDiffFile =
  | {
      readonly available: true;
      readonly path: string;
      readonly action: RelayConversationFileAction;
      readonly added: number;
      readonly removed: number;
      readonly unavailableReason: string | null;
      readonly rows: readonly RelayConversationDiffFileRow[] | null;
      readonly rowsTruncated: boolean;
      readonly rowsUnavailableReason: string | null;
    }
  | {
      readonly available: false;
      readonly reason: "NO_RESOURCE" | "NO_BASELINE" | "ROOT_NOT_GIT" | "RESOURCE_UNAVAILABLE" | "PATH_NOT_FOUND";
    };
