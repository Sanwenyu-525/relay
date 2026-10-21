import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';

import type { DbExecutor } from '../infrastructure/database.js';
import type { GatewayCapability, GatewayDecision, LocalDirectoryAccessRow, LocalDirectoryWriteTier,
  ManagedResourceRow } from
  '../infrastructure/database-schema.js';
import type { JsonObject } from '../infrastructure/json.js';
import { runSafeGit } from '../git/git-adapter.js';
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
/**
 * Git 只读动作（2026-10-20，P1-3）。与文件读取同一条原则：显式选择目录就是授权读取，
 * Git 的历史与工作区状态属于同一个目录，因此不需要用户再手工建一条 GIT_READ 连接。
 * 只到这三项——stage/commit/push 仍必须单独授权，绝不随目录选择顺带开放。
 */
const GIT_READ_ACTIONS = ['GIT_STATUS', 'GIT_DIFF', 'GIT_LOG'] as const;

/** Git 只读的投影：状态、仓库根与一句人话。界面只读这里，不自己判断是否仓库。 */
export type LocalDirectoryGitReadState =
  /** 已配置或复用了本目录的 GIT_READ 连接与三条只读策略。 */
  | 'READY'
  /** 不是 Git 仓库（或本机没有可用的 git）：Git 工具不会出现在会话里。 */
  | 'NOT_A_REPOSITORY'
  /** 目录是某个仓库的子目录：Git 输出不是路径受限的，不按子目录授权。 */
  | 'REPO_ROOT_REQUIRED'
  /** 本目录的 Git 只读连接已被停用；重新打开目录不会替它恢复。 */
  | 'DISABLED'
  /** 此前明确设置或撤销过 Git 只读规则（含策略被撤销或改成拒绝）：不自动恢复，需人工确认。 */
  | 'REVIEW_REQUIRED'
  /** 目录未就绪（归档、停用、歧义），未做任何核对。 */
  | 'NOT_CHECKED';

/** Git 只读的投影：状态、仓库根与一句人话。界面只读这里，不自己判断是否仓库。
 *  用 type 别名（而非 interface）声明：命令结果必须可赋给 JsonObject。 */
export type LocalDirectoryGitRead = {
  readonly state: LocalDirectoryGitReadState;
  /** 识别到的仓库根（绝对路径）；不是仓库时为 null。 */
  readonly repo_root: string | null;
  readonly detail: string;
};

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

/** 两个绝对路径是否指向同一个受管根（大小写、分隔符与末尾斜杠不构成区别）。 */
function sameRoot(left: string, right: string): boolean {
  return canonicalResourceIdentity(left) === canonicalResourceIdentity(right);
}

/**
 * 用只读 git 探测仓库根。
 *
 * 失败一律折成 null，不向打开目录的用例抛错：目录不是仓库、本机没装 git、或 git 拒绝
 * 访问都是可说明的普通事实，不该让「打开文件夹」失败。这里刻意不走 `runReadOnlyGit`：
 * 后者会因仓库配置了 clean/process filter 而抛错，那是「读取内容」的顾虑，不是「这是不是
 * 仓库根」的顾虑。
 */
async function repositoryRoot(canonicalRoot: string): Promise<string | null> {
  const result = await runSafeGit(['rev-parse', '--show-toplevel'],
    { cwd: canonicalRoot, timeoutMs: 10_000 });
  const output = result.stdout.trim();
  if (result.exitCode !== 0 || output === '') return null;
  try { return await realpath(output); }
  catch { return null; }
}

/** 只找与目录根**精确相同**的 GIT_READ 连接：Git 的输出不是路径受限的，父目录的连接不能借用。 */
async function exactRootGitConnections(repositories: Repositories, workspaceId: string, projectId: string,
  canonicalRoot: string, status: 'ACTIVE' | 'DISABLED') {
  const connections = (await repositories.gateway.listConnections(workspaceId, projectId))
    .filter((connection) => connection.status === status &&
      typeof connection.config.root_path === 'string' &&
      sameRoot(connection.config.root_path, canonicalRoot));
  const rows = await Promise.all(connections.map(async (connection) => ({ connection,
    capabilities: await repositories.gateway.listConnectionCapabilities(connection.id) })));
  return rows.filter((row) => row.capabilities.includes('GIT_READ'));
}

/**
 * 三条 Git 只读策略是否仍然生效且不是拒绝。
 *
 * 「连接还在」不等于「还能读」：策略可以被单独撤销或改成 DENY，所以 READY 必须两条都成立。
 * 用与准入相同的 `rankActivePolicies` 排序，界面与服务端不会出现两套结论。
 */
async function gitPoliciesIntact(repositories: Repositories, workspaceId: string, projectId: string,
  canonicalRoot: string): Promise<boolean> {
  for (const actionType of GIT_READ_ACTIONS) {
    const policies = (await repositories.gateway.listActivePolicies(workspaceId, projectId,
      'GIT_READ', actionType)).filter((policy) =>
      targetMatches(policy.target_prefix, canonicalRoot, 'GIT_READ'));
    const selected = rankActivePolicies(policies);
    if (selected === undefined || selected.decision === 'DENY') return false;
  }
  return true;
}

/**
 * 让 Git 只读随「打开这个目录」自然成立（2026-10-20，P1-3）。
 *
 * 四条边界，都在这里而不是界面里：
 * 1. 只有打开的就是仓库根时才配置。子目录不配置：`git log` 会返回整个仓库的历史，
 *    按子目录授权等于把父目录的信息一并放出去；此时只报出仓库根，由用户在原处决定。
 * 2. 只建 GIT_READ 与 status/diff/log 三条 AUTO 策略。stage/commit/push 属于写动作，
 *    不因为「能读」而开放。
 * 3. 停用或撤销过的连接只如实报告，不新建一条绕过；此前显式设置/撤销过的规则同样不自动恢复。
 * 4. 不新增第二套授权：真正决定准入的仍是 gateway_connections 与策略行，这里只是替用户
 *    完成一次「等价于手工登记」的配置。
 */
async function ensureGitReadAccess(repositories: Repositories, input: {
  workspaceId: string; projectId: string; resource: ManagedResourceRow;
  access: LocalDirectoryAccessRow | undefined;
}): Promise<{ git: LocalDirectoryGitRead; connectionId: string | null;
  policyIds: Record<string, string>; changed: boolean }> {
  const { workspaceId, projectId, resource } = input;
  const canonicalRoot = resource.canonical_root;
  const inherited = input.access === undefined ? {} : policyIdsOf(input.access);
  const inheritedGitPolicies = Object.fromEntries(Object.entries(inherited)
    .filter(([action]) => (GIT_READ_ACTIONS as readonly string[]).includes(action)));
  const recordedId = input.access?.git_connection_id ?? null;
  const unchanged = (git: LocalDirectoryGitRead, policyIds = inheritedGitPolicies) =>
    ({ git, connectionId: recordedId, policyIds, changed: false });

  const repoRoot = await repositoryRoot(canonicalRoot);
  if (repoRoot === null) {
    return unchanged({ state: 'NOT_A_REPOSITORY', repo_root: null,
      detail: '这个目录不是 Git 仓库（或本机没有可用的 git）；会话里不会出现 Git 只读工具，文件读写不受影响。' });
  }
  if (!sameRoot(repoRoot, canonicalRoot)) {
    return unchanged({ state: 'REPO_ROOT_REQUIRED', repo_root: repoRoot,
      detail: `这个目录在 Git 仓库 ${repoRoot} 内。Git 的历史与分支状态不只属于这个子目录，` +
        '因此不按子目录授权；需要 Git 只读时，请在仓库根目录再打开一次。' });
  }

  // 已经记录过的连接：只复用或如实报告，不替换成新 ID。
  if (recordedId !== null) {
    const recorded = await repositories.gateway.readConnection(recordedId);
    if (recorded?.status === 'DISABLED') {
      return unchanged({ state: 'DISABLED', repo_root: repoRoot,
        detail: '这个目录的 Git 只读连接已停用；重新打开目录不会替它恢复。' });
    }
    if (recorded?.status === 'ACTIVE' && recorded.workspace_id === workspaceId &&
        recorded.project_id === projectId &&
        (await repositories.gateway.hasConnectionCapability(recorded.id, 'GIT_READ')) &&
        typeof recorded.config.root_path === 'string' && sameRoot(recorded.config.root_path, canonicalRoot)) {
      if (!(await gitPoliciesIntact(repositories, workspaceId, projectId, canonicalRoot))) {
        return unchanged({ state: 'REVIEW_REQUIRED', repo_root: repoRoot,
          detail: '这个目录的 Git 只读权限条目已被撤销或改为拒绝；重新打开目录不会替它恢复。' });
      }
      return unchanged({ state: 'READY', repo_root: repoRoot,
        detail: '这个目录的 Git 只读已就绪（status · diff · log）。' });
    }
  }

  const active = await exactRootGitConnections(repositories, workspaceId, projectId, canonicalRoot, 'ACTIVE');
  if (active[0] !== undefined) {
    const connectionId = active[0].connection.id;
    if (!(await gitPoliciesIntact(repositories, workspaceId, projectId, canonicalRoot))) {
      return unchanged({ state: 'REVIEW_REQUIRED', repo_root: repoRoot,
        detail: '这个目录的 Git 只读权限条目已被撤销或改为拒绝；重新打开目录不会替它恢复。' });
    }
    return { git: { state: 'READY', repo_root: repoRoot,
      detail: '这个目录的 Git 只读已就绪（status · diff · log）。' },
      connectionId, policyIds: inheritedGitPolicies,
      changed: connectionId !== recordedId };
  }
  const disabled = await exactRootGitConnections(repositories, workspaceId, projectId, canonicalRoot, 'DISABLED');
  if (disabled[0] !== undefined) {
    return unchanged({ state: 'DISABLED', repo_root: repoRoot,
      detail: '这个目录的 Git 只读连接已停用；重新打开目录不会替它恢复。' });
  }
  // 明确设置或撤销过的规则不自动恢复：与文件读取同一条原则，撤销必须是可留存的。
  for (const actionType of GIT_READ_ACTIONS) {
    const history = await repositories.gateway.listPolicyTargetHistory(workspaceId, projectId,
      'GIT_READ', actionType);
    if (history.some((target) => targetMatches(target, canonicalRoot, 'GIT_READ'))) {
      return unchanged({ state: 'REVIEW_REQUIRED', repo_root: repoRoot,
        detail: '这个目录的 Git 只读规则此前被明确设置或撤销过；重新打开目录不会自动恢复，需要你确认后再授权。' });
    }
  }

  const connectionId = await createFileConnection(repositories, workspaceId, projectId, canonicalRoot, ['GIT_READ']);
  const policyIds: Record<string, string> = { ...inheritedGitPolicies };
  for (const actionType of GIT_READ_ACTIONS) {
    if (policyIds[actionType] !== undefined) continue;
    policyIds[actionType] = await createPolicy(repositories, { workspaceId, projectId,
      canonicalRoot, capability: 'GIT_READ', actionType, decision: 'AUTO' });
  }
  return { git: { state: 'READY', repo_root: repoRoot,
    detail: '已随这个目录建立 Git 只读（status · diff · log）；提交与推送仍需单独授权。' },
    connectionId, policyIds, changed: true };
}

/**
 * Called only from the explicit OpenWorkingDirectory command. It records which ordinary
 * file settings the application owns; the active Gateway connection and policy rows still
 * decide every action. GETs and restored sessions never call this function.
 *
 * 2026-10-20：Git 只读也在这一步随目录成立（P1-3）。返回投影供打开目录的结果直接展示，
 * `changed` 表示这次是否真的写了新的管理指针（调用方据此 bump authority）。
 */
export async function ensureLocalDirectoryReadAccess(repositories: Repositories, input: {
  workspaceId: string; projectId: string; resource: ManagedResourceRow;
}): Promise<{ access: LocalDirectoryAccessRow; git: LocalDirectoryGitRead; changed: boolean }> {
  const existingAccess = await repositories.gateway.readLocalDirectoryAccess(input.resource.id);
  if (existingAccess !== undefined) {
    // 历史行也要补 Git 只读：不补的话，「重新打开一个旧目录」与「新开一个目录」行为不同。
    const git = await ensureGitReadAccess(repositories, { ...input, access: existingAccess });
    const merged = { ...policyIdsOf(existingAccess), ...git.policyIds };
    const samePolicyIds = Object.keys(merged).length === Object.keys(policyIdsOf(existingAccess)).length &&
      Object.entries(merged).every(([action, id]) => policyIdsOf(existingAccess)[action] === id);
    if (git.connectionId === existingAccess.git_connection_id && samePolicyIds) {
      return { access: existingAccess, git: git.git, changed: false };
    }
    const updated = await repositories.gateway.updateLocalDirectoryAccess({
      resourceId: input.resource.id, expectedRevision: existingAccess.revision,
      writeTier: existingAccess.write_tier, writeConnectionId: existingAccess.write_connection_id,
      gitConnectionId: git.connectionId, policyIds: merged });
    return { access: updated ?? existingAccess, git: git.git, changed: updated !== undefined };
  }

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

  const git = await ensureGitReadAccess(repositories, { workspaceId, projectId, resource,
    access: undefined });
  const access = await repositories.gateway.insertLocalDirectoryAccess({ resourceId: resource.id, writeTier,
    readConnectionId, writeConnectionId, gitConnectionId: git.connectionId,
    policyIds: { ...managedPolicyIds, ...git.policyIds } });
  return { access, git: git.git, changed: true };
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
        (await ensureLocalDirectoryReadAccess(repositories, { workspaceId: input.workspaceId,
          projectId: input.projectId, resource })).access;
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
        expectedRevision, writeTier: input.tier, writeConnectionId,
        gitConnectionId: access.git_connection_id, policyIds });
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
