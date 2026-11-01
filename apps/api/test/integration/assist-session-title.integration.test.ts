import assert from 'assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';

import { sql } from 'kysely';

import { createAssistSession } from '../../src/application/assist-commands.js';
import {
  archiveAssistSession,
  deleteAssistSession,
  regenerateAssistSessionTitle,
  renameAssistSession,
} from '../../src/application/assist-session-controls.js';
import { DomainError } from '../../src/application/domain-error.js';
import {
  enqueueSessionTitleAfterTurn,
  runSessionTitleGenerationTick,
} from '../../src/application/session-title-generation.js';
import { createRepositories, withTransaction } from '../../src/application/unit-of-work.js';
import type { AssistSessionRow, AssistTitleGenerationRow } from '../../src/infrastructure/database-schema.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { toDecimalString } from '../../src/shared/decimal.js';
import { FakeModelPort } from '../../src/workflow/fake-model-port.js';
import {
  createDataRoot, expectCommandAccepted, startTestApi, workspacePath,
  type TestApi,
} from './api-harness.js';
import {
  APP_DATABASE_URL, MIGRATIONS_DIRECTORY, MIGRATION_DATABASE_URL, openDatabase,
} from './integration-support.js';

/**
 * 会话标题自动生成的真实 PostgreSQL 集成（0157，2026-11-01 SESSION_AUTO_TITLE）。
 *
 * 单测能证明格式与规则，**这里只取证依赖事务、行锁、CAS 与账本的部分**：
 *   * 创建声明 PROVISIONAL 时由服务端派生结构化临时标题；显式标题按 USER_DEFINED 保护；
 *   * 首轮结算后入队，后台 tick 用受控模型落标题，消息终态与主回复不受影响；
 *   * 手动改名后，迟到的模型结果停在 SKIPPED，不能覆盖；请求行保留可核对身份；
 *   * 显式重新生成可以替换 USER_DEFINED，但仍是 command_id 幂等 + expected_revision CAS；
 *   * 没有模型 / 输出非法时 AUTO 降级为规则标题；显式重新生成失败并保留原标题；
 *   * 旧会话（LEGACY）不被自动改名；归档会话拒绝重新生成；
 *   * 标题辅助调用进 `model_calls`，但 purpose=TITLE 不抢 PRIMARY 的「最近一次调用」读数。
 *
 * 不取证：真实 Provider、Windows/WebView2、界面观感。模型由 FakeModelPort 的触发串控制。
 */

const app = openDatabase(APP_DATABASE_URL, 'relay-assist-session-title-test');
let api: TestApi;

before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
  await createDataRoot();
  api = await startTestApi();
});
after(async () => { await api.stop(); await app.close(); });

async function newWorkspace(tag: string): Promise<string> {
  const workspaceId = randomUUID();
  await withTransaction(app.db, async (repositories) => {
    await repositories.workspaces.insertWorkspace({ id: workspaceId, name: `session-title-${tag}` });
    await repositories.workspaces.insertAuthorityRow(workspaceId);
  });
  return workspaceId;
}

async function newSession(workspaceId: string, title: string,
  titleSource: 'PROVISIONAL' | 'USER_DEFINED' = 'PROVISIONAL'): Promise<string> {
  const created = await createAssistSession(app.db, {
    workspaceId, commandId: randomUUID(), projectId: null, title, titleSource,
  });
  return created.result.session_id;
}

async function readSession(sessionId: string): Promise<AssistSessionRow> {
  const row = await createRepositories(app.db).assist.readSession(sessionId);
  assert.ok(row !== undefined, `会话 ${sessionId} 读不回来`);
  return row;
}

async function readJob(sessionId: string): Promise<AssistTitleGenerationRow> {
  const row = (await sql<AssistTitleGenerationRow>`select * from assist_title_generations
    where session_id = ${sessionId} order by requested_at desc limit 1`.execute(app.db)).rows[0];
  assert.ok(row !== undefined, `会话 ${sessionId} 没有标题生成请求`);
  return row;
}

/** 播种一轮已完成对话：用户消息在前、助手回复在后，两者都是可命名的有效正文。 */
async function seedTurn(sessionId: string, userContent: string, assistantContent: string):
Promise<{ readonly userId: string; readonly assistantId: string }> {
  const current = (await sql<{ s: number }>`select coalesce(max(seq), 0)::int as s
    from assist_messages where session_id = ${sessionId}`.execute(app.db)).rows[0]!.s;
  const userId = randomUUID();
  const assistantId = randomUUID();
  await sql`insert into assist_messages (id, session_id, seq, role, status, intent, content)
    values (${userId}, ${sessionId}, ${current + 1}, 'USER', 'COMPLETED', 'DISCUSS',
      ${userContent})`.execute(app.db);
  await sql`insert into assist_messages (id, session_id, seq, role, status, intent, content)
    values (${assistantId}, ${sessionId}, ${current + 2}, 'ASSISTANT', 'COMPLETED', 'DISCUSS',
      ${assistantContent})`.execute(app.db);
  return { userId, assistantId };
}

async function expectDomainCode(work: () => Promise<unknown>, code: string): Promise<void> {
  try { await work(); } catch (error) {
    if (error instanceof DomainError) { assert.equal(error.code, code); return; }
    throw new Error(`期望抛出的 DomainError ${code}，实际：${String(error)}`);
  }
  throw new Error(`期望抛出的 DomainError ${code} 没有出现`);
}

test('创建：只有声明 PROVISIONAL 才由服务端派生结构化临时标题，显式标题按用户来源保护', async () => {
  const workspaceId = await newWorkspace('create');
  const provisional = await createAssistSession(app.db, {
    workspaceId, commandId: randomUUID(), projectId: null, titleSource: 'PROVISIONAL',
    title: '现在聊天界面的消息宽度不一致，而且布局有点乱，帮我优化一下。',
  });
  assert.match(provisional.result.title, /^UI-/u,
    `临时标题应当是结构化分类，实际：${provisional.result.title}`);
  const provisionalRow = await readSession(provisional.result.session_id);
  assert.equal(provisionalRow.title_source, 'PROVISIONAL');
  assert.equal(provisionalRow.title, provisional.result.title);

  const explicit = await createAssistSession(app.db, {
    workspaceId, commandId: randomUUID(), projectId: null, title: '我自己的会话标题',
  });
  assert.equal(explicit.result.title, '我自己的会话标题',
    '未声明 PROVISIONAL 的调用方显式给了名字，服务端不得改写');
  assert.equal((await readSession(explicit.result.session_id)).title_source, 'USER_DEFINED');
});

test('自动命名：首轮完成后入队，受控模型结果经校验落库；TITLE 调用不抢 PRIMARY 读数', async () => {
  const workspaceId = await newWorkspace('model');
  const sessionId = await newSession(workspaceId,
    '现在聊天界面的消息宽度不一致，FAKE_TITLE_UI 帮我优化布局');
  const turn = await seedTurn(sessionId,
    '现在聊天界面的消息宽度不一致，FAKE_TITLE_UI 帮我优化布局',
    '已把消息宽度与布局统一。');
  const primaryCallId = randomUUID();
  await sql`insert into model_calls (id, workspace_id, kind, assist_message_id,
      provider, model, config_fingerprint, status, usage_input_tokens, usage_output_tokens,
      purpose, started_at, settled_at)
    values (${primaryCallId}, ${workspaceId}, 'ASSIST', ${turn.assistantId},
      'fake', 'fake', ${'a'.repeat(64)}, 'COMPLETED', 1_200, 80, 'PRIMARY',
      now() - interval '10 seconds', now() - interval '9 seconds')`.execute(app.db);

  assert.equal(await enqueueSessionTitleAfterTurn(app.db, { sessionId,
    assistantMessageId: turn.assistantId }), true, '首轮结算后应当入队一次 AUTO 请求');
  assert.equal((await readJob(sessionId)).status, 'PENDING');

  const outcome = await runSessionTitleGenerationTick(app.db, {
    workerId: 'test:title-model', modelPort: new FakeModelPort() });
  assert.equal(outcome?.result, 'MODEL_APPLIED');

  const row = await readSession(sessionId);
  assert.equal(row.title, 'UI-聊天消息布局优化');
  assert.equal(row.title_source, 'AI_GENERATED');
  assert.ok(row.title_generated_at !== null);

  const job = await readJob(sessionId);
  assert.equal(job.status, 'COMPLETED');
  assert.equal(job.generator, 'MODEL');
  assert.equal(job.result_title, 'UI-聊天消息布局优化');

  // 辅助外呼确实进账本，但「最近一次调用」仍只读 PRIMARY。
  const titleCall = (await sql<{ status: string; purpose: string }>`select status, purpose
    from model_calls where assist_message_id = ${turn.assistantId} and purpose = 'TITLE'`
    .execute(app.db)).rows[0];
  assert.equal(titleCall?.status, 'COMPLETED');
  assert.equal(titleCall?.purpose, 'TITLE');
  const latest = await createRepositories(app.db).assist.latestContextUsageCall(sessionId);
  assert.equal(latest?.id, primaryCallId,
    '标题生成不是面向用户的回复，不能抢走「最近一次调用」读数');

  // 标题是会话事实，不改消息终态与正文。
  const assistant = await createRepositories(app.db).assist.readMessage(turn.assistantId);
  assert.equal(assistant?.status, 'COMPLETED');
  assert.equal(assistant?.content, '已把消息宽度与布局统一。');
});

test('并发保护：手动改名后迟到的生成结果停在 SKIPPED，标题与来源保持用户值', async () => {
  const workspaceId = await newWorkspace('late');
  const sessionId = await newSession(workspaceId, '修复登录报错 FAKE_TITLE_FIX');
  const turn = await seedTurn(sessionId, '登录接口报错，FAKE_TITLE_FIX 帮我修复', '已定位到超时。');
  await enqueueSessionTitleAfterTurn(app.db, { sessionId,
    assistantMessageId: turn.assistantId });
  const claimed = await withTransaction(app.db, (tx) => tx.titleGenerations.claim({
    workerId: 'test:late', leaseMs: 60_000, now: new Date() }));
  assert.ok(claimed !== undefined);

  const before = await readSession(sessionId);
  const renamed = await renameAssistSession(app.db, {
    workspaceId, sessionId, commandId: randomUUID(),
    expectedRevision: toDecimalString(before.revision), title: '我的标题' });
  assert.equal(renamed.result.title, '我的标题');

  const applied = await withTransaction(app.db, (tx) => tx.titleGenerations.apply({
    job: claimed.job, attemptsAtClaim: claimed.attemptsAtClaim, workerId: 'test:late',
    title: '修复-模型调用超时', titleSource: 'AI_GENERATED', generator: 'MODEL',
    now: new Date() }));
  assert.equal(applied.applied, false);
  assert.equal(applied.reason, 'SUPERSEDED');

  const row = await readSession(sessionId);
  assert.equal(row.title, '我的标题', '迟到的模型结果不能覆盖用户刚设置的名字');
  assert.equal(row.title_source, 'USER_DEFINED');
  const job = await readJob(sessionId);
  assert.equal(job.status, 'SKIPPED');
  assert.equal(job.error_code, 'TITLE_SUPERSEDED');
});

test('显式重新生成：可替换手动标题，但回执只代表受理，落库仍走同一套 CAS', async () => {
  const workspaceId = await newWorkspace('regenerate');
  const sessionId = await newSession(workspaceId, '手动命名的讨论', 'USER_DEFINED');
  await seedTurn(sessionId, '模型调用总是超时，FAKE_TITLE_FIX 请修复', '已调整超时设置。');
  const renamed = await renameAssistSession(app.db, {
    workspaceId, sessionId, commandId: randomUUID(), expectedRevision: '0', title: '我的标题' });
  const commandId = randomUUID();
  const response = await api.post(workspacePath(workspaceId,
    `/assist-sessions/${sessionId}/title/generate`),
  { command_id: commandId, expected_revision: renamed.result.revision });
  const result = expectCommandAccepted(response, 200, commandId) as
    { session_id: string; request_id: string; status: string; revision: string };
  assert.equal(result.session_id, sessionId);
  assert.equal(result.status, 'PENDING', '受理回执不能宣称标题已更新');

  const readBack = await api.get(workspacePath(workspaceId, `/assist-sessions/${sessionId}`));
  const dto = readBack.body as { title: string; title_source: string;
    title_generation: { status: string; request_kind: string } | null };
  assert.equal(dto.title, '我的标题');
  assert.equal(dto.title_source, 'USER_DEFINED');
  assert.equal(dto.title_generation?.status, 'PENDING');
  assert.equal(dto.title_generation?.request_kind, 'REGENERATE');

  const outcome = await runSessionTitleGenerationTick(app.db, {
    workerId: 'test:title-regen', modelPort: new FakeModelPort() });
  assert.equal(outcome?.result, 'MODEL_APPLIED');
  const row = await readSession(sessionId);
  assert.equal(row.title, '修复-模型调用超时修复');
  assert.equal(row.title_source, 'AI_GENERATED');
  // 同一 command_id 重放：回执返回同一条请求，不新建第二条。
  const replay = await api.post(workspacePath(workspaceId,
    `/assist-sessions/${sessionId}/title/generate`),
  { command_id: commandId, expected_revision: renamed.result.revision });
  assert.equal((replay.body as { result: { request_id: string } }).result.request_id, result.request_id);
  const jobs = (await sql<{ c: string }>`select count(*)::text as c from assist_title_generations
    where session_id = ${sessionId}`.execute(app.db)).rows[0]!;
  assert.equal(Number(jobs.c), 1, '同一命令重放不能产生第二条请求');
});

test('降级：没有模型或模型输出非法时，AUTO 落规则标题并保持 PROVISIONAL', async () => {
  const workspaceId = await newWorkspace('fallback');
  const first = await newSession(workspaceId, '聊天界面布局需要调整');
  const firstTurn = await seedTurn(first, '聊天界面布局需要调整', '已按统一宽度重排。');
  await enqueueSessionTitleAfterTurn(app.db, { sessionId: first,
    assistantMessageId: firstTurn.assistantId });
  const noModel = await runSessionTitleGenerationTick(app.db, { workerId: 'test:title-rules' });
  assert.equal(noModel?.result, 'RULES_APPLIED');
  const firstRow = await readSession(first);
  assert.match(firstRow.title, /^UI-/u);
  assert.equal(firstRow.title_source, 'PROVISIONAL');
  const firstJob = await readJob(first);
  assert.equal(firstJob.generator, 'RULES');

  const second = await newSession(workspaceId, '修复模型调用超时 FAKE_TITLE_INVALID_JSON');
  const secondTurn = await seedTurn(second, '修复模型调用超时 FAKE_TITLE_INVALID_JSON', '在处理。');
  await enqueueSessionTitleAfterTurn(app.db, { sessionId: second,
    assistantMessageId: secondTurn.assistantId });
  const invalid = await runSessionTitleGenerationTick(app.db, {
    workerId: 'test:title-invalid', modelPort: new FakeModelPort() });
  assert.equal(invalid?.result, 'RULES_APPLIED', '非法 JSON 不能落库，改用规则标题');
  const secondRow = await readSession(second);
  assert.match(secondRow.title, /^修复-/u);
  assert.equal(secondRow.title_source, 'PROVISIONAL');
});

test('保护边界：旧会话 LEGACY 不被自动改名；归档会话拒绝重新生成', async () => {
  const workspaceId = await newWorkspace('protected');
  const legacyId = randomUUID();
  await createRepositories(app.db).assist.insertSession({ id: legacyId, workspaceId,
    projectId: null, taskId: null, title: '旧版本的标题' });
  const legacyTurn = await seedTurn(legacyId, '把页面布局调整一下', '已调整。');
  assert.equal(await enqueueSessionTitleAfterTurn(app.db, { sessionId: legacyId,
    assistantMessageId: legacyTurn.assistantId }), false,
  '来源不明或显式保护的标题不能进入自动命名队列');
  const legacyRow = await readSession(legacyId);
  assert.equal(legacyRow.title, '旧版本的标题');
  assert.equal(legacyRow.title_source, 'LEGACY');

  const archived = await newSession(workspaceId, '还没归档的讨论', 'USER_DEFINED');
  await seedTurn(archived, '随便聊两句', '好的。');
  await archiveAssistSession(app.db, { workspaceId, sessionId: archived,
    commandId: randomUUID(), expectedRevision: '0' });
  await expectDomainCode(() => regenerateAssistSessionTitle(app.db, { workspaceId,
    sessionId: archived, commandId: randomUUID(), expectedRevision: '1' }), 'INVALID_TRANSITION');
});

test('显式重新生成在没有模型时如实失败并保留手动标题', async () => {
  const workspaceId = await newWorkspace('regen-fail');
  const sessionId = await newSession(workspaceId, '我的标题', 'USER_DEFINED');
  await seedTurn(sessionId, '帮我优化一下界面', '已改。');
  await regenerateAssistSessionTitle(app.db, { workspaceId, sessionId,
    commandId: randomUUID(), expectedRevision: '0' });
  const base = new Date();
  const first = await runSessionTitleGenerationTick(app.db, {
    workerId: 'test:title-fail', now: base });
  assert.equal(first?.result, 'RETRIED', '第一次失败仍有退避重试');
  const second = await runSessionTitleGenerationTick(app.db, {
    workerId: 'test:title-fail', now: new Date(base.getTime() + 10_000) });
  assert.equal(second?.result, 'FAILED');
  const row = await readSession(sessionId);
  assert.equal(row.title, '我的标题', '没有模型时不能用规则标题覆盖手动命名');
  assert.equal(row.title_source, 'USER_DEFINED');
  assert.equal((await readJob(sessionId)).error_code, 'TITLE_MODEL_UNAVAILABLE');
});

test('删除会话级联删除标题请求：新账本没有把删除路径重新堵上', async () => {
  const workspaceId = await newWorkspace('cascade');
  const sessionId = await newSession(workspaceId, '准备删除的讨论');
  const turn = await seedTurn(sessionId, '这条讨论不用命名', '好的。');
  await enqueueSessionTitleAfterTurn(app.db, { sessionId,
    assistantMessageId: turn.assistantId });
  assert.equal((await readJob(sessionId)).status, 'PENDING');
  const row = await readSession(sessionId);
  await deleteAssistSession(app.db, { workspaceId, sessionId, commandId: randomUUID(),
    expectedRevision: toDecimalString(row.revision) });
  const left = (await sql<{ c: string }>`select count(*)::text as c from assist_title_generations
    where session_id = ${sessionId}`.execute(app.db)).rows[0]!;
  assert.equal(Number(left.c), 0);
});
