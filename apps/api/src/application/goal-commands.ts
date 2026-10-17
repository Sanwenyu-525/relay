import { randomUUID } from 'node:crypto';
import type { DbExecutor } from '../infrastructure/database.js';
import { toDecimalString } from '../shared/decimal.js';
import { checkOptionalText, checkRequiredText, normalizeText } from '../shared/text.js';
import { LOCAL_ACTOR_REF, httpCommandScopeKey } from './actor.js';
import { runIdempotentCommand, type CommandOutcome } from './command.js';
import { invalidTransition, resourceNotFound, revisionConflict, validationFailed } from './domain-error.js';
import { requireWorkspace } from './guards.js';
import { requireRevision } from './revisions.js';

export interface EditGoalInput {
  readonly workspaceId: string; readonly goalId: string; readonly commandId: string;
  readonly expectedRevision: string; readonly title: string; readonly description: string;
}
export type EditGoalResult = {
  readonly goal_id: string; readonly title: string; readonly description: string;
  readonly status: string; readonly revision: string;
};

export async function editGoal(db: DbExecutor, input: EditGoalInput): Promise<CommandOutcome<EditGoalResult>> {
  const titleProblem = checkRequiredText(input.title, 'title', 'goalTitle');
  const descriptionProblem = checkOptionalText(input.description, 'description', 'goalDescription');
  const problems = [titleProblem, descriptionProblem].filter((problem) => problem !== undefined);
  if (problems.length > 0) throw validationFailed(problems);
  const title = normalizeText(input.title);
  const description = normalizeText(input.description);
  const expectedRevision = requireRevision(input.expectedRevision, 'expected_revision');

  return runIdempotentCommand<EditGoalResult>(db, {
    scopeKey: httpCommandScopeKey(input.workspaceId), commandId: input.commandId,
    commandType: 'EditGoal', target: { goal_id: input.goalId },
    body: { expected_revision: toDecimalString(expectedRevision), title, description },
    execute: async (repositories) => {
      await requireWorkspace(repositories, input.workspaceId);
      const goal = await repositories.projects.lockGoalForUpdate(input.goalId);
      if (goal === undefined || goal.workspace_id !== input.workspaceId) throw resourceNotFound('Goal');
      if (goal.status !== 'ACTIVE') throw invalidTransition('已归档的目标不能编辑。');
      if (goal.revision !== expectedRevision) throw revisionConflict({ entityType: 'GOAL',
        expectedRevision: toDecimalString(expectedRevision), actualRevision: toDecimalString(goal.revision) });
      const updated = await repositories.projects.updateGoalPresentation(goal.id,
        expectedRevision, title, description);
      if (updated === undefined) throw revisionConflict({ entityType: 'GOAL',
        expectedRevision: toDecimalString(expectedRevision), actualRevision: toDecimalString(goal.revision) });
      await repositories.activities.insertActivityRecord({ id: randomUUID(), workspaceId: goal.workspace_id,
        actorKind: 'HUMAN', actorRef: LOCAL_ACTOR_REF, commandId: input.commandId,
        projectId: null, taskId: null, eventType: 'GOAL_UPDATED',
        factRefs: { goal_id: goal.id, previous_revision: toDecimalString(goal.revision),
          revision: toDecimalString(updated.revision), changed_fields: [
            ...(goal.title !== updated.title ? ['title'] : []),
            ...(goal.description !== updated.description ? ['description'] : []),
          ], title: updated.title } });
      return { goal_id: updated.id, title: updated.title, description: updated.description,
        status: updated.status, revision: toDecimalString(updated.revision) };
    },
  });
}

export interface ArchiveGoalInput {
  readonly workspaceId: string; readonly goalId: string; readonly commandId: string;
  readonly expectedRevision: string;
}
export type ArchiveGoalResult = { readonly goal_id: string; readonly status: 'ARCHIVED'; readonly revision: string };

export async function archiveGoal(db: DbExecutor, input: ArchiveGoalInput): Promise<CommandOutcome<ArchiveGoalResult>> {
  const expectedRevision = requireRevision(input.expectedRevision, 'expected_revision');
  return runIdempotentCommand<ArchiveGoalResult>(db, {
    scopeKey: httpCommandScopeKey(input.workspaceId), commandId: input.commandId,
    commandType: 'ArchiveGoal', target: { goal_id: input.goalId },
    body: { expected_revision: toDecimalString(expectedRevision) },
    execute: async (repositories) => {
      await requireWorkspace(repositories, input.workspaceId);
      const goal = await repositories.projects.lockGoalForUpdate(input.goalId);
      if (goal === undefined || goal.workspace_id !== input.workspaceId) throw resourceNotFound('Goal');
      if (goal.status !== 'ACTIVE') throw invalidTransition('目标已归档。');
      if (goal.revision !== expectedRevision) throw revisionConflict({ entityType: 'GOAL',
        expectedRevision: toDecimalString(expectedRevision), actualRevision: toDecimalString(goal.revision) });
      const updated = await repositories.projects.archiveGoal(goal.id, expectedRevision);
      if (updated === undefined) throw revisionConflict({ entityType: 'GOAL',
        expectedRevision: toDecimalString(expectedRevision), actualRevision: toDecimalString(goal.revision) });
      await repositories.activities.insertActivityRecord({ id: randomUUID(), workspaceId: goal.workspace_id,
        actorKind: 'HUMAN', actorRef: LOCAL_ACTOR_REF, commandId: input.commandId,
        projectId: null, taskId: null, eventType: 'GOAL_ARCHIVED',
        factRefs: { goal_id: goal.id, previous_revision: toDecimalString(goal.revision),
          revision: toDecimalString(updated.revision) } });
      return { goal_id: updated.id, status: 'ARCHIVED', revision: toDecimalString(updated.revision) };
    },
  });
}
