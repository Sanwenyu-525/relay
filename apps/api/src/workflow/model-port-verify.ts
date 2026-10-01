import { ConfigError } from '../config/config.js';
import type { DbExecutor } from '../infrastructure/database.js';
import type { ModelCallRow } from '../infrastructure/database-schema.js';
import { ModelCallRepository } from '../model/model-call-repository.js';
import type { ModelUsage } from './fake-model-port.js';
import {
  computeModelConfigFingerprint,
  readModelPortConfig,
  type ModelPortConfig,
} from './model-port-config.js';
import {
  DEFAULT_MODEL_BASE_URL,
  guardedModelFetch,
  parseModelBaseUrl,
  type ModelFetchDependencies,
} from './model-endpoint-policy.js';
import {
  MODEL_ERROR_CATEGORIES,
  classifyProviderErrorOrProtocol,
  categoryOfProviderStatus,
  type ModelErrorCategory,
} from './model-error-classification.js';

/**
 * 模型端口连接验证（设计见 docs/testing/evidence/remediation-2026-09-28/model-verification-design.md）。
 *
 * 固定短文本、非流式、短超时；结果写入 model_calls（kind='VERIFY'）。
 * 响应永不包含密钥或原始响应头；失败不回退 Mock。
 */

export const VERIFY_PROMPT = 'relay-verify-1';
export const VERIFY_TIMEOUT_MS = 15_000;
const VERIFY_MAX_OUTPUT_TOKENS = 16;

// 分类词表的唯一来源在 model-error-classification；此处保留旧名，
// 避免连接验证的公开响应契约与既有调用方改名。
export type ModelVerifyErrorCategory = ModelErrorCategory;

export const MODEL_VERIFY_ERROR_CATEGORIES = MODEL_ERROR_CATEGORIES;

export interface ModelVerifyResult {
  readonly ok: boolean;
  readonly latency_ms: number | null;
  readonly provider: string;
  readonly model: string;
  readonly config_fingerprint: string;
  readonly error_category: ModelVerifyErrorCategory | null;
  readonly verified_at: string;
}

export interface VerifyCallSuccess {
  readonly providerRequestId: string;
  readonly usage: ModelUsage;
}

/** 可注入的验证外呼边界：测试用可控 Fake，生产用 OpenAI 兼容非流式调用。 */
export interface VerifyCallPort {
  call(input: {
    readonly config: ModelPortConfig;
    readonly prompt: string;
    readonly timeoutMs: number;
  }): Promise<VerifyCallSuccess>;
}

export class ModelVerifyCallError extends Error {
  override readonly name = 'ModelVerifyCallError';
  constructor(
    readonly category: ModelVerifyErrorCategory,
    message: string,
    readonly providerRequestId = '',
    readonly usage?: ModelUsage,
  ) {
    super(message);
  }
}

/** 配置侧拒绝（未配置 / 残缺）：不发起外呼，也不写 VERIFY 账本。 */
export class ModelVerifyConfigError extends Error {
  override readonly name = 'ModelVerifyConfigError';
  constructor(
    readonly code: 'MODEL_PORT_NOT_CONFIGURED' | 'MODEL_CONFIG_INVALID',
    message: string,
  ) {
    super(message);
  }
}

export function resolveVerifyConfig(env: NodeJS.ProcessEnv): ModelPortConfig {
  const provider = env.RELAY_MODEL_PROVIDER;
  if (provider === undefined || provider === '' || provider === 'fake') {
    throw new ModelVerifyConfigError(
      'MODEL_PORT_NOT_CONFIGURED',
      'current instance uses the Mock model port; there is no real model configuration to verify',
    );
  }
  try {
    return readModelPortConfig(env)!;
  } catch (error) {
    if (error instanceof ConfigError) {
      throw new ModelVerifyConfigError('MODEL_CONFIG_INVALID', error.issues.join('; '));
    }
    throw new ModelVerifyConfigError('MODEL_CONFIG_INVALID', 'model configuration is invalid');
  }
}

export function classifyVerifyError(error: unknown): ModelVerifyErrorCategory {
  return classifyProviderErrorOrProtocol(error);
}

/**
 * 生产验证外呼：OpenAI 兼容 /chat/completions，非流式、固定短文本、短超时。
 * 走 guardedModelFetch，与真实端口同一端点策略。
 */
export function createOpenAiCompatibleVerifyCall(
  transport: ModelFetchDependencies = {},
): VerifyCallPort {
  return {
    async call(input) {
      const baseUrl = parseModelBaseUrl(input.config.baseUrl ?? DEFAULT_MODEL_BASE_URL);
      const fetchFn = guardedModelFetch(baseUrl, transport);
      let response: Response;
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
      } catch (error) {
        if (error instanceof Error &&
            (error.name === 'TimeoutError' || error.name === 'AbortError')) {
          throw new ModelVerifyCallError('TIMEOUT', 'verify call timed out');
        }
        throw error;
      }
      if (!response.ok) {
        throw new ModelVerifyCallError(categoryOfProviderStatus(response.status),
          `verify call failed with HTTP ${response.status}`);
      }
      let payload: unknown;
      try { payload = await response.json(); }
      catch { throw new ModelVerifyCallError('PROTOCOL', 'verify response is not valid JSON'); }
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

function extractCompletionText(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (typeof first !== 'object' || first === null) return null;
  const message = (first as { message?: unknown }).message;
  if (typeof message !== 'object' || message === null) return null;
  const content = (message as { content?: unknown }).content;
  return typeof content === 'string' ? content : null;
}

function extractProviderRequestId(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) return '';
  const id = (payload as { id?: unknown }).id;
  return typeof id === 'string' ? id : '';
}

function extractUsage(payload: unknown): ModelUsage {
  if (typeof payload !== 'object' || payload === null) {
    return { inputTokens: null, outputTokens: null };
  }
  const usage = (payload as { usage?: unknown }).usage;
  if (typeof usage !== 'object' || usage === null) {
    return { inputTokens: null, outputTokens: null };
  }
  const prompt = (usage as { prompt_tokens?: unknown }).prompt_tokens;
  const completion = (usage as { completion_tokens?: unknown }).completion_tokens;
  return {
    inputTokens: typeof prompt === 'number' && Number.isSafeInteger(prompt) && prompt >= 0
      ? prompt : null,
    outputTokens: typeof completion === 'number' && Number.isSafeInteger(completion) &&
      completion >= 0 ? completion : null,
  };
}

/** 可控 Fake 验证外呼：测试按场景注入成功/认证失败/超时/无效模型/网络失败。 */
export type FakeVerifyScenario =
  | 'SUCCESS'
  | 'AUTH'
  | 'TIMEOUT'
  | 'INVALID_MODEL'
  | 'NETWORK';

export function createFakeVerifyCall(scenario: FakeVerifyScenario): VerifyCallPort {
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
          throw new ModelVerifyCallError('PROTOCOL',
            'verify call failed with HTTP 404');
        case 'NETWORK':
          throw new ModelVerifyCallError('NETWORK', 'fetch failed');
      }
    },
  };
}

export interface ModelVerificationState {
  readonly current_config_fingerprint: string | null;
  readonly last: ModelVerifyResult | null;
  /** 最近一次验证的指纹是否仍匹配当前配置；不匹配表示配置已变、需重新验证。 */
  readonly matches_current_config: boolean;
  /** API 进程环境的启动校验结果；不代表 Worker 进程已被探测。 */
  readonly worker_startup_validation: 'NOT_CONFIGURED' | 'OK' | 'FAILED';
}

export function describeWorkerStartupValidation(env: NodeJS.ProcessEnv):
  'NOT_CONFIGURED' | 'OK' | 'FAILED' {
  const provider = env.RELAY_MODEL_PROVIDER;
  if (provider === undefined || provider === '' || provider === 'fake') return 'NOT_CONFIGURED';
  try {
    readModelPortConfig(env);
    return 'OK';
  } catch {
    return 'FAILED';
  }
}

/** 账本行 → 验证结果视图。不回填密钥；error_kind 即 error_category。 */
export function verifyResultFromRow(row: ModelCallRow): ModelVerifyResult {
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

function categoryOfErrorKind(errorKind: string | null): ModelVerifyErrorCategory {
  if (errorKind !== null &&
      (MODEL_VERIFY_ERROR_CATEGORIES as readonly string[]).includes(errorKind)) {
    return errorKind as ModelVerifyErrorCategory;
  }
  return 'PROTOCOL';
}

export async function readModelVerificationState(
  db: DbExecutor,
  env: NodeJS.ProcessEnv,
): Promise<ModelVerificationState> {
  let currentConfig: ModelPortConfig | undefined;
  let currentFingerprint: string | null = null;
  try {
    currentConfig = resolveVerifyConfig(env);
    currentFingerprint = computeModelConfigFingerprint(currentConfig);
  } catch {
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
