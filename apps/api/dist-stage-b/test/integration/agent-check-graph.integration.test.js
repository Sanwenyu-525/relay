import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { sql } from 'kysely';
import { createProject } from '../../src/application/create-project.js';
import { createTask } from '../../src/application/create-task.js';
import { delegateTask } from '../../src/application/delegate-task.js';
import { createGatewayConnectionCommand } from '../../src/application/gateway-commands.js';
import { createGatewayPolicy, registerManagedResource } from '../../src/application/gateway-configuration.js';
import { markTaskReady } from '../../src/application/task-commands.js';
import { createRepositories, withTransaction } from '../../src/application/unit-of-work.js';
import { GRAPH_CHECKPOINT_SCHEMA, installGraphCheckpoints } from '../../src/infrastructure/graph-checkpoints.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { resolveStoredContentPath } from '../../src/storage/managed-content-store.js';
import { describeModelPortStatus } from '../../src/workflow/model-port-config.js';
import { runOneCommand } from '../../src/worker/run-command.js';
import { executeToolLoopStep } from '../../src/worker/tool-loop-action.js';
import { createWorkspace } from './api-harness.js';
import { createTemporaryDatabase, MIGRATIONS_DIRECTORY, openDatabase } from './integration-support.js';
test('the production graph continues after a failed check through repair to a persisted HUMAN candidate', { timeout: 120_000 }, async () => {
    assert.equal(describeModelPortStatus(process.env).configured, false, 'this regression requires FakeModelPort and must not call a real provider');
    const database = await createTemporaryDatabase('agent_check_graph');
    let app;
    let temporaryRoot;
    try {
        await runMigrations({ connectionString: database.migrationUrl, directory: MIGRATIONS_DIRECTORY });
        await installGraphCheckpoints(database.migrationUrl);
        app = openDatabase(database.appUrl, 'relay-agent-check-graph-test');
        const db = app.db;
        const repositories = createRepositories(db);
        temporaryRoot = await mkdtemp(join(tmpdir(), 'relay-agent-check-graph-'));
        const root = join(temporaryRoot, 'workspace');
        const dataRoot = join(temporaryRoot, 'data');
        await mkdir(join(root, 'src'), { recursive: true });
        await mkdir(dataRoot);
        const target = join(root, 'src', 'value.txt');
        const initial = 'incorrect\n';
        const repaired = `fixed-${randomUUID()}\n`;
        const unrelated = 'user work must stay byte-for-byte\r\n';
        await writeFile(target, initial);
        await writeFile(join(root, 'notes.txt'), unrelated);
        // 检查位于受管根外：写工具无法篡改检查来伪造通过。
        const checker = join(temporaryRoot, 'check.mjs');
        const checkerText = 'import { readFileSync } from "node:fs";\n' +
            'const actual = readFileSync("src/value.txt", "utf8");\n' +
            `const expected = ${JSON.stringify(repaired)};\n` +
            'if (actual !== expected) { console.error("expected=" + expected.trim() +\n' +
            '  "; actual=" + actual.trim()); process.exitCode = 1; }\n' +
            'else console.log("verified=" + actual.trim());\n';
        await writeFile(checker, checkerText);
        const check = { id: 'tests', executable: process.execPath,
            args: [checker], max_output_bytes: 4096,
            executable_sha256: createHash('sha256').update(await readFile(process.execPath)).digest('hex') };
        const baseline = createHash('sha256').update(initial).digest('hex');
        const workspaceId = await createWorkspace(db);
        const project = await createProject(db, { workspaceId, commandId: randomUUID(),
            title: 'Graph check repair', projectType: 'DEVELOPMENT' });
        const projectId = project.result.project_id;
        const resource = await registerManagedResource(db, { workspaceId, projectId, rootPath: root });
        const connection = await createGatewayConnectionCommand(db, { workspaceId, projectId,
            commandId: randomUUID(), rootPath: root, capabilities: ['FILE_READ', 'FILE_WRITE', 'CLI_RUN'] });
        const connectionId = connection.result.connection_id;
        assert.ok(connectionId !== undefined);
        for (const [capability, actionType] of [['FILE_READ', 'READ_FILE'],
            ['FILE_WRITE', 'APPLY_CHANGESET'], ['CLI_RUN', 'CLI_RUN']]) {
            await createGatewayPolicy(db, { workspaceId, projectId, capability, actionType,
                targetPrefix: resource.canonicalRoot, decision: 'AUTO', maxPayloadBytes: 262144 });
        }
        const task = await createTask(db, { workspaceId, projectId, commandId: randomUUID(),
            title: 'Repair from a failed check', objective: 'Run tests, read and repair, then rerun tests',
            expectedOutputs: { kind: 'MARKDOWN_DOCUMENT' }, mode: 'ME',
            criteria: [{ criterionId: 'human', statement: 'Human reviews the repaired candidate',
                    required: true, method: 'HUMAN' }] });
        const ready = await markTaskReady(db, { workspaceId, taskId: task.result.task_id,
            commandId: randomUUID(), expectedRevision: task.result.revision });
        const delegated = await delegateTask(db, { workspaceId, taskId: task.result.task_id,
            commandId: randomUUID(), expectedTaskRevision: ready.result.revision,
            toolLoopAction: { resource_id: resource.resourceId,
                connections: { FILE_READ: connectionId, FILE_WRITE: connectionId, CLI_RUN: connectionId },
                allowed_tools: ['run_check', 'read_file', 'apply_changeset'], max_rounds: 6, max_tool_calls: 8 },
            scopeGrant: { resource_id: resource.resourceId,
                allowed_actions: ['APPLY_CHANGESET', 'CLI_RUN'], checks: [check] } });
        const runId = delegated.result.run_id;
        const fakeToolScript = [
            [{ name: 'run_check', arguments: { check_id: 'tests' } }],
            [{ name: 'read_file', arguments: { relative_path: 'src/value.txt' } }],
            [{ name: 'apply_changeset', arguments: { changes: [{ action: 'MODIFY',
                                path: 'src/value.txt', baselineSha256: baseline, content: repaired }] } }],
            [{ name: 'run_check', arguments: { check_id: 'tests' } }],
        ];
        const deliver = () => runOneCommand(db, { workerId: `graph-check-${randomUUID()}`,
            dataRoot, checkpointUrl: database.appUrl, fakeToolScript });
        const delivered = await deliver();
        assert.equal(delivered?.runId, runId);
        assert.equal(delivered?.outcome, 'DONE');
        const rows = await repositories.toolCalls.listByRun(runId);
        // 把 TOOL_CHECK_FAILED 后继变成 END 会在这里失败：只剩第一次检查，修复不发生。
        assert.deepEqual(rows.map((row) => [row.round, row.tool_name, row.status]), [
            [0, 'run_check', 'SETTLED'], [1, 'read_file', 'SETTLED'],
            [2, 'apply_changeset', 'SETTLED'], [3, 'run_check', 'SETTLED'],
        ]);
        assert.equal(rows[0].result_ref?.exitCode, 1);
        assert.equal(rows[0].result_ref?.outcome, 'FAILED');
        assert.match(String(rows[0].result_ref?.stderr), /actual=incorrect/);
        assert.ok(String(rows[0].result_ref?.stderr).includes(repaired.trim()));
        assert.equal(rows[1].result_ref?.content, initial);
        assert.equal(rows[1].result_ref?.sha256, baseline);
        assert.equal(rows[3].result_ref?.exitCode, 0);
        assert.equal(rows[3].result_ref?.outcome, 'SUCCEEDED');
        assert.equal(rows[3].result_ref?.stdout, `verified=${repaired.trim()}\n`);
        const operations = await repositories.gateway.listRunOperations(runId);
        assert.equal(operations.length, 4);
        const failed = await repositories.gateway.readOperation(rows[0].operation_id);
        assert.equal(failed?.status, 'FAILED');
        const failedInvocations = await repositories.gateway.listInvocations(failed.id);
        assert.equal(failedInvocations.length, 1);
        assert.equal(failedInvocations[0].status, 'FAILED');
        assert.ok(failedInvocations[0].resource_claim_id !== null);
        assert.equal((await repositories.gateway.readClaim(failedInvocations[0].resource_claim_id))?.status, 'RELEASED', 'a normal check failure must not quarantine the workspace needed for repair');
        assert.equal((await repositories.runs.readRun(runId))?.status, 'WAITING_APPROVAL');
        const reviews = await repositories.reviews.listByRun(runId);
        assert.equal(reviews.length, 1);
        assert.equal(reviews[0].kind, 'CRITERION');
        assert.equal(reviews[0].status, 'OPEN');
        assert.equal(reviews[0].criterion_id, 'human');
        const versions = (await sql `
        select storage_ref, content_hash from artifact_versions
        where source_ref like ${`run:${runId}/%`}`.execute(db)).rows;
        assert.equal(versions.length, 1, 'graph must persist the candidate before human review');
        const content = await readFile(resolveStoredContentPath(dataRoot, versions[0].storage_ref));
        assert.equal(createHash('sha256').update(content).digest('hex'), versions[0].content_hash.toString('hex'));
        assert.equal((await sql `select count(*)::bigint as count
        from completion_records where task_id = ${task.result.task_id}`.execute(db)).rows[0].count, 0n);
        const saver = PostgresSaver.fromConnString(database.appUrl, { schema: GRAPH_CHECKPOINT_SCHEMA });
        const history = [];
        try {
            for await (const tuple of saver.list({ configurable: { thread_id: runId, checkpoint_ns: '' } })) {
                history.unshift(tuple.checkpoint.channel_values);
            }
        }
        finally {
            await saver.end();
        }
        const failureIndex = history.findIndex((state) => state.lastStatus === 'TOOL_CHECK_FAILED');
        assert.ok(failureIndex >= 0, 'the check-failure node outcome must be durably checkpointed');
        assert.ok(history.slice(failureIndex + 1).some((state) => state.lastStatus === 'TOOL_LOOP_ACTION_REQUIRED' && state.toolCallId === rows[1].id), 'the persisted graph must advance to the read after the check failure');
        assert.equal(history.at(-1)?.lastStatus, 'WAITING_REVIEW');
        const checkpoints = (await sql `select count(*)::bigint as count
        from relay_graph_v1.checkpoints where thread_id = ${runId}`.execute(db)).rows[0].count;
        assert.equal(await deliver(), undefined);
        // 新 START 重放已保存的 Review 屏障；不会重建模型轮次或再执行写入。
        await withTransaction(db, (owned) => owned.dispatch.insertCommand({ id: randomUUID(),
            workspaceId, runId, sourceCommandId: randomUUID(), kind: 'START' }));
        assert.equal((await deliver())?.outcome, 'DONE');
        for (const row of rows) {
            const replay = await executeToolLoopStep(db, { toolCallId: row.id,
                claim: { commandId: randomUUID(), runId, workspaceId, kind: 'START',
                    reviewDecisionId: null, workerId: 'settled-tool-replay', epoch: 0n } });
            assert.equal(replay.operationId, row.operation_id);
        }
        assert.deepEqual(await repositories.toolCalls.listByRun(runId), rows);
        assert.deepEqual(await repositories.gateway.listRunOperations(runId), operations);
        assert.equal((await sql `select count(*)::bigint as count
        from invocation_attempts where run_id = ${runId}`.execute(db)).rows[0].count, 4n);
        assert.equal((await sql `select count(*)::bigint as count
        from relay_graph_v1.checkpoints where thread_id = ${runId}`.execute(db)).rows[0].count, checkpoints);
        assert.equal(await readFile(target, 'utf8'), repaired);
        assert.equal(await readFile(join(root, 'notes.txt'), 'utf8'), unrelated);
        assert.equal(await readFile(checker, 'utf8'), checkerText);
    }
    finally {
        await app?.close();
        await database.drop();
        if (temporaryRoot !== undefined)
            await rm(temporaryRoot, { recursive: true, force: true });
    }
});
