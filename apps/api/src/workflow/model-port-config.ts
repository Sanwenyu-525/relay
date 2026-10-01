import { createHash } from 'node:crypto';

import { ConfigError } from '../config/config.js';
import { DEFAULT_MODEL_BASE_URL, parseModelBaseUrl } from './model-endpoint-policy.js';

/**
 * 真实模型端口的配置（M04）：模型、endpoint、密钥全部外置，密钥只经环境变量
 * 注入（.env 已被 Git 忽略），不写入代码、日志或文档。
 *
 * RELAY_MODEL_PROVIDER 未设置或为 `fake` 时不启用真实模型（回归与离线测试路径）。
 * 设置为 `openai-compatible` 但缺少 RELAY_MODEL_API_KEY / RELAY_MODEL_NAME 时属于
 * 残缺配置：启动校验直接失败，不让 Worker 在缺少关键输入的情况下静默回退 Fake。
 */

export interface ModelPortConfig {
  readonly provider: 'openai-compatible';
  readonly model: string;
  readonly apiKey: string;
  readonly baseUrl: string | undefined;
  readonly timeoutMs: number;
  readonly maxOutputTokens: number;
  readonly maxCallTokens: number;
  readonly maxScopeCalls: number;
  readonly maxScopeTokens: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 4_096;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 600_000;
const MIN_MAX_OUTPUT_TOKENS = 256;
const MAX_MAX_OUTPUT_TOKENS = 65_536;
const DEFAULT_MAX_CALL_TOKENS = 65_536;
const MIN_MAX_CALL_TOKENS = 1_024;
const MAX_MAX_CALL_TOKENS = 262_144;
const DEFAULT_MAX_SCOPE_CALLS = 32;
const DEFAULT_MAX_SCOPE_TOKENS = 262_144;

export function readModelPortConfig(env: NodeJS.ProcessEnv): ModelPortConfig | undefined {
  const provider = env.RELAY_MODEL_PROVIDER;
  if (provider === undefined || provider === '' || provider === 'fake') return undefined;
  if (provider !== 'openai-compatible') {
    throw new ConfigError([`RELAY_MODEL_PROVIDER ${provider} is unsupported`]);
  }
  const apiKey = env.RELAY_MODEL_API_KEY;
  const model = env.RELAY_MODEL_NAME;
  const issues: string[] = [];
  if (apiKey === undefined || apiKey.trim() === '') issues.push('RELAY_MODEL_API_KEY is required');
  if (model === undefined || model.trim() === '') issues.push('RELAY_MODEL_NAME is required');
  if (issues.length > 0) throw new ConfigError(issues);
  const timeoutMs = readBoundedInteger(env.RELAY_MODEL_TIMEOUT_MS, DEFAULT_TIMEOUT_MS,
    MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, 'RELAY_MODEL_TIMEOUT_MS', issues);
  const maxOutputTokens = readBoundedInteger(env.RELAY_MODEL_MAX_OUTPUT_TOKENS,
    DEFAULT_MAX_OUTPUT_TOKENS, MIN_MAX_OUTPUT_TOKENS, MAX_MAX_OUTPUT_TOKENS,
    'RELAY_MODEL_MAX_OUTPUT_TOKENS', issues);
  const maxCallTokens = readBoundedInteger(env.RELAY_MODEL_MAX_CALL_TOKENS,
    DEFAULT_MAX_CALL_TOKENS, MIN_MAX_CALL_TOKENS, MAX_MAX_CALL_TOKENS,
    'RELAY_MODEL_MAX_CALL_TOKENS', issues);
  const maxScopeCalls = readBoundedInteger(env.RELAY_MODEL_MAX_SCOPE_CALLS,
    DEFAULT_MAX_SCOPE_CALLS, 1, 256, 'RELAY_MODEL_MAX_SCOPE_CALLS', issues);
  const maxScopeTokens = readBoundedInteger(env.RELAY_MODEL_MAX_SCOPE_TOKENS,
    DEFAULT_MAX_SCOPE_TOKENS, MIN_MAX_CALL_TOKENS, 2_000_000,
    'RELAY_MODEL_MAX_SCOPE_TOKENS', issues);
  if (maxCallTokens < maxOutputTokens) {
    issues.push('RELAY_MODEL_MAX_CALL_TOKENS must cover RELAY_MODEL_MAX_OUTPUT_TOKENS');
  }
  if (maxScopeTokens < maxCallTokens) {
    issues.push('RELAY_MODEL_MAX_SCOPE_TOKENS must cover RELAY_MODEL_MAX_CALL_TOKENS');
  }
  if (issues.length > 0) throw new ConfigError(issues);
  const baseUrl = env.RELAY_MODEL_BASE_URL;
  const parsedBaseUrl = baseUrl === undefined || baseUrl === '' ? undefined
    : parseModelBaseUrl(baseUrl);
  return { provider: 'openai-compatible', model: model!.trim(), apiKey: apiKey!.trim(),
    baseUrl: parsedBaseUrl, timeoutMs: timeoutMs!, maxOutputTokens: maxOutputTokens!,
    maxCallTokens: maxCallTokens!, maxScopeCalls: maxScopeCalls!,
    maxScopeTokens: maxScopeTokens! };
}

/** 启动校验：残缺的真实模型配置让 Worker 明确失败，而不是静默回退 Fake。 */
export function validateModelPortConfig(env: NodeJS.ProcessEnv): void {
  readModelPortConfig(env);
}

/**
 * 配置指纹：与 ModelIdentity.configFingerprint 同一算法（不含密钥明文）。
 * 配置（模型/端点/限额）变化后指纹变化，旧验证结果按不匹配处理。
 */
export function computeModelConfigFingerprint(config: Pick<ModelPortConfig,
  'provider' | 'model' | 'baseUrl' | 'timeoutMs' | 'maxOutputTokens' |
  'maxCallTokens' | 'maxScopeCalls' | 'maxScopeTokens'>): string {
  const baseUrl = parseModelBaseUrl(config.baseUrl ?? DEFAULT_MODEL_BASE_URL);
  return createHash('sha256').update(JSON.stringify({
    provider: config.provider, model: config.model, baseUrl,
    timeoutMs: config.timeoutMs, maxOutputTokens: config.maxOutputTokens,
    maxCallTokens: config.maxCallTokens, maxScopeCalls: config.maxScopeCalls,
    maxScopeTokens: config.maxScopeTokens,
  })).digest('hex');
}

/**
 * 只读的模型端口状态（供设置页展示）：不含密钥。`base_url` 已由
 * parseModelBaseUrl 保证是含公开 https 主机、无凭据/query/fragment 的完整地址，
 * 可安全展示；未自定义时为 null（使用内置默认端点）。`invalid` 表示真实
 * Provider 配置残缺——生产进程本会拒绝启动，该状态只出现在显式读取配置的场景。
 */
export interface ModelPortStatus {
  readonly provider: 'fake' | 'openai-compatible' | 'invalid';
  readonly configured: boolean;
  readonly model: string | null;
  readonly baseUrl: string | null;
  /** 单次调用 token 上限：UI 用作上下文占用的分母。null 表示不可核对。 */
  readonly maxCallTokens: number | null;
}

export function describeModelPortStatus(env: NodeJS.ProcessEnv): ModelPortStatus {
  const provider = env.RELAY_MODEL_PROVIDER;
  if (provider === undefined || provider === '' || provider === 'fake') {
    return { provider: 'fake', configured: false, model: null, baseUrl: null, maxCallTokens: null };
  }
  try {
    const config: ModelPortConfig = readModelPortConfig(env)!;
    return { provider: 'openai-compatible', configured: true, model: config.model,
      baseUrl: config.baseUrl ?? null, maxCallTokens: config.maxCallTokens };
  } catch {
    return { provider: 'invalid', configured: false, model: null, baseUrl: null, maxCallTokens: null };
  }
}

function readBoundedInteger(raw: string | undefined, fallback: number, minimum: number,
  maximum: number, field: string, issues: string[]): number {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    issues.push(`${field} must be an integer from ${minimum} to ${maximum}`);
    return fallback;
  }
  return value;
}
