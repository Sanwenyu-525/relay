import type { CredentialIdentityState } from './credential-identity.js';

/**
 * 连接验证的**目标**与状态词表（P1-4）。
 *
 * 此前 `/model-port/verify` 只能验证进程默认模型：目录里有、API Key 填了、默认模型验证过，
 * 都会被误读成「当前选择的模型可执行」。这里把「验证哪个连接/哪个确切型号」变成显式目标，
 * 并把状态拆成互斥的 13 态，让 UI 不再用一个布尔值冒充四件事（目录存在 / 凭据已填 /
 * 默认模型验证过 / 所选模型可执行）。
 *
 * 状态是**推导**出来的，不是另存一份事实：输入全部来自已持久化的事实（配置可解析性、
 * 目录快照与新鲜度、账户冷却行、`model_calls(kind=VERIFY)` 最近一行、凭据身份比较）。
 * 推导函数是纯函数，词表与优先级由单元测试钉住。
 */

export type VerifyTarget =
  | { readonly connection: 'default' }
  | { readonly connection: 'openrouter'; readonly model: string };

export const DEFAULT_VERIFY_TARGET: VerifyTarget = { connection: 'default' };

export const VERIFY_TARGET_STATES = [
  'NOT_CONFIGURED', 'CONFIG_INCOMPLETE', 'UNVERIFIED', 'VERIFIED', 'CREDENTIAL_CHANGED',
  'AUTH_FAILED', 'MODEL_NOT_FOUND', 'CATALOG_STALE', 'CAPABILITY_INSUFFICIENT',
  'FREE_INELIGIBLE', 'ACCOUNT_COOLDOWN', 'BUDGET_EXHAUSTED', 'UNKNOWN',
] as const;

export type VerifyTargetState = (typeof VERIFY_TARGET_STATES)[number];

/** 目录侧对「这个确切型号」的判定；默认连接没有目录依据，传 null。 */
export interface VerifyCatalogFacts {
  readonly fresh: boolean;
  readonly entry: { readonly free: boolean; readonly textInput: boolean;
    readonly textOutput: boolean } | null;
}

export interface VerifyTargetStateInput {
  /** 连接凭据与端点能否解析（缺 Key / 缺型号 / 端点非法）。 */
  readonly configured: boolean;
  /** 有 Provider 声明但字段残缺——生产进程本会拒绝启动，这里只表达诊断。 */
  readonly configIncomplete: boolean;
  readonly catalog: VerifyCatalogFacts | null;
  /** 该凭据身份当前是否有未过期的账户级冷却。 */
  readonly accountCooldownActive: boolean;
  readonly credentialIdentity: CredentialIdentityState;
  readonly currentFingerprint: string | null;
  readonly last: { readonly ok: boolean; readonly configFingerprint: string;
    readonly errorKind: string | null } | null;
}

/**
 * 优先级：**能不能验证**先于**上次验证结果**。
 *
 * 一个模型此刻不具备可验证前提（没凭据、不在目录、不免费、能力不足、目录过期、账户冷却），
 * 就算上一行 VERIFY 是 ok，也不能显示「已验证」——那正是本任务要消掉的误读。
 */
export function describeVerifyTargetState(input: VerifyTargetStateInput): VerifyTargetState {
  if (input.configIncomplete) return 'CONFIG_INCOMPLETE';
  if (!input.configured || input.currentFingerprint === null) return 'NOT_CONFIGURED';
  const catalog = input.catalog;
  if (catalog !== null) {
    if (catalog.entry === null) return 'FREE_INELIGIBLE';
    if (!catalog.entry.free) return 'FREE_INELIGIBLE';
    if (!catalog.entry.textInput || !catalog.entry.textOutput) return 'CAPABILITY_INSUFFICIENT';
    if (!catalog.fresh) return 'CATALOG_STALE';
  }
  if (input.accountCooldownActive) return 'ACCOUNT_COOLDOWN';
  const last = input.last;
  if (last === null) return 'UNVERIFIED';
  // 配置指纹不符说明这一行验证的不是当前配置，旧结论不继承。
  if (last.configFingerprint !== input.currentFingerprint) return 'UNVERIFIED';
  if (input.credentialIdentity === 'CHANGED') return 'CREDENTIAL_CHANGED';
  if (last.ok) return 'VERIFIED';
  switch (last.errorKind) {
    case 'AUTH': return 'AUTH_FAILED';
    case 'MODEL_NOT_FOUND': return 'MODEL_NOT_FOUND';
    case 'RATE_LIMIT': return 'ACCOUNT_COOLDOWN';
    case 'BUDGET_EXHAUSTED': return 'BUDGET_EXHAUSTED';
    default: return 'UNKNOWN';
  }
}

/** 目标是否属于「免费目录型号」：只有它需要零价硬限制。 */
export function isFreeCatalogTarget(target: VerifyTarget): boolean {
  return target.connection === 'openrouter';
}

/** 稳定的目标标识：用于日志与响应，不含凭据。 */
export function describeVerifyTarget(target: VerifyTarget): string {
  return target.connection === 'default' ? 'default' : `openrouter:${target.model}`;
}
