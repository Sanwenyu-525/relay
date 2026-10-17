import type { DecimalRevision } from "../../types";
import type { RelayGatewayDecision } from "./gateway";
import type { RelayModelVerifyErrorCategory } from "./information";

export interface RelayAssistSourceRef {
  readonly kind: "KNOWLEDGE" | "MEMORY" | "DECISION";
  readonly rootId: string;
  readonly version: DecimalRevision;
}

/** 会话身份在建立时冻结；切换模式等于换会话，不在会话中途改写。 */
export type RelayConversationMode = "AGENT" | "ASSISTANT" | "LEARNING";

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
  readonly revision: DecimalRevision;
  readonly updatedAt: string;
  readonly conversationMode: RelayConversationMode;
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
    readonly workingDirectory: { readonly resourceId: string; readonly canonicalRoot: string | null } | null;
  };
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
   * 写档位以服务端投影为准：policyDecision 是该目录上 APPLY_CHANGESET 的生效策略档位
   * （排序已在准入同一处完成，界面不再自己判定）；policyId / policyRevision 是改档位
   * 需要的乐观锁坐标。旧回执里没有这组字段，一律为 null，表示「未核对」而不是「未授权」。
   */
  readonly writeReadiness: { readonly status: string; readonly detail: string;
    readonly policyDecision: RelayGatewayDecision | null;
    readonly policyId: string | null; readonly policyRevision: string | null;
    readonly policyTargetPrefix: string | null };
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
  readonly intent: string;
  readonly content: string | null;
  readonly errorCode: string | null;
  readonly providerErrorKind: RelayModelVerifyErrorCategory | null;
  readonly sources: readonly { readonly sourceRef: string | null; readonly kind: string | null;
    readonly rootId: string | null; readonly version: string | null;
    readonly status: string; readonly reason: string | null }[];
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

export type RelayConversationDiff =
  | {
      readonly available: true;
      readonly baselineCapturedAt: string;
      readonly baselineRevision: DecimalRevision;
      readonly rootPath: string;
      readonly resourceId: string;
      readonly incomplete: boolean;
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
