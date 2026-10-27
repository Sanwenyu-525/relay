import { CredentialStoreError, type CredentialStore } from '../credentials/credential-store.js';
import { defaultCredentialStore } from '../credentials/default-credential-store.js';
import type { DbExecutor } from '../infrastructure/database.js';
import type { ModelConnectionRow } from '../infrastructure/database-schema.js';
import { WorkspaceDefaultModelConnectionRepository } from '../model/model-connection-repository.js';
import { computeModelConfigFingerprint, type ModelPortConfig } from '../workflow/model-port-config.js';
import { freezeSingleCandidatePlan, type FrozenAssistModelPlan } from './assist-model-snapshot.js';
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
  if (defaultRow === undefined) return undefined;
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
  return row === undefined ? undefined : { connectionId: row.connection_id, revision: row.revision };
}
