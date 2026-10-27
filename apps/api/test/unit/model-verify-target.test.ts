import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_VERIFY_TARGET, VERIFY_TARGET_STATES, describeVerifyTarget,
  describeVerifyTargetState, isFreeCatalogTarget, type VerifyTargetStateInput } from
  '../../src/workflow/model-verify-target.js';

/**
 * P1-4 验证目标状态词表：13 态互斥、优先级固定。
 * 这里只断言推导，不涉及配置读取、目录同步或外呼。
 */

const FP = 'a'.repeat(64);

function input(overrides: Partial<VerifyTargetStateInput> = {}): VerifyTargetStateInput {
  return {
    configured: true,
    configIncomplete: false,
    catalog: null,
    accountCooldownActive: false,
    credentialIdentity: 'UNKNOWN',
    currentFingerprint: FP,
    last: null,
    ...overrides,
  };
}

test('词表恰好 13 态且无重复', () => {
  assert.equal(VERIFY_TARGET_STATES.length, 13);
  assert.equal(new Set(VERIFY_TARGET_STATES).size, 13);
});

test('未配置 / 残缺优先于任何历史结论', () => {
  assert.equal(describeVerifyTargetState(input({ configured: false,
    last: { ok: true, configFingerprint: FP, errorKind: null } })), 'NOT_CONFIGURED');
  assert.equal(describeVerifyTargetState(input({ configIncomplete: true })), 'CONFIG_INCOMPLETE');
});

test('目录事实先于上次验证：不在目录 / 不免费 / 能力不足 / 目录过期分别成立', () => {
  const last = { ok: true, configFingerprint: FP, errorKind: null };
  assert.equal(describeVerifyTargetState(input({ last,
    catalog: { fresh: true, entry: null } })), 'FREE_INELIGIBLE');
  assert.equal(describeVerifyTargetState(input({ last,
    catalog: { fresh: true, entry: { free: false, textInput: true, textOutput: true } } })),
  'FREE_INELIGIBLE');
  assert.equal(describeVerifyTargetState(input({ last,
    catalog: { fresh: true, entry: { free: true, textInput: true, textOutput: false } } })),
  'CAPABILITY_INSUFFICIENT');
  assert.equal(describeVerifyTargetState(input({ last,
    catalog: { fresh: false, entry: { free: true, textInput: true, textOutput: true } } })),
  'CATALOG_STALE');
});

test('账户冷却先于上次验证结果：冷却期内不显示已验证', () => {
  assert.equal(describeVerifyTargetState(input({ accountCooldownActive: true,
    last: { ok: true, configFingerprint: FP, errorKind: null } })), 'ACCOUNT_COOLDOWN');
});

test('没有历史行 → UNVERIFIED；指纹不符 → UNVERIFIED（旧结论不继承）', () => {
  assert.equal(describeVerifyTargetState(input()), 'UNVERIFIED');
  assert.equal(describeVerifyTargetState(input({
    last: { ok: true, configFingerprint: 'b'.repeat(64), errorKind: null } })), 'UNVERIFIED');
});

test('凭据变化 → CREDENTIAL_CHANGED，即使上次是成功', () => {
  assert.equal(describeVerifyTargetState(input({ credentialIdentity: 'CHANGED',
    last: { ok: true, configFingerprint: FP, errorKind: null } })), 'CREDENTIAL_CHANGED');
});

test('成功 → VERIFIED；失败按 error_kind 映射到可操作状态', () => {
  assert.equal(describeVerifyTargetState(input({
    last: { ok: true, configFingerprint: FP, errorKind: null } })), 'VERIFIED');
  const failed = (errorKind: string | null) => describeVerifyTargetState(input({
    last: { ok: false, configFingerprint: FP, errorKind } }));
  assert.equal(failed('AUTH'), 'AUTH_FAILED');
  assert.equal(failed('MODEL_NOT_FOUND'), 'MODEL_NOT_FOUND');
  assert.equal(failed('RATE_LIMIT'), 'ACCOUNT_COOLDOWN');
  assert.equal(failed('BUDGET_EXHAUSTED'), 'BUDGET_EXHAUSTED');
  assert.equal(failed('TIMEOUT'), 'UNKNOWN');
  assert.equal(failed('NETWORK'), 'UNKNOWN');
  assert.equal(failed(null), 'UNKNOWN');
});

test('默认连接没有目录依据：catalog 为 null 时不被目录事实短路', () => {
  assert.equal(describeVerifyTargetState(input({ catalog: null,
    last: { ok: true, configFingerprint: FP, errorKind: null } })), 'VERIFIED');
});

test('目标标识稳定且不含凭据；只有 OpenRouter 目录型号需要零价守卫', () => {
  assert.equal(describeVerifyTarget(DEFAULT_VERIFY_TARGET), 'default');
  assert.equal(describeVerifyTarget({ connection: 'openrouter', model: 'free/model-x' }),
    'openrouter:free/model-x');
  assert.equal(isFreeCatalogTarget(DEFAULT_VERIFY_TARGET), false);
  assert.equal(isFreeCatalogTarget({ connection: 'openrouter', model: 'free/model-x' }), true);
});
