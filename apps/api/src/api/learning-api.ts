import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';

import {
  clearLearningRecords, correctLearningRecord, deleteLearningEvidence, readLearningContinuation,
  readLearningRecords, readLearningSessionState, setLearningRecordControl,
} from '../application/learning-records.js';
import { commandEnvelopeSchema } from './domain-schemas.js';
import { createCommandHandler, sendReadError, type RouteDependencies } from './envelope.js';

/**
 * 学习记录 API（0072，ADR-020）。
 *
 * 三条口径直接写进形状：
 *   * 读路径只读应用保存的同一记录，**不**请求模型重新生成进度总结；
 *   * 所有写命令都是 `POST` + `command_id`，复用既有命令回执与幂等；
 *   * 返回只给最小身份与结果元数据（代次/修订/被删计数），不返回可复原的评估正文。
 */

const strict = { additionalProperties: false } as const;
const uuid = Type.String({ format: 'uuid' });
const rev = Type.String({ pattern: '^(0|[1-9][0-9]*)$' });
const base = Type.Object({ workspace_id: uuid }, strict);
const sessionItem = Type.Object({ workspace_id: uuid, id: uuid }, strict);

const evidenceSchema = Type.Object({
  evidence_id: uuid, kind: Type.String(), scenario: Type.String(), detail: Type.String(),
  disposition: Type.String(), source_kind: Type.String(),
  source_message_id: Type.Union([uuid, Type.Null()]),
  session_id: Type.Union([uuid, Type.Null()]),
  observed_at: Type.String(),
}, strict);

const conceptSchema = Type.Object({
  concept_id: uuid, topic: Type.String(), display_name: Type.String(),
  generation: rev, revision: rev, evidence: Type.Array(evidenceSchema),
}, strict);

/** 轻量查看：默认摘要，展开所需的具体缺口与依据也在同一投影里。 */
const recordsSchema = Type.Object({
  epoch: rev,
  cleared_at: Type.Union([Type.String(), Type.Null()]),
  concepts: Type.Array(conceptSchema),
}, strict);

const continuationSchema = Type.Object({
  session_id: uuid, goal: Type.String(),
  last_observed_at: Type.Union([Type.String(), Type.Null()]),
  topics: Type.Array(Type.Object({ topic: Type.String(), concepts: Type.Integer() }, strict)),
  open_items: Type.Array(Type.Object({
    concept_id: uuid, display_name: Type.String(), kind: Type.String(),
    disposition: Type.String(), detail: Type.String(), scenario: Type.String(),
  }, strict)),
}, strict);

const correctionBody = Type.Object({
  command_id: uuid,
  session_id: uuid,
  /** 聊天纠正须核对原用户消息；明确 UI 操作可省略，模型结算不走本命令。 */
  source_message_id: Type.Optional(uuid),
  concept_id: uuid,
  scenario: Type.String({ minLength: 1, maxLength: 200 }),
  detail: Type.String({ minLength: 1, maxLength: 400 }),
}, strict);

const deletionBody = Type.Object({
  command_id: uuid,
  evidence_id: uuid,
  /** 期望的概念代次；落后即 REVISION_CONFLICT，不用最后写入覆盖。 */
  expected_generation: Type.Optional(rev),
}, strict);

const clearBody = Type.Object({ command_id: uuid }, strict);

const controlBody = Type.Object({
  command_id: uuid,
  records_enabled: Type.Boolean(),
  expected_revision: Type.Optional(rev),
}, strict);

export function registerLearningRoutes(app: FastifyInstance,
  dependencies: RouteDependencies): void {
  app.get('/learning-sessions/:id/state', {
    schema: { params: sessionItem, response: { 200: Type.Object({
      session_id: uuid, records_enabled: Type.Boolean(), revision: rev,
      rounds: Type.Array(Type.Object({ message_id: uuid, status: Type.String(),
        rejection_reason: Type.Union([Type.String(), Type.Null()]),
        record_enabled: Type.Boolean() }, strict)),
    }, strict) } },
  }, async (request, reply) => {
    try {
      const p = request.params as { workspace_id: string; id: string };
      return await readLearningSessionState(dependencies.database.executor,
        { workspaceId: p.workspace_id, sessionId: p.id });
    } catch (error) { return sendReadError(reply, error, request.id); }
  });
  app.get('/learning-records', {
    schema: { params: base, response: { 200: recordsSchema } },
  }, async (request, reply) => {
    try {
      const p = request.params as { workspace_id: string };
      return await readLearningRecords(dependencies.database.executor,
        { workspaceId: p.workspace_id });
    } catch (error) { return sendReadError(reply, error, request.id); }
  });

  app.get('/learning-sessions/:id/continuation', {
    schema: { params: sessionItem, response: { 200: continuationSchema } },
  }, async (request, reply) => {
    try {
      const p = request.params as { workspace_id: string; id: string };
      return await readLearningContinuation(dependencies.database.executor,
        { workspaceId: p.workspace_id, sessionId: p.id ?? '' });
    } catch (error) { return sendReadError(reply, error, request.id); }
  });

  app.post('/learning-records/corrections', {
    schema: { params: base, body: correctionBody,
      response: { 200: commandEnvelopeSchema(Type.Object({
        evidence_id: uuid, concept_id: uuid, generation: rev }, strict)) } },
  }, createCommandHandler(dependencies, { commandType: 'CorrectLearningRecord',
    bodySchema: correctionBody,
    execute: async ({ executor, params, body }) => {
      const outcome = await correctLearningRecord(executor, {
        workspaceId: params.workspace_id ?? '', commandId: body.command_id,
        sessionId: body.session_id,
        ...(body.source_message_id === undefined ? {} : { sourceMessageId: body.source_message_id }),
        conceptId: body.concept_id, scenario: body.scenario, detail: body.detail,
      });
      return { outcome, result: outcome.result };
    } }));

  app.post('/learning-records/deletions', {
    schema: { params: base, body: deletionBody,
      response: { 200: commandEnvelopeSchema(Type.Object({
        deleted: Type.Boolean(), concept_id: uuid, generation: rev }, strict)) } },
  }, createCommandHandler(dependencies, { commandType: 'DeleteLearningEvidence',
    bodySchema: deletionBody,
    execute: async ({ executor, params, body }) => {
      const outcome = await deleteLearningEvidence(executor, {
        workspaceId: params.workspace_id ?? '', commandId: body.command_id,
        evidenceId: body.evidence_id,
        ...(body.expected_generation === undefined
          ? {} : { expectedGeneration: body.expected_generation }),
      });
      return { outcome, result: outcome.result };
    } }));

  app.post('/learning-records/clearances', {
    schema: { params: base, body: clearBody,
      response: { 200: commandEnvelopeSchema(Type.Object({
        epoch: rev, cleared_evidence: Type.Integer(), cleared_concepts: Type.Integer(),
        cancelled_rounds: Type.Integer() }, strict)) } },
  }, createCommandHandler(dependencies, { commandType: 'ClearLearningRecords',
    bodySchema: clearBody,
    execute: async ({ executor, params, body }) => {
      const outcome = await clearLearningRecords(executor, {
        workspaceId: params.workspace_id ?? '', commandId: body.command_id,
      });
      return { outcome, result: outcome.result };
    } }));

  app.post('/learning-sessions/:id/record-control', {
    schema: { params: sessionItem, body: controlBody,
      response: { 200: commandEnvelopeSchema(Type.Object({
        session_id: uuid, records_enabled: Type.Boolean(), revision: rev }, strict)) } },
  }, createCommandHandler(dependencies, { commandType: 'SetLearningRecordControl',
    bodySchema: controlBody,
    execute: async ({ executor, params, body }) => {
      const outcome = await setLearningRecordControl(executor, {
        workspaceId: params.workspace_id ?? '', commandId: body.command_id,
        sessionId: params.id ?? '', recordsEnabled: body.records_enabled,
        ...(body.expected_revision === undefined
          ? {} : { expectedRevision: body.expected_revision }),
      });
      return { outcome, result: outcome.result };
    } }));
}
