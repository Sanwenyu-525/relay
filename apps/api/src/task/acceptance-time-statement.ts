export interface AcceptanceTimeValues { preparation_ms?: number; total_acceptance_ms?: number }

/** 首片只核对原文中明确的数字和单位，不由模型补猜未记录的耗时。 */
export function readAcceptanceTimeStatement(text: string): AcceptanceTimeValues | null {
  const read = (label: string): number | undefined | null => {
    const pattern = new RegExp(`${label}\\s*(?:用了|用时|耗时|花了|花费|改为|改成|是|为)?\\s*` +
      `(\\d+(?:\\.\\d+)?)\\s*(毫秒|分钟|小时|秒|分)`, 'gu');
    const matches = [...text.matchAll(pattern)];
    if (matches.length === 0) {
      return new RegExp(`${label}\\s*(?:用了|用时|耗时|花了|花费|改为|改成|是|为)?\\s*[-+0-9零一二三四五六七八九十]`, 'u')
        .test(text) ? null : undefined;
    }
    if (matches.length !== 1) return null;
    const units: Record<string, number> = { 毫秒: 1, 秒: 1000, 分钟: 60000, 分: 60000, 小时: 3600000 };
    const ms = Number(matches[0]![1]) * units[matches[0]![2]!]!;
    return Number.isSafeInteger(ms) && ms >= 0 ? ms : null;
  };
  const preparation = read('准备(?:材料)?(?:成本|时间)?');
  const total = read('(?:整体|总)?验收(?:总)?(?:时间)?');
  if (total !== undefined && /(?:不含|不包括|未计入|另加)准备/u.test(text)) return null;
  if (preparation === null || total === null || (preparation === undefined && total === undefined)) return null;
  return { ...(preparation === undefined ? {} : { preparation_ms: preparation }),
    ...(total === undefined ? {} : { total_acceptance_ms: total }) };
}
