import { randomUUID } from 'node:crypto';

import type { DbExecutor } from '../infrastructure/database.js';
import type { ProjectType } from '../infrastructure/database-schema.js';
import { isPhaseOfProjectType, PHASES_BY_PROJECT_TYPE } from '../project/project-phase.js';
import { toDecimalString } from '../shared/decimal.js';
import { LOCAL_ACTOR_REF, httpCommandScopeKey } from './actor.js';
import { runIdempotentCommand, type CommandOutcome } from './command.js';
import {
  invalidTransition,
  resourceNotFound,
  revisionConflict,
  validationFailed,
} from './domain-error.js';
import { lockWritableProjectInWorkspace, readProjectInWorkspace, requireWorkspace } from './guards.js';
import { requireRevision } from './revisions.js';
import { normalizeStateAction, type NormalizedStateAction } from './state-action.js';
import type { Repositories } from './unit-of-work.js';

export interface RunStateCommandInput {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly commandId: string;
  readonly expectedRevision: string;
  readonly action: string;
  /** action 的类型化参数（HTTP 层已去掉 command_id / expected_revision / action）。 */
  readonly params: Readonly<Record<string, unknown>>;
}

export type RunStateCommandResult = {
  readonly project_id: string;
  readonly action: string;
  readonly revision: string;
};

/**
 * Project State 的类型化命令。
 *
 * 依据 docs/api/http-command-contract.md 第 5 节与 contracts/01-facts-and-ownership.md 第 4 节：
 *   * 输入是 command_id、expected_revision 与一个类型化 action，不接受任意字段路径赋值或整对象覆盖；
 *   * revision 冲突不做 last-write-wins，返回当前版本由调用方重建意图；
 *   * 相同 command_id 与相同内容返回原回执，异内容由回执层裁决为 COMMAND_ID_REUSED；
 *   * 非空 SET_NEXT_ACTION 先锁目标 Task，再锁 ProjectState；null 不需要 Task 锁，
 *     从而不与完成/重开的 Task → ProjectState 路径形成反向等待。
 * 每次成功提交都把 State revision 递增一次；被冲突拒绝的命令不写任何事实。
 */
export async function runStateCommand(
  db: DbExecutor,
  input: RunStateCommandInput,
): Promise<CommandOutcome<RunStateCommandResult>> {
  const expectedRevision = requireRevision(input.expectedRevision, 'expected_revision');
  const normalized = normalizeStateAction(input.action, input.params);

  return runIdempotentCommand<RunStateCommandResult>(db, {
    scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId,
    commandType: 'SetProjectState',
    target: { project_id: input.projectId },
    body: { expected_revision: toDecimalString(expectedRevision), ...normalized.body },
    execute: async (repositories) => {
      await requireWorkspace(repositories, input.workspaceId);

      const project = await readProjectInWorkspace(
        repositories,
        input.workspaceId,
        input.projectId,
      );

      if (normalized.action === 'SET_NEXT_ACTION' && normalized.nextActionTaskId !== null) {
        // 先以 Task → ProjectState 的既有顺序锁定目标，既验证“属于当前 Project”，
        // 也避免 ProjectState → Task 与 Reopen 的 Task → ProjectState 交错死锁。
        // 不使用 workspace guard，以保留原有“不属于当前 Project”统一为字段校验错误的语义。
        const task = await repositories.tasks.lockTask(normalized.nextActionTaskId);

        if (task === undefined || task.project_id !== project.id) {
          throw validationFailed([
            {
              field: 'next_action_task_id',
              message: 'must reference a task of this project',
            },
          ]);
        }
      }

      await lockWritableProjectInWorkspace(repositories, input.workspaceId, project.id);

      const state = await repositories.projects.lockProjectState(project.id);

      if (state === undefined) {
        throw resourceNotFound('Project State');
      }

      if (state.revision !== expectedRevision) {
        throw revisionConflict({
          entityType: 'PROJECT_STATE',
          expectedRevision: toDecimalString(expectedRevision),
          actualRevision: toDecimalString(state.revision),
        });
      }

      const updated = await applyAction(
        repositories,
        project.id,
        project.project_type,
        expectedRevision,
        normalized,
      );

      await repositories.activities.insertActivityRecord({
        id: randomUUID(),
        workspaceId: project.workspace_id,
        actorKind: 'HUMAN',
        actorRef: LOCAL_ACTOR_REF,
        commandId: input.commandId,
        projectId: project.id,
        taskId: null,
        eventType: 'PROJECT_STATE_UPDATED',
        factRefs: {
          action: normalized.action,
          state_revision: toDecimalString(updated),
        },
      });

      return {
        project_id: project.id,
        action: normalized.action,
        revision: toDecimalString(updated),
      };
    },
  });
}

export async function applyAction(
  repositories: Repositories,
  projectId: string,
  projectType: ProjectType,
  expectedRevision: bigint,
  action: NormalizedStateAction,
): Promise<bigint> {
  switch (action.action) {
    case 'SET_PHASE': {
      if (!isPhaseOfProjectType(projectType, action.phaseKey)) {
        throw validationFailed([
          {
            field: 'phase_key',
            message: `must be one of: ${PHASES_BY_PROJECT_TYPE[projectType].join(', ')}`,
          },
        ]);
      }

      const state = await repositories.projects.setProjectStatePhase(
        projectId,
        expectedRevision,
        action.phaseKey,
      );

      return requireBumped(state, expectedRevision);
    }
    case 'SET_NEXT_ACTION': {
      const state = await repositories.projects.setProjectStateNextAction(
        projectId,
        expectedRevision,
        action.nextActionTaskId,
      );

      return requireBumped(state, expectedRevision);
    }
    case 'SELECT_ARTIFACT_VERSION': {
      const version = await repositories.artifacts.readArtifactVersion(action.artifactVersionId);
      const artifact =
        version === undefined
          ? undefined
          : await repositories.artifacts.readArtifact(version.artifact_id);

      if (version === undefined || artifact?.project_id !== projectId) {
        throw resourceNotFound('Artifact version');
      }

      const existing = await repositories.projects.findProjectStateArtifactRef(
        projectId,
        version.id,
      );

      if (existing !== undefined) {
        throw invalidTransition('该产物版本已被选入当前 Project State。', {
          taskId: artifact.task_id,
        });
      }

      await repositories.projects.insertStateArtifactRef({
        projectId,
        artifactVersionId: version.id,
        sourceRef: action.sourceRef,
      });

      return bumpOnly(repositories, projectId, expectedRevision);
    }
    case 'ADD_CONFIRMED_RISK': {
      await repositories.projects.insertRisk({
        id: randomUUID(),
        projectId,
        statement: action.statement,
        sourceRef: action.sourceRef,
        confirmationRef: action.confirmationRef,
      });

      return bumpOnly(repositories, projectId, expectedRevision);
    }
    case 'RESOLVE_BLOCKER': {
      const blocker = await repositories.projects.readBlocker(action.blockerId);

      if (blocker === undefined || blocker.project_id !== projectId) {
        throw resourceNotFound('Project blocker');
      }

      const resolved = await repositories.projects.resolveBlocker(action.blockerId);

      if (resolved === undefined) {
        throw invalidTransition('该 blocker 已经解除，不重复解除。', {
          blockerIds: [action.blockerId],
        });
      }

      return bumpOnly(repositories, projectId, expectedRevision);
    }
  }
}

async function bumpOnly(
  repositories: Repositories,
  projectId: string,
  expectedRevision: bigint,
): Promise<bigint> {
  const state = await repositories.projects.bumpProjectStateRevision(
    projectId,
    expectedRevision,
  );

  return requireBumped(state, expectedRevision);
}

/** CAS 未命中只可能发生在锁外并发的极端情况：按版本冲突处理，不静默继续。 */
function requireBumped(
  state: { readonly revision: bigint } | undefined,
  expectedRevision: bigint,
): bigint {
  if (state === undefined) {
    throw revisionConflict({
      entityType: 'PROJECT_STATE',
      expectedRevision: toDecimalString(expectedRevision),
      actualRevision: toDecimalString(expectedRevision),
    });
  }

  return state.revision;
}
