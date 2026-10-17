import assert from 'node:assert/strict';
import test from 'node:test';

import { parseFrozenModelConstraint, FrozenModelConstraintError,
  type FrozenModelConstraint } from '../../src/workflow/frozen-model-constraint.js';

const FP = 'a'.repeat(64);

function validConstraint(): FrozenModelConstraint {
  return {
    connection: { provider: 'openai-compatible', model: 'free/model-x', configFingerprint: FP },
    freeOnly: true,
    catalogBasis: { source: 'openrouter', snapshotSeq: '3', sourceModelId: 'free/model-x' },
  };
}

test('缺省/空快照返回 undefined，调用方保留原默认行为', () => {
  assert.equal(parseFrozenModelConstraint(undefined), undefined);
  assert.equal(parseFrozenModelConstraint(null), undefined);
});

test('合法冻结快照原样解析、保留确切模型 ID 与目录依据', () => {
  assert.deepEqual(parseFrozenModelConstraint(validConstraint()), validConstraint());
});

test('freeOnly 缺省视为无免费约束，但不用 false 冒充“已知非免费”之外语义', () => {
  const base = validConstraint() as unknown as Record<string, unknown>;
  const noFlag = { ...base, freeOnly: undefined };
  const parsed = parseFrozenModelConstraint(noFlag);
  assert.equal(parsed?.freeOnly, false);
});

test('budget 可选：给出时随快照一起冻结', () => {
  const withBudget = { ...validConstraint(),
    budget: { callReservationTokens: 4096, scopeCallLimit: 32, scopeTokenLimit: 262144 } };
  assert.deepEqual(parseFrozenModelConstraint(withBudget)?.budget, withBudget.budget);
});

for (const [name, mutation] of [
  ['provider 为空', (c: Record<string, unknown>) => ({ ...c,
    connection: { ...(c.connection as object), provider: '  ' } })],
  ['模型 ID 为空', (c: Record<string, unknown>) => ({ ...c,
    connection: { ...(c.connection as object), model: '' } })],
  ['指纹非 64 hex', (c: Record<string, unknown>) => ({ ...c,
    connection: { ...(c.connection as object), configFingerprint: 'zzz' } })],
  ['freeOnly 非布尔', (c: Record<string, unknown>) => ({ ...c, freeOnly: 'yes' })],
  ['catalogBasis.source 非 openrouter', (c: Record<string, unknown>) => ({ ...c,
    catalogBasis: { source: 'other', snapshotSeq: '1', sourceModelId: 'm' } })],
  ['snapshotSeq 非数字串', (c: Record<string, unknown>) => ({ ...c,
    catalogBasis: { source: 'openrouter', snapshotSeq: 'v3', sourceModelId: 'm' } })],
  ['budget 非正整数', (c: Record<string, unknown>) => ({ ...c,
    budget: { callReservationTokens: 0, scopeCallLimit: 32, scopeTokenLimit: 262144 } })],
] as const) {
  test(`畸形冻结快照判不合法（不升级为免费/确切模型）：${name}`, () => {
    const bad = mutation(validConstraint() as unknown as Record<string, unknown>);
    assert.throws(() => parseFrozenModelConstraint(bad), FrozenModelConstraintError);
  });
}

test('非对象快照直接抛错', () => {
  assert.throws(() => parseFrozenModelConstraint('free/model-x'), FrozenModelConstraintError);
  assert.throws(() => parseFrozenModelConstraint([1, 2]), FrozenModelConstraintError);
});
