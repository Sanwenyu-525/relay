/** 组合类名：只处理 falsy 值，不做去重或优先级推断。 */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter((part): part is string => Boolean(part)).join(" ");
}
