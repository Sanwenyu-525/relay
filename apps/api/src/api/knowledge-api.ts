import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';

import { createKnowledgeCollection, createKnowledgeRelation, createKnowledgeTag,
  commitKnowledgeImport, deleteKnowledgeCollection, deleteKnowledgeRelation, deleteKnowledgeTag,
  previewKnowledgeImport, renameKnowledgeTag, setKnowledgeCollections, setKnowledgeTags,
  updateKnowledgeCollection } from '../application/knowledge-commands.js';
import { backfillKnowledgeIndex, listKnowledgeCollections, listKnowledgePage,
  listKnowledgeTags, readKnowledgeHealth, readKnowledgeOrganization, readKnowledgeOverview }
  from '../application/knowledge-queries.js';
import { createCommandHandler, sendReadError, type RouteDependencies } from './envelope.js';
import { commandEnvelopeSchema } from './domain-schemas.js';

/**
 * 知识库组织与检索 API（0167）。
 *
 * 读取端点只返回数据库事实；写入端点全部走 `createCommandHandler`（幂等回执 + Problem Details）。
 * 预览端点不写库，提交端点重新提取并校验，客户端正文从不被直接信任。
 */

const strict = { additionalProperties: false } as const;
const uuid = Type.String({ format: 'uuid' });
const rev = Type.String({ pattern: '^(0|[1-9][0-9]*)$' });
const base = Type.Object({ workspace_id: uuid }, strict);
const item = Type.Object({ workspace_id: uuid, id: uuid }, strict);

const listQuery = Type.Object({
  project_id: Type.Optional(uuid),
  scope: Type.Optional(Type.Union([Type.Literal('ALL'), Type.Literal('WORKSPACE'),
    Type.Literal('PROJECT')])),
  status: Type.Optional(Type.Union([Type.Literal('ACTIVE'), Type.Literal('ARCHIVED'),
    Type.Literal('ALL')])),
  q: Type.Optional(Type.String({ maxLength: 200 })),
  collection_id: Type.Optional(uuid),
  tag_id: Type.Optional(uuid),
  sort: Type.Optional(Type.Union([Type.Literal('UPDATED_DESC'), Type.Literal('CREATED_DESC'),
    Type.Literal('TITLE_ASC')])),
  limit: Type.Optional(Type.String({ pattern: '^(?:[1-9]|[1-5][0-9]|50)$' })),
  cursor: Type.Optional(Type.String({ maxLength: 1000 })),
}, strict);

const collectionRef = Type.Object({ id: uuid, name: Type.String() }, strict);
const listItem = Type.Object({
  id: uuid, title: Type.String(), project_id: Type.Union([uuid, Type.Null()]),
  status: Type.String(), revision: rev, current_version: rev,
  summary: Type.Union([Type.String(), Type.Null()]),
  source_kind: Type.String(), media_type: Type.String(), availability: Type.String(),
  source_uri: Type.Union([Type.String(), Type.Null()]),
  tags: Type.Array(Type.String(), { maxItems: 64 }),
  collections: Type.Array(collectionRef, { maxItems: 64 }),
  matched_fields: Type.Array(Type.String(), { maxItems: 4 }),
  snippet: Type.Union([Type.String(), Type.Null()]),
  created_at: Type.String(), updated_at: Type.String(),
}, strict);
const listResponse = Type.Object({ items: Type.Array(listItem, { maxItems: 50 }),
  next_cursor: Type.Union([Type.String(), Type.Null()]) }, strict);

const overviewResponse = Type.Object({
  knowledge_total: Type.Integer(), decision_total: Type.Integer(), rule_total: Type.Integer(),
  recent_new: Type.Integer(), recent_updated: Type.Integer(), unavailable: Type.Integer(),
  stale: Type.Integer(), curation_pending: Type.Integer(), collection_total: Type.Integer(),
  tag_total: Type.Integer(), unorganized: Type.Integer(),
  latest_created_at: Type.Union([Type.String(), Type.Null()]),
  latest_updated_at: Type.Union([Type.String(), Type.Null()]),
}, strict);

const tagRef = Type.Object({ id: uuid, name: Type.String() }, strict);
const collectionDetail = Type.Object({ id: uuid, name: Type.String(),
  description: Type.Union([Type.String(), Type.Null()]) }, strict);
const relationView = Type.Object({ id: uuid, direction: Type.String(), kind: Type.String(),
  other_id: uuid, other_title: Type.String(), other_status: Type.String(),
  target_version: Type.Union([rev, Type.Null()]), note: Type.Union([Type.String(), Type.Null()]),
  created_at: Type.String() }, strict);
const usageView = Type.Object({ message_id: uuid, session_id: uuid, session_title: Type.String(),
  seq: Type.String(), role: Type.String(), created_at: Type.String(),
  version: Type.Union([Type.String(), Type.Null()]), status: Type.Union([Type.String(), Type.Null()]) },
  strict);
const organizationResponse = Type.Object({ tags: Type.Array(tagRef),
  collections: Type.Array(collectionDetail), relations: Type.Array(relationView),
  usage: Type.Array(usageView) }, strict);

const collectionListResponse = Type.Object({ items: Type.Array(Type.Object({
  id: uuid, project_id: Type.Union([uuid, Type.Null()]), name: Type.String(),
  description: Type.Union([Type.String(), Type.Null()]), revision: rev,
  item_count: Type.Integer(), created_at: Type.String(), updated_at: Type.String(),
}, strict)) }, strict);
const tagListResponse = Type.Object({ items: Type.Array(Type.Object({ id: uuid,
  name: Type.String(), usage_count: Type.Integer() }, strict)) }, strict);
const healthResponse = Type.Object({
  duplicates: Type.Array(Type.Object({ content_sha256: Type.String(),
    ids: Type.Array(uuid) }, strict)),
  unavailable: Type.Integer(), stale: Type.Integer(), unorganized: Type.Integer(),
  curation_pending: Type.Integer(), stale_after_days: Type.Integer(),
}, strict);

const resultSimple = Type.Record(Type.String(), Type.String());
const collectionResult = Type.Object({ collection_id: uuid, revision: rev }, strict);
const deleteResult = Type.Object({ collection_id: Type.Optional(uuid), tag_id: Type.Optional(uuid),
  relation_id: Type.Optional(uuid), status: Type.String() }, strict);
const setCollectionsResult = Type.Object({ knowledge_id: uuid,
  collection_ids: Type.Array(uuid) }, strict);
const setTagsResult = Type.Object({ knowledge_id: uuid, tags: Type.Array(tagRef) }, strict);
const tagResult = Type.Object({ tag_id: uuid, name: Type.String() }, strict);
const relationResult = Type.Object({ relation_id: uuid, from_knowledge_id: uuid,
  to_knowledge_id: uuid, relation_kind: Type.String() }, strict);
const importResult = Type.Object({ knowledge_id: uuid, revision: rev, version: rev,
  status: Type.String(), created: Type.String(), duplicate_of: Type.String() }, strict);

const createCollectionBody = Type.Object({ command_id: uuid,
  project_id: Type.Union([uuid, Type.Null()]), name: Type.String({ minLength: 1, maxLength: 120 }),
  description: Type.Optional(Type.Union([Type.String({ maxLength: 400 }), Type.Null()])) }, strict);
const updateCollectionBody = Type.Object({ command_id: uuid, expected_revision: rev,
  name: Type.String({ minLength: 1, maxLength: 120 }),
  description: Type.Optional(Type.Union([Type.String({ maxLength: 400 }), Type.Null()])) }, strict);
const commandOnlyBody = Type.Object({ command_id: uuid }, strict);
const setCollectionsBody = Type.Object({ command_id: uuid,
  collection_ids: Type.Array(uuid, { maxItems: 20 }) }, strict);
const tagName = Type.String({ minLength: 1, maxLength: 48 });
const setTagsBody = Type.Object({ command_id: uuid,
  tags: Type.Array(tagName, { maxItems: 12 }) }, strict);
const tagNameBody = Type.Object({ command_id: uuid, name: tagName }, strict);
const relationBody = Type.Object({ command_id: uuid, to_knowledge_id: uuid,
  relation_kind: Type.Union([Type.Literal('RELATES_TO'), Type.Literal('SUPERSEDES'),
    Type.Literal('DERIVED_FROM'), Type.Literal('CONSTRAINS'), Type.Literal('REFERENCES')]),
  target_version: Type.Optional(Type.Union([rev, Type.Null()])),
  note: Type.Optional(Type.Union([Type.String({ maxLength: 400 }), Type.Null()])) }, strict);

const importFile = Type.Object({ name: Type.String({ minLength: 1, maxLength: 260 }),
  media_type: Type.String({ maxLength: 120 }),
  content_base64: Type.String({ minLength: 1, maxLength: 16_000_000 }) }, strict);
const previewBody = Type.Object({ project_id: Type.Optional(Type.Union([uuid, Type.Null()])),
  files: Type.Array(importFile, { maxItems: 20 }) }, strict);
const commitBody = Type.Object({ command_id: uuid, project_id: Type.Union([uuid, Type.Null()]),
  file: importFile, title: Type.Optional(Type.Union([Type.String({ maxLength: 200 }), Type.Null()])),
  tags: Type.Optional(Type.Array(tagName, { maxItems: 12 })),
  collection_ids: Type.Optional(Type.Array(uuid, { maxItems: 20 })),
  duplicate_strategy: Type.Optional(Type.Union([Type.Literal('SKIP'),
    Type.Literal('NEW_VERSION'), Type.Literal('NEW')])),
  target_knowledge_id: Type.Optional(uuid),
  expected_revision: Type.Optional(rev) }, strict);

const previewResponse = Type.Object({
  files: Type.Array(Type.Object({
    name: Type.String(), status: Type.String(),
    failure: Type.Optional(Type.String()), message: Type.Optional(Type.String()),
    size: Type.Optional(Type.Integer()), format: Type.Optional(Type.String()),
    media_type: Type.Optional(Type.String()), title_suggestion: Type.Optional(Type.String()),
    text: Type.Optional(Type.String()), text_length: Type.Optional(Type.Integer()),
    content_sha256: Type.Optional(Type.String()),
    detail: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    duplicates: Type.Optional(Type.Array(Type.Object({ id: uuid, title: Type.String(),
      project_id: Type.Union([uuid, Type.Null()]), revision: Type.Union([rev, Type.Null()]),
      current_version: Type.Union([rev, Type.Null()]),
      status: Type.Union([Type.String(), Type.Null()]) }, strict))),
    similar: Type.Optional(Type.Array(Type.Object({ id: uuid, title: Type.String(),
      project_id: Type.Union([uuid, Type.Null()]), revision: Type.Union([rev, Type.Null()]),
      current_version: Type.Union([rev, Type.Null()]),
      status: Type.Union([Type.String(), Type.Null()]) }, strict))),
  }, strict), { maxItems: 20 }),
}, strict);

export function registerKnowledgeRoutes(app: FastifyInstance,
  dependencies: RouteDependencies): void {
  app.get('/knowledge/page', { schema: { params: base, querystring: listQuery,
    response: { 200: listResponse } } }, async (request, reply) => {
    try {
      const p = request.params as { workspace_id: string };
      const q = request.query as { project_id?: string; scope?: string; status?: string;
        q?: string; collection_id?: string; tag_id?: string; sort?: string; limit?: string;
        cursor?: string };
      const result = await listKnowledgePage(dependencies.database.executor, {
        workspaceId: p.workspace_id, projectId: q.project_id, scope: q.scope, status: q.status,
        q: q.q, collectionId: q.collection_id, tagId: q.tag_id, sort: q.sort,
        limit: q.limit === undefined ? undefined : Number(q.limit), cursor: q.cursor,
      });
      return result;
    } catch (error) {
      return sendReadError(reply, error, request.id);
    }
  });

  app.get('/knowledge/overview', { schema: { params: base, querystring: listQuery,
    response: { 200: overviewResponse } } }, async (request, reply) => {
    try {
      const p = request.params as { workspace_id: string };
      const q = request.query as { project_id?: string };
      return await readKnowledgeOverview(dependencies.database.executor, p.workspace_id,
        q.project_id);
    } catch (error) { return sendReadError(reply, error, request.id); }
  });

  app.get('/knowledge/health', { schema: { params: base, querystring: listQuery,
    response: { 200: healthResponse } } }, async (request, reply) => {
    try {
      const p = request.params as { workspace_id: string };
      const q = request.query as { project_id?: string };
      return await readKnowledgeHealth(dependencies.database.executor, p.workspace_id,
        q.project_id);
    } catch (error) { return sendReadError(reply, error, request.id); }
  });

  app.get('/knowledge/:id/organization', { schema: { params: item,
    response: { 200: organizationResponse } } }, async (request, reply) => {
    try {
      const p = request.params as { workspace_id: string; id: string };
      return await readKnowledgeOrganization(dependencies.database.executor, p.workspace_id, p.id);
    } catch (error) { return sendReadError(reply, error, request.id); }
  });

  app.get('/knowledge-collections', { schema: { params: base, querystring: listQuery,
    response: { 200: collectionListResponse } } }, async (request, reply) => {
    try {
      const p = request.params as { workspace_id: string };
      const q = request.query as { project_id?: string };
      return { items: await listKnowledgeCollections(dependencies.database.executor,
        p.workspace_id, q.project_id) };
    } catch (error) { return sendReadError(reply, error, request.id); }
  });

  app.get('/knowledge-tags', { schema: { params: base, querystring: listQuery,
    response: { 200: tagListResponse } } }, async (request, reply) => {
    try {
      const p = request.params as { workspace_id: string };
      const q = request.query as { project_id?: string };
      return { items: await listKnowledgeTags(dependencies.database.executor,
        p.workspace_id, q.project_id) };
    } catch (error) { return sendReadError(reply, error, request.id); }
  });

  app.post('/knowledge-collections', { schema: { params: base, body: createCollectionBody,
    response: { 201: commandEnvelopeSchema(collectionResult) } } },
  createCommandHandler(dependencies, { commandType: 'CreateKnowledgeCollection',
    bodySchema: createCollectionBody,
    execute: async ({ executor, params, body }) => {
      const outcome = await createKnowledgeCollection(executor, {
        workspaceId: params.workspace_id ?? '', commandId: body.command_id,
        projectId: body.project_id, name: body.name,
        description: body.description });
      return { outcome, result: outcome.result as { collection_id: string; revision: string } };
    } }));

  app.patch('/knowledge-collections/:id', { schema: { params: item, body: updateCollectionBody,
    response: { 200: commandEnvelopeSchema(collectionResult) } } },
  createCommandHandler(dependencies, { commandType: 'UpdateKnowledgeCollection',
    bodySchema: updateCollectionBody,
    execute: async ({ executor, params, body }) => {
      const outcome = await updateKnowledgeCollection(executor, {
        workspaceId: params.workspace_id ?? '', commandId: body.command_id,
        collectionId: params.id ?? '', expectedRevision: body.expected_revision,
        name: body.name, description: body.description });
      return { outcome, result: outcome.result as { collection_id: string; revision: string } };
    } }));

  app.delete('/knowledge-collections/:id', { schema: { params: item, body: commandOnlyBody,
    response: { 200: commandEnvelopeSchema(deleteResult) } } },
  createCommandHandler(dependencies, { commandType: 'DeleteKnowledgeCollection',
    bodySchema: commandOnlyBody,
    execute: async ({ executor, params, body }) => {
      const outcome = await deleteKnowledgeCollection(executor, {
        workspaceId: params.workspace_id ?? '', commandId: body.command_id,
        collectionId: params.id ?? '' });
      return { outcome, result: outcome.result as { collection_id: string; status: string } };
    } }));

  app.put('/knowledge/:id/collections', { schema: { params: item, body: setCollectionsBody,
    response: { 200: commandEnvelopeSchema(setCollectionsResult) } } },
  createCommandHandler(dependencies, { commandType: 'SetKnowledgeCollections',
    bodySchema: setCollectionsBody,
    execute: async ({ executor, params, body }) => {
      const outcome = await setKnowledgeCollections(executor, {
        workspaceId: params.workspace_id ?? '', commandId: body.command_id,
        knowledgeId: params.id ?? '', collectionIds: body.collection_ids });
      return { outcome, result: outcome.result as { knowledge_id: string;
        collection_ids: string[] } };
    } }));

  app.post('/knowledge-tags', { schema: { params: base, body: tagNameBody,
    response: { 201: commandEnvelopeSchema(tagResult) } } },
  createCommandHandler(dependencies, { commandType: 'CreateKnowledgeTag',
    bodySchema: tagNameBody,
    execute: async ({ executor, params, body }) => {
      const outcome = await createKnowledgeTag(executor, {
        workspaceId: params.workspace_id ?? '', commandId: body.command_id, name: body.name });
      return { outcome, result: outcome.result as { tag_id: string; name: string } };
    } }));

  app.patch('/knowledge-tags/:id', { schema: { params: item, body: tagNameBody,
    response: { 200: commandEnvelopeSchema(tagResult) } } },
  createCommandHandler(dependencies, { commandType: 'RenameKnowledgeTag',
    bodySchema: tagNameBody,
    execute: async ({ executor, params, body }) => {
      const outcome = await renameKnowledgeTag(executor, {
        workspaceId: params.workspace_id ?? '', commandId: body.command_id,
        tagId: params.id ?? '', name: body.name });
      return { outcome, result: outcome.result as { tag_id: string; name: string } };
    } }));

  app.delete('/knowledge-tags/:id', { schema: { params: item, body: commandOnlyBody,
    response: { 200: commandEnvelopeSchema(deleteResult) } } },
  createCommandHandler(dependencies, { commandType: 'DeleteKnowledgeTag',
    bodySchema: commandOnlyBody,
    execute: async ({ executor, params, body }) => {
      const outcome = await deleteKnowledgeTag(executor, {
        workspaceId: params.workspace_id ?? '', commandId: body.command_id,
        tagId: params.id ?? '' });
      return { outcome, result: outcome.result as { tag_id: string; status: string } };
    } }));

  app.put('/knowledge/:id/tags', { schema: { params: item, body: setTagsBody,
    response: { 200: commandEnvelopeSchema(setTagsResult) } } },
  createCommandHandler(dependencies, { commandType: 'SetKnowledgeTags',
    bodySchema: setTagsBody,
    execute: async ({ executor, params, body }) => {
      const outcome = await setKnowledgeTags(executor, {
        workspaceId: params.workspace_id ?? '', commandId: body.command_id,
        knowledgeId: params.id ?? '', tags: body.tags });
      return { outcome, result: outcome.result as { knowledge_id: string;
        tags: { id: string; name: string }[] } };
    } }));

  app.post('/knowledge/:id/relations', { schema: { params: item, body: relationBody,
    response: { 201: commandEnvelopeSchema(relationResult) } } },
  createCommandHandler(dependencies, { commandType: 'CreateKnowledgeRelation',
    bodySchema: relationBody,
    execute: async ({ executor, params, body }) => {
      const outcome = await createKnowledgeRelation(executor, {
        workspaceId: params.workspace_id ?? '', commandId: body.command_id,
        fromKnowledgeId: params.id ?? '', toKnowledgeId: body.to_knowledge_id,
        relationKind: body.relation_kind,
        targetVersion: body.target_version, note: body.note });
      return { outcome, result: outcome.result as { relation_id: string;
        from_knowledge_id: string; to_knowledge_id: string; relation_kind: string } };
    } }));

  app.delete('/knowledge-relations/:id', { schema: { params: item, body: commandOnlyBody,
    response: { 200: commandEnvelopeSchema(deleteResult) } } },
  createCommandHandler(dependencies, { commandType: 'DeleteKnowledgeRelation',
    bodySchema: commandOnlyBody,
    execute: async ({ executor, params, body }) => {
      const outcome = await deleteKnowledgeRelation(executor, {
        workspaceId: params.workspace_id ?? '', commandId: body.command_id,
        relationId: params.id ?? '' });
      return { outcome, result: outcome.result as { relation_id: string; status: string } };
    } }));

  app.post('/knowledge-import/preview', { schema: { params: base, body: previewBody,
    response: { 200: previewResponse } } }, async (request, reply) => {
    try {
      const p = request.params as { workspace_id: string };
      const body = request.body as { project_id?: string | null;
        files: { name: string; media_type: string; content_base64: string }[] };
      return await previewKnowledgeImport(dependencies.database.executor, {
        workspaceId: p.workspace_id, projectId: body.project_id ?? null,
        files: body.files.map((file) => ({ name: file.name, mediaType: file.media_type,
          contentBase64: file.content_base64 })) });
    } catch (error) { return sendReadError(reply, error, request.id); }
  });

  app.post('/knowledge-import', { schema: { params: base, body: commitBody,
    response: { 201: commandEnvelopeSchema(importResult) } } },
  createCommandHandler(dependencies, { commandType: 'ImportKnowledge', bodySchema: commitBody,
    execute: async ({ executor, params, body }) => {
      const outcome = await commitKnowledgeImport(executor, {
        workspaceId: params.workspace_id ?? '', commandId: body.command_id,
        projectId: body.project_id,
        file: { name: body.file.name, mediaType: body.file.media_type,
          contentBase64: body.file.content_base64 },
        title: body.title,
        tags: body.tags, collectionIds: body.collection_ids,
        duplicateStrategy: body.duplicate_strategy,
        targetKnowledgeId: body.target_knowledge_id,
        expectedRevision: body.expected_revision });
      return { outcome, result: outcome.result as { knowledge_id: string; revision: string;
        version: string; status: string; created: string; duplicate_of: string } };
    } }));

  // 维护入口：有界批次回填旧知识的分词与摘要。返回本批处理条数，不静默「全部完成」。
  app.post('/knowledge/reindex', { schema: { params: base,
    response: { 200: resultSimple } } }, async (request, reply) => {
    try {
      const p = request.params as { workspace_id: string };
      const processed = await backfillKnowledgeIndex(dependencies.database.executor,
        p.workspace_id, 50);
      return { processed: String(processed) };
    } catch (error) { return sendReadError(reply, error, request.id); }
  });
}
