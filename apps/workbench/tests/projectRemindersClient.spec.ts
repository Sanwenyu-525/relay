import { afterEach, expect, it, vi } from 'vitest';
import { RelayApiClient } from '../src/api/relayClient';
afterEach(() => vi.unstubAllGlobals());
it('提醒客户端传递确认实际时刻与原时区、读取待处理并沿原通知回执结算', async () => {
  const posts: { url: string; body: Record<string, unknown> }[] = [];
  const occurrence = { occurrence_id: 'o1', reminder_id: 'r1', project_id: 'p1', config_revision: '1', schedule_generation: '1', title: '继续项目',
    due_at: '2026-10-14T08:30:00.000Z', timezone: 'Asia/Shanghai', missed: true, status: 'PENDING', revision: '1', resolution_reason: null, resolved_at: null,
    created_at: '2026-10-14T08:31:00Z', project: { title: '报告项目', revision: '0', archived: false }, plan_entry: '/api/v1/workspaces/w1/projects/p1/period-plans', can_plan: true, execution_admission: 'NOT_GRANTED' };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
    if (url.endsWith('/claim')) return json({ items: [{ occurrence_id: 'o1', item_key: 'project-reminder:o1', change_key: '1', title: '继续项目', reason: '错过仍待处理', target_url: '/projects/p1' }] });
    if (init?.method === 'POST') {
      const body = init.body ? JSON.parse(String(init.body)) : {}; posts.push({ url, body });
      if (url.endsWith('/settle')) return json({ status: 'recorded' });
      return json({ command_id: body.command_id, committed_at: '2026-10-14T00:00:00Z', result: url.endsWith('/resolutions') ?
        { occurrence_id: 'o1', project_id: 'p1', revision: '2', status: 'HANDLED' } : { reminder_id: 'r1', project_id: 'p1', revision: '1', schedule_generation: '1', status: body.status ?? 'ENABLED' } }, url.endsWith('/reminders') ? 201 : 200);
    }
    if (url.includes('/reminder-occurrences')) return json(url.endsWith('/o1') ? occurrence : { items: [occurrence] });
    const row = { reminder_id: 'r1', project_id: 'p1', revision: '1', schedule_generation: '1', status: 'ENABLED', title: '继续项目', due_at: occurrence.due_at, timezone: 'Asia/Shanghai', history: [{ revision: '1' }], created_at: occurrence.created_at };
    return json(url.endsWith('/reminders') ? { project_id: 'p1', items: [row] } : row);
  }));
  const api = new RelayApiClient({ baseUrl: 'http://127.0.0.1:8787', workspaceId: 'w1', bearerToken: 'test' });
  await api.createProjectReminder({ commandId: 'c1', projectId: 'p1', title: '继续项目', dueAt: '2026-10-14T16:30:00+08:00', timezone: 'Asia/Shanghai', confirmed: true });
  expect(posts[0]?.body.due_at).toBe('2026-10-14T16:30:00+08:00');
  expect((await api.getProjectReminders('p1')).items[0]?.timezone).toBe('Asia/Shanghai'); expect((await api.getProjectReminder('r1')).history).toHaveLength(1);
  expect((await api.getReminderOccurrences('p1')).items[0]?.missed).toBe(true); expect((await api.getReminderOccurrence('o1')).canPlan).toBe(true);
  await api.editProjectReminder({ commandId: 'c2', reminderId: 'r1', expectedRevision: '1', title: '继续项目', dueAt: '2026-10-15T08:30:00Z', timezone: 'UTC', confirmed: true, reason: '改时间' });
  await api.setProjectReminderStatus({ commandId: 'c3', reminderId: 'r1', expectedRevision: '2', status: 'DISABLED', reason: '停未来' });
  const notification = (await api.claimReminderNotifications())[0]!; await api.settleReminderNotification(notification, 'DENIED');
  expect(posts.find((p) => p.url.endsWith('/settle'))?.body).toEqual({ item_key: 'project-reminder:o1', change_key: '1', status: 'DENIED' });
  expect((await api.resolveReminderOccurrence({ commandId: 'c4', occurrenceId: 'o1', expectedRevision: '1', action: 'HANDLE', reason: '已查看' })).status).toBe('HANDLED');
});
