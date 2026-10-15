import { afterEach, expect, it, vi } from 'vitest';
import { RelayApiClient } from '../src/api/relayClient';
afterEach(() => vi.unstubAllGlobals());

const change = { ordinal: 0, change_kind: 'REPORT_ACCEPTANCE_TIME', command_id: 'record1', status: 'PENDING',
  before_ref: null, after_ref: null, error: null };
const request = { request_id: 'request1', session_id: 's1', source_message_id: 'message1', project_id: 'p1',
  decision: 'MAINTAIN', status: 'READY', candidate_status: 'READY', questions: [], changes: [change],
  decision_required: null, undo_command_id: 'undo1', revision: '1', created_at: '2026-10-14T00:00:00Z', updated_at: '2026-10-14T00:00:00Z' };
const client = () => new RelayApiClient({ baseUrl: 'http://127.0.0.1:8787', workspaceId: 'w1', bearerToken: 'test' });
it('会话耗时客户端沿原用户消息解释和应用，读回确切试用回执', async () => {
  const posts: Record<string, unknown>[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method !== 'POST') return new Response(JSON.stringify({ ...request, status: 'APPLIED', revision: '2',
      updated_at: '2026-10-14T00:00:01Z', changes: [{ ...change, status: 'APPLIED' }] }), { status: 200 });
    const body = JSON.parse(String(init?.body));
    posts.push(body);
    return new Response(JSON.stringify({ command_id: body.command_id ?? 'apply1', committed_at: '2026-10-14T00:00:00Z',
      result: posts.length === 1 ? request : { request_id: 'request1', status: 'APPLIED', revision: '2',
        undo_command_id: 'undo1', changes: [{ ...change, status: 'APPLIED', after_ref: {
          trial_id: 'trial1', task_id: 'task1', revision: '2', source_message_id: 'message1' } }] } }),
    { status: posts.length === 1 ? 202 : 200 });
  }));
  const result = await client().reportAcceptanceTimeFromConversation({ sessionId: 's1', sourceMessageId: 'message1', commandId: 'interpret1' });
  expect(posts[0]).toEqual({ command_id: 'interpret1', source_message_id: 'message1' });
  expect(posts[1]).toEqual({});
  expect(result.request.status).toBe('APPLIED');
  expect(result.request.updatedAt).toBe('2026-10-14T00:00:01Z');
  expect(result.application?.changes?.[0]?.afterRef).toMatchObject({ trial_id: 'trial1', source_message_id: 'message1' });
});
it('多条试用需要澄清时不调用应用入口', async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ command_id: 'interpret1', committed_at: '2026-10-14T00:00:00Z',
    result: { ...request, decision: 'CLARIFY', status: 'CLARIFY', changes: null, questions: ['请说明样本标签。'] } }), { status: 202 }));
  vi.stubGlobal('fetch', fetch);
  const result = await client().reportAcceptanceTimeFromConversation({ sessionId: 's1', sourceMessageId: 'message1', commandId: 'interpret1' });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(result.application).toBeNull();
  expect(result.request.questions).toEqual(['请说明样本标签。']);
});
