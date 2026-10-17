import { sql } from 'kysely';

import type { DbExecutor } from '../infrastructure/database.js';
import type {
  ModelCatalogSyncStateRow, ModelCatalogEntryRow,
} from '../infrastructure/database-schema.js';
import { requireRow } from '../shared/sql-rows.js';
import type { ResolvedCatalogEntry } from '../workflow/model-catalog-pricing.js';
import type { SyncSkipReason } from '../workflow/model-catalog-config.js';

/**
 * 模型目录快照与同步状态的独占 SQL Owner（迁移 0088，专项阶段 B）。
 * 用例负责开事务并绑定同一个执行器；本仓库不自开 transaction()/commit()。
 * 快照发布是「CAS + 整体替换」的同一短事务，读取永远看到完整一份，不会读到半份。
 * 网络拉取由用例放在事务外；这里只做持久化，不发外呼、不建 Task/Run、不写 model_calls。
 */

export const CATALOG_FAILURE_REASONS = [
  'NETWORK', 'TIMEOUT', 'AUTH', 'RATE_LIMIT', 'PROTOCOL',
  'INCOMPLETE', 'ENDPOINT_NOT_ALLOWED', 'NOT_CONFIGURED',
] as const;
export type CatalogFailureReason = typeof CATALOG_FAILURE_REASONS[number];

export interface AcquiredLease { readonly token: string; readonly baseSeq: string; }
export interface PublishedSnapshot { readonly snapshotSeq: string; }

/** 领取租约前在同一行锁内做的复核结论；不刷新时连带给出跳过的原因。 */
export type LeaseDecision =
  | { readonly attempt: true }
  | { readonly attempt: false; readonly reason: SyncSkipReason };

/** 领取租约的结果：领到、已被别人占、或复核后决定不刷新（未领租约、未改任何事实）。 */
export type LeaseAttempt =
  | { readonly kind: 'acquired'; readonly baseSeq: string }
  | { readonly kind: 'inflight' }
  | { readonly kind: 'stale'; readonly reason: SyncSkipReason };

export class ModelCatalogRepository {
  constructor(private readonly db: DbExecutor) {}

  /** 单例发布头。迁移预置一行，运行期不会缺行；缺行属于实现/迁移错误。 */
  async readSyncState(): Promise<ModelCatalogSyncStateRow> {
    const result = await sql<ModelCatalogSyncStateRow>`
      select * from model_catalog_sync_state where singleton = true
    `.execute(this.db);
    return requireRow(result.rows, 'read model catalog sync state');
  }

  /** 读当前快照条目。freeOnly 只取严格免费项；顺序稳定便于 UI 与测试。 */
  async readEntries(freeOnly: boolean): Promise<readonly ModelCatalogEntryRow[]> {
    const result = freeOnly
      ? await sql<ModelCatalogEntryRow>`
        select * from model_catalog_entries where is_free = true order by source_model_id
      `.execute(this.db)
      : await sql<ModelCatalogEntryRow>`
        select * from model_catalog_entries order by source_model_id
      `.execute(this.db);
    return result.rows;
  }

  /** 0093：按来源模型 id 读当前目录条目（图片附件能力闸门用）；无条目返回 undefined。 */
  async readEntryBySourceModelId(sourceModelId: string): Promise<ModelCatalogEntryRow | undefined> {
    return (await sql<ModelCatalogEntryRow>`select * from model_catalog_entries
      where source_model_id = ${sourceModelId}
      order by fetched_at desc limit 1`.execute(this.db)).rows[0];
  }

  /**
   * 读取发布头并**锁住该行**（`for update`），供后续决策与领取租约在同一行锁内串行化。
   * 只在调用方已开启的事务里使用；锁随事务结束释放，不会跨外呼持有。
   */
  async readSyncStateForUpdate(): Promise<ModelCatalogSyncStateRow> {
    const result = await sql<ModelCatalogSyncStateRow>`
      select * from model_catalog_sync_state where singleton = true for update
    `.execute(this.db);
    return requireRow(result.rows, 'lock model catalog sync state');
  }

  /**
   * 原子领取同步租约：仅当没有未过期租约时成功（跨进程/多客户端去重）。
   *
   * `evaluate` 在**持有该行锁、读到当前发布头之后**调用，把「此刻是否还该外呼」的判定
   * （缓存 TTL、退避、手动刷新最小间隔）钉在领取租约那一刻，而不是更早某次无锁读取的
   * 快照上。这是为了堵住一个真实的竞争：两个请求都读到同一份**旧**状态、都判断「该刷新」，
   * 其中一个成功后另一个才来领租约——此时租约早已释放，若沿用旧判断就会在缓存已新鲜时
   * 再发一次外呼。判定为不刷新时本方法**不领取租约**，也不改任何事实。
   */
  async tryAcquireLease(input: {
    readonly token: string;
    readonly now: Date;
    readonly leaseExpiresAt: Date;
    readonly evaluate: (current: ModelCatalogSyncStateRow) => LeaseDecision;
  }): Promise<LeaseAttempt> {
    const current = await this.readSyncStateForUpdate();
    const decision = input.evaluate(current);
    if (!decision.attempt) return { kind: 'stale', reason: decision.reason };
    const result = await sql<{ snapshot_seq: string }>`
      update model_catalog_sync_state
      set sync_lease_token = ${input.token}, sync_lease_expires_at = ${input.leaseExpiresAt},
        last_attempt_at = ${input.now}, revision = revision + 1
      where singleton = true
        and (sync_lease_token is null or sync_lease_expires_at < ${input.now})
      returning snapshot_seq::text as snapshot_seq
    `.execute(this.db);
    const row = result.rows[0];
    return row === undefined
      ? { kind: 'inflight' }
      : { kind: 'acquired', baseSeq: row.snapshot_seq };
  }

  /**
   * CAS 原子发布：只有仍持有本租约、且基线 seq 未被更成功发布推进时才替换快照。
   * 成功 → 写新 digest、seq+1、刷新成功时间、清零退避、清租约，并在同一事务整体替换条目。
   * 返回 null（0 行）→ 本次为较旧响应或已失租，条目一字不改，直接丢弃。
   */
  async publishSnapshot(input: {
    readonly token: string;
    readonly baseSeq: string;
    readonly digest: string;
    readonly fetchedAt: Date;
    readonly entries: readonly ResolvedCatalogEntry[];
  }): Promise<PublishedSnapshot | null> {
    const updated = await sql<{ snapshot_seq: string }>`
      update model_catalog_sync_state
      set directory_digest = ${input.digest}, snapshot_seq = snapshot_seq + 1,
        last_success_at = ${input.fetchedAt}, last_failure_at = null, last_failure_reason = null,
        consecutive_failures = 0, sync_lease_token = null, sync_lease_expires_at = null,
        revision = revision + 1
      where singleton = true and sync_lease_token = ${input.token}
        and snapshot_seq = ${input.baseSeq}::bigint
      returning snapshot_seq::text as snapshot_seq
    `.execute(this.db);
    const row = updated.rows[0];
    if (row === undefined) return null; // CAS 失败：旧响应不得覆盖更新快照，丢弃本次。
    await sql`delete from model_catalog_entries`.execute(this.db);
    for (const entry of input.entries) {
      await sql`
        insert into model_catalog_entries
          (source_model_id, display_name, context_window, pricing, capabilities, is_free, not_free_reason, fetched_at)
        values
          (${entry.source_model_id}, ${entry.display_name}, ${entry.context_window},
          ${JSON.stringify(entry.pricing)}::jsonb, ${JSON.stringify(entry.capabilities)}::jsonb,
          ${entry.is_free}, ${entry.not_free_reason}, ${input.fetchedAt})
      `.execute(this.db);
    }
    return { snapshotSeq: row.snapshot_seq };
  }

  /** 失败收口：保留旧快照与成功时间，仅记失败原因与递增退避，并释放租约。 */
  async recordFailure(input: { token: string; reason: CatalogFailureReason; at: Date }): Promise<void> {
    await sql`
      update model_catalog_sync_state
      set last_failure_at = ${input.at}, last_failure_reason = ${input.reason},
        consecutive_failures = consecutive_failures + 1,
        sync_lease_token = null, sync_lease_expires_at = null, revision = revision + 1
      where singleton = true and sync_lease_token = ${input.token}
    `.execute(this.db);
  }

  /** 未发起外呼即放弃（如未配置/门拒绝）时释放已领租约，不改任何业务事实。 */
  async releaseLease(token: string): Promise<void> {
    await sql`
      update model_catalog_sync_state
      set sync_lease_token = null, sync_lease_expires_at = null, revision = revision + 1
      where singleton = true and sync_lease_token = ${token}
    `.execute(this.db);
  }
}
