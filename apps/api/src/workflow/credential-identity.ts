import { createHash } from 'node:crypto';

/**
 * 凭据身份（P0-2）。
 *
 * 配置指纹只描述「Provider / 型号 / 端点 / 预算」，换 API Key 不改变它，于是旧验证结果
 * 会被误认为仍然有效，账户级冷却也会被另一个账户继承。这里补上**只属于凭据**的身份：
 *
 *   * 单向摘要：`sha256(domain ‖ provider ‖ key)`，不可逆、不可枚举（Provider Key 是
 *     高熵随机串），不存明文、不写日志、不进任何 HTTP 响应；
 *   * 域分隔：凭据身份与账户冷却键各用一个固定域前缀，避免同一摘要被跨用途复用；
 *   * 账户冷却键：`sha256(domain ‖ credentialFingerprint)`，与具体型号无关——同一个
 *     账户的所有免费型号共享冷却，不同账户互不影响，重启后仍按同一键读取。
 *
 * 调用方只在服务端比较这两个值，从不返回给前端，也不写入提示词/上下文清单。
 */

const CREDENTIAL_DOMAIN = 'relay-model-credential-v1';
const ACCOUNT_COOLDOWN_DOMAIN = 'relay-model-account-cooldown-v2';

export type CredentialIdentityState = 'MATCH' | 'CHANGED' | 'UNKNOWN';

/** 凭据身份摘要；空白凭据不是身份，直接拒绝而不是产生一个「看起来有效」的摘要。 */
export function computeCredentialFingerprint(provider: string, apiKey: string): string {
  const credential = apiKey.trim();
  if (credential === '') throw new Error('credential fingerprint requires a non-empty credential');
  return createHash('sha256')
    .update(`${CREDENTIAL_DOMAIN}\u0000${provider}\u0000${credential}`, 'utf8').digest('hex');
}

export function readCredentialFingerprint(
  config: { readonly provider: string; readonly apiKey: string }): string {
  return computeCredentialFingerprint(config.provider, config.apiKey);
}

/** 账户级冷却键：同一凭据身份 → 同一键；换凭据 → 另一套冷却。 */
export function accountCooldownKey(credentialFingerprint: string): string {
  return createHash('sha256')
    .update(`${ACCOUNT_COOLDOWN_DOMAIN}\u0000${credentialFingerprint}`, 'utf8').digest('hex');
}

/**
 * 冻结凭据与当前凭据的比较。
 *
 * 冻结值为空（旧数据、未记录）返回 UNKNOWN：既不冒充匹配，也不据此拒绝旧 Run——
 * 旧数据的兼容行为由调用方按各自契约决定。
 */
export function compareCredentialIdentity(frozen: string | null | undefined,
  current: string): CredentialIdentityState {
  if (frozen === null || frozen === undefined || frozen === '') return 'UNKNOWN';
  return frozen === current ? 'MATCH' : 'CHANGED';
}
