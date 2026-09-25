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
} from '../storage/managed-content-store.js';
import { toDecimalString } from '../shared/decimal.js';
import { invalidTransition, resourceNotFound, storageUnavailable } from './domain-error.js';
import { withTransaction, type Repositories } from './unit-of-work.js';
import type { RunAdvance } from '../run/run-repository.js';
import {
  buildContextFixture,
  type FakeScenario,
} from '../workflow/context-fixture.js';
import { FakeModelPort, type ModelPort } from '../workflow/fake-model-port.js';
import {
  ALL_EXECUTED_STEP_KINDS,
  CANDIDATE_OUTPUT_SCHEMA,
  validateCandidate,
} from '../workflow/markdown-deliverable.js';
import { evaluateCompletionGate, completeRun } from './complete-run.js';
import { countCorrectionRounds, loadCorrectionInput, verifyRun } from './verify-run.js';

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
  /** PERSIST_CANDIDATE 需要受管内容存储；P05 不写宿主路径。 */
  readonly storage: ManagedContentStore;
  readonly leaseMs?: number | undefined;
  /** 稳定来源尝试 ID；缺省为 `${stepKind}#${attemptNumber}`。 */
  readonly attemptKey?: string | undefined;
  /** 仅测试注入：决定 FakeModelPort 行为。 */
  readonly fakeScenario?: FakeScenario | undefined;
  readonly signal?: AbortSignal | undefined;
}

export type AdvanceRunStepResult =
  | { readonly status: 'RUN_TERMINAL'; readonly run_status: RunStatus }
  | { readonly status: 'STALE_OWNERSHIP'; readonly run_id: string }
  | { readonly status: 'NO_STEP'; readonly run_id: string }
  | { readonly status: 'STEP_NOT_IMPLEMENTED'; readonly step_kind: RunStepKind }
  | { readonly status: 'CLAIM_CONFLICT'; readonly step_kind: RunStepKind }
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

export async function advanceRunStep(
  db: DbExecutor,
  input: AdvanceRunStepInput,
): Promise<AdvanceRunStepResult> {
  const modelPort: ModelPort = new FakeModelPort();

  return withTransaction(db, async (repositories) => {
    const run = await repositories.runs.lockRun(input.runId);

    if (run === undefined) {
      throw resourceNotFound('Run');
    }

    if (isTerminalRunStatus(run.status)) {
      return { status: 'RUN_TERMINAL', run_status: run.status };
    }

    const task = await repositories.tasks.lockTask(run.task_id);

    if (task === undefined) {
      throw resourceNotFound('Task');
    }

    // Task 执行权与 Run 的 ownership_epoch 必须同时匹配：旧 Run 不得推进新执行者（契约 02 第 2 节）。
    if (task.executor_run_id !== run.id || task.ownership_epoch !== run.ownership_epoch) {
      await recordOwnershipMismatch(repositories, run, task.id, task.executor_run_id, task.ownership_epoch);

      return { status: 'STALE_OWNERSHIP', run_id: run.id };
    }

    const steps = await repositories.runs.listSteps(run.id);
    const step = steps.find((candidate) => candidate.status !== 'SUCCEEDED');

    if (step === undefined) {
      return { status: 'NO_STEP', run_id: run.id };
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
    const inserted = await repositories.runs.insertStepAttempt({
      id: randomUUID(),
      stepId: step.id,
      attemptNumber,
      attemptKey,
    });

    let attempt = inserted.row;

    if (!inserted.inserted) {
      // 稳定来源尝试 ID 命中已有尝试：结果去重，不重跑（B08 的去重前提）。
      if (attempt.status === 'SUCCEEDED' || attempt.status === 'FAILED') {
        return { status: 'REPLAYED', step_kind: step.step_kind, result_ref: attempt.result_ref };
      }

      if (attempt.status === 'REJECTED_STALE') {
        return { status: 'STALE_RESULT', step_kind: step.step_kind };
      }

      if (attempt.status === 'RUNNING' && attempt.worker_id !== input.workerId) {
        return { status: 'CLAIM_CONFLICT', step_kind: step.step_kind };
      }
    }

    if (attempt.status === 'PREPARED') {
      const claimed = await repositories.runs.claimAttempt({
        attemptId: attempt.id,
        workerId: input.workerId,
        leaseUntil: new Date(Date.now() + (input.leaseMs ?? DEFAULT_LEASE_MS)),
      });

      if (claimed === undefined) {
        return { status: 'CLAIM_CONFLICT', step_kind: step.step_kind };
      }

      attempt = claimed;
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

    let runRow = await applyRunTransitionBefore(repositories, run, step);

    const execution = await executeStep(repositories, {
      stepKind: step.step_kind,
      run,
      task,
      step,
      attemptNumber,
      storage: input.storage,
      modelPort,
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
        attempt_number: toDecimalString(attemptNumber),
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

    return {
      status: 'STEP_SUCCEEDED',
      step_kind: step.step_kind,
      run_status: runRow.status,
      result_ref: execution.resultRef,
    };
  });
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

    if (attempt.claim_epoch !== input.expectedClaimEpoch) {
      const rejected = await repositories.runs.markAttemptRejectedStale({
        attemptId: attempt.id,
        evidence: input.evidence,
      });

      return { accepted: false, attempt: rejected };
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
  readonly storage: ManagedContentStore;
  readonly modelPort: ModelPort;
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
  const contract = await repositories.runs.readContract(input.run.id);

  if (contract === undefined) {
    throw invalidTransition('Run 缺少冻结的执行契约，无法构建上下文。', {
      taskId: input.task.id,
    });
  }

  // 修正轮把上一轮失败证据装进 payload：round ≥ 1 时摘要随之变化，形成新的不可变 Manifest。
  const correction = await loadCorrectionInput(repositories, input.run.id);

  const fixture = buildContextFixture({
    taskId: input.task.id,
    taskTitle: input.task.title,
    contractSnapshot: contract.frozen_snapshot,
    ...(input.fakeScenario === undefined ? {} : { fakeScenario: input.fakeScenario }),
    ...(correction === undefined ? {} : { correction }),
  });

  const manifest = await repositories.runs.insertContextManifest({
    id: randomUUID(),
    runId: input.run.id,
    stepId: input.step.id,
    builderVersion: fixture.builderVersion,
    manifestHash: fixture.manifestHash,
    payload: fixture.payload,
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
          provider_request_id: result.providerRequestId,
          usage: {
            input_tokens: result.usage.inputTokens,
            output_tokens: result.usage.outputTokens,
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

  const versionId = randomUUID();
  const versionNumber =
    baseVersion === undefined ? 1n : await nextVersionNumberLocked(repositories, baseVersion.artifact_id);
  const artifactId = baseVersion === undefined ? randomUUID() : baseVersion.artifact_id;
  const published = await publishCandidate(input.storage, {
    artifactId,
    versionId,
    content: contentBuffer,
  });

  if (baseVersion !== undefined) {
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

  if (step.step_kind === 'DRAFT' && run.status === 'PLANNING') {
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
): Promise<{ readonly payload: JsonObject }> {
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

  return { payload: manifest.payload };
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

async function publishCandidate(
  storage: ManagedContentStore,
  input: { readonly artifactId: string; readonly versionId: string; readonly content: Buffer },
): Promise<{ readonly storageRef: string; readonly contentHash: Buffer; readonly size: bigint }> {
  try {
    return await storage.publish(input);
  } catch (error) {
    if (error instanceof StorageConflictError || error instanceof StorageUnavailableError) {
      throw storageUnavailable();
    }

    throw error;
  }
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
