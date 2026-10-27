import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { CredentialStoreError, CredentialStoreUnavailableError, isCredentialReference,
  requireCredentialReference } from '../../src/credentials/credential-store.js';
import { createDpapiCredentialStore, resolveCredentialHelperExecutable,
  resolveCredentialRoot } from '../../src/credentials/dpapi-credential-store.js';

/**
 * 凭据存储适配器（P2 前置设施）：用可控假 helper 验证**协议边界**，不测 DPAPI 本身
 * （DPAPI 由 `apps/credential-helper` 的 Rust 单测覆盖，那里是真实加密）。
 *
 * 重点：秘密只在管道里出现；失败一律是类型化错误；错误消息绝不回显秘密。
 */

const FAKE_HELPER = String.raw`
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const mode = process.env.FAKE_CREDENTIAL_MODE ?? 'ok';
  const reply = (body) => { process.stdout.write(JSON.stringify(body) + '\n'); };
  if (mode === 'garbage') { process.stdout.write('not json\n'); return; }
  if (mode === 'exit') { process.exitCode = 3; return; }
  if (mode === 'slow') { setTimeout(() => reply({ version: 'relay-credential-v1', ok: true }), 5000); return; }
  let request;
  try { request = JSON.parse(input); } catch { reply({ version: 'relay-credential-v1', ok: false,
    error: { code: 'INVALID_REQUEST', message: 'bad json' } }); return; }
  if (request.version !== 'relay-credential-v1') { reply({ version: 'other', ok: false }); return; }
  if (request.op === 'protect') { reply({ version: 'relay-credential-v1', ok: true, exists: true }); return; }
  if (request.op === 'resolve') {
    if (request.reference === 'cred-missing') { reply({ version: 'relay-credential-v1', ok: false,
      exists: false, error: { code: 'NOT_FOUND', message: 'no credential stored' } }); return; }
    if (request.reference === 'cred-broken') { reply({ version: 'relay-credential-v1', ok: false,
      error: { code: 'UNPROTECT_FAILED', message: 'DPAPI unprotect failed' } }); return; }
    reply({ version: 'relay-credential-v1', ok: true, secret: 'synthetic-secret-from-fake-helper' });
    return;
  }
  if (request.op === 'status') { reply({ version: 'relay-credential-v1', ok: true,
    exists: request.reference === 'cred-present' }); return; }
  if (request.op === 'delete') { reply({ version: 'relay-credential-v1', ok: true, exists: false }); return; }
  reply({ version: 'relay-credential-v1', ok: false, error: { code: 'UNKNOWN_OP', message: 'no' } });
});
`;

async function fakeStore(options: { timeoutMs?: number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'relay-credential-unit-'));
  const script = join(dir, 'fake-helper.mjs');
  await writeFile(script, FAKE_HELPER, 'utf8');
  return createDpapiCredentialStore({ root: dir, executable: process.execPath,
    args: [script], ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) });
}

test('引用规则与 helper 一致：拒绝分隔符、点号、过短与首字符非字母数字', () => {
  assert.equal(isCredentialReference('cred-0001'), true);
  for (const invalid of ['../escape', 'a/b', 'a\\b', 'short', '-leading', '_leading',
    'has.dot', 'x'.repeat(65)]) {
    assert.equal(isCredentialReference(invalid), false, invalid);
  }
  assert.throws(() => requireCredentialReference('../escape'),
    (error: unknown) => error instanceof CredentialStoreError && error.code === 'INVALID_REFERENCE');
});

test('put / resolve / status / delete 走同一协议，解析返回秘密', async () => {
  const store = await fakeStore();
  await store.put('cred-roundtrip', 'synthetic-secret');
  assert.equal(await store.resolve('cred-roundtrip'), 'synthetic-secret-from-fake-helper');
  assert.equal(await store.status('cred-present'), true);
  assert.equal(await store.status('cred-absent'), false);
  await store.delete('cred-roundtrip');
});

test('引用不存在返回 undefined（未配置不是故障），存储故障才是错误', async () => {
  const store = await fakeStore();
  assert.equal(await store.resolve('cred-missing'), undefined);
  await assert.rejects(store.resolve('cred-broken'), (error: unknown) =>
    error instanceof CredentialStoreError && error.code === 'UNPROTECT_FAILED');
});

test('空秘密与非法引用在启动 helper 之前就被拒绝', async () => {
  const store = await fakeStore();
  await assert.rejects(store.put('cred-empty', '   '), (error: unknown) =>
    error instanceof CredentialStoreError && error.code === 'EMPTY_SECRET');
  await assert.rejects(store.put('../escape', 'synthetic'), (error: unknown) =>
    error instanceof CredentialStoreError && error.code === 'INVALID_REFERENCE');
});

test('helper 输出畸形 / 非零退出 / 超时都是类型化不可用错误', async () => {
  const previous = process.env.FAKE_CREDENTIAL_MODE;
  try {
    process.env.FAKE_CREDENTIAL_MODE = 'garbage';
    await assert.rejects((await fakeStore()).status('cred-present'), (error: unknown) =>
      error instanceof CredentialStoreUnavailableError && error.code === 'HELPER_PROTOCOL');
    process.env.FAKE_CREDENTIAL_MODE = 'exit';
    await assert.rejects((await fakeStore()).status('cred-present'), (error: unknown) =>
      error instanceof CredentialStoreUnavailableError && error.code === 'HELPER_EXIT');
    process.env.FAKE_CREDENTIAL_MODE = 'slow';
    await assert.rejects((await fakeStore({ timeoutMs: 150 })).status('cred-present'),
      (error: unknown) => error instanceof CredentialStoreUnavailableError &&
        error.code === 'HELPER_TIMEOUT');
  } finally {
    if (previous === undefined) delete process.env.FAKE_CREDENTIAL_MODE;
    else process.env.FAKE_CREDENTIAL_MODE = previous;
  }
});

test('错误消息与错误对象都不携带秘密', async () => {
  const store = await fakeStore();
  try {
    await store.put('cred-empty', '   ');
  } catch (error) {
    const text = `${(error as Error).message} ${JSON.stringify(error)}`;
    assert.equal(text.includes('synthetic-secret'), false);
  }
  const secret = await store.resolve('cred-roundtrip');
  assert.equal(secret, 'synthetic-secret-from-fake-helper');
});

test('helper 路径与存放根的解析：显式配置优先，相对路径不冒充绝对路径', () => {
  assert.equal(resolveCredentialHelperExecutable({ RELAY_CREDENTIAL_HELPER: 'C://x//h.exe' }),
    'C://x//h.exe');
  assert.match(resolveCredentialHelperExecutable({}), /relay-credential-helper\.exe$/u);
  assert.equal(resolveCredentialRoot({ RELAY_CREDENTIAL_ROOT: 'relative/dir' }), undefined);
  assert.match(String(resolveCredentialRoot({ RELAY_CREDENTIAL_ROOT: 'C://relay//credentials' })),
    /credentials$/u);
});
