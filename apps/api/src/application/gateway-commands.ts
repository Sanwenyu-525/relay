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
import { COMPUTER_DESKTOP_TARGET } from '../computer/protocol.js';
import { GITHUB_READ_ACTION_TYPES } from '../github/github-adapter.js';
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
  allowedExecutables?: readonly string[] | undefined;
}): Promise<CommandOutcome<IdResult>> {
  if (input.capabilities.length === 0 || new Set(input.capabilities).size !== input.capabilities.length) {
    throw validationFailed([{ field: 'capabilities', message: 'must be a nonempty unique list' }]);
  }
  // REAL connections bind exactly one real-world boundary: FILE_READ one real
  // directory, WEB_FETCH one allowed host; other capabilities keep the empty
  // P09 config (no credentials stored).
  const config = await resolveConnectionConfig(input.capabilities, input.rootPath,
    input.allowedHost, input.allowPrivate, input.allowedExecutables);
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
  allowPrivate: boolean | undefined, allowedExecutables: readonly string[] | undefined,
): Promise<JsonObject | undefined> {
  const rootBoundCaps: GatewayCapability[] =
    ['FILE_READ', 'FILE_QUERY', 'FILE_WRITE', 'GIT_READ', 'GIT_WRITE', 'CLI_RUN'];
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
    // 没有 root-bound 能力就不可能挂得上 CLI_RUN，清单必须在此拒掉，
    // 否则会变成一个谁也读不到、谁也生效不了的死配置。
    await resolveAllowedExecutables(capabilities, allowedExecutables);
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
    const executables = await resolveAllowedExecutables(capabilities, allowedExecutables);
    return { root_path: await realpath(rootPath),
      // 未配置时不落这个键：既有连接行的 config 形状必须逐字不变。
      ...(executables === undefined ? {} : { allowed_executables: [...executables] }) };
  }
  if (rootPath !== undefined) {
    throw validationFailed([{ field: 'root_path', message: 'only filesystem connections bind a root' }]);
  }
  // WEB_FETCH 分支没有 CLI_RUN 可用，清单在此拒掉而不是静默丢弃。
  await resolveAllowedExecutables(capabilities, allowedExecutables);
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

/** 允许清单的条目上限；与检查的冻结清单一样按可枚举、可核对的口径设上限。 */
export const ALLOWED_EXECUTABLES_MAX = 32;

/**
 * CLI_RUN 连接上的可执行文件允许清单（plans/2026-10-05-cli-executable-admission.md）。
 *
 * 模型只**提出**一次检查的入口。根内脚本不需要配置；根外入口（包管理器、解释器、
 * 系统工具）必须由用户在这里点名，否则准入判定会拒绝。清单是用户授权的一部分，
 * 所以每一项都要在写入前实测存在且是可运行文件，并按 realpath 规范化存储——
 * 用户回读到的就是真正生效的那一份。
 *
 * 未配置（undefined）与配了空清单语义不同：空清单是一个没有意义的配置，
 * 存下来只会让人以为「配过了」，所以直接拒绝。
 */
export async function resolveAllowedExecutables(capabilities: readonly GatewayCapability[],
  entries: readonly string[] | undefined): Promise<readonly string[] | undefined> {
  if (entries === undefined) return undefined;
  const refuse = (message: string) => validationFailed([{ field: 'allowed_executables', message }]);
  // 清单只对 CLI_RUN 有意义；挂到别的能力上会让人误以为那项能力也受这份约束。
  if (!capabilities.includes('CLI_RUN')) {
    throw refuse('allowed_executables is only meaningful for a CLI_RUN connection');
  }
  if (entries.length === 0) throw refuse('allowed_executables must name at least one executable');
  if (entries.length > ALLOWED_EXECUTABLES_MAX) {
    throw refuse(`allowed_executables must name at most ${ALLOWED_EXECUTABLES_MAX} executables`);
  }
  const seen = new Set<string>();
  const resolved: string[] = [];
  for (const entry of entries) {
    const trimmed = entry.trim();
    if (trimmed === '') throw refuse('allowed_executables entries must be non-empty paths');
    if (!isAbsolute(trimmed)) throw refuse(`allowed_executables entry must be an absolute path: ${trimmed}`);
    let real: string;
    try {
      real = await realpath(trimmed);
    } catch {
      throw refuse(`allowed_executables entry does not exist: ${trimmed}`);
    }
    const stats = await stat(real);
    if (!stats.isFile()) throw refuse(`allowed_executables entry must be a file: ${trimmed}`);
    // Windows 上同一个文件的大小写写法必须折叠成一项，否则清单回读会多出重复行。
    const key = process.platform === 'win32' ? real.toLowerCase() : real;
    if (seen.has(key)) continue;
    seen.add(key);
    resolved.push(real);
  }
  return resolved;
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
  capability: GatewayCapability, resourceId: string | null, host: string | undefined,
  actionType?: string | undefined): Promise<{ actionType: string; targetPrefix: string }> {
  if (capability === 'FAKE_PUBLIC_READ') {
    if (resourceId !== null) throw validationFailed([{ field: 'resource_id', message: 'public read has no resource' }]);
    return { actionType: 'READ_PUBLIC', targetPrefix: 'https://public.example/' };
  }
  if (capability === 'WEB_FETCH') {
    if (resourceId !== null) throw validationFailed([{ field: 'resource_id', message: 'web fetch has no resource' }]);
    // WEB_FETCH policies match by URL host; the host is the web analogue of a path prefix.
    return { actionType: 'WEB_FETCH', targetPrefix: requireValidHost(host) };
  }
  if (capability === 'COMPUTER_READ' || capability === 'COMPUTER_INPUT') {
    // 0092: Computer 策略的目标是合成值 computer://desktop，不绑定受管根，
    // 因此 resource_id 可空（与 WEB_FETCH 同形）；动作类仍按词表收编。
    if (actionType !== undefined && !SUPPORTED_POLICY_ACTIONS[capability].includes(actionType)) {
      throw validationFailed([{ field: 'action_type',
        message: `unsupported action for ${capability}: ${SUPPORTED_POLICY_ACTIONS[capability].join(', ')}` }]);
    }
    return { actionType: actionType ?? defaultActionTypeOf(capability),
      targetPrefix: COMPUTER_DESKTOP_TARGET };
  }
  if (resourceId === null) throw validationFailed([{ field: 'resource_id', message: 'write permission requires a resource' }]);
  const resource = await repositories.gateway.readResource(resourceId);
  if (resource?.workspace_id !== workspaceId || resource.project_id !== projectId || resource.status !== 'ACTIVE') {
    throw resourceNotFound('Managed resource');
  }
  // 同一 capability 下不同 action_type 是**不同**的权限事实（读 diff 与读状态不是同一授权）。
  // 缺省仍取既有的单一默认动作，因此既有调用方与历史策略的判定不变。
  const derived = defaultActionTypeOf(capability);
  if (actionType !== undefined && actionType !== derived) {
    if (!SUPPORTED_POLICY_ACTIONS[capability].includes(actionType)) {
      throw validationFailed([{ field: 'action_type',
        message: `unsupported action for ${capability}: ${SUPPORTED_POLICY_ACTIONS[capability].join(', ')}` }]);
    }
    return { actionType, targetPrefix: resource.canonical_root };
  }
  return { actionType: derived, targetPrefix: resource.canonical_root };
}

/** 每个 capability 在 Permission 词表里可出现的 action_type。缺省动作见 defaultActionTypeOf。 */
const SUPPORTED_POLICY_ACTIONS: Record<GatewayCapability, readonly string[]> = {
  FAKE_WRITE: ['WRITE_MARKER'],
  FAKE_PUBLIC_READ: ['READ_PUBLIC'],
  FILE_READ: ['READ_FILE'],
  FILE_QUERY: ['LIST_DIRECTORY', 'FIND_PATHS', 'SEARCH_TEXT'],
  WEB_FETCH: ['WEB_FETCH'],
  FILE_WRITE: ['WRITE_FILE', 'APPLY_CHANGESET', 'READ_CHANGE_SET'],
  GIT_READ: ['GIT_STATUS', 'GIT_DIFF', 'GIT_LOG'],
  GIT_WRITE: ['GIT_STAGE', 'GIT_COMMIT', 'GIT_PUSH'],
  CLI_RUN: ['CLI_RUN', 'RUN_BUILD', 'RUN_TEST'],
  COMPUTER_READ: ['COMPUTER_SCREENSHOT', 'COMPUTER_GET_WINDOWS'],
  COMPUTER_INPUT: ['COMPUTER_ACTIVATE_WINDOW', 'COMPUTER_MOVE', 'COMPUTER_CLICK',
    'COMPUTER_DOUBLE_CLICK', 'COMPUTER_SCROLL', 'COMPUTER_DRAG', 'COMPUTER_TYPE',
    'COMPUTER_KEYPRESS', 'COMPUTER_HOTKEY'],
  // 0103: GitHub 只读四个动作。写动作不在词表内，因此也无法在这里被授权。
  GITHUB_READ: GITHUB_READ_ACTION_TYPES,
  // 0105: 浏览器三族。BROWSER_COMMIT 只有提交表单与上传文件两个动作，且永不免批；
  // 策略里出现它也只是「允许/询问/拒绝」，不会变成 AUTO 直通。
  BROWSER_READ: ['BROWSER_LIST_PAGES', 'BROWSER_READ_PAGE', 'BROWSER_SCREENSHOT', 'BROWSER_WAIT_FOR'],
  BROWSER_ACTION: ['BROWSER_NEW_PAGE', 'BROWSER_NAVIGATE', 'BROWSER_CLICK', 'BROWSER_FILL',
    'BROWSER_PRESS_KEY', 'BROWSER_CLOSE_PAGE'],
  BROWSER_COMMIT: ['BROWSER_SUBMIT_FORM', 'BROWSER_UPLOAD_FILE'],
};

function defaultActionTypeOf(capability: GatewayCapability): string {
  if (capability === 'FAKE_PUBLIC_READ') return 'READ_PUBLIC';
  if (capability === 'WEB_FETCH') return 'WEB_FETCH';
  if (capability === 'FILE_READ') return 'READ_FILE';
  if (capability === 'FILE_QUERY') return 'LIST_DIRECTORY';
  if (capability === 'FILE_WRITE') return 'APPLY_CHANGESET';
  if (capability === 'GIT_READ') return 'GIT_STATUS';
  if (capability === 'GIT_WRITE') return 'GIT_COMMIT';
  if (capability === 'CLI_RUN') return 'CLI_RUN';
  if (capability === 'COMPUTER_READ') return 'COMPUTER_SCREENSHOT';
  if (capability === 'COMPUTER_INPUT') return 'COMPUTER_CLICK';
  // 0103: 仓库身份是这份词表里唯一不需要参数的动作，缺省授权它等于「可以查这个仓库」。
  if (capability === 'GITHUB_READ') return 'GITHUB_REPO_VIEW';
  return 'WRITE_MARKER';
}

export async function createGatewayPolicyCommand(db: DbExecutor, input: {
  workspaceId: string; projectId: string; commandId: string; capability: GatewayCapability;
  resourceId: string | null; decision: GatewayDecision; maxPayloadBytes: number;
  host?: string | undefined;
  /** 可选：显式指定该 capability 下的 action_type（如 GIT_DIFF）。缺省沿用既有默认动作。 */
  actionType?: string | undefined;
}): Promise<CommandOutcome<IdResult>> {
  if (!Number.isInteger(input.maxPayloadBytes) || input.maxPayloadBytes < 0 || input.maxPayloadBytes > 262144) {
    throw validationFailed([{ field: 'max_payload_bytes', message: 'must be from 0 to 262144' }]);
  }
  return runIdempotentCommand(db, { scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId, commandType: 'CreateGatewayPolicy',
    target: { project_id: input.projectId }, body: { capability: input.capability,
      resource_id: input.resourceId, decision: input.decision, max_payload_bytes: input.maxPayloadBytes,
      ...(input.host === undefined ? {} : { host: input.host.toLowerCase() }),
      ...(input.actionType === undefined ? {} : { action_type: input.actionType }) },
    execute: async (repositories) => {
      await authorityWrite(repositories, input.workspaceId);
      await projectVisible(repositories, input.workspaceId, input.projectId);
      const scope = await policyScope(repositories, input.workspaceId, input.projectId,
        input.capability, input.resourceId, input.host, input.actionType);
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
  /** Optional explicit action_type; absent keeps the existing per-capability default. */
  actionType?: string | undefined;
}): Promise<CommandOutcome<IdResult>> {
  const expected = requireRevision(input.expectedRevision, 'expected_revision');
  return runIdempotentCommand(db, { scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId, commandType: 'AddGatewayPolicyVersion',
    target: { project_id: input.projectId, policy_id: input.policyId },
    body: { expected_revision: toDecimalString(expected), capability: input.capability,
      resource_id: input.resourceId, decision: input.decision, max_payload_bytes: input.maxPayloadBytes,
      ...(input.host === undefined ? {} : { host: input.host.toLowerCase() }),
      ...(input.actionType === undefined ? {} : { action_type: input.actionType }) },
    execute: async (repositories) => {
      await authorityWrite(repositories, input.workspaceId);
      const policy = await repositories.gateway.readPolicy(input.policyId);
      if (policy?.workspace_id !== input.workspaceId || policy.project_id !== input.projectId) throw resourceNotFound('Permission policy');
      await projectVisible(repositories, input.workspaceId, input.projectId);
      if (policy.revision !== expected) throw revisionConflict({ entityType: 'PERMISSION_POLICY',
        expectedRevision: toDecimalString(expected), actualRevision: toDecimalString(policy.revision) });
      const scope = await policyScope(repositories, input.workspaceId, input.projectId,
        input.capability, input.resourceId, input.host, input.actionType);
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

/**
 * 把「来源项目」已登记的连接、受管资源与 ACTIVE 权限策略复制到「目标项目」（2026-10-19）。
 *
 * 动机：连接与权限策略在数据模型上按项目登记（`gateway_connections.project_id` 等均为
 * `NOT NULL`），每开一个项目都要重配一遍。作用域本身是可审计性的收益，重复劳动不是——
 * 本命令把「沿用上次配置」变成一次可回执、可重放的操作，而不是把 `project_id` 改成可空
 * 去模糊化「这次动作是谁授权的」（那会破坏 authority 链与审计，见验收表 2026-10-19 行）。
 *
 * 复制规则（全部在同一个命令事务里完成，回执与业务事实同事务提交）：
 * - **受管资源**：按 `identity_key` 判重——目标项目已有同 identity 的 ACTIVE 资源则跳过，
 *   否则插入（`canonical_root` / `identity_key` / `file_write_root_id` 均取自来源行，
 *   不重新走文件系统探测：来源登记时已验证过目录存在）。
 * - **连接**：整行复制（`config` 含 root_path / allowed_host / allowed_executables 等，
 *   来源登记时已校验过边界存在）；目标项目已有 ACTIVE 且 config 与能力集合都相同的连接
 *   则跳过（连接没有自然键，这条判重只防「用户连点两次」类重复，不承诺语义幂等——
 *   真正的幂等由 command_id 回执承担）。
 * - **权限策略**：只复制 ACTIVE 策略的**当前生效版本**（capability / action_type /
 *   target_prefix / decision / max_payload_bytes 原样），目标项目已有同 capability +
 *   action_type + target_prefix 的 ACTIVE 策略则跳过。文件族策略的 target_prefix 是
 *   canonical_root，依赖上一步资源已就位；历史版本不复制——授权以当前生效版本为准。
 * - 只复制不删改：目标项目里已有的其它配置不受影响；来源项目只读。
 */
type CopyGatewaySettingsResult = {
  readonly project_id: string;
  readonly source_project_id: string;
  readonly resources_created: string;
  readonly connections_copied: string;
  readonly policies_copied: string;
  readonly skipped: string;
};

export async function copyGatewaySettingsCommand(db: DbExecutor, input: {
  workspaceId: string; sourceProjectId: string; targetProjectId: string; commandId: string;
}): Promise<CommandOutcome<CopyGatewaySettingsResult>> {
  if (input.sourceProjectId === input.targetProjectId) {
    throw validationFailed([{ field: 'source_project_id', message: 'source and target must differ' }]);
  }
  return runIdempotentCommand(db, { scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId, commandType: 'CopyGatewaySettings',
    target: { project_id: input.targetProjectId },
    body: { source_project_id: input.sourceProjectId },
    execute: async (repositories) => {
      await authorityWrite(repositories, input.workspaceId);
      await projectVisible(repositories, input.workspaceId, input.targetProjectId);
      await projectVisible(repositories, input.workspaceId, input.sourceProjectId);
      // 资源登记由同一把 advisory 事务锁串行（与 createManagedResourceCommand 相同），
      // 必须在读判重之前拿锁，否则两个并发复制可能同时通过判重。
      await repositories.gateway.lockResourceRegistry();

      let resourcesCreated = 0;
      let connectionsCopied = 0;
      let policiesCopied = 0;
      let skipped = 0;

      // 1) 受管资源：identity 判重后整行复制。
      const targetResources = await repositories.gateway.listProjectResources(input.workspaceId, input.targetProjectId);
      const sourceResources = (await repositories.gateway.listProjectResources(input.workspaceId, input.sourceProjectId))
        .filter((row) => row.status === 'ACTIVE');
      for (const source of sourceResources) {
        const existing = targetResources.some((row) => row.identity_key === source.identity_key && row.status === 'ACTIVE');
        if (existing) { skipped += 1; continue; }
        await repositories.gateway.insertResource({ id: randomUUID(),
          workspaceId: input.workspaceId, projectId: input.targetProjectId,
          canonicalRoot: source.canonical_root, identityKey: source.identity_key,
          fileWriteRootId: source.file_write_root_id });
        resourcesCreated += 1;
      }

      // 2) 连接：config 与能力集合都相同的 ACTIVE 连接视为已存在。
      const targetConnections = await repositories.gateway.listConnections(input.workspaceId, input.targetProjectId);
      const targetConnectionShapes = await Promise.all(targetConnections
        .filter((row) => row.status === 'ACTIVE')
        .map(async (row) => ({ config: JSON.stringify(row.config),
          capabilities: (await repositories.gateway.listConnectionCapabilities(row.id)).slice().sort() })));
      const sourceConnections = (await repositories.gateway.listConnections(input.workspaceId, input.sourceProjectId))
        .filter((row) => row.status === 'ACTIVE');
      for (const source of sourceConnections) {
        const capabilities = (await repositories.gateway.listConnectionCapabilities(source.id)).slice().sort();
        const duplicated = targetConnectionShapes.some((row) => row.config === JSON.stringify(source.config) &&
          row.capabilities.length === capabilities.length &&
          row.capabilities.every((capability, index) => capability === capabilities[index]));
        if (duplicated) { skipped += 1; continue; }
        const connection = await repositories.gateway.insertConnection({ id: randomUUID(),
          workspaceId: input.workspaceId, projectId: input.targetProjectId, config: source.config });
        for (const capability of capabilities) {
          await repositories.gateway.addConnectionCapability(connection.id, capability);
        }
        targetConnectionShapes.push({ config: JSON.stringify(source.config), capabilities });
        connectionsCopied += 1;
      }

      // 3) 权限策略：只复制 ACTIVE 策略的当前生效版本；同 capability+action+target 视为已存在。
      const sourcePolicies = (await repositories.gateway.listPolicies(input.workspaceId, input.sourceProjectId))
        .filter((row) => row.status === 'ACTIVE' && row.active_version !== null);
      for (const source of sourcePolicies) {
        const versions = await repositories.gateway.listPolicyVersions(source.id);
        const active = versions.find((version) => version.version === source.active_version);
        if (active === undefined) { skipped += 1; continue; }
        const existing = (await repositories.gateway.listActivePolicies(input.workspaceId, input.targetProjectId,
          active.capability_key, active.action_type))
          .some((row) => row.target_prefix === active.target_prefix);
        if (existing) { skipped += 1; continue; }
        await repositories.gateway.insertPolicy({ id: randomUUID(),
          workspaceId: input.workspaceId, projectId: input.targetProjectId,
          capability: active.capability_key, actionType: active.action_type,
          targetPrefix: active.target_prefix, decision: active.decision,
          maxPayloadBytes: Number(active.max_payload_bytes) });
        policiesCopied += 1;
      }

      if (resourcesCreated + connectionsCopied + policiesCopied > 0) {
        await repositories.workspaces.bumpAuthority(input.workspaceId);
      }
      return { project_id: input.targetProjectId, source_project_id: input.sourceProjectId,
        resources_created: String(resourcesCreated), connections_copied: String(connectionsCopied),
        policies_copied: String(policiesCopied), skipped: String(skipped) };
    } });
}
