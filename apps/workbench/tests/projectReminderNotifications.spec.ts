import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RelayApiClient } from '../src/api/relayClient';
import { deliverProjectReminderNotifications } from '../src/lib/projectReminderNotifications';
const host = vi.hoisted(() => ({ isFocused: vi.fn(async () => false), show: vi.fn(async () => {}), unminimize: vi.fn(async () => {}), setFocus: vi.fn(async () => {}) }));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => host }));
const item = { occurrenceId: 'o1', itemKey: 'project-reminder:o1', changeKey: '1', title: '继续项目', reason: '到时提醒', targetUrl: '/projects/old' };
let notification: { onclick?: () => void; close: ReturnType<typeof vi.fn> };
beforeEach(() => { vi.clearAllMocks(); host.isFocused.mockResolvedValue(false); });
afterEach(() => vi.unstubAllGlobals());
it('提醒投递复用宿主，点击重读当前项目，只导航不处理事项或执行计划', async () => {
  class TestNotification { static permission = 'granted'; onclick?: () => void; close = vi.fn(); constructor() { notification = this; } }
  vi.stubGlobal('Notification', TestNotification);
  const client = { claimReminderNotifications: vi.fn(async () => [item]), settleReminderNotification: vi.fn(async () => {}),
    getReminderOccurrence: vi.fn(async () => ({ projectId: 'current', occurrenceId: 'o1', canPlan: true })), resolveReminderOccurrence: vi.fn(), proposePeriodPlan: vi.fn() };
  const navigate = vi.fn(); await deliverProjectReminderNotifications(client as unknown as RelayApiClient, navigate, () => true);
  expect(client.settleReminderNotification).toHaveBeenCalledWith(item, 'DISPATCHED'); notification.onclick?.();
  await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith('/projects/current?reminder_occurrence=o1'));
  expect(client.getReminderOccurrence).toHaveBeenCalledWith('o1'); expect(client.resolveReminderOccurrence).not.toHaveBeenCalled(); expect(client.proposePeriodPlan).not.toHaveBeenCalled();
});
it('通知拒绝或失败只结算投递，不撤销原事项；窗口聚焦时不领取', async () => {
  vi.stubGlobal('Notification', class { static permission = 'denied'; });
  const client = { claimReminderNotifications: vi.fn(async () => [item]), settleReminderNotification: vi.fn(async () => {}) };
  await deliverProjectReminderNotifications(client as unknown as RelayApiClient, vi.fn(), () => true);
  expect(client.settleReminderNotification).toHaveBeenCalledWith(item, 'DENIED');
  vi.stubGlobal('Notification', class { static permission = 'granted'; constructor() { throw new Error('delivery failed'); } });
  await deliverProjectReminderNotifications(client as unknown as RelayApiClient, vi.fn(), () => true);
  expect(client.settleReminderNotification).toHaveBeenLastCalledWith(item, 'FAILED');
  host.isFocused.mockResolvedValue(true); client.claimReminderNotifications.mockClear();
  await deliverProjectReminderNotifications(client as unknown as RelayApiClient, vi.fn(), () => true); expect(client.claimReminderNotifications).not.toHaveBeenCalled();
});
