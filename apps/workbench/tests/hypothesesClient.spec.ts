import { afterEach, expect, it, vi } from 'vitest';
import { RelayApiClient } from '../src/api/relayClient';
afterEach(() => vi.unstubAllGlobals());
const client = () => new RelayApiClient({ baseUrl: 'http://127.0.0.1:8787', workspaceId: 'w1', bearerToken: 'test' });
const definition = { claim: '降低成本', method: '比较样本', criterion: '总成本下降' };
it('假设客户端支持定义/观察/建议/用户确认，读取确切来源及旧结论适用性', async () => {
  const posts: Record<string, unknown>[] = [];
  const conclusion = { id: 'confirmed1', hypothesis_id: 'h1', hypothesis_version: '1', kind: 'USER_CONFIRMED',
    outcome: 'NOT_SUPPORTED', rationale: '用户已确认', evidence_sufficient: true, method_reliable: true,
    observation_ids: ['o1'], suggestion_id: 'suggestion1', created_at: '2026-10-14T00:00:03Z', applicable: false,
    recommendation: 'STOP_NEXT_STAGE' };
  const hypothesis = { hypothesis_id: 'h1', project_id: 'p1', title: '成本假设', revision: '6', version: '2', created_at: '2026-10-14T00:00:00Z',
    versions: [{ id: 'v2', hypothesis_id: 'h1', version: '2', ...definition, source_knowledge_version_id: null, source_message_id: 'message1',
      source_status: 'NONE', created_at: '2026-10-14T00:00:05Z' }],
    observations: [{ id: 'o1', hypothesis_id: 'h1', hypothesis_version: '1', summary: '原样本', knowledge_version_id: 'kv1',
      evidence_kind: 'UNVERIFIED_REFERENCE', source_status: 'STALE', created_at: '2026-10-14T00:00:01Z' }],
    conclusions: [conclusion], current_user_conclusion: conclusion };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method !== 'POST') return new Response(JSON.stringify(url.endsWith('/hypotheses') ? { project_id: 'p1', items: [hypothesis] } : hypothesis), { status: 200 });
    const body = JSON.parse(String(init.body));
    posts.push(body);
    const result = { hypothesis_id: 'h1', project_id: 'p1', revision: String(posts.length), version: body.method && posts.length > 1 ? '2' : '1',
      ...(url.endsWith('/observations') ? { decision_review_count: '1', decision_review_candidates_ref: 'projects/p1/decision-reviews' } : {}),
      ...(url.endsWith('/suggestions') ? { suggestion_id: 'suggestion1', outcome: 'NOT_SUPPORTED', recommendation: 'STOP_NEXT_STAGE' } : {}),
      ...(url.endsWith('/confirmations') ? { conclusion_id: 'confirmed1', outcome: 'NOT_SUPPORTED' } : {}) };
    return new Response(JSON.stringify({ command_id: body.command_id, committed_at: '2026-10-14T00:00:00Z', result }), { status: posts.length === 1 ? 201 : 200 });
  }));
  const api = client();
  const created = await api.createHypothesis({ projectId: 'p1', commandId: 'create1', title: '成本假设', confirmed: true, ...definition });
  const observed = await api.observeHypothesis({ hypothesisId: created.hypothesisId, commandId: 'observe1', expectedRevision: created.revision, summary: '原样本', knowledgeVersionId: 'kv1' });
  expect(observed.decisionReviewCount).toBe('1');
  expect(observed.decisionReviewCandidatesRef).toBe('projects/p1/decision-reviews');
  const suggested = await api.suggestHypothesisConclusion({ hypothesisId: 'h1', commandId: 'suggest1', expectedRevision: observed.revision,
    outcome: 'NOT_SUPPORTED', rationale: '样本未支持', evidenceSufficient: true, methodReliable: true });
  await api.confirmHypothesisConclusion({ hypothesisId: 'h1', commandId: 'confirm1', expectedRevision: suggested.revision, suggestionId: suggested.suggestionId!, confirmed: true });
  await api.versionHypothesis({ hypothesisId: 'h1', commandId: 'version1', expectedRevision: '4', ...definition });
  expect(posts[0]).toMatchObject({ confirmed: true, ...definition });
  expect(posts[1]).toMatchObject({ knowledge_version_id: 'kv1', expected_revision: '1' });
  expect(posts[3]).toMatchObject({ suggestion_id: 'suggestion1', confirmed: true });
  const current = await api.getHypothesis('h1');
  expect(current.currentUserConclusion).toMatchObject({ kind: 'USER_CONFIRMED', applicable: false });
  expect(current.observations[0]?.evidenceKind).toBe('UNVERIFIED_REFERENCE');
  expect(current.versions[0]?.sourceMessageId).toBe('message1');
  expect((await api.getProjectHypotheses('p1')).items).toHaveLength(1);
});
it('会话建档只应用 CREATE_HYPOTHESIS，随后读回原来源消息', async () => {
  const change = { ordinal: 0, change_kind: 'CREATE_HYPOTHESIS', command_id: 'write1', status: 'PENDING', before_ref: null, after_ref: null, error: null };
  const request = { request_id: 'req1', session_id: 's1', source_message_id: 'message1', project_id: 'p1', decision: 'MAINTAIN',
    status: 'READY', candidate_status: 'READY', questions: [], changes: [change], decision_required: null,
    undo_command_id: 'undo1', revision: '1', created_at: '2026-10-14T00:00:00Z', updated_at: '2026-10-14T00:00:00Z' };
  let count = 0;
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    count++;
    if (init?.method !== 'POST') return new Response(JSON.stringify({ ...request, status: 'APPLIED', revision: '2' }), { status: 200 });
    const body = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ command_id: body.command_id ?? 'apply1', committed_at: '2026-10-14T00:00:00Z', result: count === 1 ? request :
      { request_id: 'req1', status: 'APPLIED', revision: '2', changes: [{ ...change, status: 'APPLIED', after_ref: { hypothesis_id: 'h1' } }], undo_command_id: 'undo1' } }),
    { status: count === 1 ? 202 : 200 });
  }));
  const result = await client().createHypothesisFromConversation({ sessionId: 's1', sourceMessageId: 'message1', commandId: 'interpret1' });
  expect(result.request.status).toBe('APPLIED');
  expect(result.application?.changes?.[0]?.afterRef).toMatchObject({ hypothesis_id: 'h1' });
  expect(count).toBe(3);
});
