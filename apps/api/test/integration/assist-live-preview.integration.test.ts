import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';

import { sql } from 'kysely';

import { createAssistSession, requestAssistMessage }
  from '../../src/application/assist-commands.js';
import { runAssistGenerationTick } from '../../src/application/assist-runner.js';
import { setMemorySettings } from '../../src/application/memory-settings.js';
import { createKnowledge } from '../../src/application/information-commands.js';
import { createRepositories, withTransaction } from '../../src/application/unit-of-work.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { ModelCallRepository } from '../../src/model/model-call-repository.js';
import { AssistRepository } from '../../src/assist/assist-repository.js';
import { AssistLivePreviewPublisher } from '../../src/assist/live-preview.js';
import { ManagedContentStore } from '../../src/storage/managed-content-store.js';
import type { AssistModelPort, AssistRequest, AssistResult, ModelUsage }
  from '../../src/workflow/fake-model-port.js';
import { FakeModelPort } from '../../src/workflow/fake-model-port.js';
import { createWorkspace, expectCommandAccepted, expectProblem,
  startTestApi, withTimeout, workspacePath, type TestApi } from './api-harness.js';
import { APP_DATABASE_URL, MIGRATIONS_DIRECTORY, MIGRATION_DATABASE_URL,
  openDatabase } from './integration-support.js';

const app = openDatabase(APP_DATABASE_URL, 'relay-api-test-assist-preview');
let api: TestApi;
let storage: ManagedContentStore;
before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL,
    directory: MIGRATIONS_DIRECTORY });
  api = await startTestApi();
  storage = new ManagedContentStore(api.dataRoot);
});
after(async () => { await api?.stop(); await app.close(); });

interface Preview {
  session_id: string; message_id: string; status: string;
  preview_revision: string; preview_text: string | null;
  preview_truncated: boolean; preview_available: boolean;
  usage: {
    state: 'ESTIMATED' | 'PARTIAL' | 'CONFIRMED' | 'UNKNOWN';
    input_tokens: number | null; output_tokens: number | null;
    cache_read_tokens: number | null; cache_creation_tokens: number | null;
    settled_calls: number; pending_calls: number; missing_usage_calls: number;
  } | null;
}

interface PreviewSseFrame { readonly id: string; readonly event: string; readonly data: Preview }

/** Open the assist live-preview SSE endpoint; frames carry the full GET-shaped DTO (contract §10.59). */
async function openPreviewStream(f: { workspaceId: string; sessionId: string }, messageId: string,
  bearer = `Bearer ${api.bearerToken}`) {
  const controller = new AbortController();
  const response = await fetch(`http://127.0.0.1:${api.port}${workspacePath(f.workspaceId,
    `/assist-sessions/${f.sessionId}/messages/${messageId}/live-preview/events`)}`, {
    headers: { Authorization: bearer, Accept: 'text/event-stream' }, signal: controller.signal });
  assert.ok(response.body, 'preview SSE response must have a body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  return {
    status: response.status,
    next: async (): Promise<PreviewSseFrame> => withTimeout((async () => {
      while (true) {
        const end = pending.indexOf('\n\n');
        if (end >= 0) {
          const frame = pending.slice(0, end);
          pending = pending.slice(end + 2);
          if (frame.startsWith(':')) continue;
          const id = frame.split('\n').find((line) => line.startsWith('id: '))?.slice(4);
          const event = frame.split('\n').find((line) => line.startsWith('event: '))?.slice(7);
          const data = frame.split('\n').find((line) => line.startsWith('data: '))?.slice(6);
          assert.ok(id && event && data, `incomplete preview frame: ${frame}`);
          return { id, event, data: JSON.parse(data) as Preview };
        }
        const chunk = await reader.read();
        if (chunk.done) throw new Error('preview SSE closed before the expected frame');
        pending += decoder.decode(chunk.value, { stream: true });
      }
    })(), 10_000, 'preview SSE frame'),
    expectClosed: async (): Promise<void> => withTimeout((async () => {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) { assert.equal(pending, ''); return; }
        pending += decoder.decode(chunk.value, { stream: true });
      }
    })(), 10_000, 'preview SSE close'),
    close: async () => { controller.abort(); await reader.cancel().catch(() => undefined); },
  };
}

async function fixture() {
  const workspaceId = await createWorkspace(app.db);
  // 本套件只观察回复调用的预览时序；自动记忆的独立调用由其集成套件覆盖。
  await setMemorySettings(app.db, { workspaceId, commandId: randomUUID(), expectedRevision: '0',
    recallEnabled: true, automaticCompaction: true, autoCapture: false });
  const projectCommand = randomUUID();
  const created = expectCommandAccepted(await api.post(workspacePath(workspaceId,
    '/projects'), { command_id: projectCommand, title: 'Live Assist',
    project_type: 'GENERAL' }), 201, projectCommand);
  const projectId = created.project_id as string;
  const session = await createAssistSession(app.db, { workspaceId, projectId,
    commandId: randomUUID(), title: 'Live discussion' });
  return { workspaceId, projectId, sessionId: session.result.session_id };
}

async function request(f: Awaited<ReturnType<typeof fixture>>, input: {
  intent?: 'DISCUSS' | 'PROPOSE_CANDIDATE' | 'PROPOSE_TASK';
  sourceRefs?: readonly { kind: 'KNOWLEDGE'; root_id: string; version: string }[];
} = {}) {
  const result = await requestAssistMessage(app.db, { workspaceId: f.workspaceId,
    sessionId: f.sessionId, commandId: randomUUID(), content: '请说明当前情况',
    ...(input.intent === undefined ? {} : { intent: input.intent }),
    ...(input.sourceRefs === undefined ? {} : { sourceRefs: input.sourceRefs }) });
  return result.result.assistant_message_id;
}

function path(f: Awaited<ReturnType<typeof fixture>>, messageId: string): string {
  return workspacePath(f.workspaceId,
    `/assist-sessions/${f.sessionId}/messages/${messageId}/live-preview`);
}

async function firstTimes(messageId: string) {
  const calls = await new ModelCallRepository(app.db).listForAssistMessage(messageId);
  assert.equal(calls.length, 1);
  return { call: calls[0]!, times: [calls[0]!.first_text_delta_at?.toISOString() ?? null,
    calls[0]!.first_preview_persisted_at?.toISOString() ?? null] };
}

function gatedPort(first: string, second: string) {
  let release!: () => void;
  let published!: () => void;
  const firstPublished = new Promise<void>((resolve) => { published = resolve; });
  const proceed = new Promise<void>((resolve) => { release = resolve; });
  let invocationCount = 0;
  const port: AssistModelPort = {
    identity: new FakeModelPort().identity,
    async assist(input: AssistRequest): Promise<AssistResult> {
      invocationCount += 1;
      await input.onTextDelta?.(first);
      published();
      await proceed;
      if (input.signal?.aborted) return { kind: 'CANCELLED' };
      await input.onTextDelta?.(second);
      return { kind: 'CONTENT', content: first + second,
        providerRequestId: 'controlled-preview',
        usage: { inputTokens: 1, outputTokens: 2 } };
    },
  };
  return { port, firstPublished, release, get invocationCount() { return invocationCount; } };
}

test('a separate API process reads the first DISCUSS increment before full settlement and reconnects by revision', async () => {
  const f = await fixture();
  const messageId = await request(f);
  const beforeRun = await api.get(path(f, messageId));
  assert.equal(beforeRun.status, 200, beforeRun.text);
  assert.deepEqual(beforeRun.body, { session_id: f.sessionId, message_id: messageId,
    status: 'PENDING', preview_revision: '0', preview_text: null,
    preview_truncated: false, preview_available: true,
    // 还没有任何调用：读数对象存在但状态是 UNKNOWN，不是 0 也不是伪造的精确值。
    usage: { state: 'UNKNOWN', input_tokens: null, output_tokens: null,
      cache_read_tokens: null, cache_creation_tokens: null,
      settled_calls: 0, pending_calls: 0, missing_usage_calls: 0 } });

  const model = gatedPort('首批文本🙂', '，后续内容');
  const generation = runAssistGenerationTick(app.db, { workerId: 'preview-worker',
    storage, modelPort: model.port, leaseMs: 30_000 });
  let initialTimes!: (string | null)[];
  try {
    await model.firstPublished;
    const first = await firstTimes(messageId);
    assert.ok(first.times.every((time) => time !== null));
    initialTimes = first.times;
    const calls = new ModelCallRepository(app.db);
    await calls.recordFirstTextDelta(first.call.id, new Date(Date.now() + 60_000));
    await calls.recordFirstPreviewPersisted(first.call.id);
    assert.deepEqual((await firstTimes(messageId)).times, initialTimes);
    const live = await api.get(path(f, messageId));
    assert.equal(live.status, 200, live.text);
    const snapshot = live.body as Preview;
    assert.equal(snapshot.status, 'RUNNING');
    assert.equal(snapshot.preview_text, '首批文本🙂');
    assert.equal(snapshot.preview_revision, '1');
    assert.equal(snapshot.preview_available, true);
    assert.equal(live.headers['cache-control'], 'no-store');
    const reconnect = await api.get(path(f, messageId));
    assert.deepEqual(reconnect.body, live.body);

    const other = await fixture();
    expectProblem(await api.get(workspacePath(other.workspaceId,
      `/assist-sessions/${f.sessionId}/messages/${messageId}/live-preview`)),
    404, 'RESOURCE_NOT_FOUND');
    expectProblem(await api.get(workspacePath(f.workspaceId,
      `/assist-sessions/${other.sessionId}/messages/${messageId}/live-preview`)),
    404, 'RESOURCE_NOT_FOUND');
    expectProblem(await api.get(workspacePath(f.workspaceId,
      `/assist-sessions/${f.sessionId}/messages/${randomUUID()}/live-preview`)),
    404, 'RESOURCE_NOT_FOUND');
    assert.equal((await api.get(path(f, messageId), { headers: {
      authorization: 'Bearer wrong' } })).status, 401);
  } finally { model.release(); }
  assert.equal((await generation)?.status, 'COMPLETED');
  assert.deepEqual((await firstTimes(messageId)).times, initialTimes);
  const finalPreview = await api.get(path(f, messageId));
  assert.deepEqual(finalPreview.body, { session_id: f.sessionId, message_id: messageId,
    status: 'COMPLETED', preview_revision: '0', preview_text: null,
    preview_truncated: false, preview_available: false, usage: null });
  const rows = await sql<{ count: string }>`select count(*)::text as count
    from assist_message_previews where message_id = ${messageId}`.execute(app.db);
  assert.equal(rows.rows[0]?.count, '0');
  const messages = await api.get(workspacePath(f.workspaceId,
    `/assist-sessions/${f.sessionId}/messages`));
  assert.equal(messages.status, 200, messages.text);
  const final = (messages.body as { items: { id: string; content: string | null }[] })
    .items.find((item) => item.id === messageId);
  assert.equal(final?.content, '首批文本🙂，后续内容');
});

for (const prefix of ['', '```json\n', '说明文字\n'])
test(`Agent reply envelopes stream safely with prefix ${JSON.stringify(prefix)}`, async () => {
  const f = await fixture();
  const messageId = await request(f);
  const model = gatedPort(prefix + '{"reply":"安全正文',
    '","execution":null,"maintenance":null}' + (prefix.startsWith('```') ? '\n```' : ''));
  const generation = runAssistGenerationTick(app.db, { workerId: 'envelope-preview',
    storage, modelPort: model.port, leaseMs: 30_000 });
  try {
    await model.firstPublished;
    const live = await api.get(path(f, messageId));
    assert.equal((live.body as Preview).preview_text, prefix === '说明文字\n' ? prefix : '安全正文');
    const { times } = await firstTimes(messageId);
    assert.ok(times[0] !== null, '首文本应当计时，即使它属于结构化协议');
    assert.ok(times[1] !== null, '回复正文增量已经持久化');
  } finally { model.release(); }
  assert.equal((await generation)?.status, 'COMPLETED');
  assert.equal((await createRepositories(app.db).assist.readMessage(messageId))?.content, '安全正文');
});

test('cancel hides the temporary text and terminal settlement removes it', async () => {
  const f = await fixture();
  const messageId = await request(f);
  const model = gatedPort('将取消的草稿', '不会展示');
  const generation = runAssistGenerationTick(app.db, { workerId: 'cancel-preview',
    storage, modelPort: model.port, leaseMs: 30_000 });
  let initialTimes!: (string | null)[];
  try {
    await model.firstPublished;
    initialTimes = (await firstTimes(messageId)).times;
    assert.ok(initialTimes.every((time) => time !== null));
    const cancelled = await api.post(workspacePath(f.workspaceId,
      `/assist-messages/${messageId}/cancel`), { command_id: randomUUID() });
    assert.equal(cancelled.status, 200, cancelled.text);
    const hidden = (await api.get(path(f, messageId))).body as Preview;
    assert.equal(hidden.preview_available, false);
    assert.equal(hidden.preview_text, null);
  } finally { model.release(); }
  assert.equal((await generation)?.status, 'CANCELLED');
  assert.deepEqual((await firstTimes(messageId)).times, initialTimes);
  const final = (await api.get(path(f, messageId))).body as Preview;
  assert.equal(final.status, 'CANCELLED');
  assert.equal(final.preview_text, null);
  const rows = await sql<{ count: string }>`select count(*)::text as count
    from assist_message_previews where message_id = ${messageId}`.execute(app.db);
  assert.equal(rows.rows[0]?.count, '0');
});

test('a Provider failure after a visible fragment clears the draft without a completed message', async () => {
  const f = await fixture();
  const messageId = await request(f);
  let release!: () => void;
  let published!: () => void;
  const proceed = new Promise<void>((resolve) => { release = resolve; });
  const firstPublished = new Promise<void>((resolve) => { published = resolve; });
  const modelPort: AssistModelPort = {
    identity: new FakeModelPort().identity,
    async assist(input: AssistRequest): Promise<AssistResult> {
      await input.onTextDelta?.('尚未验证的片段');
      published();
      await proceed;
      throw new Error('controlled Provider failure');
    },
  };
  const generation = runAssistGenerationTick(app.db, { workerId: 'failed-preview',
    storage, modelPort, leaseMs: 30_000 });
  try {
    await firstPublished;
    assert.equal(((await api.get(path(f, messageId))).body as Preview).preview_text,
      '尚未验证的片段');
  } finally { release(); }
  assert.equal((await generation)?.status, 'FAILED');
  const final = (await api.get(path(f, messageId))).body as Preview;
  assert.equal(final.status, 'FAILED');
  assert.equal(final.preview_available, false);
  assert.equal(final.preview_text, null);
  const rows = await sql<{ count: string }>`select count(*)::text as count
    from assist_message_previews where message_id = ${messageId}`.execute(app.db);
  assert.equal(rows.rows[0]?.count, '0');
});

test('source revocation masks live and completed text, and a later DISCUSS cannot reuse that history', async () => {
  const f = await fixture();
  const knowledge = await createKnowledge(app.db, { workspaceId: f.workspaceId,
    projectId: f.projectId, commandId: randomUUID(), title: 'Sensitive source',
    source: { sourceKind: 'NOTE', text: 'Only while available' } });
  const rootId = knowledge.result.knowledge_id!;
  const messageId = await request(f, { sourceRefs: [{ kind: 'KNOWLEDGE',
    root_id: rootId, version: '1' }] });
  const model = gatedPort('依据敏感来源的首批内容', '，完整回复');
  const generation = runAssistGenerationTick(app.db, { workerId: 'revoked-preview',
    storage, modelPort: model.port, leaseMs: 30_000 });
  try {
    await model.firstPublished;
    assert.equal((await api.get(path(f, messageId))).body &&
      ((await api.get(path(f, messageId))).body as Preview).preview_available, true);
    await withTransaction(app.db, async (r) => {
      await r.information.setRootStatus('knowledge', rootId, 'ARCHIVED');
    });
    const hidden = (await api.get(path(f, messageId))).body as Preview;
    assert.equal(hidden.preview_available, false);
    assert.equal(hidden.preview_text, null);
    assert.equal(hidden.preview_revision, '0');
  } finally { model.release(); }
  assert.equal((await generation)?.status, 'COMPLETED');
  const messages = await api.get(workspacePath(f.workspaceId,
    `/assist-sessions/${f.sessionId}/messages`));
  assert.equal(messages.status, 200, messages.text);
  const hiddenFinal = (messages.body as { items: { id: string; content: string | null;
    sources: unknown }[] }).items.find((item) => item.id === messageId);
  assert.equal(hiddenFinal?.content, null);
  assert.ok(!JSON.stringify(hiddenFinal).includes(rootId));
  const nextId = await request(f);
  const nextRequests: AssistRequest[] = [];
  const safePort: AssistModelPort = { identity: model.port.identity, assist: async (input) => {
    nextRequests.push(input);
    return new FakeModelPort().assist(input);
  } };
  const next = await runAssistGenerationTick(app.db, { workerId: 'history-check',
    storage, modelPort: safePort, leaseMs: 30_000 });
  assert.equal(next?.messageId, nextId);
  assert.equal(next?.status, 'COMPLETED');
  assert.equal(nextRequests.length, 1);
  assert.ok(!JSON.stringify(nextRequests).includes('依据敏感来源的首批内容'));
  assert.ok(!JSON.stringify(nextRequests).includes('Only while available'));
  assert.ok(!JSON.stringify(nextRequests).includes(rootId));
  assert.equal(model.invocationCount, 1);
});

test('structured proposals never expose raw JSON through the preview endpoint', async () => {
  const f = await fixture();
  const messageId = await request(f, { intent: 'PROPOSE_TASK' });
  const pending = (await api.get(path(f, messageId))).body as Preview;
  assert.equal(pending.preview_available, false);
  const result = await runAssistGenerationTick(app.db, { workerId: 'proposal-no-preview',
    storage, modelPort: new FakeModelPort(), leaseMs: 30_000 });
  assert.equal(result?.status, 'COMPLETED');
  assert.deepEqual((await firstTimes(messageId)).times, [null, null]);
  const final = (await api.get(path(f, messageId))).body as Preview;
  assert.equal(final.preview_available, false);
  assert.equal(final.preview_text, null);
  const rows = await sql<{ count: string }>`select count(*)::text as count
    from assist_message_previews where message_id = ${messageId}`.execute(app.db);
  assert.equal(rows.rows[0]?.count, '0');
});

test('before-first-text failure, cancel and expired Worker cannot invent output times', async () => {
  for (const scenario of ['failure', 'cancel', 'expired'] as const) {
    const f = await fixture();
    const messageId = await request(f);
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const proceed = new Promise<void>((resolve) => { release = resolve; });
    const modelPort: AssistModelPort = {
      identity: new FakeModelPort().identity,
      async assist(input) {
        await input.onTextDelta?.('');
        entered();
        await proceed;
        if (scenario === 'failure') throw new Error('controlled failure before text');
        await input.onTextDelta?.('late text after losing the claim');
        return { kind: 'CONTENT', content: 'late text', providerRequestId: 'late-preview',
          usage: { inputTokens: null, outputTokens: null } };
      },
    };
    const generation = runAssistGenerationTick(app.db, { workerId: `before-${scenario}`,
      storage, modelPort, leaseMs: 30_000 });
    try {
      await started;
      assert.deepEqual((await firstTimes(messageId)).times, [null, null]);
      if (scenario === 'cancel') {
        assert.equal((await api.post(workspacePath(f.workspaceId,
          `/assist-messages/${messageId}/cancel`), { command_id: randomUUID() })).status, 200);
      } else if (scenario === 'expired') {
        assert.ok((await createRepositories(app.db).assist.failExpiredLeases(
          new Date(Date.now() + 60_000))).includes(messageId));
      }
    } finally { release(); }
    const result = await generation;
    assert.equal(result?.status, scenario === 'failure' ? 'FAILED' :
      scenario === 'cancel' ? 'CANCELLED' : 'DISCARDED');
    assert.deepEqual((await firstTimes(messageId)).times, [null, null]);
    assert.equal(((await api.get(path(f, messageId))).body as Preview).preview_text, null);
  }
});

test('final buffered flush preserves times and a timing write failure rolls back its preview', async () => {
  for (const scenario of ['flush', 'failure'] as const) {
    const f = await fixture();
    const messageId = await request(f);
    const originalInterval = AssistLivePreviewPublisher.MIN_FLUSH_MS;
    const originalWrite = AssistRepository.prototype.writeLivePreview;
    const originalTime = ModelCallRepository.prototype.recordFirstPreviewPersisted;
    let completedWrites = 0;
    // Force the second fragment to buffer until the runner's existing final
    // flush. This controls scheduling; it is not a performance threshold.
    Object.defineProperty(AssistLivePreviewPublisher, 'MIN_FLUSH_MS', { value: Infinity });
    AssistRepository.prototype.writeLivePreview = async function (...args) {
      if ((await firstTimes(messageId)).call.status === 'COMPLETED') completedWrites += 1;
      return originalWrite.apply(this, args);
    };
    if (scenario === 'failure') {
      ModelCallRepository.prototype.recordFirstPreviewPersisted = async () => {
        throw new TypeError('TOP_SECRET_TIMING_FAILURE');
      };
    }
    const modelPort: AssistModelPort = {
      identity: new FakeModelPort().identity,
      async assist(input) {
        await input.onTextDelta?.('first');
        await input.onTextDelta?.(' tail');
        return { kind: 'CONTENT', content: 'first tail', providerRequestId: 'buffered-preview',
          usage: { inputTokens: 1, outputTokens: 2 } };
      },
    };
    try {
      const result = await runAssistGenerationTick(app.db, { workerId: `timing-${scenario}`,
        storage, modelPort, leaseMs: 30_000 });
      assert.equal(result?.status, scenario === 'flush' ? 'COMPLETED' : 'FAILED');
      const recorded = await firstTimes(messageId);
      assert.ok(recorded.call.first_text_delta_at);
      if (scenario === 'flush') {
        assert.equal(completedWrites, 0, '主循环在模型调用结算前刷新缓冲预览');
        assert.ok(recorded.call.first_preview_persisted_at);
        assert.equal(recorded.call.status, 'COMPLETED');
      } else {
        assert.equal(recorded.call.status, 'FAILED');
        assert.equal(recorded.call.first_preview_persisted_at, null);
      }
      assert.equal((await sql`select message_id from assist_message_previews
        where message_id = ${messageId}`.execute(app.db)).rows.length, 0);
    } finally {
      Object.defineProperty(AssistLivePreviewPublisher, 'MIN_FLUSH_MS', { value: originalInterval });
      AssistRepository.prototype.writeLivePreview = originalWrite;
      ModelCallRepository.prototype.recordFirstPreviewPersisted = originalTime;
    }
  }
});

test('expired generation lease clears an in-flight preview before a stale Worker can publish again', async () => {
  const f = await fixture();
  const messageId = await request(f);
  const model = gatedPort('旧 Worker 草稿', ' 不可续写');
  const generation = runAssistGenerationTick(app.db, { workerId: 'lost-preview',
    storage, modelPort: model.port, leaseMs: 30_000 });
  try {
    await model.firstPublished;
    const failed = await createRepositories(app.db).assist.failExpiredLeases(
      new Date(Date.now() + 60_000));
    assert.ok(failed.includes(messageId));
    const hidden = (await api.get(path(f, messageId))).body as Preview;
    assert.equal(hidden.status, 'FAILED');
    assert.equal(hidden.preview_text, null);
    assert.equal(hidden.preview_available, false);
  } finally { model.release(); }
  assert.equal((await generation)?.status, 'DISCARDED');
  const rows = await sql<{ count: string }>`select count(*)::text as count
    from assist_message_previews where message_id = ${messageId}`.execute(app.db);
  assert.equal(rows.rows[0]?.count, '0');
});

test('SSE assist_preview pushes the GET DTO, re-pushes on reconnect and closes at terminal settlement', async () => {
  const f = await fixture();
  const messageId = await request(f);
  const model = gatedPort('首批文本🙂', '，后续内容');
  const generation = runAssistGenerationTick(app.db, { workerId: 'sse-preview',
    storage, modelPort: model.port, leaseMs: 30_000 });
  let stream: Awaited<ReturnType<typeof openPreviewStream>> | undefined;
  try {
    await model.firstPublished; // first committed prefix exists before we connect
    stream = await openPreviewStream(f, messageId);
    assert.equal(stream.status, 200);
    const first = await stream.next();
    const snapshot = (await api.get(path(f, messageId))).body as Preview;
    assert.equal(first.event, 'assist_preview');
    assert.equal(first.id, snapshot.preview_revision);
    assert.deepEqual(first.data, snapshot);
    assert.equal(snapshot.preview_text, '首批文本🙂');
    // No after/Last-Event-ID: a fresh connection re-pushes the current full snapshot.
    const again = await openPreviewStream(f, messageId);
    try {
      const replay = await again.next();
      assert.equal(replay.id, snapshot.preview_revision);
      assert.deepEqual(replay.data, snapshot);
    } finally { await again.close(); }
    // Foreign workspace fails before the stream is upgraded.
    const other = await fixture();
    const denied = await openPreviewStream({ workspaceId: other.workspaceId,
      sessionId: f.sessionId }, messageId);
    assert.equal(denied.status, 404);
    await denied.close();
    // Release the gated generation: settlement deletes the row and the next
    // reauthorized read is terminal, so the server sends it and ends the stream.
    model.release();
    let last = await stream.next();
    while (last.data.status === 'PENDING' || last.data.status === 'RUNNING') {
      last = await stream.next();
    }
    assert.equal(last.data.status, 'COMPLETED');
    assert.equal(last.data.preview_available, false);
    assert.equal(last.data.preview_text, null);
    await stream.expectClosed();
  } finally {
    model.release();
    await stream?.close();
  }
  assert.equal((await generation)?.status, 'COMPLETED');
  assert.equal(((await api.get(path(f, messageId))).body as Preview).status, 'COMPLETED');
});

interface UsageSummary {
  state: 'ESTIMATED' | 'PARTIAL' | 'CONFIRMED' | 'UNKNOWN';
  input_tokens: number | null; output_tokens: number | null;
  cache_read_tokens: number | null; cache_creation_tokens: number | null;
  settled_calls: number; pending_calls: number; missing_usage_calls: number;
}

function messagePath(f: { workspaceId: string; sessionId: string }): string {
  return workspacePath(f.workspaceId, `/assist-sessions/${f.sessionId}/messages`);
}

function summaryOf(items: readonly { readonly id: string;
  readonly usage_summary: UsageSummary }[], messageId: string): UsageSummary {
  const found = items.find((item) => item.id === messageId);
  assert.ok(found, 'message row must be present');
  return found.usage_summary;
}

/** 可控用量端口：先发布一帧估算，再等测试读完预览，最后返回真实用量。 */
function usageGatedPort(input: { text: string; finalUsage: ModelUsage;
  estimate: { input: number; output: number; providerInput?: number | null;
    providerOutput?: number | null } }) {
  let release!: () => void;
  let published!: () => void;
  const proceed = new Promise<void>((resolve) => { release = resolve; });
  const firstPublished = new Promise<void>((resolve) => { published = resolve; });
  const port: AssistModelPort = {
    identity: new FakeModelPort().identity,
    async assist(request: AssistRequest): Promise<AssistResult> {
      await request.onUsageProgress?.({ inputTokensEstimate: input.estimate.input,
        outputTokensEstimate: input.estimate.output,
        providerUsage: { inputTokens: input.estimate.providerInput ?? null,
          outputTokens: input.estimate.providerOutput ?? null,
          cacheReadTokens: null, cacheCreationTokens: null } });
      published();
      await proceed;
      if (request.signal?.aborted) return { kind: 'CANCELLED' };
      await request.onTextDelta?.(input.text);
      return { kind: 'CONTENT', content: input.text,
        providerRequestId: 'usage-fixture-call', usage: input.finalUsage };
    },
  };
  return { port, firstPublished, release };
}

test('生成中的估算随预览读取可见，结算后以 model_calls 账本校准且不重复累计', async () => {
  const f = await fixture();
  const messageId = await request(f);
  const model = usageGatedPort({ text: '用量测试正文', estimate: { input: 1_000, output: 0,
    providerInput: 1_100 },
    finalUsage: { inputTokens: 1_200, outputTokens: 480,
      cacheReadTokens: 200, cacheCreationTokens: 30 } });
  const generation = runAssistGenerationTick(app.db, { workerId: 'usage-preview',
    storage, modelPort: model.port, leaseMs: 30_000 });
  try {
    await model.firstPublished;
    const live = (await api.get(path(f, messageId))).body as Preview;
    assert.equal(live.preview_available, true);
    assert.ok(live.usage, 'running generation must expose a usage projection');
    assert.equal(live.usage.state, 'ESTIMATED');
    // Provider 已上报的输入替换估算；输出尚未上报，仍按估算显示。
    assert.equal(live.usage.input_tokens, 1_100);
    assert.equal(live.usage.output_tokens, 0);
    assert.equal(live.usage.settled_calls, 0);
    assert.equal(live.usage.pending_calls, 1);
    const usageRow = (await sql<{ usage: unknown }>`select usage from assist_message_previews
      where message_id = ${messageId}`.execute(app.db)).rows[0];
    assert.ok(usageRow?.usage, '估算只存在可丢弃预览行上');
  } finally { model.release(); }
  assert.equal((await generation)?.status, 'COMPLETED');
  const messages = (await api.get(messagePath(f)))
    .body as { items: { id: string; usage_summary: UsageSummary }[] };
  const summary = summaryOf(messages.items, messageId);
  assert.equal(summary.state, 'CONFIRMED');
  assert.equal(summary.input_tokens, 1_200);
  assert.equal(summary.output_tokens, 480);
  assert.equal(summary.cache_read_tokens, 200);
  assert.equal(summary.cache_creation_tokens, 30);
  assert.equal(summary.settled_calls, 1);
  assert.equal(summary.pending_calls, 0);
  assert.equal(summary.missing_usage_calls, 0);
  // 账本只结算一次：没有因为「估算 + 结算」出现第二行或二次累计。
  const calls = await new ModelCallRepository(app.db).listForAssistMessage(messageId);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.usage_input_tokens, 1_200);
  // 结算删除预览行，迟到的同一 Worker 写不进新读数。
  assert.equal((await sql`select message_id from assist_message_previews
    where message_id = ${messageId}`.execute(app.db)).rows.length, 0);
  const late = await createRepositories(app.db).assist.writeLiveUsage(messageId, 'usage-preview',
    { call_id: calls[0]!.id, input_tokens_estimate: 1, output_tokens_estimate: 1 });
  assert.equal(late, false, 'stale usage frames must not resurrect a settled preview');
});

test('Provider 不上报用量时保持未知，估算不冒充最终精确值', async () => {
  const f = await fixture();
  const messageId = await request(f);
  const model = usageGatedPort({ text: '没有上报用量', estimate: { input: 900, output: 0 },
    finalUsage: { inputTokens: null, outputTokens: null,
      cacheReadTokens: null, cacheCreationTokens: null } });
  const generation = runAssistGenerationTick(app.db, { workerId: 'usage-unknown',
    storage, modelPort: model.port, leaseMs: 30_000 });
  try {
    await model.firstPublished;
    const live = (await api.get(path(f, messageId))).body as Preview;
    assert.equal(live.usage?.state, 'ESTIMATED');
    assert.equal(live.usage?.input_tokens, 900);
  } finally { model.release(); }
  assert.equal((await generation)?.status, 'COMPLETED');
  const messages = (await api.get(messagePath(f)))
    .body as { items: { id: string; usage_summary: UsageSummary }[] };
  const summary = summaryOf(messages.items, messageId);
  assert.equal(summary.state, 'UNKNOWN');
  assert.equal(summary.input_tokens, null);
  assert.equal(summary.output_tokens, null);
  assert.equal(summary.settled_calls, 1);
  assert.equal(summary.missing_usage_calls, 1);
});

test('记忆提取等辅助外呼不并入用户可见的本轮用量', async () => {
  const f = await fixture();
  const messageId = await request(f);
  const model = usageGatedPort({ text: '主调用正文', estimate: { input: 800, output: 0 },
    finalUsage: { inputTokens: 900, outputTokens: 120,
      cacheReadTokens: null, cacheCreationTokens: null } });
  const generation = runAssistGenerationTick(app.db, { workerId: 'usage-aux',
    storage, modelPort: model.port, leaseMs: 30_000 });
  model.release();
  await generation;
  const before = (await api.get(messagePath(f)))
    .body as { items: { id: string; usage_summary: UsageSummary }[] };
  assert.equal(summaryOf(before.items, messageId).input_tokens, 900);
  // 同一条 assistant message 上再挂一次 MEMORY_CAPTURE 外呼；它不是这一轮的消耗。
  const auxiliaryId = randomUUID();
  await new ModelCallRepository(app.db).begin(auxiliaryId,
    { workspaceId: f.workspaceId, kind: 'ASSIST', assistMessageId: messageId,
      purpose: 'MEMORY_CAPTURE' }, new FakeModelPort().identity);
  await new ModelCallRepository(app.db).settle(auxiliaryId, { status: 'COMPLETED',
    providerRequestId: 'auxiliary-call', usage: { inputTokens: 30_000,
      outputTokens: 500, cacheReadTokens: null, cacheCreationTokens: null } });
  const after = (await api.get(messagePath(f)))
    .body as { items: { id: string; usage_summary: UsageSummary }[] };
  const summary = summaryOf(after.items, messageId);
  assert.equal(summary.input_tokens, 900);
  assert.equal(summary.output_tokens, 120);
  assert.equal(summary.settled_calls, 1);
});

test('工具续轮的多轮调用逐次累计：已结算 + 在途估算合并，结算后账本优先', async () => {
  const f = await fixture();
  const messageId = await request(f);
  const workerId = 'usage-rounds';
  const assist = createRepositories(app.db).assist;
  assert.equal(await assist.claimPendingMessage(messageId, workerId), true);
  const calls = new ModelCallRepository(app.db);
  const identity = new FakeModelPort().identity;
  const firstId = randomUUID();
  await calls.begin(firstId, { workspaceId: f.workspaceId, kind: 'ASSIST',
    assistMessageId: messageId }, identity);
  await calls.settle(firstId, { status: 'COMPLETED', providerRequestId: 'round-1',
    usage: { inputTokens: 1_000, outputTokens: 100,
      cacheReadTokens: null, cacheCreationTokens: null } });
  const secondId = randomUUID();
  await calls.begin(secondId, { workspaceId: f.workspaceId, kind: 'ASSIST',
    assistMessageId: messageId }, identity);
  await assist.writeLiveUsage(messageId, workerId, { call_id: secondId,
    input_tokens_estimate: 2_000, output_tokens_estimate: 120,
    provider_input_tokens: null, provider_output_tokens: null,
    provider_cache_read_tokens: null, provider_cache_creation_tokens: null });
  const live = (await api.get(path(f, messageId))).body as Preview;
  assert.equal(live.usage?.state, 'PARTIAL');
  // 第二轮输入是新请求的完整上下文，第一轮输入已经发生：逐次累计而不是取最大值。
  assert.equal(live.usage?.input_tokens, 3_000);
  assert.equal(live.usage?.output_tokens, 220);
  assert.equal(live.usage?.settled_calls, 1);
  assert.equal(live.usage?.pending_calls, 1);
  await calls.settle(secondId, { status: 'COMPLETED', providerRequestId: 'round-2',
    usage: { inputTokens: 2_400, outputTokens: 160,
      cacheReadTokens: null, cacheCreationTokens: null } });
  // 预览行可能还留着第二轮旧估算；读侧只看 STARTED 的估算，结算后账本优先。
  const settledPreview = (await api.get(path(f, messageId))).body as Preview;
  assert.equal(settledPreview.usage?.state, 'CONFIRMED');
  assert.equal(settledPreview.usage?.input_tokens, 3_400);
  assert.equal(settledPreview.usage?.output_tokens, 260);
  assert.equal(settledPreview.usage?.settled_calls, 2);
  await assist.settleGeneration({ messageId, workerId, status: 'COMPLETED',
    content: '两轮工具续轮后的回复', errorCode: null, providerRequestId: 'round-2',
    usageInputTokens: 3_400, usageOutputTokens: 260,
    usageCacheReadTokens: null, usageCacheCreationTokens: null });
  const messages = (await api.get(messagePath(f)))
    .body as { items: { id: string; usage_summary: UsageSummary }[] };
  const summary = summaryOf(messages.items, messageId);
  assert.equal(summary.state, 'CONFIRMED');
  assert.equal(summary.input_tokens, 3_400);
  assert.equal(summary.output_tokens, 260);
  assert.equal(summary.settled_calls, 2);
});

test('SSE 在首个估算到达后就推送用量，不必等待正文', async () => {
  const f = await fixture();
  const messageId = await request(f);
  const model = usageGatedPort({ text: '稍后才有正文', estimate: { input: 700, output: 0 },
    finalUsage: { inputTokens: 760, outputTokens: 90,
      cacheReadTokens: null, cacheCreationTokens: null } });
  const generation = runAssistGenerationTick(app.db, { workerId: 'usage-sse',
    storage, modelPort: model.port, leaseMs: 30_000 });
  let stream: Awaited<ReturnType<typeof openPreviewStream>> | undefined;
  try {
    await model.firstPublished;
    stream = await openPreviewStream(f, messageId);
    const first = await stream.next();
    assert.equal(first.data.preview_text, null, '正文还没到');
    assert.equal(first.data.usage?.state, 'ESTIMATED');
    assert.equal(first.data.usage?.input_tokens, 700);
  } finally {
    model.release();
    await stream?.close();
  }
  assert.equal((await generation)?.status, 'COMPLETED');
});
