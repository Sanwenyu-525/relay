import assert from 'node:assert/strict';
import test from 'node:test';

import { planAssistModelBudget } from '../../src/application/assist-model-snapshot.js';

const config = { maxCallTokens: 8_192, maxScopeCalls: 32, maxScopeTokens: 262_144 };

test('256K 档：作用域下限要盖住两笔在途预留加一笔已结算余量', () => {
  const plan = planAssistModelBudget(config, 262_144, 262_144);
  assert.equal(plan.callReservationTokens, 262_144);
  assert.equal(plan.scopeTokenLimit, 786_432);
});

test('回归：上一轮 TITLE 辅助调用在途时，下一条消息的预留必须放行', () => {
  const plan = planAssistModelBudget(config, 262_144, 262_144);
  const settled = 10_397;
  const needed = settled + plan.callReservationTokens * 2;
  assert.ok(needed > 524_288, '这组实测数字必须越过旧下限，用例才有回归意义');
  assert.ok(needed <= plan.scopeTokenLimit, '旧公式 524288 在这里会把用户下一条消息判成预算耗尽');
});

test('未选档位时保持原口径：作用域取进程默认，不被单次预留撑大', () => {
  const plan = planAssistModelBudget(config, null, null);
  assert.equal(plan.callReservationTokens, 8_192);
  assert.equal(plan.scopeTokenLimit, 262_144);
});

test('Provider 窗口小于档位时按窗口截断，下限随之缩小', () => {
  const plan = planAssistModelBudget(config, 262_144, 131_072);
  assert.equal(plan.callReservationTokens, 131_072);
  assert.equal(plan.scopeTokenLimit, 393_216);
});

test('连接自带的更大作用域上限仍然生效', () => {
  const plan = planAssistModelBudget({ ...config, maxScopeTokens: 1_048_576 }, 262_144, 262_144);
  assert.equal(plan.scopeTokenLimit, 1_048_576);
});