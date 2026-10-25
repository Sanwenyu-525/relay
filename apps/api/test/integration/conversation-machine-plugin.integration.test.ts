import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import { sql } from 'kysely';

import { applyConversationExecution, recordConversationExecutionCandidate,
  type ConversationTaskCandidate } from '../../src/application/conversation-execution.js';
import { createAssistSession, requestAssistMessage } from '../../src/application/assist-commands.js';
import { runAssistGenerationTick } from '../../src/application/assist-runner.js';
import { createFakeConnection, registerManagedResource }
  from '../../src/application/gateway-configuration.js';
import { createRepositories, withTransaction } from '../../src/application/unit-of-work.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { ManagedContentStore } from '../../src/storage/managed-content-store.js';
import { FakeModelPort, type AssistModelPort } from '../../src/workflow/fake-model-port.js';
import type { JsonObject } from '../../src/infrastructure/json.js';
import { createDataRoot } from './api-harness.js';
import { APP_DATABASE_URL, MIGRATION_DATABASE_URL, MIGRATIONS_DIRECTORY, openDatabase }
  from './integration-support.js';

/**
 * 未归属会话的机器插件执行（2026-10-25）。
 *
 * 用户截图复现：工作区级会话（无项目、无目录）里 @电脑操控「打开浏览器」，模型只能
 * 回答「这条会话还没有归入任何项目，因此没有可用的电脑操控连接」。插件是安装级
 * 资源、按项目登记连接；本组用例锁住借用的完整链路：
 *
 *   * 主流程路由：工作区有可借用的（连接 + 归属项目 ACTIVE 资源齐备）机器插件时，
 *     零工具的未归属会话也走主流程，模型按执行候选协议给出 interaction；
 *   * 归属借用：请求行落在插件连接归属项目与其受管资源上；
 *   * 词表收敛：借用执行的冻结工具循环只含机器族工具——借来的受管根不是用户的
 *     工作范围，不给文件、Git 与检查工具；
 *   * 负例：文件类候选不借用；工作区没有可借用连接时回到纯文本路径，回复照常
 *     结算，不留注定失败的请求行。
 */

const app = openDatabase(APP_DATABASE_URL, 'relay-api-test-conv-machine-plugin');
let dataRoot: string;
const roots: string[] = [];

before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
  dataRoot = await createDataRoot();
});
after(async () => {
  await app.close();
  await rm(dataRoot, { recursive: true, force: true });
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

interface Fixture {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly resourceId: string;
  readonly root: string;
  readonly sessionId: string;
}

async function fixture(options?: {
  readonly withMachineConnection?: boolean;
  readonly withResource?: boolean;
}): Promise<Fixture> {
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const withResource = options?.withResource !== false;
  const root = await mkdtemp(join(tmpdir(), 'relay-conv-machine-'));
  roots.push(root);
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'index.ts'), 'export const relay = true;\n', 'utf8');

  await withTransaction(app.db, async (repositories) => {
    await repositories.workspaces.insertWorkspace({ id: workspaceId, name: 'conv-machine-plugin' });
    await repositories.workspaces.insertAuthorityRow(workspaceId);
    await repositories.projects.insertProject({ id: projectId, workspaceId,
      title: 'conv-machine-plugin', projectType: 'DEVELOPMENT' });
  });
  let resourceId = '';
  if (withResource) {
    const registered = await registerManagedResource(app.db,
      { workspaceId, projectId, rootPath: root });
    resourceId = registered.resourceId;
  }
  if (options?.withMachineConnection) {
    await createFakeConnection(app.db, { workspaceId, projectId,
      capabilities: ['COMPUTER_READ', 'COMPUTER_INPUT'] });
    await createFakeConnection(app.db, { workspaceId, projectId,
      capabilities: ['BROWSER_READ', 'BROWSER_ACTION'] });
  }
  // 未归属会话：不传 projectId（工作区也没有配置默认目录，不会继承）。
  const session = await createAssistSession(app.db, { workspaceId, commandId: randomUUID(),
    title: '工作区讨论', conversationMode: 'AGENT' });
  const sessionRow = await createRepositories(app.db).assist.readSession(session.result.session_id);
  assert.equal(sessionRow?.project_id, null, '夹具会话必须真的没有项目归属');
  assert.equal(sessionRow?.working_resource_id, null, '夹具会话必须真的没有绑定目录');
  return { workspaceId, projectId, resourceId, root, sessionId: session.result.session_id };
}

function oneShotPort(content: string): AssistModelPort {
  const base = new FakeModelPort();
  return {
    identity: base.identity,
    assist: async () => ({ kind: 'CONTENT' as const, content, providerRequestId: 'machine-one-shot',
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: null,
        cacheCreationTokens: null } }),
  };
}

function computerCandidate(): JsonObject {
  return { title: '打开浏览器', objective: '通过电脑操控打开系统默认浏览器',
    criteria: [{ statement: '浏览器进程已打开', required: true, method: 'HUMAN' }],
    expected_outputs: { kind: 'MARKDOWN_DOCUMENT' },
    writes_files: false, file_changes: [], check: null, interaction: 'COMPUTER' };
}

/** 防线用例直接以类型化候选调用原入口（不经模型判定）。 */
function typedComputerCandidate(): ConversationTaskCandidate {
  return { title: '打开浏览器', objective: '通过电脑操控打开系统默认浏览器',
    criteria: [{ statement: '浏览器进程已打开', required: true, method: 'HUMAN' }],
    expected_outputs: { kind: 'MARKDOWN_DOCUMENT' },
    file_changes: [], writes_files: false, interaction: 'COMPUTER' };
}

async function ask(fx: Pick<Fixture, 'workspaceId' | 'sessionId'>, content: string,
  port: AssistModelPort) {
  const storage = new ManagedContentStore(dataRoot);
  const sent = await requestAssistMessage(app.db, { workspaceId: fx.workspaceId,
    sessionId: fx.sessionId, commandId: randomUUID(), content });
  const outcome = await runAssistGenerationTick(app.db, { workerId: `machine-${randomUUID()}`,
    storage, modelPort: port, leaseMs: 60_000, maxMessages: 1 });
  assert.ok(outcome !== undefined, '本次生成 tick 应当领取这条消息');
  const message = await createRepositories(app.db).assist.readMessage(
    sent.result.assistant_message_id);
  const requests = (await createRepositories(app.db).conversationExecutions
    .listSessionRequests(fx.workspaceId, fx.sessionId))
    .filter((item) => item.source_message_id === sent.result.user_message_id);
  return { sent, outcome, message, requests };
}

async function frozenToolLoop(runId: string): Promise<{ connections: JsonObject;
  allowedTools: string[] }> {
  const result = await sql<{ frozen_snapshot: JsonObject }>`
    select frozen_snapshot from execution_contracts where run_id = ${runId}
  `.execute(app.db);
  const loop = result.rows[0]?.frozen_snapshot.tool_loop_action as JsonObject | undefined;
  assert.ok(loop, 'Run 必须冻结工具循环信封');
  return { connections: loop.connections as JsonObject,
    allowedTools: loop.allowed_tools as string[] };
}

// --------------------------------------------------------------- 正例：借用链路

test('未归属会话的纯电脑操作候选借用插件连接归属项目进入执行', async () => {
  const fx = await fixture({ withMachineConnection: true });
  const result = await ask(fx, '@电脑操控 打开浏览器', oneShotPort(JSON.stringify({
    reply: '我会把「打开浏览器」作为电脑操控执行交给后台。', maintenance: null,
    execution: computerCandidate(),
  })));
  assert.equal(result.message?.status, 'COMPLETED');

  assert.equal(result.requests.length, 1, '主流程判定必须落成执行请求行');
  const request = result.requests[0]!;
  assert.equal(request.decision, 'PREPARE');
  assert.equal(request.candidate_status, 'READY');
  // 归属借用：请求行落在插件连接归属项目与其受管资源上，root_path 同源。
  assert.equal(request.project_id, fx.projectId);
  assert.equal(request.resource_id, fx.resourceId);

  const applied = await applyConversationExecution(app.db,
    { workspaceId: fx.workspaceId, requestId: request.id });
  assert.equal(applied.status, 'DELEGATED');
  assert.ok(applied.run_id, '委托必须给出确切 Run');
  const task = await createRepositories(app.db).tasks.readTask(applied.task_id!);
  assert.equal(task?.project_id, fx.projectId, 'Task 记在插件连接归属项目名下');

  const loop = await frozenToolLoop(applied.run_id!);
  assert.equal(loop.connections.COMPUTER_READ !== undefined, true, '信封必须带 COMPUTER_READ 连接');
  assert.equal(loop.connections.COMPUTER_INPUT !== undefined, true, '信封必须带 COMPUTER_INPUT 连接');
  assert.equal(loop.connections.FILE_QUERY, undefined, '借用执行不携带文件能力');
  assert.equal(loop.connections.FILE_READ, undefined, '借用执行不携带文件能力');
  assert.ok(loop.allowedTools.includes('computer_screenshot'));
  assert.ok(loop.allowedTools.includes('computer_click'));
  assert.equal(loop.allowedTools.includes('read_file'), false, '借来的受管根不给文件工具');
  assert.equal(loop.allowedTools.includes('list_directory'), false, '借来的受管根不给文件工具');
  assert.equal(loop.allowedTools.includes('git_status'), false, '借用执行不给 Git 工具');
});

test('未归属会话的纯浏览器操作候选走同一借用链路', async () => {
  const fx = await fixture({ withMachineConnection: true });
  const result = await ask(fx, '@浏览器操控 打开 example.com', oneShotPort(JSON.stringify({
    reply: '我会把打开网页交给后台浏览器执行。', maintenance: null,
    execution: { ...computerCandidate(), title: '打开 example.com',
      objective: '用浏览器打开 example.com', interaction: 'BROWSER' },
  })));
  assert.equal(result.message?.status, 'COMPLETED');
  assert.equal(result.requests.length, 1);
  const applied = await applyConversationExecution(app.db,
    { workspaceId: fx.workspaceId, requestId: result.requests[0]!.id });
  assert.equal(applied.status, 'DELEGATED');
  const loop = await frozenToolLoop(applied.run_id!);
  assert.equal(loop.connections.BROWSER_READ !== undefined, true);
  assert.equal(loop.connections.BROWSER_ACTION !== undefined, true);
  assert.equal(loop.allowedTools.includes('browser_navigate'), true);
  assert.equal(loop.allowedTools.includes('read_file'), false);
});

// --------------------------------------------------------------- 负例：不借用的情形

test('未归属会话的文件修改候选不借用机器通道', async () => {
  const fx = await fixture({ withMachineConnection: true });
  const result = await ask(fx, '帮我改一下 index.ts', oneShotPort(JSON.stringify({
    reply: '修改文件需要先把这段会话归入项目并绑定目录。', maintenance: null,
    execution: { title: '修改 index.ts', objective: '把 src/index.ts 改为 false',
      criteria: [{ statement: 'src/index.ts 导出 false', required: true, method: 'HUMAN' }],
      expected_outputs: { kind: 'MARKDOWN_DOCUMENT' },
      file_changes: [{ path: 'src/index.ts', action: 'MODIFY' }], writes_files: true,
      check: null },
  })));
  assert.equal(result.message?.status, 'COMPLETED');
  assert.deepEqual(result.requests, [], '文件类候选不得借用机器插件通道落成请求行');
});

test('工作区没有机器连接时回到纯文本路径，回复照常结算不留请求行', async () => {
  const fx = await fixture({ withMachineConnection: false });
  const result = await ask(fx, '@电脑操控 打开浏览器', oneShotPort(
    '工作区还没有登记电脑操控连接，请先在连接与权限页登记。'));
  assert.equal(result.message?.status, 'COMPLETED');
  assert.deepEqual(result.requests, [], '没有可借用连接时不得落执行请求行');
});

test('机器连接的归属项目没有 ACTIVE 受管资源时同样不可借用', async () => {
  const fx = await fixture({ withMachineConnection: true, withResource: false });
  const result = await ask(fx, '@电脑操控 打开浏览器', oneShotPort(
    '电脑操控连接还没有可归属的受管目录，暂时无法执行。'));
  assert.equal(result.message?.status, 'COMPLETED');
  assert.deepEqual(result.requests, [], '归属解析失败（连接在、资源缺）不得落执行请求行');
});

// --------------------------------------------------------------- 防线：原入口的 typed 拒绝

test('未归属会话不带机器能力直入执行仍按原规则拒绝', async () => {
  const fx = await fixture({ withMachineConnection: true });
  const sent = await requestAssistMessage(app.db, { workspaceId: fx.workspaceId,
    sessionId: fx.sessionId, commandId: randomUUID(), content: '打开浏览器' });
  const tick = await runAssistGenerationTick(app.db, { workerId: `machine-${randomUUID()}`,
    storage: new ManagedContentStore(dataRoot),
    modelPort: oneShotPort('{"reply":"好的","execution":null,"maintenance":null}'),
    leaseMs: 60_000, maxMessages: 1 });
  assert.ok(tick !== undefined);
  await assert.rejects(() => recordConversationExecutionCandidate(app.db,
    { workspaceId: fx.workspaceId, sessionId: fx.sessionId,
      sourceMessageId: sent.result.user_message_id, resourceId: null,
      commandId: randomUUID(),
      outcome: { kind: 'PREPARE', reply: 'ok', candidate: typedComputerCandidate() } }),
    /从对话直接进入执行要求会话绑定明确的 Project/u);
});

test('工作区没有机器连接时按类型化原因拒绝而不是伪造归属', async () => {
  const fx = await fixture({ withMachineConnection: false });
  const sent = await requestAssistMessage(app.db, { workspaceId: fx.workspaceId,
    sessionId: fx.sessionId, commandId: randomUUID(), content: '打开浏览器' });
  const tick = await runAssistGenerationTick(app.db, { workerId: `machine-${randomUUID()}`,
    storage: new ManagedContentStore(dataRoot),
    modelPort: oneShotPort('{"reply":"好的","execution":null,"maintenance":null}'),
    leaseMs: 60_000, maxMessages: 1 });
  assert.ok(tick !== undefined);
  await assert.rejects(() => recordConversationExecutionCandidate(app.db,
    { workspaceId: fx.workspaceId, sessionId: fx.sessionId,
      sourceMessageId: sent.result.user_message_id, resourceId: null,
      commandId: randomUUID(), machineCapability: 'COMPUTER_INPUT',
      outcome: { kind: 'PREPARE', reply: 'ok', candidate: typedComputerCandidate() } }),
    /工作区还没有登记可用的电脑操控连接/u);
});
