import type { DecimalRevision } from "../../types";
import { RelayTransportError } from "../core/errors";
import { RelayHttp } from "../core/http";
import { array, boolean, decimal, integer, nullableString, object, string } from "../core/primitives";
import { assistMessageFrom, assistantProfileFrom, assistProposalFrom, assistSessionBindingFrom, assistSessionDeleteFrom, assistSessionDirectoryBindingFrom, assistSessionForkFrom, assistSessionFrom, assistSessionPinFrom, assistSessionStateFrom, assistSessionTitleFrom, assistSessionUnreadFrom, assistSourceBody, conversationExecutionFrom, conversationExecutionSummaryFrom, packDefinitionFrom, skillDefinitionFrom, workingDirectoryFrom } from "../parse/assist";
import { commandEnvelopeFrom } from "../parse/projects";
import type { RelayAssistLivePreview, RelayAssistMessage, RelayAssistMessageAttachmentContent, RelayAssistMessageAttachmentUpload, RelayAssistProposal, RelayAssistSession, RelayAssistSessionBinding, RelayAssistSessionDelete, RelayAssistSessionDirectoryBinding, RelayAssistSessionFork, RelayAssistSessionPin, RelayAssistSessionState, RelayAssistSessionTitle, RelayAssistSessionUnread, RelayAssistantProfile, RelayConversationMode, RelayAssistSourceRef, RelayConversationExecution, RelayConversationExecutionStage, RelayPackDefinition, RelaySkillDefinition, RelaySkillInput, RelayWorkingDirectory } from "../dtos/assist";
import type { RelayCommandEnvelope } from "../dtos/projects";

export async function getAssistSessions(http: RelayHttp, target: { projectId?: string; taskId?: string; includeContext?: boolean; status?: "ACTIVE" | "ARCHIVED" | "ALL" } = {}): Promise<readonly RelayAssistSession[]> {
  const query = new URLSearchParams();
  if (target.projectId) query.set("project_id", target.projectId);
  if (target.taskId) query.set("task_id", target.taskId);
  if (target.includeContext) query.set("include_context", "true");
  // 服务端缺省只列 ACTIVE，这里就只在不默认时才带参数：左栏「已归档」那一段是显式读法。
  if (target.status && target.status !== "ACTIVE") query.set("status", target.status);
  const body = object(await http.request(`${http.workspacePath("/assist-sessions")}?${query}`), "assist sessions");
  return array(body, "items", "assist sessions").map(assistSessionFrom);
}

export async function getAssistSession(http: RelayHttp, sessionId: string, includeContext = false): Promise<RelayAssistSession> {
  return assistSessionFrom(await http.request(http.workspacePath(
    `/assist-sessions/${encodeURIComponent(sessionId)}${includeContext ? "?include_context=true" : ""}`)));
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

/**
 * 会话行内控制五条命令（0090 / 0104 / 命令契约 §10.86）。
 *
 * 都带 `expected_revision`：CAS 落后由服务端翻成 409，界面重读后让人重新决定，
 * 这里绝不换新 command_id 重发。回执对不上同样只报「无法核对」，不假装改动已生效。
 */
async function postSessionControl<T>(http: RelayHttp, input: { sessionId: string; commandId: string;
  expectedRevision: DecimalRevision; path: string; extra?: Record<string, unknown>;
  /** 会话控制统一 200；分叉新建子会话，按契约第 3 节是 201。 */ status?: number },
  parse: (value: unknown) => T, mismatch: (value: T) => boolean, label: string): Promise<T> {
  const body = await http.request(http.workspacePath(
    `/assist-sessions/${encodeURIComponent(input.sessionId)}/${input.path}`), { method: "POST",
    body: JSON.stringify({ command_id: input.commandId,
      expected_revision: input.expectedRevision, ...(input.extra ?? {}) }) }, input.status ?? 200);
  try {
    const envelope = commandEnvelopeFrom(body);
    if (envelope.commandId !== input.commandId) throw new Error("command mismatch");
    const result = parse(envelope.result);
    if (mismatch(result)) throw new Error("command mismatch");
    return result;
  } catch { throw new RelayTransportError(`Assist 会话${label}回执无法核对，请查询原 command_id。`); }
}

export function renameAssistSession(http: RelayHttp, input: { sessionId: string; commandId: string;
  expectedRevision: DecimalRevision; title: string }): Promise<RelayAssistSessionTitle> {
  return postSessionControl(http, { ...input, path: "title", extra: { title: input.title } },
    assistSessionTitleFrom, (r) => r.sessionId !== input.sessionId || r.title !== input.title.trim(), "改名");
}

export function setAssistSessionPin(http: RelayHttp, input: { sessionId: string; commandId: string;
  expectedRevision: DecimalRevision; pinned: boolean }): Promise<RelayAssistSessionPin> {
  return postSessionControl(http, { ...input, path: "pin", extra: { pinned: input.pinned } },
    assistSessionPinFrom, (r) => r.sessionId !== input.sessionId || r.pinned !== input.pinned, "置顶");
}

export function setAssistSessionUnread(http: RelayHttp, input: { sessionId: string; commandId: string;
  expectedRevision: DecimalRevision; unread: boolean }): Promise<RelayAssistSessionUnread> {
  return postSessionControl(http, { ...input, path: "unread", extra: { unread: input.unread } },
    assistSessionUnreadFrom, (r) => r.sessionId !== input.sessionId || r.unread !== input.unread, "未读");
}

export function archiveAssistSession(http: RelayHttp, input: { sessionId: string; commandId: string;
  expectedRevision: DecimalRevision }): Promise<RelayAssistSessionState> {
  return postSessionControl(http, { ...input, path: "archive" }, assistSessionStateFrom,
    (r) => r.sessionId !== input.sessionId || r.status !== "ARCHIVED", "归档");
}

export function reopenAssistSession(http: RelayHttp, input: { sessionId: string; commandId: string;
  expectedRevision: DecimalRevision }): Promise<RelayAssistSessionState> {
  return postSessionControl(http, { ...input, path: "reopen" }, assistSessionStateFrom,
    (r) => r.sessionId !== input.sessionId || r.status !== "ACTIVE", "重开");
}

/**
 * 物理删除（ADR-027）。与归档不同，它不可撤销：回执只核对身份，界面不得据此提供恢复入口。
 * 被其它对象引用的会话按 409 `SESSION_DELETE_BLOCKED` 拒绝，阻止项在 problem 的
 * `blocking_reasons` 里；那是可读的业务拒绝，不是回执不明。
 */
export function deleteAssistSession(http: RelayHttp, input: { sessionId: string; commandId: string;
  expectedRevision: DecimalRevision }): Promise<RelayAssistSessionDelete> {
  return postSessionControl(http, { ...input, path: "delete" }, assistSessionDeleteFrom,
    (r) => r.sessionId !== input.sessionId, "删除");
}

/**
 * 分叉（0113）：回执里的会话身份是**新建的子会话**，提交前无从预知，因此不做「等于目标会话」
 * 这一类核对，只核对 command_id 与回执形状（与新建会话同一读法）。
 */
export function forkAssistSession(http: RelayHttp, input: { sessionId: string; commandId: string;
  expectedRevision: DecimalRevision }): Promise<RelayAssistSessionFork> {
  return postSessionControl(http, { ...input, path: "fork", status: 201 }, assistSessionForkFrom,
    () => false, "分叉");
}

export async function getAssistMessages(http: RelayHttp, sessionId: string): Promise<readonly RelayAssistMessage[]> {
  const body = object(await http.request(http.workspacePath(`/assist-sessions/${encodeURIComponent(sessionId)}/messages?limit=200`)), "assist messages");
  return array(body, "items", "assist messages").map(assistMessageFrom);
}

/**
 * 0093：上传一张图片附件（先暂存、随消息命令绑定，不是幂等命令）。
 * 客户端不做业务裁决：类型白名单、单张上限与会话准入都由服务端唯一准绳决定，
 * 前端只按同一组常量做发送前预检，拿到 422 时如实展示服务端说明。
 */
export async function uploadAssistMessageAttachment(http: RelayHttp, input: {
  sessionId: string; name: string; mediaType: string; dataBase64: string }): Promise<RelayAssistMessageAttachmentUpload> {
  const body = object(await http.request(http.workspacePath(
    `/assist-sessions/${encodeURIComponent(input.sessionId)}/message-attachments`), { method: "POST",
    body: JSON.stringify({ name: input.name, media_type: input.mediaType,
      data_base64: input.dataBase64 }) }, 201), "assist attachment upload");
  return { attachmentId: string(body, "attachment_id", "assist attachment upload"),
    byteLength: integer(body, "byte_length", "assist attachment upload"),
    contentHash: string(body, "content_hash", "assist attachment upload") };
}

/** 0093：读一张附件的内容（历史消息缩略图）。内容按单张读取，不进消息列表投影。 */
export async function getAssistMessageAttachment(http: RelayHttp, input: {
  sessionId: string; attachmentId: string }): Promise<RelayAssistMessageAttachmentContent> {
  const body = object(await http.request(http.workspacePath(
    `/assist-sessions/${encodeURIComponent(input.sessionId)}/message-attachments/${encodeURIComponent(input.attachmentId)}`)),
    "assist attachment");
  return { attachmentId: string(body, "attachment_id", "assist attachment"),
    name: string(body, "name", "assist attachment"),
    mediaType: string(body, "media_type", "assist attachment"),
    byteLength: integer(body, "byte_length", "assist attachment"),
    dataBase64: string(body, "data_base64", "assist attachment") };
}

export function assistLivePreviewFrom(raw: unknown, expectedSessionId: string, expectedMessageId: string): RelayAssistLivePreview {
  const row = object(raw, "assist live preview");
  const status = string(row, "status", "assist live preview");
  if (!["PENDING", "RUNNING", "COMPLETED", "FAILED", "CANCELLED"].includes(status) ||
    string(row, "session_id", "assist live preview") !== expectedSessionId ||
    string(row, "message_id", "assist live preview") !== expectedMessageId) {
    throw new RelayTransportError("Assist 草稿预览与当前消息不匹配。");
  }
  return { sessionId: expectedSessionId, messageId: expectedMessageId,
    status: status as RelayAssistMessage["status"],
    previewRevision: decimal(row, "preview_revision", "assist live preview"),
    previewText: nullableString(row, "preview_text", "assist live preview"),
    previewTruncated: boolean(row, "preview_truncated", "assist live preview"),
    previewAvailable: boolean(row, "preview_available", "assist live preview") };
}

export async function getAssistLivePreview(http: RelayHttp, sessionId: string, messageId: string): Promise<RelayAssistLivePreview> {
  return assistLivePreviewFrom(await http.request(http.workspacePath(
    `/assist-sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}/live-preview`)),
    sessionId, messageId);
}

/**
 * 发一条消息。三个分支是**排他的**，不是可选字段的组合：
 * 普通档带 intent 或 skill_ref；助手档两个都不带——服务端会以 409 拒绝助手档的
 * intent 与 Skill（ADR-018、命令契约 §10.60.4），客户端就不该把这条路留出来。
 *
 * `attachmentIds` 只在有图片附件时出现：它进命令载荷 hash，重放按原 ids 核对，
 * 所以重试必须沿同一组 ids（不重新上传、不换 id）。没有附件时载荷逐字不变。
 */
export async function requestAssistMessage(http: RelayHttp, input: { sessionId: string; commandId: string; content: string; sourceRefs: readonly RelayAssistSourceRef[]; recordLearning?: boolean; expectedModelSelectionRevision?: string; attachmentIds?: readonly string[] } & ( { intent: "DISCUSS" | "PROPOSE_CANDIDATE" | "PROPOSE_TASK"; skillRef?: never; skillInput?: never } | { intent?: never; skillRef: { id: string; version: string }; skillInput: RelaySkillInput } | { intent?: never; skillRef?: never; skillInput?: never } )): Promise<{ userMessageId: string; assistantMessageId: string }> {
  const body = await http.request(http.workspacePath(`/assist-sessions/${encodeURIComponent(input.sessionId)}/messages`), {
    method: "POST", body: JSON.stringify({ command_id: input.commandId, content: input.content,
      source_refs: input.sourceRefs.map(assistSourceBody),
      ...(input.recordLearning === undefined ? {} : { record_learning: input.recordLearning }),
      ...(input.expectedModelSelectionRevision === undefined ? {} : { expected_model_selection_revision: input.expectedModelSelectionRevision }),
      ...(input.attachmentIds === undefined || input.attachmentIds.length === 0 ? {}
        : { attachment_ids: [...input.attachmentIds] }),
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
