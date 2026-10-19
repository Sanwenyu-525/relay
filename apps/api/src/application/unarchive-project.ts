import { randomUUID } from 'node:crypto';

import type { DbExecutor } from '../infrastructure/database.js';
import { toDecimalString } from '../shared/decimal.js';
import { LOCAL_ACTOR_REF, httpCommandScopeKey } from './actor.js';
import { runIdempotentCommand, type CommandOutcome } from './command.js';
import { resourceNotFound, revisionConflict } from './domain-error.js';
import { requireRevision } from './revisions.js';

export interface UnarchiveProjectInput {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly commandId: string;
  readonly expectedRevision: string;
}

export type UnarchiveProjectResult = {
  readonly project_id: string;
  readonly revision: string;
  readonly archived_at: null;
  readonly archive_status: 'ACTIVE';
};

/**
 * 撤销项目归档（危险操作的反向命令，工作台 §13.2）。
 *
 * 它只做一件事：把 `projects.archived_at` 写回 NULL。归档成立的前提是九类阻断项都已清空
 * （活动 Task/Run/租约、未结算外部效果、进行中的导入与 Assist），因此撤销不需要回滚下游，
 * 也不补写 Project State 或重开任何 Task——只是让原来那批读侧栅栏重新放行。
 *
 * 已是 ACTIVE 时如实返回当前事实、不推进修订（与 `reopenAssistSession` 同一口径），
 * 这样撤销条与其它入口重复点击都不会制造空的修订推进。
 */
export async function unarchiveProject(db: DbExecutor,
  input: UnarchiveProjectInput): Promise<CommandOutcome<UnarchiveProjectResult>> {
  const expectedRevision = requireRevision(input.expectedRevision, 'expected_revision');

  return runIdempotentCommand<UnarchiveProjectResult>(db, {
    scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId,
    commandType: 'UnarchiveProject',
    target: { project_id: input.projectId },
    body: { expected_revision: toDecimalString(expectedRevision) },
    execute: async (repositories) => {
      // 与归档取同一把排他锁：撤销与另一次归档/状态写入必须串行，不能各自看到对方之前的行。
      const project = await repositories.projects.lockProjectExclusive(input.projectId);
      if (project === undefined || project.workspace_id !== input.workspaceId) {
        throw resourceNotFound('Project');
      }
      if (project.revision !== expectedRevision) {
        throw revisionConflict({ entityType: 'PROJECT',
          expectedRevision: toDecimalString(expectedRevision),
          actualRevision: toDecimalString(project.revision) });
      }
      if (project.archived_at === null) {
        return { project_id: project.id, revision: toDecimalString(project.revision),
          archived_at: null, archive_status: 'ACTIVE' };
      }

      const restored = await repositories.projects.unarchiveProject(project.id, expectedRevision);
      if (restored === undefined) {
        throw revisionConflict({ entityType: 'PROJECT',
          expectedRevision: toDecimalString(expectedRevision),
          actualRevision: toDecimalString(project.revision) });
      }
      await repositories.activities.insertActivityRecord({
        id: randomUUID(), workspaceId: input.workspaceId,
        actorKind: 'HUMAN', actorRef: LOCAL_ACTOR_REF,
        commandId: input.commandId, projectId: restored.id, taskId: null,
        eventType: 'PROJECT_UNARCHIVED',
        factRefs: { project_id: restored.id,
          previous_revision: toDecimalString(project.revision),
          revision: toDecimalString(restored.revision),
          archived_at: project.archived_at.toISOString() },
      });
      return { project_id: restored.id, revision: toDecimalString(restored.revision),
        archived_at: null, archive_status: 'ACTIVE' };
    },
  });
}
