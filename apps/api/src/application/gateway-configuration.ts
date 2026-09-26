import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import type { DbExecutor } from '../infrastructure/database.js';
import type { GatewayCapability, GatewayDecision } from '../infrastructure/database-schema.js';
import type { JsonObject } from '../infrastructure/json.js';
import { DomainError, invalidTransition, resourceNotFound, validationFailed } from './domain-error.js';
import { lockWritableProjectInWorkspace } from './guards.js';
import { withTransaction } from './unit-of-work.js';

function gatewayConflict(code: string, detail: string): DomainError {
  return new DomainError({ code, status: 409, type: `/problems/${code.toLowerCase().replaceAll('_', '-')}`,
    title: 'Gateway 事实冲突', detail, retryable: false, retryAction: 'REFRESH_AND_REDECIDE' });
}

export function canonicalResourceIdentity(path: string): string {
  const normalized = resolve(path);
  return process.platform === 'win32' ? normalized.replaceAll('/', '\\').toLowerCase() : normalized;
}

/** Uses an already resolved directory identity. Symlink aliases are resolved by realpath. */
export function rootsOverlap(a: string, b: string): boolean {
  const left = canonicalResourceIdentity(a);
  const right = canonicalResourceIdentity(b);
  const leftToRight = relative(left, right);
  const rightToLeft = relative(right, left);
  return leftToRight === '' || rightToLeft === '' ||
    (!leftToRight.startsWith(`..${sep}`) && leftToRight !== '..' && !isAbsolute(leftToRight)) ||
    (!rightToLeft.startsWith(`..${sep}`) && rightToLeft !== '..' && !isAbsolute(rightToLeft));
}

async function lockWritableAuthority(repositories: Parameters<Parameters<typeof withTransaction>[1]>[0], workspaceId: string): Promise<void> {
  if (await repositories.workspaces.lockAuthority(workspaceId, 'update') === undefined) throw resourceNotFound('Workspace authority');
}

export async function createFakeConnection(db: DbExecutor, input: {
  readonly workspaceId: string; readonly projectId: string;
  readonly capabilities: readonly GatewayCapability[]; readonly config?: JsonObject;
}): Promise<{ readonly connectionId: string; readonly version: string }> {
  if (input.capabilities.length === 0 || new Set(input.capabilities).size !== input.capabilities.length) {
    throw validationFailed([{ field: 'capabilities', message: 'must be a nonempty unique capability list' }]);
  }
  if (Object.keys(input.config ?? {}).length !== 0) throw validationFailed([
    { field: 'config', message: 'P09 Fake Connection config must be empty; no credentials are stored' },
  ]);
  return withTransaction(db, async (repositories) => {
    await lockWritableAuthority(repositories, input.workspaceId);
    await lockWritableProjectInWorkspace(repositories, input.workspaceId, input.projectId);
    const connection = await repositories.gateway.insertConnection({ id: randomUUID(), workspaceId: input.workspaceId,
      projectId: input.projectId, config: input.config ?? {} });
    for (const capability of input.capabilities) await repositories.gateway.addConnectionCapability(connection.id, capability);
    await repositories.workspaces.bumpAuthority(input.workspaceId);
    return { connectionId: connection.id, version: connection.version.toString() };
  });
}

export async function setFakeConnection(db: DbExecutor, input: {
  readonly workspaceId: string; readonly connectionId: string;
  readonly status: 'ACTIVE' | 'DISABLED'; readonly config: JsonObject;
}): Promise<{ readonly version: string }> {
  if (Object.keys(input.config).length !== 0) throw validationFailed([
    { field: 'config', message: 'P09 Fake Connection config must be empty; no credentials are stored' },
  ]);
  return withTransaction(db, async (repositories) => {
    await lockWritableAuthority(repositories, input.workspaceId);
    const current = await repositories.gateway.readConnection(input.connectionId);
    if (current?.workspace_id !== input.workspaceId) throw resourceNotFound('Connection');
    await lockWritableProjectInWorkspace(repositories, input.workspaceId, current.project_id);
    const changed = await repositories.gateway.setConnection({ id: current.id, status: input.status, config: input.config });
    await repositories.workspaces.bumpAuthority(input.workspaceId);
    return { version: changed.version.toString() };
  });
}

export async function createGatewayPolicy(db: DbExecutor, input: {
  readonly workspaceId: string; readonly projectId: string;
  readonly capability: GatewayCapability; readonly actionType: string;
  readonly targetPrefix: string; readonly decision: GatewayDecision;
  readonly maxPayloadBytes: number;
}): Promise<{ readonly policyId: string; readonly version: string }> {
  if (!input.actionType || !input.targetPrefix || !Number.isInteger(input.maxPayloadBytes) ||
      input.maxPayloadBytes < 0 || input.maxPayloadBytes > 262144) {
    throw validationFailed([{ field: 'policy', message: 'invalid action, target prefix or size limit' }]);
  }
  return withTransaction(db, async (repositories) => {
    await lockWritableAuthority(repositories, input.workspaceId);
    await lockWritableProjectInWorkspace(repositories, input.workspaceId, input.projectId);
    const policy = await repositories.gateway.insertPolicy({ id: randomUUID(), workspaceId: input.workspaceId,
      projectId: input.projectId, capability: input.capability, actionType: input.actionType,
      targetPrefix: input.targetPrefix, decision: input.decision, maxPayloadBytes: input.maxPayloadBytes });
    await repositories.workspaces.bumpAuthority(input.workspaceId);
    return { policyId: policy.id, version: '1' };
  });
}

export async function replaceGatewayPolicy(db: DbExecutor, input: {
  readonly workspaceId: string; readonly policyId: string; readonly capability: GatewayCapability;
  readonly actionType: string; readonly targetPrefix: string; readonly decision: GatewayDecision;
  readonly maxPayloadBytes: number;
}): Promise<{ readonly version: string }> {
  return withTransaction(db, async (repositories) => {
    await lockWritableAuthority(repositories, input.workspaceId);
    const policy = await repositories.gateway.readPolicy(input.policyId);
    if (policy?.workspace_id !== input.workspaceId) throw resourceNotFound('Permission policy');
    await lockWritableProjectInWorkspace(repositories, input.workspaceId, policy.project_id);
    const next = (await repositories.gateway.latestPolicyVersion(policy.id)) + 1n;
    await repositories.gateway.insertPolicyVersion({ policyId: policy.id, version: next,
      capability: input.capability, actionType: input.actionType, targetPrefix: input.targetPrefix,
      decision: input.decision, maxPayloadBytes: input.maxPayloadBytes });
    await repositories.gateway.activatePolicyVersion(policy.id, next);
    await repositories.workspaces.bumpAuthority(input.workspaceId);
    return { version: next.toString() };
  });
}

export async function revokeGatewayPolicy(db: DbExecutor, input: {
  readonly workspaceId: string; readonly policyId: string;
}): Promise<void> {
  await withTransaction(db, async (repositories) => {
    await lockWritableAuthority(repositories, input.workspaceId);
    const policy = await repositories.gateway.readPolicy(input.policyId);
    if (policy?.workspace_id !== input.workspaceId) throw resourceNotFound('Permission policy');
    await lockWritableProjectInWorkspace(repositories, input.workspaceId, policy.project_id);
    if (policy.status === 'REVOKED') return;
    await repositories.gateway.revokePolicy(policy.id);
    await repositories.workspaces.bumpAuthority(input.workspaceId);
  });
}

/** Registration serializes all roots, including those owned by another Workspace. */
export async function registerManagedResource(db: DbExecutor, input: {
  readonly workspaceId: string; readonly projectId: string; readonly rootPath: string;
}): Promise<{ readonly resourceId: string; readonly canonicalRoot: string }> {
  const canonicalRoot = await realpath(input.rootPath);
  if (!(await stat(canonicalRoot)).isDirectory()) throw validationFailed([{ field: 'root_path', message: 'must be an existing directory' }]);
  return withTransaction(db, async (repositories) => {
    await lockWritableAuthority(repositories, input.workspaceId);
    await lockWritableProjectInWorkspace(repositories, input.workspaceId, input.projectId);
    await repositories.gateway.lockResourceRegistry();
    const existing = await repositories.gateway.listResources();
    if (existing.some((row) => row.project_id === input.projectId && row.identity_key === canonicalResourceIdentity(canonicalRoot))) {
      throw gatewayConflict('RESOURCE_ROOT_DUPLICATE', '该 Project 已登记相同的实际目录。');
    }
    const row = await repositories.gateway.insertResource({ id: randomUUID(), workspaceId: input.workspaceId,
      projectId: input.projectId, canonicalRoot, identityKey: canonicalResourceIdentity(canonicalRoot) });
    await repositories.workspaces.bumpAuthority(input.workspaceId);
    return { resourceId: row.id, canonicalRoot: row.canonical_root };
  });
}

export async function disableManagedResource(db: DbExecutor, input: {
  readonly workspaceId: string; readonly resourceId: string;
}): Promise<void> {
  await withTransaction(db, async (repositories) => {
    await lockWritableAuthority(repositories, input.workspaceId);
    const resource = await repositories.gateway.lockResource(input.resourceId);
    if (resource?.workspace_id !== input.workspaceId) throw resourceNotFound('Managed resource');
    await lockWritableProjectInWorkspace(repositories, input.workspaceId, resource.project_id);
    if (resource.status === 'DISABLED') return;
    await repositories.gateway.lockResourceRegistry();
    if ((await repositories.gateway.listOccupiedResources()).some((row) =>
      rootsOverlap(row.identity_key, resource.identity_key))) {
      throw gatewayConflict('RESOURCE_OCCUPIED', '重叠资源仍处于 HELD 或 QUARANTINED，不能停用。');
    }
    await repositories.gateway.disableResource(resource.id);
    await repositories.workspaces.bumpAuthority(input.workspaceId);
  });
}

export async function createImportJob(db: DbExecutor, input: {
  readonly workspaceId: string; readonly projectId: string; readonly actorRef: string;
  readonly configVersion: string; readonly sourceUri: string; readonly commandId: string;
}): Promise<{ readonly importJobId: string }> {
  if (!input.actorRef || !input.configVersion || !input.sourceUri.startsWith('https://public.example/')) {
    throw invalidTransition('P09 Fake 用户导入只接受显式用户主体与固定公共 Fake 来源。');
  }
  return withTransaction(db, async (repositories) => {
    await lockWritableProjectInWorkspace(repositories, input.workspaceId, input.projectId);
    const job = await repositories.gateway.insertImportJob({ id: randomUUID(), workspaceId: input.workspaceId,
      projectId: input.projectId, actorRef: input.actorRef, configVersion: input.configVersion,
      sourceUri: input.sourceUri, commandId: input.commandId });
    return { importJobId: job.id };
  });
}
