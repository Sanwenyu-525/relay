import { isTauri } from '@tauri-apps/api/core';
import type { RelayApiClient } from '../api/relayClient';

/** 复用原窗口/通知权限与投递回执；项目提醒不能替代必须介入通知。 */
export async function deliverProjectReminderNotifications(client: RelayApiClient, navigate: (path: string) => void, active: () => boolean) {
  if (!active() || !isTauri()) return;
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  if (!active() || await getCurrentWindow().isFocused()) return;
  const items = await client.claimReminderNotifications();
  if (!active() || items.length === 0) return;
  const settle = (status: 'DISPATCHED' | 'DENIED' | 'FAILED') => Promise.all(items.map((i) => client.settleReminderNotification(i, status)));
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') { await settle('DENIED'); return; }
  try {
    const notification = new Notification(items.length === 1 ? items[0]!.title : `${items.length} 个继续项目提醒`, {
      body: items.length === 1 ? items[0]!.reason : '提醒事项独立保留，请打开项目后主动发起下一段计划。' });
    notification.onclick = () => {
      void (async () => {
        try {
          // 原通知不是当前事实；点击不标处理、不创建计划或调用模型。
          const current = await client.getReminderOccurrence(items[0]!.occurrenceId);
          if (!active()) return;
          await getCurrentWindow().show(); await getCurrentWindow().unminimize(); await getCurrentWindow().setFocus();
          navigate(`/projects/${encodeURIComponent(current.projectId)}${current.canPlan ? `?reminder_occurrence=${encodeURIComponent(current.occurrenceId)}` : ''}`);
        } finally { notification.close(); }
      })().catch(() => { /* 读回失败保持原事项，用户可从应用重新读取。 */ });
    };
    await settle('DISPATCHED');
  } catch { await settle('FAILED'); }
}
