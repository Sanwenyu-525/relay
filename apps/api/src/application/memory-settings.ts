import type { DbExecutor } from '../infrastructure/database.js';
import type { JsonObject } from '../infrastructure/json.js';
import { httpCommandScopeKey } from './actor.js';
import { runIdempotentCommand } from './command.js';
import { resourceNotFound, revisionConflict } from './domain-error.js';
import { requireWorkspace } from './guards.js';
import { requireRevision } from './revisions.js';
import { createRepositories } from './unit-of-work.js';

export async function readMemorySettings(db: DbExecutor, workspaceId: string): Promise<JsonObject> {
  const r = createRepositories(db);
  await requireWorkspace(r, workspaceId);
  const settings = await r.information.readMemorySettings(workspaceId);
  return { workspace_id: workspaceId, recall_enabled: settings?.recall_enabled ?? true,
    automatic_compaction: settings?.automatic_compaction ?? true,
    auto_capture: settings?.auto_capture ?? true,
    revision: (settings?.revision ?? 0n).toString() };
}

export async function setMemorySettings(db: DbExecutor, input: { workspaceId: string;
  commandId: string; expectedRevision: string; recallEnabled: boolean; automaticCompaction: boolean;
  autoCapture: boolean }) {
  const expected = requireRevision(input.expectedRevision, 'expected_revision');
  return runIdempotentCommand<JsonObject>(db, { scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId, commandType: 'SetMemorySettings', target: { workspace_id: input.workspaceId },
    body: { expected_revision: expected.toString(), recall_enabled: input.recallEnabled,
      automatic_compaction: input.automaticCompaction, auto_capture: input.autoCapture },
    execute: async (r) => {
      if (await r.workspaces.lockAuthority(input.workspaceId, 'update') === undefined) throw resourceNotFound('Workspace');
      const prior = await r.receipts.findReceipt({ scopeKey: httpCommandScopeKey(input.workspaceId), commandId: input.commandId });
      if (prior !== undefined) return prior.result_ref;
      const current = await r.information.readMemorySettings(input.workspaceId);
      if ((current?.revision ?? 0n) !== expected) throw revisionConflict({ entityType: 'MEMORY_SETTINGS',
        expectedRevision: expected.toString(), actualRevision: (current?.revision ?? 0n).toString() });
      const saved = await r.information.setMemorySettings(input.workspaceId, input.recallEnabled,
        input.automaticCompaction, input.autoCapture);
      return { workspace_id: input.workspaceId, recall_enabled: saved.recall_enabled,
        automatic_compaction: saved.automatic_compaction, auto_capture: saved.auto_capture,
        revision: saved.revision.toString() };
    } });
}
