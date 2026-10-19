import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'kysely';
import test, { after, before } from 'node:test';

import { createAssistSession, bindAssistSessionDirectory, cancelAssistMessage,
  requestAssistMessage } from '../../src/application/assist-commands.js';
import { runAssistGenerationTick } from '../../src/application/assist-runner.js';
import { createGatewayPolicy, registerManagedResource } from
  '../../src/application/gateway-configuration.js';
import { openWorkingDirectory } from '../../src/application/open-working-directory.js';
import { createRepositories, withTransaction } from '../../src/application/unit-of-work.js';
import { SessionToolCallRepository } from '../../src/assist/session-tool-call-repository.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { ManagedContentStore } from '../../src/storage/managed-content-store.js';
import { FakeModelPort, type AssistModelPort, type AssistResult } from
  '../../src/workflow/fake-model-port.js';
import type { GatewayCapability } from '../../src/infrastructure/database-schema.js';
import type { JsonObject } from '../../src/infrastructure/json.js';
import { createDataRoot } from './api-harness.js';
import { APP_DATABASE_URL, MIGRATION_DATABASE_URL, MIGRATIONS_DIRECTORY, openDatabase } from
  './integration-support.js';

/**
 * 普通 Agent 连续工具主流程的真实 PG 出口（ADR-022 / 总纲 §0.5.1 / AM-01–04、AM-07–09）。
 *
 * 之前普通 AGENT 会话在 `assist-runner.ts` 的主分支里**不声明任何工具**，模型一旦请求工具
 * 就被结算成 `TOOL_CALLS_WITHOUT_DECLARED_TOOLS`；目录绑定只存在于浏览器内存，读取必须先
 * 走一条独立的执行解释模型调用。本文件锁住重构后的目标行为：
 *
 *   * AM-01/02：绑定目录后同一条原消息里，模型自己列目录、读文件，**真实磁盘内容**（本次
 *     随机标记）回到原模型轮次，原会话给出回答；不填任务表、不产生 Task/Run、磁盘未变。
 *   * AM-03：目录来自服务端持久关联；同项目多个受管资源时不取第一项，绑定哪个读哪个；
 *     换绑后立即生效。
 *   * AM-04：普通 AGENT 请求写工具被类型化拒绝，不连 Operation、不落写能力动作；
 *     两种会话读取身份在库层面互不冒充。
 *   * AM-07：一次回答只有一条推进链——不出现 `TOOL_CALLS_WITHOUT_DECLARED_TOOLS`，
 *     也不需要端口的 `interpret`（旧执行解释分支）才能拿到文件。
 *   * AM-08/09：重放同一命令拿回原回执；取消后不再派发新工具。
 *
 * 随机标记**不写进 Fake 的预设回答**：它只能经工具回执进入模型上下文，否则本文件证明的
 * 只是 Fake 自己写死的字符串。
 */

const app = openDatabase(APP_DATABASE_URL, 'relay-api-test-agent-main-loop');
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

interface AgentFixture {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly root: string;
  readonly canonicalRoot: string;
  readonly connectionId: string;
  /** 本次随机验证标记：只有真实读到文件才可能出现在模型上下文里。 */
  readonly marker: string;
}

/** 建一个真实的隔离目录树：README、子目录，以及含随机标记的文件。 */
async function makeTree(): Promise<{ root: string; marker: string; fileContent: string }> {
  const root = await mkdtemp(join(tmpdir(), 'relay-main-loop-'));
  roots.push(root);
  await mkdir(join(root, 'src'), { recursive: true });
  const marker = `RELAY-MARKER-${randomUUID().slice(0, 8).toUpperCase()}`;
  const fileContent = `# 目录说明\n本文件的随机标记：${marker}\n`;
  await writeFile(join(root, 'README.md'), fileContent, 'utf8');
  await writeFile(join(root, 'src', 'index.ts'), 'export const relay = true;\n', 'utf8');
  return { root, marker, fileContent };
}

async function fixture(options: {
  readonly capabilities?: readonly GatewayCapability[];
  /** 同项目内额外登记的第二个受管根：用来证明不取第一项。 */
  readonly extraRoot?: boolean;
  /** 是否把会话绑定到目录；缺省绑定。 */
  readonly bind?: boolean;
} = {}): Promise<AgentFixture> {
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const { root, marker } = await makeTree();

  await withTransaction(app.db, async (repositories) => {
    await repositories.workspaces.insertWorkspace({ id: workspaceId, name: 'main-loop' });
    await repositories.workspaces.insertAuthorityRow(workspaceId);
    await repositories.projects.insertProject({ id: projectId, workspaceId, title: 'main-loop',
      projectType: 'DEVELOPMENT' });
  });
  const { resourceId, canonicalRoot } = await registerManagedResource(app.db,
    { workspaceId, projectId, rootPath: root });
  if (options.extraRoot === true) {
    const sibling = await mkdtemp(join(tmpdir(), 'relay-main-loop-other-'));
    roots.push(sibling);
    await writeFile(join(sibling, 'OTHER.md'), '另一个根，不该被默认读到。\n', 'utf8');
    await registerManagedResource(app.db, { workspaceId, projectId, rootPath: sibling });
  }
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
    ['FILE_QUERY', 'FIND_PATHS'], ['FILE_QUERY', 'SEARCH_TEXT'], ['FILE_READ', 'READ_FILE']] as const) {
    if (!capabilities.includes(capability)) continue;
    await createGatewayPolicy(app.db, { workspaceId, projectId, capability, actionType,
      targetPrefix: canonicalRoot, decision: 'AUTO', maxPayloadBytes: 262144 });
  }
  const session = await createAssistSession(app.db, { workspaceId, commandId: randomUUID(),
    title: '普通会话', projectId, conversationMode: 'AGENT' });
  if (options.bind !== false) {
    await bindAssistSessionDirectory(app.db, { workspaceId,
      sessionId: session.result.session_id, commandId: randomUUID(), resourceId });
  }
  return { workspaceId, projectId, sessionId: session.result.session_id, root, canonicalRoot,
    connectionId, marker };
}

interface AskResult {
  readonly status: string;
  readonly errorCode: string | null;
  readonly content: string | null;
  readonly declaredTools: readonly string[];
  /** 回传给模型上下文的所有工具结果正文。 */
  readonly fedBack: readonly { name: string; content: string }[];
  /** 端口实际被调用的次数（多轮工具就是多次）。 */
  readonly assistCalls: number;
  /** 旧执行解释入口是否被调用过：主流程下必须为 0。 */
  readonly interpretCalls: number;
  readonly systemPrompts: readonly string[];
  /** 诊断用：这条消息的实际身份。 */
  readonly identity: { intent: string; hasSkill: boolean; hasMethod: boolean;
    projectId: string | null; workingResourceId: string | null };
}

async function ask(fx: AgentFixture, content: string, port?: AssistModelPort): Promise<AskResult> {
  const storage = new ManagedContentStore(dataRoot);
  const modelPort = port ?? new FakeModelPort();
  const originalAssist = modelPort.assist.bind(modelPort);
  const originalInterpret = modelPort.interpret?.bind(modelPort);
  let declaredTools: readonly string[] = [];
  let fedBack: readonly { name: string; content: string }[] = [];
  let assistCalls = 0;
  let interpretCalls = 0;
  const systemPrompts: string[] = [];
  modelPort.assist = async (request) => {
    assistCalls += 1;
    declaredTools = (request.tools ?? []).map((spec) => spec.name);
    systemPrompts.push(request.system);
    if ((request.toolTurns?.length ?? 0) > fedBack.length) {
      fedBack = request.toolTurns!.flatMap((turn) => turn.results
        .map((result) => ({ name: result.name, content: result.content })));
    }
    return originalAssist(request);
  };
  if (originalInterpret !== undefined) {
    modelPort.interpret = async (request) => {
      interpretCalls += 1;
      return originalInterpret(request);
    };
  }
  const sent = await requestAssistMessage(app.db, { workspaceId: fx.workspaceId,
    sessionId: fx.sessionId, commandId: randomUUID(), content });
  const outcome = await runAssistGenerationTick(app.db, { workerId: `main-loop-${randomUUID()}`,
    storage, modelPort, leaseMs: 60_000, maxMessages: 1 });
  assert.ok(outcome !== undefined, '本次生成 tick 应当领取这条消息');
  assert.equal(outcome?.messageId, sent.result.assistant_message_id);
  const message = await createRepositories(app.db).assist.readMessage(
    sent.result.assistant_message_id);
  const sessionRow = await createRepositories(app.db).assist.readSession(fx.sessionId);
  return { status: message?.status ?? 'MISSING', errorCode: message?.error_code ?? null,
    content: message?.content ?? null, declaredTools, fedBack, assistCalls, interpretCalls,
    systemPrompts,
    identity: { intent: message?.intent ?? '', hasSkill: message?.skill_snapshot != null,
      hasMethod: message?.method_snapshot != null,
      projectId: sessionRow?.project_id ?? null,
      workingResourceId: sessionRow?.working_resource_id ?? null } };
}

/** 按脚本发工具的普通会话入口（脚本工具名必须在本次声明的词表内）。 */
async function askWithScript(fx: AgentFixture,
  script: readonly (readonly { name: string; arguments: Record<string, unknown> }[])[],
  content = '看一下这个目录下面的文件'): Promise<AskResult> {
  const scripted = new FakeModelPort();
  const original = scripted.assist.bind(scripted);
  scripted.assist = async (request) => original({
    ...request,
    turns: request.turns.length === 0
      ? [{ role: 'user' as const, content: `FAKE_ASSIST_TOOLS ${JSON.stringify(script)}` }]
      : request.turns,
  });
  return ask(fx, `${content}\nFAKE_ASSIST_TOOLS ${JSON.stringify(script)}`, scripted);
}

/** 一个固定脚本的端口：第一轮发给定工具请求，之后按 settleOrFinish 收尾。 */
function scriptedPort(rounds: readonly (readonly { name: string; arguments: JsonObject }[])[],
  settleOrFinish: (round: number) => AssistResult): AssistModelPort {
  let round = 0;
  return {
    identity: new FakeModelPort().identity,
    assist: async () => {
      const script = rounds[round];
      round += 1;
      if (script !== undefined) {
        return { kind: 'TOOL_CALLS',
          calls: script.map((item, ordinal) => ({ providerToolCallId: `stub-${round}-${ordinal}`,
            name: item.name, arguments: item.arguments })),
          preamble: '', providerRequestId: `stub-r${round}`,
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: null,
            cacheCreationTokens: null } };
      }
      return settleOrFinish(round);
    },
  };
}

async function countProjectRows(table: string, projectId: string): Promise<number> {
  const rows = await sql<{ present: boolean }>`select exists(
    select 1 from ${sql.table(table)} where project_id = ${projectId}) as present`
    .execute(app.db);
  return rows.rows[0]?.present === true ? 1 : 0;
}

async function countRunsOfProject(projectId: string): Promise<number> {
  const rows = await sql<{ present: boolean }>`select exists(
    select 1 from runs r join tasks t on t.id = r.task_id
    where t.project_id = ${projectId}) as present`.execute(app.db);
  return rows.rows[0]?.present === true ? 1 : 0;
}

// ---------------------------------------------------------------- AM-01 / AM-02

test('AM-01/02 普通会话在同一条消息里读到真实目录与真实文件，随机标记进模型上下文，磁盘未变', async () => {
  const fx = await fixture();
  const before_ = await readFile(join(fx.root, 'README.md'), 'utf8');

  const outcome = await askWithScript(fx, [
    [{ name: 'list_directory', arguments: {} }],
    [{ name: 'read_file', arguments: { relative_path: 'README.md' } }],
  ]);

  assert.equal(outcome.status, 'COMPLETED', JSON.stringify({ status: outcome.status,
    errorCode: outcome.errorCode, fedBack: outcome.fedBack }));
  assert.equal(outcome.errorCode, null,
    '主流程不允许再结算成 TOOL_CALLS_WITHOUT_DECLARED_TOOLS：' + String(outcome.errorCode));

  // 词表按当前连接裁剪，且只含只读工具。
  assert.deepEqual(outcome.declaredTools,
    ['list_directory', 'find_paths', 'search_text', 'read_file'],
    '词表诊断：' + JSON.stringify({ declaredTools: outcome.declaredTools,
      assistCalls: outcome.assistCalls, fedBack: outcome.fedBack,
      identity: outcome.identity,
      system: (outcome.systemPrompts[0] ?? '').slice(0, 160) }));
  assert.ok(!outcome.declaredTools.some((name) =>
    ['apply_changeset', 'run_check', 'read_change_set'].includes(name)),
  '会话读取来源不得出现写工具：' + JSON.stringify(outcome.declaredTools));

  // 「真的读了磁盘」：目录列举里必须有真实条目，文件读取结果里必须有本次随机标记。
  const listing = outcome.fedBack.find((item) => item.name === 'list_directory');
  assert.ok(listing !== undefined, '模型应当收到 list_directory 的结果');
  assert.match(listing?.content ?? '', /README\.md/u);
  const read = outcome.fedBack.find((item) => item.name === 'read_file');
  assert.ok(read !== undefined,
    '模型应当收到 read_file 的结果；实际工具行：' + JSON.stringify(
      (await new SessionToolCallRepository(app.db).listBySession(fx.sessionId))
        .map((row) => ({ tool: row.tool_name, status: row.status, reason: row.rejection_reason,
          detail: row.rejection_detail }))));
  assert.ok((read?.content ?? '').includes(fx.marker),
    '本次随机标记必须经工具回执进入模型上下文；实际结果：' + String(read?.content));

  // 磁盘逐字节未变：只读轮次不改任何文件，也不新建。
  assert.equal(await readFile(join(fx.root, 'README.md'), 'utf8'), before_);
  assert.deepEqual((await readdir(fx.root)).sort(), ['README.md', 'src']);

  // 纯讨论/读取不制造占位 Task/Run、范围授权或 Run 侧工具账本。
  assert.equal(await countProjectRows('tasks', fx.projectId), 0);
  assert.equal(await countRunsOfProject(fx.projectId), 0);
  assert.equal(await countProjectRows('run_scope_grants', fx.projectId), 0);
});

// ------------------------------------------------------------------------- AM-07

test('AM-07 一次回答只有一条推进链：多轮工具在同一个模型上下文里完成，不经旧解释入口', async () => {
  const fx = await fixture();
  const outcome = await askWithScript(fx, [
    [{ name: 'list_directory', arguments: {} }],
    [{ name: 'find_paths', arguments: { pattern: 'index.ts' } }],
    [{ name: 'read_file', arguments: { relative_path: 'src/index.ts' } }],
  ]);
  assert.equal(outcome.status, 'COMPLETED', JSON.stringify(outcome));
  assert.ok(outcome.assistCalls >= 4,
    `一条主流程应有多次模型调用（3 轮工具 + 收尾），实际 ${outcome.assistCalls}`);
  assert.equal(outcome.interpretCalls, 0,
    '主流程下普通读取不得再经过独立的执行解释模型入口');
  const rows = await new SessionToolCallRepository(app.db).listBySession(fx.sessionId);
  assert.deepEqual(rows.map((row) => row.tool_name),
    ['list_directory', 'find_paths', 'read_file']);
  assert.ok(rows.every((row) => row.status === 'SETTLED'),
    JSON.stringify(rows.map((row) => ({ tool: row.tool_name, status: row.status }))));
  // 提示词不得再声明「本轮不自己调用工具」或否认读取能力。
  const system = outcome.systemPrompts[0] ?? '';
  assert.ok(!system.includes('本轮你只生成对话回复，不自己调用工具'),
    '声明了只读工具的轮次不得套用「不自己调用工具」的旧边界：' + system.slice(0, 200));
});

// ------------------------------------------------------------------------- AM-03

test('AM-03 目录来自服务端持久绑定；同项目多个受管资源时不取第一项', async () => {
  const fx = await fixture({ extraRoot: true });
  // 会话绑定的是 fx.canonicalRoot；同项目另有第二个 ACTIVE 受管资源。
  const resources = (await createRepositories(app.db).gateway.listResources())
    .filter((row) => row.workspace_id === fx.workspaceId && row.project_id === fx.projectId);
  assert.equal(resources.length, 2, '本用例需要两个受管资源才能证明不取第一项');

  const outcome = await askWithScript(fx, [
    [{ name: 'list_directory', arguments: {} }],
  ]);
  assert.equal(outcome.status, 'COMPLETED', JSON.stringify(outcome));
  const listing = outcome.fedBack.find((item) => item.name === 'list_directory');
  assert.ok((listing?.content ?? '').includes('README.md'));
  assert.ok(!(listing?.content ?? '').includes('OTHER.md'),
    '未绑定到本会话的受管根不得被读到：' + String(listing?.content));

  // 换绑后下一轮立刻按新目录解析，不缓存旧绑定。
  //
  // 目录重绑会按该根建立自己的只读配置；必须读取第二个根，不能复用第一个根的内容。
  const other = resources.find((row) => row.canonical_root !== fx.canonicalRoot)!;
  const opened = await openWorkingDirectory(app.db, { workspaceId: fx.workspaceId,
    commandId: randomUUID(), rootPath: other.canonical_root, projectId: fx.projectId });
  assert.equal(opened.result.status, 'READY');
  assert.equal(opened.result.association?.resource_id, other.id);
  await bindAssistSessionDirectory(app.db, { workspaceId: fx.workspaceId,
    sessionId: fx.sessionId, commandId: randomUUID(), resourceId: other.id });
  const rebound = await askWithScript(fx, [[{ name: 'list_directory', arguments: {} }]]);
  assert.equal(rebound.status, 'COMPLETED', JSON.stringify(rebound));
  const reboundListing = rebound.fedBack.find((item) => item.name === 'list_directory');
  assert.ok((reboundListing?.content ?? '').includes('OTHER.md'),
    '目录重绑后应读取新根：' + String(reboundListing?.content));
  assert.ok(!(reboundListing?.content ?? '').includes('README.md'),
    '换绑后不得继续读上一个根：' + String(reboundListing?.content));
  const reboundRows = await new SessionToolCallRepository(app.db).listBySession(fx.sessionId);
  const lastRow = reboundRows.at(-1);
  assert.equal(lastRow?.status, 'SETTLED',
    '新目录自动配置只读连接后，应通过原会话读取新的根');
  const reboundOperation = await createRepositories(app.db).gateway.readOperation(lastRow!.operation_id!);
  assert.equal(reboundOperation?.resource_id, other.id,
    '第二条读取 Operation 必须绑定新目录的受管资源');
});

test('AM-03 未绑定目录的会话按类型化原因拒掉本次读取，不回落到「取第一个资源」', async () => {
  const fx = await fixture({ bind: false });
  const outcome = await askWithScript(fx, [
    [{ name: 'list_directory', arguments: {} }],
    [{ name: 'read_file', arguments: { relative_path: 'README.md' } }],
  ]);
  // 项目有文件连接，所以**读取能力是可见的**——可见性与准入分离（AM-04）。真正缺的是
  // 这段会话没选定目录，因此每次请求按类型化原因拒掉并留在账本上，而不是任取一个资源。
  const rows = await new SessionToolCallRepository(app.db).listBySession(fx.sessionId);
  assert.ok(rows.length > 0, '工具请求必须留痕，而不是静默丢弃');
  assert.ok(rows.every((row) => row.status === 'REJECTED' && row.operation_id === null),
    JSON.stringify(rows.map((row) => ({ tool: row.tool_name, status: row.status,
      reason: row.rejection_reason, operation: row.operation_id }))));
  assert.ok(rows.every((row) => row.rejection_reason ===
    'AGENT_SESSION_HAS_NO_WORKING_DIRECTORY'),
  JSON.stringify(rows.map((row) => row.rejection_reason)));
  assert.ok(['COMPLETED', 'FAILED'].includes(outcome.status));
  assert.ok(outcome.declaredTools.includes('list_directory'),
    '能力存在时词表仍应可见：' + JSON.stringify(outcome.declaredTools));
  // 关键：拒掉的理由里必须出现「先选择目录」，而不是任何关于「系统没有读取能力」的说法。
  const refusal = rows[0]?.rejection_detail ?? '';
  assert.match(refusal, /请先选择目录/u);
});

// ------------------------------------------------------------------------- AM-04

test('AM-04 普通会话请求写工具被类型化拒绝，不连 Operation、不产生写能力动作', async () => {
  const fx = await fixture();
  const before_ = await readFile(join(fx.root, 'src', 'index.ts'), 'utf8');
  const outcome = await ask(fx, '把 src/index.ts 改成 false',
    scriptedPort([[{ name: 'apply_changeset', arguments: { changes: [{ path: 'src/index.ts',
      action: 'MODIFY', baselineSha256: 'a'.repeat(64),
      content: 'export const relay = false;\n' }] } }]],
    (round) => ({ kind: 'CONTENT', content: '（stub）这一步需要人工发起。',
      providerRequestId: `stub-r${round}`,
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: null,
        cacheCreationTokens: null } })));
  assert.equal(outcome.status, 'COMPLETED', JSON.stringify(outcome));
  const rows = await new SessionToolCallRepository(app.db).listBySession(fx.sessionId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.status, 'REJECTED');
  assert.equal(rows[0]?.rejection_reason, 'TOOL_NOT_READ_ONLY');
  assert.equal(rows[0]?.operation_id, null);
  assert.equal(await countProjectRows('logical_operations', fx.projectId), 0);
  assert.equal(await countProjectRows('tasks', fx.projectId), 0);
  assert.equal(await countRunsOfProject(fx.projectId), 0);
  assert.equal(await readFile(join(fx.root, 'src', 'index.ts'), 'utf8'), before_);
});

test('AM-04 会话读取身份可分辨：普通 AGENT 的行不能指向人设助手的 Operation', async () => {
  const fx = await fixture();
  await askWithScript(fx, [[{ name: 'list_directory', arguments: {} }]]);
  const repository = new SessionToolCallRepository(app.db);
  const rows = await repository.listBySession(fx.sessionId);
  const settled = rows.find((row) => row.operation_id !== null);
  assert.ok(settled !== undefined, '本用例需要一次成功读取');

  // 产生的 Operation 来源必须是普通会话自己的身份，而不是人设助手。
  const operations = (await sql<{ origin: string; capability_key: string }>`
    select origin, capability_key from logical_operations
    where id = ${settled.operation_id}`.execute(app.db)).rows;
  assert.equal(operations[0]?.origin, 'AGENT_SESSION_READ');
  assert.ok(['FILE_READ', 'FILE_QUERY', 'GIT_READ'].includes(operations[0]?.capability_key ?? ''));
  // 仓库方法按来源过滤：不存在的 Operation 与别的来源的 Operation 都绑不上。
  assert.equal(await repository.attachOperation(settled.id, randomUUID(), 'AGENT_SESSION_READ'), false);
});

// ---------------------------------------------------------------------- AM-08/09

test('AM-08 绑定命令按原 command_id 重放拿回原回执，且不产生第二个绑定', async () => {
  const fx = await fixture({ bind: false });
  const resourceId = (await createRepositories(app.db).gateway.listResources())
    .find((row) => row.workspace_id === fx.workspaceId && row.project_id === fx.projectId)!.id;
  const commandId = randomUUID();
  const first = await bindAssistSessionDirectory(app.db, { workspaceId: fx.workspaceId,
    sessionId: fx.sessionId, commandId, resourceId });
  const second = await bindAssistSessionDirectory(app.db, { workspaceId: fx.workspaceId,
    sessionId: fx.sessionId, commandId, resourceId });
  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.equal(second.result.session_id, first.result.session_id);
  assert.equal(second.result.working_resource_id, first.result.working_resource_id);
  const session = await createRepositories(app.db).assist.readSession(fx.sessionId);
  assert.equal(session?.working_resource_id, resourceId);
});

test('AM-09 取消先于领取时本轮根本不启动：消息按 CANCELLED 收口，且零工具读取', async () => {
  const fx = await fixture();
  const storage = new ManagedContentStore(dataRoot);
  const port = scriptedPort([[{ name: 'list_directory', arguments: {} }]],
    (round) => ({ kind: 'CONTENT', content: '（stub）不该到这里。',
      providerRequestId: `stub-r${round}`,
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: null,
        cacheCreationTokens: null } }));
  const sent = await requestAssistMessage(app.db, { workspaceId: fx.workspaceId,
    sessionId: fx.sessionId, commandId: randomUUID(), content: '看一下这个目录下面的文件' });
  // 在 Worker 领取前持久化取消意图：沿既有 cancel_requested 通道，本轮不新增停止资源。
  // PENDING 消息被取消后直接收敛，因此这一轮**不该**被任何 Worker 领取。
  await cancelAssistMessage(app.db, { workspaceId: fx.workspaceId,
    commandId: randomUUID(), messageId: sent.result.assistant_message_id });
  const outcome = await runAssistGenerationTick(app.db, { workerId: `main-loop-${randomUUID()}`,
    storage, modelPort: port, leaseMs: 60_000, maxMessages: 1 });
  assert.equal(outcome, undefined,
    '已取消的消息不得被领取：' + JSON.stringify(outcome ?? null));
  const message = await createRepositories(app.db).assist.readMessage(
    sent.result.assistant_message_id);
  assert.equal(message?.status, 'CANCELLED');
  assert.equal(message?.cancel_requested, true);
  const rows = await new SessionToolCallRepository(app.db).listBySession(fx.sessionId);
  assert.equal(rows.length, 0, '取消后不得再派发工具读取');
  assert.equal(await countProjectRows('logical_operations', fx.projectId), 0);
});
