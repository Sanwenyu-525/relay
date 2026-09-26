import { sql } from 'kysely';

import type { DbExecutor } from '../infrastructure/database.js';
import type {
  ActivityActorKind,
  ActivityRecordRow,
} from '../infrastructure/database-schema.js';
import type { JsonObject } from '../infrastructure/json.js';
import { requireRow } from '../shared/sql-rows.js';

export interface NewActivityRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly actorKind: ActivityActorKind;
  readonly actorRef: string;
  readonly commandId: string | null;
  readonly projectId: string | null;
  readonly taskId: string | null;
  readonly runId?: string | null;
  readonly eventType: string;
  readonly factRefs: JsonObject;
}

export interface ActivityPageRow extends ActivityRecordRow {
  readonly cursor_at: string;
}

export interface ActivityPageFilter {
  readonly workspaceId: string;
  readonly projectId?: string | undefined;
  readonly taskId?: string | undefined;
  readonly runId?: string | undefined;
  readonly from?: Date | undefined;
  readonly to?: Date | undefined;
  readonly after?: { readonly at: string; readonly id: string } | undefined;
  readonly limit: number;
}

/**
 * 关键审计：与业务事实在同一事务写入。
 * 这不是事件溯源主存储，只保存可追溯到命令、Project/Task 与事实引用的记录。
 */
export class ActivityRecordRepository {
  private readonly db: DbExecutor;

  constructor(db: DbExecutor) {
    this.db = db;
  }

  async insertActivityRecord(record: NewActivityRecord): Promise<ActivityRecordRow> {
    const result = await sql<ActivityRecordRow>`
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

  async listActivityRecordsByCommand(commandId: string): Promise<readonly ActivityRecordRow[]> {
    const result = await sql<ActivityRecordRow>`
      select id, workspace_id, actor_kind, actor_ref, command_id, project_id, task_id,
             run_id, event_type, fact_refs, created_at
      from activity_records
      where command_id = ${commandId}
      order by created_at, id
    `.execute(this.db);

    return result.rows;
  }

  async listPage(filter: ActivityPageFilter): Promise<readonly ActivityPageRow[]> {
    const rows = await sql<ActivityPageRow>`
      select id, workspace_id, actor_kind, actor_ref, command_id, project_id,
             task_id, run_id, event_type, fact_refs, created_at,
             created_at::text as cursor_at
      from activity_records
      where workspace_id = ${filter.workspaceId}
        ${filter.projectId === undefined ? sql`` : sql`and project_id = ${filter.projectId}`}
        ${filter.taskId === undefined ? sql`` : sql`and task_id = ${filter.taskId}`}
        ${filter.runId === undefined ? sql`` : sql`and run_id = ${filter.runId}`}
        ${filter.from === undefined ? sql`` : sql`and created_at >= ${filter.from}`}
        ${filter.to === undefined ? sql`` : sql`and created_at < ${filter.to}`}
        ${filter.after === undefined ? sql`` : sql`and (created_at, id) <
          (${filter.after.at}::timestamptz, ${filter.after.id}::uuid)`}
      order by created_at desc, id desc
      limit ${filter.limit + 1}
    `.execute(this.db);
    return rows.rows;
  }
}
