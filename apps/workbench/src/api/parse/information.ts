import { RelayContractError } from "../core/errors";
import { array, boolean, decimal, integer, nullableInteger, nullableString, object, string, stringArray } from "../core/primitives";
import type { RelayDecision, RelayInformationKind, RelayInterventionItem, RelayKnowledge, RelayKnowledgeCurationCandidate, RelayKnowledgeGuideEntry, RelayKnowledgeVersion, RelayKnowledgeVersionContent, RelayMemory, RelayMemoryEffectiveStatus, RelayMemoryRevision, RelayModelVerifyResult, RelayProjectKnowledgeGuide, RelayRule, RelayRuleEnforcement, RelayRuleStrength, RelayRuleVersion, RelaySearchItem } from "../dtos/information";

export function interventionFrom(value: unknown): RelayInterventionItem {
  const row = object(value, "intervention");
  const kind = string(row, "kind", "intervention");
  if (!["REVIEW", "LOCK_CONFLICT", "RUN_FAILED", "UNKNOWN", "SCHEDULED_TASK_BLOCKED"].includes(kind))
    throw new Error("人工介入事项类型无效。");
  const targetUrl = string(row, "target_url", "intervention");
  if (!/^\/(?:runs\/[^/]+|reviews\?id=[^/]+|tasks\?tab=attention|scheduled-tasks\/[^/]+)$/u.test(targetUrl))
    throw new Error("人工介入事项入口无效。");
  return { itemKey: string(row, "item_key", "intervention"),
    changeKey: string(row, "change_key", "intervention"),
    kind: kind as RelayInterventionItem["kind"],
    title: string(row, "title", "intervention"),
    reason: string(row, "reason", "intervention"), targetUrl };
}

export function knowledgeGuideFrom(value: unknown): RelayProjectKnowledgeGuide {
  const row = object(value, "project knowledge guide");
  return { projectId: string(row, "project_id", "project knowledge guide"),
    exists: boolean(row, "exists", "project knowledge guide"),
    revision: decimal(row, "revision", "project knowledge guide"),
    entryCount: integer(row, "entry_count", "project knowledge guide"),
    entries: array(row, "entries", "project knowledge guide").map((value) => {
      const entry = object(value, "knowledge guide entry");
      const refKind = string(entry, "ref_kind", "knowledge guide entry");
      const referenceMode = string(entry, "reference_mode", "knowledge guide entry");
      const resolution = string(entry, "resolution", "knowledge guide entry");
      if (!["KNOWLEDGE", "DECISION", "RULE", "ARTIFACT_VERSION"].includes(refKind)) {
        throw new Error("knowledge guide entry.ref_kind 响应格式无效。");
      }
      if (referenceMode !== "PINNED" && referenceMode !== "CURRENT") {
        throw new Error("knowledge guide entry.reference_mode 响应格式无效。");
      }
      if (!["AVAILABLE", "ARCHIVED", "SUPERSEDED", "STALE", "CROSS_SCOPE",
        "MISSING"].includes(resolution)) {
        throw new Error("knowledge guide entry.resolution 响应格式无效。");
      }
      return { ordinal: integer(entry, "ordinal", "knowledge guide entry"),
        refKind: refKind as RelayKnowledgeGuideEntry["refKind"],
        referenceMode: referenceMode as RelayKnowledgeGuideEntry["referenceMode"],
        targetId: string(entry, "target_id", "knowledge guide entry"),
        label: nullableString(entry, "label", "knowledge guide entry"),
        title: nullableString(entry, "title", "knowledge guide entry"),
        resolvedVersionId: nullableString(entry, "resolved_version_id", "knowledge guide entry"),
        resolvedVersionNumber: entry.resolved_version_number === null ? null
          : decimal(entry, "resolved_version_number", "knowledge guide entry"),
        targetStatus: string(entry, "target_status", "knowledge guide entry"),
        isCurrent: boolean(entry, "is_current", "knowledge guide entry"),
        resolution: resolution as RelayKnowledgeGuideEntry["resolution"],
        note: string(entry, "note", "knowledge guide entry") };
    }),
    gaps: stringArray(row, "gaps", "project knowledge guide") };
}

export function knowledgeCurationCandidateFrom(value: unknown): RelayKnowledgeCurationCandidate {
  const row = object(value, "knowledge curation candidate");
  const status = string(row, "status", "knowledge curation candidate");
  if (!["PROPOSED", "ACCEPTED", "REJECTED", "STALE"].includes(status)) {
    throw new Error("knowledge curation candidate.status 响应格式无效。");
  }
  return { id: string(row, "id", "knowledge curation candidate"),
    projectId: string(row, "project_id", "knowledge curation candidate"),
    sourceArtifactVersionId: string(row, "source_artifact_version_id", "knowledge curation candidate"),
    sourceArtifactId: string(row, "source_artifact_id", "knowledge curation candidate"),
    sourceVersionNumber: string(row, "source_version_number", "knowledge curation candidate"),
    sourceTitle: string(row, "source_title", "knowledge curation candidate"),
    suggestedTitle: string(row, "suggested_title", "knowledge curation candidate"),
    suggestedKnowledgeId: nullableString(row, "suggested_knowledge_id", "knowledge curation candidate"),
    suggestedKnowledgeTitle: nullableString(row, "suggested_knowledge_title", "knowledge curation candidate"),
    similar: array(row, "similar", "knowledge curation candidate").map((value) => {
      const similar = object(value, "curation similar");
      return { knowledgeId: string(similar, "knowledge_id", "curation similar"),
        title: string(similar, "title", "curation similar"),
        status: string(similar, "status", "curation similar"),
        reason: string(similar, "reason", "curation similar") };
    }),
    status: status as RelayKnowledgeCurationCandidate["status"],
    acceptedKnowledgeId: nullableString(row, "accepted_knowledge_id", "knowledge curation candidate"),
    acceptedKnowledgeVersionId: nullableString(row, "accepted_knowledge_version_id", "knowledge curation candidate"),
    staleReason: nullableString(row, "stale_reason", "knowledge curation candidate"),
    rejectedAt: nullableString(row, "rejected_at", "knowledge curation candidate") };
}

export function knowledgeFrom(value: unknown): RelayKnowledge {
  const row = object(value, "knowledge");
  return {
    id: string(row, "id", "knowledge"), projectId: nullableString(row, "project_id", "knowledge"),
    title: string(row, "title", "knowledge"), status: string(row, "status", "knowledge"),
    revision: decimal(row, "revision", "knowledge"), currentVersion: decimal(row, "current_version", "knowledge"),
    createdAt: string(row, "created_at", "knowledge"), updatedAt: string(row, "updated_at", "knowledge")
  };
}

export function knowledgeVersionContentFrom(value: unknown): RelayKnowledgeVersionContent {
  const row = object(value, "knowledge content");
  const metadata = knowledgeVersionFrom({ ...row, excerpt: null });
  const status = string(row, "content_status", "knowledge content");
  if (status !== "FULL" && status !== "PARTIAL" && status !== "UNAVAILABLE" &&
    status !== "UNSUPPORTED" && status !== "READ_FAILED") throw new Error("知识正文状态无效。");
  const content = nullableString(row, "content", "knowledge content");
  if ((status === "FULL" || status === "PARTIAL") ? content === null : content !== null) {
    throw new Error("知识正文状态与可读内容不一致。");
  }
  if ((status === "FULL" || status === "PARTIAL") && metadata.availability !== "AVAILABLE") {
    throw new Error("知识正文状态与来源可用性不一致。");
  }
  return { id: metadata.id, knowledgeId: metadata.knowledgeId, version: metadata.version,
    sourceKind: metadata.sourceKind, mediaType: metadata.mediaType, contentSha256: metadata.contentSha256,
    availability: metadata.availability, sourceRefs: metadata.sourceRefs, createdAt: metadata.createdAt,
    title: string(row, "title", "knowledge content"), projectId: nullableString(row, "project_id", "knowledge content"),
    currentVersion: decimal(row, "current_version", "knowledge content"),
    sourceUri: nullableString(row, "source_uri", "knowledge content"), contentStatus: status, content };
}

export function knowledgeVersionFrom(value: unknown): RelayKnowledgeVersion {
  const row = object(value, "knowledge version");
  const sourceKind = string(row, "source_kind", "knowledge version");
  if (sourceKind !== "NOTE" && sourceKind !== "MANAGED_TEXT" && sourceKind !== "ARTIFACT_VERSION" && sourceKind !== "WEB_PAGE") {
    throw new Error("knowledge version.source_kind 响应格式无效。");
  }
  return {
    id: string(row, "id", "knowledge version"), knowledgeId: string(row, "knowledge_id", "knowledge version"),
    version: decimal(row, "version", "knowledge version"), sourceKind,
    mediaType: string(row, "media_type", "knowledge version"),
    contentSha256: string(row, "content_sha256", "knowledge version"),
    availability: string(row, "availability", "knowledge version"),
    excerpt: nullableString(row, "excerpt", "knowledge version"),
    sourceRefs: object(row.source_refs, "knowledge version.source_refs"),
    createdAt: string(row, "created_at", "knowledge version")
  };
}

/**
 * 只读有效状态：缺字段视为旧服务端，落为 null（界面说「状态待核对」）；
 * 已知枚举之外的任何形状都显式失败，不把未知悄悄当成 ACTIVE 或「未知」。
 */
function memoryEffectiveStatus(row: Record<string, unknown>, name: string): RelayMemoryEffectiveStatus | null {
  const value = row.effective_status;
  if (value === undefined) return null;
  if (value === "ACTIVE" || value === "EXPIRED" || value === "RETIRED") return value;
  throw new RelayContractError(`${name}.effective_status 响应格式无效。`);
}

/** 0125 的 origin：缺字段按人工确认读——旧数据没有「自动记住」这个概念。 */
function memoryOrigin(row: Record<string, unknown>): RelayMemory["origin"] {
  const value = row.origin;
  if (value === undefined || value === null) return "HUMAN_CONFIRMED";
  if (value === "HUMAN_CONFIRMED" || value === "AUTO_CAPTURE") return value;
  throw new RelayContractError("memory.origin 包含未知取值。");
}

/** DEV-0042 的来源类别：缺字段按 UNKNOWN 读——旧数据没有经过来源核验，不能当成用户原话。 */
function memorySourceKind(row: Record<string, unknown>): RelayMemory["sourceKind"] {
  const value = row.source_kind;
  if (value === undefined || value === null) return "UNKNOWN";
  if (value === "MANUAL" || value === "USER_STATEMENT" || value === "MODEL_OBSERVATION" ||
      value === "UNKNOWN") {
    return value;
  }
  throw new RelayContractError("memory.source_kind 包含未知取值。");
}

export function memoryFrom(value: unknown): RelayMemory {
  const row = object(value, "memory");
  return {
    id: string(row, "id", "memory"), projectId: nullableString(row, "project_id", "memory"),
    title: string(row, "title", "memory"), origin: memoryOrigin(row),
    sourceKind: memorySourceKind(row),
    status: string(row, "status", "memory"),
    effectiveStatus: memoryEffectiveStatus(row, "memory"),
    revision: decimal(row, "revision", "memory"), currentVersion: decimal(row, "current_version", "memory"),
    text: string(row, "text", "memory"), confirmedBy: string(row, "confirmed_by", "memory"),
    confirmedAt: string(row, "confirmed_at", "memory"), expiresAt: nullableString(row, "expires_at", "memory"),
    createdAt: string(row, "created_at", "memory"), updatedAt: string(row, "updated_at", "memory")
  };
}

/** 历史修订不可变：故意不读 effective_status，不把当前动态状态安到某一条旧版本上。 */
export function memoryRevisionFrom(value: unknown): RelayMemoryRevision {
  const row = object(value, "memory revision");
  return {
    id: string(row, "id", "memory revision"), memoryId: string(row, "memory_id", "memory revision"),
    version: decimal(row, "version", "memory revision"), title: string(row, "title", "memory revision"),
    text: string(row, "text", "memory revision"), confirmedBy: string(row, "confirmed_by", "memory revision"),
    confirmedAt: string(row, "confirmed_at", "memory revision"),
    expiresAt: nullableString(row, "expires_at", "memory revision"),
    createdAt: string(row, "created_at", "memory revision")
  };
}

export function decisionFrom(value: unknown): RelayDecision {
  const row = object(value, "decision");
  return {
    id: string(row, "id", "decision"), projectId: nullableString(row, "project_id", "decision"),
    title: string(row, "title", "decision"), status: string(row, "status", "decision"),
    revision: decimal(row, "revision", "decision"), currentVersion: decimal(row, "current_version", "decision"),
    choice: string(row, "choice", "decision"), rationale: string(row, "rationale", "decision"),
    alternatives: stringArray(row, "alternatives", "decision"), costs: stringArray(row, "costs", "decision"),
    supersededById: nullableString(row, "superseded_by_id", "decision"),
    createdAt: string(row, "created_at", "decision"), updatedAt: string(row, "updated_at", "decision")
  };
}

export function ruleFields(row: Record<string, unknown>, name: string) {
  const strength = string(row, "strength", name);
  const enforcement = string(row, "enforcement", name);
  if (strength !== "HARD" && strength !== "PREFERENCE") throw new Error(`${name}.strength 响应格式无效。`);
  if (!["PRE_ACTION", "POST_CHECK", "SEMANTIC", "HUMAN"].includes(enforcement)) {
    throw new Error(`${name}.enforcement 响应格式无效。`);
  }
  return {
    ruleKey: string(row, "rule_key", name), statement: string(row, "statement", name), strength: strength as RelayRuleStrength,
    applicability: string(row, "applicability", name), enforcement: enforcement as RelayRuleEnforcement,
    method: nullableString(row, "method", name), targetSpec: object(row.target_spec, `${name}.target_spec`)
  };
}

export function ruleFrom(value: unknown): RelayRule {
  const row = object(value, "rule");
  const scope = string(row, "scope", "rule");
  if (scope !== "WORKSPACE" && scope !== "PROJECT" && scope !== "TASK") throw new Error("rule.scope 响应格式无效。");
  return {
    id: string(row, "id", "rule"), scope, scopeId: string(row, "scope_id", "rule"),
    projectId: nullableString(row, "project_id", "rule"), taskId: nullableString(row, "task_id", "rule"),
    status: string(row, "status", "rule"), revision: decimal(row, "revision", "rule"),
    currentVersion: decimal(row, "current_version", "rule"), ...ruleFields(row, "rule"),
    createdAt: string(row, "created_at", "rule"), updatedAt: string(row, "updated_at", "rule")
  };
}

export function ruleVersionFrom(value: unknown): RelayRuleVersion {
  const row = object(value, "rule version");
  return {
    ruleId: string(row, "rule_id", "rule version"), version: decimal(row, "version", "rule version"),
    ...ruleFields(row, "rule version"), createdAt: string(row, "created_at", "rule version")
  };
}

export function searchItemFrom(value: unknown): RelaySearchItem {  const row = object(value, "search item");
  const type = string(row, "type", "search item");
  if (!["KNOWLEDGE", "MEMORY", "DECISION", "RULE"].includes(type)) throw new Error("search item.type 响应格式无效。");
  return {
    type: type as RelayInformationKind, id: string(row, "id", "search item"),
    version: decimal(row, "version", "search item"), title: string(row, "title", "search item"),
    snippet: string(row, "snippet", "search item"), matchedFields: stringArray(row, "matched_fields", "search item"),
    sourceRef: string(row, "source_ref", "search item"), status: string(row, "status", "search item"),
    projectId: nullableString(row, "project_id", "search item")
  };
}

export function modelVerifyResultFrom(row: Record<string, unknown>): RelayModelVerifyResult {
  const category = row.error_category;
  if (category !== null && category !== "AUTH" && category !== "RATE_LIMIT" &&
      category !== "TIMEOUT" && category !== "STREAM_BROKEN" && category !== "PROTOCOL" &&
      category !== "NETWORK") {
    throw new Error("model-port verify.error_category 响应格式无效。");
  }
  return {
    ok: boolean(row, "ok", "model-port verify"),
    latencyMs: nullableInteger(row, "latency_ms", "model-port verify"),
    provider: string(row, "provider", "model-port verify"),
    model: string(row, "model", "model-port verify"),
    configFingerprint: string(row, "config_fingerprint", "model-port verify"),
    errorCategory: category,
    verifiedAt: string(row, "verified_at", "model-port verify")
  };
}
