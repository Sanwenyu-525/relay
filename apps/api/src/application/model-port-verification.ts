import { createHash, randomUUID } from 'node:crypto';

import type { DbExecutor } from '../infrastructure/database.js';
import type { CredentialStore } from '../credentials/credential-store.js';
import { CredentialStoreError } from '../credentials/credential-store.js';
import { ModelCallRepository } from '../model/model-call-repository.js';
import { ModelProviderCooldownRepository } from '../model/model-provider-cooldown-repository.js';
import type { ModelUsage } from '../workflow/fake-model-port.js';
import { computeModelConfigFingerprint, type ModelPortConfig } from
  '../workflow/model-port-config.js';
import { accountCooldownKey, compareCredentialIdentity, readCredentialFingerprint } from
  '../workflow/credential-identity.js';
import { classifyVerifyError, resolveVerifyTargetConfig, ModelVerifyTargetError,
  VERIFY_PROMPT, VERIFY_TIMEOUT_MS, verifyResultFromRow,
  type ModelVerificationState, type ModelVerifyResult, type VerifyCallPort } from
  '../workflow/model-port-verify.js';
import { DEFAULT_VERIFY_TARGET, describeVerifyTarget, describeVerifyTargetState,
  type VerifyTarget } from '../workflow/model-verify-target.js';
import { readModelCatalogConfig } from '../workflow/model-catalog-config.js';
import { readAdmission, requireNormalAdmission } from './maintenance-admission.js';
import { connectionCredentials, modelPortConfigFromConnection } from
  './model-connection-runtime.js';
import { createRepositories } from './unit-of-work.js';

export interface RunModelPortVerificationInput {
  readonly db: DbExecutor;
  readonly workspaceId: string;
  readonly env: NodeJS.ProcessEnv;
  readonly call: VerifyCallPort;
  readonly now?: () => Date;
  /** P1-4：验证目标；缺省为进程默认连接。OpenRouter 目录型号使用独立凭据与零价探针。 */
  readonly target?: VerifyTarget | undefined;
  /** 0158：验证已登记连接时解析其系统凭据库引用；缺省用进程默认存储。 */
  readonly credentials?: CredentialStore | undefined;
}

/**
 * 已登记连接的验证配置解析（0158）。
 *
 * 型号、端点与预算都取连接行本身——不允许客户端另报型号，否则会造出「连接 A 的凭据跑
 * 型号 B」的验证结果。凭据只从系统凭据库解析，既不读进程环境变量，也不回退其他连接；
 * 缺失或存储不可用都在外呼前显式拒绝，不写一行看起来像「已验证」的账本。
 */
async function resolveRegisteredVerifyTarget(db: DbExecutor, credentials: CredentialStore | undefined,
  workspaceId: string, connectionId: string): Promise<ModelPortConfig> {
  const repository = createRepositories(db);
  const row = await repository.modelConnections.read(workspaceId, connectionId);
  if (row === undefined) {
    throw new ModelVerifyTargetError('MODEL_VERIFY_CONNECTION_UNAVAILABLE',
      'model connection is not visible in this workspace');
  }
  // MODEL-SETTINGS-03（P0-3）：停用连接不得被探测。
  //
  // 这里必须在任何记账与外呼之前拒绝：停用是用户的显式决定，为它发一次请求会让
  // 「已停用」在账本上产生一条新的 VERIFY 结论，也会真的花用户的额度。零外呼、零新账本。
  if (row.status !== 'ACTIVE') {
    throw new ModelVerifyTargetError('MODEL_VERIFY_CONNECTION_DISABLED',
      'model connection is disabled; no provider call is allowed for a disabled connection');
  }
  let apiKey: string | undefined;
  try {
    apiKey = await connectionCredentials(credentials).resolve(row.credential_ref);
  } catch (error) {
    if (error instanceof CredentialStoreError) {
      throw new ModelVerifyTargetError('MODEL_VERIFY_CREDENTIAL_STORE_UNAVAILABLE',
        `credential store is unavailable (${error.code})`);
    }
    throw error;
  }
  if (apiKey === undefined || apiKey.trim() === '') {
    throw new ModelVerifyTargetError('MODEL_VERIFY_CREDENTIAL_MISSING',
      'model connection has no stored credential');
  }
  return modelPortConfigFromConnection(row, apiKey);
}

/** Reserve new VERIFY work under the admission gate; network and settlement drain normally. */
/**
 * 探测前的免费资格确认（P1-4）：目录快照必须新鲜，且该型号在快照里是免费 + 文本输入输出。
 * 任一不成立就按目标侧拒绝——不探测、不记账、不冒充「已验证」。
 */
async function assertFreeTargetEligible(db: DbExecutor, model: string,
  env: NodeJS.ProcessEnv): Promise<void> {
  const catalogConfig = readModelCatalogConfig(env);
  const repository = createRepositories(db);
  const sync = await repository.modelCatalog.readSyncState();
  if (catalogConfig === undefined || sync.last_success_at === null ||
      Date.now() - sync.last_success_at.getTime() >= catalogConfig.cacheTtlMs) {
    throw new ModelVerifyTargetError('MODEL_VERIFY_CATALOG_STALE',
      'model catalog is stale; free eligibility cannot be confirmed for this probe');
  }
  const entry = await repository.modelCatalog.readEntryBySourceModelId(model);
  if (entry === undefined || !entry.is_free ||
      entry.capabilities.text_input !== true || entry.capabilities.text_output !== true) {
    throw new ModelVerifyTargetError('MODEL_VERIFY_TARGET_NOT_ELIGIBLE',
      'target model is not a free text model in the current catalog snapshot');
  }
}

export async function runModelPortVerification(
  input: RunModelPortVerificationInput,
): Promise<ModelVerifyResult> {
  const target = input.target ?? DEFAULT_VERIFY_TARGET;
  // 已登记连接：凭据与配置来自连接行 + 系统凭据库，不经进程环境；其余目标沿用原解析。
  const resolved = target.connection === 'registered'
    ? { config: await resolveRegisteredVerifyTarget(input.db, input.credentials,
      input.workspaceId, target.connectionId), guard: undefined }
    : resolveVerifyTargetConfig(input.env, target);
  const config = resolved.config;
  const configFingerprint = computeModelConfigFingerprint(config);
  // 免费目录型号在探测前先确认「此刻仍然是可探测的免费文本型号」：目录过期或资格变化时
  // 不发起可能计费的探针，也不写一行看起来像「已验证」的账本。
  if (target.connection === 'openrouter') {
    await assertFreeTargetEligible(input.db, target.model, input.env);
  }
  const now = input.now ?? (() => new Date());
  const started = Date.now();
  const inputHash = createHash('sha256').update(VERIFY_PROMPT, 'utf8').digest('hex');
  const calls = new ModelCallRepository(input.db);
  const callId = randomUUID();
  const connectionId = target.connection === 'registered' ? target.connectionId : null;
  await input.db.transaction().execute(async (trx) => {
    requireNormalAdmission(await readAdmission(createRepositories(trx), 'share'));
    await new ModelCallRepository(trx).beginVerifyInTransaction(callId,
      { workspaceId: input.workspaceId, inputHash, connectionId },
      { provider: config.provider, model: config.model, configFingerprint,
        credentialFingerprint: readCredentialFingerprint(config) });
  });
  try {
    const success = await input.call.call({
      config, prompt: VERIFY_PROMPT, timeoutMs: VERIFY_TIMEOUT_MS,
      ...(resolved.guard === undefined ? {} : { guard: resolved.guard }),
    });
    await calls.settle(callId, {
      status: 'COMPLETED',
      providerRequestId: success.providerRequestId,
      usage: success.usage,
    });
    return {
      ok: true,
      latency_ms: Date.now() - started,
      provider: config.provider,
      model: config.model,
      config_fingerprint: configFingerprint,
      error_category: null,
      verified_at: now().toISOString(),
    };
  } catch (error) {
    const category = classifyVerifyError(error);
    const evidence = typeof error === 'object' && error !== null
      ? error as { providerRequestId?: unknown; usage?: unknown } : {};
    const usage = evidence.usage;
    const knownUsage = typeof usage === 'object' && usage !== null &&
      'inputTokens' in usage && 'outputTokens' in usage
      ? { inputTokens: (usage as ModelUsage).inputTokens,
        outputTokens: (usage as ModelUsage).outputTokens,
        cacheReadTokens: (usage as ModelUsage).cacheReadTokens ?? null,
        cacheCreationTokens: (usage as ModelUsage).cacheCreationTokens ?? null }
      : undefined;
    await calls.settle(callId, {
      status: 'FAILED',
      errorKind: (error instanceof Error && 'errorKind' in error &&
        typeof (error as { errorKind?: unknown }).errorKind === 'string')
        ? (error as { errorKind: string }).errorKind : category,
      ...(typeof evidence.providerRequestId === 'string' &&
        evidence.providerRequestId !== ''
        ? { providerRequestId: evidence.providerRequestId } : {}),
      ...(knownUsage === undefined ? {} : { usage: knownUsage }),
    });
    return {
      ok: false,
      latency_ms: Date.now() - started,
      provider: config.provider,
      model: config.model,
      config_fingerprint: configFingerprint,
      error_category: category,
      verified_at: now().toISOString(),
    };
  }
}

/**
 * 某条已登记连接的验证状态（0158，只读）。
 *
 * 与进程默认/OpenRouter 的 `readModelVerificationState` 同一套状态推导，差别只在事实来源：
 *   * 配置来自连接行 + 系统凭据库，不读 `.env`；
 *   * 最近一次验证按 `model_calls.connection_id` 精确归属，不让同型号的其他连接冒充；
 *   * 凭据身份也用**本连接**的验证行比较——轮换后旧结论立即变成 `CREDENTIAL_CHANGED`；
 *   * 没有目录依据（自建 Provider 不在目录里），catalog 恒为 null，不制造「免费资格」结论。
 *
 * 凭据存储或凭据缺失不在这里抛错（这是只读查询）：状态保守落在 NOT_CONFIGURED 之外的
 * 既有无凭据语义上；`runModelPortVerification` 的显式错误才是可操作入口。
 */
export async function readModelConnectionVerificationState(input: {
  readonly db: DbExecutor;
  readonly workspaceId: string;
  readonly connectionId: string;
  readonly credentials?: CredentialStore | undefined;
}): Promise<ModelVerificationState> {
  const repository = createRepositories(input.db);
  const row = await repository.modelConnections.read(input.workspaceId, input.connectionId);
  if (row === undefined) {
    throw new ModelVerifyTargetError('MODEL_VERIFY_CONNECTION_UNAVAILABLE',
      'model connection is not visible in this workspace');
  }
  let config: ModelPortConfig | undefined;
  try {
    const apiKey = await connectionCredentials(input.credentials).resolve(row.credential_ref);
    if (apiKey !== undefined && apiKey.trim() !== '') {
      config = modelPortConfigFromConnection(row, apiKey);
    }
  } catch (error) {
    if (!(error instanceof CredentialStoreError)) throw error;
    // 存储不可用：仍返回可读状态，但绝不显示「已验证」；POST 验证会给出可操作错误。
    config = undefined;
  }
  const currentFingerprint = config === undefined ? null : computeModelConfigFingerprint(config);
  const calls = new ModelCallRepository(input.db);
  // P0-2：已登记连接是工作区作用域的事实。`last` 只读**本工作区**的最近 VERIFY，
  // 不读跨 Workspace 的全局行——否则别的工作区的探测结论会出现在这条连接的状态里。
  const workspaceRow = await calls.latestVerifyForWorkspace(input.workspaceId);
  const targetRow = await calls.latestVerifyForConnection(input.workspaceId, input.connectionId);
  const last = workspaceRow === undefined ? null : verifyResultFromRow(workspaceRow);
  const targetLast = targetRow === undefined ? null : verifyResultFromRow(targetRow);
  const credentialIdentity = config === undefined || targetRow === undefined
    ? 'UNKNOWN' as const
    : compareCredentialIdentity(targetRow.credential_fingerprint, readCredentialFingerprint(config));
  const accountCooldownActive = config === undefined ? false
    : await new ModelProviderCooldownRepository(input.db).readActive({ scope: 'ACCOUNT',
      modelId: '', configFingerprint: accountCooldownKey(readCredentialFingerprint(config)),
      now: new Date() }) !== undefined;
  const state = describeVerifyTargetState({
    configured: config !== undefined,
    configIncomplete: false,
    catalog: null,
    accountCooldownActive,
    credentialIdentity,
    currentFingerprint,
    last: targetRow === undefined ? null : { ok: targetRow.status === 'COMPLETED',
      configFingerprint: targetRow.config_fingerprint, errorKind: targetRow.error_kind },
  });
  return {
    target: describeVerifyTarget({ connection: 'registered', connectionId: input.connectionId }),
    connection: 'registered',
    connection_id: input.connectionId,
    model: row.default_model,
    current_config_fingerprint: currentFingerprint,
    last,
    target_last: targetLast,
    matches_current_config: targetRow !== undefined && currentFingerprint !== null &&
      targetRow.config_fingerprint === currentFingerprint && credentialIdentity !== 'CHANGED',
    credential_identity: credentialIdentity,
    state,
    worker_startup_validation: 'NOT_CONFIGURED',
  };
}
