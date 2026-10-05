// Opt-in real-model tool-calling slice. Runs ONLY when RELAY_MODEL_* is fully
// configured; otherwise the whole file is skipped so the standard regression
// never spends tokens or hits the network. The API key stays in the environment;
// nothing here prints or stores it.
//
// This file answers one question the Fake-model suite structurally cannot: does
// the configured provider actually emit tool calls through bindTools, and does
// the model then use the real file bytes it read? Every assertion below is about
// a fact only a real model call can produce.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { sql } from 'kysely';

import { createGatewayPolicy, registerManagedResource } from
  '../../src/application/gateway-configuration.js';
import { createTask } from '../../src/application/create-task.js';
import { delegateTask } from '../../src/application/delegate-task.js';
import { applySafeControl, requestRunControl } from '../../src/application/control-requests.js';
import { advanceRunStep } from '../../src/application/run-steps.js';
import { markTaskReady } from '../../src/application/task-commands.js';
import type { FrozenCheck } from '../../src/application/run-scope-grant.js';
import { withTransaction } from '../../src/application/unit-of-work.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { GRAPH_CHECKPOINT_SCHEMA, installGraphCheckpoints } from '../../src/infrastructure/graph-checkpoints.js';
import type { GatewayCapability } from '../../src/infrastructure/database-schema.js';
import { RunToolCallRepository } from '../../src/run/run-tool-call-repository.js';
import { ManagedContentStore, resolveStoredContentPath } from '../../src/storage/managed-content-store.js';
import { describeModelPortStatus } from '../../src/workflow/model-port-config.js';
import { executeToolLoopStep } from '../../src/worker/tool-loop-action.js';
import { runOneCommand } from '../../src/worker/run-command.js';
import { createDataRoot } from './api-harness.js';
import { APP_DATABASE_URL, MIGRATIONS_DIRECTORY, MIGRATION_DATABASE_URL, openDatabase } from
  './integration-support.js';

const modelReady = describeModelPortStatus(process.env).configured;
const app = openDatabase(APP_DATABASE_URL, 'relay-api-test-real-model-tool-loop');
let dataRoot: string;
const roots: string[] = [];
before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
  if (modelReady) await installGraphCheckpoints(MIGRATION_DATABASE_URL);
  dataRoot = await createDataRoot();
});
after(async () => {
  await app.close();
  await rm(dataRoot, { recursive: true, force: true });
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

interface RealFixture {
  readonly runId: string;
  readonly workspaceId: string;
  readonly resourceId: string;
  readonly rootPath: string;
  readonly marker: string;
  /** 绑定该受管根、承担读能力的那条真实连接。 */
  readonly connectionId: string;
}

/**
 * 合成受管目录：标记串只存在于磁盘，任务目标里不含它。
 *
 * 因此「候选正文原样回显标记」只可能来自模型真的调用 read_file 读到了那些字节，
 * 而不可能来自提示词、Context 或预制答案。
 */
async function realFixture(name: string, options: {
  readonly maxRounds?: number;
  readonly maxToolCalls?: number;
} = {}): Promise<RealFixture> {
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const taskId = randomUUID();
  const root = await mkdtemp(join(tmpdir(), 'relay-real-tool-loop-'));
  roots.push(root);
  await mkdir(join(root, 'src'), { recursive: true });
  const marker = `RELAY-TOOL-LOOP-${randomUUID()}`;
  // 标记故意放在 src/ 深处且不在任何索引文件里：只有真的定位并读取才会拿到。
  await writeFile(join(root, 'src', '配置常量.ts'),
    `export const 构建标记 = "${marker}";\n`, 'utf8');
  await writeFile(join(root, 'README.md'), '# 合成目录\n这里没有目标标记。\n', 'utf8');
  await writeFile(join(root, 'src', 'index.ts'), 'export const relay = true;\n', 'utf8');

  await withTransaction(app.db, async (repositories) => {
    await repositories.workspaces.insertWorkspace({ id: workspaceId, name });
    await repositories.workspaces.insertAuthorityRow(workspaceId);
    await repositories.projects.insertProject({ id: projectId, workspaceId, title: name,
      projectType: 'DEVELOPMENT' });
  });
  const { resourceId } = await registerManagedResource(app.db,
    { workspaceId, projectId, rootPath: root });
  const connectionId = await withTransaction(app.db, async (repositories) => {
    await repositories.workspaces.lockAuthority(workspaceId, 'update');
    const connection = await repositories.gateway.insertConnection({ id: randomUUID(),
      workspaceId, projectId, config: { root_path: root } });
    for (const capability of ['FILE_QUERY', 'FILE_READ', 'GIT_READ'] as GatewayCapability[]) {
      await repositories.gateway.addConnectionCapability(connection.id, capability);
    }
    await repositories.workspaces.bumpAuthority(workspaceId);
    return connection.id;
  });
  for (const [capability, actionType] of [['FILE_QUERY', 'FIND_PATHS'],
    ['FILE_QUERY', 'SEARCH_TEXT'], ['FILE_QUERY', 'LIST_DIRECTORY'],
    ['FILE_READ', 'READ_FILE'], ['GIT_READ', 'GIT_STATUS'], ['GIT_READ', 'GIT_DIFF'],
    ['GIT_READ', 'GIT_LOG']] as const) {
    await createGatewayPolicy(app.db, { workspaceId, projectId, capability, actionType,
      targetPrefix: root, decision: 'AUTO', maxPayloadBytes: 262144 });
  }

  const task = await createTask(app.db, { workspaceId, commandId: randomUUID(), projectId,
    title: '真实模型自主取证', expectedOutputs: { kind: 'MARKDOWN_DOCUMENT' },
    // 目标只描述「找出并回显标记」，不含标记本身，也不指定文件名或行号。
    objective: '在受管目录中自行查找，找出标记所在的源文件，并在候选正文的「结论」小节里原样回显该标记字符串。标记本身不在本目标中，请自行使用读取工具取证。',
    criteria: [{ criterionId: 'c1', statement: '存在候选交付', required: true, method: 'HUMAN' }],
    mode: 'ME' });
  const ready = await markTaskReady(app.db, { workspaceId, taskId: task.result.task_id,
    commandId: randomUUID(), expectedRevision: task.result.revision });
  const delegated = await delegateTask(app.db, { workspaceId, taskId: task.result.task_id,
    commandId: randomUUID(), expectedTaskRevision: ready.result.revision,
    toolLoopAction: { resource_id: resourceId,
      connections: { FILE_QUERY: connectionId, FILE_READ: connectionId, GIT_READ: connectionId },
      allowed_tools: ['list_directory', 'find_paths', 'search_text', 'read_file',
        'git_status', 'git_diff', 'git_log'],
      max_rounds: options.maxRounds ?? 8, max_tool_calls: options.maxToolCalls ?? 16 } });
  return { runId: delegated.result.run_id, workspaceId, resourceId, rootPath: root, marker,
  connectionId };
}

interface WritableFixture extends RealFixture {
  readonly root: string;
  readonly unrelatedText: string;
  readonly readmeText: string;
}

/**
 * 可写的合成受管目录：目标文件、标记串与一份用户无关改动。
 *
 * 目标路径故意不出现在任务目标里（只说「src 目录里」），因此「模型改对了文件」只可能
 * 来自它真的搜索并读取过目录。unrelated.ts 与 notes.md 代表用户已有的无关内容：模型没有
 * 获得删除授权，也不能顺手格式化它们。
 */
async function writableFixture(name: string): Promise<WritableFixture> {
  const base = await realFixture(name, { maxRounds: 12, maxToolCalls: 24 });
  const root = base.rootPath;
  const marker = base.marker;
  const unrelatedText = '// 用户自己的改动：不要动我\nexport const keep = "原样保留";\n';
  // realFixture 建好的 README 就是这份「与任务无关但属于用户」的内容。
  const readmeText = '# 合成目录\n这里没有目标标记。\n';
  await writeFile(join(root, 'src', 'greeter.ts'),
    `// ${marker}\nexport const greet = () => "hello";\n`, 'utf8');
  await writeFile(join(root, 'src', 'unrelated.ts'), unrelatedText, 'utf8');

  // 读连接沿用 realFixture 建好的那一个：产品路径也是同目录同一连接承担读写，
  // 这里只补 FILE_WRITE 能力，不另建第二个绑定。
  const connectionId = base.connectionId;
  await withTransaction(app.db, async (repositories) => {
    await repositories.workspaces.lockAuthority(base.workspaceId, 'update');
    await repositories.gateway.addConnectionCapability(connectionId, 'FILE_WRITE');
    await repositories.workspaces.bumpAuthority(base.workspaceId);
  });
  for (const [capability, actionType] of [['FILE_WRITE', 'APPLY_CHANGESET'],
    ['FILE_WRITE', 'READ_CHANGE_SET']] as const) {
    await createGatewayPolicy(app.db, { workspaceId: base.workspaceId,
      projectId: await projectIdOf(base.resourceId), capability, actionType,
      targetPrefix: root, decision: 'AUTO', maxPayloadBytes: 262144 });
  }

  // 用同一份信封与范围授权重新建一个 Run：真实产品路径是 Delegate 时冻结这两者，
  // 这里显式给出等价形状，让真实模型在授权内自主定位并改写。
  const task = await createTask(app.db, { workspaceId: base.workspaceId,
    commandId: randomUUID(), projectId: await projectIdOf(base.resourceId),
    title: '真实模型自主改写', expectedOutputs: { kind: 'MARKDOWN_DOCUMENT' },
    objective: 'src 目录里有一个 greet 函数。请自行查找该文件并读取，然后在同一文件里追加一行：' +
      '让 greet 返回 RELAY-REAL-WRITE-OK。保留该文件已有的全部内容，不要修改其他文件。',
    criteria: [{ criterionId: 'c1', statement: 'src 目录里 greet 返回 RELAY-REAL-WRITE-OK',
      required: true, method: 'HUMAN' }],
    mode: 'ME' });
  const ready = await markTaskReady(app.db, { workspaceId: base.workspaceId,
    taskId: task.result.task_id, commandId: randomUUID(), expectedRevision: task.result.revision });
  const delegated = await delegateTask(app.db, { workspaceId: base.workspaceId,
    taskId: task.result.task_id, commandId: randomUUID(), expectedTaskRevision: ready.result.revision,
    toolLoopAction: { resource_id: base.resourceId,
      connections: { FILE_QUERY: connectionId, FILE_READ: connectionId, FILE_WRITE: connectionId },
      allowed_tools: ['list_directory', 'find_paths', 'search_text', 'read_file',
        'apply_changeset', 'read_change_set'],
      max_rounds: 12, max_tool_calls: 24 },
    scopeGrant: { resource_id: base.resourceId, allowed_actions: ['APPLY_CHANGESET'], checks: [] } });
  return { ...base, runId: delegated.result.run_id, root, unrelatedText, readmeText };
}

async function projectIdOf(resourceId: string): Promise<string> {
  const resource = await withTransaction(app.db, (repositories) =>
    repositories.gateway.readResource(resourceId));
  assert.ok(resource !== undefined);
  return resource.project_id;
}

interface RepairFixture extends RealFixture {
  readonly taskId: string;
  readonly targetPath: string;
  readonly sourceText: string;
  readonly sourceSha256: string;
  readonly expectedGreeting: string;
  readonly check: FrozenCheck;
  readonly scriptPath: string;
  readonly scriptText: string;
  readonly preservedFiles: readonly { readonly path: string; readonly bytes: Buffer }[];
  readonly entries: readonly string[];
}

/** 修复要求只由真实失败输出给出；检查脚本在受管根之外，写工具不能把检查改绿。 */
async function repairFixture(): Promise<RepairFixture> {
  const base = await realFixture('real-model-tool-loop-repair', { maxRounds: 12, maxToolCalls: 24 });
  // realFixture 的只读 Run 从未执行；通过控制 Owner 取消，生产领取会结算其 START 后跳过。
  const baseFacts = await withTransaction(app.db, async (repositories) => {
    const run = await repositories.runs.readRun(base.runId);
    assert.ok(run !== undefined);
    assert.equal(run.status, 'CREATED');
    assert.equal(run.worker_id, null);
    const task = await repositories.tasks.readTask(run.task_id);
    assert.ok(task !== undefined);
    return { taskRevision: task.revision.toString(), runRevision: run.revision.toString() };
  });
  await requestRunControl(app.db, { workspaceId: base.workspaceId, runId: base.runId,
    commandId: randomUUID(), type: 'CANCEL', expectedTaskRevision: baseFacts.taskRevision,
    expectedRunRevision: baseFacts.runRevision });
  assert.equal((await applySafeControl(app.db, base.runId))?.status, 'APPLIED');
  assert.equal((await withTransaction(app.db, (repositories) =>
    repositories.runs.readRun(base.runId)))?.status, 'CANCELLED');
  const projectId = await projectIdOf(base.resourceId);
  const targetPath = 'src/greeter.mjs';
  const marker = `RELAY-REPAIR-FILE-${randomUUID()}`;
  const sourceText = `// ${marker}\nexport const greet = () => "hello";\n`;
  const sourceSha256 = createHash('sha256').update(sourceText).digest('hex');
  const expectedGreeting = `RELAY-REPAIR-OK-${randomUUID()}`;
  await writeFile(join(base.rootPath, targetPath), sourceText, 'utf8');
  await writeFile(join(base.rootPath, 'src', 'unrelated.ts'),
    '// 用户已有改动，必须原样保留\nexport const keep = "不要格式化";\n', 'utf8');
  const preservedFiles = await Promise.all(['README.md', 'src/index.ts',
    'src/配置常量.ts', 'src/unrelated.ts'].map(async (path) =>
    ({ path, bytes: await readFile(join(base.rootPath, path)) })));
  const entries = (await readdir(base.rootPath, { recursive: true })).sort();

  const checkRoot = await mkdtemp(join(tmpdir(), 'relay-real-repair-check-'));
  roots.push(checkRoot);
  const scriptPath = join(checkRoot, 'check.mjs');
  const scriptText = [
    'import { createHash } from "node:crypto";',
    'import { readFile } from "node:fs/promises";',
    'import { pathToFileURL } from "node:url";',
    'const source = await readFile(process.argv[2], "utf8");',
    'console.log("SOURCE_SHA256=" + createHash("sha256").update(source).digest("hex"));',
    'const { greet } = await import(pathToFileURL(process.argv[2]).href);',
    'const actual = greet();',
    `const expected = ${JSON.stringify(expectedGreeting)};`,
    'if (actual !== expected) {',
    `  console.error("FAIL ${targetPath}: greet() returned " + JSON.stringify(actual) +`,
    '    "; expected " + JSON.stringify(expected) + ". Fix greet and preserve existing comments.");',
    '  process.exit(1);',
    '}',
    `console.log("PASS ${targetPath}: " + actual);`,
    '',
  ].join('\n');
  await writeFile(scriptPath, scriptText, 'utf8');
  const check: FrozenCheck = { id: 'check-1', executable: process.execPath,
    args: [scriptPath, join(base.rootPath, targetPath)], max_output_bytes: 4096,
    executable_sha256: createHash('sha256').update(await readFile(process.execPath)).digest('hex') };

  await withTransaction(app.db, async (repositories) => {
    await repositories.workspaces.lockAuthority(base.workspaceId, 'update');
    for (const capability of ['FILE_WRITE', 'CLI_RUN'] as const) {
      await repositories.gateway.addConnectionCapability(base.connectionId, capability);
    }
    await repositories.workspaces.bumpAuthority(base.workspaceId);
  });
  for (const [capability, actionType] of [['FILE_WRITE', 'APPLY_CHANGESET'],
    ['FILE_WRITE', 'READ_CHANGE_SET'], ['CLI_RUN', 'CLI_RUN']] as const) {
    await createGatewayPolicy(app.db, { workspaceId: base.workspaceId, projectId,
      capability, actionType, targetPrefix: base.rootPath, decision: 'AUTO', maxPayloadBytes: 262144 });
  }
  const task = await createTask(app.db, { workspaceId: base.workspaceId, projectId,
    commandId: randomUUID(), title: '根据真实检查输出修复',
    expectedOutputs: { kind: 'MARKDOWN_DOCUMENT' },
    objective: '先运行本次已配置检查。根据它实际返回的失败输出，自行读取并修复对应源文件，' +
      '再运行同一个检查，确认通过后交付。保留源文件已有注释及所有无关用户内容；' +
      '不要修改检查程序，不要新建或删除文件。',
    criteria: [{ criterionId: 'c1', statement: '实际检查先失败，修复后同一检查通过',
      required: true, method: 'HUMAN' }], mode: 'ME' });
  const ready = await markTaskReady(app.db, { workspaceId: base.workspaceId,
    taskId: task.result.task_id, commandId: randomUUID(), expectedRevision: task.result.revision });
  const delegated = await delegateTask(app.db, { workspaceId: base.workspaceId,
    taskId: task.result.task_id, commandId: randomUUID(), expectedTaskRevision: ready.result.revision,
    toolLoopAction: { resource_id: base.resourceId,
      connections: { FILE_QUERY: base.connectionId, FILE_READ: base.connectionId,
        FILE_WRITE: base.connectionId, CLI_RUN: base.connectionId },
      allowed_tools: ['list_directory', 'find_paths', 'search_text', 'read_file',
        'apply_changeset', 'read_change_set', 'run_check'], max_rounds: 12, max_tool_calls: 24 },
    scopeGrant: { resource_id: base.resourceId,
      allowed_actions: ['APPLY_CHANGESET', 'CLI_RUN'], checks: [check] } });
  return { ...base, runId: delegated.result.run_id, taskId: task.result.task_id,
    marker, targetPath, sourceText, sourceSha256,
    expectedGreeting, check, scriptPath, scriptText, preservedFiles, entries };
}

/** 真实模型下交替推进步骤与工具派发；上限只是防失控，不是产品预算。 */
async function driveReal(fx: RealFixture, maxIterations = 40): Promise<readonly string[]> {
  const storage = new ManagedContentStore(dataRoot);
  const statuses: string[] = [];
  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const advanced = await advanceRunStep(app.db, { runId: fx.runId,
      workerId: `real-loop-${randomUUID()}`, storage });
    statuses.push(advanced.status);
    if (advanced.status === 'STEP_SUCCEEDED' || advanced.status === 'RETRYABLE' ||
        advanced.status === 'REPLAYED') continue;
    if (advanced.status !== 'TOOL_LOOP_ACTION_REQUIRED') return statuses;
    const dispatched = await executeToolLoopStep(app.db, { claim: { commandId: randomUUID(),
      runId: fx.runId, workspaceId: fx.workspaceId, kind: 'START', reviewDecisionId: null,
      workerId: `real-loop-${randomUUID()}`, epoch: 0n }, toolCallId: advanced.tool_call_id });
    statuses.push(`TOOL_${dispatched.status}`);
    if (dispatched.status === 'WAITING' || dispatched.status === 'UNKNOWN' ||
        dispatched.status === 'STOPPED' || dispatched.status === 'FAILED') return statuses;
  }
  return statuses;
}

async function draftAttemptId(runId: string): Promise<string> {
  return withTransaction(app.db, async (repositories) => {
    const run = await repositories.runs.readRun(runId);
    const draft = (await repositories.runs.listSteps(runId))
      .find((step) => step.step_kind === 'DRAFT');
    assert.ok(draft !== undefined, `no DRAFT step; run=${run?.status}`);
    const attempts = await repositories.runs.listAttempts(draft.id);
    assert.ok(attempts.length > 0, `no DRAFT attempt; run=${run?.status}`);
    return attempts.at(-1)!.id;
  });
}

test('the real provider repairs from a failed check result and reruns the frozen check successfully',
  { skip: !modelReady && 'RELAY_MODEL_* not configured', timeout: 900_000 }, async () => {
    const fx = await repairFixture();
    const statuses: string[] = [];
    const deliver = () => runOneCommand(app.db, { workerId: `real-graph-${randomUUID()}`,
      dataRoot, checkpointUrl: APP_DATABASE_URL,
      onClaim: async (claim) => {
        assert.equal(claim.runId, fx.runId, 'the production worker claimed another fixture Run');
      },
      afterStep: async (step) => {
        statuses.push(step.status);
        // 普通 AssertionError 向外传播；不 abort 成 LOST，也不让图的 REPEAT 边重试。
        assert.notEqual(step.status, 'RETRYABLE', 'the real probe stops at its first retryable failure');
      } });
    const delivered = await deliver();
    const repository = new RunToolCallRepository(app.db);
    const rows = await repository.listByRun(fx.runId);
    const checks = rows.filter((row) => row.tool_name === 'run_check' && row.status === 'SETTLED');
    const writes = rows.filter((row) => row.tool_name === 'apply_changeset' && row.status === 'SETTLED');
    const callsOfRun = async () => (await sql<{ id: string; status: string; provider: string; model: string;
      request_id: string | null; input_tokens: number | null; output_tokens: number | null;
      error_kind: string | null }>`
      select c.id, c.status, c.provider, c.model, c.provider_request_id as request_id,
        c.usage_input_tokens as input_tokens, c.usage_output_tokens as output_tokens, c.error_kind
      from model_calls c join step_attempts a on a.id = c.step_attempt_id
        join run_steps s on s.id = a.step_id
      where s.run_id = ${fx.runId} order by c.started_at, c.id`.execute(app.db)).rows;
    const calls = await callsOfRun();
    console.log(`real-model-repair trace: ${JSON.stringify({ statuses, delivery: delivered,
      tool_names: rows.map((row) => row.tool_name), tool_statuses: rows.map((row) => row.status),
      check_exit_codes: checks.map((row) => row.result_ref?.exitCode),
      model_calls: calls.length, model_statuses: calls.map((call) => call.status),
      model_identities: calls.map((call) => ({ provider: call.provider, model: call.model })),
      model_errors: calls.map((call) => call.error_kind),
      model_usage: calls.map((call) => ({ input: call.input_tokens, output: call.output_tokens })) })}`);
    assert.equal(delivered?.runId, fx.runId);
    assert.equal(delivered?.outcome, 'DONE', 'the production graph must finish this delivery at human review');
    assert.ok(!statuses.includes('RETRYABLE'), 'the probe stopped at a retryable failure without retrying');
    assert.equal(checks.length, 2, 'expected one failed check and one successful recheck');
    const failed = checks[0]!;
    const passed = checks[1]!;
    assert.equal(failed.result_ref?.outcome, 'FAILED');
    assert.equal(failed.result_ref?.exitCode, 1);
    assert.ok(String(failed.result_ref?.stderr).includes(`FAIL ${fx.targetPath}`));
    assert.ok(String(failed.result_ref?.stderr).includes(fx.expectedGreeting),
      'the real failure output must supply the repair value absent from the task');
    assert.ok(String(failed.result_ref?.stdout).includes(`SOURCE_SHA256=${fx.sourceSha256}`));
    assert.equal(passed.result_ref?.outcome, 'SUCCEEDED');
    assert.equal(passed.result_ref?.exitCode, 0);
    assert.ok(String(passed.result_ref?.stdout).includes(`PASS ${fx.targetPath}: ${fx.expectedGreeting}`));
    assert.equal(passed.result_ref?.stderr, '');
    assert.equal(failed.result_ref?.truncated, false);
    assert.equal(passed.result_ref?.truncated, false);
    assert.ok(writes.length > 0, 'the real model never requested a repair write');
    const sourceRead = rows.find((row) => row.tool_name === 'read_file' && row.status === 'SETTLED' &&
      row.arguments.relative_path === fx.targetPath && row.result_ref?.content === fx.sourceText);
    assert.ok(sourceRead !== undefined, 'the real model did not read the actual broken source');
    // 各个新模型轮次必须消费上一段真实回执，不能同轮先猜改动与检查结果。
    assert.ok(failed.round < sourceRead.round && sourceRead.round < writes[0]!.round);
    assert.ok(writes.every((row) => row.round > sourceRead.round && row.round < passed.round));
    assert.deepEqual(failed.arguments, { check_id: fx.check.id });
    assert.deepEqual(passed.arguments, { check_id: fx.check.id });

    const grant = await withTransaction(app.db, (repositories) =>
      repositories.scopeGrants.readByRun(fx.runId));
    assert.deepEqual(grant?.checks, [fx.check]);
    for (const [row, status] of [[failed, 'FAILED'], [passed, 'SUCCEEDED']] as const) {
      assert.ok(row.operation_id !== null);
      const operation = await withTransaction(app.db, (repositories) =>
        repositories.gateway.readOperation(row.operation_id!));
      assert.equal(operation?.status, status);
      assert.equal(operation?.action_type, 'CLI_RUN');
      assert.deepEqual(operation?.params, { executable: fx.check.executable,
        args: [...fx.check.args], max_output_bytes: fx.check.max_output_bytes });
      assert.deepEqual(operation?.result_ref, row.result_ref);
      const invocations = await withTransaction(app.db, (repositories) =>
        repositories.gateway.listInvocations(row.operation_id!));
      assert.equal(invocations.length, 1, 'each check must launch exactly once');
      assert.equal(invocations[0]!.status, status);
      assert.deepEqual(invocations[0]!.result_ref, row.result_ref);
    }

    let previousSha256 = fx.sourceSha256;
    for (const write of writes) {
      assert.ok(write.operation_id !== null);
      const ledger = await withTransaction(app.db, (repositories) =>
        repositories.changeSets.listByOperation(write.operation_id!));
      assert.equal(ledger.length, 1);
      const files = await withTransaction(app.db, (repositories) =>
        repositories.changeSets.listFiles(ledger[0]!.id));
      assert.equal(files.length, 1, 'the repair may only modify the failed source');
      const file = files[0]!;
      assert.equal(file.relative_path, fx.targetPath);
      assert.equal(file.action, 'MODIFY');
      assert.equal(file.status, 'APPLIED');
      assert.equal(file.baseline_sha256, previousSha256);
      assert.equal(file.observed_baseline_sha256, previousSha256);
      assert.ok(file.actual_sha256 !== null);
      assert.equal(file.target_sha256, file.actual_sha256);
      previousSha256 = file.actual_sha256;
    }
    const repaired = await readFile(join(fx.rootPath, fx.targetPath), 'utf8');
    assert.ok(repaired.includes(fx.marker), 'the repair dropped the unpredictable source marker');
    assert.ok(repaired.includes(fx.expectedGreeting), 'the real file does not contain the feedback-driven repair');
    assert.equal(createHash('sha256').update(repaired).digest('hex'), previousSha256);
    assert.ok(String(passed.result_ref?.stdout).includes(`SOURCE_SHA256=${previousSha256}`));
    const assertPreserved = async () => {
      for (const file of fx.preservedFiles) {
        assert.deepEqual(await readFile(join(fx.rootPath, file.path)), file.bytes);
      }
      assert.deepEqual((await readdir(fx.rootPath, { recursive: true })).sort(), fx.entries);
      assert.equal(await readFile(fx.scriptPath, 'utf8'), fx.scriptText);
    };
    await assertPreserved();

    const candidates = (await sql<{ id: string }>`select a.id from step_attempts a
      join run_steps s on s.id = a.step_id where s.run_id = ${fx.runId}
      and s.step_kind = 'DRAFT' and a.status = 'SUCCEEDED'`.execute(app.db)).rows;
    assert.equal(candidates.length, 1, 'the provider must settle a candidate after the successful recheck');
    const humanState = await withTransaction(app.db, async (repositories) => ({
      run: await repositories.runs.readRun(fx.runId), task: await repositories.tasks.readTask(fx.taskId),
      reviews: await repositories.reviews.listByRun(fx.runId) }));
    assert.equal(humanState.run?.status, 'WAITING_APPROVAL');
    assert.equal(humanState.task?.status, 'WAITING');
    assert.equal(humanState.task?.executor_run_id, fx.runId);
    const review = humanState.reviews.find((row) => row.kind === 'CRITERION' &&
      row.status === 'OPEN' && row.criterion_id === 'c1');
    assert.ok(review !== undefined, 'a successful tool check cannot replace human acceptance');
    const versions = (await sql<{ storage_ref: string; content_hash: Buffer }>`
      select storage_ref, content_hash from artifact_versions
      where source_ref like ${`run:${fx.runId}/%`}`.execute(app.db)).rows;
    assert.equal(versions.length, 1, 'the production graph must persist one candidate before review');
    const content = await readFile(resolveStoredContentPath(dataRoot, versions[0]!.storage_ref));
    assert.equal(createHash('sha256').update(content).digest('hex'), versions[0]!.content_hash.toString('hex'));
    assert.equal((await sql<{ count: bigint }>`select count(*)::bigint as count
      from completion_records where task_id = ${fx.taskId}`.execute(app.db)).rows[0]!.count, 0n);

    const checkpointsOfRun = async () => {
      const saver = PostgresSaver.fromConnString(APP_DATABASE_URL, { schema: GRAPH_CHECKPOINT_SCHEMA });
      const history: { id: string; values: Record<string, unknown> }[] = [];
      try {
        for await (const tuple of saver.list({ configurable: { thread_id: fx.runId, checkpoint_ns: '' } })) {
          history.unshift({ id: tuple.checkpoint.id, values: tuple.checkpoint.channel_values });
        }
      } finally { await saver.end(); }
      return history;
    };
    const checkpoints = await checkpointsOfRun();
    const failureIndex = checkpoints.findIndex((entry) => entry.values.lastStatus === 'TOOL_CHECK_FAILED');
    assert.ok(failureIndex >= 0, 'the real failed check must be durably checkpointed');
    assert.ok(checkpoints.slice(failureIndex + 1).some((entry) =>
      entry.values.lastStatus === 'TOOL_LOOP_ACTION_REQUIRED' && entry.values.toolCallId === sourceRead.id),
    'the production graph must request the actual source read after the failed-check checkpoint');
    assert.equal(checkpoints.at(-1)?.values.lastStatus, 'WAITING_REVIEW');
    assert.equal(checkpoints.at(-1)?.values.reviewId, review.id);
    assert.ok(calls.length >= 5, 'the repair requires feedback-driven model round trips');
    assert.ok(calls.every((call) => call.provider === 'openai-compatible' && call.model !== ''),
      'the production graph must use the configured real provider');
    assert.ok(calls.every((call) => call.status === 'COMPLETED' && call.error_kind === null),
      'a provider failure must fail this probe, including timeout or 429');
    assert.ok(calls.every((call) => typeof call.request_id === 'string' && call.request_id !== ''));
    assert.ok(calls.every((call) => (call.input_tokens ?? 0) > 0 && (call.output_tokens ?? 0) > 0),
      'missing usage stays unknown and cannot be presented as real model metering');

    const operations = await withTransaction(app.db, (repositories) =>
      repositories.gateway.listRunOperations(fx.runId));
    const invocations = (await sql<{ id: string }>`select id from invocation_attempts
      where run_id = ${fx.runId} order by created_at, id`.execute(app.db)).rows;
    for (const row of [failed, ...writes, passed]) {
      const replayed = await executeToolLoopStep(app.db, { toolCallId: row.id,
        claim: { commandId: randomUUID(), runId: fx.runId, workspaceId: fx.workspaceId,
          kind: 'START', reviewDecisionId: null, workerId: `real-replay-${randomUUID()}`, epoch: 0n } });
      assert.equal(replayed.operationId, row.operation_id);
    }
    assert.equal(await deliver(), undefined, 'the completed delivery has no pending command');
    // 模拟 START 再投递已保存的 Review 屏障：走生产图，不能再问模型或重复派发。
    await withTransaction(app.db, (repositories) => repositories.dispatch.insertCommand({
      id: randomUUID(), workspaceId: fx.workspaceId, runId: fx.runId,
      sourceCommandId: randomUUID(), kind: 'START' }));
    const replayedDelivery = await deliver();
    assert.equal(replayedDelivery?.runId, fx.runId);
    assert.equal(replayedDelivery?.outcome, 'DONE');
    assert.deepEqual(await repository.listByRun(fx.runId), rows);
    assert.deepEqual(await withTransaction(app.db, (repositories) =>
      repositories.gateway.listRunOperations(fx.runId)), operations);
    assert.deepEqual((await sql<{ id: string }>`select id from invocation_attempts
      where run_id = ${fx.runId} order by created_at, id`.execute(app.db)).rows, invocations);
    assert.deepEqual(await callsOfRun(), calls);
    assert.deepEqual(await checkpointsOfRun(), checkpoints);
    assert.equal(await readFile(join(fx.rootPath, fx.targetPath), 'utf8'), repaired);
    await assertPreserved();
  });

test('the real provider edits real files it located itself, and leaves unrelated content alone',
  { skip: !modelReady && 'RELAY_MODEL_* not configured', timeout: 900_000 }, async () => {
    const fx = await writableFixture('real-model-tool-loop-write');
    const statuses = await driveReal(fx);
    const rows = await new RunToolCallRepository(app.db).listByAttempt(await draftAttemptId(fx.runId));
    const settled = rows.filter((row) => row.status === 'SETTLED');
    console.log(`real-model-write trace: ${JSON.stringify({ statuses,
      tool_names: rows.map((row) => row.tool_name), tool_statuses: rows.map((row) => row.status),
      // 拒绝原因是模型下一步的依据：不记录它，被拒时无法判断是模型错还是准入规则挡的。
      rejections: rows.filter((row) => row.status === 'REJECTED')
        .map((row) => ({ tool: row.tool_name, ...row.result_ref as object })) })}`);

    // 模型必须自己定位文件：目标里没有给出目标路径，只有「src 目录里」这一条线索。
    assert.ok(settled.some((row) => row.tool_name === 'read_file' && row.status === 'SETTLED'),
      `no successful read_file; tools=${JSON.stringify(rows.map((row) => row.tool_name))}`);
    const writes = settled.filter((row) => row.tool_name === 'apply_changeset');
    assert.ok(writes.length > 0, 'the real model never requested a write tool');
    // 落盘证据：磁盘内容来自真实写入，不是预制答案，也不是「模型说改好了」。
    const written = await readFile(join(fx.root, 'src', 'greeter.ts'), 'utf8');
    assert.match(written, /RELAY-REAL-WRITE-OK/u,
      `the real on-disk content was not produced by the model write: ${written}`);
    assert.ok(written.includes(fx.marker),
      `the write dropped the original marker, so it was not derived from the file it read: ${written}`);
    // 用户已有的无关改动必须原样保留：模型没有获得删除授权，也没有理由动它。
    assert.equal(await readFile(join(fx.root, 'src', 'unrelated.ts'), 'utf8'),
      fx.unrelatedText);
    assert.equal(await readFile(join(fx.root, 'README.md'), 'utf8'), fx.readmeText);
    // 重复投递不得重复写入：同一次授权下的再次结算不能改出第二份内容。
    const beforeReplay = await readFile(join(fx.root, 'src', 'greeter.ts'), 'utf8');
    await driveReal(fx, 4);
    assert.equal(await readFile(join(fx.root, 'src', 'greeter.ts'), 'utf8'), beforeReplay);
  });

test('the real provider emits tool calls and grounds the candidate in the bytes it read',
  { skip: !modelReady && 'RELAY_MODEL_* not configured', timeout: 600_000 }, async () => {
    const fx = await realFixture('real-model-tool-loop-read');
    const statuses = await driveReal(fx);

    const rows = await new RunToolCallRepository(app.db).listByAttempt(await draftAttemptId(fx.runId));
    const settled = rows.filter((row) => row.status === 'SETTLED');

    // 每次工具调用都是一次真实计费的模型往返；把它原样记录，供稳定性判断使用。
    const calls = (await sql<{ status: string; request_id: string | null;
      input_tokens: number | null }>`
      select status, provider_request_id as request_id, usage_input_tokens as input_tokens
      from model_calls where step_attempt_id = ${await draftAttemptId(fx.runId)}
      order by started_at`.execute(app.db)).rows;
    const trace = {
      statuses,
      tool_names: rows.map((row) => row.tool_name),
      tool_statuses: rows.map((row) => row.status),
      model_calls: calls.length,
      model_statuses: calls.map((call) => call.status),
      provider_request_ids: calls.map((call) => call.request_id),
      nonzero_usage_calls: calls.filter((call) => (call.input_tokens ?? 0) > 0).length,
    };
    console.log(`real-model-tool-loop trace: ${JSON.stringify(trace)}`);

    assert.ok(settled.length > 0,
      `the real model requested no dispatched tool; statuses=${JSON.stringify(statuses)}`);
    // 模型必须先定位再读取：只有 read_file 真的成功，标记才可能进入候选。
    assert.ok(settled.some((row) => row.tool_name === 'read_file' && row.status === 'SETTLED'),
      `no successful read_file; tools=${JSON.stringify(trace.tool_names)}`);
    // 每次工具请求都是一次有 request id 的真实调用，用量缺失保持 null 而不是补零。
    assert.ok(calls.length >= 2, 'tool calling needs at least two real model round trips');
    assert.ok(calls.every((call) => call.status === 'COMPLETED'), 'no call left unsettled');
    assert.ok(trace.nonzero_usage_calls >= 2, 'the provider reported no real token usage');

    const candidate = (await sql<{ content: string }>`
      select a.result_ref->>'content' as content
      from step_attempts a join run_steps s on s.id = a.step_id
      where s.run_id = ${fx.runId} and s.step_kind = 'DRAFT' and a.status = 'SUCCEEDED'
      order by a.attempt_number desc limit 1`.execute(app.db)).rows[0];
    assert.ok(candidate !== undefined, 'no DRAFT candidate was settled');
    assert.ok(candidate!.content.includes(fx.marker),
      'the candidate does not echo the on-disk marker: the model did not ground its answer in the file it read');
  });
