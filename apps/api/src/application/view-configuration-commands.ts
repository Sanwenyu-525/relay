import { randomUUID } from 'node:crypto';

import type { DbExecutor } from '../infrastructure/database.js';
import type { ProjectViewConfigurationRow } from '../infrastructure/database-schema.js';
import { toDecimalString } from '../shared/decimal.js';
import { isViewKind, resolveViewTemplate, type ViewKind,
  VIEW_TEMPLATE_VERSION } from '../view/builtin-view.js';
import { LOCAL_ACTOR_REF, httpCommandScopeKey } from './actor.js';
import { runIdempotentCommand, type CommandOutcome } from './command.js';
import { invalidTransition, resourceNotFound, revisionConflict,
  validationFailed } from './domain-error.js';
import { lockWritableProjectInWorkspace, readProjectInWorkspace } from './guards.js';
import { requireRevision } from './revisions.js';
import { createRepositories } from './unit-of-work.js';

export type ViewConfigurationDto = {
  readonly project_id: string;
  readonly revision: string;
  readonly kind: ViewKind;
  readonly template_version: string;
  readonly template_sha256: string;
  readonly pages: readonly { readonly page_id: string;
    readonly visible: boolean; readonly position: number }[];
  readonly updated_at: string;
};

function dto(row: ProjectViewConfigurationRow): ViewConfigurationDto {
  if (row.template_version !== VIEW_TEMPLATE_VERSION) {
    throw invalidTransition('已保存的内置工作台模板版本不可用。');
  }
  return { project_id: row.project_id, revision: toDecimalString(row.revision),
    ...resolveViewTemplate(row.kind), updated_at: row.updated_at.toISOString() };
}

export async function readViewConfiguration(db: DbExecutor, input: {
  readonly workspaceId: string; readonly projectId: string;
}): Promise<ViewConfigurationDto> {
  const r = createRepositories(db);
  await readProjectInWorkspace(r, input.workspaceId, input.projectId);
  const row = await r.views.read(input.projectId);
  if (row?.workspace_id !== input.workspaceId) throw resourceNotFound('View configuration');
  return dto(row);
}

export async function setViewConfiguration(db: DbExecutor, input: {
  readonly workspaceId: string; readonly projectId: string;
  readonly commandId: string; readonly expectedRevision: string;
  readonly kind: ViewKind;
}): Promise<CommandOutcome<ViewConfigurationDto>> {
  if (!isViewKind(input.kind)) {
    throw validationFailed([{ field: 'kind', message: 'unknown built-in view kind' }]);
  }
  const expected = requireRevision(input.expectedRevision, 'expected_revision');
  return runIdempotentCommand<ViewConfigurationDto>(db, {
    scopeKey: httpCommandScopeKey(input.workspaceId), commandId: input.commandId,
    commandType: 'SetViewConfiguration',
    target: { project_id: input.projectId },
    body: { expected_revision: toDecimalString(expected), kind: input.kind },
    execute: async (r) => {
      const project = await lockWritableProjectInWorkspace(r,
        input.workspaceId, input.projectId);
      const row = await r.views.read(project.id, true);
      if (row?.workspace_id !== input.workspaceId) throw resourceNotFound('View configuration');
      if (row.revision !== expected) {
        throw revisionConflict({ entityType: 'VIEW_CONFIGURATION',
          expectedRevision: toDecimalString(expected),
          actualRevision: toDecimalString(row.revision) });
      }
      const updated = await r.views.setKind(project.id, expected, input.kind);
      if (updated === undefined) {
        throw revisionConflict({ entityType: 'VIEW_CONFIGURATION',
          expectedRevision: toDecimalString(expected),
          actualRevision: toDecimalString(row.revision) });
      }
      await r.activities.insertActivityRecord({ id: randomUUID(),
        workspaceId: input.workspaceId, actorKind: 'HUMAN',
        actorRef: LOCAL_ACTOR_REF, commandId: input.commandId,
        projectId: project.id, taskId: null,
        eventType: 'VIEW_CONFIGURATION_CHANGED', factRefs: {
          kind: input.kind, revision: toDecimalString(updated.revision),
          template_version: VIEW_TEMPLATE_VERSION,
        } });
      return dto(updated);
    },
  });
}
