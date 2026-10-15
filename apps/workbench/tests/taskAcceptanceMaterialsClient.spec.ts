import { afterEach, expect, it, vi } from 'vitest';
import { RelayApiClient } from '../src/api/relayClient';
afterEach(() => { vi.unstubAllGlobals(); });

it('基础客户端：文本导入和关联分用原命令，材料读取与撤销沿原 Task', async () => {
  const posts: { path: string; body: Record<string, unknown> }[] = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status,
    headers: { 'Content-Type': 'application/json' } });
  let withdrawn = false;
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const path = new URL(input).pathname;
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posts.push({ path, body });
      if (path.endsWith('/knowledge')) return json({ command_id: body.command_id,
        committed_at: '2026-10-14T00:00:00Z', result: { knowledge_id: 'k1', version: '1', revision: '0' } }, 201);
      if (path.endsWith('/withdrawals')) withdrawn = true;
      return json({ command_id: body.command_id, committed_at: '2026-10-14T00:00:00Z',
        result: { material_id: 'm1', task_id: 't1', status: withdrawn ? 'WITHDRAWN' : 'ACTIVE', revision: withdrawn ? '2' : '1' } });
    }
    return json({ task_id: 't1', acceptance_revision: '1', items: [{
      material_id: 'm1', task_id: 't1', status: 'ACTIVE', revision: '1', acceptance_revision: '1',
      criterion_id: null, knowledge_id: 'k1', knowledge_version: '1', knowledge_version_id: 'kv1',
      title: 'test.log', content_sha256: 'a'.repeat(64), material_availability: 'AVAILABLE',
      tested_artifact_version_id: null, acceptance_matches: true, tested_artifact_is_current: null,
      evidence_kind: 'UNVERIFIED_REFERENCE', source_label: 'test.log', note: null,
      missing_fields: ['criterion_id', 'tested_artifact_version_id'],
      created_at: '2026-10-14T00:00:00Z', withdrawn_at: null,
    }] });
  }));
  const client = new RelayApiClient({ baseUrl: 'http://127.0.0.1:8787', workspaceId: 'w1', bearerToken: 'test' });
  const imported = await client.importTaskAcceptanceMaterial({ taskId: 't1', projectId: 'p1',
    commandId: 'attach-1', importCommandId: 'import-1', expectedAcceptanceRevision: '1',
    title: 'test.log', text: '测试结果原文', mediaType: 'text/plain', sourceLabel: 'test.log' });
  expect(imported.materialId).toBe('m1');
  expect(posts[0]?.body).toMatchObject({ command_id: 'import-1', text: '测试结果原文', source_kind: 'MANAGED_TEXT' });
  expect(posts[1]?.body).toMatchObject({ command_id: 'attach-1', knowledge_id: 'k1', knowledge_version: '1' });
  const materials = await client.getTaskAcceptanceMaterials('t1');
  expect(materials.items[0]?.evidenceKind).toBe('UNVERIFIED_REFERENCE');
  expect(materials.items[0]?.missingFields).toEqual(['criterion_id', 'tested_artifact_version_id']);
  const removed = await client.withdrawTaskAcceptanceMaterial({ taskId: 't1', materialId: 'm1',
    commandId: 'withdraw-1', expectedRevision: '1' });
  expect(removed).toMatchObject({ materialId: 'm1', status: 'WITHDRAWN', revision: '2' });
});
