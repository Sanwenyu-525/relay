import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import { sql } from 'kysely';

import { applyConversationExecution } from '../../src/application/conversation-execution.js';
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
import { OpenAiCompatibleModelPort } from '../../src/workflow/openai-compatible-model-port.js';
import { readModelPortConfig } from '../../src/workflow/model-port-config.js';
import type { JsonObject } from '../../src/infrastructure/json.js';
import { createDataRoot } from './api-harness.js';
import { APP_DATABASE_URL, MIGRATION_DATABASE_URL, MIGRATIONS_DIRECTORY, openDatabase }
  from './integration-support.js';

/**
 * Computer Plugin 真实 Provider 协议兼容（2026-11-01 COMPUTER-PLUGIN-E2E）。
 *
 * 只在显式注入 RELAY_MODEL_* 与 RELAY_ACCEPTANCE_REAL_MODEL=1 时运行：
 *   T1 明确插件请求 → 可委托候选 → 原执行链
 *   T2 自然语言请求 → 同一链
 *   T3 能力询问 → 不产生 READY 候选或 Run
 *
 * 与 FakeModel 套件分开文件，因为会话模型选择会按进程环境冻结快照；同一进程里
 * 混用真实端口与 FakeModelPort 会让快照身份对不上。
 */

const app = openDatabase(APP_DATABASE_URL, 'relay-api-test-computer-plugin-real');
let dataRoot: string;
const roots: string[] = [];

before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
  dataRoot = await createDataRoot();
  // 只影响能力事实块里的运行时状态；本组不派发桌面动作。
  process.env.COMPUTER_RUNTIME_MODE = 'mock';
});
after(async () => {
  await app.close();
  await rm(dataRoot, { recursive: true, force: true });
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

interface Fixture {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly sessionId: string;
}

async function fixture(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const root = await mkdtemp(join(tmpdir(), 'relay-computer-real-'));
  roots.push(root);
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'index.ts'), 'export const relay = true;\n', 'utf8');
  await withTransaction(app.db, async (repositories) => {
    await repositories.workspaces.insertWorkspace({ id: workspaceId, name: 'computer-real' });
    await repositories.workspaces.insertAuthorityRow(workspaceId);
    await repositories.projects.insertProject({ id: projectId, workspaceId,
      title: 'computer-real', projectType: 'DEVELOPMENT' });
  });
  const registered = await registerManagedResource(app.db, { workspaceId, projectId, rootPath: root });
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
  const enabled = await enableProjectPluginCommand(app.db,
    { workspaceId, projectId, commandId: randomUUID(), plugin: 'computer' });
  assert.equal(enabled.replayed, false);
  await setMemorySettings(app.db, { workspaceId, commandId: randomUUID(),
    expectedRevision: '0', recallEnabled: true, automaticCompaction: true, autoCapture: false });
  const session = await createAssistSession(app.db, { workspaceId, commandId: randomUUID(),
    projectId, title: '电脑操控真实模型会话', conversationMode: 'AGENT' });
  await bindAssistSessionDirectory(app.db, { workspaceId, sessionId: session.result.session_id,
    commandId: randomUUID(), resourceId: registered.resourceId });
  return { workspaceId, projectId, sessionId: session.result.session_id };
}

function realModelPort(): OpenAiCompatibleModelPort {
  const config = readModelPortConfig(process.env);
  assert.ok(config, 'RELAY_MODEL_PROVIDER 与凭据必须由集成运行命令显式注入');
  return new OpenAiCompatibleModelPort(config);
}

async function ask(fx: Fixture, content: string) {
  const sent = await requestAssistMessage(app.db, { workspaceId: fx.workspaceId,
    sessionId: fx.sessionId, commandId: randomUUID(), content });
  const outcome = await runAssistGenerationTick(app.db, { workerId: `computer-real-${randomUUID()}`,
    storage: new ManagedContentStore(dataRoot), modelPort: realModelPort(),
    leaseMs: 120_000, maxMessages: 1 });
  assert.ok(outcome !== undefined, '本次生成 tick 应当领取这条消息');
  const repositories = createRepositories(app.db);
  const message = await repositories.assist.readMessage(sent.result.assistant_message_id);
  const requests = (await repositories.conversationExecutions
    .listSessionRequests(fx.workspaceId, fx.sessionId))
    .filter((item) => item.source_message_id === sent.result.user_message_id);
  return { sent, message, requests };
}

async function frozenLoop(runId: string): Promise<{ allowedTools: string[] }> {
  const result = await sql<{ frozen_snapshot: JsonObject }>`
    select frozen_snapshot from execution_contracts where run_id = ${runId}
  `.execute(app.db);
  const loop = result.rows[0]?.frozen_snapshot.tool_loop_action as JsonObject | undefined;
  assert.ok(loop, 'Run 必须冻结工具循环信封');
  return { allowedTools: loop.allowed_tools as string[] };
}

const skip = process.env.RELAY_ACCEPTANCE_REAL_MODEL !== '1'
  ? 'set RELAY_ACCEPTANCE_REAL_MODEL=1 with RELAY_MODEL_* env to run the real provider' : false;

test('T1-REAL 真实 Provider：@电脑操控 打开记事本生成可委托候选', { skip, timeout: 90_000 },
  async () => {
    const fx = await fixture();
    const result = await ask(fx, '@电脑操控 打开记事本');
    const ready = result.requests.find((request) => request.candidate_status === 'READY' &&
      request.candidate?.interaction === 'COMPUTER');
    assert.ok(ready, '真实 Provider 必须生成可委托的电脑操作候选；实际回复：'
      + (result.message?.content ?? ''));
    assert.match(result.message?.content ?? '', /已登记执行请求（电脑操控）/u);
    const applied = await applyConversationExecution(app.db,
      { workspaceId: fx.workspaceId, requestId: ready.id });
    assert.equal(applied.status, 'DELEGATED');
    const loop = await frozenLoop(applied.run_id!);
    assert.ok(loop.allowedTools.includes('computer_get_windows'));
    assert.ok(loop.allowedTools.includes('computer_hotkey'));
  });

test('T2-REAL 真实 Provider：自然语言「请帮我打开记事本」走同一执行链', { skip,
  timeout: 90_000 }, async () => {
  const fx = await fixture();
  const result = await ask(fx, '请帮我打开记事本');
  const ready = result.requests.find((request) => request.candidate_status === 'READY' &&
    request.candidate?.interaction === 'COMPUTER');
  assert.ok(ready, '自然语言请求也必须生成可委托候选；实际回复：'
    + (result.message?.content ?? ''));
});

test('T3-REAL 真实 Provider：能力询问不会产生 READY 候选或 Run', { skip, timeout: 90_000 },
  async () => {
    const fx = await fixture();
    const result = await ask(fx, '@电脑操控 能不能打开记事本？');
    assert.equal(result.requests.some((request) => request.candidate_status === 'READY'), false,
      '能力询问不能得到 READY 候选；实际回复：' + (result.message?.content ?? ''));
    const runs = await sql<{ count: string }>`select count(*)::text as count from runs
      where task_id in (select id from tasks where project_id = ${fx.projectId})`.execute(app.db);
    assert.equal(runs.rows[0]?.count, '0');
  });
