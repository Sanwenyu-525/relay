import type { DbExecutor } from '../infrastructure/database.js';
import { requireWorkspaceVisible } from './guards.js';
import { resourceNotFound, validationFailed } from './domain-error.js';
import { WorkContextRepository } from '../project/work-context-repository.js';

export type WorkContextStatus = 'ACTIVE' | 'ARCHIVED' | 'ALL';
const VALID_STATUSES = ['ACTIVE', 'ARCHIVED'] as const;

function resolveStatuses(status: string | undefined): readonly string[] {
  const value = status ?? 'ACTIVE';
  if (value === 'ALL') return VALID_STATUSES;
  if (value === 'ACTIVE' || value === 'ARCHIVED') return [value];
  throw validationFailed([{ field: 'status', message: 'must be ACTIVE, ARCHIVED, or ALL' }]);
}

export async function readGoalWorkContext(
  db: DbExecutor, workspaceId: string, goalId: string, status?: string,
) {
  await requireWorkspaceVisible(db, workspaceId);
  const repository = new WorkContextRepository(db);
  const goal = await repository.readGoal(workspaceId, goalId);
  if (goal === undefined) throw resourceNotFound('Goal');
  const statuses = resolveStatuses(status);
  const [projects, directories, sessions] = await Promise.all([
    repository.listGoalProjects(workspaceId, goalId),
    repository.listGoalDirectories(workspaceId, goalId),
    repository.listGoalSessions(workspaceId, goalId, statuses),
  ]);
  return {
    kind: 'GOAL' as const,
    goal,
    projects: projects.map((project) => ({
      id: project.id, title: project.title, project_type: project.project_type,
      archive_status: project.archived_at === null ? 'ACTIVE' as const : 'ARCHIVED' as const,
      archived_at: project.archived_at?.toISOString() ?? null,
      revision: project.revision,
      directories: directories.filter((directory) => directory.project_id === project.id)
        .map(({ project_id: _projectId, ...directory }) => directory),
    })),
    sessions: sessions.map(({ task_id: _taskId, ...session }) => session),
  };
}

export async function readDirectoryWorkContext(
  db: DbExecutor, workspaceId: string, resourceId: string, status?: string,
) {
  await requireWorkspaceVisible(db, workspaceId);
  const repository = new WorkContextRepository(db);
  const directory = await repository.readDirectory(workspaceId, resourceId);
  if (directory === undefined) throw resourceNotFound('ManagedResource');
  const statuses = resolveStatuses(status);
  const [linkedGoals, sessions] = await Promise.all([
    repository.listDirectoryGoals(workspaceId, directory.project_id),
    repository.listDirectorySessions(workspaceId, directory.project_id, resourceId, statuses),
  ]);
  return {
    kind: 'DIRECTORY' as const,
    directory: {
      id: directory.id, canonical_root: directory.canonical_root,
      status: directory.status, revision: directory.revision,
      project: {
        id: directory.project_id, title: directory.project_title,
        project_type: directory.project_type,
        archive_status: directory.archived_at === null ? 'ACTIVE' as const : 'ARCHIVED' as const,
        archived_at: directory.archived_at?.toISOString() ?? null,
        revision: directory.project_revision,
      },
    },
    linked_goals: linkedGoals,
    sessions: sessions.map(({ task_id: _taskId, ...session }) => session),
  };
}
