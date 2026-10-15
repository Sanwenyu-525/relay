import { sql } from 'kysely';
import { requireRow } from '../shared/sql-rows.js';
export class TodayRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    async readSelectionRevision(workspaceId) {
        const result = await sql `select revision from today_selection_states
      where workspace_id = ${workspaceId}`.execute(this.db);
        return result.rows[0]?.revision ?? 0n;
    }
    async lockSelectionState(workspaceId) {
        await sql `insert into today_selection_states(workspace_id) values (${workspaceId})
      on conflict (workspace_id) do nothing`.execute(this.db);
        const result = await sql `select revision from today_selection_states
      where workspace_id = ${workspaceId} for update`.execute(this.db);
        return requireRow(result.rows, 'lock Today selection state').revision;
    }
    async advanceSelectionRevision(workspaceId, expected) {
        const result = await sql `update today_selection_states
      set revision = revision + 1, updated_at = now()
      where workspace_id = ${workspaceId} and revision = ${expected}
      returning revision`.execute(this.db);
        return result.rows[0]?.revision;
    }
    async setTaskSelection(input) {
        if (!input.pin && input.laterLocalDate === null) {
            await sql `delete from task_selections where workspace_id = ${input.workspaceId}
        and task_id = ${input.taskId}`.execute(this.db);
            return;
        }
        await sql `insert into task_selections(workspace_id, task_id, pin, later_local_date,
      later_timezone, revision) values (${input.workspaceId}, ${input.taskId}, ${input.pin},
      ${input.laterLocalDate}::date, ${input.laterTimezone}, ${input.revision})
      on conflict (task_id) do update set pin = excluded.pin,
        later_local_date = excluded.later_local_date,
        later_timezone = excluded.later_timezone,
        revision = excluded.revision, updated_at = now()`.execute(this.db);
    }
    async listTaskSelections(workspaceId) {
        const result = await sql `select task_id, pin,
      later_local_date::text as later_local_date, later_timezone,
      (later_local_date::timestamp at time zone later_timezone) as later_until,
      revision from task_selections where workspace_id = ${workspaceId}`.execute(this.db);
        return result.rows;
    }
    async setFocus(input) {
        if (input.goalId === null && input.projectId === null && input.taskId === null) {
            await sql `delete from focus_selections where workspace_id = ${input.workspaceId}
        and focus_local_date = ${input.date}::date`.execute(this.db);
            return;
        }
        await sql `insert into focus_selections(workspace_id, focus_local_date, timezone,
      goal_id, project_id, task_id, revision)
      values (${input.workspaceId}, ${input.date}::date, ${input.timezone},
        ${input.goalId}, ${input.projectId}, ${input.taskId}, ${input.revision})
      on conflict (workspace_id, focus_local_date) do update set
        timezone = excluded.timezone, goal_id = excluded.goal_id,
        project_id = excluded.project_id, task_id = excluded.task_id,
        revision = excluded.revision, updated_at = now()`.execute(this.db);
    }
    async readFocus(workspaceId, date) {
        const result = await sql `select focus_local_date::text as focus_local_date,
      timezone, goal_id, project_id, task_id, revision from focus_selections
      where workspace_id = ${workspaceId} and focus_local_date = ${date}::date`.execute(this.db);
        return result.rows[0];
    }
    /** The query date is observed at its own local midnight. PostgreSQL applies
     * the saved IANA timezone rules, including the offset on that date. */
    async observationAt(date, timezone) {
        const result = await sql `select
      (${date}::date::timestamp at time zone ${timezone}) as observed_at`.execute(this.db);
        return requireRow(result.rows, 'Today local midnight').observed_at;
    }
    async listNextActions(workspaceId) {
        const result = await sql `
      select s.project_id, s.next_action_task_id as task_id, s.revision
      from project_states s join projects p on p.id = s.project_id
      where p.workspace_id = ${workspaceId} and s.next_action_task_id is not null
    `.execute(this.db);
        return result.rows;
    }
    async listEffectiveGoals(workspaceId) {
        const result = await sql `
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
