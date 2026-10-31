import type { RelayHttp } from "../core/http";
import { array, nullableString, object, string } from "../core/primitives";
import { RelayContractError } from "../core/errors";
import { commandEnvelopeFrom } from "../parse/projects";

export interface RelaySubagentSupplement {
  readonly id: string;
  readonly delegationId: string;
  readonly sourceMessageId: string;
  readonly sourceSessionId: string;
  readonly parentSessionId: string;
  readonly content: string;
  readonly delegationStatus: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED";
  readonly parentSeenAt: string | null;
  readonly childSeenAt: string | null;
  readonly createdAt: string;
}

export interface RelaySubagentSupplementResult {
  readonly supplementId: string;
  readonly sourceMessageId: string;
  readonly childSessionId: string;
  readonly parentSessionId: string;
  readonly delegationId: string;
}

export function subagentSupplementResultFrom(value: unknown, childSessionId: string): RelaySubagentSupplementResult {
  const row = object(value, "subagent supplement result");
  const child = string(row, "child_session_id", "subagent supplement result");
  if (child !== childSessionId) throw new RelayContractError("子任务补充回执的会话身份无法核对。");
  return { supplementId: string(row, "supplement_id", "subagent supplement result"),
    sourceMessageId: string(row, "source_message_id", "subagent supplement result"),
    childSessionId: child, parentSessionId: string(row, "parent_session_id", "subagent supplement result"),
    delegationId: string(row, "delegation_id", "subagent supplement result") };
}

export async function getSubagentSupplements(http: RelayHttp, sessionId: string): Promise<readonly RelaySubagentSupplement[]> {
  const body = object(await http.request(http.workspacePath(
    `/assist-sessions/${encodeURIComponent(sessionId)}/supplements`)), "subagent supplements");
  return array(body, "items", "subagent supplements").map((value) => {
    const row = object(value, "subagent supplement");
    const status = string(row, "delegation_status", "subagent supplement");
    if (!["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED"].includes(status)) {
      throw new RelayContractError("子任务补充状态无法核对。");
    }
    const source = string(row, "source_session_id", "subagent supplement");
    const parent = string(row, "parent_session_id", "subagent supplement");
    if (sessionId !== source && sessionId !== parent) {
      throw new RelayContractError("子任务补充不属于当前会话。");
    }
    return { id: string(row, "id", "subagent supplement"),
      delegationId: string(row, "delegation_id", "subagent supplement"),
      sourceMessageId: string(row, "source_message_id", "subagent supplement"),
      sourceSessionId: source, parentSessionId: parent,
      content: string(row, "content", "subagent supplement"),
      delegationStatus: status as RelaySubagentSupplement["delegationStatus"],
      parentSeenAt: nullableString(row, "parent_seen_at", "subagent supplement"),
      childSeenAt: nullableString(row, "child_seen_at", "subagent supplement"),
      createdAt: string(row, "created_at", "subagent supplement") };
  });
}

export async function supplementSubagent(http: RelayHttp, input: {
  childSessionId: string; commandId: string; content: string;
}): Promise<RelaySubagentSupplementResult> {
  const body = await http.request(http.workspacePath(
    `/assist-sessions/${encodeURIComponent(input.childSessionId)}/supplements`), {
    method: "POST", body: JSON.stringify({ command_id: input.commandId, content: input.content }) }, 200);
  const receipt = commandEnvelopeFrom(body);
  if (receipt.commandId !== input.commandId) throw new RelayContractError("子任务补充命令身份无法核对。");
  return subagentSupplementResultFrom(receipt.result, input.childSessionId);
}
