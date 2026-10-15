import { afterEach, expect, it, vi } from 'vitest';
import { RelayApiClient } from '../src/api/relayClient';
afterEach(() => vi.unstubAllGlobals());

it('冻结比较客户端传递原基线版本与目标，读回整体变慢和未知项', async () => {
  const posts: Record<string, unknown>[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      posts.push(body);
      return new Response(JSON.stringify({ command_id: body.command_id, committed_at: '2026-10-14T00:00:00Z',
        result: body.baseline_trial_id ? { comparison_id: 'cmp1', project_id: 'p1' } :
          { trial_id: 'new1', task_id: 't1', status: 'RUNNING', revision: '1' } }), { status: 200 });
    }
    const observation = { observation_id: 'o1', trial_revision: '3', preparation_ms: '60000',
      total_acceptance_ms: '150000', correctness_outcome: 'NO_ISSUE_REPORTED', source_kind: 'USER_REPORTED', source_note: '人工补录' };
    return new Response(JSON.stringify({ project_id: 'p1', items: [{
      comparison_id: 'cmp1', project_id: 'p1', baseline_trial_id: 'old1', baseline_task_id: 't0',
      baseline_revision: '3', baseline_current: true, baseline_finding_ms: '60000',
      baseline_observation: { ...observation, preparation_ms: '0', total_acceptance_ms: '120000' },
      target_reduction_percent: 20, sample_scope: '相似任务样本', frozen_at: '2026-10-14T00:00:00Z',
      total_includes_preparation: true, evidence_kind: 'USER_REPORTED_SAMPLE', samples: [
        { trial_id: 'new1', task_id: 't1', trial_revision: '3', sample_label: '新流程', status: 'FINISHED', material_ids: [],
          finding_ms: '30000', observation, material_status: 'CURRENT', assessment: 'TARGET_NOT_MET',
          finding_reduction_percent: 50, total_reduction_percent: -25, preparation_difference_ms: '60000',
          finding_target_met: true, overall_time_saved: false },
        { trial_id: 'new2', task_id: 't2', trial_revision: '2', sample_label: '未补录', status: 'FINISHED', material_ids: [],
          finding_ms: '30000', observation: null, material_status: 'CURRENT', assessment: 'INSUFFICIENT_DATA',
          finding_reduction_percent: 50, total_reduction_percent: null, preparation_difference_ms: null,
          finding_target_met: true, overall_time_saved: null },
      ],
    }] }), { status: 200 });
  }));
  const client = new RelayApiClient({ baseUrl: 'http://127.0.0.1:8787', workspaceId: 'w1', bearerToken: 'test' });
  const frozen = await client.freezeAcceptanceComparison({ projectId: 'p1', commandId: 'freeze1', baselineTrialId: 'old1',
    expectedBaselineRevision: '3', targetReductionPercent: 20, sampleScope: '相似任务样本' });
  await client.startTaskAcceptanceTrial({ taskId: 't1', commandId: 'start1', expectedAcceptanceRevision: '1',
    mode: 'EVIDENCE_VIEW', sampleLabel: '新流程', comparisonId: frozen.comparisonId });
  await client.recordTaskAcceptanceObservation({ taskId: 't1', trialId: 'new1', commandId: 'observe1', expectedRevision: '2',
    preparationMs: 60000, totalAcceptanceMs: 150000, sourceNote: '人工补录', correctnessOutcome: 'NO_ISSUE_REPORTED' });
  expect(posts[0]).toMatchObject({ expected_baseline_revision: '3', target_reduction_percent: 20 });
  expect(posts[1]).toMatchObject({ comparison_id: 'cmp1', mode: 'EVIDENCE_VIEW' });
  expect(posts[2]).toMatchObject({ correctness_outcome: 'NO_ISSUE_REPORTED' });
  const comparison = (await client.getAcceptanceComparisons('p1')).items[0]!;
  expect(comparison.samples[0]).toMatchObject({ findingTargetMet: true, overallTimeSaved: false,
    totalReductionPercent: -25, assessment: 'TARGET_NOT_MET' });
  expect(comparison.samples[1]?.overallTimeSaved).toBeNull();
  expect(comparison.evidenceKind).toBe('USER_REPORTED_SAMPLE');
});
