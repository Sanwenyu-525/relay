import { createHash, randomUUID } from 'node:crypto';

import type { DbExecutor } from '../infrastructure/database.js';
import { ModelCallRepository } from '../model/model-call-repository.js';
import type { ModelUsage } from '../workflow/fake-model-port.js';
import { computeModelConfigFingerprint } from '../workflow/model-port-config.js';
import { readCredentialFingerprint } from '../workflow/credential-identity.js';
import { classifyVerifyError, resolveVerifyTargetConfig, ModelVerifyTargetError,
  VERIFY_PROMPT, VERIFY_TIMEOUT_MS,
  type ModelVerifyResult, type VerifyCallPort } from '../workflow/model-port-verify.js';
import { DEFAULT_VERIFY_TARGET, type VerifyTarget } from '../workflow/model-verify-target.js';
import { readModelCatalogConfig } from '../workflow/model-catalog-config.js';
import { readAdmission, requireNormalAdmission } from './maintenance-admission.js';
import { createRepositories } from './unit-of-work.js';

export interface RunModelPortVerificationInput {
  readonly db: DbExecutor;
  readonly workspaceId: string;
  readonly env: NodeJS.ProcessEnv;
  readonly call: VerifyCallPort;
  readonly now?: () => Date;
  /** P1-4：验证目标；缺省为进程默认连接。OpenRouter 目录型号使用独立凭据与零价探针。 */
  readonly target?: VerifyTarget | undefined;
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
  const resolved = resolveVerifyTargetConfig(input.env, target);
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
  await input.db.transaction().execute(async (trx) => {
    requireNormalAdmission(await readAdmission(createRepositories(trx), 'share'));
    await new ModelCallRepository(trx).beginVerifyInTransaction(callId,
      { workspaceId: input.workspaceId, inputHash },
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
