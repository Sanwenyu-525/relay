import type { DecimalRevision } from "../../types";
import { RelayContractError } from "../core/errors";
import { array, boolean, decimal, nullableString, object, string } from "../core/primitives";
import type { RelayCompactAccepted, RelayMemoryCompactionRequest,
  RelayMemoryCreatedFromMessage, RelayMemoryProvenance,
  RelayMemoryProvenanceSource, RelayMemorySettings, RelayMemorySourceRef, RelayMessageMemoryUse,
  RelaySessionMemory, RelaySessionMemoryCheckpoint, RelaySessionMemoryResetResult } from "../dtos/memory";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const sha256Pattern = /^[0-9a-f]{64}$/u;

function uuid(record: Record<string, unknown>, key: string, name: string): string {
  const value = string(record, key, name);
  if (!uuidPattern.test(value)) throw new RelayContractError(`${name}.${key} 不是合法 UUID。`);
  return value;
}

function nullableUuid(record: Record<string, unknown>, key: string, name: string): string | null {
  const value = nullableString(record, key, name);
  if (value !== null && !uuidPattern.test(value)) throw new RelayContractError(`${name}.${key} 不是合法 UUID。`);
  return value;
}

function enumeration<T extends string>(record: Record<string, unknown>, key: string, name: string,
  allowed: readonly T[]): T {
  const value = string(record, key, name);
  if (!(allowed as readonly string[]).includes(value)) {
    throw new RelayContractError(`${name}.${key} 包含未知取值。`);
  }
  return value as T;
}

const sourceKinds = ["KNOWLEDGE", "MEMORY", "DECISION"] as const;
const selectionBases = ["LITERAL_MATCH", "RECENT_CONFIRMED"] as const;
const compactionReasons = ["MANUAL", "AUTO"] as const;
const compactionStatuses = ["PENDING", "RUNNING", "COMPLETED", "FAILED", "CANCELLED"] as const;

export function memorySettingsFrom(value: unknown): RelayMemorySettings {
  const row = object(value, "memory settings");
  return { workspaceId: uuid(row, "workspace_id", "memory settings"),
    revision: decimal(row, "revision", "memory settings"),
    recallEnabled: boolean(row, "recall_enabled", "memory settings"),
    automaticCompaction: boolean(row, "automatic_compaction", "memory settings"),
    // 0125 新增字段：旧服务端不返回时按开启处理——那时的服务端本来就没有自动捕获，
    // 显示「关闭」会让用户以为这项已经停用。
    autoCapture: row.auto_capture === undefined ? true : boolean(row, "auto_capture", "memory settings") };
}

/**
 * 来源身份。
 *
 * `AVAILABLE` 必须给全身份（种类、根、版本、可读引用）；`UNAVAILABLE` 只说明「这里原本有一个
 * 已失效的来源」，服务端已抹掉身份，客户端不得补造，也不得把它算成一条可用来源。
 */
export function memorySourceRefFrom(value: unknown): RelayMemorySourceRef {
  const row = object(value, "memory source");
  const status = string(row, "status", "memory source");
  if (status === "UNAVAILABLE") {
    return { status, kind: null, rootId: null, version: null, sourceRef: null,
      selection: null, selectionBasis: null, origin: null, sourceKind: null };
  }
  if (status !== "AVAILABLE") throw new RelayContractError("memory source.status 包含未知取值。");
  const selection = row.selection === undefined || row.selection === null ? null
    : enumeration(row, "selection", "memory source", ["AUTO_MEMORY"] as const);
  const selectionBasis = row.selection_basis === undefined || row.selection_basis === null ? null
    : enumeration(row, "selection_basis", "memory source", selectionBases);
  const kind = enumeration(row, "kind", "memory source", sourceKinds);
  // 0125：只有记忆有 origin；旧来源缺字段按人工确认读，非记忆来源保持 null。
  const origin = kind !== "MEMORY" ? null
    : row.origin === "AUTO_CAPTURE" ? "AUTO_CAPTURE" as const
      : row.origin === "HUMAN_CONFIRMED" || row.origin === undefined || row.origin === null
        ? "HUMAN_CONFIRMED" as const
        : (() => { throw new RelayContractError("memory source.origin 包含未知取值。"); })();
  // DEV-0042：来源类别同样只属于记忆；旧来源缺字段按 UNKNOWN 读，不当成用户原话。
  const sourceKind = kind !== "MEMORY" ? null
    : row.source_kind === "MANUAL" || row.source_kind === "USER_STATEMENT" ||
      row.source_kind === "MODEL_OBSERVATION" || row.source_kind === "UNKNOWN"
      ? row.source_kind
      : row.source_kind === undefined || row.source_kind === null
        ? "UNKNOWN" as const
        : (() => { throw new RelayContractError("memory source.source_kind 包含未知取值。"); })();
  return { status, kind,
    rootId: uuid(row, "root_id", "memory source"),
    version: decimal(row, "version", "memory source"),
    sourceRef: string(row, "source_ref", "memory source"),
    selection, selectionBasis, origin, sourceKind };
}

export function memoryProvenanceFrom(value: unknown, expectedMemoryId: string): RelayMemoryProvenance {
  const row = object(value, "memory provenance");
  const memoryId = uuid(row, "memory_id", "memory provenance");
  if (memoryId !== expectedMemoryId) throw new RelayContractError("记忆来源响应与所选记忆不一致。");
  return { memoryId, sources: array(row, "sources", "memory provenance").map((item) => {
    const source = object(item, "memory provenance source");
    const contentSha256 = string(source, "content_sha256", "memory provenance source");
    if (!sha256Pattern.test(contentSha256)) {
      throw new RelayContractError("memory provenance source.content_sha256 不是 64 位十六进制。");
    }
    const parsed: RelayMemoryProvenanceSource = {
      memoryVersion: decimal(source, "memory_version", "memory provenance source"),
      sessionId: uuid(source, "session_id", "memory provenance source"),
      messageId: uuid(source, "message_id", "memory provenance source"),
      contentSha256 };
    return parsed;
  }) };
}

function checkpointFrom(value: unknown): RelaySessionMemoryCheckpoint {
  const row = object(value, "session memory checkpoint");
  const available = boolean(row, "available", "session memory checkpoint");
  const summary = row.summary === null ? null : string(row, "summary", "session memory checkpoint");
  // 失效检查点不给摘要正文：服务端若同时返回 available=false 与摘要，说明这次响应
  // 违反契约，不能挑一个信——旧摘要正文一旦进入界面就会被当成可用记忆回显。
  if (!available && summary !== null) {
    throw new RelayContractError("session memory checkpoint 在失效时仍返回了摘要正文。");
  }
  return { id: uuid(row, "id", "session memory checkpoint"),
    available,
    throughSeq: decimal(row, "through_seq", "session memory checkpoint"),
    summary,
    modelCallId: nullableUuid(row, "model_call_id", "session memory checkpoint"),
    createdAt: string(row, "created_at", "session memory checkpoint"),
    sourceMessageIds: array(row, "source_message_ids", "session memory checkpoint").map((item) => {
      if (typeof item !== "string" || !uuidPattern.test(item)) {
        throw new RelayContractError("session memory checkpoint.source_message_ids 含非法 UUID。");
      }
      return item;
    }),
    sources: array(row, "sources", "session memory checkpoint").map(memorySourceRefFrom) };
}

function compactionRequestFrom(value: unknown): RelayMemoryCompactionRequest {
  const row = object(value, "memory compaction request");
  const errorCode = row.error_code === null ? null : string(row, "error_code", "memory compaction request");
  return { id: uuid(row, "id", "memory compaction request"),
    reason: enumeration(row, "reason", "memory compaction request", compactionReasons),
    status: enumeration(row, "status", "memory compaction request", compactionStatuses),
    cancelRequested: boolean(row, "cancel_requested", "memory compaction request"),
    errorCode,
    checkpointId: nullableUuid(row, "checkpoint_id", "memory compaction request"),
    modelCallId: nullableUuid(row, "model_call_id", "memory compaction request"),
    throughSeq: decimal(row, "through_seq", "memory compaction request"),
    createdAt: string(row, "created_at", "memory compaction request"),
    updatedAt: string(row, "updated_at", "memory compaction request") };
}

export function sessionMemoryFrom(value: unknown, expectedSessionId: string): RelaySessionMemory {
  const row = object(value, "session memory");
  const sessionId = uuid(row, "session_id", "session memory");
  if (sessionId !== expectedSessionId) throw new RelayContractError("会话记忆响应与当前会话不一致。");
  const checkpoint = row.checkpoint === null ? null : checkpointFrom(row.checkpoint);
  return { sessionId,
    sessionRevision: decimal(row, "session_revision", "session memory"),
    revision: decimal(row, "revision", "session memory"),
    remember: boolean(row, "remember", "session memory"),
    clearedThroughSeq: decimal(row, "cleared_through_seq", "session memory"),
    checkpoint,
    requests: array(row, "requests", "session memory").map(compactionRequestFrom) };
}

export function messageMemoryUseFrom(value: unknown, expected: { sessionId: string; messageId: string }): RelayMessageMemoryUse {
  const row = object(value, "message memory");
  const sessionId = uuid(row, "session_id", "message memory");
  const messageId = uuid(row, "message_id", "message memory");
  if (sessionId !== expected.sessionId || messageId !== expected.messageId) {
    throw new RelayContractError("消息记忆来源响应与当前消息不一致。");
  }
  return { sessionId, messageId,
    recorded: boolean(row, "recorded", "message memory"),
    available: boolean(row, "available", "message memory"),
    checkpointId: nullableUuid(row, "checkpoint_id", "message memory"),
    sources: array(row, "sources", "message memory").map(memorySourceRefFrom) };
}

export function sessionMemoryResetFrom(value: unknown, expectedSessionId: string): RelaySessionMemoryResetResult {
  const row = object(value, "session memory reset");
  const sessionId = uuid(row, "session_id", "session memory reset");
  if (sessionId !== expectedSessionId) throw new RelayContractError("工作窗口回执与当前会话不一致。");
  return { sessionId,
    revision: decimal(row, "revision", "session memory reset"),
    sessionRevision: decimal(row, "session_revision", "session memory reset"),
    remember: boolean(row, "remember", "session memory reset"),
    clearedThroughSeq: decimal(row, "cleared_through_seq", "session memory reset") };
}

export function memoryCreatedFromMessageFrom(value: unknown): RelayMemoryCreatedFromMessage {
  const row = object(value, "memory create result");
  const status = string(row, "status", "memory create result");
  if (status !== "ACTIVE" && status !== "RETIRED") {
    throw new RelayContractError("memory create result.status 包含未知取值。");
  }
  return { memoryId: uuid(row, "memory_id", "memory create result"),
    revision: decimal(row, "revision", "memory create result"),
    version: decimal(row, "version", "memory create result"),
    status };
}

export function compactAcceptedFrom(value: unknown, expectedSessionId: string): RelayCompactAccepted {
  const row = object(value, "compact result");
  // 聊天命令的 202 会带 `kind`/`system` 标签，但底层 Owner 是 RequestMemoryCompaction：
  // 重放或回执查询拿到的可能只有原始结果。标签在就核对，不在不补造。
  if (row.kind !== undefined && row.kind !== "MEMORY_COMPACTION") {
    throw new RelayContractError("compact result.kind 不是记忆整理。");
  }
  if (row.system !== undefined && row.system !== "compact") {
    throw new RelayContractError("compact result.system 不是 compact。");
  }
  const sessionId = uuid(row, "session_id", "compact result");
  if (sessionId !== expectedSessionId) throw new RelayContractError("整理回执与当前会话不一致。");
  const status = string(row, "status", "compact result");
  if (status !== "PENDING") throw new RelayContractError("整理受理回执的状态不是 PENDING。");
  return { sessionId, requestId: uuid(row, "request_id", "compact result"), status };
}

/** 十进制修订的比较：只用于「回执不能倒退」这类本地核对，不参与任何业务裁决。 */
export function revisionAtLeast(value: DecimalRevision, floor: DecimalRevision): boolean {
  return BigInt(value) >= BigInt(floor);
}
