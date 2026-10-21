import type { DecimalRevision } from "../../types";

/** N03 项目知识导读只存确切引用与人工标签，不复制正文，也不维护第二份 revision。 */
export interface RelayKnowledgeGuideEntry {
  readonly ordinal: number;
  readonly refKind: "KNOWLEDGE" | "DECISION" | "RULE" | "ARTIFACT_VERSION";
  readonly referenceMode: "PINNED" | "CURRENT";
  readonly targetId: string;
  readonly label: string | null;
  readonly title: string | null;
  readonly resolvedVersionId: string | null;
  readonly resolvedVersionNumber: DecimalRevision | null;
  readonly targetStatus: string;
  readonly isCurrent: boolean;
  readonly resolution: "AVAILABLE" | "ARCHIVED" | "SUPERSEDED" | "STALE" | "CROSS_SCOPE" | "MISSING";
  readonly note: string;
}

export interface RelayProjectKnowledgeGuide {
  readonly projectId: string;
  /** 从未保存过导读时为 false，此时 entries 为空且 revision 为 "0"。 */
  readonly exists: boolean;
  readonly revision: DecimalRevision;
  readonly entryCount: number;
  readonly entries: readonly RelayKnowledgeGuideEntry[];
  readonly gaps: readonly string[];
}

/** 字段名与 API schema 一致（snake_case，schema 禁止 additionalProperties）。 */
export interface RelayKnowledgeGuideEntryInput {
  readonly ref_kind: RelayKnowledgeGuideEntry["refKind"];
  readonly reference_mode: RelayKnowledgeGuideEntry["referenceMode"];
  readonly knowledge_id?: string;
  readonly decision_id?: string;
  readonly rule_id?: string;
  readonly artifact_version_id?: string;
  readonly pinned_version_id?: string;
  readonly label?: string;
}

/** N03 整理候选只提示不合并；终态优先于缺口。 */
export interface RelayKnowledgeCurationCandidate {
  readonly id: string;
  readonly projectId: string;
  readonly sourceArtifactVersionId: string;
  readonly sourceArtifactId: string;
  readonly sourceVersionNumber: string;
  readonly sourceTitle: string;
  readonly suggestedTitle: string;
  readonly suggestedKnowledgeId: string | null;
  readonly suggestedKnowledgeTitle: string | null;
  readonly similar: readonly { readonly knowledgeId: string; readonly title: string;
    readonly status: string; readonly reason: string }[];
  readonly status: "PROPOSED" | "ACCEPTED" | "REJECTED" | "STALE";
  readonly acceptedKnowledgeId: string | null;
  readonly acceptedKnowledgeVersionId: string | null;
  readonly staleReason: string | null;
  readonly rejectedAt: string | null;
}

export interface RelayInterventionItem {
  readonly itemKey: string; readonly changeKey: string;
  readonly kind: "REVIEW" | "LOCK_CONFLICT" | "RUN_FAILED" | "UNKNOWN" | "SCHEDULED_TASK_BLOCKED";
  readonly title: string; readonly reason: string; readonly targetUrl: string;
}

/** 只读模型端口状态：密钥永不出现在此结构中。 */
/**
 * 当前聊天模型能否接受图片输入（2026-10-19）：与发送时的能力闸门同一份判定，
 * 输入框据此在粘贴图片时就给出说明。`UNKNOWN` 表示这次读不到模型目录（不是「不支持」）。
 */
export type RelayChatImageInput =
  | "NOT_CONFIGURED" | "SUPPORTED" | "DECLARED"
  | "MODEL_LACKS_IMAGE_INPUT" | "MODEL_NOT_IN_CATALOG" | "UNKNOWN";

/**
 * 这次图片输入结论来自哪一层（2026-10-19，迁移 0121）：模型目录 / 人的声明 / 环境变量 / 都没有。
 * 界面用它区分「目录说可以」与「你自己声明的」；旧服务端缺字段按 `NONE`。
 */
export type RelayChatImageInputSource = "CATALOG" | "DECLARED" | "ENV" | "NONE";

/**
 * 模型能力声明（2026-10-19，迁移 0121）：人对某个模型能力的主张，按 (provider, model) 存档。
 * 目录里有条目时目录仍是准绳，声明只补「目录里没有这个模型」这一处空白。
 */
export interface RelayModelCapabilityDeclaration {
  readonly provider: string;
  readonly sourceModelId: string;
  readonly imageInput: boolean;
  readonly note: string | null;
  readonly declaredAt: string;
  readonly updatedAt: string;
}

export interface RelayModelPortStatus {
  readonly provider: "fake" | "openai-compatible" | "invalid";
  readonly configured: boolean;
  readonly model: string | null;
  readonly baseUrl: string | null;
  /** 单次调用 token 上限：上下文占用的分母。null 表示不可核对，不能据此算比例。 */
  readonly maxCallTokens: number | null;
  readonly imageInput: RelayChatImageInput;
  readonly imageInputSource: RelayChatImageInputSource;
}

/** 验证错误分类：与设置页指引一一对应。 */
export type RelayModelVerifyErrorCategory =
  | "AUTH" | "RATE_LIMIT" | "TIMEOUT" | "STREAM_BROKEN" | "PROTOCOL" | "NETWORK";

/** 一次验证结果：永不包含密钥。 */
export interface RelayModelVerifyResult {
  readonly ok: boolean;
  readonly latencyMs: number | null;
  readonly provider: string;
  readonly model: string;
  readonly configFingerprint: string;
  readonly errorCategory: RelayModelVerifyErrorCategory | null;
  readonly verifiedAt: string;
}

/** 最近一次验证 + 当前配置指纹匹配情况。 */
export interface RelayModelVerificationState {
  readonly currentConfigFingerprint: string | null;
  readonly last: RelayModelVerifyResult | null;
  readonly matchesCurrentConfig: boolean;
  /** API 进程环境的启动校验；不代表 Worker 进程已被探测。 */
  readonly workerStartupValidation: "NOT_CONFIGURED" | "OK" | "FAILED";
}

export type RelayInformationKind = "KNOWLEDGE" | "MEMORY" | "DECISION" | "RULE";

export type RelayKnowledgeSource = "NOTE" | "MANAGED_TEXT" | "ARTIFACT_VERSION" | "WEB_PAGE";

export type RelayRuleStrength = "HARD" | "PREFERENCE";

export type RelayRuleEnforcement = "PRE_ACTION" | "POST_CHECK" | "SEMANTIC" | "HUMAN";

export interface RelayKnowledge {
  readonly id: string;
  readonly projectId: string | null;
  readonly title: string;
  readonly status: string;
  readonly revision: DecimalRevision;
  readonly currentVersion: DecimalRevision;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RelayKnowledgeVersion {
  readonly id: string;
  readonly knowledgeId: string;
  readonly version: DecimalRevision;
  readonly sourceKind: RelayKnowledgeSource;
  readonly mediaType: string;
  readonly contentSha256: string;
  readonly availability: string;
  readonly excerpt: string | null;
  readonly sourceRefs: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

export interface RelayKnowledgeVersionContent extends Omit<RelayKnowledgeVersion, "excerpt"> {
  readonly title: string;
  readonly projectId: string | null;
  readonly currentVersion: DecimalRevision;
  readonly sourceUri: string | null;
  readonly contentStatus: "FULL" | "PARTIAL" | "UNAVAILABLE" | "UNSUPPORTED" | "READ_FAILED";
  readonly content: string | null;
}

/**
 * 长期记忆的只读有效状态：由服务端在同一次快照里按数据库时间判定。
 *
 * 它是投影而不是可写状态：EXPIRED 不能当作命令状态提交，续期必须走 AddMemoryRevision。
 */
export type RelayMemoryEffectiveStatus = "ACTIVE" | "EXPIRED" | "RETIRED";

export type RelayMemoryOrigin = "HUMAN_CONFIRMED" | "AUTO_CAPTURE";

/** DEV-0042：记忆条目的来源类别——内容来自谁的哪一段。旧服务端缺字段时按 UNKNOWN 读。 */
export type RelayMemorySourceKind = "MANUAL" | "USER_STATEMENT" | "MODEL_OBSERVATION" | "UNKNOWN";

export interface RelayMemory {
  readonly id: string;
  readonly projectId: string | null;
  readonly title: string;
  /** 0125：人工确认还是结算后自动记住。旧服务端缺字段时按人工确认读。 */
  readonly origin: RelayMemoryOrigin;
  /**
   * DEV-0042：自动记住的条目里，哪一条是用户自己的话（USER_STATEMENT），
   * 哪一条只是模型叙述的观察（MODEL_OBSERVATION，可能含工具结果或网页正文的转述）。
   */
  readonly sourceKind: RelayMemorySourceKind;
  /** 原持久状态，仍只有 ACTIVE / RETIRED，用于停用与恢复命令。 */
  readonly status: string;
  /**
   * 服务端没有提供该字段（旧版本）时为 null：界面展示「状态待核对」，
   * 不能退回 `status === "ACTIVE"` 推断有效，也不按浏览器时钟推算到期。
   */
  readonly effectiveStatus: RelayMemoryEffectiveStatus | null;
  readonly revision: DecimalRevision;
  readonly currentVersion: DecimalRevision;
  readonly text: string;
  readonly confirmedBy: string;
  readonly confirmedAt: string;
  readonly expiresAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 历史修订保留当时的内容与有效期，不附加动态有效状态，也不随当前时间重新判定。 */
export interface RelayMemoryRevision {
  readonly id: string;
  readonly memoryId: string;
  readonly version: DecimalRevision;
  readonly title: string;
  readonly text: string;
  readonly confirmedBy: string;
  readonly confirmedAt: string;
  readonly expiresAt: string | null;
  readonly createdAt: string;
}

export interface RelayDecision {
  readonly id: string;
  readonly projectId: string | null;
  readonly title: string;
  readonly status: string;
  readonly revision: DecimalRevision;
  readonly currentVersion: DecimalRevision;
  readonly choice: string;
  readonly rationale: string;
  readonly alternatives: readonly string[];
  readonly costs: readonly string[];
  readonly supersededById: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RelayRule {
  readonly id: string;
  readonly scope: "WORKSPACE" | "PROJECT" | "TASK";
  readonly scopeId: string;
  readonly projectId: string | null;
  readonly taskId: string | null;
  readonly status: string;
  readonly revision: DecimalRevision;
  readonly currentVersion: DecimalRevision;
  readonly ruleKey: string;
  readonly statement: string;
  readonly strength: RelayRuleStrength;
  readonly applicability: string;
  readonly enforcement: RelayRuleEnforcement;
  readonly method: string | null;
  readonly targetSpec: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RelayRuleVersion {
  readonly ruleId: string;
  readonly version: DecimalRevision;
  readonly ruleKey: string;
  readonly statement: string;
  readonly strength: RelayRuleStrength;
  readonly applicability: string;
  readonly enforcement: RelayRuleEnforcement;
  readonly method: string | null;
  readonly targetSpec: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

export interface RelaySearchItem {
  readonly type: RelayInformationKind;
  readonly id: string;
  readonly version: DecimalRevision;
  readonly title: string;
  readonly snippet: string;
  readonly matchedFields: readonly string[];
  readonly sourceRef: string;
  readonly status: string;
  readonly projectId: string | null;
}

export interface RelaySearchPage {
  readonly items: readonly RelaySearchItem[];
  readonly nextCursor: string | null;
}
