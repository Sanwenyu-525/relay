import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';

import type { DbExecutor } from '../infrastructure/database.js';
import type { GatewayCapability, GatewayDecision, LocalDirectoryAccessRow, LocalDirectoryWriteTier,
  ManagedResourceRow } from
  '../infrastructure/database-schema.js';
import type { JsonObject } from '../infrastructure/json.js';
import { toDecimalString } from '../shared/decimal.js';
import { canonicalResourceIdentity, registrationFileWriteRootId } from './gateway-configuration.js';
import { rankActivePolicies, targetMatches } from './gateway-actions.js';
import { httpCommandScopeKey } from './actor.js';
import { runIdempotentCommand, type CommandOutcome } from './command.js';
import { invalidTransition, resourceNotFound, revisionConflict, validationFailed } from './domain-error.js';
import { lockWritableProjectInWorkspace, requireWorkspace } from './guards.js';
import { requireRevision } from './revisions.js';
import { createRepositories, type Repositories } from './unit-of-work.js';

export type { LocalDirectoryWriteTier };

const MAX_POLICY_PAYLOAD_BYTES = 262144;
const READ_ACTIONS: readonly { capability: 'FILE_READ' | 'FILE_QUERY'; actionType: string }[] = [
  { capability: 'FILE_READ', actionType: 'READ_FILE' },
  { capability: 'FILE_QUERY', actionType: 'LIST_DIRECTORY' },
  { capability: 'FILE_QUERY', actionType: 'FIND_PATHS' },
  { capability: 'FILE_QUERY', actionType: 'SEARCH_TEXT' },
];
const WRITE_ACTIONS = ['WRITE_FILE', 'APPLY_CHANGESET', 'READ_CHANGE_SET'] as const;

function policyIdsOf(access: LocalDirectoryAccessRow): Record<string, string> {
  return Object.fromEntries(Object.entries(access.policy_ids)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

function matchingRoot(config: JsonObject, canonicalRoot: string, capability: GatewayCapability): boolean {
  return typeof config.root_path === 'string' && targetMatches(config.root_path, canonicalRoot, capability);
}

async function connectionCapabilities(repositories: Repositories, connectionId: string) {
  return repositories.gateway.listConnectionCapabilities(connectionId);
}

async function matchingConnections(repositories: Repositories, workspaceId: string, projectId: string,
  canonicalRoot: string, capability: GatewayCapability, status: 'ACTIVE' | 'DISABLED') {
  const connections = (await repositories.gateway.listConnections(workspaceId, projectId))
    .filter((connection) => connection.status === status &&
      matchingRoot(connection.config, canonicalRoot, capability));
  const rows = await Promise.all(connections.map(async (connection) => ({ connection,
    capabilities: await connectionCapabilities(repositories, connection.id) })));
  return rows.filter((row) => row.capabilities.includes(capability));
}

async function createFileConnection(repositories: Repositories, workspaceId: string, projectId: string,
  canonicalRoot: string, capabilities: readonly GatewayCapability[]): Promise<string> {
  const connection = await repositories.gateway.insertConnection({ id: randomUUID(), workspaceId,
    projectId, config: { root_path: canonicalRoot } });
  for (const capability of capabilities) {
    await repositories.gateway.addConnectionCapability(connection.id, capability);
  }
  return connection.id;
}

async function createPolicy(repositories: Repositories, input: { workspaceId: string; projectId: string;
  canonicalRoot: string; capability: GatewayCapability; actionType: string;
  decision: GatewayDecision }): Promise<string> {
  const policy = await repositories.gateway.insertPolicy({ id: randomUUID(),
    workspaceId: input.workspaceId, projectId: input.projectId,
    capability: input.capability, actionType: input.actionType, targetPrefix: input.canonicalRoot,
    decision: input.decision, maxPayloadBytes: MAX_POLICY_PAYLOAD_BYTES });
  return policy.id;
}

/**
 * Called only from the explicit OpenWorkingDirectory command. It records which ordinary
 * file settings the application owns; the active Gateway connection and policy rows still
 * decide every action. GETs and restored sessions never call this function.
 */
export async function ensureLocalDirectoryReadAccess(repositories: Repositories, input: {
  workspaceId: string; projectId: string; resource: ManagedResourceRow;
}): Promise<LocalDirectoryAccessRow> {
  const existingAccess = await repositories.gateway.readLocalDirectoryAccess(input.resource.id);
  if (existingAccess !== undefined) return existingAccess;

  const { workspaceId, projectId, resource } = input;
  const readConnections = await matchingConnections(repositories, workspaceId, projectId,
    resource.canonical_root, 'FILE_READ', 'ACTIVE');
  const readConnection = readConnections.find((row) => row.capabilities.includes('FILE_QUERY'));
  let readConnectionId = readConnection?.connection.id;
  if (readConnectionId === undefined) {
    const disabled = await matchingConnections(repositories, workspaceId, projectId,
      resource.canonical_root, 'FILE_READ', 'DISABLED');
    const disabledQuery = await matchingConnections(repositories, workspaceId, projectId,
      resource.canonical_root, 'FILE_QUERY', 'DISABLED');
    if (disabled.length > 0 || disabledQuery.length > 0) {
      throw invalidTransition('这个目录的读取连接已停用；重新选择目录不会替它恢复。');
    }
    readConnectionId = await createFileConnection(repositories, workspaceId, projectId,
      resource.canonical_root, ['FILE_READ', 'FILE_QUERY']);
  }

  const managedPolicyIds: Record<string, string> = {};
  for (const action of READ_ACTIONS) {
    const policies = (await repositories.gateway.listActivePolicies(workspaceId, projectId,
      action.capability, action.actionType)).filter((policy) =>
      targetMatches(policy.target_prefix, resource.canonical_root, action.capability));
    if (rankActivePolicies(policies) !== undefined) continue;
    const historicalTargets = await repositories.gateway.listPolicyTargetHistory(workspaceId, projectId,
      action.capability, action.actionType);
    if (historicalTargets.some((target) =>
      targetMatches(target, resource.canonical_root, action.capability))) {
      throw invalidTransition('这个目录的读取规则曾被明确设置或撤销；重新打开不会恢复读取。请先明确重新授权后再试。');
    }
    const policyId = await createPolicy(repositories, { workspaceId, projectId,
      canonicalRoot: resource.canonical_root,
      capability: action.capability, actionType: action.actionType, decision: 'AUTO' });
    managedPolicyIds[action.actionType] = policyId;
  }

  const writeConnections = await matchingConnections(repositories, workspaceId, projectId,
    resource.canonical_root, 'FILE_WRITE', 'ACTIVE');
  const writeConnectionId = writeConnections[0]?.connection.id ?? null;
  const writePolicies = (await repositories.gateway.listActivePolicies(workspaceId, projectId,
    'FILE_WRITE', 'APPLY_CHANGESET')).filter((policy) =>
    targetMatches(policy.target_prefix, resource.canonical_root, 'FILE_WRITE'));
  const selectedWrite = rankActivePolicies(writePolicies);
  const writeTier: LocalDirectoryWriteTier = selectedWrite?.decision === 'ASK' ? 'ASK'
    : selectedWrite?.decision === 'AUTO' ? 'AUTO' : 'READ_ONLY';

  return repositories.gateway.insertLocalDirectoryAccess({ resourceId: resource.id, writeTier,
    readConnectionId, writeConnectionId, policyIds: managedPolicyIds });
}

async function validateRoot(resource: ManagedResourceRow): Promise<void> {
  let root: string;
  try { root = await realpath(resource.canonical_root); }
  catch { throw invalidTransition('目录已不存在或无法核对真实路径；没有更改本目录权限。'); }
  if (!(await stat(root)).isDirectory() ||
      canonicalResourceIdentity(root) !== canonicalResourceIdentity(resource.canonical_root)) {
    throw invalidTransition('目录真实身份已变化；没有更改本目录权限。');
  }
  const rootId = await registrationFileWriteRootId(root);
  if (rootId === null || resource.file_write_root_id !== rootId) {
    throw invalidTransition('该目录无法核对 Windows 写身份；不能设置写入权限。');
  }
}

async function writeConnectionForTier(repositories: Repositories, input: {
  workspaceId: string; projectId: string; resource: ManagedResourceRow;
  access: LocalDirectoryAccessRow; tier: LocalDirectoryWriteTier;
}): Promise<string | null> {
  if (input.tier === 'READ_ONLY') return input.access.write_connection_id;
  const { resource, workspaceId, projectId } = input;
  if (input.access.write_connection_id !== null) {
    const recorded = await repositories.gateway.readConnection(input.access.write_connection_id);
    if (recorded?.status === 'DISABLED') {
      throw invalidTransition('这个目录的文件写入连接已停用；不能创建新连接绕过停用状态。');
    }
    if (recorded?.status === 'ACTIVE' && recorded.workspace_id === workspaceId &&
        recorded.project_id === projectId &&
        (await repositories.gateway.hasConnectionCapability(recorded.id, 'FILE_WRITE')) &&
        matchingRoot(recorded.config, resource.canonical_root, 'FILE_WRITE')) return recorded.id;
  }
  const active = await matchingConnections(repositories, workspaceId, projectId,
    resource.canonical_root, 'FILE_WRITE', 'ACTIVE');
  if (active[0] !== undefined) return active[0].connection.id;
  const disabled = await matchingConnections(repositories, workspaceId, projectId,
    resource.canonical_root, 'FILE_WRITE', 'DISABLED');
  if (disabled.length > 0) {
    throw invalidTransition('这个目录的文件写入连接已停用；不能创建新连接绕过停用状态。');
  }
  return createFileConnection(repositories, workspaceId, projectId, resource.canonical_root,
    ['FILE_WRITE']);
}

export async function setLocalDirectoryWriteTier(db: DbExecutor, input: {
  workspaceId: string; projectId: string; resourceId: string; commandId: string;
  expectedRevision: string; tier: LocalDirectoryWriteTier;
}): Promise<CommandOutcome<JsonObject>> {
  if (!['READ_ONLY', 'ASK', 'AUTO', 'FULL'].includes(input.tier)) {
    throw validationFailed([{ field: 'write_tier', message: 'must be READ_ONLY, ASK, AUTO, or FULL' }]);
  }
  const expectedRevision = requireRevision(input.expectedRevision, 'expected_revision');
  const scopeKey = httpCommandScopeKey(input.workspaceId);
  const resourceSnapshot = await createRepositories(db).gateway.readResource(input.resourceId);
  if (resourceSnapshot?.workspace_id !== input.workspaceId || resourceSnapshot.project_id !== input.projectId) {
    throw resourceNotFound('Managed resource');
  }
  // A committed receipt is historical truth. Only first execution needs the current physical root.
  const prior = await createRepositories(db).receipts.findReceipt({ scopeKey, commandId: input.commandId });
  if (prior === undefined) await validateRoot(resourceSnapshot);

  return runIdempotentCommand<JsonObject>(db, { scopeKey,
    commandId: input.commandId, commandType: 'SetLocalDirectoryWriteTier',
    target: { project_id: input.projectId, resource_id: input.resourceId },
    body: { expected_revision: toDecimalString(expectedRevision), write_tier: input.tier,
      canonical_root: resourceSnapshot.canonical_root },
    execute: async (repositories) => {
      if (await repositories.workspaces.lockAuthority(input.workspaceId, 'update') === undefined) {
        throw resourceNotFound('Workspace authority');
      }
      await requireWorkspace(repositories, input.workspaceId);
      await lockWritableProjectInWorkspace(repositories, input.workspaceId, input.projectId);
      const resource = await repositories.gateway.lockResource(input.resourceId);
      if (resource?.workspace_id !== input.workspaceId || resource.project_id !== input.projectId) {
        throw resourceNotFound('Managed resource');
      }
      if (resource.status !== 'ACTIVE') throw invalidTransition('受管目录已停用，不能修改目录权限。');
      if (resource.canonical_root !== resourceSnapshot.canonical_root ||
          resource.file_write_root_id !== resourceSnapshot.file_write_root_id) {
        throw invalidTransition('目录根身份在设置期间发生变化；没有修改权限。');
      }
      const access = await repositories.gateway.readLocalDirectoryAccess(resource.id, true) ??
        await ensureLocalDirectoryReadAccess(repositories, { workspaceId: input.workspaceId,
          projectId: input.projectId, resource });
      if (access.revision !== expectedRevision) {
        throw revisionConflict({ entityType: 'LOCAL_DIRECTORY_ACCESS',
          expectedRevision: toDecimalString(expectedRevision), actualRevision: toDecimalString(access.revision) });
      }

      const writeConnectionId = await writeConnectionForTier(repositories, { workspaceId: input.workspaceId,
        projectId: input.projectId, resource, access, tier: input.tier });
      const policyIds = policyIdsOf(access);
      // FULL writes the same AUTO policy row as AUTO: GatewayDecision has no fourth value, so
      // the difference lives only in write_tier and is re-read by admission on every decision.
      const decision: GatewayDecision = input.tier === 'READ_ONLY' ? 'DENY'
        : input.tier === 'ASK' ? 'ASK' : 'AUTO';
      for (const actionType of WRITE_ACTIONS) {
        const previousPolicyId = policyIds[actionType];
        const previousPolicy = previousPolicyId === undefined
          ? undefined : await repositories.gateway.readPolicy(previousPolicyId);
        if (previousPolicy?.workspace_id === input.workspaceId && previousPolicy.project_id === input.projectId &&
            previousPolicy.status === 'ACTIVE') {
          const version = (await repositories.gateway.latestPolicyVersion(previousPolicy.id)) + 1n;
          await repositories.gateway.insertPolicyVersion({ policyId: previousPolicy.id, version,
            capability: 'FILE_WRITE', actionType, targetPrefix: resource.canonical_root,
            decision, maxPayloadBytes: MAX_POLICY_PAYLOAD_BYTES });
          await repositories.gateway.activatePolicyVersion(previousPolicy.id, version);
        } else {
          policyIds[actionType] = await createPolicy(repositories, { workspaceId: input.workspaceId,
            projectId: input.projectId, canonicalRoot: resource.canonical_root,
            capability: 'FILE_WRITE', actionType, decision });
        }
      }
      const updated = await repositories.gateway.updateLocalDirectoryAccess({ resourceId: resource.id,
        expectedRevision, writeTier: input.tier, writeConnectionId, policyIds });
      if (updated === undefined) {
        const current = await repositories.gateway.readLocalDirectoryAccess(resource.id);
        throw revisionConflict({ entityType: 'LOCAL_DIRECTORY_ACCESS',
          expectedRevision: toDecimalString(expectedRevision),
          actualRevision: toDecimalString(current?.revision ?? 0n) });
      }
      await repositories.workspaces.bumpAuthority(input.workspaceId);
      return { project_id: input.projectId, resource_id: resource.id, write_tier: updated.write_tier,
        revision: toDecimalString(updated.revision) };
    } });
}
