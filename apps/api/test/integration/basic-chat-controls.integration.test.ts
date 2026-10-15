import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';

import { cancelAssistMessage, createAssistSession, requestAssistMessage } from
  '../../src/application/assist-commands.js';
import { createAssistantProfile } from '../../src/application/assistant-profile-commands.js';
import { httpCommandScopeKey } from '../../src/application/actor.js';
import { applyStateMaintenance, interpretStateMaintenance } from
  '../../src/application/conversation-state.js';
import type { ExecuteChatCommandResult } from '../../src/application/execute-chat-command.js';
import { createRepositories } from '../../src/application/unit-of-work.js';
import type { ConversationMode } from '../../src/infrastructure/database-schema.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import type { AssistModelPort } from '../../src/workflow/fake-model-port.js';
import { createWorkspace, startTestApi, workspacePath, type TestApi } from './api-harness.js';
import { APP_DATABASE_URL, MIGRATIONS_DIRECTORY, MIGRATION_DATABASE_URL, openDatabase } from
  './integration-support.js';

// 有界正向 PG/HTTP 出口；没有真实 Provider、并发或压力测试。
const app = openDatabase(APP_DATABASE_URL, 'relay-api-test-basic-chat-controls');
let api: TestApi;
before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
  api = await startTestApi();
});
after(async () => { await api?.stop(); await app.close(); });

type Envelope = { command_id: string; committed_at: string; result: ExecuteChatCommandResult;
  links: { resource: string } };

async function project(workspaceId: string): Promise<string> {
  const created = await api.post(workspacePath(workspaceId, '/projects'), {
    command_id: randomUUID(), title: '基础会话控制', project_type: 'DEVELOPMENT' });
  assert.equal(created.status, 201, created.text);
  return (created.body as { result: { project_id: string } }).result.project_id;
}

async function sentAndStopped(workspaceId: string, sessionId: string, content: string) {
  const sent = await requestAssistMessage(app.db, { workspaceId, sessionId,
    commandId: randomUUID(), content });
  await cancelAssistMessage(app.db, { workspaceId,
    messageId: sent.result.assistant_message_id, commandId: randomUUID() });
  return sent.result;
}

test('/clear 与 /new 新建空会话，保留项目/任务/冻结身份/旧历史且原回执重放', async () => {
  const workspaceId = await createWorkspace(app.db);
  const projectId = await project(workspaceId);
  const task = await api.post(workspacePath(workspaceId, '/tasks'), {
    command_id: randomUUID(), project_id: projectId, title: '保留任务绑定', objective: '核对绑定',
    criteria: [{ statement: '人工核对' }] });
  assert.equal(task.status, 201, task.text);
  const taskId = (task.body as { result: { task_id: string } }).result.task_id;
  const profile = await createAssistantProfile(app.db, { workspaceId, commandId: randomUUID(),
    name: '基础只读助手', roleDescription: '只读回答', tone: '简短' });
  const assistantProfileId = profile.result.assistant_profile_id as string;
  const repositories = createRepositories(app.db);
  for (const conversationMode of ['AGENT', 'ASSISTANT', 'LEARNING'] as const satisfies readonly ConversationMode[]) {
    const session = await createAssistSession(app.db, { workspaceId, commandId: randomUUID(),
      projectId, taskId, title: '原会话', conversationMode,
      ...(conversationMode === 'ASSISTANT' ? { assistantProfileId } : {}) });
    const sourceId = session.result.session_id;
    await sentAndStopped(workspaceId, sourceId, '保留这条历史');
    const source = await repositories.assist.readSession(sourceId);
    assert.ok(source !== undefined);
    const history = await repositories.assist.listMessages(sourceId);
    for (const text of ['/clear', '/new']) {
      const commandId = randomUUID();
      const path = workspacePath(workspaceId, `/assist-sessions/${sourceId}/chat-commands`);
      const response = await api.post(path, { command_id: commandId, text });
      assert.equal(response.status, 200, response.text);
      const envelope = response.body as Envelope;
      assert.equal(envelope.result.kind, 'NEW_SESSION');
      if (envelope.result.kind !== 'NEW_SESSION') throw new Error('wrong result kind');
      assert.notEqual(envelope.result.session_id, sourceId);
      const created = await repositories.assist.readSession(envelope.result.session_id);
      assert.ok(created !== undefined);
      assert.equal(created.project_id, projectId);
      assert.equal(created.task_id, taskId);
      assert.equal(created.conversation_mode, conversationMode);
      assert.equal(created.assistant_profile_id, source.assistant_profile_id);
      assert.equal(created.assistant_profile_revision, source.assistant_profile_revision);
      assert.deepEqual(created.assistant_role_snapshot, source.assistant_role_snapshot);
      assert.deepEqual(await repositories.assist.listMessages(created.id), []);
      assert.deepEqual(await repositories.assist.listMessages(sourceId), history);
      assert.equal((await repositories.assist.readSession(sourceId))?.status, 'ACTIVE');
      const replay = await api.post(path, { command_id: commandId, text });
      assert.equal(replay.status, 200, replay.text);
      assert.equal(replay.headers['command-replayed'], 'true');
      assert.deepEqual(replay.body, envelope);
    }
  }
});

test('/undo 复用原撤回身份与状态 Owner，持久原成功回执且重放不重复补偿', async () => {
  const workspaceId = await createWorkspace(app.db);
  const projectId = await project(workspaceId);
  const session = await createAssistSession(app.db, { workspaceId, commandId: randomUUID(),
    projectId, title: '撤回状态调整' });
  const sessionId = session.result.session_id;
  const sent = await sentAndStopped(workspaceId, sessionId, '把阶段设为构建');
  const modelPort: AssistModelPort = {
    identity: { provider: 'fake', model: 'fake-model-v1', configFingerprint: 'basic-chat-controls' },
    assist: async () => { throw new Error('assist must not be called'); },
    interpret: async () => ({ kind: 'CONTENT',
      content: JSON.stringify({ decision: 'MAINTAIN', questions: [], decision_required: null,
        changes: [{ kind: 'SET_PHASE', phase: 'IMPLEMENTATION' }] }),
      providerRequestId: 'basic-chat-controls', usage: { inputTokens: 1, outputTokens: 1 } }),
  };
  const interpreted = await interpretStateMaintenance(app.db, { workspaceId, sessionId,
    sourceMessageId: sent.user_message_id, commandId: randomUUID(), modelPort });
  const requestId = interpreted.result.request.id;
  const applied = await applyStateMaintenance(app.db, { workspaceId, requestId });
  assert.equal(applied.status, 'APPLIED');
  const path = workspacePath(workspaceId, `/assist-sessions/${sessionId}/chat-commands`);
  const response = await api.post(path, { command_id: applied.undo_command_id, text: '/undo' });
  assert.equal(response.status, 200, response.text);
  const envelope = response.body as Envelope;
  assert.equal(envelope.result.kind, 'STATE_WITHDRAWAL');
  if (envelope.result.kind !== 'STATE_WITHDRAWAL') throw new Error('wrong result kind');
  assert.equal(envelope.result.status, 'UNDONE');
  assert.equal(envelope.result.request_id, requestId);
  const repositories = createRepositories(app.db);
  assert.equal((await repositories.projects.readProjectState(projectId))?.phase_key, 'DISCOVERY');
  const receipt = await repositories.receipts.findReceipt({
    scopeKey: httpCommandScopeKey(workspaceId), commandId: applied.undo_command_id });
  assert.ok(receipt !== undefined);
  assert.equal(receipt.command_type, 'WithdrawStateMaintenance');
  const changes = await repositories.conversationState.listChangeRows(requestId);
  assert.deepEqual(changes.map((change) => change.status), ['COMPENSATED']);
  const replay = await api.post(path, { command_id: applied.undo_command_id, text: '/撤回' });
  assert.equal(replay.status, 200, replay.text);
  assert.equal(replay.headers['command-replayed'], 'true');
  assert.deepEqual(replay.body, envelope);
  assert.deepEqual(await repositories.conversationState.listChangeRows(requestId), changes);
});
