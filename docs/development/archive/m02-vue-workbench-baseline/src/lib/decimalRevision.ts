/**
 * API 的 revision 是十进制字符串。比较与递增在字符串边界完成，避免超过
 * Number.MAX_SAFE_INTEGER 时把两个不同版本折叠成同一个值。
 */
function normalize(value: string): string {
  if (!/^\d+$/u.test(value)) {
    throw new Error(`revision 必须是十进制字符串，实际为：${value}`);
  }
  return value.replace(/^0+(?=\d)/u, "");
}

export function compareDecimalRevisions(left: string, right: string): number {
  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);
  if (normalizedLeft.length !== normalizedRight.length) {
    return normalizedLeft.length > normalizedRight.length ? 1 : -1;
  }
  if (normalizedLeft === normalizedRight) {
    return 0;
  }
  return normalizedLeft > normalizedRight ? 1 : -1;
}

export function incrementDecimalRevision(value: string): string {
  return (BigInt(normalize(value)) + 1n).toString();
}
