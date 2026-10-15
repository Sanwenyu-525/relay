import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'kysely';
import test, { after, before } from 'node:test';

import { createAssistSession, requestAssistMessage } from '../../src/application/assist-commands.js';
import { runAssistGenerationTick } from '../../src/application/assist-runner.js';
import { readLearningRecords } from '../../src/application/learning-records.js';
import { createGatewayPolicy, registerManagedResource } from
  '../../src/application/gateway-configuration.js';
import { createRepositories, withTransaction } from '../../src/application/unit-of-work.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { ManagedContentStore } from '../../src/storage/managed-content-store.js';
import { FakeModelPort, type AssistModelPort, type AssistResult, type ModelUsage }
  from '../../src/workflow/fake-model-port.js';
import { createDataRoot } from './api-harness.js';
import { APP_DATABASE_URL, MIGRATION_DATABASE_URL, MIGRATIONS_DIRECTORY, openDatabase } from
  './integration-support.js';

/**
 * 学习轮次的真实 PG 出口（0072 / ADR-020 工作包 B）。
 *
 * 用可控 Fake 模型跑真实的「读文件 → 教学正文 + 同轮增量」序列，验三件事：
 *   * 学习身份真的能读受管目录，而磁盘逐字节未变、不产生 Task/Run；
 *   * **每一次**模型调用（含工具续轮）都进 `model_calls` 账本，不是只汇总到消息行；
 *   * 正文与增量分别落库：增量不合法、被关闭或轮次被停时，正文照样可读。
 */

const app = openDatabase(APP_DATABASE_URL, 'relay-api-test-learning-round');
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

interface LearningFixture {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly root: string;
  readonly canonicalRoot: string;
}

const TARGET_BASELINE = 'export const relay = true;\n';

async function fixture(): Promise<LearningFixture> {
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const root = await mkdtemp(join(tmpdir(), 'relay-learning-'));
  roots.push(root);
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'README.md'), '# Relay\n幂等性说明\n', 'utf8');
  await writeFile(join(root, 'src', 'idempotency.ts'), TARGET_BASELINE, 'utf8');

  await withTransaction(app.db, async (repositories) => {
    await repositories.workspaces.insertWorkspace({ id: workspaceId, name: '学习模式' });
    await repositories.workspaces.insertAuthorityRow(workspaceId);
    await repositories.projects.insertProject({ id: projectId, workspaceId, title: '学习项目',
      projectType: 'DEVELOPMENT' });
  });
  const { canonicalRoot } = await registerManagedResource(app.db,
    { workspaceId, projectId, rootPath: root });
  await withTransaction(app.db, async (repositories) => {
    await repositories.workspaces.lockAuthority(workspaceId, 'update');
    const connection = await repositories.gateway.insertConnection({ id: randomUUID(),
      workspaceId, projectId, config: { root_path: canonicalRoot } });
    await repositories.gateway.addConnectionCapability(connection.id, 'FILE_QUERY');
    await repositories.gateway.addConnectionCapability(connection.id, 'FILE_READ');
    await repositories.workspaces.bumpAuthority(workspaceId);
  });
  for (const actionType of ['LIST_DIRECTORY', 'FIND_PATHS', 'SEARCH_TEXT'] as const) {
    await createGatewayPolicy(app.db, { workspaceId, projectId, capability: 'FILE_QUERY',
      actionType, targetPrefix: canonicalRoot, decision: 'AUTO', maxPayloadBytes: 262144 });
  }
  await createGatewayPolicy(app.db, { workspaceId, projectId, capability: 'FILE_READ',
    actionType: 'READ_FILE', targetPrefix: canonicalRoot, decision: 'AUTO',
    maxPayloadBytes: 262144 });

  const session = await createAssistSession(app.db, { workspaceId, commandId: randomUUID(),
    title: '幂等性学习', projectId, conversationMode: 'LEARNING' });
  return { workspaceId, projectId, sessionId: session.result.session_id, root, canonicalRoot };
}

interface AskResult {
  readonly assistantMessageId: string;
  readonly status: string;
  readonly errorCode: string | null;
  readonly content: string | null;
  readonly roundStatus: string | null;
  readonly roundReason: string | null;
  readonly declaredTools: readonly string[];
  readonly fedBack: readonly { readonly name: string; readonly content: string }[];
}

async function ask(fx: LearningFixture, content: string, options: {
  readonly port?: AssistModelPort | undefined;
  readonly recordLearning?: boolean | undefined;
} = {}): Promise<AskResult> {
  const storage = new ManagedContentStore(dataRoot);
  const modelPort = options.port ?? new FakeModelPort();
  const original = modelPort.assist.bind(modelPort);
  let declaredTools: readonly string[] = [];
  let fedBack: readonly { name: string; content: string }[] = [];
  modelPort.assist = async (request) => {
    declaredTools = (request.tools ?? []).map((spec) => spec.name);
    if ((request.toolTurns?.length ?? 0) > fedBack.length) {
      fedBack = request.toolTurns!.flatMap((turn) => turn.results
        .map((result) => ({ name: result.name, content: result.content })));
    }
    return original(request);
  };
  const sent = await requestAssistMessage(app.db, { workspaceId: fx.workspaceId,
    sessionId: fx.sessionId, commandId: randomUUID(), content,
    ...(options.recordLearning === undefined ? {} : { recordLearning: options.recordLearning }) });
  const outcome = await runAssistGenerationTick(app.db, { workerId: `学习-${randomUUID()}`,
    storage, modelPort, leaseMs: 60_000, maxMessages: 1 });
  assert.ok(outcome !== undefined, '本次生成 tick 应当领取这条消息');
  assert.equal(outcome?.messageId, sent.result.assistant_message_id);
  const repositories = createRepositories(app.db);
  const message = await repositories.assist.readMessage(sent.result.assistant_message_id);
  const round = await repositories.learning.readRoundByMessage(sent.result.assistant_message_id);
  return { assistantMessageId: sent.result.assistant_message_id,
    status: message?.status ?? 'MISSING', errorCode: message?.error_code ?? null,
    content: message?.content ?? null, roundStatus: round?.status ?? null,
    roundReason: round?.rejection_reason ?? null, declaredTools, fedBack };
}

async function modelCalls(messageId: string): Promise<readonly { readonly kind: string;
  readonly status: string; readonly inputTokens: number | null;
  readonly outputTokens: number | null }[]> {
  return (await sql<{ kind: string; status: string; input_tokens: number | null;
    output_tokens: number | null }>`select kind, status, usage_input_tokens as input_tokens,
      usage_output_tokens as output_tokens from model_calls
    where assist_message_id = ${messageId} order by started_at, id`.execute(app.db)).rows
    .map((row) => ({ kind: row.kind, status: row.status, inputTokens: row.input_tokens,
      outputTokens: row.output_tokens }));
}

async function executionCounts(workspaceId: string): Promise<{ tasks: number; runs: number }> {
  const tasks = await sql<{ count: string }>`select count(*)::text as count from tasks
    where workspace_id = ${workspaceId}`.execute(app.db);
  const runs = await sql<{ count: string }>`select count(*)::text as count from runs
    where workspace_id = ${workspaceId}`.execute(app.db);
  return { tasks: Number(tasks.rows[0]?.count ?? '0'), runs: Number(runs.rows[0]?.count ?? '0') };
}

test('LM-01/07：项目带学读真实代码，正文与增量分别落库，磁盘未变且不建 Task/Run', async () => {
  const fx = await fixture();
  const before = await readFile(join(fx.root, 'src', 'idempotency.ts'), 'utf8');
  const script = [[{ name: 'read_file', arguments: { relative_path: 'src/idempotency.ts' } }]];
  const content = [
    `FAKE_ASSIST_TOOLS ${JSON.stringify(script)}`,
    '响应丢失为什么会造成重复提交？',
    'LEARNING: OBSERVE | 后端可靠性 | 幂等性 | 同 ID 异载荷 | 能指出同 ID 不同载荷必须拒绝',
    'LEARNING: GAP | 后端可靠性 | 幂等键作用域 | 跨任务重试 | 把幂等键作用域误当成整库唯一',
  ].join('\n');
  const result = await ask(fx, content);

  assert.equal(result.status, 'COMPLETED', JSON.stringify(result));
  assert.ok((result.content ?? '').length > 0, '正文必须可读');
  assert.ok(result.declaredTools.includes('read_file'), '学习轮次应当拿到只读词表');
  assert.ok(result.fedBack.some((entry) => entry.content.includes('relay')), 
    `工具结果应当回传模型：${JSON.stringify(result.fedBack)}`);

  const view = await readLearningRecords(app.db, { workspaceId: fx.workspaceId });
  const byName = new Map(view.concepts.map((concept) => [concept.display_name, concept]));
  assert.equal(byName.get('幂等性')?.evidence.length, 1);
  assert.equal(byName.get('幂等键作用域')?.evidence[0]?.disposition, 'PENDING_REVIEW');
  assert.equal(result.roundStatus, 'SETTLED');

  assert.equal(await readFile(join(fx.root, 'src', 'idempotency.ts'), 'utf8'), before,
    '只读轮次不得改动磁盘');
  const counts = await executionCounts(fx.workspaceId);
  assert.equal(counts.tasks, 0, '学习不建 Task');
  assert.equal(counts.runs, 0, '学习不建 Run');
});

test('LM-11：每次模型调用（含工具续轮）都进调用账本，且账本用量与消息用量一致', async () => {
  const fx = await fixture();
  const script = [[{ name: 'read_file', arguments: { relative_path: 'README.md' } }]];
  const content = `FAKE_ASSIST_TOOLS ${JSON.stringify(script)}\n看看这个项目。`;
  const result = await ask(fx, content);
  assert.equal(result.status, 'COMPLETED');

  const calls = await modelCalls(result.assistantMessageId);
  assert.ok(calls.length >= 2,
    `工具续轮的每一次调用都要留账本，实际 ${calls.length} 行：${JSON.stringify(calls)}`);
  assert.ok(calls.every((call) => call.kind === 'ASSIST'), JSON.stringify(calls));
  assert.ok(calls.every((call) => call.status === 'COMPLETED'), JSON.stringify(calls));

  // 账本用量之和必须等于消息行用量：任何一次调用绕过 recordModelInvocation 都会让两者不等。
  const message = await createRepositories(app.db).assist.readMessage(result.assistantMessageId);
  const ledgerInput = calls.reduce((sum, call) => sum + (call.inputTokens ?? 0), 0);
  const ledgerOutput = calls.reduce((sum, call) => sum + (call.outputTokens ?? 0), 0);
  assert.equal(ledgerInput, message?.usage_input_tokens,
    '输入用量账本合计与消息行不一致，说明有调用没被计量');
  assert.equal(ledgerOutput, message?.usage_output_tokens,
    '输出用量账本合计与消息行不一致，说明有调用没被计量');
});

test('LM-13：消息级「本次不记录」时正文照常可读，增量一律不写', async () => {
  const fx = await fixture();
  const result = await ask(fx,
    'LEARNING: OBSERVE | 后端可靠性 | 幂等性 | 响应丢失重试 | 这条不应被写入',
    { recordLearning: false });

  assert.equal(result.status, 'COMPLETED', '关闭记录不阻断教学回答');
  assert.ok((result.content ?? '').length > 0);
  assert.equal(result.roundStatus, 'REJECTED');
  assert.equal(result.roundReason, 'LEARNING_RECORD_DISABLED');
  const view = await readLearningRecords(app.db, { workspaceId: fx.workspaceId });
  assert.equal(view.concepts.length, 0, '关闭记录时模型返回增量也不写');
});

test('LM-12：信封不合法时保留正文、如实显示未更新与原因', async () => {
  const fx = await fixture();
  const result = await ask(fx, 'FAKE_LEARNING_BAD_ENVELOPE 讲讲幂等性。');

  assert.equal(result.status, 'COMPLETED');
  assert.ok((result.content ?? '').length > 0, '信封不合法也要保留可读回答');
  assert.equal(result.roundStatus, 'REJECTED');
  assert.equal(result.roundReason, 'LEARNING_ENVELOPE_NOT_JSON');
  const view = await readLearningRecords(app.db, { workspaceId: fx.workspaceId });
  assert.equal(view.concepts.length, 0, '不合法信封不产生任何知识点或证据');
});

test('LM-02：跳过与无实质回答不产生证据，也不降级', async () => {
  const fx = await fixture();
  const result = await ask(fx, '先跳过这个问题，聊聊别的。');

  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.roundStatus, 'SETTLED');
  assert.equal(result.roundReason, null);
  const view = await readLearningRecords(app.db, { workspaceId: fx.workspaceId });
  assert.equal(view.concepts.length, 0, '跳过不制造接触、自述或表现证据');
});

test('LM-14：轮次被停止时消息与轮次都如实收口，不留 PENDING', async () => {
  const fx = await fixture();
  const cancelled: AssistModelPort = {
    identity: new FakeModelPort().identity,
    assist: async (): Promise<AssistResult> => ({
      kind: 'CANCELLED',
      usage: { inputTokens: null, outputTokens: null,
        cacheReadTokens: null, cacheCreationTokens: null } as ModelUsage,
    }),
  };
  const result = await ask(fx, '讲讲幂等性。', { port: cancelled });

  assert.equal(result.status, 'CANCELLED', JSON.stringify(result));
  assert.equal(result.roundStatus, 'CANCELLED', '停止后未结算的轮次显式收口');
  assert.equal(result.roundReason, 'LEARNING_ROUND_CANCELLED');
  const view = await readLearningRecords(app.db, { workspaceId: fx.workspaceId });
  assert.equal(view.concepts.length, 0, '停止的轮次不写任何增量');
});
