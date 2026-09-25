import { randomUUID } from 'node:crypto';

import type { DbExecutor } from '../infrastructure/database.js';
import type { FieldError } from '../shared/field-error.js';
import { toDecimalString } from '../shared/decimal.js';
import { checkOptionalText, checkRequiredText, normalizeText } from '../shared/text.js';
import { LOCAL_ACTOR_REF, httpCommandScopeKey } from './actor.js';
import { runIdempotentCommand, type CommandOutcome } from './command.js';
import { validationFailed } from './domain-error.js';
import { requireWorkspace } from './guards.js';

export interface CreateGoalInput {
  readonly workspaceId: string;
  readonly commandId: string;
  readonly title: string;
  readonly description: string;
}

export type CreateGoalResult = {
  readonly goal_id: string;
  readonly status: string;
  readonly revision: string;
};

/**
 * CreateGoal：Goal 是 Workspace 级事实，只有标题、说明与生命周期（不做百分比/KPI 引擎）。
 * 与 Project 的关联是单独命令（LinkProjectGoal），创建 Goal 不会隐式关联任何 Project。
 */
export async function createGoal(
  db: DbExecutor,
  input: CreateGoalInput,
): Promise<CommandOutcome<CreateGoalResult>> {
  const problems: FieldError[] = [];
  const titleProblem = checkRequiredText(input.title, 'title', 'goalTitle');
  const descriptionProblem = checkOptionalText(input.description, 'description', 'goalDescription');

  if (titleProblem !== undefined) {
    problems.push(titleProblem);
  }

  if (descriptionProblem !== undefined) {
    problems.push(descriptionProblem);
  }

  if (problems.length > 0) {
    throw validationFailed(problems);
  }

  const title = normalizeText(input.title);
  const description = normalizeText(input.description);

  return runIdempotentCommand<CreateGoalResult>(db, {
    scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId,
    commandType: 'CreateGoal',
    target: { workspace_id: input.workspaceId },
    body: { title, description },
    execute: async (repositories) => {
      await requireWorkspace(repositories, input.workspaceId);

      const goal = await repositories.projects.insertGoal({
        id: randomUUID(),
        workspaceId: input.workspaceId,
        title,
        description,
        status: 'ACTIVE',
      });

      await repositories.activities.insertActivityRecord({
        id: randomUUID(),
        actorKind: 'HUMAN',
        actorRef: LOCAL_ACTOR_REF,
        commandId: input.commandId,
        projectId: null,
        taskId: null,
        eventType: 'GOAL_CREATED',
        factRefs: { goal_id: goal.id, title: goal.title },
      });

      return {
        goal_id: goal.id,
        status: goal.status,
        revision: toDecimalString(goal.revision),
      };
    },
  });
}