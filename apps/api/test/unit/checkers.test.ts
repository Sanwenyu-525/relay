import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCheckPlan,
  type CheckPlanEntry,
  type FrozenCriterionInput,
} from '../../src/workflow/check-plan.js';
import {
  hasChecker,
  ModelSemanticChecker,
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
  const outcome = checker.check({
    entry,
    content,
    artifactVersionId: '22222222-2222-2222-2222-222222222222',
    contentHashHex: 'ab'.repeat(32),
    ...(fakeScenario === undefined ? {} : { fakeScenario }),
  });
  if (outcome instanceof Promise) throw new Error('unexpected async checker outcome');
  return outcome;
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

test('semantic-model-v1 maps model verdicts and treats evaluation failures as ERROR', async () => {
  const entry: CheckPlanEntry = {
    criterionId: 'rule:semantic:v1', statement: '候选必须给出明确结论', required: true,
    method: 'SEMANTIC', severity: 'HARD', checkerId: 'semantic-model-v1',
    checkerVersion: '1', targetSpec: { severity: 'HARD' },
  };
  const base = { entry, artifactVersionId: '3', contentHashHex: 'cd'.repeat(32) };

  const checker = new ModelSemanticChecker(async ({ statement, content }) => {
    assert.equal(statement, '候选必须给出明确结论');
    assert.ok(content.includes('结论'));
    return { verdict: 'PASS', reason: '陈述满足', providerRequestId: 'req-1',
      usage: { inputTokens: 12, outputTokens: 8 } };
  });
  const passed = await checker.check({ ...base, content: '## 结论\n明确' });
  assert.equal(passed.result, 'PASS');
  const evidence = passed.evidence as { fake: boolean; usage: { input_tokens: number };
    provider_request_id: string };
  assert.equal(evidence.fake, false);
  assert.equal(evidence.usage.input_tokens, 12);
  assert.equal(evidence.provider_request_id, 'req-1');

  const failed = await new ModelSemanticChecker(async () => ({
    verdict: 'FAIL', reason: '陈述未满足', providerRequestId: 'req-2',
    usage: { inputTokens: 10, outputTokens: 5 } })).check({ ...base, content: '没有结论' });
  assert.equal(failed.result, 'FAIL');

  const uncertain = await new ModelSemanticChecker(async () => ({
    verdict: 'UNCERTAIN', reason: '依据不足', providerRequestId: 'req-3',
    usage: { inputTokens: 10, outputTokens: 5 } })).check({ ...base, content: '含糊' });
  assert.equal(uncertain.result, 'UNCERTAIN');

  const errored = await new ModelSemanticChecker(async () => {
    throw new Error('model timeout');
  }).check({ ...base, content: '任意' });
  assert.equal(errored.result, 'ERROR');
  assert.equal((errored.evidence as { reason: string }).reason, 'SEMANTIC_EVALUATION_FAILED');

  const responseError = Object.assign(new Error('invalid verdict'), {
    providerRequestId: 'req-invalid',
    usage: { inputTokens: 7, outputTokens: null },
  });
  const invalid = await new ModelSemanticChecker(async () => {
    throw responseError;
  }).check({ ...base, content: '任意' });
  assert.equal(invalid.result, 'ERROR');
  assert.deepEqual(invalid.evidence.usage, { input_tokens: 7, output_tokens: null });
  assert.equal(invalid.evidence.provider_request_id, 'req-invalid');
});

test('semantic failures retain the six Provider categories without raw messages', async () => {
  const entry = entryOf('semantic', 'SEMANTIC');
  const cases = [
    ['AUTH', Object.assign(new Error('private provider payload'), { status: 401 })],
    ['RATE_LIMIT', Object.assign(new Error('private provider payload'), { status: 429 })],
    ['TIMEOUT', Object.assign(new Error('private provider payload'), { name: 'TimeoutError' })],
    ['STREAM_BROKEN', Object.assign(new Error('private provider payload'), {
      name: 'MODEL_STREAM_INCOMPLETE' })],
    ['PROTOCOL', Object.assign(new Error('private provider payload'), { status: 422 })],
    ['NETWORK', new TypeError('fetch failed: private provider payload')],
  ] as const;
  for (const [category, error] of cases) {
    const outcome = await new ModelSemanticChecker(async () => { throw error; }).check({
      entry, content: LEGAL_CONTENT, artifactVersionId: 'v1', contentHashHex: 'ab'.repeat(32) });
    assert.equal(outcome.result, 'ERROR');
    assert.equal(outcome.evidence.error_kind, category);
    assert.equal(JSON.stringify(outcome).includes('private provider payload'), false);
  }
});

test('semantic local failures and cancellation do not invent a Provider category', async () => {
  const entry = entryOf('semantic', 'SEMANTIC');
  const local = Object.assign(new Error('private local payload'), { name: 'LocalCheckerError' });
  const controller = new AbortController();
  controller.abort();
  for (const [error, signal] of [[local, undefined],
    [new TypeError('private local payload'), undefined],
    [Object.assign(new Error('private cancellation payload'), { name: 'AbortError' }),
      controller.signal]] as const) {
    const outcome = await new ModelSemanticChecker(async () => { throw error; }).check({
      entry, content: LEGAL_CONTENT, artifactVersionId: 'v1', contentHashHex: 'ab'.repeat(32),
      ...(signal === undefined ? {} : { signal }) });
    assert.equal(outcome.result, 'ERROR');
    assert.equal(outcome.evidence.error_kind, error.name);
    assert.equal(JSON.stringify(outcome).includes('private'), false);
  }
});
