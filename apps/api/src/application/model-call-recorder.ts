import { randomUUID } from 'node:crypto';

import type { DbExecutor } from '../infrastructure/database.js';
import { ModelCallRepository, type ModelCallOrigin,
  type ModelCallSettlement } from '../model/model-call-repository.js';
import type { ModelIdentity } from '../workflow/fake-model-port.js';

/** The begin insert commits before invoking a Provider. A lost process leaves
 * STARTED as an unknown outcome and never silently invents zero usage. */
export async function recordModelInvocation<T>(db: DbExecutor, input: {
  readonly origin: ModelCallOrigin;
  readonly identity: ModelIdentity;
  readonly signal?: AbortSignal;
  readonly invoke: (callId: string) => Promise<T>;
  readonly settle: (result: T) => ModelCallSettlement;
}): Promise<{ readonly callId: string; readonly result: T }> {
  const callId = randomUUID();
  const calls = new ModelCallRepository(db);
  await calls.begin(callId, input.origin, input.identity);
  let result: T;
  try {
    result = await input.invoke(callId);
  } catch (error) {
    const evidence = typeof error === 'object' && error !== null
      ? error as { providerRequestId?: unknown; usage?: unknown } : {};
    const usage = evidence.usage;
    const knownUsage = typeof usage === 'object' && usage !== null &&
      'inputTokens' in usage && 'outputTokens' in usage &&
      (usage.inputTokens === null || (Number.isSafeInteger(usage.inputTokens) &&
        (usage.inputTokens as number) >= 0)) &&
      (usage.outputTokens === null || (Number.isSafeInteger(usage.outputTokens) &&
        (usage.outputTokens as number) >= 0))
      ? { inputTokens: usage.inputTokens as number | null,
        outputTokens: usage.outputTokens as number | null } : undefined;
    await calls.settle(callId, { status: input.signal?.aborted === true ? 'CANCELLED' : 'FAILED',
      errorKind: input.signal?.aborted === true ? null
        : error instanceof Error ? error.name : 'UNKNOWN',
      ...(typeof evidence.providerRequestId === 'string'
        ? { providerRequestId: evidence.providerRequestId } : {}),
      ...(knownUsage === undefined ? {} : { usage: knownUsage }) });
    throw error;
  }
  await calls.settle(callId, input.settle(result));
  return { callId, result };
}
