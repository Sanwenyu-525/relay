import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { sql } from 'kysely';

import { selectSessionModel, readSessionModel } from '../../src/application/select-session-model.js';
import { requestAssistMessage } from '../../src/application/assist-commands.js';
import { createRepositories } from '../../src/application/unit-of-work.js';
import { DomainError } from '../../src/application/domain-error.js';
import { SessionModelSelectionRepository } from '../../src/model/session-model-selection-repository.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { createDataRoot, createWorkspace } from './api-harness.js';
import {
  APP_DATABASE_URL, MIGRATIONS_DIRECTORY, MIGRATION_DATABASE_URL, openDatabase, expectSqlState,
} from './integration-support.js';

/**
 * 会话模型选择的真实 PG 集成（专项阶段 C；FM-06 的 revision/幂等/CAS/隔离，迁移 0089 的 CHECK）。
 *
 * 单测只覆盖了纯解析器；**依赖真实 SQL 事务/唯一约束/行级 CAS** 的保证在这里验证：
 *   * 默认连接选择落库、可只读回显、从不写 model_calls / runs、从不改进程默认；
 *   * 同一 command_id 重放返回原结果且不新增回执、不推进 revision；
 *   * 新 command_id 重选以 revision CAS 单调递增；仓库层基线不符 → null；
 *   * 跨会话互不影响；目录免费项依赖独立 OpenRouter 聊天凭据持久选择，缺失时不串用其他凭据；
 *   * 迁移 0089 的「免费必带目录依据 / 依据三列同现同缺」CHECK 真正拦截半截写入。
 * 时钟与凭据都不触达真实平台：默认连接靠注入的可解析配置（选择从不外呼），目录靠直接入库的快照行。
 */

const app = openDatabase(APP_DATABASE_URL, 'relay-session-model-selection-test');

// 可解析但不外呼的「默认连接」：parseModelBaseUrl 只验证公开 https，选择命令不发起任何调用。
const DEFAULT_ENV = {
  RELAY_MODEL_PROVIDER: 'openai-compatible', RELAY_MODEL_NAME: 'gpt-default',
  RELAY_MODEL_API_KEY: 'relay-integration-not-a-real-key',
  RELAY_MODEL_BASE_URL: 'https://models.vendor.com/v1',
} as NodeJS.ProcessEnv;
const FAKE_ENV = { RELAY_MODEL_PROVIDER: 'fake' } as NodeJS.ProcessEnv;

before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
  await createDataRoot();
});
after(async () => { await app.close(); });

async function newSession(workspaceId: string, title = '选择测试会话'): Promise<string> {
  const id = randomUUID();
  await createRepositories(app.db).assist.insertSession({
    id, workspaceId, projectId: null, taskId: null, title });
  return id;
}
async function receiptsFor(commandId: string): Promise<number> {
  const row = (await sql<{ c: string }>`select count(*)::text as c from command_receipts
    where command_id = ${commandId}`.execute(app.db)).rows[0];
  return Number(row?.c ?? '0');
}
async function selectionRowCount(sessionId: string): Promise<number> {
  const row = (await sql<{ c: string }>`select count(*)::text as c from session_model_selection
    where session_id = ${sessionId}`.execute(app.db)).rows[0];
  return Number(row?.c ?? '0');
}
async function seedCatalog(seq: string, models: [string, boolean][]): Promise<void> {
  await sql`delete from model_catalog_entries`.execute(app.db);
  for (const [id, isFree] of models) {
    await sql`
      insert into model_catalog_entries
        (source_model_id, display_name, context_window, pricing, capabilities, is_free, not_free_reason, fetched_at)
      values (${id}, ${id}, 131072, '{}'::jsonb,
        ${JSON.stringify({ tools: true, structured_outputs: false, response_format: true,
          text_input: isFree, text_output: isFree, image_input: false })}::jsonb, ${isFree},
        ${isFree ? null : 'NONZERO_PRICE'}, now())`.execute(app.db);
  }
  await sql`update model_catalog_sync_state set snapshot_seq = ${seq}::bigint,
    last_success_at = now() where singleton = true
    `.execute(app.db);
}
async function expectDomainCode(work: () => Promise<unknown>, code: string): Promise<void> {
  try { await work(); } catch (error) {
    if (error instanceof DomainError) { assert.equal(error.code, code); return; }
    throw new Error(`期望抛出的 DomainError ${code}，实际：${String(error)}`);
  }
  throw new Error(`期望抛出的 DomainError ${code} 没有出现`);
}

test('默认连接选择落库并可只读回显；从不写 model_calls，同一 command_id 重放不推进 revision', async () => {
  const workspaceId = await createWorkspace(app.db);
  const sessionId = await newSession(workspaceId);
  const commandId = randomUUID();
  const callsBefore = Number(((await sql<{ c: string }>`select count(*)::text as c from model_calls`
    .execute(app.db)).rows[0]?.c ?? '0'));

  const first = await selectSessionModel(app.db, {
    workspaceId, sessionId, commandId, requestedModel: 'gpt-default', env: DEFAULT_ENV });
  assert.equal(first.replayed, false);
  assert.equal(first.result.connection, 'default');
  assert.equal(first.result.model, 'gpt-default');
  assert.equal(first.result.free_only, false);
  assert.equal(first.result.catalog_source, null);
  assert.equal(first.result.catalog_snapshot_seq, null);
  assert.equal(first.result.catalog_model_id, null);
  assert.equal(first.result.revision, '1');
  assert.match(first.result.config_fingerprint, /^[0-9a-f]{64}$/u);
  assert.equal(await selectionRowCount(sessionId), 1);

  // 只读回显与写入结果一致。
  assert.deepEqual(await readSessionModel(app.db, { workspaceId, sessionId }), first.result);

  // 同 command_id + 同内容重放：返回原结果，replayed=true，不新增回执、revision 不推进。
  const replay = await selectSessionModel(app.db, {
    workspaceId, sessionId, commandId, requestedModel: 'gpt-default', env: DEFAULT_ENV });
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.result, first.result);
  assert.equal(await receiptsFor(commandId), 1);
  assert.equal((await readSessionModel(app.db, { workspaceId, sessionId }))?.revision, '1');

  // 新 command_id 重选：走 CAS UPDATE，revision 单调递增到 2，仍只一行。
  const second = await selectSessionModel(app.db, {
    workspaceId, sessionId, commandId: randomUUID(), requestedModel: 'gpt-default', env: DEFAULT_ENV });
  assert.equal(second.replayed, false);
  assert.equal(second.result.revision, '2');
  assert.equal(await selectionRowCount(sessionId), 1);

  // 选择从不建模型调用账本，也不创建 Run。
  assert.equal(Number(((await sql<{ c: string }>`select count(*)::text as c from model_calls`
    .execute(app.db)).rows[0]?.c ?? '0')), callsBefore);
});

test('跨会话隔离：A 的选择对 B 不可见，B 无覆盖即沿用默认（readSessionModel 返回 undefined）', async () => {
  const workspaceId = await createWorkspace(app.db);
  const sessionA = await newSession(workspaceId, 'A');
  const sessionB = await newSession(workspaceId, 'B');
  await selectSessionModel(app.db, {
    workspaceId, sessionId: sessionA, commandId: randomUUID(),
    requestedModel: 'gpt-default', env: DEFAULT_ENV });
  assert.equal(await selectionRowCount(sessionB), 0);
  assert.equal(await readSessionModel(app.db, { workspaceId, sessionId: sessionB }), undefined);
  // 跨 workspace 的 session 对另一 workspace 不可见。
  const otherWorkspace = await createWorkspace(app.db);
  await expectDomainCode(
    () => readSessionModel(app.db, { workspaceId: otherWorkspace, sessionId: sessionA }),
    'RESOURCE_NOT_FOUND');
});

test('仓库层 CAS：基线 revision 不符返回 null，绝不覆盖更新的值', async () => {
  const workspaceId = await createWorkspace(app.db);
  const sessionId = await newSession(workspaceId);
  const repo = new SessionModelSelectionRepository(app.db);
  const base = {
    sessionId, connection: 'default' as const, model: 'gpt-default',
    configFingerprint: 'a'.repeat(64), freeOnly: false, catalogSource: null,
    catalogSnapshotSeq: null, catalogModelId: null, commandId: randomUUID(), now: new Date(),
  };
  const created = await repo.applySelection({ ...base, expectedRevision: null });
  assert.ok(created);
  assert.equal(created?.revision.toString(), '1');
  // 首次写的 on-conflict：再次以 null 基线写同一会话 → 命中已存在行 → null（不重复建行）。
  assert.equal(await repo.applySelection({ ...base, expectedRevision: null }), null);
  // 陈旧基线：以 '1' 之外的值作 CAS 基线 → 0 行 → null。
  assert.equal(await repo.applySelection({ ...base, expectedRevision: '999' }), null);
  // 正确基线 '1' → 递增到 2。
  const bumped = await repo.applySelection({ ...base, expectedRevision: '1' });
  assert.equal(bumped?.revision.toString(), '2');
});

test('OpenRouter 免费目录项使用独立聊天凭据落库；缺凭据、收费与目录外均按类型拒绝', async () => {
  const workspaceId = await createWorkspace(app.db);
  const sessionId = await newSession(workspaceId);
  await seedCatalog('5', [['free-a', true], ['paid-b', false]]);

  // 即使其他平台默认密钥和目录密钥存在，也不得被复用为 OpenRouter 聊天凭据。
  await expectDomainCode(() => selectSessionModel(app.db, {
    workspaceId, sessionId, commandId: randomUUID(), requestedModel: 'free-a', env: {
      ...FAKE_ENV, RELAY_MODEL_API_KEY: 'other-platform-key',
      RELAY_MODEL_CATALOG_API_KEY: 'catalog-key' } as NodeJS.ProcessEnv }),
  'OPENROUTER_CHAT_NOT_CONFIGURED');
  assert.equal(await selectionRowCount(sessionId), 0);

  const chosen = await selectSessionModel(app.db, {
    workspaceId, sessionId, commandId: randomUUID(), requestedModel: 'free-a', env: {
      ...FAKE_ENV, RELAY_OPENROUTER_API_KEY: 'isolated-openrouter-key' } as NodeJS.ProcessEnv });
  assert.equal(chosen.result.connection, 'openrouter');
  assert.equal(chosen.result.free_only, true);
  assert.equal(chosen.result.catalog_model_id, 'free-a');
  assert.match(chosen.result.config_fingerprint, /^[0-9a-f]{64}$/u);
  assert.equal(await selectionRowCount(sessionId), 1);

  await expectDomainCode(() => selectSessionModel(app.db, {
    workspaceId, sessionId, commandId: randomUUID(), requestedModel: 'paid-b', env: FAKE_ENV }),
  'MODEL_PAID_NOT_AVAILABLE');
  await expectDomainCode(() => selectSessionModel(app.db, {
    workspaceId, sessionId, commandId: randomUUID(), requestedModel: 'not-listed', env: FAKE_ENV }),
  'MODEL_NOT_REGISTERED');

  await sql`delete from model_catalog_entries`.execute(app.db);
});

test('模型选择与待处理首条消息通过会话行锁顺序绑定', async () => {
  const workspaceId = await createWorkspace(app.db);
  const sessionId = await newSession(workspaceId);
  await selectSessionModel(app.db, { workspaceId, sessionId, commandId: randomUUID(),
    requestedModel: 'gpt-default', env: DEFAULT_ENV });
  await createRepositories(app.db).assist.insertMessage({ id: randomUUID(), sessionId,
    seq: 1n, role: 'ASSISTANT', status: 'PENDING', intent: 'DISCUSS', content: null, sources: [] });
  await expectDomainCode(() => selectSessionModel(app.db, { workspaceId, sessionId,
    commandId: randomUUID(), requestedModel: 'gpt-default', env: DEFAULT_ENV }),
  'INVALID_TRANSITION');
});

test('消息受理冻结当前 OpenRouter 候选序列，首条消息可用 selection revision 拒绝竞态', async () => {
  const workspaceId = await createWorkspace(app.db);
  const sessionId = await newSession(workspaceId, '冻结候选测试');
  await seedCatalog('7', [['free-c', true], ['free-a', true], ['free-b', true],
    ['free-d', true], ['paid-z', false]]);
  const env = { ...FAKE_ENV, RELAY_OPENROUTER_API_KEY: 'isolated-openrouter-key' } as NodeJS.ProcessEnv;
  const selected = await selectSessionModel(app.db, { workspaceId, sessionId,
    commandId: randomUUID(), requestedModel: 'free-c', env });
  const raced = await selectSessionModel(app.db, { workspaceId, sessionId,
    commandId: randomUUID(), requestedModel: 'free-c', env });
  assert.equal(selected.result.revision, '1');
  assert.equal(raced.result.revision, '2');

  await expectDomainCode(() => requestAssistMessage(app.db, { workspaceId, sessionId,
    commandId: randomUUID(), content: '首条消息', expectedModelSelectionRevision: '1' }, env),
  'MODEL_SELECTION_REVISION_CONFLICT');
  const accepted = await requestAssistMessage(app.db, { workspaceId, sessionId,
    commandId: randomUUID(), content: '首条消息', expectedModelSelectionRevision: '2' }, env);
  const assistant = await createRepositories(app.db).assist.readMessage(
    accepted.result.assistant_message_id);
  assert.equal(assistant?.status, 'PENDING');
  const snapshot = assistant?.model_selection_snapshot;
  assert.ok(snapshot);
  const candidates = snapshot.candidates;
  assert.ok(Array.isArray(candidates));
  assert.equal((candidates[0] as { free_only: boolean }).free_only, true);
  assert.deepEqual(candidates.map((entry) => (entry as { connection: { model: string } })
    .connection.model), ['free-c', 'free-a', 'free-b']);
  assert.equal(snapshot.max_attempts, 3);
  assert.equal(snapshot.policy_version, 'openrouter-free-fallback-v1');
  assert.deepEqual(assistant?.model_attempt_state, { revision: '1', current_candidate_index: 0,
    switch_count: 0, switches: [], active_call_id: null, active_candidate_index: null,
    active_turn_id: null, completed_turn_id: null, completed_call_id: null,
    last_failure: null, status: 'READY' });
  assert.equal((await createRepositories(app.db).assist.readMessage(
    accepted.result.user_message_id))?.model_selection_snapshot, null);
  await sql`delete from model_catalog_entries`.execute(app.db);
});

test('消息受理冻结无会话覆盖时的真实默认配置，Fake 路径继续兼容旧快照空值', async () => {
  const workspaceId = await createWorkspace(app.db);
  const configuredSession = await newSession(workspaceId, '默认模型冻结');
  const accepted = await requestAssistMessage(app.db, { workspaceId,
    sessionId: configuredSession, commandId: randomUUID(), content: '冻结默认模型' }, DEFAULT_ENV);
  const message = await createRepositories(app.db).assist.readMessage(accepted.result.assistant_message_id);
  const snapshot = message?.model_selection_snapshot;
  assert.ok(snapshot);
  const candidates = snapshot.candidates;
  assert.ok(Array.isArray(candidates));
  assert.equal((candidates[0] as { connection: { provider: string; model: string } })
    .connection.provider, 'openai-compatible');
  assert.equal((candidates[0] as { connection: { model: string } }).connection.model, 'gpt-default');

  const fakeSession = await newSession(workspaceId, 'Fake兼容');
  const fake = await requestAssistMessage(app.db, { workspaceId, sessionId: fakeSession,
    commandId: randomUUID(), content: 'Fake默认兼容' }, FAKE_ENV);
  const fakeMessage = await createRepositories(app.db).assist.readMessage(fake.result.assistant_message_id);
  assert.equal(fakeMessage?.model_selection_snapshot, null);
  assert.equal(fakeMessage?.model_attempt_state, null);
});

test('免费模型选择与图片附件在消息受理同一事务内拒绝，不泄漏到原图像路径', async () => {
  const workspaceId = await createWorkspace(app.db);
  const sessionId = await newSession(workspaceId, '免费附件拒绝');
  await seedCatalog('8', [['free-image-test', true]]);
  const env = { ...FAKE_ENV, RELAY_OPENROUTER_API_KEY: 'isolated-openrouter-key' } as NodeJS.ProcessEnv;
  await selectSessionModel(app.db, { workspaceId, sessionId, commandId: randomUUID(),
    requestedModel: 'free-image-test', env });
  const attachmentId = randomUUID();
  const bytes = Buffer.from('png');
  await createRepositories(app.db).assist.insertAttachment({ id: attachmentId, workspaceId, sessionId,
    name: 'test.png', mediaType: 'image/png', content: bytes,
    contentHash: createHash('sha256').update(bytes).digest() });
  await expectDomainCode(() => requestAssistMessage(app.db, { workspaceId, sessionId,
    commandId: randomUUID(), content: '请看图片', attachmentIds: [attachmentId] }, env),
  'INVALID_TRANSITION');
  const row = await createRepositories(app.db).assist.readAttachment(attachmentId, workspaceId, sessionId);
  assert.equal(row?.message_id, null);
  await sql`delete from model_catalog_entries`.execute(app.db);
});

test('已归档会话不能选择：INVALID_TRANSITION，事务回滚不留回执', async () => {
  const workspaceId = await createWorkspace(app.db);
  const sessionId = await newSession(workspaceId);
  await sql`update assist_sessions set status = 'ARCHIVED' where id = ${sessionId}`.execute(app.db);
  const commandId = randomUUID();
  await expectDomainCode(() => selectSessionModel(app.db, {
    workspaceId, sessionId, commandId, requestedModel: 'gpt-default', env: DEFAULT_ENV }),
  'INVALID_TRANSITION');
  assert.equal(await receiptsFor(commandId), 0);
  assert.equal(await selectionRowCount(sessionId), 0);
});

test('迁移 0089 CHECK 拦截半截/矛盾写入：免费必带完整目录依据，非 openrouter 连接不得带目录来源', async () => {
  const workspaceId = await createWorkspace(app.db);
  const sessionId = await newSession(workspaceId);
  const fingerprint = 'b'.repeat(64);
  // free_only=true 却缺目录依据（catalog_source null）→ 违反 coupling CHECK。
  await expectSqlState('23514', '免费却无目录依据', () => sql`
    insert into session_model_selection
      (session_id, connection, model, config_fingerprint, free_only, catalog_source,
       catalog_snapshot_seq, catalog_model_id, revision, selected_by_command_id, updated_at)
    values (${sessionId}, 'openrouter', 'free-a', ${fingerprint}, true, null, null, null, 1,
      ${randomUUID()}::uuid, now())`.execute(app.db));
  // 目录依据三列不同现同缺（有 source 无 seq）→ 违反 co-null CHECK。
  await expectSqlState('23514', '目录依据半截', () => sql`
    insert into session_model_selection
      (session_id, connection, model, config_fingerprint, free_only, catalog_source,
       catalog_snapshot_seq, catalog_model_id, revision, selected_by_command_id, updated_at)
    values (${sessionId}, 'openrouter', 'free-a', ${fingerprint}, true, 'openrouter', null,
      'free-a', 1, ${randomUUID()}::uuid, now())`.execute(app.db));
  // default 连接却带 openrouter 目录来源 → 违反 connection 分支 CHECK。
  await expectSqlState('23514', '默认连接混目录来源', () => sql`
    insert into session_model_selection
      (session_id, connection, model, config_fingerprint, free_only, catalog_source,
       catalog_snapshot_seq, catalog_model_id, revision, selected_by_command_id, updated_at)
    values (${sessionId}, 'default', 'gpt-default', ${fingerprint}, false, 'openrouter', 1,
      'free-a', 1, ${randomUUID()}::uuid, now())`.execute(app.db));
  // openrouter 连接却没有任何目录依据（独立反例的镜像）→ 违反 0095 的反向 CHECK。
  // free_only=false 也要拒：来源依据是「这次选择依据哪份事实」的凭据，与是否仅免费无关。
  await expectSqlState('23514', 'OpenRouter 连接缺目录来源', () => sql`
    insert into session_model_selection
      (session_id, connection, model, config_fingerprint, free_only, catalog_source,
       catalog_snapshot_seq, catalog_model_id, revision, selected_by_command_id, updated_at)
    values (${sessionId}, 'openrouter', 'free-a', ${fingerprint}, false, null, null, null, 1,
      ${randomUUID()}::uuid, now())`.execute(app.db));
  // 只有 source、缺 seq/model 的半截依据 → 同样被 0095 拒（不依赖 co-null 兜底也能拦住）。
  await expectSqlState('23514', 'OpenRouter 连接半截来源', () => sql`
    insert into session_model_selection
      (session_id, connection, model, config_fingerprint, free_only, catalog_source,
       catalog_snapshot_seq, catalog_model_id, revision, selected_by_command_id, updated_at)
    values (${sessionId}, 'openrouter', 'free-a', ${fingerprint}, true, 'openrouter', 1,
      null, 1, ${randomUUID()}::uuid, now())`.execute(app.db));
  assert.equal(await selectionRowCount(sessionId), 0);
});

test('迁移 0094/0095 不误伤合法组合：default 无来源可用，openrouter 带完整依据可用（与是否免费无关）', async () => {
  const workspaceId = await createWorkspace(app.db);
  const fingerprint = 'c'.repeat(64);
  // 每个合法组合用**独立会话**验证：应用角色没有 DELETE（0089 只授 SELECT/INSERT/UPDATE），
  // 测试同样不能用 DELETE 清行——那本身就说明「删除用户选择」不是可用手段。
  const insertOn = async (sessionId: string, connection: 'default' | 'openrouter',
    model: string, freeOnly: boolean): Promise<void> => {
    await sql`
      insert into session_model_selection
        (session_id, connection, model, config_fingerprint, free_only, catalog_source,
         catalog_snapshot_seq, catalog_model_id, revision, selected_by_command_id, updated_at)
      values (${sessionId}, ${connection}, ${model}, ${fingerprint}, ${freeOnly},
        ${connection === 'openrouter' ? 'openrouter' : null},
        ${connection === 'openrouter' ? 7 : null},
        ${connection === 'openrouter' ? model : null}, 1, ${randomUUID()}::uuid, now())`
      .execute(app.db);
  };

  // default 无来源（合法「沿用默认」）：0094/0095 都不得拦。
  await insertOn(await newSession(workspaceId), 'default', 'gpt-default', false);
  // openrouter 带完整依据、free_only=false：0095 不应只认「免费」这一种来源用法。
  await insertOn(await newSession(workspaceId), 'openrouter', 'free-a', false);
  // openrouter 带完整依据、free_only=true：常规免费选择。
  await insertOn(await newSession(workspaceId), 'openrouter', 'free-a', true);
});
