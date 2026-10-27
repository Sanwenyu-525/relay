import assert from 'node:assert/strict';
import test from 'node:test';

import { CredentialStoreError, CredentialStoreUnavailableError,
  type CredentialStore } from '../../src/credentials/credential-store.js';
import { applyCredentialEnv, applyCredentialEnvFromStore, CREDENTIAL_ENV_VARIABLES,
  CredentialEnvError, credentialRefVariable, hasCredentialReference, materializeCredentialEnv }
  from '../../src/credentials/credential-env.js';
import { readModelPortConfig } from '../../src/workflow/model-port-config.js';

/**
 * 凭据引用物化（ADR-036 的虚拟内置连接）。
 *
 * 这一层决定「进程启动时到底用的是哪把 Key」，所以每条失败路径都必须**让启动失败**，
 * 而不是回落明文、回落默认模型或回落「未配置」——那三种回落都会悄悄改变模型身份。
 */

const SECRET = 'synthetic-key-from-store-0123456789';

function memoryStore(entries: Record<string, string>, options: {
  readonly failWith?: Error;
} = {}): CredentialStore & { readonly calls: string[] } {
  const calls: string[] = [];
  const store: CredentialStore = {
    async put(reference) { calls.push(`put:${reference}`); },
    async resolve(reference) {
      calls.push(`resolve:${reference}`);
      if (options.failWith !== undefined) throw options.failWith;
      return entries[reference];
    },
    async delete(reference) { calls.push(`delete:${reference}`); },
    async status(reference) { calls.push(`status:${reference}`); return reference in entries; },
  };
  return Object.assign(store, { calls });
}

test('没有任何引用时完全不动环境，也不碰凭据库', async () => {
  const env = { RELAY_MODEL_PROVIDER: 'openai-compatible', RELAY_MODEL_API_KEY: 'literal-key' };
  const store = memoryStore({});
  const resolved = await materializeCredentialEnv(env, { store });
  assert.deepEqual(resolved, env);
  assert.notEqual(resolved, env, '必须返回新对象，调用方不会意外共享可变环境');
  assert.deepEqual(store.calls, []);
  assert.equal(hasCredentialReference(env), false);
});

test('引用解析后填入对应变量，原环境对象不被修改', async () => {
  const env: NodeJS.ProcessEnv = { RELAY_MODEL_PROVIDER: 'openai-compatible',
    RELAY_MODEL_API_KEY_REF: 'cred-primary', RELAY_MODEL_NAME: 'gpt-test' };
  const store = memoryStore({ 'cred-primary': SECRET });
  const resolved = await materializeCredentialEnv(env, { store });
  assert.equal(resolved.RELAY_MODEL_API_KEY, SECRET);
  assert.equal(env.RELAY_MODEL_API_KEY, undefined);
  assert.deepEqual(store.calls, ['resolve:cred-primary']);
  assert.equal(hasCredentialReference(env), true);
  // 物化后的配置能被既有的同步读取点直接消费——这正是「不动 20+ 个读取点」的前提。
  const config = readModelPortConfig(resolved);
  assert.equal(config?.apiKey, SECRET);
  assert.equal(config?.model, 'gpt-test');
});

test('明文与引用同时存在 → 启动失败，且不去解析凭据', async () => {
  const env = { RELAY_MODEL_API_KEY: 'literal-key', RELAY_MODEL_API_KEY_REF: 'cred-primary' };
  const store = memoryStore({ 'cred-primary': SECRET });
  await assert.rejects(materializeCredentialEnv(env, { store }), (error: unknown) =>
    error instanceof CredentialEnvError && error.code === 'CREDENTIAL_ENV_AMBIGUOUS' &&
      error.message.includes('RELAY_MODEL_API_KEY_REF') && error.message.includes('RELAY_MODEL_API_KEY'));
  assert.deepEqual(store.calls, []);
});

test('引用指向不存在的凭据 → 启动失败，不回落明文也不回落未配置', async () => {
  const env = { RELAY_MODEL_API_KEY_REF: 'cred-missing' };
  await assert.rejects(materializeCredentialEnv(env, { store: memoryStore({}) }),
    (error: unknown) => error instanceof CredentialEnvError &&
      error.code === 'CREDENTIAL_REF_NOT_FOUND');
  // 空串同样按「没有凭据」处理：空 Key 会让上游返回 401，却看起来像「已配置」。
  await assert.rejects(materializeCredentialEnv(env,
    { store: memoryStore({ 'cred-missing': '   ' }) }),
  (error: unknown) => error instanceof CredentialEnvError &&
    error.code === 'CREDENTIAL_REF_NOT_FOUND');
});

test('凭据库故障 → 启动失败，消息只含错误码不含秘密', async () => {
  const env = { RELAY_MODEL_API_KEY_REF: 'cred-primary' };
  const store = memoryStore({}, { failWith: new CredentialStoreUnavailableError('HELPER_TIMEOUT',
    'credential helper timed out') });
  await assert.rejects(materializeCredentialEnv(env, { store }), (error: unknown) => {
    assert.ok(error instanceof CredentialEnvError);
    assert.equal(error.code, 'CREDENTIAL_STORE_UNAVAILABLE');
    assert.match(error.message, /HELPER_TIMEOUT/u);
    assert.equal(error.message.includes(SECRET), false);
    return true;
  });
  // helper 报出的业务错误同样收敛为不可用，而不是当成「未配置」。
  await assert.rejects(materializeCredentialEnv(env,
    { store: memoryStore({}, { failWith: new CredentialStoreError('UNPROTECT_FAILED', 'dpapi') }) }),
  (error: unknown) => error instanceof CredentialEnvError &&
    error.code === 'CREDENTIAL_STORE_UNAVAILABLE');
});

test('多个变量各自独立：只配 OpenRouter 引用不影响默认模型 Key', async () => {
  const env = { RELAY_MODEL_PROVIDER: 'fake', RELAY_OPENROUTER_API_KEY_REF: 'cred-openrouter' };
  const resolved = await materializeCredentialEnv(env,
    { store: memoryStore({ 'cred-openrouter': 'openrouter-secret' }) });
  assert.equal(resolved.RELAY_OPENROUTER_API_KEY, 'openrouter-secret');
  assert.equal(resolved.RELAY_MODEL_API_KEY, undefined);
  assert.equal(resolved.RELAY_MODEL_PROVIDER, 'fake');
});

test('写回环境时删除已消费的引用，二次物化不再被判成歧义', async () => {
  const env: NodeJS.ProcessEnv = { RELAY_MODEL_API_KEY_REF: 'cred-primary' };
  const store = memoryStore({ 'cred-primary': SECRET });
  applyCredentialEnv(env, await materializeCredentialEnv(env, { store }));
  assert.equal(env.RELAY_MODEL_API_KEY, SECRET);
  assert.equal(env.RELAY_MODEL_API_KEY_REF, undefined);
  // 第二次调用是 no-op（引用已消费），不会因为「明文 + 引用」而失败。
  const again = await materializeCredentialEnv(env, { store });
  assert.equal(again.RELAY_MODEL_API_KEY, SECRET);
  assert.deepEqual(store.calls, ['resolve:cred-primary']);
});

test('启动便捷入口写回同一个环境对象', async () => {
  const env: NodeJS.ProcessEnv = { RELAY_MODEL_API_KEY_REF: 'cred-primary' };
  await applyCredentialEnvFromStore(env, { store: memoryStore({ 'cred-primary': SECRET }) });
  assert.equal(env.RELAY_MODEL_API_KEY, SECRET);
});

test('变量与引用命名是既有契约的一部分：只追加 _REF 后缀，不改变量名', () => {
  assert.deepEqual([...CREDENTIAL_ENV_VARIABLES],
    ['RELAY_MODEL_API_KEY', 'RELAY_OPENROUTER_API_KEY', 'OPENROUTER_API_KEY']);
  for (const name of CREDENTIAL_ENV_VARIABLES) {
    assert.equal(credentialRefVariable(name), `${name}_REF`);
  }
});
