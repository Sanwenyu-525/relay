import { RelayTransportError } from "../core/errors";
import type { RelayHttp } from "../core/http";
import { array, boolean, decimal, integer, nullableInteger, nullableString, object, string } from "../core/primitives";
import { commandEnvelopeFrom } from "../parse/projects";

export interface RelaySessionModelSelection {
  readonly sessionId: string;
  readonly connection: "default" | "openrouter" | "registered";
  /** 仅 `connection=registered` 时指向稳定连接身份；其余为 null。 */
  readonly connectionId: string | null;
  readonly model: string;
  readonly freeOnly: boolean;
  readonly revision: string;
}

export interface RelayCatalogModel {
  readonly id: string;
  readonly name: string;
  readonly contextWindow: number | null;
  readonly tools: boolean | null;
  readonly textInput: boolean | null;
  readonly textOutput: boolean | null;
}

export interface RelayModelCatalog {
  readonly configured: boolean;
  readonly chatConfigured: boolean;
  readonly lastSuccessAt: string | null;
  readonly lastFailureReason: string | null;
  readonly cacheStale: boolean;
  readonly snapshotSeq: string;
  readonly freeCount: number;
  readonly models: readonly RelayCatalogModel[];
}

function capability(row: Record<string, unknown>, key: string): boolean | null {
  return row[key] === null ? null : boolean(row, key, "model capability");
}

export function sessionModelSelectionFrom(value: unknown): RelaySessionModelSelection {
  const row = object(value, "session model selection");
  const freeOnly = boolean(row, "free_only", "session model selection");
  // 旧服务的回执没有 connection：按当时的语义由免费开关回推，不把旧会话当成已登记连接。
  const rawConnection = row.connection;
  if (rawConnection !== undefined && rawConnection !== null &&
    rawConnection !== "default" && rawConnection !== "openrouter" && rawConnection !== "registered") {
    throw new Error("模型连接类型无效。");
  }
  const connection = rawConnection === "default" || rawConnection === "openrouter" ||
    rawConnection === "registered" ? rawConnection : freeOnly ? "openrouter" : "default";
  const connectionId = row.connection_id === null || row.connection_id === undefined
    ? null : string(row, "connection_id", "session model selection");
  if (connection === "registered" && connectionId === null) {
    throw new Error("已登记连接的选择缺少连接身份。");
  }
  return { sessionId: string(row, "session_id", "session model selection"), connection,
    connectionId,
    model: string(row, "model", "session model selection"),
    freeOnly,
    revision: decimal(row, "revision", "session model selection") };
}

export async function getSessionModelSelection(http: RelayHttp, sessionId: string): Promise<RelaySessionModelSelection | null> {
  const row = object(await http.request(http.workspacePath(
    `/assist-sessions/${encodeURIComponent(sessionId)}/model-selection`)), "model selection");
  // 旧服务直接返回选择对象本身；model 为空（含裸 {model:null}）表示没有显式选择。
  const legacy = row.selection === undefined;
  if (legacy ? row.model === null || row.model === undefined : row.selection === null) return null;
  const selection = sessionModelSelectionFrom(legacy ? row : row.selection);
  if (selection.sessionId !== sessionId) throw new Error("模型选择与当前会话不匹配。");
  return selection;
}

export async function getModelCatalog(http: RelayHttp): Promise<RelayModelCatalog> {
  const row = object(await http.request(http.workspacePath("/model-catalog")), "model catalog");
  return { configured: boolean(row, "configured", "model catalog"),
    // 兼容旧服务只提供目录：缺少生成配置证明时不可声称已能调用。
    chatConfigured: row.chat_configured === undefined ? false : boolean(row, "chat_configured", "model catalog"),
    lastSuccessAt: nullableString(row, "last_success_at", "model catalog"),
    lastFailureReason: nullableString(row, "last_failure_reason", "model catalog"),
    cacheStale: boolean(row, "cache_stale", "model catalog"),
    snapshotSeq: decimal(row, "snapshot_seq", "model catalog"),
    freeCount: integer(row, "free_count", "model catalog"),
    models: array(row, "entries", "model catalog").flatMap((value) => {
      const entry = object(value, "catalog model");
      const id = string(entry, "source_model_id", "catalog model");
      if (!boolean(entry, "is_free", "catalog model") || id === "openrouter/free") return [];
      const capabilities = object(entry.capabilities, "model capabilities");
      return [{ id, name: string(entry, "display_name", "catalog model"),
        contextWindow: nullableInteger(entry, "context_window", "catalog model"),
        tools: capability(capabilities, "tools"), textInput: capability(capabilities, "text_input"),
        textOutput: capability(capabilities, "text_output") }];
    }) };
}

export async function refreshModelCatalog(http: RelayHttp): Promise<{ status: string; reason: string | null }> {
  const row = object(await http.request(http.workspacePath("/model-catalog/refresh"), { method: "POST" }), "catalog refresh");
  return { status: string(row, "status", "catalog refresh"), reason: nullableString(row, "reason", "catalog refresh") };
}

export async function selectSessionModel(http: RelayHttp, input: {
  sessionId: string; commandId: string; model: string;
}): Promise<RelaySessionModelSelection> {
  const body = await http.request(http.workspacePath(`/assist-sessions/${encodeURIComponent(input.sessionId)}/chat-commands`),
    { method: "POST", body: JSON.stringify({ command_id: input.commandId, text: `/model ${input.model}` }) }, 200);
  try {
    const envelope = commandEnvelopeFrom(body);
    const selection = sessionModelSelectionFrom(envelope.result);
    if (envelope.commandId !== input.commandId || envelope.result.kind !== "MODEL_SELECTION" ||
      selection.sessionId !== input.sessionId || selection.model !== input.model) throw new Error("command mismatch");
    return selection;
  } catch { throw new RelayTransportError("模型选择回执无法核对，请查询原 command_id。"); }
}

/**
 * 选择一个已登记连接：绑定稳定 connection_id，型号取连接当前声明。
 * 回执按连接身份核对；另一条连接即使型号相同也不算本次成功。
 */
export async function selectSessionConnection(http: RelayHttp, input: {
  sessionId: string; commandId: string; connectionId: string;
}): Promise<RelaySessionModelSelection> {
  const body = await http.request(http.workspacePath(
    `/assist-sessions/${encodeURIComponent(input.sessionId)}/model-selection`),
  { method: "POST", body: JSON.stringify({ command_id: input.commandId,
    connection_id: input.connectionId }) }, 200);
  try {
    const envelope = commandEnvelopeFrom(body);
    const selection = sessionModelSelectionFrom(envelope.result);
    if (envelope.commandId !== input.commandId || envelope.result.kind !== "MODEL_SELECTION" ||
      selection.sessionId !== input.sessionId || selection.connection !== "registered" ||
      selection.connectionId !== input.connectionId) throw new Error("command mismatch");
    return selection;
  } catch { throw new RelayTransportError("会话连接选择回执无法核对，请查询原 command_id。"); }
}

/** 清除本会话覆盖：回到工作区聊天默认 → 进程默认；不清除任何连接或凭据。 */
export async function clearSessionModelSelection(http: RelayHttp, input: {
  sessionId: string; commandId: string;
}): Promise<boolean> {
  const body = await http.request(http.workspacePath(
    `/assist-sessions/${encodeURIComponent(input.sessionId)}/model-selection`),
  { method: "POST", body: JSON.stringify({ command_id: input.commandId, connection_id: null }) }, 200);
  try {
    const envelope = commandEnvelopeFrom(body);
    if (envelope.commandId !== input.commandId || envelope.result.kind !== "MODEL_SELECTION_CLEARED" ||
      envelope.result.session_id !== input.sessionId) throw new Error("command mismatch");
    return envelope.result.cleared === true;
  } catch { throw new RelayTransportError("清除模型选择回执无法核对，请查询原 command_id。"); }
}
