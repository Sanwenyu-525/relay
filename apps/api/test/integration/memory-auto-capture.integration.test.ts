import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';

import { sql } from 'kysely';

import { createAssistSession, requestAssistMessage } from '../../src/application/assist-commands.js';
import { runAssistGenerationTick } from '../../src/application/assist-runner.js';
import { loadAssistSourceContent } from '../../src/application/assist-source-content.js';
import { captureMemoriesForTurn } from '../../src/application/memory-auto-capture.js';
import { listInformation } from '../../src/application/information-queries.js';
import { createRepositories, withTransaction } from '../../src/application/unit-of-work.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { ManagedContentStore } from '../../src/storage/managed-content-store.js';
import { FakeModelPort } from '../../src/workflow/fake-model-port.js';
import { createDataRoot } from './api-harness.js';
import { APP_DATABASE_URL, MIGRATION_DATABASE_URL, MIGRATIONS_DIRECTORY, openDatabase } from './integration-support.js';

/**
 * 自动捕获的来源类别（DEV-0042、ADR-032）：真实 PostgreSQL。
 *
 * 固定的是三件事：
 *  1. 提取项必须逐字引用它声明的那一段，核验不过的候选**不写入**；
 *  2. 写下的条目带来源类别（用户原话 / 模型观察），并随召回排序与投影透出；
 *  3. 模型侧看到的来源段标注类别，观察不得被当成用户陈述。
 */

const app = openDatabase(APP_DATABASE_URL, 'relay-memory-auto-capture');
let dataRoot: string;

before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
  dataRoot = await createDataRoot();
});
after(async () => { await app.close(); });

const USER_TEXT = '我们决定用 PostgreSQL 做唯一业务数据库。';
const REPLY_TEXT = '网页正文说 pnpm 是这个仓库的包管理器。';

async function fixture(): Promise<{ workspaceId: string; projectId: string; sessionId: string }> {
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  await withTransaction(app.db, async (r) => {
    await r.workspaces.insertWorkspace({ id: workspaceId, name: 'auto-capture' });
    await r.workspaces.insertAuthorityRow(workspaceId);
    await r.projects.insertProject({ id: projectId, workspaceId, title: 'auto', projectType: 'GENERAL' });
  });
  const session = await createAssistSession(app.db, { workspaceId, projectId,
    title: 'auto capture', commandId: randomUUID() });
  return { workspaceId, projectId, sessionId: session.result.session_id };
}

test('自动捕获：来源核验不通过的候选不写入，条目带来源类别并影响召回排序', async () => {
  const f = await fixture();
  const sent = await requestAssistMessage(app.db, { workspaceId: f.workspaceId,
    sessionId: f.sessionId, commandId: randomUUID(), content: USER_TEXT });

  // 让助手消息结算完成：回复正文里含网页正文的转述。
  const replyPort = new FakeModelPort();
  replyPort.assist = async () => ({ kind: 'CONTENT', content: REPLY_TEXT,
    providerRequestId: randomUUID(), usage: { inputTokens: 1, outputTokens: 1 } });
  const ticked = await runAssistGenerationTick(app.db, { workerId: randomUUID(),
    storage: new ManagedContentStore(dataRoot), modelPort: replyPort, leaseMs: 60_000 });
  assert.equal(ticked?.status, 'COMPLETED', JSON.stringify(ticked));

  const repositories = createRepositories(app.db);
  const session = await repositories.assist.readSession(f.sessionId);
  const assistant = await repositories.assist.readMessage(sent.result.assistant_message_id);
  assert.ok(session && assistant);

  // 抽取结果：一条引自用户原话、一条引自助手答复、一条引用在两段里都找不到。
  const extraction = JSON.stringify({ memories: [
    { title: '数据库选型', text: '唯一业务数据库用 PostgreSQL。', source: 'user',
      quote: '我们决定用 PostgreSQL', reason: '用户第一句' },
    { title: '包管理器', text: '这个仓库用 pnpm。', source: 'assistant',
      quote: 'pnpm 是这个仓库的包管理器' },
    { title: '凭空来的', text: '用户同意改用 MySQL。', source: 'user',
      quote: '用户同意改用 MySQL' },
  ] });
  const capturePort = new FakeModelPort();
  capturePort.assist = async () => ({ kind: 'CONTENT', content: extraction,
    providerRequestId: randomUUID(), usage: { inputTokens: 1, outputTokens: 1 } });

  const written = await captureMemoriesForTurn(app.db, { session, message: assistant,
    reply: REPLY_TEXT, modelPort: capturePort });
  assert.equal(written, 2, '核验不通过的候选不得写入');

  const items = await listInformation(app.db, 'memory', f.workspaceId, f.projectId);
  const byTitle = new Map(items.map((item) => [String(item.title), item]));
  assert.equal(byTitle.get('数据库选型')?.origin, 'AUTO_CAPTURE');
  assert.equal(byTitle.get('数据库选型')?.source_kind, 'USER_STATEMENT');
  assert.equal(byTitle.get('包管理器')?.source_kind, 'MODEL_OBSERVATION');
  assert.equal(byTitle.has('凭空来的'), false, '来源核验不通过的候选不落库');

  const captures = await sql<{ title: string; source_quote: string }>`
    select m.title, c.source_quote from memory_auto_captures c
      join memory_items m on m.id = c.memory_id
    where c.workspace_id = ${f.workspaceId} and c.status = 'ACTIVE'`.execute(app.db);
  const quoteByTitle = new Map(captures.rows.map((row) => [row.title, row.source_quote]));
  assert.equal(quoteByTitle.get('数据库选型'), '我们决定用 PostgreSQL');
  assert.equal(quoteByTitle.get('包管理器'), 'pnpm 是这个仓库的包管理器');

  // 召回排序：同为自动捕获时，用户原话先于模型观察。
  const recalled = await repositories.information.recallMemories(f.workspaceId, f.projectId, [], 10);
  const kinds = recalled.map((row) => row.source_kind);
  assert.equal(kinds[0], 'USER_STATEMENT', `召回顺序应先用户原话：${kinds.join(',')}`);
  assert.ok(kinds.indexOf('MODEL_OBSERVATION') > kinds.indexOf('USER_STATEMENT'));

  // 模型侧看到的来源段带类别标注：观察不能被当成用户陈述。
  const storage = new ManagedContentStore(dataRoot);
  const userMemory = recalled.find((row) => row.source_kind === 'USER_STATEMENT');
  const observed = recalled.find((row) => row.source_kind === 'MODEL_OBSERVATION');
  assert.ok(userMemory && observed);
  const userSection = await loadAssistSourceContent(repositories, storage, session,
    { kind: 'MEMORY', root_id: userMemory.id, version: userMemory.current_version.toString() });
  const observedSection = await loadAssistSourceContent(repositories, storage, session,
    { kind: 'MEMORY', root_id: observed.id, version: observed.current_version.toString() });
  assert.match(userSection.section, /用户原话/u);
  assert.match(observedSection.section, /模型观察/u);
  assert.ok(userSection.section.includes('UNTRUSTED_DATA'));
});
