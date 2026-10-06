import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test, { after, before } from 'node:test';

import { createAssistSession, requestAssistMessage } from '../../src/application/assist-commands.js';
import { applyConversationExecution, interpretConversationMessage } from
  '../../src/application/conversation-execution.js';
import { createGatewayPolicy, canonicalResourceIdentity } from
  '../../src/application/gateway-configuration.js';
import { openWorkingDirectory } from '../../src/application/open-working-directory.js';
import { advanceRunStep } from '../../src/application/run-steps.js';
import type { FrozenCheck } from '../../src/application/run-scope-grant.js';
import { createRepositories, withTransaction } from '../../src/application/unit-of-work.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { RunToolCallRepository } from '../../src/run/run-tool-call-repository.js';
import { ManagedContentStore } from '../../src/storage/managed-content-store.js';
import { executeToolLoopStep } from '../../src/worker/tool-loop-action.js';
import type { DbExecutor } from '../../src/infrastructure/database.js';
import type { GatewayCapability } from '../../src/infrastructure/database-schema.js';
import type { JsonObject } from '../../src/infrastructure/json.js';
import type { AssistModelPort, ConversationInterpretationRequest, ModelIdentity } from '../../src/workflow/fake-model-port.js';
import { RELAY_AGENT_CORE_PROMPT } from '../../src/workflow/agent-system-prompt.js';
import { createDataRoot } from './api-harness.js';
import { APP_DATABASE_URL, MIGRATIONS_DIRECTORY, MIGRATION_DATABASE_URL, openDatabase } from
  './integration-support.js';

/**
 * 文件夹入口与「明确执行请求直接进入执行」的真实 PG 出口。
 *
 * 覆盖 FC-01/02/03/05 的服务端部分：目录身份复用与歧义、多项目显式选择、首条意图只保留一次、
 * 候选先落库、纯讨论不建 Task，以及明确请求建立真实 Task 并 Delegate 出带受控文件写与检查命令的 Run。
 */

const app = openDatabase(APP_DATABASE_URL, 'relay-api-test-folder-entry');
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

const identity: ModelIdentity = { provider: 'fake', model: 'fake-model-v1',
  configFingerprint: 'folder-entry-test' };

function port(body: unknown, requests?: ConversationInterpretationRequest[]): AssistModelPort {
  return { identity, assist: async () => { throw new Error('assist is not used in this suite'); },
    interpret: async (request) => {
      requests?.push(request);
      return { kind: 'CONTENT', content: JSON.stringify(body), providerRequestId: 'test',
        usage: { inputTokens: 1, outputTokens: 1 } };
    } };
}

async function workspace(name: string): Promise<string> {
  const workspaceId = randomUUID();
  await withTransaction(app.db, async (repositories) => {
    await repositories.workspaces.insertWorkspace({ id: workspaceId, name });
    await repositories.workspaces.insertAuthorityRow(workspaceId);
  });
  return workspaceId;
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'relay-folder-'));
  roots.push(root);
  return root;
}

async function sessionIn(workspaceId: string, projectId: string, content: string): Promise<{
  sessionId: string; userMessageId: string;
}> {
  const session = await createAssistSession(app.db, { workspaceId, commandId: randomUUID(),
    projectId, title: '目录会话' });
  const sent = await requestAssistMessage(app.db, { workspaceId,
    sessionId: session.result.session_id, commandId: randomUUID(), content });
  return { sessionId: session.result.session_id, userMessageId: sent.result.user_message_id };
}

test('首次打开有效目录建立最小关联，再次打开复用同一项目与受管资源', async () => {
  const workspaceId = await workspace('folder-open');
  const root = await tempRoot();
  const first = await openWorkingDirectory(app.db, { workspaceId, commandId: randomUUID(), rootPath: root });
  assert.equal(first.result.status, 'READY');
  assert.equal(first.result.created_project, true);
  assert.equal(first.result.created_resource, true);
  assert.equal(first.result.association?.project_title, basename(root));
  assert.ok(first.result.association !== null);
  // 目录不是项目目标：首次登记不虚构 Goal，也不预设验收。
  const projects = await withTransaction(app.db, (repositories) =>
    repositories.projects.listProjectsPage({ workspaceId, status: 'active', limit: 10, before: null }));
  assert.equal(projects.length, 1);
  assert.equal(projects[0]?.next_action_task_id, null);

  const second = await openWorkingDirectory(app.db, { workspaceId, commandId: randomUUID(), rootPath: root });
  assert.equal(second.result.created_project, false);
  assert.equal(second.result.created_resource, false);
  assert.equal(second.result.association?.project_id, first.result.association?.project_id);
  assert.equal(second.result.association?.resource_id, first.result.association?.resource_id);
});

test('已提交的命令按原 command_id 重放，即使目录此后被删除', async () => {
  const workspaceId = await workspace('folder-replay');
  const root = await tempRoot();
  const commandId = randomUUID();
  const first = await openWorkingDirectory(app.db, { workspaceId, commandId, rootPath: root });
  await rm(root, { recursive: true, force: true });
  const replay = await openWorkingDirectory(app.db, { workspaceId, commandId, rootPath: root });
  assert.equal(replay.replayed, true);
  assert.equal(replay.result.association?.resource_id, first.result.association?.resource_id);
});

test('大小写别名不产生第二个写 Owner；嵌套根如实报告重叠；无效目录被拒绝', async () => {
  const workspaceId = await workspace('folder-identity');
  const root = await tempRoot();
  await mkdir(join(root, 'nested'), { recursive: true });
  const opened = await openWorkingDirectory(app.db, { workspaceId, commandId: randomUUID(), rootPath: root });
  assert.equal(opened.result.status, 'READY');

  const upper = await openWorkingDirectory(app.db, { workspaceId, commandId: randomUUID(),
    rootPath: root.toUpperCase() });
  assert.equal(upper.result.association?.resource_id, opened.result.association?.resource_id);
  assert.equal(upper.result.created_resource, false);

  const nested = await openWorkingDirectory(app.db, { workspaceId, commandId: randomUUID(),
    rootPath: join(root, 'nested') });
  // 已有重叠受管根时不新开项目，改为要求显式选定作用域。
  assert.equal(nested.result.status, 'NOT_READY');
  assert.equal(nested.result.reason, 'OVERLAPPING_OTHER_PROJECT');
  assert.equal(nested.result.created_resource, false);
  assert.equal(nested.result.candidates.some((candidate) =>
    candidate.resource_id === opened.result.association?.resource_id), true);
  const scoped = await openWorkingDirectory(app.db, { workspaceId, commandId: randomUUID(),
    rootPath: join(root, 'nested'), projectId: opened.result.association?.project_id });
  assert.equal(scoped.result.status, 'READY');
  assert.equal(scoped.result.created_resource, true);

  await assert.rejects(() => openWorkingDirectory(app.db, { workspaceId, commandId: randomUUID(),
    rootPath: join(root, 'missing') }));
});

test('同一实际目录关联多个项目时要求显式选择，不替用户猜作用域', async () => {
  const workspaceId = await workspace('folder-ambiguous');
  const root = await tempRoot();
  const first = await openWorkingDirectory(app.db, { workspaceId, commandId: randomUUID(), rootPath: root });
  const projectId = first.result.association?.project_id ?? '';
  const otherProject = randomUUID();
  await withTransaction(app.db, async (repositories) => {
    await repositories.projects.insertProject({ id: otherProject, workspaceId, title: '另一个项目',
      projectType: 'DEVELOPMENT' });
    await repositories.projects.insertProjectState(otherProject, 'PLANNING');
    await repositories.gateway.insertResource({ id: randomUUID(), workspaceId, projectId: otherProject,
      canonicalRoot: join(root, '..', basename(root)), identityKey: canonicalResourceIdentity(root),
      fileWriteRootId: null });
  });
  const ambiguous = await openWorkingDirectory(app.db, { workspaceId, commandId: randomUUID(), rootPath: root });
  assert.equal(ambiguous.result.status, 'AMBIGUOUS');
  assert.equal(ambiguous.result.reason, 'MULTIPLE_PROJECTS');
  assert.equal(ambiguous.result.association, null);
  assert.deepEqual(new Set(ambiguous.result.candidates.map((item) => item.project_id)),
    new Set([projectId, otherProject]));

  const chosen = await openWorkingDirectory(app.db, { workspaceId, commandId: randomUUID(),
    rootPath: root, projectId: otherProject });
  assert.equal(chosen.result.status, 'READY');
  assert.equal(chosen.result.association?.project_id, otherProject);
});

test('纯讨论不创建 Task；明确请求建立真实 Task 并 Delegate 出受控文件写与检查命令', async () => {
  const interpretationRequests: ConversationInterpretationRequest[] = [];
  const workspaceId = await workspace('conversation-execution');
  const root = await tempRoot();
  const opened = await openWorkingDirectory(app.db, { workspaceId, commandId: randomUUID(), rootPath: root });
  const projectId = opened.result.association?.project_id ?? '';
  const resourceId = opened.result.association?.resource_id ?? '';
  assert.notEqual(projectId, '');
  assert.notEqual(resourceId, '');

  const discussed = await sessionIn(workspaceId, projectId, '先讨论一下这个目录该放什么');
  const discuss = await interpretConversationMessage(app.db, { workspaceId,
    sessionId: discussed.sessionId, sourceMessageId: discussed.userMessageId, resourceId,
    commandId: randomUUID(), modelPort: port({ decision: 'DISCUSS' }, interpretationRequests) });
  assert.equal(discuss.result.decision, 'DISCUSS');
  assert.equal(discuss.result.task_id, null);
  assert.equal(discuss.result.status, 'DISCUSSED');
  assert.equal(interpretationRequests[0]?.userContent, '先讨论一下这个目录该放什么');
  assert.ok(interpretationRequests[0]?.system.includes(RELAY_AGENT_CORE_PROMPT));
  assert.match(interpretationRequests[0]!.system, /本次只解释原用户意图/u);

  const asked = await sessionIn(workspaceId, projectId, '帮我把这个文件的内容改成 after 并跑一次检查');
  const commandId = randomUUID();
  const prepared = await interpretConversationMessage(app.db, { workspaceId,
    sessionId: asked.sessionId, sourceMessageId: asked.userMessageId, resourceId, commandId,
    modelPort: port({ decision: 'PREPARE', task: {
      title: '改写 answer.txt 并检查',
      objective: 'answer.txt 的内容变成 after，且一次检查命令成功退出',
      criteria: [{ statement: 'answer.txt 内容为 after', required: true, method: 'HUMAN' }],
      expected_outputs: { kind: 'MARKDOWN_DOCUMENT' },
      file_changes: [{ path: 'answer.txt', action: 'MODIFY' }],
      check: { executable: process.execPath, args: ['--version'] } } }, interpretationRequests) });
  assert.equal(prepared.result.decision, 'PREPARE');
  assert.equal(prepared.result.status, 'READY');
  assert.equal((prepared.result.candidate?.title ?? null), '改写 answer.txt 并检查');
  // 确认页必须能看到这次会真正执行的那条命令：候选要把它原样带给前端。
  // 这条断言是前端 ExecutionSummary 那块展示的唯一服务端侧证据——没有它，
  // 「组件会渲染」只能靠模拟响应证明，真实链路上 check 可能根本没传过去。
  assert.deepEqual(prepared.result.candidate?.check,
    { executable: process.execPath, args: ['--version'] });
  assert.equal(interpretationRequests[1]?.userContent, '帮我把这个文件的内容改成 after 并跑一次检查');
  assert.ok(interpretationRequests[1]?.system.includes(RELAY_AGENT_CORE_PROMPT));
  // 方案 B：解释只产出目标与范围，不产出文件正文——真正的读取与改写由 Run 内的工具循环做。
  assert.match(interpretationRequests[1]!.system, /只写 path 与 action，不要写 content/u);
  assert.match(interpretationRequests[1]!.system, /不要因为「还没读过文件」而 CLARIFY/u);
  // 候选已经落库：同一原消息再次提交不会产生第二个请求行，也不会重付模型整理成本。
  const rows = await withTransaction(app.db, (repositories) =>
    repositories.conversationExecutions.listSessionRequests(workspaceId, asked.sessionId));
  assert.equal(rows.filter((row) => row.source_message_id === asked.userMessageId).length, 1);
  const again = await interpretConversationMessage(app.db, { workspaceId,
    sessionId: asked.sessionId, sourceMessageId: asked.userMessageId, resourceId, commandId,
    modelPort: port({ decision: 'DISCUSS' }, interpretationRequests) });
  assert.equal(again.result.decision, 'PREPARE');
  assert.equal(again.result.request_id, prepared.result.request_id);
  assert.equal(interpretationRequests.length, 2);

  const target = join(root, 'answer.txt');
  await writeFile(target, 'before\n', 'utf8');
  // 缺连接时不静默放行：先给出具体原因，再由调用方补齐有效配置。
  // 方案 B 下工具循环必须先能读，因此报出的是第一项缺失的读能力。
  await assert.rejects(() => applyConversationExecution(app.db, { workspaceId,
    requestId: prepared.result.request_id }), /FILE_QUERY 连接/);

  const resource = await createRepositories(app.db).gateway.readResource(resourceId);
  assert.ok(resource !== undefined);
  const connectionId = await rootBoundConnection(app.db, { workspaceId, projectId,
    canonicalRoot: resource.canonical_root,
    // process.execPath 是受管根之外的解释器：没有这份点名，冻结期就该拒绝它。
    allowedExecutables: [process.execPath],
    capabilities: ['FILE_QUERY', 'FILE_READ', 'FILE_WRITE', 'CLI_RUN'] });
  for (const [capability, actionType] of [['FILE_QUERY', 'LIST_DIRECTORY'],
    ['FILE_QUERY', 'FIND_PATHS'], ['FILE_QUERY', 'SEARCH_TEXT'], ['FILE_READ', 'READ_FILE'],
    ['FILE_WRITE', 'APPLY_CHANGESET'], ['FILE_WRITE', 'READ_CHANGE_SET'],
    ['CLI_RUN', 'CLI_RUN']] as const) {
    await createGatewayPolicy(app.db, { workspaceId, projectId, capability, actionType,
      targetPrefix: resource.canonical_root, decision: 'AUTO', maxPayloadBytes: 262144 });
  }

  const applied = await applyConversationExecution(app.db, { workspaceId,
    requestId: prepared.result.request_id });
  assert.ok(applied.task_id !== null);
  assert.ok(applied.run_id !== null);
  const replayedApply = applyConversationExecution(app.db, { workspaceId,
    requestId: prepared.result.request_id });
  const settled = await replayedApply;
  assert.equal(settled.task_id, applied.task_id);
  assert.equal(settled.run_id, applied.run_id);

  const contract = await withTransaction(app.db, (repositories) =>
    repositories.runs.readContract(applied.run_id as string));
  assert.ok(contract !== undefined);
  // 冻结的是工具循环信封与本次任务范围授权，不再是预制好的文件变更与命令。
  const snapshot = contract.frozen_snapshot as { tool_loop_action?: { resource_id?: string;
    allowed_tools?: readonly string[]; connections?: Record<string, string>;
    max_rounds?: number; max_tool_calls?: number };
    file_write_action?: unknown; cli_run_action?: unknown };
  assert.equal(snapshot.file_write_action, undefined);
  assert.equal(snapshot.cli_run_action, undefined);
  assert.equal(snapshot.tool_loop_action?.resource_id, resourceId);
  assert.deepEqual(snapshot.tool_loop_action?.allowed_tools,
    ['list_directory', 'find_paths', 'search_text', 'read_file', 'apply_changeset',
      'read_change_set', 'run_check']);
  assert.equal(snapshot.tool_loop_action?.connections?.FILE_WRITE, connectionId);

  // 授权只放行本次范围内的普通编辑与已配置检查；删除永远不在其中。
  const grant = await withTransaction(app.db, (repositories) =>
    repositories.scopeGrants.readByRun(applied.run_id as string));
  assert.ok(grant !== undefined);
  assert.deepEqual([...grant.allowed_actions].sort(), ['APPLY_CHANGESET', 'CLI_RUN']);
  assert.equal(grant.checks.length, 1);
  const frozenChecks = grant.checks as unknown as readonly FrozenCheck[];
  assert.match(frozenChecks[0]!.executable_sha256, /^[0-9a-f]{64}$/);

  // 真实链：Run 内的模型先读真实文件，再改，再跑一次已配置检查。
  const rowsOfRun = await driveToolLoop(applied.run_id as string, workspaceId, [
    [{ name: 'read_file', arguments: { relative_path: 'answer.txt' } }],
    [{ name: 'apply_changeset', arguments: { changes: [{ action: 'MODIFY',
      path: 'answer.txt', baselineSha256: await sha256Of(target),
      content: 'after\n' }] } }],
    [{ name: 'run_check', arguments: { check_id: frozenChecks[0]!.id } }],
  ]);
  assert.equal(await readFile(target, 'utf8'), 'after\n');
  assert.deepEqual(rowsOfRun.map((row) => row.status), ['SETTLED', 'SETTLED', 'SETTLED']);
  // 读到的必须是磁盘上的真实内容，而不是预制答案。
  const read = rowsOfRun[0]!;
  assert.ok(String(read.result_ref?.content).includes('before'));
});

test('不提供文件名时模型自行定位并改写；只读请求不需要写连接，两种授权形状各自成立', async () => {
  const workspaceId = await workspace('conversation-scope');
  const root = await tempRoot();
  const opened = await openWorkingDirectory(app.db, { workspaceId, commandId: randomUUID(), rootPath: root });
  const projectId = opened.result.association?.project_id ?? '';
  const resourceId = opened.result.association?.resource_id ?? '';
  const resource = await createRepositories(app.db).gateway.readResource(resourceId);
  assert.ok(resource !== undefined);

  // 目录里有两个文件，用户只描述问题不给文件名；解析器有真实缺陷，另一个文件无关。
  const broken = join(root, 'parser.ts');
  const unrelated = join(root, 'notes.md');
  await writeFile(broken, 'export const parse = (v: string) => Number(v);\n', 'utf8');
  await writeFile(unrelated, 'unrelated-user-note: keep this line\n', 'utf8');

  const readerOnly = await rootBoundConnection(app.db, { workspaceId, projectId,
    canonicalRoot: resource.canonical_root, capabilities: ['FILE_QUERY', 'FILE_READ'] });
  assert.notEqual(readerOnly, '');
  for (const [capability, actionType] of [['FILE_QUERY', 'LIST_DIRECTORY'],
    ['FILE_QUERY', 'FIND_PATHS'], ['FILE_QUERY', 'SEARCH_TEXT'], ['FILE_READ', 'READ_FILE']] as const) {
    await createGatewayPolicy(app.db, { workspaceId, projectId, capability, actionType,
      targetPrefix: resource.canonical_root, decision: 'AUTO', maxPayloadBytes: 262144 });
  }

  // 只读请求：只有读连接也必须能真正进入执行，不能因为缺少 FILE_WRITE 连接被挡住。
  const reading = await sessionIn(workspaceId, projectId, '先看看这个目录里有哪些文件');
  const readPrepared = await interpretConversationMessage(app.db, { workspaceId,
    sessionId: reading.sessionId, sourceMessageId: reading.userMessageId, resourceId,
    commandId: randomUUID(), modelPort: port({ decision: 'PREPARE', task: {
      title: '盘点目录文件',
      objective: '列出生效文件清单并说明每个文件的作用',
      criteria: [{ statement: '清单覆盖目录内全部生效文件', required: true, method: 'HUMAN' }],
      expected_outputs: { kind: 'MARKDOWN_DOCUMENT' }, writes_files: false } }) });
  assert.equal(readPrepared.result.decision, 'PREPARE');
  const readApplied = await applyConversationExecution(app.db, { workspaceId,
    requestId: readPrepared.result.request_id });
  assert.ok(readApplied.run_id !== null);
  const readContract = await withTransaction(app.db, (repositories) =>
    repositories.runs.readContract(readApplied.run_id as string));
  const readSnapshot = readContract?.frozen_snapshot as { tool_loop_action?: {
    allowed_tools?: readonly string[]; connections?: Record<string, string> } };
  assert.deepEqual(readSnapshot.tool_loop_action?.allowed_tools,
    ['list_directory', 'find_paths', 'search_text', 'read_file']);
  assert.equal(readSnapshot.tool_loop_action?.connections?.FILE_WRITE, undefined);
  // 只读 Run 也没有编辑授权：范围授权里没有任何可写动作。
  const readGrant = await withTransaction(app.db, (repositories) =>
    repositories.scopeGrants.readByRun(readApplied.run_id as string));
  // 纯只读任务不产生任何授权事实，而不是落一条空的范围授权。
  assert.equal(readGrant, undefined);

  // 用户只描述问题、不给文件名：解释模型没有目录访问，拿不准具体路径是正常结果。
  // 这时仍必须按明确修改意图授予范围内的编辑能力，否则模型永远改不了任何东西。
  await rootBoundConnection(app.db, { workspaceId, projectId,
    canonicalRoot: resource.canonical_root, capabilities: ['FILE_WRITE'] });
  for (const [capability, actionType] of [['FILE_WRITE', 'APPLY_CHANGESET'],
    ['FILE_WRITE', 'READ_CHANGE_SET']] as const) {
    await createGatewayPolicy(app.db, { workspaceId, projectId, capability, actionType,
      targetPrefix: resource.canonical_root, decision: 'AUTO', maxPayloadBytes: 262144 });
  }

  const vague = await sessionIn(workspaceId, projectId,
    '目录里那个把字符串转数字的解析函数处理空串会崩，修一下');
  const vaguePrepared = await interpretConversationMessage(app.db, { workspaceId,
    sessionId: vague.sessionId, sourceMessageId: vague.userMessageId, resourceId,
    commandId: randomUUID(), modelPort: port({ decision: 'PREPARE', task: {
      title: '修复解析函数空串崩溃',
      objective: 'parse 遇到空串不再抛出异常，返回可判断的结果',
      criteria: [{ statement: 'parse("") 不抛出异常', required: true, method: 'HUMAN' }],
      expected_outputs: { kind: 'MARKDOWN_DOCUMENT' },
      writes_files: true, file_changes: [] } }) });
  assert.equal(vaguePrepared.result.decision, 'PREPARE');
  const vagueApplied = await applyConversationExecution(app.db, { workspaceId,
    requestId: vaguePrepared.result.request_id });
  assert.ok(vagueApplied.run_id !== null);
  const vagueContract = await withTransaction(app.db, (repositories) =>
    repositories.runs.readContract(vagueApplied.run_id as string));
  const vagueSnapshot = vagueContract?.frozen_snapshot as { tool_loop_action?: {
    allowed_tools?: readonly string[] } };
  assert.deepEqual(vagueSnapshot.tool_loop_action?.allowed_tools,
    ['list_directory', 'find_paths', 'search_text', 'read_file',
      'apply_changeset', 'read_change_set']);
  const vagueGrant = await withTransaction(app.db, (repositories) =>
    repositories.scopeGrants.readByRun(vagueApplied.run_id as string));
  assert.deepEqual([...(vagueGrant?.allowed_actions ?? [])], ['APPLY_CHANGESET']);

  // 真实链：模型先自行定位到 parser.ts，读到真实内容后才改；无关文件不受影响。
  const rows = await driveToolLoop(vagueApplied.run_id as string, workspaceId, [
    [{ name: 'search_text', arguments: { query: 'Number(v)' } }],
    [{ name: 'read_file', arguments: { relative_path: 'parser.ts' } }],
    [{ name: 'apply_changeset', arguments: { changes: [{ action: 'MODIFY', path: 'parser.ts',
      baselineSha256: await sha256Of(broken),
      content: 'export const parse = (v: string) => (v.trim() === "" ? 0 : Number(v));\n' }] } }],
  ]);
  assert.deepEqual(rows.map((row) => row.status), ['SETTLED', 'SETTLED', 'SETTLED']);
  const located = JSON.stringify(rows[0]!.result_ref);
  assert.ok(located.includes('parser.ts'), `搜索结果应定位到真实文件：${located}`);
  assert.ok(JSON.stringify(rows[1]!.result_ref).includes('Number(v)'));
  // 落盘的是模型读过真实文件后给出的内容，而不是解释阶段预制的正文。
  assert.match(await readFile(broken, 'utf8'), /v\.trim\(\) === ""/u);
  // 用户已有的无关内容必须原样保留：模型只改了它定位到的那一个文件。
  assert.equal(await readFile(unrelated, 'utf8'), 'unrelated-user-note: keep this line\n');
});

/** root-bound 能力的真实连接：绑定规范根，不接受空 config 的 Fake 路径。 */
async function rootBoundConnection(db: DbExecutor, input: {
  readonly workspaceId: string; readonly projectId: string; readonly canonicalRoot: string;
  readonly capabilities: readonly GatewayCapability[];
  /**
   * 根外可执行入口的允许清单。测试用 `process.execPath` 作为检查入口，而它在受管根之外，
   * 所以必须显式点名——这正是准入判定要锁住的产品行为。
   */
  readonly allowedExecutables?: readonly string[] | undefined;
}): Promise<string> {
  return withTransaction(db, async (repositories) => {
    await repositories.workspaces.lockAuthority(input.workspaceId, 'update');
    const connection = await repositories.gateway.insertConnection({ id: randomUUID(),
      workspaceId: input.workspaceId, projectId: input.projectId,
      config: { root_path: input.canonicalRoot,
        ...(input.allowedExecutables === undefined ? {} :
          { allowed_executables: [...input.allowedExecutables] }) } });
    for (const capability of input.capabilities) {
      await repositories.gateway.addConnectionCapability(connection.id, capability);
    }
    await repositories.workspaces.bumpAuthority(input.workspaceId);
    return connection.id;
  });
}

async function sha256Of(path: string): Promise<string> {
  const bytes = await readFile(path);
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * 有界驱动真实工具循环：advance 与工具派发交替，直到 Run 离开这两个状态。
 * 返回 DRAFT Attempt 的全部工具行，供断言核对真实读写真实检查。
 */
async function driveToolLoop(runId: string, workspaceId: string,
  script: readonly { readonly name: string; readonly arguments: JsonObject }[][]) {
  const storage = new ManagedContentStore(dataRoot);
  for (let iteration = 0; iteration < 20; iteration += 1) {
    const advanced = await advanceRunStep(app.db, { runId, workerId: `loop-${randomUUID()}`,
      storage, fakeToolScript: script });
    if (advanced.status === 'STEP_SUCCEEDED' || advanced.status === 'RETRYABLE' ||
        advanced.status === 'REPLAYED') continue;
    if (advanced.status !== 'TOOL_LOOP_ACTION_REQUIRED') break;
    const dispatched = await executeToolLoopStep(app.db, { claim: { commandId: randomUUID(),
      runId, workspaceId, kind: 'START', reviewDecisionId: null,
      workerId: `loop-${randomUUID()}`, epoch: 0n }, toolCallId: advanced.tool_call_id });
    if (dispatched.status !== 'SUCCEEDED') {
      assert.fail(`工具派发未成功：${dispatched.status}`);
    }
  }
  return withTransaction(app.db, async (repositories) => {
    const steps = await repositories.runs.listSteps(runId);
    const draft = steps.find((step) => step.step_kind === 'DRAFT');
    assert.ok(draft !== undefined);
    const attempts = await repositories.runs.listAttempts(draft.id);
    return new RunToolCallRepository(app.db).listByAttempt(attempts.at(-1)!.id);
  });
}
