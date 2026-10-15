import { sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import type { DbExecutor } from '../infrastructure/database.js';
import type { JsonObject } from '../infrastructure/json.js';
export interface ProjectReminderRow {
  id: string; workspace_id: string; project_id: string; title: string; due_at: Date; timezone: string;
  status: 'ENABLED' | 'PAUSED' | 'DISABLED'; schedule_generation: bigint; revision: bigint; history: JsonObject[]; created_at: Date;
}
export interface ReminderOccurrenceRow {
  id: string; reminder_id: string; workspace_id: string; project_id: string; schedule_generation: bigint; config_revision: bigint;
  title: string; due_at: Date; timezone: string; missed: boolean; status: 'PENDING' | 'HANDLED' | 'DISMISSED'; revision: bigint;
  resolution_reason: string | null; resolved_at: Date | null; created_at: Date;
}
export class ProjectReminderRepository {
  constructor(private readonly db: DbExecutor) {}
  async now() { return (await sql<{ time: Date }>`select clock_timestamp() as time`.execute(this.db)).rows[0]!.time; }
  async insert(row: Pick<ProjectReminderRow, 'id' | 'workspace_id' | 'project_id' | 'title' | 'due_at' | 'timezone' | 'history'>) {
    return (await sql<ProjectReminderRow>`insert into project_reminders (id, workspace_id, project_id, title, due_at, timezone, history)
      values (${row.id}, ${row.workspace_id}, ${row.project_id}, ${row.title}, ${row.due_at}, ${row.timezone}, ${JSON.stringify(row.history)}::jsonb) returning *`.execute(this.db)).rows[0]!;
  }
  async read(id: string, lock = false) {
    return (await sql<ProjectReminderRow>`select * from project_reminders where id = ${id} ${lock ? sql`for update` : sql``}`.execute(this.db)).rows[0];
  }
  async list(workspaceId: string, projectId: string) {
    return (await sql<ProjectReminderRow>`select * from project_reminders where workspace_id = ${workspaceId} and project_id = ${projectId} order by created_at, id`.execute(this.db)).rows;
  }
  async update(row: ProjectReminderRow, event: JsonObject) {
    return (await sql<ProjectReminderRow>`update project_reminders set title = ${row.title}, due_at = ${row.due_at}, timezone = ${row.timezone},
      status = ${row.status}, schedule_generation = ${row.schedule_generation}, revision = revision + 1, history = history || ${JSON.stringify([event])}::jsonb
      where id = ${row.id} returning *`.execute(this.db)).rows[0]!;
  }
  async dueWorkspaces() {
    return (await sql<{ workspace_id: string }>`select distinct r.workspace_id from project_reminders r join projects p on p.id = r.project_id
      where r.status = 'ENABLED' and r.due_at <= clock_timestamp() and p.archived_at is null
        and not exists (select 1 from project_reminder_occurrences o where o.reminder_id = r.id and o.schedule_generation = r.schedule_generation)
      order by r.workspace_id`.execute(this.db)).rows.map((r) => r.workspace_id);
  }
  async due(workspaceId: string, now: Date) {
    return (await sql<ProjectReminderRow>`select r.* from project_reminders r join projects p on p.id = r.project_id where r.workspace_id = ${workspaceId}
      and r.status = 'ENABLED' and r.due_at <= ${now} and p.archived_at is null
      and not exists (select 1 from project_reminder_occurrences o where o.reminder_id = r.id and o.schedule_generation = r.schedule_generation)
      order by r.due_at, r.id limit 100 for update of r`.execute(this.db)).rows;
  }
  async trigger(row: ProjectReminderRow, missed: boolean) {
    return (await sql<ReminderOccurrenceRow>`insert into project_reminder_occurrences
      (id, reminder_id, workspace_id, project_id, schedule_generation, config_revision, title, due_at, timezone, missed)
      values (${randomUUID()}, ${row.id}, ${row.workspace_id}, ${row.project_id}, ${row.schedule_generation}, ${row.revision}, ${row.title}, ${row.due_at}, ${row.timezone}, ${missed})
      on conflict (reminder_id, schedule_generation) do nothing returning *`.execute(this.db)).rows[0];
  }
  async occurrences(workspaceId: string, projectId?: string, pendingOnly = false) {
    return (await sql<ReminderOccurrenceRow>`select * from project_reminder_occurrences where workspace_id = ${workspaceId}
      ${projectId === undefined ? sql`` : sql`and project_id = ${projectId}`} ${pendingOnly ? sql`and status = 'PENDING'` : sql``}
      order by created_at, id`.execute(this.db)).rows;
  }
  async readOccurrence(id: string, lock = false) {
    return (await sql<ReminderOccurrenceRow>`select * from project_reminder_occurrences where id = ${id} ${lock ? sql`for update` : sql``}`.execute(this.db)).rows[0];
  }
  async resolve(id: string, status: 'HANDLED' | 'DISMISSED', reason: string) {
    return (await sql<ReminderOccurrenceRow>`update project_reminder_occurrences set status = ${status}, resolution_reason = ${reason},
      resolved_at = clock_timestamp(), revision = revision + 1 where id = ${id} returning *`.execute(this.db)).rows[0]!;
  }
  async claim(workspaceId: string, id: string) {
    return (await sql<{ item_key: string }>`insert into attention_notification_receipts (workspace_id, item_key, change_key)
      values (${workspaceId}, ${`project-reminder:${id}`}, '1') on conflict do nothing returning item_key`.execute(this.db)).rows.length > 0;
  }
}
