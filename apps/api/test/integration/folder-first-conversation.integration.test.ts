import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test, { after, before } from 'node:test';
import { sql } from 'kysely';

import { createAssistSession, requestAssistMessage } from '../../src/application/assist-commands.js';
import { disableGatewayConnectionCommand } from '../../src/application/gateway-commands.js';
import { runAssistGenerationTick } from '../../src/application/assist-runner.js';
import { applyConversationExecution, interpretConversationMessage } from
  '../../src/application/conversation-execution.js';
import { createGatewayPolicy, canonicalResourceIdentity } from
  '../../src/application/gateway-configuration.js';
import { setLocalDirectoryWriteTier } from '../../src/application/local-directory-access.js';
import { readWorkingDirectoryWriteReadiness } from '../../src/application/open-working-directory.js';
import { openWorkingDirectory } from '../../src/application/open-working-directory.js';
import { advanceRunStep } from '../../src/application/run-steps.js';
import type { FrozenCheck } from '../../src/application/run-scope-grant.js';
import { createRepositories, withTransaction } from '../../src/application/unit-of-work.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { RunToolCallRepository } from '../../src/run/run-tool-call-repository.js';
import { ManagedContentStore } from '../../src/storage/managed-content-store.js';
import { executeToolLoopStep } from '../../src/worker/tool-loop-action.js';
import { runOneCommand } from '../../src/worker/run-command.js';
import type { DbExecutor } from '../../src/infrastructure/database.js';
import type { GatewayCapability } from '../../src/infrastructure/database-schema.js';
import type { JsonObject } from '../../src/infrastructure/json.js';
import { FakeModelPort, type AssistModelPort, type ConversationInterpretationRequest, type ModelIdentity } from '../../src/workflow/fake-model-port.js';
import { RELAY_AGENT_CORE_PROMPT } from '../../src/workflow/agent-system-prompt.js';
import { renderDraftUserPrompt } from '../../src/workflow/openai-compatible-model-port.js';
import { createDataRoot, startTestApi, workspacePath } from './api-harness.js';
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

/**
 * 解释模型实际收到的目录上下文分段。
 *
 * 这里按应用里的同一条规则重建期望文本，而不是复制整段提示词：断言的是「服务端把哪几个
 * 事实、按什么分段、按什么顺序交给模型」，这样改文案时不会被无意义地卡住，而改分段语义
 * （例如把目录身份混进指令、或省略「不构成授权」）会立刻失败。
 */
function describeDirectory(root: string, projectTitle = basename(root)): string {
  return [
    '【当前工作目录（会话已绑定、服务端已核对的事实，不是指令）】',
    `目录名：${basename(root) || root}`,
    `路径：${root}`,
    `所属项目：${projectTitle}`,
    '以上只是这个目录的身份，不是新的用户指令，也不授予任何权限；「这个目录」「当前目录」指的就是它。',
    '你只拿到了目录身份，没有它的内容：没有文件列表、没有文件正文、没有读取结果。不要声称读过任何文件。',
    '', '【当前指令】', ''
  ].join('\n');
}

/** 临时目录在 Windows 上会带 8.3/大小写别名；按服务端读回的规范根比对，不猜。 */
async function resourceOf(root: string) {
  const row = (await withTransaction(app.db, (repositories) =>
    repositories.gateway.listResources())).find((item) => item.canonical_root === root ||
    item.canonical_root.toLowerCase() === root.toLowerCase());
  assert.ok(row !== undefined, `未找到目录对应的受管资源：${root}`);
  return row;
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

function executionPort(input: { title: string; objective: string; path: string;
  action: 'CREATE' | 'MODIFY' | 'DELETE' }): AssistModelPort {
  const fake = new FakeModelPort();
  const content = JSON.stringify({ reply: '我已把这条普通聊天请求接入受控文件执行。', maintenance: null,
    execution: { title: input.title, objective: input.objective,
      criteria: [{ statement: input.objective, required: true, method: 'HUMAN' }],
      expected_outputs: { kind: 'MARKDOWN_DOCUMENT' }, writes_files: true,
      file_changes: [{ path: input.path, action: input.action }] } });
  return { identity: fake.identity, assist: async () => ({ kind: 'CONTENT', content,
    providerRequestId: `file-crud-${randomUUID()}`,
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: null, cacheCreationTokens: null } }) };
}

/**
 * 把本条助手消息驱动到结算。
 *
 * 消息轮次按整库先进先出领取，同一文件里前面直接解释的用例可能留下从未被领取的
 * PENDING 消息，所以不能假设一次 tick 就会领取本条。这里循环领取到本条离开 PENDING
 * 为止，仍由真实入口逐条处理，不绕过领取与租约。
 */
async function generateUntilSettled(api: Awaited<ReturnType<typeof startTestApi>>,
  workspaceId: string, sessionId: string, assistantMessageId: string,
  modelPort: AssistModelPort): Promise<string | undefined> {
  const messagesPath = workspacePath(workspaceId, `/assist-sessions/${sessionId}/messages`);
  const statusOf = async () => {
    const response = await api.get(messagesPath);
    assert.equal(response.status, 200, response.text);
    return (response.body as { items: { id: string; status: string }[] }).items
      .find((item) => item.id === assistantMessageId)?.status;
  };
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await statusOf() !== 'PENDING') break;
    const generated = await runAssistGenerationTick(app.db, {
      workerId: `method-main-loop-${randomUUID()}`,
      storage: new ManagedContentStore(api.dataRoot), leaseMs: 60_000, maxMessages: 1,
      modelPort });
    assert.ok(generated, '方法消息必须由普通主流程领取');
  }
  return statusOf();
}

async function prepareOrdinaryWrite(api: Awaited<ReturnType<typeof startTestApi>>, input: {
  workspaceId: string; projectId: string; resourceId: string; userContent: string;
  title: string; objective: string; path: string; action: 'CREATE' | 'MODIFY' | 'DELETE';
}) {
  const path = (suffix: string) => workspacePath(input.workspaceId, suffix);
  const created = await api.post(path('/assist-sessions'), { command_id: randomUUID(),
    project_id: input.projectId, title: `普通聊天 ${input.action}` });
  assert.equal(created.status, 201, created.text);
  const sessionId = (created.body as { result: { session_id: string } }).result.session_id;
  const bound = await api.post(path(`/assist-sessions/${sessionId}/working-directory`), {
    command_id: randomUUID(), resource_id: input.resourceId });
  assert.equal(bound.status, 200, bound.text);
  const sent = await api.post(path(`/assist-sessions/${sessionId}/messages`), {
    command_id: randomUUID(), content: input.userContent, intent: 'DISCUSS' });
  assert.equal(sent.status, 202, sent.text);
  const sentResult = (sent.body as { result: { user_message_id: string; assistant_message_id: string } }).result;
  const generated = await runAssistGenerationTick(app.db, { workerId: `file-crud-${randomUUID()}`,
    storage: new ManagedContentStore(api.dataRoot), modelPort: executionPort(input), leaseMs: 60_000, maxMessages: 1 });
  assert.ok(generated, '普通聊天消息必须由原 Assist 主流程领取');

  const messages = await api.get(path(`/assist-sessions/${sessionId}/messages`));
  assert.equal(messages.status, 200, messages.text);
  const assistant = (messages.body as { items: { id: string; status: string; content: string | null;
    error_code: string | null }[] })
    .items.find((item) => item.id === sentResult.assistant_message_id);
  assert.equal(assistant?.status, 'COMPLETED', JSON.stringify({ generated, assistant }));
  assert.match(assistant?.content ?? '', /受控文件执行/u);

  const requestList = await api.get(path(`/conversation-execution-requests?session_id=${sessionId}`));
  assert.equal(requestList.status, 200, requestList.text);
  const request = (requestList.body as { items: { request_id: string; source_message_id: string;
    status: string; candidate: JsonObject | null }[] }).items.find((item) =>
    item.source_message_id === sentResult.user_message_id);
  assert.ok(request, '主流程候选必须落在该用户原消息的请求行');
  assert.equal(request.status, 'READY');
  assert.equal((request.candidate as JsonObject | null)?.writes_files, true);

  const applied = await api.post(path(`/conversation-execution-requests/${request.request_id}/applications`), {});
  assert.equal(applied.status, 200, applied.text);
  const appliedResult = (applied.body as { result: { task_id: string; run_id: string; status: string } }).result;
  assert.equal(appliedResult.status, 'DELEGATED');
  const replay = await api.post(path(`/conversation-execution-requests/${request.request_id}/applications`), {});
  assert.equal(replay.status, 200, replay.text);
  assert.equal((replay.body as { result: { run_id: string } }).result.run_id, appliedResult.run_id,
    '原请求重放必须复用同一个 Run');
  return { sessionId, userMessageId: sentResult.user_message_id, requestId: request.request_id,
    taskId: appliedResult.task_id, runId: appliedResult.run_id };
}

async function openAutoWriteDirectory(api: Awaited<ReturnType<typeof startTestApi>>, name: string,
  files: Readonly<Record<string, string>> = {}) {
  const workspaceId = await workspace(name);
  const root = await tempRoot();
  for (const [relativePath, content] of Object.entries(files)) {
    const target = join(root, relativePath);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
  const open = await api.post(workspacePath(workspaceId, '/working-directories/open'), {
    command_id: randomUUID(), root_path: root });
  assert.equal(open.status, 200, open.text);
  const result = (open.body as { result: { association: { project_id: string; resource_id: string };
    write_readiness: { access_revision: string; write_tier: string } } }).result;
  const { project_id: projectId, resource_id: resourceId } = result.association;
  assert.equal(result.write_readiness.write_tier, 'READ_ONLY');
  const write = await api.post(workspacePath(workspaceId,
    `/projects/${projectId}/managed-resources/${resourceId}/local-access`), {
    command_id: randomUUID(), expected_revision: result.write_readiness.access_revision,
    write_tier: 'AUTO' });
  assert.equal(write.status, 200, write.text);
  return { workspaceId, projectId, resourceId, root };
}

async function runToolScript(api: Awaited<ReturnType<typeof startTestApi>>, runId: string,
  script: readonly { readonly name: string; readonly arguments: JsonObject }[][]) {
  const delivered = await runOneCommand(app.db, { workerId: `ordinary-file-crud-${randomUUID()}`,
    dataRoot: api.dataRoot, checkpointUrl: APP_DATABASE_URL, fakeToolScript: script });
  assert.equal(delivered?.runId, runId, `Run Worker 必须消费原 Run：${JSON.stringify(delivered)}`);
}

async function runToolFeed(api: Awaited<ReturnType<typeof startTestApi>>, workspaceId: string, runId: string) {
  const response = await api.get(workspacePath(workspaceId, `/runs/${runId}/tool-calls`));
  assert.equal(response.status, 200, response.text);
  return response.body as { run_id: string; run_status: string; wait_reason: string | null;
    rounds: { round: number; calls: { tool_name: string; status: string; result_ref: JsonObject | null;
      file_changes: { path: string; action: string; status: string }[] }[] }[] };
}

async function readonlyRequest(name: string) {
  const workspaceId = await workspace(name);
  const root = await tempRoot();
  const opened = await openWorkingDirectory(app.db, { workspaceId, commandId: randomUUID(), rootPath: root });
  const { project_id: projectId, resource_id: resourceId } = opened.result.association!;
  const asked = await sessionIn(workspaceId, projectId, '读取目录并整理现状');
  const prepared = await interpretConversationMessage(app.db, { workspaceId,
    sessionId: asked.sessionId, sourceMessageId: asked.userMessageId, resourceId,
    commandId: randomUUID(), modelPort: port({ decision: 'PREPARE', task: {
      title: '读取目录', objective: '整理目录现状',
      criteria: [{ statement: '列出目录现状', required: true, method: 'HUMAN' }],
      expected_outputs: { kind: 'MARKDOWN_DOCUMENT' }, file_changes: [] } }) });
  const resource = await createRepositories(app.db).gateway.readResource(resourceId);
  assert.ok(resource);
  return { workspaceId, projectId, root: resource.canonical_root, requestId: prepared.result.request_id };
}

async function assertSingleExecution(workspaceId: string) {
  const counts = await sql<{ tasks: string; runs: string }>`select
    (select count(*) from tasks where workspace_id = ${workspaceId})::text as tasks,
    (select count(*) from runs where workspace_id = ${workspaceId})::text as runs`.execute(app.db);
  assert.deepEqual(counts.rows[0], { tasks: '1', runs: '1' });
}

test('普通聊天主流程通过原消息与 Run 工具结果完成真实 CREATE/MODIFY', async () => {
  const api = await startTestApi();
  try {
    const createdEnv = await openAutoWriteDirectory(api, 'ordinary-chat-create');
    const createdText = `创建样本\nUTF-8：中文🚀\n${randomUUID()}\n`;
    const created = await prepareOrdinaryWrite(api, { ...createdEnv,
      userContent: `在当前目录新建 create.txt，内容为本次测试样本。`,
      title: '新建 create.txt', objective: 'create.txt 已写入测试内容',
      path: 'create.txt', action: 'CREATE' });
    await runToolScript(api, created.runId, [[{ name: 'apply_changeset', arguments: { changes: [
      { action: 'CREATE', path: 'create.txt', content: createdText },
    ] } }]]);
    assert.deepEqual(await readFile(join(createdEnv.root, 'create.txt')), Buffer.from(createdText, 'utf8'));
    const createFeed = await runToolFeed(api, createdEnv.workspaceId, created.runId);
    const createCall = createFeed.rounds.flatMap((round) => round.calls)
      .find((call) => call.tool_name === 'apply_changeset');
    assert.equal(createCall?.status, 'SETTLED');
    assert.deepEqual(createCall?.file_changes.map((change) =>
      [change.path, change.action, change.status]), [['create.txt', 'CREATE', 'APPLIED']]);
    const createProjection = await api.get(workspacePath(createdEnv.workspaceId,
      `/conversation-execution-requests?session_id=${created.sessionId}`));
    const createRequest = (createProjection.body as { items: { source_message_id: string;
      run_id: string | null }[] }).items.find((item) => item.source_message_id === created.userMessageId);
    assert.equal(createRequest?.run_id, created.runId,
      '原会话中的原用户消息必须能读回真实执行结果所属的 Run');

    const original = '标题\n保留段落\nreplace-this\n结尾\n';
    const replacement = '标题\n保留段落\nreplacement\n结尾\n';
    const modifiedEnv = await openAutoWriteDirectory(api, 'ordinary-chat-modify', { 'modify.txt': original });
    const modified = await prepareOrdinaryWrite(api, { ...modifiedEnv,
      userContent: '读取 modify.txt，把 replace-this 替换成 replacement，其他内容保留。',
      title: '修改 modify.txt', objective: 'modify.txt 中的目标行已替换且其他内容保留',
      path: 'modify.txt', action: 'MODIFY' });
    const baselineSha256 = await sha256Of(join(modifiedEnv.root, 'modify.txt'));
    await runToolScript(api, modified.runId, [
      [{ name: 'read_file', arguments: { relative_path: 'modify.txt' } }],
      [{ name: 'apply_changeset', arguments: { changes: [
        { action: 'MODIFY', path: 'modify.txt', baselineSha256, content: replacement },
      ] } }],
    ]);
    assert.equal(await readFile(join(modifiedEnv.root, 'modify.txt'), 'utf8'), replacement);
    const modifyFeed = await runToolFeed(api, modifiedEnv.workspaceId, modified.runId);
    const modifyCalls = modifyFeed.rounds.flatMap((round) => round.calls);
    assert.ok(String(modifyCalls.find((call) => call.tool_name === 'read_file')?.result_ref?.content)
      .includes(original), '修改前的基线必须由真实 read_file 工具从磁盘读取');
    assert.deepEqual(modifyCalls.find((call) => call.tool_name === 'apply_changeset')?.file_changes
      .map((change) => [change.path, change.action, change.status]),
    [['modify.txt', 'MODIFY', 'APPLIED']]);
  } finally { await api.stop(); }
});

test('普通聊天 DELETE 在确切 Review 前不落盘，批准删除、拒绝保留并反馈原会话', async () => {
  const api = await startTestApi();
  try {
    const runDeleteDecision = async (decision: 'APPROVE' | 'DENY', name: string) => {
      const original = `delete sample ${randomUUID()}\n`;
      const env = await openAutoWriteDirectory(api, name, { 'delete.txt': original });
      const chat = await prepareOrdinaryWrite(api, { ...env,
        userContent: '删除当前目录中的 delete.txt。', title: '删除 delete.txt',
        objective: 'delete.txt 根据当前用户的确切确认删除', path: 'delete.txt', action: 'DELETE' });
      const script: { readonly name: string; readonly arguments: JsonObject }[][] = [
        [{ name: 'read_file', arguments: { relative_path: 'delete.txt' } }],
        [{ name: 'apply_changeset', arguments: { changes: [{ action: 'DELETE', path: 'delete.txt',
          baselineSha256: await sha256Of(join(env.root, 'delete.txt')) }] } }],
      ];
      await runToolScript(api, chat.runId, script);
      assert.equal(await readFile(join(env.root, 'delete.txt'), 'utf8'), original,
        'AUTO 档不能越过 DELETE 的单动作 Review');
      const initialFeed = await runToolFeed(api, env.workspaceId, chat.runId);
      const pending = initialFeed.rounds.flatMap((round) => round.calls)
        .find((call) => call.tool_name === 'apply_changeset');
      assert.equal(pending?.status, 'WAITING_APPROVAL');
      const runReviews = await api.get(workspacePath(env.workspaceId, `/runs/${chat.runId}/reviews`));
      assert.equal(runReviews.status, 200, runReviews.text);
      const actionReview = (runReviews.body as { items: { id: string; kind: string; status: string;
        revision: string; target_hash: string }[] }).items.find((review) =>
        review.kind === 'ACTION_APPROVAL' && review.status === 'OPEN');
      assert.ok(actionReview, '删除必须有绑定本次 Operation 的待确认 Review');
      const decided = await api.post(workspacePath(env.workspaceId,
        `/reviews/${actionReview.id}/decisions`), { command_id: randomUUID(),
        expected_revision: actionReview.revision, target_hash: actionReview.target_hash, decision });
      assert.equal(decided.status, 200, decided.text);
      if (decision === 'APPROVE') {
        await runToolScript(api, chat.runId, script);
        await assert.rejects(() => readFile(join(env.root, 'delete.txt')),
          (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
      } else {
        assert.equal(await readFile(join(env.root, 'delete.txt'), 'utf8'), original,
          '拒绝 Review 后真实磁盘字节必须保留');
      }
      const finalFeed = await runToolFeed(api, env.workspaceId, chat.runId);
      const finalDeleteCall = finalFeed.rounds.flatMap((round) => round.calls)
        .find((call) => call.tool_name === 'apply_changeset');
      assert.notEqual(finalDeleteCall?.status, 'WAITING_APPROVAL',
        '原会话工具投影不能在 Review 已决定后仍显示永久等待');
      assert.equal(finalDeleteCall?.result_ref?.reason,
        decision === 'DENY' ? 'HUMAN_DENIED' : undefined);
      if (decision === 'APPROVE') {
        assert.deepEqual(finalDeleteCall?.file_changes.map((change) =>
          [change.path, change.action, change.status]), [['delete.txt', 'DELETE', 'APPLIED']]);
      }
      const sessionRequests = await api.get(workspacePath(env.workspaceId,
        `/conversation-execution-requests?session_id=${chat.sessionId}`));
      assert.equal(sessionRequests.status, 200, sessionRequests.text);
      assert.ok((sessionRequests.body as { items: { source_message_id: string; run_id: string | null }[] })
        .items.some((request) => request.source_message_id === chat.userMessageId &&
          request.run_id === chat.runId), '原消息仍指向包含删除结果的同一 Run');
    };
    await runDeleteDecision('APPROVE', 'ordinary-chat-delete-approved');
    await runDeleteDecision('DENY', 'ordinary-chat-delete-denied');
  } finally { await api.stop(); }
});

/**
 * 完全访问档的真实准入闭环（迁移 0112）。
 *
 * 上一例证明 AUTO 档的删除一定停在 ACTION_APPROVAL；这里只改变同一目录的档位，
 * 其余流程逐字相同，因此两者的差值就是「档位」这一件事。策略行仍是 AUTO，
 * 差别只记在 local_directory_access.write_tier 上。
 */
test('完全访问档：本目录 DELETE 不产生 ACTION_APPROVAL 并真实落盘', async () => {
  const api = await startTestApi();
  try {
    const original = `full-access delete sample ${randomUUID()}\n`;
    const env = await openAutoWriteDirectory(api, 'full-access-directory-delete', { 'delete.txt': original });
    const readinessPath = workspacePath(env.workspaceId,
      `/projects/${env.projectId}/managed-resources/${env.resourceId}/write-readiness`);
    const revision = (await api.get(readinessPath)
      .then((response) => response.body) as { access_revision: string }).access_revision;
    const upgraded = await api.post(workspacePath(env.workspaceId,
      `/projects/${env.projectId}/managed-resources/${env.resourceId}/local-access`), {
      command_id: randomUUID(), expected_revision: revision, write_tier: 'FULL' });
    assert.equal(upgraded.status, 200, upgraded.text);
    assert.equal((upgraded.body as { result: { write_tier: string } }).result.write_tier, 'FULL');
    const upgradedReadiness = await api.get(readinessPath)
      .then((response) => response.body) as { write_tier: string; policy_decision: string; detail: string };
    // 完全访问在权限侧就是一条 AUTO 策略：网关没有第四种判定，豁免来自目录档位。
    assert.equal(upgradedReadiness.policy_decision, 'AUTO');
    assert.equal(upgradedReadiness.write_tier, 'FULL');
    assert.match(upgradedReadiness.detail, /完全访问/u);

    const chat = await prepareOrdinaryWrite(api, { ...env,
      userContent: '删除当前目录中的 delete.txt。', title: '删除 delete.txt',
      objective: 'delete.txt 已按完全访问档删除', path: 'delete.txt', action: 'DELETE' });
    await runToolScript(api, chat.runId, [
      [{ name: 'read_file', arguments: { relative_path: 'delete.txt' } }],
      [{ name: 'apply_changeset', arguments: { changes: [{ action: 'DELETE', path: 'delete.txt',
        baselineSha256: await sha256Of(join(env.root, 'delete.txt')) }] } }],
    ]);
    await assert.rejects(() => readFile(join(env.root, 'delete.txt')),
      (error: NodeJS.ErrnoException) => error.code === 'ENOENT',
      '完全访问目录内的删除必须真实落盘，不再停在待确认');
    const feed = await runToolFeed(api, env.workspaceId, chat.runId);
    const deleteCall = feed.rounds.flatMap((round) => round.calls)
      .find((call) => call.tool_name === 'apply_changeset');
    assert.equal(deleteCall?.status, 'SETTLED');
    assert.deepEqual(deleteCall?.file_changes.map((change) =>
      [change.path, change.action, change.status]), [['delete.txt', 'DELETE', 'APPLIED']]);
    const runReviews = await api.get(workspacePath(env.workspaceId, `/runs/${chat.runId}/reviews`));
    assert.equal((runReviews.body as { items: { kind: string }[] }).items
      .some((review) => review.kind === 'ACTION_APPROVAL'), false,
      '完全访问免掉的是单动作 Review，不是操作、调用与账本记录');
  } finally { await api.stop(); }
});

test('基础会话组合：HTTP 消息到执行、真实读取、成果读回和人工验收完成', async () => {
  const api = await startTestApi();
  try {
    const workspaceId = await workspace('basic-conversation-execution');
    const root = await tempRoot();
    const original = 'basic conversation source\n';
    await writeFile(join(root, 'notes.txt'), original);
    const path = (suffix: string) => workspacePath(workspaceId, suffix);
    const opened = await api.post(path('/working-directories/open'), {
      command_id: randomUUID(), root_path: root });
    assert.equal(opened.status, 200, opened.text);
    const { project_id: projectId, resource_id: resourceId } =
      (opened.body as { result: { association: { project_id: string; resource_id: string } } })
        .result.association;
    const resource = await createRepositories(app.db).gateway.readResource(resourceId);
    assert.ok(resource);
    const connections = await createRepositories(app.db).gateway.listConnections(workspaceId, projectId);
    assert.equal(connections.length, 1, '目录选择本身创建一条基础读取连接');
    assert.equal(connections[0]?.config.root_path, resource.canonical_root);
    assert.deepEqual(await createRepositories(app.db).gateway.listConnectionCapabilities(connections[0]!.id),
      ['FILE_QUERY', 'FILE_READ']);
    for (const [capability, actionType] of [['FILE_QUERY', 'LIST_DIRECTORY'],
      ['FILE_QUERY', 'FIND_PATHS'], ['FILE_QUERY', 'SEARCH_TEXT'], ['FILE_READ', 'READ_FILE']] as const) {
      const policies = await createRepositories(app.db).gateway.listActivePolicies(workspaceId, projectId,
        capability, actionType);
      assert.ok(policies.some((policy) => policy.target_prefix === resource.canonical_root &&
        policy.decision === 'AUTO'), `${actionType} read policy is created from directory selection`);
    }
    const created = await api.post(path('/assist-sessions'), {
      command_id: randomUUID(), project_id: projectId, title: '基础普通会话' });
    assert.equal(created.status, 201, created.text);
    const sessionId = (created.body as { result: { session_id: string } }).result.session_id;
    const sent = await api.post(path(`/assist-sessions/${sessionId}/messages`), {
      command_id: randomUUID(), content: '读取 notes.txt 并整理一份交付说明', intent: 'DISCUSS' });
    assert.equal(sent.status, 202, sent.text);
    const sourceMessageId = (sent.body as { result: { user_message_id: string } }).result.user_message_id;
    const interpreted = await api.post(path(`/assist-sessions/${sessionId}/execution-requests`), {
      command_id: randomUUID(), source_message_id: sourceMessageId, resource_id: resourceId });
    assert.equal(interpreted.status, 202, interpreted.text);
    const prepared = (interpreted.body as { result: { request_id: string; status: string } }).result;
    assert.equal(prepared.status, 'READY');
    const applied = await api.post(path(`/conversation-execution-requests/${prepared.request_id}/applications`), {});
    assert.equal(applied.status, 200, applied.text);
    const envelope = applied.body as { command_id: string; result: {
      request_id: string; status: string; task_id: string; run_id: string; revision: string } };
    assert.equal(envelope.command_id, prepared.request_id);
    assert.equal(envelope.result.request_id, prepared.request_id);
    assert.equal(envelope.result.status, 'DELEGATED');
    const { task_id: taskId, run_id: runId } = envelope.result;
    const deliver = () => runOneCommand(app.db, { workerId: `basic-conversation-${randomUUID()}`,
      dataRoot: api.dataRoot, checkpointUrl: APP_DATABASE_URL,
      fakeToolScript: [[{ name: 'read_file', arguments: { relative_path: 'notes.txt' } }]] });
    assert.equal((await deliver())?.runId, runId);
    const repositories = createRepositories(app.db);
    const tools = await repositories.toolCalls.listByRun(runId);
    assert.equal(tools.length, 1);
    assert.equal(tools[0]?.result_ref?.content, original);
    assert.equal((await repositories.runs.readRun(runId))?.status, 'WAITING_APPROVAL');
    const steps = await repositories.runs.listSteps(runId);
    const versionId = steps.find((step) => step.step_kind === 'PERSIST_CANDIDATE')
      ?.result_ref?.artifact_version_id;
    assert.equal(typeof versionId, 'string');
    const content = await api.get(path(`/artifact-versions/${String(versionId)}/content`));
    assert.equal(content.status, 200, content.text);
    assert.ok(content.text.trim().length > 0);
    const reviews = await api.get(path(`/runs/${runId}/reviews`));
    assert.equal(reviews.status, 200, reviews.text);
    const review = (reviews.body as { items: { id: string; revision: string; target_hash: string }[] }).items[0];
    assert.ok(review);
    const accepted = await api.post(path(`/reviews/${review.id}/decisions`), {
      command_id: randomUUID(), expected_revision: review.revision,
      target_hash: review.target_hash, decision: 'ACCEPT' });
    assert.equal(accepted.status, 200, accepted.text);
    assert.equal((await deliver())?.runId, runId);
    assert.equal((await repositories.runs.readRun(runId))?.status, 'COMPLETED');
    const task = await repositories.tasks.readTask(taskId);
    assert.equal(task?.status, 'DONE');
    assert.ok(task?.current_completion_id);
    const requests = await api.get(path(`/conversation-execution-requests?session_id=${sessionId}`));
    assert.equal(requests.status, 200, requests.text);
    assert.equal((requests.body as { items: { run_id: string }[] }).items[0]?.run_id, runId);
    const projected = (requests.body as { items: { request_id: string; resource_id: string; candidate: JsonObject | null }[] }).items[0]!;
    const saved = await repositories.conversationExecutions.readRequest(projected.request_id);
    assert.equal(projected.resource_id, saved?.resource_id);
    assert.deepEqual(projected.candidate, saved?.candidate);
    assert.equal(await readFile(join(root, 'notes.txt'), 'utf8'), original);
  } finally { await api.stop(); }
});

test('目录选择自动补齐读连接后接续原 Task，不重复建立 Task/Run', async () => {
  const request = await readonlyRequest('resume-after-connection');
  const delegated = await applyConversationExecution(app.db, request);
  assert.equal(delegated.status, 'DELEGATED');
  assert.deepEqual(await applyConversationExecution(app.db, request), delegated);
  await assertSingleExecution(request.workspaceId);
});

test('基础执行接续：委托已提交但请求阶段保存失败时核对原 Run', async () => {
  const request = await readonlyRequest('resume-saved-delegate');
  await rootBoundConnection(app.db, { ...request, canonicalRoot: request.root,
    capabilities: ['FILE_QUERY', 'FILE_READ'] });
  const migrator = openDatabase(MIGRATION_DATABASE_URL, 'relay-test-stage-failure');
  try {
    await sql`create function test_fail_conversation_delegated() returns trigger language plpgsql as $$
      begin if NEW.status = 'DELEGATED' then raise exception 'injected conversation stage failure';
      end if; return NEW; end $$`.execute(migrator.db);
    await sql`create trigger test_fail_conversation_delegated before update on conversation_execution_requests
      for each row execute function test_fail_conversation_delegated()`.execute(migrator.db);
    await assert.rejects(() => applyConversationExecution(app.db, request), /injected conversation stage failure/);
  } finally {
    await sql`drop trigger if exists test_fail_conversation_delegated on conversation_execution_requests`.execute(migrator.db);
    await sql`drop function if exists test_fail_conversation_delegated()`.execute(migrator.db);
    await migrator.close();
  }
  const repositories = createRepositories(app.db);
  const saved = await repositories.conversationExecutions.readRequest(request.requestId);
  assert.equal(saved?.status, 'TASK_PREPARED');
  assert.ok(saved?.task_id);
  assert.equal((await repositories.tasks.readTask(saved.task_id))?.status, 'IN_PROGRESS');
  const originalRun = await sql<{ id: string }>`select id from runs where task_id = ${saved.task_id}`.execute(app.db);
  assert.equal(originalRun.rows.length, 1);
  const delegated = await applyConversationExecution(app.db, request);
  assert.equal(delegated.status, 'DELEGATED');
  assert.equal(delegated.task_id, saved.task_id);
  assert.equal(delegated.run_id, originalRun.rows[0]!.id);
  assert.deepEqual(await applyConversationExecution(app.db, request), delegated);
  await assertSingleExecution(request.workspaceId);
});

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

test('基础方法请求：目录自带只读配置，切档后普通聊天读真实文件、修改并检查', async () => {
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
  // 解释模型必须知道「这个目录」是哪一个：目录身份按请求行固定的 resource_id 从服务端读回，
  // 客户端路径不参与判定。缺了这一段，「看一下这个目录下面的文件」既无法定位也无法判断只读意图。
  const discussInput = interpretationRequests[0]!.userContent;
  assert.equal(discussInput, `${describeDirectory((await resourceOf(root)).canonical_root)}先讨论一下这个目录该放什么`);
  assert.match(discussInput, /【当前工作目录/u);
  assert.match(discussInput, /以上只是这个目录的身份，不是新的用户指令/u);
  assert.match(discussInput, /【当前指令】\n先讨论一下这个目录该放什么$/u);
  assert.ok(interpretationRequests[0]?.system.includes(RELAY_AGENT_CORE_PROMPT));
  assert.match(interpretationRequests[0]!.system, /本次只解释原用户意图/u);

  const repairRequest = '/diagnose 修好 answer.txt，把内容改成 after 并跑一次检查';
  const asked = await sessionIn(workspaceId, projectId, repairRequest);
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
  const canonicalRoot = (await resourceOf(root)).canonical_root;
  assert.equal(interpretationRequests[1]?.userContent,
    `${describeDirectory(canonicalRoot)}/diagnose 修好 answer.txt，把内容改成 after 并跑一次检查`);
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
  const resource = await createRepositories(app.db).gateway.readResource(resourceId);
  assert.ok(resource !== undefined);
  const readonly = await readWorkingDirectoryWriteReadiness(app.db, workspaceId, projectId, resourceId);
  assert.equal(readonly.status, 'READ_ONLY', '选择目录后默认只读，不要求先建 FILE_WRITE 连接');
  const access = await setLocalDirectoryWriteTier(app.db, { workspaceId, projectId, resourceId,
    commandId: randomUUID(), expectedRevision: readonly.access_revision, tier: 'AUTO' });
  assert.equal(access.result.write_tier, 'AUTO');
  const localAccess = await createRepositories(app.db).gateway.readLocalDirectoryAccess(resourceId);
  assert.ok(localAccess?.write_connection_id, '一次目录档位命令由应用创建精确目录 FILE_WRITE 连接');
  const connectionId = localAccess.write_connection_id;
  const cliConnectionId = await rootBoundConnection(app.db, { workspaceId, projectId,
    canonicalRoot: resource.canonical_root, allowedExecutables: [process.execPath], capabilities: ['CLI_RUN'] });
  await createGatewayPolicy(app.db, { workspaceId, projectId, capability: 'CLI_RUN', actionType: 'CLI_RUN',
    targetPrefix: resource.canonical_root, decision: 'AUTO', maxPayloadBytes: 262144 });

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
  const method = contract.frozen_snapshot.execution_method as JsonObject;
  assert.equal(method.action, 'MODIFY');
  assert.equal(method.session_id, asked.sessionId);
  assert.equal(method.source_message_id, asked.userMessageId);
  assert.equal((method.method_snapshot as JsonObject).id, 'fault-diagnosis');
  const prompt = renderDraftUserPrompt({ contract: contract.frozen_snapshot });
  assert.match(prompt, /故障诊断（fault-diagnosis@1\.0\.0）/u);
  assert.ok(prompt.includes('用户已明确要求修改'));
  assert.ok(prompt.includes('修好 answer.txt'));
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
  assert.equal(snapshot.tool_loop_action?.connections?.CLI_RUN, cliConnectionId,
    '本地文件档位不得替 CLI 创建或扩张执行权限');

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
  const steps = await createRepositories(app.db).runs.listSteps(applied.run_id as string);
  const persisted = steps.find((step) => step.step_kind === 'PERSIST_CANDIDATE');
  assert.equal(persisted?.status, 'SUCCEEDED', JSON.stringify(steps.map((step) =>
    ({ kind: step.step_kind, status: step.status, result: step.result_ref }))));
  assert.equal(typeof persisted?.result_ref?.artifact_version_id, 'string');
  const run = await createRepositories(app.db).runs.readRun(applied.run_id as string);
  assert.equal(run?.status, 'WAITING_APPROVAL', '检查与候选保存完成后保留原 HUMAN 判断入口');
});

test('普通聊天里的方法 MODIFY：主流程保留 execution_method 并在 Run 内真实落盘', async () => {
  const api = await startTestApi();
  try {
    const original = 'before\n';
    const env = await openAutoWriteDirectory(api, 'method-main-loop-modify', { 'answer.txt': original });
    const path = (suffix: string) => workspacePath(env.workspaceId, suffix);
    const created = await api.post(path('/assist-sessions'), { command_id: randomUUID(),
      project_id: env.projectId, title: '方法修改主流程' });
    assert.equal(created.status, 201, created.text);
    const sessionId = (created.body as { result: { session_id: string } }).result.session_id;
    const bound = await api.post(path(`/assist-sessions/${sessionId}/working-directory`), {
      command_id: randomUUID(), resource_id: env.resourceId });
    assert.equal(bound.status, 200, bound.text);
    const sent = await api.post(path(`/assist-sessions/${sessionId}/messages`), {
      command_id: randomUUID(), intent: 'DISCUSS',
      content: '/diagnose 修好 answer.txt，把内容改成 after' });
    assert.equal(sent.status, 202, sent.text);
    const sentResult = (sent.body as { result: { user_message_id: string;
      assistant_message_id: string } }).result;
    const status = await generateUntilSettled(api, env.workspaceId, sessionId,
      sentResult.assistant_message_id,
      executionPort({ title: '改写 answer.txt', objective: 'answer.txt 内容变成 after',
        path: 'answer.txt', action: 'MODIFY' }));
    assert.equal(status, 'COMPLETED', '方法消息必须由普通主流程完成');
    const messages = await api.get(path(`/assist-sessions/${sessionId}/messages`));
    assert.equal(messages.status, 200, messages.text);
    const assistant = (messages.body as { items: { id: string; status: string; content: string | null }[] })
      .items.find((item) => item.id === sentResult.assistant_message_id);
    assert.match(assistant?.content ?? '', /受控文件执行/u);

    const requestList = await api.get(path(`/conversation-execution-requests?session_id=${sessionId}`));
    assert.equal(requestList.status, 200, requestList.text);
    const request = (requestList.body as { items: { request_id: string; source_message_id: string;
      status: string; candidate: JsonObject | null }[] }).items
      .find((item) => item.source_message_id === sentResult.user_message_id);
    assert.ok(request, '方法主流程的候选必须落在原用户消息的请求行');
    assert.equal(request.status, 'READY');
    assert.equal(request.candidate?.writes_files, true);
    const method = request.candidate?.execution_method as JsonObject;
    assert.equal(method.action, 'MODIFY', '主流程落库不能丢掉方法绑定');
    assert.equal((method.method_snapshot as JsonObject).id, 'fault-diagnosis');
    assert.equal(method.session_id, sessionId);
    assert.equal(method.source_message_id, sentResult.user_message_id);

    const applied = await api.post(path(
      `/conversation-execution-requests/${request.request_id}/applications`), {});
    assert.equal(applied.status, 200, applied.text);
    const runId = (applied.body as { result: { run_id: string } }).result.run_id;
    const contract = (await createRepositories(app.db).runs.readContract(runId))!;
    assert.equal((contract.frozen_snapshot.execution_method as JsonObject).action, 'MODIFY');
    const allowed = (contract.frozen_snapshot.tool_loop_action as JsonObject).allowed_tools as string[];
    assert.ok(allowed.includes('read_file') && allowed.includes('apply_changeset'),
      `方法 MODIFY 的 Run 必须拿到读写工具：${allowed.join(',')}`);
    assert.match(renderDraftUserPrompt({ contract: contract.frozen_snapshot }),
      /故障诊断（fault-diagnosis@1\.0\.0）/u);

    const target = join(env.root, 'answer.txt');
    const rows = await driveToolLoop(runId, env.workspaceId, [
      [{ name: 'read_file', arguments: { relative_path: 'answer.txt' } }],
      [{ name: 'apply_changeset', arguments: { changes: [{ action: 'MODIFY', path: 'answer.txt',
        baselineSha256: await sha256Of(target), content: 'after\n' }] } }],
    ]);
    assert.deepEqual(rows.map((row) => row.status), ['SETTLED', 'SETTLED']);
    assert.equal(await readFile(target, 'utf8'), 'after\n');
  } finally { await api.stop(); }
});

test('方法 INSPECT 的写候选被收口为 CLARIFY，不建 Task/Run、磁盘不变', async () => {
  const api = await startTestApi();
  try {
    const original = 'inspect-only\n';
    const env = await openAutoWriteDirectory(api, 'method-main-loop-inspect', { 'answer.txt': original });
    const path = (suffix: string) => workspacePath(env.workspaceId, suffix);
    const created = await api.post(path('/assist-sessions'), { command_id: randomUUID(),
      project_id: env.projectId, title: '方法只读主流程' });
    assert.equal(created.status, 201, created.text);
    const sessionId = (created.body as { result: { session_id: string } }).result.session_id;
    await api.post(path(`/assist-sessions/${sessionId}/working-directory`), {
      command_id: randomUUID(), resource_id: env.resourceId });
    const sent = await api.post(path(`/assist-sessions/${sessionId}/messages`), {
      command_id: randomUUID(), intent: 'DISCUSS', content: '/diagnose 看看 answer.txt 有没有问题' });
    assert.equal(sent.status, 202, sent.text);
    const sentResult = (sent.body as { result: { user_message_id: string;
      assistant_message_id: string } }).result;
    const status = await generateUntilSettled(api, env.workspaceId, sessionId,
      sentResult.assistant_message_id,
      executionPort({ title: '不该出现的写候选', objective: '不该落盘',
        path: 'answer.txt', action: 'MODIFY' }));
    assert.equal(status, 'COMPLETED');
    const requestList = await api.get(path(`/conversation-execution-requests?session_id=${sessionId}`));
    const request = (requestList.body as { items: { status: string; candidate: JsonObject | null;
      source_message_id: string }[] }).items
      .find((item) => item.source_message_id === sentResult.user_message_id);
    assert.equal(request?.status, 'CLARIFY');
    assert.equal(request?.candidate, null);
    const counts = await sql<{ tasks: string; runs: string }>`select
      (select count(*) from tasks where workspace_id = ${env.workspaceId})::text as tasks,
      (select count(*) from runs where workspace_id = ${env.workspaceId})::text as runs`.execute(app.db);
    assert.deepEqual(counts.rows[0], { tasks: '0', runs: '0' });
    assert.equal(await readFile(join(env.root, 'answer.txt'), 'utf8'), original);
  } finally { await api.stop(); }
});

test('基础只读方法：只配读连接即可进入 Run 并读取文件，原学习身份不进入执行', async () => {
  const workspaceId = await workspace('basic-method-inspect');
  const root = await tempRoot();
  await writeFile(join(root, 'note.txt'), 'read-only evidence\n');
  const opened = await openWorkingDirectory(app.db, { workspaceId, commandId: randomUUID(), rootPath: root });
  const projectId = opened.result.association!.project_id;
  const resourceId = opened.result.association!.resource_id;
  const resource = (await createRepositories(app.db).gateway.readResource(resourceId))!;
  await rootBoundConnection(app.db, { workspaceId, projectId, canonicalRoot: resource.canonical_root,
    capabilities: ['FILE_QUERY', 'FILE_READ'] });
  await createGatewayPolicy(app.db, { workspaceId, projectId, capability: 'FILE_READ', actionType: 'READ_FILE',
    targetPrefix: resource.canonical_root, decision: 'AUTO', maxPayloadBytes: 262144 });
  const asked = await sessionIn(workspaceId, projectId, '/review 看看 note.txt');
  const interpreted = await interpretConversationMessage(app.db, { workspaceId,
    sessionId: asked.sessionId, sourceMessageId: asked.userMessageId, resourceId, commandId: randomUUID(),
    modelPort: port({ decision: 'PREPARE', task: { title: '检查 note.txt', objective: '阅读并报告',
      criteria: [{ statement: '有依据的阅读结论', required: true, method: 'HUMAN' }],
      expected_outputs: { kind: 'MARKDOWN_DOCUMENT' }, writes_files: false } }) });
  const applied = await applyConversationExecution(app.db, { workspaceId, requestId: interpreted.result.request_id });
  assert.ok(applied.run_id);
  const contract = (await createRepositories(app.db).runs.readContract(applied.run_id))!;
  assert.equal((contract.frozen_snapshot.execution_method as JsonObject).action, 'INSPECT');
  assert.ok(!(contract.frozen_snapshot.tool_loop_action as JsonObject).allowed_tools?.toString().includes('apply_changeset'));
  const calls = await driveToolLoop(applied.run_id, workspaceId,
    [[{ name: 'read_file', arguments: { relative_path: 'note.txt' } }]]);
  assert.equal(calls[0]!.status, 'SETTLED');
  assert.ok(String(calls[0]!.result_ref?.content).includes('read-only evidence'));
  assert.equal(await readFile(join(root, 'note.txt'), 'utf8'), 'read-only evidence\n');
  const learning = await createAssistSession(app.db, { workspaceId, projectId,
    commandId: randomUUID(), title: '学习', conversationMode: 'LEARNING' });
  const message = await requestAssistMessage(app.db, { workspaceId,
    sessionId: learning.result.session_id, commandId: randomUUID(), content: '理解审查' });
  await assert.rejects(() => interpretConversationMessage(app.db, { workspaceId,
    sessionId: learning.result.session_id, sourceMessageId: message.result.user_message_id,
    resourceId, commandId: randomUUID(), modelPort: port({ decision: 'DISCUSS' }) }), /只有普通 Agent/u);
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

  // 目录写档位投影（工作台 §18.1）：对话页芯片显示的档位必须与实际准入门禁同源。
  const autoView = await openWorkingDirectory(app.db, { workspaceId, commandId: randomUUID(),
    rootPath: resource.canonical_root });
  assert.equal(autoView.result.write_readiness.status, 'READY');
  assert.equal(autoView.result.write_readiness.policy_decision, 'AUTO');
  assert.ok(autoView.result.write_readiness.policy_id !== null, '生效条目 ID 必须给界面当乐观锁坐标');
  assert.match(autoView.result.write_readiness.policy_revision ?? '', /^\d+$/u);
  assert.equal(autoView.result.write_readiness.policy_target_prefix, resource.canonical_root);
  // AUTO 不能再被描述成「具体动作仍需逐次批准」：措辞与档位不符会让人以为没有本次任务授权这回事。
  assert.match(autoView.result.write_readiness.detail, /删除/u);

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

  // 最严格者优先：同目录再压一条 ASK，投影立刻从 AUTO 变成 ASK——与准入共用同一个排序函数。
  await createGatewayPolicy(app.db, { workspaceId, projectId, capability: 'FILE_WRITE',
    actionType: 'APPLY_CHANGESET', targetPrefix: resource.canonical_root, decision: 'ASK',
    maxPayloadBytes: 262144 });
  const askView = await openWorkingDirectory(app.db, { workspaceId, commandId: randomUUID(),
    rootPath: resource.canonical_root });
  assert.equal(askView.result.write_readiness.policy_decision, 'ASK');
});

/**
 * 目录查看请求的服务端出口（2026-10-15）。
 *
 * 这一组针对用户实测失败的同一句话：绑定目录后问「看一下这个目录下面的文件」，实际拿到的是
 * 状态维护澄清卡与「我没有本地文件访问能力」的普通回复，既没有目录列表也没有读取结果。
 * 覆盖的是服务端能独立承担的部分：目录上下文分段、只读候选的准入、真实工具回执、只读边界、
 * 幂等与恢复，以及缺能力时的真实原因。真实模型的自然语言识别质量由 Provider 定向复验承担，
 * 不在这里用 Fake 返回值冒充。
 */
test('目录查看请求：明确只读请求进入既有只读执行链并把真实列表带回原会话', async () => {
  const workspaceId = await workspace('readonly-listing');
  const root = await tempRoot();
  const marker = `listing-marker-${randomUUID()}`;
  await writeFile(join(root, 'README.md'), `# 本次验证\n\n${marker}\n`, 'utf8');
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'example.ts'), 'export const example = 1;\n', 'utf8');
  const opened = await openWorkingDirectory(app.db, { workspaceId, commandId: randomUUID(), rootPath: root });
  const projectId = opened.result.association?.project_id ?? '';
  const resourceId = opened.result.association?.resource_id ?? '';
  const resource = (await createRepositories(app.db).gateway.readResource(resourceId))!;
  await rootBoundConnection(app.db, { workspaceId, projectId, canonicalRoot: resource.canonical_root,
    capabilities: ['FILE_QUERY', 'FILE_READ'] });
  for (const [capability, actionType] of [['FILE_QUERY', 'LIST_DIRECTORY'],
    ['FILE_QUERY', 'FIND_PATHS'], ['FILE_QUERY', 'SEARCH_TEXT'], ['FILE_READ', 'READ_FILE']] as const) {
    await createGatewayPolicy(app.db, { workspaceId, projectId, capability, actionType,
      targetPrefix: resource.canonical_root, decision: 'AUTO', maxPayloadBytes: 262144 });
  }

  const asked = await sessionIn(workspaceId, projectId, '看一下这个目录下面的文件');
  const requests: ConversationInterpretationRequest[] = [];
  const interpreted = await interpretConversationMessage(app.db, { workspaceId,
    sessionId: asked.sessionId, sourceMessageId: asked.userMessageId, resourceId, commandId: randomUUID(),
    modelPort: port({ decision: 'PREPARE', task: {
      title: '盘点目录文件', objective: '列出生效文件清单并说明每个文件的作用',
      criteria: [{ statement: '清单覆盖目录内全部生效文件', required: true, method: 'HUMAN' }],
      expected_outputs: { kind: 'MARKDOWN_DOCUMENT' }, writes_files: false,
      // 真实模型对只读请求会把路径当定位提示列进来；显式 false 必须压过它。
      file_changes: [{ path: 'README.md', action: 'MODIFY' }],
      // schema 的 check 空占位不得被当成格式错误的检查命令。
      check: { executable: '', args: [] } } }, requests) });
  // 解释模型必须拿到目录身份，「这个目录」才有指代对象。
  assert.match(requests[0]!.userContent, /【当前工作目录/u);
  assert.match(requests[0]!.userContent, new RegExp(`路径：${resource.canonical_root.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`, 'u'));
  assert.equal(requests[0]!.userContent.endsWith('看一下这个目录下面的文件'), true);
  assert.equal(interpreted.result.decision, 'PREPARE');
  assert.equal(interpreted.result.candidate?.writes_files, false);
  assert.equal(interpreted.result.candidate?.check, undefined);
  // 只读候选由服务端判定为可直接启动：界面不需要也不应该自己判断这次是不是只读。
  assert.equal(interpreted.result.auto_start, true);

  const applied = await applyConversationExecution(app.db, { workspaceId, requestId: interpreted.result.request_id });
  assert.ok(applied.run_id !== null, '明确的只读查看必须真正进入执行，而不是停在候选');
  const snapshot = (await withTransaction(app.db, (repositories) =>
    repositories.runs.readContract(applied.run_id as string)))?.frozen_snapshot as
    { tool_loop_action?: { allowed_tools?: readonly string[]; connections?: Record<string, string> } };
  // 只读边界：没有写工具、没有 CLI、没有写连接，也就不存在任何范围授权。
  assert.deepEqual(snapshot.tool_loop_action?.allowed_tools,
    ['list_directory', 'find_paths', 'search_text', 'read_file']);
  assert.equal(snapshot.tool_loop_action?.connections?.FILE_WRITE, undefined);
  assert.equal(snapshot.tool_loop_action?.connections?.CLI_RUN, undefined);
  assert.equal(await withTransaction(app.db, (repositories) =>
    repositories.scopeGrants.readByRun(applied.run_id as string)), undefined);

  // 真实工具回执：目录清单与文件正文都来自实际调用，目录未被修改。
  const rows = await driveToolLoop(applied.run_id as string, workspaceId, [
    [{ name: 'list_directory', arguments: { relative_path: '.' } }],
    [{ name: 'read_file', arguments: { relative_path: 'README.md' } }],
  ]);
  assert.deepEqual(rows.map((row) => row.status), ['SETTLED', 'SETTLED']);
  const listing = JSON.stringify(rows[0]!.result_ref);
  assert.ok(listing.includes('README.md') && listing.includes('src'), `目录清单应来自真实 list_directory：${listing}`);
  // 文件正文必须含本次随机标记：它只可能来自磁盘上的真实文件，不来自测试预设的模型文本。
  assert.ok(String(rows[1]!.result_ref?.content).includes(marker),
    '读取结果必须包含只存在于磁盘的本次随机标记');
  assert.match(await readFile(join(root, 'README.md'), 'utf8'), new RegExp(marker, 'u'));

  // 幂等：同一原请求重复提交只重放原 Task/Run，不产生第二份。
  assert.deepEqual(await applyConversationExecution(app.db,
    { workspaceId, requestId: interpreted.result.request_id }), applied);
  await assertSingleExecution(workspaceId);
});

test('目录查看请求：缺读能力时报告真实缺口，不把它说成「没有本地能力」', async () => {
  const workspaceId = await workspace('readonly-missing-capability');
  const root = await tempRoot();
  const opened = await openWorkingDirectory(app.db, { workspaceId, commandId: randomUUID(), rootPath: root });
  const projectId = opened.result.association?.project_id ?? '';
  const resourceId = opened.result.association?.resource_id ?? '';
  const asked = await sessionIn(workspaceId, projectId, '列一下当前目录');
  const prepared = await interpretConversationMessage(app.db, { workspaceId,
    sessionId: asked.sessionId, sourceMessageId: asked.userMessageId, resourceId, commandId: randomUUID(),
    modelPort: port({ decision: 'PREPARE', task: { title: '列出目录', objective: '列出直接子项',
      criteria: [{ statement: '已列出直接子项', required: true, method: 'HUMAN' }],
      expected_outputs: { kind: 'MARKDOWN_DOCUMENT' }, writes_files: false } }) });
  // 目录选择已创建只读连接；显式停用后必须按真实缺口拒绝，且不能另建连接绕过停用。
  const access = await createRepositories(app.db).gateway.readLocalDirectoryAccess(resourceId);
  assert.ok(access?.read_connection_id);
  const readConnection = await createRepositories(app.db).gateway.readConnection(access.read_connection_id);
  assert.ok(readConnection);
  await disableGatewayConnectionCommand(app.db, { workspaceId, projectId,
    connectionId: readConnection.id, commandId: randomUUID(),
    expectedVersion: readConnection.version.toString() });
  const connectionCount = (await createRepositories(app.db).gateway.listConnections(workspaceId, projectId)).length;
  // 缺 FILE_QUERY：报出第一项缺失的具体能力，而不是笼统地否认本地文件能力。
  await assert.rejects(() => applyConversationExecution(app.db,
    { workspaceId, requestId: prepared.result.request_id }), /FILE_QUERY 连接/u);
  assert.equal((await createRepositories(app.db).gateway.listConnections(workspaceId, projectId)).length,
    connectionCount, '停用连接不得被隐式替换成新的活动连接');
});

test('目录查看请求：受管根外的路径不被读取，停用关联不沿旧资源继续执行', async () => {
  const workspaceId = await workspace('readonly-boundary');
  const root = await tempRoot();
  const outside = join(root, '..', `outside-${randomUUID()}.txt`);
  const outsideText = 'must-not-be-read\n';
  await writeFile(outside, outsideText, 'utf8');
  roots.push(outside);
  const opened = await openWorkingDirectory(app.db, { workspaceId, commandId: randomUUID(), rootPath: root });
  const projectId = opened.result.association?.project_id ?? '';
  const resourceId = opened.result.association?.resource_id ?? '';
  const resource = (await createRepositories(app.db).gateway.readResource(resourceId))!;
  await rootBoundConnection(app.db, { workspaceId, projectId, canonicalRoot: resource.canonical_root,
    capabilities: ['FILE_QUERY', 'FILE_READ'] });
  for (const [capability, actionType] of [['FILE_QUERY', 'LIST_DIRECTORY'],
    ['FILE_QUERY', 'FIND_PATHS'], ['FILE_QUERY', 'SEARCH_TEXT'], ['FILE_READ', 'READ_FILE']] as const) {
    await createGatewayPolicy(app.db, { workspaceId, projectId, capability, actionType,
      targetPrefix: resource.canonical_root, decision: 'AUTO', maxPayloadBytes: 262144 });
  }
  const asked = await sessionIn(workspaceId, projectId, '看看这个项目里有哪些文件');
  const prepared = await interpretConversationMessage(app.db, { workspaceId,
    sessionId: asked.sessionId, sourceMessageId: asked.userMessageId, resourceId, commandId: randomUUID(),
    modelPort: port({ decision: 'PREPARE', task: { title: '盘点目录', objective: '列出直接子项',
      criteria: [{ statement: '已列出直接子项', required: true, method: 'HUMAN' }],
      expected_outputs: { kind: 'MARKDOWN_DOCUMENT' }, writes_files: false } }) });
  const applied = await applyConversationExecution(app.db, { workspaceId, requestId: prepared.result.request_id });
  assert.ok(applied.run_id !== null);
  // 逃逸防护：受管根外的路径在真实派发处被拒，根外文件内容不得进入任何工具回执。
  const rows = await driveToolLoop(applied.run_id as string, workspaceId, [
    [{ name: 'read_file', arguments: { relative_path: '../outside-file.txt' } }],
  ], true);
  assert.equal(rows[0]!.status, 'REJECTED', '越界读取必须以拒绝结算，不能被当成普通成功调用');
  assert.equal((rows[0]!.result_ref as JsonObject | null)?.reason, 'GATEWAY_TARGET_DENIED');
  assert.ok(!JSON.stringify(rows[0]!.result_ref).includes(outsideText),
    `受管根外的内容不得出现在工具回执里：${JSON.stringify(rows[0]!.result_ref)}`);
  assert.equal(await readFile(outside, 'utf8'), outsideText, '越界尝试不得改动根外文件');
});

test('目录查看请求：会话没有绑定目录时不进入执行，也不猜目录', async () => {
  const workspaceId = await workspace('readonly-unbound');
  const otherProject = randomUUID();
  await withTransaction(app.db, async (repositories) => {
    await repositories.projects.insertProject({ id: otherProject, workspaceId, title: '别的项目',
      projectType: 'GENERAL' });
    await repositories.projects.insertProjectState(otherProject, 'PLANNING');
  });
  const session = await createAssistSession(app.db, { workspaceId, commandId: randomUUID(),
    projectId: otherProject, title: '未绑定目录的会话' });
  const sent = await requestAssistMessage(app.db, { workspaceId,
    sessionId: session.result.session_id, commandId: randomUUID(), content: '看一下这个目录下面的文件' });
  // 会话有 Project 但没有任何受管资源：请求行登记阶段就按真实原因拒绝，模型根本不被调用。
  await assert.rejects(() => interpretConversationMessage(app.db, { workspaceId,
    sessionId: session.result.session_id, sourceMessageId: sent.result.user_message_id,
    resourceId: randomUUID(), commandId: randomUUID(), modelPort: port({ decision: 'PREPARE' }) }),
  /Managed resource/u);
  const tasks = await withTransaction(app.db, (repositories) =>
    repositories.conversationExecutions.listSessionRequests(workspaceId, session.result.session_id));
  assert.equal(tasks.length, 0, '被拒绝的请求不得留下任何执行事实');
});

test('目录查看请求：只读解释只建立读工具，不写文件也不执行 CLI', async () => {
  const workspaceId = await workspace('readonly-explain');
  const root = await tempRoot();
  const marker = `explain-marker-${randomUUID()}`;
  await writeFile(join(root, 'note.md'), `# 说明\n\n${marker}\n`, 'utf8');
  const before = await readdir(join(root));
  const opened = await openWorkingDirectory(app.db, { workspaceId, commandId: randomUUID(), rootPath: root });
  const projectId = opened.result.association?.project_id ?? '';
  const resourceId = opened.result.association?.resource_id ?? '';
  const resource = (await createRepositories(app.db).gateway.readResource(resourceId))!;
  // 只配读能力：连写连接和 CLI 连接都不存在，任何越界尝试都只能是被拒。
  await rootBoundConnection(app.db, { workspaceId, projectId, canonicalRoot: resource.canonical_root,
    capabilities: ['FILE_QUERY', 'FILE_READ'] });
  for (const [capability, actionType] of [['FILE_QUERY', 'LIST_DIRECTORY'],
    ['FILE_QUERY', 'FIND_PATHS'], ['FILE_QUERY', 'SEARCH_TEXT'], ['FILE_READ', 'READ_FILE']] as const) {
    await createGatewayPolicy(app.db, { workspaceId, projectId, capability, actionType,
      targetPrefix: resource.canonical_root, decision: 'AUTO', maxPayloadBytes: 262144 });
  }
  const asked = await sessionIn(workspaceId, projectId, '帮我解释一下 note.md 这个文件');
  const prepared = await interpretConversationMessage(app.db, { workspaceId,
    sessionId: asked.sessionId, sourceMessageId: asked.userMessageId, resourceId, commandId: randomUUID(),
    modelPort: port({ decision: 'PREPARE', task: { title: '解释 note.md', objective: '基于原文说明这个文件讲了什么',
      criteria: [{ statement: '解释结论来自文件原文', required: true, method: 'HUMAN' }],
      expected_outputs: { kind: 'MARKDOWN_DOCUMENT' }, writes_files: false } }) });
  assert.equal(prepared.result.auto_start, true);
  const applied = await applyConversationExecution(app.db, { workspaceId, requestId: prepared.result.request_id });
  assert.ok(applied.run_id !== null);
  const contract = (await withTransaction(app.db, (repositories) =>
    repositories.runs.readContract(applied.run_id as string)))?.frozen_snapshot as
    { tool_loop_action?: { allowed_tools?: readonly string[] } };
  assert.ok(!contract.tool_loop_action?.allowed_tools?.includes('apply_changeset'));
  assert.ok(!contract.tool_loop_action?.allowed_tools?.includes('run_check'));
  const rows = await driveToolLoop(applied.run_id as string, workspaceId, [
    [{ name: 'read_file', arguments: { relative_path: 'note.md' } }] ]);
  assert.equal(rows[0]!.status, 'SETTLED');
  assert.ok(String(rows[0]!.result_ref?.content).includes(marker),
    '只读解释的依据必须来自真实读取，而不是测试预设的模型文本');
  // 目录逐字节未变：既没有新建文件，也没有改动内容。
  assert.deepEqual(await readdir(join(root)), before);
  assert.match(await readFile(join(root, 'note.md'), 'utf8'), new RegExp(marker, 'u'));
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
  script: readonly { readonly name: string; readonly arguments: JsonObject }[][],
  allowRejectedAction = false) {
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
    if (dispatched.status !== 'SUCCEEDED' && !(allowRejectedAction && dispatched.status === 'FAILED')) {
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
