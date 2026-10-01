import { createHash } from 'node:crypto';

import type { DbExecutor } from '../infrastructure/database.js';
import type { ContextManifestRow, InformationRootRow, KnowledgeVersionRow,
  MemoryVersionRow, DecisionVersionRow, RunRow } from '../infrastructure/database-schema.js';
import type { JsonObject } from '../infrastructure/json.js';
import type { ManagedContentStore } from '../storage/managed-content-store.js';
import { MODEL_ERROR_CATEGORIES } from '../workflow/model-error-classification.js';
import { resourceNotFound } from './domain-error.js';
import { createRepositories, type Repositories } from './unit-of-work.js';
import { requireWorkspace } from './guards.js';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const INFO_SOURCE = new RegExp(`^(knowledge|memory|decision):(${UUID}):v([1-9][0-9]*)$`, 'iu');
const HASH = /^[0-9a-f]{64}$/iu;
const SOURCE_KINDS = new Set(['CONTRACT', 'PROJECT', 'TASK', 'RUN', 'CORRECTION',
  'KNOWLEDGE', 'MEMORY', 'DECISION']);
const SOURCE_ROLES = new Set(['MANDATORY', 'RELEVANT', 'STEP_SPECIFIC']);
const SOURCE_TRUST = new Set(['CANONICAL', 'UNTRUSTED_DATA']);

export interface TraceSourceDto {
  readonly kind: string;
  readonly source_ref: string | null;
  readonly version: string | null;
  readonly sha256: string | null;
  readonly source_sha256: string | null;
  readonly role: string;
  readonly trust: string;
  readonly availability: 'AVAILABLE' | 'UNAVAILABLE';
}

export async function readRunTrace(db: DbExecutor, storage: ManagedContentStore,
  workspaceId: string, runId: string) {
  return db.transaction().setIsolationLevel('repeatable read').execute(async (snapshot) => {
    const r = createRepositories(snapshot);
    await requireWorkspace(r, workspaceId);
    const run = await r.runs.readRun(runId);
    if (run?.workspace_id !== workspaceId) throw resourceNotFound('Run');
    const task = await r.tasks.readTask(run.task_id);
    if (task?.workspace_id !== workspaceId) throw resourceNotFound('Run');
    const steps = await r.runs.listSteps(run.id);
    const attemptRows = (await Promise.all(steps.map((step) => r.runs.listAttempts(step.id)))).flat();
    const manifests = await r.runs.listContextManifests(run.id);
    const sessions = await r.verifications.listSessionsByRun(run.id);
    const reviews = await r.reviews.listByRun(run.id);
    const operations = await r.gateway.listRunOperations(run.id);
    const effects = await snapshot.selectFrom('run_effect_actions').selectAll()
      .where('run_id', '=', run.id).orderBy('created_at').orderBy('operation_id').execute();
    const calls = attemptRows.length === 0 ? [] : await snapshot.selectFrom('model_calls')
      .selectAll().where('workspace_id', '=', workspaceId)
      .where('step_attempt_id', 'in', attemptRows.map((row) => row.id))
      .orderBy('started_at').orderBy('id').execute();
    return {
      run_id: run.id, task_id: run.task_id, project_id: task.project_id,
      status: run.status, steps: steps.map((step) => ({
        id: step.id, step_index: step.step_index, kind: step.step_kind,
        status: step.status, revision: step.revision.toString(),
        result_available: step.result_ref !== null,
        started_at: step.started_at?.toISOString() ?? null,
        finished_at: step.finished_at?.toISOString() ?? null })),
      attempts: attemptRows.map((attempt) => ({
        id: attempt.id, step_id: attempt.step_id,
        attempt_number: attempt.attempt_number.toString(), status: attempt.status,
        claim_epoch: attempt.claim_epoch.toString(),
        result_available: attempt.result_ref !== null,
        started_at: attempt.started_at?.toISOString() ?? null,
        finished_at: attempt.finished_at?.toISOString() ?? null })),
      model_calls: calls.map((call) => ({ id: call.id,
        step_attempt_id: call.step_attempt_id, manifest_id: call.manifest_id,
        kind: call.kind, criterion_id: call.criterion_id, check_attempt: call.check_attempt,
        provider_error_kind: call.status === 'FAILED' && call.error_kind !== null &&
          (MODEL_ERROR_CATEGORIES as readonly string[]).includes(call.error_kind)
          ? call.error_kind : null,
        provider_request_id: call.provider_request_id,
        status: call.status, provider: call.provider, model: call.model,
        input_sha256: call.input_sha256, read_operation_id: call.read_operation_id,
        read_invocation_id: call.read_invocation_id,
        usage_input_tokens: call.usage_input_tokens,
        usage_output_tokens: call.usage_output_tokens,
        started_at: call.started_at.toISOString(),
        first_text_delta_at: call.first_text_delta_at?.toISOString() ?? null,
        first_preview_persisted_at: call.first_preview_persisted_at?.toISOString() ?? null,
        settled_at: call.settled_at?.toISOString() ?? null })),
      manifests: await Promise.all(manifests.map((manifest) => manifestDto(r, storage, run,
        task.project_id, manifest))),
      verifications: await Promise.all(sessions.map(async (session) => ({
        id: session.id, status: session.status, verdict: session.verdict,
        acceptance_revision: session.acceptance_revision.toString(),
        check_plan_hash: session.check_plan_hash.toString('hex'),
        parent_session_id: session.parent_session_id,
        targets: (await r.verifications.listTargets(session.id)).map((target) => ({
          artifact_version_id: target.artifact_version_id,
          content_sha256: target.content_hash.toString('hex') })),
        checks: (await r.verifications.listCheckResults(session.id)).map((check) => ({
          id: check.id, criterion_id: check.criterion_id, result: check.result,
          severity: check.severity, required: check.required,
          created_at: check.created_at.toISOString() })),
        created_at: session.created_at.toISOString(),
        finalized_at: session.finalized_at?.toISOString() ?? null }))),
      reviews: await Promise.all(reviews.map(async (review) => {
        const decision = await r.reviews.readDecision(review.id);
        return { id: review.id, kind: review.kind, status: review.status,
          operation_id: review.operation_id,
          verification_session_id: review.verification_session_id,
          target_hash: review.target_hash.toString('hex'),
          decision: decision === undefined ? null : { id: decision.id,
            value: decision.decision, decided_at: decision.decided_at.toISOString() },
          created_at: review.created_at.toISOString(),
          decided_at: review.decided_at?.toISOString() ?? null };
      })),
      operations: await Promise.all(operations.map(async (operation) => ({
        id: operation.id, step_id: operation.step_id,
        capability: operation.capability_key, action_type: operation.action_type,
        status: operation.status, params_sha256: operation.params_hash.toString('hex'),
        result_available: operation.result_ref !== null,
        invocations: (await r.gateway.listInvocations(operation.id)).map((invocation) => ({
          id: invocation.id, attempt_number: invocation.attempt_number.toString(),
          status: invocation.status, result_available: invocation.result_ref !== null,
          created_at: invocation.created_at.toISOString(),
          resolved_at: invocation.resolved_at?.toISOString() ?? null })),
        created_at: operation.created_at.toISOString(),
        updated_at: operation.updated_at.toISOString() }))),
      effects: effects.map((effect) => ({ id: effect.operation_id,
        step_id: effect.step_id, status: effect.status,
        params_sha256: effect.params_hash.toString('hex'),
        result_available: effect.result_ref !== null,
        created_at: effect.created_at.toISOString(),
        resolved_at: effect.resolved_at?.toISOString() ?? null })),
    };
  });
}

async function manifestDto(r: Repositories, storage: ManagedContentStore,
  run: RunRow, projectId: string | null, manifest: ContextManifestRow) {
  const sources = Array.isArray(manifest.payload.sources) ? manifest.payload.sources : [];
  return { id: manifest.id, step_id: manifest.step_id,
    builder_version: manifest.builder_version, sha256: manifest.manifest_hash.toString('hex'),
    sources: await Promise.all(sources.map((source) => sourceDto(r, storage, run,
      projectId, source))), created_at: manifest.created_at.toISOString() };
}

/** Reuse Trace's exact current-source visibility check before exposing draft text. */
export async function runManifestSourcesAvailable(r: Repositories,
  storage: ManagedContentStore, run: RunRow, projectId: string | null,
  manifest: ContextManifestRow): Promise<boolean> {
  const sources = manifest.payload.sources;
  if (!Array.isArray(sources)) return false;
  for (const source of sources) {
    if ((await sourceDto(r, storage, run, projectId, source)).availability !== 'AVAILABLE') {
      return false;
    }
  }
  return true;
}

async function sourceDto(r: Repositories, storage: ManagedContentStore,
  run: RunRow, projectId: string | null, source: unknown): Promise<TraceSourceDto> {
  const value = source && typeof source === 'object' && !Array.isArray(source)
    ? source as JsonObject : {};
  const kind = typeof value.kind === 'string' && SOURCE_KINDS.has(value.kind)
    ? value.kind : 'UNKNOWN';
  const sourceRef = typeof value.source_ref === 'string' ? value.source_ref : '';
  const version = typeof value.version === 'string' && value.version.length <= 64 &&
    /^[0-9a-f]+$/iu.test(value.version) ? value.version : null;
  const sha256 = typeof value.sha256 === 'string' && HASH.test(value.sha256) ? value.sha256 : null;
  const sourceSha = typeof value.source_sha256 === 'string' && HASH.test(value.source_sha256)
    ? value.source_sha256 : null;
  const role = typeof value.role === 'string' && SOURCE_ROLES.has(value.role)
    ? value.role : 'UNKNOWN';
  const trust = typeof value.trust === 'string' && SOURCE_TRUST.has(value.trust)
    ? value.trust : 'UNKNOWN';
  const match = INFO_SOURCE.exec(sourceRef);
  if (match !== null) {
    const sourceKind = match[1]!.toLowerCase() as 'knowledge' | 'memory' | 'decision';
    const rootId = match[2]!;
    const versionNumber = BigInt(match[3]!);
    const root = await r.information.readRoot<InformationRootRow>(sourceKind, rootId);
    if (root?.workspace_id !== run.workspace_id || root.project_id !== null &&
        root.project_id !== projectId || root.status !== 'ACTIVE') return unavailable(kind, role, trust);
    const exact = await r.information.readVersion<KnowledgeVersionRow | MemoryVersionRow |
      DecisionVersionRow>(sourceKind, rootId, versionNumber);
    if (exact === undefined) return unavailable(kind, role, trust);
    if (sourceKind === 'knowledge') {
      const knowledge = exact as KnowledgeVersionRow;
      if (knowledge.availability !== 'AVAILABLE' || sourceSha !== knowledge.content_sha256.toString('hex')) {
        return unavailable(kind, role, trust);
      }
      if (knowledge.source_kind === 'ARTIFACT_VERSION') {
        const artifact = knowledge.artifact_version_id === null ? undefined :
          await r.artifacts.readArtifactVersion(knowledge.artifact_version_id);
        const owner = artifact === undefined ? undefined : await r.artifacts.readArtifact(artifact.artifact_id);
        if (artifact === undefined || owner?.workspace_id !== run.workspace_id ||
            artifact.content_hash.toString('hex') !== sourceSha) return unavailable(kind, role, trust);
        const read = await storage.readWithHashCheck(artifact.storage_ref,
          { contentHash: artifact.content_hash, size: artifact.size });
        if (read.status !== 'OK') return unavailable(kind, role, trust);
      } else if (knowledge.content_text === null ||
          createHash('sha256').update(knowledge.content_text).digest('hex') !== sourceSha) {
        return unavailable(kind, role, trust);
      }
    } else if (sourceKind === 'memory') {
      const memory = exact as MemoryVersionRow;
      if (memory.expires_at !== null && memory.expires_at.getTime() <= Date.now() ||
          sourceSha !== createHash('sha256').update(memory.body_text).digest('hex')) {
        return unavailable(kind, role, trust);
      }
    } else {
      const decision = exact as DecisionVersionRow;
      if (sourceSha !== createHash('sha256').update(`${decision.choice}\n${decision.rationale}`)
        .digest('hex')) return unavailable(kind, role, trust);
    }
    return { kind, source_ref: sourceRef, version, sha256, source_sha256: sourceSha,
      role, trust, availability: 'AVAILABLE' };
  }
  const mandatory = sourceRef === `run:${run.id}:contract` || sourceRef === `run:${run.id}` ||
    sourceRef === `task:${run.task_id}` || projectId !== null && sourceRef === `project:${projectId}` ||
    new RegExp(`^run:${run.id}:correction:[1-9][0-9]*$`, 'iu').test(sourceRef);
  return mandatory ? { kind, source_ref: sourceRef, version, sha256, source_sha256: sourceSha,
    role, trust, availability: 'AVAILABLE' } : unavailable(kind, role, trust);
}

function unavailable(kind: string, role: string, trust: string): TraceSourceDto {
  return { kind, source_ref: null, version: null, sha256: null, source_sha256: null,
    role, trust, availability: 'UNAVAILABLE' };
}
