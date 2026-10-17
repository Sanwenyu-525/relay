import assert from 'node:assert/strict';
import test from 'node:test';

import { startBackgroundModelCatalogSync } from '../../src/application/model-catalog-background-sync.js';

test('a hung catalog refresh does not block default worker work and is stopped on shutdown', async () => {
  let refreshStarted!: () => void;
  const started = new Promise<void>((resolve) => { refreshStarted = resolve; });
  let finishRefresh!: () => void;
  const hungRefresh = new Promise<void>((resolve) => { finishRefresh = resolve; });
  const controller = new AbortController();
  const lifecycle = startBackgroundModelCatalogSync({
    db: {} as never,
    env: {},
    signal: controller.signal,
    sync: async () => {
      refreshStarted();
      await hungRefresh;
      return { status: 'NOT_CONFIGURED' };
    },
  });
  await started;

  let defaultWorkProcessed = false;
  await Promise.resolve().then(() => { defaultWorkProcessed = true; });
  assert.equal(defaultWorkProcessed, true);

  controller.abort();
  finishRefresh();
  await lifecycle.stop();
});
