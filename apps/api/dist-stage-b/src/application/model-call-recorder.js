import { randomUUID } from 'node:crypto';
import { ModelCallRepository } from '../model/model-call-repository.js';
import { classifyProviderError } from '../workflow/model-error-classification.js';
/** The begin insert commits before invoking a Provider. A lost process leaves
 * STARTED as an unknown outcome and never silently invents zero usage. */
export async function recordModelInvocation(db, input) {
    const callId = randomUUID();
    const calls = new ModelCallRepository(db);
    await calls.begin(callId, input.origin, input.identity);
    let result;
    try {
        result = await input.invoke(callId);
    }
    catch (error) {
        const evidence = typeof error === 'object' && error !== null
            ? error : {};
        const usage = evidence.usage;
        const fields = typeof usage === 'object' && usage !== null
            ? usage : {};
        const knownUsage = 'inputTokens' in fields && 'outputTokens' in fields &&
            (fields.inputTokens === null || (Number.isSafeInteger(fields.inputTokens) &&
                fields.inputTokens >= 0)) &&
            (fields.outputTokens === null || (Number.isSafeInteger(fields.outputTokens) &&
                fields.outputTokens >= 0))
            ? { inputTokens: fields.inputTokens,
                outputTokens: fields.outputTokens,
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
function cacheToken(value) {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
}
