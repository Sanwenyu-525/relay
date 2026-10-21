import { RelayTransportError } from "../core/errors";
import type { RelayHttp } from "../core/http";
import { array, decimal, nullableString, object, string, stringList } from "../core/primitives";
import type { RelayConversationMode } from "../dtos/assist";
import type { RelayCompactAccepted } from "../dtos/memory";
import { compactAcceptedFrom } from "../parse/memory";
import { commandEnvelopeFrom } from "../parse/projects";

export type RelayChatCommand = {
  readonly kind: "METHOD" | "SYSTEM";
  readonly name: string;
  readonly aliases: readonly string[];
  readonly title: string;
  readonly summary: string;
  readonly usage: string;
  readonly methodId: string | null;
  readonly systemId: string | null;
};

export async function getChatCommands(http: RelayHttp): Promise<readonly RelayChatCommand[]> {
  const body = object(await http.request(http.workspacePath("/chat-commands")), "chat commands");
  return array(body, "items", "chat commands").map((value) => {
    const row = object(value, "chat command");
    const kind = string(row, "kind", "chat command");
    if (kind !== "METHOD" && kind !== "SYSTEM") throw new Error("聊天命令登记类型无效。");
    return { kind, name: string(row, "name", "chat command"),
      aliases: stringList(row, "aliases", "chat command"),
      title: string(row, "title", "chat command"), summary: string(row, "summary", "chat command"),
      usage: string(row, "usage", "chat command"),
      methodId: kind === "METHOD" ? string(row, "method_id", "chat command") : null,
      systemId: kind === "SYSTEM" ? string(row, "system_id", "chat command") : null };
  });
}

export type RelayChatSessionResult = {
  readonly sessionId: string;
  readonly projectId: string | null;
  readonly taskId: string | null;
  readonly conversationMode: RelayConversationMode;
  readonly assistantProfileId: string | null;
  readonly assistantProfileRevision: string | null;
};

export function chatSessionResultFrom(value: unknown, sessionId: string, system: "clear" | "new"): RelayChatSessionResult {
  try {
    const row = object(value, "chat command");
    const mode = string(row, "conversation_mode", "chat command");
    const createdId = string(row, "session_id", "chat command");
    if (row.kind !== "NEW_SESSION" || row.system !== system || row.source_session_id !== sessionId ||
      !createdId || createdId === sessionId || !["AGENT", "ASSISTANT", "LEARNING"].includes(mode)) throw new Error("command mismatch");
    decimal(row, "revision", "chat command");
    return { sessionId: createdId, projectId: nullableString(row, "project_id", "chat command"),
      taskId: nullableString(row, "task_id", "chat command"), conversationMode: mode as RelayConversationMode,
      assistantProfileId: nullableString(row, "assistant_profile_id", "chat command"),
      assistantProfileRevision: row.assistant_profile_revision === null ? null
        : decimal(row, "assistant_profile_revision", "chat command") };
  } catch { throw new RelayTransportError("新会话命令回执无法核对，请查询原 command_id。"); }
}

export async function restartAssistSession(http: RelayHttp, input: {
  sessionId: string; commandId: string; text: string; system: "clear" | "new";
}): Promise<RelayChatSessionResult> {
  const body = await http.request(http.workspacePath(`/assist-sessions/${encodeURIComponent(input.sessionId)}/chat-commands`),
    { method: "POST", body: JSON.stringify({ command_id: input.commandId, text: input.text }) }, 200);
  try {
    const envelope = commandEnvelopeFrom(body);
    if (envelope.commandId !== input.commandId) throw new Error("command mismatch");
    return chatSessionResultFrom(envelope.result, input.sessionId, input.system);
  } catch { throw new RelayTransportError("新会话命令回执无法核对，请查询原 command_id。"); }
}

/**
 * `/compact` 与 `/压缩` 走同一条 chat-commands 通道（HTTP §10.99）。
 *
 * 与 `/clear`、`/new` 的关键差别：它们建新会话，这一条只申请整理当前工作窗口。
 * 202 只表示受理，回执里没有会话修订可用——完成与否由会话记忆 GET 回答。
 *
 * 回执核对只认三件事：命令身份、会话身份、`PENDING`。这里**不**要求服务端在
 * `result` 上额外套一层前端包装（`kind`/`system` 是本次聊天命令的语义标签，
 * 但底层 Owner 是同一个 `RequestMemoryCompaction`，重放回执可能只有它的原始结果）。
 */
export async function compactAssistSession(http: RelayHttp, input: {
  sessionId: string; commandId: string; text: string;
}): Promise<RelayCompactAccepted> {
  const body = await http.request(http.workspacePath(`/assist-sessions/${encodeURIComponent(input.sessionId)}/chat-commands`),
    { method: "POST", body: JSON.stringify({ command_id: input.commandId, text: input.text }) }, 202);
  try {
    const envelope = commandEnvelopeFrom(body);
    if (envelope.commandId !== input.commandId) throw new Error("command mismatch");
    return compactAcceptedFrom(envelope.result, input.sessionId);
  } catch { throw new RelayTransportError("整理命令回执无法核对，请查询原 command_id。"); }
}
