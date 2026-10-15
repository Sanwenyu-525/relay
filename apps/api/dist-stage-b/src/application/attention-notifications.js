import { sql } from 'kysely';
import { requireWorkspaceVisible } from './guards.js';
/** The open projection is always recomputed from business facts; receipts never own resolution. */
export async function listInterventionItems(db, workspaceId) {
    await requireWorkspaceVisible(db, workspaceId);
    const [reviews, conflicts, failedRuns, operations, effects] = await Promise.all([
        sql `select id, revision, kind, reason from review_requests
      where workspace_id = ${workspaceId} and status = 'OPEN'
        and (expires_at is null or expires_at > now())
      order by created_at, id`.execute(db),
        sql `select c.id, c.artifact_id, c.base_version_id,
        c.run_id, c.reason from artifact_lock_conflicts c
      join runs r on r.id = c.run_id
      join tasks t on t.id = r.task_id
      where c.workspace_id = ${workspaceId} and r.status = 'FAILED'
        and t.status not in ('DONE', 'CANCELLED')
        and not exists (select 1 from runs newer where newer.task_id = r.task_id
          and (newer.created_at, newer.id) > (r.created_at, r.id))
        and exists (select 1 from artifact_text_locks l where l.artifact_id = c.artifact_id)
      order by c.created_at, c.id`.execute(db),
        sql `select r.id, r.revision, r.wait_reason from runs r
      join tasks t on t.id = r.task_id
      where r.workspace_id = ${workspaceId} and r.status = 'FAILED'
        and t.status not in ('DONE', 'CANCELLED')
        and not exists (select 1 from runs newer where newer.task_id = r.task_id
          and (newer.created_at, newer.id) > (r.created_at, r.id))
      order by r.updated_at, r.id`.execute(db),
        sql `select id, run_id from logical_operations
      where workspace_id = ${workspaceId} and status = 'UNKNOWN'
      order by updated_at, id`.execute(db),
        sql `select e.operation_id as id, e.run_id from run_effect_actions e
      join runs r on r.id = e.run_id where r.workspace_id = ${workspaceId}
        and e.status = 'UNKNOWN' order by e.created_at, e.operation_id`.execute(db),
    ]);
    const items = [];
    for (const row of reviews.rows)
        items.push({ item_key: `review:${row.id}`,
            change_key: row.revision.toString(), kind: 'REVIEW', title: '有待审批事项',
            reason: `${row.kind}：${row.reason}`, target_url: `/reviews?id=${row.id}` });
    for (const row of conflicts.rows)
        items.push({ item_key: `lock-conflict:${row.id}`,
            change_key: row.base_version_id, kind: 'LOCK_CONFLICT', title: '锁定原文与 AI 候选冲突',
            reason: row.reason, target_url: `/runs/${row.run_id}` });
    const conflictRuns = new Set(conflicts.rows.map((row) => row.run_id));
    for (const row of failedRuns.rows)
        if (!conflictRuns.has(row.id))
            items.push({
                item_key: `run-failed:${row.id}`, change_key: row.revision.toString(),
                kind: 'RUN_FAILED', title: '执行失败，需要人工核对',
                reason: row.wait_reason ?? 'Run 已失败，不能自行继续。', target_url: `/runs/${row.id}`
            });
    for (const row of [...operations.rows, ...effects.rows])
        items.push({
            item_key: `unknown:${row.id}`, change_key: 'UNKNOWN', kind: 'UNKNOWN',
            title: '动作结果不明，需要核对', reason: `Operation ${row.id} 的结果不明。`,
            target_url: row.run_id ? `/runs/${row.run_id}` : '/tasks?tab=attention'
        });
    return [...new Map(items.map((item) => [item.item_key, item])).values()];
}
export async function claimInterventionNotifications(db, workspaceId) {
    return db.transaction().execute(async (trx) => {
        const items = await listInterventionItems(trx, workspaceId);
        const claimed = [];
        for (const item of items) {
            const result = await sql `insert into attention_notification_receipts
        (workspace_id, item_key, change_key) values
        (${workspaceId}, ${item.item_key}, ${item.change_key})
        on conflict do nothing returning item_key`.execute(trx);
            if (result.rows.length)
                claimed.push(item);
        }
        return claimed;
    });
}
export async function settleInterventionNotification(db, workspaceId, itemKey, changeKey, status) {
    await requireWorkspaceVisible(db, workspaceId);
    await sql `update attention_notification_receipts set delivery_status = ${status}
    where workspace_id = ${workspaceId} and item_key = ${itemKey}
      and change_key = ${changeKey} and delivery_status = 'CLAIMED'`.execute(db);
}
