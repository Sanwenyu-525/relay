import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';

import {
  addGatewayPolicyVersionCommand, createGatewayConnectionCommand,
  createGatewayPolicyCommand, createManagedResourceCommand,
  disableGatewayConnectionCommand, disableManagedResourceCommand,
  revokeGatewayPolicyCommand,
} from '../application/gateway-commands.js';
import { createWebImportJob } from '../application/web-import-commands.js';
import { closePartialFileWriteCommand, readFileWriteDispositionPreview } from '../application/file-write-disposition.js';
import {
  listGatewayConnections, listGatewayPolicies, listGatewayPolicyVersions,
  listImportGatewayOperations, listManagedResources, listRunGatewayOperations,
  readFileWriteChangeSets, readFileWriteFrozenDiff, readGatewayConnection, readGatewayOperationDto, readManagedResource,
  testFakeGatewayConnection,
} from '../application/gateway-queries.js';
import { createRepositories } from '../application/unit-of-work.js';
import { resourceNotFound } from '../application/domain-error.js';
import { createCommandHandler, sendReadError, type RouteDependencies } from './envelope.js';
import { commandEnvelopeSchema } from './domain-schemas.js';

const strict = { additionalProperties: false } as const;
const uuid = Type.String({ format: 'uuid' });
const revision = Type.String({ pattern: '^(0|[1-9][0-9]*)$' });
const commandId = Type.Object({ command_id: uuid }, strict);
const projectParams = Type.Object({ workspace_id: uuid, project_id: uuid }, strict);
const connectionParams = Type.Object({ workspace_id: uuid, project_id: uuid, connection_id: uuid }, strict);
const policyParams = Type.Object({ workspace_id: uuid, project_id: uuid, policy_id: uuid }, strict);
const resourceParams = Type.Object({ workspace_id: uuid, project_id: uuid, resource_id: uuid }, strict);
const runParams = Type.Object({ workspace_id: uuid, run_id: uuid }, strict);
const importParams = Type.Object({ workspace_id: uuid, import_job_id: uuid }, strict);
const operationParams = Type.Object({ workspace_id: uuid, operation_id: uuid }, strict);
const capability = Type.Union([
  Type.Literal('FAKE_WRITE'),
  Type.Literal('FAKE_PUBLIC_READ'),
  Type.Literal('FILE_READ'),
  Type.Literal('WEB_FETCH'),
  Type.Literal('FILE_WRITE'),
  Type.Literal('GIT_READ'),
  Type.Literal('GIT_WRITE'),
  Type.Literal('CLI_RUN'),
]);
const decision = Type.Union([Type.Literal('AUTO'), Type.Literal('ASK'), Type.Literal('DENY')]);
const commandResult = Type.Record(Type.String(), Type.String());

const createConnectionBody = Type.Object({ command_id: uuid,
  capabilities: Type.Array(capability, { minItems: 1, maxItems: 6, uniqueItems: true }),
  root_path: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
  allowed_host: Type.Optional(Type.String({ minLength: 1, maxLength: 253 })),
  allow_private: Type.Optional(Type.Boolean()) }, strict);
const disableBody = Type.Object({ command_id: uuid, expected_version: revision }, strict);
const createPolicyBody = Type.Object({ command_id: uuid, capability,
  resource_id: Type.Union([uuid, Type.Null()]), decision,
  max_payload_bytes: Type.Integer({ minimum: 0, maximum: 262144 }),
  host: Type.Optional(Type.String({ minLength: 1, maxLength: 253 })) }, strict);
const versionPolicyBody = Type.Object({ command_id: uuid, expected_revision: revision, capability,
  resource_id: Type.Union([uuid, Type.Null()]), decision,
  max_payload_bytes: Type.Integer({ minimum: 0, maximum: 262144 }),
  host: Type.Optional(Type.String({ minLength: 1, maxLength: 253 })) }, strict);
const revokeBody = Type.Object({ command_id: uuid, expected_revision: revision }, strict);
const createResourceBody = Type.Object({ command_id: uuid, root_path: Type.String({ minLength: 1 }) }, strict);
const disableResourceBody = Type.Object({ command_id: uuid, expected_revision: revision }, strict);
const createImportBody = Type.Object({ command_id: uuid,
  url: Type.String({ minLength: 1, maxLength: 2048 }), connection_id: uuid }, strict);
const closePartialFileWriteBody = Type.Object({
  command_id: uuid, invocation_id: uuid,
  decision: Type.Literal('KEEP_CURRENT_AND_FAIL_RUN'),
  expected_run_revision: revision, expected_task_revision: revision,
  expected_observation_sha256: Type.String({ pattern: '^[0-9a-f]{64}$' }),
}, strict);

/** P09 config/history API. Claim, Admit, outcome and reconcile remain internal Worker ports. */
export function registerGatewayRoutes(app: FastifyInstance, dependencies: RouteDependencies): void {
  app.post('/projects/:project_id/connections', {
    schema: { params: projectParams, body: createConnectionBody,
      response: { 201: commandEnvelopeSchema(commandResult) } },
  }, createCommandHandler(dependencies, { commandType: 'CreateGatewayConnection', bodySchema: createConnectionBody,
    execute: async ({ executor, params, body }) => {
      const outcome = await createGatewayConnectionCommand(executor, { workspaceId: params.workspace_id ?? '',
        projectId: params.project_id ?? '', commandId: body.command_id, capabilities: body.capabilities,
        rootPath: body.root_path,
        ...(body.allowed_host === undefined ? {} : { allowedHost: body.allowed_host }),
        ...(body.allow_private === undefined ? {} : { allowPrivate: body.allow_private }) });
      return { outcome, result: outcome.result };
    } }));
  app.get('/projects/:project_id/connections', { schema: { params: projectParams } }, async (request, reply) => {
    try { const p = request.params as { workspace_id: string; project_id: string };
      return await listGatewayConnections(dependencies.database.executor, p.workspace_id, p.project_id);
    } catch (error) { return sendReadError(reply, error, request.id); }
  });
  app.get('/projects/:project_id/connections/:connection_id', { schema: { params: connectionParams } }, async (request, reply) => {
    try { const p = request.params as { workspace_id: string; project_id: string; connection_id: string };
      return await readGatewayConnection(dependencies.database.executor, p.workspace_id, p.project_id, p.connection_id);
    } catch (error) { return sendReadError(reply, error, request.id); }
  });
  app.post('/projects/:project_id/connections/:connection_id/test', { schema: { params: connectionParams } }, async (request, reply) => {
    try { const p = request.params as { workspace_id: string; project_id: string; connection_id: string };
      return await testFakeGatewayConnection(dependencies.database.executor, p.workspace_id, p.project_id, p.connection_id);
    } catch (error) { return sendReadError(reply, error, request.id); }
  });
  app.post('/projects/:project_id/connections/:connection_id/disable', {
    schema: { params: connectionParams, body: disableBody,
      response: { 200: commandEnvelopeSchema(commandResult) } },
  }, createCommandHandler(dependencies, { commandType: 'DisableGatewayConnection', bodySchema: disableBody,
    execute: async ({ executor, params, body }) => {
      const outcome = await disableGatewayConnectionCommand(executor, { workspaceId: params.workspace_id ?? '',
        projectId: params.project_id ?? '', connectionId: params.connection_id ?? '',
        commandId: body.command_id, expectedVersion: body.expected_version });
      return { outcome, result: outcome.result };
    } }));

  app.post('/projects/:project_id/permission-policies', {
    schema: { params: projectParams, body: createPolicyBody,
      response: { 201: commandEnvelopeSchema(commandResult) } },
  }, createCommandHandler(dependencies, { commandType: 'CreateGatewayPolicy', bodySchema: createPolicyBody,
    execute: async ({ executor, params, body }) => {
      const outcome = await createGatewayPolicyCommand(executor, { workspaceId: params.workspace_id ?? '',
        projectId: params.project_id ?? '', commandId: body.command_id, capability: body.capability,
        resourceId: body.resource_id, decision: body.decision, maxPayloadBytes: body.max_payload_bytes,
        ...(body.host === undefined ? {} : { host: body.host }) });
      return { outcome, result: outcome.result };
    } }));
  app.get('/projects/:project_id/permission-policies', { schema: { params: projectParams } }, async (request, reply) => {
    try { const p = request.params as { workspace_id: string; project_id: string };
      return await listGatewayPolicies(dependencies.database.executor, p.workspace_id, p.project_id);
    } catch (error) { return sendReadError(reply, error, request.id); }
  });
  app.get('/projects/:project_id/permission-policies/:policy_id/versions', { schema: { params: policyParams } }, async (request, reply) => {
    try { const p = request.params as { workspace_id: string; project_id: string; policy_id: string };
      return await listGatewayPolicyVersions(dependencies.database.executor, p.workspace_id, p.project_id, p.policy_id);
    } catch (error) { return sendReadError(reply, error, request.id); }
  });
  app.post('/projects/:project_id/permission-policies/:policy_id/versions', {
    schema: { params: policyParams, body: versionPolicyBody,
      response: { 200: commandEnvelopeSchema(commandResult) } },
  }, createCommandHandler(dependencies, { commandType: 'AddGatewayPolicyVersion', bodySchema: versionPolicyBody,
    execute: async ({ executor, params, body }) => {
      const outcome = await addGatewayPolicyVersionCommand(executor, { workspaceId: params.workspace_id ?? '',
        projectId: params.project_id ?? '', policyId: params.policy_id ?? '', commandId: body.command_id,
        expectedRevision: body.expected_revision, capability: body.capability,
        resourceId: body.resource_id, decision: body.decision, maxPayloadBytes: body.max_payload_bytes,
        ...(body.host === undefined ? {} : { host: body.host }) });
      return { outcome, result: outcome.result };
    } }));
  app.post('/projects/:project_id/permission-policies/:policy_id/revoke', {
    schema: { params: policyParams, body: revokeBody,
      response: { 200: commandEnvelopeSchema(commandResult) } },
  }, createCommandHandler(dependencies, { commandType: 'RevokeGatewayPolicy', bodySchema: revokeBody,
    execute: async ({ executor, params, body }) => {
      const outcome = await revokeGatewayPolicyCommand(executor, { workspaceId: params.workspace_id ?? '',
        projectId: params.project_id ?? '', policyId: params.policy_id ?? '',
        commandId: body.command_id, expectedRevision: body.expected_revision });
      return { outcome, result: outcome.result };
    } }));

  app.post('/projects/:project_id/managed-resources', {
    schema: { params: projectParams, body: createResourceBody,
      response: { 201: commandEnvelopeSchema(commandResult) } },
  }, createCommandHandler(dependencies, { commandType: 'CreateManagedResource', bodySchema: createResourceBody,
    execute: async ({ executor, params, body }) => {
      const outcome = await createManagedResourceCommand(executor, { workspaceId: params.workspace_id ?? '',
        projectId: params.project_id ?? '', commandId: body.command_id, rootPath: body.root_path });
      return { outcome, result: outcome.result };
    } }));
  app.get('/projects/:project_id/managed-resources', { schema: { params: projectParams } }, async (request, reply) => {
    try { const p = request.params as { workspace_id: string; project_id: string };
      return await listManagedResources(dependencies.database.executor, p.workspace_id, p.project_id);
    } catch (error) { return sendReadError(reply, error, request.id); }
  });
  app.get('/projects/:project_id/managed-resources/:resource_id', { schema: { params: resourceParams } }, async (request, reply) => {
    try { const p = request.params as { workspace_id: string; project_id: string; resource_id: string };
      return await readManagedResource(dependencies.database.executor, p.workspace_id, p.project_id, p.resource_id);
    } catch (error) { return sendReadError(reply, error, request.id); }
  });
  app.post('/projects/:project_id/managed-resources/:resource_id/disable', {
    schema: { params: resourceParams, body: disableResourceBody,
      response: { 200: commandEnvelopeSchema(commandResult) } },
  }, createCommandHandler(dependencies, { commandType: 'DisableManagedResource', bodySchema: disableResourceBody,
    execute: async ({ executor, params, body }) => {
      const outcome = await disableManagedResourceCommand(executor, { workspaceId: params.workspace_id ?? '',
        projectId: params.project_id ?? '', resourceId: params.resource_id ?? '',
        commandId: body.command_id, expectedRevision: body.expected_revision });
      return { outcome, result: outcome.result };
    } }));

  app.post('/projects/:project_id/import-jobs', {
    schema: { params: projectParams, body: createImportBody,
      response: { 201: commandEnvelopeSchema(commandResult) } },
  }, createCommandHandler(dependencies, { commandType: 'CreateWebImportJob', bodySchema: createImportBody,
    execute: async ({ executor, params, body }) => {
      const outcome = await createWebImportJob(executor, { workspaceId: params.workspace_id ?? '',
        projectId: params.project_id ?? '', commandId: body.command_id, url: body.url,
        connectionId: body.connection_id });
      return { outcome, result: outcome.result };
    } }));

  app.get('/runs/:run_id/operations', { schema: { params: runParams } }, async (request, reply) => {
    try { const p = request.params as { workspace_id: string; run_id: string };
      return await listRunGatewayOperations(dependencies.database.executor, p.workspace_id, p.run_id);
    } catch (error) { return sendReadError(reply, error, request.id); }
  });
  app.get('/import-jobs/:import_job_id/operations', { schema: { params: importParams } }, async (request, reply) => {
    try { const p = request.params as { workspace_id: string; import_job_id: string };
      return await listImportGatewayOperations(dependencies.database.executor, p.workspace_id, p.import_job_id);
    } catch (error) { return sendReadError(reply, error, request.id); }
  });
  app.get('/operations/:operation_id', { schema: { params: operationParams } }, async (request, reply) => {
    try { const p = request.params as { workspace_id: string; operation_id: string };
      return await readGatewayOperationDto(dependencies.database.executor, p.workspace_id, p.operation_id);
    } catch (error) { return sendReadError(reply, error, request.id); }
  });
  app.get('/operations/:operation_id/change-sets', { schema: { params: operationParams } }, async (request, reply) => {
    try { const p = request.params as { workspace_id: string; operation_id: string };
      reply.header('Cache-Control', 'no-store');
      return await readFileWriteChangeSets(dependencies.database.executor, p.workspace_id, p.operation_id);
    } catch (error) { return sendReadError(reply, error, request.id); }
  });
  app.get('/operations/:operation_id/file-write-diff', { schema: { params: operationParams } }, async (request, reply) => {
    try { const p = request.params as { workspace_id: string; operation_id: string };
      reply.header('Cache-Control', 'no-store');
      return await readFileWriteFrozenDiff(dependencies.database.executor, p.workspace_id, p.operation_id);
    } catch (error) { return sendReadError(reply, error, request.id); }
  });
  app.get('/operations/:operation_id/file-write-disposition', { schema: { params: operationParams } }, async (request, reply) => {
    try { const p = request.params as { workspace_id: string; operation_id: string };
      reply.header('Cache-Control', 'no-store');
      return await readFileWriteDispositionPreview(dependencies.database.executor, p.workspace_id, p.operation_id);
    } catch (error) { return sendReadError(reply, error, request.id); }
  });
  app.post('/operations/:operation_id/file-write-disposition', {
    schema: { params: operationParams, body: closePartialFileWriteBody,
      response: { 200: commandEnvelopeSchema(commandResult) } },
  }, createCommandHandler(dependencies, { commandType: 'ClosePartialFileWrite',
    bodySchema: closePartialFileWriteBody,
    execute: async ({ executor, params, body }) => {
      const outcome = await closePartialFileWriteCommand(executor, {
        workspaceId: params.workspace_id ?? '', operationId: params.operation_id ?? '',
        invocationId: body.invocation_id, commandId: body.command_id,
        decision: body.decision, expectedRunRevision: body.expected_run_revision,
        expectedTaskRevision: body.expected_task_revision,
        expectedObservationSha256: body.expected_observation_sha256,
      });
      return { outcome, result: outcome.result };
    } }));
  app.get('/import-jobs/:import_job_id', { schema: { params: importParams } }, async (request, reply) => {
    try {
      const p = request.params as { workspace_id: string; import_job_id: string };
      const row = await createRepositories(dependencies.database.executor).gateway.readImportJob(p.import_job_id);
      if (row?.workspace_id !== p.workspace_id) throw resourceNotFound('Import job');
      return { id: row.id, project_id: row.project_id, actor_ref: row.actor_ref,
        config_version: row.config_version, source_uri: row.source_uri, status: row.status,
        revision: row.revision.toString(), error: row.error, knowledge_version_id: row.knowledge_version_id,
        request_command_id: row.request_command_id, created_at: row.created_at.toISOString() };
    } catch (error) { return sendReadError(reply, error, request.id); }
  });
}
