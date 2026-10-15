import { RelayTransportError } from "../core/errors";
import { RelayHttp } from "../core/http";
import { array, object } from "../core/primitives";
import { commandEnvelopeFrom } from "../parse/projects";
import { stateMaintenanceApplyResultFrom, stateMaintenanceRequestFrom,
  undoPlanFrom } from "../parse/stateMaintenance";
import type { RelayStateMaintenanceApplyResult,
  RelayStateMaintenanceRequest, RelayUndoPlan } from "../dtos/stateMaintenance";

/**
 * 对话状态维护解释：明确维护指令的 user 消息 → 状态维护请求投影。
 * 模型解释在服务端完成；命令身份在发送时固定，响应丢失后按原 command_id 核对或重放。
 */
export async function createStateMaintenanceRequest(http: RelayHttp,
  input: { sessionId: string; sourceMessageId: string; commandId: string;
    timezone?: string }): Promise<RelayStateMaintenanceRequest> {
  const envelope = commandEnvelopeFrom(await http.request(
    http.workspacePath(`/assist-sessions/${encodeURIComponent(input.sessionId)}/state-maintenance-requests`),
    { method: "POST", body: JSON.stringify({ command_id: input.commandId,
      source_message_id: input.sourceMessageId,
      ...(input.timezone === undefined ? {} : { timezone: input.timezone }) }) }, 202));
  if (envelope.commandId !== input.commandId) {
    throw new RelayTransportError("状态维护请求的命令回执无法对应，请查询原 command_id。");
  }
  return stateMaintenanceRequestFrom(envelope.result);
}

/** 明确会话记录沿原请求；需要澄清、决定或其他种类变更时只返回候选。 */
async function applyConversationRecord(http: RelayHttp,
  input: { sessionId: string; sourceMessageId: string; commandId: string; timezone?: string }, kind: 'REPORT_ACCEPTANCE_TIME' | 'CREATE_HYPOTHESIS' | 'START_WORK_SEGMENT') {
  const request = await createStateMaintenanceRequest(http, input);
  if (request.decision !== 'MAINTAIN' || request.status !== 'READY' || request.decisionRequired !== null ||
      request.changes === null || request.changes.length === 0 ||
      request.changes.some((change) => change.changeKind !== kind)) {
    return { request, application: null };
  }
  const application = await applyConversationStateRequest(http, request.requestId);
  const current = stateMaintenanceRequestFrom(await http.request(http.workspacePath(
    `/conversation-state-requests/${encodeURIComponent(request.requestId)}`)));
  if (current.requestId !== request.requestId || current.sourceMessageId !== request.sourceMessageId) {
    throw new RelayTransportError('记录读回与原用户消息不匹配。');
  }
  return { request: current, application };
}
export function reportAcceptanceTimeFromConversation(http: RelayHttp,
  input: { sessionId: string; sourceMessageId: string; commandId: string; timezone?: string }) {
  return applyConversationRecord(http, input, 'REPORT_ACCEPTANCE_TIME');
}
export function createHypothesisFromConversation(http: RelayHttp,
  input: { sessionId: string; sourceMessageId: string; commandId: string; timezone?: string }) {
  return applyConversationRecord(http, input, 'CREATE_HYPOTHESIS');
}
export function startWorkSegmentFromConversation(http: RelayHttp,
  input: { sessionId: string; sourceMessageId: string; commandId: string; timezone?: string }) {
  return applyConversationRecord(http, input, 'START_WORK_SEGMENT');
}

/**
 * 明确指令的自动生效入口：请求行上没有命令身份，结果按 request_id 核对；
 * 服务端按请求行幂等，重放不会产生第二组变更。
 */
export async function applyConversationStateRequest(http: RelayHttp,
  requestId: string): Promise<RelayStateMaintenanceApplyResult> {
  const envelope = commandEnvelopeFrom(await http.request(
    http.workspacePath(`/conversation-state-requests/${encodeURIComponent(requestId)}/applications`),
    { method: "POST", body: JSON.stringify({}) }, 200));
  const result = stateMaintenanceApplyResultFrom(envelope.result);
  if (result.requestId !== requestId) {
    throw new RelayTransportError("状态维护生效结果与原请求不匹配，请按原回执核对。");
  }
  return result;
}

/** 已生效整组的撤回：命令身份在发送时固定，回执必须逐字对应，不换 ID 绕过。 */
export async function withdrawConversationStateRequest(http: RelayHttp,
  input: { requestId: string; commandId: string; planDigest?: string;
    confirmedChangeIds?: readonly string[] }): Promise<RelayStateMaintenanceApplyResult> {
  const envelope = commandEnvelopeFrom(await http.request(
    http.workspacePath(`/conversation-state-requests/${encodeURIComponent(input.requestId)}/withdrawals`),
    { method: "POST", body: JSON.stringify({ command_id: input.commandId,
      ...(input.planDigest === undefined ? {}
        : { plan_digest: input.planDigest,
          confirmed_change_ids: [...(input.confirmedChangeIds ?? [])] }) }) }, 200));
  if (envelope.commandId !== input.commandId) {
    throw new RelayTransportError("撤回命令的回执无法对应，请查询原 command_id。");
  }
  const result = stateMaintenanceApplyResultFrom(envelope.result);
  if (result.requestId !== input.requestId) {
    throw new RelayTransportError("撤回结果与原请求不匹配，请按原回执核对。");
  }
  return result;
}

/**
 * 对既有 DECISION_REQUIRED 的一句话续答：绑定原请求与用户看到答案时的版本
 * （expected_revision），决定本身不写业务事实；之后由原 applications 入口继续生效。
 */
export async function answerConversationStateDecision(http: RelayHttp,
  input: { requestId: string; commandId: string; resolution: "ACCEPT" | "DECLINE";
    answer: string; expectedRevision: string }): Promise<RelayStateMaintenanceApplyResult> {
  const envelope = commandEnvelopeFrom(await http.request(
    http.workspacePath(`/conversation-state-requests/${encodeURIComponent(input.requestId)}/decision-replies`),
    { method: "POST", body: JSON.stringify({ command_id: input.commandId,
      resolution: input.resolution, answer: input.answer,
      expected_revision: input.expectedRevision }) }, 200));
  if (envelope.commandId !== input.commandId) {
    throw new RelayTransportError("决定回执无法对应，请查询原 command_id。");
  }
  const result = stateMaintenanceApplyResultFrom(envelope.result);
  if (result.requestId !== input.requestId) {
    throw new RelayTransportError("决定回执与原请求不匹配，请按原回执核对。");
  }
  return result;
}

/** 撤回事前预检方案（只读）：整组里有不可撤回项时服务端一项都不执行，
 * 这里先把具体范围、原因与影响取回来交给用户决定。
 */
export async function getConversationStateUndoPlan(http: RelayHttp,
  requestId: string): Promise<RelayUndoPlan> {
  return undoPlanFrom(await http.request(http.workspacePath(
    `/conversation-state-requests/${encodeURIComponent(requestId)}/undo-plan`)));
}

/** 会话已有的状态维护请求：按 source_message_id 归位到各条 user 消息下方展示。 */
export async function getConversationStateRequests(http: RelayHttp,
  sessionId: string): Promise<readonly RelayStateMaintenanceRequest[]> {
  const query = new URLSearchParams({ session_id: sessionId });
  const body = object(await http.request(
    `${http.workspacePath("/conversation-state-requests")}?${query}`),
  "conversation state requests");
  return array(body, "items", "conversation state requests").map(stateMaintenanceRequestFrom);
}
