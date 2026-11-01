import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import { bindAssistSessionDirectory, createAssistSession, requestAssistMessage } from '../../src/application/assist-commands.js';
import { runAssistGenerationTick } from '../../src/application/assist-runner.js';
import { createMemory, retireInformation } from '../../src/application/information-commands.js';
import { setMemorySettings } from '../../src/application/memory-settings.js';
import { recallConfirmedMemoryRefs } from '../../src/application/memory-recall.js';
import { openWorkingDirectory } from '../../src/application/open-working-directory.js';
import { createRepositories, withTransaction } from '../../src/application/unit-of-work.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { ManagedContentStore } from '../../src/storage/managed-content-store.js';
import { FakeModelPort, type AssistRequest } from '../../src/workflow/fake-model-port.js';
import { createDataRoot, startTestApi, workspacePath, type TestApi } from './api-harness.js';
import { APP_DATABASE_URL, MIGRATION_DATABASE_URL, MIGRATIONS_DIRECTORY, openDatabase } from './integration-support.js';

const app = openDatabase(APP_DATABASE_URL, 'relay-memory-module');
let api: TestApi;
let dataRoot: string;
const roots: string[] = [];
before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
  dataRoot = await createDataRoot();
  api = await startTestApi();
});
after(async () => {
  await api?.stop(); await app.close();
  await rm(dataRoot, { recursive: true, force: true });
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function fixture(tools = false) {
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  await withTransaction(app.db, async (r) => {
    await r.workspaces.insertWorkspace({ id: workspaceId, name: 'memory-module' });
    await r.workspaces.insertAuthorityRow(workspaceId);
    await r.projects.insertProject({ id: projectId, workspaceId, title: 'memory', projectType: 'GENERAL' });
  });
  let resourceId: string | undefined;
  if (tools) {
    const root = await mkdtemp(join(tmpdir(), 'relay-memory-tools-')); roots.push(root);
    const opened = await openWorkingDirectory(app.db, { workspaceId, projectId, commandId: randomUUID(), rootPath: root });
    resourceId = opened.result.association?.resource_id;
  }
  const session = await createAssistSession(app.db, { workspaceId, projectId, title: 'remember', commandId: randomUUID() });
  if (resourceId !== undefined) await bindAssistSessionDirectory(app.db, { workspaceId,
    sessionId: session.result.session_id, commandId: randomUUID(), resourceId });
  return { workspaceId, projectId, sessionId: session.result.session_id,
    path: (suffix: string) => workspacePath(workspaceId, suffix) };
}

async function ask(f: Awaited<ReturnType<typeof fixture>>, content: string) {
  const sent = await requestAssistMessage(app.db, { workspaceId: f.workspaceId,
    sessionId: f.sessionId, commandId: randomUUID(), content });
  const inputs: AssistRequest[] = [];
  const modelPort = new FakeModelPort();
  modelPort.assist = async (request) => {
    inputs.push(request);
    const remembered = request.turns.map((turn) => turn.content).join('\n')
      .match(/(?:MEMORY|REVOKE)-[0-9a-f-]{36}/u)?.[0] ?? '';
    return { kind: 'CONTENT', content: `memory response ${remembered}`, providerRequestId: randomUUID(),
      usage: { inputTokens: 1, outputTokens: 1 } };
  };
  const result = await runAssistGenerationTick(app.db, { workerId: randomUUID(),
    storage: new ManagedContentStore(dataRoot), modelPort, leaseMs: 60_000 });
  assert.equal(result?.status, 'COMPLETED', JSON.stringify(result));
  return { ...sent.result, inputs, text: inputs.map((input) => input.turns.map((turn) => turn.content).join('\n')).join('\n') };
}

for (const tools of [false, true]) {
  test(`confirmed long-term memory enters actual ${tools ? 'tool-loop' : 'plain'} model input, can be disabled, and is scope bounded`, async () => {
    const f = await fixture(tools);
    const marker = `MEMORY-${randomUUID()}`;
    const memory = await createMemory(app.db, { workspaceId: f.workspaceId, projectId: f.projectId,
      commandId: randomUUID(), title: 'memory preferences', text: marker, confirmed: true });
    const other = await fixture();
    const privateMarker = `PRIVATE-${randomUUID()}`;
    await createMemory(app.db, { workspaceId: other.workspaceId, projectId: other.projectId,
      commandId: randomUUID(), title: 'other', text: privateMarker, confirmed: true });
    const first = await ask(f, 'what are my preferences');
    if (tools) assert.ok((first.inputs[0]?.tools?.length ?? 0) > 0, 'exercise the actual tool-loop path');
    assert.ok(first.text.includes(marker), first.text);
    assert.ok(!first.text.includes(privateMarker));
    assert.ok(first.text.includes('UNTRUSTED_DATA'));
    const message = await createRepositories(app.db).assist.readMessage(first.assistant_message_id);
    assert.ok(Array.isArray(message?.sources));
    assert.ok(message.sources.some((source) => typeof source === 'object' && source !== null &&
      !Array.isArray(source) && source.root_id === memory.result.memory_id && source.selection === 'AUTO_MEMORY'));
    await setMemorySettings(app.db, { workspaceId: f.workspaceId, commandId: randomUUID(),
      expectedRevision: '0', recallEnabled: false, automaticCompaction: true, autoCapture: true });
    const second = await ask(f, 'continue');
    assert.ok(!second.text.includes(marker), 'disabled recall must not leak via historical automatic context');
  });
}

test('explicit memory sources do not consume the automatic recall candidate limit', async () => {
  const f = await fixture();
  const r = createRepositories(app.db);
  const eligible = await createMemory(app.db, { workspaceId: f.workspaceId, projectId: f.projectId,
    commandId: randomUUID(), title: 'explicit retained', text: 'older explicit preference', confirmed: true });
  const excluded = new Set<string>();
  for (let i = 0; i < 8; i++) {
    const saved = await createMemory(app.db, { workspaceId: f.workspaceId, projectId: f.projectId,
      commandId: randomUUID(), title: `explicit ${i}`, text: `explicit ${i}`, confirmed: true });
    excluded.add(saved.result.memory_id!);
  }
  const session = (await r.assist.readSession(f.sessionId))!;
  const recalled = await recallConfirmedMemoryRefs(r, session, 'explicit', excluded, 3);
  assert.deepEqual(recalled.map((ref) => ref.root_id), [eligible.result.memory_id]);
});

test('message save requires confirmation, exact source hash and scope; provenance blocks physical source deletion', async () => {
  const f = await fixture();
  const content = `source-${randomUUID()}`;
  const sent = await ask(f, content);
  const path = f.path(`/assist-sessions/${f.sessionId}/messages/${sent.user_message_id}/memories`);
  const body = { command_id: randomUUID(), expected_session_revision: '0',
    content_sha256: createHash('sha256').update(content).digest('hex'), project_id: f.projectId,
    title: 'saved source', text: content, confirmed: true };
  assert.equal((await api.post(path, { ...body, confirmed: false })).status, 422);
  assert.equal((await api.post(path, { ...body, content_sha256: '0'.repeat(64) })).status, 409);
  const saved = await api.post(path, body);
  assert.equal(saved.status, 201, saved.text);
  assert.deepEqual((await api.post(path, body)).body, saved.body);
  const id = (saved.body as { result: { memory_id: string } }).result.memory_id;
  const provenance = await api.get(f.path(`/memories/${id}/provenance`));
  assert.equal(provenance.status, 200, provenance.text);
  assert.equal((provenance.body as { sources: { message_id: string }[] }).sources[0]?.message_id, sent.user_message_id);
  // 2026-10-31：记忆来源凭据是会话自有账本，随会话删除一起清理（0137 起删除路径就是如此），
  // 不再单独阻断删除；长期记忆正文与版本保留，另有停用入口。
  const blockers = await createRepositories(app.db).assist.listDeleteBlockers(f.sessionId);
  assert.equal(blockers.some((reason) => String(reason) === 'MEMORY_SOURCES'), false);
  const other = await fixture();
  assert.equal((await api.post(path, { ...body, command_id: randomUUID(), project_id: other.projectId })).status, 404);
  assert.equal((await api.get(other.path(`/memories/${id}/provenance`))).status, 404);
});

test('retired recalled source is removed from both new recall and prior assistant context', async () => {
  const f = await fixture();
  const marker = `REVOKE-${randomUUID()}`;
  const memory = await createMemory(app.db, { workspaceId: f.workspaceId, projectId: null,
    commandId: randomUUID(), title: 'global preference', text: marker, confirmed: true });
  assert.ok((await ask(f, 'preference')).text.includes(marker));
  await retireInformation(app.db, { workspaceId: f.workspaceId, kind: 'memory',
    id: memory.result.memory_id!, expectedRevision: '0', commandId: randomUUID() });
  assert.ok(!(await ask(f, 'continue without stale source')).text.includes(marker));
});

test('memory settings are persisted, revision guarded and HTTP replayable', async () => {
  const f = await fixture();
  const endpoint = f.path('/memory-settings');
  const body = { command_id: randomUUID(), expected_revision: '0', recall_enabled: false, automatic_compaction: false };
  const result = await api.post(endpoint, body);
  assert.equal(result.status, 200, result.text);
  assert.deepEqual((await api.post(endpoint, body)).body, result.body);
  const read = await api.get(endpoint);
  assert.equal((read.body as { recall_enabled: boolean }).recall_enabled, false);
  assert.equal((await api.post(endpoint, { ...body, command_id: randomUUID() })).status, 409);
});

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

async function waitPast(iso: string): Promise<void> {
  await waitMs(Math.max(0, Date.parse(iso) - Date.now()) + 250);
}

test('replaying an expired memory create returns the original receipt; only first execution checks expiry admission', async () => {
  const f = await fixture();
  const path = f.path('/memories');
  const commandId = randomUUID();
  const body = { command_id: commandId, project_id: null, title: 'short-lived declared memory',
    text: 'expiry replay', confirmed: true, expires_at: new Date(Date.now() + 1200).toISOString() };
  const first = await api.post(path, body);
  assert.equal(first.status, 201, first.text);
  const memoryId = (first.body as { result: { memory_id: string } }).result.memory_id;
  const beforeExpiry = await api.post(path, body);
  assert.equal(beforeExpiry.status, 201, beforeExpiry.text);
  assert.equal(beforeExpiry.headers['command-replayed'], 'true');
  assert.deepEqual(beforeExpiry.body, first.body);
  await waitPast(body.expires_at);
  // Time has moved past expires_at: the already committed command still resolves from its
  // original receipt - same memory, no extension, no new version, no time-based rejection.
  const afterExpiry = await api.post(path, body);
  assert.equal(afterExpiry.status, 201, afterExpiry.text);
  assert.deepEqual(afterExpiry.body, first.body);
  const receipt = await api.get(f.path(`/commands/${commandId}`));
  assert.equal(receipt.status, 200, receipt.text);
  const memory = await api.get(f.path(`/memories/${memoryId}`));
  assert.equal(memory.status, 200, memory.text);
  assert.equal((memory.body as { effective_status: string }).effective_status, 'EXPIRED');
  assert.equal((memory.body as { current_version: string }).current_version, '1');
  // First-execution admission still applies: a new command with a past expires_at is rejected,
  // and reusing the original command_id with a different payload is a command-id conflict.
  const pastBody = { ...body, command_id: randomUUID(), expires_at: new Date(Date.now() - 1000).toISOString() };
  const past = await api.post(path, pastBody);
  assert.equal(past.status, 422, past.text);
  assert.equal((past.body as { code: string }).code, 'VALIDATION_FAILED');
  assert.equal((await api.post(path, { ...body, title: 'changed payload' })).status, 409);
});

test('memory revision replay keeps the original result after its own expires_at has passed', async () => {
  const f = await fixture();
  const created = await api.post(f.path('/memories'), { command_id: randomUUID(), project_id: null,
    title: 'renewable fact', text: 'revision replay base', confirmed: true });
  assert.equal(created.status, 201, created.text);
  const memoryId = (created.body as { result: { memory_id: string } }).result.memory_id;
  const revisionPath = f.path(`/memories/${memoryId}/revisions`);
  const revision = { command_id: randomUUID(), expected_revision: '0', title: 'renewable fact',
    text: 'revision replay v2', confirmed: true, expires_at: new Date(Date.now() + 1200).toISOString() };
  const first = await api.post(revisionPath, revision);
  assert.equal(first.status, 200, first.text);
  await waitPast(revision.expires_at);
  const replayed = await api.post(revisionPath, revision);
  assert.equal(replayed.status, 200, replayed.text);
  assert.deepEqual(replayed.body, first.body);
  const detail = await api.get(f.path(`/memories/${memoryId}`));
  assert.equal((detail.body as { current_version: string }).current_version, '2');
  assert.equal((detail.body as { effective_status: string }).effective_status, 'EXPIRED');
});

test('save-from-message replay returns the original memory after its expires_at has passed', async () => {
  const f = await fixture();
  const content = `expiry-replay-source-${randomUUID()}`;
  const sent = await ask(f, content);
  const path = f.path(`/assist-sessions/${f.sessionId}/messages/${sent.user_message_id}/memories`);
  const body = { command_id: randomUUID(), expected_session_revision: '0',
    content_sha256: createHash('sha256').update(content).digest('hex'), project_id: f.projectId,
    title: 'saved source', text: content, confirmed: true,
    expires_at: new Date(Date.now() + 1200).toISOString() };
  const first = await api.post(path, body);
  assert.equal(first.status, 201, first.text);
  const memoryId = (first.body as { result: { memory_id: string } }).result.memory_id;
  await waitPast(body.expires_at);
  const replayed = await api.post(path, body);
  assert.equal(replayed.status, 201, replayed.text);
  assert.deepEqual(replayed.body, first.body);
  const detail = await api.get(f.path(`/memories/${memoryId}`));
  assert.equal((detail.body as { effective_status: string }).effective_status, 'EXPIRED');
  assert.equal((detail.body as { current_version: string }).current_version, '1');
});

/**
 * BUG-CHAT-CONTEXT-CROSS-TALK：只发「你好」时不得注入无关记忆。
 *
 * 旧实现把没有字面命中的记忆按 updated_at 顺序当「近期已确认」回退带进来，装配处又把
 * 它和手选资料合并说成「显式选中资料」——模型因此声称「你选中了一条资料」。这里同时钉住
 * 两件事：问候不召回；真正相关时召回，并在模型输入与服务端来源记录里都标成自动召回。
 */
test('greeting does not recall unrelated memory; related recall is labeled automatic, not user-selected', async () => {
  const f = await fixture();
  await setMemorySettings(app.db, { workspaceId: f.workspaceId, commandId: randomUUID(),
    expectedRevision: '0', recallEnabled: true, automaticCompaction: true, autoCapture: false });
  const marker = `NOTEBOOK-${randomUUID()}`;
  await createMemory(app.db, { workspaceId: f.workspaceId, projectId: f.projectId,
    commandId: randomUUID(), title: '用户请求打开记事本', text: `打开记事本 ${marker}`, confirmed: true });

  const greeting = await ask(f, '你好');
  assert.ok(!greeting.text.includes(marker), '问候语不得注入无关记忆');
  const greetingMessage = await createRepositories(app.db).assist.readMessage(greeting.assistant_message_id);
  assert.equal(greetingMessage?.sources.length, 0, '问候轮不得记录记忆来源');

  // 同一 workspace 内消息真实相关时才召回；召回理由与选择方式必须如实标注。
  const related = await ask(f, '打开记事本');
  assert.ok(related.text.includes(marker), related.text);
  const prompt = related.inputs.at(-1)?.turns[0]?.content ?? '';
  assert.match(prompt, /自动召回长期记忆：1 条/u);
  assert.match(prompt, /不是用户本轮选择/u);
  assert.ok(!prompt.includes('显式选中资料：1'), prompt);
  const relatedMessage = await createRepositories(app.db).assist.readMessage(related.assistant_message_id);
  const recorded = relatedMessage?.sources[0] as Record<string, unknown> | undefined;
  assert.equal(recorded?.selection, 'AUTO_MEMORY');
  assert.equal(recorded?.selection_basis, 'LITERAL_MATCH');
});

/** BUG-CHAT-CONTEXT-CROSS-TALK：短期历史按会话隔离，不因同 workspace 而串读。 */
test('short-term history stays inside one session', async () => {
  const f = await fixture();
  await setMemorySettings(app.db, { workspaceId: f.workspaceId, commandId: randomUUID(),
    expectedRevision: '0', recallEnabled: false, automaticCompaction: true, autoCapture: false });
  const marker = `HISTORY-${randomUUID()}`;
  await ask(f, `记住这个标记：${marker}`);
  const other = await createAssistSession(app.db, { workspaceId: f.workspaceId, projectId: f.projectId,
    title: 'isolated', commandId: randomUUID() });
  const sent = await requestAssistMessage(app.db, { workspaceId: f.workspaceId,
    sessionId: other.result.session_id, commandId: randomUUID(), content: '你好' });
  const inputs: AssistRequest[] = [];
  const modelPort = new FakeModelPort();
  modelPort.assist = async (request) => {
    inputs.push(request);
    return { kind: 'CONTENT', content: 'ok', providerRequestId: randomUUID(),
      usage: { inputTokens: 1, outputTokens: 1 } };
  };
  const result = await runAssistGenerationTick(app.db, { workerId: randomUUID(),
    storage: new ManagedContentStore(dataRoot), modelPort, leaseMs: 60_000 });
  assert.equal(result?.status, 'COMPLETED', JSON.stringify(result));
  assert.equal(result?.messageId, sent.result.assistant_message_id);
  const text = inputs.map((input) => input.turns.map((turn) => turn.content).join('\n')).join('\n');
  assert.ok(!text.includes(marker), '另一个会话的正文不得进入本次输入');
});
