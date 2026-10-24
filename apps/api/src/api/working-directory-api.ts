import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';

import { openWorkingDirectory } from '../application/open-working-directory.js';
import { readWorkspaceDefaultDirectory, setWorkspaceContextBudget, setWorkspaceDefaultDirectory,
  setWorkspaceDefaultWriteTier } from '../application/workspace-default-directory.js';
import { createCommandHandler, sendReadError, type RouteDependencies } from './envelope.js';
import { commandEnvelopeSchema } from './domain-schemas.js';

const strict = { additionalProperties: false } as const;
const uuid = Type.String({ format: 'uuid' });

const candidateSchema = Type.Object({
  project_id: uuid,
  project_title: Type.String(),
  project_archived: Type.Boolean(),
  resource_id: uuid,
  resource_status: Type.String(),
  file_write_identity_bound: Type.Boolean(),
}, strict);

const openResultSchema = Type.Object({
  canonical_root: Type.String(),
  display_name: Type.String(),
  status: Type.Union([Type.Literal('READY'), Type.Literal('AMBIGUOUS'), Type.Literal('NOT_READY')]),
  reason: Type.Union([Type.String(), Type.Null()]),
  association: Type.Union([candidateSchema, Type.Null()]),
  created_project: Type.Boolean(),
  created_resource: Type.Boolean(),
  candidates: Type.Array(candidateSchema),
  // 2026-10-20（P1-3）：Git 只读投影。可选是因为旧回执写在这些字段之前，
  // 重放时必须照样返回，不能因为升级就丢掉一条已提交的回执。
  git_read: Type.Optional(Type.Object({
    state: Type.String(),
    repo_root: Type.Union([Type.String(), Type.Null()]),
    detail: Type.String(),
  }, strict)),
  write_readiness: Type.Object({
    status: Type.String(),
    detail: Type.String(),
    // 可选：已提交回执在这组字段存在之前写入，重放时必须照样返回。
    policy_decision: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    policy_id: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    policy_revision: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    policy_target_prefix: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    write_tier: Type.Optional(Type.Union([Type.Literal('READ_ONLY'), Type.Literal('ASK'),
      Type.Literal('AUTO'), Type.Literal('FULL'), Type.Null()])),
    access_revision: Type.Optional(Type.String({ pattern: '^(0|[1-9][0-9]*)$' })),
  }, strict),
}, strict);

const openBody = Type.Object({
  command_id: uuid,
  root_path: Type.String({ minLength: 1, maxLength: 1024 }),
  project_id: Type.Optional(Type.Union([uuid, Type.Null()])),
}, strict);

/**
 * 工作台 §18.1 的文件夹入口。写命令：可能建立最小 Project/受管资源，因此读取页面不得调用它。
 * 取消选择、目录无效和登记失败都由调用方保留草稿并说明，不在这里伪造就绪状态。
 */
export function registerWorkingDirectoryRoutes(app: FastifyInstance, dependencies: RouteDependencies): void {
  const rev = Type.String({ pattern: '^(0|[1-9][0-9]*)$' });
  const params = Type.Object({ workspace_id: uuid }, strict);
  const result = Type.Object({ workspace_id: uuid, resource_id: Type.Union([uuid, Type.Null()]), revision: rev }, strict);
  const setBody = Type.Object({ command_id: uuid, expected_revision: rev, resource_id: uuid }, strict);
  const clearBody = Type.Object({ command_id: uuid, expected_revision: rev }, strict);
  const tierEnum = Type.Union([Type.Literal('READ_ONLY'), Type.Literal('ASK'), Type.Literal('AUTO'),
    Type.Literal('FULL')]);
  // 0131（DEV-0115）：默认档位与默认目录共用同一行与同一个修订号，因此 CAS 用同一把尺子。
  const tierBody = Type.Object({ command_id: uuid, expected_revision: rev,
    default_write_tier: Type.Union([tierEnum, Type.Null()]) }, strict);
  const tierResult = Type.Object({ workspace_id: uuid, default_write_tier: Type.Union([tierEnum, Type.Null()]),
    revision: rev }, strict);
  const projection = Type.Object({ resource_id: Type.Union([uuid, Type.Null()]),
    canonical_root: Type.Union([Type.String(), Type.Null()]),
    display_name: Type.Union([Type.String(), Type.Null()]),
    write_tier: Type.Union([Type.Literal('READ_ONLY'), Type.Literal('ASK'), Type.Literal('AUTO'),
      Type.Literal('FULL'), Type.Null()]),
    default_write_tier: Type.Union([tierEnum, Type.Null()]),
    /** 0135（2026-10-24）：上下文长度档位；null＝还没选过，由客户端按进程默认值展示。 */
    context_budget_tokens: Type.Union([Type.Integer(), Type.Null()]),
    status: Type.Union([Type.Literal('UNSET'), Type.Literal('READY'), Type.Literal('UNAVAILABLE')]),
    reason: Type.Union([Type.String(), Type.Null()]), revision: rev }, strict);
  app.get('/default-working-directory', { schema: { params, response: { 200: projection } } }, async (request, reply) => {
    try {
      return await readWorkspaceDefaultDirectory(dependencies.database.executor,
        (request.params as { workspace_id: string }).workspace_id);
    } catch (error) { return sendReadError(reply, error, request.id); }
  });
  app.post('/default-working-directory', {
    schema: { params, body: setBody, response: { 200: commandEnvelopeSchema(result) } },
  }, createCommandHandler(dependencies, { commandType: 'SetWorkspaceDefaultDirectory', bodySchema: setBody,
    execute: async ({ executor, params: p, body }) => {
      const outcome = await setWorkspaceDefaultDirectory(executor, { workspaceId: p.workspace_id ?? '',
        commandId: body.command_id, expectedRevision: body.expected_revision, resourceId: body.resource_id });
      return { outcome, result: outcome.result };
    } }));
  app.post('/default-working-directory/clear', {
    schema: { params, body: clearBody, response: { 200: commandEnvelopeSchema(result) } },
  }, createCommandHandler(dependencies, { commandType: 'ClearWorkspaceDefaultDirectory', bodySchema: clearBody,
    execute: async ({ executor, params: p, body }) => {
      const outcome = await setWorkspaceDefaultDirectory(executor, { workspaceId: p.workspace_id ?? '',
        commandId: body.command_id, expectedRevision: body.expected_revision, resourceId: null });
      return { outcome, result: outcome.result };
    } }));
  app.post('/default-write-tier', {
    schema: { params, body: tierBody, response: { 200: commandEnvelopeSchema(tierResult) } },
  }, createCommandHandler(dependencies, { commandType: 'SetWorkspaceDefaultWriteTier', bodySchema: tierBody,
    execute: async ({ executor, params: p, body }) => {
      const outcome = await setWorkspaceDefaultWriteTier(executor, { workspaceId: p.workspace_id ?? '',
        commandId: body.command_id, expectedRevision: body.expected_revision,
        tier: body.default_write_tier });
      return { outcome, result: outcome.result };
    } }));

  /* 0135（2026-10-24）：上下文长度三档。与默认写档位共用同一行与同一个修订号，
     所以 CAS 用同一把尺子；`context_budget_tokens` 为 null 表示清除选择（回到进程默认）。 */
  const budgetBody = Type.Object({ command_id: uuid, expected_revision: rev,
    context_budget_tokens: Type.Union([Type.Literal(262_144), Type.Literal(524_288),
      Type.Literal(1_048_576), Type.Null()]) }, strict);
  const budgetResult = Type.Object({ workspace_id: uuid,
    context_budget_tokens: Type.Union([Type.Integer(), Type.Null()]), revision: rev }, strict);
  app.post('/context-budget', {
    schema: { params, body: budgetBody, response: { 200: commandEnvelopeSchema(budgetResult) } },
  }, createCommandHandler(dependencies, { commandType: 'SetWorkspaceContextBudget', bodySchema: budgetBody,
    execute: async ({ executor, params: p, body }) => {
      const outcome = await setWorkspaceContextBudget(executor, { workspaceId: p.workspace_id ?? '',
        commandId: body.command_id, expectedRevision: body.expected_revision,
        budgetTokens: body.context_budget_tokens });
      return { outcome, result: outcome.result };
    } }));
  app.post('/working-directories/open', {
    schema: { body: openBody, response: { 200: commandEnvelopeSchema(openResultSchema) } },
  }, createCommandHandler(dependencies, { commandType: 'OpenWorkingDirectory', bodySchema: openBody,
    execute: async ({ executor, params, body }) => {
      const outcome = await openWorkingDirectory(executor, { workspaceId: params.workspace_id ?? '',
        commandId: body.command_id, rootPath: body.root_path, projectId: body.project_id ?? null });
      return { outcome, result: outcome.result };
    } }));
}
