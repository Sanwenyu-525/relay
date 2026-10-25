import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';

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
import { releaseComputerDesktopLeaseAtSafeBoundary } from './computer-desktop-lease.js';
import type { RunAdvance } from '../run/run-repository.js';
import { type FakeScenario } from '../workflow/context-fixture.js';
import { readFrozenRunActions } from '../workflow/execution-contract.js';
import { readPendingFrozenRunAction } from './frozen-run-actions.js';
import { attachReadEvidenceWithinBudget, draftInputHash, loadRunReadEvidence,
  ReadInputBudgetError } from './run-read-evidence.js';
import { buildRunContext, type BuiltContext } from './context-builder.js';
import { contextManifestMatchesCurrent, matchesTaskContext } from './context-fence.js';
import { FakeModelPort, type ModelPort } from '../workflow/fake-model-port.js';
import { ModelCallBudgetError, ModelSourcePolicyError }
  from '../workflow/openai-compatible-model-port.js';
import { resolveRunModelPort, type RunSemanticModel } from './run-model-port.js';
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
import { RunToolCallRepository } from '../run/run-tool-call-repository.js';
import { buildToolTurns, operationIdsOf, persistToolRound, resolveToolLoopPlan }
  from './tool-loop.js';
import { validateSafeRelativePath } from '../files/file-changeset.js';
import { MAX_PREVIEW_FILE_BYTES, ToolCallPreviewPublisher }
  from '../conversation-diff/tool-call-preview.js';
import type { RunToolCallRow } from '../infrastructure/database-schema.js';
import type { FakeToolScript, ModelToolTurn } from '../workflow/fake-model-port.js';
import type { ModelFetchDependencies } from '../workflow/model-endpoint-policy.js';

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
  /** 仅测试夹具可打开：允许显式冻结的 FakeSemanticChecker 运行。 */
  readonly testOnlyAllowFakeSemanticChecker?: boolean | undefined;
  /** 仅测试注入：使独立 Worker 的 Mock 模型保持在途。 */
  readonly fakeModelDelayMs?: number | undefined;
  /** 仅测试注入：FakeModelPort 逐轮发出的工具请求脚本；生产路径不包含它。 */
  readonly fakeToolScript?: FakeToolScript | undefined;
  /** 仅测试注入：Context token 上限。 */
  readonly contextBudgetTokens?: number | undefined;
  /**
   * 模型端口的环境来源；缺省 process.env。生产 Worker 不传，测试用它隔离真实进程环境。
   * 它只提供凭据/端点/预算的解析输入，模型身份仍由 Run 冻结契约决定。
   */
  readonly modelEnv?: NodeJS.ProcessEnv | undefined;
  /** 仅测试注入：受控 Provider fetch/lookup 接缝（与 Assist 同一形态）。 */
  readonly modelTransport?: ModelFetchDependencies | undefined;
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
  /** 模型工具循环有一个未决调用要派发；步骤 Attempt 保持原状，由图节点处理后回到 advance。 */
  | { readonly status: 'TOOL_LOOP_ACTION_REQUIRED'; readonly run_id: string;
      readonly tool_call_id: string }
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
    }
  /**
   * 预算耗尽：AI 需要用户决定是否给新预算、接手或停止（契约 02 第 3 节）。
   * 这不是执行失败——步骤失败原因与 Run 等待原因分别记录，执行权仍归 AI。
   */
  | {
      readonly status: 'BUDGET_EXHAUSTED';
      readonly step_kind: RunStepKind;
      readonly reason: string;
      readonly run_status: RunStatus;
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
      await repositories.toolCalls.rejectUndispatchedForTerminalRun(run.id, run.status);
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
    const pendingAction = await readPendingFrozenRunAction(repositories, run.id);
    const readAction = pendingAction !== undefined &&
      (pendingAction.action.kind === 'READ' || pendingAction.action.kind === 'WEB')
      ? pendingAction.action
      : frozen === undefined ? undefined : readFrozenRunActions(frozen).read;
    // 全部冻结动作都已 SUCCEEDED：本轮不再要求任何 Gateway 动作，直接推进候选产物。
    const gatewayActionSucceeded = pendingAction?.allSettled === true;
    const pendingIsRead = readAction !== undefined && readAction.operation_id === pendingAction?.actionId;
    // 读动作可在 DRAFT 之前发生；写与检查必须等 DRAFT 已成功，且仍在候选产物发布之前。
    const needsGatewayAction = pendingAction !== undefined && !gatewayActionSucceeded &&
      published?.status !== 'SUCCEEDED' &&
      (pendingIsRead
        ? draft?.status === 'SUCCEEDED' || built?.status === 'SUCCEEDED'
        : draft?.status === 'SUCCEEDED');
    let pendingReadAction = false;
    if (needsGatewayAction) {
      const actionOperationId = pendingAction!.actionId;
      const operation = pendingAction!.operation;
      const matchingStep = pendingIsRead
        ? operation?.step_id === built?.id ||
          // Legacy reads were bound to DRAFT. A correction may reset that
          // step, but the successful read must keep its old action identity.
          (operation?.step_id === draft?.id &&
            (draft?.status === 'SUCCEEDED' || operation?.status === 'SUCCEEDED'))
        : operation?.step_id === draft?.id;
      if (operation !== undefined && (operation.run_id !== run.id || !matchingStep)) {
        throw invalidTransition('Gateway 操作身份与冻结 Run 不匹配。');
      }
      if (operation?.status === 'UNKNOWN' || operation?.status === 'DISPATCHING') {
        return { status: 'ACTION_UNKNOWN', run_id: run.id, operation_id: actionOperationId };
      }
      if (operation?.status === 'DENIED' || operation?.status === 'FAILED') {
        return { status: 'GATEWAY_ACTION_DENIED', run_id: run.id, operation_id: actionOperationId };
      }
      pendingReadAction = pendingIsRead && draft?.status !== 'SUCCEEDED';
      if (!pendingReadAction) {
        return { status: 'GATEWAY_ACTION_REQUIRED', run_id: run.id, operation_id: actionOperationId };
      }
    }
    // 模型工具循环的未决调用在领取步骤 Attempt 之前交回图节点：Gateway 的 ASK 会释放
    // Worker claim 并把 Run 置为 WAITING_APPROVAL，那不能发生在步骤结算事务里。
    const pendingToolCall = (await new RunToolCallRepository(db).listPending(run.id))[0];
    if (pendingToolCall !== undefined) {
      return { status: 'TOOL_LOOP_ACTION_REQUIRED', run_id: run.id,
        tool_call_id: pendingToolCall.id };
    }
    // Compatibility: older builds could mark an UNKNOWN tool row SETTLED. Check
    // authoritative operations before attempting to reclaim or generate a new draft.
    // ACTION_UNKNOWN 只能由「可能已经产生外部效果」的动作触发，也就是 Operation 本身处于
    // DISPATCHING/UNKNOWN。PREPARED 与 WAITING_APPROVAL 从未派发：把它们投影成未知，会让一个
    // 已证明零副作用的确定性拒绝看起来仍需人工核对，并把 Run 挂成等待停机证据。
    for (const operation of await repositories.gateway.listUnresolvedRunOperations(run.id)) {
      if (!['DISPATCHING', 'UNKNOWN'].includes(operation.status)) continue;
      if (await repositories.toolCalls.readByOperation(run.id, operation.id) !== undefined) {
        return { status: 'ACTION_UNKNOWN', run_id: run.id, operation_id: operation.id };
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
        operation_id: pendingAction!.actionId };
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
  if (prepared.kind !== 'READY') {
    // UNKNOWN 与工具派发都不在本次提交里结算。两者都先释放 Worker claim：
    // 下一次 Gateway 动作必须按既有 RUN 领取协议重新领取，不能沿用步骤的 claim。
    const current = await withTransaction(db, async (repositories) => {
      const { run } = await lockTaskAndRun(repositories, input.runId);
      if (input.invocationEpoch !== undefined &&
          !(await repositories.dispatch.hasCurrentInvocation(run.id, input.workerId, input.invocationEpoch))) {
        return false;
      }
      if (run.worker_id === input.workerId && run.worker_epoch === claim.workerEpoch) {
        await repositories.runs.releaseWorker(run.id, input.workerId, claim.workerEpoch);
        await repositories.computerDesktopLease.unbindWorker({ runId: run.id,
          workerId: input.workerId, workerEpoch: claim.workerEpoch });
        await releaseComputerDesktopLeaseAtSafeBoundary(repositories, run.id);
      }
      return true;
    });
    if (!current) return { status: 'INVOCATION_LOST', run_id: claim.run.id };
    if (prepared.kind === 'UNKNOWN') {
      return { status: 'ACTION_UNKNOWN', run_id: claim.run.id, operation_id: prepared.operationId };
    }
    // 步骤 Attempt 保持 RUNNING：工具派发由图节点完成，之后回到这里续跑同一 Attempt。
    return { status: 'TOOL_LOOP_ACTION_REQUIRED', run_id: claim.run.id,
      tool_call_id: prepared.toolCallId };
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
    if (prepared.toolLoopStop !== undefined) {
      // 停止点不进入 executeStep：模型端口回放的仍是工具请求，让它跑一遍只会得到
      // UNEXPECTED_MODEL_RESULT，把真实原因掩盖成「模型返回了意外结果」。
      return await parkRunForToolLoopStop(repositories, {
        run, runRow, task, step, runningStep, attempt, stop: prepared.toolLoopStop });
    }
    const execution = prepared.preflightFailure ?? await executeStep(repositories, {
      stepKind: step.step_kind, run, task, step, attemptNumber: attempt.attempt_number,
      stepAttemptId: attempt.id, modelCallDb: db,
      storage: prepared.storage, modelPort: prepared.modelPort,
      ...(prepared.persist === undefined ? {} : { persist: prepared.persist }),
      ...(prepared.context === undefined ? {} : { context: prepared.context }),
      ...(prepared.semanticChecks === undefined ? {} :
        { precomputedChecks: prepared.semanticChecks }),
      ...(prepared.semanticModel === undefined ? {} :
        { semanticModel: prepared.semanticModel }),
      ...(input.fakeScenario === undefined ? {} : { fakeScenario: input.fakeScenario }),
      ...(input.testOnlyAllowFakeSemanticChecker === true
        ? { testOnlyAllowFakeSemanticChecker: true } : {}),
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
        await repositories.computerDesktopLease.unbindWorker({ runId: run.id,
          workerId: input.workerId, workerEpoch: claim.workerEpoch });
        await releaseComputerDesktopLeaseAtSafeBoundary(repositories, run.id);
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
    await repositories.computerDesktopLease.unbindWorker({ runId: run.id,
      workerId: input.workerId, workerEpoch: claim.workerEpoch });
  });
}

interface PreparedPersist {
  readonly artifactId: string;
  readonly versionId: string;
  readonly sourceRef: string;
  readonly published: PublishedContent;
}

/**
 * 工具循环停在等待点的实测事实。
 *
 * 只记录真实结算出来的数字与真实的拒绝原因：模型「还想继续」这件事本身不是事实，
 * 因此不作为停止理由写进来——判据是这一轮没有任何请求可以派发，且全部拒绝都表示
 * 「再试一次也不会不同」。
 */
interface ToolLoopStop {
  readonly reason: 'TOOL_LOOP_BUDGET_EXHAUSTED' | 'TOOL_ADAPTATION_REQUIRES_HUMAN';
  readonly wait_reason: 'REPEATED_FAILURE' | 'HUMAN_TOOL';
  readonly rounds_used: number;
  readonly max_rounds: number;
  readonly calls_used: number;
  readonly max_tool_calls: number;
  readonly rejected: number;
  readonly rejections: readonly string[];
}

/**
 * 「再试一次也不会不同」的拒绝原因。
 *
 * 预算类原因意味着模型已经没有任何可执行空间；冲突适配类原因按产品规则必须停下来让
 * 用户看差异。参数非法、未知工具、越界路径这些是**可修正**的：模型需要再取一轮反馈
 * 才能改对，把它们当成终止条件会让一次笔误直接烧掉整个 Run。
 */
const TERMINAL_TOOL_REJECTIONS: ReadonlySet<string> = new Set([
  'TOOL_LOOP_ROUNDS_EXHAUSTED', 'TOOL_LOOP_BUDGET_EXHAUSTED',
  'TOOL_ADAPTATION_REQUIRES_HUMAN', 'TOOL_ADAPTATION_AMBIGUOUS',
  'TOOL_ADAPTATION_TARGET_MISSING',
]);

function toolLoopStopFor(reason: string,
  detail: Omit<ToolLoopStop, 'reason' | 'wait_reason'>): ToolLoopStop {
  return reason === 'TOOL_ADAPTATION_REQUIRES_HUMAN'
    ? { ...detail, reason: 'TOOL_ADAPTATION_REQUIRES_HUMAN', wait_reason: 'HUMAN_TOOL' }
    : { ...detail, reason: 'TOOL_LOOP_BUDGET_EXHAUSTED', wait_reason: 'REPEATED_FAILURE' };
}

type PreparedExternalWork =
  | { readonly kind: 'UNKNOWN'; readonly operationId: string }
  /** 模型请求了工具：本步骤 Attempt 保持 RUNNING，交出 Worker，由图节点派发后回到这里续跑。 */
  | { readonly kind: 'TOOL_DISPATCH_REQUIRED'; readonly toolCallId: string }
  | { readonly kind: 'READY'; readonly storage: ManagedContentStore;
      readonly modelPort: ModelPort; readonly persist?: PreparedPersist;
      readonly context?: BuiltContext;
      readonly semanticChecks?: ReadonlyMap<string, PreparedSemanticCheck>;
      /** 冻结计划解析出的语义模型；缺省表示旧 Run 用 registry 的进程默认检查器。 */
      readonly semanticModel?: RunSemanticModel;
      readonly preflightFailure?: Extract<StepExecution, { readonly outcome: 'FAILED' }>;
      readonly toolLoopStop?: ToolLoopStop };

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
  // P0-1：执行端模型身份只来自 Run 冻结的执行契约，不读进程默认模型。
  const admission = await resolveRunModelPort(db, {
    run: claim.run,
    contract: await repositories.runs.readContract(claim.run.id),
    env: input.modelEnv ?? process.env,
    ...(input.modelTransport === undefined ? {} : { transport: input.modelTransport }),
  });
  let modelPort: ModelPort = admission.kind === 'READY'
    ? admission.port : new FakeModelPort(input.fakeModelDelayMs);
  let persist: PreparedPersist | undefined;
  let context: BuiltContext | undefined;
  let semanticChecks: ReadonlyMap<string, PreparedSemanticCheck> | undefined;
  let preflightFailure: Extract<StepExecution, { readonly outcome: 'FAILED' }> | undefined;
  let toolDispatch: { readonly toolCallId: string } | undefined;
  let toolLoopStop: ToolLoopStop | undefined;
  const reads = new Map<string, { hashHex: string; size: bigint; result: ContentReadResult }>();

  if (claim.step.step_kind === 'BUILD_CONTEXT') {
    const correction = await loadCorrectionInput(repositories, claim.run.id);
    context = await buildRunContext(db, { run: claim.run, task: claim.task, storage: input.storage,
      // 冻结计划指向真实模型时，取材口径按真实模型执行；停止态仍按冻结意图取材，
      // 不因为此刻配置不可用就把上下文改成 Mock 口径。
      externalModel: admission.kind === 'READY' ? admission.external : true,
      ...(input.fakeScenario === undefined ? {} : { fakeScenario: input.fakeScenario }),
      ...(input.fakeToolScript === undefined ? {} : { fakeToolScript: input.fakeToolScript }),
      ...(input.contextBudgetTokens === undefined ? {} : { budgetTokens: input.contextBudgetTokens }),
      ...(correction === undefined ? {} : { correction }) });
  }

  if (claim.step.step_kind === 'DRAFT') {
    if (admission.kind === 'STOPPED') {
      // 冻结模型不可执行就明确停止：不回退默认模型、不回退 Fake、不发起替代外呼。
      preflightFailure = { outcome: 'FAILED', reason: admission.reason,
        evidence: admission.evidence };
    }
    let manifest: Awaited<ReturnType<typeof loadManifestForDraft>> | undefined;
    try { manifest = await loadManifestForDraft(repositories, claim.run.id, claim.task.id); }
    catch (error) {
      if (!(error instanceof ReadInputBudgetError)) throw error;
      preflightFailure = { outcome: 'FAILED', reason: 'CONTEXT_REQUIRED_OVER_BUDGET',
        evidence: { reason: 'CONTEXT_REQUIRED_OVER_BUDGET', source: 'GATEWAY_READ' } };
    }
    if (manifest !== undefined && preflightFailure === undefined) {
      const currentPort = modelPort;
      const readEvidence = await loadRunReadEvidence(repositories, claim.run.id);
      const toolRepository = new RunToolCallRepository(db);
      const toolPlan = await resolveToolLoopPlan(db, claim.run.id, claim.run.workspace_id);
      let toolRows = toolPlan === undefined ? [] : await toolRepository.listByAttempt(claim.attempt.id);
      const inputHash = draftInputHash(manifest.payload, CANDIDATE_OUTPUT_SCHEMA);
      let previewEnabled = true;
      try {
        // 每一轮「无可派发请求」都在同一次 prepare 内再问一次模型：可修正的拒绝要把
        // 类型化原因回传，收尾轮则给模型用已有结果作答的机会。硬上界取信封的轮次预算
        // 再加一次收尾——超过它 persistToolRound 只会产生终止类拒绝。
        // 每一次模型调用仍是一行 model_calls；工具轮次的历史从已落库的行重建，
        // 因此恢复与正常推进走同一条路径，不依赖进程内存里的对话。
        const maxTurns = (toolPlan?.intent.max_rounds ?? 0) + 2;
        // 终止原因取本次 prepare 里**第一个**终止类拒绝，而不是最后一次：模型的意图会变，
        // 但「它为什么开始收尾」是那一次真实拒绝决定的。
        let firstTerminal: string | undefined;
        let terminalRejections: string[] = [];
        let lastRound = 0;
        let lastUsedCalls = 0;
        let lastAccepted = 0;
        for (let turn = 0; turn < maxTurns; turn += 1) {
          const round = toolRows.length === 0 ? 0
            : Math.max(...toolRows.map((row) => row.round)) + 1;
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
              const toolTurns = toolPlan === undefined ? [] : await loadSettledToolTurns(db, toolRows);
              // 生成中的只读预览通道（工作台 §34.4 / CD-09–11）：只给 APPLY_CHANGESET 类
              // 工具建发布器，逐工具序号隔离；任何预览失败都不改变模型调用与后续执行。
              const toolPreviews = new Map<number, ToolCallPreviewPublisher>();
              let generated: Awaited<ReturnType<typeof currentPort.generate>>;
              try {
                generated = await currentPort.generate({ manifest: manifest.payload,
                outputSchema: CANDIDATE_OUTPUT_SCHEMA,
                  ...(toolPlan === undefined ? {} : { tools: toolPlan.specs, toolTurns }),
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
                  },
                  onToolArgumentsDelta: async (delta) => {
                    const plan = toolPlan;
                    if (plan === undefined) return;
                    if (plan.allowed.get(delta.name)?.actionType !== 'APPLY_CHANGESET') return;
                    let publisher = toolPreviews.get(delta.toolIndex);
                    if (publisher === undefined) {
                      publisher = new ToolCallPreviewPublisher({ repositories,
                        sink: { workspaceId: claim.run.workspace_id, runId: claim.run.id,
                          modelCallId: callId, ordinal: delta.toolIndex },
                        toolName: delta.name,
                        readFile: (relativePath) => readManagedPreviewFile(
                          plan.canonicalRoot, relativePath) });
                      toolPreviews.set(delta.toolIndex, publisher);
                    }
                    await publisher.feed(delta.argumentsText);
                  } });
                if (generated.kind !== 'CANCELLED' && previewEnabled) {
                  try { await preview.flush(); }
                  catch (error) {
                    if (!(error instanceof AssistPreviewOwnershipLostError)) {
                      throw new RunDraftPreviewWriteError();
                    }
                  }
                }
              } finally {
                // 生成结束即撤下临时预览：工具行的「执行中/已修改」随后接管这一位置。
                // 清理失败也只影响展示：读接口按模型调用状态过滤已结算调用的残留预览。
                for (const publisher of toolPreviews.values()) await publisher.flush();
                await deleteToolCallPreviews(repositories, claim.run.workspace_id, callId);
              }
              return generated;
            },
            settle: (result) => {
              if (result.kind === 'CANCELLED') {
                return { status: 'CANCELLED', providerRequestId: result.providerRequestId ?? null,
                  ...(result.usage === undefined ? {} : { usage: result.usage }) };
              }
              // Provider request id 与已知用量对所有非取消结果都保留；缺失的保持 null 而不是补零。
              if (result.kind === 'CONTENT' || result.kind === 'TOOL_CALLS') {
                return { status: 'COMPLETED', providerRequestId: result.providerRequestId,
                  usage: result.usage };
              }
              return { status: 'COMPLETED' };
            },
          });
          modelPort = { identity: currentPort.identity, generate: async () => recorded.result };
          if (toolPlan !== undefined && recorded.result.kind === 'TOOL_CALLS') {
            // 工具请求先落库再交给图节点派发：行 id 就是后续动作身份，重放不会产生第二次动作。
            const usedCalls = await toolRepository.countByRun(claim.run.id);
            const persisted = await persistToolRound(db, {
              workspaceId: claim.run.workspace_id, projectId: toolPlan.projectId,
              runId: claim.run.id, stepId: claim.step.id, stepAttemptId: claim.attempt.id,
              modelCallId: recorded.callId, round, calls: recorded.result.calls, plan: toolPlan,
              preamble: recorded.result.preamble, reasoningContent: recorded.result.reasoningContent,
              usedCalls,
              cancelled: input.signal?.aborted === true });
            const dispatchable = persisted.rows.find((row) => row.status === 'REQUESTED');
            if (dispatchable !== undefined) {
              toolDispatch = { toolCallId: dispatchable.id };
              break;
            }
            if (persisted.rejected === 0) break;
            // 本轮没有任何请求可以派发，且全部带类型化原因：刷新后才知道拒绝的是什么。
            toolRows = await toolRepository.listByAttempt(claim.attempt.id);
            const rejections = toolRows.filter((row) => row.round === round).map((row) =>
              typeof row.result_ref?.reason === 'string' ? row.result_ref.reason
                : 'TOOL_REQUEST_REJECTED');
            lastRound = round;
            lastUsedCalls = usedCalls;
            lastAccepted = persisted.rows.length - persisted.rejected;
            if (!rejections.every((reason) => TERMINAL_TOOL_REJECTIONS.has(reason))) {
              // 可修正的拒绝：把类型化原因回传，让模型自己改对，而不是替它判定失败。
              continue;
            }
            firstTerminal ??= rejections[0];
            terminalRejections = [...terminalRejections, ...rejections];
            if (turn === 0) continue;
            toolLoopStop = toolLoopStopFor(firstTerminal ?? 'TOOL_LOOP_BUDGET_EXHAUSTED', {
              rounds_used: lastRound + 1,
              max_rounds: toolPlan.intent.max_rounds,
              calls_used: lastUsedCalls + lastAccepted,
              max_tool_calls: toolPlan.intent.max_tool_calls,
              rejected: terminalRejections.length, rejections: terminalRejections });
            break;
          } else {
            break;
          }
        }
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
    const preparedChecks = await prepareSemanticChecks(db, {
      run: claim.run, task: claim.task, storage: input.storage,
      stepAttemptId: claim.attempt.id,
      ...(admission.kind === 'READY' && admission.semantic !== undefined
        ? { semanticModel: admission.semantic } : {}),
      ...(admission.kind === 'STOPPED'
        ? { modelStop: { reason: admission.reason, evidence: admission.evidence } } : {}),
      ...(input.fakeScenario === undefined ? {} : { fakeScenario: input.fakeScenario }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    semanticChecks = preparedChecks.checks;
    if (preparedChecks.stop !== undefined && preflightFailure === undefined) {
      // 冻结模型不可执行而本 Run 的验收需要语义模型：明确停止，不换模型、不降级为人工证据。
      preflightFailure = { outcome: 'FAILED', reason: preparedChecks.stop.reason,
        evidence: preparedChecks.stop.evidence };
    }
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

  if (toolDispatch !== undefined) return { kind: 'TOOL_DISPATCH_REQUIRED', ...toolDispatch };

  return { kind: 'READY', modelPort,
    storage: new PreloadedContentStore(input.storage.dataRoot, reads),
    ...(persist === undefined ? {} : { persist }),
    ...(context === undefined ? {} : { context }),
    ...(semanticChecks === undefined ? {} : { semanticChecks }),
    ...(admission.kind === 'READY' && admission.semantic !== undefined
      ? { semanticModel: admission.semantic } : {}),
    ...(preflightFailure === undefined ? {} : { preflightFailure }),
    ...(toolLoopStop === undefined ? {} : { toolLoopStop }) };
}

/**
 * 从已落库的工具行重建模型需要的轮次消息。
 *
 * 工具结果取自该行对应 Operation 的 result_ref，而不是重新执行动作：成功读取的证据
 * 在恢复后仍是同一份。UNKNOWN 的动作不会出现在这里——它还没结算，模型不会拿到编造的结果。
 */
async function loadSettledToolTurns(db: DbExecutor,
  rows: readonly RunToolCallRow[]): Promise<readonly ModelToolTurn[]> {
  const results = new Map<string, JsonObject>();
  for (const operationId of operationIdsOf(rows)) {
    const operation = await createRepositories(db).gateway.readOperation(operationId);
    if (operation?.result_ref !== null && operation?.result_ref !== undefined) {
      results.set(operationId, operation.result_ref);
    }
  }
  return buildToolTurns(rows, results);
}

/**
 * 生成中预览的只读文本获取：受管根内、非保护路径、且不超过预览上限。
 *
 * 任何不可读（逃逸/保护路径/目录/超限/IO 失败）都返回 null——该文件预览记「待核对」，
 * 真实写入仍走原 Gateway 校验；这里不读、不缓存、不写任何东西。
 */
async function readManagedPreviewFile(rootPath: string,
  relativePath: string): Promise<string | null> {
  let absolute: string;
  try {
    absolute = validateSafeRelativePath(rootPath, relativePath);
  } catch {
    return null;
  }
  try {
    const info = await stat(absolute);
    if (!info.isFile() || info.size > MAX_PREVIEW_FILE_BYTES) return null;
    return await readFile(absolute, 'utf8');
  } catch {
    return null;
  }
}

/** 生成结束后的预览清理；失败只影响展示，不改变模型调用结果与执行。 */
async function deleteToolCallPreviews(repositories: Repositories, workspaceId: string,
  modelCallId: string): Promise<void> {
  try {
    await repositories.toolCallPreview.deleteForCall(workspaceId, modelCallId);
  } catch {
    // 预览是可丢弃证据：清理失败留给读接口按模型调用状态过滤。
  }
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
  readonly semanticModel?: RunSemanticModel | undefined;
  readonly fakeScenario?: FakeScenario | undefined;
  readonly testOnlyAllowFakeSemanticChecker?: boolean | undefined;
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
        ...(input.semanticModel === undefined ? {} : { semanticModel: input.semanticModel }),
        ...(input.fakeScenario === undefined ? {} : { fakeScenario: input.fakeScenario }),
        ...(input.testOnlyAllowFakeSemanticChecker === true
          ? { testOnlyAllowFakeSemanticChecker: true } : {}),
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

/**
 * 工具循环停在等待点：预算耗尽或冲突需要人工，把决定权交回用户（契约 02 第 3 节）。
 *
 * 三件事必须同时成立，缺一件就退化成「AI 悄悄重试到死」或「记成执行失败」：
 * 步骤 Attempt 以类型化原因失败（真实原因可追溯）；Run 进入等待并带对应等待原因；
 * Task 转 WAITING 但执行权仍归 AI，用户可选择新预算、接手或停止。
 *
 * 这里刻意不创建 Review：工具循环预算冻结在 Run 契约信封里，「给同一个 Run 加预算」与冻结
 * 信封冲突；RETRY_BUDGET 决定分支又强绑验证 session 与产物版本，复用会造出假关联。
 * 「新预算」只能由新委托（新 Run 带更大信封）实现，因此不需要一个没有真实决定的等待项。
 */
async function parkRunForToolLoopStop(
  repositories: Repositories,
  input: {
    readonly run: RunRow;
    readonly runRow: RunRow;
    readonly task: { readonly id: string; readonly revision: bigint; readonly project_id: string | null };
    readonly step: RunStepRow;
    readonly runningStep: RunStepRow;
    readonly attempt: StepAttemptRow;
    readonly stop: ToolLoopStop;
  },
): Promise<AdvanceRunStepResult> {
  const evidence: JsonObject = { reason: input.stop.reason,
    rounds_used: String(input.stop.rounds_used), max_rounds: input.stop.max_rounds,
    calls_used: input.stop.calls_used, max_tool_calls: input.stop.max_tool_calls,
    rejected: input.stop.rejected, rejections: [...input.stop.rejections] };
  const recorded = await repositories.runs.recordAttemptOutcome({
    attemptId: input.attempt.id,
    expectedClaimEpoch: input.attempt.claim_epoch,
    status: 'FAILED',
    resultRef: evidence,
    evidence: { reason: input.stop.reason },
  });
  if (recorded === undefined) return { status: 'STALE_RESULT', step_kind: input.step.step_kind };
  const failedStep = await repositories.runs.advanceStep({
    stepId: input.step.id,
    expectedRevision: input.runningStep.revision,
    status: 'FAILED',
    resultRef: evidence,
  });
  if (failedStep === undefined) {
    throw new Error('run step failure CAS failed while holding the run lock');
  }
  const parked = await advanceOrThrow(repositories, {
    runId: input.run.id,
    expectedRevision: input.runRow.revision,
    status: 'WAITING_APPROVAL',
    currentStepId: input.step.id,
    waitReason: input.stop.wait_reason,
    resumePhase: 'RUNNING',
  });
  let taskStatus: TaskStatus = 'WAITING';
  // 等待不转移执行权：Task 变 WAITING，但 executor_run_id 与 ownership_epoch 不动。
  // 已经是等待态时不重复改写，只按当前事实返回。
  const currentTask = await repositories.tasks.readTask(input.task.id);
  if (currentTask?.status === 'IN_PROGRESS') {
    const waiting = await repositories.tasks.applyTaskStatus({ taskId: currentTask.id,
      expectedRevision: currentTask.revision, fromStatus: 'IN_PROGRESS', toStatus: 'WAITING' });
    if (waiting === undefined) throw new Error('tool loop wait Task CAS failed');
  } else if (currentTask !== undefined) {
    taskStatus = currentTask.status;
  }
  await repositories.activities.insertActivityRecord({
    id: randomUUID(),
    workspaceId: input.run.workspace_id,
    runId: input.run.id,
    actorKind: 'SYSTEM',
    actorRef: `run:${input.run.id}`,
    commandId: null,
    projectId: input.task.project_id,
    taskId: input.task.id,
    eventType: 'RUN_WAITING_TOOL_LOOP',
    factRefs: { run_id: input.run.id, step_kind: input.step.step_kind,
      reason: input.stop.reason, wait_reason: input.stop.wait_reason,
      attempt_number: toDecimalString(input.attempt.attempt_number),
      rounds_used: String(input.stop.rounds_used), max_rounds: input.stop.max_rounds,
      calls_used: input.stop.calls_used, max_tool_calls: input.stop.max_tool_calls },
  });
  return {
    status: 'BUDGET_EXHAUSTED',
    step_kind: input.step.step_kind,
    reason: input.stop.reason,
    run_status: parked.status,
    task_status: taskStatus,
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
  if (isTerminalRunStatus(row.status)) {
    await releaseComputerDesktopLeaseAtSafeBoundary(repositories, row.id);
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
