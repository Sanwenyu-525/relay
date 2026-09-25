import { createHash } from 'node:crypto';

import type { JsonObject, JsonValue } from '../infrastructure/json.js';

/**
 * 命令回执摘要。
 *
 * 依据 docs/database/physical-design-postgresql.md 第 1 节：不使用 JSON 文本序列化顺序计算幂等摘要。
 * 这里先把输入编码成固定版本的规范形式（键按 UTF-16 码元排序、数组保持调用方给出的顺序），再算 SHA-256；
 * 算法与规范化版本随回执一起落库，升级规则不改变历史回执的判断。
 */

export const PAYLOAD_HASH_ALGORITHM = 'sha256';

export const CANONICALIZATION_VERSION = 'relay-canonical-json-v1';

export class PayloadCanonicalizationError extends Error {
  override readonly name = 'PayloadCanonicalizationError';
}

/**
 * 规范编码 v1：
 *   null / boolean / string / finite number 按 JSON 字面量输出；
 *   number 必须有限且安全整数范围，超过 2^53 的整数必须以十进制字符串表达；
 *   对象按键排序，只接受普通对象（不接受 Date、Map、Buffer、bigint 等非 JSON 值）；
 *   数组顺序保持调用方规范化后的结果，本函数不重排数组。
 */
export function canonicalizeJson(value: JsonValue): string {
  if (value === null) {
    return 'null';
  }

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'string':
      return JSON.stringify(value);
    case 'number':
      return canonicalizeNumber(value);
    case 'object':
      return isJsonArray(value) ? canonicalizeArray(value) : canonicalizeObject(value);
    default:
      throw new PayloadCanonicalizationError(
        `unsupported value type in payload: ${typeof value}`,
      );
  }
}

export interface CommandPayload {
  /** 命令类型进入摘要；command_id 与请求追踪 ID 不进入摘要。 */
  readonly commandType: string;
  /** 规范化后的命令目标（资源 ID 等），缺省值必须由调用方显式补齐。 */
  readonly target: JsonValue;
  /** 规范化后的请求内容。 */
  readonly body: JsonValue;
}

/** 摘要是 sha256(utf8(canonicalizeJson({command_type, target, body})))。 */
export function computePayloadHash(payload: CommandPayload): Buffer {
  const canonical = canonicalizeJson({
    body: payload.body,
    command_type: payload.commandType,
    target: payload.target,
  });

  return createHash(PAYLOAD_HASH_ALGORITHM).update(canonical, 'utf8').digest();
}

export function payloadHashHex(hash: Buffer): string {
  return Buffer.from(hash).toString('hex');
}

function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

function canonicalizeNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new PayloadCanonicalizationError('payload numbers must be finite');
  }

  if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
    throw new PayloadCanonicalizationError(
      'integers beyond 2^53 must be encoded as decimal strings',
    );
  }

  return JSON.stringify(value);
}

function canonicalizeArray(value: readonly JsonValue[]): string {
  return `[${value.map((item) => canonicalizeJson(item)).join(',')}]`;
}

function canonicalizeObject(value: JsonObject): string {
  const prototype = Object.getPrototypeOf(value);

  if (prototype !== Object.prototype && prototype !== null) {
    throw new PayloadCanonicalizationError(
      'payload objects must be plain objects without a custom prototype',
    );
  }

  const keys = Object.keys(value).sort();
  const entries = keys.map((key) => {
    const item = value[key];

    if (item === undefined) {
      throw new PayloadCanonicalizationError('payload values must not be undefined');
    }

    return `${JSON.stringify(key)}:${canonicalizeJson(item)}`;
  });

  return `{${entries.join(',')}}`;
}