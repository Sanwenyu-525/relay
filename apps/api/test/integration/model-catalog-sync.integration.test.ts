import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { before, after } from 'node:test';

import { sql } from 'kysely';

import { syncModelCatalog } from '../../src/application/model-catalog-sync.js';
import { ModelCatalogRepository } from '../../src/model/model-catalog-repository.js';
import { CatalogSourceError, createFakeCatalogSource } from '../../src/workflow/openrouter-catalog-source.js';
import { shouldAttemptRefresh } from '../../src/workflow/model-catalog-config.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import {
  APP_DATABASE_URL, MIGRATION_DATABASE_URL, MIGRATIONS_DIRECTORY, openDatabase,
} from './integration-support.js';

/**
 * 免费模型目录同步用例的真实 PG 集成（专项阶段 B；FM-02/FM-03/FM-04/FM-05 的持久化语义）。
 *
 * 单测只覆盖了纯决策（TTL/退避/限速）与来源传输；租约去重、CAS 原子发布、失败保留旧快照、
 * 合法空目录清空、以及「同步绝不写 model_calls」这些**依赖真实 SQL 事务/锁**的保证在这里验证。
 * 网络用可控假源，时钟用可控 now，绝不触达真实 OpenRouter。
 */

const app = openDatabase(APP_DATABASE_URL, 'relay-model-catalog-sync-test');
const ENV = { RELAY_MODEL_CATALOG_ENABLED: 'true', RELAY_MODEL_CATALOG_MIN_REFRESH_SECONDS: '1' } as NodeJS.ProcessEnv;

let clockMs: number;
const now = (): Date => new Date(clockMs);
const advance = (ms: number): void => { clockMs += ms; };

before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
  clockMs = Date.UTC(2026, 9, 15, 12, 0, 0);
  // 清理用应用角色**确实持有**的动作（0088 授了 DELETE），而不是 TRUNCATE。
  // 测试夹具不得为了自己方便去给生产应用角色补危险权限（TRUNCATE/DDL），
  // 因此这里改动作、不改授权：relay_app 上 TRUNCATE 会以 SQLSTATE 42501 失败。
  await sql`delete from model_catalog_entries`.execute(app.db);
  await sql`update model_catalog_sync_state set snapshot_seq = 0, directory_digest = null,
    last_success_at = null, last_attempt_at = null, last_failure_at = null,
    last_failure_reason = null, consecutive_failures = 0, sync_lease_token = null,
    sync_lease_expires_at = null`.execute(app.db);
});
after(async () => { await app.close(); });

const repo = (): ModelCatalogRepository => new ModelCatalogRepository(app.db);

/** 受控复核预设：直接决定「这次到底该不该外呼」，用于把租约语义与刷新决策分开验证。 */
const alwaysAttempt = (): { readonly attempt: true } => ({ attempt: true });

function zeroFree(id: string): Record<string, unknown> {
  return { id, name: `${id} 展示名`, context_length: 128_000,
    pricing: { prompt: '0', completion: '0', request: '0' } };
}
function paid(id: string): Record<string, unknown> {
  return { id, name: id, pricing: { prompt: '0.0000000001', completion: '0', request: '0' } };
}

async function modelCallCount(): Promise<number> {
  const row = await sql<{ c: string }>`select count(*)::text as c from model_calls`.execute(app.db);
  return Number(row.rows[0]?.c ?? '0');
}

test('首次同步发布快照：严格免费判定入库，且绝不写 model_calls', async () => {
  const callsBefore = await modelCallCount();
  const result = await syncModelCatalog({ db: app.db, env: ENV, trigger: 'startup', now,
    source: createFakeCatalogSource(async () => [zeroFree('free-a'), paid('paid-b'), zeroFree('free-a')]) });
  assert.equal(result.status, 'PUBLISHED');
  if (result.status !== 'PUBLISHED') return;
  assert.equal(result.totalCount, 2); // 重复 id 去重
  assert.equal(result.freeCount, 1);  // 极小非零 → 非免费
  assert.equal(result.snapshotSeq, '1');

  const state = await repo().readSyncState();
  assert.equal(state.directory_digest?.length, 64);
  assert.ok(state.last_success_at);
  assert.equal(state.consecutive_failures, 0);

  const entries = await repo().readEntries(false);
  assert.deepEqual([...entries].map((e) => e.source_model_id).sort(), ['free-a', 'paid-b']);
  const freeA = entries.find((e) => e.source_model_id === 'free-a');
  assert.equal(freeA?.is_free, true);
  assert.equal(freeA?.not_free_reason, null);
  assert.equal(freeA?.context_window, 128_000);
  const paidB = entries.find((e) => e.source_model_id === 'paid-b');
  assert.equal(paidB?.is_free, false);
  assert.equal(paidB?.not_free_reason, 'NONZERO_PRICE');

  assert.equal(await modelCallCount(), callsBefore); // 读目录不建调用账本
});

test('缓存新鲜时 startup 跳过；过期后重新发布并推进 seq（TTL）', async () => {
  // 紧接上一用例：刚成功，未过 24h。
  const skipped = await syncModelCatalog({ db: app.db, env: ENV, trigger: 'open', now,
    source: createFakeCatalogSource(async () => [zeroFree('x')]) });
  assert.deepEqual(skipped, { status: 'SKIPPED', reason: 'CACHE_FRESH' });

  advance(24 * 3_600_000); // 越过 TTL
  const published = await syncModelCatalog({ db: app.db, env: ENV, trigger: 'startup', now,
    source: createFakeCatalogSource(async () => [zeroFree('x')]) });
  assert.equal(published.status, 'PUBLISHED');
  const state = await repo().readSyncState();
  assert.equal(state.snapshot_seq.toString(), '2');
});

test('未过期租约在途时跳过外呼（跨进程去重）', async () => {
  // 越过 TTL：本用例要验的是「拿到租约那一刻的在途判定」，前置必须真的走到外呼准入，
  // 否则会先被缓存的 CACHE_FRESH 拦掉，测不到租约去重。
  advance(25 * 3_600_000);
  const held = await repo().tryAcquireLease({
    token: randomUUID(), now: now(), leaseExpiresAt: new Date(clockMs + 60_000),
    evaluate: alwaysAttempt,
  });
  assert.equal(held.kind, 'acquired'); // 占用租约
  const result = await syncModelCatalog({ db: app.db, env: ENV, trigger: 'startup', now,
    source: createFakeCatalogSource(async () => { throw new Error('must not fetch while in-flight'); }) });
  assert.equal(result.status, 'SKIPPED');
  if (result.status === 'SKIPPED') assert.equal(result.reason, 'IN_FLIGHT');
  // 释放，避免影响后续用例。
  await sql`update model_catalog_sync_state set sync_lease_token = null, sync_lease_expires_at = null
    where singleton = true`.execute(app.db);
});

test('来源失败保留旧快照与成功时间，只记失败原因并进入退避', async () => {
  // 同样需要越过 TTL，才能真的发起外呼并让来源失败收口。
  advance(25 * 3_600_000);
  const before = await repo().readSyncState();
  const entriesBefore = await repo().readEntries(false);
  const failed = await syncModelCatalog({ db: app.db, env: ENV, trigger: 'startup', now,
    source: createFakeCatalogSource(async () => { throw new CatalogSourceError('RATE_LIMIT'); }) });
  assert.deepEqual(failed, { status: 'FAILED', reason: 'RATE_LIMIT' });

  const afterState = await repo().readSyncState();
  assert.deepEqual(afterState.directory_digest, before.directory_digest); // 摘要不变
  assert.deepEqual(afterState.last_success_at, before.last_success_at);   // 成功时间不变
  assert.equal(afterState.consecutive_failures, before.consecutive_failures + 1);
  assert.equal(afterState.last_failure_reason, 'RATE_LIMIT');
  const entriesAfter = await repo().readEntries(false);
  assert.equal(entriesAfter.length, entriesBefore.length); // 旧条目原样保留

  // 退避窗口内：再次 startup 直接跳过为 BACKOFF，不重复外呼。
  const backed = await syncModelCatalog({ db: app.db, env: ENV, trigger: 'startup', now,
    source: createFakeCatalogSource(async () => { throw new Error('must not fetch during backoff'); }) });
  assert.deepEqual(backed, { status: 'SKIPPED', reason: 'BACKOFF' });
});

test('合法但为空的目录如实清空免费集合', async () => {
  advance(25 * 3_600_000); // 越过退避（秒级）与缓存 TTL（24h）
  const result = await syncModelCatalog({ db: app.db, env: ENV, trigger: 'startup', now,
    source: createFakeCatalogSource(async () => []) });
  assert.equal(result.status, 'PUBLISHED');
  const entries = await repo().readEntries(false);
  assert.equal(entries.length, 0);
  assert.equal((await repo().readSyncState()).directory_digest?.length, 64);
});

test('CAS：迟到/较旧响应基线不匹配则丢弃，旧结果不得覆盖新快照', async () => {
  const r = repo();
  const base = await r.readSyncState();
  const baseSeq = base.snapshot_seq.toString();
  const staleToken = randomUUID();
  // 模拟一个仍在处理旧响应、基线为 baseSeq 的执行体（此处只借 CAS 语义，不发外呼）。
  const acquired = await r.tryAcquireLease({
    token: staleToken, now: now(), leaseExpiresAt: new Date(clockMs + 600_000), evaluate: alwaysAttempt });
  assert.equal(acquired.kind, 'acquired');
  await r.releaseLease(staleToken); // 交还，让“另一个更成功发布”接管

  // 更成功的一次发布推进 seq 并替换内容。
  const publisherToken = randomUUID();
  const publisher = await r.tryAcquireLease({
    token: publisherToken, now: now(), leaseExpiresAt: new Date(clockMs + 600_000), evaluate: alwaysAttempt });
  assert.equal(publisher.kind, 'acquired');
  if (publisher.kind !== 'acquired') return;
  const publishedNewer = await app.db.transaction().execute((trx) =>
    new ModelCatalogRepository(trx).publishSnapshot({
      token: publisherToken, baseSeq: publisher.baseSeq, digest: 'a'.repeat(64),
      fetchedAt: now(), entries: [{ source_model_id: 'newer', display_name: 'newer',
        context_window: null, pricing: {}, capabilities: { tools: null, text_input: null, text_output: null, image_input: null, structured_outputs: null, response_format: null },
        is_free: false, not_free_reason: 'MISSING_PRICE' }],
    }));
  assert.ok(publishedNewer);

  // 现在再有一个执行体领取租约，基线必须已经不等于 baseSeq（seq 被上面推进过）。
  const freshToken = randomUUID();
  const newer = await r.tryAcquireLease({
    token: freshToken, now: now(), leaseExpiresAt: new Date(clockMs + 600_000), evaluate: alwaysAttempt });
  assert.equal(newer.kind, 'acquired');
  if (newer.kind !== 'acquired') return;
  assert.notEqual(newer.baseSeq, baseSeq); // seq 已被上面推进

  // 旧执行体拿着过期基线尝试发布：CAS 不匹配 → null，内容一字不改。
  const late = await app.db.transaction().execute((trx) =>
    new ModelCatalogRepository(trx).publishSnapshot({
      token: staleToken, baseSeq, digest: 'b'.repeat(64), fetchedAt: now(),
      entries: [{ source_model_id: 'late', display_name: 'late', context_window: null,
        pricing: {}, capabilities: { tools: null, text_input: null, text_output: null, image_input: null, structured_outputs: null, response_format: null },
        is_free: true, not_free_reason: null }],
    }));
  assert.equal(late, null);
  const entries = await r.readEntries(false);
  assert.deepEqual(entries.map((e) => e.source_model_id), ['newer']);
});

test('两个请求读到同一旧状态：领取租约前必须按**当前**状态复核，缓存已新鲜则不重复外呼', async () => {
  advance(25 * 3_600_000); // 越过 TTL，构造出「两个请求都会决定刷新」的起点
  const observed = await repo().readSyncState(); // 即「请求 B 在事务外读到的那一份旧状态」
  assert.ok(observed.last_success_at, '前置：应已有成功快照');

  // 请求 A 先完成一次成功发布，把 last_success_at 刷到现在。
  const published = await syncModelCatalog({ db: app.db, env: ENV, trigger: 'startup', now,
    source: createFakeCatalogSource(async () => [zeroFree('race-a')]) });
  assert.equal(published.status, 'PUBLISHED');

  // 请求 B 现在才来领租约。它手里仍是那份旧状态，但复核必须看到当前状态，
  // 从而得出 CACHE_FRESH 并**放弃外呼**——而不是拿着旧判断再发一次请求。
  let seenLastSuccessAt: Date | null | undefined;
  const attempt = await app.db.transaction().execute((trx) =>
    new ModelCatalogRepository(trx).tryAcquireLease({
      token: randomUUID(), now: now(), leaseExpiresAt: new Date(clockMs + 60_000),
      evaluate: (current) => {
        seenLastSuccessAt = current.last_success_at;
        return shouldAttemptRefresh({
          now: now(), trigger: 'startup',
          lastSuccessAt: current.last_success_at, lastAttemptAt: current.last_attempt_at,
          lastFailureAt: current.last_failure_at, consecutiveFailures: current.consecutive_failures,
          cacheTtlMs: 24 * 3_600_000, minRefreshIntervalMs: 60_000,
          backoffBaseMs: 30_000, backoffMaxMs: 21_600_000,
        });
      },
    }));

  assert.notEqual(seenLastSuccessAt?.getTime(), observed.last_success_at?.getTime(),
    '复核读到的必须是当前状态，而不是请求 B 早先读到的那份旧状态');
  assert.equal(attempt.kind, 'stale');
  if (attempt.kind === 'stale') assert.equal(attempt.reason, 'CACHE_FRESH');
  // 复核判定不刷新时不得留下租约。
  assert.equal((await repo().readSyncState()).sync_lease_token, null);

  // 端到端同样不重复外呼：同一时刻再跑一次同步，来源一旦被调用即失败。
  const second = await syncModelCatalog({ db: app.db, env: ENV, trigger: 'startup', now,
    source: createFakeCatalogSource(async () => { throw new Error('must not fetch while cache is fresh'); }) });
  assert.deepEqual(second, { status: 'SKIPPED', reason: 'CACHE_FRESH' });
});

test('非空的畸形目录不得被当成合法空目录：保留旧快照，且不清空免费集合', async () => {
  advance(25 * 3_600_000); // 越过 TTL，先落地一份已知良好的非空快照
  const seeded = await syncModelCatalog({ db: app.db, env: ENV, trigger: 'startup', now,
    source: createFakeCatalogSource(async () => [zeroFree('keep-me')]) });
  assert.equal(seeded.status, 'PUBLISHED');
  const before = await repo().readSyncState();
  const entriesBefore = await repo().readEntries(false);
  assert.ok(entriesBefore.length > 0, '前置：应已有非空快照');

  advance(25 * 3_600_000); // 让下一次自动触发真的会外呼
  // data:[{}] 这类「非空但没有一条身份完整」的结果，绝不能被解析成零条目并发布。
  const malformed = await syncModelCatalog({ db: app.db, env: ENV, trigger: 'startup', now,
    source: createFakeCatalogSource(async () => [{}]) });
  assert.deepEqual(malformed, { status: 'FAILED', reason: 'INCOMPLETE' });

  const after = await repo().readSyncState();
  assert.deepEqual(after.directory_digest, before.directory_digest); // 摘要不变
  assert.deepEqual(after.last_success_at, before.last_success_at);   // 成功时间不变
  assert.equal(after.last_failure_reason, 'INCOMPLETE');
  assert.equal((await repo().readEntries(false)).length, entriesBefore.length); // 旧条目原样保留

  advance(60_000); // 越过刚记下的退避，让下一次能再次外呼
  // 同一模型 id 给出互相矛盾的记录：整份拒绝，同样不覆盖旧快照。
  const conflict = await syncModelCatalog({ db: app.db, env: ENV, trigger: 'startup', now,
    source: createFakeCatalogSource(async () => [zeroFree('dup'), {
      id: 'dup', name: 'dup', context_length: 128_000,
      pricing: { prompt: '0', completion: '0.001', request: '0' } }]) });
  assert.deepEqual(conflict, { status: 'FAILED', reason: 'PROTOCOL' });
  assert.deepEqual((await repo().readSyncState()).directory_digest, before.directory_digest);
  assert.equal((await repo().readEntries(false)).length, entriesBefore.length);
});
