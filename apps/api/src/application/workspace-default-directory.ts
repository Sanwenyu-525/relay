import { realpath, stat } from 'node:fs/promises';
import { basename } from 'node:path';

import type { DbExecutor } from '../infrastructure/database.js';
import type { LocalDirectoryWriteTier, ManagedResourceRow } from '../infrastructure/database-schema.js';
import type { JsonObject } from '../infrastructure/json.js';
import { toDecimalString } from '../shared/decimal.js';
import { httpCommandScopeKey } from './actor.js';
import { runIdempotentCommand, type CommandOutcome } from './command.js';
import { invalidTransition, resourceNotFound, revisionConflict } from './domain-error.js';
import { canonicalResourceIdentity, rootsOverlap } from './gateway-configuration.js';
import { requireWorkspace } from './guards.js';
import { requireRevision } from './revisions.js';
import { createRepositories, type Repositories } from './unit-of-work.js';

/** No registration or permission writes: a default is only a reference to an existing scope. */
async function directoryReason(repositories: Repositories, workspaceId: string,
  resource: ManagedResourceRow): Promise<string | null> {
  if (resource.workspace_id !== workspaceId) return 'RESOURCE_UNAVAILABLE';
  if (resource.status !== 'ACTIVE') return 'RESOURCE_DISABLED';
  const project = await repositories.projects.readProject(resource.project_id);
  if (project?.workspace_id !== workspaceId) return 'RESOURCE_UNAVAILABLE';
  if (project.archived_at !== null) return 'PROJECT_ARCHIVED';
  if ((await repositories.gateway.listResources()).some((other) => other.id !== resource.id &&
      other.workspace_id === workspaceId && other.status === 'ACTIVE' &&
      rootsOverlap(other.canonical_root, resource.canonical_root))) return 'RESOURCE_OVERLAP';
  try {
    const root = await realpath(resource.canonical_root);
    if (!(await stat(root)).isDirectory() ||
        canonicalResourceIdentity(root) !== canonicalResourceIdentity(resource.canonical_root)) {
      return 'DIRECTORY_IDENTITY_CHANGED';
    }
  } catch { return 'DIRECTORY_UNAVAILABLE'; }
  return null;
}

export async function readWorkspaceDefaultDirectory(db: DbExecutor, workspaceId: string): Promise<JsonObject> {
  const repositories = createRepositories(db);
  await requireWorkspace(repositories, workspaceId);
  const configured = await repositories.workspaces.readDefaultDirectory(workspaceId);
  const revision = toDecimalString(configured?.revision ?? 0n);
  const defaultWriteTier = configured?.default_write_tier ?? null;
  const empty = { resource_id: null, canonical_root: null, display_name: null, write_tier: null,
    default_write_tier: defaultWriteTier, status: 'UNSET', reason: null, revision };
  if (configured?.resource_id == null) return empty;
  const resource = await repositories.gateway.readResource(configured.resource_id);
  if (resource?.workspace_id !== workspaceId) {
    return { ...empty, status: 'UNAVAILABLE', reason: 'RESOURCE_UNAVAILABLE' };
  }
  const reason = await directoryReason(repositories, workspaceId, resource);
  const access = await repositories.gateway.readLocalDirectoryAccess(resource.id);
  return { resource_id: resource.id, canonical_root: resource.canonical_root,
    display_name: basename(resource.canonical_root) || resource.canonical_root,
    write_tier: access?.write_tier ?? 'READ_ONLY', default_write_tier: defaultWriteTier,
    status: reason === null ? 'READY' : 'UNAVAILABLE',
    reason, revision };
}

export async function setWorkspaceDefaultDirectory(db: DbExecutor, input: {
  workspaceId: string; commandId: string; expectedRevision: string; resourceId: string | null;
}): Promise<CommandOutcome<JsonObject>> {
  const revision = requireRevision(input.expectedRevision, 'expected_revision');
  return runIdempotentCommand(db, { scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId,
    commandType: input.resourceId === null ? 'ClearWorkspaceDefaultDirectory' : 'SetWorkspaceDefaultDirectory',
    target: { workspace_id: input.workspaceId },
    body: { expected_revision: toDecimalString(revision), resource_id: input.resourceId },
    execute: async (repositories) => {
      if (await repositories.workspaces.lockAuthority(input.workspaceId, 'update') === undefined) {
        throw resourceNotFound('Workspace');
      }
      // A concurrent identical first request may have committed while we waited. Let the
      // receipt uniqueness path roll this transaction back and compare the original payload.
      const committed = await repositories.receipts.findReceipt({
        scopeKey: httpCommandScopeKey(input.workspaceId), commandId: input.commandId });
      if (committed !== undefined) return committed.result_ref;
      const current = await repositories.workspaces.readDefaultDirectory(input.workspaceId);
      if ((current?.revision ?? 0n) !== revision) {
        // 打开目录可能已经顺手登记了同一个值：目标已达成的重放不是冲突。
        // 修订守卫要防的是「覆盖别人不同的选择」，不是「重复声明同一件事」。
        if ((current?.resource_id ?? null) === input.resourceId) {
          return { workspace_id: input.workspaceId, resource_id: current?.resource_id ?? null,
            revision: toDecimalString(current?.revision ?? 0n) };
        }
        throw revisionConflict({
          entityType: 'WORKSPACE_DEFAULT_DIRECTORY', expectedRevision: toDecimalString(revision),
          actualRevision: toDecimalString(current?.revision ?? 0n) });
      }
      if (input.resourceId !== null) {
        // Same lock order as OpenWorkingDirectory: authority, registry, project, resource.
        await repositories.gateway.lockResourceRegistry();
        const resource = await repositories.gateway.readResource(input.resourceId);
        if (resource?.workspace_id !== input.workspaceId) throw resourceNotFound('Managed resource');
        await repositories.projects.lockProjectArchiveGate(resource.project_id);
        await repositories.gateway.lockResource(resource.id);
        const reason = await directoryReason(repositories, input.workspaceId,
          (await repositories.gateway.readResource(resource.id))!);
        if (reason !== null) throw invalidTransition(`默认目录尚未就绪（${reason}），原设置未更改。`);
      }
      const saved = await repositories.workspaces.setDefaultDirectory(input.workspaceId, input.resourceId);
      return { workspace_id: input.workspaceId, resource_id: saved.resource_id,
        revision: toDecimalString(saved.revision) };
    } });
}

/**
 * 工作区级默认写档位（2026-10-22，DEV-0115）。
 *
 * 用户要的「什么时候都能选档位」落在这里：档位属于某个具体目录的写策略，没有目录就没有可写的对象，
 * 但「以后新开的目录按哪一档起步」这件事本来就与工作区同级，不需要先有目录才能决定。
 * 这条默认值只有一个作用点：`ensureLocalDirectoryReadAccess` **新建** `local_directory_access` 行时
 * 按它建写连接与三条写策略，与用户当时显式改档的命令同一画法（完全访问与自动批准在策略行上同为
 * AUTO，差别只在 `write_tier` 这一列）。已有目录的行不被改写，改了默认也不会回头动任何一个已绑定
 * 目录；被停用的写连接、核对不到的写身份、曾被明确撤销的写规则这三种情况一律跳过而不是绕过。
 * 因此「默认＝完全访问」的真实含义是：以后每新开一个目录，这一档就当场成立一次，删除不再逐次确认——
 * 界面必须把这句说出来，不把它写成一次普通的偏好保存。
 * 与默认目录共用同一行、同一个修订号：两处都是「这个工作区的默认」，一次 CAS 管住两次选择。
 */
export async function setWorkspaceDefaultWriteTier(db: DbExecutor, input: {
  workspaceId: string; commandId: string; expectedRevision: string; tier: LocalDirectoryWriteTier | null;
}): Promise<CommandOutcome<JsonObject>> {
  const revision = requireRevision(input.expectedRevision, 'expected_revision');
  return runIdempotentCommand(db, { scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId,
    commandType: 'SetWorkspaceDefaultWriteTier',
    target: { workspace_id: input.workspaceId },
    body: { expected_revision: toDecimalString(revision), default_write_tier: input.tier },
    execute: async (repositories) => {
      if (await repositories.workspaces.lockAuthority(input.workspaceId, 'update') === undefined) {
        throw resourceNotFound('Workspace');
      }
      const committed = await repositories.receipts.findReceipt({
        scopeKey: httpCommandScopeKey(input.workspaceId), commandId: input.commandId });
      if (committed !== undefined) return committed.result_ref;
      const current = await repositories.workspaces.readDefaultDirectory(input.workspaceId);
      if ((current?.revision ?? 0n) !== revision) {
        // 目标已达成的重放不是冲突：防的是覆盖别人不同的选择，不是重复声明同一件事。
        if ((current?.default_write_tier ?? null) === input.tier) {
          return { workspace_id: input.workspaceId, default_write_tier: current?.default_write_tier ?? null,
            revision: toDecimalString(current?.revision ?? 0n) };
        }
        throw revisionConflict({
          entityType: 'WORKSPACE_DEFAULT_DIRECTORY', expectedRevision: toDecimalString(revision),
          actualRevision: toDecimalString(current?.revision ?? 0n) });
      }
      const saved = await repositories.workspaces.setDefaultWriteTier(input.workspaceId, input.tier);
      return { workspace_id: input.workspaceId, default_write_tier: saved.default_write_tier,
        revision: toDecimalString(saved.revision) };
    } });
}

/**
 * 首次打开目录时登记为工作区默认目录（2026-10-19 用户要求「基础能力不该让开发者自己配置」）。
 *
 * 只在当前**没有**默认目录时写入：已有默认是用户的显式选择，打开另一个目录不覆盖它，
 * 也不因为读取失败改根。目录本身不满足默认条件（停用、归档、重叠、身份变化）时静默跳过——
 * 这条命令的语义是「打开目录」，不把「没设成默认」说成打开失败；真正不可用的原因仍由
 * `readWorkspaceDefaultDirectory` 的投影如实给出。
 *
 * 它不创建资源、不放宽档位：写仍按该目录自己的 `write_tier` 判定，绑定只是作用域。
 */
export async function ensureWorkspaceDefaultDirectory(repositories: Repositories,
  workspaceId: string, resource: ManagedResourceRow): Promise<boolean> {
  const configured = await repositories.workspaces.readDefaultDirectory(workspaceId);
  if (configured?.resource_id != null) return false;
  if (await directoryReason(repositories, workspaceId, resource) !== null) return false;
  await repositories.workspaces.setDefaultDirectory(workspaceId, resource.id);
  return true;
}

/** Called only while creating a new unscoped AGENT session, never from the read/tool path. */
export async function inheritWorkspaceDefaultDirectory(repositories: Repositories,
  workspaceId: string): Promise<ManagedResourceRow | undefined> {
  if (await repositories.workspaces.lockAuthority(workspaceId, 'share') === undefined) {
    throw resourceNotFound('Workspace');
  }
  const configured = await repositories.workspaces.readDefaultDirectory(workspaceId);
  if (configured?.resource_id == null) return undefined;
  await repositories.gateway.lockResourceRegistry();
  const snapshot = await repositories.gateway.readResource(configured.resource_id);
  if (snapshot?.workspace_id !== workspaceId) return undefined;
  await repositories.projects.lockProjectArchiveGate(snapshot.project_id);
  const resource = await repositories.gateway.lockResource(snapshot.id);
  return resource !== undefined && await directoryReason(repositories, workspaceId, resource) === null
    ? resource : undefined;
}
