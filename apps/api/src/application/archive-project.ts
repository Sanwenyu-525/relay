import { randomUUID } from 'node:crypto';

import type { DbExecutor } from '../infrastructure/database.js';
import { toDecimalString } from '../shared/decimal.js';
import { LOCAL_ACTOR_REF, httpCommandScopeKey } from './actor.js';
import { runIdempotentCommand, type CommandOutcome } from './command.js';
import { projectArchiveBlocked, projectArchived, resourceNotFound,
  revisionConflict } from './domain-error.js';
import { requireRevision } from './revisions.js';

export interface ArchiveProjectInput {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly commandId: string;
  readonly expectedRevision: string;
}

export type ArchiveProjectResult = {
  readonly project_id: string;
  readonly revision: string;
  readonly archived_at: string;
  readonly archive_status: 'ARCHIVED';
};

/** Project Owner: one short transaction owns the archive decision and its receipt. */
export async function archiveProject(
  db: DbExecutor,
  input: ArchiveProjectInput,
): Promise<CommandOutcome<ArchiveProjectResult>> {
  const expectedRevision = requireRevision(input.expectedRevision, 'expected_revision');

  return runIdempotentCommand<ArchiveProjectResult>(db, {
    scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId,
    commandType: 'ArchiveProject',
    target: { project_id: input.projectId },
    body: { expected_revision: toDecimalString(expectedRevision) },
    execute: async (repositories) => {
      // Do not lock Task rows after Project: ordinary writes already lock Task then
      // take Project KEY SHARE. The exclusive Project lock waits for them and
      // excludes every later write until this decision commits.
      const project = await repositories.projects.lockProjectExclusive(input.projectId);
      if (project === undefined || project.workspace_id !== input.workspaceId) {
        throw resourceNotFound('Project');
      }
      if (project.archived_at !== null) throw projectArchived();
      if (project.revision !== expectedRevision) {
        throw revisionConflict({ entityType: 'PROJECT',
          expectedRevision: toDecimalString(expectedRevision),
          actualRevision: toDecimalString(project.revision) });
      }

      const blockers = await repositories.projects.listArchiveBlockers(project.id);
      if (blockers.length > 0) throw projectArchiveBlocked(blockers);

      const archived = await repositories.projects.archiveProject(project.id, expectedRevision);
      if (archived === undefined) {
        throw revisionConflict({ entityType: 'PROJECT',
          expectedRevision: toDecimalString(expectedRevision),
          actualRevision: toDecimalString(project.revision) });
      }
      const archivedAt = archived.archived_at!;
      await repositories.activities.insertActivityRecord({
        id: randomUUID(), workspaceId: input.workspaceId,
        actorKind: 'HUMAN', actorRef: LOCAL_ACTOR_REF,
        commandId: input.commandId, projectId: project.id, taskId: null,
        eventType: 'PROJECT_ARCHIVED',
        factRefs: { project_id: project.id,
          previous_revision: toDecimalString(project.revision),
          revision: toDecimalString(archived.revision),
          archived_at: archivedAt.toISOString() },
      });
      return { project_id: archived.id, revision: toDecimalString(archived.revision),
        archived_at: archivedAt.toISOString(), archive_status: 'ARCHIVED' };
    },
  });
}
