import type { DecimalRevision } from "../../types";
import { RelayContractError, RelayTransportError } from "../core/errors";
import type { RelayHttp } from "../core/http";
import { object } from "../core/primitives";
import { commandEnvelopeFrom } from "../parse/projects";
import { memoryCreatedFromMessageFrom, memoryProvenanceFrom, memorySettingsFrom,
  messageMemoryUseFrom, revisionAtLeast, sessionMemoryFrom, sessionMemoryResetFrom } from "../parse/memory";
import type { RelayCompactAccepted, RelayMemoryCreatedFromMessage, RelayMemoryProvenance,
  RelayMemorySettings, RelayMessageMemoryUse, RelaySessionMemory, RelaySessionMemoryResetResult }
  from "../dtos/memory";

/**
 * 长短期记忆的写入面（HTTP §10.99）。
 *
 * 这一层只做三件事：把请求按契约形状发出去、核对回执身份、把结果解析成可显示的投影。
 * 它不做业务裁决——「这个会话还能不能整理」「这次清除会不会撞在途消息」都由服务端回答，
 * 客户端不预先编一套本地规则去抢答。
 */

/** 缺配置时服务端返回修订 0 与两个开关 true；这里不补默认值，缺字段按契约错误失败。 */
export async function getMemorySettings(http: RelayHttp): Promise<RelayMemorySettings> {
  const settings = memorySettingsFrom(await http.request(http.workspacePath("/memory-settings")));
  if (settings.workspaceId !== http.workspaceId) {
    throw new RelayContractError("记忆设置响应的 Workspace 与当前连接不一致。");
  }
  return settings;
}

/**
 * 保存 Workspace 记忆设置。
 *
 * 两个开关**必须一起提交**：服务端按整行 CAS 写入，只带想改的那一个会把另一个写成默认值。
 * 调用方因此必须传读回的另一开关值，而不是「我觉得应该是 true」。
 */
export async function saveMemorySettings(http: RelayHttp, input: {
  commandId: string; expectedRevision: DecimalRevision;
  recallEnabled: boolean; automaticCompaction: boolean; autoCapture: boolean;
}): Promise<RelayMemorySettings> {
  const body = await http.request(http.workspacePath("/memory-settings"), { method: "POST",
    body: JSON.stringify({ command_id: input.commandId, expected_revision: input.expectedRevision,
      recall_enabled: input.recallEnabled, automatic_compaction: input.automaticCompaction,
      auto_capture: input.autoCapture }) }, 200);
  try {
    const envelope = commandEnvelopeFrom(body);
    if (envelope.commandId !== input.commandId) throw new Error("command mismatch");
    const saved = memorySettingsFrom(envelope.result);
    if (saved.workspaceId !== http.workspaceId) throw new Error("workspace mismatch");
    // 回执不能倒退：修订至少要在提交前那条之上，否则说明拿回的是更早的一次写入。
    if (!revisionAtLeast(saved.revision, input.expectedRevision)) throw new Error("revision regression");
    return saved;
  } catch { throw new RelayTransportError("记忆设置回执无法核对，请查询原 command_id。"); }
}

/**
 * 从一条已完成消息明确保存长期记忆。
 *
 * `contentSha256` 必须是**原消息正文**的 UTF-8 SHA256，不是用户编辑后的记忆草稿——
 * 服务端用它证明「我保存的是你确认的那条来源」。正文可编辑，但来源身份不可改。
 */
export async function createMemoryFromMessage(http: RelayHttp, input: {
  sessionId: string; messageId: string; commandId: string;
  expectedSessionRevision: DecimalRevision; contentSha256: string;
  projectId: string | null; title: string; text: string; expiresAt?: string | null;
}): Promise<RelayMemoryCreatedFromMessage> {
  const body = await http.request(http.workspacePath(
    `/assist-sessions/${encodeURIComponent(input.sessionId)}/messages/${encodeURIComponent(input.messageId)}/memories`),
  { method: "POST", body: JSON.stringify({ command_id: input.commandId,
    expected_session_revision: input.expectedSessionRevision, content_sha256: input.contentSha256,
    project_id: input.projectId, title: input.title, text: input.text, confirmed: true,
    ...(input.expiresAt === undefined ? {} : { expires_at: input.expiresAt }) }) }, 201);
  try {
    const envelope = commandEnvelopeFrom(body);
    if (envelope.commandId !== input.commandId) throw new Error("command mismatch");
    return memoryCreatedFromMessageFrom(envelope.result);
  } catch { throw new RelayTransportError("保存记忆的回执无法核对，请查询原 command_id。"); }
}

/** 手工创建的记忆没有来源，返回空数组是合法事实，不是「读取失败」。 */
export async function getMemoryProvenance(http: RelayHttp, memoryId: string): Promise<RelayMemoryProvenance> {
  return memoryProvenanceFrom(await http.request(http.workspacePath(
    `/memories/${encodeURIComponent(memoryId)}/provenance`)), memoryId);
}

export async function getSessionMemory(http: RelayHttp, sessionId: string): Promise<RelaySessionMemory> {
  return sessionMemoryFrom(await http.request(http.workspacePath(
    `/assist-sessions/${encodeURIComponent(sessionId)}/memory`)), sessionId);
}

/** 202 只表示受理：`requestId` 随后要拿去 GET 会话窗口读状态，不能就地标成「已整理」。 */
export async function requestSessionMemoryCompaction(http: RelayHttp, input: {
  sessionId: string; commandId: string; expectedRevision: DecimalRevision;
}): Promise<RelayCompactAccepted> {
  const body = await http.request(http.workspacePath(
    `/assist-sessions/${encodeURIComponent(input.sessionId)}/memory/compact`), { method: "POST",
    body: JSON.stringify({ command_id: input.commandId, expected_revision: input.expectedRevision }) }, 202);
  try {
    const envelope = commandEnvelopeFrom(body);
    if (envelope.commandId !== input.commandId) throw new Error("command mismatch");
    const result = object(envelope.result, "compact result");
    if (result.session_id !== input.sessionId) throw new Error("session mismatch");
    if (result.status !== "PENDING") throw new Error("status mismatch");
    if (typeof result.request_id !== "string") throw new Error("request id missing");
    return { sessionId: input.sessionId, requestId: result.request_id, status: "PENDING" };
  } catch { throw new RelayTransportError("记忆整理回执无法核对，请查询原 command_id。"); }
}

/**
 * 取消整理。
 *
 * `RUNNING` 时服务端只持久化取消意图，因此 `status` 仍是 `RUNNING` 而 `cancelRequested` 为 true；
 * 两者分开返回，界面才不会把「请求停止」说成「已取消」。
 */
export async function cancelMemoryCompaction(http: RelayHttp, input: {
  sessionId: string; requestId: string; commandId: string;
}): Promise<{ sessionId: string; requestId: string; status: string; cancelRequested: boolean }> {
  const body = await http.request(http.workspacePath(
    `/assist-sessions/${encodeURIComponent(input.sessionId)}/memory/requests/${encodeURIComponent(input.requestId)}/cancel`),
  { method: "POST", body: JSON.stringify({ command_id: input.commandId }) }, 200);
  try {
    const envelope = commandEnvelopeFrom(body);
    if (envelope.commandId !== input.commandId) throw new Error("command mismatch");
    const result = object(envelope.result, "cancel memory result");
    if (result.session_id !== input.sessionId || result.request_id !== input.requestId) throw new Error("target mismatch");
    if (typeof result.status !== "string" || typeof result.cancel_requested !== "boolean") {
      throw new Error("shape mismatch");
    }
    return { sessionId: input.sessionId, requestId: input.requestId,
      status: result.status, cancelRequested: result.cancel_requested };
  } catch { throw new RelayTransportError("取消整理的回执无法核对，请查询原 command_id。"); }
}

/**
 * 清除工作窗口 / 切换一次性模式。
 *
 * `expected_revision` 是**工作窗口**修订，`expected_session_revision` 是会话修订：
 * 两者都必须是本次读回的值，混用会被服务端当冲突拒绝。开关实际变化时会话修订也会前进，
 * 所以成功后必须重读，不能把两种修订在本地互相赋值。
 */
async function postSessionMemoryControl(http: RelayHttp, input: {
  sessionId: string; commandId: string; expectedRevision: DecimalRevision;
  expectedSessionRevision: DecimalRevision; remember?: boolean;
}): Promise<RelaySessionMemoryResetResult> {
  const remember = input.remember;
  const path = remember === undefined ? "clear" : "remember";
  const body = await http.request(http.workspacePath(
    `/assist-sessions/${encodeURIComponent(input.sessionId)}/memory/${path}`), { method: "POST",
    body: JSON.stringify({ command_id: input.commandId, expected_revision: input.expectedRevision,
      expected_session_revision: input.expectedSessionRevision,
      ...(remember === undefined ? {} : { remember }) }) }, 200);
  try {
    const envelope = commandEnvelopeFrom(body);
    if (envelope.commandId !== input.commandId) throw new Error("command mismatch");
    const result = sessionMemoryResetFrom(envelope.result, input.sessionId);
    if (remember !== undefined && result.remember !== remember) throw new Error("remember mismatch");
    if (!revisionAtLeast(result.revision, input.expectedRevision)) throw new Error("revision regression");
    return result;
  } catch { throw new RelayTransportError("工作窗口回执无法核对，请查询原 command_id。"); }
}

export function clearSessionMemory(http: RelayHttp, input: {
  sessionId: string; commandId: string; expectedRevision: DecimalRevision;
  expectedSessionRevision: DecimalRevision;
}): Promise<RelaySessionMemoryResetResult> {
  return postSessionMemoryControl(http, input);
}

export function setSessionMemoryRemember(http: RelayHttp, input: {
  sessionId: string; commandId: string; expectedRevision: DecimalRevision;
  expectedSessionRevision: DecimalRevision; remember: boolean;
}): Promise<RelaySessionMemoryResetResult> {
  return postSessionMemoryControl(http, input);
}

/**
 * 一条消息的记忆使用足迹。
 *
 * `recorded=false` 是「没有采集记录」，不能显示成「未使用记忆」；`available=false`
 * 是「采集过但来源已失效」，内容不回显。两种情况都不允许前端凭消息正文猜。
 */
export async function getMessageMemoryUse(http: RelayHttp, sessionId: string,
  messageId: string): Promise<RelayMessageMemoryUse> {
  return messageMemoryUseFrom(await http.request(http.workspacePath(
    `/assist-sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}/memory`)),
  { sessionId, messageId });
}
