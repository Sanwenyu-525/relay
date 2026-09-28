import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';

import type { DbExecutor } from '../infrastructure/database.js';
import type { ChangeSetFileRow, ChangeSetRow, FileWritePathIdentityRow,
  InvocationAttemptRow, LogicalOperationRow } from '../infrastructure/database-schema.js';
import type { JsonObject } from '../infrastructure/json.js';
import { canonicalRelativePath, computeSha256, reconcileFileChangeset,
  type FileChange } from '../files/file-changeset.js';
import { canonicalizeJson } from '../receipt/payload-hash.js';
import { inspectWindowsFileResiduals, reconcileWindowsFileChangeset,
  type WindowsFileIdentityPart, type WindowsFilePathEvidence,
  type WindowsFileResidualCandidate } from '../files/windows-file-io.js';
import { LOCAL_ACTOR_REF, httpCommandScopeKey } from './actor.js';
import { runIdempotentCommand, type CommandOutcome } from './command.js';
import { invalidTransition, resourceNotFound, revisionConflict } from './domain-error.js';
import { lockTaskAndRun } from './lock-task-run.js';
import { createRepositories, type Repositories } from './unit-of-work.js';

type Decision = 'KEEP_CURRENT_AND_FAIL_RUN';
interface CurrentFile {
  readonly relative_path: string;
  readonly ledger_status: string;
  readonly ledger_actual_sha256: string | null;
  readonly current_sha256: string | null;
  readonly readable: boolean;
  readonly current_target_id?: string | null;
  readonly parent_chain?: readonly WindowsFileIdentityPart[];
  readonly residual_candidates?: readonly WindowsFileResidualCandidate[];
}
interface Observation {
  readonly sha256: string | null;
  readonly files: readonly CurrentFile[];
  readonly safe: boolean;
  readonly mode?: 'PARTIAL_LEDGER' | 'NO_RECEIPT';
}

export interface FileWriteDispositionPreview {
  readonly operation_id: string;
  readonly invocation_id: string | null;
  readonly change_set_id: string | null;
  readonly run_id: string;
  readonly run_revision: string;
  readonly task_revision: string;
  readonly operation_status: string;
  readonly stop_proof_recorded: boolean;
  readonly can_dispose: boolean;
  readonly blocking_reasons: readonly string[];
  readonly observation_sha256: string | null;
  readonly observation_mode: 'PARTIAL_LEDGER' | 'NO_RECEIPT' | null;
  readonly files: readonly CurrentFile[];
  readonly disposition: {
    readonly id: string; readonly decision: Decision; readonly created_at: string;
    readonly observation_sha256: string; readonly observation: JsonObject;
  } | null;
}

function expectedRoot(operation: LogicalOperationRow, frozenRoot?: string): string {
  if (frozenRoot !== undefined) return frozenRoot;
  return operation.action_type === 'APPLY_CHANGESET'
    ? operation.normalized_target : dirname(operation.normalized_target);
}

function hasNoFileWriteReceipt(invocation: InvocationAttemptRow): boolean {
  return !Object.prototype.hasOwnProperty.call(invocation.result_ref ?? {}, 'file_write_receipt');
}

function unattributedFileFacts(files: readonly CurrentFile[]): JsonObject[] {
  return files.map<JsonObject>((file) => ({ path: file.relative_path,
    ledger_status: file.ledger_status, current_sha256: file.current_sha256,
    current_target_id: file.current_target_id ?? null,
    parent_chain: (file.parent_chain ?? []).map<JsonObject>((part) => ({ path: part.path, id: part.id })),
    residual_candidates: (file.residual_candidates ?? []).map<JsonObject>((candidate) => ({
      path: candidate.path, id: candidate.id, sha256: candidate.sha256,
      status: candidate.status, error: candidate.error })) }));
}

async function observeWithoutReceipt(ledger: ChangeSetRow,
  files: readonly ChangeSetFileRow[], pathEvidence: FileWritePathIdentityRow,
  invocation: InvocationAttemptRow): Promise<Observation> {
  const captures = pathEvidence.captures as unknown as WindowsFilePathEvidence['captures'];
  if (!Array.isArray(captures) || captures.length !== files.length) {
    return { safe: false, sha256: null, files: [], mode: 'NO_RECEIPT' };
  }
  const byPath = new Map(captures.map((capture) => [capture.path, capture]));
  if (byPath.size !== captures.length) {
    return { safe: false, sha256: null, files: [], mode: 'NO_RECEIPT' };
  }
  try {
    const requested = files.map((file) => {
      const capture = byPath.get(file.relative_path);
      if (capture?.action !== file.action || !Array.isArray(capture.parent_chain)) {
        throw new Error('Frozen path identity is incomplete');
      }
      return { path: file.relative_path, parent_chain: capture.parent_chain,
        target_id: capture.target_id, sha256: capture.sha256 };
    });
    const observed = await inspectWindowsFileResiduals({ root_path: pathEvidence.root_path,
      root_id: pathEvidence.root_id, captures }, requested, AbortSignal.timeout(10_000));
    const current: CurrentFile[] = observed.files.map((item, index) => {
      const ledgerFile = files[index]!;
      const candidates = [...item.candidates].sort((a, b) =>
        a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
      return { relative_path: ledgerFile.relative_path, ledger_status: ledgerFile.status,
        ledger_actual_sha256: ledgerFile.actual_sha256,
        current_sha256: item.target.sha256, current_target_id: item.target.id,
        parent_chain: item.parent_chain, residual_candidates: candidates,
        readable: item.target.status === 'READABLE' || item.target.status === 'MISSING' };
    });
    const safe = observed.complete && current.every((file) => file.readable &&
      file.residual_candidates?.every((candidate) => candidate.status === 'READABLE') === true);
    if (!safe) return { safe: false, sha256: null, files: current, mode: 'NO_RECEIPT' };
    const facts: JsonObject = { change_set_id: ledger.id, invocation_id: invocation.id,
      canonical_root: ledger.canonical_root, root_id: pathEvidence.root_id,
      observation_mode: 'NO_RECEIPT',
      files: unattributedFileFacts(current) };
    return { safe: true, sha256: computeSha256(canonicalizeJson(facts)),
      files: current, mode: 'NO_RECEIPT' };
  } catch {
    return { safe: false, sha256: null, files: [], mode: 'NO_RECEIPT' };
  }
}

/** Read only; every affected path is checked against the frozen root before a hash is offered. */
async function observe(ledger: ChangeSetRow, files: readonly ChangeSetFileRow[],
  pathEvidence?: FileWritePathIdentityRow, invocation?: InvocationAttemptRow): Promise<Observation> {
  if (files.length === 0 || files.length !== ledger.file_count) {
    return { safe: false, sha256: null, files: [] };
  }
  try {
    for (const file of files) {
      if (canonicalRelativePath(ledger.canonical_root, file.relative_path) !== file.relative_path) {
        return { safe: false, sha256: null, files: [] };
      }
    }
  } catch {
    return { safe: false, sha256: null, files: [] };
  }
  if (process.platform === 'win32' && ledger.status === 'UNKNOWN' &&
      pathEvidence?.root_path === ledger.canonical_root && invocation !== undefined &&
      hasNoFileWriteReceipt(invocation)) {
    return observeWithoutReceipt(ledger, files, pathEvidence, invocation);
  }
  const changes: FileChange[] = files.map((file) => ({
    path: file.relative_path, action: file.action,
    baselineSha256: file.baseline_sha256,
    ...(file.target_sha256 === null ? {} : { targetSha256: file.target_sha256 }),
  }));
  // A current file may have been replaced by arbitrary external content. Keep
  // preview and decision reads bounded even when the frozen write was tiny.
  let checks: readonly { readonly actualSha: string | null; readonly readError?: string }[];
  if (process.platform === 'win32') {
    if (pathEvidence?.root_path !== ledger.canonical_root || invocation === undefined) {
      return { safe: false, sha256: null, files: [] };
    }
    const receipt = invocation.result_ref?.file_write_receipt;
    const result = typeof receipt === 'object' && receipt !== null && !Array.isArray(receipt)
      ? (receipt as JsonObject).result : undefined;
    const physical = typeof result === 'object' && result !== null && !Array.isArray(result)
      ? (result as JsonObject).physical_files : undefined;
    if (!Array.isArray(physical) || physical.length !== files.length) {
      return { safe: false, sha256: null, files: [] };
    }
    const byPath = new Map(physical.map((item) => {
      const entry = typeof item === 'object' && item !== null && !Array.isArray(item)
        ? item as JsonObject : undefined;
      return [entry?.path, entry] as const;
    }));
    try {
      const requested = files.map((file) => {
        const entry = byPath.get(file.relative_path);
        if (entry === undefined || !Array.isArray(entry.parent_chain) ||
            (entry.target_id !== null && typeof entry.target_id !== 'string') ||
            (entry.actual_sha256 !== null && typeof entry.actual_sha256 !== 'string')) {
          throw new Error('Physical file receipt cannot be used for disposition');
        }
        return { path: file.relative_path,
          parent_chain: entry.parent_chain as unknown as readonly WindowsFileIdentityPart[],
          target_id: entry.target_id,
          expected_sha256: entry.actual_sha256 };
      });
      const result = await reconcileWindowsFileChangeset({
        root_path: pathEvidence.root_path, root_id: pathEvidence.root_id,
        captures: pathEvidence.captures as unknown as WindowsFilePathEvidence['captures'],
      }, requested, AbortSignal.timeout(10_000));
      checks = result.map((item) => ({ actualSha: item.sha256,
        ...(item.error === undefined ? {} : { readError: item.error }) }));
    } catch {
      return { safe: false, sha256: null, files: [] };
    }
  } else {
    const observed = await reconcileFileChangeset(ledger.canonical_root, changes,
      { maxFileBytes: 1024 * 1024, signal: AbortSignal.timeout(10_000) });
    checks = observed.checks;
  }
  const current = files.map((file, index) => ({
    relative_path: file.relative_path,
    ledger_status: file.status,
    ledger_actual_sha256: file.actual_sha256,
    current_sha256: checks[index]?.actualSha ?? null,
    readable: checks[index]?.readError === undefined,
  }));
  const safe = checks.length === files.length && current.every((file) => file.readable);
  if (!safe) return { safe, sha256: null, files: current };
  const facts: JsonObject = { change_set_id: ledger.id, invocation_id: ledger.invocation_id,
    canonical_root: ledger.canonical_root,
    files: current.map((file) => ({ path: file.relative_path,
      current_sha256: file.current_sha256 })) };
  return { safe, sha256: computeSha256(canonicalizeJson(facts)),
    files: current, mode: 'PARTIAL_LEDGER' };
}

async function dispositionContext(repositories: Repositories, workspaceId: string, operationId: string) {
  const operation = await repositories.gateway.readOperation(operationId);
  if (operation?.workspace_id !== workspaceId || operation.origin !== 'RUN' ||
      operation.capability_key !== 'FILE_WRITE' || operation.run_id === null) {
    throw resourceNotFound('File write operation');
  }
  const run = await repositories.runs.readRun(operation.run_id);
  const task = run === undefined ? undefined : await repositories.tasks.readTask(run.task_id);
  if (run === undefined || task === undefined || task.workspace_id !== workspaceId) {
    throw resourceNotFound('Run');
  }
  const invocation = await repositories.gateway.lastInvocation(operation.id);
  const ledger = invocation === undefined ? undefined :
    await repositories.changeSets.readLedgerByInvocation(invocation.id);
  const proof = invocation === undefined ? undefined :
    await repositories.fileWriteStopProofs.readByInvocation(invocation.id);
  const disposition = invocation === undefined ? undefined :
    await repositories.fileWriteDispositions.readByInvocation(invocation.id);
  const pathEvidence = await repositories.fileWritePaths.readByOperation(operation.id);
  return { operation, run, task, invocation, ledger, proof, disposition, pathEvidence };
}

export async function readFileWriteDispositionPreview(db: DbExecutor, workspaceId: string,
  operationId: string): Promise<FileWriteDispositionPreview> {
  const repositories = createRepositories(db);
  const context = await dispositionContext(repositories, workspaceId, operationId);
  const { operation, run, task, invocation, ledger, proof, disposition, pathEvidence } = context;
  const current = ledger === undefined ? { safe: false, sha256: null, files: [] } as Observation
    : disposition === undefined ? await observe(ledger.changeSet, ledger.files,
      pathEvidence, invocation)
      : { safe: false, sha256: null, files: [] } as Observation;
  const reasons: string[] = [];
  if (disposition === undefined) {
    const [claim, resource, delivery, outbox, unresolved, effects, steps] = await Promise.all([
      invocation?.resource_claim_id === null || invocation === undefined ? undefined
        : repositories.gateway.readClaim(invocation.resource_claim_id),
      operation.resource_id === null ? undefined : repositories.gateway.readResource(operation.resource_id),
      repositories.dispatch.readInvocation(run.id),
      proof === undefined ? undefined : repositories.dispatch.readOutbox(proof.command_id),
      repositories.gateway.listUnresolvedRunOperations(run.id),
      repositories.recovery.listUnresolvedEffects(run.id),
      repositories.runs.listSteps(run.id),
    ]);
    if (operation.status !== 'UNKNOWN' || invocation?.status !== 'UNKNOWN') reasons.push('ACTION_NOT_UNKNOWN');
    if (ledger === undefined ||
        !((ledger.changeSet.status === 'PARTIAL' && current.mode === 'PARTIAL_LEDGER') ||
          (ledger.changeSet.status === 'UNKNOWN' && current.mode === 'NO_RECEIPT')) ||
        ledger.changeSet.canonical_root !== expectedRoot(operation, pathEvidence?.root_path)) {
      reasons.push('PARTIAL_LEDGER_REQUIRED');
    }
    if (proof === undefined) reasons.push('TRUSTED_STOP_PROOF_REQUIRED');
    else if (proof.operation_id !== operation.id || proof.run_id !== run.id ||
        proof.worker_id !== invocation?.worker_id || proof.worker_epoch !== invocation.worker_epoch ||
        run.worker_epoch !== proof.worker_epoch + 1n ||
        delivery?.worker_id !== proof.worker_id || delivery.epoch !== proof.dispatch_epoch ||
        delivery.command_id !== proof.command_id || !['ACTIVE', 'STOP_REQUIRED'].includes(delivery.status) ||
        outbox?.worker_id !== proof.worker_id || outbox.claim_epoch !== proof.dispatch_epoch ||
        !['CLAIMED', 'BLOCKED'].includes(outbox.status)) {
      reasons.push('TRUSTED_STOP_PROOF_MISMATCH');
    }
    if (resource?.status !== 'ACTIVE' || claim?.status !== 'QUARANTINED' ||
        claim.run_id !== run.id || claim.resource_id !== resource.id) {
      reasons.push('RESOURCE_NOT_QUARANTINED');
    }
    if (unresolved.length !== 1 || unresolved[0]?.id !== operation.id || effects.length > 0) {
      reasons.push('OTHER_UNRESOLVED_ACTIONS');
    }
    if (steps.some((step) => step.status === 'RUNNING') ||
        (await Promise.all(steps.map((step) => repositories.runs.listAttempts(step.id))))
          .some((attempts) => attempts.some((attempt) => attempt.status === 'RUNNING'))) {
      reasons.push('RUN_STEP_ACTIVE');
    }
    if (!current.safe) reasons.push('CURRENT_FILES_UNREADABLE');
    if (run.status !== 'RUNNING' || run.worker_id !== null || task.executor_run_id !== run.id ||
        task.ownership_epoch !== run.ownership_epoch) {
      reasons.push('RUN_NOT_READY');
    }
  }
  return {
    operation_id: operation.id, invocation_id: invocation?.id ?? null,
    change_set_id: ledger?.changeSet.id ?? null, run_id: run.id,
    run_revision: run.revision.toString(), task_revision: task.revision.toString(),
    operation_status: operation.status, stop_proof_recorded: proof !== undefined,
    can_dispose: disposition === undefined && reasons.length === 0,
    blocking_reasons: reasons, observation_sha256: current.sha256,
    observation_mode: current.mode ?? null, files: current.files,
    disposition: disposition === undefined ? null : {
      id: disposition.id, decision: disposition.decision,
      created_at: disposition.created_at.toISOString(),
      observation_sha256: disposition.observation_sha256,
      observation: disposition.observation,
    },
  };
}

export interface ClosePartialFileWriteResult extends JsonObject {
  readonly operation_id: string; readonly invocation_id: string;
  readonly disposition_id: string; readonly decision: Decision;
  readonly run_id: string; readonly run_status: 'FAILED';
  readonly task_id: string; readonly task_status: 'READY';
  readonly observation_sha256: string;
}

/** Explicitly keep the observed bytes, fail the old Run, and end its original delivery. */
export async function closePartialFileWriteCommand(db: DbExecutor, input: {
  readonly workspaceId: string; readonly operationId: string; readonly invocationId: string;
  readonly commandId: string; readonly decision: Decision;
  readonly expectedRunRevision: string; readonly expectedTaskRevision: string;
  readonly expectedObservationSha256: string;
}): Promise<CommandOutcome<ClosePartialFileWriteResult>> {
  const scopeKey = httpCommandScopeKey(input.workspaceId);
  const existingReceipt = await createRepositories(db).receipts.findReceipt({
    scopeKey, commandId: input.commandId,
  });
  // Read the filesystem before opening the business transaction. The quarantined
  // claim excludes Relay writers; a later external edit remains an explicit limit.
  const source = existingReceipt === undefined
    ? await dispositionContext(createRepositories(db), input.workspaceId, input.operationId)
    : undefined;
  const current = source?.ledger === undefined
    ? { safe: false, sha256: null, files: [] } as Observation
    : await observe(source.ledger.changeSet, source.ledger.files,
      source.pathEvidence, source.invocation);
  return runIdempotentCommand(db, {
    scopeKey, commandId: input.commandId,
    commandType: 'ClosePartialFileWrite', target: input.operationId,
    body: { invocation_id: input.invocationId, decision: input.decision,
      expected_run_revision: input.expectedRunRevision,
      expected_task_revision: input.expectedTaskRevision,
      expected_observation_sha256: input.expectedObservationSha256 },
    execute: async (repositories) => {
      const located = await repositories.gateway.readOperation(input.operationId);
      if (located?.workspace_id !== input.workspaceId || located.run_id === null ||
          located.capability_key !== 'FILE_WRITE' || located.origin !== 'RUN') {
        throw resourceNotFound('File write operation');
      }
      const { task, run } = await lockTaskAndRun(repositories, located.run_id, input.workspaceId);
      if (run.revision.toString() !== input.expectedRunRevision) {
        throw revisionConflict({ entityType: 'Run', expectedRevision: input.expectedRunRevision,
          actualRevision: run.revision.toString() });
      }
      if (task.revision.toString() !== input.expectedTaskRevision) {
        throw revisionConflict({ entityType: 'Task', expectedRevision: input.expectedTaskRevision,
          actualRevision: task.revision.toString() });
      }
      if (run.status !== 'RUNNING' || run.worker_id !== null ||
          task.executor_run_id !== run.id || task.ownership_epoch !== run.ownership_epoch) {
        throw invalidTransition('旧 Run 尚未处于可人工处置的安全点。');
      }
      const resource = located.resource_id === null ? undefined :
        await repositories.gateway.lockResource(located.resource_id);
      const operation = await repositories.gateway.lockOperation(located.id);
      const invocation = await repositories.gateway.lockInvocation(input.invocationId);
      if (resource?.status !== 'ACTIVE' || operation?.status !== 'UNKNOWN' ||
          invocation?.operation_id !== operation.id || invocation.status !== 'UNKNOWN' ||
          invocation.run_id !== run.id || invocation.resource_id !== resource.id) {
        throw invalidTransition('原 FILE_WRITE 动作、调用或受管资源已变化。');
      }
      const ledger = await repositories.changeSets.readLedgerByInvocation(invocation.id);
      const pathEvidence = await repositories.fileWritePaths.readByOperation(operation.id);
      if (ledger === undefined ||
          !((ledger.changeSet.status === 'PARTIAL' && current.mode === 'PARTIAL_LEDGER') ||
            (ledger.changeSet.status === 'UNKNOWN' && current.mode === 'NO_RECEIPT' &&
              pathEvidence !== undefined && hasNoFileWriteReceipt(invocation))) ||
          ledger.changeSet.operation_id !== operation.id || ledger.changeSet.run_id !== run.id ||
          ledger.changeSet.resource_id !== resource.id ||
          ledger.changeSet.canonical_root !== expectedRoot(operation, pathEvidence?.root_path)) {
        throw invalidTransition('需要原调用的 PARTIAL 或缺回执 UNKNOWN 逐文件账本。');
      }
      if (source?.ledger?.changeSet.id !== ledger.changeSet.id ||
          source.ledger.changeSet.file_count !== ledger.changeSet.file_count ||
          source.ledger.files.length !== ledger.files.length ||
          source.ledger.files.some((file, index) =>
            file.relative_path !== ledger.files[index]?.relative_path ||
            file.status !== ledger.files[index]?.status ||
            file.target_sha256 !== ledger.files[index]?.target_sha256)) {
        throw invalidTransition('逐文件账本在观察后发生变化，请刷新后重新决定。');
      }
      const proof = await repositories.fileWriteStopProofs.readByInvocation(invocation.id);
      const delivery = await repositories.dispatch.lockInvocation(run.id);
      const outbox = proof === undefined ? undefined : await repositories.dispatch.lockOutbox(proof.command_id);
      if (proof?.operation_id !== operation.id || proof.run_id !== run.id ||
          proof.worker_id !== invocation.worker_id || proof.worker_epoch !== invocation.worker_epoch ||
          run.worker_epoch !== proof.worker_epoch + 1n ||
          delivery?.worker_id !== proof.worker_id || delivery.epoch !== proof.dispatch_epoch ||
          delivery.command_id !== proof.command_id || !['ACTIVE', 'STOP_REQUIRED'].includes(delivery.status) ||
          outbox?.worker_id !== proof.worker_id || outbox.claim_epoch !== proof.dispatch_epoch ||
          !['CLAIMED', 'BLOCKED'].includes(outbox.status)) {
        throw invalidTransition('缺少与原调用及旧投递匹配的可信桌面 Job 停机证明。');
      }
      const claim = invocation.resource_claim_id === null ? undefined :
        await repositories.gateway.readClaim(invocation.resource_claim_id);
      if (claim?.status !== 'QUARANTINED' || claim.run_id !== run.id ||
          claim.worker_id !== proof.worker_id || claim.worker_epoch !== proof.worker_epoch) {
        throw invalidTransition('原资源隔离事实已变化。');
      }
      const unresolved = await repositories.gateway.listUnresolvedRunOperations(run.id);
      if (unresolved.length !== 1 || unresolved[0]?.id !== operation.id ||
          (await repositories.recovery.listUnresolvedEffects(run.id)).length > 0) {
        throw invalidTransition('Run 还有其他未决动作，不能仅处置这次文件写入。');
      }
      for (const step of await repositories.runs.listSteps(run.id)) {
        if (step.status === 'RUNNING' || (await repositories.runs.listAttempts(step.id))
          .some((attempt) => attempt.status === 'RUNNING')) {
          throw invalidTransition('Run 仍有运行中的步骤或 Attempt。');
        }
      }
      if (!current.safe || current.sha256 === null) {
        throw invalidTransition('当前文件无法安全回读，资源继续隔离。');
      }
      if (current.sha256 !== input.expectedObservationSha256) {
        throw invalidTransition('当前文件已变化，请刷新逐文件事实后重新决定。');
      }
      const observation: JsonObject = { canonical_root: ledger.changeSet.canonical_root,
        observation_mode: current.mode ?? null,
        files: current.mode === 'NO_RECEIPT' ? unattributedFileFacts(current.files)
          : current.files.map<JsonObject>((file) => ({ path: file.relative_path,
            current_sha256: file.current_sha256, ledger_status: file.ledger_status,
            ledger_actual_sha256: file.ledger_actual_sha256 })) };
      const decision = await repositories.fileWriteDispositions.insert({
        id: randomUUID(), invocation_id: invocation.id, operation_id: operation.id,
        change_set_id: ledger.changeSet.id, workspace_id: run.workspace_id,
        project_id: operation.project_id, run_id: run.id, resource_id: resource.id,
        command_id: input.commandId, actor_ref: LOCAL_ACTOR_REF, decision: input.decision,
        observation_sha256: current.sha256, observation,
      });
      const closeReason = current.mode === 'NO_RECEIPT'
        ? 'UNATTRIBUTED_FILE_WRITE_MANUALLY_CLOSED' : 'PARTIAL_FILE_WRITE_MANUALLY_CLOSED';
      await repositories.gateway.setOperationStatus(operation.id, 'MANUALLY_CLOSED', {
        reason: closeReason, disposition_id: decision.id,
        observation_sha256: current.sha256,
      });
      await repositories.gateway.setClaimStatus(claim.id, 'RELEASED');
      await repositories.dispatch.settleStoppedForManualDisposition(run.id, proof.worker_id,
        proof.dispatch_epoch, proof.command_id);
      const pending = await repositories.recovery.lockPendingControl(run.id);
      if (pending !== undefined) {
        const rejected = await repositories.recovery.decideControl(pending.id, 'REJECTED',
          { reason: 'FILE_WRITE_MANUALLY_CLOSED', disposition_id: decision.id });
        if (rejected === undefined) throw new Error('manual disposition control CAS failed');
      }
      const failed = await repositories.runs.advanceRun({ runId: run.id,
        expectedRevision: run.revision, status: 'FAILED',
        currentStepId: run.current_step_id, waitReason: closeReason,
        terminal: true });
      if (failed === undefined) throw new Error('manual disposition Run CAS failed');
      const releasedTask = await repositories.tasks.releaseExecutionFromRun({
        taskId: task.id, runId: run.id, expectedRevision: task.revision, toStatus: 'READY',
      });
      if (releasedTask === undefined) throw new Error('manual disposition Task CAS failed');
      await repositories.activities.insertActivityRecord({ id: randomUUID(),
        workspaceId: run.workspace_id, actorKind: 'HUMAN', actorRef: LOCAL_ACTOR_REF,
        commandId: input.commandId, projectId: task.project_id, taskId: task.id,
        runId: run.id, eventType: 'FILE_WRITE_MANUALLY_CLOSED',
        factRefs: { operation_id: operation.id, invocation_id: invocation.id,
          change_set_id: ledger.changeSet.id, stop_proof_invocation_id: proof.invocation_id,
          disposition_id: decision.id, observation_sha256: current.sha256,
          decision: input.decision, observation_mode: current.mode ?? null } });
      return { operation_id: operation.id, invocation_id: invocation.id,
        disposition_id: decision.id, decision: input.decision,
        run_id: run.id, run_status: 'FAILED', task_id: task.id, task_status: 'READY',
        observation_sha256: current.sha256 };
    },
  });
}
