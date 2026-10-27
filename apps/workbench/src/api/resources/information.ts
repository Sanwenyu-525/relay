import type { DecimalRevision } from "../../types";
import { RelayTransportError } from "../core/errors";
import { RelayHttp } from "../core/http";
import { array, decimal, directList, integer, nullableOptionalInteger, nullableString, object, string, stringArray } from "../core/primitives";
import { decisionFrom, interventionFrom, knowledgeCurationCandidateFrom, knowledgeFrom, knowledgeGuideFrom, knowledgeVersionContentFrom, knowledgeVersionFrom, memoryFrom, memoryRevisionFrom, modelVerifyResultFrom, ruleFrom, ruleVersionFrom, searchItemFrom } from "../parse/information";
import { commandEnvelopeFrom } from "../parse/projects";
import type { RelayDecision, RelayInformationKind, RelayInterventionItem, RelayKnowledge, RelayKnowledgeCurationCandidate, RelayKnowledgeGuideEntryInput, RelayKnowledgeSource, RelayKnowledgeVersion, RelayKnowledgeVersionContent, RelayChatImageInput, RelayChatImageInputSource, RelayMemory, RelayModelCapabilityDeclaration, RelayMemoryEffectiveStatus, RelayMemoryRevision, RelayModelPortStatus, RelayModelVerificationState, RelayModelVerifyResult, RelayVerifyTarget, RelayVerifyTargetState, RelayProjectKnowledgeGuide, RelayRule, RelayRuleEnforcement, RelayRuleStrength, RelayRuleVersion, RelaySearchPage } from "../dtos/information";
import type { RelayCommandEnvelope } from "../dtos/projects";

export async function getKnowledge(http: RelayHttp, projectId: string | null = null): Promise<readonly RelayKnowledge[]> {
  return directList(await http.request(informationListPath(http, "knowledge", projectId)), "knowledge list", knowledgeFrom);
}

export async function getKnowledgeDetail(http: RelayHttp, id: string): Promise<RelayKnowledge> {
  return knowledgeFrom(await http.request(http.workspacePath(`/knowledge/${encodeURIComponent(id)}`)));
}

export async function getKnowledgeVersions(http: RelayHttp, id: string): Promise<readonly RelayKnowledgeVersion[]> {
  return directList(await http.request(http.workspacePath(`/knowledge/${encodeURIComponent(id)}/versions`)),
    "knowledge versions", knowledgeVersionFrom);
}

export async function getKnowledgeVersionContent(http: RelayHttp, id: string, version: DecimalRevision): Promise<RelayKnowledgeVersionContent> {
  const result = knowledgeVersionContentFrom(await http.request(http.workspacePath(
    `/knowledge/${encodeURIComponent(id)}/versions/${encodeURIComponent(version)}/content`)));
  if (result.knowledgeId !== id || result.version !== version) {
    throw new Error("知识正文响应与所选资料版本不一致。");
  }
  return result;
}

export async function createKnowledge(http: RelayHttp, input: { commandId: string; projectId: string | null; title: string; sourceKind: Exclude<RelayKnowledgeSource, "WEB_PAGE">; text?: string; mediaType?: string; artifactVersionId?: string }): Promise<RelayCommandEnvelope> {
  return informationCommand(http, "/knowledge", {
    command_id: input.commandId, project_id: input.projectId, title: input.title,
    source_kind: input.sourceKind,
    ...(input.text === undefined ? {} : { text: input.text }),
    ...(input.mediaType === undefined ? {} : { media_type: input.mediaType }),
    ...(input.artifactVersionId === undefined ? {} : { artifact_version_id: input.artifactVersionId })
  }, 201);
}

export async function addKnowledgeVersion(http: RelayHttp, input: { id: string; commandId: string; expectedRevision: DecimalRevision; sourceKind: Exclude<RelayKnowledgeSource, "WEB_PAGE">; text?: string; mediaType?: string; artifactVersionId?: string }): Promise<RelayCommandEnvelope> {
  return informationCommand(http, `/knowledge/${encodeURIComponent(input.id)}/versions`, {
    command_id: input.commandId, expected_revision: input.expectedRevision, source_kind: input.sourceKind,
    ...(input.text === undefined ? {} : { text: input.text }),
    ...(input.mediaType === undefined ? {} : { media_type: input.mediaType }),
    ...(input.artifactVersionId === undefined ? {} : { artifact_version_id: input.artifactVersionId })
  }, 200);
}

export async function archiveKnowledge(http: RelayHttp, id: string, commandId: string, expectedRevision: DecimalRevision): Promise<RelayCommandEnvelope> {
  return informationCommand(http, `/knowledge/${encodeURIComponent(id)}/archive`,
    { command_id: commandId, expected_revision: expectedRevision }, 200);
}

/**
 * 反向命令回执核对：command_id、目标身份、ACTIVE 与修订下限四项都成立才算确认。
 *
 * 调用方拿这个结果当撤销/恢复的唯一依据，因此宁可抛「无法核对」也不能返回部分可信的信封；
 * 修订下限挡的是把归档前的旧回执误当成本次恢复结果（服务端只会返回相等或更大的修订）。
 */
async function restoreCommand(http: RelayHttp, path: string, input: { commandId: string; id: string; expectedRevision: DecimalRevision }, resultKey: string): Promise<RelayCommandEnvelope> {
  const body = await http.request(http.workspacePath(path), { method: "POST", body: JSON.stringify({
    command_id: input.commandId, expected_revision: input.expectedRevision }) }, 200);
  try {
    const envelope = commandEnvelopeFrom(body);
    if (envelope.commandId !== input.commandId) throw new Error("command ID mismatch");
    const id = string(envelope.result, resultKey, "restore result");
    const revision = decimal(envelope.result, "revision", "restore result");
    if (id !== input.id) throw new Error("restore target mismatch");
    if (envelope.result.status !== "ACTIVE") throw new Error("restore status mismatch");
    if (BigInt(revision) < BigInt(input.expectedRevision)) throw new Error("restore revision regression");
    return envelope;
  } catch {
    throw new RelayTransportError("命令回执无法核对，请查询原 command_id。");
  }
}

/** 取消资料归档：只把根状态改回 ACTIVE，不改正文版本、来源与归档产生的待核对候选。 */
export async function unarchiveKnowledge(http: RelayHttp, id: string, commandId: string, expectedRevision: DecimalRevision): Promise<RelayCommandEnvelope> {
  return restoreCommand(http, `/knowledge/${encodeURIComponent(id)}/unarchive`,
    { commandId, id, expectedRevision }, "knowledge_id");
}

/**
 * 记忆列表：默认「全部」，与旧调用保持同一请求形状（不发多余参数）。
 *
 * 有效状态由服务端按数据库时间裁决；前端不按浏览器时钟或 `status === ACTIVE` 过滤已加载列表。
 */
export async function getMemories(http: RelayHttp, projectId: string | null = null,
  effectiveStatus: RelayMemoryEffectiveStatus | "ALL" = "ALL"): Promise<readonly RelayMemory[]> {
  const query = new URLSearchParams();
  if (projectId !== null) query.set("project_id", projectId);
  if (effectiveStatus !== "ALL") query.set("effective_status", effectiveStatus);
  const suffix = query.toString();
  const path = http.workspacePath("/memories");
  return directList(await http.request(suffix === "" ? path : `${path}?${suffix}`), "memory list", memoryFrom);
}

export async function getMemory(http: RelayHttp, id: string): Promise<RelayMemory> {
  return memoryFrom(await http.request(http.workspacePath(`/memories/${encodeURIComponent(id)}`)));
}

export async function getMemoryRevisions(http: RelayHttp, id: string): Promise<readonly RelayMemoryRevision[]> {
  return directList(await http.request(http.workspacePath(`/memories/${encodeURIComponent(id)}/revisions`)),
    "memory revisions", memoryRevisionFrom);
}

export async function createMemory(http: RelayHttp, input: { commandId: string; projectId: string | null; title: string; text: string; confirmed: true; expiresAt?: string | null }): Promise<RelayCommandEnvelope> {
  return informationCommand(http, "/memories", {
    command_id: input.commandId, project_id: input.projectId, title: input.title,
    text: input.text, confirmed: input.confirmed,
    ...(input.expiresAt === undefined ? {} : { expires_at: input.expiresAt })
  }, 201);
}

export async function addMemoryRevision(http: RelayHttp, input: { id: string; commandId: string; expectedRevision: DecimalRevision; title: string; text: string; confirmed: true; expiresAt?: string | null }): Promise<RelayCommandEnvelope> {
  return informationCommand(http, `/memories/${encodeURIComponent(input.id)}/revisions`, {
    command_id: input.commandId, expected_revision: input.expectedRevision, title: input.title,
    text: input.text, confirmed: input.confirmed,
    ...(input.expiresAt === undefined ? {} : { expires_at: input.expiresAt })
  }, 200);
}

export async function retireMemory(http: RelayHttp, id: string, commandId: string, expectedRevision: DecimalRevision): Promise<RelayCommandEnvelope> {
  return informationCommand(http, `/memories/${encodeURIComponent(id)}/retire`,
    { command_id: commandId, expected_revision: expectedRevision }, 200);
}

/** 恢复记忆：只改根状态；确认主体与有效期不变，已过期版本仍按原过滤规则排除。 */
export async function reactivateMemory(http: RelayHttp, id: string, commandId: string, expectedRevision: DecimalRevision): Promise<RelayCommandEnvelope> {
  return restoreCommand(http, `/memories/${encodeURIComponent(id)}/reactivate`,
    { commandId, id, expectedRevision }, "memory_id");
}

export async function getDecisions(http: RelayHttp, projectId: string | null = null): Promise<readonly RelayDecision[]> {
  return directList(await http.request(informationListPath(http, "decisions", projectId)), "decision list", decisionFrom);
}

export async function getDecision(http: RelayHttp, id: string): Promise<RelayDecision> {
  return decisionFrom(await http.request(http.workspacePath(`/decisions/${encodeURIComponent(id)}`)));
}

export async function createDecision(http: RelayHttp, input: { commandId: string; projectId: string | null; title: string; choice: string; rationale: string; alternatives: readonly string[]; costs: readonly string[] }): Promise<RelayCommandEnvelope> {
  return informationCommand(http, "/decisions", {
    command_id: input.commandId, project_id: input.projectId, title: input.title,
    choice: input.choice, rationale: input.rationale,
    alternatives: [...input.alternatives], costs: [...input.costs]
  }, 201);
}

export async function supersedeDecision(http: RelayHttp, input: { id: string; commandId: string; expectedRevision: DecimalRevision; replacementDecisionId: string }): Promise<RelayCommandEnvelope> {
  return informationCommand(http, `/decisions/${encodeURIComponent(input.id)}/supersessions`, {
    command_id: input.commandId, expected_revision: input.expectedRevision,
    replacement_decision_id: input.replacementDecisionId
  }, 200);
}

export async function getRules(http: RelayHttp, projectId: string | null = null): Promise<readonly RelayRule[]> {
  return directList(await http.request(informationListPath(http, "rules", projectId)), "rule list", ruleFrom);
}

export async function getRule(http: RelayHttp, id: string): Promise<RelayRule> {
  return ruleFrom(await http.request(http.workspacePath(`/rules/${encodeURIComponent(id)}`)));
}

export async function getRuleVersions(http: RelayHttp, id: string): Promise<readonly RelayRuleVersion[]> {
  return directList(await http.request(http.workspacePath(`/rules/${encodeURIComponent(id)}/versions`)),
    "rule versions", ruleVersionFrom);
}

/** 规则键可选：缺省时由服务端按 command_id 生成稳定唯一键（HTTP §10.106）。 */
export async function createRule(http: RelayHttp, input: { commandId: string; scope: "WORKSPACE" | "PROJECT" | "TASK"; scopeId: string; ruleKey?: string; statement: string; strength: RelayRuleStrength; enforcement: RelayRuleEnforcement; method?: string; targetSpec?: Readonly<Record<string, unknown>> }): Promise<RelayCommandEnvelope> {
  return informationCommand(http, "/rules", {
    command_id: input.commandId, scope: input.scope, scope_id: input.scopeId,
    ...(input.ruleKey === undefined ? {} : { rule_key: input.ruleKey }),
    statement: input.statement, strength: input.strength,
    applicability: "AI_RUN", enforcement: input.enforcement,
    ...(input.method === undefined ? {} : { method: input.method }),
    ...(input.targetSpec === undefined ? {} : { target_spec: input.targetSpec })
  }, 201);
}

export async function addRuleVersion(http: RelayHttp, input: { id: string; commandId: string; expectedRevision: DecimalRevision; ruleKey: string; statement: string; strength: RelayRuleStrength; enforcement: RelayRuleEnforcement; method?: string; targetSpec?: Readonly<Record<string, unknown>> }): Promise<RelayCommandEnvelope> {
  return informationCommand(http, `/rules/${encodeURIComponent(input.id)}/versions`, {
    command_id: input.commandId, expected_revision: input.expectedRevision,
    rule_key: input.ruleKey, statement: input.statement, strength: input.strength,
    applicability: "AI_RUN", enforcement: input.enforcement,
    ...(input.method === undefined ? {} : { method: input.method }),
    ...(input.targetSpec === undefined ? {} : { target_spec: input.targetSpec })
  }, 200);
}

export async function retireRule(http: RelayHttp, id: string, commandId: string, expectedRevision: DecimalRevision): Promise<RelayCommandEnvelope> {
  return informationCommand(http, `/rules/${encodeURIComponent(id)}/retire`,
    { command_id: commandId, expected_revision: expectedRevision }, 200);
}

/** 恢复规则：只改根状态；rule_revision / context_revision 继续递增，不回退既有执行契约。 */
export async function reactivateRule(http: RelayHttp, id: string, commandId: string, expectedRevision: DecimalRevision): Promise<RelayCommandEnvelope> {
  return restoreCommand(http, `/rules/${encodeURIComponent(id)}/reactivate`,
    { commandId, id, expectedRevision }, "rule_id");
}

export async function searchInformation(http: RelayHttp, input: { q: string; projectId: string | null; types: readonly RelayInformationKind[]; limit?: number; cursor?: string }): Promise<RelaySearchPage> {
  const query = new URLSearchParams({ q: input.q, types: input.types.join(","), limit: String(input.limit ?? 20) });
  if (input.projectId !== null) query.set("project_id", input.projectId);
  if (input.cursor !== undefined) query.set("cursor", input.cursor);
  const record = object(await http.request(`${http.workspacePath("/search")}?${query.toString()}`), "search");
  return {
    items: array(record, "items", "search").map(searchItemFrom),
    nextCursor: nullableString(record, "next_cursor", "search")
  };
}

export function informationListPath(http: RelayHttp, resource: string, projectId: string | null): string {
  const path = http.workspacePath(`/${resource}`);
  return projectId === null ? path : `${path}?${new URLSearchParams({ project_id: projectId })}`;
}

export async function informationCommand(http: RelayHttp, path: string, payload: Record<string, unknown>, status: number): Promise<RelayCommandEnvelope> {
  const body = await http.request(http.workspacePath(path), { method: "POST", body: JSON.stringify(payload) }, status);
  try {
    const envelope = commandEnvelopeFrom(body);
    if (envelope.commandId !== payload.command_id) throw new Error("command ID mismatch");
    return envelope;
  } catch {
    throw new RelayTransportError("命令回执无法核对，请查询原 command_id。");
  }
}

/** N03 导读是 Project 拥有的编排，不属于 Context 自动注入范围。 */
export async function getProjectKnowledgeGuide(http: RelayHttp, projectId: string): Promise<RelayProjectKnowledgeGuide> {
  return knowledgeGuideFrom(await http.request(http.workspacePath(
    `/projects/${encodeURIComponent(projectId)}/knowledge-guide`)));
}

/** 整份替换式保存：编辑导读就是替换清单，条目可删但被引用对象不可变。 */
export async function saveProjectKnowledgeGuide(http: RelayHttp, input: { readonly projectId: string; readonly expectedRevision: DecimalRevision; readonly entries: readonly RelayKnowledgeGuideEntryInput[]; readonly commandId: string }): Promise<{ readonly revision: DecimalRevision; readonly entryCount: number }> {
  const result = object(commandEnvelopeFrom(await http.request(http.workspacePath(
    `/projects/${encodeURIComponent(input.projectId)}/knowledge-guide`), {
    method: "PUT", body: JSON.stringify({ command_id: input.commandId,
      expected_revision: input.expectedRevision,
      entries: input.entries.map((entry) => ({ ...entry })) }) })).result,
  "knowledge guide request");
  // 保存命令的 entry_count 按 revision 同口径传十进制字符串（GET 导读才是整数）；
  // 两种形状都按可核对解析，其他形状显式失败，不当成 0 条。
  const entryCount = typeof result.entry_count === "string"
    ? decimal(result, "entry_count", "knowledge guide request")
    : integer(result, "entry_count", "knowledge guide request");
  return { revision: decimal(result, "revision", "knowledge guide request"),
    entryCount: Number(entryCount) };
}

/**
 * 只由用户主动请求产生；不接受任何自动或后台触发。
 *
 * 命令回执只带候选 ID（`{ project_id, candidate_ids }`），不回整对象——新候选的正文由
 * 随后的列表读取提供。按 `items` 解析会必然抛 `RelayContractError`，调用方也只用条数。
 */
export async function createKnowledgeCurationCandidates(http: RelayHttp, input: { readonly projectId: string; readonly sources: readonly { readonly artifactVersionId: string; readonly suggestedTitle?: string }[]; readonly commandId: string }): Promise<readonly string[]> {
  const result = object(commandEnvelopeFrom(await http.request(http.workspacePath(
    `/projects/${encodeURIComponent(input.projectId)}/knowledge-curation-candidates`), {
    method: "POST", body: JSON.stringify({ command_id: input.commandId,
      sources: input.sources.map((source) => ({ artifact_version_id: source.artifactVersionId,
        ...(source.suggestedTitle === undefined ? {} : { suggested_title: source.suggestedTitle }) })) }) })).result,
  "curation candidate request");
  return stringArray(result, "candidate_ids", "curation candidate request");
}

export async function listKnowledgeCurationCandidates(http: RelayHttp, projectId: string): Promise<readonly RelayKnowledgeCurationCandidate[]> {
  const result = object(await http.request(http.workspacePath(
    `/projects/${encodeURIComponent(projectId)}/knowledge-curation-candidates`)), "curation candidates");
  return array(result, "items", "curation candidates").map(knowledgeCurationCandidateFrom);
}

/** 接受不是独立命令，但满足契约幂等语义：同 command_id 重放或并发都返回原回执。 */
export async function acceptKnowledgeCurationCandidate(http: RelayHttp, input: { readonly projectId: string; readonly candidateId: string; readonly commandId: string }): Promise<{ readonly candidateId: string; readonly knowledgeId: string; readonly knowledgeVersionId: string; readonly knowledgeRevision: DecimalRevision; readonly mode: "CREATED" | "NEW_VERSION" }> {
  const result = object(commandEnvelopeFrom(await http.request(http.workspacePath(
    `/projects/${encodeURIComponent(input.projectId)}/knowledge-curation-candidates/${encodeURIComponent(input.candidateId)}/accept`),
  { method: "POST", body: JSON.stringify({ command_id: input.commandId }) })).result,
  "accept curation request");
  return { candidateId: string(result, "candidate_id", "accept curation request"),
    knowledgeId: string(result, "knowledge_id", "accept curation request"),
    knowledgeVersionId: string(result, "knowledge_version_id", "accept curation request"),
    knowledgeRevision: decimal(result, "knowledge_revision", "accept curation request"),
    mode: string(result, "mode", "accept curation request") as "CREATED" | "NEW_VERSION" };
}

export async function rejectKnowledgeCurationCandidate(http: RelayHttp, input: { readonly projectId: string; readonly candidateId: string; readonly commandId: string }): Promise<{ readonly candidateId: string; readonly status: "REJECTED" }> {
  const result = object(commandEnvelopeFrom(await http.request(http.workspacePath(
    `/projects/${encodeURIComponent(input.projectId)}/knowledge-curation-candidates/${encodeURIComponent(input.candidateId)}/reject`),
  { method: "POST", body: JSON.stringify({ command_id: input.commandId }) })).result,
  "reject curation request");
  return { candidateId: string(result, "candidate_id", "reject curation request"),
    status: string(result, "status", "reject curation request") as "REJECTED" };
}

export async function getInterventions(http: RelayHttp): Promise<readonly RelayInterventionItem[]> {
  const row = object(await http.request(http.workspacePath('/attention/interventions')), "interventions");
  return array(row, "items", "interventions").map(interventionFrom);
}

/**
 * 图片输入能力：新增字段。旧服务端不返回时按 `UNKNOWN` 处理——界面只是不提前提示，
 * 发送时的闸门仍是准绳（不因为读不到就宣称可以发）。
 */
const CHAT_IMAGE_INPUT_STATES: readonly RelayChatImageInput[] = ["NOT_CONFIGURED", "SUPPORTED",
  "DECLARED", "MODEL_LACKS_IMAGE_INPUT", "MODEL_NOT_IN_CATALOG", "UNKNOWN"];
function chatImageInputFrom(row: Record<string, unknown>): RelayChatImageInput {
  const value = row.image_input;
  if (value === undefined) return "UNKNOWN";
  if (typeof value === "string" && (CHAT_IMAGE_INPUT_STATES as readonly string[]).includes(value)) {
    return value as RelayChatImageInput;
  }
  throw new Error("model-port 返回了无法识别的 image_input 取值。");
}

/** 结论来源：旧服务端不返回时按 NONE（不冒充「目录判定」）。 */
const CHAT_IMAGE_INPUT_SOURCES: readonly RelayChatImageInputSource[] =
  ["CATALOG", "DECLARED", "ENV", "NONE"];
function chatImageInputSourceFrom(row: Record<string, unknown>): RelayChatImageInputSource {
  const value = row.image_input_source;
  if (value === undefined) return "NONE";
  if (typeof value === "string" && (CHAT_IMAGE_INPUT_SOURCES as readonly string[]).includes(value)) {
    return value as RelayChatImageInputSource;
  }
  throw new Error("model-port 返回了无法识别的 image_input_source 取值。");
}

/** 模型端口只读状态：服务端保证不含密钥。 */
export async function getModelPortStatus(http: RelayHttp): Promise<RelayModelPortStatus> {
  const row = object(await http.request(http.workspacePath('/model-port')), "model-port");
  const provider = string(row, "provider", "model-port");
  if (provider !== "fake" && provider !== "openai-compatible" && provider !== "invalid") {
    throw new Error("服务端返回了无法识别的模型端口状态。");
  }
  return { provider,
    configured: row.configured === true,
    model: row.model === null ? null : string(row, "model", "model-port"),
    baseUrl: row.base_url === null ? null : string(row, "base_url", "model-port"),
    // max_call_tokens 是可选新增字段：缺失等同"不可核对"，不能当作 0 或默认值。
    maxCallTokens: nullableOptionalInteger(row, "max_call_tokens", "model-port"),
    imageInput: chatImageInputFrom(row),
    imageInputSource: chatImageInputSourceFrom(row) };
}

/**
 * 模型能力声明（2026-10-19，迁移 0121）。
 *
 * 三个调用面：列出、覆盖声明、撤销声明。它是实例级配置而非业务命令，所以没有
 * command_id 与回执——同键再写就是改口，GET 是权威读取。
 */
function capabilityFrom(value: unknown): RelayModelCapabilityDeclaration {
  const row = object(value, "model-capability");
  return { provider: string(row, "provider", "model-capability"),
    sourceModelId: string(row, "source_model_id", "model-capability"),
    imageInput: row.image_input === true,
    note: row.note === null ? null : string(row, "note", "model-capability"),
    declaredAt: string(row, "declared_at", "model-capability"),
    updatedAt: string(row, "updated_at", "model-capability") };
}

export async function getModelCapabilities(http: RelayHttp):
Promise<readonly RelayModelCapabilityDeclaration[]> {
  const body = object(await http.request(http.workspacePath('/model-capabilities')),
    "model-capabilities");
  if (!Array.isArray(body.items)) throw new Error("model-capabilities 缺少 items 数组。");
  return body.items.map(capabilityFrom);
}

export async function putModelCapability(http: RelayHttp, input: {
  readonly provider: string; readonly model: string;
  readonly imageInput: boolean; readonly note?: string | null;
}): Promise<RelayModelCapabilityDeclaration> {
  return capabilityFrom(await http.request(
    http.workspacePath(`/model-capabilities/${encodeURIComponent(input.provider)}/${encodeURIComponent(input.model)}`),
    { method: "PUT", body: JSON.stringify({ image_input: input.imageInput,
      note: input.note ?? null }) }));
}

export async function deleteModelCapability(http: RelayHttp, input: {
  readonly provider: string; readonly model: string;
}): Promise<boolean> {
  const body = object(await http.request(
    http.workspacePath(`/model-capabilities/${encodeURIComponent(input.provider)}/${encodeURIComponent(input.model)}`),
    { method: "DELETE" }), "model-capability delete");
  return body.removed === true;
}

const VERIFY_TARGET_STATES: readonly RelayVerifyTargetState[] = ["NOT_CONFIGURED",
  "CONFIG_INCOMPLETE", "UNVERIFIED", "VERIFIED", "CREDENTIAL_CHANGED", "AUTH_FAILED",
  "MODEL_NOT_FOUND", "CATALOG_STALE", "CAPABILITY_INSUFFICIENT", "FREE_INELIGIBLE",
  "ACCOUNT_COOLDOWN", "BUDGET_EXHAUSTED", "UNKNOWN"];

/** 目标查询串：缺省目标不带参数，旧服务端行为不变。 */
function verifyTargetQuery(target: RelayVerifyTarget | undefined): string {
  if (target === undefined || target.connection === "default") return "";
  const model = target.model?.trim() ?? "";
  if (model === "") throw new Error("验证目标缺少确切型号。");
  return `?connection=openrouter&model=${encodeURIComponent(model)}`;
}

/** 最近一次模型验证与当前配置指纹匹配情况（可指定目标，P1-4）。 */
export async function getModelPortVerification(http: RelayHttp,
  target?: RelayVerifyTarget): Promise<RelayModelVerificationState> {
  const row = object(await http.request(http.workspacePath(
    `/model-port/verification${verifyTargetQuery(target)}`)), "model-port verification");
  const fingerprint = row.current_config_fingerprint === null
    ? null : string(row, "current_config_fingerprint", "model-port verification");
  const last = row.last === null ? null : modelVerifyResultFrom(
    object(row.last, "model-port verification.last"));
  // 字段缺失（旧服务端）才退回实例级 last；显式 null 表示「本目标没有验证行」，
  // 不能拿另一个型号的成功顶替它。
  const targetLast = row.target_last === undefined ? last
    : row.target_last === null ? null
      : modelVerifyResultFrom(object(row.target_last, "model-port verification.target_last"));
  const worker = string(row, "worker_startup_validation", "model-port verification");
  if (worker !== "NOT_CONFIGURED" && worker !== "OK" && worker !== "FAILED") {
    throw new Error("服务端返回了无法识别的 Worker 启动校验状态。");
  }
  // 新字段对旧服务端容错：缺失时退回旧语义，不谎报目标状态。
  const rawState = row.state;
  const state = typeof rawState === "string" &&
    (VERIFY_TARGET_STATES as readonly string[]).includes(rawState)
    ? rawState as RelayVerifyTargetState : null;
  const credential = row.credential_identity;
  const credentialIdentity = credential === "MATCH" || credential === "CHANGED" ||
    credential === "UNKNOWN" ? credential : "UNKNOWN" as const;
  const connection = row.connection === "openrouter" ? "openrouter" as const : "default" as const;
  return {
    target: typeof row.target === "string" ? row.target : "default",
    connection,
    model: row.model === undefined || row.model === null ? null
      : string(row, "model", "model-port verification"),
    currentConfigFingerprint: fingerprint, last, targetLast,
    matchesCurrentConfig: row.matches_current_config === true,
    credentialIdentity, state,
    workerStartupValidation: worker,
  };
}

/** 触发一次连接/模型验证；结果由服务端写入 model_calls，不含密钥。 */
export async function verifyModelPort(http: RelayHttp,
  target?: RelayVerifyTarget): Promise<RelayModelVerifyResult> {
  const body = target === undefined || target.connection === "default" ? undefined
    : { connection: "openrouter", model: target.model };
  return modelVerifyResultFrom(object(await http.request(
    http.workspacePath("/model-port/verify"), {
      method: "POST",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), "model-port verify"));
}

export async function claimInterventionNotifications(http: RelayHttp): Promise<readonly RelayInterventionItem[]> {
  const row = object(await http.request(http.workspacePath('/attention/notifications/claim'),
    { method: 'POST' }), "claimed interventions");
  return array(row, "items", "claimed interventions").map(interventionFrom);
}

export async function settleInterventionNotification(http: RelayHttp, item: RelayInterventionItem, status: "DISPATCHED" | "DENIED" | "FAILED"): Promise<void> {
  await http.request(http.workspacePath('/attention/notifications/settle'), { method: 'POST',
    body: JSON.stringify({ item_key: item.itemKey, change_key: item.changeKey, status }) });
}
