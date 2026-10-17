import { randomUUID } from 'node:crypto';

import type { DbExecutor } from '../infrastructure/database.js';
import { toDecimalString } from '../shared/decimal.js';
import { LOCAL_ACTOR_REF, httpCommandScopeKey } from './actor.js';
import { runIdempotentCommand, type CommandOutcome } from './command.js';
import { invalidTransition, resourceNotFound, revisionConflict } from './domain-error.js';
import { lockTaskInWorkspace, lockWritableProjectInWorkspace, requireWorkspace } from './guards.js';
import { requireRevision, requireUuid } from './revisions.js';

export interface AssignInboxTaskToProjectInput {
  readonly workspaceId: string;
  readonly taskId: string;
  readonly commandId: string;
  readonly expectedRevision: string;
  readonly projectId: string;
}

export type AssignInboxTaskToProjectResult = {
  readonly task_id: string;
  readonly project_id: string;
  readonly status: string;
  readonly revision: string;
  readonly acceptance_revision: string;
}

export async function assignInboxTaskToProject(
  db: DbExecutor,
  input: AssignInboxTaskToProjectInput,
): Promise<CommandOutcome<AssignInboxTaskToProjectResult>> {
  const expectedRevision = requireRevision(input.expectedRevision, 'expected_revision');
  const projectId = requireUuid(input.projectId, 'project_id');
  return runIdempotentCommand(db, {
    scopeKey: httpCommandScopeKey(input.workspaceId), commandId: input.commandId,
    commandType: 'AssignInboxTaskToProject', target: { task_id: input.taskId },
    body: { expected_revision: toDecimalString(expectedRevision), project_id: projectId },
    execute: async (repositories) => {
      await requireWorkspace(repositories, input.workspaceId);
      const task = await lockTaskInWorkspace(repositories, input.workspaceId, input.taskId);
      await lockWritableProjectInWorkspace(repositories, input.workspaceId, projectId);
      if (task.revision !== expectedRevision) throw revisionConflict({ entityType: 'TASK',
        expectedRevision: toDecimalString(expectedRevision), actualRevision: toDecimalString(task.revision) });
      if (task.project_id !== null || !['INBOX', 'READY'].includes(task.status)
        || task.executor_kind !== 'HUMAN' || task.executor_run_id !== null) {
        throw invalidTransition('仅可将未归属且由人工持有的 Inbox 或 Ready 任务首次归入项目。');
      }
      const blockers = await repositories.tasks.hasProjectBindingBlockers(task.id);
      if (blockers.priorWork) throw invalidTransition('已有产物、运行或完成凭据的任务不能通过 Inbox 归入入口迁移。');
      if (blockers.dependencies) throw invalidTransition('请先明确处理任务依赖，再归入项目。');

      const sessions = [...await repositories.assist.listSessions(input.workspaceId, undefined, task.id, 'ALL')]
        .sort((a, b) => a.id.localeCompare(b.id));
      const lockedSessions = [];
      for (const listed of sessions) {
        const session = await repositories.assist.readSession(listed.id, true);
        if (session === undefined || session.workspace_id !== input.workspaceId || session.task_id !== task.id
          || session.project_id !== null || session.working_resource_id !== null) {
          throw invalidTransition('任务会话归属已变化，请刷新后重试。');
        }
        if (await repositories.assist.hasInflightMessages(session.id)) {
          throw invalidTransition('任务会话仍有进行中的消息，请稍后再归入项目。');
        }
        lockedSessions.push(session);
      }

      const updated = await repositories.tasks.assignInboxTaskToProject({
        taskId: task.id, expectedRevision, projectId,
      });
      if (updated === undefined) throw revisionConflict({ entityType: 'TASK',
        expectedRevision: toDecimalString(expectedRevision), actualRevision: toDecimalString(task.revision) });
      for (const session of lockedSessions) await repositories.assist.bindSessionProject(session.id, projectId);
      await repositories.activities.insertActivityRecord({ id: randomUUID(), workspaceId: input.workspaceId,
        actorKind: 'HUMAN', actorRef: LOCAL_ACTOR_REF, commandId: input.commandId,
        projectId, taskId: task.id, eventType: 'TASK_PROJECT_ASSIGNED',
        factRefs: { previous_project_id: null, project_id: projectId,
          previous_revision: toDecimalString(task.revision), revision: toDecimalString(updated.revision),
          session_ids: lockedSessions.map((session) => session.id) } });
      return { task_id: updated.id, project_id: projectId, status: updated.status,
        revision: toDecimalString(updated.revision), acceptance_revision: toDecimalString(updated.acceptance_revision) };
    },
  });
}
