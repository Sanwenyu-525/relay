import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

import { sql } from 'kysely';

import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { runAssistGenerationTick } from '../../src/application/assist-runner.js';
import { FakeModelPort, type AssistModelPort, type AssistRequest,
  type AssistResult, type ModelIdentity } from '../../src/workflow/fake-model-port.js';
import { ManagedContentStore } from '../../src/storage/managed-content-store.js';
import { createRepositories, withTransaction } from '../../src/application/unit-of-work.js';
import { createDataRoot, startTestApi, workspacePath } from './api-harness.js';
import { APP_DATABASE_URL, MIGRATIONS_DIRECTORY, MIGRATION_DATABASE_URL, openDatabase }
  from './integration-support.js';

/**
 * 消息撤回（0132）的运行时语义：实施者自检，与并行评审的 RA-01..RA-03 互补。
 *
 * 覆盖评审文件声明未覆盖的三项：
 *   * RR-01：任何 RUNNING 撤回（含崩溃遗留的过期回执）都挡住新消息；
 *   * RR-02：过期 RUNNING 按原回执接续恢复，未过期时拒绝并发执行；
 *   * RR-03：下一轮上下文只保留撤回占位与回执摘要，不回放旧回复原文。
 *
 * 全部走真实 HTTP + 真实 PG + 真实会话写路径；只有「崩溃遗留」的行状态用 SQL 直接摆放，
 * 因为正常流程没有可注入的执行中断点。
 */

const app = openDatabase(APP_DATABASE_URL, 'relay-api-test-msg-recall-runtime');
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

function describe(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === 'bigint' ? item.toString() : item);
}

async function sha256OfContent(content: string): Promise<string> {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

async function readOrNull(root: string, relativePath: string): Promise<string | null> {
  try { return await readFile(join(root, relativePath), 'utf8'); } catch { return null; }
}

async function openDirectory(api: Awaited<ReturnType<typeof startTestApi>>, name: string,
  files: Readonly<Record<string, string>>) {
  const workspaceId = randomUUID();
  await withTransaction(app.db, async (repositories) => {
    await repositories.workspaces.insertWorkspace({ id: workspaceId, name });
    await repositories.workspaces.insertAuthorityRow(workspaceId);
  });
  const root = await mkdtemp(join(tmpdir(), 'relay-msg-recall-runtime-'));
  roots.push(root);
  for (const [relativePath, content] of Object.entries(files)) {
    const target = join(root, relativePath);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
  const open = await api.post(workspacePath(workspaceId, '/working-directories/open'), {
    command_id: randomUUID(), root_path: root });
  assert.equal(open.status, 200, open.text);
  const result = (open.body as { result: { association: { project_id: string; resource_id: string };
    write_readiness: { access_revision: string } } }).result;
  const { project_id: projectId, resource_id: resourceId } = result.association;
  const write = await api.post(workspacePath(workspaceId,
    `/projects/${projectId}/managed-resources/${resourceId}/local-access`), {
    command_id: randomUUID(), expected_revision: result.write_readiness.access_revision,
    write_tier: 'FULL' });
  assert.equal(write.status, 200, write.text);
  return { workspaceId, projectId, resourceId, root };
}

async function openBoundSession(api: Awaited<ReturnType<typeof startTestApi>>,
  name: string, files: Readonly<Record<string, string>>) {
  const dir = await openDirectory(api, name, files);
  const path = (suffix: string) => workspacePath(dir.workspaceId, suffix);
  const created = await api.post(path('/assist-sessions'), { command_id: randomUUID(),
    project_id: dir.projectId, title: '撤回运行时会话' });
  assert.equal(created.status, 201, created.text);
  const sessionId = (created.body as { result: { session_id: string } }).result.session_id;
  const bound = await api.post(path(`/assist-sessions/${sessionId}/working-directory`), {
    command_id: randomUUID(), resource_id: dir.resourceId });
  assert.equal(bound.status, 200, bound.text);
  return { ...dir, sessionId };
}

async function sendScripted(api: Awaited<ReturnType<typeof startTestApi>>,
  env: { workspaceId: string; sessionId: string }, script: unknown, plainText: string) {
  const content = `FAKE_ASSIST_TOOLS ${JSON.stringify(script)}\n${plainText}`;
  const sent = await api.post(workspacePath(env.workspaceId,
    `/assist-sessions/${env.sessionId}/messages`), {
    command_id: randomUUID(), content, intent: 'DISCUSS' });
  assert.equal(sent.status, 202, sent.text);
  return (sent.body as { result: { user_message_id: string; assistant_message_id: string } }).result;
}

function applyChangeset(changes: readonly unknown[]): unknown[][] {
  return [[{ name: 'apply_changeset', arguments: { changes } }]];
}

async function runRound(api: Awaited<ReturnType<typeof startTestApi>>, label: string,
  modelPort: AssistModelPort = new FakeModelPort()) {
  const generated = await runAssistGenerationTick(app.db, {
    workerId: `msg-recall-runtime-${label}-${randomUUID()}`,
    storage: new ManagedContentStore(api.dataRoot), leaseMs: 60_000, maxMessages: 1, modelPort });
  assert.ok(generated, `${label}：这条消息必须由普通会话主流程领取`);
}

async function assertRoundSettled(assistantMessageId: string, label: string) {
  const message = await createRepositories(app.db).assist.readMessage(assistantMessageId);
  assert.equal(message?.status, 'COMPLETED',
    `${label}：助手消息应完成（${message?.status}/${message?.error_code ?? '无错误'}）`);
}

/** 直接摆一条 RUNNING 回执：正常路径没有可注入的中断点，这是「崩溃遗留」的唯一入口。 */
async function insertRunningRecall(input: {
  workspaceId: string; sessionId: string; messageId: string;
  assistantMessageId: string; rootPath: string | null; plannedFiles: number;
}): Promise<string> {
  const recallId = randomUUID();
  await sql`insert into assist_message_recalls (id, workspace_id, session_id, message_id,
    assistant_message_id, command_id, status, root_path, planned_files)
    values (${recallId}, ${input.workspaceId}, ${input.sessionId}, ${input.messageId},
      ${input.assistantMessageId}, ${randomUUID()}, 'RUNNING', ${input.rootPath},
      ${input.plannedFiles})`.execute(app.db);
  return recallId;
}

async function backdateRecall(recallId: string, seconds: number): Promise<void> {
  await sql`update assist_message_recalls
    set requested_at = now() - make_interval(secs => ${seconds}), last_resumed_at = null
    where id = ${recallId}`.execute(app.db);
}

function sendMessage(api: Awaited<ReturnType<typeof startTestApi>>,
  env: { workspaceId: string; sessionId: string }, content: string) {
  return api.post(workspacePath(env.workspaceId,
    `/assist-sessions/${env.sessionId}/messages`), {
    command_id: randomUUID(), content, intent: 'DISCUSS' });
}

/** 记录实际交给模型的请求，其余行为委托给确定性 Fake。 */
class RecordingAssistPort implements AssistModelPort {
  readonly requests: AssistRequest[] = [];
  readonly identity: ModelIdentity;
  private readonly inner = new FakeModelPort();

  constructor() {
    this.identity = this.inner.identity;
  }

  async assist(request: AssistRequest): Promise<AssistResult> {
    this.requests.push(request);
    return this.inner.assist(request);
  }
}

test('RR-01 任何 RUNNING 撤回都挡住新消息，包括崩溃遗留的过期回执', async () => {
  const api = await startTestApi();
  try {
    const env = await openBoundSession(api, 'recall-fence', { 'f.md': 'f0\n' });
    const first = await sendScripted(api, env,
      applyChangeset([{ path: 'f.md', action: 'MODIFY', content: 'f1\n',
        baselineSha256: await sha256OfContent('f0\n') }]), '栅栏用第一轮');
    await runRound(api, 'rr1-m1');
    await assertRoundSettled(first.assistant_message_id, 'RR-01 第一轮');

    const recallId = await insertRunningRecall({ workspaceId: env.workspaceId,
      sessionId: env.sessionId, messageId: first.user_message_id,
      assistantMessageId: first.assistant_message_id, rootPath: env.root, plannedFiles: 0 });

    const fresh = await sendMessage(api, env, '撤回执行中不应受理');
    assert.equal(fresh.status, 409, fresh.text);
    assert.equal((fresh.body as { code: string }).code, 'INVALID_TRANSITION');
    assert.match(String((fresh.body as { detail?: string }).detail ?? ''), /撤回/u);

    // 过期回执同样挡住：此时放行新消息会让接续恢复漏掉这期间的文件写入。
    await backdateRecall(recallId, 120);
    const stale = await sendMessage(api, env, '崩溃遗留期间不应受理');
    assert.equal(stale.status, 409, stale.text);
    assert.equal((stale.body as { code: string }).code, 'INVALID_TRANSITION');

    await sql`update assist_message_recalls
      set status = 'COMPLETED', completed_at = now() where id = ${recallId}`.execute(app.db);
    const allowed = await sendMessage(api, env, '撤回结算后可以继续');
    assert.equal(allowed.status, 202, describe(allowed.body));
    await runRound(api, 'rr1-m2');
  } finally {
    await api.stop();
  }
});

test('RR-02 过期 RUNNING 按原回执接续恢复；未过期时拒绝并发执行', async () => {
  const api = await startTestApi();
  try {
    const env = await openBoundSession(api, 'recall-resume', { 'r.md': 'r0\n' });
    const round = await sendScripted(api, env,
      applyChangeset([{ path: 'r.md', action: 'MODIFY', content: 'r1\n',
        baselineSha256: await sha256OfContent('r0\n') }]), '接续用第一轮');
    await runRound(api, 'rr2-m1');
    await assertRoundSettled(round.assistant_message_id, 'RR-02 第一轮');
    assert.equal(await readOrNull(env.root, 'r.md'), 'r1\n');

    // 0132 改为发送前基线后，前像断言改为基线条目断言：目标消息的发送前字节
    // 必须在准入时入库（内容寻址），恢复接续按同一基线工作。
    const baseline = (await sql<{ message_id: string; id: string; status: string }>`
      select message_id, id, status from assist_message_baselines
      where message_id = ${round.user_message_id}`.execute(app.db)).rows[0];
    assert.ok(baseline !== undefined, '发送前基线必须在消息准入时建立');
    assert.equal(baseline.status, 'COMPLETE');
    const baselineEntry = (await sql<{ blob_sha256: string }>`
      select blob_sha256 from assist_message_baseline_files
      where baseline_id = ${baseline.id} and relative_path = 'r.md'`.execute(app.db)).rows[0];
    assert.ok(baselineEntry !== undefined, 'r.md 的发送前字节必须在基线里');
    assert.equal(baselineEntry.blob_sha256, await sha256OfContent('r0\n'));

    // 按一次「已预检、尚未恢复任何文件」的崩溃现场摆放回执。
    const recallId = await insertRunningRecall({ workspaceId: env.workspaceId,
      sessionId: env.sessionId, messageId: round.user_message_id,
      assistantMessageId: round.assistant_message_id, rootPath: env.root, plannedFiles: 1 });
    const expectedCurrent = await sha256OfContent('r1\n');
    await sql`insert into assist_message_recall_files (recall_id, relative_path,
      baseline_existed, baseline_sha256, baseline_message_id, expected_current_sha256,
      observed_sha256, status)
      values (${recallId}, 'r.md', true, ${baselineEntry.blob_sha256}, ${round.user_message_id},
        ${expectedCurrent}, ${expectedCurrent}, 'PLANNED')`.execute(app.db);

    const recallPath = workspacePath(env.workspaceId,
      `/assist-messages/${round.user_message_id}/recall`);
    const inFlight = await api.post(recallPath, { command_id: randomUUID() });
    assert.equal(inFlight.status, 409, inFlight.text);
    assert.equal((inFlight.body as { code: string }).code, 'RECALL_IN_PROGRESS',
      '未过期的回执不得被第二个客户端并发接续');
    assert.equal(await readOrNull(env.root, 'r.md'), 'r1\n');

    await backdateRecall(recallId, 120);
    const resumed = await api.post(recallPath, { command_id: randomUUID() });
    assert.equal(resumed.status, 200, resumed.text);
    const receipt = (resumed.body as { result: { id: string; status: string;
      planned_files: number; restored_files: number; skipped_files: number;
      files: { path: string; status: string; baseline: string }[] } }).result;
    assert.equal(receipt.id, recallId, '接续必须沿用原回执，不新建第二次撤回');
    assert.equal(receipt.status, 'COMPLETED', describe(receipt));
    assert.deepEqual([receipt.planned_files, receipt.restored_files, receipt.skipped_files],
      [1, 1, 0]);
    assert.deepEqual(receipt.files.map((file) => [file.path, file.status, file.baseline]),
      [['r.md', 'RESTORED', 'PRESENT']]);
    assert.equal(await readOrNull(env.root, 'r.md'), 'r0\n', '接续把文件恢复到发送前内容');

    const messages = await api.get(workspacePath(env.workspaceId,
      `/assist-sessions/${env.sessionId}/messages`));
    assert.equal(messages.status, 200, messages.text);
    const byId = new Map((messages.body as { items: { id: string;
      withdrawn_at: string | null }[] }).items.map((row) => [row.id, row]));
    assert.ok((byId.get(round.user_message_id)?.withdrawn_at ?? null) !== null,
      '接续结算后才标记撤回');
    assert.ok((byId.get(round.assistant_message_id)?.withdrawn_at ?? null) !== null);

    const allowed = await sendMessage(api, env, '接续完成后可以继续');
    assert.equal(allowed.status, 202, describe(allowed.body));
    await runRound(api, 'rr2-m2');
  } finally {
    await api.stop();
  }
});

test('RR-03 下一轮上下文只保留撤回占位与回执摘要，不回放旧回复原文', async () => {
  const api = await startTestApi();
  try {
    const env = await openBoundSession(api, 'recall-context', { 'c.md': 'c0\n' });
    const first = await sendScripted(api, env,
      applyChangeset([{ path: 'c.md', action: 'MODIFY', content: 'c1\n',
        baselineSha256: await sha256OfContent('c0\n') }]), '这轮的原文不应再回放');
    await runRound(api, 'rr3-m1');
    await assertRoundSettled(first.assistant_message_id, 'RR-03 第一轮');
    assert.equal(await readOrNull(env.root, 'c.md'), 'c1\n');

    const recall = await api.post(workspacePath(env.workspaceId,
      `/assist-messages/${first.user_message_id}/recall`), { command_id: randomUUID() });
    assert.equal(recall.status, 200, recall.text);
    assert.equal((recall.body as { result: { status: string } }).result.status, 'COMPLETED');
    assert.equal(await readOrNull(env.root, 'c.md'), 'c0\n');

    const port = new RecordingAssistPort();
    const sent = await sendMessage(api, env, '现在这个文件的内容是什么？');
    assert.equal(sent.status, 202, sent.text);
    await runRound(api, 'rr3-m2', port);

    assert.ok(port.requests.length > 0, '新一轮必须实际调用模型');
    const text = port.requests.flatMap((request) =>
      request.turns.map((turn) => turn.content)).join('\n---\n');
    assert.match(text, /消息撤回回执/u, '回执摘要必须进入下一轮上下文');
    assert.match(text, /已恢复 1\/1 个文件/u);
    assert.match(text, /已撤回轮次的旧回复与压缩摘要/u);
    const placeholders = port.requests[0]!.turns
      .filter((turn) => turn.content === '（该轮已撤回；原文与当时的文件效果不再作为当前事实。）');
    assert.equal(placeholders.length, 2, '目标用户消息与直接回复各留一条占位');
    assert.doesNotMatch(text, /FAKE_ASSIST_TOOLS/u, '撤回轮次的原文（含脚本）不得回放');
    assert.doesNotMatch(text, /这轮的原文不应再回放/u);
  } finally {
    await api.stop();
  }
});
