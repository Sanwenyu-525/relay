import type { DbExecutor } from '../infrastructure/database.js';
import type { ContextManifestRow, DecisionRow, InformationRootRow, KnowledgeVersionRow,
  MemoryVersionRow, RuleRow } from '../infrastructure/database-schema.js';
import type { JsonObject, JsonValue } from '../infrastructure/json.js';
import type { ManagedContentStore } from '../storage/managed-content-store.js';
import { resourceNotFound } from './domain-error.js';
import { createRepositories } from './unit-of-work.js';

type ContextBuildStatus = 'NOT_STARTED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';
const SAFE_REASONS = new Set(['CONTEXT_REQUIRED_OVER_BUDGET',
  'CONTEXT_REQUIRED_SOURCE_UNAVAILABLE', 'CONTEXT_SOURCE_CHANGED']);

async function visibleRun(db: DbExecutor, workspaceId: string, runId: string) {
  const r = createRepositories(db);
  const run = await r.runs.readRun(runId);
  if (run?.workspace_id !== workspaceId) throw resourceNotFound('Run');
  const task = await r.tasks.readTask(run.task_id);
  if (task?.workspace_id !== workspaceId || task.project_id === null ||
      (await r.projects.readProject(task.project_id))?.workspace_id !== workspaceId) {
    throw resourceNotFound('Run');
  }
  return { run, task, projectId: task.project_id };
}

function summary(row: ContextManifestRow) {
  return { id: row.id, run_id: row.run_id, step_id: row.step_id,
    created_at: row.created_at.toISOString(), builder_version: row.builder_version,
    template_version: stringField(row.payload.template_version) ?? 'context-fixture-v1',
    manifest_hash: row.manifest_hash.toString('hex') };
}

export async function listRunContextManifests(db: DbExecutor, workspaceId: string, runId: string) {
  await visibleRun(db, workspaceId, runId);
  const r = createRepositories(db);
  const items = (await r.runs.listContextManifests(runId)).map(summary);
  const step = await r.runs.readStepByKind(runId, 'BUILD_CONTEXT');
  const attempts = step === undefined ? [] : await r.runs.listAttempts(step.id);
  const reason = attempts.at(-1)?.evidence?.reason;
  const reasonCode = typeof reason === 'string' && SAFE_REASONS.has(reason) ? reason : null;
  const status: ContextBuildStatus = step?.status === 'SUCCEEDED' ? 'SUCCEEDED' :
    step?.status === 'FAILED' ? 'FAILED' : step?.status === 'RUNNING' ? 'RUNNING' : 'NOT_STARTED';
  const message = reasonCode === 'CONTEXT_REQUIRED_OVER_BUDGET' ? '必需上下文超过预算。' :
    reasonCode === 'CONTEXT_REQUIRED_SOURCE_UNAVAILABLE' ? '必需来源不可用。' :
      reasonCode === 'CONTEXT_SOURCE_CHANGED' ? '来源构建期间发生变化，可重新装配。' : null;
  return { items, build: { status, reason_code: reasonCode, message } };
}

export async function readRunContextManifest(db: DbExecutor, storage: ManagedContentStore,
  workspaceId: string, runId: string, manifestId: string) {
  const { projectId } = await visibleRun(db, workspaceId, runId);
  const row = await createRepositories(db).runs.readContextManifestById(runId, manifestId);
  if (row === undefined) throw resourceNotFound('ContextManifest');
  const payload = row.payload;
  const sourceValues = Array.isArray(payload.sources) ? payload.sources : [];
  const sources: JsonObject[] = [];
  for (const value of sourceValues) {
    if (!isObject(value)) continue;
    if (await sourceVisible(db, storage, workspaceId, projectId, payload, value)) sources.push(value);
  }
  const exclusionValues = Array.isArray(payload.exclusions) ? payload.exclusions : [];
  const exclusions: JsonObject[] = [];
  for (const value of exclusionValues) {
    if (!isObject(value) || typeof value.reason !== 'string' ||
        typeof value.source_ref !== 'string') continue;
    if (await informationRefVisible(db, storage, workspaceId, projectId, value.source_ref)) {
      exclusions.push({ source_ref: value.source_ref, reason: value.reason });
    }
  }
  const allVisible = sources.length === sourceValues.length;
  const budget = isObject(payload.budget) ? { ...payload.budget,
    ...(!allVisible ? { required_tokens: null, selected_tokens: null } : {}) } : null;
  const dependencies = isObject(payload.dependencies) ? payload.dependencies : {};
  return { ...summary(row), budget, dependencies, sources, exclusions };
}

async function sourceVisible(db: DbExecutor, storage: ManagedContentStore,
  workspaceId: string, projectId: string, payload: JsonObject, source: JsonObject): Promise<boolean> {
  if (typeof source.kind !== 'string' || typeof source.source_ref !== 'string') return false;
  if (source.kind === 'CONTRACT') return ruleRefsVisible(db, workspaceId, projectId, payload);
  if (['PROJECT', 'TASK', 'RUN', 'CORRECTION'].includes(source.kind)) return true;
  return informationRefVisible(db, storage, workspaceId, projectId, source.source_ref);
}

async function ruleRefsVisible(db: DbExecutor, workspaceId: string, projectId: string,
  payload: JsonObject): Promise<boolean> {
  const contract = isObject(payload.contract) ? payload.contract : {};
  const refs = Array.isArray(contract.rule_refs) ? contract.rule_refs : [];
  const r = createRepositories(db);
  for (const value of refs) {
    if (!isObject(value) || typeof value.rule_id !== 'string' || typeof value.version !== 'string') return false;
    const root = await r.information.readRoot<RuleRow>('rule', value.rule_id);
    if (root?.workspace_id !== workspaceId || root.status !== 'ACTIVE' ||
        root.project_id !== null && root.project_id !== projectId ||
        root.current_version.toString() !== value.version) return false;
  }
  return true;
}

async function informationRefVisible(db: DbExecutor, storage: ManagedContentStore,
  workspaceId: string, projectId: string, ref: string): Promise<boolean> {
  const match = /^(knowledge|memory|decision):([0-9a-f-]{36}):v([1-9][0-9]*)$/iu.exec(ref);
  if (match === null) return false;
  const [, kind, id, versionText] = match;
  if (kind === undefined || id === undefined || versionText === undefined) return false;
  const key = kind.toLowerCase() as 'knowledge' | 'memory' | 'decision';
  const r = createRepositories(db);
  const root = await r.information.readRoot<InformationRootRow | DecisionRow>(key, id);
  if (root?.workspace_id !== workspaceId || root.status !== 'ACTIVE' ||
      root.project_id !== null && root.project_id !== projectId) return false;
  const version = (await r.information.listVersions<KnowledgeVersionRow | MemoryVersionRow>(key, id))
    .find((candidate) => candidate.version.toString() === versionText);
  if (version === undefined) return false;
  if (key === 'memory') {
    const expires = (version as MemoryVersionRow).expires_at;
    return expires === null || expires.getTime() > Date.now();
  }
  if (key === 'knowledge') {
    const knowledge = version as KnowledgeVersionRow;
    if (knowledge.availability !== 'AVAILABLE') return false;
    if (knowledge.source_kind === 'ARTIFACT_VERSION') {
      const artifact = knowledge.artifact_version_id === null ? undefined :
        await r.artifacts.readArtifactVersion(knowledge.artifact_version_id);
      if (artifact === undefined || artifact.content_hash.toString('hex') !==
          knowledge.content_sha256.toString('hex')) return false;
      const read = await storage.readWithHashCheck(artifact.storage_ref,
        { contentHash: artifact.content_hash, size: artifact.size });
      return read.status === 'OK';
    }
  }
  return true;
}

function isObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(value: JsonValue | undefined): string | null {
  return typeof value === 'string' ? value : null;
}
