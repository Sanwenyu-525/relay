import assert from 'node:assert/strict';
import test from 'node:test';
import { reminderInstant } from '../../src/application/project-reminders.js';
test('提醒时刻使用明确偏移量并保留同一实际时刻，不因显示时区改变', () => {
  assert.equal(reminderInstant('2026-10-14T16:30:00+08:00', 'Asia/Shanghai').toISOString(), '2026-10-14T08:30:00.000Z');
  assert.equal(reminderInstant('2026-10-14T08:30:00Z', 'America/New_York').toISOString(), '2026-10-14T08:30:00.000Z');
  assert.notEqual(reminderInstant('2026-11-01T01:30:00-04:00', 'America/New_York').getTime(), reminderInstant('2026-11-01T01:30:00-05:00', 'America/New_York').getTime());
});
test('缺时区、无效日期或时区不能成为提醒实际时刻', () => {
  assert.throws(() => reminderInstant('2026-10-14T16:30:00', 'Asia/Shanghai'));
  assert.throws(() => reminderInstant('2026-02-30T16:30:00Z', 'UTC'));
  assert.throws(() => reminderInstant('2026-10-14T16:30:00Z', 'Not/AZone'));
});
