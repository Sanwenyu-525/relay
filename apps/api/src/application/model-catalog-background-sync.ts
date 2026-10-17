import type { DbExecutor } from '../infrastructure/database.js';
import { syncModelCatalog, type SyncModelCatalogResult } from './model-catalog-sync.js';

const REFRESH_INTERVAL_MS = 60_000;

/** Run the non-critical directory refresh independently from Worker delivery ticks. */
export function startBackgroundModelCatalogSync(input: {
  readonly db: DbExecutor;
  readonly env: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly onResult?: (result: SyncModelCatalogResult) => void;
  readonly onError?: () => void;
  readonly sync?: typeof syncModelCatalog;
}): { readonly stop: () => Promise<void> } {
  const sync = input.sync ?? syncModelCatalog;
  let stopped = input.signal?.aborted ?? false;
  let pending: Promise<void> | undefined;
  let nextTrigger: 'startup' | 'open' = 'startup';

  const refresh = (): void => {
    if (stopped || pending !== undefined) return;
    const trigger = nextTrigger;
    nextTrigger = 'open';
    pending = (async () => {
      try {
        const result = await sync({ db: input.db, env: input.env, trigger });
        try { input.onResult?.(result); } catch { /* Refresh logging cannot stop delivery. */ }
      } catch {
        try { input.onError?.(); } catch { /* Refresh reporting cannot stop delivery. */ }
      }
    })().finally(() => { pending = undefined; });
  };

  const timer = setInterval(refresh, REFRESH_INTERVAL_MS);
  timer.unref();
  const stop = async (): Promise<void> => {
    stopped = true;
    clearInterval(timer);
    input.signal?.removeEventListener('abort', onAbort);
    await pending;
  };
  const onAbort = (): void => { void stop(); };
  input.signal?.addEventListener('abort', onAbort, { once: true });
  if (!stopped) refresh();
  return { stop };
}
