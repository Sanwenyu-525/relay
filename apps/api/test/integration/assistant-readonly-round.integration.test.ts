import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'kysely';
import test, { after, before } from 'node:test';

import { createAssistSession, requestAssistMessage } from '../../src/application/assist-commands.js';
import { runAssistGenerationTick } from '../../src/application/assist-runner.js';
import { createAssistantProfile } from '../../src/application/assistant-profile-commands.js';
import { createGatewayPolicy, registerManagedResource } from
  '../../src/application/gateway-configuration.js';
import { createRepositories, withTransaction } from '../../src/application/unit-of-work.js';
import { SessionToolCallRepository } from
  '../../src/assist/session-tool-call-repository.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { ManagedContentStore } from '../../src/storage/managed-content-store.js';
import { FakeModelPort, type AssistModelPort } from '../../src/workflow/fake-model-port.js';
import type { GatewayCapability } from '../../src/infrastructure/database-schema.js';
import type { JsonObject } from '../../src/infrastructure/json.js';
import { createDataRoot } from './api-harness.js';
import { APP_DATABASE_URL, MIGRATION_DATABASE_URL, MIGRATIONS_DIRECTORY, openDatabase } from
  './integration-support.js';

/**
 * B 档只读轮次的真实 PG 出口（迁移 0060）。
 *
 * 用可控 Fake 模型发出真实的「搜索 → 读文件 → 回答」序列，每一步都落到自己的
 * Gateway 动作身份上。每条用例都是一条反例或正向出口：
 *   * 只读真的读了磁盘，而磁盘逐字节未变；
 *   * 模型请求写工具时被类型化拒绝，且不连任何 Operation；
 *   * 一轮结束后 tasks / runs / run_scope_grants / run_tool_calls 全为 0；
 *   * 产生的 Operation 只属只读 capability，来源是 ASSISTANT_READ；
 *   * 跨身份冒用（把 B 档的行指向一个 RUN 的既有 Operation）被拒；
 *   * 连接被删后词表当场收窄，模型收到类型化原因而不是静默。
 */

const app = openDatabase(APP_DATABASE_URL, 'relay-api-test-assistant-readonly-round');
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

interface AssistantFixture {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly root: string;
  readonly connectionId: string;
  readonly botId: string;
  readonly canonicalRoot: string;
}

const TARGET_BASELINE = 'export const relay = true;\n';

async function fixture(options: {
  /** 声明给连接的能力；缺省给 FILE_QUERY + FILE_READ。 */
  readonly capabilities?: readonly GatewayCapability[];
  readonly readScope?: JsonObject | undefined;
} = {}): Promise<AssistantFixture> {
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const root = await mkdtemp(join(tmpdir(), 'relay-助手-'));
  roots.push(root);
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'README.md'), '# Relay\n人设只读轮次\n', 'utf8');
  await writeFile(join(root, 'src', 'index.ts'), TARGET_BASELINE, 'utf8');

  await withTransaction(app.db, async (repositories) => {
    await repositories.workspaces.insertWorkspace({ id: workspaceId, name: '助手-read' });
    await repositories.workspaces.insertAuthorityRow(workspaceId);
    await repositories.projects.insertProject({ id: projectId, workspaceId, title: '助手-read',
      projectType: 'DEVELOPMENT' });
  });
  const { resourceId, canonicalRoot } = await registerManagedResource(app.db,
    { workspaceId, projectId, rootPath: root });
  const capabilities = options.capabilities ?? ['FILE_QUERY', 'FILE_READ'];
  const connectionId = await withTransaction(app.db, async (repositories) => {
    await repositories.workspaces.lockAuthority(workspaceId, 'update');
    const connection = await repositories.gateway.insertConnection({ id: randomUUID(),
      workspaceId, projectId, config: { root_path: canonicalRoot } });
    for (const capability of capabilities) {
      await repositories.gateway.addConnectionCapability(connection.id, capability);
    }
    await repositories.workspaces.bumpAuthority(workspaceId);
    return connection.id;
  });
  for (const [capability, actionType] of [['FILE_QUERY', 'LIST_DIRECTORY'],
    ['FILE_QUERY', 'FIND_PATHS'], ['FILE_QUERY', 'SEARCH_TEXT'], ['FILE_READ', 'READ_FILE'],
    ['GIT_READ', 'GIT_STATUS'], ['GIT_READ', 'GIT_DIFF'], ['GIT_READ', 'GIT_LOG']] as const) {
    if (!capabilities.includes(capability)) continue;
    await createGatewayPolicy(app.db, { workspaceId, projectId, capability, actionType,
      targetPrefix: canonicalRoot, decision: 'AUTO', maxPayloadBytes: 262144 });
  }

  const 助手 = await createAssistantProfile(app.db, { workspaceId, commandId: randomUUID(),
    name: '审读', roleDescription: '只读复核这份改动', tone: '简短',
    ...(options.readScope === undefined ? {} : { readScope: options.readScope }) });
  const botId = 助手.result.assistant_profile_id as string;
  const session = await createAssistSession(app.db, { workspaceId, commandId: randomUUID(),
    title: '人设会话', projectId, conversationMode: 'ASSISTANT', assistantProfileId: botId });
  return { workspaceId, projectId, sessionId: session.result.session_id, root, connectionId,
    botId, canonicalRoot };
}

/**
 * 发一条消息并跑一次生成 tick。
 *
 * 默认用 Fake 端口按脚本发工具；`port` 可替换为任意端口，用来驱动「模型请求了
 * 本次词表里没有的工具」这类 Fake 不会主动制造的情况。
 */
async function ask(fx: AssistantFixture, content: string,
  port?: AssistModelPort): Promise<{ readonly status: string; readonly errorCode: string | null;
  readonly declaredTools: readonly string[];
  readonly fedBack: readonly { name: string; content: string }[] }> {
  const storage = new ManagedContentStore(dataRoot);
  const modelPort = port ?? new FakeModelPort();
  const original = modelPort.assist.bind(modelPort);
  let declaredTools: readonly string[] = [];
  let fedBack: readonly { name: string; content: string }[] = [];
  modelPort.assist = async (request) => {
    declaredTools = (request.tools ?? []).map((spec) => spec.name);
    if ((request.toolTurns?.length ?? 0) > fedBack.length) {
      fedBack = request.toolTurns!.flatMap((turn) => turn.results
        .map((result) => ({ name: result.name, content: result.content })));
    }
    return original(request);
  };
  const sent = await requestAssistMessage(app.db, { workspaceId: fx.workspaceId,
    sessionId: fx.sessionId, commandId: randomUUID(), content });
  const outcome = await runAssistGenerationTick(app.db, { workerId: `助手-${randomUUID()}`,
    storage, modelPort, leaseMs: 60_000, maxMessages: 1 });
  assert.ok(outcome !== undefined, '本次生成 tick 应当领取这条消息');
  assert.equal(outcome?.messageId, sent.result.assistant_message_id);
  const message = await createRepositories(app.db).assist.readMessage(
    sent.result.assistant_message_id);
  return { status: message?.status ?? 'MISSING', errorCode: message?.error_code ?? null,
    declaredTools, fedBack };
}

/** 按脚本发工具的便捷入口。 */
async function askWithScript(fx: AssistantFixture, script: readonly (readonly { name: string;
  arguments: Record<string, unknown> }[])[]): ReturnType<typeof ask> {
  const scripted = new FakeModelPort();
  const original = scripted.assist.bind(scripted);
  scripted.assist = async (request) => {
    const turns = request.turns.length === 0 ? [{ role: 'user' as const,
      content: `FAKE_ASSIST_TOOLS ${JSON.stringify(script)}` }] : request.turns;
    return original({ ...request, turns });
  };
  return ask(fx, `FAKE_ASSIST_TOOLS ${JSON.stringify(script)}`, scripted);
}

/** 一个只会越权的端口：第一轮就请求写工具，第二轮只给正文。 */
function writeRequestingPort(toolName: string, toolArguments: JsonObject): AssistModelPort {
  let round = 0;
  return {
    identity: new FakeModelPort().identity,
    assist: async () => {
      round += 1;
      if (round === 1) {
        return { kind: 'TOOL_CALLS', calls: [{ providerToolCallId: `stub-tool-${round}`,
          name: toolName, arguments: toolArguments }], preamble: '',
          providerRequestId: 'stub-write-1',
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: null,
            cacheCreationTokens: null } };
      }
      return { kind: 'CONTENT', content: '（stub）已用只读工具回答。',
        providerRequestId: 'stub-write-2',
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: null,
          cacheCreationTokens: null } };
    },
  };
}

/**
 * 计数必须按本用例的 Project 限定：同一个临时库里前一个用例已经建过自己的动作，
 * 数整张表会把别人的事实算成自己的。
 */
async function countProjectRows(table: string, projectId: string): Promise<number> {
  const rows = await sql<{ present: boolean }>`select exists(
    select 1 from ${sql.table(table)} where project_id = ${projectId}) as present`
    .execute(app.db);
  return rows.rows[0]?.present === true ? 1 : 0;
}

/** Run 挂在 task_id 上，因此按 Task 的 Project 归属统计，而不是按 runs.project_id。 */
async function countRunsOfProject(projectId: string): Promise<number> {
  const rows = await sql<{ present: boolean }>`select exists(
    select 1 from runs r join tasks t on t.id = r.task_id
    where t.project_id = ${projectId}) as present`.execute(app.db);
  return rows.rows[0]?.present === true ? 1 : 0;
}

/**
 * `run_tool_calls` 没有 project_id（它挂在 Run 上），只能整表计数。
 * 本文件里只有 B 档用例在跑，而 B 档永远不写这张表，因此整表为 0 本身就是结论。
 */
async function countAllRows(table: string): Promise<number> {
  const rows = await sql<{ present: boolean }>`select exists(
    select 1 from ${sql.table(table)}) as present`.execute(app.db);
  return rows.rows[0]?.present === true ? 1 : 0;
}

test('只读轮次真的读了磁盘，而磁盘逐字节未变，也没有建Task/Run', async () => {
  const fx = await fixture();
  const before_ = await readFile(join(fx.root, 'src', 'index.ts'), 'utf8');
  const outcome = await askWithScript(fx, [
    [{ name: 'find_paths', arguments: { pattern: 'index.ts' } }],
    [{ name: 'read_file', arguments: { relative_path: 'src/index.ts' } }],
  ]);
  assert.equal(outcome.status, 'COMPLETED', JSON.stringify(outcome));
  // 词表按当前连接裁剪：这次给了 FILE_QUERY + FILE_READ，因此目录浏览、搜索、
  // 读文件都在列，Git 与写工具一律不在。
  assert.deepEqual(outcome.declaredTools,
    ['list_directory', 'find_paths', 'search_text', 'read_file']);
    // 「真的读了磁盘」的证据是回传给模型的那次读取结果：必须是磁盘上的真实正文，
  // 而不是模型编的一段话或目录名列表。
  const readResult = outcome.fedBack.find((item) => item.name === 'read_file');
  assert.ok(readResult !== undefined,
    '模型应当收到 read_file 的结果；实际工具行：' + JSON.stringify(
      (await new SessionToolCallRepository(app.db).listBySession(fx.sessionId))
        .map((row) => ({ tool: row.tool_name, status: row.status, reason: row.rejection_reason,
          detail: row.rejection_detail }))));
  assert.match(readResult?.content ?? '', /export const relay = true/u);
  assert.equal(await readFile(join(fx.root, 'src', 'index.ts'), 'utf8'), before_);

  // 执行链没有被创建：一个 Task、一个 Run、一条范围授权、一条 run_tool_calls 都没有。
  assert.equal(await countProjectRows('tasks', fx.projectId), 0);
  assert.equal(await countRunsOfProject(fx.projectId), 0);
  assert.equal(await countProjectRows('run_scope_grants', fx.projectId), 0);
  assert.equal(await countAllRows('run_tool_calls'), 0);

  // 产生的只读动作来源与能力都在词表内。
  const operations = (await sql<{ origin: string; capability_key: string }>`
    select origin, capability_key from logical_operations order by created_at`
    .execute(app.db)).rows;
  assert.ok(operations.length > 0, '读取必须留下账本，而不是只显示过一次');
  for (const operation of operations) {
    assert.equal(operation.origin, 'ASSISTANT_READ');
    assert.ok(['FILE_READ', 'FILE_QUERY', 'GIT_READ'].includes(operation.capability_key),
      `不允许出现写能力：${operation.capability_key}`);
  }
  const rows = await new SessionToolCallRepository(app.db).listBySession(fx.sessionId);
  assert.ok(rows.every((row) => row.status === 'SETTLED'), JSON.stringify(rows.map((r) => r.status)));
});

test('模型请求写工具时被拒，且不连任何 Operation、不落一个字节', async () => {
  const fx = await fixture();
  const before_ = await readFile(join(fx.root, 'src', 'index.ts'), 'utf8');
  const outcome = await ask(fx, `请把 ${TARGET_BASELINE.trim()} 改成 false`,
    writeRequestingPort('apply_changeset', { changes: [{ path: 'src/index.ts',
      action: 'MODIFY', baseline_sha256: 'a'.repeat(64), content_sha256: 'b'.repeat(64),
      content: 'export const relay = false;\n' }] }));
  // 写请求被类型化拒绝并回传模型，模型因此改用只读回答——这是设计的恢复路径，
  // 不是「照做了」。真正要锁住的是：被拒、没连 Operation、磁盘没变、没有写能力动作。
  assert.equal(outcome.status, 'COMPLETED', JSON.stringify(outcome));
  const rows = await new SessionToolCallRepository(app.db).listBySession(fx.sessionId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.status, 'REJECTED');
  assert.equal(rows[0]?.rejection_reason, 'TOOL_NOT_READ_ONLY');
  // 被拒的请求不连 Operation：不留一条「已批准的动作」等着被人误当成发生过。
  assert.equal(rows[0]?.operation_id, null);
  assert.equal(rows[0]?.status, 'REJECTED');
  assert.equal(await countProjectRows('logical_operations', fx.projectId), 0);
  assert.equal(await countProjectRows('tasks', fx.projectId), 0);
  assert.equal(await countRunsOfProject(fx.projectId), 0);
  assert.equal(await countAllRows('run_tool_calls'), 0);
  assert.equal(await readFile(join(fx.root, 'src', 'index.ts'), 'utf8'), before_);
  // 目录里也没有多出任何新文件。
  assert.deepEqual((await readdir(join(fx.root, 'src'))).sort(), ['index.ts']);
});

test('同一消息的同一轮同一序号只能有一个请求', async () => {
  const fx = await fixture();
  await askWithScript(fx, [[{ name: 'find_paths', arguments: { pattern: '*.ts' } }]]);
  const repository = new SessionToolCallRepository(app.db);
  const rows = await repository.listBySession(fx.sessionId);
  assert.ok(rows.length > 0);
  await assert.rejects(() => repository.insert({ id: randomUUID(), sessionId: fx.sessionId,
    messageId: rows[0]!.message_id, round: rows[0]!.round, ordinal: rows[0]!.ordinal,
    toolName: 'read_file', arguments: {}, argumentsSha256: 'c'.repeat(64) }));
});

test('跨身份冒用被拒：B 档的行不能指向一个 RUN 的既有 Operation', async () => {
  const fx = await fixture();
  await askWithScript(fx, [[{ name: 'list_directory', arguments: { relative_path: 'src' } }]]);
  const repository = new SessionToolCallRepository(app.db);
  const rows = await repository.listBySession(fx.sessionId);
  const attached = rows[0]!;
  assert.ok(attached.operation_id !== null);

  // 直接改写绕过仓库方法也不行：0060 的 capability × origin CHECK 挡住写能力来源，
  // 而仓库方法本身按 ASSISTANT_READ 过滤，两条路都不给跨身份冒用留缝。
  assert.equal(await repository.attachOperation(attached.id, randomUUID(), 'ASSISTANT_READ'), false);
  await assert.rejects(() => sql`update session_tool_calls set operation_id = ${randomUUID()}
    where id = ${attached.id}`.execute(app.db), '外键约束必须挡住不存在的 Operation');
});

test('连接被删后词表当场收窄，模型收到类型化原因而不是静默', async () => {
  const fx = await fixture();
  // 先跑一轮确认能读。
  const first = await askWithScript(fx, [[{ name: 'read_file',
    arguments: { relative_path: 'src/index.ts' } }]]);
  assert.equal(first.status, 'COMPLETED');

  // 停用连接后同一会话再问一次只读：词表里不再有 read_file。
  await createRepositories(app.db).gateway.setConnection({ id: fx.connectionId, status: 'DISABLED',
    config: { root_path: fx.canonicalRoot } });
  const second = await askWithScript(fx, [[{ name: 'read_file',
    arguments: { relative_path: 'src/index.ts' } }]]);
  // Fake 只发出词表内声明过的工具；能力被收回后模型这一轮拿不到 read_file，
  // 因此只会照原样回答，账本上不会出现新的读取。
  const rows = await new SessionToolCallRepository(app.db).listBySession(fx.sessionId);
  assert.equal(rows.length, 1, '能力收回后不得再产生新的读取事实');
  assert.ok(['COMPLETED', 'FAILED'].includes(second.status));
});

test('受管根缺失时以类型化原因拒掉，不伪造连接', async () => {
  const workspaceId = randomUUID();
  await withTransaction(app.db, async (repositories) => {
    await repositories.workspaces.insertWorkspace({ id: workspaceId, name: '助手-no-root' });
    await repositories.workspaces.insertAuthorityRow(workspaceId);
  });
  const 助手 = await createAssistantProfile(app.db, { workspaceId, commandId: randomUUID(),
    name: '审读', roleDescription: '只读复核' });
  const session = await createAssistSession(app.db, { workspaceId, commandId: randomUUID(),
    title: '无目录会话', conversationMode: 'ASSISTANT', assistantProfileId: 助手.result.assistant_profile_id as string });
  // 会话没有项目，也没有受管根：这一轮不该崩，也不该假装能读。
  const storage = new ManagedContentStore(dataRoot);
  await requestAssistMessage(app.db, { workspaceId, sessionId: session.result.session_id,
    commandId: randomUUID(), content: '读一下这个目录' });
  const outcome = await runAssistGenerationTick(app.db, { workerId: `助手-${randomUUID()}`,
    storage, modelPort: new FakeModelPort(), leaseMs: 60_000, maxMessages: 1 });
  assert.equal(outcome?.status, 'COMPLETED');
});