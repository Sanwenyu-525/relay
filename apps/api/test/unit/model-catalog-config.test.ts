import assert from 'node:assert/strict';
import test from 'node:test';

import { ConfigError } from '../../src/config/config.js';
import {
  readModelCatalogConfig, catalogConfigEnabled, isCacheStale, backoffMs, shouldAttemptRefresh,
} from '../../src/workflow/model-catalog-config.js';

// FM-02/FM-03/FM-04 的纯决策面：缓存过期、指数退避、手动最小间隔、开关与有界解析。
// 用可控时间与直接构造状态，不触碰数据库与网络；租约去重与 CAS 发布的真实语义交给集成测试。

const H = 3_600_000;
const base = {
  now: new Date('2026-10-15T12:00:00Z'),
  cacheTtlMs: 24 * H, minRefreshIntervalMs: 60_000,
  backoffBaseMs: 30_000, backoffMaxMs: 6 * H,
};

test('无成功快照视为过期，触发首次同步', () => {
  assert.equal(isCacheStale(base.now, null, base.cacheTtlMs), true);
});

test('距上次成功恰好达到 TTL 判过期，未达判新鲜', () => {
  assert.equal(isCacheStale(base.now, new Date(base.now.getTime() - 24 * H), base.cacheTtlMs), true);
  assert.equal(isCacheStale(base.now, new Date(base.now.getTime() - (24 * H - 1)), base.cacheTtlMs), false);
});

test('退避：n 次失败后 min(max, base*2^(n-1))，0 次为 0', () => {
  assert.equal(backoffMs(0, 30_000, 6 * H), 0);
  assert.equal(backoffMs(1, 30_000, 6 * H), 30_000);
  assert.equal(backoffMs(2, 30_000, 6 * H), 60_000);
  assert.equal(backoffMs(9, 30_000, 6 * H), 7_680_000); // 30s*256，未封顶
  assert.equal(backoffMs(10, 30_000, 6 * H), 15_360_000); // 30s*512，仍未封顶
  assert.equal(backoffMs(11, 30_000, 6 * H), 6 * H); // 30s*1024 超过 6h，封顶
});

test('startup：缓存新鲜则跳过（CACHE_FRESH），过期才尝试', () => {
  const fresh = shouldAttemptRefresh({
    ...base, trigger: 'startup', lastSuccessAt: new Date(base.now.getTime() - H),
    lastAttemptAt: null, lastFailureAt: null, consecutiveFailures: 0,
  });
  assert.deepEqual(fresh, { attempt: false, reason: 'CACHE_FRESH' });
  const stale = shouldAttemptRefresh({
    ...base, trigger: 'startup', lastSuccessAt: null,
    lastAttemptAt: null, lastFailureAt: null, consecutiveFailures: 0,
  });
  assert.deepEqual(stale, { attempt: true });
});

test('退避优先于一切：连续失败后未过退避窗口，即便缓存过期也先等（含 startup 与 manual）', () => {
  const within = shouldAttemptRefresh({
    ...base, trigger: 'manual', lastSuccessAt: null, lastAttemptAt: new Date(base.now.getTime() - 10 * H),
    lastFailureAt: new Date(base.now.getTime() - 10_000), consecutiveFailures: 1,
  });
  assert.deepEqual(within, { attempt: false, reason: 'BACKOFF' });
  // 退避窗口过后：manual 若距上次尝试已超最小间隔则允许。
  const afterBackoff = shouldAttemptRefresh({
    ...base, trigger: 'manual', lastSuccessAt: null, lastAttemptAt: new Date(base.now.getTime() - 10 * H),
    lastFailureAt: new Date(base.now.getTime() - 60_000), consecutiveFailures: 1, // backoff=30s<60s
  });
  assert.deepEqual(afterBackoff, { attempt: true });
});

test('manual：忽略缓存新鲜度，但受最小刷新间隔限速（RATE_LIMITED）', () => {
  const throttled = shouldAttemptRefresh({
    ...base, trigger: 'manual', lastSuccessAt: new Date(base.now.getTime() - H),
    lastAttemptAt: new Date(base.now.getTime() - 10_000), // 距上次尝试 10s < 60s
    lastFailureAt: null, consecutiveFailures: 0,
  });
  assert.deepEqual(throttled, { attempt: false, reason: 'RATE_LIMITED' });
  const allowed = shouldAttemptRefresh({
    ...base, trigger: 'manual', lastSuccessAt: new Date(base.now.getTime() - H),
    lastAttemptAt: new Date(base.now.getTime() - 120_000), lastFailureAt: null, consecutiveFailures: 0,
  });
  assert.deepEqual(allowed, { attempt: true });
});

test('enabled 开关：未设置或 true 视为启用，显式 false 关闭，其它值报错', () => {
  assert.equal(catalogConfigEnabled({}), true);
  assert.equal(catalogConfigEnabled({ RELAY_MODEL_CATALOG_ENABLED: 'true' }), true);
  assert.equal(readModelCatalogConfig({ RELAY_MODEL_CATALOG_ENABLED: 'false' }), undefined);
  assert.throws(() => readModelCatalogConfig({ RELAY_MODEL_CATALOG_ENABLED: 'yes' }), ConfigError);
});

test('默认配置：公开 https 端点、24h TTL，凭据可选独立', () => {
  const config = readModelCatalogConfig({});
  assert.ok(config);
  assert.equal(config.baseUrl, 'https://openrouter.ai/api/v1');
  assert.equal(config.apiKey, undefined);
  assert.equal(config.cacheTtlMs, 24 * H);
});

test('独立目录凭据与聊天凭据不串用', () => {
  const config = readModelCatalogConfig({
    RELAY_MODEL_CATALOG_API_KEY: 'catalog-key',
    RELAY_MODEL_API_KEY: 'chat-key', // 不应影响目录
  });
  assert.equal(config?.apiKey, 'catalog-key');
});

test('非法/越界配置一律 ConfigError，绝不静默回退到危险默认', () => {
  assert.throws(() => readModelCatalogConfig({ RELAY_MODEL_CATALOG_TTL_SECONDS: '0' }), ConfigError);
  assert.throws(() => readModelCatalogConfig({ RELAY_MODEL_CATALOG_TTL_SECONDS: 'abc' }), ConfigError);
  assert.throws(() => readModelCatalogConfig({ RELAY_MODEL_CATALOG_BASE_URL: 'http://openrouter.ai/api/v1' }), ConfigError);
  assert.throws(() => readModelCatalogConfig({
    RELAY_MODEL_CATALOG_BACKOFF_BASE_SECONDS: '120', RELAY_MODEL_CATALOG_BACKOFF_MAX_SECONDS: '60',
  }), ConfigError); // max < base
  assert.throws(() => readModelCatalogConfig({
    RELAY_MODEL_CATALOG_LEASE_SECONDS: '5', RELAY_MODEL_CATALOG_TIMEOUT_MS: '15000',
  }), ConfigError); // 租约盖不住外呼超时
});
