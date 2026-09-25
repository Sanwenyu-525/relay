import { randomUUID } from 'node:crypto';

import type { DbExecutor } from '../infrastructure/database.js';
import { toDecimalString } from '../shared/decimal.js';
import { LOCAL_ACTOR_REF, httpCommandScopeKey } from './actor.js';
import { runIdempotentCommand, type CommandOutcome } from './command.js';
import {
  goalLinkInUse,
  invalidTransition,
  resourceNotFound,
  revisionConflict,
} from './domain-error.js';
import { lockProjectInWorkspace } from './guards.js';
import { normalizeIdSet, requireRevision, requireUuid } from './revisions.js';

export interface LinkProjectGoalInput {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly commandId: string;
  readonly expectedRevision: string;
  readonly goalId: string;
}

export type LinkProjectGoalResult = {
  readonly project_id: string;
  readonly revision: string;
  readonly goal_ids: readonly string[];
};

export interface UnlinkProjectGoalInput {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly commandId: string;
  readonly expectedRevision: string;
  readonly goalId: string;
  /** 调用方在解除前查到的受影响 Task 清单；与锁下实际清单不一致时整笔命令被拒。 */
  readonly expectedImpactedTaskIds: readonly string[];
}

export type UnlinkProjectGoalResult = {
  readonly project_id: string;
  readonly revision: string;
  readonly impacted_tasks: readonly {
    readonly task_id: string;
    readonly revision: string;
  }[];
};

/**
 * LinkProjectGoal：把 Workspace 内的 Goal 关联到 Project。
 * 关联集合是 Project 的事实，按 Project revision 做 CAS，并在 Project 行锁下串行化，
 * 使“关联/解除”与“Task 显式对齐”的并发产生确定结果（先提交者赢，后到者看到新事实）。
 */
export async function linkProjectGoal(
  db: DbExecutor,
  input: LinkProjectGoalInput,
): Promise<CommandOutcome<LinkProjectGoalResult>> {
  const goalId = requireUuid(input.goalId, 'goal_id');
  const expectedRevision = requireRevision(input.expectedRevision, 'expected_revision');

  return runIdempotentCommand<LinkProjectGoalResult>(db, {
    scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId,
    commandType: 'LinkProjectGoal',
    target: { project_id: input.projectId, goal_id: goalId },
    body: { expected_revision: toDecimalString(expectedRevision), goal_id: goalId },
    execute: async (repositories) => {
      const project = await lockProjectInWorkspace(
        repositories,
        input.workspaceId,
        input.projectId,
      );

      if (project.revision !== expectedRevision) {
        throw revisionConflict({
          entityType: 'PROJECT',
          expectedRevision: toDecimalString(expectedRevision),
          actualRevision: toDecimalString(project.revision),
        });
      }

      const goal = await repositories.projects.readGoal(goalId);

      if (goal === undefined || goal.workspace_id !== input.workspaceId) {
        throw resourceNotFound('Goal');
      }

      const existing = await repositories.projects.findProjectGoalLink(project.id, goalId);

      if (existing !== undefined) {
        throw invalidTransition('该 Goal 已关联到当前 Project。', { goalId });
      }

      await repositories.projects.linkGoalToProject({
        workspaceId: input.workspaceId,
        projectId: project.id,
        goalId,
      });

      const updated = await repositories.projects.bumpProjectRevision(
        project.id,
        expectedRevision,
      );

      if (updated === undefined) {
        throw revisionConflict({
          entityType: 'PROJECT',
          expectedRevision: toDecimalString(expectedRevision),
          actualRevision: toDecimalString(project.revision),
        });
      }

      await repositories.activities.insertActivityRecord({
        id: randomUUID(),
        actorKind: 'HUMAN',
        actorRef: LOCAL_ACTOR_REF,
        commandId: input.commandId,
        projectId: project.id,
        taskId: null,
        eventType: 'PROJECT_GOAL_LINKED',
        factRefs: { goal_id: goalId },
      });

      const links = await repositories.projects.listProjectGoalLinks(project.id);

      return {
        project_id: project.id,
        revision: toDecimalString(updated.revision),
        goal_ids: links.map((link) => link.goal_id),
      };
    },
  });
}

/**
 * UnlinkProjectGoal：原子解除 Project–Goal 关联。
 *
 * 依据 contracts/01-facts-and-ownership.md 第 5 节与 information-planning 第 5 节：
 * 解除时若存在显式 Task 对齐，必须在同一个明确操作内清理，不能静默遗留无效关系。
 * 这里要求调用方提交它查到的受影响清单，锁下重新核对；清单变化返回 409 并给出当前清单。
 * 清理后受影响的 Task 保持 EXPLICIT 但集合为空（显式“不对齐任何 Goal”），并递增其 revision。
 */
export async function unlinkProjectGoal(
  db: DbExecutor,
  input: UnlinkProjectGoalInput,
): Promise<CommandOutcome<UnlinkProjectGoalResult>> {
  const goalId = requireUuid(input.goalId, 'goal_id');
  const expectedRevision = requireRevision(input.expectedRevision, 'expected_revision');
  const expectedImpacted = normalizeIdSet(
    input.expectedImpactedTaskIds,
    'expected_impacted_task_ids',
  );

  return runIdempotentCommand<UnlinkProjectGoalResult>(db, {
    scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId,
    commandType: 'UnlinkProjectGoal',
    target: { project_id: input.projectId, goal_id: goalId },
    body: {
      expected_revision: toDecimalString(expectedRevision),
      goal_id: goalId,
      expected_impacted_task_ids: expectedImpacted,
    },
    execute: async (repositories) => {
      const project = await lockProjectInWorkspace(
        repositories,
        input.workspaceId,
        input.projectId,
      );

      if (project.revision !== expectedRevision) {
        throw revisionConflict({
          entityType: 'PROJECT',
          expectedRevision: toDecimalString(expectedRevision),
          actualRevision: toDecimalString(project.revision),
        });
      }

      const link = await repositories.projects.findProjectGoalLink(project.id, goalId);

      if (link === undefined) {
        throw resourceNotFound('Project Goal 关联');
      }

      const impacted = await repositories.projects.listExplicitGoalTasksForGoal(
        project.id,
        goalId,
      );
      const impactedIds = impacted.map((task) => task.task_id);

      if (!sameIdSet(impactedIds, expectedImpacted)) {
        throw goalLinkInUse({
          goalId,
          impactedTaskIds: [...impactedIds].sort(),
        });
      }

      // 先清理显式对齐行，再删除关联：task_explicit_goals 通过复合外键引用 project_goals(project_id, goal_id)，
      // 反向删除会被延迟到外键检查时拒绝（23503）。
      const impactedTasks: { task_id: string; revision: string }[] = [];

      for (const task of impacted) {
        await repositories.tasks.deleteExplicitGoal(task.task_id, goalId);

        const bumped = await repositories.tasks.bumpTaskRevision(task.task_id);

        if (bumped === undefined) {
          throw resourceNotFound('Task');
        }

        impactedTasks.push({
          task_id: bumped.id,
          revision: toDecimalString(bumped.revision),
        });
      }

      await repositories.projects.deleteProjectGoalLink(project.id, goalId);

      const updated = await repositories.projects.bumpProjectRevision(
        project.id,
        expectedRevision,
      );

      if (updated === undefined) {
        throw revisionConflict({
          entityType: 'PROJECT',
          expectedRevision: toDecimalString(expectedRevision),
          actualRevision: toDecimalString(project.revision),
        });
      }

      await repositories.activities.insertActivityRecord({
        id: randomUUID(),
        actorKind: 'HUMAN',
        actorRef: LOCAL_ACTOR_REF,
        commandId: input.commandId,
        projectId: project.id,
        taskId: null,
        eventType: 'PROJECT_GOAL_UNLINKED',
        factRefs: {
          goal_id: goalId,
          cleared_explicit_alignment_task_ids: impactedIds,
        },
      });

      return {
        project_id: project.id,
        revision: toDecimalString(updated.revision),
        impacted_tasks: impactedTasks,
      };
    },
  });
}

function sameIdSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  const sorted = [...left].sort();

  return sorted.every((value, index) => value === right[index]);
}