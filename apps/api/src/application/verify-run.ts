import { randomUUID } from 'node:crypto';

import type {
  RunRow,
  TaskRow,
  VerificationSessionRow,
} from '../infrastructure/database-schema.js';
import type { JsonObject } from '../infrastructure/json.js';
import type { ManagedContentStore } from '../storage/managed-content-store.js';
import { evidenceUnavailable, invalidTransition } from './domain-error.js';
import type { StepExecution } from './run-steps.js';
import type { Repositories } from './unit-of-work.js';
import {
  buildCheckPlan,
  checkPlanHash,
  planFromFrozenSnapshot,
  planToJson,
} from '../workflow/check-plan.js';
import { hasChecker, resolveCheckerForScenario } from '../workflow/checkers.js';
import type { ContextCorrectionInput, FakeScenario } from '../workflow/context-fixture.js';
import { computeVerdict, DEFAULT_CORRECTION_BUDGET } from '../workflow/verdict.js';
import { createVerificationReviews } from './review-requests.js';

/**
 * VERIFY 步骤（contracts/03-verification-and-approval.md 第 3–5 节、
 * docs/architecture/runtime-context.md 第 4 节）。
 *
 * 边界：
 *   * CheckPlan 由冻结执行契约与内置 registry 派生，Worker 无写权；缺 checker 时不静默降级为建议；
 *   * 证据先核对（受管内容存在且 hash/size 一致），不一致直接 EVIDENCE_UNAVAILABLE，不写任何检查结果；
 *   * 检查结果只追加，历史不可改写；session 的 status/verdict 只在总决策时一次写入；
 *   * RETRY_CHECKER 不 finalize（保留未决），下一次推进只重跑检查器；
 *   * 本模块不写 Task DONE、不写 Run 终态：Run 目标状态只作为返回值交给 Workflow 生命周期。
 */

export interface VerifyRunInput {
  readonly run: RunRow;
  readonly task: TaskRow;
  readonly storage: ManagedContentStore;
  readonly fakeScenario?: FakeScenario | undefined;
}

export async function verifyRun(
  repositories: Repositories,
  input: VerifyRunInput,
): Promise<StepExecution> {
  const contract = await repositories.runs.readContract(input.run.id);

  if (contract === undefined) {
    throw invalidTransition('Run 缺少冻结的执行契约，无法验证候选。', {
      taskId: input.task.id,
    });
  }

  const plan = buildCheckPlan(planFromFrozenSnapshot(contract.frozen_snapshot));
  const planHash = checkPlanHash(plan);

  // 规则 enforcement 与可用 checker 不匹配时不降级为建议：直接判为不可执行的步骤失败。
  for (const entry of plan.entries) {
    if (!hasChecker(entry.checkerId, entry.checkerVersion)) {
      return {
        outcome: 'FAILED',
        reason: 'CHECKER_NOT_REGISTERED',
        evidence: {
          criterion_id: entry.criterionId,
          checker_id: entry.checkerId,
          checker_version: entry.checkerVersion,
        },
      };
    }
  }

  const target = await loadVerifiedTarget(repositories, input);

  const sessions = await repositories.verifications.listSessionsByRun(input.run.id);
  const open = sessions.find((session) => session.status === 'OPEN');
  const session =
    open ??
    (await repositories.verifications.insertSession({
      id: randomUUID(),
      taskId: input.task.id,
      acceptanceRevision: contract.acceptance_revision,
      runId: input.run.id,
      executionContractId: input.run.id,
      verifierPolicyVersion: plan.policyVersion,
      checkPlanHash: planHash,
      checkPlan: planToJson(plan),
      // 已用预算 = 该 Run 已 finalize 为 RETRY 的 session 数（同一 Run 的修正轮次）。
      correctionBudgetUsed: countCorrectionRounds(sessions),
      parentSessionId: sessions.at(-1)?.id ?? null,
    }));

  await repositories.verifications.insertTarget({
    sessionId: session.id,
    artifactVersionId: target.versionId,
    contentHash: target.contentHash,
  });

  const history = await repositories.verifications.listCheckResults(session.id);

  for (const entry of plan.entries) {
    const previousAttempts = history
      .filter((row) => row.criterion_id === entry.criterionId)
      .map((row) => row.check_attempt);
    const checkAttempt = previousAttempts.length === 0 ? 1 : Math.max(...previousAttempts) + 1;
    const checker = resolveCheckerForScenario(entry, input.fakeScenario);
    const outcome = checker.check({
      entry,
      content: target.content,
      artifactVersionId: target.versionId,
      contentHashHex: target.contentHash.toString('hex'),
      ...(input.fakeScenario === undefined ? {} : { fakeScenario: input.fakeScenario }),
    });

    await repositories.verifications.insertCheckResult({
      id: randomUUID(),
      sessionId: session.id,
      criterionId: entry.criterionId,
      checkAttempt,
      checkerId: entry.checkerId,
      checkerVersion: entry.checkerVersion,
      result: outcome.result,
      required: entry.required,
      severity: entry.severity,
      evidenceRefs: outcome.evidence,
    });
  }

  const latest = await repositories.verifications.listLatestCheckResults(session.id);
  const correctionBudget = (await repositories.reviews.readCorrectionBudget(input.run.id))?.max_corrections ?? DEFAULT_CORRECTION_BUDGET;
  const verdict = computeVerdict({
    plan,
    latestResults: latest,
    correctionBudgetUsed: session.correction_budget_used,
    correctionBudget,
  });
  const resultRef: JsonObject = {
    session_id: session.id,
    verdict: verdict.decision,
    reason: verdict.reason,
    target_artifact_version_id: target.versionId,
    check_plan_hash: planHash.toString('hex'),
  };

  if (verdict.decision === 'RETRY_CHECKER') {
    // 保留未决：不 finalize、不新建产物，下一次推进只重跑检查器。
    return {
      outcome: 'RETRYABLE',
      reason: verdict.reason,
      evidence: {
        ...resultRef,
        failing_criterion_ids: [...verdict.failingCriterionIds],
        uncertain_criterion_ids: [...verdict.uncertainCriterionIds],
        pending_human_criterion_ids: [...verdict.pendingHumanCriterionIds],
      },
    };
  }

  if (verdict.decision === 'RETRY') {
    await finalizeOrThrow(repositories, {
      session,
      status: 'RETRY',
      correctionBudgetUsed: session.correction_budget_used + 1n,
    });

    return {
      outcome: 'CORRECTION',
      resultRef,
      evidence: {
        ...resultRef,
        failing_criterion_ids: [...verdict.failingCriterionIds],
        severity_scope: 'REQUIRED_NON_PREFERENCE',
      },
    };
  }

  if (verdict.decision === 'HUMAN') {
    await finalizeOrThrow(repositories, {
      session,
      status: 'HUMAN',
      correctionBudgetUsed: session.correction_budget_used,
    });

    await createVerificationReviews(repositories, {
      run: input.run,
      task: input.task,
      session,
      verdict,
      correctionBudget,
    });

    return {
      outcome: 'SUCCESS',
      resultRef,
      runStatus: 'WAITING_APPROVAL',
      waitReason: verdict.reason,
    };
  }

  await finalizeOrThrow(repositories, {
    session,
    status: 'PASS',
    correctionBudgetUsed: session.correction_budget_used,
  });

  return { outcome: 'SUCCESS', resultRef, runStatus: 'VERIFYING', waitReason: null };
}

/**
 * 该 Run 已 finalize 为 RETRY 的 session 数：既是下一轮修正的 round，也是已用修正预算。
 * 同一 Run 内它是单调递增的事实，因此修正轮输入与预算都不需要额外计数列。
 */
export function countCorrectionRounds(
  sessions: readonly VerificationSessionRow[],
): bigint {
  return BigInt(sessions.filter((session) => session.status === 'RETRY').length);
}

/**
 * 修正轮输入：round = 已 finalize 为 RETRY 的 session 数；
 * failures = 最新已 finalize session 的失败项（FAIL 与 ERROR 都作为可核对证据，是否修复仍由总决策决定）。
 * round 0 返回 undefined，payload 因此不含 `correction`，摘要与 P05 一致。
 */
export async function loadCorrectionInput(
  repositories: Repositories,
  runId: string,
): Promise<ContextCorrectionInput | undefined> {
  const sessions = await repositories.verifications.listSessionsByRun(runId);
  const round = countCorrectionRounds(sessions);

  if (round === 0n) {
    return undefined;
  }

  const latestFinalized = sessions.filter((session) => session.status !== 'OPEN').at(-1);

  if (latestFinalized === undefined) {
    return undefined;
  }

  const results = await repositories.verifications.listLatestCheckResults(latestFinalized.id);

  return {
    round: Number(round),
    failures: results
      .filter((row) => row.result === 'FAIL' || row.result === 'ERROR')
      .map((row) => {
        const reason = readEvidenceReason(row.evidence_refs);

        return {
          criterion_id: row.criterion_id,
          result: row.result,
          severity: row.severity,
          ...(reason === undefined ? {} : { reason }),
        };
      }),
  };
}

/** PERSIST_CANDIDATE 的轮次来源：round 0 沿用 P05 的来源尝试 ID，round ≥ 1 按轮次区分。 */
export async function currentCorrectionRound(
  repositories: Repositories,
  runId: string,
): Promise<bigint> {
  return countCorrectionRounds(await repositories.verifications.listSessionsByRun(runId));
}

interface VerifiedTarget {
  readonly versionId: string;
  readonly contentHash: Buffer;
  readonly content: string;
}

/**
 * 读 PERSIST_CANDIDATE 的候选版本并核对受管内容：文件缺失、被替换或 hash/size 不一致一律
 * EVIDENCE_UNAVAILABLE，不写任何检查结果，也不把缺失当成 FAIL。
 */
async function loadVerifiedTarget(
  repositories: Repositories,
  input: VerifyRunInput,
): Promise<VerifiedTarget> {
  const persistStep = await repositories.runs.readStepByKind(input.run.id, 'PERSIST_CANDIDATE');
  const versionId = readString(persistStep?.result_ref, 'artifact_version_id');

  if (versionId === undefined) {
    throw invalidTransition('VERIFY 需要 PERSIST_CANDIDATE 已成功登记候选版本。', {
      taskId: input.task.id,
    });
  }

  const version = await repositories.artifacts.readArtifactVersion(versionId);

  if (version === undefined) {
    throw evidenceUnavailable({ artifactVersionId: versionId, reason: 'MISSING' });
  }

  const read = await input.storage.readWithHashCheck(version.storage_ref, {
    contentHash: version.content_hash,
    size: version.size,
  });

  if (read.status !== 'OK') {
    throw evidenceUnavailable({ artifactVersionId: version.id, reason: read.status });
  }

  return { versionId: version.id, contentHash: version.content_hash, content: read.content.toString('utf8') };
}

async function finalizeOrThrow(
  repositories: Repositories,
  input: {
    readonly session: VerificationSessionRow;
    readonly status: 'PASS' | 'RETRY' | 'HUMAN';
    readonly correctionBudgetUsed: bigint;
  },
): Promise<void> {
  const finalized = await repositories.verifications.finalizeSession({
    sessionId: input.session.id,
    expectedRevision: input.session.revision,
    status: input.status,
    correctionBudgetUsed: input.correctionBudgetUsed,
  });

  if (finalized === undefined) {
    throw new Error('verification session finalize CAS failed while holding the run lock');
  }
}

function readString(value: JsonObject | null | undefined, key: string): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }

  const field = (value as JsonObject)[key];

  return typeof field === 'string' ? field : undefined;
}

function readEvidenceReason(evidence: JsonObject): string | undefined {
  const reason = evidence.reason;

  return typeof reason === 'string' ? reason : undefined;
}
