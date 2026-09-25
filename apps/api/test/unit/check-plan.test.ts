import assert from 'node:assert/strict';
import test from 'node:test';

import type { CriterionMethod } from '../../src/infrastructure/database-schema.js';
import type { JsonObject } from '../../src/infrastructure/json.js';
import {
  buildCheckPlan,
  checkPlanHash,
  planFromFrozenSnapshot,
  planToJson,
  VERIFIER_POLICY_VERSION,
  type FrozenCriterionInput,
} from '../../src/workflow/check-plan.js';
import { freezeExecutionContract } from '../../src/workflow/execution-contract.js';

/**
 * P06 CheckPlan 的派生、严重度缺省与冻结摘要（contracts/03 第 3、4 节）。
 * 计划由冻结契约 + 内置 registry 确定，Worker 无写权；未注册 method 必须抛错而不是降级。
 */

function criterion(
  criterionId: string,
  method: CriterionMethod,
  options: { readonly required?: boolean; readonly targetSpec?: JsonObject } = {},
): FrozenCriterionInput {
  return {
    criterionId,
    statement: `${criterionId} 的判定陈述`,
    required: options.required ?? true,
    method,
    targetSpec: options.targetSpec ?? {},
  };
}

function planOf(criteria: readonly FrozenCriterionInput[]) {
  return buildCheckPlan({
    criteria,
    workflowKey: 'markdown-deliverable-v1',
    workflowVersion: '1',
  });
}

test('severity defaults to HARD for required criteria and PREFERENCE otherwise', () => {
  const plan = planOf([
    criterion('c-required', 'MARKDOWN_STRUCTURE'),
    criterion('c-optional', 'SEMANTIC', { required: false }),
  ]);

  assert.equal(plan.policyVersion, VERIFIER_POLICY_VERSION);
  assert.deepEqual(
    plan.entries.map((entry) => [entry.criterionId, entry.severity]),
    [
      ['c-required', 'HARD'],
      ['c-optional', 'PREFERENCE'],
    ],
  );
});

test('an explicit target_spec severity wins and invalid values are rejected', () => {
  const plan = planOf([
    criterion('c1', 'SEMANTIC', { targetSpec: { severity: 'PREFERENCE' } }),
    criterion('c2', 'SEMANTIC', { targetSpec: { severity: 'RULE' } }),
  ]);

  assert.deepEqual(
    plan.entries.map((entry) => entry.severity),
    ['PREFERENCE', 'RULE'],
  );

  assert.throws(
    () => planOf([criterion('c3', 'SEMANTIC', { targetSpec: { severity: 'SOFT' } })]),
    /invalid target_spec\.severity/u,
  );
});

test('every method maps to a registered checker and an unknown method throws', () => {
  const plan = planOf([
    criterion('c1', 'HUMAN'),
    criterion('c2', 'MARKDOWN_STRUCTURE'),
    criterion('c3', 'CITATION_EXISTS'),
    criterion('c4', 'SEMANTIC'),
  ]);

  assert.deepEqual(
    plan.entries.map((entry) => entry.checkerId),
    ['human-evidence-v1', 'markdown-structure-v1', 'citation-exists-v1', 'fake-semantic-v1'],
  );

  assert.throws(
    () => planOf([criterion('c5', 'PDF_TEXT' as CriterionMethod, { required: true })]),
    /unregistered criterion method/u,
  );
});

test('the plan hash is stable for the same plan and 32 bytes long', () => {
  const criteria = [criterion('c1', 'MARKDOWN_STRUCTURE'), criterion('c2', 'SEMANTIC')];
  const first = checkPlanHash(planOf(criteria));
  const second = checkPlanHash(planOf(criteria));
  const reordered = checkPlanHash(planOf([...criteria].reverse()));

  assert.equal(first.length, 32);
  assert.equal(first.equals(second), true);
  assert.equal(first.equals(reordered), false);
});

test('the plan can be rebuilt from the frozen contract snapshot', () => {
  const frozen = freezeExecutionContract({
    taskId: '11111111-1111-1111-1111-111111111111',
    acceptanceRevision: 3n,
    objective: '写一份候选交付',
    expectedOutputs: {},
    criteria: [
      {
        criterionId: 'c1',
        statement: '结构完整',
        required: true,
        method: 'MARKDOWN_STRUCTURE',
        targetSpec: {},
      },
      {
        criterionId: 'c2',
        statement: '引用存在',
        required: false,
        method: 'CITATION_EXISTS',
        targetSpec: { severity: 'PREFERENCE' },
      },
    ],
  });
  const rebuilt = buildCheckPlan(planFromFrozenSnapshot(frozen.snapshot));

  assert.deepEqual(rebuilt.workflowKey, 'markdown-deliverable-v1');
  assert.deepEqual(
    rebuilt.entries.map((entry) => [entry.criterionId, entry.required, entry.severity]),
    [
      ['c1', true, 'HARD'],
      ['c2', false, 'PREFERENCE'],
    ],
  );
  assert.deepEqual(planToJson(rebuilt).entries, planToJson(rebuilt).entries);

  assert.throws(
    () => planFromFrozenSnapshot({ criteria: [], workflow: { key: '', version: '' } }),
    /workflow identity/u,
  );
});
