/**
 * revision / ownership_epoch / acceptance_revision 在应用层保持 bigint。
 * 公开 JSON 使用十进制字符串（契约：docs/api/http-command-contract.md 第 1 节），
 * 不允许先转换成 number，否则 > 2^53 会静默丢精度。
 */
export function toDecimalString(value: bigint): string {
  return value.toString(10);
}