import type { DecimalRevision } from "../../types";

/**
 * 长短期记忆（HTTP §10.99）的只读投影。
 *
 * 这一层只承载服务端已经裁决过的事实：哪些来源可用、摘要是否仍有效、整理到了哪一步，
 * 都不由前端按本地缓存或浏览器时钟推断。字段缺失一律按「无法核对」处理，不补默认值。
 */

/** Workspace 级配置：缺配置时服务端返回修订 0 与三个开关 true，GET 零写入。 */
export interface RelayMemorySettings {
  readonly workspaceId: string;
  readonly revision: DecimalRevision;
  readonly recallEnabled: boolean;
  readonly automaticCompaction: boolean;
  /** 0125：结算后自动提取长期记忆（ADR-030）。旧服务端不返回时按开启处理。 */
  readonly autoCapture: boolean;
}

/** 长期记忆的不可变保存来源；手工创建的记忆没有来源，这里就是空数组。 */
export interface RelayMemoryProvenanceSource {
  readonly memoryVersion: DecimalRevision;
  readonly sessionId: string;
  readonly messageId: string;
  readonly contentSha256: string;
}

export interface RelayMemoryProvenance {
  readonly memoryId: string;
  readonly sources: readonly RelayMemoryProvenanceSource[];
}

/**
 * 一次生成实际用到的来源身份。
 *
 * 失效来源由服务端刻意抹掉身份（只留 `status`），因此 `kind` 等字段在
 * `UNAVAILABLE` 时为 null；把它补成某个具体对象等于凭空造出使用记录。
 */
export interface RelayMemorySourceRef {
  readonly status: "AVAILABLE" | "UNAVAILABLE";
  readonly kind: "KNOWLEDGE" | "MEMORY" | "DECISION" | null;
  readonly rootId: string | null;
  readonly version: DecimalRevision | null;
  readonly sourceRef: string | null;
  readonly selection: "AUTO_MEMORY" | null;
  readonly selectionBasis: "LITERAL_MATCH" | "RECENT_CONFIRMED" | null;
  /** 0125：记忆来源是人工确认还是自动记住；非记忆来源为 null。 */
  readonly origin: "HUMAN_CONFIRMED" | "AUTO_CAPTURE" | null;
  /**
   * DEV-0042：记忆来源的类别——用户原话 / 模型观察 / 人工保存 / 来源未标注。
   * 非记忆来源为 null；旧来源缺字段按 UNKNOWN 读。
   */
  readonly sourceKind: "MANUAL" | "USER_STATEMENT" | "MODEL_OBSERVATION" | "UNKNOWN" | null;
}

export type RelayMemoryCompactionReason = "MANUAL" | "AUTO";
export type RelayMemoryCompactionStatus = "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";

/** 一条整理请求的公开状态；`cancelRequested` 与 `status` 分开，取消意图不等于已取消。 */
export interface RelayMemoryCompactionRequest {
  readonly id: string;
  readonly reason: RelayMemoryCompactionReason;
  readonly status: RelayMemoryCompactionStatus;
  readonly cancelRequested: boolean;
  readonly errorCode: string | null;
  readonly checkpointId: string | null;
  readonly modelCallId: string | null;
  readonly throughSeq: DecimalRevision;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 已提交的摘要检查点；`available=false` 时服务端不给摘要正文与足迹。 */
export interface RelaySessionMemoryCheckpoint {
  readonly id: string;
  readonly available: boolean;
  readonly throughSeq: DecimalRevision;
  readonly summary: string | null;
  readonly modelCallId: string | null;
  readonly createdAt: string;
  readonly sourceMessageIds: readonly string[];
  readonly sources: readonly RelayMemorySourceRef[];
}

/** 会话短期工作窗口：两种修订（窗口 / 会话）必须分开携带，不能混用。 */
export interface RelaySessionMemory {
  readonly sessionId: string;
  readonly sessionRevision: DecimalRevision;
  readonly revision: DecimalRevision;
  readonly remember: boolean;
  readonly clearedThroughSeq: DecimalRevision;
  readonly checkpoint: RelaySessionMemoryCheckpoint | null;
  readonly requests: readonly RelayMemoryCompactionRequest[];
}

/**
 * 一条消息的记忆使用足迹。
 *
 * `recorded=false` 表示这条消息根本没有采集记录——它不等于「没有使用记忆」；
 * `available=false` 表示采集过但来源已失效，内容不回显。
 */
export interface RelayMessageMemoryUse {
  readonly sessionId: string;
  readonly messageId: string;
  readonly recorded: boolean;
  readonly available: boolean;
  readonly checkpointId: string | null;
  readonly sources: readonly RelayMemorySourceRef[];
}

/** 清除 / 一次性开关的回执结果：两种修订分别返回，重读时按各自用途使用。 */
export interface RelaySessionMemoryResetResult {
  readonly sessionId: string;
  readonly revision: DecimalRevision;
  readonly sessionRevision: DecimalRevision;
  readonly remember: boolean;
  readonly clearedThroughSeq: DecimalRevision;
}

/** 从消息明确保存长期记忆的回执：新 Memory 的身份与版本。 */
export interface RelayMemoryCreatedFromMessage {
  readonly memoryId: string;
  readonly revision: DecimalRevision;
  readonly version: DecimalRevision;
  readonly status: string;
}

/** `/compact` 只表示受理：完成与否由会话窗口 GET 回答。 */
export interface RelayCompactAccepted {
  readonly sessionId: string;
  readonly requestId: string;
  readonly status: "PENDING";
}
