import { sql } from 'kysely';
import type { DbExecutor } from '../infrastructure/database.js';

export interface TaskAcceptanceMaterialRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly task_id: string;
  readonly acceptance_revision: bigint;
  readonly criterion_id: string | null;
  readonly knowledge_version_id: string;
  readonly tested_artifact_version_id: string | null;
  readonly source_label: string | null;
  readonly note: string | null;
  readonly status: 'ACTIVE' | 'WITHDRAWN';
  readonly revision: bigint;
  readonly created_at: Date;
  readonly withdrawn_at: Date | null;
}

export class TaskAcceptanceMaterialRepository {
  constructor(private readonly db: DbExecutor) {}

  async insert(input: Omit<TaskAcceptanceMaterialRow,
    'status' | 'revision' | 'created_at' | 'withdrawn_at'>): Promise<TaskAcceptanceMaterialRow> {
    return (await sql<TaskAcceptanceMaterialRow>`insert into task_acceptance_materials
      (id, workspace_id, task_id, acceptance_revision, criterion_id, knowledge_version_id,
        tested_artifact_version_id, source_label, note)
      values (${input.id}, ${input.workspace_id}, ${input.task_id}, ${input.acceptance_revision},
        ${input.criterion_id}, ${input.knowledge_version_id}, ${input.tested_artifact_version_id},
        ${input.source_label}, ${input.note}) returning *`.execute(this.db)).rows[0]!;
  }

  async list(workspaceId: string, taskId: string): Promise<readonly TaskAcceptanceMaterialRow[]> {
    return (await sql<TaskAcceptanceMaterialRow>`select * from task_acceptance_materials
      where workspace_id = ${workspaceId} and task_id = ${taskId}
      order by created_at desc, id desc`.execute(this.db)).rows;
  }

  async read(id: string, lock = false): Promise<TaskAcceptanceMaterialRow | undefined> {
    return (await sql<TaskAcceptanceMaterialRow>`select * from task_acceptance_materials
      where id = ${id} ${lock ? sql`for update` : sql``}`.execute(this.db)).rows[0];
  }

  async withdraw(id: string): Promise<TaskAcceptanceMaterialRow> {
    return (await sql<TaskAcceptanceMaterialRow>`update task_acceptance_materials
      set status = 'WITHDRAWN', withdrawn_at = now(), revision = revision + 1
      where id = ${id} returning *`.execute(this.db)).rows[0]!;
  }
}
