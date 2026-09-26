import { sql } from 'kysely';

import type { DbExecutor } from '../infrastructure/database.js';
import { requireRow } from '../shared/sql-rows.js';

export interface TaskSelectionRow {
  readonly task_id: string;
  readonly pin: boolean;
  readonly later_local_date: string | null;
  readonly later_timezone: string | null;
  readonly later_until: Date | null;
  readonly revision: bigint;
}

export interface FocusSelectionRow {
  readonly focus_local_date: string;
  readonly timezone: string;
  readonly goal_id: string | null;
  readonly project_id: string | null;
  readonly task_id: string | null;
  readonly revision: bigint;
}

export class TodayRepository {
  constructor(private readonly db: DbExecutor) {}

  async readSelectionRevision(workspaceId: string): Promise<bigint> {
    const result = await sql<{ revision: bigint }>`select revision from today_selection_states
      where workspace_id = ${workspaceId}`.execute(this.db);
    return result.rows[0]?.revision ?? 0n;
  }

  async lockSelectionState(workspaceId: string): Promise<bigint> {
    await sql`insert into today_selection_states(workspace_id) values (${workspaceId})
      on conflict (workspace_id) do nothing`.execute(this.db);
    const result = await sql<{ revision: bigint }>`select revision from today_selection_states
      where workspace_id = ${workspaceId} for update`.execute(this.db);
    return requireRow(result.rows, 'lock Today selection state').revision;
  }

  async advanceSelectionRevision(workspaceId: string, expected: bigint): Promise<bigint | undefined> {
    const result = await sql<{ revision: bigint }>`update today_selection_states
      set revision = revision + 1, updated_at = now()
      where workspace_id = ${workspaceId} and revision = ${expected}
      returning revision`.execute(this.db);
    return result.rows[0]?.revision;
  }

  async setTaskSelection(input: { workspaceId: string; taskId: string; pin: boolean;
    laterLocalDate: string | null; laterTimezone: string | null; revision: bigint }): Promise<void> {
    if (!input.pin && input.laterLocalDate === null) {
      await sql`delete from task_selections where workspace_id = ${input.workspaceId}
        and task_id = ${input.taskId}`.execute(this.db);
      return;
    }
    await sql`insert into task_selections(workspace_id, task_id, pin, later_local_date,
      later_timezone, revision) values (${input.workspaceId}, ${input.taskId}, ${input.pin},
      ${input.laterLocalDate}::date, ${input.laterTimezone}, ${input.revision})
      on conflict (task_id) do update set pin = excluded.pin,
        later_local_date = excluded.later_local_date,
        later_timezone = excluded.later_timezone,
        revision = excluded.revision, updated_at = now()`.execute(this.db);
  }

  async listTaskSelections(workspaceId: string): Promise<readonly TaskSelectionRow[]> {
    const result = await sql<TaskSelectionRow>`select task_id, pin,
      later_local_date::text as later_local_date, later_timezone,
      (later_local_date::timestamp at time zone later_timezone) as later_until,
      revision from task_selections where workspace_id = ${workspaceId}`.execute(this.db);
    return result.rows;
  }

  async setFocus(input: { workspaceId: string; date: string; timezone: string;
    goalId: string | null; projectId: string | null; taskId: string | null;
    revision: bigint }): Promise<void> {
    if (input.goalId === null && input.projectId === null && input.taskId === null) {
      await sql`delete from focus_selections where workspace_id = ${input.workspaceId}
        and focus_local_date = ${input.date}::date`.execute(this.db);
      return;
    }
    await sql`insert into focus_selections(workspace_id, focus_local_date, timezone,
      goal_id, project_id, task_id, revision)
      values (${input.workspaceId}, ${input.date}::date, ${input.timezone},
        ${input.goalId}, ${input.projectId}, ${input.taskId}, ${input.revision})
      on conflict (workspace_id, focus_local_date) do update set
        timezone = excluded.timezone, goal_id = excluded.goal_id,
        project_id = excluded.project_id, task_id = excluded.task_id,
        revision = excluded.revision, updated_at = now()`.execute(this.db);
  }

  async readFocus(workspaceId: string, date: string): Promise<FocusSelectionRow | undefined> {
    const result = await sql<FocusSelectionRow>`select focus_local_date::text as focus_local_date,
      timezone, goal_id, project_id, task_id, revision from focus_selections
      where workspace_id = ${workspaceId} and focus_local_date = ${date}::date`.execute(this.db);
    return result.rows[0];
  }

  /** The query date is observed at its own local midnight. PostgreSQL applies
   * the saved IANA timezone rules, including the offset on that date. */
  async observationAt(date: string, timezone: string): Promise<Date> {
    const result = await sql<{ observed_at: Date }>`select
      (${date}::date::timestamp at time zone ${timezone}) as observed_at`.execute(this.db);
    return requireRow(result.rows, 'Today local midnight').observed_at;
  }

  async listNextActions(workspaceId: string): Promise<readonly {
    project_id: string; task_id: string; revision: bigint }[]> {
    const result = await sql<{ project_id: string; task_id: string; revision: bigint }>`
      select s.project_id, s.next_action_task_id as task_id, s.revision
      from project_states s join projects p on p.id = s.project_id
      where p.workspace_id = ${workspaceId} and s.next_action_task_id is not null
    `.execute(this.db);
    return result.rows;
  }

  async listEffectiveGoals(workspaceId: string): Promise<readonly {
    task_id: string; goal_id: string }[]> {
    const result = await sql<{ task_id: string; goal_id: string }>`
      select t.id as task_id, e.goal_id from tasks t
      join task_explicit_goals e on e.task_id = t.id
      where t.workspace_id = ${workspaceId} and t.goal_alignment_mode = 'EXPLICIT'
      union all
      select t.id as task_id, pg.goal_id from tasks t
      join project_goals pg on pg.project_id = t.project_id
      where t.workspace_id = ${workspaceId} and t.goal_alignment_mode = 'INHERIT'
    `.execute(this.db);
    return result.rows;
  }
}
