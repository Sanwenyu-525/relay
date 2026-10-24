export type RelayScheduledTaskStatus = 'ENABLED' | 'PAUSED' | 'DISABLED' | 'EXPIRED';
export type RelayScheduledTaskOccurrenceStatus = 'DISPATCHING' | 'DISPATCHED' | 'BLOCKED' | 'SKIPPED' | 'RESOLVED';

/** 只支持「每 N 天」与「每周指定星期几」；cron 表达式不在本片范围。 */
export type RelayScheduledTaskRepeat =
  | { kind: 'DAILY'; intervalDays: number }
  | { kind: 'WEEKLY'; weekdays: readonly number[] };

export interface RelayScheduledTaskTemplate {
  taskTitle: string;
  objective: string;
  /** 每行一条验收标准。 */
  criteria: readonly string[];
  mode: 'ME' | 'AI_ASSIST';
}

export interface RelayScheduledTaskResult {
  scheduledTaskId: string;
  projectId: string;
  status: RelayScheduledTaskStatus;
  revision: string;
  scheduleGeneration: string;
  nextDueAt: string | null;
}

export interface RelayScheduledTask extends RelayScheduledTaskResult {
  title: string;
  template: RelayScheduledTaskTemplate;
  repeat: RelayScheduledTaskRepeat;
  timezone: string;
  localTime: string;
  firstRunAt: string;
  maxRuns: number;
  runsStarted: number;
  authorizationExpiresAt: string;
  createdAt: string;
  /** 列表与详情都带项目投影；项目标题只用于显示，不参与身份判断。 */
  project?: { title: string; revision: string; archived: boolean };
}

export interface RelayScheduledTaskOccurrence {
  occurrenceId: string;
  scheduledTaskId: string;
  projectId: string;
  sequence: string;
  dueAt: string;
  timezone: string;
  missed: boolean;
  status: RelayScheduledTaskOccurrenceStatus;
  taskId: string | null;
  runId: string | null;
  reason: string | null;
  revision: string;
  createdAt: string;
}

export interface RelayScheduledTaskDetail extends RelayScheduledTask {
  project: { title: string; revision: string; archived: boolean };
  occurrences: readonly RelayScheduledTaskOccurrence[];
  /** 最近 20 条窗口之外仍未处理（BLOCKED）的时段；待处理触发以它为准，避免旧阻塞丢入口。 */
  pendingOccurrences: readonly RelayScheduledTaskOccurrence[];
}

export interface RelayScheduledTaskCreate {
  commandId: string;
  projectId: string;
  title: string;
  template: RelayScheduledTaskTemplate;
  repeat: RelayScheduledTaskRepeat;
  timezone: string;
  /** HH:MM 本地时刻；跨 DST 仍按墙钟解释。 */
  localTime: string;
  /** YYYY-MM-DD 首次触发日期。 */
  firstLocalDate: string;
  maxRuns: number;
  authorizationExpiresAt: string;
  confirmed: true;
}

export interface RelayScheduledTaskEdit extends RelayScheduledTaskCreate {
  scheduledTaskId: string;
  expectedRevision: string;
  reason: string;
}

export interface RelayScheduledTaskStatusInput {
  commandId: string;
  scheduledTaskId: string;
  expectedRevision: string;
  status: 'ENABLED' | 'PAUSED' | 'DISABLED';
  reason: string;
}

export interface RelayScheduledTaskOccurrenceResolution {
  commandId: string;
  occurrenceId: string;
  expectedRevision: string;
  action: 'RETRY' | 'DISMISS';
  reason: string;
}
