import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { bindAssistSessionDirectory, createAssistSession, requestAssistMessage } from '../../src/application/assist-commands.js';
import { openWorkingDirectory } from '../../src/application/open-working-directory.js';
import { setLocalDirectoryWriteTier } from '../../src/application/local-directory-access.js';
import { setMemorySettings } from '../../src/application/memory-settings.js';
import { readAssistModelRuntime } from '../../src/application/assist-model-runtime.js';
import { runAssistGenerationTick, type AssistGenerationOptions } from '../../src/application/assist-runner.js';
import { pauseGoal, resumeGoalCommand } from '../../src/application/assist-goals.js';
import { goalRoundMessageId, runAssistGoalTick } from '../../src/application/goal-advance.js';
import { syncModelCatalog } from '../../src/application/model-catalog-sync.js';
import { selectSessionModel } from '../../src/application/select-session-model.js';
import { createRepositories } from '../../src/application/unit-of-work.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { ManagedContentStore } from '../../src/storage/managed-content-store.js';
import { FakeModelPort } from '../../src/workflow/fake-model-port.js';
import { SessionToolCallRepository } from '../../src/assist/session-tool-call-repository.js';
import { SessionTodoRepository } from '../../src/assist/session-todo-repository.js';
import { createDataRoot, createWorkspace } from './api-harness.js';
import { APP_DATABASE_URL, MIGRATION_DATABASE_URL, MIGRATIONS_DIRECTORY, openDatabase } from './integration-support.js';

// Explicit opt-in only. The credential is inherited in memory by the isolated
// integration runner, never included in arguments, fixtures, snapshots or output.
for (const scenario of ['reply', 'todo', 'files-auto', 'files-full', 'goal-files']) test(`live OpenRouter: real catalog → selection → frozen message → guarded ${scenario} → original ledger`,
  { skip: process.env.RELAY_ACCEPTANCE_REAL_OPENROUTER !== '1', timeout: 300_000 }, async () => {
    assert.ok(process.env.RELAY_OPENROUTER_API_KEY, 'a separately configured credential is required');
    const app = openDatabase(APP_DATABASE_URL, 'relay-free-model-live-test');
    let dataRoot: string | undefined;
    const useTools = scenario === 'todo';
    const goalFiles = scenario === 'goal-files';
    const files = scenario.startsWith('files-') || goalFiles;
    const env: NodeJS.ProcessEnv = { RELAY_MODEL_PROVIDER: 'fake', RELAY_MODEL_CATALOG_ENABLED: 'true',
      RELAY_OPENROUTER_API_KEY: process.env.RELAY_OPENROUTER_API_KEY,
      RELAY_MODEL_MAX_OUTPUT_TOKENS: files ? '2048' : '512', RELAY_MODEL_MAX_CALL_TOKENS: '32768',
      RELAY_MODEL_MAX_SCOPE_CALLS: files ? '8' : '3', RELAY_MODEL_MAX_SCOPE_TOKENS: '262144',
      RELAY_MODEL_TIMEOUT_MS: '60000' };
    try {
      await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
      dataRoot = await createDataRoot();
      const synced = await syncModelCatalog({ db: app.db, env, trigger: 'startup' });
      assert.ok(synced.status === 'PUBLISHED' || synced.status === 'SKIPPED',
        '目录必须已同步，后续场景允许复用同库的有效缓存');
      const repositories = createRepositories(app.db);
      const models = (await repositories.modelCatalog.readEntries(true))
        .filter((entry) => entry.source_model_id !== 'openrouter/free' &&
          entry.capabilities.text_input === true && entry.capabilities.text_output === true &&
          entry.capabilities.tools === true && entry.capabilities.response_format === true &&
          entry.context_window !== null && entry.context_window >= 16384)
        .sort((left, right) => left.source_model_id.localeCompare(right.source_model_id));
      const requestedFreeModel = process.env.RELAY_ACCEPTANCE_FREE_MODEL;
      const selected = requestedFreeModel === undefined ? models[0]
        : models.find((entry) => entry.source_model_id === requestedFreeModel);
      assert.ok(selected, 'the selected model must be in the free catalog with declared text/tool/JSON support');
      const workspaceId = await createWorkspace(app.db);
      const marker = `RELAY-DISK-${randomUUID()}`;
      const original = `${marker}\n`;
      const root = join(dataRoot, 'synthetic-files');
      let projectId: string | undefined;
      let resourceId: string | undefined;
      if (files) {
        await mkdir(root);
        await writeFile(join(root, 'target.txt'), original);
        await writeFile(join(root, 'protected.txt'), 'UNRELATED-KEEP\n');
        const opened = await openWorkingDirectory(app.db, { workspaceId,
          commandId: randomUUID(), rootPath: root });
        assert.ok(opened.result.association);
        projectId = opened.result.association.project_id;
        resourceId = opened.result.association.resource_id;
        await setLocalDirectoryWriteTier(app.db, { workspaceId, projectId, resourceId,
          commandId: randomUUID(), expectedRevision: opened.result.write_readiness.access_revision,
          tier: scenario === 'files-full' ? 'FULL' : 'AUTO' });
        await setMemorySettings(app.db, { workspaceId, commandId: randomUUID(), expectedRevision: '0',
          recallEnabled: true, automaticCompaction: true, autoCapture: false });
      }
      const created = await createAssistSession(app.db, { workspaceId, projectId: projectId ?? null,
        commandId: randomUUID(), title: 'Synthetic live acceptance' });
      const sessionId = created.result.session_id;
      if (resourceId !== undefined) await bindAssistSessionDirectory(app.db, { workspaceId,
        sessionId, resourceId, commandId: randomUUID() });
      const selection = await selectSessionModel(app.db, { workspaceId, sessionId, env,
        commandId: randomUUID(), requestedModel: selected.source_model_id });
      const accepted = await requestAssistMessage(app.db, { workspaceId, sessionId,
        commandId: randomUUID(), expectedModelSelectionRevision: selection.result.revision,
        ...(goalFiles ? { chatMode: 'GOAL' as const } : {}),
        content: files
          ? 'Synthetic file test. Read target.txt with read_file, keep its original bytes and append '
            + 'exactly RELAY_FREE_FILE_OK followed by a newline using apply_changeset with the read baseline. '
            + 'Then read target.txt again to verify it. Reply with the original RELAY-DISK marker from the file. '
            + 'Only modify target.txt. Do not delegate, create execution candidates, or change project state.'
            + (goalFiles ? ' Goal success criterion c1: preserve the original marker and include exactly one '
              + 'RELAY_FREE_FILE_OK line. On every continuation read target.txt again; if that line exists, '
              + 'do not write again. Report goal progress and real evidence for c1; model completion is not human acceptance.' : '')
          : useTools
          ? 'Synthetic tool test. Call todo_write with expected_version 0 and exactly one item '
            + '{"content":"RELAY_FREE_TOOL_OK","status":"completed"}. After the tool succeeds, '
            + 'reply RELAY_FREE_TOOL_OK. Do not delegate, propose work, or change any project state.'
          : 'This is a synthetic connection test. Do not invoke tools, propose work, or change state. Reply with RELAY_LIVE_OK.' }, env);
      const wire: { model: string; guarded: boolean; tools: string[] }[] = [];
      const generationOptions: AssistGenerationOptions = { workerId: `live-${randomUUID()}`,
        storage: new ManagedContentStore(dataRoot), modelPort: new FakeModelPort(), modelEnv: env,
        modelFetchDependencies: { fetch: async (input, init) => {
          if (String(input).endsWith('/chat/completions')) {
            assert.ok(wire.length < 8, '合成验收最多发出八次免费请求');
            const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
            if (goalFiles) assert.deepEqual(body.response_format, { type: 'json_object' },
              '目标协议必须落实为实际 Provider 请求格式');
            const provider = body.provider as Record<string, unknown> | undefined;
            const prices = provider?.max_price as Record<string, unknown> | undefined;
            const tools = Array.isArray(body.tools) ? body.tools as { function?: { name?: string } }[] : [];
            wire.push({ model: String(body.model), tools: tools.flatMap((tool) =>
              tool.function?.name === undefined ? [] : [tool.function.name]),
              guarded: provider?.allow_fallbacks === false &&
              provider.require_parameters === true && ['prompt', 'completion', 'request', 'image']
                .every((key) => prices?.[key] === 0) && !('models' in body) && !('plugins' in body) });
            assert.ok(wire.at(-1)?.guarded, '拒绝发出缺少零价格与禁止付费回退约束的请求');
          }
          return fetch(input, init);
        } }, leaseMs: 90_000, maxMessages: 1 };
      const result = await runAssistGenerationTick(app.db, generationOptions);
      const runtime = await readAssistModelRuntime(app.db, { workspaceId, messageId: accepted.result.assistant_message_id });
      // Only safe metadata is printed; goal diagnostics below contain synthetic
      // fixture output only. No credentials, endpoint configuration or account labels.
      console.log(JSON.stringify({ liveModelAcceptance: true, scenario, status: result?.status,
        preferredModel: runtime.preferred_model, actualModel: runtime.actual_model,
        calls: runtime.calls.map((call) => ({ model: call.model, status: call.status,
          errorKind: call.error_kind, inputTokens: call.input_tokens, outputTokens: call.output_tokens })),
        wireCalls: wire.length, allRequestsGuarded: wire.length > 0 && wire.every((call) => call.guarded) }));
      assert.equal(result?.status, 'COMPLETED', 'real generation must complete in the original message');
      assert.ok(wire.length > 0 && wire.length <= (files ? 8 : 3));
      assert.ok(wire.every((call) => call.guarded));
      assert.equal(runtime.calls.length, wire.length, 'each actual HTTP attempt must have its own original ledger row');
      assert.equal(runtime.preferred_model, selected.source_model_id);
      assert.equal(runtime.calls.at(-1)?.status, 'COMPLETED');
      const message = await repositories.assist.readMessage(accepted.result.assistant_message_id);
      if (goalFiles) console.log(JSON.stringify({ liveGoalFirstOutcome: true,
        outcome: message?.goal_outcome, reply: message?.content }));
      assert.ok(message?.content?.trim(), 'the original assistant message must contain the real reply');
      if (files) {
        const calls = await new SessionToolCallRepository(app.db).listByMessage(message!.id);
        const settled = calls.filter((call) => call.status === 'SETTLED');
        const writeIndex = settled.findIndex((call) => call.tool_name === 'apply_changeset');
        console.log(JSON.stringify({ freeFileToolEvidence: true, calls: calls.map((call) => ({
          tool: call.tool_name, status: call.status, reason: call.rejection_reason,
          argumentKeys: Object.keys(call.arguments) })), declaredTools: [...new Set(wire.flatMap((call) => call.tools))],
          methodAction: message!.method_action }));
        assert.ok(writeIndex > 0, '必须实际执行修改，且先读取真实文件');
        assert.ok(settled.slice(0, writeIndex).some((call) => call.tool_name === 'read_file'));
        assert.ok(settled.slice(writeIndex + 1).some((call) => call.tool_name === 'read_file'),
          '写入之后必须真实回读');
        assert.equal(await readFile(join(root, 'target.txt'), 'utf8'), original + 'RELAY_FREE_FILE_OK\n');
        assert.equal(await readFile(join(root, 'protected.txt'), 'utf8'), 'UNRELATED-KEEP\n');
        assert.ok(message!.content!.includes(marker), '标记只能来自磁盘工具结果，用户请求未提供它');
        assert.equal(await runAssistGenerationTick(app.db, { workerId: 'live-replay-check',
          storage: new ManagedContentStore(dataRoot), modelPort: new FakeModelPort(), modelEnv: env,
          leaseMs: 90_000 }), undefined);
        assert.equal((await new SessionToolCallRepository(app.db).listByMessage(message!.id)).length, calls.length);
        assert.equal(await readFile(join(root, 'target.txt'), 'utf8'), original + 'RELAY_FREE_FILE_OK\n');
      }
      if (goalFiles) {
        const goalId = accepted.result.goal_id;
        assert.ok(goalId);
        await pauseGoal(app.db, { workspaceId, goalId, commandId: randomUUID() });
        await runAssistGoalTick(app.db, { workerId: 'free-goal-pause' });
        const paused = await repositories.planGoals.readGoal(goalId);
        console.log(JSON.stringify({ liveGoalPaused: true, status: paused?.status,
          outcome: message!.goal_outcome, criteria: paused?.criteria }));
        assert.ok(paused);
        assert.equal(paused.status, 'PAUSED');
        assert.equal(paused.round_count, 1);
        const commandId = randomUUID();
        const resumed = await resumeGoalCommand(app.db, { workspaceId, goalId, commandId });
        const replay = await resumeGoalCommand(app.db, { workspaceId, goalId, commandId });
        assert.deepEqual(replay.result, resumed.result);
        const tick = await runAssistGoalTick(app.db, { workerId: 'free-goal-resumed-worker' });
        const nextMessageId = goalRoundMessageId(goalId, 2);
        const afterResume = await repositories.planGoals.readGoal(goalId);
        console.log(JSON.stringify({ liveGoalAdvance: true, status: afterResume?.status,
          advanced: tick.advanced.length, skipped: tick.skipped.map((entry) => entry.reason),
          stopCode: afterResume?.stop_reason?.code ?? null }));
        assert.ok(tick.advanced.some((round) => round.goalId === goalId && round.messageId === nextMessageId));
        assert.equal((await runAssistGoalTick(app.db, { workerId: 'free-goal-repeated-tick' }))
          .advanced.some((round) => round.goalId === goalId), false);
        const beforeResumeCalls = wire.length;
        const continued = await runAssistGenerationTick(app.db, { ...generationOptions,
          workerId: 'free-goal-new-generation-worker' });
        const continuedRuntime = await readAssistModelRuntime(app.db, { workspaceId, messageId: nextMessageId });
        const continuedMessage = await repositories.assist.readMessage(nextMessageId);
        console.log(JSON.stringify({ liveGoalContinuation: true, status: continued?.status,
          outcome: continuedMessage?.goal_outcome, reply: continuedMessage?.content,
          errorCode: continued?.errorCode, calls: continuedRuntime.calls.map((call) => ({
            model: call.model, status: call.status, errorKind: call.error_kind })),
          wireCalls: wire.length - beforeResumeCalls, allRequestsGuarded: wire.every((call) => call.guarded) }));
        assert.equal(continued?.messageId, nextMessageId);
        assert.ok(continued);
        assert.equal(continued.status, 'COMPLETED');
        const nextCalls = await new SessionToolCallRepository(app.db).listByMessage(nextMessageId);
        assert.ok(nextCalls.some((call) => call.tool_name === 'read_file' && call.status === 'SETTLED'));
        assert.equal(nextCalls.some((call) => call.tool_name === 'apply_changeset'), false,
          '继续只需回读核对，不能重做已经完成的修改');
        assert.equal(await readFile(join(root, 'target.txt'), 'utf8'), original + 'RELAY_FREE_FILE_OK\n');
        assert.equal(await readFile(join(root, 'protected.txt'), 'utf8'), 'UNRELATED-KEEP\n');
        await runAssistGoalTick(app.db, { workerId: 'free-goal-settle' });
        const awaiting = await repositories.planGoals.readGoal(goalId);
        console.log(JSON.stringify({ liveGoalSettlement: true, status: awaiting?.status,
          roundCount: awaiting?.round_count, stopCode: awaiting?.stop_reason?.code ?? null,
          outcome: (await repositories.assist.readMessage(nextMessageId))?.goal_outcome,
          criteria: awaiting?.criteria }));
        assert.ok(awaiting);
        assert.equal(awaiting.status, 'AWAITING_ACCEPTANCE', '模型声明完成只进入待人工验收');
        assert.equal(awaiting.objective, paused.objective);
        assert.equal(awaiting.round_count, 2);
        assert.equal((await repositories.assist.listMessages(sessionId, 50))
          .filter((entry) => entry.goal_id === goalId).length, 2);
      }
      if (useTools) {
        const calls = await new SessionToolCallRepository(app.db).listByMessage(message!.id);
        assert.ok(calls.some((call) => call.tool_name === 'todo_write' && call.status === 'SETTLED'),
          'the real free model must invoke and settle todo_write');
        const snapshot = await new SessionTodoRepository(app.db).read(sessionId);
        assert.ok(snapshot);
        assert.equal(snapshot.version, 1);
        assert.deepEqual(snapshot.items.map((item) => ({ content: item.content, status: item.status })),
          [{ content: 'RELAY_FREE_TOOL_OK', status: 'completed' }]);
      }
    } catch (error) {
      // Test runner inspection must never serialize an SDK error carrying request headers.
      if (error instanceof assert.AssertionError) throw error;
      throw new Error('Live acceptance stopped before completion; inspect safe ledger metadata and environment connectivity.');
    } finally {
      delete env.RELAY_OPENROUTER_API_KEY;
      await app.close();
      if (dataRoot !== undefined) await rm(dataRoot, { recursive: true, force: true });
    }
  });
