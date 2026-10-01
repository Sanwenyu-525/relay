import { randomUUID } from 'node:crypto';

import type { DbExecutor } from '../infrastructure/database.js';
import type {
  JsonObject,
  JsonValue,
} from '../infrastructure/json.js';
import type {
  ArtifactVersionRow,
  RunRow,
  RunStatus,
  RunStepKind,
  RunStepRow,
  StepAttemptRow,
  TaskRow,
  TaskStatus,
} from '../infrastructure/database-schema.js';
import {
  MAX_MARKDOWN_BYTES,
  ManagedContentStore,
  StorageConflictError,
  StorageUnavailableError,
  contentHashOf,
  managedContentRef,
  type ContentReadResult,
  type PublishedContent,
} from '../storage/managed-content-store.js';
import { toDecimalString } from '../shared/decimal.js';
import { DomainError, invalidTransition, resourceNotFound } from './domain-error.js';
import { createRepositories, withTransaction, type Repositories } from './unit-of-work.js';
import { lockTaskAndRun } from './lock-task-run.js';
import { requireCurrentRuleSnapshot } from './rule-fence.js';
import { applySafeControl } from './control-requests.js';
import type { RunAdvance } from '../run/run-repository.js';
import { type FakeScenario } from '../workflow/context-fixture.js';
import { readFileReadAction, readMockActionOperationId,
  readWebFetchAction } from '../workflow/execution-contract.js';
import { attachReadEvidenceWithinBudget, draftInputHash, loadRunReadEvidence,
  ReadInputBudgetError } from './run-read-evidence.js';
import { buildRunContext, type BuiltContext } from './context-builder.js';
import { contextManifestMatchesCurrent, matchesTaskContext } from './context-fence.js';
import { FakeModelPort, type ModelPort } from '../workflow/fake-model-port.js';
import { readModelPortConfig } from '../workflow/model-port-config.js';
import { OpenAiCompatibleModelPort, ModelCallBudgetError, ModelSourcePolicyError }
  from '../workflow/openai-compatible-model-port.js';
import { recordModelInvocation } from './model-call-recorder.js';
import { AssistLivePreviewPublisher, AssistPreviewOwnershipLostError } from '../assist/live-preview.js';
import { publishRunDraftPreview, recordRunDraftFirstTextDelta } from './run-draft-preview.js';
import { ModelScopeBudgetError } from '../model/model-call-repository.js';
import {
  ALL_EXECUTED_STEP_KINDS,
  CANDIDATE_OUTPUT_SCHEMA,
  validateCandidate,
} from '../workflow/markdown-deliverable.js';
import { evaluateCompletionGate, completeRun } from './complete-run.js';
import {
  countCorrectionRounds,
  loadCorrectionInput,
  prepareSemanticChecks,
  verifyRun,
  type PreparedSemanticCheck,
} from './verify-run.js';
import { advanceAiTextLocks, requireAiTextLocks } from './artifact-commands.js';

/**
 * 内部应用端口 AdvanceStep（docs/api/http-command-contract.md 第 5 节）。
 *
 * 不暴露 HTTP：Worker/测试通过它推进一个 Run 的下一步，输入必须带 Task ownership_epoch 与
 * worker claim 身份。Runtime 只执行一次有界步骤并返回受约束结果，不写 Task DONE、不伪造 PASS。
 *
 * Run 迁移路径（contracts/02-state-and-execution.md 第 3 节）：
 *   CREATED →(BUILD_CONTEXT 前)→ CONTEXT_BUILDING →(成功后)→ PLANNING
 *   PLANNING →(DRAFT 前)→ RUNNING →(DRAFT 成功后)→ RUNNING
 *   RUNNING →(PERSIST_CANDIDATE 成功后)→ VERIFYING
 *   VERIFYING →(VERIFY 总决策 PASS / RETRY_CHECKER)→ VERIFYING
 *   VERIFYING →(VERIFY 总决策 RETRY)→ RETRYING →(四个步骤重置后)→ 重新装配上下文
 *   VERIFYING →(VERIFY 总决策 HUMAN)→ WAITING_APPROVAL
 *   WAITING_APPROVAL/VERIFYING →(COMPLETE 成功后)→ COMPLETED（终态）
 * 失败路径：不可恢复失败 → 步骤 FAILED、Run FAILED（终态）、Task 释放回 READY。
 * 完成前置不满足 → COMPLETION_BLOCKED：步骤保持 PENDING、Run 不变、不抛错（等待人工不是执行失败）。
 */

const DEFAULT_LEASE_MS = 30_000;
const MAX_PURE_GENERATION_ATTEMPTS = 2n;

/** A local preview failure must not enter Provider transport classification. */
class RunDraftPreviewWriteError extends Error {
  override readonly name = 'RunDraftPreviewWriteError';
  constructor() { super('Run draft preview write failed'); }
}

/** 修正回路重置的步骤：装配上下文 → 起草 → 落盘候选 → 验证，按固定顺序重跑。 */
const CORRECTION_STEP_KINDS: readonly RunStepKind[] = [
  'BUILD_CONTEXT',
  'DRAFT',
  'PERSIST_CANDIDATE',
  'VERIFY',
];

const PERSIST_CANDIDATE_STEP_REF = 'step:PERSIST_CANDIDATE';

export interface AdvanceRunStepInput {
  readonly runId: string;
  readonly workerId: string;
  /** Required by the independent Worker: fences the entire Run invocation. */
  readonly invocationEpoch?: bigint | undefined;
  /** PERSIST_CANDIDATE 需要受管内容存储；P05 不写宿主路径。 */
  readonly storage: ManagedContentStore;
  readonly leaseMs?: number | undefined;
  /** 稳定来源尝试 ID；缺省为 `${stepKind}#${attemptNumber}`。 */
  readonly attemptKey?: string | undefined;
  /** 仅测试注入：决定 FakeModelPort 行为。 */
  readonly fakeScenario?: FakeScenario | undefined;
  /** 仅测试注入：使独立 Worker 的 Mock 模型保持在途。 */
  readonly fakeModelDelayMs?: number | undefined;
  /** 仅测试注入：Context token 上限。 */
  readonly contextBudgetTokens?: number | undefined;
  readonly signal?: AbortSignal | undefined;
  /** 受控故障点，只用于真实 PG 恢复/并发测试。 */
  readonly hooks?: {
    readonly afterClaim?: () => Promise<void>;
    readonly afterEffectIntent?: () => Promise<void>;
    readonly afterEffectDispatch?: () => Promise<void>;
    readonly beforeCommit?: () => Promise<void>;
  } | undefined;
}

export type AdvanceRunStepResult =
  | { readonly status: 'RUN_TERMINAL'; readonly run_status: RunStatus }
  | { readonly status: 'INVOCATION_LOST'; readonly run_id: string }
  | { readonly status: 'COMMAND_SUPERSEDED'; readonly run_id: string }
  | { readonly status: 'STALE_OWNERSHIP'; readonly run_id: string }
  | { readonly status: 'NO_STEP'; readonly run_id: string }
  | { readonly status: 'WAITING_REVIEW'; readonly run_id: string }
  | { readonly status: 'STEP_NOT_IMPLEMENTED'; readonly step_kind: RunStepKind }
  | { readonly status: 'CLAIM_CONFLICT'; readonly step_kind: RunStepKind }
  | { readonly status: 'CONTROL_PENDING'; readonly run_id: string }
  | { readonly status: 'ACTION_UNKNOWN'; readonly run_id: string; readonly operation_id: string }
  | { readonly status: 'GATEWAY_ACTION_REQUIRED'; readonly run_id: string; readonly operation_id: string }
  | { readonly status: 'GATEWAY_ACTION_DENIED'; readonly run_id: string; readonly operation_id: string }
  | { readonly status: 'REPLAYED'; readonly step_kind: RunStepKind; readonly result_ref: JsonObject | null }
  | { readonly status: 'STALE_RESULT'; readonly step_kind: RunStepKind }
  | {
      readonly status: 'RETRYABLE';
      readonly step_kind: RunStepKind;
      readonly attempt_number: string;
      readonly reason: string;
    }
  | {
      readonly status: 'STEP_SUCCEEDED';
      readonly step_kind: RunStepKind;
      readonly run_status: RunStatus;
      readonly result_ref: JsonObject | null;
    }
  /** 完成前置不满足：等待人工，不是执行失败；步骤保持 PENDING、Run 不变。 */
  | {
      readonly status: 'COMPLETION_BLOCKED';
      readonly step_kind: 'COMPLETE';
      readonly reason: string;
      readonly run_status: RunStatus;
    }
  /** 修正回路已排期：四个步骤重置为 PENDING，Run 回到 RETRYING。 */
  | {
      readonly status: 'CORRECTION_SCHEDULED';
      readonly step_kind: 'VERIFY';
      readonly run_status: RunStatus;
      readonly session_id: string;
      readonly correction_round: string;
    }
  | {
      readonly status: 'RUN_FAILED';
      readonly step_kind: RunStepKind;
      readonly reason: string;
      readonly task_status: TaskStatus;
    };

export interface RecordStaleAttemptResultInput {
  readonly attemptId: string;
  readonly expectedClaimEpoch: bigint;
  readonly resultRef: JsonObject | null;
  readonly evidence: JsonObject;
}

export interface RecordStaleAttemptResult {
  readonly accepted: boolean;
  readonly attempt: StepAttemptRow | undefined;
}

/**
 * 单次步骤执行结果。Run 的状态迁移统一由 Workflow 生命周期（applyRunTransitionAfter）写入，
 * 因此 SUCCESS 只携带“Run 应该去哪”的意图，而不是自己改 Run。
 */
export type StepExecution =
  | {
      readonly outcome: 'SUCCESS';
      readonly resultRef: JsonObject;
      /** 成功后 Run 的目标状态；缺省由步骤种类决定。 */
      readonly runStatus?: RunStatus;
      readonly waitReason?: string | null;
    }
  /** 可修正失败：session 已 finalize 为 RETRY，由调用方排期修正回路。 */
  | {
      readonly outcome: 'CORRECTION';
      readonly resultRef: JsonObject;
      readonly evidence: JsonObject;
    }
  | { readonly outcome: 'RETRYABLE'; readonly reason: string; readonly evidence: JsonObject }
  /** 完成前置不满足：步骤保持 PENDING、Run 不变、不抛错（等待人工不是执行失败）。 */
  | { readonly outcome: 'BLOCKED'; readonly reason: string }
  | { readonly outcome: 'FAILED'; readonly reason: string; readonly evidence: JsonObject };

interface ClaimedStep {
  readonly kind: 'CLAIMED';
  readonly run: RunRow;
  readonly task: TaskRow;
  readonly step: RunStepRow;
  readonly runningStep: RunStepRow;
  readonly attempt: StepAttemptRow;
  readonly workerEpoch: bigint;
}

class ControlPreemptedError extends Error {
  override readonly name = 'ControlPreemptedError';
}

class StaleInvocationError extends Error {
  override readonly name = 'StaleInvocationError';
}

/** 仅供故障注入：模拟进程在该指令后消失，跳过本进程的异常清理。 */
export class SimulatedWorkerCrash extends Error {
  override readonly name = 'SimulatedWorkerCrash';
}

export async function advanceRunStep(
  db: DbExecutor,
  input: AdvanceRunStepInput,
): Promise<AdvanceRunStepResult> {
  const locatedRun = await createRepositories(db).runs.readRun(input.runId);
  if (locatedRun === undefined) throw resourceNotFound('Run');
  const claim = await withTransaction<ClaimedStep | AdvanceRunStepResult>(db, async (repositories) => {
    // COMPLETE can be selected below. Authority must precede Task→Run, even
    // when this round ultimately selects another step.
    const authority = await repositories.workspaces.lockAuthority(locatedRun.workspace_id, 'share');
    if (authority === undefined) throw resourceNotFound('Workspace authority');
    const { run, task } = await lockTaskAndRun(repositories, input.runId);

    if (input.invocationEpoch !== undefined &&
        !(await repositories.dispatch.hasCurrentInvocation(run.id, input.workerId, input.invocationEpoch))) {
      return { status: 'INVOCATION_LOST', run_id: run.id };
    }
    // A user control must reach its safe point even when a Review has already
    // inserted a later command. The old START still settles after that point.
    if (await repositories.recovery.findPendingControl(run.id)) {
      return { status: 'CONTROL_PENDING', run_id: run.id };
    }
    // Review may commit a RESUME after this START produced its wait and before
    // the old delivery was acknowledged. A recovered START cannot consume the
    // approved continuation; only its successor may enter that step.
    if (input.invocationEpoch !== undefined &&
        await repositories.dispatch.hasLaterCommandForInvocation(
          run.id, input.workerId, input.invocationEpoch)) {
      return { status: 'COMMAND_SUPERSEDED', run_id: run.id };
    }

    if (isTerminalRunStatus(run.status)) {
      return { status: 'RUN_TERMINAL', run_status: run.status };
    }

    // Task 执行权与 Run 的 ownership_epoch 必须同时匹配：旧 Run 不得推进新执行者（契约 02 第 2 节）。
    if (task.executor_run_id !== run.id || task.ownership_epoch !== run.ownership_epoch) {
      await recordOwnershipMismatch(repositories, run, task.id, task.executor_run_id, task.ownership_epoch);

      return { status: 'STALE_OWNERSHIP', run_id: run.id };
    }

    if (run.status === 'PAUSED') return { status: 'CONTROL_PENDING', run_id: run.id };
    await requireCurrentRuleSnapshot(repositories, run.id, authority);

    let steps = await repositories.runs.listSteps(run.id);
    const built = steps.find((candidate) => candidate.step_kind === 'BUILD_CONTEXT');
    const published = steps.find((candidate) => candidate.step_kind === 'PERSIST_CANDIDATE');
    // A committed ASK is authoritative even if its graph interrupt checkpoint
    // was not written. Do not reset DRAFT on a Task status-only Review change.
    const draft = steps.find((candidate) => candidate.step_kind === 'DRAFT');
    const contract = await repositories.runs.readContract(run.id);
    const frozen = contract?.frozen_snapshot;
    const readAction = frozen === undefined ? undefined :
      readFileReadAction(frozen) ?? readWebFetchAction(frozen);
    const actionOperationId = frozen === undefined ? undefined :
      readMockActionOperationId(frozen);
    let gatewayActionSucceeded = false;
    const needsGatewayAction = actionOperationId !== undefined && published?.status !== 'SUCCEEDED' &&
      // Existing Runs prepared their read after DRAFT. Preserve their completed
      // draft and Review identity; only pending drafts take the new read-first path.
      (draft?.status === 'SUCCEEDED' || (readAction !== undefined && built?.status === 'SUCCEEDED'));
    let pendingReadAction = false;
    if (needsGatewayAction) {
      const operation = await repositories.gateway.readOperation(actionOperationId);
      const matchingStep = readAction === undefined
        ? operation?.step_id === draft?.id
        : operation?.step_id === built?.id ||
          // Legacy reads were bound to DRAFT. A correction may reset that
          // step, but the successful read must keep its old action identity.
          (operation?.step_id === draft?.id &&
            (draft?.status === 'SUCCEEDED' || operation?.status === 'SUCCEEDED'));
      if (operation !== undefined && (operation.run_id !== run.id || !matchingStep)) {
        throw invalidTransition('Mock Gateway 操作身份与冻结 Run 不匹配。');
      }
      if (operation?.status === 'UNKNOWN' || operation?.status === 'DISPATCHING') {
        return { status: 'ACTION_UNKNOWN', run_id: run.id, operation_id: actionOperationId };
      }
      if (operation?.status === 'DENIED' || operation?.status === 'FAILED') {
        return { status: 'GATEWAY_ACTION_DENIED', run_id: run.id, operation_id: actionOperationId };
      }
      gatewayActionSucceeded = operation?.status === 'SUCCEEDED';
      pendingReadAction = readAction !== undefined && draft?.status !== 'SUCCEEDED' &&
        !gatewayActionSucceeded;
      if (!gatewayActionSucceeded && !pendingReadAction) {
        return { status: 'GATEWAY_ACTION_REQUIRED', run_id: run.id, operation_id: actionOperationId };
      }
    }
    if (built?.status === 'SUCCEEDED') {
      const hash = readString(built.result_ref, 'manifest_hash');
      const manifest = hash === undefined ? undefined : await repositories.runs.readContextManifestByHash(
        run.id, Buffer.from(hash, 'hex'));
      const stale = manifest === undefined ||
        !(await contextManifestMatchesCurrent(repositories, manifest.payload, run, task, authority));
      if (stale && run.worker_id !== null) {
        return { status: 'CLAIM_CONFLICT', step_kind: 'BUILD_CONTEXT' };
      }
      if (stale && gatewayActionSucceeded) {
        throw invalidTransition('Context 来源已变化，已发生的动作需先核对。', { taskId: task.id });
      }
      if (stale && published?.status === 'PENDING') {
        await repositories.runs.resetStepToPending({ stepId: built.id, expectedRevision: built.revision });
        const draft = steps.find((candidate) => candidate.step_kind === 'DRAFT');
        if (draft?.status === 'SUCCEEDED' || draft?.status === 'RUNNING') {
          await repositories.runs.resetStepToPending({ stepId: draft.id, expectedRevision: draft.revision });
        }
        steps = await repositories.runs.listSteps(run.id);
      } else if (stale && published?.status !== 'SUCCEEDED') {
        throw invalidTransition('Context 来源已变化，已发生的动作需先核对。', { taskId: task.id });
      }
      // Published evidence belongs to the frozen contract. VERIFY and COMPLETE
      // use their own current gates; a later Context change must not erase it.
    }
    if (pendingReadAction && steps.find((candidate) => candidate.step_kind === 'BUILD_CONTEXT')?.status === 'SUCCEEDED') {
      // Gateway's existing RUN protocol admits actions only in RUNNING. No
      // DRAFT Attempt or model call exists yet, so an ASK waits before input use.
      if (run.status === 'PLANNING') {
        await advanceOrThrow(repositories, { runId: run.id, expectedRevision: run.revision,
          status: 'RUNNING', currentStepId: built!.id });
      }
      return { status: 'GATEWAY_ACTION_REQUIRED', run_id: run.id,
        operation_id: actionOperationId! };
    }
    const step = steps.find((candidate) => candidate.status !== 'SUCCEEDED');

    if (step === undefined) {
      return { status: 'NO_STEP', run_id: run.id };
    }

    // 操作审批仍由 P09 消费；Run 等待期间不能让轮询器越过审批执行下一步。
    // 验证 HUMAN 的 COMPLETE 仍走下面的完成 Gate，保留既有 COMPLETION_BLOCKED 语义。
    if (run.status === 'WAITING_APPROVAL' && step.step_kind !== 'COMPLETE') {
      return { status: 'WAITING_REVIEW', run_id: run.id };
    }

    if (!ALL_EXECUTED_STEP_KINDS.includes(step.step_kind)) {
      // 计划外的步骤种类：不执行、也不推进，避免以 Fake 结果冒充真实动作。
      return { status: 'STEP_NOT_IMPLEMENTED', step_kind: step.step_kind };
    }

    if (step.step_kind === 'COMPLETE') {
      // 完成 Gate 在建立尝试之前先核对：等待人工不是执行失败，反复轮询也不该留下失败尝试。
      const gate = await evaluateCompletionGate(repositories, { run, task });

      if (!gate.ok) {
        return {
          status: 'COMPLETION_BLOCKED',
          step_kind: 'COMPLETE',
          reason: gate.reason,
          run_status: run.status,
        };
      }
    }

    const attempts = await repositories.runs.listAttempts(step.id);
    const attemptNumber = BigInt(attempts.length + 1);
    const attemptKey = input.attemptKey ?? `${step.step_kind}#${attemptNumber}`;
    const matching = attempts.find((row) => row.attempt_key === attemptKey);
    if (matching?.status === 'SUCCEEDED' || matching?.status === 'FAILED') {
      return { status: 'REPLAYED', step_kind: step.step_kind, result_ref: matching.result_ref };
    }
    if (run.worker_id !== null) return { status: 'CLAIM_CONFLICT', step_kind: step.step_kind };
    const recovering = attempts.at(-1)?.status === 'RUNNING' ? attempts.at(-1) : undefined;
    const inserted = recovering === undefined
      ? await repositories.runs.insertStepAttempt({ id: randomUUID(), stepId: step.id,
          attemptNumber, attemptKey })
      : { row: recovering, inserted: false };

    let attempt = inserted.row;

    if (!inserted.inserted) {
      // 稳定来源尝试 ID 命中已有尝试：结果去重，不重跑（B08 的去重前提）。
      if (attempt.status === 'SUCCEEDED' || attempt.status === 'FAILED') {
        return { status: 'REPLAYED', step_kind: step.step_kind, result_ref: attempt.result_ref };
      }

      if (attempt.status === 'REJECTED_STALE') {
        return { status: 'STALE_RESULT', step_kind: step.step_kind };
      }

      if (attempt.status === 'RUNNING' && run.worker_id !== null) {
        return { status: 'CLAIM_CONFLICT', step_kind: step.step_kind };
      }
    }

    const worker = await repositories.runs.claimWorker(run.id, input.workerId,
      new Date(Date.now() + (input.leaseMs ?? DEFAULT_LEASE_MS)));
    if (worker === undefined) return { status: 'CLAIM_CONFLICT', step_kind: step.step_kind };

    if (attempt.status === 'PREPARED') {
      const claimed = await repositories.runs.claimAttempt({
        attemptId: attempt.id,
        workerId: input.workerId,
        leaseUntil: new Date(Date.now() + (input.leaseMs ?? DEFAULT_LEASE_MS)),
      });

      if (claimed === undefined) {
        throw new Error('attempt claim CAS failed after Run worker claim');
      }

      attempt = claimed;
    } else if (attempt.status === 'RUNNING') {
      const reclaimed = await repositories.runs.reclaimAttempt(attempt.id, input.workerId,
        new Date(Date.now() + (input.leaseMs ?? DEFAULT_LEASE_MS)));
      if (reclaimed === undefined) throw new Error('attempt reclaim CAS failed after Run worker claim');
      attempt = reclaimed;
    }

    // 步骤进入 RUNNING（持久保存步骤位置）；RETRYABLE 失败后仍留在 RUNNING，下一步会重新选中它。
    const runningStep = await repositories.runs.advanceStep({
      stepId: step.id,
      expectedRevision: step.revision,
      status: 'RUNNING',
    });

    if (runningStep === undefined) {
      throw new Error('run step advance CAS failed while holding the run lock');
    }

    const runRow = await applyRunTransitionBefore(repositories, worker, step);
    return { kind: 'CLAIMED', run: runRow, task, step, runningStep, attempt,
      workerEpoch: worker.worker_epoch };
  });

  if (!('kind' in claim)) {
    if (claim.status === 'CONTROL_PENDING') await applySafeControl(db, claim.run_id);
    return claim;
  }

  try {
  await input.hooks?.afterClaim?.();
  const prepared = await prepareExternalWork(db, input, claim);
  if (prepared.kind === 'UNKNOWN') {
    const current = await withTransaction(db, async (repositories) => {
      const { run } = await lockTaskAndRun(repositories, input.runId);
      if (input.invocationEpoch !== undefined &&
          !(await repositories.dispatch.hasCurrentInvocation(run.id, input.workerId, input.invocationEpoch))) {
        return false;
      }
      if (run.worker_id === input.workerId && run.worker_epoch === claim.workerEpoch) {
        await repositories.runs.releaseWorker(run.id, input.workerId, claim.workerEpoch);
      }
      return true;
    });
    if (!current) return { status: 'INVOCATION_LOST', run_id: claim.run.id };
    return { status: 'ACTION_UNKNOWN', run_id: claim.run.id, operation_id: prepared.operationId };
  }
  await input.hooks?.beforeCommit?.();
  if (input.signal?.aborted) throw new StaleInvocationError('worker stopped before step commit');

  const result = await withTransaction<AdvanceRunStepResult>(db, async (repositories) => {
    const authority = await repositories.workspaces.lockAuthority(claim.run.workspace_id, 'share');
    if (authority === undefined) throw resourceNotFound('Workspace authority');
    const { task, run } = await lockTaskAndRun(repositories, input.runId);
    if (input.invocationEpoch !== undefined &&
        !(await repositories.dispatch.hasCurrentInvocation(run.id, input.workerId, input.invocationEpoch))) {
      return { status: 'STALE_RESULT', step_kind: claim.step.step_kind };
    }
    const { step, runningStep, attempt } = claim;
    if (run.worker_epoch !== claim.workerEpoch || run.worker_id !== input.workerId ||
        task.executor_run_id !== run.id || task.ownership_epoch !== run.ownership_epoch) {
      return { status: 'STALE_RESULT', step_kind: step.step_kind };
    }
    const currentAttempt = await repositories.runs.readAttempt(attempt.id);
    const currentStep = await repositories.runs.readStep(step.id);
    if (currentAttempt?.status !== 'RUNNING' || currentAttempt.claim_epoch !== attempt.claim_epoch ||
        currentStep?.revision !== runningStep.revision || currentStep?.status !== 'RUNNING') {
      return { status: 'STALE_RESULT', step_kind: step.step_kind };
    }
    // A committed control wins against every step without a published effect.
    // Published content still needs its stable Attempt/Artifact evidence recorded.
    if ((step.step_kind !== 'PERSIST_CANDIDATE' || prepared.persist === undefined) &&
        await repositories.recovery.findPendingControl(run.id)) {
      await repositories.runs.recordAttemptOutcome({ attemptId: attempt.id,
        expectedClaimEpoch: attempt.claim_epoch, status: 'FAILED', resultRef: null,
        evidence: { reason: 'CONTROL_PREEMPTED' } });
      return { status: 'CONTROL_PENDING', run_id: run.id };
    }
    // 已发布的受管效果仍要登记同一 Attempt/Artifact；规则更新只阻止后续动作。
    // PREPARED/纯计算步骤没有已发生效果，继续按规则版本栅栏拒绝。
    if (step.step_kind !== 'PERSIST_CANDIDATE' || prepared.persist === undefined) {
      await requireCurrentRuleSnapshot(repositories, run.id, authority);
    }
    if (input.signal?.aborted) throw new StaleInvocationError('worker stopped before step result');
    let runRow = run;
    const execution = prepared.preflightFailure ?? await executeStep(repositories, {
      stepKind: step.step_kind, run, task, step, attemptNumber: attempt.attempt_number,
      stepAttemptId: attempt.id, modelCallDb: db,
      storage: prepared.storage, modelPort: prepared.modelPort,
      ...(prepared.persist === undefined ? {} : { persist: prepared.persist }),
      ...(prepared.context === undefined ? {} : { context: prepared.context }),
      ...(prepared.semanticChecks === undefined ? {} :
        { precomputedChecks: prepared.semanticChecks }),
      ...(input.fakeScenario === undefined ? {} : { fakeScenario: input.fakeScenario }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });

    if (execution.outcome === 'RETRYABLE') {
      const recorded = await repositories.runs.recordAttemptOutcome({
        attemptId: attempt.id,
        expectedClaimEpoch: attempt.claim_epoch,
        status: 'FAILED',
        resultRef: execution.evidence,
        evidence: { reason: execution.reason },
      });

      if (recorded === undefined) {
        return { status: 'STALE_RESULT', step_kind: step.step_kind };
      }

      return {
        status: 'RETRYABLE',
        step_kind: step.step_kind,
        attempt_number: toDecimalString(attempt.attempt_number),
        reason: execution.reason,
      };
    }

    if (execution.outcome === 'BLOCKED') {
      // 同一事务内 Gate 已在建立尝试前核对过：这里再阻塞说明存在内部不一致，
      // 按内部错误处理（整笔回滚），而不是把“等待人工”记成一次执行失败。
      throw new Error('completion gate changed while holding the run lock');
    }

    if (execution.outcome === 'FAILED') {
      return await failRun(repositories, {
        run,
        runRow,
        task,
        step,
        runningStep,
        attempt,
        execution,
      });
    }

    if (execution.outcome === 'CORRECTION') {
      return await scheduleCorrection(repositories, {
        run,
        runRow,
        step,
        runningStep,
        attempt,
        execution,
      });
    }

    const recorded = await repositories.runs.recordAttemptOutcome({
      attemptId: attempt.id,
      expectedClaimEpoch: attempt.claim_epoch,
      status: 'SUCCEEDED',
      resultRef: execution.resultRef,
      evidence: null,
    });

    if (recorded === undefined) {
      return { status: 'STALE_RESULT', step_kind: step.step_kind };
    }

    const succeeded = await repositories.runs.advanceStep({
      stepId: step.id,
      expectedRevision: runningStep.revision,
      status: 'SUCCEEDED',
      resultRef: execution.resultRef,
    });

    if (succeeded === undefined) {
      throw new Error('run step success CAS failed while holding the run lock');
    }

    runRow = await applyRunTransitionAfter(repositories, runRow, step, execution);

    if (runRow.status === 'WAITING_APPROVAL' && task.status === 'IN_PROGRESS') {
      const waiting = await repositories.tasks.applyTaskStatus({ taskId: task.id,
        expectedRevision: task.revision, fromStatus: 'IN_PROGRESS', toStatus: 'WAITING' });
      if (waiting === undefined) throw new Error('review waiting Task CAS failed');
    }

    return {
      status: 'STEP_SUCCEEDED',
      step_kind: step.step_kind,
      run_status: runRow.status,
      result_ref: execution.resultRef,
    };
  });
  if (result.status !== 'STALE_RESULT') {
    await withTransaction(db, async (repositories) => {
      const { run } = await lockTaskAndRun(repositories, input.runId);
      if (run.worker_id === input.workerId && run.worker_epoch === claim.workerEpoch) {
        await repositories.runs.releaseWorker(run.id, input.workerId, claim.workerEpoch);
      }
    });
    await applySafeControl(db, input.runId);
  }
  return result;
  } catch (error) {
    if (error instanceof SimulatedWorkerCrash) throw error;
    if (error instanceof StaleInvocationError) {
      return { status: 'INVOCATION_LOST', run_id: claim.run.id };
    }
    await cleanupClaimAfterError(db, input, claim);
    if (error instanceof ControlPreemptedError) {
      await applySafeControl(db, input.runId);
      return { status: 'CONTROL_PENDING', run_id: input.runId };
    }
    throw error;
  }
}

async function cleanupClaimAfterError(db: DbExecutor, input: AdvanceRunStepInput, claim: ClaimedStep): Promise<void> {
  await withTransaction(db, async (repositories) => {
    const { run } = await lockTaskAndRun(repositories, input.runId);
    if (run.worker_id !== input.workerId || run.worker_epoch !== claim.workerEpoch) return;
    const effect = await repositories.recovery.readEffectByAttempt(claim.attempt.id);
    if (effect === undefined || effect.status === 'PREPARED' || effect.status === 'FAILED') {
      await repositories.runs.recordAttemptOutcome({ attemptId: claim.attempt.id,
        expectedClaimEpoch: claim.attempt.claim_epoch, status: 'FAILED', resultRef: null,
        evidence: { reason: 'WORKER_EXECUTION_ERROR' } });
    }
    // 已发布但步骤尚未提交也需核对；保留 worker claim 直到停机证据到位并完成 fence。
    if (effect?.status === 'DISPATCHING' || effect?.status === 'UNKNOWN' || effect?.status === 'SUCCEEDED') return;
    await repositories.runs.releaseWorker(run.id, input.workerId, claim.workerEpoch);
  });
}

interface PreparedPersist {
  readonly artifactId: string;
  readonly versionId: string;
  readonly sourceRef: string;
  readonly published: PublishedContent;
}

type PreparedExternalWork =
  | { readonly kind: 'UNKNOWN'; readonly operationId: string }
  | { readonly kind: 'READY'; readonly storage: ManagedContentStore;
      readonly modelPort: ModelPort; readonly persist?: PreparedPersist;
      readonly context?: BuiltContext;
      readonly semanticChecks?: ReadonlyMap<string, PreparedSemanticCheck>;
      readonly preflightFailure?: Extract<StepExecution, { readonly outcome: 'FAILED' }> };

/** 事务外只读受管内容；提交事务只能消费已核对的字节，不再执行文件 I/O。 */
class PreloadedContentStore extends ManagedContentStore {
  constructor(dataRoot: string, private readonly reads: ReadonlyMap<string, {
    readonly hashHex: string; readonly size: bigint; readonly result: ContentReadResult;
  }>) { super(dataRoot); }

  override async readWithHashCheck(storageRef: string, expected: {
    readonly contentHash: Buffer; readonly size: bigint;
  }): Promise<ContentReadResult> {
    const read = this.reads.get(storageRef);
    if (read === undefined || read.hashHex !== expected.contentHash.toString('hex') || read.size !== expected.size) {
      return { status: 'MISSING' };
    }
    return read.result;
  }

  override async publish(): Promise<PublishedContent> {
    throw new Error('managed content publish must finish outside the commit transaction');
  }
}

async function prepareExternalWork(db: DbExecutor, input: AdvanceRunStepInput,
  claim: ClaimedStep): Promise<PreparedExternalWork> {
  const repositories = createRepositories(db);
  const modelConfig = readModelPortConfig(process.env);
  let modelPort: ModelPort = modelConfig === undefined
    ? new FakeModelPort(input.fakeModelDelayMs)
    : new OpenAiCompatibleModelPort(modelConfig);
  let persist: PreparedPersist | undefined;
  let context: BuiltContext | undefined;
  let semanticChecks: ReadonlyMap<string, PreparedSemanticCheck> | undefined;
  let preflightFailure: Extract<StepExecution, { readonly outcome: 'FAILED' }> | undefined;
  const reads = new Map<string, { hashHex: string; size: bigint; result: ContentReadResult }>();

  if (claim.step.step_kind === 'BUILD_CONTEXT') {
    const correction = await loadCorrectionInput(repositories, claim.run.id);
    context = await buildRunContext(db, { run: claim.run, task: claim.task, storage: input.storage,
      externalModel: modelConfig !== undefined,
      ...(input.fakeScenario === undefined ? {} : { fakeScenario: input.fakeScenario }),
      ...(input.contextBudgetTokens === undefined ? {} : { budgetTokens: input.contextBudgetTokens }),
      ...(correction === undefined ? {} : { correction }) });
  }

  if (claim.step.step_kind === 'DRAFT') {
    let manifest: Awaited<ReturnType<typeof loadManifestForDraft>> | undefined;
    try { manifest = await loadManifestForDraft(repositories, claim.run.id, claim.task.id); }
    catch (error) {
      if (!(error instanceof ReadInputBudgetError)) throw error;
      preflightFailure = { outcome: 'FAILED', reason: 'CONTEXT_REQUIRED_OVER_BUDGET',
        evidence: { reason: 'CONTEXT_REQUIRED_OVER_BUDGET', source: 'GATEWAY_READ' } };
    }
    if (manifest !== undefined) {
      const currentPort = modelPort;
      const readEvidence = await loadRunReadEvidence(repositories, claim.run.id);
      const inputHash = draftInputHash(manifest.payload, CANDIDATE_OUTPUT_SCHEMA);
      let previewEnabled = true;
      try {
        const recorded = await recordModelInvocation(db, {
          origin: { workspaceId: claim.run.workspace_id, kind: 'DRAFT',
            stepAttemptId: claim.attempt.id, manifestId: manifest.id,
            inputHash,
            ...(readEvidence === undefined ? {} : {
              readOperationId: readEvidence.operationId,
              readInvocationId: readEvidence.invocationId,
            }) },
          identity: currentPort.identity,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
          invoke: async (callId) => {
            const previewOwner = {
              workspaceId: claim.run.workspace_id, runId: claim.run.id,
              stepId: claim.step.id, attemptId: claim.attempt.id,
              attemptClaimEpoch: claim.attempt.claim_epoch,
              runWorkerEpoch: claim.workerEpoch, workerId: input.workerId,
              ...(input.invocationEpoch === undefined ? {} :
                { invocationEpoch: input.invocationEpoch }),
              modelCallId: callId, manifestId: manifest.id, inputHash,
            };
            let textObserved = false;
            const preview = new AssistLivePreviewPublisher((text, truncated) =>
              publishRunDraftPreview(db, { ...previewOwner, text, truncated }),
              () => { previewEnabled = false; });
            const generated = await currentPort.generate({ manifest: manifest.payload,
            outputSchema: CANDIDATE_OUTPUT_SCHEMA,
              ...(input.signal === undefined ? {} : { signal: input.signal }),
              onTextDelta: async (piece) => {
                const observedAt = new Date();
                if (piece === '' || !previewEnabled || input.signal?.aborted) return;
                try {
                  if (!textObserved) {
                    textObserved = await recordRunDraftFirstTextDelta(db,
                      { ...previewOwner, observedAt });
                    if (!textObserved) { previewEnabled = false; return; }
                  }
                  await preview.push(piece);
                }
                catch (error) {
                  if (!(error instanceof AssistPreviewOwnershipLostError)) {
                    throw new RunDraftPreviewWriteError();
                  }
                }
              } });
            if (generated.kind !== 'CANCELLED' && previewEnabled) {
              try { await preview.flush(); }
              catch (error) {
                if (!(error instanceof AssistPreviewOwnershipLostError)) {
                  throw new RunDraftPreviewWriteError();
                }
              }
            }
            return generated;
          },
          settle: (result) => result.kind === 'CANCELLED'
            ? { status: 'CANCELLED', providerRequestId: result.providerRequestId ?? null,
              ...(result.usage === undefined ? {} : { usage: result.usage }) }
            : result.kind === 'CONTENT'
              ? { status: 'COMPLETED', providerRequestId: result.providerRequestId,
                usage: result.usage }
              : { status: 'COMPLETED' },
        });
        modelPort = { identity: currentPort.identity, generate: async () => recorded.result };
      } catch (error) {
        if (error instanceof ModelSourcePolicyError) {
          preflightFailure = { outcome: 'FAILED', reason: 'MODEL_SOURCE_SELECTION_REQUIRED',
            evidence: { reason: 'MODEL_SOURCE_SELECTION_REQUIRED' } };
        } else if (error instanceof ModelScopeBudgetError ||
            error instanceof ModelCallBudgetError) {
          preflightFailure = { outcome: 'FAILED', reason: 'MODEL_BUDGET_EXHAUSTED',
            evidence: { reason: 'MODEL_BUDGET_EXHAUSTED' } };
        } else throw error;
      }
    }
  }

  if (claim.step.step_kind === 'PERSIST_CANDIDATE') {
    const content = Buffer.from(await loadDraftContent(repositories, claim.run.id, claim.task.id), 'utf8');
    if (content.byteLength <= MAX_MARKDOWN_BYTES) {
      const round = countCorrectionRounds(await repositories.verifications.listSessionsByRun(claim.run.id));
      const baseSourceRef = `run:${claim.run.id}/${PERSIST_CANDIDATE_STEP_REF}`;
      const sourceRef = round === 0n ? baseSourceRef : `${baseSourceRef}/round:${toDecimalString(round)}`;
      const existing = await repositories.artifacts.findArtifactVersionBySourceRef({ taskId: claim.task.id, sourceRef });
      if (existing === undefined) {
        const base = await repositories.artifacts.findArtifactVersionBySourceRef({ taskId: claim.task.id,
          sourceRef: baseSourceRef });
        const artifactId = base?.artifact_id ?? claim.run.id;
        const versionId = claim.attempt.id;
        const targetRef = managedContentRef(artifactId, versionId);
        const effect = await withTransaction(db, async (tx) => {
          const { run, task } = await lockTaskAndRun(tx, claim.run.id);
          if (!(await hasCurrentEffectWriter(tx, input, claim, run, task))) {
            throw new StaleInvocationError('effect intent belongs to a stale invocation');
          }
          return tx.recovery.insertEffect({
            operationId: claim.attempt.id, runId: claim.run.id, stepId: claim.step.id,
            attemptId: claim.attempt.id, targetRef, paramsHash: contentHashOf(content),
          });
        });
        if (!effect.params_hash.equals(contentHashOf(content)) || effect.target_ref !== targetRef) {
          throw new Error('stable operation identity is bound to different content');
        }
        await input.hooks?.afterEffectIntent?.();
        const published = await publishOrReconcileEffect(db, input, claim, effect, content,
          artifactId, versionId, sourceRef);
        if (published === null) return { kind: 'UNKNOWN', operationId: effect.operation_id };
        persist = { artifactId, versionId, sourceRef, published };
      }
    }
  }

  if (claim.step.step_kind === 'VERIFY') {
    const persistStep = await repositories.runs.readStepByKind(claim.run.id, 'PERSIST_CANDIDATE');
    const versionId = readString(persistStep?.result_ref, 'artifact_version_id');
    if (versionId !== undefined) await preloadVersion(repositories, input.storage, versionId, reads);
    // 模型型语义检查在结果事务之外调用与记账（携带 budget 的 begin() 会对 runs 行
    // for update，留在事务内会与结果事务的行锁自死锁）；对齐 DRAFT 的 prepare 阶段。
    semanticChecks = await prepareSemanticChecks(db, {
      run: claim.run, task: claim.task, storage: input.storage,
      stepAttemptId: claim.attempt.id,
      ...(input.fakeScenario === undefined ? {} : { fakeScenario: input.fakeScenario }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  }

  if (claim.step.step_kind === 'COMPLETE') {
    const sessions = await repositories.verifications.listSessionsByRun(claim.run.id);
    const latest = sessions.at(-1);
    if (latest !== undefined) {
      for (const target of await repositories.verifications.listTargets(latest.id)) {
        await preloadVersion(repositories, input.storage, target.artifact_version_id, reads);
      }
    }
  }

  return { kind: 'READY', modelPort,
    storage: new PreloadedContentStore(input.storage.dataRoot, reads),
    ...(persist === undefined ? {} : { persist }),
    ...(context === undefined ? {} : { context }),
    ...(semanticChecks === undefined ? {} : { semanticChecks }),
    ...(preflightFailure === undefined ? {} : { preflightFailure }) };
}

async function preloadVersion(repositories: Repositories, storage: ManagedContentStore, versionId: string,
  reads: Map<string, { hashHex: string; size: bigint; result: ContentReadResult }>): Promise<void> {
  const version = await repositories.artifacts.readArtifactVersion(versionId);
  if (version === undefined || reads.has(version.storage_ref)) return;
  const result = await storage.readWithHashCheck(version.storage_ref,
    { contentHash: version.content_hash, size: version.size });
  reads.set(version.storage_ref, { hashHex: version.content_hash.toString('hex'), size: version.size, result });
}

async function hasCurrentEffectWriter(repositories: Repositories, input: AdvanceRunStepInput,
  claim: ClaimedStep, run: RunRow, task: TaskRow): Promise<boolean> {
  return run.worker_epoch === claim.workerEpoch && run.worker_id === input.workerId &&
    task.executor_run_id === run.id && task.ownership_epoch === run.ownership_epoch &&
    (input.invocationEpoch === undefined ||
      await repositories.dispatch.hasCurrentInvocation(run.id, input.workerId, input.invocationEpoch));
}

async function requireCurrentEffectWriter(db: DbExecutor, input: AdvanceRunStepInput,
  claim: ClaimedStep): Promise<void> {
  const current = await withTransaction(db, async (repositories) => {
    const { run, task } = await lockTaskAndRun(repositories, claim.run.id);
    return hasCurrentEffectWriter(repositories, input, claim, run, task);
  });
  if (!current) throw new StaleInvocationError('effect result belongs to a stale invocation');
}

async function resolveEffectForCurrentWriter(db: DbExecutor, input: AdvanceRunStepInput,
  claim: ClaimedStep, operationId: string, expectedStatus: 'DISPATCHING' | 'UNKNOWN' | 'SUCCEEDED',
  status: 'SUCCEEDED' | 'UNKNOWN', resultRef: JsonObject): Promise<void> {
  const current = await withTransaction(db, async (repositories) => {
    const { run, task } = await lockTaskAndRun(repositories, claim.run.id);
    if (!(await hasCurrentEffectWriter(repositories, input, claim, run, task))) return false;
    await repositories.recovery.resolveEffect(operationId, expectedStatus, status, resultRef);
    return true;
  });
  if (!current) throw new StaleInvocationError('effect result belongs to a stale invocation');
}

async function publishOrReconcileEffect(db: DbExecutor, input: AdvanceRunStepInput, claim: ClaimedStep,
  effect: { readonly operation_id: string; readonly status: string; readonly target_ref: string;
    readonly params_hash: Buffer; readonly result_ref: JsonObject | null },
  content: Buffer, artifactId: string, versionId: string, sourceRef: string): Promise<PublishedContent | null> {
  const expected = { contentHash: contentHashOf(content), size: BigInt(content.byteLength) };
  const checkPublished = async (): Promise<PublishedContent | null> => {
    const read = await input.storage.readWithHashCheck(effect.target_ref, expected);
    return read.status === 'OK' ? { storageRef: effect.target_ref,
      contentHash: expected.contentHash, size: expected.size } : null;
  };

  if (effect.status === 'SUCCEEDED' || effect.status === 'DISPATCHING' || effect.status === 'UNKNOWN') {
    const published = await checkPublished();
    if (published === null) {
      if (effect.status === 'SUCCEEDED') {
        await resolveEffectForCurrentWriter(db, input, claim, effect.operation_id,
          'SUCCEEDED', 'UNKNOWN', { reason: 'PUBLISHED_TARGET_UNAVAILABLE',
            target_ref: effect.target_ref, prior_result_ref: effect.result_ref });
      } else {
        await requireCurrentEffectWriter(db, input, claim);
      }
      return null;
    }
    if (effect.status !== 'SUCCEEDED') {
      await resolveEffectForCurrentWriter(db, input, claim, effect.operation_id,
        effect.status as 'DISPATCHING' | 'UNKNOWN', 'SUCCEEDED',
        effectResult(artifactId, versionId, sourceRef, published));
    }
    return published;
  }
  if (effect.status !== 'PREPARED') return null;
  const dispatched = await withTransaction(db, async (repositories) => {
    const authority = await repositories.workspaces.lockAuthority(claim.run.workspace_id, 'share');
    if (authority === undefined) throw resourceNotFound('Workspace authority');
    const { run, task } = await lockTaskAndRun(repositories, claim.run.id);
    await requireCurrentRuleSnapshot(repositories, run.id, authority);
    if (run.worker_epoch !== claim.workerEpoch || run.worker_id !== input.workerId ||
        task.executor_run_id !== run.id || task.ownership_epoch !== run.ownership_epoch ||
        (input.invocationEpoch !== undefined &&
          !(await repositories.dispatch.hasCurrentInvocation(run.id, input.workerId, input.invocationEpoch))) ||
        await repositories.recovery.findPendingControl(run.id)) {
      return null;
    }
    return repositories.recovery.dispatchEffect(effect.operation_id);
  });
  if (dispatched === null) throw new ControlPreemptedError('control or ownership changed before effect dispatch');
  if (dispatched === undefined) return null;
  await input.hooks?.afterEffectDispatch?.();
  let published: PublishedContent | null = null;
  try {
    published = await input.storage.publish({ artifactId, versionId, content });
  } catch (error) {
    if (error instanceof StorageConflictError) published = await checkPublished();
    if (published === null && !(error instanceof StorageConflictError || error instanceof StorageUnavailableError)) throw error;
  }
  if (published === null) {
    await resolveEffectForCurrentWriter(db, input, claim, effect.operation_id,
      'DISPATCHING', 'UNKNOWN', { reason: 'PUBLISH_OUTCOME_UNCERTAIN',
        target_ref: effect.target_ref });
    return null;
  }
  await resolveEffectForCurrentWriter(db, input, claim, effect.operation_id,
    'DISPATCHING', 'SUCCEEDED', effectResult(artifactId, versionId, sourceRef, published));
  return published;
}

function effectResult(artifactId: string, versionId: string, sourceRef: string,
  published: PublishedContent): JsonObject {
  return { artifact_id: artifactId, version_id: versionId, source_ref: sourceRef,
    storage_ref: published.storageRef, sha256: published.contentHash.toString('hex'),
    size: toDecimalString(published.size) };
}

/**
 * 迟到结果的登记入口：claim_epoch 不匹配时只写核对证据并拒绝，匹配时才正常登记。
 * 测试用它验证“旧 epoch 结果被拒绝、步骤位置不变、不产生第二条版本”。
 */
export async function recordStaleAttemptResult(
  db: DbExecutor,
  input: RecordStaleAttemptResultInput,
): Promise<RecordStaleAttemptResult> {
  return withTransaction(db, async (repositories) => {
    const attempt = await repositories.runs.readAttempt(input.attemptId);

    if (attempt === undefined) {
      throw resourceNotFound('Step attempt');
    }

    const step = await repositories.runs.readStep(attempt.step_id);
    if (step === undefined) throw resourceNotFound('Step attempt ownership context');
    const { run, task } = await lockTaskAndRun(repositories, step.run_id);
    const current = await repositories.runs.readAttempt(input.attemptId);
    if (current === undefined) throw resourceNotFound('Step attempt');

    if (current.claim_epoch !== input.expectedClaimEpoch || current.status !== 'RUNNING' ||
        run.worker_id !== current.worker_id || run.worker_id === null ||
        task.executor_run_id !== run.id || task.ownership_epoch !== run.ownership_epoch) {

      await repositories.activities.insertActivityRecord({
        id: randomUUID(),
        workspaceId: run.workspace_id,
        runId: run.id,
        actorKind: 'AI',
        actorRef: `run:${run.id}/attempt:${attempt.id}`,
        commandId: null,
        projectId: task.project_id,
        taskId: task.id,
        eventType: 'STEP_ATTEMPT_RESULT_REJECTED_STALE',
        factRefs: {
          attempt_id: attempt.id,
          step_id: step.id,
          run_id: run.id,
          submitted_claim_epoch: toDecimalString(input.expectedClaimEpoch),
          observed_claim_epoch: toDecimalString(current.claim_epoch),
          observed_status: current.status,
          observed_worker_id: current.worker_id,
          observed_lease_until: current.lease_until?.toISOString() ?? null,
          observed_run_worker_id: run.worker_id,
          observed_run_worker_epoch: toDecimalString(run.worker_epoch),
          submitted_result_ref: input.resultRef,
          evidence: input.evidence,
        },
      });

      return { accepted: false, attempt: current };
    }

    const recorded = await repositories.runs.recordAttemptOutcome({
      attemptId: attempt.id,
      expectedClaimEpoch: input.expectedClaimEpoch,
      status: 'SUCCEEDED',
      resultRef: input.resultRef,
      evidence: input.evidence,
    });

    return { accepted: recorded !== undefined, attempt: recorded };
  });
}

interface ExecuteStepInput {
  readonly stepKind: RunStepKind;
  readonly run: RunRow;
  readonly task: TaskRow;
  readonly step: RunStepRow;
  readonly attemptNumber: bigint;
  readonly stepAttemptId: string;
  readonly modelCallDb: DbExecutor;
  readonly storage: ManagedContentStore;
  readonly modelPort: ModelPort;
  readonly persist?: PreparedPersist | undefined;
  readonly context?: BuiltContext | undefined;
  readonly precomputedChecks?: ReadonlyMap<string, PreparedSemanticCheck> | undefined;
  readonly fakeScenario?: FakeScenario | undefined;
  readonly signal?: AbortSignal | undefined;
}

async function executeStep(
  repositories: Repositories,
  input: ExecuteStepInput,
): Promise<StepExecution> {
  switch (input.stepKind) {
    case 'BUILD_CONTEXT':
      return executeBuildContext(repositories, input);
    case 'DRAFT':
      return executeDraft(repositories, input);
    case 'PERSIST_CANDIDATE':
      return executePersistCandidate(repositories, input);
    case 'VERIFY':
      return verifyRun(repositories, {
        run: input.run,
        task: input.task,
        storage: input.storage,
        modelCallDb: input.modelCallDb,
        stepAttemptId: input.stepAttemptId,
        ...(input.precomputedChecks === undefined ? {} :
          { precomputedChecks: input.precomputedChecks }),
        ...(input.fakeScenario === undefined ? {} : { fakeScenario: input.fakeScenario }),
      });
    case 'COMPLETE': {
      const outcome = await completeRun(repositories, {
        run: input.run,
        task: input.task,
        storage: input.storage,
      });

      return outcome.outcome === 'COMPLETE'
        ? { outcome: 'SUCCESS', resultRef: outcome.resultRef, runStatus: 'COMPLETED', waitReason: null }
        : { outcome: 'BLOCKED', reason: outcome.reason };
    }
    default:
      // 由 ALL_EXECUTED_STEP_KINDS 守卫；这里只表达“本阶段不执行”。
      return { outcome: 'FAILED', reason: 'STEP_NOT_IMPLEMENTED', evidence: { step_kind: input.stepKind } };
  }
}

async function executeBuildContext(
  repositories: Repositories,
  input: ExecuteStepInput,
): Promise<StepExecution> {
  const built = input.context;
  if (built === undefined) throw new Error('BUILD_CONTEXT requires prepared context');
  if (built.kind === 'FAILED') {
    return { outcome: 'FAILED', reason: built.reason, evidence: built.evidence };
  }
  const authority = await repositories.workspaces.readAuthority(input.run.workspace_id);
  const project = input.task.project_id === null ? undefined :
    await repositories.projects.readProject(input.task.project_id, true);
  if (authority === undefined || built.contextRevision !== toDecimalString(authority.context_revision) ||
      built.authorityRevision !== toDecimalString(authority.revision) ||
      project === undefined || built.projectRevision !== toDecimalString(project.revision) ||
      !matchesTaskContext(built.payload, input.task)) {
    return { outcome: 'RETRYABLE', reason: 'CONTEXT_SOURCE_CHANGED',
      evidence: { reason: 'CONTEXT_SOURCE_CHANGED' } };
  }

  const manifest = await repositories.runs.insertContextManifest({
    id: randomUUID(),
    runId: input.run.id,
    stepId: input.step.id,
    builderVersion: built.builderVersion,
    manifestHash: built.manifestHash,
    payload: built.payload,
  });

  return {
    outcome: 'SUCCESS',
    resultRef: {
      manifest_id: manifest.row.id,
      manifest_hash: manifest.row.manifest_hash.toString('hex'),
      builder_version: manifest.row.builder_version,
      reused: !manifest.inserted,
    },
  };
}

async function executeDraft(
  repositories: Repositories,
  input: ExecuteStepInput,
): Promise<StepExecution> {
  const manifest = await loadManifestForDraft(repositories, input.run.id, input.task.id);

  const result = await input.modelPort.generate({
    manifest: manifest.payload,
    outputSchema: CANDIDATE_OUTPUT_SCHEMA,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });

  switch (result.kind) {
    case 'CANCELLED':
      return { outcome: 'FAILED', reason: 'CANCELLED', evidence: { kind: 'CANCELLED' } };

    case 'MISSING_MATERIAL':
      // 缺资料不可重试：模型无法在没有输入的情况下生成可验证候选。
      return {
        outcome: 'FAILED',
        reason: 'MISSING_MATERIAL',
        evidence: { kind: 'MISSING_MATERIAL', missing: [...result.missing] },
      };

    case 'SCHEMA_INVALID':
      return schemaInvalidOutcome(input.attemptNumber, result.reason, result.raw);

    case 'CONTENT': {
      // 模型输出只变成受约束结果：CONTENT 仍要过结构校验，非法结构按可重试的 schema 失败处理。
      const validation = validateCandidate(result.content);

      if (!validation.ok) {
        const reason = validation.issues.map((issue) => issue.detail).join(' ');
        return schemaInvalidOutcome(input.attemptNumber, reason, result.content);
      }

      return {
        outcome: 'SUCCESS',
        resultRef: {
          kind: 'CONTENT',
          content: result.content,
          input_sha256: draftInputHash(manifest.payload, CANDIDATE_OUTPUT_SCHEMA),
          provider_request_id: result.providerRequestId,
          usage: {
            input_tokens: result.usage.inputTokens,
            output_tokens: result.usage.outputTokens,
            cache_read_tokens: result.usage.cacheReadTokens ?? null,
            cache_creation_tokens: result.usage.cacheCreationTokens ?? null,
          },
        },
      };
    }

    default:
      return { outcome: 'FAILED', reason: 'UNEXPECTED_MODEL_RESULT', evidence: { kind: 'UNKNOWN' } };
  }
}

/**
 * 落盘候选：round 0 建立该 Run 的唯一 Artifact 与 v1；修正轮（round ≥ 1）在同一 Artifact 上
 * 追加新版本，而不是新建第二个 Artifact（contracts/03 第 5 节：新版本未验证，旧版本历史结论保留）。
 */
async function executePersistCandidate(
  repositories: Repositories,
  input: ExecuteStepInput,
): Promise<StepExecution> {
  const content = await loadDraftContent(repositories, input.run.id, input.task.id);
  const contentBuffer = Buffer.from(content, 'utf8');

  if (contentBuffer.byteLength > MAX_MARKDOWN_BYTES) {
    return {
      outcome: 'FAILED',
      reason: 'CANDIDATE_TOO_LARGE',
      evidence: { kind: 'CANDIDATE_TOO_LARGE', size: contentBuffer.byteLength, limit: MAX_MARKDOWN_BYTES },
    };
  }

  const baseSourceRef = `run:${input.run.id}/${PERSIST_CANDIDATE_STEP_REF}`;
  const round = await countCorrectionRounds(await repositories.verifications.listSessionsByRun(input.run.id));
  const sourceRef =
    round === 0n ? baseSourceRef : `${baseSourceRef}/round:${toDecimalString(round)}`;
  const existing = await repositories.artifacts.findArtifactVersionBySourceRef({
    taskId: input.task.id,
    sourceRef,
  });

  if (existing !== undefined) {
    // 命中本轮的来源尝试 ID 即复用：不重复发布内容、也不新建版本（幂等）。
    return { outcome: 'SUCCESS', resultRef: versionResultRef(existing.artifact_id, existing) };
  }

  const baseVersion = await repositories.artifacts.findArtifactVersionBySourceRef({
    taskId: input.task.id,
    sourceRef: baseSourceRef,
  });

  if (round > 0n && baseVersion === undefined) {
    // 修正轮必须建立在已有候选之上；找不到 round 0 的版本说明步骤顺序被破坏。
    throw invalidTransition('修正轮找不到上一轮的候选版本，不能新建修正版本。', {
      taskId: input.task.id,
    });
  }

  const versionId = input.persist?.versionId ?? randomUUID();
  const versionNumber =
    baseVersion === undefined ? 1n : await nextVersionNumberLocked(repositories, baseVersion.artifact_id);
  const artifactId = input.persist?.artifactId ?? (baseVersion === undefined ? randomUUID() : baseVersion.artifact_id);
  if (input.persist === undefined || input.persist.sourceRef !== sourceRef ||
      (baseVersion !== undefined && input.persist.artifactId !== baseVersion.artifact_id)) {
    throw new Error('published effect no longer matches the locked candidate source');
  }
  const published = input.persist.published;
  const effect = await repositories.recovery.lockEffectByAttempt(input.persist.versionId);
  if (effect?.status !== 'SUCCEEDED' || effect.target_ref !== published.storageRef ||
      !effect.params_hash.equals(contentHashOf(contentBuffer))) {
    throw new Error('candidate publish effect is not reconciled for this attempt');
  }

  if (baseVersion !== undefined) {
    const previousVersion = (await repositories.artifacts.listArtifactVersions(artifactId)).at(-1);
    let textLocks: Awaited<ReturnType<typeof requireAiTextLocks>>;
    try {
      textLocks = await requireAiTextLocks(repositories, input.storage, artifactId, content);
    } catch (error) {
      if (!(error instanceof DomainError) || error.code !== 'INVALID_TRANSITION') throw error;
      const detail = error instanceof Error ? error.message : 'locked content cannot be mapped';
      await repositories.artifacts.recordTextLockConflict({ id: versionId,
        workspaceId: input.run.workspace_id, runId: input.run.id, taskId: input.task.id,
        artifactId, baseVersionId: previousVersion?.id ?? baseVersion.id, reason: detail });
      return { outcome: 'FAILED', reason: 'LOCKED_CONTENT_CONFLICT',
        evidence: { kind: 'LOCKED_CONTENT_CONFLICT',
          artifact_id: artifactId, base_version_id: previousVersion?.id ?? baseVersion.id,
          detail } };
    }
    const version = await repositories.artifacts.insertArtifactVersion({
      id: versionId,
      artifactId,
      versionNumber,
      storageRef: published.storageRef,
      contentHash: published.contentHash,
      size: published.size,
      mediaType: 'text/markdown',
      sourceKind: 'AI',
      sourceRef,
    });
    await advanceAiTextLocks(repositories, version.id, textLocks);
    if (previousVersion !== undefined) {
      await repositories.lineage.insertExactEdge({ workspaceId: input.run.workspace_id,
        childVersionId: version.id, relation: 'REVISED_FROM',
        parentKind: 'ARTIFACT_VERSION', parentId: previousVersion.id });
    }
    await repositories.lineage.insertExactEdge({ workspaceId: input.run.workspace_id,
      childVersionId: version.id, relation: 'GENERATED_BY',
      parentKind: 'RUN_STEP', parentId: input.step.id });

    return { outcome: 'SUCCESS', resultRef: versionResultRef(artifactId, version) };
  }

  const artifact = await repositories.artifacts.insertArtifact({
    id: artifactId,
    workspaceId: input.run.workspace_id,
    projectId: input.task.project_id,
    taskId: input.task.id,
    artifactKind: 'MARKDOWN_DOCUMENT',
    title: `${input.task.title}（候选）`,
  });

  const version = await repositories.artifacts.insertArtifactVersion({
    id: versionId,
    artifactId,
    versionNumber,
    storageRef: published.storageRef,
    contentHash: published.contentHash,
    size: published.size,
    mediaType: 'text/markdown',
    sourceKind: 'AI',
    sourceRef,
  });
  await repositories.lineage.insertExactEdge({ workspaceId: input.run.workspace_id,
    childVersionId: version.id, relation: 'GENERATED_BY',
    parentKind: 'RUN_STEP', parentId: input.step.id });

  return { outcome: 'SUCCESS', resultRef: versionResultRef(artifact.id, version) };
}

/** 新版本序号在 Artifact 行锁下分配（锁序 Task → Artifact，与人工追加版本一致）。 */
async function nextVersionNumberLocked(
  repositories: Repositories,
  artifactId: string,
): Promise<bigint> {
  const locked = await repositories.artifacts.lockArtifact(artifactId);

  if (locked === undefined) {
    throw new Error('artifact row disappeared while holding the task lock');
  }

  return repositories.artifacts.nextVersionNumber(artifactId);
}

function versionResultRef(artifactId: string, version: ArtifactVersionRow): JsonObject {
  return {
    artifact_id: artifactId,
    artifact_version_id: version.id,
    version_number: toDecimalString(version.version_number),
    sha256: version.content_hash.toString('hex'),
    size: toDecimalString(version.size),
  };
}

function schemaInvalidOutcome(attemptNumber: bigint, reason: string, raw: string): StepExecution {
  const evidence: JsonObject = { kind: 'SCHEMA_INVALID', reason, raw };

  // 纯生成最多 2 次基础设施重试（docs/architecture/runtime-context.md 第 2 节）；
  // 第 2 次仍失败才判定为不可恢复失败。
  if (attemptNumber < MAX_PURE_GENERATION_ATTEMPTS) {
    return { outcome: 'RETRYABLE', reason, evidence };
  }

  return { outcome: 'FAILED', reason, evidence };
}

async function applyRunTransitionBefore(
  repositories: Repositories,
  run: RunRow,
  step: RunStepRow,
): Promise<RunRow> {
  if (step.step_kind === 'BUILD_CONTEXT' && run.status === 'CREATED') {
    return advanceOrThrow(repositories, {
      runId: run.id,
      expectedRevision: run.revision,
      status: 'CONTEXT_BUILDING',
      currentStepId: step.id,
    });
  }

  // A read-first Gateway action has already moved PLANNING to RUNNING while
  // BUILD_CONTEXT remained the position. DRAFT still becomes the current step.
  if (step.step_kind === 'DRAFT' && (run.status === 'PLANNING' ||
      (run.status === 'RUNNING' && run.current_step_id !== step.id))) {
    return advanceOrThrow(repositories, {
      runId: run.id,
      expectedRevision: run.revision,
      status: 'RUNNING',
      currentStepId: step.id,
    });
  }

  return run;
}

async function applyRunTransitionAfter(
  repositories: Repositories,
  run: RunRow,
  step: RunStepRow,
  execution: Extract<StepExecution, { readonly outcome: 'SUCCESS' }>,
): Promise<RunRow> {
  switch (step.step_kind) {
    case 'BUILD_CONTEXT':
      return advanceOrThrow(repositories, {
        runId: run.id,
        expectedRevision: run.revision,
        status: 'PLANNING',
        currentStepId: step.id,
      });
    case 'DRAFT':
      // 非最终执行步骤成功仍停留在 RUNNING（契约 02 第 3 节）。
      return advanceOrThrow(repositories, {
        runId: run.id,
        expectedRevision: run.revision,
        status: 'RUNNING',
        currentStepId: step.id,
      });
    case 'PERSIST_CANDIDATE':
      // 候选产物已持久化，进入待验证，不写 DONE、不伪造 PASS。
      return advanceOrThrow(repositories, {
        runId: run.id,
        expectedRevision: run.revision,
        status: 'VERIFYING',
        currentStepId: step.id,
      });
    case 'VERIFY':
      // PASS/RETRY_CHECKER 保持 VERIFYING；HUMAN 转 WAITING_APPROVAL 并记录判定原因。
      return advanceOrThrow(repositories, {
        runId: run.id,
        expectedRevision: run.revision,
        status: execution.runStatus ?? 'VERIFYING',
        currentStepId: step.id,
        waitReason: execution.waitReason ?? null,
      });
    case 'COMPLETE':
      return advanceOrThrow(repositories, {
        runId: run.id,
        expectedRevision: run.revision,
        status: 'COMPLETED',
        currentStepId: step.id,
        terminal: true,
      });
    default:
      return run;
  }
}

/**
 * 修正回路（contracts/03 第 3 节“定向修正，提交新产物版本后再验证”）：
 * 登记 VERIFY 成功 → 把 BUILD_CONTEXT/DRAFT/PERSIST_CANDIDATE/VERIFY 重置为 PENDING →
 * Run 回到 RETRYING 并从 BUILD_CONTEXT 重新开始。不新建步骤行、不让步骤计划增长。
 */
async function scheduleCorrection(
  repositories: Repositories,
  input: {
    readonly run: RunRow;
    readonly runRow: RunRow;
    readonly step: RunStepRow;
    readonly runningStep: RunStepRow;
    readonly attempt: StepAttemptRow;
    readonly execution: Extract<StepExecution, { readonly outcome: 'CORRECTION' }>;
  },
): Promise<AdvanceRunStepResult> {
  const recorded = await repositories.runs.recordAttemptOutcome({
    attemptId: input.attempt.id,
    expectedClaimEpoch: input.attempt.claim_epoch,
    status: 'SUCCEEDED',
    resultRef: input.execution.resultRef,
    evidence: input.execution.evidence,
  });

  if (recorded === undefined) {
    return { status: 'STALE_RESULT', step_kind: input.step.step_kind };
  }

  const succeeded = await repositories.runs.advanceStep({
    stepId: input.step.id,
    expectedRevision: input.runningStep.revision,
    status: 'SUCCEEDED',
    resultRef: input.execution.resultRef,
  });

  if (succeeded === undefined) {
    throw new Error('run step success CAS failed while holding the run lock');
  }

  const steps = await repositories.runs.listSteps(input.run.id);
  const correctionSteps = steps.filter((candidate) =>
    CORRECTION_STEP_KINDS.includes(candidate.step_kind),
  );

  for (const candidate of correctionSteps) {
    const reset = await repositories.runs.resetStepToPending({
      stepId: candidate.id,
      expectedRevision: candidate.revision,
    });

    if (reset === undefined) {
      throw new Error('run step reset CAS failed while holding the run lock');
    }
  }

  const buildStep = correctionSteps.find((candidate) => candidate.step_kind === 'BUILD_CONTEXT');
  const sessionId = readString(input.execution.resultRef, 'session_id');

  if (sessionId === undefined) {
    throw new Error('correction result_ref is missing session_id');
  }

  const round = countCorrectionRounds(
    await repositories.verifications.listSessionsByRun(input.run.id),
  );

  const runRow = await advanceOrThrow(repositories, {
    runId: input.run.id,
    expectedRevision: input.runRow.revision,
    status: 'RETRYING',
    currentStepId: buildStep?.id ?? null,
    waitReason: readString(input.execution.evidence, 'reason') ?? null,
  });

  return {
    status: 'CORRECTION_SCHEDULED',
    step_kind: 'VERIFY',
    run_status: runRow.status,
    session_id: sessionId,
    correction_round: toDecimalString(round),
  };
}

async function failRun(
  repositories: Repositories,
  input: {
    readonly run: RunRow;
    readonly runRow: RunRow;
    readonly task: { readonly id: string; readonly revision: bigint; readonly project_id: string | null };
    readonly step: RunStepRow;
    readonly runningStep: RunStepRow;
    readonly attempt: StepAttemptRow;
    readonly execution: Extract<StepExecution, { readonly outcome: 'FAILED' }>;
  },
): Promise<AdvanceRunStepResult> {
  const recorded = await repositories.runs.recordAttemptOutcome({
    attemptId: input.attempt.id,
    expectedClaimEpoch: input.attempt.claim_epoch,
    status: 'FAILED',
    resultRef: input.execution.evidence,
    evidence: { reason: input.execution.reason },
  });

  if (recorded === undefined) {
    return { status: 'STALE_RESULT', step_kind: input.step.step_kind };
  }

  const failedStep = await repositories.runs.advanceStep({
    stepId: input.step.id,
    expectedRevision: input.runningStep.revision,
    status: 'FAILED',
    resultRef: input.execution.evidence,
  });

  if (failedStep === undefined) {
    throw new Error('run step failure CAS failed while holding the run lock');
  }

  await advanceOrThrow(repositories, {
    runId: input.run.id,
    expectedRevision: input.runRow.revision,
    status: 'FAILED',
    currentStepId: input.step.id,
    waitReason: input.execution.reason,
    terminal: true,
  });

  const released = await repositories.tasks.releaseExecutionFromRun({
    taskId: input.task.id,
    runId: input.run.id,
    expectedRevision: input.task.revision,
    toStatus: 'READY',
  });

  if (released === undefined) {
    throw new Error('task execution release CAS failed while holding the task lock');
  }

  await repositories.activities.insertActivityRecord({
    id: randomUUID(),
    workspaceId: input.run.workspace_id,
    runId: input.run.id,
    actorKind: 'AI',
    actorRef: `run:${input.run.id}`,
    commandId: null,
    projectId: input.task.project_id,
    taskId: input.task.id,
    eventType: 'RUN_FAILED',
    factRefs: {
      run_id: input.run.id,
      step_kind: input.step.step_kind,
      reason: input.execution.reason,
      attempt_number: toDecimalString(input.attempt.attempt_number),
      task_revision: toDecimalString(released.revision),
      ownership_epoch: toDecimalString(released.ownership_epoch),
    },
  });

  return {
    status: 'RUN_FAILED',
    step_kind: input.step.step_kind,
    reason: input.execution.reason,
    task_status: released.status,
  };
}

async function advanceOrThrow(repositories: Repositories, advance: RunAdvance): Promise<RunRow> {
  const row = await repositories.runs.advanceRun(advance);

  if (row === undefined) {
    throw new Error('run advance CAS failed while holding the run lock');
  }

  return row;
}

async function recordOwnershipMismatch(
  repositories: Repositories,
  run: RunRow,
  taskId: string,
  taskExecutorRunId: string | null,
  taskOwnershipEpoch: bigint,
): Promise<void> {
  await repositories.activities.insertActivityRecord({
    id: randomUUID(),
    workspaceId: run.workspace_id,
    runId: run.id,
    actorKind: 'SYSTEM',
    actorRef: `run:${run.id}`,
    commandId: null,
    projectId: null,
    taskId,
    eventType: 'RUN_OWNERSHIP_MISMATCH',
    factRefs: {
      run_id: run.id,
      run_ownership_epoch: toDecimalString(run.ownership_epoch),
      task_executor_run_id: taskExecutorRunId,
      task_ownership_epoch: toDecimalString(taskOwnershipEpoch),
    },
  });
}

async function loadManifestForDraft(
  repositories: Repositories,
  runId: string,
  taskId: string,
): Promise<{ readonly id: string; readonly payload: JsonObject }> {
  const buildStep = await repositories.runs.readStepByKind(runId, 'BUILD_CONTEXT');
  const manifestHashHex = readString(buildStep?.result_ref, 'manifest_hash');

  if (manifestHashHex === undefined) {
    throw invalidTransition('DRAFT 需要先成功构建上下文。', { taskId });
  }

  const manifest = await repositories.runs.readContextManifestByHash(
    runId,
    Buffer.from(manifestHashHex, 'hex'),
  );

  if (manifest === undefined) {
    throw invalidTransition('Run 的 Context Manifest 不可用。', { taskId });
  }

  const readEvidence = await loadRunReadEvidence(repositories, runId);
  return { id: manifest.id,
    payload: readEvidence === undefined ? manifest.payload :
      attachReadEvidenceWithinBudget(manifest.payload, readEvidence) };
}

async function loadDraftContent(
  repositories: Repositories,
  runId: string,
  taskId: string,
): Promise<string> {
  const draftStep = await repositories.runs.readStepByKind(runId, 'DRAFT');
  const content = readString(draftStep?.result_ref, 'content');

  if (content === undefined) {
    throw invalidTransition('PERSIST_CANDIDATE 需要先成功生成候选内容。', { taskId });
  }

  return content;
}

function readString(value: JsonValue | null | undefined, key: string): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }

  const field = (value as JsonObject)[key];

  return typeof field === 'string' ? field : undefined;
}

function isTerminalRunStatus(status: RunStatus): boolean {
  return status === 'COMPLETED' || status === 'FAILED' || status === 'CANCELLED';
}
