import { createHash, randomUUID } from 'node:crypto';

import type { DbExecutor } from '../infrastructure/database.js';
import type { ModelCatalogSyncStateRow } from '../infrastructure/database-schema.js';
import { DomainError } from './domain-error.js';
import { createRepositories } from './unit-of-work.js';
import { readAdmission } from './maintenance-admission.js';
import {
  ModelCatalogRepository, type CatalogFailureReason, type LeaseDecision,
} from '../model/model-catalog-repository.js';
import { resolveCatalogSnapshot, type ResolvedCatalogEntry } from '../workflow/model-catalog-pricing.js';
import { readModelCatalogConfig, shouldAttemptRefresh, type SyncSkipReason } from '../workflow/model-catalog-config.js';
import { CatalogSourceError, createOpenRouterCatalogSource, type CatalogSourcePort } from '../workflow/openrouter-catalog-source.js';

/**
 * 免费模型目录同步用例（专项阶段 B；测试 FM-02/FM-03/FM-04/FM-05）。
 *
 * 生命周期纪律：
 * 1) 目录是进程级全局事实，不建 Task/Run、不写 model_calls、不发推理——这里只做「读来源 + 落快照」。
 * 2) 外呼放在事务外；租约领取与快照发布各自是独立短事务，网络等待绝不占着事务/行锁。
 * 3) 跨进程/多客户端去重靠 DB 租约：只有拿到未过期租约的执行体才发起外呼。
 * 4) 发布用 snapshot_seq 做 CAS：迟到或较旧的响应基线不匹配即丢弃，旧响应不得覆盖新快照。
 * 5) 来源失败保留旧快照与成功时间，仅记失败原因并推进退避；合法但为空的目录如实清空免费集合。
 * 6) 凭据只按引用留在服务端解析，摘要与快照都不含密钥、endpoint 之外的敏感信息。
 */

export type SyncModelCatalogResult =
  | { readonly status: 'NOT_CONFIGURED' }
  | { readonly status: 'SKIPPED'; readonly reason: SyncSkipReason }
  | { readonly status: 'REJECTED'; readonly reason: 'MAINTENANCE' }
  | { readonly status: 'PUBLISHED'; readonly snapshotSeq: string;
      readonly totalCount: number; readonly freeCount: number; readonly fetchedAt: string }
  | { readonly status: 'FAILED'; readonly reason: CatalogFailureReason };

export interface SyncModelCatalogInput {
  readonly db: DbExecutor;
  readonly env: NodeJS.ProcessEnv;
  readonly trigger: 'startup' | 'open' | 'manual';
  /** 可控来源：单测注入假源；缺省用真实 OpenRouter 来源（仍走 guardedModelFetch）。 */
  readonly source?: CatalogSourcePort;
  /** 可控时钟：所有时间戳与租约/退避判定共用同一 now，便于确定性测试。 */
  readonly now?: () => Date;
}

export async function syncModelCatalog(
  input: SyncModelCatalogInput,
): Promise<SyncModelCatalogResult> {
  const config = readModelCatalogConfig(input.env);
  if (config === undefined) return { status: 'NOT_CONFIGURED' };
  const now = input.now ?? (() => new Date());
  const repo = new ModelCatalogRepository(input.db);

  // 1) 读当前发布头，判断此刻是否该外呼（退避优先，其次按触发方式看 TTL / 手动限速）。
  const state = await repo.readSyncState();
  const decision = shouldAttemptRefresh({
    now: now(), trigger: input.trigger,
    lastSuccessAt: state.last_success_at, lastAttemptAt: state.last_attempt_at,
    lastFailureAt: state.last_failure_at, consecutiveFailures: state.consecutive_failures,
    cacheTtlMs: config.cacheTtlMs, minRefreshIntervalMs: config.minRefreshIntervalMs,
    backoffBaseMs: config.backoffBaseMs, backoffMaxMs: config.backoffMaxMs,
  });
  if (!decision.attempt) return { status: 'SKIPPED', reason: decision.reason };

  // 2) 单事务：先核对维护准入，再**按当前状态复核一次**并原子领取租约（跨进程去重）。
  //    维护/排空态直接拒绝，不发起外呼也不领租约。
  //
  //    为什么必须在这里复核：步骤 1 的读取是无锁的，两个请求完全可能读到同一份**旧**状态、
  //    都判断「该刷新」。若其中一个先完成了外呼与发布，另一个随后才进到这里，租约早已被前者
  //    释放，于是它会拿旧判断再发一次外呼——缓存明明已经新鲜。把 TTL/退避/手动限速的判定
  //    钉在「持有该行锁、读到当前发布头之后」，两个请求就串行收敛到真实状态。
  const startedAt = now();
  const token = randomUUID();
  const decide = (state: ModelCatalogSyncStateRow): LeaseDecision =>
    shouldAttemptRefresh({
      now: now(), trigger: input.trigger,
      lastSuccessAt: state.last_success_at, lastAttemptAt: state.last_attempt_at,
      lastFailureAt: state.last_failure_at, consecutiveFailures: state.consecutive_failures,
      cacheTtlMs: config.cacheTtlMs, minRefreshIntervalMs: config.minRefreshIntervalMs,
      backoffBaseMs: config.backoffBaseMs, backoffMaxMs: config.backoffMaxMs,
    });
  type LeaseOutcome =
    | { readonly kind: 'rejected' }
    | { readonly kind: 'inflight' }
    | { readonly kind: 'stale'; readonly reason: SyncSkipReason }
    | { readonly kind: 'lease'; readonly baseSeq: string };
  let outcome: LeaseOutcome;
  try {
    outcome = await input.db.transaction().execute(async (trx) => {
      const repositories = createRepositories(trx);
      const gate = await readAdmission(repositories, 'share');
      if (gate.mode !== 'NORMAL') return { kind: 'rejected' };
      const leaseExpiresAt = new Date(startedAt.getTime() + config.leaseTtlMs);
      const attempt = await repositories.modelCatalog.tryAcquireLease({
        token, now: startedAt, leaseExpiresAt, evaluate: decide,
      });
      if (attempt.kind === 'stale') return { kind: 'stale', reason: attempt.reason };
      return attempt.kind === 'inflight'
        ? { kind: 'inflight' }
        : { kind: 'lease', baseSeq: attempt.baseSeq };
    });
  } catch (error) {
    // readAdmission 在门不可用时抛 DomainError(503)：目录刷新非关键，如实拒绝且不改动任何事实。
    if (error instanceof DomainError) return { status: 'REJECTED', reason: 'MAINTENANCE' };
    throw error;
  }
  if (outcome.kind === 'rejected') return { status: 'REJECTED', reason: 'MAINTENANCE' };
  if (outcome.kind === 'stale') return { status: 'SKIPPED', reason: outcome.reason };
  if (outcome.kind === 'inflight') return { status: 'SKIPPED', reason: 'IN_FLIGHT' };
  const baseSeq = outcome.baseSeq;

  // 3) 事务外发起一次有界 GET；任何来源失败 → 记失败原因并保留旧快照，随后释放租约（在 recordFailure 内）。
  const source = input.source ?? createOpenRouterCatalogSource(config);
  const signal = AbortSignal.timeout(config.fetchTimeoutMs);
  let rawEntries: readonly unknown[];
  try {
    rawEntries = await source.fetchCatalog(signal);
  } catch (error) {
    const reason: CatalogFailureReason = error instanceof CatalogSourceError ? error.reason : 'NETWORK';
    await repo.recordFailure({ token, reason, at: now() });
    return { status: 'FAILED', reason };
  }

  // 4) 整份解析：非空畸形结果不得被当成「合法的空目录」；同一模型 id 的矛盾重复不得静默取首见者。
  //    两者都收口为「不发布」，保留最近一次成功快照与其成功时间（绝不覆盖旧缓存）。
  const resolution = resolveCatalogSnapshot(rawEntries);
  if (resolution.kind !== 'OK') {
    const reason: CatalogFailureReason = resolution.kind === 'CONFLICT' ? 'PROTOCOL' : 'INCOMPLETE';
    await repo.recordFailure({ token, reason, at: now() });
    return { status: 'FAILED', reason };
  }
  const entries = resolution.entries;

  // 5) CAS 原子发布（同事务：CAS 更新发布头 + 整体替换条目）。基线被更成功发布推进 → 本次作废。
  const fetchedAt = now();
  const digest = catalogDigest(entries);
  const published = await input.db.transaction().execute((trx) =>
    createRepositories(trx).modelCatalog.publishSnapshot({
      token, baseSeq, digest, fetchedAt, entries,
    }));
  if (published === null) return { status: 'SKIPPED', reason: 'SUPERSEDED' };

  const freeCount = entries.reduce((count, entry) => entry.is_free ? count + 1 : count, 0);
  return {
    status: 'PUBLISHED', snapshotSeq: published.snapshotSeq,
    totalCount: entries.length, freeCount, fetchedAt: fetchedAt.toISOString(),
  };
}

/**
 * 快照内容摘要：对「影响免费判定与展示」的字段做稳定序列化（按 id 排序、pricing 键排序），
 * 与来源无关字段（fetched_at）不参与。仅作发布头的可核实指纹，不用于比较跳过发布——
 * 每次成功外呼都刷新 fetched_at 并整体替换，以保持「上次成功时间」语义清晰。
 */
function catalogDigest(entries: readonly ResolvedCatalogEntry[]): string {
  const canonical = [...entries]
    .sort((a, b) => a.source_model_id < b.source_model_id ? -1 : a.source_model_id > b.source_model_id ? 1 : 0)
    .map((entry) => [
      entry.source_model_id, entry.display_name, entry.context_window,
      entry.is_free, entry.not_free_reason, canonicalPricing(entry.pricing),
    ]);
  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}

function canonicalPricing(pricing: Record<string, string>): string {
  const sorted = Object.keys(pricing).sort().map((key) => [key, pricing[key] ?? '']);
  return JSON.stringify(sorted);
}
