import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import test, { after, before, beforeEach } from 'node:test';
import { sql } from 'kysely';
import { createAssistSession, requestAssistMessage, setSessionContextBudget }
  from '../../src/application/assist-commands.js';
import { runAssistGenerationTick } from '../../src/application/assist-runner.js';
import { runAssistMemoryTick } from '../../src/application/assist-memory-runner.js';
import { readSessionContextUsage } from '../../src/application/assist-context-projection.js';
import { EXTRACTION_SYSTEM } from '../../src/application/memory-auto-capture.js';
import { readMemorySettings, setMemorySettings } from '../../src/application/memory-settings.js';
import { createRepositories, withTransaction } from '../../src/application/unit-of-work.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { ManagedContentStore } from '../../src/storage/managed-content-store.js';
import { FakeModelPort, type AssistRequest } from '../../src/workflow/fake-model-port.js';
import type { JsonValue } from '../../src/infrastructure/json.js';
import { APP_DATABASE_URL, MIGRATION_DATABASE_URL, MIGRATIONS_DIRECTORY, openDatabase }
  from './integration-support.js';

/**
 * 0162：自动压缩的 token 阈值与溢出保护（真实 PostgreSQL）。
 *
 * 这里的「当前上下文」不是字符串长度：测试替身在每次 PRIMARY 调用上**上报确定的
 * input_tokens**（10 万 / 21 万 / 35 万…），服务端的基线读数、阈值判定、投影与日志
 * 全部读这同一份数字。因此断言的是真实判定路径，不是「造一段很长的文本碰运气」。
 *
 * 覆盖：
 *   · 低于阈值不触发；达到阈值自动触发并把原消息重排队后执行完；
 *   · 用户自定义阈值（低于/高于默认）生效；
 *   · 关闭普通自动压缩后，到阈值不压、但安全上限仍触发溢出保护；
 *   · 设置持久化：只改开关不会清空已保存阈值；恢复默认写回 NULL；
 *   · 用量投影给出模型窗口/生效阈值/距离/最近结果，界面不必自己算。
 */

const app = openDatabase(APP_DATABASE_URL, 'relay-context-compaction');
let root: string;
let storage: ManagedContentStore;
before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
  root = await mkdtemp(join(tmpdir(), 'relay-context-compaction-data-'));
  storage = new ManagedContentStore(root);
});
/*
 * 这个套件只走应用层（`runAssistGenerationTick` / `runAssistMemoryTick`），不经过 HTTP，
 * 因此**不启动测试 API 进程**：那会多一个后台调度器与用例竞争「全库领取」的消息。
 */
after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
/*
 * 用例之间共享同一个数据库，而记忆整理/压缩是**全库领取**的：前一个用例留下的
 * PENDING 请求会被下一个用例的 generation tick 先领走，表现为「明明没发消息却返回
 * undefined」。这里在每个用例开始前把残留请求跑完，保证失败归因指向本用例。
 */
beforeEach(async () => {
  for (let round = 0; round < 8; round++) {
    const drained = await runAssistMemoryTick(app.db, { workerId: randomUUID(), leaseMs: 60_000,
      storage, modelPort: new FakeModelPort() });
    if (drained === undefined) break;
  }
  // 领取是**全库**的：上一个用例断言失败会留下 PENDING 消息，下一个用例的 tick 会先领它，
  // 于是「自己的消息没被处理」被误读成业务缺陷。用例之间先把残留 ROW 收口掉。
  await sql`update assist_messages set status = 'CANCELLED', content = null,
    cancel_requested = true where status in ('PENDING', 'RUNNING')`.execute(app.db);
});

const MIB = 1_048_576;

async function fixture(rounds = 9, tier = 262_144) {
  const workspaceId = randomUUID();
  await withTransaction(app.db, async (r) => {
    await r.workspaces.insertWorkspace({ id: workspaceId, name: 'context-compaction' });
    await r.workspaces.insertAuthorityRow(workspaceId);
  });
  const made = await createAssistSession(app.db, { workspaceId, projectId: null,
    commandId: randomUUID(), title: 'context-compaction' });
  const sessionId = made.result.session_id;
  await setSessionContextBudget(app.db, { workspaceId, sessionId, commandId: randomUUID(),
    expectedRevision: '0', budgetTokens: tier });
  await withTransaction(app.db, async (r) => {
    for (let i = 1; i <= rounds * 2; i++) {
      await r.assist.insertMessage({ id: randomUUID(), sessionId, seq: BigInt(i),
        role: i % 2 === 1 ? 'USER' : 'ASSISTANT', status: 'COMPLETED', intent: 'DISCUSS',
        content: `原对话第 ${i} 条，保留为压缩候选。`, sources: [] });
    }
  });
  return { workspaceId, sessionId };
}

/** 质量门要求固定分段；这里给全 11 段，与提示词一致。 */
function structuredSummary(marker: string): string {
  return ['【当前目标与范围】' + marker, '【有效约束与偏好】无', '【项目约束】无',
    '【已确认决策】无', '【已完成工作与已修改文件】无', '【已验证进展与证据】无',
    '【未完成事项与下一步】继续当前任务', '【未决问题、失败与 UNKNOWN】无',
    '【当前执行状态】对话继续中', '【被替代或已撤回的要求】无',
    '【来源】integration fixture'].join('\n');
}

/**
 * 模型替身：PRIMARY 上报一个确定的输入量，压缩请求返回结构化摘要。
 * `usage.inputTokens` 就是被测的「真实基线」，不是按正文长度估出来的。
 */
function port(primaryInputTokens: number, options: {
  readonly summary?: string; readonly badSummary?: boolean } = {}) {
  const model = new FakeModelPort();
  const inputs: AssistRequest[] = [];
  model.assist = async (input) => {
    inputs.push(input);
    if (input.system.includes('MEMORY_COMPACTION_V1')) {
      return { kind: 'CONTENT', content: options.badSummary === true ? 'not-json'
        : JSON.stringify({ summary: structuredSummary(options.summary ?? '压缩后的接续要点') }),
      providerRequestId: randomUUID(), usage: { inputTokens: 40, outputTokens: 20 } };
    }
    return { kind: 'CONTENT', content: '收到，继续。', providerRequestId: randomUUID(),
      usage: { inputTokens: primaryInputTokens, outputTokens: 10 } };
  };
  return { model, inputs, options: { workerId: randomUUID(), leaseMs: 60_000, storage, modelPort: model } };
}

/**
 * 主模型生成调用：排除压缩与长期记忆提取。
 *
 * 三者共用同一个端口（`options.modelPort`），所以 `inputs.length` 会把「本轮生成了一次」
 * 和「同一轮要不要记忆提取」混在一起。用例要断言的是「压缩前有没有先调主模型」，
 * 因此按系统提示词身份过滤，而不是数字符串长度。
 */
function primaryCalls(p: { readonly inputs: readonly AssistRequest[] }): readonly AssistRequest[] {
  return p.inputs.filter((input) => !input.system.includes('MEMORY_COMPACTION_V1') &&
    input.system !== EXTRACTION_SYSTEM);
}

async function send(session: { readonly workspaceId: string; readonly sessionId: string },
  content: string) {
  return requestAssistMessage(app.db, { ...session, commandId: randomUUID(), content });
}

async function requests(sessionId: string) {
  return createRepositories(app.db).assistMemory.requests(sessionId);
}

/** 请求行上的压缩审计字段（`model_snapshot.memory_compaction`）；旧行没有则为空对象。 */
function compactionMeta(request: { readonly model_snapshot: Record<string, JsonValue> } | undefined) {
  const raw = request?.model_snapshot.memory_compaction;
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? raw as Record<string, JsonValue> : {};
}

test('低于生效阈值时不触发自动压缩，消息照常完成', async () => {
  const f = await fixture(9, MIB);
  // 1M 档位、1M 目标窗口：默认阈值 350K。
  const first = port(100_000);
  await send(f, '第一轮');
  assert.equal((await runAssistGenerationTick(app.db, first.options))?.status, 'COMPLETED');

  const second = port(100_000);
  await send(f, '第二轮');
  assert.equal((await runAssistGenerationTick(app.db, second.options))?.status, 'COMPLETED');
  assert.equal(primaryCalls(second).length, 1, '阈值以下不应先压缩再调用');
  assert.equal((await requests(f.sessionId)).length, 0);
});

test('达到 350K 自动压缩：原消息重排队、压缩完成后继续执行', async () => {
  const f = await fixture(9, MIB);
  const first = port(350_000);
  await send(f, '第一轮');
  assert.equal((await runAssistGenerationTick(app.db, first.options))?.status, 'COMPLETED');

  const pending = port(350_000);
  const sent = await send(f, '达到阈值后这一轮');
  assert.equal((await runAssistGenerationTick(app.db, pending.options))?.status, 'DISCARDED');
  assert.equal(pending.inputs.length, 0, '先压缩，不在压缩前调用主模型');
  assert.equal((await createRepositories(app.db).assist
    .readMessage(sent.result.assistant_message_id))?.status, 'PENDING');

  const compaction = port(0);
  assert.equal((await runAssistMemoryTick(app.db, compaction.options))?.status, 'COMPLETED');
  const [request] = await requests(f.sessionId);
  assert.equal(request?.reason, 'AUTO');
  assert.equal(compactionMeta(request).trigger, 'THRESHOLD');
  assert.ok(Number(compactionMeta(request).tokens_before) >= 350_000);
  // 判定时冻结的边界：压后复核要用同一份，不在执行端重新猜一个上限。
  const frozenMeta = compactionMeta(request);
  assert.equal(typeof frozenMeta.safe_input_tokens, 'number');
  assert.equal(frozenMeta.post_compaction_target_tokens, 100_000);
  // 压后读数必须回填：它是「最近一次压缩结果」里压缩前后对照的唯一来源。
  assert.equal(typeof frozenMeta.tokens_after, 'number');
  assert.ok(Number(frozenMeta.tokens_after) < Number(frozenMeta.tokens_before));

  const resumed = port(120_000);
  assert.equal((await runAssistGenerationTick(app.db, resumed.options))?.status, 'COMPLETED');
  assert.equal(primaryCalls(resumed).length, 1);
  assert.ok(primaryCalls(resumed)[0]?.turns.some((turn) => turn.content.includes('压缩后的接续要点')),
    '压缩后的摘要必须进入下一轮输入');
});

test('用户把阈值调到 200K 后按 200K 判定（低于它不压，高于它压）', async () => {
  const below = await fixture(9, MIB);
  await setMemorySettings(app.db, { workspaceId: below.workspaceId, commandId: randomUUID(),
    expectedRevision: '0', recallEnabled: true, automaticCompaction: true, autoCapture: false,
    compactionThresholdTokens: 200_000 });
  const first = port(150_000);
  await send(below, '第一轮');
  assert.equal((await runAssistGenerationTick(app.db, first.options))?.status, 'COMPLETED');
  const second = port(150_000);
  await send(below, '低于 200K');
  assert.equal((await runAssistGenerationTick(app.db, second.options))?.status, 'COMPLETED');
  assert.equal(primaryCalls(second).length, 1);
  assert.equal((await requests(below.sessionId)).length, 0);

  const above = await fixture(9, MIB);
  await setMemorySettings(app.db, { workspaceId: above.workspaceId, commandId: randomUUID(),
    expectedRevision: '0', recallEnabled: true, automaticCompaction: true, autoCapture: false,
    compactionThresholdTokens: 200_000 });
  const baseline = port(210_000);
  await send(above, '第一轮');
  assert.equal((await runAssistGenerationTick(app.db, baseline.options))?.status, 'COMPLETED');
  const triggered = port(210_000);
  await send(above, '高于 200K');
  assert.equal((await runAssistGenerationTick(app.db, triggered.options))?.status, 'DISCARDED');
  const [request] = await requests(above.sessionId);
  assert.equal(compactionMeta(request).trigger, 'THRESHOLD');
  assert.equal(compactionMeta(request).threshold_tokens, 200_000);
});

test('关闭普通自动压缩：到阈值不压，触及安全上限仍触发溢出保护', async () => {
  const f = await fixture(9);
  // 默认 256K 档位：安全输入上限 232652，生效阈值 209386（上限的 90%）。
  await setMemorySettings(app.db, { workspaceId: f.workspaceId, commandId: randomUUID(),
    expectedRevision: '0', recallEnabled: true, automaticCompaction: false, autoCapture: false });

  const below = port(220_000);
  await send(f, '第一轮');
  assert.equal((await runAssistGenerationTick(app.db, below.options))?.status, 'COMPLETED');
  const safe = port(220_000);
  await send(f, '高于阈值但仍在安全上限内');
  assert.equal((await runAssistGenerationTick(app.db, safe.options))?.status, 'COMPLETED');
  assert.equal(primaryCalls(safe).length, 1, '用户关闭自动压缩后，到阈值不应擅自整理');
  assert.equal((await requests(f.sessionId)).length, 0);

  const over = await fixture(9);
  await setMemorySettings(app.db, { workspaceId: over.workspaceId, commandId: randomUUID(),
    expectedRevision: '0', recallEnabled: true, automaticCompaction: false, autoCapture: false });
  const baseline = port(240_000);
  await send(over, '第一轮');
  assert.equal((await runAssistGenerationTick(app.db, baseline.options))?.status, 'COMPLETED');
  const overflow = port(240_000);
  await send(over, '超过安全上限');
  assert.equal((await runAssistGenerationTick(app.db, overflow.options))?.status, 'DISCARDED');
  const [request] = await requests(over.sessionId);
  assert.equal(compactionMeta(request).trigger, 'OVERFLOW');
});

test('阈值设置按整行 CAS 持久化：只改开关不清空阈值，恢复默认写回 NULL', async () => {
  const f = await fixture(2);
  const saved = await setMemorySettings(app.db, { workspaceId: f.workspaceId,
    commandId: randomUUID(), expectedRevision: '0', recallEnabled: true,
    automaticCompaction: true, autoCapture: false, compactionThresholdTokens: 300_000 });
  assert.equal(saved.result.compaction_threshold_tokens, 300_000);
  // 旧客户端（或界面只改开关）不带阈值：保持已保存值，不写回默认。
  const toggled = await setMemorySettings(app.db, { workspaceId: f.workspaceId,
    commandId: randomUUID(), expectedRevision: '1', recallEnabled: false,
    automaticCompaction: true, autoCapture: false });
  assert.equal(toggled.result.compaction_threshold_tokens, 300_000);
  // 恢复默认 = NULL，读取时仍然是 NULL（生效值由策略算 350K）。
  const reset = await setMemorySettings(app.db, { workspaceId: f.workspaceId,
    commandId: randomUUID(), expectedRevision: '2', recallEnabled: false,
    automaticCompaction: true, autoCapture: false, compactionThresholdTokens: null });
  assert.equal(reset.result.compaction_threshold_tokens, null);
  const reread = await readMemorySettings(app.db, f.workspaceId);
  assert.equal(reread.compaction_threshold_tokens, null);
  assert.equal(reread.compaction_threshold_default_tokens, 350_000);
  assert.deepEqual(reread.compaction_threshold_recommended, { min: 256_000, max: 400_000 });
});

test('用量投影把模型窗口、生效阈值、距离与最近一次结果分开给出', async () => {
  const f = await fixture(9);
  await setMemorySettings(app.db, { workspaceId: f.workspaceId, commandId: randomUUID(),
    expectedRevision: '0', recallEnabled: true, automaticCompaction: true, autoCapture: false,
    compactionThresholdTokens: 200_000 });
  const first = port(180_000);
  await send(f, '第一轮');
  assert.equal((await runAssistGenerationTick(app.db, first.options))?.status, 'COMPLETED');

  const projection = await readSessionContextUsage(app.db, f.workspaceId, f.sessionId);
  assert.equal(projection.compaction.threshold_tokens, 200_000);
  assert.equal(projection.compaction.effective_threshold_tokens, 200_000);
  assert.equal(projection.compaction.threshold_clamped, false);
  assert.equal(projection.compaction.window_source, 'SESSION_TIER',
    '没有模型目录条目时不得冒充真实窗口');
  assert.equal(projection.compaction.model_window_tokens, null);
  assert.equal(projection.compaction.target_window_tokens, 262_144);
  // 基线 180000 + 之后新增消息（估算增量），距离阈值约 2 万。
  assert.equal(projection.compaction.context_source, 'PROVIDER_USAGE');
  assert.ok(projection.compaction.context_tokens >= 180_000);
  assert.ok(projection.compaction.distance_tokens > 0);

  // 触发一次自动压缩后，最近结果出现在同一份投影里。
  //
  // 「当前上下文」的基线是**上一次已结算的 PRIMARY 调用**（180K）。下一轮的端口还没被
  // 调用，它报多少都不影响这次判定。因此要让它越线，只能改配置：把阈值下调到 150K，
  // 同一份 180K 基线立刻高于新阈值——这也顺带验证了「阈值改小后立即生效」。
  await setMemorySettings(app.db, { workspaceId: f.workspaceId, commandId: randomUUID(),
    expectedRevision: '1', recallEnabled: true, automaticCompaction: true, autoCapture: false,
    compactionThresholdTokens: 150_000 });
  const high = port(180_000);
  await send(f, '触发压缩');
  assert.equal((await runAssistGenerationTick(app.db, high.options))?.status, 'DISCARDED');
  assert.equal((await runAssistMemoryTick(app.db, port(0).options))?.status, 'COMPLETED');
  const afterCompaction = await readSessionContextUsage(app.db, f.workspaceId, f.sessionId);
  assert.equal(afterCompaction.compaction.active, null);
  assert.equal(afterCompaction.compaction.last_result?.status, 'COMPLETED');
  assert.equal(afterCompaction.compaction.last_result?.trigger, 'THRESHOLD');
  assert.ok((afterCompaction.compaction.last_result?.tokens_before ?? 0) >= 150_000);
  // 「最近一次压缩结果」必须给出压缩前后对照，且压后读数低于压前。
  const tokensAfter = afterCompaction.compaction.last_result?.tokens_after;
  assert.equal(typeof tokensAfter, 'number');
  assert.ok((tokensAfter ?? Infinity) <
    (afterCompaction.compaction.last_result?.tokens_before ?? 0));
  // 这批整理后远低于安全上限，预算复核应给出明确的 false（不是「没有读数」）。
  assert.equal(afterCompaction.compaction.last_result?.budget_unmet, false);
});

test('压缩失败保留原始消息与旧窗口，下一轮仍可继续', async () => {
  const f = await fixture(9, MIB);
  const first = port(350_000);
  await send(f, '第一轮');
  assert.equal((await runAssistGenerationTick(app.db, first.options))?.status, 'COMPLETED');
  const before = await createRepositories(app.db).assist.listMessages(f.sessionId);

  await send(f, '触发失败');
  assert.equal((await runAssistGenerationTick(app.db, port(350_000).options))?.status, 'DISCARDED');
  const failed = await runAssistMemoryTick(app.db, port(0, { badSummary: true }).options);
  assert.equal(failed?.status, 'FAILED');
  assert.equal(failed?.errorCode, 'MEMORY_SUMMARY_INVALID');
  assert.equal((await createRepositories(app.db).assistMemory.state(f.sessionId))?.checkpoint_id ?? null, null);
  const after = await createRepositories(app.db).assist.listMessages(f.sessionId);
  assert.ok(after.length >= before.length, '失败不得删除原始消息');

  // 失败后同一个边界不自动重试：原消息照常继续执行（不循环压缩）。
  const resumed = port(120_000);
  assert.equal((await runAssistGenerationTick(app.db, resumed.options))?.status, 'COMPLETED');
  assert.equal(primaryCalls(resumed).length, 1);
});

test('压缩后 Token 数仍高于阈值时不会无限压缩：同一边界只压一次', async () => {
  const f = await fixture(9, MIB);
  const first = port(350_000);
  await send(f, '第一轮');
  assert.equal((await runAssistGenerationTick(app.db, first.options))?.status, 'COMPLETED');
  await send(f, '触发压缩');
  assert.equal((await runAssistGenerationTick(app.db, port(350_000).options))?.status, 'DISCARDED');
  assert.equal((await runAssistMemoryTick(app.db, port(0).options))?.status, 'COMPLETED');
  const count = (await requests(f.sessionId)).length;
  const messagesBefore = (await sql<{ count: bigint }>`select count(*) as count from assist_messages
    where session_id = ${f.sessionId}`.execute(app.db)).rows[0]?.count;

  // 第二轮：替身仍上报 350K（模拟「压缩后依然很大」）。预览窗口已推进；
  // 若没有新候选轮次，prepare 必须返回 null 而不是再造一条请求。
  const resumed = port(350_000);
  assert.equal((await runAssistGenerationTick(app.db, resumed.options))?.status, 'COMPLETED');
  assert.equal(primaryCalls(resumed).length, 1);
  assert.equal((await requests(f.sessionId)).length, count, '同一边界不得重复发起压缩');
  assert.equal((await sql<{ count: bigint }>`select count(*) as count from assist_messages
    where session_id = ${f.sessionId}`.execute(app.db)).rows[0]?.count, messagesBefore,
  '原始消息条数不因压缩变化');
});

test('压缩完成但压后仍超预算：投影给出 unmet，无法容纳时明确中止且原文不丢', async () => {
  // 默认 256K 档位：安全输入上限 232,652 tokens。把本批压缩**覆盖不到**的最后 8 条
  // 换成大正文，模拟「单条巨大输入」——整理只能压旧轮次，剩余的近期原文仍装不下。
  const f = await fixture(9);
  const first = port(350_000);
  await send(f, '第一轮');
  assert.equal((await runAssistGenerationTick(app.db, first.options))?.status, 'COMPLETED');
  // 只把**最近 8 条**（压缩永远保留的原文窗口）换成大正文：候选旧轮次仍可整理，
  // 但整理完剩余的近期原文依旧装不下——这正是「压完还不够」的真实形态。
  await send(f, '触发压缩');
  // 保留窗口（最近 8 条）换成大正文；只有 COMPLETED 行可以带正文（PENDING 必须为 NULL）。
  const big = '上下文压力原文。'.repeat(4600); // 每条约 110KB
  await sql`update assist_messages set content = ${big}
    where session_id = ${f.sessionId} and seq > 14 and status = 'COMPLETED'`.execute(app.db);
  assert.equal((await runAssistGenerationTick(app.db, port(350_000).options))?.status, 'DISCARDED');
  assert.equal((await runAssistMemoryTick(app.db, port(0).options))?.status, 'COMPLETED',
    '本批压缩本身成功：候选旧轮次确实被整理');

  const projection = await readSessionContextUsage(app.db, f.workspaceId, f.sessionId);
  const last = projection.compaction.last_result;
  assert.equal(last?.status, 'COMPLETED');
  assert.equal(last?.budget_unmet, true, '压后读数仍不低于安全输入上限时必须如实标 unmet');
  assert.ok((last?.tokens_after ?? 0) >= projection.compaction.safe_input_tokens);

  /*
   * 后续进位：装不下时先继续整理仍有候选的批次，候选耗尽后明确中止。
   * 断言「有界」而不是「一次就成功」——近期原文窗口不能压，这是设计约束；
   * 关键是既不无限压缩，也不静默把超预算请求发出去。
   */
  const messagesBefore = (await sql<{ count: bigint }>`select count(*) as count from assist_messages
    where session_id = ${f.sessionId}`.execute(app.db)).rows[0]?.count;
  const resumed = port(10_000);
  let terminal: { readonly status: string; readonly errorCode: string | null } | undefined;
  for (let tick = 0; tick < 6 && terminal === undefined; tick++) {
    const outcome = await runAssistGenerationTick(app.db, resumed.options);
    if (outcome !== undefined && outcome.status !== 'DISCARDED') terminal = outcome;
  }
  assert.equal(terminal?.status, 'FAILED');
  assert.equal(terminal?.errorCode, 'MEMORY_CONTEXT_TOO_LARGE');
  assert.equal(primaryCalls(resumed).length, 0, '装不下的请求不得发出');
  // 原始消息一条不少：压缩只推进检查点，不删除历史。
  assert.equal((await sql<{ count: bigint }>`select count(*) as count from assist_messages
    where session_id = ${f.sessionId}`.execute(app.db)).rows[0]?.count, messagesBefore);
  /*
   * 有界且不空转：这一批之后剩下的候选是一个**悬挂的 user 轮**（没有已完成的
   * ASSISTANT 轮可作锚点），按既有契约不能单独成批。因此不再发起第二次压缩，
   * 也不会每轮重试同一边界——这正是「不无限压缩」的确定性形态。
   */
  assert.equal((await requests(f.sessionId)).length, 1,
    '没有可结算锚点时不再发起压缩请求');
});
