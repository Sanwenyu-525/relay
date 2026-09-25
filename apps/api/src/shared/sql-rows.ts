/** 显式 SQL 的单行结果断言：写入口必须拿到自己刚写入的行，静默返回空行属于实现错误。 */
export function requireRow<TRow>(
  rows: readonly TRow[],
  operation: string,
): TRow {
  const row = rows[0];

  if (row === undefined) {
    throw new Error(`${operation} returned no row`);
  }

  return row;
}