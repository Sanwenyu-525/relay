import { createDpapiCredentialStore, resolveCredentialHelperExecutable,
  resolveCredentialRootOrThrow } from './dpapi-credential-store.js';
import type { CredentialStore } from './credential-store.js';

/**
 * 进程级默认凭据存储（ADR-036）。
 *
 * 为什么需要它：连接解析发生在**多个异步入口**（Delegate 冻结、Run 执行、设置页校验），
 * 逐个把存储端口往下传会穿透十几层签名，而每一层都可能传错。这里按「存放根」缓存一个实例，
 * 让调用方只表达「我要用默认存储」；需要注入的测试仍然走显式参数。
 *
 * 构造本身不 spawn 子进程（只有真正 put/resolve 才 spawn），所以这里缓存没有启动代价。
 * 缓存键是存放根：同一进程内不会因为 `RELAY_CREDENTIAL_ROOT` 变化而拿到旧实例。
 */
const cache = new Map<string, CredentialStore>();

export function defaultCredentialStore(env: NodeJS.ProcessEnv = process.env): CredentialStore {
  const root = resolveCredentialRootOrThrow(env);
  const cached = cache.get(root);
  if (cached !== undefined) return cached;
  const store = createDpapiCredentialStore({ root,
    executable: resolveCredentialHelperExecutable(env) });
  cache.set(root, store);
  return store;
}

/** 仅测试：清空缓存，避免跨用例串用同一实例。 */
export function resetDefaultCredentialStoreForTest(): void {
  cache.clear();
}
