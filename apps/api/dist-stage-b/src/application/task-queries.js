import { toDecimalString } from '../shared/decimal.js';
import { readTaskInWorkspace } from './guards.js';
import { loadReadinessForTasks, loadTaskReadiness, taskAllowedActions } from './task-readiness.js';
import { createRepositories } from './unit-of-work.js';
export async function readTaskDetail(repositories, task) {
    const acceptance = await repositories.tasks.readAcceptanceVersion(task.id, task.acceptance_revision);
    const criteria = await repositories.tasks.listCriteria(task.id, task.acceptance_revision);
    const readiness = await loadTaskReadiness(repositories, task, criteria);
    const goalAlignment = await readGoalAlignment(repositories, task);
    const dependencies = await repositories.tasks.listDependencies(task.id);
    const waitingReason = await currentRunWaitReason(repositories, task);
    const archived = task.project_id !== null &&
        (await repositories.projects.readProject(task.project_id))?.archived_at !== null;
    return {
        ...summarize(task, readiness.blockingTaskIds, readiness.unresolvedBlockerIds, readiness.requiredCriterionCount, waitingReason, archived),
        acceptance: buildAcceptance(task, acceptance, criteria),
        goal_alignment: goalAlignment,
        dependencies: dependencies.map((dependency) => ({
            task_id: dependency.depends_on_task_id,
            dependency_kind: dependency.dependency_kind,
            status: dependency.depends_on_status,
            title: dependency.depends_on_title,
        })),
    };
}
export async function listTasksSummary(repositories, tasks, projectId) {
    const readiness = await loadReadinessForTasks(repositories, tasks, projectId);
    const archivedByProject = new Map();
    for (const id of new Set(tasks.map((task) => task.project_id).filter((id) => id !== null))) {
        archivedByProject.set(id, (await repositories.projects.readProject(id))?.archived_at !== null);
    }
    return Promise.all(tasks.map(async (task) => {
        const facts = readiness.get(task.id);
        return summarize(task, facts?.blockingTaskIds ?? [], facts?.unresolvedBlockerIds ?? [], facts?.requiredCriterionCount ?? 0, await currentRunWaitReason(repositories, task), task.project_id !== null && archivedByProject.get(task.project_id) === true);
    }));
}
export async function listTasks(db, input) {
    const repositories = createRepositories(db);
    const rows = await repositories.tasks.listTasksPage({
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        limit: input.limit,
        before: input.before,
    });
    const hasMore = rows.length > input.limit;
    const page = hasMore ? rows.slice(0, input.limit) : rows;
    const last = page.at(-1);
    return {
        items: await listTasksSummary(repositories, page, input.projectId),
        next_cursor: hasMore && last !== undefined ? {
            createdAt: last.created_at, exactCreatedAt: last.cursor_created_at, id: last.id,
        } : null,
    };
}
export async function readTaskById(db, workspaceId, taskId) {
    const repositories = createRepositories(db);
    const task = await readTaskInWorkspace(repositories, workspaceId, taskId);
    return readTaskDetail(repositories, task);
}
function summarize(task, blockingTaskIds, unresolvedBlockerIds, requiredCriterionCount, waitingReason, archived) {
    return {
        id: task.id,
        project_id: task.project_id,
        title: task.title,
        status: task.status,
        mode: task.mode,
        revision: toDecimalString(task.revision),
        acceptance_revision: toDecimalString(task.acceptance_revision),
        priority: task.priority,
        due_local_date: task.due_local_date,
        timezone: task.due_timezone,
        executor: {
            kind: task.executor_kind,
            // P05：AI 执行权指向当前 Run；HUMAN 时必须为 null（与 ck_tasks_executor 一致）。
            run_id: task.executor_run_id,
            ownership_epoch: toDecimalString(task.ownership_epoch),
        },
        current_completion_id: task.current_completion_id,
        // P08 AI WAITING 直接投影当前 Run 的持久等待依据；不复制第二份 Task 原因。
        waiting_reason: waitingReason,
        blocking_task_ids: [...blockingTaskIds].sort(),
        unresolved_blocker_ids: [...unresolvedBlockerIds],
        allowed_actions: archived ? [] : taskAllowedActions({
            status: task.status,
            satisfiable: requiredCriterionCount > 0
                && blockingTaskIds.length === 0
                && unresolvedBlockerIds.length === 0,
        }),
        created_at: task.created_at.toISOString(),
        updated_at: task.updated_at.toISOString(),
    };
}
async function currentRunWaitReason(repositories, task) {
    if (task.status !== 'WAITING' || task.executor_run_id === null)
        return null;
    const run = await repositories.runs.readRun(task.executor_run_id);
    return run?.wait_reason ?? null;
}
function buildAcceptance(task, acceptance, criteria) {
    return {
        acceptance_revision: toDecimalString(task.acceptance_revision),
        objective: acceptance?.objective ?? '',
        expected_outputs: acceptance?.required_output_spec ?? {},
        source: acceptance?.source ?? 'CREATE',
        created_at: (acceptance?.created_at ?? task.created_at).toISOString(),
        criteria: criteria.map((criterion) => ({
            criterion_id: criterion.criterion_id,
            statement: criterion.statement,
            required: criterion.required,
            method: criterion.method,
            target_spec: criterion.target_spec,
        })),
    };
}
/** 无显式对齐时读取时继承 Project 当前 Goals；显式对齐时返回存储的集合（可为空）。 */
async function readGoalAlignment(repositories, task) {
    if (task.goal_alignment_mode === 'EXPLICIT') {
        const explicit = await repositories.tasks.listExplicitGoals(task.id);
        return {
            mode: 'EXPLICIT',
            goal_ids: explicit.map((row) => row.goal_id),
            effective_goal_ids: explicit.map((row) => row.goal_id),
        };
    }
    if (task.project_id === null) {
        return { mode: 'INHERIT', goal_ids: [], effective_goal_ids: [] };
    }
    const links = await repositories.projects.listProjectGoalLinks(task.project_id);
    const linkedIds = links.map((link) => link.goal_id);
    return {
        mode: 'INHERIT',
        goal_ids: [],
        effective_goal_ids: linkedIds,
    };
}
