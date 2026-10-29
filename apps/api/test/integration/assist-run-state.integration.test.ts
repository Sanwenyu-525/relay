import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';

import { sql } from 'kysely';

import { createAssistSession } from '../../src/application/assist-commands.js';
import { createRepositories, withTransaction } from '../../src/application/unit-of-work.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import {
  createDataRoot, startTestApi, workspacePath, type TestApi,
} from './api-harness.js';
import {
  APP_DATABASE_URL, MIGRATIONS_DIRECTORY, MIGRATION_DATABASE_URL, openDatabase,
} from './integration-support.js';

/**
 * 会话运行态投影（2026-10-28）的真实 PostgreSQL 集成。
 *
 * 左栏要在**没点开**一条会话时看出它正在生成回复，唯一可信来源是那一轮回复行自己的
 * `assist_messages.status`。这里取证的是这条派生链本身：
 *   * 没有消息、或只有终态消息 → `run_state` 为 `null`（不另立「空闲」这个词）；
 *   * 预插的 ASSISTANT 行（PENDING）→ `PENDING`；Worker 认领后（RUNNING）→ `RUNNING`；
 *   * 两者并存时 `RUNNING` 压过 `PENDING`——有 Worker 认领的那一轮才是「真的在生成」；
 *   * 结算成 COMPLETED / FAILED / CANCELLED 之后必须回到 `null`，不能留在 RUNNING；
 *   * 列表一次读取里逐行派生：同一请求里 A 在跑、B 不在跑，各自如实；
 *   * 列表与单条读取**同一口径**（左栏切换会话时会按身份重读那一行，两处不一致就会
 *     出现「切走亮、切回灭」）；
 *   * 它不改变排序键、修订与 `updated_at`：只读投影不写任何东西。
 *
 * 真实模型、Worker 领取与浏览器表现不在本文件范围内（后者归工作台的浏览器用例）。
 */

const app = openDatabase(APP_DATABASE_URL, 'relay-assist-run-state-test');
let api: TestApi;

before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
  await createDataRoot();
  api = await startTestApi();
});
after(async () => { await api.stop(); await app.close(); });

async function newWorkspace(tag: string): Promise<string> {
  const workspaceId = randomUUID();
  await withTransaction(app.db, async (repositories) => {
    await repositories.workspaces.insertWorkspace({ id: workspaceId, name: `assist-run-state-${tag}` });
    await repositories.workspaces.insertAuthorityRow(workspaceId);
  });
  return workspaceId;
}

async function newSession(workspaceId: string, title: string): Promise<string> {
  const created = await createAssistSession(app.db, {
    workspaceId, commandId: randomUUID(), projectId: null, title });
  return created.result.session_id;
}

/** 播种一条消息行；`status` 直接落库，模拟 Worker 认领与结算三个时刻。 */
async function seedMessage(sessionId: string, role: 'USER' | 'ASSISTANT',
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED'): Promise<string> {
  const messageId = randomUUID();
  await withTransaction(app.db, async (repositories) => {
    const seq = await repositories.assist.nextMessageSeq(sessionId);
    await repositories.assist.insertMessage({ id: messageId, sessionId, seq, role, status,
      intent: 'DISCUSS', content: status === 'COMPLETED' ? '写完了' : null, sources: [] });
  });
  return messageId;
}

interface ListedSession {
  id: string;
  has_messages: boolean;
  run_state: 'RUNNING' | 'PENDING' | null;
  revision: string;
  updated_at: string;
}

const listPath = (workspaceId: string) => workspacePath(workspaceId, '/assist-sessions');

async function listed(workspaceId: string): Promise<readonly ListedSession[]> {
  const response = await api.get(listPath(workspaceId));
  assert.equal(response.status, 200);
  return (response.body as { items: ListedSession[] }).items;
}

async function single(workspaceId: string, sessionId: string): Promise<ListedSession> {
  const response = await api.get(workspacePath(workspaceId, `/assist-sessions/${sessionId}`));
  assert.equal(response.status, 200);
  return response.body as ListedSession;
}

test('没有消息与只有终态消息都读成 null：不另立「空闲」这一种取值', async () => {
  const workspaceId = await newWorkspace('idle');
  const empty = await newSession(workspaceId, '还没说过话的讨论');
  const settled = await newSession(workspaceId, '已经结算的讨论');
  await seedMessage(settled, 'USER', 'COMPLETED');
  await seedMessage(settled, 'ASSISTANT', 'COMPLETED');

  const items = await listed(workspaceId);
  const byId = new Map(items.map((item) => [item.id, item]));
  assert.equal(byId.get(empty)?.run_state, null);
  assert.equal(byId.get(settled)?.run_state, null);
  assert.equal((await single(workspaceId, empty)).run_state, null);
  assert.equal((await single(workspaceId, settled)).run_state, null);
  // 派生列不影响本来就有的那枚事实：「有没有消息」仍按消息表给出。
  assert.equal(byId.get(empty)?.has_messages, false);
  assert.equal(byId.get(settled)?.has_messages, true);
});

test('预插的 ASSISTANT 行读成 PENDING，Worker 认领后读成 RUNNING，结算后回到 null', async () => {
  const workspaceId = await newWorkspace('transitions');
  const sessionId = await newSession(workspaceId, '一轮完整生命周期');
  await seedMessage(sessionId, 'USER', 'COMPLETED');
  const assistant = await seedMessage(sessionId, 'ASSISTANT', 'PENDING');

  assert.equal((await single(workspaceId, sessionId)).run_state, 'PENDING');
  assert.equal((await listed(workspaceId)).find((item) => item.id === sessionId)?.run_state, 'PENDING');

  await sql`update assist_messages set status = 'RUNNING', worker_id = 'worker-run-state'
    where id = ${assistant}`.execute(app.db);
  assert.equal((await single(workspaceId, sessionId)).run_state, 'RUNNING');
  assert.equal((await listed(workspaceId)).find((item) => item.id === sessionId)?.run_state, 'RUNNING');

  // 结算成 COMPLETED：没有在途行，运行态消失。
  await sql`update assist_messages set status = 'COMPLETED', content = '做完了'
    where id = ${assistant}`.execute(app.db);
  assert.equal((await single(workspaceId, sessionId)).run_state, null);
  assert.equal((await listed(workspaceId)).find((item) => item.id === sessionId)?.run_state, null);
});

test('失败与取消同样是终态：都不能留在 RUNNING 上', async () => {
  const workspaceId = await newWorkspace('terminal');
  const failedSession = await newSession(workspaceId, '会失败的一轮');
  const cancelledSession = await newSession(workspaceId, '被取消的一轮');
  const failed = await seedMessage(failedSession, 'ASSISTANT', 'RUNNING');
  const cancelled = await seedMessage(cancelledSession, 'ASSISTANT', 'RUNNING');
  assert.equal((await single(workspaceId, failedSession)).run_state, 'RUNNING');
  assert.equal((await single(workspaceId, cancelledSession)).run_state, 'RUNNING');

  await sql`update assist_messages set status = 'FAILED', error_code = 'PROVIDER_ERROR'
    where id = ${failed}`.execute(app.db);
  await sql`update assist_messages set status = 'CANCELLED' where id = ${cancelled}`.execute(app.db);

  const items = await listed(workspaceId);
  assert.equal(items.find((item) => item.id === failedSession)?.run_state, null);
  assert.equal(items.find((item) => item.id === cancelledSession)?.run_state, null);
});

test('RUNNING 压过 PENDING：真在生成的那一轮决定这一行显示什么', async () => {
  const workspaceId = await newWorkspace('precedence');
  const sessionId = await newSession(workspaceId, '排队里还有一轮');
  const running = await seedMessage(sessionId, 'ASSISTANT', 'RUNNING');
  await seedMessage(sessionId, 'ASSISTANT', 'PENDING');

  assert.equal((await single(workspaceId, sessionId)).run_state, 'RUNNING');
  await sql`update assist_messages set status = 'COMPLETED', content = '先做完这一轮'
    where id = ${running}`.execute(app.db);
  // 前一轮结算之后，剩下的那条仍在排队：运行态退成 PENDING，而不是直接消失。
  assert.equal((await single(workspaceId, sessionId)).run_state, 'PENDING');
});

test('一次列表读取里逐行派生：在跑的那条是 RUNNING，别的一条是 null，互不串', async () => {
  const workspaceId = await newWorkspace('per-row');
  const running = await newSession(workspaceId, '这条在跑');
  const idle = await newSession(workspaceId, '这条没有在跑');
  await seedMessage(running, 'ASSISTANT', 'RUNNING');

  const items = await listed(workspaceId);
  assert.equal(items.length, 2, '同一工作区两条会话都要读回来');
  assert.equal(items.find((item) => item.id === running)?.run_state, 'RUNNING');
  assert.equal(items.find((item) => item.id === idle)?.run_state, null);
});

test('只读投影不写任何东西：不推进修订、updated_at 与活动排序键', async () => {
  const workspaceId = await newWorkspace('read-only');
  const sessionId = await newSession(workspaceId, '只读不写');
  await seedMessage(sessionId, 'ASSISTANT', 'RUNNING');
  const before = await createRepositories(app.db).assist.readSession(sessionId);
  assert.ok(before !== undefined);

  await listed(workspaceId);
  await single(workspaceId, sessionId);

  const after = await createRepositories(app.db).assist.readSession(sessionId);
  assert.ok(after !== undefined);
  assert.equal(after.revision, before.revision);
  assert.equal(after.updated_at.toISOString(), before.updated_at.toISOString());
  assert.equal(after.last_message_at?.toISOString(), before.last_message_at?.toISOString());
});
