import { createHash, randomUUID } from 'node:crypto';

import type { DbExecutor } from '../infrastructure/database.js';
import { ModelCallRepository } from '../model/model-call-repository.js';
import type { ModelUsage } from '../workflow/fake-model-port.js';
import { computeModelConfigFingerprint } from '../workflow/model-port-config.js';
import { classifyVerifyError, resolveVerifyConfig, VERIFY_PROMPT, VERIFY_TIMEOUT_MS,
  type ModelVerifyResult, type VerifyCallPort } from '../workflow/model-port-verify.js';
import { readAdmission, requireNormalAdmission } from './maintenance-admission.js';
import { createRepositories } from './unit-of-work.js';

export interface RunModelPortVerificationInput {
  readonly db: DbExecutor;
  readonly workspaceId: string;
  readonly env: NodeJS.ProcessEnv;
  readonly call: VerifyCallPort;
  readonly now?: () => Date;
}

/** Reserve new VERIFY work under the admission gate; network and settlement drain normally. */
export async function runModelPortVerification(
  input: RunModelPortVerificationInput,
): Promise<ModelVerifyResult> {
  const config = resolveVerifyConfig(input.env);
  const configFingerprint = computeModelConfigFingerprint(config);
  const now = input.now ?? (() => new Date());
  const started = Date.now();
  const inputHash = createHash('sha256').update(VERIFY_PROMPT, 'utf8').digest('hex');
  const calls = new ModelCallRepository(input.db);
  const callId = randomUUID();
  await input.db.transaction().execute(async (trx) => {
    requireNormalAdmission(await readAdmission(createRepositories(trx), 'share'));
    await new ModelCallRepository(trx).beginVerifyInTransaction(callId,
      { workspaceId: input.workspaceId, inputHash },
      { provider: config.provider, model: config.model, configFingerprint });
  });
  try {
    const success = await input.call.call({
      config, prompt: VERIFY_PROMPT, timeoutMs: VERIFY_TIMEOUT_MS,
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
        outputTokens: (usage as ModelUsage).outputTokens }
      : undefined;
    await calls.settle(callId, {
      status: 'FAILED',
      errorKind: category,
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
