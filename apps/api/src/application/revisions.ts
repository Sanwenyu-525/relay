import { validationFailed } from './domain-error.js';

const DECIMAL_PATTERN = /^\d{1,19}$/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * 版本与 ID 的入口解析。
 *
 * revision/acceptance_revision/epoch 在 JSON 中是十进制字符串（契约第 1 节），这里先校验格式，
 * 再转成 bigint 交给应用与数据库；不做任何 number 往返。命令摘要使用规范化后的字符串，
 * 因此 "01" 与 "1" 是同一个命令内容。
 */
export function requireRevision(value: string, field: string): bigint {
  if (!DECIMAL_PATTERN.test(value)) {
    throw validationFailed([
      { field, message: 'must be a decimal string within the bigint range' },
    ]);
  }

  return BigInt(value);
}

export function requireUuid(value: string, field: string): string {
  if (!UUID_PATTERN.test(value)) {
    throw validationFailed([{ field, message: 'must be a UUID string' }]);
  }

  return value.toLowerCase();
}

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/** 集合语义的输入（goal_ids 等）先去除重复并排序，让相同集合得到相同的命令摘要。 */
export function normalizeIdSet(values: readonly string[], field: string): readonly string[] {
  const unique = new Set<string>();

  for (const value of values) {
    unique.add(requireUuid(value, field));
  }

  return [...unique].sort();
}