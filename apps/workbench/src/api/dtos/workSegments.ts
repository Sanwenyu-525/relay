export interface RelayWorkSegmentTaskInput { taskId: string; expectedRevision: string; expectedAcceptanceRevision: string }
export interface RelayWorkSegmentStart {
  projectId: string; commandId: string; confirmed: true; title: string; expectation: string; tasks: RelayWorkSegmentTaskInput[];
}
export interface RelayWorkSegmentMutation { segmentId: string; commandId: string; expectedRevision: string }
export interface RelayWorkSegmentEventInput extends RelayWorkSegmentMutation {
  kind: 'REWORK' | 'HUMAN_INTERVENTION'; description: string; taskId?: string; sourceRunId?: string; durationMs?: number;
}
export interface RelayWorkSegmentEventResolution {
  eventId: string; commandId: string; expectedRevision: string; action: 'CONFIRM' | 'WITHDRAW'; reason: string;
}
export interface RelayWorkSegmentResult {
  segmentId: string; projectId: string; status: 'OPEN' | 'FINISHED'; revision: string;
  eventId: string | null; eventRevision: string | null; eventStatus: string | null;
}
export interface RelayWorkSegmentEvent {
  id: string; kind: 'REWORK' | 'HUMAN_INTERVENTION'; taskId: string | null; sourceRunId: string | null;
  description: string; durationMs: string | null; status: 'CANDIDATE' | 'CONFIRMED' | 'WITHDRAWN'; revision: string;
  history: Readonly<Record<string, unknown>>[]; sourceKind: 'USER_DECLARED'; createdAt: string;
}
export interface RelayWorkSegment extends RelayWorkSegmentResult {
  title: string; expectation: string; baselineStatus: 'RECORDED'; baseline: Readonly<Record<string, unknown>>;
  sourceMessageId: string | null; startedAt: string; finishedAt: string | null; snapshotKind: 'LIVE' | 'FINISHED';
  actual: Readonly<Record<string, unknown>>; events: RelayWorkSegmentEvent[];
  eventStatistics: { coverage: 'CONFIRMED_RECORDS_ONLY'; reworkCount: number; interventionCount: number; knownInterventionMs: string | null };
}
