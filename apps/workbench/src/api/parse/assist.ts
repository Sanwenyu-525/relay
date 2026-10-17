import { array, boolean, decimal, integer, isRecord, nullableInteger, nullableOptionalInteger, nullableString, object, optionalString, string, stringArray, stringList } from "../core/primitives";
import type { RelayAssistMessage, RelayAssistProposal, RelayAssistProposalBase, RelayAssistSession, RelayAssistSessionBinding, RelayAssistSessionDirectoryBinding, RelayAssistSessionPin, RelayAssistSessionState, RelayAssistSessionTitle, RelayAssistSessionUnread, RelayAssistantProfile, RelayAssistSkillOutput, RelayAssistSourceRef, RelayConversationCheck, RelayConversationDiff, RelayConversationDiffFile, RelayConversationDiffUnavailableReason, RelayConversationExecution, RelayConversationFileAction, RelayConversationFileDiff, RelayPackDefinition, RelayRunToolCall, RelayRunToolCallPreviews, RelayRunToolCalls, RelaySkillDefinition, RelayToolCallStatus, RelayWorkingDirectory, RelayWorkingDirectoryCandidate } from "../dtos/assist";
import type { DecimalRevision } from "../../types";
import type { RelayGatewayDecision } from "../dtos/gateway";

export function assistSourceBody(source: RelayAssistSourceRef) {
  return { kind: source.kind, root_id: source.rootId, version: source.version };
}

export function skillDefinitionFrom(value: unknown): RelaySkillDefinition {
  const row = object(value, "skill definition");
  const target = string(row, "target", "skill definition");
  const outputKind = string(row, "output_kind", "skill definition");
  const availability = string(row, "availability", "skill definition");
  if ((target !== "PROJECT" && target !== "TASK") ||
    !["TASK_DEFINITION_SUGGESTION", "PROJECT_RESUME", "VERIFICATION_PLAN_SUGGESTION",
      "PROJECT_BLUEPRINT_SUGGESTION"].includes(outputKind) ||
    !["CALLABLE_SUGGESTION_ONLY", "CALLABLE_READ_ONLY", "HISTORICAL_ONLY"].includes(availability) ||
    typeof row.call_supported !== "boolean" || typeof row.accept_supported !== "boolean") {
    throw new Error("Skill 定义响应格式无效。");
  }
  return { id: string(row, "id", "skill definition"), version: string(row, "version", "skill definition"),
    sha256: string(row, "sha256", "skill definition"), title: string(row, "title", "skill definition"),
    target, outputKind: outputKind as RelaySkillDefinition["outputKind"],
    availability: availability as RelaySkillDefinition["availability"],
    callSupported: row.call_supported,
    requiredCapabilities: stringList(row, "required_capabilities", "skill definition"),
    missingCapabilities: stringList(row, "missing_capabilities", "skill definition"),
    acceptSupported: row.accept_supported,
    dependencies: array(row, "dependencies", "skill definition").map((value) => {
      const dep = object(value, "skill dependency");
      return { kind: string(dep, "kind", "skill dependency"), id: string(dep, "id", "skill dependency"),
        version: string(dep, "version", "skill dependency"), sha256: string(dep, "sha256", "skill dependency") };
    }) };
}

export function packDefinitionFrom(value: unknown): RelayPackDefinition {
  const row = object(value, "pack");
  return { id: string(row, "id", "pack"), version: string(row, "version", "pack"),
    sha256: string(row, "sha256", "pack"), title: string(row, "title", "pack"),
    hostContract: string(row, "host_contract", "pack"), availability: string(row, "availability", "pack"),
    members: array(row, "members", "pack").map((value) => {
      const member = object(value, "pack member");
      const target = string(member, "target", "pack member");
      if (member.kind !== "SKILL" || (target !== "PROJECT" && target !== "TASK") ||
        typeof member.accept_supported !== "boolean") throw new Error("Pack 成员响应格式无效。");
      return { kind: "SKILL" as const, id: string(member, "id", "pack member"),
        version: string(member, "version", "pack member"),
        sha256: string(member, "sha256", "pack member"), target,
        availability: string(member, "availability", "pack member"),
        requiredCapabilities: stringList(member, "required_capabilities", "pack member"),
        missingCapabilities: stringList(member, "missing_capabilities", "pack member"),
        acceptSupported: member.accept_supported };
    }) };
}

export function assistSkillOutputFrom(value: unknown): RelayAssistSkillOutput {
  const row = object(value, "assist skill output");
  const kind = string(row, "kind", "assist skill output");
  const status = string(row, "status", "assist skill output");
  const targetKind = string(row, "target_kind", "assist skill output");
  if (!["TASK_DEFINITION_SUGGESTION", "PROJECT_RESUME", "VERIFICATION_PLAN_SUGGESTION",
    "PROJECT_BLUEPRINT_SUGGESTION"].includes(kind) ||
    (status !== "SUGGESTED" && status !== "READ_ONLY") ||
    (targetKind !== "PROJECT" && targetKind !== "TASK") ||
    (kind === "PROJECT_RESUME") !== (status === "READ_ONLY" && targetKind === "PROJECT") ||
    (kind === "PROJECT_BLUEPRINT_SUGGESTION" ?
      (status !== "SUGGESTED" || targetKind !== "PROJECT") :
      (kind !== "PROJECT_RESUME" && targetKind !== "TASK"))) {
    throw new Error("Assist Skill 输出类型无效。");
  }
  const payload = object(row.payload, "assist skill payload");
  if (typeof payload.summary !== "string" ||
    (kind === "PROJECT_RESUME" && (!Array.isArray(payload.highlights) ||
      !Array.isArray(payload.next_steps) || payload.comparison_baseline !== null || payload.read_only !== true)) ||
    (kind === "TASK_DEFINITION_SUGGESTION" && (typeof payload.objective !== "string" ||
      !Array.isArray(payload.criteria) || !isRecord(payload.expected_outputs))) ||
    (kind === "VERIFICATION_PLAN_SUGGESTION" &&
      (!Array.isArray(payload.checks) && !Array.isArray(payload.additional_checks) ||
      payload.effective_check_plan !== false)) ||
    (kind === "PROJECT_BLUEPRINT_SUGGESTION" &&
      (!isRecord(payload.draft) || payload.effective_blueprint !== false))) {
    throw new Error("Assist Skill 输出内容无效。");
  }
  return { kind: kind as RelayAssistSkillOutput["kind"], status, targetKind,
    targetId: string(row, "target_id", "assist skill output"),
    asOf: string(row, "as_of", "assist skill output"),
    baseline: object(row.baseline, "assist skill baseline"),
    basisSha256: string(row, "basis_sha256", "assist skill output"),
    payloadSha256: string(row, "payload_sha256", "assist skill output"),
    payload };
}

const SESSION_FORMAT_ERROR = "会话响应格式无效。";
const PROFILE_FORMAT_ERROR = "助手配置响应格式无效。";

/**
 * 人设标签用**冻结**的修订，不是助手的当前修订。
 *
 * 助手之后被改写或归档，既有会话显示的仍是它建立时那一版人设——否则同一条会话的
 * 历史消息会在中途换一张脸。
 */
function personaLabel(role: Record<string, unknown> | null,
  revision: DecimalRevision | null): string | null {
  if (role === null) return null;
  const name = typeof role.name === "string" && role.name.trim() !== "" ? role.name : "未命名助手";
  return revision === null ? `${name} · 人设` : `${name} · 人设 v${revision}`;
}

/** 缺键等同 null。0059 之前没有这些列；显式的 null 同样读成 null。 */
function optionalNullable(row: Record<string, unknown>, key: string, name: string): string | null {
  return row[key] === undefined ? null : nullableString(row, key, name);
}

export function assistantProfileFrom(value: unknown): RelayAssistantProfile {
  const row = object(value, "assistant profile");
  const status = string(row, "status", "assistant profile");
  const name = string(row, "name", "assistant profile");
  const revision = decimal(row, "revision", "assistant profile");
  if (status !== "ACTIVE" && status !== "ARCHIVED") throw new Error(PROFILE_FORMAT_ERROR);
  const tone = nullableString(row, "tone", "assistant profile");
  return { id: string(row, "id", "assistant profile"), name,
    roleDescription: string(row, "role_description", "assistant profile"), tone,
    readScope: object(row.read_scope ?? {}, "assistant profile"),
    status, revision,
    optionLabel: status === "ARCHIVED" ? `${name} · v${revision} · 已归档` : `${name} · v${revision}` };
}

export function assistSessionFrom(value: unknown): RelayAssistSession {
  const row = object(value, "assist session");
  // 字段**缺失**才回落成普通档，值不在词表内一律报错：
  // 缺失只可能来自迁移 0059 之前的响应（那时本来只有一种身份），
  // 而「不认识的模式」意味着服务端在说我们听不懂的话，这时猜一个身份最糟。
  const conversationMode = row.conversation_mode === undefined
    ? "AGENT" : string(row, "conversation_mode", "assist session");
  // 0072 新增 'LEARNING'：学习身份是独立受限档，必须在这里被**认识**，
  // 否则读到一个学习会话会让整份会话清单解析失败。
  if (conversationMode !== "AGENT" && conversationMode !== "ASSISTANT"
    && conversationMode !== "LEARNING") {
    throw new Error(SESSION_FORMAT_ERROR);
  }
  // 三个助手列同理：0059 之前没有这些列，缺失等同 null；显式的 null 也是 null。
  const assistantProfileId = optionalNullable(row, "assistant_profile_id", "assist session");
  const assistantProfileRevision = optionalNullable(row, "assistant_profile_revision", "assist session");
  const roleValue = row.assistant_role;
  const role = roleValue === null || roleValue === undefined
    ? null : object(roleValue, "assist session");
  if (conversationMode === "ASSISTANT" &&
    (assistantProfileId === null || assistantProfileRevision === null || role === null)) {
    // 助手会话缺冻结快照说明响应不完整，不能当成普通会话显示。
    throw new Error(SESSION_FORMAT_ERROR);
  }
  return { id: string(row, "id", "assist session"),
    projectId: nullableString(row, "project_id", "assist session"),
    taskId: nullableString(row, "task_id", "assist session"),
    title: string(row, "title", "assist session"), status: string(row, "status", "assist session"),
    revision: decimal(row, "revision", "assist session"),
    // 0090：pinned_at 缺失只来自该迁移之前的响应，那时还没有置顶这件事。
    pinnedAt: optionalNullable(row, "pinned_at", "assist session"),
    // 0104：unread_at 同理，缺失读成已读——未读是后加的可选标记，不是第三种状态。
    unreadAt: optionalNullable(row, "unread_at", "assist session"),
    updatedAt: string(row, "updated_at", "assist session"),
    conversationMode, assistantProfileId, assistantProfileRevision,
    personaLabel: personaLabel(role, assistantProfileRevision),
    // 同理：remember 缺失只来自 0059 之前的响应，那时的会话默认可读。
    remember: row.remember === undefined ? true : boolean(row, "remember", "assist session"),
    // 0087：working_resource_id 缺失只来自该迁移之前的响应，那时会话本来就没有目录绑定。
    workingResourceId: row.working_resource_id === undefined
      ? null : nullableString(row, "working_resource_id", "assist session"),
    ...(row.context === undefined ? {} : { context: (() => {
      const context = object(row.context, "assist session context");
      const directory = context.working_directory === null ? null
        : object(context.working_directory, "assist session directory");
      return { projectGoals: array(context, "project_goals", "assist session context").map((value) => {
        const goal = object(value, "assist session goal");
        return { goalId: string(goal, "goal_id", "assist session goal"), title: string(goal, "title", "assist session goal") };
      }), workingDirectory: directory === null ? null : {
        resourceId: string(directory, "resource_id", "assist session directory"),
        canonicalRoot: nullableString(directory, "canonical_root", "assist session directory") } };
    })() }) };
}

export function assistMessageFrom(value: unknown): RelayAssistMessage {
  const row = object(value, "assist message");
  const role = string(row, "role", "assist message");
  const status = string(row, "status", "assist message");
  if (role !== "USER" && role !== "ASSISTANT") throw new Error("Assist 消息角色无法识别。");
  if (status !== "PENDING" && status !== "RUNNING" && status !== "COMPLETED" && status !== "FAILED" && status !== "CANCELLED") {
    throw new Error("Assist 消息状态无法识别。");
  }
  const usage = object(row.usage, "assist message.usage");
  const providerErrorKind = row.provider_error_kind ?? null;
  if (providerErrorKind !== null && (status !== "FAILED" ||
      providerErrorKind !== "AUTH" && providerErrorKind !== "RATE_LIMIT" &&
      providerErrorKind !== "TIMEOUT" && providerErrorKind !== "STREAM_BROKEN" &&
      providerErrorKind !== "PROTOCOL" && providerErrorKind !== "NETWORK")) {
    throw new Error("Assist 消息 Provider 失败类别无效。");
  }
  const skillRow = row.skill === null || row.skill === undefined ? null : object(row.skill, "assist skill");
  const skillTarget = skillRow?.target;
  const target: "PROJECT" | "TASK" | null = skillTarget === "PROJECT" || skillTarget === "TASK"
    ? skillTarget : null;
  const definitionAvailability = skillRow === null ? null : string(skillRow, "definition_availability", "assist skill");
  const outputAvailability = skillRow === null ? null : string(skillRow, "output_availability", "assist skill");
  if (definitionAvailability !== null && !["AVAILABLE", "HISTORICAL_ONLY", "UNAVAILABLE"].includes(definitionAvailability) ||
    outputAvailability !== null && !["PENDING", "HISTORICAL_SNAPSHOT", "NO_OUTPUT", "UNAVAILABLE"].includes(outputAvailability)) {
    throw new Error("Assist Skill 历史可用性无效。");
  }
  const skill = skillRow === null ? null : {
    id: string(skillRow, "id", "assist skill"), version: string(skillRow, "version", "assist skill"),
    sha256: optionalString(skillRow, "sha256"),
    definitionAvailability: definitionAvailability as NonNullable<RelayAssistMessage["skill"]>["definitionAvailability"],
    outputAvailability: outputAvailability as NonNullable<RelayAssistMessage["skill"]>["outputAvailability"],
    target,
    availability: optionalString(skillRow, "availability"),
    missingCapabilities: Array.isArray(skillRow.missing_capabilities)
      ? stringList(skillRow, "missing_capabilities", "assist skill") : []
  };
  return { id: string(row, "id", "assist message"),
    sessionId: string(row, "session_id", "assist message"),
    seq: decimal(row, "seq", "assist message"), role, status,
    createdAt: optionalString(row, "created_at"),
    intent: string(row, "intent", "assist message"),
    content: nullableString(row, "content", "assist message"),
    errorCode: nullableString(row, "error_code", "assist message"),
    providerErrorKind,
    sources: array(row, "sources", "assist message").map((value) => {
      const source = object(value, "assist source");
      return { sourceRef: optionalString(source, "source_ref"),
        kind: optionalString(source, "kind"), rootId: optionalString(source, "root_id"),
        version: optionalString(source, "version"),
        status: string(source, "status", "assist source"),
        reason: optionalString(source, "reason") };
    }),
    skill, skillInput: row.skill_input === null || row.skill_input === undefined
      ? null : object(row.skill_input, "assist skill input"),
    skillOutput: row.skill_output === null || row.skill_output === undefined
      ? null : assistSkillOutputFrom(row.skill_output),
    usage: { inputTokens: nullableInteger(usage, "input_tokens", "assist usage"),
      outputTokens: nullableInteger(usage, "output_tokens", "assist usage"),
      // cache_* 是 Provider 可选上报项：旧服务端没有这两个字段时按"未上报"处理，
      // 不能因为缺字段就判定整个响应非法。
      cacheReadTokens: nullableOptionalInteger(usage, "cache_read_tokens", "assist usage"),
      cacheCreationTokens: nullableOptionalInteger(usage, "cache_creation_tokens", "assist usage") },
    cancelRequested: row.cancel_requested === true };
}

export function assistProposalFrom(value: unknown): RelayAssistProposal {
  const row = object(value, "assist proposal");
  const kind = string(row, "kind", "assist proposal");
  const targetType = string(row, "target_type", "assist proposal");
  const status = string(row, "status", "assist proposal");
  if (status !== "PENDING" && status !== "ACCEPTED" && status !== "REJECTED" && status !== "EXPIRED") {
    throw new Error("Assist 提案类型或状态无法识别。");
  }
  const common: RelayAssistProposalBase = { id: string(row, "id", "assist proposal"),
    sessionId: string(row, "session_id", "assist proposal"),
    messageId: string(row, "message_id", "assist proposal"),
    targetId: string(row, "target_id", "assist proposal"),
    baseRevision: decimal(row, "base_revision", "assist proposal"),
    payloadHash: string(row, "payload_hash", "assist proposal"),
    payloadAvailable: row.payload_available === undefined ? true : row.payload_available === true,
    status };
  const payload = object(row.payload, "assist proposal.payload");
  if ((kind === "TASK_CONTRACT_CHANGE" || kind === "VERIFICATION_PLAN_CHANGE") && targetType === "TASK") {
    const acceptanceRevision = decimal(row, "base_acceptance_revision", "task skill proposal");
    const skillSha256 = string(row, "skill_sha256", "task skill proposal");
    const skillOutputSha256 = string(row, "skill_output_sha256", "task skill proposal");
    if (!/^[0-9a-f]{64}$/.test(common.payloadHash) ||
      !/^[0-9a-f]{64}$/.test(skillSha256) || !/^[0-9a-f]{64}$/.test(skillOutputSha256) ||
      typeof row.payload_available !== "boolean") throw new Error("Task Skill 提案来源格式无效。");
    if (!common.payloadAvailable) return { ...common, kind, targetType,
      baseAcceptanceRevision: acceptanceRevision, skillSha256, skillOutputSha256, payload: null };
    const rawMode = payload.suggested_mode;
    if (rawMode !== null && typeof rawMode !== "string") throw new Error("建议模式格式无效。");
    return { ...common, kind, targetType, baseAcceptanceRevision: acceptanceRevision,
      skillSha256, skillOutputSha256,
      payload: { objective: string(payload, "objective", "task skill proposal"),
        requiredOutputSpec: object(payload.required_output_spec, "task skill outputs"),
        criteria: array(payload, "criteria", "task skill proposal").map((value) => {
          const criterion = object(value, "task skill criterion");
          const source = string(criterion, "source", "task skill criterion");
          if (typeof criterion.required !== "boolean" ||
            (source !== "PRESERVED" && source !== "SUGGESTED")) {
            throw new Error("Task Skill 合并条件格式无效。");
          }
          return { criterionId: string(criterion, "criterion_id", "task skill criterion"),
            statement: string(criterion, "statement", "task skill criterion"),
            required: criterion.required, method: string(criterion, "method", "task skill criterion"),
            targetSpec: object(criterion.target_spec, "task skill target spec"), source };
        }), addedCriterionIds: stringList(payload, "added_criterion_ids", "task skill proposal"),
        preservedCriterionIds: stringList(payload, "preserved_criterion_ids", "task skill proposal"),
        suggestedMode: rawMode } };
  }
  if (kind === "CANDIDATE_MARKDOWN" && targetType === "TASK") {
    return { ...common, kind, targetType, payload: {
      title: string(payload, "title", "candidate payload"),
      mediaType: string(payload, "media_type", "candidate payload"),
      markdown: string(payload, "markdown", "candidate payload") } };
  }
  if (kind === "TASK_DEFINITION" && targetType === "PROJECT") {
    return { ...common, kind, targetType, payload: {
      title: string(payload, "title", "task proposal payload"),
      objective: string(payload, "objective", "task proposal payload"),
      criteria: array(payload, "criteria", "task proposal payload").map((value) => {
        const criterion = object(value, "task proposal criterion");
        if (typeof criterion.required !== "boolean") throw new Error("提案验收条件格式无效。");
        return { statement: string(criterion, "statement", "task proposal criterion"),
          required: criterion.required, method: string(criterion, "method", "task proposal criterion") };
      }), expectedOutputs: object(payload.expected_outputs, "task proposal expected_outputs") } };
  }
  throw new Error("Assist 提案类型或目标无法识别。");
}

export function workingDirectoryCandidateFrom(value: unknown): RelayWorkingDirectoryCandidate {
  const row = object(value, "working directory candidate");
  return { projectId: string(row, "project_id", "working directory candidate"),
    projectTitle: string(row, "project_title", "working directory candidate"),
    projectArchived: boolean(row, "project_archived", "working directory candidate"),
    resourceId: string(row, "resource_id", "working directory candidate"),
    resourceStatus: string(row, "resource_status", "working directory candidate"),
    fileWriteIdentityBound: boolean(row, "file_write_identity_bound", "working directory candidate") };
}

export function workingDirectoryFrom(value: unknown): RelayWorkingDirectory {
  const row = object(value, "working directory");
  const status = string(row, "status", "working directory");
  if (status !== "READY" && status !== "AMBIGUOUS" && status !== "NOT_READY") {
    throw new Error("working directory.status 无法识别");
  }
  const readiness = object(row.write_readiness, "working directory write readiness");
  const association = row.association === null || row.association === undefined
    ? null : workingDirectoryCandidateFrom(row.association);
  return { canonicalRoot: string(row, "canonical_root", "working directory"),
    displayName: string(row, "display_name", "working directory"), status,
    reason: nullableString(row, "reason", "working directory"), association,
    createdProject: boolean(row, "created_project", "working directory"),
    createdResource: boolean(row, "created_resource", "working directory"),
    candidates: array(row, "candidates", "working directory").map(workingDirectoryCandidateFrom),
    writeReadiness: { status: string(readiness, "status", "working directory write readiness"),
      detail: string(readiness, "detail", "working directory write readiness"),
      policyDecision: policyDecisionOf(readiness),
      policyId: optionalString(readiness, "policy_id"),
      policyRevision: optionalString(readiness, "policy_revision"),
      policyTargetPrefix: optionalString(readiness, "policy_target_prefix") } };
}

/** 缺键（旧回执）当作未核对；出现无法识别的档位不当作空值蒙混，显式失败。 */
function policyDecisionOf(readiness: Record<string, unknown>): RelayGatewayDecision | null {
  const value = readiness.policy_decision;
  if (value === undefined || value === null) return null;
  if (value !== "DENY" && value !== "ASK" && value !== "AUTO") {
    throw new Error("working directory write readiness.policy_decision 无法识别");
  }
  return value;
}

/**
 * 归入项目的回执：只读会话身份、项目归属与确切修订。
 *
 * 这里不解析目录是否就绪，也不解析任何权限字段——归属与执行准入是两件事，
 * 回执里没有的就不得凭空补出来。首次响应与按原 command_id 查回的回执共用它。
 */
export function assistSessionBindingFrom(value: unknown): RelayAssistSessionBinding {
  const row = object(value, "assist session binding");
  return { sessionId: string(row, "session_id", "assist session binding"),
    projectId: string(row, "project_id", "assist session binding"),
    revision: decimal(row, "revision", "assist session binding") };
}

/**
 * 绑定工作目录的回执解析（0087）。
 *
 * 与归属回执同样逐字核对：command_id 对不上、或回执里的资源不是这次请求的那个，
 * 都不能当成已绑定，也不能换新 ID 重试。
 */
export function assistSessionDirectoryBindingFrom(value: unknown): RelayAssistSessionDirectoryBinding {
  const row = object(value, "assist session directory binding");
  return { sessionId: string(row, "session_id", "assist session directory binding"),
    workingResourceId: string(row, "working_resource_id", "assist session directory binding"),
    revision: decimal(row, "revision", "assist session directory binding") };
}

/**
 * 会话行内控制三条回执的解析（0090）。
 *
 * 与绑定回执一样逐字核对：`pinned` 必须是布尔、`status` 只认库里那两个值——
 * 读出一个听不懂的归档态却当成成功，比报错更糟。
 */
export function assistSessionTitleFrom(value: unknown): RelayAssistSessionTitle {
  const row = object(value, "assist session title");
  return { sessionId: string(row, "session_id", "assist session title"),
    title: string(row, "title", "assist session title"),
    revision: decimal(row, "revision", "assist session title"),
    updatedAt: string(row, "updated_at", "assist session title") };
}

export function assistSessionPinFrom(value: unknown): RelayAssistSessionPin {
  const row = object(value, "assist session pin");
  if (typeof row.pinned !== "boolean") throw new Error("Assist 会话置顶回执格式无效。");
  return { sessionId: string(row, "session_id", "assist session pin"), pinned: row.pinned,
    pinnedAt: nullableString(row, "pinned_at", "assist session pin"),
    revision: decimal(row, "revision", "assist session pin"),
    updatedAt: string(row, "updated_at", "assist session pin") };
}

export function assistSessionUnreadFrom(value: unknown): RelayAssistSessionUnread {
  const row = object(value, "assist session unread");
  if (typeof row.unread !== "boolean") throw new Error("Assist 会话未读回执格式无效。");
  return { sessionId: string(row, "session_id", "assist session unread"), unread: row.unread,
    unreadAt: nullableString(row, "unread_at", "assist session unread"),
    revision: decimal(row, "revision", "assist session unread"),
    updatedAt: string(row, "updated_at", "assist session unread") };
}

export function assistSessionStateFrom(value: unknown): RelayAssistSessionState {
  const row = object(value, "assist session state");
  const status = string(row, "status", "assist session state");
  if (status !== "ACTIVE" && status !== "ARCHIVED") throw new Error("Assist 会话状态回执无法识别。");
  return { sessionId: string(row, "session_id", "assist session state"), status,
    revision: decimal(row, "revision", "assist session state"),
    updatedAt: string(row, "updated_at", "assist session state") };
}

export const RELAY_TOOL_CALL_STATUSES = ["REQUESTED", "PREPARED", "WAITING_APPROVAL", "SETTLED",
  "REJECTED", "ABANDONED"] as const;

export function toolCallStatus(value: unknown): RelayToolCallStatus {
  // 封闭词表：把没见过的状态当成合法会让界面显示一个用户无法理解的死路。
  if (typeof value !== "string" || !(RELAY_TOOL_CALL_STATUSES as readonly string[]).includes(value)) {
    throw new Error("工具调用状态无效。");
  }
  return value as RelayToolCallStatus;
}

export function toolCallFrom(value: unknown): RelayRunToolCall {
  const row = object(value, "Run tool call");
  return { id: string(row, "id", "Run tool call"),
    round: integer(row, "round", "Run tool call"), ordinal: integer(row, "ordinal", "Run tool call"),
    toolName: string(row, "tool_name", "Run tool call"),
    status: toolCallStatus(row.status),
    args: object(row.arguments, "Run tool call arguments"),
    argsSha256: string(row, "arguments_sha256", "Run tool call"),
    providerToolCallId: string(row, "provider_tool_call_id", "Run tool call"),
    operationId: nullableString(row, "operation_id", "Run tool call"),
    adaptationOf: nullableString(row, "adaptation_of", "Run tool call"),
    adaptedPath: nullableString(row, "adapted_path", "Run tool call"),
    resultRef: row.result_ref === null || row.result_ref === undefined
      ? null : object(row.result_ref, "Run tool call result"),
    createdAt: string(row, "created_at", "Run tool call"),
    updatedAt: string(row, "updated_at", "Run tool call"),
    fileChanges: array(row, "file_changes", "Run tool call").map((entry) => {
      const file = object(entry, "Run tool call file change");
      const action = string(file, "action", "Run tool call file change");
      if (action !== "CREATE" && action !== "MODIFY" && action !== "DELETE") {
        throw new Error("Run 工具调用的文件动作无法识别。");
      }
      const status = string(file, "status", "Run tool call file change");
      if (!["APPLIED", "CONFLICT", "FAILED", "UNKNOWN"].includes(status)) {
        throw new Error("Run 工具调用的文件状态无法识别。");
      }
      return { path: string(file, "path", "Run tool call file change"),
        action: action as "CREATE" | "MODIFY" | "DELETE",
        status: status as "APPLIED" | "CONFLICT" | "FAILED" | "UNKNOWN",
        added: integer(file, "added", "Run tool call file change"),
        removed: integer(file, "removed", "Run tool call file change"),
        unavailableReason: nullableString(file, "unavailable_reason", "Run tool call file change") };
    }) };
}

export function runToolCallsFrom(value: unknown): RelayRunToolCalls {
  const row = object(value, "Run tool calls");
  return { runId: string(row, "run_id", "Run tool calls"),
    runStatus: string(row, "run_status", "Run tool calls"),
    waitReason: nullableString(row, "wait_reason", "Run tool calls"),
    // 顺序直接信任服务端：客户端重排会掩盖服务端顺序错误，也会让「最新一轮」难以核对。
    rounds: array(row, "rounds", "Run tool calls").map((entry) => {
      const round = object(entry, "Run tool call round");
      return { round: integer(round, "round", "Run tool call round"),
        modelCallId: string(round, "model_call_id", "Run tool call round"),
        calls: array(round, "calls", "Run tool call round").map(toolCallFrom) };
    }) };
}

/**
 * 读出候选声明的那一次检查。
 *
 * 缺 `check` 是正常形状（这次不跑检查），因此这里宽松返回 null 而不抛错；
 * 但形状**存在却不对**（可执行名不是字符串、参数不是字符串数组）必须显式失败——
 * 静默忽略会让确认页把一条将要执行的命令显示成「不跑检查」。
 */
export function conversationCheckFrom(candidate: Record<string, unknown>): RelayConversationCheck | null {
  const raw = candidate.check;
  if (raw === undefined || raw === null) return null;
  const check = object(raw, "conversation execution check");
  const args = array(check, "args", "conversation execution check");
  for (const entry of args) {
    if (typeof entry !== "string") {
      throw new Error("conversation execution check.args 响应格式无效。");
    }
  }
  return { executable: string(check, "executable", "conversation execution check"),
    args: args as readonly string[] };
}

export function conversationExecutionFrom(value: unknown): RelayConversationExecution {
  const row = object(value, "conversation execution");
  const decision = string(row, "decision", "conversation execution");
  if (decision !== "DISCUSS" && decision !== "CLARIFY" && decision !== "PREPARE") {
    throw new Error("conversation execution.decision 无法识别");
  }
  const candidate = row.candidate === null || row.candidate === undefined
    ? null : object(row.candidate, "conversation execution candidate");
  return { requestId: string(row, "request_id", "conversation execution"),
    sessionId: string(row, "session_id", "conversation execution"),
    sourceMessageId: string(row, "source_message_id", "conversation execution"),
    resourceId: string(row, "resource_id", "conversation execution"),
    rootPath: string(row, "root_path", "conversation execution"), decision,
    status: string(row, "status", "conversation execution"),
    candidateStatus: string(row, "candidate_status", "conversation execution"),
    questions: stringArray(row, "questions", "conversation execution"),
    title: candidate === null ? null : optionalString(candidate, "title"),
    objective: candidate === null ? null : optionalString(candidate, "objective"),
    check: candidate === null ? null : conversationCheckFrom(candidate),
    autoStart: row.auto_start === true,
    taskId: nullableString(row, "task_id", "conversation execution"),
    runId: nullableString(row, "run_id", "conversation execution"),
    revision: decimal(row, "revision", "conversation execution") };
}

export function conversationExecutionSummaryFrom(value: unknown): RelayConversationExecution {
  const row = object(value, "conversation execution");
  const candidate = row.candidate === null || row.candidate === undefined
    ? null : object(row.candidate, "conversation execution candidate");
  return { requestId: string(row, "request_id", "conversation execution"),
    sessionId: string(row, "session_id", "conversation execution"),
    sourceMessageId: string(row, "source_message_id", "conversation execution"),
    decision: string(row, "decision", "conversation execution"),
    status: string(row, "status", "conversation execution"),
    candidateStatus: string(row, "candidate_status", "conversation execution"),
    rootPath: string(row, "root_path", "conversation execution"),
    resourceId: optionalString(row, "resource_id") ?? undefined,
    title: candidate === null ? null : optionalString(candidate, "title"),
    objective: candidate === null ? null : optionalString(candidate, "objective"),
    check: candidate === null ? null : conversationCheckFrom(candidate),
    questions: stringArray(row, "questions", "conversation execution"),
    autoStart: row.auto_start === true,
    taskId: nullableString(row, "task_id", "conversation execution"),
    runId: nullableString(row, "run_id", "conversation execution"),
    revision: decimal(row, "revision", "conversation execution") };
}

/** 会话总 diff 的单文件净变化（工作台 §34）。 */
export function conversationDiffFileFrom(value: unknown): RelayConversationFileDiff {
  const row = object(value, "conversation file diff");
  const action = string(row, "action", "conversation file diff");
  if (!["CREATE", "MODIFY", "DELETE", "SAME"].includes(action)) {
    throw new Error("会话文件 diff 动作无效。");
  }
  return {
    path: string(row, "path", "conversation file diff"),
    action: action as RelayConversationFileAction,
    added: integer(row, "added", "conversation file diff"),
    removed: integer(row, "removed", "conversation file diff"),
    unavailableReason: nullableString(row, "unavailable_reason", "conversation file diff"),
  };
}

/** 会话总 diff 的只读投影：基线到当前已落盘内容的净变化（CD-02/03/16/17）。 */
export function conversationDiffFrom(value: unknown): RelayConversationDiff {
  const row = object(value, "conversation diff");
  const available = row.available;
  if (available === true) {
    return {
      available: true,
      baselineCapturedAt: string(row, "baseline_captured_at", "conversation diff"),
      baselineRevision: decimal(row, "baseline_revision", "conversation diff"),
      rootPath: string(row, "root_path", "conversation diff"),
      resourceId: string(row, "resource_id", "conversation diff"),
      incomplete: boolean(row, "incomplete", "conversation diff"),
      totalFiles: integer(row, "total_files", "conversation diff"),
      totalAdded: integer(row, "total_added", "conversation diff"),
      totalRemoved: integer(row, "total_removed", "conversation diff"),
      files: array(row, "files", "conversation diff").map(conversationDiffFileFrom),
    };
  }
  if (available === false) {
    const reason = string(row, "reason", "conversation diff");
    if (!["NO_RESOURCE", "NO_BASELINE", "ROOT_NOT_GIT", "RESOURCE_UNAVAILABLE"].includes(reason)) {
      throw new Error("会话 diff 不可用原因无效。");
    }
    return { available: false, reason: reason as RelayConversationDiffUnavailableReason };
  }
  throw new Error("会话 diff 可用性标记无效。");
}

/** 展开阅读的单文件完整 diff（工作台 §34.2）：行数与总数同源，rows 为 null 时看原因。 */
export function conversationDiffFileDetailFrom(value: unknown): RelayConversationDiffFile {
  const row = object(value, "conversation diff file");
  if (row.available === true) {
    const action = string(row, "action", "conversation diff file");
    if (!["CREATE", "MODIFY", "DELETE", "SAME"].includes(action)) {
      throw new Error("会话文件 diff 动作无效。");
    }
    const rawRows = row.rows;
    const rows = rawRows === null || rawRows === undefined ? null
      : (Array.isArray(rawRows) ? rawRows : (() => {
          throw new Error("会话文件 diff 行无效。");
        })()).map((entry) => {
        const line = object(entry, "conversation diff row");
        const kind = string(line, "kind", "conversation diff row");
        if (!["CONTEXT", "ADD", "REMOVE"].includes(kind)) {
          throw new Error("会话文件 diff 行类型无效。");
        }
        return { kind: kind as "CONTEXT" | "ADD" | "REMOVE",
          oldLine: nullableInteger(line, "old_line", "conversation diff row"),
          newLine: nullableInteger(line, "new_line", "conversation diff row"),
          text: string(line, "text", "conversation diff row") };
      });
    return {
      available: true,
      path: string(row, "path", "conversation diff file"),
      action: action as RelayConversationFileAction,
      added: integer(row, "added", "conversation diff file"),
      removed: integer(row, "removed", "conversation diff file"),
      unavailableReason: nullableString(row, "unavailable_reason", "conversation diff file"),
      rows,
      rowsTruncated: boolean(row, "rows_truncated", "conversation diff file"),
      rowsUnavailableReason: nullableString(row, "rows_unavailable_reason", "conversation diff file"),
    };
  }
  if (row.available === false) {
    const reason = string(row, "reason", "conversation diff file");
    if (!["NO_RESOURCE", "NO_BASELINE", "ROOT_NOT_GIT", "RESOURCE_UNAVAILABLE",
      "PATH_NOT_FOUND"].includes(reason)) {
      throw new Error("会话文件 diff 不可用原因无效。");
    }
    return { available: false, reason: reason as "NO_RESOURCE" | "NO_BASELINE" | "ROOT_NOT_GIT"
      | "RESOURCE_UNAVAILABLE" | "PATH_NOT_FOUND" };
  }
  throw new Error("会话文件 diff 可用性标记无效。");
}

/** 生成中的工具预览（工作台 §34.4）：可丢弃的临时证据；-1 表示待核对。 */
export function runToolCallPreviewsFrom(value: unknown): RelayRunToolCallPreviews {
  const row = object(value, "Run tool call previews");
  return {
    runId: string(row, "run_id", "Run tool call previews"),
    previews: array(row, "previews", "Run tool call previews").map((entry) => {
      const preview = object(entry, "Run tool call preview");
      return {
        modelCallId: string(preview, "model_call_id", "Run tool call preview"),
        ordinal: integer(preview, "ordinal", "Run tool call preview"),
        toolName: string(preview, "tool_name", "Run tool call preview"),
        revision: string(preview, "revision", "Run tool call preview"),
        truncated: boolean(preview, "truncated", "Run tool call preview"),
        updatedAt: string(preview, "updated_at", "Run tool call preview"),
        files: array(preview, "files", "Run tool call preview").map((fileEntry) => {
          const file = object(fileEntry, "Run tool call preview file");
          const action = string(file, "action", "Run tool call preview file");
          if (!["CREATE", "MODIFY", "DELETE", "UNKNOWN"].includes(action)) {
            throw new Error("Run 工具预览的文件动作无效。");
          }
          return {
            path: string(file, "path", "Run tool call preview file"),
            action: action as "CREATE" | "MODIFY" | "DELETE" | "UNKNOWN",
            added: integer(file, "added", "Run tool call preview file"),
            removed: integer(file, "removed", "Run tool call preview file"),
            targetComplete: boolean(file, "target_complete", "Run tool call preview file"),
          };
        }),
      };
    }),
  };
}
