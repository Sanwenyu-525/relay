import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test, { before, after } from 'node:test';
import { sql } from 'kysely';
import { bindAssistSessionDirectory, bindAssistSessionProject, createAssistSession, requestAssistMessage } from '../../src/application/assist-commands.js';
import { openWorkingDirectory } from '../../src/application/open-working-directory.js';
import { archiveAssistSession, deleteAssistSession, forkAssistSession } from '../../src/application/assist-session-controls.js';
import { runAssistGenerationTick } from '../../src/application/assist-runner.js';
import { runAssistMemoryTick } from '../../src/application/assist-memory-runner.js';
import { requestMemoryCompaction, readSessionMemory, resetSessionMemory,
  cancelMemoryCompaction } from '../../src/application/assist-memory.js';
import { createMemory, createMemoryFromMessage, retireInformation } from '../../src/application/information-commands.js';
import { createRepositories, withTransaction } from '../../src/application/unit-of-work.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { ManagedContentStore } from '../../src/storage/managed-content-store.js';
import { FakeModelPort, type AssistRequest } from '../../src/workflow/fake-model-port.js';
import { createDataRoot, startTestApi, workspacePath, type TestApi } from './api-harness.js';
import { APP_DATABASE_URL, MIGRATION_DATABASE_URL, MIGRATIONS_DIRECTORY, openDatabase } from './integration-support.js';

const app = openDatabase(APP_DATABASE_URL, 'relay-short-memory');
let root: string;
let storage: ManagedContentStore;
let api: TestApi;
before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
  root = await createDataRoot(); storage = new ManagedContentStore(root); api = await startTestApi();
});
after(async () => { await api?.stop(); await app.close(); await rm(root, { recursive: true, force: true }); });

async function fixture(rounds = 12, sources: Parameters<ReturnType<typeof createRepositories>['assist']['insertMessage']>[0]['sources'] = []) {
  const workspaceId = randomUUID();
  await withTransaction(app.db, async (r) => {
    await r.workspaces.insertWorkspace({ id: workspaceId, name: 'short-memory' });
    await r.workspaces.insertAuthorityRow(workspaceId);
  });
  const made = await createAssistSession(app.db, { workspaceId, projectId: null,
    commandId: randomUUID(), title: 'short-memory' });
  const sessionId = made.result.session_id;
  const marker = `GOAL-${randomUUID()}`;
  await withTransaction(app.db, async (r) => {
    for (let i = 0; i < rounds * 2; i++) await r.assist.insertMessage({ id: randomUUID(), sessionId,
      seq: BigInt(i + 1), role: i % 2 === 0 ? 'USER' : 'ASSISTANT', status: 'COMPLETED', intent: 'DISCUSS',
      content: i === 0 ? marker : `original-${i}`, sources: i % 2 === 0 ? [] : sources });
  });
  return { workspaceId, sessionId, marker,
    path: (suffix = '') => workspacePath(workspaceId, `/assist-sessions/${sessionId}/memory${suffix}`) };
}

function port(summary: string, bad = false) {
  const model = new FakeModelPort(); const inputs: AssistRequest[] = [];
  model.assist = async (input) => {
    inputs.push(input);
    return { kind: 'CONTENT', content: input.system.includes('MEMORY_COMPACTION_V1')
      ? bad ? 'invalid summary' : JSON.stringify({ summary }) : 'continued',
    providerRequestId: randomUUID(), usage: { inputTokens: 7, outputTokens: 3 } };
  };
  return { model, inputs, options: { workerId: randomUUID(), leaseMs: 60000, storage, modelPort: model } };
}

async function compact(f: Awaited<ReturnType<typeof fixture>>, p = port(f.marker)) {
  const revision = (await createRepositories(app.db).assist.readSession(f.sessionId))!.revision.toString();
  const request = await requestMemoryCompaction(app.db, { ...f, commandId: randomUUID(), expectedRevision: revision }, storage);
  const result = await runAssistMemoryTick(app.db, p.options);
  assert.equal(result?.status, 'COMPLETED', JSON.stringify(result));
  return { ...p, request };
}

test('manual HTTP compaction is replayable; restart uses persisted summary plus exact recent originals and cost ledger', async () => {
  const f = await fixture(); const p = port(f.marker);
  const body = { command_id: randomUUID(), expected_revision: '0' };
  const accepted = await api.post(f.path('/compact'), body);
  assert.equal(accepted.status, 202, accepted.text);
  assert.deepEqual((await api.post(f.path('/compact'), body)).body, accepted.body);
  assert.equal((await runAssistMemoryTick(app.db, p.options))?.status, 'COMPLETED');
  assert.ok(p.inputs[0]?.turns[0]?.content.includes(f.marker));
  const read = await readSessionMemory(app.db, storage, f.workspaceId, f.sessionId);
  assert.equal(read.checkpoint?.through_seq, '16');
  assert.equal(read.checkpoint?.summary, f.marker);
  assert.equal(read.revision, '1');
  const calls = await sql<{ status: string }>`select status from model_calls where id = ${read.checkpoint!.model_call_id}`.execute(app.db);
  assert.equal(calls.rows[0]?.status, 'COMPLETED');
  // Restart the actual HTTP process as well; its fresh projection must read the committed checkpoint.
  await api.stop(); api = await startTestApi();
  const persisted = await api.get(f.path());
  assert.equal(persisted.status, 200, persisted.text);
  assert.equal((persisted.body as { checkpoint: { summary: string } }).checkpoint.summary, f.marker);
  // A new pool/worker has no process-local transcript or summary cache.
  const restarted = openDatabase(APP_DATABASE_URL, 'relay-memory-restarted');
  try {
    await requestAssistMessage(restarted.db, { ...f, commandId: randomUUID(), content: 'continue-after-restart' });
    const resumed = port('unused');
    assert.equal((await runAssistGenerationTick(restarted.db, resumed.options))?.status, 'COMPLETED');
    const input = resumed.inputs.flatMap((entry) => entry.turns).map((turn) => turn.content).join('\n');
    assert.ok(input.includes(f.marker)); assert.ok(input.includes('original-23'));
    assert.ok(!input.includes('original-1\n'), 'covered original prefix is replaced only after checkpoint commit');
    assert.equal((await createRepositories(restarted.db).assist.listMessages(f.sessionId)).length, 26);
  } finally { await restarted.close(); }
});

test('compaction refuses tool results and records their request and usage as a failed call', async () => {
  const f = await fixture();
  await requestMemoryCompaction(app.db, { ...f, commandId: randomUUID() }, storage);
  const p = port('unused');
  p.model.assist = async () => ({ kind: 'TOOL_CALLS', calls: [], preamble: '',
    providerRequestId: 'memory-tool-refusal', usage: { inputTokens: 17, outputTokens: 4 } });
  const result = await runAssistMemoryTick(app.db, p.options);
  assert.equal(result?.status, 'FAILED');
  const job = await createRepositories(app.db).assistMemory.request(result!.requestId);
  assert.equal(job?.checkpoint_id, null);
  const call = (await sql<{ status: string; error_kind: string; provider_request_id: string;
    usage_input_tokens: number; usage_output_tokens: number }>`select status, error_kind, provider_request_id,
      usage_input_tokens, usage_output_tokens from model_calls where id = ${job!.model_call_id}`.execute(app.db)).rows[0]!;
  assert.equal(call.status, 'FAILED');
  assert.equal(call.error_kind, 'MEMORY_TOOL_CALLS_UNSUPPORTED');
  assert.equal(call.provider_request_id, 'memory-tool-refusal');
  assert.equal(call.usage_input_tokens, 17);
  assert.equal(call.usage_output_tokens, 4);
});

test('automatic compaction requeues original message, commits checkpoint, then completes that same message', async () => {
  const f = await fixture(17); const p = port(f.marker);
  const sent = await requestAssistMessage(app.db, { ...f, commandId: randomUUID(), content: 'automatic-continue' });
  assert.equal((await runAssistGenerationTick(app.db, p.options))?.status, 'DISCARDED');
  assert.equal(p.inputs.length, 0);
  await runAssistGenerationTick(app.db, p.options);
  assert.equal(p.inputs.length, 1);
  assert.equal((await runAssistGenerationTick(app.db, p.options))?.status, 'COMPLETED');
  assert.equal((await createRepositories(app.db).assist.readMessage(sent.result.assistant_message_id))?.status, 'COMPLETED');
  assert.ok(p.inputs[1]?.turns.some((turn) => turn.content.includes(f.marker)));
});

test('bad summary preserves checkpoint and originals; no automatic retry loop', async () => {
  const f = await fixture(); await compact(f);
  const before = await readSessionMemory(app.db, storage, f.workspaceId, f.sessionId);
  await withTransaction(app.db, async (r) => {
    for (let i = 25; i <= 40; i++) await r.assist.insertMessage({ id: randomUUID(), sessionId: f.sessionId,
      seq: BigInt(i), role: i % 2 ? 'USER' : 'ASSISTANT', status: 'COMPLETED', intent: 'DISCUSS', content: `new-${i}`, sources: [] });
  });
  await requestMemoryCompaction(app.db, { ...f, commandId: randomUUID(), expectedRevision: '0' }, storage);
  assert.equal((await runAssistMemoryTick(app.db, port('bad', true).options))?.errorCode, 'MEMORY_SUMMARY_INVALID');
  const after = await readSessionMemory(app.db, storage, f.workspaceId, f.sessionId);
  assert.equal(after.checkpoint?.id, before.checkpoint?.id); assert.equal(after.revision, before.revision);
  assert.equal((await createRepositories(app.db).assist.listMessages(f.sessionId)).length, 40);
});

test('source invalidation hides summary and removes derived historical answers from subsequent model input', async () => {
  const f = await fixture(0);
  const marker = `PRIVATE-${randomUUID()}`;
  const memory = await createMemory(app.db, { workspaceId: f.workspaceId, projectId: null,
    commandId: randomUUID(), title: 'private', text: marker, confirmed: true });
  await withTransaction(app.db, async (r) => {
    for (let i = 1; i <= 24; i++) await r.assist.insertMessage({ id: randomUUID(), sessionId: f.sessionId,
      seq: BigInt(i), role: i % 2 ? 'USER' : 'ASSISTANT', status: 'COMPLETED', intent: 'DISCUSS',
      content: i % 2 ? 'question' : marker, sources: i % 2 ? [] : [{ kind: 'MEMORY', root_id: memory.result.memory_id!,
        version: '1', status: 'SENT', selection: 'AUTO_MEMORY' }] });
  });
  await compact(f, port(marker));
  const derived = port(marker); derived.model.assist = async (input) => {
    derived.inputs.push(input); return { kind: 'CONTENT', content: marker, providerRequestId: randomUUID(), usage: { inputTokens: 1, outputTokens: 1 } };
  };
  await requestAssistMessage(app.db, { ...f, commandId: randomUUID(), content: 'continue' });
  assert.equal((await runAssistGenerationTick(app.db, derived.options))?.status, 'COMPLETED');
  await retireInformation(app.db, { workspaceId: f.workspaceId, kind: 'memory', id: memory.result.memory_id!,
    commandId: randomUUID(), expectedRevision: '0' });
  assert.equal((await readSessionMemory(app.db, storage, f.workspaceId, f.sessionId)).checkpoint?.summary, null);
  await requestAssistMessage(app.db, { ...f, commandId: randomUUID(), content: 'continue safely' });
  const next = port('unused');
  assert.equal((await runAssistGenerationTick(app.db, next.options))?.status, 'COMPLETED');
  assert.ok(!JSON.stringify(next.inputs).includes(marker));
});

test('clear and one-off mode preserve original history and long-term memory; in-flight controls reject', async () => {
  const f = await fixture(); await compact(f);
  const reset = await resetSessionMemory(app.db, { ...f, commandId: randomUUID(), expectedRevision: '1', expectedSessionRevision: '0', remember: false });
  assert.equal(reset.result.session_revision, '1');
  assert.equal((await createRepositories(app.db).assist.listMessages(f.sessionId)).length, 24);
  await requestAssistMessage(app.db, { ...f, commandId: randomUUID(), content: 'one-off-current' });
  await assert.rejects(() => resetSessionMemory(app.db, { ...f, commandId: randomUUID(), expectedRevision: '2', expectedSessionRevision: '1' }));
  const p = port('unused');
  assert.equal((await runAssistGenerationTick(app.db, p.options))?.status, 'COMPLETED');
  assert.ok(!JSON.stringify(p.inputs).includes(f.marker));
  assert.ok(JSON.stringify(p.inputs).includes('one-off-current'));
  await resetSessionMemory(app.db, { ...f, commandId: randomUUID(), expectedRevision: '2', expectedSessionRevision: '1', remember: true });
  await requestAssistMessage(app.db, { ...f, commandId: randomUUID(), content: 'remember-again' });
  const resumed = port('unused'); await runAssistGenerationTick(app.db, resumed.options);
  assert.ok(!JSON.stringify(resumed.inputs).includes('one-off-current'));
});

test('cancelled/expired requests never publish; completed checkpoint children can be physically deleted', async () => {
  const f = await fixture();
  const requested = await requestMemoryCompaction(app.db, { ...f, commandId: randomUUID(), expectedRevision: '0' }, storage);
  assert.ok((await createRepositories(app.db).assist.listDeleteBlockers(f.sessionId)).includes('MEMORY_COMPACTION_ACTIVE'));
  await cancelMemoryCompaction(app.db, { ...f, requestId: String(requested.result.request_id), commandId: randomUUID() });
  assert.equal(await runAssistMemoryTick(app.db, port('unused').options), undefined);
  const second = await requestMemoryCompaction(app.db, { ...f, commandId: randomUUID(), expectedRevision: '0' }, storage);
  const claimed = await createRepositories(app.db).assistMemory.claim('lost-worker', -1);
  assert.equal(claimed?.id, second.result.request_id);
  await createRepositories(app.db).assistMemory.expireLeases();
  assert.equal(await createRepositories(app.db).assistMemory.heartbeat(claimed!.id, 'lost-worker', claimed!.claim_epoch, 60000), false);
  await compact(f);
  await deleteAssistSession(app.db, { ...f, commandId: randomUUID(), expectedRevision: '0' });
  assert.equal(await createRepositories(app.db).assist.readSession(f.sessionId), undefined);
});

test('settings/source changes during model call reject publication and retain raw history', async () => {
  const f = await fixture();
  await requestMemoryCompaction(app.db, { ...f, commandId: randomUUID(), expectedRevision: '0' }, storage);
  const p = port('stale');
  const original = p.model.assist;
  p.model.assist = async (input) => {
    await createRepositories(app.db).information.setMemorySettings(f.workspaceId, false, false);
    return original(input);
  };
  assert.equal((await runAssistMemoryTick(app.db, p.options))?.status, 'FAILED');
  assert.equal((await readSessionMemory(app.db, storage, f.workspaceId, f.sessionId)).checkpoint, null);
});

test('running cancel settles CANCELLED when the model returns on abort; old worker cannot publish', async () => {
  const f = await fixture();
  const requested = await requestMemoryCompaction(app.db, { ...f, commandId: randomUUID(), expectedRevision: '0' }, storage);
  const p = port('must never publish');
  let started!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  p.model.assist = async (input) => {
    started();
    await new Promise<void>((resolve) => input.signal?.addEventListener('abort', () => resolve(), { once: true }));
    return { kind: 'CANCELLED' };
  };
  const running = runAssistMemoryTick(app.db, p.options);
  await entered;
  await cancelMemoryCompaction(app.db, { ...f, requestId: String(requested.result.request_id), commandId: randomUUID() });
  assert.equal((await running)?.status, 'CANCELLED');
  assert.equal((await createRepositories(app.db).assistMemory.request(String(requested.result.request_id)))?.status, 'CANCELLED');
  assert.equal((await readSessionMemory(app.db, storage, f.workspaceId, f.sessionId)).checkpoint, null);
  assert.equal(await createRepositories(app.db).assistMemory.activeRequest(f.sessionId), undefined);
});

test('transitive history and fork retain source invalidation; stale derived replies cannot become long-term facts', async () => {
  const f = await fixture(0);
  const marker = `SECRET-${randomUUID()}`;
  const original = await createMemory(app.db, { workspaceId: f.workspaceId, projectId: null,
    commandId: randomUUID(), title: 'original', text: marker, confirmed: true });
  const echo = port('unused');
  echo.model.assist = async (input) => {
    echo.inputs.push(input);
    return { kind: 'CONTENT', content: JSON.stringify(input.turns).includes(marker) ? marker : 'safe',
      providerRequestId: randomUUID(), usage: { inputTokens: 1, outputTokens: 1 } };
  };
  await requestAssistMessage(app.db, { ...f, commandId: randomUUID(), content: 'first' });
  await runAssistGenerationTick(app.db, echo.options);
  for (let i = 0; i < 3; i++) await createMemory(app.db, { workspaceId: f.workspaceId, projectId: null,
    commandId: randomUUID(), title: 'new-ranked-topic', text: `new-ranked-topic-${i}`, confirmed: true });
  const second = await requestAssistMessage(app.db, { ...f, commandId: randomUUID(), content: 'new-ranked-topic' });
  assert.equal((await runAssistGenerationTick(app.db, echo.options))?.status, 'COMPLETED');
  const repository = createRepositories(app.db);
  const secondMessage = await repository.assist.readMessage(second.result.assistant_message_id);
  assert.equal(secondMessage?.content, marker);
  assert.ok(!JSON.stringify(secondMessage?.sources).includes(String(original.result.memory_id)), 'M arrives only through history');
  assert.ok(JSON.stringify((await repository.assistMemory.use(second.result.assistant_message_id))?.sources).includes(String(original.result.memory_id)));
  const child = await forkAssistSession(app.db, { ...f, commandId: randomUUID(), expectedRevision: '0' });
  await retireInformation(app.db, { workspaceId: f.workspaceId, kind: 'memory', id: String(original.result.memory_id), commandId: randomUUID(), expectedRevision: '0' });
  await assert.rejects(() => createMemoryFromMessage(app.db, { ...f, messageId: second.result.assistant_message_id,
    commandId: randomUUID(), expectedSessionRevision: '0', expectedContentSha256: createHash('sha256').update(marker).digest('hex'),
    projectId: null, title: 'stale fact', text: marker, confirmed: true }, storage));
  const usage = await api.get(workspacePath(f.workspaceId, `/assist-sessions/${f.sessionId}/messages/${second.result.assistant_message_id}/memory`));
  assert.equal(usage.status, 200, usage.text); assert.equal((usage.body as { available: boolean }).available, false);
  for (const sessionId of [f.sessionId, child.result.session_id]) {
    await requestAssistMessage(app.db, { ...f, sessionId, commandId: randomUUID(), content: 'new-ranked-topic' });
    const next = port('unused'); assert.equal((await runAssistGenerationTick(app.db, next.options))?.status, 'COMPLETED');
    assert.ok(!JSON.stringify(next.inputs).includes(marker), 'neither parent nor fork leaks derived source');
  }
});

test('AUTO malformed summary does not retry same boundary and the original pending reply continues', async () => {
  const f = await fixture(17); const p = port('invalid', true);
  await requestAssistMessage(app.db, { ...f, commandId: randomUUID(), content: 'continue-after-auto-failure' });
  await runAssistGenerationTick(app.db, p.options);
  await runAssistGenerationTick(app.db, p.options);
  assert.equal(p.inputs.length, 1);
  assert.equal((await runAssistGenerationTick(app.db, p.options))?.status, 'COMPLETED');
  assert.equal(p.inputs.filter((input) => input.system.includes('MEMORY_COMPACTION_V1')).length, 1);
  assert.equal((await readSessionMemory(app.db, storage, f.workspaceId, f.sessionId)).checkpoint, null);
});

test('/compact and Chinese alias use the real persistent owner and replay after completion', async () => {
  const f = await fixture();
  const body = { command_id: randomUUID(), text: '/压缩' };
  const endpoint = workspacePath(f.workspaceId, `/assist-sessions/${f.sessionId}/chat-commands`);
  const accepted = await api.post(endpoint, body);
  assert.equal(accepted.status, 202, accepted.text);
  assert.equal((accepted.body as { result: { kind: string } }).result.kind, 'MEMORY_COMPACTION');
  await runAssistMemoryTick(app.db, port('summary').options);
  assert.deepEqual((await api.post(endpoint, body)).body, accepted.body);
});

test('checkpoint reaches actual tool-loop input; changing directory excludes previous derived tool context', async () => {
  const f = await fixture();
  const dirA = await mkdtemp(join(tmpdir(), 'relay-memory-scope-a-'));
  const dirB = await mkdtemp(join(tmpdir(), 'relay-memory-scope-b-'));
  try {
    const first = await openWorkingDirectory(app.db, { workspaceId: f.workspaceId, rootPath: dirA, commandId: randomUUID() });
    const projectId = first.result.association!.project_id;
    await bindAssistSessionProject(app.db, { ...f, projectId, commandId: randomUUID() });
    await bindAssistSessionDirectory(app.db, { ...f, commandId: randomUUID(), resourceId: first.result.association!.resource_id });
    await compact(f);
    const marker = `TOOL-CONTEXT-${randomUUID()}`;
    const p = port('unused');
    p.model.assist = async (input) => {
      p.inputs.push(input);
      return { kind: 'CONTENT', content: marker, providerRequestId: randomUUID(), usage: { inputTokens: 1, outputTokens: 1 } };
    };
    await requestAssistMessage(app.db, { ...f, commandId: randomUUID(), content: 'continue-with-tools' });
    assert.equal((await runAssistGenerationTick(app.db, p.options))?.status, 'COMPLETED');
    assert.ok((p.inputs[0]?.tools?.length ?? 0) > 0);
    assert.ok(JSON.stringify(p.inputs).includes(f.marker));
    const second = await openWorkingDirectory(app.db, { workspaceId: f.workspaceId, projectId, rootPath: dirB, commandId: randomUUID() });
    await bindAssistSessionDirectory(app.db, { ...f, commandId: randomUUID(), resourceId: second.result.association!.resource_id });
    await requestAssistMessage(app.db, { ...f, commandId: randomUUID(), content: 'continue-in-other-directory' });
    const next = port('unused');
    assert.equal((await runAssistGenerationTick(app.db, next.options))?.status, 'COMPLETED');
    assert.ok(!JSON.stringify(next.inputs).includes(marker));
  } finally {
    await rm(dirA, { recursive: true, force: true }); await rm(dirB, { recursive: true, force: true });
  }
});

test('final UTF-8 input budget includes explicit Chinese source bodies and fails before model invocation', async () => {
  const f = await fixture(0);
  const refs: { kind: 'MEMORY'; root_id: string; version: string }[] = [];
  for (let i = 0; i < 3; i++) {
    const saved = await createMemory(app.db, { workspaceId: f.workspaceId, projectId: null, commandId: randomUUID(),
      title: `large-${i}`, text: '中'.repeat(16000), confirmed: true });
    refs.push({ kind: 'MEMORY', root_id: String(saved.result.memory_id), version: '1' });
  }
  await requestAssistMessage(app.db, { ...f, commandId: randomUUID(), content: 'large sources', sourceRefs: refs });
  const p = port('must not run');
  assert.equal((await runAssistGenerationTick(app.db, p.options))?.errorCode, 'MEMORY_CONTEXT_TOO_LARGE');
  assert.equal(p.inputs.length, 0);
});

test('late model result after lease expiry cannot publish or overwrite the old checkpoint', async () => {
  const f = await fixture(); await compact(f);
  const previous = await readSessionMemory(app.db, storage, f.workspaceId, f.sessionId);
  await withTransaction(app.db, async (r) => {
    for (let i = 25; i <= 40; i++) await r.assist.insertMessage({ id: randomUUID(), sessionId: f.sessionId,
      seq: BigInt(i), role: i % 2 ? 'USER' : 'ASSISTANT', status: 'COMPLETED', intent: 'DISCUSS', content: `tail-${i}`, sources: [] });
  });
  const requested = await requestMemoryCompaction(app.db, { ...f, commandId: randomUUID(), expectedRevision: '0' }, storage);
  const p = port('late result'); const original = p.model.assist;
  p.model.assist = async (input) => {
    await sql`update assist_memory_requests set lease_until = now() - interval '1 second' where id = ${String(requested.result.request_id)}`.execute(app.db);
    await createRepositories(app.db).assistMemory.expireLeases();
    return original(input);
  };
  await runAssistMemoryTick(app.db, p.options);
  const after = await readSessionMemory(app.db, storage, f.workspaceId, f.sessionId);
  assert.equal(after.checkpoint?.id, previous.checkpoint?.id);
  assert.equal(after.revision, previous.revision);
  assert.equal((await createRepositories(app.db).assistMemory.request(String(requested.result.request_id)))?.error_code, 'MEMORY_WORKER_LOST');
});

test('legacy tool reply without usage provenance cannot regain its body through fork', async () => {
  const f = await fixture(0); const directory = await mkdtemp(join(tmpdir(), 'relay-memory-legacy-'));
  const marker = `LEGACY-${randomUUID()}`;
  try {
    await writeFile(join(directory, 'README.md'), marker);
    const opened = await openWorkingDirectory(app.db, { workspaceId: f.workspaceId, rootPath: directory, commandId: randomUUID() });
    await bindAssistSessionProject(app.db, { ...f, projectId: opened.result.association!.project_id, commandId: randomUUID() });
    await bindAssistSessionDirectory(app.db, { ...f, resourceId: opened.result.association!.resource_id, commandId: randomUUID() });
    const sent = await requestAssistMessage(app.db, { ...f, commandId: randomUUID(), content: 'read the note' });
    const p = port('unused');
    p.model.assist = async (input) => {
      if ((input.toolTurns?.length ?? 0) === 0) return { kind: 'TOOL_CALLS', calls: [{
        providerToolCallId: 'legacy-read', name: 'read_file', arguments: { relative_path: 'README.md' } }],
      preamble: '', providerRequestId: randomUUID(), usage: { inputTokens: 1, outputTokens: 1 } };
      const actual = JSON.stringify(input.toolTurns).match(/LEGACY-[0-9a-f-]{36}/u)?.[0];
      assert.equal(actual, marker);
      return { kind: 'CONTENT', content: actual, providerRequestId: randomUUID(), usage: { inputTokens: 1, outputTokens: 1 } };
    };
    assert.equal((await runAssistGenerationTick(app.db, p.options))?.status, 'COMPLETED');
    await sql`delete from assist_memory_uses where message_id = ${sent.result.assistant_message_id}`.execute(app.db);
    const current = await createRepositories(app.db).assist.readSession(f.sessionId);
    const child = await forkAssistSession(app.db, { ...f, commandId: randomUUID(), expectedRevision: current!.revision.toString() });
    const childMessages = await createRepositories(app.db).assist.listMessages(child.result.session_id);
    assert.equal(childMessages.at(-1)?.content, '（历史工具答复的来源无法核对，正文未复制。）');
    assert.equal((await createRepositories(app.db).assist.readMessage(sent.result.assistant_message_id))?.content, marker);
    await requestAssistMessage(app.db, { ...f, sessionId: child.result.session_id, commandId: randomUUID(), content: 'continue' });
    const next = port('unused');
    assert.equal((await runAssistGenerationTick(app.db, next.options))?.status, 'COMPLETED');
    assert.ok(next.inputs.length > 0);
    assert.ok(!JSON.stringify(next.inputs).includes(marker));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('cancelled rounds with null error retain a truthful marker in the working history', async () => {
  const f = await fixture(0);
  await withTransaction(app.db, async (r) => {
    await r.assist.insertMessage({ id: randomUUID(), sessionId: f.sessionId, seq: 1n,
      role: 'USER', status: 'COMPLETED', intent: 'DISCUSS', content: 'unfinished goal', sources: [] });
    await r.assist.insertMessage({ id: randomUUID(), sessionId: f.sessionId, seq: 2n,
      role: 'ASSISTANT', status: 'CANCELLED', intent: 'DISCUSS', content: null, sources: [] });
  });
  await requestAssistMessage(app.db, { ...f, commandId: randomUUID(), content: 'continue' });
  const p = port('unused');
  assert.equal((await runAssistGenerationTick(app.db, p.options))?.status, 'COMPLETED');
  assert.ok(JSON.stringify(p.inputs).includes('该轮 CANCELLED'));
});

test('archiving a session settles its queued compaction without a model call or stranded active request', async () => {
  const f = await fixture();
  const requested = await requestMemoryCompaction(app.db, { ...f, commandId: randomUUID(), expectedRevision: '0' }, storage);
  await archiveAssistSession(app.db, { ...f, commandId: randomUUID(), expectedRevision: '0' });
  const r = createRepositories(app.db);
  assert.equal(await r.assist.hasRunnableGeneration(new Date()), true);
  const p = port('must not run');
  await runAssistMemoryTick(app.db, p.options);
  assert.equal(p.inputs.length, 0);
  assert.equal(await r.assistMemory.activeRequest(f.sessionId), undefined);
  assert.equal((await r.assistMemory.request(String(requested.result.request_id)))?.error_code, 'MEMORY_SCOPE_CHANGED');
});
