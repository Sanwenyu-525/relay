import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test, { after, before } from 'node:test';

import { createAssistSession, requestAssistMessage } from '../../src/application/assist-commands.js';
import { applyConversationExecution, interpretConversationMessage } from
  '../../src/application/conversation-execution.js';
import { claimGatewayWorker, claimRunForGateway, dispatchGatewayAction, prepareGatewayAction,
  type GatewayOrigin } from '../../src/application/gateway-actions.js';
import { canonicalResourceIdentity, createFakeConnection, createGatewayPolicy } from
  '../../src/application/gateway-configuration.js';
import { openWorkingDirectory } from '../../src/application/open-working-directory.js';
import { resolveReview } from '../../src/application/review-decisions.js';
import { advanceRunStep } from '../../src/application/run-steps.js';
import { createRepositories, withTransaction } from '../../src/application/unit-of-work.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { ManagedContentStore } from '../../src/storage/managed-content-store.js';
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
      file_changes: [{ path: 'answer.txt', action: 'MODIFY', content: 'after\n' }],
      check: { executable: process.execPath, args: ['--version'] } } }, interpretationRequests) });
  assert.equal(prepared.result.decision, 'PREPARE');
  assert.equal(prepared.result.status, 'READY');
  assert.equal((prepared.result.candidate?.title ?? null), '改写 answer.txt 并检查');
  assert.equal(interpretationRequests[1]?.userContent, '帮我把这个文件的内容改成 after 并跑一次检查');
  assert.ok(interpretationRequests[1]?.system.includes(RELAY_AGENT_CORE_PROMPT));
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
  await assert.rejects(() => applyConversationExecution(app.db, { workspaceId,
    requestId: prepared.result.request_id }), /FILE_WRITE 连接/);

  const connection = await createFakeConnection(app.db, { workspaceId, projectId,
    capabilities: ['FILE_WRITE', 'CLI_RUN'] });
  const resource = await createRepositories(app.db).gateway.readResource(resourceId);
  assert.ok(resource !== undefined);
  for (const [capability, actionType] of [['FILE_WRITE', 'APPLY_CHANGESET'],
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
  const snapshot = contract.frozen_snapshot as { file_write_action?: { intent_key?: string };
    cli_run_action?: { intent_key?: string } };
  assert.equal(snapshot.file_write_action?.intent_key, 'file-write-v1');
  assert.equal(snapshot.cli_run_action?.intent_key, 'cli-run-v1');

  await approveAndWrite(workspaceId, applied.run_id as string, connection.connectionId,
    resourceId, target);
});

/**
 * 走完真实受控链：DRAFT → 文件变更审批 → 落盘 → 检查命令审批 → 真实子进程。
 * 批准本身不执行任何副作用；未批准前文件内容必须保持原样。
 */
async function approveAndWrite(workspaceId: string, runId: string, connectionId: string,
  resourceId: string, target: string): Promise<void> {
  const storage = new ManagedContentStore(dataRoot);
  for (const kind of ['BUILD_CONTEXT', 'DRAFT']) {
    const advanced = await advanceRunStep(app.db, { runId, workerId: `setup-${randomUUID()}`, storage });
    assert.equal(advanced.status, 'STEP_SUCCEEDED', `${kind}: ${JSON.stringify(advanced)}`);
  }
  const repositories = createRepositories(app.db);
  const resource = await repositories.gateway.readResource(resourceId);
  const step = await repositories.runs.readStepByKind(runId, 'DRAFT');
  const contract = await repositories.runs.readContract(runId);
  assert.ok(step !== undefined && contract !== undefined && resource !== undefined);
  const write = (contract.frozen_snapshot as { file_write_action: { operation_id: string } }).file_write_action;
  const cli = (contract.frozen_snapshot as { cli_run_action: { operation_id: string } }).cli_run_action;
  const workerId = `worker-${randomUUID()}`;

  const held = await claimRunForGateway(app.db, { workspaceId, runId, workerId });
  const prepared = await prepareGatewayAction(app.db, { workspaceId, operationId: write.operation_id,
    intentKey: 'file-write-v1', connectionId,
    origin: { kind: 'RUN', runId, stepId: step.id, resourceId, workerId,
      workerEpoch: BigInt(held.worker_epoch) },
    actionType: 'APPLY_CHANGESET', target: resource.canonical_root,
    params: { changes: (contract.frozen_snapshot as { file_write_action: { changes: unknown } })
      .file_write_action.changes } as never });
  assert.equal(prepared.status, 'WAITING_APPROVAL');
  assert.equal(await readFile(target, 'utf8'), 'before\n');
  await approve(workspaceId, prepared.review_id as string);
  assert.equal(await readFile(target, 'utf8'), 'before\n');

  const writeEpoch = BigInt((await claimGatewayWorker(app.db, { workspaceId,
    operationId: write.operation_id, workerId })).worker_epoch);
  const origin = (workerEpoch: bigint): GatewayOrigin => ({ kind: 'RUN', runId, stepId: step.id,
    resourceId, workerId, workerEpoch });
  const written = await dispatchGatewayAction(app.db, { workspaceId, operationId: write.operation_id,
    origin: origin(writeEpoch) });
  assert.equal(written.status, 'SUCCEEDED');
  assert.equal(await readFile(target, 'utf8'), 'after\n');

  const checkPrepared = await prepareGatewayAction(app.db, { workspaceId, operationId: cli.operation_id,
    intentKey: 'cli-run-v1', connectionId, origin: origin(writeEpoch),
    actionType: 'CLI_RUN', target: resource.canonical_root,
    params: { executable: process.execPath, args: ['--version'] } });
  assert.equal(checkPrepared.status, 'WAITING_APPROVAL');
  await approve(workspaceId, checkPrepared.review_id as string);
  const checkEpoch = BigInt((await claimGatewayWorker(app.db, { workspaceId,
    operationId: cli.operation_id, workerId })).worker_epoch);
  const checked = await dispatchGatewayAction(app.db, { workspaceId, operationId: cli.operation_id,
    origin: origin(checkEpoch) });
  assert.equal(checked.status, 'SUCCEEDED');
  const operation = await withTransaction(app.db, (repositories) =>
    repositories.gateway.readOperation(cli.operation_id));
  assert.equal(operation?.status, 'SUCCEEDED');
  assert.equal((operation?.result_ref as { outcome?: string } | null)?.outcome, 'SUCCEEDED');
}

async function approve(workspaceId: string, reviewId: string): Promise<void> {
  const review = await withTransaction(app.db, (repositories) => repositories.reviews.readRequest(reviewId));
  assert.ok(review);
  const decided = await resolveReview(app.db, { workspaceId, reviewId, commandId: randomUUID(),
    expectedRevision: review.revision.toString(), targetHash: review.target_hash.toString('hex'),
    decision: 'APPROVE' });
  assert.equal(decided.result.effect.external_effect_executed, false);
}
