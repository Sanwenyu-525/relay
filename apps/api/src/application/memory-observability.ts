import { sql } from 'kysely';

import type { DbExecutor } from '../infrastructure/database.js';
import type { JsonObject } from '../infrastructure/json.js';
import { createRepositories } from './unit-of-work.js';

/** 记忆管理页的真实统计：全部来自数据库聚合与运行记录，不生成演示数字。 */
export async function readMemoryObservability(db: DbExecutor, workspaceId: string,
  projectId: string | null): Promise<JsonObject> {
  const r = createRepositories(db);
  const stats = await r.information.memoryStats(workspaceId, projectId);
  const types = await r.information.memoryCountsByType(workspaceId, projectId);
  const runs = await r.information.listMemoryMaintenanceRuns(workspaceId, 5);
  const fts = (await sql<{ present: boolean }>`select exists (
    select 1 from pg_indexes where schemaname = current_schema()
      and indexname = 'ix_memory_items_fts') as present`.execute(db)).rows[0];
  return {
    total: stats.total, active: stats.active, superseded: stats.superseded,
    retired: stats.retired, expired: stats.expired, stale: stats.stale,
    pinned: stats.pinned, storage_bytes: stats.storage_bytes,
    unverified: stats.unverified, failed: stats.failed,
    instruction_risk: stats.instruction_risk,
    index_health: {
      fts_index_present: fts?.present ?? false,
      unindexed: stats.unindexed,
    },
    recall: { last_24h: stats.recall_24h, avg_latency_ms: stats.avg_latency_ms,
      last_at: stats.last_recall_at?.toISOString() ?? null },
    capture: { pending: stats.capture_pending, failed: stats.capture_failed,
      last_24h: stats.capture_last_24h },
    maintenance: { last_at: stats.last_maintenance_at?.toISOString() ?? null,
      runs: runs.map((row) => ({ id: row.id, trigger: row.trigger, status: row.status,
        stats: row.stats, error: row.error,
        started_at: row.started_at.toISOString(),
        finished_at: row.finished_at?.toISOString() ?? null })) },
    types: types.map((row) => ({ memory_type: row.memory_type, count: row.count })),
  };
}
