import { sql } from 'kysely';
import type { DbExecutor } from '../infrastructure/database.js';
import type { JsonObject } from '../infrastructure/json.js';

export interface TimeEstimateRow {
  id: string; workspace_id: string; task_id: string; revision: bigint; acceptance_revision: bigint;
  elapsed_ms: bigint | null; execution_ms: bigint | null; waiting_ms: bigint | null; review_ms: bigint | null;
  human_ms: bigint | null; source_note: string; created_at: Date;
}
export interface PeriodPlanRow {
  id: string; workspace_id: string; project_id: string; title: string; available_ms: bigint;
  started_at: Date; ends_at: Date; baseline: JsonObject; items: JsonObject[]; revision: bigint;
}
export interface ScopeSimulationRow {
  id: string; workspace_id: string; project_id: string; source_plan_id: string; source_plan_revision: bigint;
  baseline: JsonObject; options: JsonObject[]; status: 'PROPOSED' | 'SELECTED'; selected_option: 'ALL' | 'SHRINK' | 'DEFER' | null;
  selected_plan_id: string | null; selection_reason: string | null; revision: bigint; created_at: Date;
}
export class PersonalPlanningRepository {
  constructor(private readonly db: DbExecutor) {}
  async now() { return (await sql<{ time: Date }>`select clock_timestamp() as time`.execute(this.db)).rows[0]!.time; }
  async estimates(taskId: string) {
    return (await sql<TimeEstimateRow>`select * from task_time_estimates where task_id = ${taskId} order by revision desc`.execute(this.db)).rows;
  }
  async insertEstimate(row: Omit<TimeEstimateRow, 'created_at'>) {
    return (await sql<TimeEstimateRow>`insert into task_time_estimates
      (id, workspace_id, task_id, revision, acceptance_revision, elapsed_ms, execution_ms, waiting_ms, review_ms, human_ms, source_note)
      values (${row.id}, ${row.workspace_id}, ${row.task_id}, ${row.revision}, ${row.acceptance_revision}, ${row.elapsed_ms},
        ${row.execution_ms}, ${row.waiting_ms}, ${row.review_ms}, ${row.human_ms}, ${row.source_note}) returning *`.execute(this.db)).rows[0]!;
  }
  async insert(row: Omit<PeriodPlanRow, 'revision'>) {
    return (await sql<PeriodPlanRow>`insert into period_plans
      (id, workspace_id, project_id, title, available_ms, started_at, ends_at, baseline, items)
      values (${row.id}, ${row.workspace_id}, ${row.project_id}, ${row.title}, ${row.available_ms}, ${row.started_at}, ${row.ends_at},
        ${JSON.stringify(row.baseline)}::jsonb, ${JSON.stringify(row.items)}::jsonb) returning *`.execute(this.db)).rows[0]!;
  }
  async read(id: string, lock = false) {
    return (await sql<PeriodPlanRow>`select * from period_plans where id = ${id} ${lock ? sql`for update` : sql``}`.execute(this.db)).rows[0];
  }
  async list(workspaceId: string, projectId: string) {
    return (await sql<PeriodPlanRow>`select * from period_plans where workspace_id = ${workspaceId} and project_id = ${projectId}
      order by started_at desc, id desc`.execute(this.db)).rows;
  }
  async resolve(id: string, items: JsonObject[]) {
    return (await sql<PeriodPlanRow>`update period_plans set items = ${JSON.stringify(items)}::jsonb,
      revision = revision + 1 where id = ${id} returning *`.execute(this.db)).rows[0]!;
  }
  async insertSimulation(row: Pick<ScopeSimulationRow, 'id' | 'workspace_id' | 'project_id' | 'source_plan_id' | 'source_plan_revision' | 'baseline' | 'options'>) {
    return (await sql<ScopeSimulationRow>`insert into plan_scope_simulations
      (id, workspace_id, project_id, source_plan_id, source_plan_revision, baseline, options)
      values (${row.id}, ${row.workspace_id}, ${row.project_id}, ${row.source_plan_id}, ${row.source_plan_revision},
        ${JSON.stringify(row.baseline)}::jsonb, ${JSON.stringify(row.options)}::jsonb) returning *`.execute(this.db)).rows[0]!;
  }
  async readSimulation(id: string, lock = false) {
    return (await sql<ScopeSimulationRow>`select * from plan_scope_simulations where id = ${id} ${lock ? sql`for update` : sql``}`.execute(this.db)).rows[0];
  }
  async listSimulations(workspaceId: string, planId: string) {
    return (await sql<ScopeSimulationRow>`select * from plan_scope_simulations where workspace_id = ${workspaceId} and source_plan_id = ${planId}
      order by created_at desc, id desc`.execute(this.db)).rows;
  }
  async selectSimulation(id: string, option: string, planId: string, reason: string) {
    return (await sql<ScopeSimulationRow>`update plan_scope_simulations set status = 'SELECTED', selected_option = ${option},
      selected_plan_id = ${planId}, selection_reason = ${reason}, revision = revision + 1 where id = ${id} returning *`.execute(this.db)).rows[0]!;
  }
}
