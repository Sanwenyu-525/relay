import type { DbExecutor } from '../infrastructure/database.js';
import { toDecimalString } from '../shared/decimal.js';
import { resourceNotFound } from './domain-error.js';
import { readProjectInWorkspace } from './guards.js';
import { STATE_ACTIONS } from './state-action.js';
import { createRepositories, type Repositories } from './unit-of-work.js';

/**
 * Project State 的组合视图（docs/api/http-command-contract.md 第 5 节）。
 *
 * 返回 State 自身 revision 与 dependency_versions：State revision 相同不代表聚合页面所有内容未变化，
 * 因此这里显式列出被投影对象的版本依据。所有字段都从各自 Owner 的事实解析，不维护第二份状态清单。
 */

export interface StateBlockerDto {
  readonly blocker_id: string;
  readonly target_kind: string;
  readonly target_id: string;
  readonly reason: string;
  readonly source_ref: string;
  readonly resolved_at: string | null;
  readonly created_at: string;
}

export interface StateRiskDto {
  readonly risk_id: string;
  readonly statement: string;
  readonly source_ref: string;
  readonly confirmation_ref: string;
  readonly resolved_at: string | null;
  readonly created_at: string;
}

export interface StateInProgressTaskDto {
  readonly task_id: string;
  readonly title: string;
  readonly status: string;
  readonly mode: string;
  readonly revision: string;
}

export interface StateCompletionRefDto {
  readonly completion_id: string;
  readonly task_id: string;
  readonly acceptance_revision: string;
  readonly committed_at: string;
}

export interface StateArtifactRefDto {
  readonly artifact_version_id: string;
  readonly artifact_id: string;
  readonly version_number: string;
  readonly source_ref: string;
}

export interface StateDependencyVersionsDto {
  readonly project: string;
  readonly state: string;
  readonly workspace_authority: string;
  readonly project_goals: readonly {
    readonly goal_id: string;
    readonly revision: string;
    readonly status: string;
  }[];
  /** 本次视图实际投影的 Task（in_progress 与 next_action）及其版本。 */
  readonly tasks: readonly { readonly task_id: string; readonly revision: string }[];
  readonly completion_refs: readonly string[];
  readonly artifact_version_refs: readonly string[];
}

export interface ProjectStateDto {
  readonly project_id: string;
  readonly phase_key: string;
  readonly next_action_task_id: string | null;
  readonly revision: string;
  readonly updated_at: string;
  readonly in_progress: readonly StateInProgressTaskDto[];
  readonly blockers: readonly StateBlockerDto[];
  readonly risks: readonly StateRiskDto[];
  readonly completed_highlight_refs: readonly StateCompletionRefDto[];
  readonly selected_artifact_version_refs: readonly StateArtifactRefDto[];
  /** decisions 表尚未建立，当前恒为空数组；不伪装成“没有关键决定”。 */
  readonly key_decision_refs: readonly string[];
  readonly dependency_versions: StateDependencyVersionsDto;
  /** 类型化命令提示（不是授权凭证）：当前事实下的 UI 提示。 */
  readonly allowed_actions: readonly string[];
}

export const STATE_COMMAND_ACTIONS: readonly string[] = STATE_ACTIONS;

export async function readProjectState(
  db: DbExecutor,
  workspaceId: string,
  projectId: string,
): Promise<ProjectStateDto> {
  const repositories = createRepositories(db);
  const project = await readProjectInWorkspace(repositories, workspaceId, projectId);

  return buildProjectState(repositories, workspaceId, project.id);
}

export async function buildProjectState(
  repositories: Repositories,
  workspaceId: string,
  projectId: string,
): Promise<ProjectStateDto> {
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
      project: toDecimalString(
        (await repositories.projects.readProject(projectId))?.revision ?? 0n,
      ),
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