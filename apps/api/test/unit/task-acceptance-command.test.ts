import assert from 'node:assert/strict';
import test from 'node:test';

import { Value } from '@sinclair/typebox/value';

import {
  ReviseTaskAcceptanceBodySchema,
  ReviseTaskAcceptanceResultSchema,
} from '../../src/api/task-api.js';
import {
  acceptanceRevisionFactRefs,
  planTaskAcceptanceRevision,
  prepareTaskAcceptanceRevision,
  type CurrentAcceptanceCriterion,
  type TaskAcceptanceCriterionInput,
} from '../../src/application/task-contract-commands.js';
import { DomainError } from '../../src/application/domain-error.js';
import type { JsonObject } from '../../src/infrastructure/json.js';

/**
 * 人工补验收条件命令（ReviseTaskAcceptance）的纯判定单元。
 *
 * 这里只覆盖不依赖数据库的判定：入口规范化、命令摘要用的规范化 body、
 * 「新版本 + 已确认必需条件不得删除或降级」的规划规则与审计事实引用形状。
 * 幂等回执、revision CAS、并发与旧证据失效的真实提交语义在
 * test/integration/task-acceptance-command.integration.test.ts 用真实 PostgreSQL 验证。
 */

function prepared(criteria: readonly TaskAcceptanceCriterionInput[], objective?: string) {
  return prepareTaskAcceptanceRevision({
    expectedRevision: '3',
    expectedAcceptanceRevision: '1',
    objective,
    criteria,
  });
}

function criterion(
  overrides: Partial<TaskAcceptanceCriterionInput> = {},
): TaskAcceptanceCriterionInput {
  return { statement: '实验报告里必须有可复现的运行步骤', ...overrides };
}

function currentCriterion(
  overrides: Partial<CurrentAcceptanceCriterion> = {},
): CurrentAcceptanceCriterion {
  return {
    criterion_id: 'run-log',
    statement: '实验报告里必须有可复现的运行步骤',
    required: true,
    method: 'HUMAN',
    target_spec: {},
    ...overrides,
  };
}

/** 原样保留当前版本的必需条件：提交它，才是在测试「改写/降级」而不是「删除」。 */
function preserved(): TaskAcceptanceCriterionInput {
  return { criterionId: 'run-log', statement: '实验报告里必须有可复现的运行步骤',
    required: true, method: 'HUMAN', targetSpec: {} };
}

function domainError(work: () => unknown): DomainError {
  try {
    work();
  } catch (error) {
    assert.ok(error instanceof DomainError, `expected a DomainError, got ${String(error)}`);
    return error;
  }

  throw new Error('expected the call to be rejected');
}

test('normalizes defaults so an unspecified criterion is a required HUMAN criterion', () => {
  const result = prepared([criterion()]);

  assert.equal(result.criteria.length, 1);
  assert.deepEqual(result.criteria[0], {
    criterionId: 'c1',
    statement: '实验报告里必须有可复现的运行步骤',
    required: true,
    method: 'HUMAN',
    targetSpec: {},
  });
});

test('trims statement and objective text before hashing and storing', () => {
  const result = prepared([criterion({ statement: '  有可复现运行步骤  ' })], '  跑通实验并整理初稿  ');

  assert.equal(result.criteria[0]?.statement, '有可复现运行步骤');
  assert.equal(result.objective, '跑通实验并整理初稿');
});

test('equivalent payloads normalize to the same command body so a replay hits the same receipt', () => {
  const left = prepared([criterion({ required: undefined, method: undefined,
    targetSpec: undefined })], '目标');
  const right = prepared([criterion({ required: true, method: 'HUMAN', targetSpec: {} })], '目标');

  // 幂等回执按规范化 body 计算摘要；未显式给出的字段与显式默认值必须落到同一摘要。
  assert.deepEqual(left.body, right.body);
  assert.deepEqual(left.body, {
    expected_revision: '3',
    expected_acceptance_revision: '1',
    objective: '目标',
    criteria: [{ criterion_id: 'c1', statement: '实验报告里必须有可复现的运行步骤',
      required: true, method: 'HUMAN', target_spec: {} }],
  });
});

test('omitting objective keeps the current one out of the command body instead of guessing', () => {
  const result = prepared([criterion()]);

  assert.equal(result.objective, undefined);
  assert.equal('objective' in result.body, false);
});

test('rejects an empty criteria list', () => {
  const error = domainError(() => prepared([]));

  assert.equal(error.code, 'VALIDATION_FAILED');
  assert.equal(error.fieldErrors[0]?.field, 'criteria');
});

test('rejects more than thirty criteria', () => {
  const many = Array.from({ length: 31 }, () => criterion({ criterionId: undefined }));
  const error = domainError(() => prepared(many));

  assert.equal(error.code, 'VALIDATION_FAILED');
  assert.match(String(error.fieldErrors[0]?.message), /30/u);
});

test('rejects duplicated criterion ids inside one submission', () => {
  const error = domainError(() => prepared([criterion({ criterionId: 'a' }),
    criterion({ criterionId: 'a' })]));

  assert.equal(error.code, 'VALIDATION_FAILED');
  assert.match(String(error.fieldErrors[0]?.message), /unique/u);
});

test('rejects an unknown check method instead of silently degrading it to a suggestion', () => {
  const error = domainError(() => prepared([criterion({ method: 'REGEX' })]));

  assert.equal(error.code, 'VALIDATION_FAILED');
  assert.match(String(error.fieldErrors[0]?.field), /method/u);
});

test('rejects an oversized target_spec snapshot', () => {
  const error = domainError(() => prepared([criterion({
    targetSpec: { blob: 'x'.repeat(5_000) } as JsonObject })]));

  assert.equal(error.code, 'VALIDATION_FAILED');
  assert.match(String(error.fieldErrors[0]?.field), /target_spec/u);
});

test('rejects a blank objective', () => {
  const error = domainError(() => prepared([criterion()], '   '));

  assert.equal(error.code, 'VALIDATION_FAILED');
  assert.equal(error.fieldErrors[0]?.field, 'objective');
});

test('plans the next acceptance revision for a zero-criterion task without touching the prior one', () => {
  const submitted = prepared([criterion({ criterionId: 'run-log' })]);
  const plan = planTaskAcceptanceRevision({ taskId: 'task', currentAcceptanceRevision: 1n,
    currentObjective: '只用一句话表达要完成的事', requiredOutputSpec: {},
    currentCriteria: [], objective: submitted.objective, criteria: submitted.criteria });

  assert.equal(plan.nextAcceptanceRevision, 2n);
  assert.equal(plan.objective, '只用一句话表达要完成的事');
  assert.deepEqual(plan.criteria.map((item) => item.criterionId), ['run-log']);
  assert.deepEqual(plan.addedCriterionIds, ['run-log']);
  assert.equal(plan.requiredCriterionCount, 1);
});

test('carries the declared outputs through byte for byte: this command never rewrites them', () => {
  const requiredOutputSpec = { artifacts: ['MARKDOWN_DOCUMENT'], retention: { policy: 'keep' } };
  const submitted = prepared([preserved()]);
  const plan = planTaskAcceptanceRevision({ taskId: 'task', currentAcceptanceRevision: 3n,
    currentObjective: '目标', requiredOutputSpec,
    currentCriteria: [currentCriterion()], objective: submitted.objective,
    criteria: submitted.criteria });

  assert.equal(JSON.stringify(plan.requiredOutputSpec), JSON.stringify(requiredOutputSpec));
});

test('reports a revised objective while keeping every prior criterion', () => {
  const submitted = prepared([preserved(), criterion({ criterionId: 'citation',
    statement: '每条结论都要有可定位的引用' })], '跑通实验并产出可评审的报告');
  const plan = planTaskAcceptanceRevision({ taskId: 'task', currentAcceptanceRevision: 1n,
    currentObjective: '旧目标', requiredOutputSpec: {},
    currentCriteria: [currentCriterion()], objective: submitted.objective,
    criteria: submitted.criteria });

  assert.equal(plan.objective, '跑通实验并产出可评审的报告');
  assert.deepEqual(plan.addedCriterionIds, ['citation']);
});

test('refuses to drop a confirmed required criterion', () => {
  const submitted = prepared([criterion({ criterionId: 'other' })]);
  const error = domainError(() => planTaskAcceptanceRevision({ taskId: 'task',
    currentAcceptanceRevision: 1n, currentObjective: '目标', requiredOutputSpec: {},
    currentCriteria: [currentCriterion()], objective: submitted.objective,
    criteria: submitted.criteria }));

  assert.equal(error.code, 'INVALID_TRANSITION');
  assert.deepEqual(error.conflict?.criterionIds, ['run-log']);
});

test('refuses to downgrade a confirmed required criterion to optional', () => {
  const submitted = prepared([criterion({ criterionId: 'run-log', required: false })]);
  const error = domainError(() => planTaskAcceptanceRevision({ taskId: 'task',
    currentAcceptanceRevision: 1n, currentObjective: '目标', requiredOutputSpec: {},
    currentCriteria: [currentCriterion()], objective: submitted.objective,
    criteria: submitted.criteria }));

  assert.equal(error.code, 'INVALID_TRANSITION');
  assert.deepEqual(error.conflict?.criterionIds, ['run-log']);
});

test('refuses to restate a confirmed required criterion as something else', () => {
  const submitted = prepared([criterion({ criterionId: 'run-log', statement: '大概跑一下就行' })]);
  const error = domainError(() => planTaskAcceptanceRevision({ taskId: 'task',
    currentAcceptanceRevision: 1n, currentObjective: '目标', requiredOutputSpec: {},
    currentCriteria: [currentCriterion()], objective: submitted.objective,
    criteria: submitted.criteria }));

  assert.equal(error.code, 'INVALID_TRANSITION');
  assert.deepEqual(error.conflict?.criterionIds, ['run-log']);
});

test('refuses to switch the check method of a confirmed required criterion', () => {
  const submitted = prepared([criterion({ criterionId: 'run-log',
    method: 'MARKDOWN_STRUCTURE' })]);
  const error = domainError(() => planTaskAcceptanceRevision({ taskId: 'task',
    currentAcceptanceRevision: 1n, currentObjective: '目标', requiredOutputSpec: {},
    currentCriteria: [currentCriterion()], objective: submitted.objective,
    criteria: submitted.criteria }));

  assert.equal(error.code, 'INVALID_TRANSITION');
});

test('refuses to change the target_spec of a confirmed required criterion', () => {
  const submitted = prepared([criterion({ criterionId: 'run-log',
    targetSpec: { severity: 'PREFERENCE' } })]);
  const error = domainError(() => planTaskAcceptanceRevision({ taskId: 'task',
    currentAcceptanceRevision: 1n, currentObjective: '目标', requiredOutputSpec: {},
    currentCriteria: [currentCriterion()], objective: submitted.objective,
    criteria: submitted.criteria }));

  assert.equal(error.code, 'INVALID_TRANSITION');
});

test('lets a human refine or drop an optional criterion, because it never was completion evidence', () => {
  const optional = currentCriterion({ criterion_id: 'polish', required: false,
    statement: '排版 nicer', target_spec: { severity: 'PREFERENCE' } });
  const submitted = prepared([preserved(), criterion({ criterionId: 'polish', required: true,
    statement: '图表清晰可读', targetSpec: { severity: 'HARD' } })]);
  const plan = planTaskAcceptanceRevision({ taskId: 'task', currentAcceptanceRevision: 1n,
    currentObjective: '目标', requiredOutputSpec: {}, currentCriteria: [currentCriterion(), optional],
    objective: submitted.objective, criteria: submitted.criteria });

  assert.equal(plan.addedCriterionIds.length, 0);
  assert.equal(plan.requiredCriterionCount, 2);
});

test('refuses a submission whose only criteria are optional', () => {
  // MarkTaskReady 要求当前验收版本至少有一条必需 criterion；在写入时就拒绝，
  // 免得用户刚补完条件就被 ready 的 409 顶回来。
  const submitted = prepared([criterion({ required: false })]);
  const error = domainError(() => planTaskAcceptanceRevision({ taskId: 'task',
    currentAcceptanceRevision: 1n, currentObjective: '目标', requiredOutputSpec: {},
    currentCriteria: [], objective: submitted.objective, criteria: submitted.criteria }));

  assert.equal(error.code, 'VALIDATION_FAILED');
  assert.match(String(error.fieldErrors[0]?.message), /required/u);
});

test('planning does not mutate the prior acceptance facts it was given', () => {
  const currentCriteria = [currentCriterion()];
  const submitted = prepared([preserved(), criterion({ criterionId: 'citation' })]);
  const before = structuredClone(currentCriteria);
  planTaskAcceptanceRevision({ taskId: 'task', currentAcceptanceRevision: 1n,
    currentObjective: '目标', requiredOutputSpec: { artifacts: ['MARKDOWN_DOCUMENT'] },
    currentCriteria, objective: submitted.objective, criteria: submitted.criteria });

  assert.deepEqual(currentCriteria, before);
});

test('the activity facts name both revisions so the audit can be replayed', () => {
  const facts = acceptanceRevisionFactRefs({ previousAcceptanceRevision: 1n,
    acceptanceRevision: 2n, addedCriterionIds: ['run-log'], criteriaCount: 3,
    requiredCriterionCount: 2 });

  assert.deepEqual(facts, {
    change_source: 'HUMAN_COMMAND',
    previous_acceptance_revision: '1',
    acceptance_revision: '2',
    added_criterion_ids: ['run-log'],
    criteria_count: 3,
    required_criteria_count: 2,
  });
});

test('the HTTP body schema accepts a well-formed revision request', () => {
  const body = { command_id: '11111111-1111-4111-8111-111111111111', expected_revision: '3',
    expected_acceptance_revision: '1', objective: '跑通实验并整理初稿',
    criteria: [{ criterion_id: 'run-log', statement: '有可复现运行步骤', required: true,
      method: 'HUMAN', target_spec: {} }] };

  assert.deepEqual([...Value.Errors(ReviseTaskAcceptanceBodySchema, body)], []);
});

test('the HTTP body schema still refuses an unknown field or an empty criteria list', () => {
  const base = { command_id: '11111111-1111-4111-8111-111111111111', expected_revision: '3',
    expected_acceptance_revision: '1', criteria: [{ statement: '有可复现运行步骤' }] };

  assert.equal(Value.Check(ReviseTaskAcceptanceBodySchema, { ...base, criteria: [] }), false);
  assert.equal(Value.Check(ReviseTaskAcceptanceBodySchema, { ...base, expected_acceptance_revision: '1' }), true);
  assert.equal(Value.Check(ReviseTaskAcceptanceBodySchema, { ...base, source: 'ASSIST' }), false);
});

test('the HTTP response schema accepts the command result it produces', () => {
  const result = { task_id: '11111111-1111-4111-8111-111111111111', status: 'INBOX',
    revision: '4', previous_acceptance_revision: '1', acceptance_revision: '2',
    objective: '只用一句话表达要完成的事', required_output_spec: {},
    criteria: [{ criterion_id: 'run-log', statement: '有可复现运行步骤', required: true,
      method: 'HUMAN', target_spec: {} }],
    added_criterion_ids: ['run-log'] };

  assert.deepEqual([...Value.Errors(ReviseTaskAcceptanceResultSchema, result)], []);
  assert.equal(Value.Check(ReviseTaskAcceptanceResultSchema, { ...result,
    added_criterion_ids: 'run-log' }), false,
  '反向断言：证明上一条不是恒真的空跑');
});