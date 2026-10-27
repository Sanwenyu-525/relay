import { CredentialStoreError, type CredentialStore } from './credential-store.js';
import { createDpapiCredentialStore, resolveCredentialHelperExecutable,
  resolveCredentialRootOrThrow } from './dpapi-credential-store.js';

/**
 * 把「凭据引用」物化成进程内可用的模型配置（ADR-036 的**虚拟内置连接**）。
 *
 * 为什么是「物化到环境」而不是「把每个读取点改成异步」：
 *
 * 模型配置今天有 20+ 个同步读取点（`readModelPortConfig(env)`），其中还有模块级常量
 * （`workflow/checkers.ts`）。把每一个都改成异步会波及启动、检查器注册、计划推导等
 * 与凭据无关的地方，并且必然有人漏改——漏改的后果正是本任务要消灭的那类缺陷：
 * 一处读到「未配置」、另一处读到真实凭据，同一进程里出现两个不同的模型身份。
 *
 * 所以只在**进程启动时**解析一次，把秘密写进本进程环境，之后所有读取点行为不变。
 * 这与今天 `.env` 注入秘密是同一个信任边界（秘密本来就以环境变量形式存在），
 * 没有把秘密扩散到新的位置：不落盘、不进日志、不进响应、不进冻结快照。
 *
 * 语义选择：
 *
 * * `<VAR>_REF` 与 `<VAR>` 同时非空 → 启动失败（`CREDENTIAL_ENV_AMBIGUOUS`）。
 *   静默选一个会让「到底用的哪把 Key」无法回答，而这正是凭据身份要能回答的问题。
 * * 引用解析不到 → 启动失败（`CREDENTIAL_REF_NOT_FOUND`）。回落明文或回落「未配置」
 *   都会悄悄改变模型身份（后者还会让真实 Provider 被当成 Fake）。
 * * 存储不可用 → 启动失败（`CREDENTIAL_STORE_UNAVAILABLE`）。不退回明文、不退回默认模型。
 * * 没有任何 `_REF` → 完全不动环境，也不启动 helper（零成本、零行为变化）。
 * * 物化成功后**删掉该 `_REF`**：引用已被本进程消费，二次物化不会被误判成「歧义」。
 *
 * 错误消息只含变量名与错误码，永不含秘密本身。
 */

/** 支持用引用提供的 API Key 变量。名字本身是既有契约，不新增变量形态。 */
export const CREDENTIAL_ENV_VARIABLES = [
  'RELAY_MODEL_API_KEY',
  'RELAY_OPENROUTER_API_KEY',
  'OPENROUTER_API_KEY',
] as const;

export type CredentialEnvVariable = (typeof CREDENTIAL_ENV_VARIABLES)[number];

export function credentialRefVariable(name: CredentialEnvVariable): string {
  return `${name}_REF`;
}

export type CredentialEnvErrorCode =
  | 'CREDENTIAL_ENV_AMBIGUOUS'
  | 'CREDENTIAL_REF_NOT_FOUND'
  | 'CREDENTIAL_STORE_UNAVAILABLE';

export class CredentialEnvError extends Error {
  override readonly name: string = 'CredentialEnvError';
  constructor(readonly code: CredentialEnvErrorCode, message: string) {
    super(message);
  }
}

export interface MaterializeCredentialEnvOptions {
  /** 注入存储（测试用）；缺省按环境创建 DPAPI 存储。 */
  readonly store?: CredentialStore | undefined;
}

interface PendingReference {
  readonly name: CredentialEnvVariable;
  readonly refVariable: string;
  readonly reference: string;
}

function pendingReferences(env: NodeJS.ProcessEnv): readonly PendingReference[] {
  const pending: PendingReference[] = [];
  for (const name of CREDENTIAL_ENV_VARIABLES) {
    const refVariable = credentialRefVariable(name);
    const reference = env[refVariable]?.trim() ?? '';
    if (reference === '') continue;
    pending.push({ name, refVariable, reference });
  }
  return pending;
}

/**
 * 返回一份**新的**环境：引用被解析成对应的 API Key 变量。原对象不被修改。
 *
 * 调用方若要让既有同步读取点看到结果，用 `applyCredentialEnv` 写回目标环境。
 */
export async function materializeCredentialEnv(env: NodeJS.ProcessEnv,
  options: MaterializeCredentialEnvOptions = {}): Promise<NodeJS.ProcessEnv> {
  const pending = pendingReferences(env);
  if (pending.length === 0) return { ...env };

  // 歧义先于任何 I/O：配置本身矛盾时不必去碰凭据库。
  for (const item of pending) {
    const literal = env[item.name]?.trim() ?? '';
    if (literal !== '') {
      throw new CredentialEnvError('CREDENTIAL_ENV_AMBIGUOUS',
        `${item.refVariable} and ${item.name} are both set; keep exactly one so the credential identity is unambiguous`);
    }
  }

  let store = options.store;
  if (store === undefined) {
    try {
      store = createDpapiCredentialStore({
        root: resolveCredentialRootOrThrow(env),
        executable: resolveCredentialHelperExecutable(env),
      });
    } catch (error) {
      throw new CredentialEnvError('CREDENTIAL_STORE_UNAVAILABLE',
        `credential storage could not be initialised: ${(error as Error).message}`);
    }
  }

  const resolved = { ...env };
  for (const item of pending) {
    let secret: string | undefined;
    try {
      secret = await store.resolve(item.reference);
    } catch (error) {
      const code = error instanceof CredentialStoreError ? error.code : 'UNKNOWN';
      throw new CredentialEnvError('CREDENTIAL_STORE_UNAVAILABLE',
        `credential storage failed while resolving ${item.refVariable} (${code})`);
    }
    if (secret === undefined || secret.trim() === '') {
      throw new CredentialEnvError('CREDENTIAL_REF_NOT_FOUND',
        `${item.refVariable} does not point at a stored credential; store it before starting`);
    }
    resolved[item.name] = secret.trim();
  }
  return resolved;
}

/**
 * 把物化结果写回目标环境（启动时用 `process.env`），并删除已被消费的 `_REF`。
 *
 * 只处理确实存在引用的变量：没有引用的变量保持原值，不覆盖调用方显式传入的明文。
 */
export function applyCredentialEnv(target: NodeJS.ProcessEnv,
  resolved: NodeJS.ProcessEnv): void {
  for (const name of CREDENTIAL_ENV_VARIABLES) {
    const refVariable = credentialRefVariable(name);
    const reference = target[refVariable]?.trim() ?? '';
    if (reference === '') continue;
    const value = resolved[name];
    if (value === undefined || value.trim() === '') continue;
    target[name] = value;
    delete target[refVariable];
  }
}

/** 启动便捷入口：解析 + 写回同一个环境对象。 */
export async function applyCredentialEnvFromStore(env: NodeJS.ProcessEnv = process.env,
  options: MaterializeCredentialEnvOptions = {}): Promise<void> {
  applyCredentialEnv(env, await materializeCredentialEnv(env, options));
}

/** 该环境是否声明了任何凭据引用（供状态展示判断「凭据来自系统凭据库」）。 */
export function hasCredentialReference(env: NodeJS.ProcessEnv): boolean {
  return pendingReferences(env).length > 0;
}
