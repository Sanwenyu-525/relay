/** PostgreSQL SQLSTATE 判定：把驱动错误码与业务判断分开，避免按错误文本匹配。 */
export const POSTGRES_ERROR_CODES = {
  checkViolation: '23514',
  foreignKeyViolation: '23503',
  insufficientPrivilege: '42501',
  notNullViolation: '23502',
  uniqueViolation: '23505',
} as const;

export type PostgresErrorCode =
  (typeof POSTGRES_ERROR_CODES)[keyof typeof POSTGRES_ERROR_CODES];

export function postgresErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }

  const code = (error as { readonly code?: unknown }).code;

  return typeof code === 'string' ? code : undefined;
}

export function isPostgresError(error: unknown, code: string): boolean {
  return postgresErrorCode(error) === code;
}