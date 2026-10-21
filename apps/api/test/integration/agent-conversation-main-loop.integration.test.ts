import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'kysely';
import test, { after, before } from 'node:test';

import { createAssistSession, bindAssistSessionDirectory, cancelAssistMessage,
  requestAssistMessage, steerAssistMessage } from '../../src/application/assist-commands.js';
import { listAssistMessages } from '../../src/application/assist-queries.js';
import { runAssistGenerationTick } from '../../src/application/assist-runner.js';
import { runSessionReadonlyRounds } from '../../src/application/assistant-readonly-round.js';
import { createGatewayPolicy, registerManagedResource } from
  '../../src/application/gateway-configuration.js';
import { openWorkingDirectory } from '../../src/application/open-working-directory.js';
import { readWorkspaceDefaultDirectory, setWorkspaceDefaultDirectory }
  from '../../src/application/workspace-default-directory.js';
import { createRepositories, withTransaction } from '../../src/application/unit-of-work.js';
import { SessionToolCallRepository } from '../../src/assist/session-tool-call-repository.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { ManagedContentStore } from '../../src/storage/managed-content-store.js';
import { FakeModelPort, type AssistModelPort, type AssistResult } from
  '../../src/workflow/fake-model-port.js';
import { ModelCallBudgetError } from '../../src/workflow/openai-compatible-model-port.js';
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
  /** Provider 传输类别：MODEL_FAILED 必须能归因，不许只剩一个 MODEL_FAILED。 */
  readonly providerErrorKind: string | null;
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
    providerErrorKind: message?.provider_error_kind ?? null,
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

test('DD-03/06 默认目录在创建时绑定，首轮真实读取文件且不提升写权限', async () => {
  const original = await fixture({ bind: false });
  const repositories = createRepositories(app.db);
  const resource = (await repositories.gateway.listResources()).find((r) =>
    r.workspace_id === original.workspaceId && r.canonical_root === original.canonicalRoot);
  assert.ok(resource);
  assert.equal(await repositories.gateway.readLocalDirectoryAccess(resource.id), undefined);
  await setWorkspaceDefaultDirectory(app.db, { workspaceId: original.workspaceId,
    commandId: randomUUID(), resourceId: resource.id, expectedRevision: '0' });
  assert.equal((await readWorkspaceDefaultDirectory(app.db, original.workspaceId)).write_tier, 'READ_ONLY');
  const created = await createAssistSession(app.db, { workspaceId: original.workspaceId,
    commandId: randomUUID(), title: 'default scope' });
  const fx = { ...original, sessionId: created.result.session_id };
  const before = await readFile(join(fx.root, 'README.md'), 'utf8');
  const outcome = await askWithScript(fx, [
    [{ name: 'list_directory', arguments: {} }],
    [{ name: 'read_file', arguments: { relative_path: 'README.md' } }],
  ]);
  assert.equal(outcome.status, 'COMPLETED', JSON.stringify(outcome));
  assert.ok(outcome.fedBack.some((item) => item.name === 'read_file' && item.content.includes(fx.marker)));
  assert.equal((await repositories.assist.readSession(fx.sessionId))?.working_directory_source, 'WORKSPACE_DEFAULT');
  assert.equal((await repositories.assist.readSession(original.sessionId))?.working_resource_id, null);
  assert.equal(await repositories.gateway.readLocalDirectoryAccess(resource.id), undefined,
    'config and creation do not create permission metadata');
  assert.equal(await countRunsOfProject(fx.projectId), 0);
  assert.equal(await countProjectRows('tasks', fx.projectId), 0);
  assert.equal(await readFile(join(fx.root, 'README.md'), 'utf8'), before);
  assert.ok(!outcome.declaredTools.includes('apply_changeset'));
});

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
  // 0128：根会话的普通 Agent 主流程额外声明 delegate_subagent——它是应用内动作
  // （子 Agent 只读轮次），不接 Gateway、不写盘，因此下面那条「不得出现写工具」的
  // 断言仍然成立；词表里多出它是 0128 的既定接线，不是本用例放宽只读边界。
  assert.deepEqual(outcome.declaredTools,
    ['list_directory', 'find_paths', 'search_text', 'read_file', 'delegate_subagent'],
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

// ---------------------------------------------------------------- 0122 插话

test('0122 插话：排队消息在下一轮模型请求前并入当前回复，不另起一轮', async () => {
  const fx = await fixture();
  const queuedText = '先别改 README，先看 src 里有什么';
  const seen: { steers: readonly string[]; toolTurns: number }[] = [];
  let queuedId: string | null = null;
  let round = 0;
  const port: AssistModelPort = {
    identity: new FakeModelPort().identity,
    assist: async (request) => {
      seen.push({ steers: [...(request.steers ?? [])],
        toolTurns: request.toolTurns?.length ?? 0 });
      round += 1;
      if (round === 1) {
        // 在途期间：用户又发一条（排队），再按一次回车请求插话。
        const sent = await requestAssistMessage(app.db, { workspaceId: fx.workspaceId,
          sessionId: fx.sessionId, commandId: randomUUID(), content: queuedText });
        queuedId = sent.result.assistant_message_id;
        const steered = await steerAssistMessage(app.db, { workspaceId: fx.workspaceId,
          messageId: queuedId, commandId: randomUUID() });
        assert.equal(steered.result.status, 'STEER_REQUESTED');
        return { kind: 'TOOL_CALLS',
          calls: [{ providerToolCallId: 'stub-1', name: 'list_directory', arguments: {} }],
          preamble: '', providerRequestId: 'stub-r1',
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: null,
            cacheCreationTokens: null } };
      }
      return { kind: 'CONTENT', content: '已经按插话调整。', providerRequestId: `stub-r${round}`,
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: null,
          cacheCreationTokens: null } };
    },
  };
  const outcome = await ask(fx, '看一下这个目录', port);
  assert.equal(outcome.status, 'COMPLETED');
  assert.equal(outcome.assistCalls, 2, '插话让这一轮多跑一步，而不是另起一轮');
  // 第一轮还没有插话；第二轮同时拿到工具轮次与插话（插话排在工具轮次之后）。
  assert.deepEqual(seen[0]?.steers, []);
  assert.deepEqual(seen[1]?.steers, [queuedText]);
  assert.ok((seen[1]?.toolTurns ?? 0) > 0, '工具结果没有被插话挤掉');
  assert.equal((await new SessionToolCallRepository(app.db).listBySession(fx.sessionId)).length,
    0, '模型请求期间到达插话后，旧工具尚未派发，必须先重新判断方向');
  assert.equal(await countProjectRows('logical_operations', fx.projectId), 0,
    '被新输入打断的工具不得进入 Gateway');

  // 排队那条被收口为 CANCELLED + STEERED：它不再自己生成回复。
  assert.ok(queuedId !== null);
  const row = await createRepositories(app.db).assist.readMessage(queuedId);
  assert.equal(row?.status, 'CANCELLED');
  assert.equal(row?.error_code, 'STEERED');
  assert.equal(row?.steer_requested, true);
  // 它不出现在消息列表里（没有回复的占位行），用户原文仍在——那是真实发过的一条。
  const messages = await listAssistMessages(app.db, { workspaceId: fx.workspaceId,
    sessionId: fx.sessionId });
  assert.equal(messages.some((item) => item.id === queuedId), false);
  assert.equal(messages.some((item) => item.role === 'USER' && item.content === queuedText), true);
  // 这一轮只有一条 ASSISTANT 回复（插话没有生成第二条）。
  assert.equal(messages.filter((item) => item.role === 'ASSISTANT' && item.status === 'COMPLETED')
    .length, 1);
});

test('0122 插话只接受排队中的消息：没有在途回复时明确拒绝，不改投递方式', async () => {
  const fx = await fixture();
  const sent = await requestAssistMessage(app.db, { workspaceId: fx.workspaceId,
    sessionId: fx.sessionId, commandId: randomUUID(), content: '一条还没开始的消息' });
  // 还没领取：这条自己就是唯一的 PENDING，会话里没有 RUNNING。
  await assert.rejects(steerAssistMessage(app.db, { workspaceId: fx.workspaceId,
    messageId: sent.result.assistant_message_id, commandId: randomUUID() }),
  /没有正在生成的回复/u);
  const row = await createRepositories(app.db).assist.readMessage(
    sent.result.assistant_message_id);
  assert.equal(row?.status, 'PENDING');
  assert.equal(row?.steer_requested, false);
  // 收尾：这条仍是 PENDING，留着会被后续用例的 tick 领取，污染别的断言。
  await cancelAssistMessage(app.db, { workspaceId: fx.workspaceId, commandId: randomUUID(),
    messageId: sent.result.assistant_message_id });
});

test('连续插话：相关补充与最终换目标的全部原文按序交给同一轮判断', async () => {
  const fx = await fixture();
  const texts = ['支持手机号', '验证码也要', '登录先不做了', '只分析启动失败，先不要修改'];
  let round = 0;
  const port: AssistModelPort = { identity: new FakeModelPort().identity,
    assist: async (request) => {
      round += 1;
      if (round === 1) {
        for (const content of texts) {
          const queued = await requestAssistMessage(app.db, { workspaceId: fx.workspaceId,
            sessionId: fx.sessionId, commandId: randomUUID(), content });
          await steerAssistMessage(app.db, { workspaceId: fx.workspaceId,
            messageId: queued.result.assistant_message_id, commandId: randomUUID() });
        }
      } else {
        assert.deepEqual(request.steers, texts);
        assert.match(request.system, /USER_STEERING_V1/u);
        assert.match(request.system, /后来的修正只替代冲突部分/u);
        assert.match(request.system, /临时提问和进度询问先回答/u);
        assert.match(request.system, /必须沿既有领域入口处理/u);
        assert.match(request.system, /正在执行的正式 Run 不受聊天改向影响/u,
          '插话规则必须写明正式 Run 的覆盖范围，防止模型承诺已停止 Run');
      }
      return { kind: 'CONTENT', content: '测试端口答复', providerRequestId: `batch-${round}`,
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: null, cacheCreationTokens: null } };
    } };
  const result = await ask(fx, '做登录页', port);
  assert.equal(result.status, 'COMPLETED');
  assert.equal(round, 2);
  const messages = await listAssistMessages(app.db,
    { workspaceId: fx.workspaceId, sessionId: fx.sessionId });
  assert.deepEqual(messages.filter((item) => item.role === 'USER').map((item) => item.content),
    ['做登录页', ...texts]);
  assert.equal(messages.filter((item) => item.role === 'ASSISTANT').length, 1);
  assert.equal(await countProjectRows('tasks', fx.projectId), 0, '插话不直接改正式任务');
});

test('跨轮连续插话：早先要求留在其工具之前，后到要求不挤掉真实结果', async () => {
  const fx = await fixture();
  const first = '先读 README';
  const last = '不用列目录了，只解释刚才读到的内容';
  let round = 0;
  const enqueue = async (content: string) => {
    const queued = await requestAssistMessage(app.db, { workspaceId: fx.workspaceId,
      sessionId: fx.sessionId, commandId: randomUUID(), content });
    await steerAssistMessage(app.db, { workspaceId: fx.workspaceId,
      messageId: queued.result.assistant_message_id, commandId: randomUUID() });
  };
  const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: null, cacheCreationTokens: null };
  const port: AssistModelPort = { identity: new FakeModelPort().identity,
    assist: async (request) => {
      round += 1;
      if (round === 1) {
        await enqueue(first);
        return { kind: 'CONTENT', content: '尚未结算的中间正文', providerRequestId: 'order-1', usage };
      }
      if (round === 2) {
        assert.deepEqual(request.steers, [first]);
        return { kind: 'TOOL_CALLS', calls: [{ providerToolCallId: 'order-read', name: 'read_file',
          arguments: { relative_path: 'README.md' } }], preamble: '', providerRequestId: 'order-2', usage };
      }
      assert.equal(request.steers?.includes(first) ?? false, false, '旧插话不重新移动到末尾');
      assert.deepEqual(request.toolTurns?.[0]?.steersBefore, [first]);
      assert.match(request.toolTurns?.[0]?.results[0]?.content ?? '', new RegExp(fx.marker));
      assert.match(request.system, /USER_STEERING_V1/u, '旧插话归入工具后仍保留理解规则');
      if (round === 3) {
        await enqueue(last);
        return { kind: 'TOOL_CALLS', calls: [{ providerToolCallId: 'order-list',
          name: 'list_directory', arguments: {} }], preamble: '', providerRequestId: 'order-3', usage };
      }
      assert.deepEqual(request.steers, [last]);
      assert.equal(JSON.parse(request.toolTurns?.[1]?.results[0]?.content ?? '{}').status, 'NOT_EXECUTED');
      return { kind: 'CONTENT', content: '完成时序测试', providerRequestId: 'order-4', usage };
    } };
  const result = await ask(fx, '检查项目', port);
  assert.equal(result.status, 'COMPLETED');
  assert.equal(round, 4);
  assert.equal((await new SessionToolCallRepository(app.db).listBySession(fx.sessionId)).length, 1);
  assert.equal(await countProjectRows('logical_operations', fx.projectId), 1);
});

for (const maxRounds of [0, 1]) {
  test(`工具之间到达插话：保留已执行结果并停止剩余动作；maxRounds=${maxRounds}`, async () => {
    const fx = await fixture();
    const repository = createRepositories(app.db).assist;
    const sent = await requestAssistMessage(app.db, { workspaceId: fx.workspaceId,
      sessionId: fx.sessionId, commandId: randomUUID(), content: '读文件，然后列目录' });
    const workerId = `between-tools-${randomUUID()}`;
    const message = await repository.claimNextPendingMessage(workerId);
    assert.equal(message?.id, sent.result.assistant_message_id);
    assert.ok(message !== undefined);
    const session = await repository.readSession(fx.sessionId);
    assert.ok(session !== undefined && session.working_resource_id !== null);
    let drains = 0;
    let round = 0;
    let queuedId: string | undefined;
    const port: AssistModelPort = { identity: new FakeModelPort().identity,
      assist: async (request) => {
        round += 1;
        if (maxRounds === 1 && round === 1) {
          return { kind: 'TOOL_CALLS', calls: [
            { providerToolCallId: 'already-read', name: 'read_file',
              arguments: { relative_path: 'README.md' } },
            { providerToolCallId: 'not-listed', name: 'list_directory', arguments: {} },
          ], preamble: '', providerRequestId: 'between-1',
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: null, cacheCreationTokens: null } };
        }
        if (maxRounds === 1) {
          const results = request.toolTurns?.[0]?.results;
          assert.match(results?.[0]?.content ?? '', new RegExp(fx.marker));
          assert.equal(results?.[0]?.isError, false);
          assert.equal(JSON.parse(results?.[1]?.content ?? '{}').reason, 'NEW_USER_INPUT');
          assert.deepEqual(request.steers, ['不用列目录了，先解释刚才读到的内容']);
          assert.deepEqual(request.tools, [], '最后一次模型请求收尾，不追加工具预算');
        }
        return { kind: 'CONTENT', content: '完成本轮测试', providerRequestId: `between-${round}`,
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: null, cacheCreationTokens: null } };
      } };
    if (maxRounds === 0) {
      const queued = await requestAssistMessage(app.db, { workspaceId: fx.workspaceId,
        sessionId: fx.sessionId, commandId: randomUUID(), content: '迟到的要求' });
      queuedId = queued.result.assistant_message_id;
      await steerAssistMessage(app.db, { workspaceId: fx.workspaceId,
        messageId: queuedId, commandId: randomUUID() });
    }
    const outcome = await runSessionReadonlyRounds(app.db, { session, message,
      availableTools: ['read_file', 'list_directory'], system: 'TEST',
      contextTurns: [{ role: 'user', content: '读文件，然后列目录' }],
      modelPort: port, signal: new AbortController().signal, maxRounds,
      resolveOrigin: async () => ({ ok: true, canonicalRoot: fx.canonicalRoot,
        origin: { kind: 'AGENT_SESSION_READ', projectId: fx.projectId,
          resourceId: session.working_resource_id!, sessionId: session.id, messageId: message.id } }),
      drainSteers: async () => {
        drains += 1;
        if (drains === 3) {
          // 第一次请求前、首个工具前均无插话；首个工具完成后才到达。
          const queued = await requestAssistMessage(app.db, { workspaceId: fx.workspaceId,
            sessionId: fx.sessionId, commandId: randomUUID(),
            content: '不用列目录了，先解释刚才读到的内容' });
          queuedId = queued.result.assistant_message_id;
          await steerAssistMessage(app.db, { workspaceId: fx.workspaceId,
            messageId: queuedId, commandId: randomUUID() });
        }
        return repository.drainSteerRequests(session.id, message.seq);
      } });
    assert.equal(outcome.kind, 'CONTENT');
    const toolRows = await new SessionToolCallRepository(app.db).listBySession(fx.sessionId);
    assert.equal(toolRows.length, maxRounds === 1 ? 1 : 0);
    assert.equal(await countProjectRows('logical_operations', fx.projectId), maxRounds === 1 ? 1 : 0);
    assert.ok(queuedId !== undefined);
    assert.equal((await repository.readMessage(queuedId))?.status,
      maxRounds === 1 ? 'CANCELLED' : 'PENDING');
    if (maxRounds === 0) {
      assert.equal(drains, 0, '收尾不消费无法在后续请求处理的插话');
      await cancelAssistMessage(app.db, { workspaceId: fx.workspaceId,
        messageId: queuedId, commandId: randomUUID() });
    }
    await repository.settleGeneration({ messageId: message.id, workerId, status: 'COMPLETED',
      content: '完成本轮测试', errorCode: null, providerRequestId: null,
      usageInputTokens: null, usageOutputTokens: null });
  });
}

// ------------------------------------------------------- 0122 插话：失败与恢复窗口

test('消费插话后模型失败：不静默丢失要求，恢复轮上下文仍能看到原文', async () => {
  const fx = await fixture();
  const queuedText = '先加手机号支持，其他不变';
  let round = 0;
  let queuedId: string | null = null;
  const failingPort: AssistModelPort = { identity: new FakeModelPort().identity,
    assist: async () => {
      round += 1;
      if (round === 1) {
        // 在途期间排队一条并请求插话；本轮先给正文（结算前会被消费），随后下一次请求失败。
        const queued = await requestAssistMessage(app.db, { workspaceId: fx.workspaceId,
          sessionId: fx.sessionId, commandId: randomUUID(), content: queuedText });
        queuedId = queued.result.assistant_message_id;
        await steerAssistMessage(app.db, { workspaceId: fx.workspaceId,
          messageId: queuedId, commandId: randomUUID() });
        return { kind: 'CONTENT', content: '尚未结算的中间正文', providerRequestId: 'fail-1',
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: null,
            cacheCreationTokens: null } };
      }
      // 插话已在正文结算前消费，第二次请求在这里失败：FAILED 不能把它静默抹掉。
      throw new Error('provider unavailable');
    } };
  const failed = await ask(fx, '做登录页', failingPort);
  assert.equal(failed.status, 'FAILED');
  assert.equal(failed.content, null, '失败的中间正文不落库');
  assert.ok(queuedId !== null);
  const repositories = createRepositories(app.db);
  const queuedRow = await repositories.assist.readMessage(queuedId);
  assert.equal(queuedRow?.status, 'CANCELLED', '已消费的插话行已收口，不再排队');
  assert.equal(queuedRow?.error_code, 'STEERED');
  const messages = await listAssistMessages(app.db, { workspaceId: fx.workspaceId,
    sessionId: fx.sessionId });
  assert.equal(messages.some((item) => item.role === 'USER' && item.content === queuedText), true,
    '用户原文保留在转录区');
  // 恢复事实：新消息的上下文构建仍能读到原要求与被消费插话的原文（用户重发即可接续）。
  let recoveryTurns: readonly string[] = [];
  const recoveryPort: AssistModelPort = { identity: new FakeModelPort().identity,
    assist: async (request) => {
      recoveryTurns = request.turns.map((turn) => turn.content);
      return { kind: 'CONTENT', content: '恢复答复', providerRequestId: 'recover-1',
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: null,
          cacheCreationTokens: null } };
    } };
  const recovered = await ask(fx, '继续', recoveryPort);
  assert.equal(recovered.status, 'COMPLETED');
  assert.ok(recoveryTurns.some((content) => content.includes('做登录页')), '原要求在恢复轮上下文');
  assert.ok(recoveryTurns.some((content) => content.includes(queuedText)),
    '被消费插话的原文在恢复轮上下文');
  // 占位行不复活：恢复轮的列表里没有第二条 STEERED/CANCELLED 占位。
  const after = await listAssistMessages(app.db, { workspaceId: fx.workspaceId,
    sessionId: fx.sessionId });
  assert.equal(after.some((item) => item.id === queuedId), false);
});

test('消费插话后模型失败带 Provider 类别：MODEL_FAILED 不是唯一的失败事实', async () => {
  const fx = await fixture();
  const queuedText = '先只改文案，不要动样式';
  let round = 0;
  let queuedId: string | null = null;
  const transportFailingPort: AssistModelPort = { identity: new FakeModelPort().identity,
    assist: async () => {
      round += 1;
      if (round === 1) {
        const queued = await requestAssistMessage(app.db, { workspaceId: fx.workspaceId,
          sessionId: fx.sessionId, commandId: randomUUID(), content: queuedText });
        queuedId = queued.result.assistant_message_id;
        await steerAssistMessage(app.db, { workspaceId: fx.workspaceId,
          messageId: queuedId, commandId: randomUUID() });
        return { kind: 'CONTENT', content: '尚未结算的中间正文', providerRequestId: 'kind-1',
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: null,
            cacheCreationTokens: null } };
      }
      // undici 的形态：TypeError('fetch failed')。它是 Provider 传输层失败，
      // 与「本模块代码抛错」必须是两条可分辨的事实。
      throw new TypeError('fetch failed');
    } };
  const failed = await ask(fx, '做登录页', transportFailingPort);
  assert.equal(failed.status, 'FAILED');
  assert.equal(failed.errorCode, 'MODEL_FAILED');
  assert.equal(failed.providerErrorKind, 'NETWORK',
    '会话轮次里的 Provider 传输失败必须留下类别，否则排查只能猜');
  assert.ok(queuedId !== null);
  const queuedRow = await createRepositories(app.db).assist.readMessage(queuedId);
  assert.equal(queuedRow?.status, 'CANCELLED');
  assert.equal(queuedRow?.error_code, 'STEERED', '有类别也不能把已消费的插话算成没消费');
});

test('消费插话后取消：本轮按 CANCELLED 收口，已消费插话不复活且原文保留', async () => {
  const fx = await fixture();
  const repository = createRepositories(app.db).assist;
  const sent = await requestAssistMessage(app.db, { workspaceId: fx.workspaceId,
    sessionId: fx.sessionId, commandId: randomUUID(), content: '做登录页' });
  const workerId = `steer-cancel-${randomUUID()}`;
  const message = await repository.claimNextPendingMessage(workerId);
  assert.ok(message !== undefined);
  const session = await repository.readSession(fx.sessionId);
  assert.ok(session !== undefined && session.working_resource_id !== null);
  const queuedText = '支持手机号登录';
  let drains = 0;
  let queuedId: string | undefined;
  let rounds = 0;
  const port: AssistModelPort = { identity: new FakeModelPort().identity,
    assist: async () => {
      rounds += 1;
      return { kind: 'CONTENT', content: `中间正文 ${rounds}`, providerRequestId: `r${rounds}`,
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: null,
          cacheCreationTokens: null } };
    } };
  const outcome = await runSessionReadonlyRounds(app.db, { session, message,
    availableTools: ['read_file'], system: 'TEST',
    contextTurns: [{ role: 'user', content: '做登录页' }],
    modelPort: port, signal: new AbortController().signal,
    resolveOrigin: async () => ({ ok: true, canonicalRoot: fx.canonicalRoot,
      origin: { kind: 'AGENT_SESSION_READ', projectId: fx.projectId,
        resourceId: session.working_resource_id!, sessionId: session.id, messageId: message.id } }),
    drainSteers: async () => {
      drains += 1;
      if (drains === 2) {
        // 第一次是首个请求前（无插话）；这里是正文结算前：插入插话并立即请求取消当前轮。
        const queued = await requestAssistMessage(app.db, { workspaceId: fx.workspaceId,
          sessionId: fx.sessionId, commandId: randomUUID(), content: queuedText });
        queuedId = queued.result.assistant_message_id;
        await steerAssistMessage(app.db, { workspaceId: fx.workspaceId,
          messageId: queuedId, commandId: randomUUID() });
        await cancelAssistMessage(app.db, { workspaceId: fx.workspaceId,
          messageId: message.id, commandId: randomUUID() });
      }
      return repository.drainSteerRequests(session.id, message.seq);
    } });
  assert.equal(outcome.kind, 'CANCELLED', '取消在下一轮请求前生效，不产出正文');
  assert.equal(rounds, 1, '取消后不再发起第二次模型请求');
  assert.ok(queuedId !== undefined);
  const queuedRow = await repository.readMessage(queuedId);
  assert.equal(queuedRow?.status, 'CANCELLED', '已消费的插话行保持收口，不因取消复活');
  assert.equal(queuedRow?.error_code, 'STEERED');
  const messages = await listAssistMessages(app.db, { workspaceId: fx.workspaceId,
    sessionId: fx.sessionId });
  assert.equal(messages.some((item) => item.role === 'USER' && item.content === queuedText), true,
    '用户原文保留');
  assert.equal((await new SessionToolCallRepository(app.db).listBySession(fx.sessionId)).length, 0);
  await repository.settleGeneration({ messageId: message.id, workerId, status: 'CANCELLED',
    content: null, errorCode: null, providerRequestId: null,
    usageInputTokens: null, usageOutputTokens: null });
});

test('消费插话后 Worker 崩溃：租约收口 LEASE_LOST，不自动重生，恢复轮读到原文', async () => {
  const fx = await fixture();
  const repository = createRepositories(app.db).assist;
  const sent = await requestAssistMessage(app.db, { workspaceId: fx.workspaceId,
    sessionId: fx.sessionId, commandId: randomUUID(), content: '做登录页' });
  const workerId = `steer-crash-${randomUUID()}`;
  const message = await repository.claimNextPendingMessage(workerId);
  assert.ok(message !== undefined);
  const queuedText = '先加手机号支持';
  // 排队一条并请求插话，再由生成方消费——随后进程崩溃（不结算、不心跳）。
  const queued = await requestAssistMessage(app.db, { workspaceId: fx.workspaceId,
    sessionId: fx.sessionId, commandId: randomUUID(), content: queuedText });
  await steerAssistMessage(app.db, { workspaceId: fx.workspaceId,
    messageId: queued.result.assistant_message_id, commandId: randomUUID() });
  const drained = await repository.drainSteerRequests(fx.sessionId, message.seq);
  assert.deepEqual(drained.map((item) => item.content), [queuedText], '插话已被生成方消费');
  // 崩溃后的清扫：租约过期把 RUNNING 收口为 FAILED/LEASE_LOST。
  const expired = await repository.failExpiredLeases(new Date(Date.now() + 60_000));
  assert.ok(expired.includes(message.id), '失联的生成必须被收口');
  const failed = await repository.readMessage(message.id);
  assert.equal(failed?.status, 'FAILED');
  assert.equal(failed?.error_code, 'LEASE_LOST');
  assert.equal(failed?.worker_id, null, '失联 Worker 的身份必须清除');
  // 已消费的插话行保持收口，不会因崩溃复活成排队消息。
  const queuedRow = await repository.readMessage(queued.result.assistant_message_id);
  assert.equal(queuedRow?.status, 'CANCELLED');
  assert.equal(queuedRow?.error_code, 'STEERED');
  // 崩溃 Worker 的迟到结算被 CAS 拒绝，不能覆盖 LEASE_LOST。
  assert.equal(await repository.settleGeneration({ messageId: message.id, workerId,
    status: 'COMPLETED', content: '迟到的正文', errorCode: null, providerRequestId: null,
    usageInputTokens: null, usageOutputTokens: null }), false);
  // 恢复事实：新消息的上下文里同时有原要求与插话原文。
  const seen: string[] = [];
  const port: AssistModelPort = { identity: new FakeModelPort().identity,
    assist: async (request) => {
      seen.push(...request.turns.map((turn) => turn.content));
      return { kind: 'CONTENT', content: '恢复答复', providerRequestId: 'recover',
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: null,
          cacheCreationTokens: null } };
    } };
  const recovered = await ask(fx, '继续', port);
  assert.equal(recovered.status, 'COMPLETED');
  assert.ok(seen.some((content) => content.includes('做登录页')), '原要求在恢复轮上下文');
  assert.ok(seen.some((content) => content.includes(queuedText)), '插话原文在恢复轮上下文');
});

test('连续插话期间预算耗尽：FAILED 带类型化原因，原文保留可恢复', async () => {
  const fx = await fixture();
  const queuedText = '先加手机号支持';
  let round = 0;
  let queuedId: string | null = null;
  const failingPort: AssistModelPort = { identity: new FakeModelPort().identity,
    assist: async () => {
      round += 1;
      if (round === 1) {
        const queued = await requestAssistMessage(app.db, { workspaceId: fx.workspaceId,
          sessionId: fx.sessionId, commandId: randomUUID(), content: queuedText });
        queuedId = queued.result.assistant_message_id;
        await steerAssistMessage(app.db, { workspaceId: fx.workspaceId,
          messageId: queuedId, commandId: randomUUID() });
        return { kind: 'CONTENT', content: '尚未结算的中间正文', providerRequestId: 'budget-1',
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: null,
            cacheCreationTokens: null } };
      }
      // 插话已在正文结算前消费；第二次请求撞上 Provider 端预算上限。
      throw new ModelCallBudgetError('budget-2', { inputTokens: 1, outputTokens: 1,
        cacheReadTokens: null, cacheCreationTokens: null });
    } };
  const failed = await ask(fx, '做登录页', failingPort);
  assert.equal(failed.status, 'FAILED');
  assert.equal(failed.errorCode, 'MODEL_BUDGET_EXHAUSTED', '预算耗尽必须是可判定的类型化原因');
  assert.equal(failed.content, null, '中间正文不落库');
  // 占位行恰好收口一次（列表排除 STEERED 行，直接读该行）。
  assert.ok(queuedId !== null);
  const queuedRow = await createRepositories(app.db).assist.readMessage(queuedId);
  assert.equal(queuedRow?.status, 'CANCELLED');
  assert.equal(queuedRow?.error_code, 'STEERED');
  const messages = await listAssistMessages(app.db, { workspaceId: fx.workspaceId,
    sessionId: fx.sessionId });
  assert.equal(messages.some((item) => item.role === 'USER' && item.content === queuedText), true,
    '预算耗尽不丢用户原文');
  assert.equal(messages.some((item) => item.id === queuedId), false, '占位行不出现在列表');
  // 恢复轮照样能读到原文（与模型失败同一恢复路径）。
  const seen: string[] = [];
  const recoveryPort: AssistModelPort = { identity: new FakeModelPort().identity,
    assist: async (request) => {
      seen.push(...request.turns.map((turn) => turn.content));
      return { kind: 'CONTENT', content: '恢复答复', providerRequestId: 'recover',
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: null,
          cacheCreationTokens: null } };
    } };
  const recovered = await ask(fx, '继续', recoveryPort);
  assert.equal(recovered.status, 'COMPLETED');
  assert.ok(seen.some((content) => content.includes(queuedText)), '插话原文在恢复轮上下文');
});
