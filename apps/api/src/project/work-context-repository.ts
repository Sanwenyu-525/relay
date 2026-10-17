import { sql } from 'kysely';
import type { DbExecutor } from '../infrastructure/database.js';

export interface WorkContextGoalRow {
  id: string; title: string; description: string; status: string; revision: string;
}
export interface WorkContextProjectRow {
  id: string; title: string; project_type: string; archived_at: Date | null; revision: string;
}
export interface WorkContextDirectoryRow {
  id: string; project_id: string; canonical_root: string; status: string; revision: string;
}
export interface WorkContextGoalLinkRow {
  id: string; title: string; status: string; revision: string;
}
export interface WorkContextSessionRow {
  id: string; project_id: string; title: string; status: string; revision: string;
  task_id: string | null; working_resource_id: string | null;
}

/** Read-only projections for Goal and managed-directory entry points. */
export class WorkContextRepository {
  constructor(private readonly db: DbExecutor) {}

  async readGoal(workspaceId: string, goalId: string): Promise<WorkContextGoalRow | undefined> {
    const result = await sql<WorkContextGoalRow>`
      select id, title, description, status, revision::text as revision
      from goals where workspace_id = ${workspaceId} and id = ${goalId}
    `.execute(this.db);
    return result.rows[0];
  }

  async listGoalProjects(workspaceId: string, goalId: string): Promise<readonly WorkContextProjectRow[]> {
    const result = await sql<WorkContextProjectRow>`
      select p.id, p.title, p.project_type, p.archived_at, p.revision::text as revision
      from project_goals pg
      join projects p on p.workspace_id = pg.workspace_id and p.id = pg.project_id
      where pg.workspace_id = ${workspaceId} and pg.goal_id = ${goalId}
      order by p.created_at, p.id
    `.execute(this.db);
    return result.rows;
  }

  async listGoalDirectories(workspaceId: string, goalId: string): Promise<readonly WorkContextDirectoryRow[]> {
    const result = await sql<WorkContextDirectoryRow>`
      select r.id, r.project_id, r.canonical_root, r.status, r.revision::text as revision
      from project_goals pg
      join managed_resources r on r.workspace_id = pg.workspace_id and r.project_id = pg.project_id
      where pg.workspace_id = ${workspaceId} and pg.goal_id = ${goalId}
      order by r.project_id, r.created_at, r.id
    `.execute(this.db);
    return result.rows;
  }

  async listGoalSessions(workspaceId: string, goalId: string, statuses: readonly string[]): Promise<readonly WorkContextSessionRow[]> {
    const result = await sql<WorkContextSessionRow>`
      select s.id, s.project_id, s.title, s.status, s.revision::text as revision,
             s.task_id, s.working_resource_id
      from project_goals pg
      join assist_sessions s on s.workspace_id = pg.workspace_id and s.project_id = pg.project_id
      where pg.workspace_id = ${workspaceId} and pg.goal_id = ${goalId}
        and s.task_id is null and s.status = any(${statuses}::text[])
      order by s.created_at, s.id
    `.execute(this.db);
    return result.rows;
  }

  async readDirectory(workspaceId: string, resourceId: string): Promise<(WorkContextDirectoryRow & { project_title: string; project_type: string; archived_at: Date | null; project_revision: string }) | undefined> {
    const result = await sql<WorkContextDirectoryRow & { project_title: string; project_type: string; archived_at: Date | null; project_revision: string }>`
      select r.id, r.project_id, r.canonical_root, r.status, r.revision::text as revision,
             p.title as project_title, p.project_type, p.archived_at,
             p.revision::text as project_revision
      from managed_resources r
      join projects p on p.workspace_id = r.workspace_id and p.id = r.project_id
      where r.workspace_id = ${workspaceId} and r.id = ${resourceId}
    `.execute(this.db);
    return result.rows[0];
  }

  async listDirectoryGoals(workspaceId: string, projectId: string): Promise<readonly WorkContextGoalLinkRow[]> {
    const result = await sql<WorkContextGoalLinkRow>`
      select g.id, g.title, g.status, g.revision::text as revision
      from project_goals pg
      join goals g on g.workspace_id = pg.workspace_id and g.id = pg.goal_id
      where pg.workspace_id = ${workspaceId} and pg.project_id = ${projectId}
      order by g.id
    `.execute(this.db);
    return result.rows;
  }

  async listDirectorySessions(workspaceId: string, projectId: string, resourceId: string, statuses: readonly string[]): Promise<readonly WorkContextSessionRow[]> {
    const result = await sql<WorkContextSessionRow>`
      select s.id, s.project_id, s.title, s.status, s.revision::text as revision,
             s.task_id, s.working_resource_id
      from assist_sessions s
      where s.workspace_id = ${workspaceId} and s.project_id = ${projectId}
        and s.working_resource_id = ${resourceId}
        and s.task_id is null and s.status = any(${statuses}::text[])
      order by s.created_at, s.id
    `.execute(this.db);
    return result.rows;
  }
}
