import { ConfigError } from '../config/config.js';
import { parseModelBaseUrl } from './model-endpoint-policy.js';

/**
 * 免费模型目录同步的进程级配置（专项阶段 B；roadmap §9.1、runtime §8.6）。
 *
 * 目录来源与聊天模型端口**分开的凭据**：`RELAY_MODEL_CATALOG_API_KEY` 独立于
 * `RELAY_MODEL_API_KEY`，两者不串用；OpenRouter 的 `/models` 列表可公开读，缺凭据
 * 仍可同步可核实目录。所有取值有界、可解析失败即启动/调用报错，绝不静默回退到危险默认。
 * 端点复用 `parseModelBaseUrl`，只接受公开 https、无凭据/query/fragment。
 *
 * 时间/大小上限用「秒」或「字节」等人类可读单位配置，落到字段时换算为毫秒，便于测试与运维。
 */

export interface ModelCatalogConfig {
  /** 已归一化的公开 https 端点（不含尾斜杠）；来源在其下追加 /models，目录不得引入新的请求主机。 */
  readonly baseUrl: string;
  /** 目录读取凭据的引用；缺省表示匿名读取公开列表。绝不明文落库、落日志或回传前端。 */
  readonly apiKey: string | undefined;
  readonly cacheTtlMs: number;
  readonly minRefreshIntervalMs: number;
  readonly leaseTtlMs: number;
  readonly backoffBaseMs: number;
  readonly backoffMaxMs: number;
  readonly fetchTimeoutMs: number;
  readonly maxEntries: number;
  readonly maxBodyBytes: number;
}

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_TTL_SECONDS = 86_400;            // 24h
const DEFAULT_MIN_REFRESH_SECONDS = 60;
const DEFAULT_LEASE_SECONDS = 60;
const DEFAULT_BACKOFF_BASE_SECONDS = 30;
const DEFAULT_BACKOFF_MAX_SECONDS = 21_600;    // 6h
const DEFAULT_FETCH_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_ENTRIES = 512;
const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024; // 2MB

/** 目录来源开关：显式 false 关闭；未设置或 true 启用（公开列表可读，默认开放）。 */
export function catalogConfigEnabled(env: NodeJS.ProcessEnv): boolean {
  const flag = env.RELAY_MODEL_CATALOG_ENABLED;
  return flag === undefined || flag === '' || flag === 'true';
}

export function readModelCatalogConfig(env: NodeJS.ProcessEnv): ModelCatalogConfig | undefined {
  const flag = env.RELAY_MODEL_CATALOG_ENABLED;
  if (flag !== undefined && flag !== '' && flag !== 'true') {
    if (flag === 'false') return undefined;
    throw new ConfigError(['RELAY_MODEL_CATALOG_ENABLED must be "true" or "false"']);
  }
  const issues: string[] = [];

  const rawBaseUrl = env.RELAY_MODEL_CATALOG_BASE_URL;
  let baseUrl = DEFAULT_BASE_URL;
  if (rawBaseUrl !== undefined && rawBaseUrl.trim() !== '') {
    try { baseUrl = parseCatalogBaseUrl(rawBaseUrl.trim()); }
    catch { issues.push('RELAY_MODEL_CATALOG_BASE_URL must be a public https URL without credentials, query or fragment'); }
  }

  const apiKeyRaw = env.RELAY_MODEL_CATALOG_API_KEY;
  const apiKey = apiKeyRaw === undefined || apiKeyRaw.trim() === '' ? undefined : apiKeyRaw.trim();

  const cacheTtlMs = readBoundedInteger(env.RELAY_MODEL_CATALOG_TTL_SECONDS,
    DEFAULT_TTL_SECONDS, 60, 604_800, 'RELAY_MODEL_CATALOG_TTL_SECONDS', issues) * 1_000;
  const minRefreshIntervalMs = readBoundedInteger(env.RELAY_MODEL_CATALOG_MIN_REFRESH_SECONDS,
    DEFAULT_MIN_REFRESH_SECONDS, 1, 3_600, 'RELAY_MODEL_CATALOG_MIN_REFRESH_SECONDS', issues) * 1_000;
  const leaseTtlMs = readBoundedInteger(env.RELAY_MODEL_CATALOG_LEASE_SECONDS,
    DEFAULT_LEASE_SECONDS, 5, 600, 'RELAY_MODEL_CATALOG_LEASE_SECONDS', issues) * 1_000;
  const backoffBaseMs = readBoundedInteger(env.RELAY_MODEL_CATALOG_BACKOFF_BASE_SECONDS,
    DEFAULT_BACKOFF_BASE_SECONDS, 1, 3_600, 'RELAY_MODEL_CATALOG_BACKOFF_BASE_SECONDS', issues) * 1_000;
  const backoffMaxMs = readBoundedInteger(env.RELAY_MODEL_CATALOG_BACKOFF_MAX_SECONDS,
    DEFAULT_BACKOFF_MAX_SECONDS, 60, 86_400, 'RELAY_MODEL_CATALOG_BACKOFF_MAX_SECONDS', issues) * 1_000;
  const fetchTimeoutMs = readBoundedInteger(env.RELAY_MODEL_CATALOG_TIMEOUT_MS,
    DEFAULT_FETCH_TIMEOUT_MS, 1_000, 60_000, 'RELAY_MODEL_CATALOG_TIMEOUT_MS', issues);
  const maxEntries = readBoundedInteger(env.RELAY_MODEL_CATALOG_MAX_ENTRIES,
    DEFAULT_MAX_ENTRIES, 1, 2_000, 'RELAY_MODEL_CATALOG_MAX_ENTRIES', issues);
  const maxBodyBytes = readBoundedInteger(env.RELAY_MODEL_CATALOG_MAX_BODY_BYTES,
    DEFAULT_MAX_BODY_BYTES, 65_536, 8 * 1024 * 1024, 'RELAY_MODEL_CATALOG_MAX_BODY_BYTES', issues);

  if (backoffMaxMs < backoffBaseMs) {
    issues.push('RELAY_MODEL_CATALOG_BACKOFF_MAX_SECONDS must be >= RELAY_MODEL_CATALOG_BACKOFF_BASE_SECONDS');
  }
  if (leaseTtlMs < fetchTimeoutMs) {
    issues.push('RELAY_MODEL_CATALOG_LEASE_SECONDS must cover RELAY_MODEL_CATALOG_TIMEOUT_MS');
  }
  if (issues.length > 0) throw new ConfigError(issues);

  return {
    baseUrl, apiKey, cacheTtlMs, minRefreshIntervalMs, leaseTtlMs,
    backoffBaseMs, backoffMaxMs, fetchTimeoutMs, maxEntries, maxBodyBytes,
  };
}

/** 目录端点归一化：复用公开 https 校验，只把错误信息指向目录自己的环境变量名。 */
function parseCatalogBaseUrl(raw: string): string {
  try { return parseModelBaseUrl(raw); }
  catch { throw new ConfigError(['RELAY_MODEL_CATALOG_BASE_URL must be a public https URL without credentials, query or fragment']); }
}

/**
 * 快照是否过期：没有成功快照（lastSuccessAt=null）视为过期，触发首次同步；
 * 有则按距上次成功是否达到 TTL 判断。纯函数，便于可控时钟测试。
 */
export function isCacheStale(now: Date, lastSuccessAt: Date | null, cacheTtlMs: number): boolean {
  if (lastSuccessAt === null) return true;
  return now.getTime() - lastSuccessAt.getTime() >= cacheTtlMs;
}

/** 指数退避：失败 n 次后等待 base * 2^(n-1)，封顶 max；n<=0 时为 0。 */
export function backoffMs(consecutiveFailures: number, baseMs: number, maxMs: number): number {
  if (consecutiveFailures <= 0) return 0;
  const shifted = baseMs * 2 ** Math.min(consecutiveFailures - 1, 32);
  return Math.min(maxMs, shifted);
}

export type SyncSkipReason = 'CACHE_FRESH' | 'BACKOFF' | 'RATE_LIMITED' | 'IN_FLIGHT' | 'SUPERSEDED';

/**
 * 是否在「此刻」发起一次外呼刷新（不判断租约是否已被别人占用，那在事务内做）。
 * 决策顺序：退避优先（连续失败后自动/手动都先等退避），其次按触发方式——
 * 手动刷新受最小间隔限速、忽略 TTL；startup/open 属自动，尊重缓存 TTL。
 */
export function shouldAttemptRefresh(input: {
  readonly now: Date;
  readonly trigger: 'startup' | 'open' | 'manual';
  readonly lastSuccessAt: Date | null;
  readonly lastAttemptAt: Date | null;
  readonly lastFailureAt: Date | null;
  readonly consecutiveFailures: number;
  readonly cacheTtlMs: number;
  readonly minRefreshIntervalMs: number;
  readonly backoffBaseMs: number;
  readonly backoffMaxMs: number;
}): { readonly attempt: true } | { readonly attempt: false; readonly reason: SyncSkipReason } {
  const backoff = backoffMs(input.consecutiveFailures, input.backoffBaseMs, input.backoffMaxMs);
  if (backoff > 0 && input.lastFailureAt !== null &&
      input.now.getTime() - input.lastFailureAt.getTime() < backoff) {
    return { attempt: false, reason: 'BACKOFF' };
  }
  if (input.trigger === 'manual') {
    if (input.lastAttemptAt !== null &&
        input.now.getTime() - input.lastAttemptAt.getTime() < input.minRefreshIntervalMs) {
      return { attempt: false, reason: 'RATE_LIMITED' };
    }
    return { attempt: true };
  }
  // startup/open 属自动触发：缓存未过期就不重复外呼。
  if (!isCacheStale(input.now, input.lastSuccessAt, input.cacheTtlMs)) {
    return { attempt: false, reason: 'CACHE_FRESH' };
  }
  return { attempt: true };
}

function readBoundedInteger(raw: string | undefined, fallback: number, minimum: number,
  maximum: number, field: string, issues: string[]): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    issues.push(`${field} must be an integer from ${minimum} to ${maximum}`);
    return fallback;
  }
  return value;
}
