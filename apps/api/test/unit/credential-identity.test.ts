import assert from 'node:assert/strict';
import test from 'node:test';

import { accountCooldownKey, compareCredentialIdentity, computeCredentialFingerprint,
  readCredentialFingerprint } from '../../src/workflow/credential-identity.js';

/**
 * P0-2 凭据身份：换 Key 必须换身份；账户冷却键必须按凭据派生。
 * 这里只断言形状与关系，断言里不出现任何真实凭据。
 */

const HEX64 = /^[0-9a-f]{64}$/u;
const KEY_A = 'synthetic-credential-a';
const KEY_B = 'synthetic-credential-b';

test('凭据身份是 64 位小写十六进制，且不含凭据明文', () => {
  const fingerprint = computeCredentialFingerprint('openai-compatible', KEY_A);
  assert.match(fingerprint, HEX64);
  assert.equal(fingerprint.includes(KEY_A), false);
});

test('同一凭据稳定，换 Key 立即改变身份', () => {
  const a1 = computeCredentialFingerprint('openai-compatible', KEY_A);
  const a2 = computeCredentialFingerprint('openai-compatible', KEY_A);
  const b = computeCredentialFingerprint('openai-compatible', KEY_B);
  assert.equal(a1, a2);
  assert.notEqual(a1, b);
});

test('同一 Key 在不同 Provider 下是不同的身份（域分隔含 Provider）', () => {
  assert.notEqual(computeCredentialFingerprint('openai-compatible', KEY_A),
    computeCredentialFingerprint('openrouter', KEY_A));
});

test('空白凭据不产生身份，直接拒绝', () => {
  assert.throws(() => computeCredentialFingerprint('openai-compatible', '   '),
    /non-empty credential/u);
});

test('账户冷却键按凭据派生：同账户稳定，不同账户互不相同，且与凭据身份本身不同', () => {
  const accountA = accountCooldownKey(computeCredentialFingerprint('openrouter', KEY_A));
  const accountAAgain = accountCooldownKey(computeCredentialFingerprint('openrouter', KEY_A));
  const accountB = accountCooldownKey(computeCredentialFingerprint('openrouter', KEY_B));
  assert.equal(accountA, accountAAgain);
  assert.notEqual(accountA, accountB);
  // 冷却键与凭据身份是两个域：同一个摘要不能既当凭据身份又当冷却键。
  assert.notEqual(accountA, computeCredentialFingerprint('openrouter', KEY_A));
  assert.match(accountA, HEX64);
});

test('凭据比较区分 MATCH / CHANGED / UNKNOWN，旧数据不冒充匹配', () => {
  const current = readCredentialFingerprint({ provider: 'openai-compatible', apiKey: KEY_A });
  assert.equal(compareCredentialIdentity(current, current), 'MATCH');
  assert.equal(compareCredentialIdentity(
    readCredentialFingerprint({ provider: 'openai-compatible', apiKey: KEY_B }), current), 'CHANGED');
  assert.equal(compareCredentialIdentity(null, current), 'UNKNOWN');
  assert.equal(compareCredentialIdentity(undefined, current), 'UNKNOWN');
  assert.equal(compareCredentialIdentity('', current), 'UNKNOWN');
});
