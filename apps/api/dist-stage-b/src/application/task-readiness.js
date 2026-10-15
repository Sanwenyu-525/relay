export function readinessReasons(facts) {
    const reasons = [];
    if (facts.requiredCriterionCount < 1) {
        reasons.push('REQUIRED_CRITERION_MISSING');
    }
    if (facts.blockingTaskIds.length > 0) {
        reasons.push('DEPENDENCY_UNSATISFIED');
    }
    if (facts.unresolvedBlockerIds.length > 0) {
        reasons.push('TASK_BLOCKED');
    }
    return reasons;
}
/** 查询投影的 allowed_actions：当前事实下的 UI 提示，不是授权凭证（契约第 6 节）。 */
export function taskAllowedActions(facts) {
    switch (facts.status) {
        case 'INBOX':
            return facts.satisfiable
                ? ['EDIT_PRESENTATION', 'MARK_READY', 'CANCEL']
                : ['EDIT_PRESENTATION', 'CANCEL'];
        case 'READY':
            return facts.satisfiable
                ? ['EDIT_PRESENTATION', 'START', 'CANCEL']
                : ['EDIT_PRESENTATION', 'CANCEL'];
        case 'IN_PROGRESS':
            // P03 起人工任务在 IN_PROGRESS 上可以保存受管产物版本并完成本轮工作。
            return ['EDIT_PRESENTATION', 'SAVE_ARTIFACT_VERSION', 'COMPLETE', 'CANCEL'];
        case 'WAITING':
        case 'BLOCKED':
            return ['CANCEL'];
        case 'DONE':
            // 已完成只能通过重开进入新周期；重开不等于把历史凭据当作新周期的完成依据。
            return ['REOPEN'];
        case 'CANCELLED':
            return [];
        default:
            return [];
    }
}
export async function loadTaskReadiness(repositories, task, criteria) {
    const blocking = await repositories.tasks.listUnfinishedBlockingDependencies([task.id]);
    const blockers = task.project_id === null
        ? []
        : await repositories.projects.listUnresolvedBlockersForTask(task.project_id, task.id);
    return {
        requiredCriterionCount: criteria.filter((criterion) => criterion.required).length,
        blockingTaskIds: blocking.map((row) => row.depends_on_task_id).sort(),
        unresolvedBlockerIds: blockers.map((blocker) => blocker.id),
    };
}
/** 列表投影的批量版本：一次取回多个 Task 的前置事实，避免 N+1 查询。 */
export async function loadReadinessForTasks(repositories, tasks, projectId) {
    const taskIds = tasks.map((task) => task.id);
    const criteriaCounts = await repositories.tasks.countRequiredCriteriaForTasks(taskIds);
    const blocking = await repositories.tasks.listUnfinishedBlockingDependencies(taskIds);
    const blockers = projectId === null ? []
        : projectId === undefined
            ? await repositories.projects.listUnresolvedBlockersForWorkspaceTasks([...new Set(tasks.map((task) => task.project_id).filter((id) => id !== null))], taskIds)
            : await repositories.projects.listUnresolvedBlockersForTasks(projectId, taskIds);
    const readiness = new Map();
    for (const task of tasks) {
        readiness.set(task.id, {
            requiredCriterionCount: criteriaCounts.get(task.id) ?? 0,
            blockingTaskIds: blocking
                .filter((row) => row.task_id === task.id)
                .map((row) => row.depends_on_task_id),
            unresolvedBlockerIds: [
                ...blockers
                    .filter((blocker) => blocker.project_id === task.project_id
                    && blocker.target_kind === 'TASK' && blocker.target_id === task.id)
                    .map((blocker) => blocker.id),
                ...blockers
                    .filter((blocker) => blocker.project_id === task.project_id
                    && blocker.target_kind === 'PROJECT' && blocker.target_id === task.project_id)
                    .map((blocker) => blocker.id),
            ],
        });
    }
    return readiness;
}
