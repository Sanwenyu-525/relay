import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';

import { createCommandHandler, sendReadError, type RouteDependencies } from './envelope.js';
import { UuidSchema } from './domain-schemas.js';
import { ProblemError } from './problem.js';
import {
  createModelConnectionCommand,
  readDefaultModelConnection,
  setDefaultModelConnectionCommand,
  listModelConnections,
  readModelConnection,
  readModelConnectionCredentialPresence,
  rotateModelConnectionCredentialCommand,
  setModelConnectionStatusCommand,
  toModelConnectionJson,
  updateModelConnectionCommand,
  type ModelConnectionBudget,
} from '../application/model-connections.js';

/**
 * 模型连接登记（P2 阶段一，ADR-036）。
 *
 * 边界（必须如实阅读）：
 *   * 这里只做**登记与凭据管理**。连接尚未参与模型解析——执行端仍只按 Run 冻结计划或
 *     进程默认解析。所以这些端点**不**声称「连接已可用于执行」；把连接接到会话选择与
 *     Run 冻结是下一阶段，需要新的冻结列，不是靠改这些端点。
 *   * 响应**永不包含** `credential_ref`、密钥、密文或凭据摘要。写入时 Key 只在请求体里
 *     出现一次，服务端落进系统凭据库后只保留不透明引用。
 *   * 写命令走统一命令处理器：回执与业务事实同事务，重放返回当时结果；更新一律
 *     revision CAS，不做 last-write-wins。
 */

const ParamsSchema = Type.Object({ workspace_id: UuidSchema });
const ConnectionParamsSchema = Type.Object({
  workspace_id: UuidSchema,
  connection_id: UuidSchema,
});

const BudgetSchema = Type.Object({
  timeout_ms: Type.Integer(),
  max_output_tokens: Type.Integer(),
  max_call_tokens: Type.Integer(),
  max_scope_calls: Type.Integer(),
  max_scope_tokens: Type.Integer(),
}, { additionalProperties: false });

const ConnectionSchema = Type.Object({
  id: UuidSchema,
  workspace_id: UuidSchema,
  name: Type.String(),
  provider_kind: Type.Literal('openai-compatible'),
  base_url: Type.Union([Type.String(), Type.Null()]),
  default_model: Type.String(),
  budget: BudgetSchema,
  /** 凭据代数：轮换后 +1。不含引用、不含摘要。 */
  credential_version: Type.Integer(),
  status: Type.Union([Type.Literal('ACTIVE'), Type.Literal('DISABLED')]),
  revision: Type.String(),
  created_at: Type.String(),
  updated_at: Type.String(),
}, { additionalProperties: false });

const ConnectionListSchema = Type.Object({
  items: Type.Array(ConnectionSchema),
}, { additionalProperties: false });

const DefaultConnectionSchema = Type.Object({
  /** 未设置时为 null：新 Run 走进程默认（并显式标注 basis=LEGACY_ENV）。 */
  connection_id: Type.Union([UuidSchema, Type.Null()]),
  revision: Type.Union([Type.String(), Type.Null()]),
}, { additionalProperties: false });

const SetDefaultConnectionBodySchema = Type.Object({
  command_id: UuidSchema,
  connection_id: UuidSchema,
}, { additionalProperties: false });

const CredentialPresenceSchema = Type.Object({
  /** 系统凭据库里是否还有这条连接引用的秘密。只回布尔。 */
  present: Type.Boolean(),
}, { additionalProperties: false });

const BudgetBodySchema = Type.Optional(Type.Object({
  timeout_ms: Type.Optional(Type.Integer()),
  max_output_tokens: Type.Optional(Type.Integer()),
  max_call_tokens: Type.Optional(Type.Integer()),
  max_scope_calls: Type.Optional(Type.Integer()),
  max_scope_tokens: Type.Optional(Type.Integer()),
}, { additionalProperties: false }));

const CreateConnectionBodySchema = Type.Object({
  command_id: UuidSchema,
  name: Type.String({ minLength: 1, maxLength: 60 }),
  /** 缺省/空串＝使用内置默认端点。 */
  base_url: Type.Optional(Type.Union([Type.String({ maxLength: 500 }), Type.Null()])),
  default_model: Type.String({ minLength: 1, maxLength: 200 }),
  budget: BudgetBodySchema,
  /** 只在此处出现一次：服务端落进系统凭据库，之后只保留不透明引用。 */
  api_key: Type.String({ minLength: 1, maxLength: 8192 }),
}, { additionalProperties: false });

const UpdateConnectionBodySchema = Type.Object({
  command_id: UuidSchema,
  expected_revision: Type.String({ pattern: '^[0-9]{1,18}$' }),
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 60 })),
  base_url: Type.Optional(Type.Union([Type.String({ maxLength: 500 }), Type.Null()])),
  default_model: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  budget: BudgetBodySchema,
}, { additionalProperties: false });

const RotateCredentialBodySchema = Type.Object({
  command_id: UuidSchema,
  expected_revision: Type.String({ pattern: '^[0-9]{1,18}$' }),
  api_key: Type.String({ minLength: 1, maxLength: 8192 }),
}, { additionalProperties: false });

const SetStatusBodySchema = Type.Object({
  command_id: UuidSchema,
  expected_revision: Type.String({ pattern: '^[0-9]{1,18}$' }),
  status: Type.Union([Type.Literal('ACTIVE'), Type.Literal('DISABLED')]),
}, { additionalProperties: false });

function budgetOf(raw: Record<string, number | undefined> | undefined):
Partial<ModelConnectionBudget> | undefined {
  if (raw === undefined) return undefined;
  return {
    ...(raw.timeout_ms === undefined ? {} : { timeoutMs: raw.timeout_ms }),
    ...(raw.max_output_tokens === undefined ? {} : { maxOutputTokens: raw.max_output_tokens }),
    ...(raw.max_call_tokens === undefined ? {} : { maxCallTokens: raw.max_call_tokens }),
    ...(raw.max_scope_calls === undefined ? {} : { maxScopeCalls: raw.max_scope_calls }),
    ...(raw.max_scope_tokens === undefined ? {} : { maxScopeTokens: raw.max_scope_tokens }),
  };
}

/** revision 用字符串传输（bigint 不能安全走 JSON number）；解析失败按请求畸形处理。 */
function revisionOf(raw: string): bigint {
  try {
    return BigInt(raw);
  } catch {
    throw new ProblemError({
      type: '/problems/malformed-request', title: '请求格式错误', status: 400,
      detail: 'expected_revision 必须是十进制整数。', code: 'MALFORMED_REQUEST',
      retryable: false, retryAction: 'NONE',
    });
  }
}

export function registerModelConnectionRoutes(app: FastifyInstance,
  dependencies: RouteDependencies): void {
  app.get('/model-connections', {
    schema: { params: ParamsSchema, response: { 200: ConnectionListSchema } },
  }, async (request, reply) => {
    try {
      const params = request.params as { workspace_id: string };
      const rows = await listModelConnections(dependencies.database.executor, params.workspace_id);
      return { items: rows.map((row) => toModelConnectionJson(row)) };
    } catch (error) { return sendReadError(reply, error, request.id); }
  });

  /**
   * 工作区默认连接。它决定**新的 Run** 从哪条连接冻结模型身份；会话聊天仍按会话选择或
   * 进程默认，两者作用域不同，互不写回。未设置时 `connection_id=null`。
   */
  app.get('/model-connections/default', {
    schema: { params: ParamsSchema, response: { 200: DefaultConnectionSchema } },
  }, async (request, reply) => {
    try {
      const params = request.params as { workspace_id: string };
      const current = await readDefaultModelConnection(dependencies.database.executor,
        params.workspace_id);
      return { connection_id: current?.connectionId ?? null,
        revision: current === undefined ? null : current.revision.toString() };
    } catch (error) { return sendReadError(reply, error, request.id); }
  });

  app.put('/model-connections/default', {
    schema: { params: ParamsSchema, body: SetDefaultConnectionBodySchema },
  }, createCommandHandler(dependencies, {
    commandType: 'SetDefaultModelConnection',
    bodySchema: SetDefaultConnectionBodySchema,
    execute: async ({ dependencies: deps, body, params }) => {
      const outcome = await setDefaultModelConnectionCommand({ db: deps.database.executor },
        { workspaceId: params.workspace_id!, commandId: body.command_id,
          connectionId: body.connection_id });
      return { outcome, result: outcome.result };
    },
  }));

  app.get('/model-connections/:connection_id', {
    schema: { params: ConnectionParamsSchema, response: { 200: ConnectionSchema } },
  }, async (request, reply) => {
    try {
      const params = request.params as { workspace_id: string; connection_id: string };
      const connection = await readModelConnection(dependencies.database.executor,
        params.workspace_id, params.connection_id);
      if (connection === undefined) {
        return sendReadError(reply, new ProblemError({
          type: '/problems/resource-not-found', title: '资源不存在', status: 404,
          detail: '模型连接在当前作用域中不可见或不存在。', code: 'RESOURCE_NOT_FOUND',
          retryable: false, retryAction: 'NONE',
        }), request.id);
      }
      return toModelConnectionJson(connection);
    } catch (error) { return sendReadError(reply, error, request.id); }
  });

  /**
   * 凭据是否还在库里。单独一个端点，是因为它要真的去问系统凭据库（一次子进程调用），
   * 不该混进列表响应里让每次刷新都付这份代价。
   */
  app.get('/model-connections/:connection_id/credential', {
    schema: { params: ConnectionParamsSchema, response: { 200: CredentialPresenceSchema } },
  }, async (request, reply) => {
    try {
      const params = request.params as { workspace_id: string; connection_id: string };
      return { present: await readModelConnectionCredentialPresence(
        { db: dependencies.database.executor, credentials: dependencies.credentials },
        { workspaceId: params.workspace_id, id: params.connection_id }) };
    } catch (error) { return sendReadError(reply, error, request.id); }
  });

  app.post('/model-connections', {
    schema: { params: ParamsSchema, body: CreateConnectionBodySchema },
  }, createCommandHandler(dependencies, {
    commandType: 'CreateModelConnection',
    bodySchema: CreateConnectionBodySchema,
    execute: async ({ dependencies: deps, body, params }) => {
      const outcome = await createModelConnectionCommand(
        { db: deps.database.executor, credentials: deps.credentials },
        { workspaceId: params.workspace_id!, commandId: body.command_id, name: body.name,
          baseUrl: body.base_url ?? null, defaultModel: body.default_model,
          budget: budgetOf(body.budget), apiKey: body.api_key });
      return { outcome, result: outcome.result };
    },
  }));

  app.patch('/model-connections/:connection_id', {
    schema: { params: ConnectionParamsSchema, body: UpdateConnectionBodySchema },
  }, createCommandHandler(dependencies, {
    commandType: 'UpdateModelConnection',
    bodySchema: UpdateConnectionBodySchema,
    execute: async ({ dependencies: deps, body, params }) => {
      const outcome = await updateModelConnectionCommand(
        { db: deps.database.executor, credentials: deps.credentials },
        { workspaceId: params.workspace_id!, commandId: body.command_id,
          id: params.connection_id!, expectedRevision: revisionOf(body.expected_revision),
          ...(body.name === undefined ? {} : { name: body.name }),
          ...(body.base_url === undefined ? {} : { baseUrl: body.base_url }),
          ...(body.default_model === undefined ? {} : { defaultModel: body.default_model }),
          ...(body.budget === undefined ? {} : { budget: budgetOf(body.budget) }) });
      return { outcome, result: outcome.result };
    },
  }));

  app.post('/model-connections/:connection_id/credential', {
    schema: { params: ConnectionParamsSchema, body: RotateCredentialBodySchema },
  }, createCommandHandler(dependencies, {
    commandType: 'RotateModelConnectionCredential',
    bodySchema: RotateCredentialBodySchema,
    execute: async ({ dependencies: deps, body, params }) => {
      const outcome = await rotateModelConnectionCredentialCommand(
        { db: deps.database.executor, credentials: deps.credentials },
        { workspaceId: params.workspace_id!, commandId: body.command_id,
          id: params.connection_id!, expectedRevision: revisionOf(body.expected_revision),
          apiKey: body.api_key });
      return { outcome, result: outcome.result };
    },
  }));

  app.post('/model-connections/:connection_id/status', {
    schema: { params: ConnectionParamsSchema, body: SetStatusBodySchema },
  }, createCommandHandler(dependencies, {
    commandType: 'SetModelConnectionStatus',
    bodySchema: SetStatusBodySchema,
    execute: async ({ dependencies: deps, body, params }) => {
      const outcome = await setModelConnectionStatusCommand(
        { db: deps.database.executor },
        { workspaceId: params.workspace_id!, commandId: body.command_id,
          id: params.connection_id!, expectedRevision: revisionOf(body.expected_revision),
          status: body.status });
      return { outcome, result: outcome.result };
    },
  }));
}
