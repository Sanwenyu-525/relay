import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { sql } from 'kysely';

import { createRepositories } from '../../src/application/unit-of-work.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { createDataRoot, createWorkspace, startTestApi, workspacePath, type TestApi } from './api-harness.js';
import { APP_DATABASE_URL, MIGRATIONS_DIRECTORY, MIGRATION_DATABASE_URL, openDatabase } from './integration-support.js';

/**
 * 内置工作方法与聊天 `/命令` 的真实 API/PG 出口（测试计划 §26 BC-01/BC-03/BC-04）。
 *
 * 断言三件事：
 *   1. `/命令` 解析是纯查询：菜单、方法、未知命令与自然语言意图都返回，且**零业务副作用**；
 *   2. 发送 `/review …` 时，assistant 消息在发起那一刻冻结方法身份与本次行动，并可读回；
 *   3. 系统命令与未知命令不能被当成普通消息发送，只读助手不因方法获得修改能力。
 */

const app = openDatabase(APP_DATABASE_URL, 'relay-api-test-chat-commands');
let api: TestApi;

before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
  await createDataRoot();
  api = await startTestApi();
});
after(async () => {
  await api.stop();
  await app.close();
});

async function receipts(workspaceId: string): Promise<number> {
  const row = (await sql<{ count: string }>`select count(*)::text as count from command_receipts
    where scope_key like ${`workspace:${workspaceId}:%`}`.execute(app.db)).rows[0];
  return Number(row?.count ?? '0');
}

async function messageCount(workspaceId: string): Promise<number> {
  const row = (await sql<{ count: string }>`select count(*)::text as count from assist_messages m
    join assist_sessions s on s.id = m.session_id
    where s.workspace_id = ${workspaceId}`.execute(app.db)).rows[0];
  return Number(row?.count ?? '0');
}

test('命令解析是纯查询：菜单/方法/未知/自然语言意图都返回且零业务副作用', async () => {
  const workspaceId = await createWorkspace(app.db);
  const before = { receipts: await receipts(workspaceId), messages: await messageCount(workspaceId) };

  const menu = await api.post(workspacePath(workspaceId, '/chat-commands/resolve'), { text: '/' });
  assert.equal(menu.status, 200);
  const menuBody = menu.body as { kind: string; menu: { name: string; aliases: string[] }[] };
  assert.equal(menuBody.kind, 'MENU');
  const names = menuBody.menu.map((entry) => entry.name);
  assert.deepEqual(names.slice(0, 3), ['review', 'diagnose', 'docs']);
  assert.ok(names.includes('clear'));
  assert.ok(menuBody.menu.some((entry) => entry.aliases.includes('代码审查')));

  const method = await api.post(workspacePath(workspaceId, '/chat-commands/resolve'),
    { text: '/review 帮我看看并发写入' });
  assert.equal(method.status, 200);
  const methodBody = method.body as { kind: string; method: { id: string };
    argument: string | null; action: string; scope: string };
  assert.equal(methodBody.kind, 'METHOD');
  assert.equal(methodBody.method.id, 'code-review');
  assert.equal(methodBody.argument, '帮我看看并发写入');
  assert.equal(methodBody.action, 'INSPECT');
  assert.equal(methodBody.scope, 'CURRENT_CHANGES');

  // 中文别名解析到同一登记项。
  const chinese = await api.post(workspacePath(workspaceId, '/chat-commands/resolve'),
    { text: '/诊断 启动失败' });
  assert.equal((chinese.body as { method: { id: string } }).method.id, 'fault-diagnosis');

  const unknown = await api.post(workspacePath(workspaceId, '/chat-commands/resolve'),
    { text: '/nope 做点什么' });
  assert.equal((unknown.body as { kind: string }).kind, 'UNKNOWN_COMMAND');
  const badArg = await api.post(workspacePath(workspaceId, '/chat-commands/resolve'), { text: '/model' });
  assert.equal((badArg.body as { kind: string }).kind, 'INVALID_ARGUMENT');
  // 路径不是命令。
  const path = await api.post(workspacePath(workspaceId, '/chat-commands/resolve'),
    { text: '/usr/bin/env node' });
  assert.equal((path.body as { kind: string }).kind, 'NOT_COMMAND');

  // 普通自然语言：识别方法并区分"只是讨论"。
  const prose = await api.post(workspacePath(workspaceId, '/chat-commands/resolve'),
    { text: '讨论诊断方法' });
  const proseBody = prose.body as { kind: string;
    detected_method: { id: string; discussion: boolean; action: string } };
  assert.equal(proseBody.kind, 'NOT_COMMAND');
  assert.equal(proseBody.detected_method.id, 'fault-diagnosis');
  assert.equal(proseBody.detected_method.discussion, true);
  assert.equal(proseBody.detected_method.action, 'INSPECT');

  const wide = await api.post(workspacePath(workspaceId, '/chat-commands/resolve'),
    { text: '全项目审查一遍' });
  assert.equal((wide.body as { detected_method: { scope: string } }).detected_method.scope, 'PROJECT');

  // 纯解析：没有任何业务写入，也没有命令回执。
  assert.equal(await receipts(workspaceId), before.receipts);
  assert.equal(await messageCount(workspaceId), before.messages);
});

test('发送 /命令 时方法身份在发起那一刻冻结并可读回', async () => {
  const workspaceId = await createWorkspace(app.db);
  const session = await api.post(workspacePath(workspaceId, '/assist-sessions'),
    { command_id: randomUUID(), title: '命令方法会话' });
  assert.equal(session.status, 201);
  const sessionId = (session.body as { result: { session_id: string } }).result.session_id;

  const sent = await api.post(workspacePath(workspaceId, `/assist-sessions/${sessionId}/messages`),
    { command_id: randomUUID(), content: '/review 帮我看看并发写入' });
  assert.equal(sent.status, 202, sent.text);
  const assistantMessageId = (sent.body as { result: { assistant_message_id: string } })
    .result.assistant_message_id;

  const stored = await createRepositories(app.db).assist.readMessage(assistantMessageId);
  assert.ok(stored !== undefined);
  assert.equal(stored.method_action, 'INSPECT');
  assert.equal(stored.method_argument, '帮我看看并发写入');
  assert.ok(stored.method_snapshot !== null);
  assert.equal(stored.skill_snapshot, null);
  assert.equal((stored.method_snapshot as { id: string }).id, 'code-review');

  const listed = await api.get(workspacePath(workspaceId, `/assist-sessions/${sessionId}/messages`));
  assert.equal(listed.status, 200);
  const item = (listed.body as { items: { id: string; method: { id: string; version: string;
    sha256: string; action: string; definition_availability: string } | null;
    method_argument: string | null }[] }).items.find((row) => row.id === assistantMessageId)!;
  assert.equal(item.method?.id, 'code-review');
  assert.equal(item.method?.version, '1.0.0');
  assert.match(item.method?.sha256 ?? '', /^[0-9a-f]{64}$/u);
  assert.equal(item.method?.action, 'INSPECT');
  assert.equal(item.method?.definition_availability, 'AVAILABLE');
  assert.equal(item.method_argument, '帮我看看并发写入');
});

test('系统命令与未知命令不能被当成普通消息发送', async () => {
  const workspaceId = await createWorkspace(app.db);
  const session = await api.post(workspacePath(workspaceId, '/assist-sessions'),
    { command_id: randomUUID(), title: '命令拒绝会话' });
  const sessionId = (session.body as { result: { session_id: string } }).result.session_id;
  const before = await messageCount(workspaceId);

  const system = await api.post(workspacePath(workspaceId, `/assist-sessions/${sessionId}/messages`),
    { command_id: randomUUID(), content: '/clear' });
  assert.equal(system.status, 422, system.text);
  assert.equal((system.body as { code: string }).code, 'VALIDATION_FAILED');

  const unknown = await api.post(workspacePath(workspaceId, `/assist-sessions/${sessionId}/messages`),
    { command_id: randomUUID(), content: '/nope 随便做点什么' });
  assert.equal(unknown.status, 422, unknown.text);

  // 被拒的消息没有落库：不存在半条用户消息或待生成回复。
  assert.equal(await messageCount(workspaceId), before);
});

test('只读助手会话不因内置方法获得修改能力', async () => {
  const workspaceId = await createWorkspace(app.db);
  const profile = await api.post(workspacePath(workspaceId, '/assistant-profiles'),
    { command_id: randomUUID(), name: '只读助手', role_description: '只读回答' });
  assert.equal(profile.status, 201, profile.text);
  const profileId = (profile.body as { result: { assistant_profile_id: string } })
    .result.assistant_profile_id;
  const session = await api.post(workspacePath(workspaceId, '/assist-sessions'),
    { command_id: randomUUID(), title: '只读助手会话', conversation_mode: 'ASSISTANT',
      assistant_profile_id: profileId });
  assert.equal(session.status, 201, session.text);
  const sessionId = (session.body as { result: { session_id: string } }).result.session_id;

  // 明确要求修改的方法被拒：只读助手不因方法升权。
  const modify = await api.post(workspacePath(workspaceId, `/assist-sessions/${sessionId}/messages`),
    { command_id: randomUUID(), content: '帮我修好启动失败',
      method_ref: { id: 'fault-diagnosis', version: '1.0.0', action: 'MODIFY' } });
  assert.equal(modify.status, 409, modify.text);
  assert.equal((modify.body as { code: string }).code, 'INVALID_TRANSITION');

  // 只读方法可以运行。
  const inspect = await api.post(workspacePath(workspaceId, `/assist-sessions/${sessionId}/messages`),
    { command_id: randomUUID(), content: '/review 帮我看看' });
  assert.equal(inspect.status, 202, inspect.text);
});
