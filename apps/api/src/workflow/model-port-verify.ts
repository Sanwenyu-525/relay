import { ConfigError } from '../config/config.js';
import type { DbExecutor } from '../infrastructure/database.js';
import type { ModelCallRow } from '../infrastructure/database-schema.js';
import { ModelCallRepository } from '../model/model-call-repository.js';
import type { ModelUsage } from './fake-model-port.js';
import {
  computeModelConfigFingerprint,
  readModelPortConfig,
  readOpenRouterModelPortConfig,
  type ModelPortConfig,
} from './model-port-config.js';
import {
  DEFAULT_MODEL_BASE_URL,
  guardedModelFetch,
  parseModelBaseUrl,
  type ModelFetchDependencies,
} from './model-endpoint-policy.js';
import { connectionVerifyUserProbe } from './prompts/run-prompts.js';
import { compareCredentialIdentity, readCredentialFingerprint,
  type CredentialIdentityState } from './credential-identity.js';
import { BoundedResponseError, readBoundedJson } from './bounded-response.js';
import { buildFreePriceGuard, withProviderGuard, type ProviderRoutingGuard } from
  './free-call-guard.js';
import { accountCooldownKey } from './credential-identity.js';
import { readModelCatalogConfig } from './model-catalog-config.js';
import { ModelCatalogRepository } from '../model/model-catalog-repository.js';
import { ModelProviderCooldownRepository } from '../model/model-provider-cooldown-repository.js';
import { DEFAULT_VERIFY_TARGET, describeVerifyTarget, describeVerifyTargetState,
  type VerifyTarget, type VerifyTargetState } from './model-verify-target.js';
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

/**
 * 连接验证用的固定 user 探针。
 *
 * 正文是 `workflow/prompts/run-prompts.ts` 的 `connectionVerifyUserProbe()`，经统一
 * 路由入口以 `USER_PROBE` 类型返回——它**不是** system 模板、不是 Agent 工作模式，
 * 也不组合公共核心。这里保留常量导出，让 `model_calls.input_hash` 与外呼 body 继续
 * 钉在同一个字符串上。
 */
export const VERIFY_PROMPT = connectionVerifyUserProbe();
export const VERIFY_TIMEOUT_MS = 15_000;
/** 验证响应的字节上限：短探针的回复很小，超过它就是异常响应而不是「更完整的答案」。 */
const VERIFY_RESPONSE_MAX_BYTES = 64 * 1024;
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
    /** 免费目录型号的探针必须携带服务商端零价硬限制（P1-4）。 */
    readonly guard?: ProviderRoutingGuard | undefined;
  }): Promise<VerifyCallSuccess>;
}

export class ModelVerifyCallError extends Error {
  override readonly name = 'ModelVerifyCallError';
  constructor(
    readonly category: ModelVerifyErrorCategory,
    message: string,
    readonly providerRequestId = '',
    readonly usage?: ModelUsage,
    /**
     * 账本 `error_kind` 的更精确取值（P1-4）：对外 `error_category` 仍是既有六类词表，
     * 只有「型号不存在」这类需要单独呈现的状态才用更细的名字记账，旧客户端不受影响。
     */
    readonly errorKind?: string,
  ) {
    super(message);
  }
}

/**
 * 目标侧拒绝（P1-4）：这个目标此刻不该被探测——不是目录里的免费型号、能力不足、
 * 或目录快照过期导致免费资格无法确认。同样不发起外呼、不写账本。
 */
export class ModelVerifyTargetError extends Error {
  override readonly name = 'ModelVerifyTargetError';
  constructor(readonly code: 'MODEL_VERIFY_TARGET_NOT_ELIGIBLE' | 'MODEL_VERIFY_CATALOG_STALE',
    message: string) {
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

/**
 * 解析验证目标（P1-4）：默认连接沿用进程配置；OpenRouter 目录型号用**独立**聊天凭据与
 * 确切型号，永不回落到 RELAY_MODEL_API_KEY。
 */
export function resolveVerifyTargetConfig(env: NodeJS.ProcessEnv,
  target: VerifyTarget): { readonly config: ModelPortConfig;
    readonly guard?: ProviderRoutingGuard | undefined } {
  if (target.connection === 'openrouter') {
    const config = readOpenRouterModelPortConfig(env, target.model);
    return { config, guard: buildFreePriceGuard({ connection: { provider: 'openrouter',
      model: target.model, configFingerprint: computeModelConfigFingerprint(config) },
      freeOnly: true, catalogBasis: null }) };
  }
  return { config: resolveVerifyConfig(env) };
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
      const guarded = guardedModelFetch(baseUrl, transport);
      // 免费型号的探针与真实外呼同一条防线：最终 HTTP 体必须带零价上限，
      // 否则「验证通过」可能是一次悄悄计费的调用。
      const fetchFn = input.guard === undefined ? guarded
        : withProviderGuard(guarded, input.guard);
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
        // 404 与 400/422 同属 PROTOCOL，但「型号不存在」是可操作的状态，单独记账。
        throw new ModelVerifyCallError(categoryOfProviderStatus(response.status),
          `verify call failed with HTTP ${response.status}`, '',
          undefined, response.status === 404 ? 'MODEL_NOT_FOUND' : undefined);
      }
      let payload: unknown;
      try {
        // P1-2：验证响应同样来自上游，读取必须按字节上限流式截断，不先整体读入。
        payload = await readBoundedJson(response, VERIFY_RESPONSE_MAX_BYTES);
      } catch (error) {
        if (error instanceof BoundedResponseError) {
          throw new ModelVerifyCallError('PROTOCOL', 'verify response exceeds the size limit');
        }
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
    return { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheCreationTokens: null };
  }
  const usage = (payload as { usage?: unknown }).usage;
  if (typeof usage !== 'object' || usage === null) {
    return { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheCreationTokens: null };
  }
  const prompt = (usage as { prompt_tokens?: unknown }).prompt_tokens;
  const completion = (usage as { completion_tokens?: unknown }).completion_tokens;
  const details = (usage as { prompt_tokens_details?: unknown }).prompt_tokens_details;
  const detail = typeof details === 'object' && details !== null
    ? details as { cached_tokens?: unknown; cache_write_tokens?: unknown } : {};
  const count = (value: unknown): number | null =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
  return {
    inputTokens: count(prompt),
    outputTokens: count(completion),
    cacheReadTokens: 'cached_tokens' in detail ? count(detail.cached_tokens) : null,
    cacheCreationTokens: 'cache_write_tokens' in detail ? count(detail.cache_write_tokens) : null,
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
  /** 本次查询的验证目标：`default` 或 `openrouter:<确切型号>`。 */
  readonly target: string;
  readonly connection: 'default' | 'openrouter';
  readonly model: string | null;
  readonly current_config_fingerprint: string | null;
  /**
   * 本实例最近一次验证（任何目标）。保持既有契约不变：它回答「上一次探测是什么结果」，
   * 不按目标过滤。
   */
  readonly last: ModelVerifyResult | null;
  /**
   * **本目标**（provider + 确切型号）最近一次验证。`state` 只由它推导——另一个型号的
   * 成功不能冒充这个型号可执行。
   */
  readonly target_last: ModelVerifyResult | null;
  /** 最近一次验证的指纹是否仍匹配当前配置；不匹配表示配置已变、需重新验证。 */
  readonly matches_current_config: boolean;
  /**
   * 0142：最近一次验证所用凭据与当前凭据的关系。`CHANGED` 表示换过 Key，
   * 旧验证结论不再代表当前连接可执行（此时 `matches_current_config` 也为 false）。
   * `UNKNOWN` 表示该行产生于 0142 之前，没有凭据身份可比——不冒充匹配。
   */
  readonly credential_identity: CredentialIdentityState;
  /**
   * P1-4：目标此刻的互斥状态。`VERIFIED` 只表示「这个确切目标刚刚探测通过」，
   * 不等于真实任务执行成功，也不代表其他型号可执行。
   */
  readonly state: VerifyTargetState;
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
  target: VerifyTarget = DEFAULT_VERIFY_TARGET,
): Promise<ModelVerificationState> {
  let currentConfig: ModelPortConfig | undefined;
  let currentFingerprint: string | null = null;
  let configIncomplete = false;
  try {
    currentConfig = resolveVerifyTargetConfig(env, target).config;
    currentFingerprint = computeModelConfigFingerprint(currentConfig);
  } catch (error) {
    currentFingerprint = null;
    configIncomplete = target.connection === 'default' &&
      (env.RELAY_MODEL_PROVIDER ?? '') !== '' && (env.RELAY_MODEL_PROVIDER ?? 'fake') !== 'fake';
    if (configIncomplete) configIncomplete = error instanceof ConfigError;
  }
  const repository = new ModelCallRepository(db);
  const globalRow = await repository.latestVerify();
  const last = globalRow === undefined ? null : verifyResultFromRow(globalRow);
  // 目标行按 provider + 确切型号取，不按指纹：同型号改端点/预算仍要看到「指纹不符」。
  const targetRow = currentConfig === undefined
    ? undefined
    : await repository.latestVerifyForModel(currentConfig.provider, currentConfig.model);
  const targetLast = targetRow === undefined ? null : verifyResultFromRow(targetRow);
  const credentialIdentity = currentConfig === undefined
    ? 'UNKNOWN' as const
    : compareCredentialIdentity(globalRow?.credential_fingerprint ?? null,
      readCredentialFingerprint(currentConfig));

  const catalog = target.connection === 'openrouter' && currentConfig !== undefined
    ? await readCatalogFacts(db, target.model) : null;
  const accountCooldownActive = currentConfig === undefined ? false
    : await new ModelProviderCooldownRepository(db).readActive({ scope: 'ACCOUNT', modelId: '',
      configFingerprint: accountCooldownKey(readCredentialFingerprint(currentConfig)),
      now: new Date() }) !== undefined;

  const state = describeVerifyTargetState({
    configured: currentConfig !== undefined && currentFingerprint !== null,
    configIncomplete,
    catalog,
    accountCooldownActive,
    credentialIdentity,
    currentFingerprint,
    last: targetRow === undefined ? null : { ok: targetRow.status === 'COMPLETED',
      configFingerprint: targetRow.config_fingerprint, errorKind: targetRow.error_kind },
  });

  return {
    target: describeVerifyTarget(target),
    connection: target.connection,
    model: target.connection === 'openrouter' ? target.model : currentConfig?.model ?? null,
    current_config_fingerprint: currentFingerprint,
    last,
    target_last: targetLast,
    matches_current_config: last !== null && currentFingerprint !== null &&
      last.config_fingerprint === currentFingerprint && credentialIdentity !== 'CHANGED',
    credential_identity: credentialIdentity,
    state,
    worker_startup_validation: describeWorkerStartupValidation(env),
  };
}

/** 目录侧事实：目标型号是否仍在已发布快照里、是否免费、是否具备文本能力、快照是否新鲜。 */
async function readCatalogFacts(db: DbExecutor, model: string): Promise<{
  readonly fresh: boolean;
  readonly entry: { readonly free: boolean; readonly textInput: boolean;
    readonly textOutput: boolean } | null;
}> {
  const catalogConfig = readModelCatalogConfig(process.env);
  const repository = new ModelCatalogRepository(db);
  const sync = await repository.readSyncState();
  const entry = await repository.readEntryBySourceModelId(model);
  const fresh = catalogConfig !== undefined && sync.last_success_at !== null &&
    Date.now() - sync.last_success_at.getTime() < catalogConfig.cacheTtlMs;
  return {
    fresh,
    entry: entry === undefined ? null : { free: entry.is_free,
      textInput: entry.capabilities.text_input === true,
      textOutput: entry.capabilities.text_output === true },
  };
}
