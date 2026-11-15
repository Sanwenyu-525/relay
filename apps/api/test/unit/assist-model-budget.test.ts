import assert from 'node:assert/strict';
import test from 'node:test';

import { planAssistModelBudget } from '../../src/application/assist-model-snapshot.js';

const config = { maxCallTokens: 1_048_576, maxScopeCalls: 32, maxScopeTokens: 1_048_576 };

test('256K 模型：作用域按配置上限放行，至少覆盖一笔单次预留', () => {
  const plan = planAssistModelBudget(config, { modelWindowTokens: 262_144 });
  assert.equal(plan.callReservationTokens, 262_144);
  assert.equal(plan.scopeTokenLimit, 1_048_576);
});

test('回归：上一轮 TITLE 辅助调用在途时，下一条消息的预留必须放行', () => {
  const plan = planAssistModelBudget(config, { modelWindowTokens: 262_144 });
  const settled = 10_397;
  const needed = settled + plan.callReservationTokens * 2;
  assert.ok(needed > 524_288, '这组实测数字必须越过旧下限，用例才有回归意义');
  assert.ok(needed <= plan.scopeTokenLimit, '旧公式 524288 在这里会把用户下一条消息判成预算耗尽');
});

test('窗口未知：按 256K 安全回退，不假定 1M', () => {
  const plan = planAssistModelBudget(config, { modelWindowTokens: null });
  assert.equal(plan.callReservationTokens, 262_144);
  assert.equal(plan.contextBudgetTokens, 262_144);
  assert.equal(plan.contextWindowSource, 'UNKNOWN_FALLBACK');
  assert.equal(plan.fallbackApplied, true);
});

test('Provider 窗口小于配置时按窗口截断，作用域仍不低配单次预留', () => {
  const plan = planAssistModelBudget(config, { modelWindowTokens: 131_072 });
  assert.equal(plan.callReservationTokens, 131_072);
  assert.equal(plan.scopeTokenLimit, 1_048_576);
});

test('1M 目标不会把作用域抬到 3M，配置仍是硬上限', () => {
  const plan = planAssistModelBudget({ maxCallTokens: 1_000_000,
    maxScopeCalls: 32, maxScopeTokens: 1_000_000 }, { modelWindowTokens: 1_000_000 });
  assert.equal(plan.callReservationTokens, 1_000_000);
  assert.equal(plan.scopeTokenLimit, 1_000_000);
});

test('服务商单次硬上限低于模型窗口时以硬上限为准', () => {
  const plan = planAssistModelBudget({ ...config, maxScopeTokens: 1_048_576 },
    { modelWindowTokens: 1_000_000, providerCallCapTokens: 65_536 });
  assert.equal(plan.callReservationTokens, 65_536);
  assert.equal(plan.scopeTokenLimit, 1_048_576);
});

test('连接自带的更大作用域上限仍然生效', () => {
  const plan = planAssistModelBudget({ ...config, maxScopeTokens: 2_000_000 },
    { modelWindowTokens: 262_144 });
  assert.equal(plan.scopeTokenLimit, 2_000_000);
});
