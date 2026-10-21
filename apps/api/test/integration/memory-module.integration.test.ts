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
      commandId: randomUUID(), title: 'memory preference', text: marker, confirmed: true });
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
  assert.ok((await createRepositories(app.db).assist.listDeleteBlockers(f.sessionId)).includes('MEMORY_SOURCES'));
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
