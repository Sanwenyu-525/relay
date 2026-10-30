import { randomUUID } from 'node:crypto';

import type { DbExecutor } from '../infrastructure/database.js';
import type { JsonObject } from '../infrastructure/json.js';
import { ModelCallRepository, type ModelCallOrigin,
  type ModelCallSettlement } from '../model/model-call-repository.js';
import type { ModelIdentity } from '../workflow/fake-model-port.js';
import { classifyProviderError } from '../workflow/model-error-classification.js';

/** The begin insert commits before invoking a Provider. A lost process leaves
 * STARTED as an unknown outcome and never silently invents zero usage. */
export async function recordModelInvocation<T>(db: DbExecutor, input: {
  readonly callId?: string;
  readonly origin: ModelCallOrigin;
  /**
   * 0145：本次请求的上下文构成。与 STARTED 行一起提交——它是「这次调用送进去了什么」
   * 的事实，必须在调用发出前就固定；结算时再补写就变成事后重构。
   */
  readonly contextUsage?: JsonObject;
  readonly identity: ModelIdentity;
  readonly signal?: AbortSignal;
  readonly invoke: (callId: string) => Promise<T>;
  readonly settle: (result: T) => ModelCallSettlement;
}): Promise<{ readonly callId: string; readonly result: T }> {
  const callId = input.callId ?? randomUUID();
  const calls = new ModelCallRepository(db);
  await calls.begin(callId, input.contextUsage === undefined ? input.origin
    : { ...input.origin, contextUsage: input.contextUsage }, input.identity);
  let result: T;
  try {
    result = await input.invoke(callId);
  } catch (error) {
    const evidence = typeof error === 'object' && error !== null
      ? error as { providerRequestId?: unknown; usage?: unknown } : {};
    const usage = evidence.usage;
    const fields = typeof usage === 'object' && usage !== null
      ? usage as { inputTokens?: unknown; outputTokens?: unknown;
        cacheReadTokens?: unknown; cacheCreationTokens?: unknown } : {};
    const knownUsage = 'inputTokens' in fields && 'outputTokens' in fields &&
      (fields.inputTokens === null || (Number.isSafeInteger(fields.inputTokens) &&
        (fields.inputTokens as number) >= 0)) &&
      (fields.outputTokens === null || (Number.isSafeInteger(fields.outputTokens) &&
        (fields.outputTokens as number) >= 0))
      ? { inputTokens: fields.inputTokens as number | null,
        outputTokens: fields.outputTokens as number | null,
        cacheReadTokens: cacheToken(fields.cacheReadTokens),
        cacheCreationTokens: cacheToken(fields.cacheCreationTokens) } : undefined;
    // Provider 传输层失败记统一分类（与连接验证同一词表，可聚合）；Relay 自身的
    // 预算、工具拒绝、语义解析等失败不是 Provider 故障，保留错误名以便定位。
    const aborted = input.signal?.aborted === true;
    const providerCategory = aborted ? undefined : classifyProviderError(error);
    await calls.settle(callId, { status: aborted ? 'CANCELLED' : 'FAILED',
      errorKind: aborted ? null
        : providerCategory ?? (error instanceof Error ? error.name : 'UNKNOWN'),
      ...(typeof evidence.providerRequestId === 'string'
        ? { providerRequestId: evidence.providerRequestId } : {}),
      ...(knownUsage === undefined ? {} : { usage: knownUsage }) });
    throw error;
  }
  await calls.settle(callId, input.settle(result));
  return { callId, result };
}

/** Provider cache fields are optional extras; absent or malformed means unknown. */
function cacheToken(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
}
