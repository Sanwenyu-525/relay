export type RelayReminderStatus = 'ENABLED' | 'PAUSED' | 'DISABLED';
export interface RelayReminderCreate { commandId: string; projectId: string; title: string; dueAt: string; timezone: string; confirmed: true }
export interface RelayReminderEdit { commandId: string; reminderId: string; expectedRevision: string; title: string; dueAt: string; timezone: string; confirmed: true; reason: string }
export interface RelayReminderStatusInput { commandId: string; reminderId: string; expectedRevision: string; status: RelayReminderStatus; reason: string }
export interface RelayReminderResult { reminderId: string; projectId: string; revision: string; status: RelayReminderStatus; scheduleGeneration: string }
export interface RelayProjectReminder extends RelayReminderResult { title: string; dueAt: string; timezone: string; history: Record<string, unknown>[]; createdAt: string }
export interface RelayReminderOccurrence {
  occurrenceId: string; reminderId: string; projectId: string; configRevision: string; scheduleGeneration: string;
  title: string; dueAt: string; timezone: string; missed: boolean; status: 'PENDING' | 'HANDLED' | 'DISMISSED'; revision: string;
  resolutionReason: string | null; resolvedAt: string | null; createdAt: string;
  project: { title: string; revision: string; archived: boolean }; planEntry: string; canPlan: boolean; executionAdmission: 'NOT_GRANTED';
}
export interface RelayReminderResolution { commandId: string; occurrenceId: string; expectedRevision: string; action: 'HANDLE' | 'DISMISS'; reason: string }
export interface RelayReminderNotification { occurrenceId: string; itemKey: string; changeKey: string; title: string; reason: string; targetUrl: string }
