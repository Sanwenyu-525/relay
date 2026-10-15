import { afterEach, expect, it, vi } from 'vitest';
import { RelayApiClient } from '../src/api/relayClient';
afterEach(() => vi.unstubAllGlobals());
const client = () => new RelayApiClient({ baseUrl: 'http://127.0.0.1:8787', workspaceId: 'w1', bearerToken: 'test' });

it('工作段客户端传递确认预期/任务版本，支持事件、结束快照与混合历史预期读回', async () => {
  const posts: Record<string, unknown>[] = [];
  let finished = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
    if (url.endsWith('/retrospectives')) return json({ project_id: 'p1', baseline_status: 'PARTIAL', expectation: null, model_usage: null, work_time: null,
      tasks: [{ task_id: 't1', baseline_status: 'RECORDED', expectation: '原预期', segment_id: 's1' }, { task_id: 't2', baseline_status: 'UNKNOWN', expectation: null, segment_id: null }] });
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)); posts.push(body);
      if (url.endsWith('/finishes')) finished = true;
      return json({ command_id: body.command_id, committed_at: '2026-10-14T00:00:00Z', result: {
        segment_id: 's1', project_id: 'p1', status: finished ? 'FINISHED' : 'OPEN', revision: String(posts.length),
        ...(url.endsWith('/events') || url.endsWith('/resolutions') ? { event_id: 'e1', event_revision: url.endsWith('/events') ? '1' : '2', event_status: url.endsWith('/events') ? 'CANDIDATE' : 'CONFIRMED' } : {}) } });
    }
    const segment = { segment_id: 's1', project_id: 'p1', title: '本段', expectation: '按原验收完成', revision: '4', status: 'FINISHED',
      baseline_status: 'RECORDED', baseline: { tasks: [{ task_id: 't1', acceptance_revision: '1' }] }, source_message_id: null,
      started_at: '2026-10-14T00:00:00Z', finished_at: '2026-10-14T00:10:00Z', snapshot_kind: 'FINISHED',
      actual: { accepted_output_count: 1, monetary_cost: null }, events: [{ id: 'e1', segment_id: 's1', kind: 'HUMAN_INTERVENTION',
        task_id: 't1', source_run_id: null, description: '用户介入', duration_ms: '300000', status: 'CONFIRMED', revision: '2',
        history: [{ action: 'CONFIRM', reason: '用户核对' }], source_kind: 'USER_DECLARED', created_at: '2026-10-14T00:05:00Z' }],
      event_statistics: { coverage: 'CONFIRMED_RECORDS_ONLY', rework_count: 0, intervention_count: 1, known_intervention_ms: '300000' } };
    return json(url.endsWith('/work-segments') ? { project_id: 'p1', items: [segment] } : segment);
  }));
  const api = client();
  const start = await api.startWorkSegment({ projectId: 'p1', commandId: 'start1', confirmed: true, title: '本段', expectation: '按原验收完成',
    tasks: [{ taskId: 't1', expectedRevision: '0', expectedAcceptanceRevision: '1' }] });
  const event = await api.proposeWorkSegmentEvent({ segmentId: start.segmentId, commandId: 'event1', expectedRevision: start.revision,
    kind: 'HUMAN_INTERVENTION', description: '用户介入', taskId: 't1', durationMs: 300000 });
  const confirmed = await api.resolveWorkSegmentEvent({ eventId: event.eventId!, commandId: 'confirm1', expectedRevision: event.eventRevision!, action: 'CONFIRM', reason: '用户核对' });
  await api.finishWorkSegment({ segmentId: 's1', commandId: 'finish1', expectedRevision: confirmed.revision });
  expect(posts[0]).toMatchObject({ confirmed: true, tasks: [{ task_id: 't1', expected_revision: '0', expected_acceptance_revision: '1' }] });
  expect(posts[2]).toMatchObject({ expected_revision: '1', action: 'CONFIRM' });
  const result = await api.getWorkSegment('s1');
  expect(result.snapshotKind).toBe('FINISHED');
  expect(result.eventStatistics.knownInterventionMs).toBe('300000');
  expect(result.events[0]?.history).toHaveLength(1);
  expect((await api.getProjectWorkSegments('p1')).items).toHaveLength(1);
  const retrospective = await api.getTemporaryRetrospective('p1', ['t1', 't2']);
  expect(retrospective.baselineStatus).toBe('PARTIAL');
  expect(retrospective.tasks[0]?.expectation).toBe('原预期');
  expect(retrospective.tasks[1]?.expectation).toBeNull();
});

it('工作段会话客户端沿原状态请求创建元数据并读回', async () => {
  const change = { ordinal: 0, change_kind: 'START_WORK_SEGMENT', command_id: 'write1', status: 'PENDING', before_ref: null, after_ref: null, error: null };
  const request = { request_id: 'r1', session_id: 'chat1', source_message_id: 'm1', project_id: 'p1', decision: 'MAINTAIN', status: 'READY',
    candidate_status: 'READY', questions: [], changes: [change], decision_required: null, undo_command_id: 'undo1', revision: '1',
    created_at: '2026-10-14T00:00:00Z', updated_at: '2026-10-14T00:00:00Z' };
  let count = 0;
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    count++;
    if (init?.method !== 'POST') return new Response(JSON.stringify({ ...request, status: 'APPLIED', revision: '2' }), { status: 200 });
    const body = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ command_id: body.command_id ?? 'apply1', committed_at: '2026-10-14T00:00:00Z', result: count === 1 ? request :
      { request_id: 'r1', status: 'APPLIED', revision: '2', undo_command_id: 'undo1', changes: [{ ...change, status: 'APPLIED', after_ref: { segment_id: 's1' } }] } }),
    { status: count === 1 ? 202 : 200 });
  }));
  const result = await client().startWorkSegmentFromConversation({ sessionId: 'chat1', sourceMessageId: 'm1', commandId: 'interpret1' });
  expect(result.application?.changes?.[0]?.afterRef?.segment_id).toBe('s1');
  expect(result.request.status).toBe('APPLIED');
  expect(count).toBe(3);
});
