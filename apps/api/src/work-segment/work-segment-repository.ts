import { sql } from 'kysely';
import type { DbExecutor } from '../infrastructure/database.js';
import type { ModelCallRow } from '../infrastructure/database-schema.js';
import type { JsonObject } from '../infrastructure/json.js';

export interface WorkSegmentRow {
  id: string; workspace_id: string; project_id: string; title: string; expectation: string; baseline: JsonObject;
  source_message_id: string | null; status: 'OPEN' | 'FINISHED'; revision: bigint;
  started_at: Date; finished_at: Date | null; result_snapshot: JsonObject | null;
}
export interface WorkSegmentEventRow {
  id: string; segment_id: string; kind: 'REWORK' | 'HUMAN_INTERVENTION'; task_id: string | null;
  source_run_id: string | null; description: string; duration_ms: bigint | null;
  status: 'CANDIDATE' | 'CONFIRMED' | 'WITHDRAWN'; revision: bigint; history: JsonObject[]; created_at: Date;
}
export class WorkSegmentRepository {
  constructor(private readonly db: DbExecutor) {}
  async now() { return (await sql<{ time: Date }>`select clock_timestamp() as time`.execute(this.db)).rows[0]!.time; }
  async insert(row: Omit<WorkSegmentRow, 'status' | 'revision' | 'finished_at' | 'result_snapshot'>) {
    return (await sql<WorkSegmentRow>`insert into work_segments
      (id, workspace_id, project_id, title, expectation, baseline, source_message_id, started_at)
      values (${row.id}, ${row.workspace_id}, ${row.project_id}, ${row.title}, ${row.expectation},
        ${JSON.stringify(row.baseline)}::jsonb, ${row.source_message_id}, ${row.started_at}) returning *`.execute(this.db)).rows[0]!;
  }
  async read(id: string, lock = false) {
    return (await sql<WorkSegmentRow>`select * from work_segments where id = ${id}
      ${lock ? sql`for update` : sql``}`.execute(this.db)).rows[0];
  }
  async list(workspaceId: string, projectId: string) {
    return (await sql<WorkSegmentRow>`select * from work_segments where workspace_id = ${workspaceId}
      and project_id = ${projectId} order by started_at desc, id desc`.execute(this.db)).rows;
  }
  async advance(id: string) {
    return (await sql<WorkSegmentRow>`update work_segments set revision = revision + 1 where id = ${id} returning *`.execute(this.db)).rows[0]!;
  }
  async finish(id: string, now: Date, snapshot: JsonObject) {
    return (await sql<WorkSegmentRow>`update work_segments set status = 'FINISHED', finished_at = ${now},
      result_snapshot = ${JSON.stringify(snapshot)}::jsonb, revision = revision + 1 where id = ${id} returning *`.execute(this.db)).rows[0]!;
  }
  async insertEvent(row: Omit<WorkSegmentEventRow, 'status' | 'revision' | 'history' | 'created_at'>) {
    return (await sql<WorkSegmentEventRow>`insert into work_segment_events
      (id, segment_id, kind, task_id, source_run_id, description, duration_ms)
      values (${row.id}, ${row.segment_id}, ${row.kind}, ${row.task_id}, ${row.source_run_id}, ${row.description}, ${row.duration_ms})
      returning *`.execute(this.db)).rows[0]!;
  }
  async readEvent(id: string, lock = false) {
    return (await sql<WorkSegmentEventRow>`select * from work_segment_events where id = ${id}
      ${lock ? sql`for update` : sql``}`.execute(this.db)).rows[0];
  }
  async events(id: string) {
    return (await sql<WorkSegmentEventRow>`select * from work_segment_events where segment_id = ${id}
      order by created_at, id`.execute(this.db)).rows;
  }
  async resolveEvent(id: string, status: 'CONFIRMED' | 'WITHDRAWN', history: JsonObject) {
    return (await sql<WorkSegmentEventRow>`update work_segment_events set status = ${status}, revision = revision + 1,
      history = history || ${JSON.stringify([history])}::jsonb where id = ${id} returning *`.execute(this.db)).rows[0]!;
  }
  async modelCalls(workspaceId: string, ids: readonly string[], from: Date, to: Date) {
    return (await sql<ModelCallRow>`select c.* from model_calls c where c.workspace_id = ${workspaceId}
      and c.kind <> 'VERIFY' and c.started_at >= ${from} and c.started_at <= ${to} and (
        exists (select 1 from step_attempts a join run_steps s on s.id = a.step_id join runs r on r.id = s.run_id
          where a.id = c.step_attempt_id and r.task_id in (${sql.join(ids)})) or
        exists (select 1 from assist_messages m join assist_sessions s on s.id = m.session_id
          where m.id = c.assist_message_id and s.task_id in (${sql.join(ids)}))) order by c.started_at, c.id`.execute(this.db)).rows;
  }
}
