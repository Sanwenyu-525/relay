import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test, { after, before } from 'node:test';

import { sql } from 'kysely';

import { runAssistGenerationTick } from '../../src/application/assist-runner.js';
import { resolveSessionReadTools, sessionReadToolsForCurrentConnections, sessionWriteAllowed }
  from '../../src/application/assist-read-tools.js';
import { createRepositories, withTransaction } from '../../src/application/unit-of-work.js';
import {
  establishConversationDiffBaseline,
  readConversationDiff,
  readConversationDiffFile,
} from '../../src/conversation-diff/net-diff-service.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import type { JsonObject } from '../../src/infrastructure/json.js';
import { ManagedContentStore } from '../../src/storage/managed-content-store.js';
import { runOneCommand } from '../../src/worker/run-command.js';
import { FakeModelPort, type AssistModelPort, type ModelIdentity } from '../../src/workflow/fake-model-port.js';
import { createDataRoot, startTestApi, workspacePath } from './api-harness.js';
import { APP_DATABASE_URL, MIGRATIONS_DIRECTORY, MIGRATION_DATABASE_URL, openDatabase } from './integration-support.js';

/**
 * 会话 diff 的**归因链**端到端验证（工作台 §34.2，2026-10-20）。
 *
 * 之前的集成套件只能证明「基线 → 当前内容」的算法，因为归因需要真实的写账本。本文件补齐那一段：
 * 走真实 HTTP 打开目录、真实主流程产出执行候选、真实 Run Worker 执行 `apply_changeset`，
 * 于是 `change_sets` / `change_set_files` 由生产代码自己写出，再用同一份库事实回答两个问题：
 *   ① 本会话改过的文件必须出现在会话口径里（归因没有漏）；
 *   ② 同一目录里别人改的文件只能出现在目录口径里（归因没有多）。
 */

const executeGit = promisify(execFile);

const app = openDatabase(APP_DATABASE_URL, 'relay-api-test-diff-attribution');
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
  configFingerprint: 'diff-attribution-test' };

/** 主流程模型：这一次判定直接产出「要改哪个文件」的执行候选。 */
function executionPort(input: { title: string; objective: string; path: string;
  action: 'CREATE' | 'MODIFY' }): AssistModelPort {
  const content = JSON.stringify({ reply: '我已把这条请求接入受控文件执行。', maintenance: null,
    execution: { title: input.title, objective: input.objective,
      criteria: [{ statement: input.objective, required: true, method: 'HUMAN' }],
      expected_outputs: { kind: 'MARKDOWN_DOCUMENT' }, writes_files: true,
      file_changes: [{ path: input.path, action: input.action }] } });
  return { identity, assist: async () => ({ kind: 'CONTENT', content,
    providerRequestId: `diff-attribution-${randomUUID()}`,
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: null, cacheCreationTokens: null } }) };
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
  const root = await mkdtemp(join(tmpdir(), 'relay-diff-attribution-'));
  roots.push(root);
  return root;
}

/** 会话 diff 的基线只认 Git 根：临时目录必须先 `git init`，否则建立起点会以 NOT_GIT_ROOT 拒绝。 */
async function gitInit(root: string): Promise<void> {
  const environment: NodeJS.ProcessEnv = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL',
    HOME: root, USERPROFILE: root };
  for (const key of ['SystemRoot', 'WINDIR', 'SystemDrive', 'PATH', 'PATHEXT', 'TEMP', 'TMP']) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  const git = async (args: readonly string[]): Promise<string> =>
    (await executeGit('git', ['-c', 'core.autocrlf=false', ...args], { cwd: root,
      env: environment, windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024 })).stdout;
  await git(['init', '-b', 'main']);
  await git(['config', 'user.name', 'Relay Test']);
  await git(['config', 'user.email', 'fixture@local']);
  await git(['config', 'core.autocrlf', 'false']);
  await git(['add', '--', '.']);
}

/** 失败信息里可能出现 baseline.revision（bigint），直接 JSON.stringify 会抛错掩盖真实断言。 */
function describe(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === 'bigint' ? item.toString() : item);
}

async function sha256Of(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

/** 打开一个真实目录并切写入档（默认 AUTO；会话直写要免逐次批准时用 FULL）。 */
async function openAutoWriteDirectory(api: Awaited<ReturnType<typeof startTestApi>>, name: string,
  files: Readonly<Record<string, string>>, tier: 'AUTO' | 'FULL' = 'AUTO') {
  const workspaceId = await workspace(name);
  const root = await tempRoot();
  for (const [relativePath, content] of Object.entries(files)) {
    const target = join(root, relativePath);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
  await gitInit(root);
  const open = await api.post(workspacePath(workspaceId, '/working-directories/open'), {
    command_id: randomUUID(), root_path: root });
  assert.equal(open.status, 200, open.text);
  const result = (open.body as { result: { association: { project_id: string; resource_id: string };
    write_readiness: { access_revision: string; write_tier: string } } }).result;
  const { project_id: projectId, resource_id: resourceId } = result.association;
  const write = await api.post(workspacePath(workspaceId,
    `/projects/${projectId}/managed-resources/${resourceId}/local-access`), {
    command_id: randomUUID(), expected_revision: result.write_readiness.access_revision,
    write_tier: tier });
  assert.equal(write.status, 200, write.text);
  return { workspaceId, projectId, resourceId, root };
}

/** 会话 + 绑定目录 + 一条真实用户消息；返回驱动主流程所需的身份。 */
async function openSession(api: Awaited<ReturnType<typeof startTestApi>>,
  env: { workspaceId: string; projectId: string; resourceId: string }, content: string) {
  const path = (suffix: string) => workspacePath(env.workspaceId, suffix);
  const created = await api.post(path('/assist-sessions'), { command_id: randomUUID(),
    project_id: env.projectId, title: '归因链会话' });
  assert.equal(created.status, 201, created.text);
  const sessionId = (created.body as { result: { session_id: string } }).result.session_id;
  const bound = await api.post(path(`/assist-sessions/${sessionId}/working-directory`), {
    command_id: randomUUID(), resource_id: env.resourceId });
  assert.equal(bound.status, 200, bound.text);
  const sent = await api.post(path(`/assist-sessions/${sessionId}/messages`), {
    command_id: randomUUID(), content, intent: 'DISCUSS' });
  assert.equal(sent.status, 202, sent.text);
  const ids = (sent.body as { result: { user_message_id: string; assistant_message_id: string } }).result;
  return { sessionId, userMessageId: ids.user_message_id, assistantMessageId: ids.assistant_message_id };
}

test('会话直写创建的未跟踪文件进入会话 diff，而不是只认 Run 的 change_sets', async () => {
  const api = await startTestApi();
  try {
    // 与 0126 的真实入口一致：HTTP 打开目录并切 FULL 档（AUTO 仍要逐次批准，会话没有审批接续通道）。
    const env = await openAutoWriteDirectory(api, 'diff-session-write', {
      'src/a.ts': 'const a = 1;\n',
    }, 'FULL');
    const content = '<!doctype html>\n<h1>三层小楼</h1>\n';
    const script = [[{ name: 'apply_changeset', arguments: { changes: [
      { path: 'three-house.html', action: 'CREATE', content },
    ] } }]];
    const session = await openSession(api, env,
      `FAKE_ASSIST_TOOLS ${JSON.stringify(script)}`);

    // 统计起点必须早于这条消息的真实写入。
    const baseline = await establishConversationDiffBaseline(
      createRepositories(app.db), { workspaceId: env.workspaceId, sessionId: session.sessionId });
    assert.equal(baseline.established, true, describe(baseline));

    const sessionRow = (await sql<Record<string, unknown>>`
      select * from assist_sessions where id = ${session.sessionId}`.execute(app.db)).rows[0];
    assert.ok(sessionRow !== undefined);
    const tools = await resolveSessionReadTools(createRepositories(app.db), sessionRow as never, true);
    const writeAllowed = await sessionWriteAllowed(app.db, sessionRow as never);
    const runnerTools = await sessionReadToolsForCurrentConnections(
      app.db, sessionRow as never, writeAllowed);
    const access = (await sql<{ write_tier: string; write_connection_id: string | null }>`
      select write_tier, write_connection_id from local_directory_access
       where resource_id = ${env.resourceId}`.execute(app.db)).rows[0];
    assert.ok(tools.includes('apply_changeset'),
      `写工具必须在词表内：tier=${access?.write_tier ?? 'MISSING'} `
      + `connection=${access?.write_connection_id ?? 'MISSING'} tools=${tools.join(',')}`);
    assert.ok(runnerTools.includes('apply_changeset'),
      `运行轮次的词表必须含写工具：writeAllowed=${writeAllowed} `
      + `tier=${access?.write_tier ?? 'MISSING'} tools=${runnerTools.join(',')}`);

    const generated = await runAssistGenerationTick(app.db, {
      workerId: `diff-session-write-${randomUUID()}`,
      storage: new ManagedContentStore(api.dataRoot), leaseMs: 60_000, maxMessages: 1,
      modelPort: new FakeModelPort() });
    assert.ok(generated, '这条消息必须由普通会话主流程领取');
    // 先看主流程自己的收口：脚本里的工具没被声明/写被拒时，失败原因在会话工具账本里。
    const message = await createRepositories(app.db).assist.readMessage(session.assistantMessageId);
    const diagnostics = (await sql<{ tool_name: string; status: string;
      rejection_reason: string | null; rejection_detail: string | null }>`
      select tool_name, status, rejection_reason, rejection_detail
        from session_tool_calls where session_id = ${session.sessionId}`.execute(app.db)).rows;
    assert.equal(message?.status, 'COMPLETED',
      `${message?.status}/${message?.error_code ?? 'no-error'} ${describe(diagnostics)}`);
    let written: string | null = null;
    try { written = await readFile(join(env.root, 'three-house.html'), 'utf8'); } catch { written = null; }
    assert.equal(written, content,
      `新建文件必须由会话直写真实落盘；账本=${describe(diagnostics)}`);

    // 归因事实：会话直写没有 Run，也不会写 change_sets，只有 session_tool_calls → Operation。
    const ledger = (await sql<{ status: string; tool_name: string; origin: string;
      action_type: string; normalized_target: string; changes: unknown }>`
      select stc.status, stc.tool_name, op.origin, op.action_type, op.normalized_target,
             op.params->'changes' as changes
        from session_tool_calls stc
        join logical_operations op on op.id = stc.operation_id
       where stc.session_id = ${session.sessionId}`.execute(app.db)).rows;
    assert.equal(ledger.length, 1, describe(ledger));
    assert.equal(ledger[0]?.tool_name, 'apply_changeset');
    assert.equal(ledger[0]?.status, 'SETTLED');
    assert.equal(ledger[0]?.origin, 'AGENT_SESSION_WRITE');
    assert.equal(ledger[0]?.action_type, 'APPLY_CHANGESET');
    const canonicalRoot = (await sql<{ canonical_root: string }>`
      select canonical_root from managed_resources where id = ${env.resourceId}`
      .execute(app.db)).rows[0]?.canonical_root;
    assert.ok(canonicalRoot !== undefined);
    assert.equal(ledger[0]?.normalized_target, canonicalRoot, describe(ledger[0]?.normalized_target));
    assert.deepEqual(ledger[0]?.changes, [{ action: 'CREATE', path: 'three-house.html', content }]);
    const changeSets = await sql<{ count: string }>`select count(*)::text as count
      from change_sets where workspace_id = ${env.workspaceId}`.execute(app.db);
    assert.equal(changeSets.rows[0]?.count, '0',
      '这条链路不产生 change_sets；归因必须直接认会话工具账本');

    // 用户看到的会话口径：新建的未跟踪文件按 CREATE 出现，行数来自真实内容。
    const sessionDiff = await readConversationDiff(createRepositories(app.db),
      { workspaceId: env.workspaceId, sessionId: session.sessionId });
    assert.equal(sessionDiff.available, true, describe(sessionDiff));
    if (!sessionDiff.available) return;
    assert.equal(sessionDiff.diff.scope, 'SESSION');
    assert.deepEqual(sessionDiff.diff.files.map((file) =>
      [file.path, file.action, file.added, file.removed]),
    [['three-house.html', 'CREATE', 2, 0]], describe(sessionDiff.diff.files));
    assert.equal(sessionDiff.diff.totalFiles, 1);
    assert.equal(sessionDiff.diff.totalAdded, 2);

    const detail = await readConversationDiffFile(createRepositories(app.db),
      { workspaceId: env.workspaceId, sessionId: session.sessionId, path: 'three-house.html' });
    assert.equal(detail.available, true, describe(detail));
    if (detail.available) {
      assert.equal(detail.file.action, 'CREATE');
      assert.ok(detail.file.rows?.some((row) => row.kind === 'ADD' && row.text === '<h1>三层小楼</h1>'));
    }
    const untouched = await readConversationDiffFile(createRepositories(app.db),
      { workspaceId: env.workspaceId, sessionId: session.sessionId, path: 'src/a.ts' });
    assert.deepEqual(untouched, { available: false, reason: 'PATH_NOT_FOUND' },
      '没有写过的路径不能被会话归因带进来');
  } finally {
    await api.stop();
  }
});

test('真实写盘后：会话口径认得出本会话改的文件，别人的同期改动只在目录口径里', async () => {
  const api = await startTestApi();
  try {
    const original = 'one\ntwo\n';
    const env = await openAutoWriteDirectory(api, 'diff-attribution', {
      'src/a.ts': original,
      'src/other.ts': 'x\n',
    });
    const session = await openSession(api, env, '把 src/a.ts 追加一行 three。');

    // 统计起点必须早于任何写入，否则基线就是「改完之后」，什么都比不出来。
    const baseline = await establishConversationDiffBaseline(
      createRepositories(app.db), { workspaceId: env.workspaceId, sessionId: session.sessionId });
    assert.equal(baseline.established, true, describe(baseline));

    // 主流程产出执行候选 → 委托出真实 Run。
    const generated = await runAssistGenerationTick(app.db, {
      workerId: `diff-attribution-${randomUUID()}`,
      storage: new ManagedContentStore(api.dataRoot), leaseMs: 60_000, maxMessages: 1,
      modelPort: executionPort({ title: '追加一行', objective: 'src/a.ts 末尾多一行 three',
        path: 'src/a.ts', action: 'MODIFY' }) });
    assert.ok(generated, '本条消息必须由普通主流程领取');

    const requests = await api.get(workspacePath(env.workspaceId,
      `/conversation-execution-requests?session_id=${session.sessionId}`));
    assert.equal(requests.status, 200, requests.text);
    const request = (requests.body as { items: { request_id: string; source_message_id: string;
      status: string; candidate: JsonObject | null }[] })
      .items.find((item) => item.source_message_id === session.userMessageId);
    assert.ok(request, '主流程必须为这条原消息留下执行请求行');
    assert.equal(request.status, 'READY', describe(request));

    const applied = await api.post(workspacePath(env.workspaceId,
      `/conversation-execution-requests/${request.request_id}/applications`), {});
    assert.equal(applied.status, 200, applied.text);
    const runId = (applied.body as { result: { run_id: string } }).result.run_id;

    // 真实 Run Worker + 脚本化工具轮：先读，再按真实摘要写。
    const baselineSha256 = await sha256Of(join(env.root, 'src', 'a.ts'));
    const script: readonly { readonly name: string; readonly arguments: JsonObject }[][] = [
      [{ name: 'read_file', arguments: { relative_path: 'src/a.ts' } }],
      [{ name: 'apply_changeset', arguments: { changes: [{ action: 'MODIFY', path: 'src/a.ts',
        baselineSha256, content: 'one\ntwo\nthree\n' }] } }],
    ];
    const delivered = await runOneCommand(app.db, { workerId: `diff-attribution-run-${randomUUID()}`,
      dataRoot: api.dataRoot, checkpointUrl: APP_DATABASE_URL, fakeToolScript: script });
    assert.equal(delivered?.runId, runId, describe(delivered));
    assert.equal(await readFile(join(env.root, 'src', 'a.ts'), 'utf8'), 'one\ntwo\nthree\n',
      '磁盘内容必须由工具循环真实写出');

    // 生产代码自己写出的写账本：这正是归因读的那两张表。
    const changeSets = (await sql<{ id: string; status: string; file_count: number }>`
      select id, status, file_count from change_sets where run_id = ${runId}`.execute(app.db)).rows;
    assert.equal(changeSets.length, 1, describe(changeSets));
    assert.equal(changeSets[0]!.status, 'SUCCEEDED');
    const files = (await sql<{ relative_path: string; action: string; status: string }>`
      select relative_path, action, status from change_set_files
      where change_set_id = ${changeSets[0]!.id} order by relative_path`.execute(app.db)).rows;
    assert.deepEqual(files.map((row) => [row.relative_path, row.action, row.status]),
      [['src/a.ts', 'MODIFY', 'APPLIED']]);

    // 同期外部修改：不是本会话写的，直接落到磁盘上。
    await writeFile(join(env.root, 'src', 'other.ts'), 'x\ny\n', 'utf8');

    // ① 会话口径：只认写账本里的路径。
    const sessionDiff = await readConversationDiff(createRepositories(app.db),
      { workspaceId: env.workspaceId, sessionId: session.sessionId });
    assert.equal(sessionDiff.available, true, describe(sessionDiff));
    if (!sessionDiff.available) return;
    assert.equal(sessionDiff.diff.scope, 'SESSION');
    assert.deepEqual(sessionDiff.diff.files.map((file) => [file.path, file.action, file.added, file.removed]),
      [['src/a.ts', 'MODIFY', 1, 0]], describe(sessionDiff.diff.files));
    assert.equal(sessionDiff.diff.totalFiles, 1);
    assert.equal(sessionDiff.diff.totalAdded, 1);
    assert.equal(sessionDiff.diff.totalRemoved, 0);

    // ② 目录口径：同一份基线，同期外部修改也在。
    const directoryDiff = await readConversationDiff(createRepositories(app.db),
      { workspaceId: env.workspaceId, sessionId: session.sessionId, scope: 'DIRECTORY' });
    assert.equal(directoryDiff.available, true, describe(directoryDiff));
    if (!directoryDiff.available) return;
    assert.equal(directoryDiff.diff.scope, 'DIRECTORY');
    assert.deepEqual(directoryDiff.diff.files.map((file) => file.path).sort(),
      ['src/a.ts', 'src/other.ts']);

    // ③ 展开正文跟着范围走：会话口径不给别人的文件，目录口径给。
    const ownDetail = await readConversationDiffFile(createRepositories(app.db),
      { workspaceId: env.workspaceId, sessionId: session.sessionId, path: 'src/a.ts' });
    assert.equal(ownDetail.available, true, describe(ownDetail));
    if (ownDetail.available) {
      assert.equal(ownDetail.file.added, 1);
      assert.ok(ownDetail.file.rows?.some((row) => row.kind === 'ADD' && row.text === 'three'));
    }
    const foreignDetail = await readConversationDiffFile(createRepositories(app.db),
      { workspaceId: env.workspaceId, sessionId: session.sessionId, path: 'src/other.ts' });
    assert.deepEqual(foreignDetail, { available: false, reason: 'PATH_NOT_FOUND' },
      '会话口径不能借展开正文读到别人改的文件');
    const foreignInDirectory = await readConversationDiffFile(createRepositories(app.db),
      { workspaceId: env.workspaceId, sessionId: session.sessionId, path: 'src/other.ts',
        scope: 'DIRECTORY' });
    assert.equal(foreignInDirectory.available, true, describe(foreignInDirectory));
  } finally {
    await api.stop();
  }
});
