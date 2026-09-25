import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MIN_CANDIDATE_CHARS,
  P05_EXECUTED_STEP_KINDS,
  REQUIRED_SECTIONS,
  WORKFLOW_KEY,
  WORKFLOW_STEPS,
  WORKFLOW_VERSION,
  validateCandidate,
} from '../../src/workflow/markdown-deliverable.js';

/**
 * markdown-deliverable-v1 的结构校验与固定步骤序列（P05）。
 * 校验必须确定性：同输入同结论，不调用模型、不依赖时间或随机。
 */

function legalCandidate(): string {
  return [
    '# 候选交付',
    '',
    '## 摘要',
    '',
    '本候选覆盖固定必需结构，用于验证。',
    '',
    '## 结论',
    '',
    '结论：候选满足必需小节。',
    '',
  ].join('\n');
}

test('exposes the fixed workflow identity and step sequence', () => {
  assert.equal(WORKFLOW_KEY, 'markdown-deliverable-v1');
  assert.equal(WORKFLOW_VERSION, '1');
  assert.deepEqual(WORKFLOW_STEPS, [
    'BUILD_CONTEXT',
    'DRAFT',
    'PERSIST_CANDIDATE',
    'VERIFY',
    'COMPLETE',
  ]);
  assert.deepEqual(P05_EXECUTED_STEP_KINDS, ['BUILD_CONTEXT', 'DRAFT', 'PERSIST_CANDIDATE']);
  assert.deepEqual(REQUIRED_SECTIONS, ['摘要', '结论']);
});

test('accepts a candidate with a title and every required non-empty section', () => {
  const result = validateCandidate(legalCandidate());

  assert.equal(result.ok, true);
  assert.deepEqual(result.issues, []);
});

test('reports a missing required section deterministically', () => {
  const withoutConclusion = [
    '# 候选交付',
    '',
    '## 摘要',
    '',
    '本候选缺少结论小节。',
    '',
  ].join('\n');
  const first = validateCandidate(withoutConclusion);
  const second = validateCandidate(withoutConclusion);

  assert.equal(first.ok, false);
  assert.deepEqual(first, second);
  assert.ok(first.issues.some((issue) => issue.code === 'MISSING_SECTION'));
});

test('reports a missing top-level title and an empty section', () => {
  const noTitle = ['## 摘要', '', '正文', '', '## 结论', '', '结论正文'].join('\n');
  const emptySection = ['# 标题', '', '## 摘要', '', '## 结论', '', '结论正文'].join('\n');

  assert.ok(validateCandidate(noTitle).issues.some((issue) => issue.code === 'MISSING_TITLE'));
  assert.ok(validateCandidate(emptySection).issues.some((issue) => issue.code === 'EMPTY_SECTION'));
});

test('reports a candidate shorter than the minimum length', () => {
  const short = `# x\n## 摘要\n## 结论`;
  const result = validateCandidate(short);

  assert.ok(short.length < MIN_CANDIDATE_CHARS);
  assert.ok(result.issues.some((issue) => issue.code === 'TOO_SHORT'));
});
