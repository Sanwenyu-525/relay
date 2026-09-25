import assert from 'node:assert/strict';
import test from 'node:test';

import type { CheckResultValue } from '../../src/infrastructure/database-schema.js';
import {
  buildCheckPlan,
  type CheckPlan,
  type FrozenCriterionInput,
} from '../../src/workflow/check-plan.js';
import { computeVerdict, DEFAULT_CORRECTION_BUDGET } from '../../src/workflow/verdict.js';

/**
 * P06 总决策的判定顺序与边界（contracts/03 第 3、9 节；C04–C07）。
 * 纯函数：不写状态、不调用 checker，因此这里可以逐条固定顺序。
 */

function planOf(criteria: readonly FrozenCriterionInput[]): CheckPlan {
  return buildCheckPlan({
    criteria,
    workflowKey: 'markdown-deliverable-v1',
    workflowVersion: '1',
  });
}

function criterion(
  criterionId: string,
  method: FrozenCriterionInput['method'],
  options: { readonly required?: boolean; readonly severity?: string } = {},
): FrozenCriterionInput {
  return {
    criterionId,
    statement: `${criterionId} 的判定陈述`,
    required: options.required ?? true,
    method,
    targetSpec: options.severity === undefined ? {} : { severity: options.severity },
  };
}

function result(
  criterionId: string,
  value: CheckResultValue,
  checkAttempt = 1,
): { criterion_id: string; check_attempt: number; result: CheckResultValue } {
  return { criterion_id: criterionId, check_attempt: checkAttempt, result: value };
}

function verdictOf(
  plan: CheckPlan,
  latestResults: readonly ReturnType<typeof result>[],
  correctionBudgetUsed = 0n,
) {
  return computeVerdict({
    plan,
    latestResults,
    correctionBudgetUsed,
    correctionBudget: DEFAULT_CORRECTION_BUDGET,
  });
}

test('a HARD failure is never covered by a semantic PASS', () => {
  const plan = planOf([
    criterion('c-structure', 'MARKDOWN_STRUCTURE'),
    criterion('c-semantic', 'SEMANTIC'),
  ]);
  const verdict = verdictOf(plan, [result('c-structure', 'FAIL'), result('c-semantic', 'PASS')]);

  assert.equal(verdict.decision, 'RETRY');
  assert.equal(verdict.reason, 'CORRECTABLE_REQUIRED_FAILURE');
  assert.deepEqual(verdict.failingCriterionIds, ['c-structure']);
});

test('a required PREFERENCE failure does not block PASS but stays recorded', () => {
  const plan = planOf([
    criterion('c-hard', 'MARKDOWN_STRUCTURE'),
    criterion('c-preference', 'SEMANTIC', { severity: 'PREFERENCE' }),
  ]);
  const verdict = verdictOf(plan, [result('c-hard', 'PASS'), result('c-preference', 'FAIL')]);

  assert.equal(verdict.decision, 'PASS');
  assert.equal(verdict.reason, 'ALL_REQUIRED_CHECKS_PASSED');
  assert.deepEqual(verdict.failingCriterionIds, ['c-preference']);
});

test('an exhausted correction budget turns a correctable failure into HUMAN', () => {
  const plan = planOf([criterion('c1', 'MARKDOWN_STRUCTURE')]);
  const failing = [result('c1', 'FAIL')];

  assert.equal(verdictOf(plan, failing, 0n).decision, 'RETRY');
  assert.equal(verdictOf(plan, failing, 1n).decision, 'RETRY');
  assert.equal(verdictOf(plan, failing, DEFAULT_CORRECTION_BUDGET).decision, 'HUMAN');
  assert.equal(
    verdictOf(plan, failing, DEFAULT_CORRECTION_BUDGET).reason,
    'CORRECTION_BUDGET_EXHAUSTED',
  );
});

test('checker ERROR retries the check once and then falls back to HUMAN', () => {
  const plan = planOf([criterion('c1', 'MARKDOWN_STRUCTURE')]);
  const first = verdictOf(plan, [result('c1', 'ERROR', 1)]);
  const second = verdictOf(plan, [result('c1', 'ERROR', 2)]);

  assert.equal(first.decision, 'RETRY_CHECKER');
  assert.equal(first.reason, 'CHECKER_ERROR_RETRYABLE');
  assert.equal(second.decision, 'HUMAN');
  assert.equal(second.reason, 'CHECKER_UNAVAILABLE');
});

test('checker ERROR is decided before a correctable FAIL so fixable checks are not locked', () => {
  const plan = planOf([
    criterion('c-error', 'MARKDOWN_STRUCTURE'),
    criterion('c-fail', 'SEMANTIC'),
  ]);
  const verdict = verdictOf(plan, [result('c-error', 'ERROR', 1), result('c-fail', 'FAIL')]);

  assert.equal(verdict.decision, 'RETRY_CHECKER');
});

test('NOT_RUN and UNCERTAIN on required criteria both stop at HUMAN', () => {
  const plan = planOf([
    criterion('c-human', 'HUMAN'),
    criterion('c-semantic', 'SEMANTIC'),
  ]);

  assert.equal(verdictOf(plan, [result('c-human', 'NOT_RUN')]).decision, 'HUMAN');
  assert.equal(verdictOf(plan, [result('c-human', 'NOT_RUN')]).reason, 'AWAITING_HUMAN_EVIDENCE');

  const uncertain = verdictOf(plan, [result('c-human', 'PASS'), result('c-semantic', 'UNCERTAIN')]);

  assert.equal(uncertain.decision, 'HUMAN');
  assert.equal(uncertain.reason, 'UNCERTAIN_REQUIRES_HUMAN');
  assert.deepEqual(uncertain.uncertainCriterionIds, ['c-semantic']);
});

test('non-required results and NOT_APPLICABLE never change the decision', () => {
  const plan = planOf([
    criterion('c1', 'MARKDOWN_STRUCTURE'),
    criterion('c-optional', 'SEMANTIC', { required: false }),
    criterion('c-skipped', 'CITATION_EXISTS'),
  ]);
  const verdict = verdictOf(plan, [
    result('c1', 'PASS'),
    result('c-optional', 'FAIL'),
    result('c-skipped', 'NOT_APPLICABLE'),
  ]);

  assert.equal(verdict.decision, 'PASS');
  assert.deepEqual(verdict.pendingHumanCriterionIds, []);
});

test('a required criterion without any result is treated as NOT_RUN, never PASS', () => {
  const plan = planOf([criterion('c1', 'MARKDOWN_STRUCTURE')]);
  const verdict = verdictOf(plan, []);

  assert.equal(verdict.decision, 'HUMAN');
  assert.deepEqual(verdict.pendingHumanCriterionIds, ['c1']);
});

test('only the latest attempt of each criterion is considered', () => {
  const plan = planOf([criterion('c1', 'MARKDOWN_STRUCTURE')]);
  const verdict = verdictOf(plan, [result('c1', 'FAIL', 1), result('c1', 'PASS', 2)]);

  assert.equal(verdict.decision, 'PASS');
  assert.deepEqual(verdict.failingCriterionIds, []);
});
