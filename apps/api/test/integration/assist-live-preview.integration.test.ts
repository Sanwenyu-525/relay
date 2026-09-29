import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';

import { sql } from 'kysely';

import { createAssistSession, requestAssistMessage }
  from '../../src/application/assist-commands.js';
import { runAssistGenerationTick } from '../../src/application/assist-runner.js';
import { createKnowledge } from '../../src/application/information-commands.js';
import { createRepositories, withTransaction } from '../../src/application/unit-of-work.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { ManagedContentStore } from '../../src/storage/managed-content-store.js';
import type { AssistModelPort, AssistRequest, AssistResult }
  from '../../src/workflow/fake-model-port.js';
import { FakeModelPort } from '../../src/workflow/fake-model-port.js';
import { createWorkspace, expectCommandAccepted, expectProblem,
  startTestApi, workspacePath, type TestApi } from './api-harness.js';
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
}

async function fixture() {
  const workspaceId = await createWorkspace(app.db);
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
    preview_truncated: false, preview_available: true });

  const model = gatedPort('首批文本🙂', '，后续内容');
  const generation = runAssistGenerationTick(app.db, { workerId: 'preview-worker',
    storage, modelPort: model.port, leaseMs: 30_000 });
  try {
    await model.firstPublished;
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
  const finalPreview = await api.get(path(f, messageId));
  assert.deepEqual(finalPreview.body, { session_id: f.sessionId, message_id: messageId,
    status: 'COMPLETED', preview_revision: '0', preview_text: null,
    preview_truncated: false, preview_available: false });
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

test('cancel hides the temporary text and terminal settlement removes it', async () => {
  const f = await fixture();
  const messageId = await request(f);
  const model = gatedPort('将取消的草稿', '不会展示');
  const generation = runAssistGenerationTick(app.db, { workerId: 'cancel-preview',
    storage, modelPort: model.port, leaseMs: 30_000 });
  try {
    await model.firstPublished;
    const cancelled = await api.post(workspacePath(f.workspaceId,
      `/assist-messages/${messageId}/cancel`), { command_id: randomUUID() });
    assert.equal(cancelled.status, 200, cancelled.text);
    const hidden = (await api.get(path(f, messageId))).body as Preview;
    assert.equal(hidden.preview_available, false);
    assert.equal(hidden.preview_text, null);
  } finally { model.release(); }
  assert.equal((await generation)?.status, 'CANCELLED');
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
  const next = await runAssistGenerationTick(app.db, { workerId: 'history-check',
    storage, modelPort: model.port, leaseMs: 30_000 });
  assert.equal(next?.messageId, nextId);
  assert.equal(next?.status, 'FAILED');
  assert.equal(next?.errorCode, 'ASSIST_HISTORY_SOURCE_UNAVAILABLE');
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
  const final = (await api.get(path(f, messageId))).body as Preview;
  assert.equal(final.preview_available, false);
  assert.equal(final.preview_text, null);
  const rows = await sql<{ count: string }>`select count(*)::text as count
    from assist_message_previews where message_id = ${messageId}`.execute(app.db);
  assert.equal(rows.rows[0]?.count, '0');
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
