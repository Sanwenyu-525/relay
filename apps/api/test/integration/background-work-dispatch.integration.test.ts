import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

import { sql } from 'kysely';

import { APP_DATABASE_URL, MIGRATION_DATABASE_URL, MIGRATIONS_DIRECTORY, openDatabase }
  from './integration-support.js';
import { createDataRoot, createWorkspace, delay, expectCommandAccepted, startTestApi,
  workspacePath, type TestApi } from './api-harness.js';
import { bindAssistSessionDirectory, createAssistSession, requestAssistMessage } from
  '../../src/application/assist-commands.js';
import { runAssistGenerationTick } from '../../src/application/assist-runner.js';
import { createGatewayConnectionCommand } from '../../src/application/gateway-commands.js';
import { createGatewayPolicy, registerManagedResource } from
  '../../src/application/gateway-configuration.js';
import { changeAdmission, readAdmissionStatus } from '../../src/application/runtime-maintenance.js';
import { createRepositories, withTransaction } from '../../src/application/unit-of-work.js';
import { createWebImportJob } from '../../src/application/web-import-commands.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { ManagedContentStore } from '../../src/storage/managed-content-store.js';
import { FakeModelPort, type AssistModelPort } from '../../src/workflow/fake-model-port.js';
import type { GatewayCapability } from '../../src/infrastructure/database-schema.js';
import type { JsonObject } from '../../src/infrastructure/json.js';

/**
 * ENG-SA-01 P0：后台工作项在**实际发布的进程拓扑**里到底有没有执行者。
 *
 * 桌面宿主与 `dev-stack.ps1 -WithWorker` 拉起的都是常驻 Supervisor + 按需一次性
 * Worker；两个一次性入口分别只领 Run 命令（`--once`）和会话生成（`--assist-once`）。
 * 于是原本挂在持续 Worker 循环里的成员唤醒、会话执行自动推进、网页导入在发布拓扑
 * 里没有任何调用方——只能等有人手工 `npm run worker`，或等页面来喊一声。
 *
 * 本文件的纪律：**只启动真实 API 子进程，绝不在测试里调用被测的那个 tick**。
 * 断言的是「没有任何页面请求、没有 Worker、没有 Supervisor 派发一次性子进程的
 * 情况下，这一行后台事实自己往前走了」。修之前这三条全部超时失败，即缺陷反例本身。
 */

const app = openDatabase(APP_DATABASE_URL, 'relay-background-dispatch-test');
const roots: string[] = [];
let api: TestApi;
let seedRoot: string;
let server: Server;
let pagePort = 0;

before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
  seedRoot = await createDataRoot();
  server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!DOCTYPE html><html><body><h1>后台派发</h1>'
      + '<p>这段正文应当落进 Knowledge。</p></body></html>');
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  pagePort = (server.address() as AddressInfo).port;
  api = await startTestApi({ dataRoot: seedRoot });
});

after(async () => {
  await api?.stop();
  server?.close();
  for (const root of roots) await rm(root, { recursive: true, force: true });
  if (seedRoot !== undefined) await rm(seedRoot, { recursive: true, force: true });
  await app.close();
});

/** 有界等待：到点仍未结算就是失败，不用无限轮询掩盖缺口。 */
async function untilTrue(read: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await read()) return;
    await delay(250);
  }
  assert.fail(`后台派发未在 30s 内完成：${label}`);
}

// ---------------------------------------------------------------- 成员消息唤醒

interface MemberFixture { workspaceId: string; projectId: string; memberId: string;
  conversationId: string; name: string; duties: string; revision: string }

/**
 * `EXTERNAL` 成员的消息按设计停在 RECORDED 等待（外部成员自己领取），于是测试能在
 * 「宿主确实在扫、但没有合法领取者」的稳定状态下注入下一步要检查的持久事实，
 * 而不是靠抢在 1 秒扫描周期之前改数据。
 */
async function memberFixture(runMode: 'BUILTIN' | 'EXTERNAL' = 'BUILTIN'): Promise<MemberFixture> {
  const workspaceId = await createWorkspace(app.db);
  const command = async (segment: string, body: Record<string, unknown>, status: 200 | 201) => {
    const id = randomUUID();
    return expectCommandAccepted(await api.post(workspacePath(workspaceId, segment),
      { command_id: id, ...body }), status, id);
  };
  const projectId = String((await command('/projects', { title: '后台唤醒项目',
    project_type: 'GENERAL' }, 201)).project_id);
  const member = await command(`/projects/${projectId}/agent-members`, {
    name: '开发成员', role_key: 'DEVELOPMENT', run_mode: runMode }, 201);
  const memberId = String(member.agent_member_id);
  const conversationId = String((await command(`/projects/${projectId}/member-conversations`, {
    kind: 'DIRECT', member_id: memberId }, 200)).conversation_id);
  return { workspaceId, projectId, memberId, conversationId, name: String(member.name),
    duties: String(member.duties), revision: String(member.revision) };
}

async function sendMemberMessage(f: MemberFixture, content: string): Promise<string> {
  const id = randomUUID();
  const result = await api.post(workspacePath(f.workspaceId,
    `/member-conversations/${f.conversationId}/messages`), { command_id: id, content,
    intent: 'DISCUSS' });
  return String(expectCommandAccepted(result, 200, id).message_id);
}

async function messageStatus(id: string): Promise<string> {
  const row = await sql<{ processing_status: string }>`select processing_status from
    project_member_messages where id = ${id}`.execute(app.db);
  return row.rows[0]?.processing_status ?? 'MISSING';
}

test('成员消息只靠常驻宿主就被消费：定向私聊唤醒对应成员并回信一条', async () => {
  const f = await memberFixture();
  const messageId = await sendMemberMessage(f, '这个方向可以先做个原型吗');

  await untilTrue(async () => (await messageStatus(messageId)) === 'PROCESSED',
    `消息 ${messageId} 仍停在 ${await messageStatus(messageId)}`);

  const reply = await sql<{ count: string }>`select count(*)::text as count from
    project_member_messages where conversation_id = ${f.conversationId}
      and sender_kind = 'MEMBER'`.execute(app.db);
  assert.equal(reply.rows[0]?.count, '1', '宿主反复扫描也只能回信一条');
  const calls = await sql<{ count: string }>`select count(*)::text as count from model_calls
    where kind = 'MEMBER' and member_message_id = ${messageId}`.execute(app.db);
  assert.equal(calls.rows[0]?.count, '1', '成员唤醒必须逐次进模型账本');
});

test('两个宿主同时在跑也不重复执行：一条消息只有一位合法结算者', async () => {
  const f = await memberFixture();
  const second = await startTestApi({ dataRoot: seedRoot });
  try {
    const messageId = await sendMemberMessage(f, '并发宿主下请给个结论');
    await untilTrue(async () => (await messageStatus(messageId)) === 'PROCESSED',
      `并发消息 ${messageId} 未被消费`);
    // 让两个宿主都再多扫若干个周期，重复回信只会在这里露出来。
    await delay(4_000);
    const rows = await sql<{ count: string }>`select count(*)::text as count from
      project_member_messages where conversation_id = ${f.conversationId}`.execute(app.db);
    // 用户消息 1 条 + 成员回信恰好 1 条：第二个宿主扫到同一行时被领取 CAS 挡住。
    assert.equal(rows.rows[0]?.count, '2', JSON.stringify(rows.rows));
    const calls = await sql<{ count: string }>`select count(*)::text as count from model_calls
      where kind = 'MEMBER' and member_message_id = ${messageId}`.execute(app.db);
    assert.equal(calls.rows[0]?.count, '1', '并发不得对同一条消息发起第二次模型调用');
  } finally {
    await second.stop();
  }
});

// ---------------------------------------------------------------- 会话执行自动推进

interface ExecutionFixture { workspaceId: string; projectId: string; sessionId: string;
  canonicalRoot: string }

async function executionFixture(): Promise<ExecutionFixture> {
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const root = await mkdtemp(join(tmpdir(), 'relay-bg-dispatch-'));
  roots.push(root);
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'index.ts'), 'export const relay = true;\n', 'utf8');
  await withTransaction(app.db, async (repositories) => {
    await repositories.workspaces.insertWorkspace({ id: workspaceId, name: 'bg-dispatch' });
    await repositories.workspaces.insertAuthorityRow(workspaceId);
    await repositories.projects.insertProject({ id: projectId, workspaceId, title: 'bg-dispatch',
      projectType: 'DEVELOPMENT' });
  });
  const { resourceId, canonicalRoot } = await registerManagedResource(app.db,
    { workspaceId, projectId, rootPath: root });
  const readId = randomUUID();
  const writeId = randomUUID();
  const capabilities: readonly GatewayCapability[] = ['FILE_QUERY', 'FILE_READ', 'FILE_WRITE'];
  await withTransaction(app.db, async (repositories) => {
    await repositories.workspaces.lockAuthority(workspaceId, 'update');
    for (const connectionId of [readId, writeId]) {
      const connection = await repositories.gateway.insertConnection({ id: connectionId,
        workspaceId, projectId, config: { root_path: canonicalRoot } });
      for (const capability of capabilities) {
        await repositories.gateway.addConnectionCapability(connection.id, capability);
      }
    }
    await repositories.workspaces.bumpAuthority(workspaceId);
  });
  const policies: readonly [GatewayCapability, string][] = [
    ['FILE_QUERY', 'LIST_DIRECTORY'], ['FILE_QUERY', 'FIND_PATHS'], ['FILE_QUERY', 'SEARCH_TEXT'],
    ['FILE_READ', 'READ_FILE'], ['FILE_WRITE', 'APPLY_CHANGESET'], ['FILE_WRITE', 'WRITE_FILE'],
  ];
  for (const [capability, actionType] of policies) {
    await createGatewayPolicy(app.db, { workspaceId, projectId, capability, actionType,
      targetPrefix: canonicalRoot, decision: 'AUTO', maxPayloadBytes: 262144 });
  }
  // 会话直写档位：候选带 writes_files，缺这一行推进就会因「无写连接」失败（那是另一条用例的成因）。
  await sql`insert into local_directory_access
    (resource_id, write_tier, read_connection_id, write_connection_id)
    values (${resourceId}, 'AUTO', ${readId}, ${writeId})`.execute(app.db);
  const session = await createAssistSession(app.db, { workspaceId, commandId: randomUUID(),
    title: '后台推进会话', projectId, conversationMode: 'AGENT' });
  const sessionId = session.result.session_id;
  await bindAssistSessionDirectory(app.db, { workspaceId, sessionId,
    commandId: randomUUID(), resourceId });
  return { workspaceId, projectId, sessionId, canonicalRoot };
}

/** 产出 READY 候选，但**不**调用自动推进 tick：推进责任必须已经归常驻宿主。 */
async function readyCandidate(f: ExecutionFixture): Promise<string> {
  const storage = new ManagedContentStore(seedRoot);
  const candidate: JsonObject = { title: '修改受管文件', objective: '把 src/index.ts 改为 false',
    criteria: [{ statement: 'src/index.ts 导出 false', required: true, method: 'HUMAN' }],
    expected_outputs: { kind: 'MARKDOWN_DOCUMENT' },
    file_changes: [{ path: 'src/index.ts', action: 'MODIFY' }], writes_files: true };
  const port: AssistModelPort = { identity: new FakeModelPort().identity,
    assist: async () => ({ kind: 'CONTENT' as const,
      content: JSON.stringify({ reply: '按这个目标处理。', execution: candidate }),
      providerRequestId: 'bg-dispatch-candidate',
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: null,
        cacheCreationTokens: null } }) };
  const sent = await requestAssistMessage(app.db, { workspaceId: f.workspaceId,
    sessionId: f.sessionId, commandId: randomUUID(), content: '把 src/index.ts 改为 false' });
  const outcome = await runAssistGenerationTick(app.db, { workerId: `seed-${randomUUID()}`,
    storage, modelPort: port, leaseMs: 60_000, maxMessages: 1 });
  assert.ok(outcome !== undefined, '夹具的生成 tick 应当领取这条消息');
  const requests = await createRepositories(app.db).conversationExecutions
    .listSessionRequests(f.workspaceId, f.sessionId);
  const row = requests.find((item) => item.source_message_id === sent.result.user_message_id);
  assert.ok(row !== undefined, '主流程必须落一行原执行请求');
  assert.equal(row.status, 'READY');
  return row.id;
}

test('已授权的会话执行候选不需要页面来喊：常驻宿主把它推进到 Task/Run', async () => {
  const f = await executionFixture();
  const requestId = await readyCandidate(f);

  await untilTrue(async () => {
    const row = await sql<{ status: string; run_id: string | null }>`select status, run_id from
      conversation_execution_requests where id = ${requestId}`.execute(app.db);
    return row.rows[0]?.status === 'DELEGATED' && row.rows[0]?.run_id !== null;
  }, `执行请求 ${requestId} 仍停在 ${
    (await sql<{ status: string }>`select status from conversation_execution_requests
      where id = ${requestId}`.execute(app.db)).rows[0]?.status}`);

  const counts = await sql<{ tasks: string; runs: string }>`select
    (select count(*)::text from tasks where project_id = ${f.projectId}) as tasks,
    (select count(*)::text from runs r join tasks t on t.id = r.task_id
      where t.project_id = ${f.projectId}) as runs`.execute(app.db);
  assert.deepEqual(counts.rows[0], { tasks: '1', runs: '1' }, '重复扫描不得产生第二个 Task/Run');
});

// ---------------------------------------------------------------- 网页导入

test('网页导入 job 不靠 Worker 也能从 QUEUED 走到 Knowledge 落库', async () => {
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  await withTransaction(app.db, async (r) => {
    await r.workspaces.insertWorkspace({ id: workspaceId, name: `bg-import-${workspaceId}` });
    await r.workspaces.insertAuthorityRow(workspaceId);
    await r.projects.insertProject({ id: projectId, workspaceId, title: '后台导入',
      projectType: 'GENERAL' });
  });
  // 受控本机服务必须显式登记 allow_private，与 web-fetch 套件同一纪律。
  const connection = await createGatewayConnectionCommand(app.db, { workspaceId, projectId,
    commandId: randomUUID(), capabilities: ['WEB_FETCH'], allowedHost: '127.0.0.1',
    allowPrivate: true });
  await createGatewayPolicy(app.db, { workspaceId, projectId, capability: 'WEB_FETCH',
    actionType: 'WEB_FETCH', targetPrefix: '127.0.0.1', decision: 'AUTO', maxPayloadBytes: 4096 });
  const job = await createWebImportJob(app.db, { workspaceId, projectId,
    commandId: randomUUID(), url: `http://127.0.0.1:${pagePort}/ok`,
    connectionId: connection.result.connection_id! });
  const jobId = job.result.import_job_id;

  await untilTrue(async () => {
    const row = await sql<{ status: string; knowledge_version_id: string | null }>`
      select status, knowledge_version_id from import_jobs where id = ${jobId}`.execute(app.db);
    return row.rows[0]?.status === 'SUCCEEDED' && row.rows[0]?.knowledge_version_id !== null;
  }, `导入 job ${jobId} 未被驱动`);

  const version = await sql<{ knowledge_version_id: string }>`select knowledge_version_id from
    import_jobs where id = ${jobId}`.execute(app.db);
  const versions = await sql<{ count: string }>`select count(*)::text as count from
    knowledge_versions where id = ${version.rows[0]!.knowledge_version_id}`.execute(app.db);
  assert.equal(versions.rows[0]?.count, '1', '导入落库必须恰好一个版本');
});

// ------------------------------------------------------ 崩溃接续与维护准入

/** 成员改回内置运行方式走真实命令入口；revision 由夹具创建时带回。 */
async function makeMemberBuiltIn(f: MemberFixture): Promise<void> {
  const id = randomUUID();
  expectCommandAccepted(await api.post(workspacePath(f.workspaceId,
    `/agent-members/${f.memberId}/edits`), { command_id: id, expected_revision: f.revision,
    reason: '接回本机内置执行', name: f.name, duties: f.duties, run_mode: 'BUILTIN' }), 200, id);
}

test('上一个宿主崩在唤醒中途：租约清扫按原协议接续，不永久卡在 CLAIMED', async () => {
  const f = await memberFixture('EXTERNAL');
  const messageId = await sendMemberMessage(f, '上一个进程在领取之后崩掉了');
  // 领取与结算之间进程退出留下的持久事实：身份已死、租约已过期、这条已经试过 1 次
  // （上限 2 之内才应当接续，超上限按 WAKEUP_ATTEMPTS_EXHAUSTED 收口——两者都由本 tick 收敛）。
  await sql`update project_member_messages set processing_status = 'CLAIMED',
      claimed_by = 'api:99999', claimed_at = now() - interval '5 minutes',
      lease_expires_at = now() - interval '3 minutes', attempts = 1
    where id = ${messageId}`.execute(app.db);
  await makeMemberBuiltIn(f);

  await untilTrue(async () => (await messageStatus(messageId)) === 'PROCESSED',
    `过期领取未被清扫接续：消息 ${messageId} 停在 ${await messageStatus(messageId)}`);
  const reply = await sql<{ count: string }>`select count(*)::text as count from
    project_member_messages where conversation_id = ${f.conversationId}
      and sender_kind = 'MEMBER'`.execute(app.db);
  assert.equal(reply.rows[0]?.count, '1', '崩溃接续后仍然只能回信一条');
});

test('维护排空期间不准入新的后台执行，恢复准入后同一条接着走完', async () => {
  const f = await memberFixture('EXTERNAL');
  const messageId = await sendMemberMessage(f, '排空期间不要开始这一条');
  const drained = await changeAdmission(app.db, { commandId: randomUUID(), action: 'begin-drain',
    expectedRevision: (await readAdmissionStatus(app.db)).revision });
  assert.equal(drained.result.mode, 'DRAINING');
  try {
    // 排空期连成员编辑命令本身也被拒（那正是准入门该有的行为），所以这里直接改持久事实：
    // 被测对象是后台 tick 的准入门，成员编辑命令由它自己的套件覆盖。
    await sql`update project_agent_members set run_mode = 'BUILTIN' where id = ${f.memberId}`
      .execute(app.db);
    await delay(4_000);
    assert.equal(await messageStatus(messageId), 'RECORDED',
      '维护排空期间不得开始新的成员唤醒');
  } finally {
    await changeAdmission(app.db, { commandId: randomUUID(), action: 'resume-admission',
      expectedRevision: (await readAdmissionStatus(app.db)).revision });
  }
  await untilTrue(async () => (await messageStatus(messageId)) === 'PROCESSED',
    `恢复准入后消息 ${messageId} 未接续消费`);
});
