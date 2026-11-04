import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import { promisify } from 'node:util';

import { sql } from 'kysely';

import { captureMessageBaseline } from '../../src/application/assist-file-baseline.js';
import { runAssistGenerationTick } from '../../src/application/assist-runner.js';
import { createRepositories, withTransaction } from '../../src/application/unit-of-work.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { ManagedContentStore } from '../../src/storage/managed-content-store.js';
import { FakeModelPort } from '../../src/workflow/fake-model-port.js';
import { createDataRoot, startTestApi, workspacePath } from './api-harness.js';
import { APP_DATABASE_URL, MIGRATIONS_DIRECTORY, MIGRATION_DATABASE_URL, openDatabase }
  from './integration-support.js';

/**
 * AGENT-FILE-CONTEXT-V3 的真实链路验收（2026-11-04）。
 *
 * 三条产品语义在这里被钉住：
 *   1. 绑定大目录发普通消息不再触发整目录内容扫描/发送前快照（V3 §P0-1）；
 *   2. 真实写入前的保护证据按 Operation + 路径落库，CREATE/MODIFY/DELETE 三类守恒（V3 §P0-2）；
 *   3. 撤回按「本次写入前真实字节」恢复，而不是按消息时刻回滚目录（V3 §P1-1）。
 *
 * 全部走真实 HTTP + 真实 PostgreSQL + 真实文件 I/O + FakeModelPort 脚本驱动，不用模拟文件系统。
 * 「旧整目录基线」的耗时用同一套生成器造出等价目录后直接调用历史 `captureMessageBaseline`
 * 测得，作为改动前后的同条件对照；新准入路径不调用它。
 */

const app = openDatabase(APP_DATABASE_URL, 'relay-api-test-file-context-v3');
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

/** 造一个「像仓库」的目录：1000 个 4 KiB 文件分布在多层子目录，总量约 4 MiB。 */
async function makeRepositoryLikeDirectory(base: string, label: string): Promise<string> {
  const root = join(base, `${label}-${randomUUID()}`);
  for (let index = 0; index < 1_000; index += 1) {
    const bucket = `pkg${String(index % 20).padStart(2, '0')}`;
    const relativePath = join(bucket, `mod${String(index % 50).padStart(2, '0')}`,
      `file-${String(index).padStart(4, '0')}.ts`);
    const target = join(root, relativePath);
    await mkdir(join(target, '..'), { recursive: true });
    const content = `// ${relativePath}\n${'export const value = 0;\n'.repeat(160)}`;
    await writeFile(target, content, 'utf8');
  }
  await writeFile(join(root, 'AGENTS.md'), '# 项目规则\n按规则执行。\n', 'utf8');
  // 必须是真实的 Git 仓库：会话 Diff 的整目录基线只对 Git 根生效，非 Git 目录测不出扫描成本。
  await promisify(execFile)('git', ['init', '--quiet'], { cwd: root });
  return root;
}

/**
 * 打开真实目录并切 FULL 写档（与消息撤回验收同一路径；直写没有审批接续通道，AUTO 会等批准）。
 */
async function openDirectory(api: Awaited<ReturnType<typeof startTestApi>>, name: string,
  root: string) {
  const workspaceId = randomUUID();
  await withTransaction(app.db, async (repositories) => {
    await repositories.workspaces.insertWorkspace({ id: workspaceId, name });
    await repositories.workspaces.insertAuthorityRow(workspaceId);
  });
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

async function createBoundSession(api: Awaited<ReturnType<typeof startTestApi>>,
  env: { workspaceId: string; projectId: string; resourceId: string }, title: string) {
  const path = (suffix: string) => workspacePath(env.workspaceId, suffix);
  const created = await api.post(path('/assist-sessions'), { command_id: randomUUID(),
    project_id: env.projectId, title });
  assert.equal(created.status, 201, created.text);
  const sessionId = (created.body as { result: { session_id: string } }).result.session_id;
  const bound = await api.post(path(`/assist-sessions/${sessionId}/working-directory`), {
    command_id: randomUUID(), resource_id: env.resourceId });
  assert.equal(bound.status, 200, bound.text);
  return sessionId;
}

async function openBoundSession(api: Awaited<ReturnType<typeof startTestApi>>, name: string,
  root: string, sessionTitle: string) {
  const dir = await openDirectory(api, name, root);
  const sessionId = await createBoundSession(api, dir, sessionTitle);
  return { ...dir, sessionId };
}

async function sendPlain(api: Awaited<ReturnType<typeof startTestApi>>,
  env: { workspaceId: string; sessionId: string }, content: string) {
  const sent = await api.post(workspacePath(env.workspaceId,
    `/assist-sessions/${env.sessionId}/messages`), {
    command_id: randomUUID(), content, intent: 'DISCUSS' });
  assert.equal(sent.status, 202, sent.text);
  return (sent.body as { result: { user_message_id: string; assistant_message_id: string } }).result;
}

function applyChangeset(changes: readonly unknown[]): unknown[][] {
  return [[{ name: 'apply_changeset', arguments: { changes } }]];
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

async function runRound(api: Awaited<ReturnType<typeof startTestApi>>, label: string) {
  const generated = await runAssistGenerationTick(app.db, {
    workerId: `file-context-v3-${label}-${randomUUID()}`,
    storage: new ManagedContentStore(api.dataRoot), leaseMs: 60_000, maxMessages: 1,
    modelPort: new FakeModelPort() });
  assert.ok(generated, `${label}：这条消息必须由普通会话主流程领取`);
}

/** 同一测试库内还有别的 PENDING 消息时，领取是按整库顺序的；先把它们跑完再断言本条。 */
async function drainPending(api: Awaited<ReturnType<typeof startTestApi>>, label: string,
  count: number) {
  for (let index = 0; index < count; index += 1) {
    const generated = await runAssistGenerationTick(app.db, {
      workerId: `file-context-v3-drain-${label}-${randomUUID()}`,
      storage: new ManagedContentStore(api.dataRoot), leaseMs: 60_000, maxMessages: 1,
      modelPort: new FakeModelPort() });
    if (!generated) return;
  }
}

async function assertRoundSettled(assistantMessageId: string, label: string) {
  const message = await createRepositories(app.db).assist.readMessage(assistantMessageId);
  assert.equal(message?.status, 'COMPLETED',
    `${label}：助手消息应完成（${message?.status}/${message?.error_code ?? '无错误'}）`);
}

async function snapshotRowCounts(workspaceId: string): Promise<{
  baselines: number; baselineFiles: number; preimages: number; blobs: number }> {
  const baselines = (await sql<{ count: string }>`
    select count(*)::text as count from assist_message_baselines
    where workspace_id = ${workspaceId}`.execute(app.db)).rows[0]!.count;
  const baselineFiles = (await sql<{ count: string }>`
    select count(*)::text as count from assist_message_baseline_files f
    join assist_message_baselines b on b.id = f.baseline_id
    where b.workspace_id = ${workspaceId}`.execute(app.db)).rows[0]!.count;
  const preimages = (await sql<{ count: string }>`
    select count(*)::text as count from file_write_preimages p
    join logical_operations op on op.id = p.operation_id
    where op.workspace_id = ${workspaceId}`.execute(app.db)).rows[0]!.count;
  const blobs = (await sql<{ count: string }>`
    select count(*)::text as count from assist_message_snapshot_blobs b
    where exists (select 1 from assist_message_baseline_files f
        join assist_message_baselines lb on lb.id = f.baseline_id
        where lb.workspace_id = ${workspaceId} and f.blob_sha256 = b.blob_sha256)
      or exists (select 1 from file_write_preimages p
        join logical_operations op on op.id = p.operation_id
        where op.workspace_id = ${workspaceId} and p.blob_sha256 = b.blob_sha256)`
    .execute(app.db)).rows[0]!.count;
  return { baselines: Number(baselines), baselineFiles: Number(baselineFiles),
    preimages: Number(preimages), blobs: Number(blobs) };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

/** 会话 Diff 的整目录写前基线也是「扫全目录」的一种，普通聊天必须为 0。 */
async function conversationDiffBaselineCount(workspaceId: string): Promise<number> {
  const row = (await sql<{ count: string }>`select count(*)::text as count
    from conversation_diff_baselines where workspace_id = ${workspaceId}`
    .execute(app.db)).rows[0]!;
  return Number(row.count);
}

test('V3-S1 大目录发「你好」：准入不扫整目录、不建发送前快照、消息正常进入执行', async () => {
  const api = await startTestApi();
  const bigRoot = await makeRepositoryLikeDirectory(dataRoot, 'big-admission');
  roots.push(bigRoot);
  try {
    const dir = await openDirectory(api, 'big-admission-ws', bigRoot);
    const samples: number[] = [];
    for (let sample = 0; sample < 5; sample += 1) {
      const sessionId = await createBoundSession(api, dir, `大目录普通消息-${sample}`);
      const started = performance.now();
      const sent = await sendPlain(api, { workspaceId: dir.workspaceId, sessionId }, '你好');
      const elapsed = performance.now() - started;
      samples.push(elapsed);
      assert.ok(elapsed < 15_000, `第 ${sample} 次准入耗时 ${elapsed.toFixed(0)}ms 超出安全上限`);
      const assistant = await createRepositories(app.db).assist.readMessage(sent.assistant_message_id);
      assert.ok(assistant !== undefined, '助手消息必须尽早持久化');
      assert.ok(['PENDING', 'RUNNING', 'COMPLETED'].includes(assistant!.status),
        `助手消息状态必须真实（实际 ${assistant!.status}）`);
    }
    const counts = await snapshotRowCounts(dir.workspaceId);
    assert.deepEqual(counts, { baselines: 0, baselineFiles: 0, preimages: 0, blobs: 0 },
      '普通消息不得产生整目录快照、前像或快照字节');
    assert.equal(await conversationDiffBaselineCount(dir.workspaceId), 0,
      '普通聊天不得建立会话 Diff 的整目录写前基线（真实 Git 仓库下也不扫）');
    await drainPending(api, 'big', 5);
    console.log(`V3_ADMISSION_BIG ${JSON.stringify({ samples,
      min: Math.min(...samples), median: median(samples), max: Math.max(...samples),
      files: 1_001, bytes: 1_001 * 4 * 1_024 })}`);
  } finally {
    await api.stop();
  }
});

test('V3-S2 小目录普通消息：同条件基准样本', async () => {
  const api = await startTestApi();
  const smallRoot = join(dataRoot, `small-admission-${randomUUID()}`);
  roots.push(smallRoot);
  await mkdir(smallRoot, { recursive: true });
  await writeFile(join(smallRoot, 'AGENTS.md'), '# 规则\n', 'utf8');
  await writeFile(join(smallRoot, 'README.md'), '# 说明\n', 'utf8');
  try {
    const dir = await openDirectory(api, 'small-admission-ws', smallRoot);
    const samples: number[] = [];
    for (let sample = 0; sample < 5; sample += 1) {
      const sessionId = await createBoundSession(api, dir, `小目录普通消息-${sample}`);
      const started = performance.now();
      await sendPlain(api, { workspaceId: dir.workspaceId, sessionId }, '你好');
      samples.push(performance.now() - started);
    }
    const counts = await snapshotRowCounts(dir.workspaceId);
    assert.deepEqual(counts, { baselines: 0, baselineFiles: 0, preimages: 0, blobs: 0 });
    await drainPending(api, 'small', 5);
    console.log(`V3_ADMISSION_SMALL ${JSON.stringify({ samples,
      min: Math.min(...samples), median: median(samples), max: Math.max(...samples) })}`);
  } finally {
    await api.stop();
  }
});

test('V3-S3 改动前的整目录基线成本：同一生成器目录上直接调用历史实现', async () => {
  const api = await startTestApi();
  const legacyRoot = await makeRepositoryLikeDirectory(dataRoot, 'big-legacy');
  roots.push(legacyRoot);
  try {
    const dir = await openDirectory(api, 'big-legacy-ws', legacyRoot);
    const sessionId = await createBoundSession(api, dir, '历史基线耗时');
    const message = await sendPlain(api, { workspaceId: dir.workspaceId, sessionId }, '你好');
    let result: Awaited<ReturnType<typeof captureMessageBaseline>> | undefined;
    let elapsed = 0;
    // 历史调用点在消息准入事务内；采集的数据库阶段依赖同一连接上的 SAVEPOINT。
    await withTransaction(app.db, async (repositories) => {
      const session = await repositories.assist.readSession(sessionId);
      assert.ok(session !== undefined);
      const started = performance.now();
      result = await captureMessageBaseline(repositories, {
        workspaceId: dir.workspaceId, session: session!, messageId: message.user_message_id,
        resourceId: dir.resourceId, rootPath: legacyRoot });
      elapsed = performance.now() - started;
    });
    assert.ok(result !== undefined, '历史采集必须返回结果');
    assert.ok(['COMPLETE', 'INCOMPLETE'].includes(result!.status), describe(result));
    const counts = await snapshotRowCounts(dir.workspaceId);
    assert.ok(counts.baselines >= 1,
      `历史实现必须真的建出整目录基线（作为对照；实际 status=${result.status} ` +
      `reason=${result.reason} rows=${counts.baselines}）`);
    assert.ok(counts.baselineFiles >= 1_000, `历史实现应遍历全部文件（实际 ${counts.baselineFiles}）`);
    await drainPending(api, 'legacy', 1);
    console.log(`V3_LEGACY_BASELINE ${JSON.stringify({ elapsedMs: elapsed,
      status: result.status, files: counts.baselineFiles, baselines: counts.baselines,
      blobs: counts.blobs })}`);
  } finally {
    await api.stop();
  }
});

test('V3-S4 CREATE/MODIFY/DELETE 写入前保护证据与撤销真实字节', async () => {
  const api = await startTestApi();
  const root = join(dataRoot, `preimage-${randomUUID()}`);
  roots.push(root);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'keep.txt'), 'keep-0\n', 'utf8');
  await writeFile(join(root, 'remove.txt'), 'remove-0\n', 'utf8');
  const keepSha = await sha256OfContent('keep-0\n');
  const removeSha = await sha256OfContent('remove-0\n');
  try {
    const env = await openBoundSession(api, 'preimage-ws', root, '三类写入保护');
    const message = await sendScripted(api, env, applyChangeset([
      { path: 'keep.txt', action: 'MODIFY', content: 'keep-1\n', baselineSha256: keepSha },
      { path: 'created.txt', action: 'CREATE', content: 'created\n' },
      { path: 'remove.txt', action: 'DELETE', baselineSha256: removeSha },
    ]), '一次变更集覆盖三类');
    await runRound(api, 's4');
    await assertRoundSettled(message.assistant_message_id, 'V3-S4');
    assert.equal(await readOrNull(root, 'keep.txt'), 'keep-1\n');
    assert.equal(await readOrNull(root, 'created.txt'), 'created\n');
    assert.equal(await readOrNull(root, 'remove.txt'), null);

    const rows = (await sql<{ relative_path: string; existed: boolean; blob_sha256: string | null;
      size_bytes: string | null; unavailable_reason: string | null; operation_id: string }>`
      select p.relative_path, p.existed, p.blob_sha256, p.size_bytes, p.unavailable_reason,
        p.operation_id
      from file_write_preimages p
      join logical_operations op on op.id = p.operation_id
      where op.workspace_id = ${env.workspaceId}
      order by p.relative_path`.execute(app.db)).rows;
    assert.deepEqual(rows.map((row) => [row.relative_path, row.existed, row.blob_sha256,
      row.unavailable_reason]).sort(), [
      ['created.txt', false, null, null],
      ['keep.txt', true, keepSha, null],
      ['remove.txt', true, removeSha, null],
    ].sort(), describe(rows));
    assert.equal(new Set(rows.map((row) => row.operation_id)).size, 1,
      '同一变更集的三条保护证据应绑定同一个 Operation');
    assert.equal(Number(rows.find((row) => row.relative_path === 'keep.txt')?.size_bytes
      ?? '0'), Buffer.byteLength('keep-0\n', 'utf8'));

    const recall = await api.post(workspacePath(env.workspaceId,
      `/assist-messages/${message.user_message_id}/recall`), { command_id: randomUUID() });
    assert.equal(recall.status, 200, recall.text);
    const receipt = (recall.body as { result: { status: string;
      files: { path: string; status: string; baseline: string; snapshot_source?: string }[] } }).result;
    assert.equal(receipt.status, 'COMPLETED', describe(recall.body));
    assert.deepEqual(receipt.files.map((file) => [file.path, file.status, file.baseline]).sort(), [
      ['created.txt', 'RESTORED', 'ABSENT'],
      ['keep.txt', 'RESTORED', 'PRESENT'],
      ['remove.txt', 'RESTORED', 'PRESENT'],
    ].sort(), describe(receipt.files));
    assert.equal(await readOrNull(root, 'keep.txt'), 'keep-0\n');
    assert.equal(await readOrNull(root, 'created.txt'), null);
    const restoredRemove = await readFile(join(root, 'remove.txt'), 'utf8');
    assert.equal(restoredRemove, 'remove-0\n');

    const recallFiles = (await sql<{ relative_path: string; snapshot_source: string;
      source_operation_id: string | null }>`
      select f.relative_path, f.snapshot_source, f.source_operation_id
      from assist_message_recall_files f
      join assist_message_recalls r on r.id = f.recall_id
      where r.message_id = ${message.user_message_id}`.execute(app.db)).rows;
    assert.ok(recallFiles.length > 0);
    for (const file of recallFiles) {
      assert.equal(file.snapshot_source, 'PRECISE_PREIMAGE', describe(file));
      assert.ok(file.source_operation_id !== null, describe(file));
    }
  } finally {
    await api.stop();
  }
});
