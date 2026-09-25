import type { CheckResultValue } from '../infrastructure/database-schema.js';
import type { CheckPlan } from './check-plan.js';

/**
 * Verification 总决策（contracts/03-verification-and-approval.md 第 3 节、
 * docs/architecture/runtime-context.md 第 4 节）。
 *
 * 这是纯函数：只读冻结的 CheckPlan 与各 criterion 的最新单项结果，不写任何状态、不调用 checker。
 * 判定顺序刻意“先修可修的”：
 *   1. 必需项的检查器 ERROR：先有界重试检查本身，两次仍不可用才 HUMAN；
 *   2. 必需项的可修正 FAIL（severity 不是 PREFERENCE）：有修正预算就 RETRY，耗尽才 HUMAN；
 *   3. 必需项的 NOT_RUN（人工证据未到）→ HUMAN；
 *   4. 必需项的 UNCERTAIN（需要责任判断）→ HUMAN；
 *   5. 其余 → PASS。
 * 这样“必需人工项未完成”不会把本可修正的失败永久锁死，检查器故障也不会被算成 FAIL 或 PASS。
 *
 * NOT_APPLICABLE 忽略；PREFERENCE 的 FAIL/UNCERTAIN 只作为建议记录；非必需项不影响总决策。
 */

/** 默认修正预算：超过后不再自动修正，转人工（contracts/03 第 3 节“修正预算耗尽 → HUMAN”）。 */
export const DEFAULT_CORRECTION_BUDGET = 2n;

/** 同一 criterion 的检查器有界重试上限：第 2 次仍 ERROR 就不再重试检查本身。 */
export const MAX_CHECKER_ATTEMPTS = 2;

export type VerdictDecision = 'PASS' | 'RETRY' | 'HUMAN' | 'RETRY_CHECKER';

/** 判定原因；写入 VERIFY 步骤 result_ref、session 与 Run 的 wait_reason，便于追溯。 */
export const VERDICT_REASON = {
  PASS: 'ALL_REQUIRED_CHECKS_PASSED',
  RETRY: 'CORRECTABLE_REQUIRED_FAILURE',
  RETRY_CHECKER: 'CHECKER_ERROR_RETRYABLE',
  CHECKER_UNAVAILABLE: 'CHECKER_UNAVAILABLE',
  CORRECTION_BUDGET_EXHAUSTED: 'CORRECTION_BUDGET_EXHAUSTED',
  AWAITING_HUMAN_EVIDENCE: 'AWAITING_HUMAN_EVIDENCE',
  UNCERTAIN_REQUIRES_HUMAN: 'UNCERTAIN_REQUIRES_HUMAN',
} as const;

/** 总决策输入用的单项结果投影（check_results 的最新一行）。 */
export interface LatestCheckResult {
  readonly criterion_id: string;
  readonly check_attempt: number;
  readonly result: CheckResultValue;
}

export interface VerdictInput {
  readonly plan: CheckPlan;
  readonly latestResults: readonly LatestCheckResult[];
  readonly correctionBudgetUsed: bigint;
  readonly correctionBudget: bigint;
}

export interface Verdict {
  readonly decision: VerdictDecision;
  readonly reason: string;
  /** 最新结果为 FAIL 的 criterion（含 PREFERENCE 建议，修正轮据此定向修复）。 */
  readonly failingCriterionIds: readonly string[];
  readonly uncertainCriterionIds: readonly string[];
  /** 最新结果为 NOT_RUN、等待人工证据的 criterion。 */
  readonly pendingHumanCriterionIds: readonly string[];
}

export function computeVerdict(input: VerdictInput): Verdict {
  const latest = new Map<string, LatestCheckResult>();

  for (const result of input.latestResults) {
    latest.set(result.criterion_id, result);
  }

  const failingCriterionIds: string[] = [];
  const uncertainCriterionIds: string[] = [];
  const pendingHumanCriterionIds: string[] = [];

  for (const entry of input.plan.entries) {
    switch (resultOf(latest, entry.criterionId)) {
      case 'FAIL':
        failingCriterionIds.push(entry.criterionId);
        break;
      case 'UNCERTAIN':
        uncertainCriterionIds.push(entry.criterionId);
        break;
      case 'NOT_RUN':
        pendingHumanCriterionIds.push(entry.criterionId);
        break;
      default:
        break;
    }
  }

  const verdict = (decision: VerdictDecision, reason: string): Verdict => ({
    decision,
    reason,
    failingCriterionIds: [...failingCriterionIds].sort(),
    uncertainCriterionIds: [...uncertainCriterionIds].sort(),
    pendingHumanCriterionIds: [...pendingHumanCriterionIds].sort(),
  });

  const required = input.plan.entries.filter((entry) => entry.required);

  // 1. 检查器 ERROR：只重试检查本身；全部 ERROR 项都已用完重试才转人工。
  const errored = required.filter((entry) => resultOf(latest, entry.criterionId) === 'ERROR');

  if (errored.length > 0) {
    const retryable = errored.some(
      (entry) => (latest.get(entry.criterionId)?.check_attempt ?? 0) < MAX_CHECKER_ATTEMPTS,
    );

    return retryable
      ? verdict('RETRY_CHECKER', VERDICT_REASON.RETRY_CHECKER)
      : verdict('HUMAN', VERDICT_REASON.CHECKER_UNAVAILABLE);
  }

  // 2. 必需项的可修正 FAIL：HARD/RULE/SEMANTIC 失败不能被语义赞同覆盖，但可以在预算内修正。
  const hardFailure = required.some(
    (entry) =>
      entry.severity !== 'PREFERENCE' && resultOf(latest, entry.criterionId) === 'FAIL',
  );

  if (hardFailure) {
    return input.correctionBudgetUsed < input.correctionBudget
      ? verdict('RETRY', VERDICT_REASON.RETRY)
      : verdict('HUMAN', VERDICT_REASON.CORRECTION_BUDGET_EXHAUSTED);
  }

  // 3. 必需人工证据未完成：不伪装成执行失败，也不产生 PASS。
  if (required.some((entry) => resultOf(latest, entry.criterionId) === 'NOT_RUN')) {
    return verdict('HUMAN', VERDICT_REASON.AWAITING_HUMAN_EVIDENCE);
  }

  // 4. 语义不确定需要责任判断。
  if (required.some((entry) => resultOf(latest, entry.criterionId) === 'UNCERTAIN')) {
    return verdict('HUMAN', VERDICT_REASON.UNCERTAIN_REQUIRES_HUMAN);
  }

  return verdict('PASS', VERDICT_REASON.PASS);
}

/** 没有结果的必需项按 NOT_RUN 处理：缺结果不能变成 PASS。 */
function resultOf(
  latest: ReadonlyMap<string, LatestCheckResult>,
  criterionId: string,
): CheckResultValue {
  return latest.get(criterionId)?.result ?? 'NOT_RUN';
}
