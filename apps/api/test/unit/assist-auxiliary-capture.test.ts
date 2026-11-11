import assert from 'node:assert/strict';
import test from 'node:test';

import { withAuxiliaryCaptureBound } from '../../src/application/assist-runner.js';

/**
 * 结算后的辅助外呼上界（2026-11-10）。
 *
 * 背景：桌面 Supervisor 按一次性 Worker 子进程退出推进派发。自动记忆提取是回复结算后的
 * 附带调用；它若永不返回，Worker 就会停在「消息已 COMPLETED、进程不退出」，后续消息
 * 一直 PENDING（界面只剩「等待处理」）。这里钉住三条：超时后调用方继续、超时前完成
 * 不改变结果、外层中止（宿主停机/租约丢失）能传进这一次调用。
 */

test('辅助外呼超时后调用方继续，并给出已中止信号', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal: AbortSignal | undefined;
  const pending = withAuxiliaryCaptureBound('message-1', undefined, (current) => {
    signal = current;
    return new Promise<number>(() => { /* 永远不返回：模拟不响应中止的挂起调用 */ });
  });
  t.mock.timers.tick(30_000);
  assert.equal(await pending, undefined);
  assert.equal(signal?.aborted, true);
});

test('按上界前完成时返回真实结果，不额外触发中止', async () => {
  let aborted = false;
  const result = await withAuxiliaryCaptureBound('message-2', undefined, async (signal) => {
    signal.addEventListener('abort', () => { aborted = true; });
    return 7;
  });
  assert.equal(result, 7);
  assert.equal(aborted, false);
});

test('外层中止传进这一次调用：调用方收到拒绝而不是被吞掉', async () => {
  const outer = new AbortController();
  const pending = withAuxiliaryCaptureBound('message-3', outer.signal, (signal) =>
    new Promise<number>((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('outer aborted')), { once: true });
    }));
  outer.abort(new Error('worker stopping'));
  await assert.rejects(pending, /outer aborted/u);
});
