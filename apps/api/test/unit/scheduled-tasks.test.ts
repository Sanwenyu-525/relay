import assert from 'node:assert/strict';
import test from 'node:test';
import {
  requireExpiry, requireLocalDate, requireLocalTime, requireMaxRuns, requireRule,
  requireText, requireTimezone,
} from '../../src/application/scheduled-tasks.js';

test('重复规则只接受按天 1–30 与按周 1–7，并规范化星期顺序', () => {
  assert.deepEqual(requireRule({ kind: 'DAILY', interval_days: 1 }), { kind: 'DAILY', interval_days: 1 });
  assert.deepEqual(requireRule({ kind: 'DAILY', interval_days: 30 }), { kind: 'DAILY', interval_days: 30 });
  assert.throws(() => requireRule({ kind: 'DAILY', interval_days: 0 }));
  assert.throws(() => requireRule({ kind: 'DAILY', interval_days: 31 }));
  assert.throws(() => requireRule({ kind: 'DAILY', interval_days: 1.5 }));

  assert.deepEqual(requireRule({ kind: 'WEEKLY', weekdays: [5, 1, 5] }), { kind: 'WEEKLY', weekdays: [1, 5] });
  assert.throws(() => requireRule({ kind: 'WEEKLY', weekdays: [] }));
  assert.throws(() => requireRule({ kind: 'WEEKLY', weekdays: [0] }));
  assert.throws(() => requireRule({ kind: 'WEEKLY', weekdays: [8] }));
});

test('执行次数上限只接受 1–100 的整数', () => {
  assert.equal(requireMaxRuns(1), 1);
  assert.equal(requireMaxRuns(100), 100);
  assert.throws(() => requireMaxRuns(0));
  assert.throws(() => requireMaxRuns(101));
  assert.throws(() => requireMaxRuns(2.5));
  assert.throws(() => requireMaxRuns(Number.NaN));
});

test('授权到期必须是带偏移量的实际时刻，不接受无时区钟点', () => {
  assert.equal(requireExpiry('2026-11-01T00:00:00Z').toISOString(), '2026-11-01T00:00:00.000Z');
  assert.equal(requireExpiry('2026-11-01T08:00:00+08:00').toISOString(), '2026-11-01T00:00:00.000Z');
  assert.throws(() => requireExpiry('2026-11-01T00:00:00'));
  assert.throws(() => requireExpiry('not-a-time'));
});

test('本地时刻、日期、时区与文本按同一口径拒绝非法输入', () => {
  assert.equal(requireLocalTime('09:00'), '09:00');
  assert.equal(requireLocalTime('23:59'), '23:59');
  assert.throws(() => requireLocalTime('24:00'));
  assert.throws(() => requireLocalTime('9:00'));

  assert.deepEqual(requireLocalDate('2026-10-18'), { year: 2026, month: 10, day: 18 });
  assert.throws(() => requireLocalDate('2026-02-30'));
  assert.throws(() => requireLocalDate('2026-10-8'));

  assert.equal(requireTimezone('Asia/Shanghai'), 'Asia/Shanghai');
  assert.throws(() => requireTimezone('Not/AZone'));

  assert.equal(requireText('  整理昨日进展  ', 'title'), '整理昨日进展');
  assert.throws(() => requireText('   ', 'title'));
  assert.throws(() => requireText('x'.repeat(201), 'title'));
});
