import { toDecimalString } from '../shared/decimal.js';
import { resourceNotFound } from './domain-error.js';
import { readProjectInWorkspace } from './guards.js';
import { STATE_ACTIONS } from './state-action.js';
import { createRepositories } from './unit-of-work.js';
export const STATE_COMMAND_ACTIONS = STATE_ACTIONS;
export async function readProjectState(db, workspaceId, projectId) {
    const repositories = createRepositories(db);
    const project = await readProjectInWorkspace(repositories, workspaceId, projectId);
    return buildProjectState(repositories, workspaceId, project.id);
}
export async function buildProjectState(repositories, workspaceId, projectId) {
    const state = await repositories.projects.readProjectState(projectId);
    if (state === undefined) {
        throw resourceNotFound('Project State');
    }
    const authority = await repositories.workspaces.readAuthority(workspaceId);
    const goals = await repositories.projects.listProjectGoalLinks(projectId);
    const inProgress = await repositories.tasks.listProjectTasksByStatus(projectId, ['IN_PROGRESS']);
    const blockers = await repositories.projects.listProjectBlockers(projectId);
    const risks = await repositories.projects.listProjectRisks(projectId);
    const completionRefs = await repositories.projects.listProjectStateCompletionRefs(projectId);
    const artifactRefs = await repositories.projects.listProjectStateArtifactRefs(projectId);
    const projectedTaskIds = new Set(inProgress.map((task) => task.id));
    if (state.next_action_task_id !== null) {
        projectedTaskIds.add(state.next_action_task_id);
    }
    const projectedTasks = await repositories.tasks.listTasksByIds([...projectedTaskIds]);
    return {
        project_id: state.project_id,
        phase_key: state.phase_key,
        next_action_task_id: state.next_action_task_id,
        revision: toDecimalString(state.revision),
        updated_at: state.updated_at.toISOString(),
        in_progress: inProgress.map((task) => ({
            task_id: task.id,
            title: task.title,
            status: task.status,
            mode: task.mode,
            revision: toDecimalString(task.revision),
        })),
        blockers: blockers.map((blocker) => ({
            blocker_id: blocker.id,
            target_kind: blocker.target_kind,
            target_id: blocker.target_id,
            reason: blocker.reason,
            source_ref: blocker.source_ref,
            resolved_at: blocker.resolved_at === null ? null : blocker.resolved_at.toISOString(),
            created_at: blocker.created_at.toISOString(),
        })),
        risks: risks.map((risk) => ({
            risk_id: risk.id,
            statement: risk.statement,
            source_ref: risk.source_ref,
            confirmation_ref: risk.confirmation_ref,
            resolved_at: risk.resolved_at === null ? null : risk.resolved_at.toISOString(),
            created_at: risk.created_at.toISOString(),
        })),
        completed_highlight_refs: completionRefs.map((ref) => ({
            completion_id: ref.completion_id,
            task_id: ref.task_id,
            acceptance_revision: toDecimalString(ref.acceptance_revision),
            committed_at: ref.committed_at.toISOString(),
        })),
        selected_artifact_version_refs: artifactRefs.map((ref) => ({
            artifact_version_id: ref.artifact_version_id,
            artifact_id: ref.artifact_id,
            version_number: toDecimalString(ref.version_number),
            source_ref: ref.source_ref,
        })),
        key_decision_refs: [],
        dependency_versions: {
            project: toDecimalString((await repositories.projects.readProject(projectId))?.revision ?? 0n),
            state: toDecimalString(state.revision),
            workspace_authority: toDecimalString(authority?.revision ?? 0n),
            project_goals: goals.map((goal) => ({
                goal_id: goal.goal_id,
                revision: toDecimalString(goal.goal_revision),
                status: goal.goal_status,
            })),
            tasks: projectedTasks.map((task) => ({
                task_id: task.id,
                revision: toDecimalString(task.revision),
            })),
            completion_refs: completionRefs.map((ref) => ref.completion_id),
            artifact_version_refs: artifactRefs.map((ref) => ref.artifact_version_id),
        },
        allowed_actions: [...STATE_COMMAND_ACTIONS],
    };
}
