import assert from 'node:assert/strict';
import test from 'node:test';
import { assessMemorySummary, MEMORY_SUMMARY_SECTIONS } from '../../src/application/assist-memory-quality.js';

function summaryText(overrides: Partial<Record<string, string>> = {}): string {
  return MEMORY_SUMMARY_SECTIONS.map((section) => `【${section}】${overrides[section] ?? '无'}`).join('\n');
}

function compactionInput(turns: readonly { status: string; content: string | null }[], previousSummary: string | null = null) {
  return JSON.stringify({ previous_summary: previousSummary, completed_turns: turns });
}

function assess(summary: string, input: string, previousSummary: string | null = null) {
  return assessMemorySummary({ summary, previousSummary, content: input });
}

test('fixed sections pass and structured fields are all recognized', () => {
  const input = compactionInput([{ status: 'COMPLETED', content: 'yes' }]);
  assert.deepEqual(assess(summaryText({ '当前目标': '整理发布说明' }), input), { ok: true });
});

test('unstructured or truncated summary is rejected before publication', () => {
  const input = compactionInput([{ status: 'COMPLETED', content: 'yes' }]);
  assert.deepEqual(assess('全部沿用之前的结论。', input), { ok: false, code: 'MEMORY_SUMMARY_SECTIONS_MISSING' });
  assert.deepEqual(assess('【当前目标】继续\n【有效约束】无', input), { ok: true },
    'two canonical sections are the minimum');
});

test('a summary that is not shorter than the input is rejected only when there is real input', () => {
  const longTurn = 'h'.repeat(2000);
  const input = compactionInput([{ status: 'COMPLETED', content: longTurn }]);
  assert.deepEqual(assess(`${summaryText()}${'x'.repeat(3000)}`, input), { ok: false, code: 'MEMORY_SUMMARY_NOT_COMPRESSED' });
  const tiny = compactionInput([{ status: 'COMPLETED', content: 'ok' }]);
  assert.deepEqual(assess(summaryText(), tiny), { ok: true },
    'trivial histories are not forced to produce a shorter summary');
});

test('FAILED, CANCELLED, WITHDRAWN and unavailable sources cannot disappear', () => {
  const input = compactionInput([
    { status: 'FAILED', content: '上传失败' },
    { status: 'CANCELLED', content: null },
    { status: 'WITHDRAWN', content: null },
    { status: 'SOURCE_UNAVAILABLE', content: null },
  ]);
  assert.deepEqual(assess(summaryText(), input), { ok: false, code: 'MEMORY_SUMMARY_STATUS_LOST' });
  assert.deepEqual(assess(summaryText({
    '未决问题': 'FAILED 上传失败；CANCELLED 已取消；WITHDRAWN 已撤回；SOURCE_UNAVAILABLE 来源失效',
  }), input), { ok: true });
  const previous = '【未决问题】FAILED 构建失败';
  assert.deepEqual(assess(summaryText(), input, previous), { ok: false, code: 'MEMORY_SUMMARY_STATUS_LOST' });
});

test('file paths and identifiers survive, and a basename is enough', () => {
  const input = compactionInput([{ status: 'COMPLETED', content: '改了 apps/api/src/application/assist-memory.ts、'
    + 'apps/api/src/assist/assist-memory-repository.ts 和 docs/architecture/agent-prompt-design.md' }]);
  assert.deepEqual(assess(summaryText({ '已验证进展': '完成三轮修改' }), input),
    { ok: false, code: 'MEMORY_SUMMARY_IDENTIFIER_LOST' });
  assert.deepEqual(assess(summaryText({ '已验证进展': '修改 assist-memory.ts 并记录到 agent-prompt-design.md' }), input),
    { ok: true });
});
