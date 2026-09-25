import type { DbExecutor } from '../infrastructure/database.js';
import type { ProjectType } from '../infrastructure/database-schema.js';
import { toDecimalString } from '../shared/decimal.js';
import { resourceNotFound } from './domain-error.js';
import { readProjectInWorkspace, requireWorkspace } from './guards.js';
import { createRepositories, type Repositories } from './unit-of-work.js';

/** Project / Goal 的查询投影。 */

export interface ProjectDto {
  readonly id: string;
  readonly title: string;
  readonly project_type: ProjectType;
  readonly archived_at: string | null;
  readonly revision: string;
  readonly state_revision: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface GoalDto {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly status: string;
  readonly revision: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface ProjectGoalDto {
  readonly goal_id: string;
  readonly title: string;
  readonly status: string;
  readonly revision: string;
  /** 显式对齐该 Goal 的 Task；解除关联前的影响清单就是这些 ID。 */
  readonly explicit_task_ids: readonly string[];
}

export async function readProjectById(
  db: DbExecutor,
  workspaceId: string,
  projectId: string,
): Promise<ProjectDto> {
  const repositories = createRepositories(db);
  const project = await readProjectInWorkspace(repositories, workspaceId, projectId);

  return buildProject(repositories, project);
}

export async function readGoalById(
  db: DbExecutor,
  workspaceId: string,
  goalId: string,
): Promise<GoalDto> {
  const repositories = createRepositories(db);

  await requireWorkspace(repositories, workspaceId);

  const goal = await repositories.projects.readGoal(goalId);

  if (goal === undefined || goal.workspace_id !== workspaceId) {
    throw resourceNotFound('Goal');
  }

  return {
    id: goal.id,
    title: goal.title,
    description: goal.description,
    status: goal.status,
    revision: toDecimalString(goal.revision),
    created_at: goal.created_at.toISOString(),
    updated_at: goal.updated_at.toISOString(),
  };
}

export async function listProjectGoals(
  db: DbExecutor,
  workspaceId: string,
  projectId: string,
): Promise<readonly ProjectGoalDto[]> {
  const repositories = createRepositories(db);
  const project = await readProjectInWorkspace(repositories, workspaceId, projectId);
  const links = await repositories.projects.listProjectGoalLinks(project.id);
  const explicit = await repositories.tasks.listExplicitGoalRefsByProject(project.id);

  return links.map((link) => ({
    goal_id: link.goal_id,
    title: link.goal_title,
    status: link.goal_status,
    revision: toDecimalString(link.goal_revision),
    explicit_task_ids: explicit
      .filter((row) => row.goal_id === link.goal_id)
      .map((row) => row.task_id),
  }));
}

export async function buildProject(
  repositories: Repositories,
  project: {
    readonly id: string;
    readonly title: string;
    readonly project_type: ProjectType;
    readonly archived_at: Date | null;
    readonly revision: bigint;
    readonly created_at: Date;
    readonly updated_at: Date;
  },
): Promise<ProjectDto> {
  const state = await repositories.projects.readProjectState(project.id);

  return {
    id: project.id,
    title: project.title,
    project_type: project.project_type,
    archived_at: project.archived_at === null ? null : project.archived_at.toISOString(),
    revision: toDecimalString(project.revision),
    state_revision: toDecimalString(state?.revision ?? 0n),
    created_at: project.created_at.toISOString(),
    updated_at: project.updated_at.toISOString(),
  };
}