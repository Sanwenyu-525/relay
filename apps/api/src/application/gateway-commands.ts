import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';

import type { DbExecutor } from '../infrastructure/database.js';
import type { GatewayCapability, GatewayDecision } from '../infrastructure/database-schema.js';
import { toDecimalString } from '../shared/decimal.js';
import { httpCommandScopeKey } from './actor.js';
import { runIdempotentCommand, type CommandOutcome } from './command.js';
import { invalidTransition, resourceNotFound, revisionConflict, validationFailed } from './domain-error.js';
import { canonicalResourceIdentity, rootsOverlap } from './gateway-configuration.js';
import { requireRevision } from './revisions.js';
import type { Repositories } from './unit-of-work.js';

type IdResult = { readonly project_id?: string; readonly connection_id?: string; readonly policy_id?: string;
  readonly resource_id?: string; readonly version?: string; readonly revision?: string;
  readonly status?: string; readonly canonical_root?: string };

async function authorityWrite(repositories: Repositories, workspaceId: string): Promise<void> {
  if (await repositories.workspaces.lockAuthority(workspaceId, 'update') === undefined) {
    throw resourceNotFound('Workspace authority');
  }
}

async function projectVisible(repositories: Repositories, workspaceId: string, projectId: string): Promise<void> {
  const project = await repositories.projects.readProject(projectId);
  if (project?.workspace_id !== workspaceId) throw resourceNotFound('Project');
}

export async function createGatewayConnectionCommand(db: DbExecutor, input: {
  workspaceId: string; projectId: string; commandId: string; capabilities: readonly GatewayCapability[];
}): Promise<CommandOutcome<IdResult>> {
  if (input.capabilities.length === 0 || new Set(input.capabilities).size !== input.capabilities.length) {
    throw validationFailed([{ field: 'capabilities', message: 'must be a nonempty unique list' }]);
  }
  return runIdempotentCommand(db, { scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId, commandType: 'CreateGatewayConnection',
    target: { project_id: input.projectId }, body: { capabilities: [...input.capabilities].sort() },
    execute: async (repositories) => {
      await authorityWrite(repositories, input.workspaceId);
      await projectVisible(repositories, input.workspaceId, input.projectId);
      const connection = await repositories.gateway.insertConnection({ id: randomUUID(),
        workspaceId: input.workspaceId, projectId: input.projectId, config: {} });
      for (const capability of input.capabilities) await repositories.gateway.addConnectionCapability(connection.id, capability);
      await repositories.workspaces.bumpAuthority(input.workspaceId);
      return { project_id: input.projectId, connection_id: connection.id,
        version: toDecimalString(connection.version), status: connection.status };
    } });
}

export async function disableGatewayConnectionCommand(db: DbExecutor, input: {
  workspaceId: string; projectId: string; connectionId: string; commandId: string; expectedVersion: string;
}): Promise<CommandOutcome<IdResult>> {
  const expected = requireRevision(input.expectedVersion, 'expected_version');
  return runIdempotentCommand(db, { scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId, commandType: 'DisableGatewayConnection',
    target: { project_id: input.projectId, connection_id: input.connectionId },
    body: { expected_version: toDecimalString(expected) },
    execute: async (repositories) => {
      await authorityWrite(repositories, input.workspaceId);
      const current = await repositories.gateway.readConnection(input.connectionId);
      if (current?.workspace_id !== input.workspaceId || current.project_id !== input.projectId) throw resourceNotFound('Connection');
      if (current.version !== expected) throw revisionConflict({ entityType: 'CONNECTION',
        expectedRevision: toDecimalString(expected), actualRevision: toDecimalString(current.version) });
      if (current.status === 'DISABLED') throw invalidTransition('Connection 已停用。');
      const changed = await repositories.gateway.setConnection({ id: current.id, status: 'DISABLED', config: {} });
      await repositories.workspaces.bumpAuthority(input.workspaceId);
      return { project_id: input.projectId, connection_id: changed.id,
        version: toDecimalString(changed.version), status: changed.status };
    } });
}

async function policyScope(repositories: Repositories, workspaceId: string, projectId: string,
  capability: GatewayCapability, resourceId: string | null): Promise<{ actionType: 'WRITE_MARKER' | 'READ_PUBLIC'; targetPrefix: string }> {
  if (capability === 'FAKE_PUBLIC_READ') {
    if (resourceId !== null) throw validationFailed([{ field: 'resource_id', message: 'public read has no resource' }]);
    return { actionType: 'READ_PUBLIC', targetPrefix: 'https://public.example/' };
  }
  if (resourceId === null) throw validationFailed([{ field: 'resource_id', message: 'write permission requires a resource' }]);
  const resource = await repositories.gateway.readResource(resourceId);
  if (resource?.workspace_id !== workspaceId || resource.project_id !== projectId || resource.status !== 'ACTIVE') {
    throw resourceNotFound('Managed resource');
  }
  return { actionType: 'WRITE_MARKER', targetPrefix: resource.canonical_root };
}

export async function createGatewayPolicyCommand(db: DbExecutor, input: {
  workspaceId: string; projectId: string; commandId: string; capability: GatewayCapability;
  resourceId: string | null; decision: GatewayDecision; maxPayloadBytes: number;
}): Promise<CommandOutcome<IdResult>> {
  if (!Number.isInteger(input.maxPayloadBytes) || input.maxPayloadBytes < 0 || input.maxPayloadBytes > 262144) {
    throw validationFailed([{ field: 'max_payload_bytes', message: 'must be from 0 to 262144' }]);
  }
  return runIdempotentCommand(db, { scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId, commandType: 'CreateGatewayPolicy',
    target: { project_id: input.projectId }, body: { capability: input.capability,
      resource_id: input.resourceId, decision: input.decision, max_payload_bytes: input.maxPayloadBytes },
    execute: async (repositories) => {
      await authorityWrite(repositories, input.workspaceId);
      await projectVisible(repositories, input.workspaceId, input.projectId);
      const scope = await policyScope(repositories, input.workspaceId, input.projectId, input.capability, input.resourceId);
      const policy = await repositories.gateway.insertPolicy({ id: randomUUID(), workspaceId: input.workspaceId,
        projectId: input.projectId, capability: input.capability, actionType: scope.actionType,
        targetPrefix: scope.targetPrefix, decision: input.decision, maxPayloadBytes: input.maxPayloadBytes });
      await repositories.workspaces.bumpAuthority(input.workspaceId);
      return { project_id: input.projectId, policy_id: policy.id,
        revision: toDecimalString(policy.revision), version: '1', status: policy.status };
    } });
}

export async function addGatewayPolicyVersionCommand(db: DbExecutor, input: {
  workspaceId: string; projectId: string; policyId: string; commandId: string; expectedRevision: string;
  capability: GatewayCapability; resourceId: string | null;
  decision: GatewayDecision; maxPayloadBytes: number;
}): Promise<CommandOutcome<IdResult>> {
  const expected = requireRevision(input.expectedRevision, 'expected_revision');
  return runIdempotentCommand(db, { scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId, commandType: 'AddGatewayPolicyVersion',
    target: { project_id: input.projectId, policy_id: input.policyId },
    body: { expected_revision: toDecimalString(expected), capability: input.capability,
      resource_id: input.resourceId, decision: input.decision, max_payload_bytes: input.maxPayloadBytes },
    execute: async (repositories) => {
      await authorityWrite(repositories, input.workspaceId);
      const policy = await repositories.gateway.readPolicy(input.policyId);
      if (policy?.workspace_id !== input.workspaceId || policy.project_id !== input.projectId) throw resourceNotFound('Permission policy');
      if (policy.revision !== expected) throw revisionConflict({ entityType: 'PERMISSION_POLICY',
        expectedRevision: toDecimalString(expected), actualRevision: toDecimalString(policy.revision) });
      const scope = await policyScope(repositories, input.workspaceId, input.projectId, input.capability, input.resourceId);
      const version = (await repositories.gateway.latestPolicyVersion(policy.id)) + 1n;
      await repositories.gateway.insertPolicyVersion({ policyId: policy.id, version,
        capability: input.capability, actionType: scope.actionType, targetPrefix: scope.targetPrefix,
        decision: input.decision, maxPayloadBytes: input.maxPayloadBytes });
      const activated = await repositories.gateway.activatePolicyVersion(policy.id, version);
      await repositories.workspaces.bumpAuthority(input.workspaceId);
      return { project_id: input.projectId, policy_id: policy.id, version: toDecimalString(version),
        revision: toDecimalString(activated.revision), status: activated.status };
    } });
}

export async function revokeGatewayPolicyCommand(db: DbExecutor, input: {
  workspaceId: string; projectId: string; policyId: string; commandId: string; expectedRevision: string;
}): Promise<CommandOutcome<IdResult>> {
  const expected = requireRevision(input.expectedRevision, 'expected_revision');
  return runIdempotentCommand(db, { scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId, commandType: 'RevokeGatewayPolicy',
    target: { project_id: input.projectId, policy_id: input.policyId },
    body: { expected_revision: toDecimalString(expected) }, execute: async (repositories) => {
      await authorityWrite(repositories, input.workspaceId);
      const policy = await repositories.gateway.readPolicy(input.policyId);
      if (policy?.workspace_id !== input.workspaceId || policy.project_id !== input.projectId) throw resourceNotFound('Permission policy');
      if (policy.revision !== expected) throw revisionConflict({ entityType: 'PERMISSION_POLICY',
        expectedRevision: toDecimalString(expected), actualRevision: toDecimalString(policy.revision) });
      if (policy.status === 'REVOKED') throw invalidTransition('Permission 已撤销。');
      const revoked = await repositories.gateway.revokePolicy(policy.id);
      await repositories.workspaces.bumpAuthority(input.workspaceId);
      return { project_id: input.projectId, policy_id: policy.id,
        revision: toDecimalString(revoked.revision), status: revoked.status };
    } });
}

export async function createManagedResourceCommand(db: DbExecutor, input: {
  workspaceId: string; projectId: string; commandId: string; rootPath: string;
}): Promise<CommandOutcome<IdResult>> {
  return runIdempotentCommand(db, { scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId, commandType: 'CreateManagedResource',
    target: { project_id: input.projectId }, body: { root_path: input.rootPath },
    execute: async (repositories) => {
      // Receipt replay bypasses this local metadata read. It occurs before DB
      // locks; the Fake adapter checks the parent again at use.
      let root: string;
      try { root = await realpath(input.rootPath); }
      catch (error) {
        if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) {
          throw validationFailed([{ field: 'root_path', message: 'must be an existing directory' }]);
        }
        throw error;
      }
      if (!(await stat(root)).isDirectory()) throw validationFailed([{ field: 'root_path', message: 'must be an existing directory' }]);
      const key = canonicalResourceIdentity(root);
      await authorityWrite(repositories, input.workspaceId);
      await projectVisible(repositories, input.workspaceId, input.projectId);
      await repositories.gateway.lockResourceRegistry();
      if ((await repositories.gateway.listResources()).some((row) =>
        row.project_id === input.projectId && row.identity_key === key)) {
        throw invalidTransition('同一 Project 已登记该实际目录。');
      }
      const resource = await repositories.gateway.insertResource({ id: randomUUID(),
        workspaceId: input.workspaceId, projectId: input.projectId, canonicalRoot: root, identityKey: key });
      await repositories.workspaces.bumpAuthority(input.workspaceId);
      return { project_id: input.projectId, resource_id: resource.id,
        revision: toDecimalString(resource.revision),
        canonical_root: resource.canonical_root, status: resource.status };
    } });
}

export async function disableManagedResourceCommand(db: DbExecutor, input: {
  workspaceId: string; projectId: string; resourceId: string; commandId: string; expectedRevision: string;
}): Promise<CommandOutcome<IdResult>> {
  const expected = requireRevision(input.expectedRevision, 'expected_revision');
  return runIdempotentCommand(db, { scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId, commandType: 'DisableManagedResource',
    target: { project_id: input.projectId, resource_id: input.resourceId },
    body: { expected_revision: toDecimalString(expected) }, execute: async (repositories) => {
      await authorityWrite(repositories, input.workspaceId);
      const resource = await repositories.gateway.lockResource(input.resourceId);
      if (resource?.workspace_id !== input.workspaceId || resource.project_id !== input.projectId) throw resourceNotFound('Managed resource');
      if (resource.revision !== expected) throw revisionConflict({ entityType: 'MANAGED_RESOURCE',
        expectedRevision: toDecimalString(expected), actualRevision: toDecimalString(resource.revision) });
      if (resource.status === 'DISABLED') throw invalidTransition('资源已停用。');
      await repositories.gateway.lockResourceRegistry();
      if ((await repositories.gateway.listOccupiedResources()).some((row) =>
        rootsOverlap(row.identity_key, resource.identity_key))) throw invalidTransition('资源仍被占用或隔离。');
      const disabled = await repositories.gateway.disableResource(resource.id);
      await repositories.workspaces.bumpAuthority(input.workspaceId);
      return { project_id: input.projectId, resource_id: disabled.id,
        revision: toDecimalString(disabled.revision), status: disabled.status };
    } });
}
