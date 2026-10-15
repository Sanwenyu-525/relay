import type { DecimalRevision } from "../../types";
import { RelayTransportError } from "../core/errors";
import { RelayHttp } from "../core/http";
import { array, boolean, decimal, nullableString, object, string } from "../core/primitives";
import { assistMessageFrom, assistantProfileFrom, assistProposalFrom, assistSessionBindingFrom, assistSessionDirectoryBindingFrom, assistSessionFrom, assistSourceBody, conversationExecutionFrom, conversationExecutionSummaryFrom, packDefinitionFrom, skillDefinitionFrom, workingDirectoryFrom } from "../parse/assist";
import { commandEnvelopeFrom } from "../parse/projects";
import type { RelayAssistLivePreview, RelayAssistMessage, RelayAssistProposal, RelayAssistSession, RelayAssistSessionBinding, RelayAssistSessionDirectoryBinding, RelayAssistantProfile, RelayConversationMode, RelayAssistSourceRef, RelayConversationExecution, RelayConversationExecutionStage, RelayPackDefinition, RelaySkillDefinition, RelaySkillInput, RelayWorkingDirectory } from "../dtos/assist";
import type { RelayCommandEnvelope } from "../dtos/projects";

export async function getAssistSessions(http: RelayHttp, target: { projectId?: string; taskId?: string } = {}): Promise<readonly RelayAssistSession[]> {
  const query = new URLSearchParams();
  if (target.projectId) query.set("project_id", target.projectId);
  if (target.taskId) query.set("task_id", target.taskId);
  const body = object(await http.request(`${http.workspacePath("/assist-sessions")}?${query}`), "assist sessions");
  return array(body, "items", "assist sessions").map(assistSessionFrom);
}

export async function getAssistSession(http: RelayHttp, sessionId: string): Promise<RelayAssistSession> {
  return assistSessionFrom(await http.request(http.workspacePath(
    `/assist-sessions/${encodeURIComponent(sessionId)}`)));
}

export async function getFirstPartySkills(http: RelayHttp): Promise<readonly RelaySkillDefinition[]> {
  const body = object(await http.request(http.workspacePath("/skill-definitions")), "skill definitions");
  return array(body, "items", "skill definitions").map(skillDefinitionFrom);
}

export async function getFirstPartyPacks(http: RelayHttp): Promise<readonly RelayPackDefinition[]> {
  const body = object(await http.request(http.workspacePath("/packs")), "packs");
  return array(body, "items", "packs").map(packDefinitionFrom);
}

/**
 * 建会话。身份在建立时冻结，因此模式与助手进**命令体**而不是查询参数：
 * 同一个 command_id 换模式重放会被服务端按异载荷拒绝，这正是我们要的行为。
 */
export async function createAssistSession(http: RelayHttp, input: { commandId: string; projectId: string | null; taskId: string | null; title: string; conversationMode?: RelayConversationMode; assistantProfileId?: string | null }): Promise<RelayAssistSession> {
  const body = await http.request(http.workspacePath("/assist-sessions"), { method: "POST",
    body: JSON.stringify({ command_id: input.commandId, project_id: input.projectId,
      task_id: input.taskId, title: input.title,
      ...(input.conversationMode === undefined ? {} : { conversation_mode: input.conversationMode }),
      ...(input.assistantProfileId === undefined || input.assistantProfileId === null ? {} : { assistant_profile_id: input.assistantProfileId }) }) }, 201);
  try {
    const envelope = commandEnvelopeFrom(body);
    if (envelope.commandId !== input.commandId) throw new Error("command mismatch");
    return assistSessionFrom({ ...envelope.result, id: envelope.result.session_id });
  } catch { throw new RelayTransportError("Assist 会话回执无法核对，请查询原 command_id。"); }
}

/**
 * 把一段尚未归属的既有讨论归入项目（工作台 §18.1）。
 *
 * 归属与执行准入是两件事：这条命令只改 project_id，不建资源、不授执行权、不产生提案。
 * 回执必须按原 command_id 与原 session_id 逐字核对——回执对不上时不能当成已归属，
 * 也不能换新 ID 重试，只能按原 command_id 查询回执。
 */
export async function bindAssistSessionProject(http: RelayHttp, input: { sessionId: string; commandId: string; projectId: string }): Promise<RelayAssistSessionBinding> {
  const body = await http.request(http.workspacePath(
    `/assist-sessions/${encodeURIComponent(input.sessionId)}/binding`), { method: "POST",
    body: JSON.stringify({ command_id: input.commandId, project_id: input.projectId }) }, 200);
  try {
    const envelope = commandEnvelopeFrom(body);
    if (envelope.commandId !== input.commandId) throw new Error("command mismatch");
    const binding = assistSessionBindingFrom(envelope.result);
    if (binding.sessionId !== input.sessionId) throw new Error("command mismatch");
    return binding;
  } catch { throw new RelayTransportError("Assist 会话归属回执无法核对，请查询原 command_id。"); }
}

/**
 * 绑定本会话的当前工作目录（0087 / 运行架构 §2.7.1）。
 *
 * 目录绑定是**作用域**而不是准入：这条命令只让服务端的读取动作有一个确切目标，
 * 不授予任何能力。回执按原 command_id、原 session_id 与原 resource_id 逐字核对——
 * 对不上时既不能当成已绑定，也不能换新 ID 重试，只能按原 command_id 查回执。
 */
export async function bindAssistSessionDirectory(http: RelayHttp, input: { sessionId: string; commandId: string; resourceId: string }): Promise<RelayAssistSessionDirectoryBinding> {
  const body = await http.request(http.workspacePath(
    `/assist-sessions/${encodeURIComponent(input.sessionId)}/working-directory`), { method: "POST",
    body: JSON.stringify({ command_id: input.commandId, resource_id: input.resourceId }) }, 200);
  try {
    const envelope = commandEnvelopeFrom(body);
    if (envelope.commandId !== input.commandId) throw new Error("command mismatch");
    const binding = assistSessionDirectoryBindingFrom(envelope.result);
    if (binding.sessionId !== input.sessionId ||
        binding.workingResourceId !== input.resourceId) throw new Error("command mismatch");
    return binding;
  } catch { throw new RelayTransportError("Assist 会话目录回执无法核对，请查询原 command_id。"); }
}

export async function getAssistMessages(http: RelayHttp, sessionId: string): Promise<readonly RelayAssistMessage[]> {
  const body = object(await http.request(http.workspacePath(`/assist-sessions/${encodeURIComponent(sessionId)}/messages?limit=200`)), "assist messages");
  return array(body, "items", "assist messages").map(assistMessageFrom);
}

export async function getAssistLivePreview(http: RelayHttp, sessionId: string, messageId: string): Promise<RelayAssistLivePreview> {
  const row = object(await http.request(http.workspacePath(
    `/assist-sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}/live-preview`)),
  "assist live preview");
  const status = string(row, "status", "assist live preview");
  if (!["PENDING", "RUNNING", "COMPLETED", "FAILED", "CANCELLED"].includes(status) ||
    string(row, "session_id", "assist live preview") !== sessionId ||
    string(row, "message_id", "assist live preview") !== messageId) {
    throw new RelayTransportError("Assist 草稿预览与当前消息不匹配。");
  }
  return { sessionId, messageId, status: status as RelayAssistMessage["status"],
    previewRevision: decimal(row, "preview_revision", "assist live preview"),
    previewText: nullableString(row, "preview_text", "assist live preview"),
    previewTruncated: boolean(row, "preview_truncated", "assist live preview"),
    previewAvailable: boolean(row, "preview_available", "assist live preview") };
}

/**
 * 发一条消息。三个分支是**排他的**，不是可选字段的组合：
 * 普通档带 intent 或 skill_ref；助手档两个都不带——服务端会以 409 拒绝助手档的
 * intent 与 Skill（ADR-018、命令契约 §10.60.4），客户端就不该把这条路留出来。
 */
export async function requestAssistMessage(http: RelayHttp, input: { sessionId: string; commandId: string; content: string; sourceRefs: readonly RelayAssistSourceRef[]; recordLearning?: boolean } & ( { intent: "DISCUSS" | "PROPOSE_CANDIDATE" | "PROPOSE_TASK"; skillRef?: never; skillInput?: never } | { intent?: never; skillRef: { id: string; version: string }; skillInput: RelaySkillInput } | { intent?: never; skillRef?: never; skillInput?: never } )): Promise<{ userMessageId: string; assistantMessageId: string }> {
  const body = await http.request(http.workspacePath(`/assist-sessions/${encodeURIComponent(input.sessionId)}/messages`), {
    method: "POST", body: JSON.stringify({ command_id: input.commandId, content: input.content,
      source_refs: input.sourceRefs.map(assistSourceBody),
      ...(input.recordLearning === undefined ? {} : { record_learning: input.recordLearning }),
      ...(input.skillRef ? { skill_ref: input.skillRef, skill_input: input.skillInput }
        : input.intent ? { intent: input.intent } : {}) }) }, 202);
  try {
    const envelope = commandEnvelopeFrom(body);
    if (envelope.commandId !== input.commandId || envelope.result.session_id !== input.sessionId) throw new Error("command mismatch");
    return { userMessageId: string(envelope.result, "user_message_id", "assist result"),
      assistantMessageId: string(envelope.result, "assistant_message_id", "assist result") };
  } catch { throw new RelayTransportError("Assist 消息回执无法核对，请查询原 command_id。"); }
}

export async function cancelAssistMessage(http: RelayHttp, messageId: string, commandId: string): Promise<string> {
  const body = await http.request(http.workspacePath(`/assist-messages/${encodeURIComponent(messageId)}/cancel`), {
    method: "POST", body: JSON.stringify({ command_id: commandId }) }, 200);
  try {
    const envelope = commandEnvelopeFrom(body);
    if (envelope.commandId !== commandId || envelope.result.message_id !== messageId) throw new Error("command mismatch");
    return string(envelope.result, "status", "assist cancel result");
  } catch { throw new RelayTransportError("Assist 取消回执无法核对，请查询原 command_id。"); }
}

export async function getAssistProposals(http: RelayHttp, sessionId: string): Promise<readonly RelayAssistProposal[]> {
  const query = new URLSearchParams({ session_id: sessionId });
  const body = object(await http.request(`${http.workspacePath("/assist-proposals")}?${query}`), "assist proposals");
  return array(body, "items", "assist proposals").map(assistProposalFrom);
}

/** 文件夹入口：可能建立最小 Project 与受管资源，因此是写命令；页面读取不得调用它。 */
export async function openWorkingDirectory(http: RelayHttp, input: { commandId: string; rootPath: string; projectId?: string | null }): Promise<RelayWorkingDirectory> {
  const envelope = commandEnvelopeFrom(await http.request(
    http.workspacePath("/working-directories/open"), { method: "POST", body: JSON.stringify({
      command_id: input.commandId, root_path: input.rootPath,
      project_id: input.projectId ?? null }) }, 200));
  if (envelope.commandId !== input.commandId) {
    throw new RelayTransportError("打开文件夹的命令回执无法对应，请查询原 command_id。");
  }
  return workingDirectoryFrom(envelope.result);
}

/** 明确执行请求：原消息 → 已保存候选。模型调用在服务端事务外，命令本身可安全重放。 */
export async function interpretConversationMessage(http: RelayHttp, input: { sessionId: string; sourceMessageId: string; resourceId: string; commandId: string }): Promise<RelayConversationExecution> {
  const envelope = commandEnvelopeFrom(await http.request(
    http.workspacePath(`/assist-sessions/${encodeURIComponent(input.sessionId)}/execution-requests`),
    { method: "POST", body: JSON.stringify({ command_id: input.commandId,
      source_message_id: input.sourceMessageId, resource_id: input.resourceId }) }, 202));
  if (envelope.commandId !== input.commandId) {
    throw new RelayTransportError("执行请求的命令回执无法对应，请查询原 command_id。");
  }
  return conversationExecutionFrom(envelope.result);
}

/** 候选 → Task/READY/Delegate。按请求行上固定的命令身份重放，不会产生第二个 Task/Run。 */
export async function applyConversationExecution(http: RelayHttp, requestId: string): Promise<RelayConversationExecutionStage> {
  const envelope = commandEnvelopeFrom(await http.request(
    http.workspacePath(`/conversation-execution-requests/${encodeURIComponent(requestId)}/applications`),
    { method: "POST", body: JSON.stringify({}) }, 200));
  const result = envelope.result;
  return { requestId: string(result, "request_id", "conversation execution result"),
    status: string(result, "status", "conversation execution result"),
    taskId: nullableString(result, "task_id", "conversation execution result"),
    runId: nullableString(result, "run_id", "conversation execution result"),
    revision: decimal(result, "revision", "conversation execution result") };
}

export async function getConversationExecutionRequests(http: RelayHttp, sessionId: string): Promise<readonly RelayConversationExecution[]> {
  const query = new URLSearchParams({ session_id: sessionId });
  const body = object(await http.request(
    `${http.workspacePath("/conversation-execution-requests")}?${query}`), "conversation execution requests");
  return array(body, "items", "conversation execution requests").map(conversationExecutionSummaryFrom);
}

export async function acceptAssistProposal(http: RelayHttp, proposalId: string, commandId: string, taskContract?: { expectedTaskRevision: DecimalRevision; expectedAcceptanceRevision: DecimalRevision; payloadHash: string }): Promise<RelayCommandEnvelope> {
  const body = await http.request(http.workspacePath(`/assist-proposals/${encodeURIComponent(proposalId)}/accept`), {
    method: "POST", body: JSON.stringify({ command_id: commandId,
      ...(taskContract ? { expected_task_revision: taskContract.expectedTaskRevision,
        expected_acceptance_revision: taskContract.expectedAcceptanceRevision,
        payload_hash: taskContract.payloadHash } : {}) }) }, 200);
  try {
    const envelope = commandEnvelopeFrom(body);
    if (envelope.commandId !== commandId) throw new Error("command mismatch");
    return envelope;
  } catch { throw new RelayTransportError("提案接受回执无法核对，请查询原 command_id。"); }
}
/** 默认只列活跃助手；includeArchived=true 时连归档项一起列，界面据此显示「已归档」。 */
export async function getAssistantProfiles(http: RelayHttp, options: { includeArchived?: boolean } = {}): Promise<readonly RelayAssistantProfile[]> {
  const query = new URLSearchParams();
  if (options.includeArchived) query.set("status", "ARCHIVED");
  const suffix = query.size > 0 ? `?${query}` : "";
  const body = object(await http.request(`${http.workspacePath("/assistant-profiles")}${suffix}`), "assistant profiles");
  return array(body, "items", "assistant profiles").map(assistantProfileFrom);
}

/** 命令回执里的结果字段名是 assistant_profile_id，与列表 DTO 的 id 不同名，这里映射过去。 */
function profileFromResult(result: Record<string, unknown>): RelayAssistantProfile {
  return assistantProfileFrom({ ...result, id: result.assistant_profile_id });
}

export async function createAssistantProfile(http: RelayHttp, input: { commandId: string; name: string; roleDescription: string; tone?: string; readScope?: { roots: readonly string[] } }): Promise<RelayAssistantProfile> {
  const body = await http.request(http.workspacePath("/assistant-profiles"), { method: "POST",
    body: JSON.stringify({ command_id: input.commandId, name: input.name,
      role_description: input.roleDescription,
      ...(input.tone === undefined ? {} : { tone: input.tone }),
      ...(input.readScope === undefined ? {} : { read_scope: input.readScope }) }) }, 201);
  try {
    const envelope = commandEnvelopeFrom(body);
    if (envelope.commandId !== input.commandId) throw new Error("command mismatch");
    return profileFromResult(envelope.result);
  } catch { throw new RelayTransportError("助手配置回执无法核对，请查询原 command_id。"); }
}

/** 归档推进「是否仍适用」，不改写配置文本；带 expectedRevision 是 CAS，落后按冲突返回。 */
export async function archiveAssistantProfile(http: RelayHttp, profileId: string, commandId: string, expectedRevision: DecimalRevision): Promise<RelayAssistantProfile> {
  const body = await http.request(http.workspacePath(`/assistant-profiles/${encodeURIComponent(profileId)}/archive`), {
    method: "POST", body: JSON.stringify({ command_id: commandId, expected_revision: expectedRevision }) }, 200);
  try {
    const envelope = commandEnvelopeFrom(body);
    if (envelope.commandId !== commandId) throw new Error("command mismatch");
    return profileFromResult(envelope.result);
  } catch { throw new RelayTransportError("助手归档回执无法核对，请查询原 command_id。"); }
}
