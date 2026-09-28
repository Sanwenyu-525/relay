import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { Stats } from 'node:fs';

import type { DbExecutor } from '../infrastructure/database.js';
import type { GatewayCapability, GatewayDecision } from '../infrastructure/database-schema.js';
import type { JsonObject } from '../infrastructure/json.js';
import { toDecimalString } from '../shared/decimal.js';
import { httpCommandScopeKey } from './actor.js';
import { runIdempotentCommand, type CommandOutcome } from './command.js';
import { invalidTransition, resourceNotFound, revisionConflict, validationFailed } from './domain-error.js';
import { canonicalResourceIdentity, registrationFileWriteRootId, rootsOverlap } from './gateway-configuration.js';
import { lockWritableProjectInWorkspace } from './guards.js';
import { requireRevision } from './revisions.js';
import { createRepositories, type Repositories } from './unit-of-work.js';

type IdResult = { readonly project_id?: string; readonly connection_id?: string; readonly policy_id?: string;
  readonly resource_id?: string; readonly version?: string; readonly revision?: string;
  readonly status?: string; readonly canonical_root?: string };

async function authorityWrite(repositories: Repositories, workspaceId: string): Promise<void> {
  if (await repositories.workspaces.lockAuthority(workspaceId, 'update') === undefined) {
    throw resourceNotFound('Workspace authority');
  }
}

async function projectVisible(repositories: Repositories, workspaceId: string, projectId: string): Promise<void> {
  await lockWritableProjectInWorkspace(repositories, workspaceId, projectId);
}

export async function createGatewayConnectionCommand(db: DbExecutor, input: {
  workspaceId: string; projectId: string; commandId: string; capabilities: readonly GatewayCapability[];
  rootPath?: string | undefined; allowedHost?: string | undefined; allowPrivate?: boolean | undefined;
}): Promise<CommandOutcome<IdResult>> {
  if (input.capabilities.length === 0 || new Set(input.capabilities).size !== input.capabilities.length) {
    throw validationFailed([{ field: 'capabilities', message: 'must be a nonempty unique list' }]);
  }
  // REAL connections bind exactly one real-world boundary: FILE_READ one real
  // directory, WEB_FETCH one allowed host; other capabilities keep the empty
  // P09 config (no credentials stored).
  const config = await resolveConnectionConfig(input.capabilities, input.rootPath,
    input.allowedHost, input.allowPrivate);
  return runIdempotentCommand(db, { scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId, commandType: 'CreateGatewayConnection',
    target: { project_id: input.projectId },
    body: { capabilities: [...input.capabilities].sort(),
      ...(config === undefined ? {} : { ...config }) },
    execute: async (repositories) => {
      await authorityWrite(repositories, input.workspaceId);
      await projectVisible(repositories, input.workspaceId, input.projectId);
      const connection = await repositories.gateway.insertConnection({ id: randomUUID(),
        workspaceId: input.workspaceId, projectId: input.projectId,
        config: config === undefined ? {} : config });
      for (const capability of input.capabilities) await repositories.gateway.addConnectionCapability(connection.id, capability);
      await repositories.workspaces.bumpAuthority(input.workspaceId);
      return { project_id: input.projectId, connection_id: connection.id,
        version: toDecimalString(connection.version), status: connection.status };
    } });
}

async function resolveConnectionConfig(capabilities: readonly GatewayCapability[],
  rootPath: string | undefined, allowedHost: string | undefined,
  allowPrivate: boolean | undefined): Promise<JsonObject | undefined> {
  const rootBoundCaps: GatewayCapability[] = ['FILE_READ', 'FILE_WRITE', 'GIT_READ', 'GIT_WRITE', 'CLI_RUN'];
  const hasRootBound = capabilities.some((c) => rootBoundCaps.includes(c));
  const hasWebFetch = capabilities.includes('WEB_FETCH');
  if (hasRootBound && hasWebFetch) {
    throw validationFailed([{ field: 'capabilities',
      message: 'a REAL connection binds exactly one boundary; split filesystem and WEB_FETCH' }]);
  }
  if (!hasRootBound && !hasWebFetch) {
    if (rootPath !== undefined || allowedHost !== undefined || allowPrivate !== undefined) {
      throw validationFailed([{ field: 'root_path',
        message: 'only filesystem/WEB_FETCH connections bind a boundary' }]);
    }
    return undefined;
  }
  if (rootPath !== undefined && allowedHost !== undefined) {
    throw validationFailed([{ field: 'root_path',
      message: 'filesystem and WEB_FETCH boundaries are mutually exclusive' }]);
  }
  if (hasRootBound) {
    if (allowedHost !== undefined || allowPrivate !== undefined) {
      throw validationFailed([{ field: 'allowed_host', message: 'only WEB_FETCH connections bind a host' }]);
    }
    if (rootPath === undefined || !isAbsolute(rootPath)) {
      throw validationFailed([{ field: 'root_path', message: 'filesystem connections require an absolute root path' }]);
    }
    let stats: Stats;
    try {
      stats = await stat(rootPath);
    } catch {
      throw validationFailed([{ field: 'root_path', message: 'root path must be an existing directory' }]);
    }
    if (!stats.isDirectory()) {
      throw validationFailed([{ field: 'root_path', message: 'root path must be an existing directory' }]);
    }
    return { root_path: await realpath(rootPath) };
  }
  if (rootPath !== undefined) {
    throw validationFailed([{ field: 'root_path', message: 'only filesystem connections bind a root' }]);
  }
  // Only an explicit opt-IN is storable; allow_private=false is the default and
  // must not appear in the config (the SQL shape guard only accepts true).
  return { allowed_host: requireValidHost(allowedHost),
    ...(allowPrivate === true ? { allow_private: true } : {}) };
}

/** Allowed host is a syntactic DNS hostname stored lowercase; the web adapter
 * re-checks scheme and resolved addresses at prepare/execute time. */
function requireValidHost(host: string | undefined): string {
  if (host === undefined || host === '') {
    throw validationFailed([{ field: 'allowed_host', message: 'WEB_FETCH connections require an allowed host' }]);
  }
  const normalized = host.trim().toLowerCase();
  if (normalized.length > 253 ||
      !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/u.test(normalized)) {
    throw validationFailed([{ field: 'allowed_host', message: 'must be a DNS hostname without scheme, path or port' }]);
  }
  return normalized;
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
      await projectVisible(repositories, input.workspaceId, input.projectId);
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
  capability: GatewayCapability, resourceId: string | null, host: string | undefined):
  Promise<{ actionType: string; targetPrefix: string }> {
  if (capability === 'FAKE_PUBLIC_READ') {
    if (resourceId !== null) throw validationFailed([{ field: 'resource_id', message: 'public read has no resource' }]);
    return { actionType: 'READ_PUBLIC', targetPrefix: 'https://public.example/' };
  }
  if (capability === 'WEB_FETCH') {
    if (resourceId !== null) throw validationFailed([{ field: 'resource_id', message: 'web fetch has no resource' }]);
    // WEB_FETCH policies match by URL host; the host is the web analogue of a path prefix.
    return { actionType: 'WEB_FETCH', targetPrefix: requireValidHost(host) };
  }
  if (resourceId === null) throw validationFailed([{ field: 'resource_id', message: 'write permission requires a resource' }]);
  const resource = await repositories.gateway.readResource(resourceId);
  if (resource?.workspace_id !== workspaceId || resource.project_id !== projectId || resource.status !== 'ACTIVE') {
    throw resourceNotFound('Managed resource');
  }
  if (capability === 'FILE_READ') return { actionType: 'READ_FILE', targetPrefix: resource.canonical_root };
  if (capability === 'FILE_WRITE') return { actionType: 'APPLY_CHANGESET', targetPrefix: resource.canonical_root };
  if (capability === 'GIT_READ') return { actionType: 'GIT_STATUS', targetPrefix: resource.canonical_root };
  if (capability === 'GIT_WRITE') return { actionType: 'GIT_COMMIT', targetPrefix: resource.canonical_root };
  if (capability === 'CLI_RUN') return { actionType: 'CLI_RUN', targetPrefix: resource.canonical_root };
  return { actionType: 'WRITE_MARKER', targetPrefix: resource.canonical_root };
}

export async function createGatewayPolicyCommand(db: DbExecutor, input: {
  workspaceId: string; projectId: string; commandId: string; capability: GatewayCapability;
  resourceId: string | null; decision: GatewayDecision; maxPayloadBytes: number;
  host?: string | undefined;
}): Promise<CommandOutcome<IdResult>> {
  if (!Number.isInteger(input.maxPayloadBytes) || input.maxPayloadBytes < 0 || input.maxPayloadBytes > 262144) {
    throw validationFailed([{ field: 'max_payload_bytes', message: 'must be from 0 to 262144' }]);
  }
  return runIdempotentCommand(db, { scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId, commandType: 'CreateGatewayPolicy',
    target: { project_id: input.projectId }, body: { capability: input.capability,
      resource_id: input.resourceId, decision: input.decision, max_payload_bytes: input.maxPayloadBytes,
      ...(input.host === undefined ? {} : { host: input.host.toLowerCase() }) },
    execute: async (repositories) => {
      await authorityWrite(repositories, input.workspaceId);
      await projectVisible(repositories, input.workspaceId, input.projectId);
      const scope = await policyScope(repositories, input.workspaceId, input.projectId,
        input.capability, input.resourceId, input.host);
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
  decision: GatewayDecision; maxPayloadBytes: number; host?: string | undefined;
}): Promise<CommandOutcome<IdResult>> {
  const expected = requireRevision(input.expectedRevision, 'expected_revision');
  return runIdempotentCommand(db, { scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId, commandType: 'AddGatewayPolicyVersion',
    target: { project_id: input.projectId, policy_id: input.policyId },
    body: { expected_revision: toDecimalString(expected), capability: input.capability,
      resource_id: input.resourceId, decision: input.decision, max_payload_bytes: input.maxPayloadBytes,
      ...(input.host === undefined ? {} : { host: input.host.toLowerCase() }) },
    execute: async (repositories) => {
      await authorityWrite(repositories, input.workspaceId);
      const policy = await repositories.gateway.readPolicy(input.policyId);
      if (policy?.workspace_id !== input.workspaceId || policy.project_id !== input.projectId) throw resourceNotFound('Permission policy');
      await projectVisible(repositories, input.workspaceId, input.projectId);
      if (policy.revision !== expected) throw revisionConflict({ entityType: 'PERMISSION_POLICY',
        expectedRevision: toDecimalString(expected), actualRevision: toDecimalString(policy.revision) });
      const scope = await policyScope(repositories, input.workspaceId, input.projectId,
        input.capability, input.resourceId, input.host);
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
      await projectVisible(repositories, input.workspaceId, input.projectId);
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
  const scopeKey = httpCommandScopeKey(input.workspaceId);
  // A committed receipt must replay even if its directory has since moved. Native
  // inspection is outside the registration transaction and only runs for first use.
  const prior = await createRepositories(db).receipts.findReceipt({ scopeKey,
    commandId: input.commandId });
  let prepared: { root: string; fileWriteRootId: string | null } | undefined;
  if (prior === undefined) {
    let root: string;
    try { root = await realpath(input.rootPath); }
    catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        throw validationFailed([{ field: 'root_path', message: 'must be an existing directory' }]);
      }
      throw error;
    }
    if (!(await stat(root)).isDirectory()) throw validationFailed([{ field: 'root_path', message: 'must be an existing directory' }]);
    const fileWriteRootId = await registrationFileWriteRootId(root);
    prepared = { root, fileWriteRootId };
  }
  return runIdempotentCommand(db, { scopeKey,
    commandId: input.commandId, commandType: 'CreateManagedResource',
    target: { project_id: input.projectId }, body: { root_path: input.rootPath },
    execute: async (repositories) => {
      if (prepared === undefined) throw new Error('Managed resource receipt disappeared during replay');
      const { root, fileWriteRootId } = prepared;
      const key = canonicalResourceIdentity(root);
      await authorityWrite(repositories, input.workspaceId);
      await projectVisible(repositories, input.workspaceId, input.projectId);
      await repositories.gateway.lockResourceRegistry();
      if ((await repositories.gateway.listResources()).some((row) =>
        row.project_id === input.projectId && row.identity_key === key && row.status === 'ACTIVE')) {
        throw invalidTransition('同一 Project 已登记该实际目录。');
      }
      const resource = await repositories.gateway.insertResource({ id: randomUUID(),
        workspaceId: input.workspaceId, projectId: input.projectId, canonicalRoot: root,
        identityKey: key, fileWriteRootId });
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
      await projectVisible(repositories, input.workspaceId, input.projectId);
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
