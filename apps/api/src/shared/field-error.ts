/**
 * 字段级错误的最小结构：HTTP Problem Details 与领域错误共用，避免两侧各有一份定义。
 * 契约见 docs/api/http-command-contract.md 第 7 节（field_errors 指向字段）。
 */
export interface FieldError {
  readonly field: string;
  readonly message: string;
}