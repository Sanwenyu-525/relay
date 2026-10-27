import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { CredentialStoreError } from '../../src/credentials/credential-store.js';
import { applyCredentialEnvFromStore } from '../../src/credentials/credential-env.js';
import { createDpapiCredentialStore } from '../../src/credentials/dpapi-credential-store.js';
import { readCredentialFingerprint } from '../../src/workflow/credential-identity.js';
import { readModelPortConfig } from '../../src/workflow/model-port-config.js';

/**
 * 真实 DPAPI 凭据存储（P2 前置设施，ADR-036）。
 *
 * 与单测的分工：单测用假 helper 验证**协议与失败语义**；这里跑**真实的
 * relay-credential-helper.exe**，证明秘密确实被操作系统保护、落盘不含明文、
 * 引用逃逸被拒绝。helper 由 `scripts/run-integration.ps1` 构建并通过
 * `RELAY_CREDENTIAL_HELPER` 指过来；未提供时本套件显式跳过（不伪装成通过）。
 */

const helper = process.env.RELAY_CREDENTIAL_HELPER?.trim();
const skipReason = helper === undefined || helper === ''
  ? 'RELAY_CREDENTIAL_HELPER is not set; run apps/api/scripts/run-integration.ps1'
  : false;

test('DPAPI 真实往返：写入、解析、状态、删除', { skip: skipReason }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-credential-integration-'));
  try {
    const store = createDpapiCredentialStore({ root, executable: helper! });
    const reference = `cred-${randomUUID().replaceAll('-', '').slice(0, 24)}`;
    const secret = `synthetic-dpapi-secret-${randomUUID()}`;
    await store.put(reference, secret);
    assert.equal(await store.resolve(reference), secret);
    assert.equal(await store.status(reference), true);

    // 落盘只有一个 blob，且不含明文。
    const files = await readdir(root);
    assert.deepEqual(files.filter((name) => name.endsWith('.bin')), [`${reference}.bin`]);
    const blob = await readFile(join(root, `${reference}.bin`));
    assert.equal(blob.includes(Buffer.from(secret, 'utf8')), false);

    await store.delete(reference);
    assert.equal(await store.status(reference), false);
    assert.equal(await store.resolve(reference), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('DPAPI 真实失败语义：引用逃逸被拒绝、缺失引用是「未配置」', { skip: skipReason },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'relay-credential-integration-'));
    try {
      const store = createDpapiCredentialStore({ root, executable: helper! });
      await assert.rejects(store.put('../escape', 'synthetic'),
        (error: unknown) => error instanceof CredentialStoreError &&
          error.code === 'INVALID_REFERENCE');
      assert.equal(await store.resolve('cred-not-stored-here'), undefined);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

test('凭据库里的 Key 能变成可用模型配置，轮换后凭据身份随之改变', { skip: skipReason },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'relay-credential-integration-'));
    try {
      const store = createDpapiCredentialStore({ root, executable: helper! });
      const reference = `cred-${randomUUID().replaceAll('-', '').slice(0, 24)}`;
      const secretA = `synthetic-key-a-${randomUUID()}`;
      const secretB = `synthetic-key-b-${randomUUID()}`;
      await store.put(reference, secretA);

      const makeEnv = (): NodeJS.ProcessEnv => ({ RELAY_MODEL_PROVIDER: 'openai-compatible',
        RELAY_MODEL_NAME: 'synthetic/credential-model', RELAY_MODEL_API_KEY_REF: reference });
      const envA = makeEnv();
      await applyCredentialEnvFromStore(envA, { store });
      const configA = readModelPortConfig(envA);
      assert.equal(configA?.apiKey, secretA);
      // 引用已被本进程消费：环境里只剩明文形态，既有同步读取点行为不变。
      assert.equal(envA.RELAY_MODEL_API_KEY_REF, undefined);
      const identityA = readCredentialFingerprint(configA!);
      assert.match(identityA, /^[0-9a-f]{64}$/u);
      assert.equal(identityA.includes(secretA), false, '凭据身份不能包含明文');

      // 轮换：同一引用覆盖新秘密。新进程物化后凭据身份必须变化，
      // 这样冻结在该身份上的旧 Run / 旧验证会明确停止，而不是悄悄换账户继续。
      await store.put(reference, secretB);
      const envB = makeEnv();
      await applyCredentialEnvFromStore(envB, { store });
      const configB = readModelPortConfig(envB);
      assert.equal(configB?.apiKey, secretB);
      assert.notEqual(readCredentialFingerprint(configB!), identityA);
      // 配置指纹只看 Provider/型号/端点/预算，不因换 Key 而变——两个维度必须分开。
      assert.equal(envB.RELAY_MODEL_NAME, envA.RELAY_MODEL_NAME);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
