import { afterEach, expect, it, vi } from 'vitest';
import { RelayApiClient } from '../src/api/relayClient';
afterEach(() => vi.unstubAllGlobals());
const client = () => new RelayApiClient({ baseUrl: 'http://127.0.0.1:8787', workspaceId: 'w1', bearerToken: 'test' });
it('估时客户端传递未知、整段与人工口径，读回历史和适用状态', async () => {
  const posts: Record<string, unknown>[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    const e = { id: 'e1', task_id: 't1', revision: '1', acceptance_revision: '1', elapsed_ms: null, execution_ms: '100', waiting_ms: null,
      review_ms: null, human_ms: '50', source_note: '依据未知', source_kind: 'USER_DECLARED', created_at: '2026-10-14T00:00:00Z' };
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)); posts.push(body);
      return new Response(JSON.stringify({ command_id: body.command_id, committed_at: e.created_at, result: { task_id: 't1', estimate_id: 'e1', revision: '1' } }), { status: 200 });
    }
    return new Response(JSON.stringify({ task_id: 't1', current: { ...e, applicable: true }, items: [e] }), { status: 200 });
  }));
  const api = client(); await api.recordTaskTimeEstimate({ commandId: 'c1', taskId: 't1', expectedTaskRevision: '0', expectedEstimateRevision: '0', confirmed: true,
    elapsedMs: null, executionMs: 100, waitingMs: null, reviewMs: null, humanMs: 50, sourceNote: '依据未知' });
  expect(posts[0]).toMatchObject({ elapsed_ms: null, execution_ms: 100, human_ms: 50, expected_estimate_revision: '0' });
  const read = await api.getTaskTimeEstimates('t1'); expect(read.current?.elapsedMs).toBeNull(); expect(read.current?.humanMs).toBe('50'); expect(read.current?.applicable).toBe(true);
});
it('计划客户端读回固定窗口、诊断候选和逐项应用结果，不冒充执行授权', async () => {
  const posts: Record<string, unknown>[] = [];
  const plan = { plan_id: 'p1', project_id: 'project1', revision: '1', title: '下一段', available_ms: '3600000', remaining_ms: '3590000',
    started_at: '2026-10-14T00:00:00Z', ends_at: '2026-10-14T01:00:00Z', expired: false, time_warning: 'ESTIMATED_WORK_EXCEEDS_REMAINING_WINDOW', stale_reasons: [], baseline: { capacity_policy: 'SERIAL_ELAPSED_INCLUDING_WAIT_AND_REVIEW' },
    execution_admission: 'NOT_GRANTED', permission_gaps: 'CHECK_AT_EXECUTION', human_intervention: 'SEE_BLOCKERS_AND_TASK_ACCEPTANCE',
    items: [{ id: 'i1', task_id: 't1', title: '主线', kind: 'DIAGNOSTIC', reason: 'BOUNDED_DIAGNOSIS_REQUIRED', budget_ms: 600000, human_ms: null,
      depends_on_task_ids: [], status: 'CANDIDATE', created_task_id: null, resolution_reason: null, output: '交付诊断证据' }] };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)); posts.push(body);
      return new Response(JSON.stringify({ command_id: body.command_id, committed_at: plan.started_at, result: { plan_id: 'p1', project_id: 'project1', revision: '1',
        ...(url.endsWith('/resolutions') ? { item_id: 'i1', item_status: 'ACCEPTED', created_task_id: 'diagnostic1' } : {}) } }), { status: 200 });
    }
    return new Response(JSON.stringify(url.endsWith('/period-plans') ? { project_id: 'project1', items: [plan] } : plan), { status: 200 });
  }));
  const api = client(); await api.proposePeriodPlan({ projectId: 'project1', commandId: 'c1', title: '下一段', availableMs: 3600000, diagnosticMs: 600000, taskIds: ['t1'], mainlineTaskIds: ['t1'], goalIds: [] });
  const read = await api.getPeriodPlan('p1'); expect(read.executionAdmission).toBe('NOT_GRANTED'); expect(read.items[0]?.humanMs).toBeNull();
  expect(read.timeWarning).toBe('ESTIMATED_WORK_EXCEEDS_REMAINING_WINDOW');
  expect((await api.getProjectPeriodPlans('project1')).items).toHaveLength(1);
  const result = await api.resolvePeriodPlanItem({ commandId: 'c2', planId: 'p1', itemId: 'i1', expectedRevision: '1', action: 'ACCEPT', reason: '先定位' });
  expect(result.createdTaskId).toBe('diagnostic1'); expect(posts[0]).toMatchObject({ mainline_task_ids: ['t1'], available_ms: 3600000 });
  expect(posts[1]).toMatchObject({ action: 'ACCEPT', expected_revision: '1' });
});
