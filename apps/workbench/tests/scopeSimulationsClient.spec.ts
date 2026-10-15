import { afterEach, expect, it, vi } from 'vitest';
import { RelayApiClient } from '../src/api/relayClient';
afterEach(() => vi.unstubAllGlobals());
const client = () => new RelayApiClient({ baseUrl: 'http://127.0.0.1:8787', workspaceId: 'w1', bearerToken: 'test' });
const item = { id: 'i1', task_id: 't1', title: '主线', kind: 'DIAGNOSTIC', reason: 'BOUNDED_DIAGNOSIS_REQUIRED', budget_ms: 100, human_ms: null,
  depends_on_task_ids: [], status: 'CANDIDATE', created_task_id: null, resolution_reason: null, output: '交付阶段证据' };
const result = { simulation_id: 's1', source_plan_id: 'p1', project_id: 'project1', revision: '1', status: 'PROPOSED', selected_option: null, selected_plan_id: null };
const view = { ...result, baseline: { available_ms: '1000', started_at: '2026-10-14T00:00:00Z', estimate_sources: [{ task_id: 't1', estimate: null }] },
  options: ['ALL', 'SHRINK', 'DEFER'].map((kind) => ({ kind, task_ids: ['t1'], retained_prerequisite_ids: [], excluded_task_ids: ['t2'],
    requested_elapsed_ms: null, requested_human_ms: null, planned_ms: 100, capacity_gap_ms: null, unknown_estimate_task_ids: ['t1'], unreliable_task_ids: [], feasibility: 'UNKNOWN',
    items: [item], consequences: [{ task_id: 't2', impact: 'NEXT_WINDOW_UNSCHEDULED' }] })), created_at: '2026-10-14T00:00:00Z', selection_reason: null,
  stale_reasons: [], selected_plan: null, execution_admission: 'NOT_GRANTED', permission_gaps: 'CHECK_AT_EXECUTION', material_gaps: 'CHECK_AT_EXECUTION', completion_date: null };
it('推演客户端保留同一容量、未知和来源，选择返回原计划应用身份与部分结果', async () => {
  const posts: Record<string, unknown>[] = []; let selected = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)); posts.push(body); if (url.endsWith('/selections')) selected = true;
      return json({ command_id: body.command_id, committed_at: view.created_at, result: selected ? { ...result, status: 'SELECTED', revision: '2', selected_option: 'SHRINK', selected_plan_id: 'p2' } : result });
    }
    const read = selected ? { ...view, status: 'SELECTED', revision: '2', selected_option: 'SHRINK', selected_plan_id: 'p2', selection_reason: '先诊断',
      selected_plan: { plan_id: 'p2', revision: '2', items: [{ ...item, status: 'ACCEPTED', created_task_id: 'diagnostic1' }] } } : view;
    return json(url.endsWith('/scope-simulations') ? { source_plan_id: 'p1', items: [read] } : read);
  }));
  const api = client(); await api.proposeScopeSimulation({ commandId: 'c1', planId: 'p1', expectedRevision: '1', keepTaskIds: ['t1'], deferTaskIds: ['t2'], unreliableTaskIds: [] });
  const original = await api.getScopeSimulation('s1'); expect(original.options[0]?.requestedElapsedMs).toBeNull(); expect(original.options[0]?.capacityGapMs).toBeNull();
  expect(original.completionDate).toBeNull(); expect(original.executionAdmission).toBe('NOT_GRANTED');
  const selectedResult = await api.selectScopeSimulation({ commandId: 'c2', simulationId: 's1', expectedRevision: '1', option: 'SHRINK', confirmed: true, reason: '先诊断' });
  expect(selectedResult.selectedPlanId).toBe('p2');
  expect((await api.getScopeSimulation('s1')).selectedPlan?.items[0]?.createdTaskId).toBe('diagnostic1');
  expect((await api.getPlanScopeSimulations('p1')).items).toHaveLength(1);
  expect(posts[0]).toMatchObject({ keep_task_ids: ['t1'], defer_task_ids: ['t2'], unreliable_task_ids: [] });
  expect(posts[1]).toMatchObject({ option: 'SHRINK', confirmed: true });
});
it('推演客户端拒绝将缺权限/执行授权或完成日期承诺冒充范围比较', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ...view, completion_date: '2026-10-15' }), { status: 200 })));
  await expect(client().getScopeSimulation('s1')).rejects.toThrow('完成日期承诺');
});
