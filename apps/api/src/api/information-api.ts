import { createHash } from 'node:crypto';

import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';

import { addKnowledgeVersion, addMemoryRevision, addRuleVersion, createDecision,
  createKnowledge, createMemory, createMemoryFromMessage, createRule, retireInformation, restoreInformation, supersedeDecision,
  type KnowledgeSource } from '../application/information-commands.js';
import { listInformation, listInformationVersions, listMemoryPage, readInformation,
  readKnowledgeVersionContent, searchInformation } from '../application/information-queries.js';
import { validationFailed } from '../application/domain-error.js';
import { readMemorySettings, setMemorySettings } from '../application/memory-settings.js';
import { consolidateMemoriesCommand, setMemoryExpiryCommand, setMemoryPinnedCommand,
  setMemoryVerificationCommand } from '../application/memory-commands.js';
import { readMemoryObservability } from '../application/memory-observability.js';
import { exportMemories, importMemories, purgeMemories } from '../application/memory-transfer.js';
import { createRepositories } from '../application/unit-of-work.js';
import { commandEnvelopeSchema } from './domain-schemas.js';
import { createCommandHandler, sendReadError, type RouteDependencies } from './envelope.js';

const strict = { additionalProperties: false } as const;
const uuid = Type.String({ format: 'uuid' });
const rev = Type.String({ pattern: '^(0|[1-9][0-9]*)$' });
const text = Type.String({ minLength: 1, maxLength: 262144 });
const base = Type.Object({ workspace_id: uuid }, strict);
const item = Type.Object({ workspace_id: uuid, id: uuid }, strict);
const listQuery = Type.Object({ project_id: Type.Optional(uuid) }, strict);
const memoryType = Type.Union([Type.Literal('USER_PREFERENCE'), Type.Literal('PROJECT_FACT'),
  Type.Literal('EXPERIENCE'), Type.Literal('EPISODIC'), Type.Literal('UNKNOWN')]);
const memoryVerification = Type.Union([Type.Literal('VERIFIED'), Type.Literal('UNVERIFIED'),
  Type.Literal('FAILED')]);
const memoryListQuery = Type.Object({ project_id: Type.Optional(uuid),
  effective_status: Type.Optional(Type.Union([Type.Literal('ALL'), Type.Literal('ACTIVE'),
    Type.Literal('EXPIRED'), Type.Literal('RETIRED'), Type.Literal('SUPERSEDED'),
    Type.Literal('STALE')])),
  memory_type: Type.Optional(Type.Union([memoryType, Type.Literal('ALL')])),
  origin: Type.Optional(Type.Union([Type.Literal('ALL'), Type.Literal('HUMAN_CONFIRMED'),
    Type.Literal('AUTO_CAPTURE')])),
  verification: Type.Optional(Type.Union([Type.Literal('ALL'), memoryVerification])),
  source_kind: Type.Optional(Type.Union([Type.Literal('ALL'), Type.Literal('MANUAL'),
    Type.Literal('USER_STATEMENT'), Type.Literal('MODEL_OBSERVATION'), Type.Literal('UNKNOWN')])),
  pinned: Type.Optional(Type.Union([Type.Literal('true'), Type.Literal('false')])),
  sort: Type.Optional(Type.Union([Type.Literal('updated'), Type.Literal('created'),
    Type.Literal('importance')])),
  cursor: Type.Optional(Type.String({ maxLength: 500 })),
  q: Type.Optional(Type.String({ maxLength: 200 })),
  limit: Type.Optional(Type.String({ pattern: '^(?:[1-9]|[1-9][0-9]|100)$' })) }, strict);
const knowledgeContentParams = Type.Object({ workspace_id: uuid, id: uuid,
  version: Type.String({ pattern: '^[1-9][0-9]{0,18}$' }) }, strict);
const knowledgeContent = Type.Object({ knowledge_id: uuid, title: Type.String(),
  project_id: Type.Union([uuid, Type.Null()]), current_version: rev,
  id: uuid, version: rev, source_kind: Type.Union([Type.Literal('NOTE'), Type.Literal('MANAGED_TEXT'),
    Type.Literal('ARTIFACT_VERSION'), Type.Literal('WEB_PAGE')]),
  media_type: Type.String(), content_sha256: Type.String(), availability: Type.String(),
  source_refs: Type.Record(Type.String(), Type.Unknown()),
  source_uri: Type.Union([Type.String(), Type.Null()]), created_at: Type.String(),
  content_status: Type.Union([Type.Literal('FULL'), Type.Literal('PARTIAL'),
    Type.Literal('UNAVAILABLE'), Type.Literal('UNSUPPORTED'), Type.Literal('READ_FAILED')]),
  content: Type.Union([Type.String(), Type.Null()]),
}, strict);
const commandResult = Type.Record(Type.String(), Type.String());
const source = {
  source_kind: Type.Union([Type.Literal('NOTE'), Type.Literal('MANAGED_TEXT'),
    Type.Literal('ARTIFACT_VERSION')]),
  text: Type.Optional(text), media_type: Type.Optional(Type.String()),
  artifact_version_id: Type.Optional(uuid),
};
const createKnowledgeBody = Type.Object({ command_id: uuid, project_id: Type.Union([uuid, Type.Null()]),
  title: text, ...source }, strict);
const versionKnowledgeBody = Type.Object({ command_id: uuid, expected_revision: rev, ...source }, strict);
const memoryFields = { title: text, text, confirmed: Type.Literal(true),
  expires_at: Type.Optional(Type.Union([Type.String({ format: 'date-time' }), Type.Null()])) };
const memoryMetaFields = {
  memory_type: Type.Optional(memoryType),
  memory_key: Type.Optional(Type.Union([Type.String({ maxLength: 80 }), Type.Null()])),
  importance: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 })),
  pinned: Type.Optional(Type.Boolean()),
  task_id: Type.Optional(Type.Union([uuid, Type.Null()])),
  verification: Type.Optional(memoryVerification),
};
const createMemoryBody = Type.Object({ command_id: uuid,
  project_id: Type.Union([uuid, Type.Null()]), ...memoryFields, ...memoryMetaFields }, strict);
const versionMemoryBody = Type.Object({ command_id: uuid, expected_revision: rev,
  ...memoryFields, ...memoryMetaFields }, strict);
const saveMemoryBody = Type.Object({ command_id: uuid, expected_session_revision: rev,
  content_sha256: Type.String({ pattern: '^[0-9a-f]{64}$' }),
  project_id: Type.Union([uuid, Type.Null()]), ...memoryFields,
  memory_type: Type.Optional(memoryType), memory_key: Type.Optional(Type.Union([Type.String({ maxLength: 80 }), Type.Null()])),
  importance: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 })),
  verification: Type.Optional(memoryVerification) }, strict);
const createDecisionBody = Type.Object({ command_id: uuid,
  project_id: Type.Union([uuid, Type.Null()]), title: text, choice: text, rationale: text,
  alternatives: Type.Array(text), costs: Type.Array(text) }, strict);
const supersedeBody = Type.Object({ command_id: uuid, expected_revision: rev,
  replacement_decision_id: uuid }, strict);
// rule_key 不在此表：CreateRule 允许缺省（服务端生成），AddRuleVersion 仍必须给出。
const ruleFields = { statement: text,
  strength: Type.Union([Type.Literal('HARD'), Type.Literal('PREFERENCE')]),
  applicability: Type.Literal('AI_RUN'),
  enforcement: Type.Union([Type.Literal('PRE_ACTION'), Type.Literal('POST_CHECK'),
    Type.Literal('SEMANTIC'), Type.Literal('HUMAN')]),
  method: Type.Optional(Type.Union([Type.Literal('HUMAN'), Type.Literal('MARKDOWN_STRUCTURE'),
    Type.Literal('CITATION_EXISTS'), Type.Literal('SEMANTIC'), Type.Null()])),
  target_spec: Type.Optional(Type.Object({}, { additionalProperties: true })),
};
// 规则键可由服务端生成：普通入口只让用户陈述规则（工作台 §42.3）。旧客户端仍可显式提交。
const createRuleBody = Type.Object({ command_id: uuid,
  scope: Type.Union([Type.Literal('WORKSPACE'), Type.Literal('PROJECT'), Type.Literal('TASK')]),
  scope_id: uuid, rule_key: Type.Optional(text), ...ruleFields }, strict);
const versionRuleBody = Type.Object({ command_id: uuid, expected_revision: rev,
  rule_key: text, ...ruleFields }, strict);
const retireBody = Type.Object({ command_id: uuid, expected_revision: rev }, strict);
const searchQuery = Type.Object({ q: Type.String({ minLength: 1, maxLength: 200 }),
  project_id: Type.Optional(uuid), types: Type.Optional(Type.String()),
  limit: Type.Optional(Type.String({ pattern: '^(?:[1-9]|[1-4][0-9]|50)$' })),
  cursor: Type.Optional(Type.String()) }, strict);

function parsedSource(body: { source_kind: KnowledgeSource['sourceKind']; text?: string;
  media_type?: string; artifact_version_id?: string }): KnowledgeSource {
  if (body.source_kind === 'ARTIFACT_VERSION') {
    if (!body.artifact_version_id || body.text !== undefined || body.media_type !== undefined) {
      throw validationFailed([{ field: 'artifact_version_id', message: 'artifact reference required without text' }]);
    }
    return { sourceKind: body.source_kind, artifactVersionId: body.artifact_version_id };
  }
  if (body.text === undefined || body.artifact_version_id !== undefined) {
    throw validationFailed([{ field: 'text', message: 'text required without artifact_version_id' }]);
  }
  return { sourceKind: body.source_kind, text: body.text,
    ...(body.media_type === undefined ? {} : { mediaType: body.media_type }) };
}

export function registerInformationRoutes(app: FastifyInstance, dependencies: RouteDependencies): void {
  const settingsBody = Type.Object({ command_id: uuid, expected_revision: rev,
    recall_enabled: Type.Boolean(), automatic_compaction: Type.Boolean(),
    // 0125 新增：缺省视为 true，旧客户端（只发两个开关）不会被 422 打断。
    auto_capture: Type.Optional(Type.Boolean()),
    // 0162：缺省 = 保持已保存的阈值（旧客户端不会把它清空）；null = 恢复默认 350K。
    // 具体区间由应用层校验并给出可执行说明，schema 只保证它是整数或 null。
    compaction_threshold_tokens: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
    // 0164：预算/模式/整理开关。缺省保持当前值，旧客户端不会重置。
    core_token_budget: Type.Optional(Type.Integer({ minimum: 0, maximum: 20000 })),
    retrieval_token_budget: Type.Optional(Type.Integer({ minimum: 0, maximum: 50000 })),
    retrieval_top_k: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
    retrieval_mode: Type.Optional(Type.Union([Type.Literal('LITERAL'), Type.Literal('HYBRID')])),
    auto_consolidate: Type.Optional(Type.Boolean()),
    consolidation_interval_hours: Type.Optional(Type.Integer({ minimum: 1, maximum: 720 })),
    memory_stale_after_days: Type.Optional(Type.Integer({ minimum: 7, maximum: 3650 })),
    embedding_provider: Type.Optional(Type.Union([Type.Literal('disabled'),
      Type.Literal('openai-compatible')])),
    remote_embedding_allowed: Type.Optional(Type.Boolean()),
    include_stale_in_recall: Type.Optional(Type.Boolean()) }, strict);
  const settingsResponse = Type.Object({ workspace_id: uuid, revision: rev,
    recall_enabled: Type.Boolean(), automatic_compaction: Type.Boolean(),
    auto_capture: Type.Boolean(),
    compaction_threshold_tokens: Type.Union([Type.Integer(), Type.Null()]),
    core_token_budget: Type.Integer(), retrieval_token_budget: Type.Integer(),
    retrieval_top_k: Type.Integer(),
    retrieval_mode: Type.Union([Type.Literal('LITERAL'), Type.Literal('HYBRID')]),
    auto_consolidate: Type.Boolean(), consolidation_interval_hours: Type.Integer(),
    memory_stale_after_days: Type.Integer(),
    embedding_provider: Type.Union([Type.Literal('disabled'), Type.Literal('openai-compatible')]),
    remote_embedding_allowed: Type.Boolean(), include_stale_in_recall: Type.Boolean(),
    capabilities: Type.Optional(Type.Record(Type.String(), Type.Unknown())) }, strict);
  app.get('/memories/:id/provenance', { schema: { params: item } }, async (request, reply) => {
    try {
      const p = request.params as { workspace_id: string; id: string };
      const memory = await readInformation(dependencies.database.executor, 'memory',
        p.workspace_id, p.id);
      const sources = await createRepositories(dependencies.database.executor).information
        .readMemorySourceEvidence(p.id);
      return { memory_id: p.id, origin: memory.origin, source_kind: memory.source_kind,
        verification: memory.verification, verified_at: memory.verified_at,
        sources: sources.map((source) => {
          const withdrawn = source.withdrawn_at !== null;
          const content = source.content;
          const hashMatches = content === null ? null
            : createHash('sha256').update(content, 'utf8').digest('hex') === source.content_sha256;
          const availability = withdrawn ? 'WITHDRAWN' : source.role === null ? 'MISSING'
            : content === null ? 'UNAVAILABLE'
              : hashMatches === false ? 'CONTENT_CHANGED' : 'AVAILABLE';
          return { memory_version: source.memory_version.toString(),
            session_id: source.session_id, message_id: source.message_id,
            session_title: source.session_title, role: source.role, status: source.status,
            content_sha256: source.content_sha256, sha256_matches: hashMatches,
            source_quote: source.source_quote,
            excerpt: content === null ? null : content.slice(0, 500),
            availability };
        }) };
    } catch (error) { return sendReadError(reply, error, request.id); }
  });
  app.get('/memory-settings', { schema: { params: base } }, async (request, reply) => {
    try { return await readMemorySettings(dependencies.database.executor,
      (request.params as { workspace_id: string }).workspace_id); }
    catch (error) { return sendReadError(reply, error, request.id); }
  });
  app.post('/memory-settings', { schema: { params: base, body: settingsBody,
    response: { 200: commandEnvelopeSchema(settingsResponse) } } },
  createCommandHandler(dependencies, {
    commandType: 'SetMemorySettings', bodySchema: settingsBody, execute: async ({ executor, params, body }) => {
      const outcome = await setMemorySettings(executor, { workspaceId: params.workspace_id ?? '',
        commandId: body.command_id, expectedRevision: body.expected_revision,
        recallEnabled: body.recall_enabled, automaticCompaction: body.automatic_compaction,
        autoCapture: body.auto_capture ?? true,
        ...(body.compaction_threshold_tokens === undefined ? {}
          : { compactionThresholdTokens: body.compaction_threshold_tokens }),
        ...(body.core_token_budget === undefined ? {} : { coreTokenBudget: body.core_token_budget }),
        ...(body.retrieval_token_budget === undefined ? {}
          : { retrievalTokenBudget: body.retrieval_token_budget }),
        ...(body.retrieval_top_k === undefined ? {} : { retrievalTopK: body.retrieval_top_k }),
        ...(body.retrieval_mode === undefined ? {} : { retrievalMode: body.retrieval_mode }),
        ...(body.auto_consolidate === undefined ? {} : { autoConsolidate: body.auto_consolidate }),
        ...(body.consolidation_interval_hours === undefined ? {}
          : { consolidationIntervalHours: body.consolidation_interval_hours }),
        ...(body.memory_stale_after_days === undefined ? {}
          : { memoryStaleAfterDays: body.memory_stale_after_days }),
        ...(body.embedding_provider === undefined ? {} : { embeddingProvider: body.embedding_provider }),
        ...(body.remote_embedding_allowed === undefined ? {}
          : { remoteEmbeddingAllowed: body.remote_embedding_allowed }),
        ...(body.include_stale_in_recall === undefined ? {}
          : { includeStaleInRecall: body.include_stale_in_recall }) });
      return { outcome, result: outcome.result };
    } }));
  const saveMemoryBody = Type.Object({ command_id: uuid, expected_session_revision: rev,
    content_sha256: Type.String({ pattern: '^[0-9a-f]{64}$' }),
    project_id: Type.Union([uuid, Type.Null()]), ...memoryFields,
    memory_type: Type.Optional(memoryType),
    memory_key: Type.Optional(Type.Union([Type.String({ maxLength: 80 }), Type.Null()])),
    importance: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 })),
    verification: Type.Optional(memoryVerification) }, strict);
  app.post('/assist-sessions/:session_id/messages/:message_id/memories', {
    schema: { params: Type.Object({ workspace_id: uuid, session_id: uuid, message_id: uuid }, strict),
      body: saveMemoryBody, response: { 201: commandEnvelopeSchema(commandResult) } },
  }, createCommandHandler(dependencies, { commandType: 'CreateMemoryFromMessage', bodySchema: saveMemoryBody,
    execute: async ({ executor, params, body }) => {
      const outcome = await createMemoryFromMessage(executor, { workspaceId: params.workspace_id ?? '',
        sessionId: params.session_id ?? '', messageId: params.message_id ?? '', commandId: body.command_id,
        expectedSessionRevision: body.expected_session_revision, expectedContentSha256: body.content_sha256,
        projectId: body.project_id, title: body.title, text: body.text, confirmed: body.confirmed,
        ...(body.memory_type === undefined ? {} : { memoryType: body.memory_type }),
        ...(body.memory_key === undefined ? {} : { memoryKey: body.memory_key }),
        ...(body.importance === undefined ? {} : { importance: body.importance }),
        ...(body.verification === undefined ? {} : { verification: body.verification }),
        ...(body.expires_at === undefined ? {} : { expiresAt: body.expires_at }) }, dependencies.storage);
      return { outcome, result: outcome.result };
    } }));
  app.get('/knowledge/:id/versions/:version/content', {
    schema: { params: knowledgeContentParams, response: { 200: knowledgeContent } },
  }, async (request, reply) => {
    try {
      const p = request.params as { workspace_id: string; id: string; version: string };
      reply.header('Cache-Control', 'no-store');
      return await readKnowledgeVersionContent(dependencies.database.executor, dependencies.storage,
        p.workspace_id, p.id, p.version);
    } catch (error) { return sendReadError(reply, error, request.id); }
  });
  for (const [path, kind] of [['knowledge', 'knowledge'], ['memories', 'memory'],
    ['decisions', 'decision'], ['rules', 'rule']] as const) {
    app.get(`/${path}`, { schema: { params: base,
      querystring: kind === 'memory' ? memoryListQuery : listQuery } }, async (request, reply) => {
      try {
        const p = request.params as { workspace_id: string };
        const q = request.query as { project_id?: string;
          effective_status?: 'ALL' | 'ACTIVE' | 'EXPIRED' | 'RETIRED' | 'SUPERSEDED' | 'STALE';
          memory_type?: string; origin?: string; q?: string; limit?: string };
        return await listInformation(dependencies.database.executor, kind, p.workspace_id, q.project_id,
          q.effective_status ?? 'ALL', kind === 'memory' ? {
            ...(q.memory_type === undefined ? {} : { memoryType: q.memory_type }),
            ...(q.origin === undefined ? {} : { origin: q.origin }),
            ...(q.q === undefined ? {} : { query: q.q }),
            ...(q.limit === undefined ? {} : { limit: Number(q.limit) }),
          } : {});
      } catch (error) { return sendReadError(reply, error, request.id); }
    });
    app.get(`/${path}/:id`, { schema: { params: item } }, async (request, reply) => {
      try {
        const p = request.params as { workspace_id: string; id: string };
        return await readInformation(dependencies.database.executor, kind, p.workspace_id, p.id);
      } catch (error) { return sendReadError(reply, error, request.id); }
    });
    const versions = kind === 'memory' ? 'revisions' : 'versions';
    app.get(`/${path}/:id/${versions}`, { schema: { params: item } }, async (request, reply) => {
      try {
        const p = request.params as { workspace_id: string; id: string };
        return await listInformationVersions(dependencies.database.executor, kind, p.workspace_id, p.id);
      } catch (error) { return sendReadError(reply, error, request.id); }
    });
  }

  /*
   * 0167：管理页列表走真实游标分页。`/memories` 保留旧数组契约给现有调用方，
   * 新页面用 `/memory/items`，一次只取一页，不再把 200 条当全量。
   */
  app.get('/memory/items', { schema: { params: base, querystring: memoryListQuery } },
    async (request, reply) => {
      try {
        const p = request.params as { workspace_id: string };
        const q = request.query as {
          project_id?: string; effective_status?: 'ALL' | 'ACTIVE' | 'EXPIRED' | 'RETIRED'
            | 'SUPERSEDED' | 'STALE'; memory_type?: string; origin?: string;
          verification?: string; source_kind?: string; pinned?: 'true' | 'false'; sort?: string;
          cursor?: string; q?: string; limit?: string };
        return await listMemoryPage(dependencies.database.executor, p.workspace_id, q.project_id, {
          ...(q.effective_status === undefined ? {} : { effectiveStatus: q.effective_status }),
          ...(q.memory_type === undefined ? {} : { memoryType: q.memory_type }),
          ...(q.origin === undefined ? {} : { origin: q.origin }),
          ...(q.verification === undefined ? {} : { verification: q.verification }),
          ...(q.source_kind === undefined ? {} : { sourceKind: q.source_kind }),
          ...(q.pinned === undefined ? {} : { pinned: q.pinned === 'true' }),
          ...(q.sort === undefined ? {} : { sort: q.sort as 'updated' | 'created' | 'importance' }),
          ...(q.cursor === undefined ? {} : { cursor: q.cursor }),
          ...(q.q === undefined ? {} : { query: q.q }),
          ...(q.limit === undefined ? {} : { pageSize: Number(q.limit) }),
        });
      } catch (error) { return sendReadError(reply, error, request.id); }
    });

  app.post('/knowledge', { schema: { params: base, body: createKnowledgeBody,
    response: { 201: commandEnvelopeSchema(commandResult) } } },
  createCommandHandler(dependencies, { commandType: 'CreateKnowledge', bodySchema: createKnowledgeBody,
    execute: async ({ executor, params, body }) => {
      const outcome = await createKnowledge(executor, { workspaceId: params.workspace_id ?? '',
        commandId: body.command_id, projectId: body.project_id, title: body.title,
        source: parsedSource(body) });
      return { outcome, result: outcome.result };
    } }));
  app.post('/knowledge/:id/versions', { schema: { params: item, body: versionKnowledgeBody,
    response: { 200: commandEnvelopeSchema(commandResult) } } },
  createCommandHandler(dependencies, { commandType: 'AddKnowledgeVersion', bodySchema: versionKnowledgeBody,
    execute: async ({ executor, params, body }) => {
      const outcome = await addKnowledgeVersion(executor, { workspaceId: params.workspace_id ?? '',
        knowledgeId: params.id ?? '', commandId: body.command_id,
        expectedRevision: body.expected_revision, source: parsedSource(body) });
      return { outcome, result: outcome.result };
    } }));
  app.post('/knowledge/:id/archive', { schema: { params: item, body: retireBody,
    response: { 200: commandEnvelopeSchema(commandResult) } } },
  createCommandHandler(dependencies, { commandType: 'ArchiveKnowledge', bodySchema: retireBody,
    execute: async ({ executor, params, body }) => {
      const outcome = await retireInformation(executor, { kind: 'knowledge', id: params.id ?? '',
        workspaceId: params.workspace_id ?? '', commandId: body.command_id,
        expectedRevision: body.expected_revision });
      return { outcome, result: outcome.result };
    } }));

  app.post('/memories', { schema: { params: base, body: createMemoryBody,
    response: { 201: commandEnvelopeSchema(commandResult) } } },
  createCommandHandler(dependencies, { commandType: 'CreateMemory', bodySchema: createMemoryBody,
    execute: async ({ executor, params, body }) => {
      const outcome = await createMemory(executor, { workspaceId: params.workspace_id ?? '',
        commandId: body.command_id, projectId: body.project_id, title: body.title,
        text: body.text, confirmed: body.confirmed,
        ...(body.memory_type === undefined ? {} : { memoryType: body.memory_type }),
        ...(body.memory_key === undefined ? {} : { memoryKey: body.memory_key }),
        ...(body.importance === undefined ? {} : { importance: body.importance }),
        ...(body.pinned === undefined ? {} : { pinned: body.pinned }),
        ...(body.task_id === undefined ? {} : { taskId: body.task_id }),
        ...(body.verification === undefined ? {} : { verification: body.verification }),
        ...(body.expires_at === undefined ? {} : { expiresAt: body.expires_at }) });
      return { outcome, result: outcome.result };
    } }));
  app.post('/memories/:id/revisions', { schema: { params: item, body: versionMemoryBody,
    response: { 200: commandEnvelopeSchema(commandResult) } } },
  createCommandHandler(dependencies, { commandType: 'AddMemoryRevision', bodySchema: versionMemoryBody,
    execute: async ({ executor, params, body }) => {
      const outcome = await addMemoryRevision(executor, { workspaceId: params.workspace_id ?? '',
        memoryId: params.id ?? '', commandId: body.command_id,
        expectedRevision: body.expected_revision, title: body.title,
        text: body.text, confirmed: body.confirmed,
        ...(body.memory_type === undefined ? {} : { memoryType: body.memory_type }),
        ...(body.memory_key === undefined ? {} : { memoryKey: body.memory_key }),
        ...(body.importance === undefined ? {} : { importance: body.importance }),
        ...(body.verification === undefined ? {} : { verification: body.verification }),
        ...(body.expires_at === undefined ? {} : { expiresAt: body.expires_at }) });
      return { outcome, result: outcome.result };
    } }));
  app.post('/memories/:id/retire', { schema: { params: item, body: retireBody,
    response: { 200: commandEnvelopeSchema(commandResult) } } },
  createCommandHandler(dependencies, { commandType: 'RetireMemory', bodySchema: retireBody,
    execute: async ({ executor, params, body }) => {
      const outcome = await retireInformation(executor, { kind: 'memory', id: params.id ?? '',
        workspaceId: params.workspace_id ?? '', commandId: body.command_id,
        expectedRevision: body.expected_revision });
      return { outcome, result: outcome.result };
    } }));

  // 0164：固定/验证/统计/整理/导入导出/清理。读路由只返回真实聚合，不返回演示数据。
  const pinBody = Type.Object({ command_id: uuid, expected_revision: rev,
    pinned: Type.Boolean() }, strict);
  app.post('/memories/:id/pin', { schema: { params: item, body: pinBody,
    response: { 200: commandEnvelopeSchema(Type.Object({}, { additionalProperties: true })) } } },
  createCommandHandler(dependencies, { commandType: 'SetMemoryPinned', bodySchema: pinBody,
    execute: async ({ executor, params, body }) => {
      const outcome = await setMemoryPinnedCommand(executor, {
        workspaceId: params.workspace_id ?? '', memoryId: params.id ?? '',
        pinned: body.pinned, commandId: body.command_id,
        expectedRevision: body.expected_revision });
      return { outcome, result: outcome.result };
    } }));

  const verifyBody = Type.Object({ command_id: uuid, expected_revision: rev,
    verification: memoryVerification, clear_stale: Type.Optional(Type.Boolean()) }, strict);
  app.post('/memories/:id/verification', { schema: { params: item, body: verifyBody,
    response: { 200: commandEnvelopeSchema(Type.Object({}, { additionalProperties: true })) } } },
  createCommandHandler(dependencies, { commandType: 'SetMemoryVerification', bodySchema: verifyBody,
    execute: async ({ executor, params, body }) => {
      const outcome = await setMemoryVerificationCommand(executor, {
        workspaceId: params.workspace_id ?? '', memoryId: params.id ?? '',
        verification: body.verification, clearStale: body.clear_stale ?? false,
        commandId: body.command_id, expectedRevision: body.expected_revision });
      return { outcome, result: outcome.result };
    } }));

  const expiryBody = Type.Object({ command_id: uuid, expected_revision: rev,
    expires_at: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]) }, strict);
  app.post('/memories/:id/expiry', { schema: { params: item, body: expiryBody,
    response: { 200: commandEnvelopeSchema(Type.Object({}, { additionalProperties: true })) } } },
  createCommandHandler(dependencies, { commandType: 'SetMemoryExpiry', bodySchema: expiryBody,
    execute: async ({ executor, params, body }) => {
      const outcome = await setMemoryExpiryCommand(executor, {
        workspaceId: params.workspace_id ?? '', memoryId: params.id ?? '',
        expiresAt: body.expires_at, commandId: body.command_id,
        expectedRevision: body.expected_revision });
      return { outcome, result: outcome.result };
    } }));

  app.get('/memory/stats', { schema: { params: base, querystring: listQuery } },
  async (request, reply) => {
    try {
      const p = request.params as { workspace_id: string };
      const q = request.query as { project_id?: string };
      return await readMemoryObservability(dependencies.database.executor, p.workspace_id,
        q.project_id ?? null);
    } catch (error) { return sendReadError(reply, error, request.id); }
  });

  app.get('/memory/maintenance/runs', { schema: { params: base } }, async (request, reply) => {
    try {
      const p = request.params as { workspace_id: string };
      const rows = await createRepositories(dependencies.database.executor).information
        .listMemoryMaintenanceRuns(p.workspace_id, 20);
      return rows.map((row) => ({ id: row.id, trigger: row.trigger, status: row.status,
        stats: row.stats, error: row.error,
        started_at: row.started_at.toISOString(),
        finished_at: row.finished_at?.toISOString() ?? null }));
    } catch (error) { return sendReadError(reply, error, request.id); }
  });

  /*
   * 0167：自动捕获任务可观察、可重试、可取消。
   * 状态语义固定：PENDING/RUNNING 未落定；SUCCEEDED 已写入；EMPTY 无可提取内容；
   * FAILED 重试耗尽；CANCELLED 关闭/日限/用户取消。它们不再混成同一个 0。
   */
  const captureTasksQuery = Type.Object({ session_id: Type.Optional(uuid),
    status: Type.Optional(Type.Union([Type.Literal('ALL'), Type.Literal('PENDING'),
      Type.Literal('RUNNING'), Type.Literal('SUCCEEDED'), Type.Literal('EMPTY'),
      Type.Literal('FAILED'), Type.Literal('CANCELLED')])),
    limit: Type.Optional(Type.String({ pattern: '^(?:[1-9]|[1-9][0-9]|100)$' })) }, strict);
  const captureTaskDto = (row: {
    id: string; kind: string; status: string; attempts: number; max_attempts: number;
    session_id: string; trigger_message_id: string; user_message_id: string | null;
    project_id: string | null; error_kind: string | null; last_error: string | null;
    result: Record<string, unknown>; next_attempt_at: Date; lease_until: Date | null;
    completed_at: Date | null; created_at: Date; updated_at: Date;
  }) => ({ id: row.id, kind: row.kind, status: row.status, attempts: row.attempts,
    max_attempts: row.max_attempts, session_id: row.session_id,
    trigger_message_id: row.trigger_message_id, user_message_id: row.user_message_id,
    project_id: row.project_id, error_kind: row.error_kind, last_error: row.last_error,
    result: row.result, next_attempt_at: row.next_attempt_at.toISOString(),
    lease_until: row.lease_until?.toISOString() ?? null,
    completed_at: row.completed_at?.toISOString() ?? null,
    created_at: row.created_at.toISOString(), updated_at: row.updated_at.toISOString() });
  app.get('/memory/capture-tasks', { schema: { params: base, querystring: captureTasksQuery } },
    async (request, reply) => {
      try {
        const p = request.params as { workspace_id: string };
        const q = request.query as { session_id?: string; status?: string; limit?: string };
        const rows = await createRepositories(dependencies.database.executor).information
          .listMemoryCaptureTasks(p.workspace_id, {
            ...(q.session_id === undefined ? {} : { sessionId: q.session_id }),
            ...(q.status === undefined ? {} : { status: q.status }),
            ...(q.limit === undefined ? {} : { limit: Number(q.limit) }),
          });
        return { items: rows.map(captureTaskDto) };
      } catch (error) { return sendReadError(reply, error, request.id); }
    });

  const captureActionBody = Type.Object({ command_id: uuid }, strict);
  for (const action of ['retry', 'cancel'] as const) {
    app.post(`/memory/capture-tasks/:id/${action}`, { schema: { params: item,
      body: captureActionBody, response: { 200: commandEnvelopeSchema(
        Type.Object({}, { additionalProperties: true })) } } },
    async (request, reply) => {
      try {
        const p = request.params as { workspace_id: string; id: string };
        const executed = action === 'retry'
          ? await createRepositories(dependencies.database.executor).information
            .retryMemoryCaptureTask(p.id, p.workspace_id)
          : await createRepositories(dependencies.database.executor).information
            .cancelMemoryCaptureTask(p.id, p.workspace_id);
        const commandId = (request.body as { command_id: string }).command_id;
        if (!executed) {
          // 200 + 明确冲突：调用方按 executed 判断是否生效，不把未执行说成成功。
          return { command_id: commandId, committed_at: new Date().toISOString(),
            result: { executed: 'false', status: 'CONFLICT' },
            links: { resource: `/memory/capture-tasks/${p.id}` } };
        }
        return { command_id: commandId, committed_at: new Date().toISOString(),
          result: { executed: 'true', status: action === 'retry' ? 'PENDING' : 'CANCELLED' },
          links: { resource: `/memory/capture-tasks/${p.id}` } };
      } catch (error) { return sendReadError(reply, error, request.id); }
    });
  }

  const consolidateBody = Type.Object({ command_id: uuid }, strict);
  app.post('/memory/maintenance/consolidate', { schema: { params: base, body: consolidateBody,
    response: { 200: commandEnvelopeSchema(Type.Object({}, { additionalProperties: true })) } } },
  createCommandHandler(dependencies, { commandType: 'ConsolidateMemories',
    bodySchema: consolidateBody, execute: async ({ executor, params, body }) => {
      const outcome = await consolidateMemoriesCommand(executor, {
        workspaceId: params.workspace_id ?? '', commandId: body.command_id });
      return { outcome, result: outcome.result };
    } }));

  app.get('/memory/export', { schema: { params: base, querystring: listQuery } },
  async (request, reply) => {
    try {
      const p = request.params as { workspace_id: string };
      const q = request.query as { project_id?: string };
      reply.header('Content-Disposition', 'attachment; filename="relay-memories.json"');
      return await exportMemories(dependencies.database.executor, p.workspace_id,
        q.project_id ?? null);
    } catch (error) { return sendReadError(reply, error, request.id); }
  });

  const importBody = Type.Object({ command_id: uuid,
    project_id: Type.Union([uuid, Type.Null()]),
    payload: Type.Object({}, { additionalProperties: true }) }, strict);
  app.post('/memory/import', { schema: { params: base, body: importBody,
    response: { 200: commandEnvelopeSchema(Type.Object({}, { additionalProperties: true })) } } },
  createCommandHandler(dependencies, { commandType: 'ImportMemories', bodySchema: importBody,
    execute: async ({ executor, params, body }) => {
      const outcome = await importMemories(executor, { workspaceId: params.workspace_id ?? '',
        commandId: body.command_id, expectedPayload: body.payload,
        projectId: body.project_id });
      return { outcome, result: outcome.result };
    } }));

  const purgeBody = Type.Object({ command_id: uuid,
    project_id: Type.Optional(Type.Union([uuid, Type.Null()])),
    memory_type: Type.Optional(Type.Union([memoryType, Type.Literal('ALL')])),
    origin: Type.Optional(Type.Union([Type.Literal('ALL'), Type.Literal('HUMAN_CONFIRMED'),
      Type.Literal('AUTO_CAPTURE')])),
    memory_ids: Type.Optional(Type.Array(uuid, { maxItems: 200 })),
    include_active: Type.Boolean(), confirmation: Type.Literal('DELETE_MEMORIES') }, strict);
  app.post('/memory/purge', { schema: { params: base, body: purgeBody,
    response: { 200: commandEnvelopeSchema(Type.Object({}, { additionalProperties: true })) } } },
  createCommandHandler(dependencies, { commandType: 'PurgeMemories', bodySchema: purgeBody,
    execute: async ({ executor, params, body }) => {
      const outcome = await purgeMemories(executor, { workspaceId: params.workspace_id ?? '',
        commandId: body.command_id, projectId: body.project_id ?? null,
        ...(body.memory_type === undefined ? {} : { memoryType: body.memory_type }),
        ...(body.origin === undefined ? {} : { origin: body.origin }),
        ...(body.memory_ids === undefined ? {} : { memoryIds: body.memory_ids }),
        includeActive: body.include_active, confirmation: body.confirmation });
      return { outcome, result: outcome.result };
    } }));

  app.post('/decisions', { schema: { params: base, body: createDecisionBody,
    response: { 201: commandEnvelopeSchema(commandResult) } } },
  createCommandHandler(dependencies, { commandType: 'CreateDecision', bodySchema: createDecisionBody,
    execute: async ({ executor, params, body }) => {
      const outcome = await createDecision(executor, { workspaceId: params.workspace_id ?? '',
        commandId: body.command_id, projectId: body.project_id, title: body.title,
        choice: body.choice, rationale: body.rationale,
        alternatives: body.alternatives, costs: body.costs });
      return { outcome, result: outcome.result };
    } }));
  app.post('/decisions/:id/supersessions', { schema: { params: item, body: supersedeBody,
    response: { 200: commandEnvelopeSchema(commandResult) } } },
  createCommandHandler(dependencies, { commandType: 'SupersedeDecision', bodySchema: supersedeBody,
    execute: async ({ executor, params, body }) => {
      const outcome = await supersedeDecision(executor, { workspaceId: params.workspace_id ?? '',
        decisionId: params.id ?? '', commandId: body.command_id,
        expectedRevision: body.expected_revision,
        replacementDecisionId: body.replacement_decision_id });
      return { outcome, result: outcome.result };
    } }));

  app.post('/rules', { schema: { params: base, body: createRuleBody,
    response: { 201: commandEnvelopeSchema(commandResult) } } },
  createCommandHandler(dependencies, { commandType: 'CreateRule', bodySchema: createRuleBody,
    execute: async ({ executor, params, body }) => {
      const outcome = await createRule(executor, { workspaceId: params.workspace_id ?? '',
        commandId: body.command_id, scope: body.scope, scopeId: body.scope_id,
        ...(body.rule_key === undefined ? {} : { ruleKey: body.rule_key }),
        statement: body.statement, strength: body.strength,
        applicability: body.applicability, enforcement: body.enforcement,
        ...(body.method === undefined ? {} : { method: body.method }),
        ...(body.target_spec === undefined ? {} : { targetSpec: body.target_spec }) });
      return { outcome, result: outcome.result };
    } }));
  app.post('/rules/:id/versions', { schema: { params: item, body: versionRuleBody,
    response: { 200: commandEnvelopeSchema(commandResult) } } },
  createCommandHandler(dependencies, { commandType: 'AddRuleVersion', bodySchema: versionRuleBody,
    execute: async ({ executor, params, body }) => {
      const outcome = await addRuleVersion(executor, { workspaceId: params.workspace_id ?? '',
        ruleId: params.id ?? '', commandId: body.command_id,
        expectedRevision: body.expected_revision, ruleKey: body.rule_key,
        statement: body.statement, strength: body.strength,
        applicability: body.applicability, enforcement: body.enforcement,
        ...(body.method === undefined ? {} : { method: body.method }),
        ...(body.target_spec === undefined ? {} : { targetSpec: body.target_spec }) });
      return { outcome, result: outcome.result };
    } }));
  app.post('/rules/:id/retire', { schema: { params: item, body: retireBody,
    response: { 200: commandEnvelopeSchema(commandResult) } } },
  createCommandHandler(dependencies, { commandType: 'RetireRule', bodySchema: retireBody,
    execute: async ({ executor, params, body }) => {
      const outcome = await retireInformation(executor, { kind: 'rule', id: params.id ?? '',
        workspaceId: params.workspace_id ?? '', commandId: body.command_id,
        expectedRevision: body.expected_revision });
      return { outcome, result: outcome.result };
    } }));

  for (const route of [
    { kind: 'knowledge', path: '/knowledge/:id/unarchive', command: 'UnarchiveKnowledge' },
    { kind: 'memory', path: '/memories/:id/reactivate', command: 'ReactivateMemory' },
    { kind: 'rule', path: '/rules/:id/reactivate', command: 'ReactivateRule' },
  ] as const) {
    app.post(route.path, { schema: { params: item, body: retireBody,
      response: { 200: commandEnvelopeSchema(commandResult) } } },
    createCommandHandler(dependencies, { commandType: route.command, bodySchema: retireBody,
      execute: async ({ executor, params, body }) => {
        const outcome = await restoreInformation(executor, { kind: route.kind, id: params.id ?? '',
          workspaceId: params.workspace_id ?? '', commandId: body.command_id,
          expectedRevision: body.expected_revision });
        return { outcome, result: outcome.result };
      } }));
  }

  app.get('/search', { schema: { params: base, querystring: searchQuery } }, async (request, reply) => {
    try {
      const p = request.params as { workspace_id: string };
      const q = request.query as { q: string; project_id?: string; types?: string;
        limit?: string; cursor?: string };
      return await searchInformation(dependencies.database.executor, {
        workspaceId: p.workspace_id, query: q.q,
        ...(q.project_id === undefined ? {} : { projectId: q.project_id }),
        ...(q.types === undefined ? {} : { types: q.types }),
        ...(q.limit === undefined ? {} : { limit: Number(q.limit) }),
        ...(q.cursor === undefined ? {} : { cursor: q.cursor }),
      });
    } catch (error) { return sendReadError(reply, error, request.id); }
  });
}
