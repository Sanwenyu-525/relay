import type { JsonObject, JsonValue } from '../infrastructure/json.js';
import type { RunRow, TaskRow, WorkspaceExecutionAuthorityRow } from '../infrastructure/database-schema.js';
import { toDecimalString } from '../shared/decimal.js';
import type { Repositories } from './unit-of-work.js';

/** A Task row revision also changes on status and Review transitions, which are not ModelPort inputs. */
export function matchesTaskContext(payload: JsonObject, task: TaskRow): boolean {
  const sources = payload.sources;
  const taskSource = Array.isArray(sources) ? sources.find((source) =>
    readString(source, 'kind') === 'TASK' &&
    readString(source, 'source_ref') === `task:${task.id}`) : undefined;
  return readString(payload.task, 'id') === task.id &&
    readString(payload.task, 'title') === task.title &&
    readString(payload.project, 'id') === task.project_id &&
    readString(taskSource, 'version') === toDecimalString(task.acceptance_revision);
}

export async function contextManifestMatchesCurrent(repositories: Repositories,
  payload: JsonObject, run: RunRow, task: TaskRow,
  authority: WorkspaceExecutionAuthorityRow): Promise<boolean> {
  const dependencies = payload.dependencies;
  if (readString(dependencies, 'context_revision') !== toDecimalString(authority.context_revision) ||
      readString(dependencies, 'authority_revision') !== toDecimalString(authority.revision) ||
      readString(payload.run, 'id') !== run.id ||
      readString(payload.run, 'ownership_epoch') !== toDecimalString(run.ownership_epoch) ||
      !matchesTaskContext(payload, task)) return false;
  const project = task.project_id === null ? undefined :
    await repositories.projects.readProject(task.project_id, true);
  return project !== undefined &&
    readString(dependencies, 'project_revision') === toDecimalString(project.revision);
}

/** Called inside the authority → Task → Run admission transaction before a Gateway effect. */
export async function hasCurrentRunContext(repositories: Repositories,
  run: RunRow, task: TaskRow, authority: WorkspaceExecutionAuthorityRow): Promise<boolean> {
  const built = await repositories.runs.readStepByKind(run.id, 'BUILD_CONTEXT');
  const hash = readString(built?.result_ref, 'manifest_hash');
  if (built?.status !== 'SUCCEEDED' || hash === undefined) return false;
  const manifest = await repositories.runs.readContextManifestByHash(run.id, Buffer.from(hash, 'hex'));
  return manifest !== undefined &&
    contextManifestMatchesCurrent(repositories, manifest.payload, run, task, authority);
}

function readString(value: JsonValue | null | undefined, key: string): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const field = (value as JsonObject)[key];
  return typeof field === 'string' ? field : undefined;
}
