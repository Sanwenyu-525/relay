import { afterEach, expect, it, vi } from 'vitest';
import { RelayApiClient } from '../src/api/relayClient';
afterEach(() => vi.unstubAllGlobals());

it('决定复审客户端登记确切资料前提，读取变化/过期候选并提交用户处理', async () => {
  const posts: Record<string, unknown>[] = [];
  let resolved = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      posts.push(body);
      if (url.endsWith('/resolutions')) resolved = true;
      return json({ command_id: body.command_id, committed_at: '2026-10-14T00:00:00Z', result: resolved ?
        { candidate_id: 'c1', project_id: 'p1', status: 'KEPT', revision: '2' } :
        { premise_id: 'premise1', decision_id: 'd1', project_id: 'p1', revision: '1' } });
    }
    if (url.endsWith('/premises')) return json({ decision_id: 'd1', items: [{ id: 'premise1', workspace_id: 'w1', project_id: 'p1',
      decision_id: 'd1', decision_revision: '0', statement: '样本仍支持原方案', knowledge_id: 'k1', hypothesis_id: null,
      baseline_ref: { kind: 'KNOWLEDGE', version: '1', version_id: 'kv1' }, revision: '1', created_at: '2026-10-14T00:00:00Z' }] });
    const review = { id: 'c1', premise_id: 'premise1', decision_id: 'd1', decision_title: '原方案', statement: '样本仍支持原方案',
      decision_revision: '0', premise_revision: '1', fingerprint: 'a'.repeat(64), cause_command_id: 'source1',
      before_ref: { kind: 'KNOWLEDGE', version: '1', version_id: 'kv1' }, after_ref: { kind: 'KNOWLEDGE', version: '2', version_id: 'kv2' },
      status: resolved ? 'KEPT' : 'PENDING', revision: resolved ? '2' : '1', reason: resolved ? '用户核对后保留' : null,
      applicable: !resolved, question: '请重新判断原决定是否仍成立。', created_at: '2026-10-14T00:00:01Z', resolved_at: resolved ? '2026-10-14T00:00:02Z' : null };
    return json({ project_id: 'p1', pending_count: resolved ? 0 : 1, items: [review, { ...review, id: 'old1', applicable: false }] });
  }));
  const api = new RelayApiClient({ baseUrl: 'http://127.0.0.1:8787', workspaceId: 'w1', bearerToken: 'test' });
  await api.registerDecisionPremise({ decisionId: 'd1', commandId: 'register1', expectedDecisionRevision: '0',
    confirmed: true, statement: '样本仍支持原方案', knowledgeVersionId: 'kv1' });
  expect(posts[0]).toMatchObject({ knowledge_version_id: 'kv1', expected_decision_revision: '0', confirmed: true });
  expect((await api.getDecisionPremises('d1')).items[0]?.baselineRef.version).toBe('1');
  const candidates = await api.getProjectDecisionReviews('p1');
  expect(candidates.pendingCount).toBe(1);
  expect(candidates.items[0]?.afterRef.version).toBe('2');
  expect(candidates.items[1]?.applicable).toBe(false);
  const kept = await api.resolveDecisionReview({ candidateId: 'c1', commandId: 'keep1', expectedRevision: '1', action: 'KEEP_DECISION', reason: '用户核对后保留' });
  expect(kept.status).toBe('KEPT');
  expect(posts[1]).toMatchObject({ action: 'KEEP_DECISION', expected_revision: '1' });
  expect((await api.getProjectDecisionReviews('p1')).pendingCount).toBe(0);
});
