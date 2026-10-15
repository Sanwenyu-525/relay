import { sql } from 'kysely';
import type { DbExecutor } from '../infrastructure/database.js';

export interface AcceptanceTrialRow {
  id: string; workspace_id: string; task_id: string; acceptance_revision: bigint;
  mode: 'ORIGINAL' | 'EVIDENCE_VIEW'; sample_label: string; material_ids: string[];
  status: 'RUNNING' | 'PAUSED' | 'FINISHED'; started_at: Date;
  active_started_at: Date | null; finished_at: Date | null; active_ms: bigint; revision: bigint;
  comparison_id: string | null;
}
export interface AcceptanceTrialObservation {
  id: string; trial_id: string; trial_revision: bigint; preparation_ms: bigint | null;
  total_acceptance_ms: bigint | null; source_note: string; created_at: Date;
  correctness_outcome: 'UNKNOWN' | 'NO_ISSUE_REPORTED' | 'ISSUE_REPORTED';
  source_message_id: string | null;
}

export class TaskAcceptanceTrialRepository {
  constructor(private readonly db: DbExecutor) {}
  async now(): Promise<Date> {
    return (await sql<{ time: Date }>`select clock_timestamp() as time`.execute(this.db)).rows[0]!.time;
  }
  async insert(row: Omit<AcceptanceTrialRow, 'status' | 'finished_at' | 'active_ms' | 'revision'>) {
    return (await sql<AcceptanceTrialRow>`insert into task_acceptance_trials
      (id, workspace_id, task_id, acceptance_revision, mode, sample_label, material_ids, started_at, active_started_at, comparison_id)
      values (${row.id}, ${row.workspace_id}, ${row.task_id}, ${row.acceptance_revision}, ${row.mode},
        ${row.sample_label}, ${JSON.stringify(row.material_ids)}::jsonb, ${row.started_at}, ${row.active_started_at}, ${row.comparison_id})
      returning *`.execute(this.db)).rows[0]!;
  }
  async read(id: string, lock = true) {
    return (await sql<AcceptanceTrialRow>`select * from task_acceptance_trials where id = ${id}
      ${lock ? sql`for update` : sql``}`.execute(this.db)).rows[0];
  }
  async list(workspaceId: string, taskId: string) {
    return (await sql<AcceptanceTrialRow>`select * from task_acceptance_trials
      where workspace_id = ${workspaceId} and task_id = ${taskId} order by started_at desc, id desc`
      .execute(this.db)).rows;
  }
  async projectSnapshot(workspaceId: string, projectId: string) {
    return (await sql<{ id: string; task_id: string; revision: string; task_title: string;
      sample_label: string; status: string }>`select trial.id, trial.task_id, trial.revision::text,
        task.title as task_title, trial.sample_label, trial.status from task_acceptance_trials trial
      join tasks task on task.id = trial.task_id
      where trial.workspace_id = ${workspaceId} and task.project_id = ${projectId}
      order by trial.started_at desc, trial.id desc`.execute(this.db)).rows;
  }
  async update(row: AcceptanceTrialRow) {
    return (await sql<AcceptanceTrialRow>`update task_acceptance_trials set status = ${row.status},
      active_started_at = ${row.active_started_at}, finished_at = ${row.finished_at},
      active_ms = ${row.active_ms}, revision = revision + 1 where id = ${row.id} returning *`
      .execute(this.db)).rows[0]!;
  }
  async observe(row: Omit<AcceptanceTrialObservation, 'created_at'>) {
    await sql`insert into task_acceptance_trial_observations
      (id, trial_id, trial_revision, preparation_ms, total_acceptance_ms, source_note, correctness_outcome, source_message_id)
      values (${row.id}, ${row.trial_id}, ${row.trial_revision}, ${row.preparation_ms},
        ${row.total_acceptance_ms}, ${row.source_note}, ${row.correctness_outcome}, ${row.source_message_id})`.execute(this.db);
  }
  async observations(trialId: string) {
    return (await sql<AcceptanceTrialObservation>`select * from task_acceptance_trial_observations
      where trial_id = ${trialId} order by trial_revision desc`.execute(this.db)).rows;
  }
}
