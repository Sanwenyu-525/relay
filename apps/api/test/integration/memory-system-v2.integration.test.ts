import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import { createAssistSession } from '../../src/application/assist-commands.js';
import {
  addMemoryRevision, createMemory, retireInformation,
} from '../../src/application/information-commands.js';
import { listInformation } from '../../src/application/information-queries.js';
import {
  consolidateMemoriesCommand, setMemoryPinnedCommand, setMemoryVerificationCommand,
} from '../../src/application/memory-commands.js';
import { runMemoryConsolidation } from '../../src/application/memory-consolidation.js';
import { readMemoryObservability } from '../../src/application/memory-observability.js';
import { recallConfirmedMemoryRefs } from '../../src/application/memory-recall.js';
import { readMemorySettings, setMemorySettings } from '../../src/application/memory-settings.js';
import { exportMemories, importMemories, purgeMemories } from '../../src/application/memory-transfer.js';
import { createRepositories, withTransaction } from '../../src/application/unit-of-work.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { APP_DATABASE_URL, MIGRATION_DATABASE_URL, MIGRATIONS_DIRECTORY, openDatabase } from './integration-support.js';

const app = openDatabase(APP_DATABASE_URL, 'relay-memory-v2');

before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
});
after(async () => { await app.close(); });

async function fixture(project = true) {
  const workspaceId = randomUUID();
  const projectId = project ? randomUUID() : null;
  await withTransaction(app.db, async (r) => {
    await r.workspaces.insertWorkspace({ id: workspaceId, name: 'memory-v2' });
    await r.workspaces.insertAuthorityRow(workspaceId);
    if (projectId !== null) {
      await r.projects.insertProject({ id: projectId, workspaceId, title: 'memory-v2', projectType: 'GENERAL' });
    }
  });
  const session = await createAssistSession(app.db, { workspaceId,
    ...(projectId === null ? {} : { projectId }), title: 'memory-v2', commandId: randomUUID() });
  return { workspaceId, projectId, sessionId: session.result.session_id };
}

test('同内容去重、同键新事实替代旧事实，并保留替代链', async () => {
  const f = await fixture();
  const first = await createMemory(app.db, { workspaceId: f.workspaceId, projectId: f.projectId,
    commandId: randomUUID(), title: '包管理器', text: '这个仓库使用 npm。', confirmed: true,
    memoryType: 'PROJECT_FACT', memoryKey: 'package-manager' });
  await assert.rejects(() => createMemory(app.db, { workspaceId: f.workspaceId, projectId: f.projectId,
    commandId: randomUUID(), title: '包管理器', text: '这个仓库使用 npm。', confirmed: true,
    memoryType: 'PROJECT_FACT', memoryKey: 'package-manager' }), (error: unknown) => {
    assert.match(JSON.stringify((error as { fieldErrors?: unknown }).fieldErrors), /高度相似/u);
    return true;
  });

  await createMemory(app.db, { workspaceId: f.workspaceId, projectId: f.projectId,
    commandId: randomUUID(), title: '包管理器', text: '这个仓库改用 pnpm。', confirmed: true,
    memoryType: 'PROJECT_FACT', memoryKey: 'package-manager' });
  const rows = await listInformation(app.db, 'memory', f.workspaceId, f.projectId ?? undefined);
  const old = rows.find((row) => row.id === first.result.memory_id);
  const current = rows.find((row) => row.id !== first.result.memory_id && row.memory_key === 'package-manager');
  assert.equal(old?.effective_status, 'SUPERSEDED');
  assert.equal(old?.superseded_by_id, current?.id);
  assert.equal(current?.effective_status, 'ACTIVE');
  assert.equal(current?.supersedes_id, first.result.memory_id);
});

test('敏感凭证拒绝写入；已验证/固定与人工验证命令真实落库', async () => {
  const f = await fixture();
  await assert.rejects(() => createMemory(app.db, { workspaceId: f.workspaceId, projectId: f.projectId,
    commandId: randomUUID(), title: '密钥', text: 'api_key = sk-ant-abcdefghijklmnopqrstuvwx',
    confirmed: true, memoryType: 'PROJECT_FACT' }), (error: unknown) => {
    assert.match(JSON.stringify((error as { fieldErrors?: unknown }).fieldErrors), /凭证/u);
    return true;
  });

  const memory = await createMemory(app.db, { workspaceId: f.workspaceId, projectId: f.projectId,
    commandId: randomUUID(), title: '命令', text: '构建使用 pnpm build。', confirmed: true,
    memoryType: 'EXPERIENCE', importance: 5 });
  const id = memory.result.memory_id!;
  let row = (await listInformation(app.db, 'memory', f.workspaceId, f.projectId ?? undefined))
    .find((item) => item.id === id);
  await setMemoryPinnedCommand(app.db, { workspaceId: f.workspaceId, memoryId: id,
    pinned: true, commandId: randomUUID(), expectedRevision: String(row?.revision ?? 0) });
  row = (await listInformation(app.db, 'memory', f.workspaceId, f.projectId ?? undefined))
    .find((item) => item.id === id);
  assert.equal(row?.pinned, true);

  await createRepositories(app.db).information.updateMemoryMetadata({
    memoryId: id, staleAt: new Date() });
  row = (await listInformation(app.db, 'memory', f.workspaceId, f.projectId ?? undefined))
    .find((item) => item.id === id);
  const verification = await setMemoryVerificationCommand(app.db, { workspaceId: f.workspaceId,
    memoryId: id, verification: 'FAILED', clearStale: true, commandId: randomUUID(),
    expectedRevision: String(row?.revision ?? 0) });
  row = (await listInformation(app.db, 'memory', f.workspaceId, f.projectId ?? undefined))
    .find((item) => item.id === id);
  assert.equal(row?.verification, 'FAILED');
  assert.equal(row?.confidence, 10);
  assert.equal(row?.stale_at, null);
  assert.equal(verification.result.revision, String(row?.revision),
    '验证回执必须返回清除陈旧后的真实 revision');
});

test('设置扩展字段持久化；召回预算生效；HYBRID 记录降级但仍返回字面命中', async () => {
  const f = await fixture();
  const marker = `BUDGET-${randomUUID()}`;
  await createMemory(app.db, { workspaceId: f.workspaceId, projectId: f.projectId,
    commandId: randomUUID(), title: '预算测试', text: `${marker} 这是一个预算测试。`,
    confirmed: true, memoryType: 'PROJECT_FACT' });
  await setMemorySettings(app.db, { workspaceId: f.workspaceId, commandId: randomUUID(),
    expectedRevision: '0', recallEnabled: true, automaticCompaction: true, autoCapture: true,
    coreTokenBudget: 100, retrievalTokenBudget: 100, retrievalTopK: 3, retrievalMode: 'HYBRID',
    autoConsolidate: false, consolidationIntervalHours: 48, memoryStaleAfterDays: 90,
    embeddingProvider: 'disabled', remoteEmbeddingAllowed: false, includeStaleInRecall: true });
  const settings = await readMemorySettings(app.db, f.workspaceId);
  assert.equal(settings?.core_token_budget, 100);
  assert.equal(settings?.retrieval_mode, 'HYBRID');
  assert.equal(settings?.include_stale_in_recall, true);

  const session = (await createRepositories(app.db).assist.readSession(f.sessionId))!;
  const refs = await recallConfirmedMemoryRefs(createRepositories(app.db), session,
    `${marker} 预算测试`, new Set<string>(), 5);
  assert.equal(refs.length, 1);
  assert.equal(refs[0]?.selection_basis, 'LITERAL_MATCH');

  await setMemorySettings(app.db, { workspaceId: f.workspaceId, commandId: randomUUID(),
    expectedRevision: settings?.revision as string, recallEnabled: true, automaticCompaction: true,
    autoCapture: true, retrievalTokenBudget: 0 });
  const afterZero = await recallConfirmedMemoryRefs(createRepositories(app.db),
    (await createRepositories(app.db).assist.readSession(f.sessionId))!, `${marker} 预算测试`,
    new Set<string>(), 5);
  assert.equal(afterZero.length, 0, '检索预算 0 时不得注入普通命中');

  const stats = await readMemoryObservability(app.db, f.workspaceId, f.projectId);
  const recall = stats.recall as { readonly last_24h: number };
  assert.ok(recall.last_24h >= 1);
});

test('固定记忆不受普通召回 topK 限制，只受 core 预算与候选上限约束', async () => {
  const f = await fixture();
  const items = [
    { title: '固定项甲', text: '数据库迁移前必须先做完整备份，并在隔离环境演练恢复。' },
    { title: '固定项乙', text: '缓存键设计要包含工作区身份，避免不同项目互相污染。' },
    { title: '固定项丙', text: '发布窗口固定在每周四晚间，紧急修复需要值班人确认。' },
    { title: '固定项丁', text: '日志轮转按天切分，保留周期由运维策略单独控制。' },
    { title: '固定项戊', text: '接口错误码必须稳定，客户端依赖错误码而不是提示文案。' },
    { title: '固定项己', text: '测试数据不得写入用户真实目录，验收结束要及时清理。' },
  ];
  const ids: string[] = [];
  for (const item of items) {
    const created = await createMemory(app.db, { workspaceId: f.workspaceId, projectId: f.projectId,
      commandId: randomUUID(), title: item.title, text: item.text,
      confirmed: true, memoryType: 'PROJECT_FACT' });
    ids.push(created.result.memory_id!);
  }
  for (const id of ids) {
    const row = (await listInformation(app.db, 'memory', f.workspaceId, f.projectId ?? undefined))
      .find((item) => item.id === id);
    await setMemoryPinnedCommand(app.db, { workspaceId: f.workspaceId, memoryId: id,
      pinned: true, commandId: randomUUID(), expectedRevision: String(row?.revision ?? 0) });
  }
  await setMemorySettings(app.db, { workspaceId: f.workspaceId,
    commandId: randomUUID(), expectedRevision: '0', recallEnabled: true,
    automaticCompaction: true, autoCapture: true, coreTokenBudget: 2000,
    retrievalTokenBudget: 100, retrievalTopK: 1, retrievalMode: 'LITERAL',
    autoConsolidate: false, consolidationIntervalHours: 24, memoryStaleAfterDays: 180 });
  assert.equal((await readMemorySettings(app.db, f.workspaceId))?.retrieval_top_k, 1);
  const session = (await createRepositories(app.db).assist.readSession(f.sessionId))!;
  const refs = await recallConfirmedMemoryRefs(createRepositories(app.db), session,
    '完全无关的测试查询', new Set<string>(), 10);
  assert.equal(refs.length, 6, '固定记忆不应被 retrieval_top_k 截断');
  assert.ok(refs.every((ref) => ref.selection_basis === 'PINNED'));
});

test('确定性整理回填索引、标记陈旧，并写真实运行记录', async () => {
  const f = await fixture();
  const r = createRepositories(app.db);
  const id = randomUUID();
  await withTransaction(app.db, async (tx) => {
    await tx.information.insertMemoryRoot({ id, workspaceId: f.workspaceId, projectId: f.projectId,
      title: '旧行', origin: 'HUMAN_CONFIRMED', memoryType: 'PROJECT_FACT',
      verification: 'UNVERIFIED' });
    await tx.information.insertMemoryVersion({ id: randomUUID(), memoryId: id, version: 1n,
      title: '旧行', text: '索引为空的一段旧正文。', confirmedBy: 'test', expiresAt: null });
  });
  const result = await withTransaction(app.db, (tx) => runMemoryConsolidation(app.db, tx,
    { workspaceId: f.workspaceId, trigger: 'MANUAL', staleAfterDays: 7 }));
  assert.equal(result.status, 'COMPLETED');
  assert.ok(result.stats.index_backfilled >= 1);
  const row = (await r.information.listMemoryStates(f.workspaceId, { id }))[0];
  assert.ok((row?.search_body_tokens ?? '') !== '');
  const runs = await r.information.listMemoryMaintenanceRuns(f.workspaceId, 5);
  assert.equal(runs[0]?.status, 'COMPLETED');
  assert.ok(Number(runs[0]?.stats.index_backfilled ?? 0) >= 0);

  const manual = await consolidateMemoriesCommand(app.db, { workspaceId: f.workspaceId,
    commandId: randomUUID() });
  assert.ok(['COMPLETED', 'SKIPPED'].includes(String(manual.result.status)));
});

test('导出、导入、真实删除：删除后不再从列表或统计召回', async () => {
  const source = await fixture(false);
  const marker = `EXPORT-${randomUUID()}`;
  const created = await createMemory(app.db, { workspaceId: source.workspaceId, projectId: null,
    commandId: randomUUID(), title: '导出条目', text: `${marker} 可导出正文。`, confirmed: true,
    memoryType: 'USER_PREFERENCE' });
  const exported = await exportMemories(app.db, source.workspaceId, null);
  assert.equal(exported.schema_version, 1);
  const memories = exported.memories as readonly Record<string, unknown>[];
  assert.equal(memories.length, 1);
  assert.ok(!JSON.stringify(exported).includes('session'));

  const target = await fixture(false);
  const imported = await importMemories(app.db, { workspaceId: target.workspaceId,
    commandId: randomUUID(), expectedPayload: exported, projectId: null });
  assert.equal(imported.result.created, 1);
  const targetRows = await listInformation(app.db, 'memory', target.workspaceId);
  assert.equal(targetRows.length, 1);
  const sourceSession = (await createRepositories(app.db).assist.readSession(source.sessionId))!;
  const beforePurge = await recallConfirmedMemoryRefs(createRepositories(app.db), sourceSession,
    marker, new Set<string>(), 5);
  assert.equal(beforePurge.length, 1, '删除前应能按正文召回');

  await retireInformation(app.db, { kind: 'memory', id: created.result.memory_id!,
    workspaceId: source.workspaceId, commandId: randomUUID(), expectedRevision: '0' });
  const purged = await purgeMemories(app.db, { workspaceId: source.workspaceId,
    commandId: randomUUID(), memoryIds: [created.result.memory_id!], includeActive: true,
    confirmation: 'DELETE_MEMORIES' });
  assert.equal(purged.result.deleted, '1');
  const after = await listInformation(app.db, 'memory', source.workspaceId);
  assert.equal(after.length, 0);
  const afterPurge = await recallConfirmedMemoryRefs(createRepositories(app.db), sourceSession,
    marker, new Set<string>(), 5);
  assert.equal(afterPurge.length, 0, '真实删除后不得从旧索引继续召回');
});

test('修订改写正文后旧的已验证状态不会自动继承，除非显式再次验证', async () => {
  const f = await fixture();
  const memory = await createMemory(app.db, { workspaceId: f.workspaceId, projectId: f.projectId,
    commandId: randomUUID(), title: '验证绑定', text: '原始正文通过验证。', confirmed: true,
    memoryType: 'PROJECT_FACT', verification: 'VERIFIED' });
  const id = memory.result.memory_id!;
  await createRepositories(app.db).information.updateMemoryMetadata({
    memoryId: id, staleAt: new Date() });
  const staleRevision = (await listInformation(app.db, 'memory', f.workspaceId, f.projectId ?? undefined))
    .find((item) => item.id === id)?.revision;
  const revision = await addMemoryRevision(app.db, { workspaceId: f.workspaceId, memoryId: id,
    commandId: randomUUID(), expectedRevision: String(staleRevision ?? '1'), title: '验证绑定',
    text: '改写后的正文尚未验证。', confirmed: true });
  assert.equal(revision.result.version, '2');
  const row = (await listInformation(app.db, 'memory', f.workspaceId, f.projectId ?? undefined))
    .find((item) => item.id === id);
  assert.equal(revision.result.revision, String(row?.revision), '命令回执必须返回推进后的真实 revision');
  assert.equal(row?.verification, 'UNVERIFIED');
  assert.equal(row?.verified_at, null);
  assert.equal(row?.stale_at, null, '新修订不得继续被旧的陈旧标记挡住');
});

test('项目隔离：同键可在不同项目共存，召回不跨项目，工作空间记忆对项目会话可见', async () => {
  const a = await fixture();
  const b = await fixture();
  const markerA = `PROJA-${randomUUID()}`;
  const markerB = `PROJB-${randomUUID()}`;
  const memoryA = await createMemory(app.db, { workspaceId: a.workspaceId, projectId: a.projectId,
    commandId: randomUUID(), title: '包管理器 A', text: `包管理器使用 npm ${markerA}`,
    confirmed: true, memoryType: 'PROJECT_FACT', memoryKey: 'package-manager' });
  const memoryB = await createMemory(app.db, { workspaceId: b.workspaceId, projectId: b.projectId,
    commandId: randomUUID(), title: '包管理器 B', text: `包管理器使用 pnpm ${markerB}`,
    confirmed: true, memoryType: 'PROJECT_FACT', memoryKey: 'package-manager' });
  const workspaceMemory = await createMemory(app.db, { workspaceId: a.workspaceId,
    projectId: null, commandId: randomUUID(), title: '通用偏好',
    text: `所有项目默认使用中文 ${markerA}`, confirmed: true, memoryType: 'USER_PREFERENCE' });

  const rowsA = await listInformation(app.db, 'memory', a.workspaceId, a.projectId ?? undefined);
  const rowsB = await listInformation(app.db, 'memory', b.workspaceId, b.projectId ?? undefined);
  assert.equal(rowsA.filter((row) => row.memory_key === 'package-manager').length, 1);
  assert.equal(rowsB.filter((row) => row.memory_key === 'package-manager').length, 1);
  assert.equal(rowsA.find((row) => row.memory_key === 'package-manager')?.title, '包管理器 A');
  assert.equal(rowsB.find((row) => row.memory_key === 'package-manager')?.title, '包管理器 B');

  const refs = await recallConfirmedMemoryRefs(createRepositories(app.db),
    (await createRepositories(app.db).assist.readSession(a.sessionId))!, `包管理器 ${markerA}`,
    new Set<string>(), 10);
  const ids = refs.map((ref) => ref.root_id);
  assert.ok(ids.includes(memoryA.result.memory_id!));
  assert.ok(ids.includes(workspaceMemory.result.memory_id!));
  assert.ok(!ids.includes(memoryB.result.memory_id!));
});

test('任务作用域校验：不存在的 task 不能写入，存在的 task 才进 TASK 作用域', async () => {
  const f = await fixture();
  await assert.rejects(() => createMemory(app.db, { workspaceId: f.workspaceId,
    projectId: f.projectId, commandId: randomUUID(), title: '任务记忆', text: '任务级事实。',
    confirmed: true, memoryType: 'PROJECT_FACT', taskId: randomUUID() }), /not found|不存在/iu);
});
