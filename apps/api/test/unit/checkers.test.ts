import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCheckPlan,
  type CheckPlanEntry,
  type FrozenCriterionInput,
} from '../../src/workflow/check-plan.js';
import {
  hasChecker,
  resolveChecker,
  resolveCheckerForScenario,
} from '../../src/workflow/checkers.js';

/**
 * P06 内置 checker 的关键结果与故障替换（contracts/03 第 7 节、C05/C06）。
 * 存在性检查不等于论断被支持；检查器故障既不是 FAIL 也不是 PASS。
 */

function entryOf(criterionId: string, method: FrozenCriterionInput['method']): CheckPlanEntry {
  const plan = buildCheckPlan({
    criteria: [
      { criterionId, statement: `${criterionId} 的判定陈述`, required: true, method, targetSpec: {} },
    ],
    workflowKey: 'markdown-deliverable-v1',
    workflowVersion: '1',
  });

  const entry = plan.entries[0];

  if (entry === undefined) {
    throw new Error('plan entry missing');
  }

  return entry;
}

const LEGAL_CONTENT = [
  '# 候选',
  '',
  '## 摘要',
  '',
  '本候选依据目标生成，覆盖固定必需结构。',
  '',
  '## 结论',
  '',
  '结论：已给出候选交付。',
  '',
  '参考资料：[Relay 设计系统](https://example.invalid/relay)',
].join('\n');

const CONTENT_WITHOUT_CITATION = [
  '# 候选',
  '',
  '## 摘要',
  '',
  '本候选依据目标生成，覆盖固定必需结构。',
  '',
  '## 结论',
  '',
  '结论：已给出候选交付，但没有引用标记。',
].join('\n');

function check(
  entry: CheckPlanEntry,
  content: string,
  fakeScenario?: string,
): { readonly result: string; readonly evidence: Record<string, unknown> } {
  const checker = resolveCheckerForScenario(entry, fakeScenario);

  return checker.check({
    entry,
    content,
    artifactVersionId: '22222222-2222-2222-2222-222222222222',
    contentHashHex: 'ab'.repeat(32),
    ...(fakeScenario === undefined ? {} : { fakeScenario }),
  });
}

test('markdown-structure-v1 only judges the required structure', () => {
  const entry = entryOf('c1', 'MARKDOWN_STRUCTURE');

  assert.equal(check(entry, LEGAL_CONTENT).result, 'PASS');
  assert.equal(check(entry, '# 只有标题\n').result, 'FAIL');
});

test('citation-exists-v1 reports existence only and never claims support', () => {
  const entry = entryOf('c2', 'CITATION_EXISTS');
  const passing = check(entry, LEGAL_CONTENT);
  const failing = check(entry, CONTENT_WITHOUT_CITATION);

  assert.equal(passing.result, 'PASS');
  assert.equal(passing.evidence.scope, 'EXISTENCE_ONLY');
  assert.equal(failing.result, 'FAIL');
  assert.equal(failing.evidence.reason, 'NO_CITATION_MARKERS');
});

test('fake-semantic-v1 distinguishes unsupported claims from uncertainty', () => {
  const entry = entryOf('c3', 'SEMANTIC');

  assert.equal(check(entry, LEGAL_CONTENT).result, 'PASS');
  assert.equal(
    check(entry, `${LEGAL_CONTENT}\n\n语义标记：EVIDENCE_UNSUPPORTED`).result,
    'FAIL',
  );
  assert.equal(
    check(entry, `${LEGAL_CONTENT}\n\n语义标记：SEMANTIC_UNCERTAIN`).result,
    'UNCERTAIN',
  );
});

test('human-evidence-v1 stays NOT_RUN so the worker cannot self-accept', () => {
  const entry = entryOf('c4', 'HUMAN');
  const outcome = check(entry, LEGAL_CONTENT);

  assert.equal(outcome.result, 'NOT_RUN');
  assert.equal(outcome.evidence.reason, 'AWAITING_HUMAN_EVIDENCE');
});

test('CHECKER_ERROR replaces the deterministic checkers with an ERROR result', () => {
  const structure = entryOf('c1', 'MARKDOWN_STRUCTURE');
  const citation = entryOf('c2', 'CITATION_EXISTS');
  const semantic = entryOf('c3', 'SEMANTIC');

  const structureOutcome = check(structure, LEGAL_CONTENT, 'CHECKER_ERROR');

  assert.equal(structureOutcome.result, 'ERROR');
  assert.equal(structureOutcome.evidence.reason, 'CHECKER_TIMEOUT');
  assert.equal(check(citation, LEGAL_CONTENT, 'CHECKER_ERROR').result, 'ERROR');
  // 语义与人工项不受该故障注入影响：故障只替换确定性检查器。
  assert.equal(check(semantic, LEGAL_CONTENT, 'CHECKER_ERROR').result, 'PASS');
});

test('the registry resolves by id and version and refuses unregistered pairs', () => {
  assert.equal(hasChecker('markdown-structure-v1', '1'), true);
  assert.equal(hasChecker('markdown-structure-v1', '2'), false);
  assert.equal(resolveChecker('markdown-structure-v1', '1')?.id, 'markdown-structure-v1');
  assert.equal(resolveChecker('unknown-checker', '1'), undefined);
});
