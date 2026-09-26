import { randomUUID } from 'node:crypto';

import type { DbExecutor } from '../infrastructure/database.js';
import { toDecimalString } from '../shared/decimal.js';
import { LOCAL_ACTOR_REF, httpCommandScopeKey } from './actor.js';
import { runIdempotentCommand, type CommandOutcome } from './command.js';
import { resourceNotFound, revisionConflict, validationFailed } from './domain-error.js';
import { lockProjectInWorkspace, lockTaskInWorkspace, requireWorkspace } from './guards.js';
import { requireLocalDate, requireTimezone } from './local-calendar.js';
import { requireRevision, requireUuid } from './revisions.js';

export type SelectionCommandResult = { readonly selection_revision: string };

export async function setTaskSelection(db: DbExecutor, input: {
  readonly workspaceId: string; readonly taskId: string; readonly commandId: string;
  readonly expectedRevision: string; readonly pin: boolean;
  readonly laterLocalDate: string | null; readonly timezone: string | null;
}): Promise<CommandOutcome<SelectionCommandResult>> {
  const expected = requireRevision(input.expectedRevision, 'expected_revision');
  const taskId = requireUuid(input.taskId, 'task_id');
  if ((input.laterLocalDate === null) !== (input.timezone === null)) {
    throw validationFailed([{ field: 'later_local_date',
      message: 'date and timezone must be set or cleared together' }]);
  }
  const laterDate = input.laterLocalDate === null ? null :
    requireLocalDate(input.laterLocalDate, 'later_local_date');
  const timezone = input.timezone === null ? null : requireTimezone(input.timezone, 'timezone');
  return runIdempotentCommand<SelectionCommandResult>(db, {
    scopeKey: httpCommandScopeKey(input.workspaceId), commandId: input.commandId,
    commandType: 'SetTaskSelection', target: { task_id: taskId },
    body: { expected_revision: toDecimalString(expected), pin: input.pin,
      later_local_date: laterDate, timezone },
    execute: async (repositories) => {
      const task = await lockTaskInWorkspace(repositories, input.workspaceId, taskId);
      const current = await repositories.today.lockSelectionState(input.workspaceId);
      if (current !== expected) throw selectionConflict(expected, current);
      const revision = await repositories.today.advanceSelectionRevision(input.workspaceId, expected);
      if (revision === undefined) throw selectionConflict(expected, current);
      await repositories.today.setTaskSelection({ workspaceId: input.workspaceId,
        taskId, pin: input.pin, laterLocalDate: laterDate, laterTimezone: timezone, revision });
      await repositories.activities.insertActivityRecord({ id: randomUUID(), actorKind: 'HUMAN',
        workspaceId: input.workspaceId,
        actorRef: LOCAL_ACTOR_REF, commandId: input.commandId,
        projectId: task.project_id, taskId, eventType: 'TODAY_TASK_SELECTION_CHANGED',
        factRefs: { task_id: taskId, selection_revision: toDecimalString(revision),
          pin: input.pin, later_local_date: laterDate, timezone } });
      return { selection_revision: toDecimalString(revision) };
    },
  });
}

export async function setFocusSelection(db: DbExecutor, input: {
  readonly workspaceId: string; readonly commandId: string;
  readonly expectedRevision: string; readonly date: string; readonly timezone: string;
  readonly targetKind: 'GOAL' | 'PROJECT' | 'TASK' | null;
  readonly targetId: string | null;
}): Promise<CommandOutcome<SelectionCommandResult>> {
  const expected = requireRevision(input.expectedRevision, 'expected_revision');
  const date = requireLocalDate(input.date, 'date');
  const timezone = requireTimezone(input.timezone, 'timezone');
  if ((input.targetKind === null) !== (input.targetId === null)) {
    throw validationFailed([{ field: 'target_id',
      message: 'target_kind and target_id must be set or cleared together' }]);
  }
  const targetId = input.targetId === null ? null : requireUuid(input.targetId, 'target_id');
  return runIdempotentCommand<SelectionCommandResult>(db, {
    scopeKey: httpCommandScopeKey(input.workspaceId), commandId: input.commandId,
    commandType: 'SetFocusSelection', target: { date },
    body: { expected_revision: toDecimalString(expected), timezone,
      target_kind: input.targetKind, target_id: targetId },
    execute: async (repositories) => {
      await requireWorkspace(repositories, input.workspaceId);
      let projectId: string | null = null;
      let taskId: string | null = null;
      let goalId: string | null = null;
      if (input.targetKind === 'TASK' && targetId !== null) {
        const task = await lockTaskInWorkspace(repositories, input.workspaceId, targetId);
        taskId = task.id;
        projectId = task.project_id;
      } else if (input.targetKind === 'PROJECT' && targetId !== null) {
        projectId = (await lockProjectInWorkspace(repositories, input.workspaceId, targetId)).id;
      } else if (input.targetKind === 'GOAL' && targetId !== null) {
        const goal = await repositories.projects.readGoal(targetId);
        if (goal?.workspace_id !== input.workspaceId) throw resourceNotFound('Goal');
        goalId = goal.id;
      }
      const current = await repositories.today.lockSelectionState(input.workspaceId);
      if (current !== expected) throw selectionConflict(expected, current);
      const revision = await repositories.today.advanceSelectionRevision(input.workspaceId, expected);
      if (revision === undefined) throw selectionConflict(expected, current);
      await repositories.today.setFocus({ workspaceId: input.workspaceId, date, timezone,
        goalId, projectId: input.targetKind === 'PROJECT' ? projectId : null,
        taskId, revision });
      await repositories.activities.insertActivityRecord({ id: randomUUID(), actorKind: 'HUMAN',
        workspaceId: input.workspaceId,
        actorRef: LOCAL_ACTOR_REF, commandId: input.commandId,
        projectId, taskId, eventType: 'TODAY_FOCUS_CHANGED',
        factRefs: { date, timezone, target_kind: input.targetKind, target_id: targetId,
          selection_revision: toDecimalString(revision) } });
      return { selection_revision: toDecimalString(revision) };
    },
  });
}

function selectionConflict(expected: bigint, actual: bigint) {
  return revisionConflict({ entityType: 'TODAY_CHOICE',
    expectedRevision: toDecimalString(expected), actualRevision: toDecimalString(actual) });
}
