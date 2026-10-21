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

/** 打开一个真实目录并切到 AUTO 档（默认打开是 READ_ONLY，写不了）。 */
async function openAutoWriteDirectory(api: Awaited<ReturnType<typeof startTestApi>>, name: string,
  files: Readonly<Record<string, string>>) {
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
    write_tier: 'AUTO' });
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
