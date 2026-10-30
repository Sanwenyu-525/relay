import assert from 'node:assert/strict';
import test from 'node:test';
import {
  advanceDueAt,
  firstDueAt,
  isValidTimezone,
  isoWeekday,
  localDateAt,
  nextDueAt,
  parseLocalDate,
  parseLocalTime,
  resolveLocalDateTime,
} from '../../src/application/zoned-time.js';

const daily = (intervalDays: number) => ({ kind: 'DAILY' as const, interval_days: intervalDays });
const weekly = (weekdays: readonly number[]) => ({ kind: 'WEEKLY' as const, weekdays });
const MS_PER_DAY = 86_400_000;

test('本地时刻按墙钟解释：上海每日 09:00 恒定 +08:00', () => {
  const anchor = resolveLocalDateTime({ year: 2026, month: 10, day: 18 }, { hour: 9, minute: 0 }, 'Asia/Shanghai');
  assert.equal(anchor.toISOString(), '2026-10-18T01:00:00.000Z');
  const next = nextDueAt({ rule: daily(1), timezone: 'Asia/Shanghai', localTime: '09:00', from: anchor, anchor });
  assert.equal(next.toISOString(), '2026-10-19T01:00:00.000Z');
});

test('跨夏令时仍保持本地 09:00，而不是固定 24 小时间隔', () => {
  const timezone = 'America/New_York';
  const anchor = resolveLocalDateTime({ year: 2026, month: 3, day: 7 }, { hour: 9, minute: 0 }, timezone);
  assert.equal(anchor.toISOString(), '2026-03-07T14:00:00.000Z');
  const next = nextDueAt({ rule: daily(1), timezone, localTime: '09:00', from: anchor, anchor });
  assert.equal(next.toISOString(), '2026-03-08T13:00:00.000Z');
  assert.equal(localDateAt(next, timezone).day, 8);
});

test('春跳不存在的墙钟时刻顺延一小时（纽约 2026-03-08 02:30 不存在）', () => {
  const resolved = resolveLocalDateTime({ year: 2026, month: 3, day: 8 }, { hour: 2, minute: 30 }, 'America/New_York');
  assert.equal(resolved.toISOString(), '2026-03-08T07:30:00.000Z');
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hourCycle: 'h23', hour: '2-digit', minute: '2-digit',
  }).format(resolved);
  assert.equal(parts, '03:30');
});

test('秋回重复的墙钟时刻取较早一次（纽约 2026-11-01 01:30 出现两次）', () => {
  const resolved = resolveLocalDateTime({ year: 2026, month: 11, day: 1 }, { hour: 1, minute: 30 }, 'America/New_York');
  assert.equal(resolved.toISOString(), '2026-11-01T05:30:00.000Z');
});

test('正偏移时区秋回同样取较早一次（柏林 2026-10-25 02:30 出现两次）', () => {
  const resolved = resolveLocalDateTime({ year: 2026, month: 10, day: 25 }, { hour: 2, minute: 30 }, 'Europe/Berlin');
  assert.equal(resolved.toISOString(), '2026-10-25T00:30:00.000Z');
});

test('柏林秋回重叠段之外的相邻时刻解析不受影响', () => {
  // 回拨前：本地 01:30 仍属 CEST（+02:00）。
  const before = resolveLocalDateTime({ year: 2026, month: 10, day: 25 }, { hour: 1, minute: 30 }, 'Europe/Berlin');
  assert.equal(before.toISOString(), '2026-10-24T23:30:00.000Z');
  // 重叠段之后：本地 03:30 只出现一次，属 CET（+01:00）。
  const after = resolveLocalDateTime({ year: 2026, month: 10, day: 25 }, { hour: 3, minute: 30 }, 'Europe/Berlin');
  assert.equal(after.toISOString(), '2026-10-25T02:30:00.000Z');
});

test('柏林秋回当日每日任务按较早一次推导下次触发', () => {
  const timezone = 'Europe/Berlin';
  const anchor = resolveLocalDateTime({ year: 2026, month: 10, day: 25 }, { hour: 2, minute: 30 }, timezone);
  assert.equal(anchor.toISOString(), '2026-10-25T00:30:00.000Z');
  const from = new Date(anchor.getTime() - MS_PER_DAY);
  const next = nextDueAt({ rule: daily(1), timezone, localTime: '02:30', from, anchor });
  assert.equal(next.toISOString(), '2026-10-25T00:30:00.000Z');
});

test('半小时夏令时秋回取较早一次，且下一次触发不会跳过该轮', () => {
  const timezone = 'Australia/Lord_Howe';
  const date = { year: 2026, month: 4, day: 5 };
  const resolved = resolveLocalDateTime(date, { hour: 1, minute: 45 }, timezone);
  assert.equal(resolved.toISOString(), '2026-04-04T14:45:00.000Z');
  const next = nextDueAt({
    rule: daily(1), timezone, localTime: '01:45',
    from: new Date('2026-04-04T14:30:00.000Z'), anchor: resolved,
  });
  assert.equal(next.toISOString(), '2026-04-04T14:45:00.000Z');
  const afterFirst = nextDueAt({
    rule: daily(1), timezone, localTime: '01:45', from: resolved, anchor: resolved,
  });
  assert.equal(afterFirst.toISOString(), '2026-04-05T15:15:00.000Z');
  assert.equal(resolveLocalDateTime(date, { hour: 1, minute: 15 }, timezone).toISOString(), '2026-04-04T14:15:00.000Z');
  assert.equal(resolveLocalDateTime(date, { hour: 2, minute: 15 }, timezone).toISOString(), '2026-04-04T15:45:00.000Z');
});

test('半小时与四十五分钟偏移时区按本地墙钟解析', () => {
  const kolkata = resolveLocalDateTime({ year: 2026, month: 10, day: 18 }, { hour: 9, minute: 0 }, 'Asia/Kolkata');
  assert.equal(kolkata.toISOString(), '2026-10-18T03:30:00.000Z');
  const chatham = resolveLocalDateTime({ year: 2026, month: 10, day: 18 }, { hour: 9, minute: 0 }, 'Pacific/Chatham');
  assert.equal(chatham.toISOString(), '2026-10-17T19:15:00.000Z');
  const kiritimati = resolveLocalDateTime({ year: 2026, month: 10, day: 18 }, { hour: 9, minute: 0 }, 'Pacific/Kiritimati');
  assert.equal(kiritimati.toISOString(), '2026-10-17T19:00:00.000Z');
});

test('每日规则按首次触发对齐，不因从 now 递推而漂移', () => {
  const anchor = resolveLocalDateTime({ year: 2026, month: 10, day: 1 }, { hour: 9, minute: 0 }, 'Asia/Shanghai');
  const from = new Date('2026-10-02T12:00:00.000Z');
  const next = nextDueAt({ rule: daily(3), timezone: 'Asia/Shanghai', localTime: '09:00', from, anchor });
  assert.equal(next.toISOString(), '2026-10-04T01:00:00.000Z');
});

test('每周规则只按本地星期几命中，1 表示周一', () => {
  assert.equal(isoWeekday({ year: 2026, month: 10, day: 18 }), 7);
  assert.equal(isoWeekday({ year: 2026, month: 10, day: 19 }), 1);
  const anchor = resolveLocalDateTime({ year: 2026, month: 10, day: 18 }, { hour: 9, minute: 0 }, 'Asia/Shanghai');
  const next = nextDueAt({ rule: weekly([1, 3]), timezone: 'Asia/Shanghai', localTime: '09:00', from: anchor, anchor });
  assert.equal(next.toISOString(), '2026-10-19T01:00:00.000Z');
  const afterMonday = nextDueAt({ rule: weekly([1, 3]), timezone: 'Asia/Shanghai', localTime: '09:00', from: next, anchor });
  assert.equal(afterMonday.toISOString(), '2026-10-21T01:00:00.000Z');
});

test('关闭三天后只推进一次，结果严格晚于 now 且落在未来', () => {
  const anchor = resolveLocalDateTime({ year: 2026, month: 10, day: 15 }, { hour: 9, minute: 0 }, 'Asia/Shanghai');
  const now = new Date('2026-10-18T04:00:00.000Z');
  const next = advanceDueAt({ rule: daily(1), timezone: 'Asia/Shanghai', localTime: '09:00', now, anchor });
  assert.equal(next.toISOString(), '2026-10-19T01:00:00.000Z');
  assert.ok(next.getTime() > now.getTime());
});

test('首次触发必须严格晚于当前时刻', () => {
  const from = new Date('2026-10-18T01:00:00.000Z');
  assert.equal(
    firstDueAt({ timezone: 'Asia/Shanghai', localTime: '09:00', localDate: { year: 2026, month: 10, day: 19 }, from }).toISOString(),
    '2026-10-19T01:00:00.000Z',
  );
  assert.throws(() => firstDueAt({ timezone: 'Asia/Shanghai', localTime: '09:00', localDate: { year: 2026, month: 10, day: 18 }, from }));
});

test('非法时区、时刻与日期被拒绝', () => {
  assert.equal(isValidTimezone('Asia/Shanghai'), true);
  assert.equal(isValidTimezone('Not/AZone'), false);
  assert.throws(() => parseLocalTime('24:00'));
  assert.throws(() => parseLocalTime('9:00'));
  assert.throws(() => parseLocalDate('2026-02-30'));
  assert.throws(() => parseLocalDate('2026-2-3'));
});
