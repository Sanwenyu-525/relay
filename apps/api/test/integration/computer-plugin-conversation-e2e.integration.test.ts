import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { after, before } from 'node:test';
import { sql } from 'kysely';

import {
  applyConversationExecution,
} from '../../src/application/conversation-execution.js';
import { runConversationExecutionAutoStartTick }
  from '../../src/application/conversation-execution-autostart.js';
import { bindAssistSessionDirectory, createAssistSession, requestAssistMessage }
  from '../../src/application/assist-commands.js';
import { setMemorySettings } from '../../src/application/memory-settings.js';
import { enableProjectPluginCommand } from '../../src/application/gateway-commands.js';
import { createGatewayPolicy, registerManagedResource }
  from '../../src/application/gateway-configuration.js';
import { runAssistGenerationTick } from '../../src/application/assist-runner.js';
import { createRepositories, withTransaction } from '../../src/application/unit-of-work.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { ManagedContentStore } from '../../src/storage/managed-content-store.js';
import { advanceRunStep } from '../../src/application/run-steps.js';
import { resolveReview } from '../../src/application/review-decisions.js';
import { executeToolLoopStep } from '../../src/worker/tool-loop-action.js';
import { FakeModelPort, type AssistModelPort } from '../../src/workflow/fake-model-port.js';
import type { JsonObject } from '../../src/infrastructure/json.js';
import { createDataRoot } from './api-harness.js';
import { APP_DATABASE_URL, MIGRATION_DATABASE_URL, MIGRATIONS_DIRECTORY, openDatabase }
  from './integration-support.js';

/**
 * Computer Plugin 端到端执行链（2026-11-01 COMPUTER-PLUGIN-E2E）。
 *
 * 真实账本里 `@电脑操控 打开记事本` 的失败点是「模型只看到文件工具 + 整段输出是分析
 * 过程 + 没有执行请求」。本组用例锁住修复后的最小闭环：
 *
 *   T1 合法候选 → 原请求行 → AutoStart → Task/Run → 冻结机器工具；
 *   T1b 模型先输出纯文本 → 一次无工具信封修复 → 候选落库；
 *   T2 自然语言（无 mention）走同一链；
 *   T3 询问可行性 → execution=null，不启动；
 *   T4 修复后仍无信封 → 类型化失败，不把分析正文当成功结算；
 *   T5 没有连接 → 不产生 Run，原请求行留下具体原因；
 *   T6 重复推进不产生第二个 Run；
 *   T7 Mock Runtime 经 Gateway 派发真实工具调用（真实 Windows 输入另行取证）。
 */

const app = openDatabase(APP_DATABASE_URL, 'relay-api-test-computer-plugin-e2e');
let dataRoot: string;
const roots: string[] = [];

before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
  dataRoot = await createDataRoot();
  // Mock 运行时只用于证明 Gateway → Runtime 的完整派发；结果带 mock 标记，不冒充真机。
  process.env.COMPUTER_RUNTIME_MODE = 'mock';
  const runtime = [resolve(process.cwd(), '..', 'computer-runtime', 'target', 'release',
    'relay-computer-runtime.exe'),
  resolve(process.cwd(), '..', 'computer-runtime', 'target', 'debug',
    'relay-computer-runtime.exe')].find((path) => existsSync(path));
  if (runtime !== undefined) process.env.RELAY_COMPUTER_RUNTIME = runtime;
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

async function fixture(options?: { readonly withComputer?: boolean;
  readonly bound?: boolean }): Promise<Fixture> {
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const root = await mkdtemp(join(tmpdir(), 'relay-computer-e2e-'));
  roots.push(root);
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'index.ts'), 'export const relay = true;\n', 'utf8');
  await withTransaction(app.db, async (repositories) => {
    await repositories.workspaces.insertWorkspace({ id: workspaceId, name: 'computer-e2e' });
    await repositories.workspaces.insertAuthorityRow(workspaceId);
    await repositories.projects.insertProject({ id: projectId, workspaceId,
      title: 'computer-e2e', projectType: 'DEVELOPMENT' });
  });
  const registered = await registerManagedResource(app.db, { workspaceId, projectId, rootPath: root });
  // 文件读工具让绑定目录的会话确实走主流程；没有它，主流程词表为空，用例会测到另一条路径。
  await withTransaction(app.db, async (repositories) => {
    await repositories.workspaces.lockAuthority(workspaceId, 'update');
    const connection = await repositories.gateway.insertConnection({ id: randomUUID(),
      workspaceId, projectId, config: { root_path: registered.canonicalRoot } });
    for (const capability of ['FILE_QUERY', 'FILE_READ'] as const) {
      await repositories.gateway.addConnectionCapability(connection.id, capability);
    }
    await repositories.workspaces.bumpAuthority(workspaceId);
  });
  for (const [capability, actionType] of [['FILE_QUERY', 'LIST_DIRECTORY'],
    ['FILE_QUERY', 'FIND_PATHS'], ['FILE_QUERY', 'SEARCH_TEXT'],
    ['FILE_READ', 'READ_FILE']] as const) {
    await createGatewayPolicy(app.db, { workspaceId, projectId, capability,
      actionType, targetPrefix: registered.canonicalRoot, decision: 'AUTO',
      maxPayloadBytes: 262_144 });
  }
  if (options?.withComputer === true) {
    const outcome = await enableProjectPluginCommand(app.db,
      { workspaceId, projectId, commandId: randomUUID(), plugin: 'computer' });
    assert.equal(outcome.replayed, false);
  }
  // 自动记忆提取是独立模型调用，会在端口计数里多一次；本组用例只核对主流程与修复轮。
  await setMemorySettings(app.db, { workspaceId, commandId: randomUUID(),
    expectedRevision: '0', recallEnabled: true, automaticCompaction: true, autoCapture: false });
  const session = await createAssistSession(app.db, { workspaceId, commandId: randomUUID(),
    projectId: options?.bound === false ? null : projectId,
    title: '电脑操控会话', conversationMode: 'AGENT' });
  if (options?.bound !== false) {
    await bindAssistSessionDirectory(app.db, { workspaceId,
      sessionId: session.result.session_id, commandId: randomUUID(),
      resourceId: registered.resourceId });
  }
  return { workspaceId, projectId, resourceId: registered.resourceId, root,
    sessionId: session.result.session_id };
}

interface CapturedRequest {
  readonly tools: readonly string[];
  readonly responseFormat: string | undefined;
  readonly lastUser: string;
}

function sequencedPort(responses: readonly string[],
  captured: CapturedRequest[] = []): AssistModelPort {
  const base = new FakeModelPort();
  let index = 0;
  return {
    identity: base.identity,
    assist: async (request) => {
      const lastUser = [...request.turns].reverse().find((turn) => turn.role === 'user')?.content ?? '';
      captured.push({ tools: (request.tools ?? []).map((tool) => tool.name),
        responseFormat: request.responseFormat, lastUser });
      const content = responses[Math.min(index, responses.length - 1)]!;
      index += 1;
      return { kind: 'CONTENT' as const, content, providerRequestId: `computer-e2e-${index}`,
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: null,
          cacheCreationTokens: null } };
    },
  };
}

function computerCandidate(): JsonObject {
  return { title: '打开记事本', objective: '在本机打开记事本并确认窗口出现',
    criteria: [{ statement: '记事本窗口在桌面上可见', required: true, method: 'HUMAN' }],
    expected_outputs: { kind: 'MARKDOWN_DOCUMENT' },
    writes_files: false, file_changes: [], check: null, interaction: 'COMPUTER' };
}

function envelope(candidate: JsonObject | null, reply: string): string {
  return JSON.stringify({ reply, execution: candidate, maintenance: null });
}

async function ask(fx: Fixture, content: string, port: AssistModelPort) {
  const storage = new ManagedContentStore(dataRoot);
  const sent = await requestAssistMessage(app.db, { workspaceId: fx.workspaceId,
    sessionId: fx.sessionId, commandId: randomUUID(), content });
  const outcome = await runAssistGenerationTick(app.db, { workerId: `computer-e2e-${randomUUID()}`,
    storage, modelPort: port, modelEnv: {}, leaseMs: 60_000, maxMessages: 1 });
  assert.ok(outcome !== undefined, '本次生成 tick 应当领取这条消息');
  const repositories = createRepositories(app.db);
  const message = await repositories.assist.readMessage(sent.result.assistant_message_id);
  const requests = (await repositories.conversationExecutions
    .listSessionRequests(fx.workspaceId, fx.sessionId))
    .filter((item) => item.source_message_id === sent.result.user_message_id);
  return { sent, message, requests };
}

async function frozenLoop(runId: string): Promise<{ connections: JsonObject;
  allowedTools: string[] }> {
  const result = await sql<{ frozen_snapshot: JsonObject }>`
    select frozen_snapshot from execution_contracts where run_id = ${runId}
  `.execute(app.db);
  const loop = result.rows[0]?.frozen_snapshot.tool_loop_action as JsonObject | undefined;
  assert.ok(loop, 'Run 必须冻结工具循环信封');
  return { connections: loop.connections as JsonObject, allowedTools: loop.allowed_tools as string[] };
}

// ------------------------------------------------------------------ T1 / T1b

test('T1 绑定目录会话的合法电脑候选进入原执行链并冻结机器工具', async () => {
  const fx = await fixture({ withComputer: true });
  const captured: CapturedRequest[] = [];
  const result = await ask(fx, '@电脑操控 打开记事本',
    sequencedPort([envelope(computerCandidate(), '把「打开记事本」作为电脑操控执行交给后台。')],
      captured));
  assert.equal(result.message?.status, 'COMPLETED');
  assert.equal(result.requests.length, 1);
  const request = result.requests[0]!;
  assert.equal(request.decision, 'PREPARE');
  assert.equal(request.candidate_status, 'READY');
  assert.equal(request.candidate?.interaction, 'COMPUTER');
  assert.match(result.message?.content ?? '', /已登记执行请求（电脑操控）/u);
  assert.match(result.message?.content ?? '', /尚未执行/u);

  const applied = await applyConversationExecution(app.db,
    { workspaceId: fx.workspaceId, requestId: request.id });
  assert.equal(applied.status, 'DELEGATED');
  assert.ok(applied.run_id);
  const loop = await frozenLoop(applied.run_id!);
  assert.equal(loop.connections.COMPUTER_READ !== undefined, true);
  assert.equal(loop.connections.COMPUTER_INPUT !== undefined, true);
  assert.ok(loop.allowedTools.includes('computer_get_windows'));
  assert.ok(loop.allowedTools.includes('computer_hotkey'));
  assert.ok(loop.allowedTools.includes('read_file'), '绑定目录会话保留文件工具');
});

test('T1b 模型先输出分析过程时，一次无工具信封修复仍落成候选', async () => {
  const fx = await fixture({ withComputer: true });
  const captured: CapturedRequest[] = [];
  const analysis = '用户要求打开记事本（电脑操作）。\n\n让我看看本轮可用的工具：'
    + 'list_directory、read_file……没有 computer_ 开头的桌面工具。所以我应该把这件事作为执行请求交给后台执行。';
  const result = await ask(fx, '@电脑操控 打开记事本',
    sequencedPort([analysis, envelope(computerCandidate(),
      '已把打开记事本整理成电脑操控执行请求。')], captured));
  assert.equal(result.message?.status, 'COMPLETED');
  assert.equal(captured.length, 2, '纯文本回复后应当只多一次修复调用');
  assert.deepEqual(captured[1]?.tools, [], '修复轮不声明工具，不会重复副作用');
  assert.equal(captured[1]?.responseFormat, 'json_object');
  assert.match(captured[1]?.lastUser ?? '', /输出格式修复/u);
  assert.equal(result.requests.length, 1, '修复后的候选仍走原请求行');
  const content = result.message?.content ?? '';
  assert.doesNotMatch(content, /让我看看本轮可用的工具/u, '模型分析过程不能落成用户可见回复');
  assert.match(content, /已登记执行请求（电脑操控）/u);
  const applied = await applyConversationExecution(app.db,
    { workspaceId: fx.workspaceId, requestId: result.requests[0]!.id });
  assert.equal(applied.status, 'DELEGATED');
});

// -------------------------------------------------------------------- T2 / T3

test('T2 普通自然语言「请帮我打开记事本」走同一条执行链', async () => {
  const fx = await fixture({ withComputer: true });
  const result = await ask(fx, '请帮我打开记事本',
    sequencedPort(['这是电脑操作，需要交给后台执行。', envelope(computerCandidate(),
      '已把打开记事本整理成电脑操控执行请求。')]));
  assert.equal(result.requests.length, 1);
  assert.equal(result.requests[0]?.candidate_status, 'READY');
  assert.equal(result.requests[0]?.candidate?.interaction, 'COMPUTER');
  const applied = await applyConversationExecution(app.db,
    { workspaceId: fx.workspaceId, requestId: result.requests[0]!.id });
  assert.equal(applied.status, 'DELEGATED');
});

test('T8 插件工作区里的普通问候不触发信封修复', async () => {
  const fx = await fixture({ withComputer: true });
  const captured: CapturedRequest[] = [];
  const result = await ask(fx, '你好',
    sequencedPort(['你好，我是 Relay 助手。'], captured));
  assert.equal(result.message?.status, 'COMPLETED');
  // 环境能力不是用户意图：没有 @mention、没有动作词时不应重发整份 system。
  assert.equal(captured.length, 1, '普通问候只应有一次主调用');
  assert.equal(captured[0]?.responseFormat, undefined);
  assert.equal(result.requests.length, 0);
});

test('T3 询问插件能不能打开记事本时不启动桌面操作', async () => {
  const fx = await fixture({ withComputer: true });
  const result = await ask(fx, '@电脑操控 能不能打开记事本？',
    sequencedPort(['可以，这个插件能在任务执行中打开应用。', envelope(null,
      '可以。电脑操控在执行阶段可以打开应用；需要我实际打开时告诉我。')]));
  assert.equal(result.requests.length, 0, '讨论不能产生执行请求');
  assert.match(result.message?.content ?? '', /可以/u);
  const runs = await sql<{ count: string }>`select count(*)::text as count from runs
    where task_id in (select id from tasks where project_id = ${fx.projectId})`.execute(app.db);
  assert.equal(runs.rows[0]?.count, '0');
});

test('T3b 模型把能力询问误判成命令时，服务端降级为澄清，不自动委托', async () => {
  const fx = await fixture({ withComputer: true });
  const result = await ask(fx, '@电脑操控 能不能打开记事本？',
    sequencedPort([envelope(computerCandidate(),
      '这是命令式请求，我把它交给后台执行。')]));
  // 澄清行可以保留（界面据此显示「需要你补充」），但绝不能是 READY 候选或有 Run。
  assert.equal(result.requests.length, 1);
  assert.equal(result.requests[0]?.status, 'CLARIFY');
  assert.equal(result.requests[0]?.task_id, null);
  assert.equal(result.requests[0]?.run_id, null);
  const content = result.message?.content ?? '';
  assert.match(content, /看起来是在询问电脑操控能否完成该操作/u);
  assert.match(content, /没有登记执行请求/u);
  assert.match(content, /现在执行/u);
  assert.doesNotMatch(content, /已交给你|交给后台执行/u);
});

// -------------------------------------------------------------------- T4 / T5

test('T4 修复后仍没有信封：明确操作请求显示类型化失败，不把分析当成功', async () => {
  const fx = await fixture({ withComputer: true });
  const analysis = '用户要求打开记事本。我先想想需要哪些步骤……';
  const result = await ask(fx, '@电脑操控 打开记事本',
    sequencedPort([analysis, analysis]));
  assert.equal(result.requests.length, 0);
  const content = result.message?.content ?? '';
  assert.match(content, /没有登记执行请求（电脑操控）/u);
  assert.match(content, /没有任何电脑或浏览器操作被执行/u);
  assert.doesNotMatch(content, /我先想想需要哪些步骤/u);
});

test('T5 没有电脑连接时原请求行留下具体原因，不产生 Run', async () => {
  const fx = await fixture({ withComputer: false });
  const result = await ask(fx, '@电脑操控 打开记事本',
    sequencedPort([envelope(computerCandidate(), '已整理成电脑操控执行请求。')]));
  assert.equal(result.requests.length, 1, '候选本身可以登记，准入由原执行入口判定');
  const tick = await runConversationExecutionAutoStartTick(app.db, { limit: 1 });
  assert.equal(tick.applied.length, 0);
  assert.equal(tick.failed.length, 1);
  assert.match(tick.failed[0]?.reason ?? '', /COMPUTER_READ/u);
  const request = await createRepositories(app.db).conversationExecutions
    .readRequest(result.requests[0]!.id);
  assert.equal(request?.status, 'FAILED');
  assert.equal(request?.run_id, null);
  const runs = await sql<{ count: string }>`select count(*)::text as count from runs
    where task_id in (select id from tasks where project_id = ${fx.projectId})`.execute(app.db);
  assert.equal(runs.rows[0]?.count, '0');
});

// -------------------------------------------------------------------------- T6

test('T6 重复 AutoStart 与重复 apply 不产生第二个 Task/Run', async () => {
  const fx = await fixture({ withComputer: true });
  const result = await ask(fx, '@电脑操控 打开记事本',
    sequencedPort([envelope(computerCandidate(), '已整理成电脑操控执行请求。')]));
  const requestId = result.requests[0]!.id;
  const first = await applyConversationExecution(app.db,
    { workspaceId: fx.workspaceId, requestId });
  assert.equal(first.status, 'DELEGATED');
  const second = await applyConversationExecution(app.db,
    { workspaceId: fx.workspaceId, requestId });
  assert.equal(second.run_id, first.run_id);
  const tick = await runConversationExecutionAutoStartTick(app.db, { limit: 1 });
  assert.equal(tick.applied.length, 0, '已委托的请求不再是 AutoStart 候选');
  const requests = await sql<{ count: string }>`select count(*)::text as count
    from conversation_execution_requests where source_message_id = ${result.sent.result.user_message_id}`
    .execute(app.db);
  assert.equal(requests.rows[0]?.count, '1');
});

// --------------------------------------------------------- 真实 Provider
// 见 computer-plugin-real-model.integration.test.ts：真实 Provider 需要单独的
// RELAY_MODEL_* 环境，不能与本组 FakeModel 用例共享同一进程，否则会话模型快照
// 会把 FakeModelPort 与真实端口混在一起。

test('T7 Mock Runtime：电脑工具经 Gateway 派发，输入动作等待人工批准', async () => {
  if (process.env.RELAY_COMPUTER_RUNTIME === undefined ||
      !existsSync(process.env.RELAY_COMPUTER_RUNTIME)) {
    // 没有运行时二进制时不能把 Mock 流程冒充成已执行；明确跳过并保留未验事实。
    return;
  }
  const fx = await fixture({ withComputer: true });
  const result = await ask(fx, '@电脑操控 打开记事本',
    sequencedPort([envelope(computerCandidate(), '已整理成电脑操控执行请求。')]));
  const applied = await applyConversationExecution(app.db,
    { workspaceId: fx.workspaceId, requestId: result.requests[0]!.id });
  assert.equal(applied.status, 'DELEGATED');
  const runId = applied.run_id!;
  const storage = new ManagedContentStore(dataRoot);
  const script = [[{ name: 'computer_get_windows', arguments: {} }],
    [{ name: 'computer_hotkey', arguments: { keys: ['WIN', 'R'] } }]];
  let toolCallId: string | undefined;
  for (let index = 0; index < 8; index += 1) {
    const step = await advanceRunStep(app.db, { runId, workerId: `computer-mock-${randomUUID()}`,
      storage, fakeToolScript: script });
    if (step.status === 'TOOL_LOOP_ACTION_REQUIRED') { toolCallId = step.tool_call_id; break; }
    assert.ok(['STEP_SUCCEEDED', 'REPLAYED'].includes(step.status), JSON.stringify(step));
  }
  assert.ok(toolCallId);
  const claim = { commandId: randomUUID(), runId, workspaceId: fx.workspaceId,
    kind: 'START' as const, reviewDecisionId: null, workerId: `computer-mock-${randomUUID()}`, epoch: 0n };
  const read = await executeToolLoopStep(app.db, { claim, toolCallId });
  assert.equal(read.status, 'SUCCEEDED', JSON.stringify(read));
  const repositories = createRepositories(app.db);
  const readOperation = read.operationId === null ? undefined
    : await repositories.gateway.readOperation(read.operationId);
  assert.equal(readOperation?.status, 'SUCCEEDED');
  assert.equal(readOperation?.result_ref?.mock, true, 'Mock 数据必须保留 mock 标记');

  let inputCallId: string | undefined;
  for (let index = 0; index < 8; index += 1) {
    const step = await advanceRunStep(app.db, { runId, workerId: `computer-mock-${randomUUID()}`,
      storage, fakeToolScript: script });
    if (step.status === 'TOOL_LOOP_ACTION_REQUIRED') { inputCallId = step.tool_call_id; break; }
    assert.ok(['STEP_SUCCEEDED', 'REPLAYED'].includes(step.status), JSON.stringify(step));
  }
  assert.ok(inputCallId);
  const waiting = await executeToolLoopStep(app.db, { claim, toolCallId: inputCallId });
  assert.equal(waiting.status, 'WAITING');
  assert.ok(waiting.reviewId);
  assert.equal((await repositories.runs.readRun(runId))?.status, 'WAITING_APPROVAL');

  const review = await repositories.reviews.readRequest(waiting.reviewId);
  assert.ok(review);
  const approved = await resolveReview(app.db, { workspaceId: fx.workspaceId,
    reviewId: review.id, commandId: randomUUID(),
    expectedRevision: String(review.revision),
    targetHash: review.target_hash.toString('hex'), decision: 'APPROVE' as const });
  const resumeCommand = (await sql<{ id: string }>`select id from run_commands
    where review_decision_id = ${approved.result.decision_id}`.execute(app.db)).rows[0];
  assert.ok(resumeCommand);
  const resumed = await executeToolLoopStep(app.db, { claim: { ...claim,
    commandId: resumeCommand.id, kind: 'RESUME' as const,
    reviewDecisionId: approved.result.decision_id }, toolCallId: inputCallId });
  assert.equal(resumed.status, 'SUCCEEDED', JSON.stringify(resumed));
});