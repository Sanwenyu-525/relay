import { afterEach, expect, it, vi } from 'vitest';
import { RelayApiClient } from '../src/api/relayClient';
afterEach(() => vi.unstubAllGlobals());

it('试用客户端保存原流程、转换和补录，读回未知总耗时及准备口径', async () => {
  const posts: Record<string, unknown>[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_input: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      posts.push(body);
      return new Response(JSON.stringify({ command_id: body.command_id, committed_at: '2026-10-14T00:00:00Z',
        result: { trial_id: 'trial1', task_id: 'task1', status: body.action === 'PAUSE' ? 'PAUSED' : 'RUNNING',
          revision: String(posts.length) } }), { status: 200 });
    }
    const observation = { observation_id: 'o1', trial_revision: '3', preparation_ms: '180000',
      total_acceptance_ms: null, source_note: '用户补录', source_kind: 'USER_REPORTED', source_message_id: 'message1', created_at: '2026-10-14T00:00:03Z' };
    return new Response(JSON.stringify({ task_id: 'task1', server_time: '2026-10-14T00:00:03Z', items: [{
      trial_id: 'trial1', task_id: 'task1', status: 'PAUSED', revision: '3', mode: 'ORIGINAL',
      sample_label: '原流程', material_ids: [], acceptance_revision: '1', acceptance_matches: true,
      started_at: '2026-10-14T00:00:00Z', finished_at: null, active_ms: '1000', paused_ms: '2000', elapsed_ms: '3000',
      total_includes_preparation: true, latest_observation: observation, observations: [observation],
    }] }), { status: 200 });
  }));
  const client = new RelayApiClient({ baseUrl: 'http://127.0.0.1:8787', workspaceId: 'w1', bearerToken: 'test' });
  const start = await client.startTaskAcceptanceTrial({ taskId: 'task1', commandId: 'start1',
    expectedAcceptanceRevision: '1', mode: 'ORIGINAL', sampleLabel: '原流程' });
  const pause = await client.transitionTaskAcceptanceTrial({ taskId: 'task1', trialId: start.trialId,
    commandId: 'pause1', expectedRevision: start.revision, action: 'PAUSE' });
  await client.recordTaskAcceptanceObservation({ taskId: 'task1', trialId: start.trialId,
    commandId: 'observe1', expectedRevision: pause.revision,
    preparationMs: 180000, totalAcceptanceMs: null, sourceNote: '用户补录' });
  expect(posts[0]).toMatchObject({ mode: 'ORIGINAL', material_ids: [] });
  expect(posts[1]).toMatchObject({ action: 'PAUSE', expected_revision: '1' });
  expect(posts[2]).toMatchObject({ preparation_ms: 180000, total_acceptance_ms: null, expected_revision: '2' });
  const trial = (await client.getTaskAcceptanceTrials('task1')).items[0]!;
  expect(trial.totalIncludesPreparation).toBe(true);
  expect(trial.latestObservation?.totalAcceptanceMs).toBeNull();
  expect(trial.latestObservation?.preparationMs).toBe('180000');
  expect(trial.latestObservation?.sourceMessageId).toBe('message1');
  expect(trial.activeMs).toBe('1000');
  expect(trial.pausedMs).toBe('2000');
});
