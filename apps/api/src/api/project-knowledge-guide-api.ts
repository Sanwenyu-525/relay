import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';

import { readProjectKnowledgeGuide, saveProjectKnowledgeGuide } from
  '../application/project-knowledge-guide.js';
import { acceptCurationCandidate, createCurationCandidates, listCurationCandidates,
  rejectCurationCandidate } from '../application/knowledge-curation.js';
import {
  UuidSchema,
  WorkspaceProjectParamsSchema,
  commandEnvelopeSchema,
} from './domain-schemas.js';
import { createCommandHandler, sendReadError, type RouteDependencies } from './envelope.js';

const strict = { additionalProperties: false } as const;
const revision = Type.String({ pattern: '^(0|[1-9][0-9]*)$' });
const refKind = Type.Union([Type.Literal('KNOWLEDGE'), Type.Literal('DECISION'),
  Type.Literal('RULE'), Type.Literal('ARTIFACT_VERSION')]);
const referenceMode = Type.Union([Type.Literal('PINNED'), Type.Literal('CURRENT')]);
const resolution = Type.Union([Type.Literal('AVAILABLE'), Type.Literal('ARCHIVED'),
  Type.Literal('SUPERSEDED'), Type.Literal('STALE'), Type.Literal('CROSS_SCOPE'),
  Type.Literal('MISSING')]);

const entryInput = Type.Object({ ref_kind: refKind, reference_mode: referenceMode,
  knowledge_id: Type.Optional(UuidSchema), decision_id: Type.Optional(UuidSchema),
  rule_id: Type.Optional(UuidSchema), artifact_version_id: Type.Optional(UuidSchema),
  pinned_version_id: Type.Optional(UuidSchema),
  label: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })) }, strict);
const saveBody = Type.Object({ command_id: UuidSchema, expected_revision: revision,
  entries: Type.Array(entryInput, { maxItems: 200 }) }, strict);

const entryView = Type.Object({ ordinal: Type.Integer({ minimum: 0 }), ref_kind: refKind,
  reference_mode: referenceMode, target_id: UuidSchema,
  label: Type.Union([Type.String(), Type.Null()]),
  title: Type.Union([Type.String(), Type.Null()]),
  resolved_version_id: Type.Union([UuidSchema, Type.Null()]),
  resolved_version_number: Type.Union([revision, Type.Null()]),
  target_status: Type.String(), is_current: Type.Boolean(), resolution, note: Type.String() },
strict);
const guide = Type.Object({ project_id: UuidSchema, exists: Type.Boolean(), revision,
  entry_count: Type.Integer({ minimum: 0 }), entries: Type.Array(entryView),
  gaps: Type.Array(Type.String()) }, strict);

const curationCandidate = Type.Object({ id: UuidSchema, project_id: UuidSchema,
  source_artifact_version_id: UuidSchema, source_artifact_id: UuidSchema,
  source_version_number: Type.String(), source_title: Type.String(),
  suggested_title: Type.String(),
  suggested_knowledge_id: Type.Union([UuidSchema, Type.Null()]),
  suggested_knowledge_title: Type.Union([Type.String(), Type.Null()]),
  similar: Type.Array(Type.Object({ knowledge_id: UuidSchema, title: Type.String(),
    status: Type.String(), reason: Type.String() }, strict)),
  status: Type.Union([Type.Literal('PROPOSED'), Type.Literal('ACCEPTED'),
    Type.Literal('REJECTED'), Type.Literal('STALE')]),
  accepted_knowledge_id: Type.Union([UuidSchema, Type.Null()]),
  accepted_knowledge_version_id: Type.Union([UuidSchema, Type.Null()]),
  stale_reason: Type.Union([Type.String(), Type.Null()]),
  rejected_at: Type.Union([Type.String(), Type.Null()]) }, strict);

/**
 * N03 项目知识导读（docs/api/http-command-contract.md §10.53）。
 * Project 拥有导读编排；条目只保存确切引用，不复制正文，也不改写 Rule / Decision。
 */
export function registerProjectKnowledgeGuideRoutes(app: FastifyInstance,
  dependencies: RouteDependencies): void {
  app.get('/projects/:project_id/knowledge-guide', {
    schema: { params: WorkspaceProjectParamsSchema, response: { 200: guide } },
  }, async (request, reply) => {
    try {
      const params = request.params as { workspace_id: string; project_id: string };
      return await readProjectKnowledgeGuide(dependencies.database.executor,
        params.workspace_id, params.project_id);
    } catch (error) { return sendReadError(reply, error, request.id); }
  });

  app.post('/projects/:project_id/knowledge-curation-candidates', {
    schema: { params: WorkspaceProjectParamsSchema,
      body: Type.Object({ command_id: UuidSchema, sources: Type.Array(Type.Object({
        artifact_version_id: UuidSchema,
        suggested_title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })) },
      strict), { minItems: 1, maxItems: 10 }) }, strict),
      response: { 201: commandEnvelopeSchema(Type.Object({ candidate_ids: Type.Array(UuidSchema) },
        strict)) } },
  }, createCommandHandler(dependencies, { commandType: 'CreateKnowledgeCurationCandidates',
    bodySchema: Type.Object({ command_id: UuidSchema, sources: Type.Array(Type.Object({
      artifact_version_id: UuidSchema,
      suggested_title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })) },
    strict), { minItems: 1, maxItems: 10 }) }, strict),
    execute: async ({ executor, body, params }) => {
      const outcome = await createCurationCandidates(executor, {
        workspaceId: params.workspace_id ?? '', projectId: params.project_id ?? '',
        sources: body.sources, commandId: body.command_id });
      return { outcome, result: { project_id: params.project_id, ...outcome.result } };
    } }));

  app.get('/projects/:project_id/knowledge-curation-candidates', {
    schema: { params: WorkspaceProjectParamsSchema,
      response: { 200: Type.Object({ items: Type.Array(curationCandidate) }, strict) } },
  }, async (request, reply) => {
    try {
      const params = request.params as { workspace_id: string; project_id: string };
      // 先复核 Project 作用域：跨 Workspace 的项目 ID 一律 404，不泄露候选是否存在。
      await readProjectKnowledgeGuide(dependencies.database.executor, params.workspace_id,
        params.project_id);
      return { items: await listCurationCandidates(dependencies.database.executor,
        params.workspace_id, params.project_id) };
    } catch (error) { return sendReadError(reply, error, request.id); }
  });

  // 接受候选不是独立命令：它复用既有 CreateKnowledge / AddKnowledgeVersion 的幂等与事务
  // （命令不可嵌套），因此自行组装回执信封，幂等身份就是派生出的原命令 ID。
  app.post('/projects/:project_id/knowledge-curation-candidates/:candidate_id/accept', {
    schema: { params: Type.Object({ workspace_id: UuidSchema, project_id: UuidSchema,
      candidate_id: UuidSchema }, strict),
      body: Type.Object({ command_id: UuidSchema }, strict),
      response: { 200: commandEnvelopeSchema(Type.Object({ candidate_id: UuidSchema,
        knowledge_id: UuidSchema, knowledge_version_id: UuidSchema,
        knowledge_revision: Type.String(),
        mode: Type.Union([Type.Literal('CREATED'), Type.Literal('NEW_VERSION')]) },
      strict)) } },
  }, async (request, reply) => {
    const params = request.params as { workspace_id: string; project_id: string;
      candidate_id: string };
    const body = request.body as { command_id: string };
    try {
      const outcome = await acceptCurationCandidate(dependencies.database.executor, {
        workspaceId: params.workspace_id, projectId: params.project_id,
        candidateId: params.candidate_id, commandId: body.command_id });
      const { replayed, ...result } = outcome;
      if (replayed) reply.header('command-replayed', 'true');
      return reply.code(200).send({
        command_id: body.command_id, committed_at: new Date().toISOString(), result,
        links: { resource: `/api/v1/workspaces/${params.workspace_id}/knowledge/${result.knowledge_id}` },
      });
    } catch (error) { return sendReadError(reply, error, request.id); }
  });

  app.post('/projects/:project_id/knowledge-curation-candidates/:candidate_id/reject', {
    schema: { params: Type.Object({ workspace_id: UuidSchema, project_id: UuidSchema,
      candidate_id: UuidSchema }, strict),
      // 与接受同形：project_id 走路径，不进 body。
      body: Type.Object({ command_id: UuidSchema }, strict),
      response: { 200: commandEnvelopeSchema(Type.Object({ candidate_id: UuidSchema,
        status: Type.Literal('REJECTED') }, strict)) } },
  }, createCommandHandler(dependencies, { commandType: 'RejectKnowledgeCurationCandidate',
    bodySchema: Type.Object({ command_id: UuidSchema }, strict),
    execute: async ({ executor, body, params }) => {
      const outcome = await rejectCurationCandidate(executor, {
        workspaceId: params.workspace_id ?? '', projectId: params.project_id ?? '',
        candidateId: params.candidate_id ?? '', commandId: body.command_id });
      return { outcome, result: outcome.result };
    } }));

  app.put('/projects/:project_id/knowledge-guide', {
    schema: { params: WorkspaceProjectParamsSchema, body: saveBody,
      response: { 200: commandEnvelopeSchema(Type.Object({ revision,
        entry_count: Type.String() }, strict)) } },
  }, createCommandHandler(dependencies, { commandType: 'SaveProjectKnowledgeGuide',
    bodySchema: saveBody,
    execute: async ({ executor, body, params }) => {
      const outcome = await saveProjectKnowledgeGuide(executor, {
        workspaceId: params.workspace_id ?? '', projectId: params.project_id ?? '',
        commandId: body.command_id, expectedRevision: body.expected_revision,
        entries: body.entries });
      return { outcome, result: { project_id: params.project_id,
        ...outcome.result } };
    } }));
}
