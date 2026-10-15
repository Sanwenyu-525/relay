import { toDecimalString } from '../shared/decimal.js';
import { resourceNotFound } from './domain-error.js';
import { readProjectInWorkspace, requireWorkspace } from './guards.js';
import { createRepositories } from './unit-of-work.js';
export async function listProjects(db, input) {
    const rows = await createRepositories(db).projects.listProjectsPage(input);
    const hasMore = rows.length > input.limit;
    const page = hasMore ? rows.slice(0, input.limit) : rows;
    const last = page.at(-1);
    return {
        items: page.map((row) => ({
            id: row.id, title: row.title, project_type: row.project_type,
            archived_at: row.archived_at?.toISOString() ?? null,
            archive_status: row.archived_at === null ? 'ACTIVE' : 'ARCHIVED',
            revision: toDecimalString(row.revision),
            state_revision: toDecimalString(row.state_revision),
            phase_key: row.phase_key,
            next_action_task_id: row.next_action_task_id,
            created_at: row.created_at.toISOString(), updated_at: row.updated_at.toISOString(),
        })),
        next_cursor: hasMore && last !== undefined
            ? { createdAt: last.cursor_created_at, id: last.id } : null,
    };
}
export async function readProjectById(db, workspaceId, projectId) {
    const repositories = createRepositories(db);
    const project = await readProjectInWorkspace(repositories, workspaceId, projectId);
    return buildProject(repositories, project);
}
export async function readGoalById(db, workspaceId, goalId) {
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
export async function listProjectGoals(db, workspaceId, projectId) {
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
/**
 * Workspace 级 Goal 列表。Goal 本来就不属于单个 Project，此前只能按 Project 反查，
 * 跨多个 Project 的目标没有入口可列举；这里只读既有 Goal 行，不新建目标事实。
 */
export async function listGoals(db, input) {
    const repositories = createRepositories(db);
    await requireWorkspace(repositories, input.workspaceId);
    const rows = await repositories.projects.listGoalsPage(input);
    const hasMore = rows.length > input.limit;
    const page = hasMore ? rows.slice(0, input.limit) : rows;
    const last = page.at(-1);
    return {
        items: page.map((row) => ({
            id: row.id,
            title: row.title,
            description: row.description,
            status: row.status,
            revision: toDecimalString(row.revision),
            created_at: row.created_at.toISOString(),
            updated_at: row.updated_at.toISOString(),
        })),
        next_cursor: hasMore && last !== undefined
            ? { createdAt: last.cursor_created_at, id: last.id } : null,
    };
}
/**
 * 该 Goal 当前关联哪些 Project。这是 project_goals 的反向读取，只返回既有 Project 事实；
 * 归档 Project 仍在列，由 archive_status 表达，不在此推断目标是否仍可推进。
 */
export async function listGoalProjects(db, workspaceId, goalId) {
    const repositories = createRepositories(db);
    await requireWorkspace(repositories, workspaceId);
    const goal = await repositories.projects.readGoal(goalId);
    if (goal === undefined || goal.workspace_id !== workspaceId) {
        throw resourceNotFound('Goal');
    }
    const links = await repositories.projects.listProjectLinksForGoal(goal.id);
    return links.map((link) => ({
        project_id: link.project_id,
        title: link.title,
        project_type: link.project_type,
        archived_at: link.archived_at?.toISOString() ?? null,
        archive_status: link.archived_at === null ? 'ACTIVE' : 'ARCHIVED',
        project_revision: toDecimalString(link.revision),
        linked_at: link.linked_at.toISOString(),
    }));
}
export async function buildProject(repositories, project) {
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
