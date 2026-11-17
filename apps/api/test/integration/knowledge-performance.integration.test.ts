import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { performance } from 'node:perf_hooks';
import { sql } from 'kysely';

import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { retrieveKnowledge } from '../../src/application/knowledge-retrieval.js';
import { APP_DATABASE_URL, MIGRATION_DATABASE_URL, MIGRATIONS_DIRECTORY, openDatabase } from './integration-support.js';
import { createWorkspace, startTestApi, workspacePath, type TestApi } from './api-harness.js';

/**
 * 知识列表/搜索/概览/Agent 检索在 100/1000/10000 条独立测试数据下的真实耗时。
 * 数据只写入集成测试的临时数据库，不接触生产库；阈值用于发现 N+1 或全表扫描回归，
 * 不是生产 SLA 承诺。运行环境会影响绝对值，因此结果同时输出原始毫秒。
 */

const database = openDatabase(APP_DATABASE_URL, 'relay-knowledge-performance');
let api: TestApi;
let workspaceId: string;

before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
  api = await startTestApi();
  workspaceId = await createWorkspace(database.db);
});
after(async () => { await api?.stop(); await database.close(); });

const path = (suffix: string) => workspacePath(workspaceId, suffix);
async function insertBatch(count: number): Promise<void> {
  const prefix = `性能知识${count}-`;
  await database.db.transaction().execute(async (trx) => {
    await sql`
      with batch as (select gen_random_uuid() as id, g from generate_series(1, ${count}) g)
      insert into knowledge_items (id, workspace_id, project_id, title, status, current_version, revision,
        summary, search_title_tokens, search_body_tokens)
      select id, ${workspaceId}, null, ${prefix} || g, 'ACTIVE', 1, 0,
        '性能摘要 ' || g, '性能 知识 检索 列表', '正文 性能 检索 关键词 ' || g
      from batch
    `.execute(trx);
    await sql`
      insert into knowledge_versions (id, workspace_id, knowledge_id, project_id, version,
        source_kind, media_type, content_text, content_sha256, availability, source_refs)
      select gen_random_uuid(), workspace_id, id, null, 1, 'MANAGED_TEXT', 'text/plain',
        '性能正文 ' || title, decode(repeat('00', 32), 'hex'), 'AVAILABLE', '{}'::jsonb
      from knowledge_items
      where workspace_id = ${workspaceId} and title like ${`${prefix}%`}
    `.execute(trx);
  });
}

async function timed<T>(label: string, work: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const start = performance.now();
  const value = await work();
  const ms = performance.now() - start;
  console.log(`[knowledge-perf] ${label}: ${ms.toFixed(1)}ms`);
  return { value, ms };
}

test('100/1000/10000 条知识：列表、中文搜索、概览与 Agent 检索保持有界', async () => {
  for (const count of [100, 1000, 10000]) {
    await insertBatch(count);
    const total = count;

    const list = await timed(`page ${total}`, async () => {
      const response = await api.get(path('/knowledge/page?limit=50&sort=TITLE_ASC'));
      assert.equal(response.status, 200, response.text);
      return response;
    });
    assert.ok(list.ms < 2000, `列表首屏在 ${total} 条时应低于 2s，实际 ${list.ms}ms`);

    const search = await timed(`search ${total}`, async () => {
      const response = await api.get(path(`/knowledge/page?limit=50&q=${encodeURIComponent('性能 检索')}`));
      assert.equal(response.status, 200, response.text);
      return response;
    });
    assert.ok(search.ms < 2000, `中文搜索在 ${total} 条时应低于 2s，实际 ${search.ms}ms`);

    const overview = await timed(`overview ${total}`, async () => {
      const response = await api.get(path('/knowledge/overview'));
      assert.equal(response.status, 200, response.text);
      return response;
    });
    assert.ok(overview.ms < 2000, `概览在 ${total} 条时应低于 2s，实际 ${overview.ms}ms`);

    const retrieval = await timed(`retrieve ${total}`, () => retrieveKnowledge(database.db, {
      workspaceId, projectId: '00000000-0000-4000-8000-000000000000',
      taskTitle: `性能知识${count}-${Math.max(1, Math.floor(count / 2))}`, limit: 10
    }));
    assert.ok(retrieval.value.length <= 10, 'Agent 候选池必须保持上限');
  }
});
