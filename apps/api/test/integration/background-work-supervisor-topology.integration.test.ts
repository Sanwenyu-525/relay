import assert from 'node:assert/strict';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';

import { sql } from 'kysely';

import { APP_DATABASE_URL, MIGRATION_DATABASE_URL, MIGRATIONS_DIRECTORY, openDatabase }
  from './integration-support.js';
import { baseEnvironment, createDataRoot, createWorkspace, delay, expectCommandAccepted,
  startTestApi, workspacePath, type TestApi } from './api-harness.js';
import { bindAssistSessionDirectory, createAssistSession, requestAssistMessage } from
  '../../src/application/assist-commands.js';
import { runAssistGenerationTick } from '../../src/application/assist-runner.js';
import { createGatewayPolicy } from '../../src/application/gateway-configuration.js';
import { registerManagedResource } from '../../src/application/gateway-configuration.js';
import { createRepositories, withTransaction } from '../../src/application/unit-of-work.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { ManagedContentStore } from '../../src/storage/managed-content-store.js';
import { FakeModelPort, type AssistModelPort } from '../../src/workflow/fake-model-port.js';
import type { GatewayCapability } from '../../src/infrastructure/database-schema.js';
import type { JsonObject } from '../../src/infrastructure/json.js';

/**
 * ENG-SA-01：按**发布拓扑的真实进程组合**验证后台派发。
 *
 * 桌面宿主拉起的是「常驻 Supervisor + 按需一次性 Worker」，API 同样常驻。这里把这两类
 * 常驻进程都按真实子进程跑起来（Supervisor 走非桌面入口，省掉宿主握手帧，其余循环同源），
 * 断言两件事：
 *   1. 挂在 API 里的后台 tick 在这种拓扑下确实消费成员消息；
 *   2. Supervisor 自身的派发职责没有被新增 tick 挤掉——自动推进建出的 Run 仍被派发出去，
 *      而不是一直躺在 `run_command_outbox` 里。
 *
 * 仍然**不在测试里调用被测 tick**；唯一直接调用的生成 tick 是夹具（产出 READY 候选）。
 * 真实 Tauri 窗口、关窗与 Job 对象语义不在本文件范围内，那份证据只能在实机取。
 */

// 编译后本文件在 dist/test/integration：上溯两级已是 dist，入口不能再拼一次 'dist'。
const SUPERVISOR_ENTRY = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..',
  'src', 'worker', 'supervisor-main.js');
const app = openDatabase(APP_DATABASE_URL, 'relay-background-topology-test');
const roots: string[] = [];
let api: TestApi;
let seedRoot: string;
let supervisor: ChildProcessByStdio<null, Readable, Readable> | undefined;
let supervisorExit: Promise<number | null> = Promise.resolve(0);
let supervisorOutput = '';

async function untilTrue(read: () => Promise<boolean>, label: () => string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await read()) return;
    await delay(250);
  }
  assert.fail(`真实进程拓扑未在 30s 内推进：${label()}`);
}

/** 非桌面入口的常驻 Supervisor：与桌面同一个 main 循环，只是不等宿主握手帧。 */
async function startSupervisor(dataRoot: string): Promise<void> {
  const child = spawn(process.execPath, [SUPERVISOR_ENTRY], {
    env: baseEnvironment({ port: 0, allowedOrigin: 'http://127.0.0.1:0',
      bearerToken: 'supervisor-does-not-read-it', dataRoot }),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  supervisor = child;
  supervisorOutput = '';
  supervisorExit = new Promise<number | null>((done) => child.once('close', (code) => done(code)));
  child.stdout.on('data', (chunk: Buffer) => { supervisorOutput += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk: Buffer) => { supervisorOutput += chunk.toString('utf8'); });
  const outcome = await Promise.race([
    untilReady(child).then(() => 'ready' as const),
    supervisorExit.then((code) => `exited with code ${code}` as const),
    delay(30_000).then(() => 'timed out after 30s' as const),
  ]);
  assert.equal(outcome, 'ready', `Supervisor 子进程未就绪（${outcome}），输出：${supervisorOutput.slice(-2000)}`);
}

function untilReady(child: ChildProcessByStdio<null, Readable, Readable>): Promise<void> {
  return new Promise<void>((done) => {
    const onData = (): void => {
      if (supervisorOutput.includes('supervisor_ready')) {
        child.stdout.off('data', onData);
        child.stderr.off('data', onData);
        done();
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
  });
}

before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
  seedRoot = await createDataRoot();
  roots.push(seedRoot);
  api = await startTestApi({ dataRoot: seedRoot });
  await startSupervisor(seedRoot);
});

after(async () => {
  supervisor?.kill('SIGTERM');
  await supervisorExit;
  await api?.stop();
  for (const root of roots) await rm(root, { recursive: true, force: true });
  await app.close();
});

test('Supervisor 常驻时成员消息仍被消费，且 Supervisor 照常派发自动推进建出的 Run', async () => {
  const workspaceId = await createWorkspace(app.db);
  const command = async (segment: string, body: Record<string, unknown>, status: 200 | 201) => {
    const id = randomUUID();
    return expectCommandAccepted(await api.post(workspacePath(workspaceId, segment),
      { command_id: id, ...body }), status, id);
  };
  const projectId = String((await command('/projects', { title: '拓扑唤醒项目',
    project_type: 'GENERAL' }, 201)).project_id);
  const memberId = String((await command(`/projects/${projectId}/agent-members`, {
    name: '开发成员', role_key: 'DEVELOPMENT', run_mode: 'BUILTIN' }, 201)).agent_member_id);
  const conversationId = String((await command(`/projects/${projectId}/member-conversations`, {
    kind: 'DIRECT', member_id: memberId }, 200)).conversation_id);
  const sendId = randomUUID();
  const message = await command(`/member-conversations/${conversationId}/messages`,
    { content: '宿主全在跑，这条该被成员接住', intent: 'DISCUSS' }, 200);
  const messageId = String(message.message_id);

  await untilTrue(async () => {
    const row = await sql<{ processing_status: string }>`select processing_status from
      project_member_messages where id = ${messageId}`.execute(app.db);
    return row.rows[0]?.processing_status === 'PROCESSED';
  }, () => `消息 ${messageId} 在 Supervisor 常驻时未被消费`);
  assert.ok(supervisor !== undefined && !supervisor.killed, 'Supervisor 不应因后台 tick 而退出');

  // 同拓扑下的完整链：候选 READY →（API 的）自动推进建 Task/Run →（Supervisor 的）派发。
  const execWorkspaceId = await createWorkspace(app.db);
  const execProjectId = randomUUID();
  const directoryRoot = await mkdtemp(join(tmpdir(), 'relay-bg-topology-'));
  roots.push(directoryRoot);
  await mkdir(join(directoryRoot, 'src'), { recursive: true });
  await writeFile(join(directoryRoot, 'src', 'index.ts'), 'export const relay = true;\n', 'utf8');
  await withTransaction(app.db, async (repositories) => {
    await repositories.projects.insertProject({ id: execProjectId, workspaceId: execWorkspaceId,
      title: '拓扑派发项目', projectType: 'DEVELOPMENT' });
  });
  const { resourceId, canonicalRoot } = await registerManagedResource(app.db,
    { workspaceId: execWorkspaceId, projectId: execProjectId, rootPath: directoryRoot });
  const readId = randomUUID();
  const writeId = randomUUID();
  const capabilities: readonly GatewayCapability[] = ['FILE_QUERY', 'FILE_READ', 'FILE_WRITE'];
  await withTransaction(app.db, async (repositories) => {
    await repositories.workspaces.lockAuthority(execWorkspaceId, 'update');
    for (const connectionId of [readId, writeId]) {
      const connection = await repositories.gateway.insertConnection({ id: connectionId,
        workspaceId: execWorkspaceId, projectId: execProjectId, config: { root_path: canonicalRoot } });
      for (const capability of capabilities) {
        await repositories.gateway.addConnectionCapability(connection.id, capability);
      }
    }
    await repositories.workspaces.bumpAuthority(execWorkspaceId);
  });
  const policies: readonly [GatewayCapability, string][] = [
    ['FILE_QUERY', 'LIST_DIRECTORY'], ['FILE_QUERY', 'FIND_PATHS'], ['FILE_QUERY', 'SEARCH_TEXT'],
    ['FILE_READ', 'READ_FILE'], ['FILE_WRITE', 'APPLY_CHANGESET'], ['FILE_WRITE', 'WRITE_FILE'],
  ];
  for (const [capability, actionType] of policies) {
    await createGatewayPolicy(app.db, { workspaceId: execWorkspaceId, projectId: execProjectId,
      capability, actionType, targetPrefix: canonicalRoot, decision: 'AUTO', maxPayloadBytes: 262144 });
  }
  await sql`insert into local_directory_access
    (resource_id, write_tier, read_connection_id, write_connection_id)
    values (${resourceId}, 'AUTO', ${readId}, ${writeId})`.execute(app.db);
  const session = await createAssistSession(app.db, { workspaceId: execWorkspaceId,
    commandId: randomUUID(), title: '拓扑推进会话', projectId: execProjectId,
    conversationMode: 'AGENT' });
  const sessionId = session.result.session_id;
  await bindAssistSessionDirectory(app.db, { workspaceId: execWorkspaceId, sessionId,
    commandId: randomUUID(), resourceId });
  const candidate: JsonObject = { title: '修改受管文件', objective: '把 src/index.ts 改为 false',
    criteria: [{ statement: 'src/index.ts 导出 false', required: true, method: 'HUMAN' }],
    expected_outputs: { kind: 'MARKDOWN_DOCUMENT' },
    file_changes: [{ path: 'src/index.ts', action: 'MODIFY' }], writes_files: true };
  const port: AssistModelPort = { identity: new FakeModelPort().identity,
    assist: async () => ({ kind: 'CONTENT' as const,
      content: JSON.stringify({ reply: '按这个目标处理。', execution: candidate }),
      providerRequestId: 'bg-topology-candidate',
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: null,
        cacheCreationTokens: null } }) };
  const sent = await requestAssistMessage(app.db, { workspaceId: execWorkspaceId, sessionId,
    commandId: randomUUID(), content: '把 src/index.ts 改为 false' });
  await runAssistGenerationTick(app.db, { workerId: `seed-${randomUUID()}`,
    storage: new ManagedContentStore(seedRoot), modelPort: port, leaseMs: 60_000, maxMessages: 1 });
  const requests = await createRepositories(app.db).conversationExecutions
    .listSessionRequests(execWorkspaceId, sessionId);
  const request = requests.find((item) => item.source_message_id === sent.result.user_message_id);
  if (request === undefined) assert.fail('主流程必须落一行原执行请求');

  await untilTrue(async () => {
    const row = await sql<{ status: string; run_id: string | null }>`select status, run_id from
      conversation_execution_requests where id = ${request.id}`.execute(app.db);
    return row.rows[0]?.status === 'DELEGATED' && row.rows[0]?.run_id !== null;
  }, () => `执行请求 ${request.id} 未推进到 DELEGATED`);
  const runId = (await sql<{ run_id: string }>`select run_id from conversation_execution_requests
    where id = ${request.id}`.execute(app.db)).rows[0]!.run_id!;

  await untilTrue(async () => {
    const row = await sql<{ pending: string }>`select
      (select count(*) from run_command_outbox o join run_commands c on c.id = o.command_id
        where c.run_id = ${runId} and o.status = 'PENDING')::text as pending`.execute(app.db);
    return row.rows[0]?.pending === '0';
  }, () => `Run ${runId} 的命令仍停在 PENDING：Supervisor 的派发被后台 tick 挤掉了`);
});
