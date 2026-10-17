import { randomUUID } from 'node:crypto';
import type { DbExecutor } from '../infrastructure/database.js';
import { toDecimalString } from '../shared/decimal.js';
import { checkRequiredText, normalizeText } from '../shared/text.js';
import { LOCAL_ACTOR_REF, httpCommandScopeKey } from './actor.js';
import { runIdempotentCommand, type CommandOutcome } from './command.js';
import { revisionConflict, validationFailed } from './domain-error.js';
import { lockProjectInWorkspace } from './guards.js';
import { requireRevision } from './revisions.js';

export interface EditProjectPresentationInput {
  readonly workspaceId: string; readonly projectId: string; readonly commandId: string;
  readonly expectedRevision: string; readonly title: string;
}
export type EditProjectPresentationResult = {
  readonly project_id: string; readonly title: string; readonly revision: string;
};

export async function editProjectPresentation(
  db: DbExecutor, input: EditProjectPresentationInput,
): Promise<CommandOutcome<EditProjectPresentationResult>> {
  const titleProblem = checkRequiredText(input.title, 'title', 'title');
  if (titleProblem !== undefined) throw validationFailed([titleProblem]);
  const title = normalizeText(input.title);
  const expectedRevision = requireRevision(input.expectedRevision, 'expected_revision');

  return runIdempotentCommand<EditProjectPresentationResult>(db, {
    scopeKey: httpCommandScopeKey(input.workspaceId), commandId: input.commandId,
    commandType: 'EditProjectPresentation', target: { project_id: input.projectId },
    body: { expected_revision: toDecimalString(expectedRevision), title },
    execute: async (repositories) => {
      const project = await lockProjectInWorkspace(repositories, input.workspaceId, input.projectId);
      if (project.revision !== expectedRevision) throw revisionConflict({ entityType: 'PROJECT',
        expectedRevision: toDecimalString(expectedRevision), actualRevision: toDecimalString(project.revision) });
      const updated = await repositories.projects.updateProjectTitle(project.id, expectedRevision, title);
      if (updated === undefined) throw revisionConflict({ entityType: 'PROJECT',
        expectedRevision: toDecimalString(expectedRevision), actualRevision: toDecimalString(project.revision) });
      await repositories.activities.insertActivityRecord({ id: randomUUID(), workspaceId: project.workspace_id,
        actorKind: 'HUMAN', actorRef: LOCAL_ACTOR_REF, commandId: input.commandId,
        projectId: project.id, taskId: null, eventType: 'PROJECT_PRESENTATION_UPDATED',
        factRefs: { project_id: project.id, previous_revision: toDecimalString(project.revision),
          revision: toDecimalString(updated.revision), title: updated.title } });
      return { project_id: updated.id, title: updated.title, revision: toDecimalString(updated.revision) };
    },
  });
}
