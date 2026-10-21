import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';
import test, { after, before } from 'node:test';

import { bindAssistSessionDirectory, createAssistSession, requestAssistMessage,
  steerAssistMessage } from '../../src/application/assist-commands.js';
import { listAssistMessages } from '../../src/application/assist-queries.js';
import { runAssistGenerationTick } from '../../src/application/assist-runner.js';
import { runSessionReadonlyRounds } from '../../src/application/assistant-readonly-round.js';
import { createGatewayPolicy, registerManagedResource } from
  '../../src/application/gateway-configuration.js';
import { createRepositories, withTransaction } from '../../src/application/unit-of-work.js';
import { SessionToolCallRepository } from '../../src/assist/session-tool-call-repository.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { ManagedContentStore } from '../../src/storage/managed-content-store.js';
import { FakeModelPort, type AssistModelPort, type AssistResult } from
  '../../src/workflow/fake-model-port.js';
import { agentMainLoopSystemPrompt } from '../../src/workflow/prompts/conversation-prompts.js';
import { OpenAiCompatibleModelPort } from '../../src/workflow/openai-compatible-model-port.js';
import { classifyProviderError, readProviderHttpStatus } from
  '../../src/workflow/model-error-classification.js';
import { readModelPortConfig, type ModelPortConfig } from '../../src/workflow/model-port-config.js';
import type { GatewayCapability } from '../../src/infrastructure/database-schema.js';
import { createDataRoot } from './api-harness.js';
import { APP_DATABASE_URL, MIGRATION_DATABASE_URL, MIGRATIONS_DIRECTORY, openDatabase } from
  './integration-support.js';

/**
 * 连续插话与方向变化的**真实 Provider** 出口（2026-10-20）。
 *
 * Fake 端口只证明输入顺序与执行边界；本文件用真实模型验证六类用户语义：
 * 相关补充、局部修正、改变阶段、明确替换目标、临时提问、关系不清。
 *
 * 断言分两级：
 *   * **硬断言**是代码层保证，与模型无关——插话原文必须进入后续请求、被停止的
 *     工具不得落账本/Gateway/磁盘、排队行必须收口。失败即缺陷。
 *   * **软记录**是模型语义（回答是否合并要求、是否停止旧方向），只写入诊断输出：
 *     真实模型是概率性的，把措辞断言写成硬失败会让本文件随模型波动而假红。
 *     发现旧计划继续产生**副作用**（工具落盘/落账本）时那是硬断言失败——那才是
 *     「回复说改了、实际还在执行旧计划」的真缺陷。
 *
 * 默认整体跳过：只有显式 `RELAY_STEER_PROVIDER_CHECK=1` 且真实 Provider 配置可用
 * 时才跑，避免全量回归烧真实模型。凭据只从环境变量或 apps/api/.env 读取，
 * 不写入任何输出。
 */

const ENABLED = process.env.RELAY_STEER_PROVIDER_CHECK === '1';

/** 会话里唯一会改磁盘内容的工具：用来如实区分「被打断的是读还是写」，不参与任何放行判定。 */
const WRITE_TOOLS: readonly string[] = ['apply_changeset'];

/** 从 apps/api/.env 补读未在进程环境里的模型配置；只进内存，不输出。 */
function loadModelPortConfig(): ModelPortConfig | undefined {
  if (process.env.RELAY_MODEL_API_KEY !== undefined) {
    try {
      return readModelPortConfig(process.env);
    } catch {
      return undefined;
    }
  }
  const envPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.env');
  if (!existsSync(envPath)) return undefined;
  const parsed = new Map<string, string>();
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/u)) {
    const match = /^([A-Z0-9_]+)=(.*)$/u.exec(line.trim());
    if (match !== null) parsed.set(match[1]!, match[2]!);
  }
  const env = { ...process.env } as NodeJS.ProcessEnv;
  for (const [key, value] of parsed) {
    if (env[key] === undefined) env[key] = value;
  }
  try {
    return readModelPortConfig(env);
  } catch {
    return undefined;
  }
}

const modelConfig = ENABLED ? loadModelPortConfig() : undefined;
const live = ENABLED && modelConfig !== undefined;

const app = openDatabase(APP_DATABASE_URL, 'relay-api-test-steer-provider');
let dataRoot: string;
const roots: string[] = [];

before(async () => {
  if (!live) return;
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
  dataRoot = await createDataRoot();
});
after(async () => {
  if (!live) return;
  await app.close();
  await rm(dataRoot, { recursive: true, force: true });
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

interface Fixture {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly root: string;
  readonly canonicalRoot: string;
  readonly connectionId: string;
  readonly marker: string;
}

async function fixture(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const root = await mkdtemp(join(tmpdir(), 'relay-steer-provider-'));
  roots.push(root);
  await mkdir(join(root, 'src'), { recursive: true });
  const marker = `RELAY-MARKER-${randomUUID().slice(0, 8).toUpperCase()}`;
  await writeFile(join(root, 'README.md'), `# 目录说明\n随机标记：${marker}\n`, 'utf8');
  await writeFile(join(root, 'src', 'index.ts'),
    'export const relay = true;\n// 登录入口占位\n', 'utf8');
  await withTransaction(app.db, async (repositories) => {
    await repositories.workspaces.insertWorkspace({ id: workspaceId, name: 'steer-provider' });
    await repositories.workspaces.insertAuthorityRow(workspaceId);
    await repositories.projects.insertProject({ id: projectId, workspaceId, title: 'steer-provider',
      projectType: 'DEVELOPMENT' });
  });
  const { resourceId, canonicalRoot } = await registerManagedResource(app.db,
    { workspaceId, projectId, rootPath: root });
  const capabilities: readonly GatewayCapability[] = ['FILE_QUERY', 'FILE_READ'];
  const connectionId = await withTransaction(app.db, async (repositories) => {
    await repositories.workspaces.lockAuthority(workspaceId, 'update');
    const connection = await repositories.gateway.insertConnection({ id: randomUUID(),
      workspaceId, projectId, config: { root_path: canonicalRoot } });
    for (const capability of capabilities) {
      await repositories.gateway.addConnectionCapability(connection.id, capability);
    }
    await repositories.workspaces.bumpAuthority(workspaceId);
    return connection.id;
  });
  for (const [capability, actionType] of [['FILE_QUERY', 'LIST_DIRECTORY'],
    ['FILE_QUERY', 'FIND_PATHS'], ['FILE_QUERY', 'SEARCH_TEXT'], ['FILE_READ', 'READ_FILE']] as const) {
    await createGatewayPolicy(app.db, { workspaceId, projectId, capability, actionType,
      targetPrefix: canonicalRoot, decision: 'AUTO', maxPayloadBytes: 262144 });
  }
  const session = await createAssistSession(app.db, { workspaceId, commandId: randomUUID(),
    title: '普通会话', projectId, conversationMode: 'AGENT' });
  await bindAssistSessionDirectory(app.db, { workspaceId,
    sessionId: session.result.session_id, commandId: randomUUID(), resourceId });
  return { workspaceId, projectId, sessionId: session.result.session_id, root, canonicalRoot,
    connectionId, marker };
}

/** 打开目录写档位（FULL）并补 FILE_WRITE 连接与策略：场景 C 需要真实写工具在词表里。 */
async function enableSessionWrite(fx: Fixture): Promise<void> {
  const resource = (await withTransaction(app.db, (repositories) =>
    repositories.gateway.listResources())).find((item) => item.project_id === fx.projectId);
  assert.ok(resource !== undefined, '夹具必须已有受管资源');
  const writeConnectionId = await withTransaction(app.db, async (repositories) => {
    await repositories.workspaces.lockAuthority(fx.workspaceId, 'update');
    const connection = await repositories.gateway.insertConnection({ id: randomUUID(),
      workspaceId: fx.workspaceId, projectId: fx.projectId,
      config: { root_path: resource.canonical_root } });
    await repositories.gateway.addConnectionCapability(connection.id, 'FILE_WRITE');
    await repositories.workspaces.bumpAuthority(fx.workspaceId);
    return connection.id;
  });
  await sql`insert into local_directory_access
    (resource_id, write_tier, read_connection_id, write_connection_id)
    values (${resource.id}, 'FULL', ${fx.connectionId}, ${writeConnectionId})
    on conflict (resource_id) do update set write_tier = 'FULL',
      write_connection_id = ${writeConnectionId}`.execute(app.db);
  await createGatewayPolicy(app.db, { workspaceId: fx.workspaceId, projectId: fx.projectId,
    capability: 'FILE_WRITE', actionType: 'APPLY_CHANGESET',
    targetPrefix: resource.canonical_root, decision: 'AUTO', maxPayloadBytes: 262144 });
  const tier = await sql<{ write_tier: string }>`select write_tier from local_directory_access
    where resource_id = ${resource.id}`.execute(app.db);
  assert.equal(tier.rows[0]?.write_tier, 'FULL');
}

// 包装器需要知道当前会话：单文件串行执行，用例开始时设置。
let currentWorkspaceId = '';
let currentSessionId = '';

interface LiveRecorder {
  readonly rounds: { steers: readonly string[]; steersBefore: readonly string[][];
    toolTurns: number; tools: readonly string[] }[];
  lastContent: string;
}

/**
 * 真实端口 + 注入包装器：在指定轮次先把插话落库并请求 steer，再透传真实请求。
 *
 * 注入点选在 `assist` 内部：主循环的 `drainSteers` 发生在 `invokeAssist` 之前，
 * 因此第 N 轮落库的插话由第 N+1 次请求前的安全点消费——与产品时序一致。
 * `inject[i]` 是第 i 轮（从 0 计）请求前要落的插话文本列表。
 */
function livePort(inject: readonly (readonly string[])[]): {
  port: AssistModelPort; recorder: LiveRecorder } {
  const real = new OpenAiCompatibleModelPort(modelConfig!);
  const recorder: LiveRecorder = { rounds: [], lastContent: '' };
  let index = 0;
  return {
    recorder,
    port: {
      identity: real.identity,
      assist: async (request: Parameters<AssistModelPort['assist']>[0]): Promise<AssistResult> => {
        recorder.rounds.push({ steers: [...(request.steers ?? [])],
          steersBefore: (request.toolTurns ?? []).map((turn) => [...(turn.steersBefore ?? [])]),
          toolTurns: request.toolTurns?.length ?? 0,
          tools: (request.tools ?? []).map((spec) => spec.name) });
        const injection = inject[index];
        index += 1;
        if (injection !== undefined) {
          for (const content of injection) {
            const queued = await requestAssistMessage(app.db, { workspaceId: currentWorkspaceId,
              sessionId: currentSessionId, commandId: randomUUID(), content });
            await steerAssistMessage(app.db, { workspaceId: currentWorkspaceId,
              messageId: queued.result.assistant_message_id, commandId: randomUUID() });
          }
        }
        const result = await real.assist(request);
        if (result.kind === 'CONTENT') recorder.lastContent = result.content;
        return result;
      },
    },
  };
}

/**
 * 失败归因证据：`MODEL_FAILED` 既可能是 Provider 传输层抖动，也可能是本模块的代码缺陷，
 * 两者必须用同一份持久化证据区分，不能靠猜。这里只读取已落库的类型化字段
 * （`provider_error_kind` / `model_calls.error_kind` / 请求号），不打印任何凭据或响应体。
 */
async function failureEvidence(messageId: string): Promise<string> {
  const row = await sql<{ provider_error_kind: string | null; provider_request_id: string | null }>`
    select provider_error_kind, provider_request_id from assist_messages where id = ${messageId}`
    .execute(app.db);
  const calls = await sql<{ status: string; error_kind: string | null }>`
    select status, error_kind from model_calls where assist_message_id = ${messageId}
    order by started_at`.execute(app.db);
  return `provider_error_kind=${row.rows[0]?.provider_error_kind ?? '-'}` +
    ` request_id=${row.rows[0]?.provider_request_id ?? '-'}` +
    ` model_calls=${JSON.stringify(calls.rows.map((call) => `${call.status}` +
      `${call.error_kind === null ? '' : ':' + call.error_kind}`))}`;
}

/**
 * 调用层错误的类型化归因（测试侧，不改生产收口口径）。
 *
 * 生产路径只在「模型外呼记录器」认得的那个错误上写 `provider_error_kind`；会话轮次里
 * 端口直接抛出的失败只会得到 `MODEL_FAILED`，光看数据库分不出 Provider 抖动与代码缺陷。
 * 因此在真实端口外面加一层观察：记录错误类型名、既有的分类结果与 HTTP 状态，正文里
 * 任何疑似凭据的长串一律打码，只用于把「外部阻塞」与「需要修代码」分开。
 */
function scrub(text: string): string {
  return text.replace(/[A-Za-z0-9_\-+/=]{16,}/gu, '[已打码]')
    .replace(/\s+/gu, ' ').slice(0, 240);
}

function describeModelFailure(error: unknown): string {
  const name = error instanceof Error ? error.name : typeof error;
  const ctor = error !== null && typeof error === 'object'
    ? (error as object).constructor?.name ?? '-' : '-';
  const category = classifyProviderError(error) ?? 'UNCLASSIFIED';
  const status = readProviderHttpStatus(error) ?? '-';
  const message = error instanceof Error ? scrub(error.message) : scrub(String(error));
  const cause = error instanceof Error && error.cause !== undefined
    ? (error.cause instanceof Error ? error.cause.name : String(typeof error.cause)) : '-';
  return `模型调用抛错 name=${name} class=${ctor} category=${category} http=${status}` +
    ` cause=${cause} message=${message}`;
}

/**
 * 夹具级清理：收口**上一个场景遗留**的 PENDING 占位行。
 *
 * 为什么必须清：生产领取逻辑 `claimNextPendingMessage` 按整库 `(session_id, created_at, id)`
 * 全局取最早一条（这是产品语义，不能为测试放宽）。真实模型场景每条插话都会排队一行；
 * 上一场景的生成已经失败收口，那些插话占位行仍是 PENDING，于是下一次 tick 先领走旧行，
 * 本场景刚发的消息反而停在 PENDING——把 Provider 失败伪装成「测试拿错消息」。
 * 这里用只有测试夹具会写的 `TEST_STALE_PENDING` 收口，不与产品事实 `STEERED` 混淆，
 * 也不改任何生产状态机。
 */
async function clearStalePendingRows(): Promise<number> {
  const stale = await sql`update assist_messages
    set status = 'CANCELLED', error_code = 'TEST_STALE_PENDING', updated_at = now()
    where role = 'ASSISTANT' and status = 'PENDING'
    returning id`.execute(app.db);
  return stale.rows.length;
}

/** 跑一轮带真实模型的普通会话生成；返回消息终态。 */
async function askLive(fx: Fixture, content: string, port: AssistModelPort, attempt: string):
  Promise<{ status: string; content: string | null; errorCode: string | null }> {
  const storage = new ManagedContentStore(dataRoot);
  const cleared = await clearStalePendingRows();
  const sent = await requestAssistMessage(app.db, { workspaceId: fx.workspaceId,
    sessionId: fx.sessionId, commandId: randomUUID(), content });
  const outcome = await runAssistGenerationTick(app.db, { workerId: `steer-live-${randomUUID()}`,
    storage, modelPort: port, leaseMs: 600_000, maxMessages: 1 });
  assert.ok(outcome !== undefined, '本次生成 tick 应当领取一条待生成消息');
  const message = await createRepositories(app.db).assist.readMessage(
    sent.result.assistant_message_id);
  const result = { status: message?.status ?? 'MISSING', content: message?.content ?? null,
    errorCode: message?.error_code ?? null };
  // 每次尝试都留类型化原因：真实模型的概率性抖动与代码缺陷要用同一份证据区分开。
  console.log(`[live ${attempt}] status=${result.status} errorCode=${result.errorCode ?? '-'}` +
    (cleared > 0 ? ` staleCleared=${cleared}` : '') +
    (result.status === 'FAILED' ? ` ${await failureEvidence(sent.result.assistant_message_id)}` : ''));
  return result;
}

/**
 * 真实模型是概率性的：Provider 端偶发失败时重跑一次，仍失败才判定缺陷。
 * 重试只消化**调用层**抖动（超时/限流/提供方 5xx），不改变任何断言。
 * 两次尝试之间留出退避窗口：限流是秒级窗口，立即重试只会把同一次抖动记成两次失败。
 */
async function askLiveWithRetry(fx: Fixture, content: string,
  live: { readonly port: AssistModelPort; readonly recorder: LiveRecorder }):
  Promise<{ status: string; content: string | null; errorCode: string | null }> {
  // 观察窗必须每次尝试各自从空开始：端口在模型调用真的失败之前就已经记下轮次，
  // 上一试遗留的 rounds 会挪动下标，让「第 1 轮带插话」读到错的那一轮。
  live.recorder.rounds.length = 0;
  live.recorder.lastContent = '';
  const first = await askLive(fx, content, live.port, 'try-1');
  if (first.status !== 'FAILED') return first;
  await new Promise((resolveBackoff) => setTimeout(resolveBackoff, 20_000));
  live.recorder.rounds.length = 0;
  live.recorder.lastContent = '';
  const second = await askLive(fx, content, live.port, 'try-2');
  if (second.status === 'FAILED') {
    assert.fail(`真实模型连续两次调用失败：try-1=${first.errorCode} try-2=${second.errorCode}`);
  }
  return second;
}

test('场景 A 相关补充：三条要求按序进入同一轮，合并为一个目标', async (t) => {
  if (!live) return t.skip('未开启真实 Provider 检查');
  const fx = await fixture();
  currentWorkspaceId = fx.workspaceId;
  currentSessionId = fx.sessionId;
  const { port, recorder } = livePort([['支持手机号登录'], ['再加验证码']]);
  const result = await askLiveWithRetry(fx, '做登录页', { port, recorder });
  assert.equal(result.status, 'COMPLETED');
  // 硬断言：两条插话原文都必须出现在后续请求里。旧插话要么仍在 steers 末尾，
  // 要么已按其引发的工具轮次移入 steersBefore——两种位置都由真实时序决定，但都不能丢。
  // 第二条的位置**不能靠「倒数第几轮」判**：真实模型自己决定这一轮跑几次，末尾可能连着
  // 好几轮没有插话（2026-10-21 真实 Provider 实测 rounds=6，第二条落在下标 2，倒数第二轮为空）。
  // 要守的不变式是「出现在它到达之后的任一请求里，且原文不丢」。
  assert.ok(recorder.rounds.length >= 3, '插话应让这一轮多跑步');
  assert.deepEqual(recorder.rounds[1]?.steers, ['支持手机号登录']);
  const secondArrivedAt = recorder.rounds.findIndex((round, index) =>
    index > 1 && (round.steers.includes('再加验证码') ||
      round.steersBefore.some((list) => list.includes('再加验证码'))));
  assert.ok(secondArrivedAt > 1,
    `第二条插话必须进入它到达之后的请求；实际=${JSON.stringify(recorder.rounds.map((r) => r.steers))}`);
  const firstAnywhere = recorder.rounds.some((round) =>
    round.steers.includes('支持手机号登录') ||
    round.steersBefore.some((list) => list.includes('支持手机号登录')));
  assert.ok(firstAnywhere, '第一条插话原文必须留在上下文里（steers 或 steersBefore）');
  // 软记录：真实模型对「合并三要求」的实际处理。
  console.log(`[A] rounds=${recorder.rounds.length} steers=${JSON.stringify(recorder.rounds.map((r) => r.steers))} steersBefore=${JSON.stringify(recorder.rounds.map((r) => r.steersBefore))}`);
  console.log(`[A] content=${recorder.lastContent.slice(0, 400)}`);
});

test('场景 B 局部修正：后文只替换冲突部分，其余要求继续有效', async (t) => {
  if (!live) return t.skip('未开启真实 Provider 检查');
  const fx = await fixture();
  currentWorkspaceId = fx.workspaceId;
  currentSessionId = fx.sessionId;
  const { port, recorder } = livePort([['改成绿色']]);
  const result = await askLiveWithRetry(fx, '登录页的按钮用红色', { port, recorder });
  assert.equal(result.status, 'COMPLETED');
  assert.ok(recorder.rounds.length >= 2, '插话应让这一轮多跑一步');
  assert.deepEqual(recorder.rounds[1]?.steers, ['改成绿色']);
  console.log(`[B] rounds=${recorder.rounds.length} content=${recorder.lastContent.slice(0, 400)}`);
});

test('场景 C 改变阶段：插话到达后未执行的写动作停止派发，磁盘逐字节不变', async (t) => {
  if (!live) return t.skip('未开启真实 Provider 检查');
  const fx = await fixture();
  await enableSessionWrite(fx);
  currentWorkspaceId = fx.workspaceId;
  currentSessionId = fx.sessionId;
  const repository = createRepositories(app.db).assist;
  const sent = await requestAssistMessage(app.db, { workspaceId: fx.workspaceId,
    sessionId: fx.sessionId, commandId: randomUUID(), content: '把 src/index.ts 改成导出 false' });
  const workerId = `steer-c-${randomUUID()}`;
  const message = await repository.claimNextPendingMessage(workerId);
  assert.ok(message !== undefined);
  const session = await repository.readSession(fx.sessionId);
  assert.ok(session !== undefined && session.working_resource_id !== null);
  const before = await readFile(join(fx.root, 'src', 'index.ts'), 'utf8');
  const readmeBefore = await readFile(join(fx.root, 'README.md'), 'utf8');
  const queuedText = '先别改，只给方案';
  let injected = false;
  let queuedId: string | undefined;
  const seenSteers: string[][] = [];
  let lastContent = '';
  /**
   * 注入时机不再靠「第几次安全点」猜：模型**报出动作之后、循环派发之前**才是这一场景的
   * 真实时刻。端口在收到 TOOL_CALLS（或 CONTENT，表示这一批本来就没有动作）后置位标记，
   * 紧接着的第一个安全点消费它——因此被撤回的批次一定包含模型刚报出的那些动作。
   */
  let armInjection = false;
  /** providerToolCallId → 该动作最终是「被撤回」还是「已派发并结算」。 */
  const observed = new Map<string, { name: string; stopped: boolean }>();
  const port: AssistModelPort = {
    identity: new FakeModelPort().identity,
    assist: async (request) => {
      seenSteers.push([...(request.steers ?? [])]);
      for (const turn of request.toolTurns ?? []) {
        for (const result of turn.results) {
          observed.set(result.providerToolCallId, { name: result.name,
            stopped: result.content.includes('NEW_USER_INPUT') });
        }
      }
      const result = await new OpenAiCompatibleModelPort(modelConfig!).assist(request);
      if (result.kind === 'CONTENT') lastContent = result.content;
      if (result.kind === 'TOOL_CALLS' || result.kind === 'CONTENT') armInjection = !injected;
      return result;
    },
  };
  const outcome = await runSessionReadonlyRounds(app.db, { session, message,
    availableTools: ['read_file', 'list_directory', 'apply_changeset', 'read_change_set'],
    system: agentMainLoopSystemPrompt(true), allowWrite: true,
    contextTurns: [{ role: 'user', content: '把 src/index.ts 改成导出 false' }],
    modelPort: port, signal: new AbortController().signal,
    resolveOrigin: async () => ({ ok: true, canonicalRoot: fx.canonicalRoot,
      origin: { kind: 'AGENT_SESSION_READ', projectId: fx.projectId,
        resourceId: session.working_resource_id!, sessionId: session.id, messageId: message.id } }),
    drainSteers: async () => {
      // 到达下一个安全点：模型刚报出的那一批动作还没派发，插话此刻落库。
      if (armInjection && !injected) {
        armInjection = false;
        injected = true;
        const queued = await requestAssistMessage(app.db, { workspaceId: fx.workspaceId,
          sessionId: fx.sessionId, commandId: randomUUID(), content: queuedText });
        queuedId = queued.result.assistant_message_id;
        await steerAssistMessage(app.db, { workspaceId: fx.workspaceId,
          messageId: queuedId, commandId: randomUUID() });
      }
      return repository.drainSteerRequests(session.id, message.seq);
    } });
  // 先留证据再断言：真实模型这一轮可能失败，失败原因（类型化 errorCode）必须落到日志里，
  // 否则断言只告诉我们「FAILED」，把 Provider 抖动与代码缺陷混成同一条现象。
  const ledger = await new SessionToolCallRepository(app.db).listBySession(fx.sessionId);
  const stopped = [...observed.entries()].filter(([, info]) => info.stopped);
  const dispatched = [...observed.entries()].filter(([, info]) => !info.stopped);
  console.log(`[C] outcome=${outcome.kind}` +
    (outcome.kind === 'FAILED' ? ` errorCode=${outcome.errorCode}` : '') +
    ` injected=${injected} 撤回=${JSON.stringify(stopped.map(([, i]) => i.name))}` +
    ` 已派发=${JSON.stringify(dispatched.map(([, i]) => i.name))}`);
  console.log(`[C] ledger=${JSON.stringify(ledger.map((row) => ({ round: row.round,
    ordinal: row.ordinal, tool: row.tool_name, status: row.status,
    op: row.operation_id !== null })))}`);
  if (stopped.length === 0) {
    // 如实记录覆盖，不冒充：真实模型这一轮一批动作都没报出，派发前安全点没被打到。
    t.diagnostic('真实模型本轮未报出任何工具动作：派发前安全点的停止语义未被这一次真实运行覆盖' +
      '（该路径由 Fake 套件 agent-conversation-main-loop 的「工具之间到达插话」用例确定覆盖）');
  } else if (!stopped.some(([, info]) => WRITE_TOOLS.includes(info.name))) {
    // 同样如实记录：被打断的批次里只有读动作，「写动作停止派发」这一半没被真实运行打到。
    t.diagnostic(`被打断的批次只含读动作（${
      JSON.stringify(stopped.map(([, info]) => info.name))}）：真实模型这次没有先报出写动作，` +
      '写动作停止派发由 Fake 套件与磁盘逐字节比对共同佐证');
  }
  // 硬断言 1：被插话撤回的动作一个都不许进账本——进了就意味着它真的执行过。
  for (const [providerToolCallId, info] of stopped) {
    assert.ok(!ledger.some((row) => row.provider_tool_call_id === providerToolCallId),
      `被撤回的 ${info.name} 不得进入工具账本`);
  }
  // 硬断言 2：反过来，已派发的动作必须**逐条如实落账**，不许被算成取消。
  for (const [providerToolCallId, info] of dispatched) {
    assert.ok(ledger.some((row) => row.provider_tool_call_id === providerToolCallId),
      `已派发的 ${info.name} 必须在账本里有记录，不能声称已取消`);
  }
  assert.ok(!ledger.some((row) => row.status === 'REQUESTED'),
    '账本里不许留下未结算的请求行（既不执行也不作废）');
  // 硬断言 3：旧方向的写入没有落到磁盘上——逐字节比对，不看模型怎么说。
  assert.equal(await readFile(join(fx.root, 'src', 'index.ts'), 'utf8'), before,
    'src/index.ts 必须逐字节不变');
  assert.equal(await readFile(join(fx.root, 'README.md'), 'utf8'), readmeBefore,
    'README.md 必须逐字节不变');
  const operations = await sql<{ n: number }>`select count(*)::int as n from logical_operations
    where project_id = ${fx.projectId} and origin = 'AGENT_SESSION_WRITE'`.execute(app.db);
  console.log(`[C] 写动作 Operation 数=${operations.rows[0]?.n ?? 0}`);
  assert.ok(queuedId !== undefined);
  const queuedRow = await repository.readMessage(queuedId);
  assert.equal(queuedRow?.status, 'CANCELLED', '插话行必须收口');
  assert.equal(queuedRow?.error_code, 'STEERED');
  const flat = seenSteers.flat();
  assert.ok(flat.includes(queuedText), '插话原文必须进入后续模型请求');
  assert.equal(outcome.kind, 'CONTENT', '这一轮必须给出正文答复');
  console.log(`[C] steers=${JSON.stringify(seenSteers)}`);
  console.log(`[C] content=${lastContent.slice(0, 400)}`);
  await repository.settleGeneration({ messageId: message.id, workerId, status: 'COMPLETED',
    content: lastContent === '' ? null : lastContent, errorCode: null,
    providerRequestId: 'providerRequestIds' in outcome
      ? (outcome.providerRequestIds.at(-1) ?? null) : null,
    usageInputTokens: null, usageOutputTokens: null });
});

test('场景 D 明确替换目标：停止旧方向，转向新目标', async (t) => {
  if (!live) return t.skip('未开启真实 Provider 检查');
  const fx = await fixture();
  currentWorkspaceId = fx.workspaceId;
  currentSessionId = fx.sessionId;
  const { port, recorder } = livePort([['登录先不做了'], ['只分析启动失败，先不要修改']]);
  const result = await askLiveWithRetry(fx, '做登录页', { port, recorder });
  assert.equal(result.status, 'COMPLETED');
  assert.deepEqual(recorder.rounds[1]?.steers ?? [], ['登录先不做了']);
  const lastSteers = recorder.rounds.at(-2)?.steers ?? [];
  assert.ok(lastSteers.includes('只分析启动失败，先不要修改'),
    `第二条插话必须进入后续请求；实际=${JSON.stringify(recorder.rounds.map((r) => r.steers))}`);
  // 硬断言：只读档位下零 Gateway 动作——「没有继续完成旧目标」的副作用证据。
  const operations = await sql<{ n: number }>`select count(*)::int as n from logical_operations
    where project_id = ${fx.projectId}`.execute(app.db);
  assert.equal(operations.rows[0]?.n, 0, '只读档位下不得产生 Gateway 动作');
  console.log(`[D] rounds=${recorder.rounds.length} tools=${JSON.stringify(recorder.rounds.map((r) => r.tools))}`);
  console.log(`[D] content=${recorder.lastContent.slice(0, 400)}`);
});

test('场景 E 临时提问：回答进度，不自行取消原目标', async (t) => {
  if (!live) return t.skip('未开启真实 Provider 检查');
  const fx = await fixture();
  currentWorkspaceId = fx.workspaceId;
  currentSessionId = fx.sessionId;
  const { port, recorder } = livePort([['现在进度怎样？']]);
  const result = await askLiveWithRetry(fx, '先读一下 README 里有什么', { port, recorder });
  assert.equal(result.status, 'COMPLETED');
  assert.ok(recorder.rounds.length >= 2, '插话应让这一轮多跑一步');
  assert.deepEqual(recorder.rounds[1]?.steers, ['现在进度怎样？']);
  console.log(`[E] rounds=${recorder.rounds.length} content=${recorder.lastContent.slice(0, 400)}`);
});

test('场景 F 关系不清：不丢弃有效要求，等待期间不继续受影响动作', async (t) => {
  if (!live) return t.skip('未开启真实 Provider 检查');
  const fx = await fixture();
  currentWorkspaceId = fx.workspaceId;
  currentSessionId = fx.sessionId;
  const { port, recorder } = livePort([['看看启动失败']]);
  const result = await askLiveWithRetry(fx, '做登录页', { port, recorder });
  assert.equal(result.status, 'COMPLETED');
  assert.deepEqual(recorder.rounds[1]?.steers, ['看看启动失败']);
  // 软记录：真实模型此刻选择澄清还是分支处理，都如实留证；判定由人复核回答文本。
  console.log(`[F] rounds=${recorder.rounds.length} content=${recorder.lastContent.slice(0, 400)}`);
});

test('真实 Provider 不可用时明确记录外部阻塞，不用 Fake 冒充模型理解', async (t) => {
  if (live) return t.skip('真实 Provider 已配置');
  if (ENABLED) {
    assert.fail('RELAY_STEER_PROVIDER_CHECK=1 但真实 Provider 配置不可用：外部阻塞，不静默跳过');
  }
  t.diagnostic('RELAY_STEER_PROVIDER_CHECK 未开启：真实 Provider 检查未运行（外部阻塞需显式开启）');
});
