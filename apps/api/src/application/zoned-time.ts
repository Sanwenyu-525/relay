/**
 * 定时任务的墙钟计算：把「本地日期 + 时刻 + 时区」解析成绝对时刻，并按重复规则求下一次触发。
 *
 * 只做纯计算，不读库、不读进程时钟。三条硬要求（ADR-026）：
 *   * 用户确认的是**墙钟时刻**，不是固定偏移；跨 DST 的每日 09:00 仍是 09:00。
 *   * 春跳（gap）不存在的时刻顺延 +1 小时；秋回（overlap）重复的时刻取**较早**的一次。
 *   * 星期几只按本地日历推导，不看进程时区，也不用 `Intl` 的星期文本。
 */

export type RepeatRule =
  | { readonly kind: 'DAILY'; readonly interval_days: number }
  | { readonly kind: 'WEEKLY'; readonly weekdays: readonly number[] };

export interface LocalDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;
/** 400 天足够覆盖 DAILY(≤30) 与 WEEKLY(≤7) 的任何合法组合，超出即视为配置不可能满足。 */
const MAX_SCAN_DAYS = 400;

const LOCAL_TIME_PATTERN = /^([01][0-9]|2[0-3]):([0-5][0-9])$/u;
const LOCAL_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;

export function parseLocalTime(value: string): { hour: number; minute: number } {
  const matched = LOCAL_TIME_PATTERN.exec(value);
  if (matched === null) throw new Error('LOCAL_TIME_INVALID');
  return { hour: Number(matched[1]), minute: Number(matched[2]) };
}

export function parseLocalDate(value: string): LocalDate {
  const matched = LOCAL_DATE_PATTERN.exec(value);
  if (matched === null) throw new Error('LOCAL_DATE_INVALID');
  const year = Number(matched[1]);
  const month = Number(matched[2]);
  const day = Number(matched[3]);
  // 回读比对拦住 2026-02-30 这类「格式对、日期不存在」的输入；Date.UTC 会静默进位，必须读回核对。
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() + 1 !== month || probe.getUTCDate() !== day) {
    throw new Error('LOCAL_DATE_INVALID');
  }
  return { year, month, day };
}

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(0);
    return true;
  } catch {
    return false;
  }
}

export function localDateKey(date: LocalDate): string {
  return `${String(date.year).padStart(4, '0')}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
}

interface ZoneParts extends LocalDate {
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

function partsAt(instantMs: number, timezone: string): ZoneParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instantMs));
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((part) => part.type === type);
    if (found === undefined) throw new Error('ZONE_PARTS_UNAVAILABLE');
    return Number(found.value);
  };
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour') % 24,
    minute: read('minute'),
    second: read('second'),
  };
}

/** 该时刻在目标时区的偏移量（毫秒）。正数表示东半球。 */
function offsetAt(instantMs: number, timezone: string): number {
  const parts = partsAt(instantMs, timezone);
  return (
    Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) -
    instantMs
  );
}

function addDays(date: LocalDate, days: number): LocalDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day) + days * MS_PER_DAY);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function dayNumber(date: LocalDate): number {
  return Math.round(Date.UTC(date.year, date.month - 1, date.day) / MS_PER_DAY);
}

/** ISO 星期：1=周一 … 7=周日。只用本地日历，不受进程时区影响。 */
export function isoWeekday(date: LocalDate): number {
  const weekday = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
  return ((weekday + 6) % 7) + 1;
}

/**
 * 把「本地日期 + 本地时刻」解析成绝对时刻。
 *
 * 两遍 offset 修正处理 DST：先用 guess 处的偏移试算，再用试算结果的偏移复算。
 * 两个候选都可能有效（秋回重叠），取较早的一次；都无效说明落在 gap，按 +1 小时顺延。
 */
export function resolveLocalDateTime(date: LocalDate, time: { hour: number; minute: number }, timezone: string): Date {
  const guess = Date.UTC(date.year, date.month - 1, date.day, time.hour, time.minute);
  const candidates = new Set<number>();
  const firstOffset = offsetAt(guess, timezone);
  candidates.add(guess - firstOffset);
  candidates.add(guess - offsetAt(guess - firstOffset, timezone));

  const valid = [...candidates].filter((instant) => sameWallClock(instant, date, time, timezone));
  if (valid.length > 0) return new Date(Math.min(...valid));

  // gap：该墙钟时刻不存在。顺延一小时后重新解析；若仍不存在，按首遍偏移直接推进一小时。
  const shifted = time.hour + 1 >= 24
    ? { date: addDays(date, 1), time: { hour: time.hour + 1 - 24, minute: time.minute } }
    : { date, time: { hour: time.hour + 1, minute: time.minute } };
  const retried = resolveLocalDateTimeWithoutGap(shifted.date, shifted.time, timezone);
  if (retried !== undefined) return retried;
  return new Date(guess - firstOffset + MS_PER_HOUR);
}

function resolveLocalDateTimeWithoutGap(date: LocalDate, time: { hour: number; minute: number }, timezone: string): Date | undefined {
  const guess = Date.UTC(date.year, date.month - 1, date.day, time.hour, time.minute);
  const candidates = new Set<number>();
  const firstOffset = offsetAt(guess, timezone);
  candidates.add(guess - firstOffset);
  candidates.add(guess - offsetAt(guess - firstOffset, timezone));
  const valid = [...candidates].filter((instant) => sameWallClock(instant, date, time, timezone));
  return valid.length === 0 ? undefined : new Date(Math.min(...valid));
}

function sameWallClock(instantMs: number, date: LocalDate, time: { hour: number; minute: number }, timezone: string): boolean {
  const parts = partsAt(instantMs, timezone);
  return parts.year === date.year && parts.month === date.month && parts.day === date.day
    && parts.hour === time.hour && parts.minute === time.minute;
}

export function localDateAt(instant: Date, timezone: string): LocalDate {
  const parts = partsAt(instant.getTime(), timezone);
  return { year: parts.year, month: parts.month, day: parts.day };
}

function matchesRule(rule: RepeatRule, anchor: LocalDate, candidate: LocalDate): boolean {
  if (rule.kind === 'DAILY') {
    const elapsed = dayNumber(candidate) - dayNumber(anchor);
    return elapsed >= 0 && elapsed % rule.interval_days === 0;
  }
  return rule.weekdays.includes(isoWeekday(candidate));
}

/**
 * 求严格晚于 `from` 的下一次触发时刻。
 *
 * `anchor` 是首次触发时刻：DAILY 的「每 N 天」按它对齐，避免每次从 now 递推造成漂移；
 * WEEKLY 只用星期几，不需要 anchor 对齐。
 */
export function nextDueAt(input: {
  readonly rule: RepeatRule;
  readonly timezone: string;
  readonly localTime: string;
  readonly from: Date;
  readonly anchor: Date;
}): Date {
  const time = parseLocalTime(input.localTime);
  const anchorDate = localDateAt(input.anchor, input.timezone);
  let candidate = localDateAt(input.from, input.timezone);
  for (let scanned = 0; scanned <= MAX_SCAN_DAYS; scanned += 1) {
    if (matchesRule(input.rule, anchorDate, candidate)) {
      const instant = resolveLocalDateTime(candidate, time, input.timezone);
      if (instant.getTime() > input.from.getTime()) return instant;
    }
    candidate = addDays(candidate, 1);
  }
  throw new Error('NEXT_DUE_UNREACHABLE');
}

/** 首次触发时刻：严格晚于 `from` 的第一个匹配时刻（含当天）。 */
export function firstDueAt(input: {
  readonly timezone: string;
  readonly localTime: string;
  readonly localDate: LocalDate;
  readonly from: Date;
}): Date {
  const time = parseLocalTime(input.localTime);
  const instant = resolveLocalDateTime(input.localDate, time, input.timezone);
  if (instant.getTime() > input.from.getTime()) return instant;
  throw new Error('FIRST_DUE_NOT_IN_FUTURE');
}

/** 触发后推进：保证下一次严格晚于 `now`，关闭期间错过的多次不逐个补。 */
export function advanceDueAt(input: {
  readonly rule: RepeatRule;
  readonly timezone: string;
  readonly localTime: string;
  readonly now: Date;
  readonly anchor: Date;
}): Date {
  return nextDueAt({ rule: input.rule, timezone: input.timezone, localTime: input.localTime, from: input.now, anchor: input.anchor });
}

export const SCHEDULE_MINUTE_MS = MS_PER_MINUTE;
