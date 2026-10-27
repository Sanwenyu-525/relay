/**
 * 模型连接凭据的安全存储端口（P2 前置设施，ADR-036）。
 *
 * 只做三件事：写入、按引用解析、删除。**没有列举，也没有回读摘要**——任何 HTTP 端点都
 * 不能调用 `resolve`，它只在服务端进程内为一次外呼解析凭据。
 *
 * 引用是不透明句柄（`[A-Za-z0-9_-]{8,64}`），业务表只存引用，永不存密钥或密文。
 * 秘密本身由操作系统凭据保护（Windows DPAPI，当前用户作用域），见 `dpapi-credential-store.ts`。
 */

export interface CredentialStore {
  /** 写入或覆盖一个引用对应的秘密；同引用覆盖即轮换。 */
  put(reference: string, secret: string): Promise<void>;
  /** 解析秘密；不存在返回 undefined（不抛错，调用方据此给出「未配置」而不是故障）。 */
  resolve(reference: string): Promise<string | undefined>;
  /** 删除；不存在也算成功（幂等）。 */
  delete(reference: string): Promise<void>;
  /** 是否存在。 */
  status(reference: string): Promise<boolean>;
}

export class CredentialStoreError extends Error {
  override readonly name: string = 'CredentialStoreError';
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

/** 存储不可用（helper 缺失、平台不支持、DPAPI 失败）：调用方必须停止而不是退回明文。 */
export class CredentialStoreUnavailableError extends CredentialStoreError {
  override readonly name: string = 'CredentialStoreUnavailableError';
  constructor(code: string, message: string) {
    super(code, message);
  }
}

const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/u;

/** 引用与 Rust helper 的校验规则保持一致：它同时是文件名，不允许分隔符或点号。 */
export function isCredentialReference(value: string): boolean {
  return REFERENCE.test(value);
}

export function requireCredentialReference(value: string): string {
  if (!isCredentialReference(value)) {
    throw new CredentialStoreError('INVALID_REFERENCE',
      'credential reference must be 8-64 characters of [A-Za-z0-9_-]');
  }
  return value;
}
