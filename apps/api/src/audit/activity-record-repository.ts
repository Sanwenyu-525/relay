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
  readonly actorKind: ActivityActorKind;
  readonly actorRef: string;
  readonly commandId: string | null;
  readonly projectId: string | null;
  readonly taskId: string | null;
  readonly eventType: string;
  readonly factRefs: JsonObject;
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
        id, actor_kind, actor_ref, command_id, project_id, task_id, event_type, fact_refs
      )
      values (
        ${record.id}, ${record.actorKind}, ${record.actorRef}, ${record.commandId},
        ${record.projectId}, ${record.taskId}, ${record.eventType},
        ${JSON.stringify(record.factRefs)}::jsonb
      )
      returning id, actor_kind, actor_ref, command_id, project_id, task_id, event_type,
                fact_refs, created_at
    `.execute(this.db);

    return requireRow(result.rows, 'insert into activity_records');
  }

  async listActivityRecordsByCommand(commandId: string): Promise<readonly ActivityRecordRow[]> {
    const result = await sql<ActivityRecordRow>`
      select id, actor_kind, actor_ref, command_id, project_id, task_id, event_type,
             fact_refs, created_at
      from activity_records
      where command_id = ${commandId}
      order by created_at, id
    `.execute(this.db);

    return result.rows;
  }
}