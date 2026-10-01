import { createHash } from 'node:crypto';

import type { DbExecutor } from '../infrastructure/database.js';
import type { RunStatus } from '../infrastructure/database-schema.js';
import type { JsonObject } from '../infrastructure/json.js';
import { ModelCallRepository } from '../model/model-call-repository.js';
import { canonicalizeJson } from '../receipt/payload-hash.js';
import { toDecimalString } from '../shared/decimal.js';
import type { ManagedContentStore } from '../storage/managed-content-store.js';
import { CANDIDATE_OUTPUT_SCHEMA } from '../workflow/markdown-deliverable.js';
import { contextManifestMatchesCurrent } from './context-fence.js';
import { resourceNotFound } from './domain-error.js';
import { lockTaskAndRun } from './lock-task-run.js';
import { attachReadEvidenceWithinBudget, draftInputHash,
  loadRunReadEvidence } from './run-read-evidence.js';
import { runManifestSourcesAvailable } from './trace-queries.js';
import { createRepositories, type Repositories } from './unit-of-work.js';

export interface RunDraftPreviewDto {
  readonly run_id: string;
  readonly run_status: RunStatus;
  readonly step_attempt_id: string | null;
  readonly attempt_claim_epoch: string | null;
  readonly model_call_id: string | null;
  readonly preview_revision: string;
  readonly preview_text: string | null;
  readonly preview_truncated: boolean;
  readonly preview_available: boolean;
}

interface RunDraftPreviewOwner {
  readonly workspaceId: string; readonly runId: string; readonly stepId: string;
  readonly attemptId: string; readonly attemptClaimEpoch: bigint;
  readonly runWorkerEpoch: bigint; readonly workerId: string;
  readonly invocationEpoch?: bigint | undefined;
  readonly modelCallId: string; readonly manifestId: string;
  readonly inputHash: string;
}

async function lockCurrentDraftOwner(transaction: DbExecutor, input: RunDraftPreviewOwner) {
  const r = createRepositories(transaction);
  const { task, run } = await lockTaskAndRun(r, input.runId, input.workspaceId);
  if (run.status !== 'RUNNING' || run.current_step_id !== input.stepId ||
      run.worker_id !== input.workerId || run.worker_epoch !== input.runWorkerEpoch ||
      run.worker_lease_until === null || run.worker_lease_until.getTime() <= Date.now() ||
      task.executor_run_id !== run.id || task.ownership_epoch !== run.ownership_epoch ||
      await r.recovery.findPendingControl(run.id)) return undefined;
  if (input.invocationEpoch !== undefined &&
      !(await r.dispatch.hasCurrentInvocation(run.id, input.workerId,
        input.invocationEpoch))) return undefined;
  const step = await r.runs.readStep(input.stepId);
  const attempt = await r.runs.readAttempt(input.attemptId);
  if (step?.run_id !== run.id || step.step_kind !== 'DRAFT' ||
      step.status !== 'RUNNING' || attempt?.step_id !== step.id ||
      attempt.status !== 'RUNNING' || attempt.worker_id !== input.workerId ||
      attempt.claim_epoch !== input.attemptClaimEpoch ||
      attempt.lease_until === null || attempt.lease_until.getTime() <= Date.now()) return undefined;
  const calls = new ModelCallRepository(transaction);
  const call = await calls.read(input.modelCallId, 'update');
  if (call?.workspace_id !== input.workspaceId || call.kind !== 'DRAFT' ||
      call.step_attempt_id !== attempt.id || call.manifest_id !== input.manifestId ||
      call.input_sha256 !== input.inputHash || call.status !== 'STARTED') return undefined;
  return { r, run, attempt, call, calls };
}

export async function recordRunDraftFirstTextDelta(db: DbExecutor,
  input: RunDraftPreviewOwner & { readonly observedAt: Date }): Promise<boolean> {
  return db.transaction().execute(async (transaction) => {
    const owner = await lockCurrentDraftOwner(transaction, input);
    if (owner === undefined) return false;
    await owner.calls.recordFirstTextDelta(owner.call.id, input.observedAt);
    return true;
  });
}

/** One short transaction per throttled prefix. The Run claim is the serializing point. */
export async function publishRunDraftPreview(db: DbExecutor,
  input: RunDraftPreviewOwner & { readonly text: string;
    readonly truncated: boolean }): Promise<boolean> {
  return db.transaction().execute(async (transaction) => {
    const owner = await lockCurrentDraftOwner(transaction, input);
    if (owner === undefined) return false;
    const { r, run, attempt, call, calls } = owner;
    await r.runs.writeDraftPreview({ runId: run.id, attemptId: attempt.id,
      attemptClaimEpoch: attempt.claim_epoch, runWorkerEpoch: run.worker_epoch,
      workerId: input.workerId, invocationEpoch: input.invocationEpoch ?? null,
      modelCallId: call.id, text: input.text, truncated: input.truncated });
    if (input.text !== '') await calls.recordFirstPreviewPersisted(call.id);
    return true;
  });
}

/** Reauthorize every poll; a preview never inherits permission from the stream connection. */
export async function readRunDraftPreview(db: DbExecutor, storage: ManagedContentStore,
  workspaceId: string, runId: string): Promise<RunDraftPreviewDto> {
  return db.transaction().execute(async (transaction) => {
    const r = createRepositories(transaction);
    const authority = await r.workspaces.lockAuthority(workspaceId, 'share');
    if (authority === undefined) throw resourceNotFound('Workspace');
    const located = await r.runs.readRun(runId);
    if (located?.workspace_id !== workspaceId) throw resourceNotFound('Run');
    const task = await r.tasks.readTaskForShare(located.task_id);
    const run = await r.runs.readRunForShare(runId);
    if (task?.workspace_id !== workspaceId || run?.workspace_id !== workspaceId ||
        run.task_id !== task.id) throw resourceNotFound('Run');
    const empty: RunDraftPreviewDto = { run_id: run.id, run_status: run.status,
      step_attempt_id: null, attempt_claim_epoch: null, model_call_id: null,
      preview_revision: '0', preview_text: null, preview_truncated: false,
      preview_available: false };
    if (run.status !== 'RUNNING' || run.worker_id === null ||
        run.worker_lease_until === null || run.worker_lease_until.getTime() <= Date.now() ||
        task.executor_run_id !== run.id || task.ownership_epoch !== run.ownership_epoch ||
        await r.recovery.findPendingControl(run.id)) return empty;
    const step = await r.runs.readStepByKind(run.id, 'DRAFT');
    if (step?.status !== 'RUNNING' || run.current_step_id !== step.id) return empty;
    const latest = (await r.runs.listAttempts(step.id)).at(-1);
    if (latest === undefined) return empty;
    const attempt = await r.runs.readAttemptForShare(latest.id);
    if (attempt?.status !== 'RUNNING' || attempt.worker_id !== run.worker_id ||
        attempt.lease_until === null || attempt.lease_until.getTime() <= Date.now()) return empty;
    const built = await r.runs.readStepByKind(run.id, 'BUILD_CONTEXT');
    const manifestHash = readString(built?.result_ref, 'manifest_hash');
    if (built?.status !== 'SUCCEEDED' || manifestHash === undefined ||
        !/^[0-9a-f]{64}$/u.test(manifestHash)) return empty;
    const manifest = await r.runs.readContextManifestByHash(run.id,
      Buffer.from(manifestHash, 'hex'));
    if (manifest === undefined ||
        createHash('sha256').update(canonicalizeJson(manifest.payload)).digest('hex') !==
          manifestHash ||
        !(await contextManifestMatchesCurrent(r, manifest.payload, run, task, authority)) ||
        !(await runManifestSourcesAvailable(r, storage, run, task.project_id, manifest))) {
      return empty;
    }
    let read;
    let modelInput: JsonObject = manifest.payload;
    try {
      read = await loadRunReadEvidence(r, run.id);
      if (read !== undefined) {
        if (!(await toolReadCurrentlyVisible(r, workspaceId, task.project_id,
          read.operationId))) return empty;
        modelInput = attachReadEvidenceWithinBudget(manifest.payload, read);
      }
    } catch { return empty; }
    const current: RunDraftPreviewDto = { ...empty,
      step_attempt_id: attempt.id,
      attempt_claim_epoch: toDecimalString(attempt.claim_epoch),
      preview_available: true };
    const preview = await r.runs.readDraftPreview(run.id);
    if (preview === undefined || preview.step_attempt_id !== attempt.id ||
        preview.attempt_claim_epoch !== attempt.claim_epoch ||
        preview.run_worker_epoch !== run.worker_epoch ||
        preview.worker_id !== run.worker_id) return current;
    if (preview.invocation_epoch !== null &&
        !(await r.dispatch.hasCurrentInvocation(run.id, run.worker_id,
          preview.invocation_epoch))) return empty;
    const call = await new ModelCallRepository(transaction).read(preview.model_call_id, true);
    if (call?.workspace_id !== workspaceId || call.kind !== 'DRAFT' ||
        call.step_attempt_id !== attempt.id || call.manifest_id !== manifest.id ||
        call.input_sha256 !== draftInputHash(modelInput, CANDIDATE_OUTPUT_SCHEMA) ||
        (call.status !== 'STARTED' && call.status !== 'COMPLETED') ||
        call.read_operation_id !== (read?.operationId ?? null) ||
        call.read_invocation_id !== (read?.invocationId ?? null)) return empty;
    return { ...current, model_call_id: call.id,
      preview_revision: toDecimalString(preview.revision),
      preview_text: preview.preview_text,
      preview_truncated: preview.truncated };
  });
}

async function toolReadCurrentlyVisible(r: Repositories, workspaceId: string,
  projectId: string | null, operationId: string): Promise<boolean> {
  if (projectId === null) return false;
  const operation = await r.gateway.readOperation(operationId);
  if (operation?.workspace_id !== workspaceId || operation.project_id !== projectId ||
      operation.status !== 'SUCCEEDED') return false;
  const connection = await r.gateway.readConnection(operation.connection_id);
  const policy = await r.gateway.readPolicy(operation.policy_id);
  if (connection?.workspace_id !== workspaceId || connection.project_id !== projectId ||
      connection.status !== 'ACTIVE' || connection.version !== operation.connection_version ||
      policy?.workspace_id !== workspaceId || policy.project_id !== projectId ||
      policy.status !== 'ACTIVE' || policy.active_version !== operation.policy_version ||
      !(await r.gateway.hasConnectionCapability(connection.id, operation.capability_key))) {
    return false;
  }
  if (operation.resource_id !== null) {
    const resource = await r.gateway.readResource(operation.resource_id);
    if (resource?.workspace_id !== workspaceId || resource.project_id !== projectId ||
        resource.status !== 'ACTIVE') return false;
  }
  return true;
}

function readString(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const field = (value as JsonObject)[key];
  return typeof field === 'string' ? field : undefined;
}
