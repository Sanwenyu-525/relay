import { sql } from 'kysely';
import type { DbExecutor } from '../infrastructure/database.js';
import { requireWorkspaceVisible } from './guards.js';

export interface AttentionItem {
  readonly item_key: string;
  readonly change_key: string;
  readonly kind: 'REVIEW' | 'LOCK_CONFLICT' | 'RUN_FAILED' | 'UNKNOWN';
  readonly title: string;
  readonly reason: string;
  readonly target_url: string;
}

interface ReviewAttentionRow { id: string; revision: bigint; kind: string; reason: string }
interface ConflictAttentionRow { id: string; artifact_id: string; base_version_id: string;
  run_id: string; reason: string }
interface RunAttentionRow { id: string; revision: bigint; wait_reason: string | null }
interface UnknownAttentionRow { id: string; run_id: string | null }

/** The open projection is always recomputed from business facts; receipts never own resolution. */
export async function listInterventionItems(db: DbExecutor, workspaceId: string): Promise<readonly AttentionItem[]> {
  await requireWorkspaceVisible(db, workspaceId);
  const [reviews, conflicts, failedRuns, operations, effects] = await Promise.all([
    sql<ReviewAttentionRow>`select id, revision, kind, reason from review_requests
      where workspace_id = ${workspaceId} and status = 'OPEN'
        and (expires_at is null or expires_at > now())
      order by created_at, id`.execute(db),
    sql<ConflictAttentionRow>`select c.id, c.artifact_id, c.base_version_id,
        c.run_id, c.reason from artifact_lock_conflicts c
      join runs r on r.id = c.run_id
      join tasks t on t.id = r.task_id
      where c.workspace_id = ${workspaceId} and r.status = 'FAILED'
        and t.status not in ('DONE', 'CANCELLED')
        and not exists (select 1 from runs newer where newer.task_id = r.task_id
          and (newer.created_at, newer.id) > (r.created_at, r.id))
        and exists (select 1 from artifact_text_locks l where l.artifact_id = c.artifact_id)
      order by c.created_at, c.id`.execute(db),
    sql<RunAttentionRow>`select r.id, r.revision, r.wait_reason from runs r
      join tasks t on t.id = r.task_id
      where r.workspace_id = ${workspaceId} and r.status = 'FAILED'
        and t.status not in ('DONE', 'CANCELLED')
        and not exists (select 1 from runs newer where newer.task_id = r.task_id
          and (newer.created_at, newer.id) > (r.created_at, r.id))
      order by r.updated_at, r.id`.execute(db),
    sql<UnknownAttentionRow>`select id, run_id from logical_operations
      where workspace_id = ${workspaceId} and status = 'UNKNOWN'
      order by updated_at, id`.execute(db),
    sql<UnknownAttentionRow>`select e.operation_id as id, e.run_id from run_effect_actions e
      join runs r on r.id = e.run_id where r.workspace_id = ${workspaceId}
        and e.status = 'UNKNOWN' order by e.created_at, e.operation_id`.execute(db),
  ]);
  const items: AttentionItem[] = [];
  for (const row of reviews.rows) items.push({ item_key: `review:${row.id}`,
    change_key: row.revision.toString(), kind: 'REVIEW', title: '有待审批事项',
    reason: `${row.kind}：${row.reason}`, target_url: `/reviews?id=${row.id}` });
  for (const row of conflicts.rows) items.push({ item_key: `lock-conflict:${row.id}`,
    change_key: row.base_version_id, kind: 'LOCK_CONFLICT', title: '锁定原文与 AI 候选冲突',
    reason: row.reason, target_url: `/runs/${row.run_id}` });
  const conflictRuns = new Set(conflicts.rows.map((row) => row.run_id));
  for (const row of failedRuns.rows) if (!conflictRuns.has(row.id)) items.push({
    item_key: `run-failed:${row.id}`, change_key: row.revision.toString(),
    kind: 'RUN_FAILED', title: '执行失败，需要人工核对',
    reason: row.wait_reason ?? 'Run 已失败，不能自行继续。', target_url: `/runs/${row.id}` });
  for (const row of [...operations.rows, ...effects.rows]) items.push({
    item_key: `unknown:${row.id}`, change_key: 'UNKNOWN', kind: 'UNKNOWN',
    title: '动作结果不明，需要核对', reason: `Operation ${row.id} 的结果不明。`,
    target_url: row.run_id ? `/runs/${row.run_id}` : '/tasks?tab=attention' });
  return [...new Map(items.map((item) => [item.item_key, item])).values()];
}

export async function claimInterventionNotifications(db: DbExecutor, workspaceId: string):
  Promise<readonly AttentionItem[]> {
  return db.transaction().execute(async (trx) => {
    const items = await listInterventionItems(trx, workspaceId);
    const claimed: AttentionItem[] = [];
    for (const item of items) {
      const result = await sql<{ item_key: string }>`insert into attention_notification_receipts
        (workspace_id, item_key, change_key) values
        (${workspaceId}, ${item.item_key}, ${item.change_key})
        on conflict do nothing returning item_key`.execute(trx);
      if (result.rows.length) claimed.push(item);
    }
    return claimed;
  });
}

export async function settleInterventionNotification(db: DbExecutor, workspaceId: string,
  itemKey: string, changeKey: string, status: 'DISPATCHED' | 'DENIED' | 'FAILED'): Promise<void> {
  await requireWorkspaceVisible(db, workspaceId);
  await sql`update attention_notification_receipts set delivery_status = ${status}
    where workspace_id = ${workspaceId} and item_key = ${itemKey}
      and change_key = ${changeKey} and delivery_status = 'CLAIMED'`.execute(db);
}
