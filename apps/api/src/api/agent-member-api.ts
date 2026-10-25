import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import {
  AGENT_ROLE_TEMPLATES, assignProjectCoordinator, createAgentMember, editAgentMember,
  listAgentMembers, readAgentMember, setAgentMemberStatus,
} from '../application/agent-members.js';
import type { AgentMemberModelSelectionInput, AgentMemberRunMode, AgentMemberStatus } from '../application/agent-members.js';
import { commandEnvelopeSchema, OpenObjectSchema } from './domain-schemas.js';
import { createCommandHandler, sendReadError, type RouteDependencies } from './envelope.js';

/**
 * 项目级长期 Agent 成员的 HTTP 面（ADR-034 包 A，迁移 0139）。
 * 命令全部 command_id 幂等、作用域 Workspace；协议归 HTTP 契约 §10.96。
 */
const strict = { additionalProperties: false } as const;
const uuid = Type.String({ format: 'uuid' });
const revision = Type.String({ pattern: '^[0-9]+$' });
const workspaceParams = Type.Object({ workspace_id: uuid }, strict);
const projectParams = Type.Object({ workspace_id: uuid, project_id: uuid }, strict);
const memberParams = Type.Object({ workspace_id: uuid, id: uuid }, strict);
const reason = Type.String({ minLength: 1, maxLength: 4000 });

/** 模型选择：INHERIT 或 EXPLICIT（解析口径与会话模型选择一致，配置时类型化拒绝）。 */
const modelSelection = Type.Union([
  Type.Object({ mode: Type.Literal('INHERIT') }, strict),
  Type.Object({ mode: Type.Literal('EXPLICIT'), model: Type.String({ minLength: 1, maxLength: 200 }) }, strict),
]);

/** 外部绑定目前只是展示性标签；可信绑定随 ADR-033 领取协议落地，不构成授权。 */
const externalBinding = Type.Optional(Type.Object({ principal_label: Type.String({ minLength: 1, maxLength: 200 }) }, strict));
const runMode = Type.Union([Type.Literal('BUILTIN'), Type.Literal('EXTERNAL')]);

const createBody = Type.Object({
  command_id: uuid,
  name: Type.String({ minLength: 1, maxLength: 100 }),
  role_key: Type.String({ minLength: 1, maxLength: 32 }),
  duties: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
  run_mode: runMode,
  model_selection: Type.Optional(modelSelection),
  external_binding: externalBinding,
}, strict);

const editBody = Type.Object({
  command_id: uuid, expected_revision: revision, reason,
  name: Type.String({ minLength: 1, maxLength: 100 }),
  duties: Type.String({ minLength: 1, maxLength: 2000 }),
  run_mode: runMode,
  model_selection: Type.Optional(modelSelection),
  external_binding: externalBinding,
}, strict);

const statusBody = Type.Object({
  command_id: uuid, expected_revision: revision, reason,
  status: Type.Union([Type.Literal('ACTIVE'), Type.Literal('INACTIVE'), Type.Literal('ARCHIVED')]),
}, strict);

const coordinatorBody = Type.Object({
  command_id: uuid, reason,
  member_id: uuid,
  /** 首次指派缺省；更换时必须带当前协调者行 revision，防止并发互换覆盖。 */
  expected_coordinator_revision: Type.Optional(revision),
}, strict);

const memberResult = Type.Object({
  agent_member_id: uuid, project_id: uuid, name: Type.String(), role_key: Type.String(),
  duties: Type.String(), status: Type.String(), run_mode: Type.String(),
  model_selection: OpenObjectSchema, external_binding: OpenObjectSchema,
  is_coordinator: Type.Boolean(), revision,
}, strict);

function toModelSelectionInput(value: undefined | { mode: 'INHERIT' } | { mode: 'EXPLICIT'; model: string }): AgentMemberModelSelectionInput | undefined {
  if (value === undefined) return undefined;
  return value.mode === 'INHERIT' ? { mode: 'INHERIT' } : { mode: 'EXPLICIT', model: value.model };
}

export function registerAgentMemberRoutes(app: FastifyInstance, d: RouteDependencies): void {
  app.post('/projects/:project_id/agent-members', {
    schema: { params: projectParams, body: createBody, response: { 201: commandEnvelopeSchema(memberResult) } },
  }, createCommandHandler(d, {
    commandType: 'CreateAgentMember', bodySchema: createBody, execute: async ({ executor, params, body }) => {
      const outcome = await createAgentMember(executor, {
        workspaceId: params.workspace_id ?? '', projectId: params.project_id ?? '', commandId: body.command_id,
        name: body.name, roleKey: body.role_key, duties: body.duties, runMode: body.run_mode as AgentMemberRunMode,
        modelSelection: toModelSelectionInput(body.model_selection), externalBinding: body.external_binding,
      });
      return { outcome, result: outcome.result };
    },
  }));

  app.post('/agent-members/:id/edits', {
    schema: { params: memberParams, body: editBody, response: { 200: commandEnvelopeSchema(memberResult) } },
  }, createCommandHandler(d, {
    commandType: 'EditAgentMember', bodySchema: editBody, execute: async ({ executor, params, body }) => {
      const outcome = await editAgentMember(executor, {
        workspaceId: params.workspace_id ?? '', agentMemberId: params.id ?? '', commandId: body.command_id,
        expectedRevision: body.expected_revision, name: body.name, duties: body.duties,
        runMode: body.run_mode as AgentMemberRunMode,
        modelSelection: toModelSelectionInput(body.model_selection), externalBinding: body.external_binding,
        reason: body.reason,
      });
      return { outcome, result: outcome.result };
    },
  }));

  app.post('/agent-members/:id/status-changes', {
    schema: { params: memberParams, body: statusBody, response: { 200: commandEnvelopeSchema(memberResult) } },
  }, createCommandHandler(d, {
    commandType: 'SetAgentMemberStatus', bodySchema: statusBody, execute: async ({ executor, params, body }) => {
      const outcome = await setAgentMemberStatus(executor, {
        workspaceId: params.workspace_id ?? '', agentMemberId: params.id ?? '', commandId: body.command_id,
        expectedRevision: body.expected_revision, status: body.status as AgentMemberStatus, reason: body.reason,
      });
      return { outcome, result: outcome.result };
    },
  }));

  app.post('/projects/:project_id/coordinator-assignments', {
    schema: { params: projectParams, body: coordinatorBody, response: { 200: commandEnvelopeSchema(Type.Object({
      project_id: uuid, agent_member_id: uuid, member_revision: revision, revision,
    }, strict)) } },
  }, createCommandHandler(d, {
    commandType: 'AssignProjectCoordinator', bodySchema: coordinatorBody, execute: async ({ executor, params, body }) => {
      const outcome = await assignProjectCoordinator(executor, {
        workspaceId: params.workspace_id ?? '', projectId: params.project_id ?? '', commandId: body.command_id,
        memberId: body.member_id, expectedCoordinatorRevision: body.expected_coordinator_revision ?? null, reason: body.reason,
      });
      return { outcome, result: outcome.result };
    },
  }));

  app.get('/projects/:project_id/agent-members', { schema: { params: projectParams } }, async (request, reply) => {
    try {
      const p = request.params as { workspace_id: string; project_id: string };
      return await listAgentMembers(d.database.executor, p.workspace_id, p.project_id);
    } catch (error) { return sendReadError(reply, error, request.id); }
  });

  app.get('/agent-members/:id', { schema: { params: memberParams } }, async (request, reply) => {
    try {
      const p = request.params as { workspace_id: string; id: string };
      return await readAgentMember(d.database.executor, p.workspace_id, p.id);
    } catch (error) { return sendReadError(reply, error, request.id); }
  });

  app.get('/agent-role-templates', { schema: { params: workspaceParams } }, async () => ({
    items: AGENT_ROLE_TEMPLATES,
  }));
}
