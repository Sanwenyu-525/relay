import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';

import type { DbExecutor } from '../infrastructure/database.js';
import type { JsonObject } from '../infrastructure/json.js';
import { getRuntimeLogger } from '../infrastructure/runtime-log.js';
import {
  memoryBodyTokens, memoryContentHash, memoryTitleTokens, memoryTrustRank,
} from './memory-model.js';
import { MEMORY_DEFAULTS } from './memory-config.js';
import { createRepositories, withTransaction, type Repositories } from './unit-of-work.js';
import type { MemoryStateRow } from '../information/information-repository.js';

export interface MemoryConsolidationStats extends JsonObject {
  duplicate_groups: number;
  superseded_duplicates: number;
  key_groups: number;
  superseded_key: number;
  stale_marked: number;
  index_backfilled: number;
}

/**
 * 确定性记忆整理（0164）。
 *
 * 只做可核对的动作：同内容/同键去重、陈旧标记、缺失索引回填。它不调用模型，
 * 不生成新事实，不把「被摘要多次」升级成更高可信度。所有替代都保留旧行与指向关系。
 *
 * 并发：事务级 advisory lock；两个 Worker/手动整理同时到达时后者跳过本次。
 */
export async function runMemoryConsolidation(db: DbExecutor, r: Repositories, input: {
  readonly workspaceId: string; readonly trigger: 'MANUAL' | 'AUTO' | 'CLI';
  readonly staleAfterDays?: number; readonly batchSize?: number;
}): Promise<{ readonly status: 'COMPLETED' | 'SKIPPED'; readonly stats: MemoryConsolidationStats }> {
  let locked = false;
  try {
    const lock = await sql<{ locked: boolean }>`select pg_try_advisory_xact_lock(
      hashtextextended(${`memory-consolidation:${input.workspaceId}`}, 0)) as locked`
      .execute(db);
    locked = lock.rows[0]?.locked === true;
  } catch {
    locked = false;
  }
  if (!locked) {
    return { status: 'SKIPPED', stats: { duplicate_groups: 0, superseded_duplicates: 0,
      key_groups: 0, superseded_key: 0, stale_marked: 0, index_backfilled: 0 } };
  }
  const batch = Math.min(Math.max(input.batchSize ?? MEMORY_DEFAULTS.maintenanceBatchSize, 1), 200);
  const runId = randomUUID();
  await r.information.insertMemoryMaintenanceRun({ id: runId, workspaceId: input.workspaceId,
    trigger: input.trigger });

  const chooseKeeper = (rows: readonly MemoryStateRow[]): MemoryStateRow => rows.slice().sort((left, right) => {
    if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
    const leftVerified = left.verification === 'VERIFIED' ? 1 : 0;
    const rightVerified = right.verification === 'VERIFIED' ? 1 : 0;
    if (leftVerified !== rightVerified) return rightVerified - leftVerified;
    const trust = memoryTrustRank(right.origin, right.source_kind)
      - memoryTrustRank(left.origin, left.source_kind);
    if (trust !== 0) return trust;
    if (left.importance !== right.importance) return right.importance - left.importance;
    if (left.confidence !== right.confidence) return right.confidence - left.confidence;
    return right.updated_at.getTime() - left.updated_at.getTime();
  })[0]!;

  const stats: MemoryConsolidationStats = { duplicate_groups: 0, superseded_duplicates: 0,
    key_groups: 0, superseded_key: 0, stale_marked: 0, index_backfilled: 0 };

  const duplicateGroups = await r.information.listDuplicateMemoryGroups(input.workspaceId, batch);
  stats.duplicate_groups = duplicateGroups.length;
  for (const group of duplicateGroups) {
    const rows = await r.information.listMemoryStatesByIds(input.workspaceId, group.ids);
    const active = rows.filter((row) => row.effective_status === 'ACTIVE');
    if (active.length < 2) continue;
    const keeper = chooseKeeper(active);
    for (const row of active) {
      if (row.id === keeper.id) continue;
      await r.information.supersedeMemory(row.id, keeper.id, 'CONSOLIDATED_DUPLICATE');
      stats.superseded_duplicates += 1;
    }
  }

  const keyGroups = await r.information.listDuplicateMemoryKeyGroups(input.workspaceId, batch);
  stats.key_groups = keyGroups.length;
  for (const group of keyGroups) {
    const rows = await r.information.listMemoryStatesByIds(input.workspaceId, group.ids);
    const active = rows.filter((row) => row.effective_status === 'ACTIVE');
    if (active.length < 2) continue;
    const keeper = chooseKeeper(active);
    for (const row of active) {
      if (row.id === keeper.id) continue;
      await r.information.supersedeMemory(row.id, keeper.id, 'CONSOLIDATED_KEY');
      stats.superseded_key += 1;
    }
  }

  const staleDays = Math.min(Math.max(input.staleAfterDays ?? MEMORY_DEFAULTS.memoryStaleAfterDays,
    7), 3650);
  const olderThan = new Date(Date.now() - staleDays * 24 * 60 * 60 * 1000);
  stats.stale_marked = await r.information.markMemoriesStale(input.workspaceId, olderThan, batch);

  const unindexed = await r.information.listUnindexedMemories(input.workspaceId, batch);
  for (const row of unindexed) {
    const titleTokens = memoryTitleTokens(row.title).join(' ');
    const bodyTokens = memoryBodyTokens(row.body_text).join(' ');
    await r.information.updateMemoryMetadata({ memoryId: row.id,
      contentHash: memoryContentHash(row.title, row.body_text),
      searchTitleTokens: titleTokens, searchBodyTokens: bodyTokens });
    stats.index_backfilled += 1;
  }

  await r.information.finishMemoryMaintenanceRun({ id: runId, status: 'COMPLETED',
    stats, error: null });
  return { status: 'COMPLETED', stats };
}

/**
 * Worker 低频整理入口：每拍最多处理一个到期工作区。
 *
 * 到期条件 = 开启自动整理 + 至少有一条记忆 + 上次成功整理早于配置间隔。
 * 没有到期工作区时返回 null，不产生空转日志。
 */
export async function runMemoryConsolidationTick(db: DbExecutor,
  now = new Date()): Promise<{ workspaceId: string; stats: MemoryConsolidationStats } | null> {
  const due = (await sql<{ workspace_id: string; memory_stale_after_days: number }>`
    select distinct m.workspace_id,
      coalesce(s.memory_stale_after_days, 180)::int as memory_stale_after_days
    from memory_items m
    left join workspace_memory_settings s on s.workspace_id = m.workspace_id
    where coalesce(s.auto_consolidate, true)
      and not exists (
        select 1 from memory_maintenance_runs r
        where r.workspace_id = m.workspace_id and r.status = 'RUNNING'
          and r.started_at > ${new Date(now.getTime() - 15 * 60 * 1000)})
      and (
        not exists (select 1 from memory_maintenance_runs r
          where r.workspace_id = m.workspace_id and r.status = 'COMPLETED')
        or (select max(r.finished_at) from memory_maintenance_runs r
          where r.workspace_id = m.workspace_id and r.status = 'COMPLETED')
          < now() - make_interval(hours => coalesce(s.consolidation_interval_hours, 24))
      )
    order by m.workspace_id limit 1`.execute(db)).rows[0];
  if (due === undefined) return null;
  try {
    const result = await withTransaction(db, (r) => runMemoryConsolidation(db, r, {
      workspaceId: due.workspace_id, trigger: 'AUTO',
      staleAfterDays: due.memory_stale_after_days,
    }));
    if (result.status !== 'COMPLETED') return null;
    return { workspaceId: due.workspace_id, stats: result.stats };
  } catch (error) {
    getRuntimeLogger('memory').warn('memory_consolidation_failed', {
      workspace_id: due.workspace_id,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
