import { sql } from 'kysely';
import { requireRow } from '../shared/sql-rows.js';
/**
 * 关键审计：与业务事实在同一事务写入。
 * 这不是事件溯源主存储，只保存可追溯到命令、Project/Task 与事实引用的记录。
 */
export class ActivityRecordRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    async insertActivityRecord(record) {
        const result = await sql `
      insert into activity_records (
        id, workspace_id, actor_kind, actor_ref, command_id, project_id, task_id,
        run_id, event_type, fact_refs
      )
      values (
        ${record.id}, ${record.workspaceId}, ${record.actorKind}, ${record.actorRef},
        ${record.commandId}, ${record.projectId}, ${record.taskId},
        ${record.runId ?? null}, ${record.eventType},
        ${JSON.stringify(record.factRefs)}::jsonb
      )
      returning id, workspace_id, actor_kind, actor_ref, command_id, project_id,
                task_id, run_id, event_type, fact_refs, created_at
    `.execute(this.db);
        return requireRow(result.rows, 'insert into activity_records');
    }
    async listActivityRecordsByCommand(commandId) {
        const result = await sql `
      select id, workspace_id, actor_kind, actor_ref, command_id, project_id, task_id,
             run_id, event_type, fact_refs, created_at
      from activity_records
      where command_id = ${commandId}
      order by created_at, id
    `.execute(this.db);
        return result.rows;
    }
    async listPage(filter) {
        const rows = await sql `
      select id, workspace_id, actor_kind, actor_ref, command_id, project_id,
             task_id, run_id, event_type, fact_refs, created_at,
             created_at::text as cursor_at
      from activity_records
      where workspace_id = ${filter.workspaceId}
        ${filter.projectId === undefined ? sql `` : sql `and project_id = ${filter.projectId}`}
        ${filter.taskId === undefined ? sql `` : sql `and task_id = ${filter.taskId}`}
        ${filter.runId === undefined ? sql `` : sql `and run_id = ${filter.runId}`}
        ${filter.from === undefined ? sql `` : sql `and created_at >= ${filter.from}`}
        ${filter.to === undefined ? sql `` : sql `and created_at < ${filter.to}`}
        ${filter.after === undefined ? sql `` : sql `and (created_at, id) <
          (${filter.after.at}::timestamptz, ${filter.after.id}::uuid)`}
      order by created_at desc, id desc
      limit ${filter.limit + 1}
    `.execute(this.db);
        return rows.rows;
    }
}
