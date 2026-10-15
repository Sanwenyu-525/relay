/** PostgreSQL SQLSTATE 判定：把驱动错误码与业务判断分开，避免按错误文本匹配。 */
export const POSTGRES_ERROR_CODES = {
    checkViolation: '23514',
    foreignKeyViolation: '23503',
    insufficientPrivilege: '42501',
    notNullViolation: '23502',
    uniqueViolation: '23505',
};
export function postgresErrorCode(error) {
    if (typeof error !== 'object' || error === null) {
        return undefined;
    }
    const code = error.code;
    return typeof code === 'string' ? code : undefined;
}
export function isPostgresError(error, code) {
    return postgresErrorCode(error) === code;
}
