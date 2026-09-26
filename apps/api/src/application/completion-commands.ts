import { randomUUID } from 'node:crypto';

import type { DbExecutor } from '../infrastructure/database.js';
import type {
  AcceptanceCriterionRow,
  ArtifactRow,
  ArtifactVersionRow,
  TaskRow,
} from '../infrastructure/database-schema.js';
import type { JsonObject } from '../infrastructure/json.js';
import type { FieldError } from '../shared/field-error.js';
import { toDecimalString } from '../shared/decimal.js';
import { checkOptionalText, checkRequiredText, normalizeText } from '../shared/text.js';
import type { ManagedContentStore } from '../storage/managed-content-store.js';
import { LOCAL_ACTOR_REF, httpCommandScopeKey } from './actor.js';
import { loadVerifiedArtifactVersion } from './artifact-queries.js';
import { requireHumanInProgress } from './artifact-commands.js';
import { runIdempotentCommand, type CommandOutcome } from './command.js';
import {
  acceptanceStale,
  invalidTransition,
  revisionConflict,
  validationFailed,
} from './domain-error.js';
import { lockTaskInWorkspace } from './guards.js';
import { requireDeclaredOutputs } from './declared-output-requirements.js';
import { normalizeIdSet, requireRevision } from './revisions.js';

/**
 * 人工完成与重开（docs/api/http-command-contract.md 第 3 节、
 * contracts/04-recovery-and-commit.md 第 7 节）。
 *
 * 完成是一次短事务：Task 状态与当前完成指针、必要的 Project State delta、
 * HumanAcceptance / CompletionRecord、命令回执与关键审计在同一事务提交。
 * 不伪造 Run、不制造自动 PASS，也不因为出现更新的版本就暗中替换被接受的版本。
 *
 * 重开只新建 acceptance_revision 并清空当前完成指针，历史凭据全部保留，并递增所属 State revision；
 * 旧完成命令的重放由回执层返回当时结果，不会把新周期再次标为 DONE。
 */

export interface CompleteHumanTaskInput {
  readonly workspaceId: string;
  readonly taskId: string;
  readonly commandId: string;
  readonly expectedRevision: string;
  readonly acceptanceRevision: string;
  /** 无产物要求的事项允许空集合；给出时必须都属于本 Task。 */
  readonly artifactVersionIds: readonly string[] | undefined;
  readonly acceptance: {
    readonly statement: string;
    readonly acceptedCriterionIds: readonly string[];
    readonly reason: string | undefined;
  };
}

export type CompleteHumanTaskResult = {
  readonly task_id: string;
  readonly status: string;
  readonly revision: string;
  readonly acceptance_revision: string;
  readonly completion_id: string;
  readonly human_acceptance_id: string;
  readonly artifact_version_ids: readonly string[];
  /** Task 无 Project 时为 null；有 Project 时是本次完成 delta 提交后的 State revision。 */
  readonly state_revision: string | null;
};

export interface ReopenTaskInput {
  readonly workspaceId: string;
  readonly taskId: string;
  readonly commandId: string;
  readonly expectedRevision: string;
  readonly reason: string;
}

export type ReopenTaskResult = {
  readonly task_id: string;
  readonly status: string;
  readonly revision: string;
  readonly acceptance_revision: string;
  readonly previous_acceptance_revision: string;
  readonly previous_completion_id: string | null;
};

export async function completeHumanTask(
  db: DbExecutor,
  storage: ManagedContentStore,
  input: CompleteHumanTaskInput,
): Promise<CommandOutcome<CompleteHumanTaskResult>> {
  const expectedRevision = requireRevision(input.expectedRevision, 'expected_revision');
  const acceptanceRevision = requireRevision(input.acceptanceRevision, 'acceptance_revision');
  const statementProblem = checkRequiredText(
    input.acceptance.statement,
    'acceptance.statement',
    'acceptanceStatement',
  );
  const reasonProblem =
    input.acceptance.reason === undefined
      ? undefined
      : checkOptionalText(input.acceptance.reason, 'acceptance.reason', 'reason');
  const problems: FieldError[] = [];

  if (statementProblem !== undefined) {
    problems.push(statementProblem);
  }

  if (reasonProblem !== undefined) {
    problems.push(reasonProblem);
  }

  if (problems.length > 0) {
    throw validationFailed(problems);
  }

  const statement = normalizeText(input.acceptance.statement);
  const reason =
    input.acceptance.reason === undefined ? null : normalizeText(input.acceptance.reason);
  const acceptedCriterionIds = normalizeCriterionIds(input.acceptance.acceptedCriterionIds);
  const artifactVersionIds = normalizeIdSet(input.artifactVersionIds ?? [], 'artifact_version_ids');

  return runIdempotentCommand<CompleteHumanTaskResult>(db, {
    scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId,
    commandType: 'CompleteHumanTask',
    target: { task_id: input.taskId },
    body: {
      expected_revision: toDecimalString(expectedRevision),
      acceptance_revision: toDecimalString(acceptanceRevision),
      artifact_version_ids: artifactVersionIds,
      acceptance: {
        statement,
        accepted_criterion_ids: acceptedCriterionIds,
        reason,
      },
    },
    execute: async (repositories) => {
      const task = await lockTaskInWorkspace(repositories, input.workspaceId, input.taskId);

      requireRevisionMatch(task, expectedRevision);

      // 先核对确切验收周期：旧凭据不能完成新周期（contracts/03 第 5 节）。
      if (task.acceptance_revision !== acceptanceRevision) {
        throw acceptanceStale({
          taskId: task.id,
          expectedAcceptanceRevision: toDecimalString(acceptanceRevision),
          actualAcceptanceRevision: toDecimalString(task.acceptance_revision),
        });
      }

      requireHumanInProgress(task, '完成');

      const criteria = await repositories.tasks.listCriteria(task.id, acceptanceRevision);
      const acceptance = await repositories.tasks.readAcceptanceVersion(
        task.id,
        acceptanceRevision,
      );

      if (acceptance === undefined) {
        throw invalidTransition('当前验收版本缺失，不能完成该 Task。', {
          taskId: task.id,
          acceptanceRevision: toDecimalString(acceptanceRevision),
        });
      }

      requireConfirmedCriteria(task, criteria, acceptedCriterionIds);

      // 完成所接受的是明确版本：逐个核对归属与证据完整性，不因更新版本而替换。
      const acceptedVersions: { version: ArtifactVersionRow; artifact: ArtifactRow }[] = [];

      for (const versionId of artifactVersionIds) {
        acceptedVersions.push(
          await loadVerifiedArtifactVersion(repositories, storage, {
            workspaceId: input.workspaceId,
            taskId: task.id,
            versionId,
          }),
        );
      }

      requireDeclaredOutputs({
        task,
        acceptanceRevision,
        requiredOutputSpec: acceptance.required_output_spec,
        providedArtifactKinds: acceptedVersions.map((entry) => entry.artifact.artifact_kind),
      });

      const acceptanceId = randomUUID();
      const completionId = randomUUID();
      const completionRef =
        task.project_id === null
          ? null
          : {
              project_id: task.project_id,
              completion_id: completionId,
              source_ref: `task:${task.id}/acceptance:${toDecimalString(acceptanceRevision)}`,
            };

      const humanAcceptance = await repositories.completions.insertHumanAcceptance({
        id: acceptanceId,
        taskId: task.id,
        acceptanceRevision,
        actorKind: 'HUMAN',
        actorRef: LOCAL_ACTOR_REF,
        statement,
        acceptedCriterionIds,
        acceptedVersionRefs: artifactVersionIds,
        reason,
      });

      // State 行先取锁，再写入状态引用：顺序固定为 Task → ProjectState，不反向。
      const state =
        task.project_id === null
          ? undefined
          : await repositories.projects.lockProjectState(task.project_id);

      if (task.project_id !== null && state === undefined) {
        throw invalidTransition('所属 Project 缺少 Project State，不能完成本 Task。', {
          taskId: task.id,
        });
      }

      const nextActionCleared = state?.next_action_task_id === task.id;
      const stateDelta: JsonObject = {
        completion_ref: completionRef,
        next_action_cleared: nextActionCleared,
        artifact_version_ids: [...artifactVersionIds],
      };

      const completion = await repositories.completions.insertCompletionRecord({
        id: completionId,
        taskId: task.id,
        acceptanceRevision,
        basisKind: 'HUMAN',
        humanAcceptanceId: humanAcceptance.id,
        stateDelta,
      });
      for (const versionId of artifactVersionIds) {
        await repositories.lineage.insertExactEdge({ workspaceId: input.workspaceId,
          childVersionId: versionId, relation: 'ACCEPTED_BY',
          parentKind: 'COMPLETION_RECORD', parentId: completion.id });
      }

      const updated = await repositories.tasks.applyCompletionPointer({
        taskId: task.id,
        expectedRevision,
        acceptanceRevision,
        completionId: completion.id,
      });

      if (updated === undefined) {
        throw revisionConflict({
          entityType: 'TASK',
          expectedRevision: toDecimalString(expectedRevision),
          actualRevision: toDecimalString(task.revision),
        });
      }

      let stateRevision: bigint | null = null;

      if (state !== undefined && completionRef !== null) {
        await repositories.projects.insertStateCompletionRef({
          projectId: state.project_id,
          completionId: completion.id,
          sourceRef: completionRef.source_ref,
        });

        const nextState = nextActionCleared
          ? await repositories.projects.setProjectStateNextAction(
              state.project_id,
              state.revision,
              null,
            )
          : await repositories.projects.bumpProjectStateRevision(state.project_id, state.revision);

        if (nextState === undefined) {
          throw revisionConflict({
            entityType: 'PROJECT_STATE',
            expectedRevision: toDecimalString(state.revision),
            actualRevision: toDecimalString(state.revision),
          });
        }

        stateRevision = nextState.revision;
      }

      await repositories.activities.insertActivityRecord({
        id: randomUUID(),
        workspaceId: task.workspace_id,
        actorKind: 'HUMAN',
        actorRef: LOCAL_ACTOR_REF,
        commandId: input.commandId,
        projectId: task.project_id,
        taskId: task.id,
        eventType: 'TASK_COMPLETED',
        factRefs: {
          completion_id: completion.id,
          human_acceptance_id: humanAcceptance.id,
          acceptance_revision: toDecimalString(acceptanceRevision),
          artifact_version_ids: [...artifactVersionIds],
          accepted_criterion_ids: acceptedCriterionIds,
          state_delta: stateDelta,
        },
      });

      return {
        task_id: updated.id,
        status: updated.status,
        revision: toDecimalString(updated.revision),
        acceptance_revision: toDecimalString(updated.acceptance_revision),
        completion_id: completion.id,
        human_acceptance_id: humanAcceptance.id,
        artifact_version_ids: artifactVersionIds,
        state_revision: stateRevision === null ? null : toDecimalString(stateRevision),
      };
    },
  });
}

/**
 * ReopenTask：只允许已完成的 Task。新建 acceptance_revision（沿用目标与必需输出契约、
 * 复制 criteria），回到 READY 并清空当前完成指针；历史完成凭据与人工接受保留在原周期。
 */
export async function reopenTask(
  db: DbExecutor,
  input: ReopenTaskInput,
): Promise<CommandOutcome<ReopenTaskResult>> {
  const expectedRevision = requireRevision(input.expectedRevision, 'expected_revision');
  const reasonProblem = checkRequiredText(input.reason, 'reason', 'reason');

  if (reasonProblem !== undefined) {
    throw validationFailed([reasonProblem]);
  }

  const reason = normalizeText(input.reason);

  return runIdempotentCommand<ReopenTaskResult>(db, {
    scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId,
    commandType: 'ReopenTask',
    target: { task_id: input.taskId },
    body: { expected_revision: toDecimalString(expectedRevision), reason },
    execute: async (repositories) => {
      const task = await lockTaskInWorkspace(repositories, input.workspaceId, input.taskId);

      requireRevisionMatch(task, expectedRevision);

       if (task.status !== 'DONE') {
        throw invalidTransition(
          `只有已完成的 Task 可以重开（当前为 ${task.status}）；进行中的 Task 不通过重开改变验收契约。`,
          { taskId: task.id },
        );
       }

       // 重开会改变当前完成投影：按 Task → ProjectState 锁序取得 State 行，
       // 让持有旧 State 组合视图的消费者能够观察到失效。
       const state =
         task.project_id === null
           ? undefined
           : await repositories.projects.lockProjectState(task.project_id);

       if (task.project_id !== null && state === undefined) {
         throw invalidTransition('所属 Project 缺少 Project State，不能重开本 Task。', {
           taskId: task.id,
         });
       }

      const previousAcceptance = await repositories.tasks.readAcceptanceVersion(
        task.id,
        task.acceptance_revision,
      );
      const previousCriteria = await repositories.tasks.listCriteria(
        task.id,
        task.acceptance_revision,
      );
      const nextAcceptanceRevision = task.acceptance_revision + 1n;

      if (previousAcceptance === undefined) {
        throw invalidTransition('当前验收版本缺失，不能重开该 Task。', {
          taskId: task.id,
          acceptanceRevision: toDecimalString(task.acceptance_revision),
        });
      }

      await repositories.tasks.insertAcceptanceVersion({
        taskId: task.id,
        acceptanceRevision: nextAcceptanceRevision,
        objective: previousAcceptance.objective,
        requiredOutputSpec: previousAcceptance.required_output_spec,
        source: 'REOPEN',
      });

      for (const criterion of previousCriteria) {
        await repositories.tasks.insertCriterion({
          taskId: task.id,
          acceptanceRevision: nextAcceptanceRevision,
          criterionId: criterion.criterion_id,
          statement: criterion.statement,
          required: criterion.required,
          method: criterion.method,
          targetSpec: criterion.target_spec,
        });
      }

      const updated = await repositories.tasks.applyReopenRevision({
        taskId: task.id,
        expectedRevision,
        acceptanceRevision: nextAcceptanceRevision,
      });

       if (updated === undefined) {
        throw revisionConflict({
          entityType: 'TASK',
          expectedRevision: toDecimalString(expectedRevision),
          actualRevision: toDecimalString(task.revision),
        });
       }

       if (state !== undefined) {
         const nextState = await repositories.projects.bumpProjectStateRevision(
           state.project_id,
           state.revision,
         );

         if (nextState === undefined) {
           throw revisionConflict({
             entityType: 'PROJECT_STATE',
             expectedRevision: toDecimalString(state.revision),
             actualRevision: toDecimalString(state.revision),
           });
         }
       }

       await repositories.activities.insertActivityRecord({
         id: randomUUID(),
         workspaceId: task.workspace_id,
        actorKind: 'HUMAN',
        actorRef: LOCAL_ACTOR_REF,
        commandId: input.commandId,
        projectId: task.project_id,
        taskId: task.id,
        eventType: 'TASK_REOPENED',
        factRefs: {
          previous_acceptance_revision: toDecimalString(task.acceptance_revision),
          acceptance_revision: toDecimalString(nextAcceptanceRevision),
          previous_completion_id: task.current_completion_id,
          reason,
        },
      });

      return {
        task_id: updated.id,
        status: updated.status,
        revision: toDecimalString(updated.revision),
        acceptance_revision: toDecimalString(updated.acceptance_revision),
        previous_acceptance_revision: toDecimalString(task.acceptance_revision),
        previous_completion_id: task.current_completion_id,
      };
    },
  });
}

function requireRevisionMatch(task: TaskRow, expectedRevision: bigint): void {
  if (task.revision !== expectedRevision) {
    throw revisionConflict({
      entityType: 'TASK',
      expectedRevision: toDecimalString(expectedRevision),
      actualRevision: toDecimalString(task.revision),
    });
  }
}

/**
 * 人工确认的 criterion_id 集合先去除重复并排序，让相同集合得到相同的命令摘要。
 * criterion_id 的合法性由“是否属于当前验收版本”判定，不在这里另建一套命名规则。
 */
function normalizeCriterionIds(values: readonly string[]): readonly string[] {
  const unique = new Set<string>();
  const problems: FieldError[] = [];

  for (const value of values) {
    if (typeof value !== 'string' || value.trim() === '') {
      problems.push({
        field: 'acceptance.accepted_criterion_ids',
        message: 'must contain non-empty criterion ids',
      });
      continue;
    }

    unique.add(value.trim());
  }

  if (problems.length > 0) {
    throw validationFailed(problems);
  }

  return [...unique].sort();
}

/** 人工项确认：必须是当前验收版本里真实存在的 criterion_id，且覆盖全部 required 项。 */
function requireConfirmedCriteria(
  task: TaskRow,
  criteria: readonly AcceptanceCriterionRow[],
  acceptedCriterionIds: readonly string[],
): void {
  const known = new Set(criteria.map((criterion) => criterion.criterion_id));
  const unknown = acceptedCriterionIds.filter((criterionId) => !known.has(criterionId));

  if (unknown.length > 0) {
    throw validationFailed(
      unknown.map((criterionId) => ({
        field: 'acceptance.accepted_criterion_ids',
        message: `"${criterionId}" is not a criterion of the current acceptance revision`,
      })),
    );
  }

  const accepted = new Set(acceptedCriterionIds);
  const missing = criteria
    .filter((criterion) => criterion.required && !accepted.has(criterion.criterion_id))
    .map((criterion) => criterion.criterion_id)
    .sort();

  if (missing.length > 0) {
    throw invalidTransition(
      '仍有必需的人工验收项未获确认，本周期不能完成；人工声明不能覆盖必需条件。',
      {
        taskId: task.id,
        acceptanceRevision: toDecimalString(task.acceptance_revision),
        criterionIds: missing,
      },
    );
  }
}
