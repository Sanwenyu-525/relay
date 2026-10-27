import { RelayHttp } from "../core/http";
import { array, integer, nullableString, object, string } from "../core/primitives";
import { commandEnvelopeFrom } from "../parse/projects";
import type { RelayDefaultModelConnection, RelayModelConnection,
  RelayModelConnectionBudget } from "../dtos/information";

/**
 * 模型连接登记（ADR-036）。响应永不包含凭据引用、密钥或摘要——服务端就不返回它们，
 * 因此这里也不做「可选字段」的兜底：多一个字段就等于多一个可能被误用的入口。
 *
 * 连接当前只决定**新 Run** 的冻结来源；会话聊天仍按会话选择或进程默认。界面文案必须
 * 如实这么说，否则用户会以为改了默认连接就换了聊天模型。
 */

function budgetFrom(value: unknown, where: string): RelayModelConnectionBudget {
  const row = object(value, `${where}.budget`);
  return {
    timeoutMs: integer(row, "timeout_ms", `${where}.budget`),
    maxOutputTokens: integer(row, "max_output_tokens", `${where}.budget`),
    maxCallTokens: integer(row, "max_call_tokens", `${where}.budget`),
    maxScopeCalls: integer(row, "max_scope_calls", `${where}.budget`),
    maxScopeTokens: integer(row, "max_scope_tokens", `${where}.budget`)
  };
}

export function modelConnectionFrom(value: unknown, where = "model connection"): RelayModelConnection {
  const row = object(value, where);
  const providerKind = string(row, "provider_kind", where);
  if (providerKind !== "openai-compatible") {
    throw new Error("服务端返回了无法识别的模型连接类型。");
  }
  const status = string(row, "status", where);
  if (status !== "ACTIVE" && status !== "DISABLED") {
    throw new Error("服务端返回了无法识别的模型连接状态。");
  }
  return {
    id: string(row, "id", where),
    name: string(row, "name", where),
    providerKind,
    baseUrl: nullableString(row, "base_url", where),
    defaultModel: string(row, "default_model", where),
    budget: budgetFrom(row.budget, where),
    credentialVersion: integer(row, "credential_version", where),
    status,
    revision: string(row, "revision", where),
    createdAt: string(row, "created_at", where),
    updatedAt: string(row, "updated_at", where)
  };
}

export async function listModelConnections(http: RelayHttp): Promise<readonly RelayModelConnection[]> {
  const row = object(await http.request(http.workspacePath("/model-connections")),
    "model connections");
  return array(row, "items", "model connections")
    .map((item) => modelConnectionFrom(item, "model connection"));
}

export async function getDefaultModelConnection(http: RelayHttp):
Promise<RelayDefaultModelConnection> {
  const row = object(await http.request(http.workspacePath("/model-connections/default")),
    "default model connection");
  return {
    connectionId: nullableString(row, "connection_id", "default model connection"),
    revision: nullableString(row, "revision", "default model connection")
  };
}

export async function getModelConnectionCredentialPresence(http: RelayHttp,
  connectionId: string): Promise<boolean> {
  const row = object(await http.request(http.workspacePath(
    `/model-connections/${connectionId}/credential`)), "model connection credential");
  return row.present === true;
}

export interface CreateModelConnectionInput {
  readonly commandId: string;
  readonly name: string;
  readonly baseUrl: string | null;
  readonly defaultModel: string;
  /** 只在这一处出现一次：服务端落进系统凭据库，之后只保留不透明引用。 */
  readonly apiKey: string;
}

export async function createModelConnection(http: RelayHttp,
  input: CreateModelConnectionInput): Promise<RelayModelConnection> {
  const envelope = commandEnvelopeFrom(await http.request(http.workspacePath("/model-connections"), {
    method: "POST",
    body: JSON.stringify({
      command_id: input.commandId,
      name: input.name,
      ...(input.baseUrl === null ? {} : { base_url: input.baseUrl }),
      default_model: input.defaultModel,
      api_key: input.apiKey
    })
  }));
  return modelConnectionFrom(envelope.result.connection, "created model connection");
}

export interface UpdateModelConnectionInput {
  readonly commandId: string;
  readonly expectedRevision: string;
  readonly name?: string;
  readonly baseUrl?: string | null;
  readonly defaultModel?: string;
}

export async function updateModelConnection(http: RelayHttp, connectionId: string,
  input: UpdateModelConnectionInput): Promise<RelayModelConnection> {
  const envelope = commandEnvelopeFrom(await http.request(
    http.workspacePath(`/model-connections/${connectionId}`), {
      method: "PATCH",
      body: JSON.stringify({
        command_id: input.commandId,
        expected_revision: input.expectedRevision,
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.baseUrl === undefined ? {} : { base_url: input.baseUrl }),
        ...(input.defaultModel === undefined ? {} : { default_model: input.defaultModel })
      })
    }));
  return modelConnectionFrom(envelope.result.connection, "updated model connection");
}

export async function rotateModelConnectionCredential(http: RelayHttp, connectionId: string,
  input: { readonly commandId: string; readonly expectedRevision: string;
    readonly apiKey: string }): Promise<RelayModelConnection> {
  const envelope = commandEnvelopeFrom(await http.request(
    http.workspacePath(`/model-connections/${connectionId}/credential`), {
      method: "POST",
      body: JSON.stringify({ command_id: input.commandId,
        expected_revision: input.expectedRevision, api_key: input.apiKey })
    }));
  return modelConnectionFrom(envelope.result.connection, "rotated model connection");
}

export async function setModelConnectionStatus(http: RelayHttp, connectionId: string,
  input: { readonly commandId: string; readonly expectedRevision: string;
    readonly status: "ACTIVE" | "DISABLED" }): Promise<RelayModelConnection> {
  const envelope = commandEnvelopeFrom(await http.request(
    http.workspacePath(`/model-connections/${connectionId}/status`), {
      method: "POST",
      body: JSON.stringify({ command_id: input.commandId,
        expected_revision: input.expectedRevision, status: input.status })
    }));
  return modelConnectionFrom(envelope.result.connection, "model connection status");
}

export async function setDefaultModelConnection(http: RelayHttp, connectionId: string,
  commandId: string): Promise<RelayDefaultModelConnection> {
  const envelope = commandEnvelopeFrom(await http.request(
    http.workspacePath("/model-connections/default"), {
      method: "PUT",
      body: JSON.stringify({ command_id: commandId, connection_id: connectionId })
    }));
  return {
    connectionId: nullableString(envelope.result, "connection_id", "default model connection"),
    revision: nullableString(envelope.result, "revision", "default model connection")
  };
}
