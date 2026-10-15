import { ConfigError } from '../config/config.js';
import { ModelCallRepository } from '../model/model-call-repository.js';
import { computeModelConfigFingerprint, readModelPortConfig, } from './model-port-config.js';
import { DEFAULT_MODEL_BASE_URL, guardedModelFetch, parseModelBaseUrl, } from './model-endpoint-policy.js';
import { MODEL_ERROR_CATEGORIES, classifyProviderErrorOrProtocol, categoryOfProviderStatus, } from './model-error-classification.js';
/**
 * 模型端口连接验证（设计见 docs/testing/evidence/remediation-2026-09-28/model-verification-design.md）。
 *
 * 固定短文本、非流式、短超时；结果写入 model_calls（kind='VERIFY'）。
 * 响应永不包含密钥或原始响应头；失败不回退 Mock。
 */
export const VERIFY_PROMPT = 'relay-verify-1';
export const VERIFY_TIMEOUT_MS = 15_000;
const VERIFY_MAX_OUTPUT_TOKENS = 16;
export const MODEL_VERIFY_ERROR_CATEGORIES = MODEL_ERROR_CATEGORIES;
export class ModelVerifyCallError extends Error {
    category;
    providerRequestId;
    usage;
    name = 'ModelVerifyCallError';
    constructor(category, message, providerRequestId = '', usage) {
        super(message);
        this.category = category;
        this.providerRequestId = providerRequestId;
        this.usage = usage;
    }
}
/** 配置侧拒绝（未配置 / 残缺）：不发起外呼，也不写 VERIFY 账本。 */
export class ModelVerifyConfigError extends Error {
    code;
    name = 'ModelVerifyConfigError';
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
export function resolveVerifyConfig(env) {
    const provider = env.RELAY_MODEL_PROVIDER;
    if (provider === undefined || provider === '' || provider === 'fake') {
        throw new ModelVerifyConfigError('MODEL_PORT_NOT_CONFIGURED', 'current instance uses the Mock model port; there is no real model configuration to verify');
    }
    try {
        return readModelPortConfig(env);
    }
    catch (error) {
        if (error instanceof ConfigError) {
            throw new ModelVerifyConfigError('MODEL_CONFIG_INVALID', error.issues.join('; '));
        }
        throw new ModelVerifyConfigError('MODEL_CONFIG_INVALID', 'model configuration is invalid');
    }
}
export function classifyVerifyError(error) {
    return classifyProviderErrorOrProtocol(error);
}
/**
 * 生产验证外呼：OpenAI 兼容 /chat/completions，非流式、固定短文本、短超时。
 * 走 guardedModelFetch，与真实端口同一端点策略。
 */
export function createOpenAiCompatibleVerifyCall(transport = {}) {
    return {
        async call(input) {
            const baseUrl = parseModelBaseUrl(input.config.baseUrl ?? DEFAULT_MODEL_BASE_URL);
            const fetchFn = guardedModelFetch(baseUrl, transport);
            let response;
            try {
                response = await fetchFn(`${baseUrl}/chat/completions`, {
                    method: 'POST',
                    headers: {
                        'content-type': 'application/json',
                        authorization: `Bearer ${input.config.apiKey}`,
                    },
                    body: JSON.stringify({
                        model: input.config.model,
                        messages: [{ role: 'user', content: input.prompt }],
                        stream: false,
                        max_tokens: VERIFY_MAX_OUTPUT_TOKENS,
                    }),
                    signal: AbortSignal.timeout(input.timeoutMs),
                    redirect: 'error',
                });
            }
            catch (error) {
                if (error instanceof Error &&
                    (error.name === 'TimeoutError' || error.name === 'AbortError')) {
                    throw new ModelVerifyCallError('TIMEOUT', 'verify call timed out');
                }
                throw error;
            }
            if (!response.ok) {
                throw new ModelVerifyCallError(categoryOfProviderStatus(response.status), `verify call failed with HTTP ${response.status}`);
            }
            let payload;
            try {
                payload = await response.json();
            }
            catch {
                throw new ModelVerifyCallError('PROTOCOL', 'verify response is not valid JSON');
            }
            const text = extractCompletionText(payload);
            if (text === null) {
                throw new ModelVerifyCallError('PROTOCOL', 'verify response is missing completion text');
            }
            return {
                providerRequestId: extractProviderRequestId(payload),
                usage: extractUsage(payload),
            };
        },
    };
}
function extractCompletionText(payload) {
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload))
        return null;
    const choices = payload.choices;
    if (!Array.isArray(choices) || choices.length === 0)
        return null;
    const first = choices[0];
    if (typeof first !== 'object' || first === null)
        return null;
    const message = first.message;
    if (typeof message !== 'object' || message === null)
        return null;
    const content = message.content;
    return typeof content === 'string' ? content : null;
}
function extractProviderRequestId(payload) {
    if (typeof payload !== 'object' || payload === null)
        return '';
    const id = payload.id;
    return typeof id === 'string' ? id : '';
}
function extractUsage(payload) {
    if (typeof payload !== 'object' || payload === null) {
        return { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheCreationTokens: null };
    }
    const usage = payload.usage;
    if (typeof usage !== 'object' || usage === null) {
        return { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheCreationTokens: null };
    }
    const prompt = usage.prompt_tokens;
    const completion = usage.completion_tokens;
    const details = usage.prompt_tokens_details;
    const detail = typeof details === 'object' && details !== null
        ? details : {};
    const count = (value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
    return {
        inputTokens: count(prompt),
        outputTokens: count(completion),
        cacheReadTokens: 'cached_tokens' in detail ? count(detail.cached_tokens) : null,
        cacheCreationTokens: 'cache_write_tokens' in detail ? count(detail.cache_write_tokens) : null,
    };
}
export function createFakeVerifyCall(scenario) {
    return {
        async call() {
            switch (scenario) {
                case 'SUCCESS':
                    return { providerRequestId: `fake-verify-${scenario.toLowerCase()}`,
                        usage: { inputTokens: 4, outputTokens: 2 } };
                case 'AUTH':
                    throw new ModelVerifyCallError('AUTH', 'verify call failed with HTTP 401');
                case 'TIMEOUT':
                    throw new ModelVerifyCallError('TIMEOUT', 'verify call timed out');
                case 'INVALID_MODEL':
                    throw new ModelVerifyCallError('PROTOCOL', 'verify call failed with HTTP 404');
                case 'NETWORK':
                    throw new ModelVerifyCallError('NETWORK', 'fetch failed');
            }
        },
    };
}
export function describeWorkerStartupValidation(env) {
    const provider = env.RELAY_MODEL_PROVIDER;
    if (provider === undefined || provider === '' || provider === 'fake')
        return 'NOT_CONFIGURED';
    try {
        readModelPortConfig(env);
        return 'OK';
    }
    catch {
        return 'FAILED';
    }
}
/** 账本行 → 验证结果视图。不回填密钥；error_kind 即 error_category。 */
export function verifyResultFromRow(row) {
    const ok = row.status === 'COMPLETED';
    return {
        ok,
        latency_ms: null,
        provider: row.provider,
        model: row.model,
        config_fingerprint: row.config_fingerprint,
        error_category: ok ? null : categoryOfErrorKind(row.error_kind),
        verified_at: (row.settled_at ?? row.started_at).toISOString(),
    };
}
function categoryOfErrorKind(errorKind) {
    if (errorKind !== null &&
        MODEL_VERIFY_ERROR_CATEGORIES.includes(errorKind)) {
        return errorKind;
    }
    return 'PROTOCOL';
}
export async function readModelVerificationState(db, env) {
    let currentConfig;
    let currentFingerprint = null;
    try {
        currentConfig = resolveVerifyConfig(env);
        currentFingerprint = computeModelConfigFingerprint(currentConfig);
    }
    catch {
        currentFingerprint = null;
    }
    const row = await new ModelCallRepository(db).latestVerify();
    const last = row === undefined ? null : verifyResultFromRow(row);
    return {
        current_config_fingerprint: currentFingerprint,
        last,
        matches_current_config: last !== null && currentFingerprint !== null &&
            last.config_fingerprint === currentFingerprint,
        worker_startup_validation: describeWorkerStartupValidation(env),
    };
}
