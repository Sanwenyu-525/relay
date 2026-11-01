import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { fileReadExecute } from '../../src/application/gateway-actions.js';

/**
 * 受控读取的风险读数与产品边界（P1-D / P1-3，2026-10-31）。
 *
 * 这里只钉三件界面会依赖的事实：
 *   · 有冻结预算时，结果带 `context_risk`（与发送前审计同一套阈值）；
 *   · 高/严重时带一句 `notice`，不只是一个百分比；
 *   · 没有预算就**不写**该字段——不编一个分母，也不假装读过。
 *
 * 边界：它是读取时的读数（stat 先于 readFile），不是读取前拦住用户的确认——
 * 准入仍由 Gateway 与审批决定，本函数不改结果。
 */

function operation(target: string) {
  return { id: 'op-1', normalized_target: target } as unknown as Parameters<typeof fileReadExecute>[0];
}

const invocation = { id: 'inv-1' } as unknown as Parameters<typeof fileReadExecute>[1];

async function withFile(bytes: number, run: (path: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'relay-read-risk-'));
  const path = join(root, 'AGENTS.md');
  try {
    await writeFile(path, 'a'.repeat(bytes));
    await run(path);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('大文件读取：带 context_risk 与一句读数', async () => {
  await withFile(300_000, async (path) => {
    const read = await fileReadExecute(operation(path), invocation, undefined, null, 100_000);
    assert.equal(read.outcome, 'SUCCEEDED');
    const risk = read.result.context_risk as { severity: string; ratio: number | null;
      budget_tokens: number | null; notice?: string } | undefined;
    assert.ok(risk !== undefined, '有预算时必须给读数');
    assert.equal(risk!.severity, 'SEVERE');
    assert.equal(risk!.budget_tokens, 100_000);
    assert.ok(typeof risk!.notice === 'string' && risk!.notice.includes('这次读取约占'));
  });
});

test('小文件读取：只给读数，不说成风险', async () => {
  await withFile(3_000, async (path) => {
    const read = await fileReadExecute(operation(path), invocation, undefined, null, 100_000);
    const risk = read.result.context_risk as { severity: string; notice?: string } | undefined;
    assert.equal(risk?.severity, 'NONE');
    assert.equal(risk?.notice, undefined);
  });
});

test('没有冻结预算：不写 context_risk，不编分母', async () => {
  await withFile(3_000, async (path) => {
    const read = await fileReadExecute(operation(path), invocation, undefined, null, null);
    assert.equal(read.outcome, 'SUCCEEDED');
    assert.equal('context_risk' in read.result, false);
  });
});
