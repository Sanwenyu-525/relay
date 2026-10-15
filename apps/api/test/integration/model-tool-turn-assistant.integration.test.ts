import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';

import { createTask } from '../../src/application/create-task.js';
import { delegateTask } from '../../src/application/delegate-task.js';
import { markTaskReady } from '../../src/application/task-commands.js';
import { buildToolTurns, persistToolRound, type ToolLoopPlan }
  from '../../src/application/tool-loop.js';
import { withTransaction } from '../../src/application/unit-of-work.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { ModelCallRepository } from '../../src/model/model-call-repository.js';
import { RunToolCallRepository } from '../../src/run/run-tool-call-repository.js';
import { FakeModelPort } from '../../src/workflow/fake-model-port.js';
import { renderToolTurns } from '../../src/workflow/openai-compatible-model-port.js';
import { declaredToolSpecs, readInternalTool } from '../../src/workflow/tool-catalog.js';
import { APP_DATABASE_URL, MIGRATION_DATABASE_URL, MIGRATIONS_DIRECTORY, openDatabase }
  from './integration-support.js';

const app = openDatabase(APP_DATABASE_URL, 'relay-api-test-model-tool-turn-assistant');
before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
});
after(async () => { await app.close(); });

// 只验证协议账本：工具均明确拒绝且不派发，不伪造一次成功的文件读取。
test('tool turns save and reload assistant protocol fields while legacy NULL stays unknown', async () => {
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  await withTransaction(app.db, async (repositories) => {
    await repositories.workspaces.insertWorkspace({ id: workspaceId, name: 'tool-turn-protocol' });
    await repositories.workspaces.insertAuthorityRow(workspaceId);
    await repositories.projects.insertProject({ id: projectId, workspaceId,
      title: '基础工具续轮', projectType: 'DEVELOPMENT' });
  });
  const task = await createTask(app.db, { workspaceId, commandId: randomUUID(), projectId,
    title: '工具消息保存', objective: '保存与读回原 assistant 字段', mode: 'ME',
    expectedOutputs: { kind: 'MARKDOWN_DOCUMENT' },
    criteria: [{ criterionId: 'c1', statement: '人工确认', required: true, method: 'HUMAN' }] });
  const ready = await markTaskReady(app.db, { workspaceId, taskId: task.result.task_id,
    commandId: randomUUID(), expectedRevision: task.result.revision });
  const delegated = await delegateTask(app.db, { workspaceId, taskId: task.result.task_id,
    commandId: randomUUID(), expectedTaskRevision: ready.result.revision });
  const runId = delegated.result.run_id;
  const attemptId = randomUUID();
  const manifestId = randomUUID();
  const stepId = await withTransaction(app.db, async (repositories) => {
    const step = await repositories.runs.readStepByKind(runId, 'DRAFT');
    assert.ok(step);
    const stepId = step.id;
    await repositories.runs.insertStepAttempt({ id: attemptId, stepId,
      attemptNumber: 1n, attemptKey: 'tool-turn-protocol' });
    await repositories.runs.insertContextManifest({ id: manifestId, runId, stepId,
      builderVersion: 'test-v1', manifestHash: Buffer.alloc(32), payload: {} });
    return stepId;
  });
  const modelCalls = new ModelCallRepository(app.db);
  const modelCallId = randomUUID();
  await modelCalls.begin(modelCallId, { workspaceId, kind: 'DRAFT', stepAttemptId: attemptId,
    manifestId }, new FakeModelPort().identity);
  await modelCalls.settle(modelCallId, { status: 'COMPLETED' });
  const definitions = ['list_directory', 'search_text'].map((name) => readInternalTool(name)!);
  const resourceId = randomUUID();
  const plan: ToolLoopPlan = { projectId, resourceId, canonicalRoot: 'D:\\synthetic-tool-turn',
    intent: { intent_key: 'tool-loop-v1', resource_id: resourceId, connections: {},
      allowed_tools: definitions.map((entry) => entry.spec.name), max_rounds: 2, max_tool_calls: 4 },
    specs: declaredToolSpecs(definitions.map((entry) => entry.spec.name)),
    allowed: new Map(definitions.map((entry) => [entry.spec.name, entry])) };
  const persisted = await persistToolRound(app.db, { workspaceId, projectId, runId, stepId,
    stepAttemptId: attemptId, modelCallId, round: 0, plan, usedCalls: 0, cancelled: false,
    preamble: '我先读取实际目录。', reasoningContent: '以工具结果继续。',
    calls: [{ providerToolCallId: 'call-list', name: 'list_directory', arguments: {} },
      { providerToolCallId: 'call-search', name: 'search_text', arguments: { query: 'Relay' } }] });
  const repository = new RunToolCallRepository(app.db);
  for (const row of persisted.rows) {
    await repository.reject(row.id, 'TEST_NOT_DISPATCHED', '本用例只核对协议保存，不派发外部动作。');
  }
  // 缺省列模拟 0073 之前未保存 assistant 字段的账本形状。
  const legacy = await repository.insert({ id: randomUUID(), workspace_id: workspaceId,
    project_id: projectId, run_id: runId, step_id: stepId, step_attempt_id: attemptId,
    model_call_id: modelCallId, round: 1, ordinal: 0, provider_tool_call_id: 'call-legacy',
    tool_name: 'list_directory', arguments: {}, arguments_sha256: '0'.repeat(64) });
  await repository.reject(legacy.id, 'TEST_NOT_DISPATCHED', '旧协议行未派发。');

  const saved = await repository.listByAttempt(attemptId);
  assert.deepEqual(saved[0]?.assistant_message,
    { content: '我先读取实际目录。', reasoning_content: '以工具结果继续。' });
  assert.equal(saved[1]?.assistant_message, null);
  assert.equal(saved[2]?.assistant_message, null);
  const turns = buildToolTurns(saved, new Map());
  assert.equal(turns[0]?.preamble, '我先读取实际目录。');
  assert.equal(turns[0]?.reasoningContent, '以工具结果继续。');
  assert.deepEqual(turns[0]?.calls.map((call) => call.providerToolCallId), ['call-list', 'call-search']);
  assert.deepEqual(turns[0]?.results.map((result) => result.providerToolCallId), ['call-list', 'call-search']);
  assert.ok(turns[0]?.results.every((result) => result.isError &&
    JSON.parse(result.content).reason === 'TEST_NOT_DISPATCHED'));
  assert.equal(turns[1]?.preamble, '');
  assert.equal(turns[1]?.reasoningContent, undefined);
  const messages = renderToolTurns(turns);
  assert.equal(messages[0]?.content, '我先读取实际目录。');
  assert.equal(messages[0]?.additional_kwargs.reasoning_content, '以工具结果继续。');
  assert.equal(messages[3]?.content, '');
  assert.equal(messages[3]?.additional_kwargs.reasoning_content, undefined);
});
