import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveRunModelPort } from '../../src/application/run-model-port.js';
import { FAKE_MODEL_PROVIDER, FakeModelPort, isFakeModelPort } from
  '../../src/workflow/fake-model-port.js';
import type { RunRow } from '../../src/infrastructure/database-schema.js';

/**
 * B1（OVERALL-FIX-20261104-B）：生产业务不得因缺模型配置自动回退 FakeModelPort。
 *
 * 旧 Run（执行契约没有冻结模型快照）的兼容条件是「进程默认配置存在」；
 * 没有配置时必须按 `MODEL_NOT_CONFIGURED` 类型化停止，Fake 只保留给
 * `RELAY_TEST_ALLOW_FAKE_MODEL=1` 的显式测试放行。
 */

const legacyRun = { workspace_id: 'ws-1' } as unknown as RunRow;

function offlineEnv(): NodeJS.ProcessEnv {
  // 保证不受外层真实模型配置（.env / 机器级 SPARK_API_KEY 回退）影响。
  const env: NodeJS.ProcessEnv = {};
  delete env.RELAY_MODEL_PROVIDER;
  delete env.RELAY_MODEL_API_KEY;
  delete env.RELAY_MODEL_NAME;
  delete env.SPARK_API_KEY;
  return env;
}

test('legacy run without any model config stops with MODEL_NOT_CONFIGURED instead of falling back to Fake', async () => {
  const admission = await resolveRunModelPort(undefined as never, {
    run: legacyRun, contract: undefined, env: offlineEnv(),
  });
  assert.equal(admission.kind, 'STOPPED');
  assert.equal(admission.kind === 'STOPPED' ? admission.reason : '', 'MODEL_NOT_CONFIGURED');
  assert.equal(admission.kind === 'STOPPED' ? admission.evidence.basis : '', 'LEGACY_ENV');
});

test('legacy run with explicit offline-test opt-in still resolves the Fake fixture', async () => {
  const admission = await resolveRunModelPort(undefined as never, {
    run: legacyRun, contract: undefined,
    env: { ...offlineEnv(), RELAY_TEST_ALLOW_FAKE_MODEL: '1' },
  });
  assert.equal(admission.kind, 'READY');
  if (admission.kind !== 'READY') return;
  assert.equal(admission.external, false);
  assert.equal(admission.basis, 'LEGACY_ENV');
  assert.equal(isFakeModelPort(admission.port), true);
});

test('legacy run with a real process default keeps the LEGACY_ENV real-model compat path', async () => {
  const admission = await resolveRunModelPort(undefined as never, {
    run: legacyRun, contract: undefined,
    env: {
      RELAY_MODEL_PROVIDER: 'openai-compatible',
      RELAY_MODEL_NAME: 'compat-model',
      RELAY_MODEL_API_KEY: 'k-test-not-real',
      RELAY_MODEL_BASE_URL: 'https://compat.example.org/v1',
    },
  });
  assert.equal(admission.kind, 'READY');
  if (admission.kind !== 'READY') return;
  assert.equal(admission.external, true);
  assert.equal(admission.basis, 'LEGACY_ENV');
  assert.equal(isFakeModelPort(admission.port), false);
});

test('FakeModelPort identity stays detectable through the shared helper', () => {
  const port = new FakeModelPort();
  assert.equal(port.identity.provider, FAKE_MODEL_PROVIDER);
  assert.equal(isFakeModelPort(port), true);
  assert.equal(isFakeModelPort({ identity: { provider: 'openai-compatible', model: 'm',
    configFingerprint: 'x' } }), false);
});
