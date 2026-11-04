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
  if (providerKind !== "openai-compatible" && providerKind !== "anthropic-messages") {
    // 不按品牌/URL 猜协议：服务端说了一条本客户端不认识的协议，就明确拒绝。
    throw new Error("服务端返回了无法识别的模型连接协议。");
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

/**
 * 工作区聊天默认连接：只影响「没有显式会话选择」的新消息；与 Run 默认分列，互不写回。
 * 未设置时 connection_id 为 null，表示继续跟随进程默认。
 */
export async function getChatDefaultModelConnection(http: RelayHttp):
Promise<RelayDefaultModelConnection> {
  const row = object(await http.request(http.workspacePath("/model-connections/chat-default")),
    "chat default model connection");
  return {
    connectionId: nullableString(row, "connection_id", "chat default model connection"),
    revision: nullableString(row, "revision", "chat default model connection")
  };
}

export async function setChatDefaultModelConnection(http: RelayHttp, input: {
  readonly commandId: string; readonly connectionId: string | null;
}): Promise<RelayDefaultModelConnection> {
  const envelope = commandEnvelopeFrom(await http.request(
    http.workspacePath("/model-connections/chat-default"), {
      method: "PUT",
      body: JSON.stringify({ command_id: input.commandId, connection_id: input.connectionId })
    }));
  return {
    connectionId: nullableString(envelope.result, "connection_id", "chat default model connection"),
    revision: nullableString(envelope.result, "revision", "chat default model connection")
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
  /** API 协议；省略时服务端按 openai-compatible 处理。 */
  readonly protocol?: "openai-compatible" | "anthropic-messages";
  readonly baseUrl: string | null;
  readonly defaultModel: string;
  /**
   * 只改这条连接的调用预算。省略时服务端用默认 30 秒；高延迟模型可单独放宽，
   * 不动其他 Provider 的全局超时。
   */
  readonly timeoutMs?: number;
  /** 只改这条连接的输出上限；省略时服务端用默认 8192。 */
  readonly maxOutputTokens?: number;
  /** 只在这一处出现一次：服务端落进系统凭据库，之后只保留不透明引用。 */
  readonly apiKey: string;
}

export interface ProbeModelConnectionInput {
  readonly protocol: "openai-compatible" | "anthropic-messages";
  readonly baseUrl: string | null;
  readonly defaultModel: string;
  /** 只在这一个请求里出现；服务端用完即弃，不写凭据库也不落业务表。 */
  readonly apiKey: string;
  readonly timeoutMs?: number;
}

export interface ProbeModelConnectionResult {
  readonly ok: boolean;
  readonly latencyMs: number;
  readonly protocol: "openai-compatible" | "anthropic-messages";
  readonly model: string;
  readonly errorCategory: string | null;
  readonly message: string | null;
}

/**
 * 「测试连接」：对尚未保存的草稿做一次真实短探针。
 *
 * 它**不是**连接验证：不写 model_calls、不写凭据库，也不产生「这条连接已验证」的事实。
 * 保存后仍需按连接身份验证（设置页每一行的「验证」）。
 */
export async function probeModelConnection(http: RelayHttp,
  input: ProbeModelConnectionInput): Promise<ProbeModelConnectionResult> {
  const row = object(await http.request(http.workspacePath("/model-connections/probe"), {
    method: "POST",
    body: JSON.stringify({
      protocol: input.protocol,
      ...(input.baseUrl === null ? {} : { base_url: input.baseUrl }),
      default_model: input.defaultModel,
      api_key: input.apiKey,
      ...(input.timeoutMs === undefined ? {} : { timeout_ms: input.timeoutMs })
    })
  }), "model connection probe");
  const protocol = string(row, "protocol", "model connection probe");
  if (protocol !== "openai-compatible" && protocol !== "anthropic-messages") {
    throw new Error("服务端返回了无法识别的模型连接协议。");
  }
  return {
    ok: row.ok === true,
    latencyMs: integer(row, "latency_ms", "model connection probe"),
    protocol,
    model: string(row, "model", "model connection probe"),
    errorCategory: nullableString(row, "error_category", "model connection probe"),
    message: nullableString(row, "message", "model connection probe")
  };
}

export async function createModelConnection(http: RelayHttp,
  input: CreateModelConnectionInput): Promise<RelayModelConnection> {
  const envelope = commandEnvelopeFrom(await http.request(http.workspacePath("/model-connections"), {
    method: "POST",
    body: JSON.stringify({
      command_id: input.commandId,
      name: input.name,
      ...(input.protocol === undefined ? {} : { protocol: input.protocol }),
      ...(input.baseUrl === null ? {} : { base_url: input.baseUrl }),
      default_model: input.defaultModel,
      ...(input.timeoutMs === undefined && input.maxOutputTokens === undefined ? {} : {
        budget: {
          ...(input.timeoutMs === undefined ? {} : { timeout_ms: input.timeoutMs }),
          ...(input.maxOutputTokens === undefined
            ? {} : { max_output_tokens: input.maxOutputTokens })
        }
      }),
      api_key: input.apiKey
    })
  }));
  return modelConnectionFrom(envelope.result.connection, "created model connection");
}

export interface UpdateModelConnectionInput {
  readonly commandId: string;
  readonly expectedRevision: string;
  readonly name?: string;
  /** 改协议会改变配置指纹；旧冻结快照与旧验证结论随之失效。 */
  readonly protocol?: "openai-compatible" | "anthropic-messages";
  readonly baseUrl?: string | null;
  readonly defaultModel?: string;
  /** 只更新这条连接的调用超时；省略表示不改。 */
  readonly timeoutMs?: number;
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
        ...(input.protocol === undefined ? {} : { protocol: input.protocol }),
        ...(input.baseUrl === undefined ? {} : { base_url: input.baseUrl }),
        ...(input.defaultModel === undefined ? {} : { default_model: input.defaultModel }),
        ...(input.timeoutMs === undefined ? {} : { budget: { timeout_ms: input.timeoutMs } })
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
