import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CatalogSourceError, createOpenRouterCatalogSource,
} from '../../src/workflow/openrouter-catalog-source.js';
import type { ModelCatalogConfig } from '../../src/workflow/model-catalog-config.js';

// 全程注入假 fetch + 公开 DNS，绝不触达真实网络；断言「只发一次有界 GET、凭据只按引用、
// 状态/大小/条数/端点异常都收口为类型化 CatalogSourceError」。对应 FM-05（凭据与端点隔离）。

function cfg(overrides: Partial<ModelCatalogConfig> = {}): ModelCatalogConfig {
  return {
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: undefined,
    cacheTtlMs: 86_400_000,
    minRefreshIntervalMs: 60_000,
    leaseTtlMs: 60_000,
    backoffBaseMs: 30_000,
    backoffMaxMs: 21_600_000,
    fetchTimeoutMs: 15_000,
    maxEntries: 512,
    maxBodyBytes: 2_097_152,
    ...overrides,
  };
}

const publicLookup = async () => [{ address: '8.8.8.8', family: 4 }];

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status: 200, headers: { 'content-type': 'application/json' }, ...init,
  });
}

async function reasonOf(promise: Promise<readonly unknown[]>): Promise<string> {
  try { await promise; return 'NO_THROW'; }
  catch (error) {
    return error instanceof CatalogSourceError ? error.reason : `OTHER:${String(error)}`;
  }
}

test('默认只发一次 GET /models，不带 Authorization（公开列表可匿名读）', async () => {
  const requests: { url: string; method: string | undefined; headers: Record<string, string> }[] = [];
  const source = createOpenRouterCatalogSource(cfg(), {
    lookup: publicLookup,
    fetch: async (input, init) => {
      requests.push({
        url: String(input), method: init?.method,
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      return jsonResponse({ data: [{ id: 'a', name: 'A', pricing: { prompt: '0', completion: '0' } }] });
    },
  });
  const data = await source.fetchCatalog(new AbortController().signal);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.method, 'GET');
  assert.equal(requests[0]?.url, 'https://openrouter.ai/api/v1/models');
  assert.equal(requests[0]?.headers.authorization, undefined);
  assert.equal((data as readonly unknown[]).length, 1);
});

test('配置目录凭据时按 Bearer 附带，且这是唯一的密钥出处', async () => {
  let seenAuth: string | undefined;
  const source = createOpenRouterCatalogSource(cfg({ apiKey: 'catalog-secret' }), {
    lookup: publicLookup,
    fetch: async (_input, init) => {
      seenAuth = ((init?.headers ?? {}) as Record<string, string>).authorization;
      return jsonResponse({ data: [] });
    },
  });
  await source.fetchCatalog(new AbortController().signal);
  assert.equal(seenAuth, 'Bearer catalog-secret');
});

test('401/403 归 AUTH，429 归 RATE_LIMIT，其它非 2xx 归 PROTOCOL', async () => {
  const mk = (status: number) => createOpenRouterCatalogSource(cfg(), {
    lookup: publicLookup, fetch: async () => new Response('', { status }),
  });
  assert.equal(await reasonOf(mk(401).fetchCatalog(new AbortController().signal)), 'AUTH');
  assert.equal(await reasonOf(mk(403).fetchCatalog(new AbortController().signal)), 'AUTH');
  assert.equal(await reasonOf(mk(429).fetchCatalog(new AbortController().signal)), 'RATE_LIMIT');
  assert.equal(await reasonOf(mk(500).fetchCatalog(new AbortController().signal)), 'PROTOCOL');
});

test('响应体超过字节上限即中止并归 INCOMPLETE', async () => {
  const source = createOpenRouterCatalogSource(cfg({ maxBodyBytes: 64 }), {
    lookup: publicLookup,
    fetch: async () => jsonResponse({ data: [{ id: 'x'.repeat(500) }] }),
  });
  assert.equal(await reasonOf(source.fetchCatalog(new AbortController().signal)), 'INCOMPLETE');
});

test('非法 JSON→PROTOCOL；data 非数组→INCOMPLETE；条目数超上限→INCOMPLETE', async () => {
  const badJson = createOpenRouterCatalogSource(cfg(), {
    lookup: publicLookup, fetch: async () => jsonResponse('not json at all'),
  });
  assert.equal(await reasonOf(badJson.fetchCatalog(new AbortController().signal)), 'PROTOCOL');

  const notArray = createOpenRouterCatalogSource(cfg(), {
    lookup: publicLookup, fetch: async () => jsonResponse({ data: { oops: true } }),
  });
  assert.equal(await reasonOf(notArray.fetchCatalog(new AbortController().signal)), 'INCOMPLETE');

  const tooMany = createOpenRouterCatalogSource(cfg({ maxEntries: 2 }), {
    lookup: publicLookup,
    fetch: async () => jsonResponse({ data: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }),
  });
  assert.equal(await reasonOf(tooMany.fetchCatalog(new AbortController().signal)), 'INCOMPLETE');
});

test('分页/不完整目录不得当整份快照：next 游标、has_more、total_count 大于实收都拒绝', async () => {
  // 真实结构是 { data, total_count, links: { next } }；全量目录的 links.next 为 null 且 total_count == data.length。
  const mk = (body: unknown) => createOpenRouterCatalogSource(cfg(), {
    lookup: publicLookup, fetch: async () => jsonResponse(body),
  });
  const signal = () => new AbortController().signal;

  // 有下一页游标 → 只是某一页。
  assert.equal(await reasonOf(mk({
    data: [{ id: 'a' }], total_count: 1, links: { next: '/api/v1/models?page=2' } }).fetchCatalog(signal())),
  'INCOMPLETE');
  // 顶层 next 游标。
  assert.equal(await reasonOf(mk({ data: [{ id: 'a' }], next: 'cursor-2' }).fetchCatalog(signal())), 'INCOMPLETE');
  // 明确还有更多。
  assert.equal(await reasonOf(mk({ data: [{ id: 'a' }], has_more: true }).fetchCatalog(signal())), 'INCOMPLETE');
  // 服务端自报 421 条，只收到 3 条 → 这份不能当整份发布。
  assert.equal(await reasonOf(mk({ data: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    total_count: 421, links: { next: null } }).fetchCatalog(signal())), 'INCOMPLETE');
  // total 也认（字符串数字同样按数值比较）。
  assert.equal(await reasonOf(mk({ data: [{ id: 'a' }], total: '9' }).fetchCatalog(signal())), 'INCOMPLETE');

  // 完整一份：next 为 null 且 total_count 与实收一致 → 正常返回。
  const complete = await mk({ data: [{ id: 'a' }, { id: 'b' }], total_count: 2, links: { next: null } })
    .fetchCatalog(signal());
  assert.equal((complete as readonly unknown[]).length, 2);
  // 没有任何分页字段的旧形状仍按整份接受（向后兼容）。
  const legacy = await mk({ data: [{ id: 'a' }] }).fetchCatalog(signal());
  assert.equal((legacy as readonly unknown[]).length, 1);
  // total_count 小于实收不构成「不完整」，不因此拒绝。
  const overDelivered = await mk({ data: [{ id: 'a' }, { id: 'b' }], total_count: 1 })
    .fetchCatalog(signal());
  assert.equal((overDelivered as readonly unknown[]).length, 2);
});

test('端点与传输异常按语义分类：私有 DNS/重定向→ENDPOINT_NOT_ALLOWED，Abort→TIMEOUT，其它→NETWORK', async () => {
  const privateDns = createOpenRouterCatalogSource(cfg(), {
    lookup: async () => [{ address: '169.254.169.254', family: 4 }],
    fetch: async () => { throw new Error('must not send'); },
  });
  assert.equal(await reasonOf(privateDns.fetchCatalog(new AbortController().signal)), 'ENDPOINT_NOT_ALLOWED');

  const redirected = createOpenRouterCatalogSource(cfg(), {
    lookup: publicLookup,
    fetch: async () => Response.redirect('https://evil.internal/leak', 302),
  });
  assert.equal(await reasonOf(redirected.fetchCatalog(new AbortController().signal)), 'ENDPOINT_NOT_ALLOWED');

  const aborted = createOpenRouterCatalogSource(cfg(), {
    lookup: publicLookup,
    fetch: async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; },
  });
  assert.equal(await reasonOf(aborted.fetchCatalog(new AbortController().signal)), 'TIMEOUT');

  const socket = createOpenRouterCatalogSource(cfg(), {
    lookup: publicLookup, fetch: async () => { throw new Error('socket reset'); },
  });
  assert.equal(await reasonOf(socket.fetchCatalog(new AbortController().signal)), 'NETWORK');
});
