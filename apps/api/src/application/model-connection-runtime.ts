import { CredentialStoreError, type CredentialStore } from '../credentials/credential-store.js';
import { defaultCredentialStore } from '../credentials/default-credential-store.js';
import type { DbExecutor } from '../infrastructure/database.js';
import type { ModelConnectionRow, SessionModelSelectionRow } from '../infrastructure/database-schema.js';
import type { ModelFetchDependencies } from '../workflow/model-endpoint-policy.js';
import { OpenAiCompatibleModelPort, type ModelCallBudget } from
  '../workflow/openai-compatible-model-port.js';
import { compareCredentialIdentity, readCredentialFingerprint } from '../workflow/credential-identity.js';
import { WorkspaceDefaultModelConnectionRepository } from '../model/model-connection-repository.js';
import { computeModelConfigFingerprint, type ModelPortConfig } from '../workflow/model-port-config.js';
import { freezeAssistModelSnapshot, freezeSingleCandidatePlan, readAssistContextBudget,
  type FrozenAssistModelPlan } from './assist-model-snapshot.js';
import { DomainError } from './domain-error.js';
import type { Repositories } from './unit-of-work.js';

/**
 * 连接 → 模型配置的运行时解析（ADR-036 阶段三）。
 *
 * 这是**唯一一处**把「一行连接 + 库里的秘密」变成 `ModelPortConfig` 的地方。冻结端与执行端
 * 都调它，因此两边算出的配置指纹必然一致——如果各写一份，任何字段顺序或默认值差异都会让
 * 执行端把一次合法冻结判成「配置已变」，然后所有 Run 一起停。
 */

/**
 * 连接行 + 秘密 → 与进程配置同形的 `ModelPortConfig`。
 *
 * `base_url` 为空表示使用内置默认端点（与 `RELAY_MODEL_BASE_URL` 缺省同义），因此传
 * `undefined` 而不是空串——空串会被 `parseModelBaseUrl` 拒绝，等于把「用默认端点」变成配置错误。
 */
export function modelPortConfigFromConnection(row: ModelConnectionRow, apiKey: string):
ModelPortConfig {
  return {
    provider: 'openai-compatible',
    model: row.default_model,
    apiKey,
    baseUrl: row.base_url ?? undefined,
    timeoutMs: row.timeout_ms,
    maxOutputTokens: row.max_output_tokens,
    maxCallTokens: row.max_call_tokens,
    maxScopeCalls: row.max_scope_calls,
    maxScopeTokens: row.max_scope_tokens,
  };
}

export function connectionConfigFingerprint(row: ModelConnectionRow): string {
  // 指纹只看 Provider/型号/端点/预算，不看密钥：换 Key 走凭据身份（`credential_fingerprint`），
  // 换端点或预算走配置指纹。两个维度分开，才能各自给出可操作的停止原因。
  return computeModelConfigFingerprint(modelPortConfigFromConnection(row, 'fingerprint-probe'));
}

/** 解析连接引用的秘密。返回 undefined 表示「库里没有」（未配置，不是故障）。 */
export async function resolveConnectionApiKey(credentials: CredentialStore,
  row: ModelConnectionRow): Promise<string | undefined> {
  try {
    return await credentials.resolve(row.credential_ref);
  } catch (error) {
    throw credentialStoreFailure(error instanceof CredentialStoreError ? error.code : 'UNKNOWN');
  }
}

export function credentialStoreFailure(code: string): DomainError {
  return new DomainError({
    code: 'MODEL_CREDENTIAL_STORE_UNAVAILABLE',
    status: 503,
    type: '/problems/model-credential-store-unavailable',
    title: '凭据存储不可用',
    detail: `系统凭据库无法读写（${code}）；本次执行未发起任何模型调用。`,
    retryable: true,
    retryAction: 'CHECK_RECEIPT_THEN_RETRY',
  });
}

export interface FrozenConnectionPlan {
  readonly plan: FrozenAssistModelPlan;
  readonly connectionId: string;
  readonly credentialVersion: number;
}

/**
 * 按工作区默认连接冻结 Run 的模型计划；没有默认连接时返回 undefined（调用方走进程默认）。
 *
 * 这里**不**做「连接不可用就退回进程默认」：默认连接是用户的显式选择，退回等于偷偷换模型。
 * 连接被停用或凭据丢失时直接抛类型化错误，让 Delegate 失败在用户面前。
 */
export async function freezeWorkspaceConnectionPlan(repositories: Repositories, input: {
  readonly workspaceId: string;
  /** 缺省用进程默认存储；**只有真的存在默认连接时才去构造它**（构造会校验存放根）。 */
  readonly credentials?: CredentialStore | undefined;
  readonly requirements: { readonly requiresTools: boolean; readonly requiresJsonOutput: boolean };
}): Promise<FrozenConnectionPlan | undefined> {
  const defaultRow = await repositories.modelConnections.readDefault(input.workspaceId);
  if (defaultRow === undefined || defaultRow.connection_id === null) return undefined;
  const connection = await repositories.modelConnections.read(input.workspaceId,
    defaultRow.connection_id);
  if (connection === undefined) {
    // 默认指向一条本工作区已不可见的连接：这是数据不一致，不能猜一条替代品。
    throw new DomainError({
      code: 'MODEL_CONNECTION_UNAVAILABLE', status: 409,
      type: '/problems/model-connection-unavailable', title: '默认模型连接不可用',
      detail: '工作区默认模型连接已不存在；请重新设置默认连接后再委派。',
      retryable: false, retryAction: 'REFRESH_AND_REDECIDE',
    });
  }
  if (connection.status !== 'ACTIVE') {
    throw new DomainError({
      code: 'MODEL_CONNECTION_DISABLED', status: 409,
      type: '/problems/model-connection-disabled', title: '默认模型连接已停用',
      detail: `默认连接「${connection.name}」已停用，不会用它发起新的模型调用；`
        + '请启用该连接或改设另一条为默认。',
      retryable: false, retryAction: 'REFRESH_AND_REDECIDE',
    });
  }
  // 存储在这里才构造：没有默认连接的工作区（绝大多数测试与旧部署）不该因为
  // 「凭据存放根没配」而连委派都做不了——那是把可选能力变成全局前置条件。
  const apiKey = await resolveConnectionApiKey(connectionCredentials(input.credentials), connection);
  if (apiKey === undefined || apiKey.trim() === '') {
    throw new DomainError({
      code: 'MODEL_CONNECTION_CREDENTIAL_MISSING', status: 409,
      type: '/problems/model-connection-credential-missing', title: '默认连接缺少凭据',
      detail: `默认连接「${connection.name}」在系统凭据库里没有可用凭据；`
        + '请重新填写该连接的 API Key 后再委派。',
      retryable: false, retryAction: 'REFRESH_AND_REDECIDE',
    });
  }
  const config = modelPortConfigFromConnection(connection, apiKey);
  const workspaceTokens = await readWorkspaceContextBudget(repositories, input.workspaceId);
  return {
    plan: freezeSingleCandidatePlan(config, input.requirements, workspaceTokens),
    connectionId: connection.id,
    credentialVersion: connection.credential_version,
  };
}

/** 工作区上下文预算档位：与 `freezeAssistModelSnapshot` 同一读法，保证预算口径一致。 */
async function readWorkspaceContextBudget(repositories: Repositories,
  workspaceId: string): Promise<number | null> {
  const configured = await repositories.workspaces.readDefaultDirectory(workspaceId);
  return configured?.context_budget_tokens ?? null;
}

/** 进程默认凭据存储（测试可注入替代）。 */
export function connectionCredentials(override?: CredentialStore | undefined): CredentialStore {
  return override ?? defaultCredentialStore();
}

/** 便捷：读工作区默认连接行（供状态展示与执行端诊断）。 */
export async function readDefaultConnection(db: DbExecutor, workspaceId: string):
Promise<{ readonly connectionId: string; readonly revision: bigint } | undefined> {
  const row = await new WorkspaceDefaultModelConnectionRepository(db).read(workspaceId);
  return row === undefined || row.connection_id === null
    ? undefined : { connectionId: row.connection_id, revision: row.revision };
}

/** 工作区聊天默认连接（0158）。`null` 表示未设置，聊天沿用进程默认。 */
export async function readChatDefaultConnection(db: DbExecutor, workspaceId: string):
Promise<{ readonly connectionId: string | null; readonly revision: bigint | null }> {
  const row = await new WorkspaceDefaultModelConnectionRepository(db).read(workspaceId);
  return { connectionId: row?.chat_connection_id ?? null,
    revision: row === undefined ? null : row.revision };
}

/**
 * 聊天消息实际绑定的连接（显式会话选择之外的兜底）。
 *
 * 只在**没有**显式会话选择时调用：工作区聊天默认连接优先于进程默认。连接不可见或已停用
 * 时抛类型化错误，绝不退回进程默认——那等于在用户不知情时换了 Provider。
 */
export async function resolveChatDefaultSelection(repositories: Repositories,
  workspaceId: string): Promise<{ readonly connectionId: string; readonly model: string;
    readonly configFingerprint: string } | undefined> {
  const defaults = await repositories.modelConnections.readDefault(workspaceId);
  const connectionId = defaults?.chat_connection_id ?? null;
  if (connectionId === null) return undefined;
  const row = await repositories.modelConnections.read(workspaceId, connectionId);
  if (row === undefined) {
    throw new DomainError({
      code: 'MODEL_CONNECTION_UNAVAILABLE', status: 409,
      type: '/problems/model-connection-unavailable', title: '聊天默认连接不可用',
      detail: '工作区聊天默认连接已不存在；请在设置里重新指定聊天默认连接，或改回内置默认。',
      retryable: false, retryAction: 'REFRESH_AND_REDECIDE',
    });
  }
  if (row.status !== 'ACTIVE') {
    throw new DomainError({
      code: 'MODEL_CONNECTION_DISABLED', status: 409,
      type: '/problems/model-connection-disabled', title: '聊天默认连接已停用',
      detail: `聊天默认连接「${row.name}」已停用，不会用它发起新的模型调用；`
        + '请启用该连接、改设聊天默认，或在设置里取消聊天默认。',
      retryable: false, retryAction: 'REFRESH_AND_REDECIDE',
    });
  }
  return { connectionId: row.id, model: row.default_model,
    configFingerprint: connectionConfigFingerprint(row) };
}

/**
 * 聊天请求的模型冻结（消息受理事务内调用）。
 *
 * 优先级：显式会话选择 > 工作区聊天默认连接 > 进程默认。三者都走同一份快照形状与预算
 * 口径；连接路径额外把连接身份放进计划（`connectionId`），执行端据此解析。
 *
 * 与 Run 的 `freezeWorkspaceConnectionPlan` 刻意分开：聊天的默认连接**不**参与 Run 冻结，
 * 反之亦然。两条默认各自作用域，混用会让「这个 Run 为什么用了这个模型」无法回答。
 */
export async function freezeChatModelSnapshot(repositories: Repositories,
  selection: SessionModelSelectionRow | undefined, env: NodeJS.ProcessEnv,
  requirements: { readonly requiresTools: boolean; readonly requiresJsonOutput: boolean },
  scope: { readonly workspaceId: string; readonly sessionId?: string | null },
  credentials?: CredentialStore | undefined): Promise<FrozenAssistModelPlan | undefined> {
  const explicit = selection === undefined ? undefined
    : await connectionSelectionOf(selection);
  const effective = explicit ?? (selection === undefined
    ? await resolveChatDefaultSelection(repositories, scope.workspaceId) : undefined);
  if (effective === undefined) {
    return freezeAssistModelSnapshot(repositories, selection, env, requirements, scope);
  }
  const row = await repositories.modelConnections.read(scope.workspaceId, effective.connectionId);
  if (row === undefined) throw new DomainError({ code: 'MODEL_CONNECTION_UNAVAILABLE', status: 409,
    type: '/problems/model-connection-unavailable', title: '模型连接不可用',
    detail: '这条会话选择的模型连接已不在当前工作区；请重新选择模型。',
    retryable: false, retryAction: 'REFRESH_AND_REDECIDE' });
  if (row.status !== 'ACTIVE') throw new DomainError({ code: 'MODEL_CONNECTION_DISABLED', status: 409,
    type: '/problems/model-connection-disabled', title: '模型连接已停用',
    detail: `模型连接「${row.name}」已停用，不会用它发起新的模型调用；`
      + '请启用该连接或在会话中重新选择模型。',
    retryable: false, retryAction: 'REFRESH_AND_REDECIDE' });
  // 选择与冻结之间连接被改过：按配置变更处理，不拿新配置冒充当时的冻结身份。
  if (row.default_model !== effective.model ||
      connectionConfigFingerprint(row) !== effective.configFingerprint) {
    throw new DomainError({
      code: 'ASSIST_MODEL_CONFIG_CHANGED', status: 409,
      type: '/problems/assist-model-config-changed', title: '模型配置已变更',
      detail: `模型连接「${row.name}」的型号或配置在选择之后被修改过；`
        + '请重新选择模型后再发送。',
      retryable: false, retryAction: 'REFRESH_AND_REDECIDE',
    });
  }
  const apiKey = await resolveConnectionApiKey(connectionCredentials(credentials), row);
  if (apiKey === undefined || apiKey.trim() === '') {
    throw new DomainError({ code: 'MODEL_CONNECTION_CREDENTIAL_MISSING', status: 409,
      type: '/problems/model-connection-credential-missing', title: '模型连接缺少凭据',
      detail: `模型连接「${row.name}」在系统凭据库里没有可用凭据；`
        + '请在设置里重新填写该连接的 API Key。',
      retryable: false, retryAction: 'REFRESH_AND_REDECIDE' });
  }
  const config = modelPortConfigFromConnection(row, apiKey);
  const workspaceTokens = await readAssistContextBudget(repositories, scope);
  const plan = freezeSingleCandidatePlan(config, requirements, workspaceTokens);
  return { ...plan, connectionId: row.id };
}

/**
 * 会话选择行里与连接解析相关的部分。`registered` 之外的两种选择不经过连接表，
 * 返回 undefined 由既有路径处理。
 */
async function connectionSelectionOf(selection: SessionModelSelectionRow):
Promise<{ readonly connectionId: string; readonly model: string;
  readonly configFingerprint: string } | undefined> {
  if (selection.connection !== 'registered') return undefined;
  if (selection.connection_id === null) throw new Error('ASSIST_MODEL_SNAPSHOT_INVALID');
  return { connectionId: selection.connection_id, model: selection.model,
    configFingerprint: selection.config_fingerprint };
}

/**
 * 执行端按**消息冻结的连接身份**解析端口（聊天、子 Agent、上下文压缩共用）。
 *
 * 五道闸门，任一不符即停（与 Run 的 `resolveFrozenConnection` 同一套判据）：
 * 连接仍可见 → 仍 ACTIVE → 型号与配置指纹未变 → 凭据仍在 → 凭据身份未变。
 * 停就是停：不退回进程默认、不换连接、不换 Key。错误码用 `ASSIST_MODEL_*` 前缀，
 * 由 `readAssistModelRouteStopCode` 原样落到消息行，用户能看到精确停因。
 */
export async function resolveFrozenChatConnectionPort(repositories: Repositories, input: {
  readonly workspaceId: string;
  readonly connectionId: string;
  readonly frozenModel: string;
  readonly frozenConfigFingerprint: string;
  readonly frozenCredentialFingerprint: string | null;
  readonly budget: ModelCallBudget;
  readonly transport?: ModelFetchDependencies | undefined;
  readonly credentials?: CredentialStore | undefined;
}): Promise<OpenAiCompatibleModelPort> {
  const row = await repositories.modelConnections.read(input.workspaceId, input.connectionId);
  if (row === undefined) throw new Error('ASSIST_MODEL_CONNECTION_UNAVAILABLE');
  if (row.status !== 'ACTIVE') throw new Error('ASSIST_MODEL_CONNECTION_DISABLED');
  if (row.default_model !== input.frozenModel ||
      connectionConfigFingerprint(row) !== input.frozenConfigFingerprint) {
    throw new Error('ASSIST_MODEL_CONFIG_CHANGED');
  }
  let apiKey: string | undefined;
  try {
    apiKey = await resolveConnectionApiKey(connectionCredentials(input.credentials), row);
  } catch (error) {
    if (error instanceof DomainError && error.code === 'MODEL_CREDENTIAL_STORE_UNAVAILABLE') {
      throw new Error('ASSIST_MODEL_CREDENTIAL_STORE_UNAVAILABLE');
    }
    throw error;
  }
  if (apiKey === undefined || apiKey.trim() === '') {
    throw new Error('ASSIST_MODEL_CONNECTION_CREDENTIAL_MISSING');
  }
  const config = modelPortConfigFromConnection(row, apiKey);
  // 换 Key 之后旧消息不能悄悄转用新凭据：配额、限流与计费归属都会变。
  if (compareCredentialIdentity(input.frozenCredentialFingerprint,
    readCredentialFingerprint(config)) === 'CHANGED') {
    throw new Error('ASSIST_MODEL_CREDENTIAL_CHANGED');
  }
  return new OpenAiCompatibleModelPort(config, input.transport ?? {}, undefined, input.budget);
}
