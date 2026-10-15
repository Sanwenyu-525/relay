import { sql } from 'kysely';
import type { DbExecutor } from '../infrastructure/database.js';
import type { AcceptanceTrialRow } from './task-acceptance-trial-repository.js';

export interface AcceptanceComparisonRow {
  id: string; workspace_id: string; project_id: string; baseline_trial_id: string;
  baseline_revision: bigint; baseline_observation_id: string | null; target_reduction_percent: number;
  sample_scope: string; frozen_at: Date;
}
export class TaskAcceptanceComparisonRepository {
  constructor(private readonly db: DbExecutor) {}
  async insert(row: Omit<AcceptanceComparisonRow, 'frozen_at'>) {
    return (await sql<AcceptanceComparisonRow>`insert into task_acceptance_comparisons
      (id, workspace_id, project_id, baseline_trial_id, baseline_revision, baseline_observation_id,
        target_reduction_percent, sample_scope)
      values (${row.id}, ${row.workspace_id}, ${row.project_id}, ${row.baseline_trial_id},
        ${row.baseline_revision}, ${row.baseline_observation_id}, ${row.target_reduction_percent}, ${row.sample_scope})
      returning *`.execute(this.db)).rows[0]!;
  }
  async read(id: string) {
    return (await sql<AcceptanceComparisonRow>`select * from task_acceptance_comparisons where id = ${id}`
      .execute(this.db)).rows[0];
  }
  async list(workspaceId: string, projectId: string) {
    return (await sql<AcceptanceComparisonRow>`select * from task_acceptance_comparisons
      where workspace_id = ${workspaceId} and project_id = ${projectId} order by frozen_at desc, id desc`
      .execute(this.db)).rows;
  }
  async trials(comparisonId: string) {
    return (await sql<AcceptanceTrialRow>`select * from task_acceptance_trials
      where comparison_id = ${comparisonId} order by started_at, id`.execute(this.db)).rows;
  }
}
