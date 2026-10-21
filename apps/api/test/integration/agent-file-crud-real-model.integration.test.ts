// Opt-in real-model slice of the *ordinary chat* file-editing path. It runs ONLY when
// RELAY_MODEL_* is fully configured, so the standard regression never spends tokens.
//
// Why this file exists: every earlier real-model case built its own Run by calling
// delegateTask() directly. That proves the tool loop works but says nothing about whether a
// user typing "change this file" in the chat actually reaches it. The chain under test is
// exactly the product one:  chat message -> AGENT main loop (real model) -> execution
// candidate -> Apply -> Task/Run -> Gateway tool loop (real model) -> bytes on disk.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

import { runAssistGenerationTick } from '../../src/application/assist-runner.js';
import { withTransaction } from '../../src/application/unit-of-work.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { RunToolCallRepository } from '../../src/run/run-tool-call-repository.js';
import { ManagedContentStore } from '../../src/storage/managed-content-store.js';
import { describeModelPortStatus, readModelPortConfig } from '../../src/workflow/model-port-config.js';
import { OpenAiCompatibleModelPort } from '../../src/workflow/openai-compatible-model-port.js';
import { runOneCommand } from '../../src/worker/run-command.js';
import { createDataRoot, startTestApi, workspacePath } from './api-harness.js';
import { APP_DATABASE_URL, MIGRATIONS_DIRECTORY, MIGRATION_DATABASE_URL, openDatabase } from
  './integration-support.js';

const modelReady = describeModelPortStatus(process.env).configured;
const app = openDatabase(APP_DATABASE_URL, 'relay-api-test-agent-file-crud-real-model');
let dataRoot: string;
const roots: string[] = [];

before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
  dataRoot = await createDataRoot();
});
after(async () => {
  await app.close();
  await rm(dataRoot, { recursive: true, force: true });
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function workspace(name: string): Promise<string> {
  const workspaceId = randomUUID();
  await withTransaction(app.db, async (repositories) => {
    await repositories.workspaces.insertWorkspace({ id: workspaceId, name });
    await repositories.workspaces.insertAuthorityRow(workspaceId);
  });
  return workspaceId;
}

/** 打开一个已存在文件的普通目录，并切到 AUTO 档（默认打开是 READ_ONLY）。 */
async function openAutoWriteDirectory(api: Awaited<ReturnType<typeof startTestApi>>,
  name: string, files: Readonly<Record<string, string>>) {
  const workspaceId = await workspace(name);
  const root = await mkdtemp(join(tmpdir(), 'relay-real-chat-crud-'));
  roots.push(root);
  for (const [relativePath, content] of Object.entries(files)) {
    const target = join(root, relativePath);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
  const opened = await api.post(workspacePath(workspaceId, '/working-directories/open'), {
    command_id: randomUUID(), root_path: root });
  assert.equal(opened.status, 200, opened.text);
  const result = (opened.body as { result: { association: { project_id: string; resource_id: string };
    write_readiness: { access_revision: string; write_tier: string } } }).result;
  const { project_id: projectId, resource_id: resourceId } = result.association;
  const write = await api.post(workspacePath(workspaceId,
    `/projects/${projectId}/managed-resources/${resourceId}/local-access`), {
    command_id: randomUUID(), expected_revision: result.write_readiness.access_revision,
    write_tier: 'AUTO' });
  assert.equal(write.status, 200, write.text);
  return { workspaceId, projectId, resourceId, root };
}

test('a real chat request to edit one file reaches the tool loop and changes the bytes on disk',
  { skip: !modelReady && 'RELAY_MODEL_* not configured', timeout: 900_000 }, async () => {
    const api = await startTestApi();
    try {
      const config = readModelPortConfig(process.env);
      assert.ok(config !== undefined);
      const modelPort = new OpenAiCompatibleModelPort(config);

      const original = '// 用户原有注释，必须保留\nexport const greet = () => "hello";\n';
      const env = await openAutoWriteDirectory(api, 'real-chat-file-edit', {
        'src/greeter.ts': original,
        'src/unrelated.ts': '// 与本任务无关，必须原样保留\nexport const keep = true;\n',
      });

      const session = await api.post(workspacePath(env.workspaceId, '/assist-sessions'), {
        command_id: randomUUID(), project_id: env.projectId, title: '真实模型文件修改' });
      assert.equal(session.status, 201, session.text);
      const sessionId = (session.body as { result: { session_id: string } }).result.session_id;
      const bound = await api.post(workspacePath(env.workspaceId,
        `/assist-sessions/${sessionId}/working-directory`), {
        command_id: randomUUID(), resource_id: env.resourceId });
      assert.equal(bound.status, 200, bound.text);
      const sent = await api.post(workspacePath(env.workspaceId,
        `/assist-sessions/${sessionId}/messages`), {
        command_id: randomUUID(),
        content: '把 src/greeter.ts 里 greet 的返回值从 "hello" 改成 "RELAY-CHAT-OK"，' +
          '文件里其他内容一个字都不要改，也不要动别的文件。',
        intent: 'DISCUSS' });
      assert.equal(sent.status, 202, sent.text);
      const sentIds = (sent.body as { result: { user_message_id: string;
        assistant_message_id: string } }).result;

      // 真实模型跑主流程（可能有多轮只读工具）。循环领取，直到本条消息离开 PENDING。
      const messagesPath = workspacePath(env.workspaceId,
        `/assist-sessions/${sessionId}/messages`);
      const messageOf = async () => {
        const response = await api.get(messagesPath);
        assert.equal(response.status, 200, response.text);
        return (response.body as { items: { id: string; status: string; content: string | null;
          error_code: string | null }[] }).items.find((item) => item.id === sentIds.assistant_message_id);
      };
      for (let attempt = 0; attempt < 12; attempt += 1) {
        const current = await messageOf();
        if (current?.status !== 'PENDING') break;
        const generated = await runAssistGenerationTick(app.db, {
          workerId: `real-chat-${randomUUID()}`, storage: new ManagedContentStore(api.dataRoot),
          leaseMs: 60_000, maxMessages: 1, modelPort });
        assert.ok(generated, '本条消息必须由普通主流程领取');
      }
      const assistant = await messageOf();
      console.log('real-chat-edit assistant>>', JSON.stringify({
        status: assistant?.status, error: assistant?.error_code,
        content: (assistant?.content ?? '').slice(0, 400) }));
      assert.equal(assistant?.status, 'COMPLETED',
        `普通主流程必须给出可读答复而不是失败：${assistant?.status}/${assistant?.error_code}`);

      // 候选必须真实落在原用户消息上，且明确声明本次要写文件。
      const requestList = await api.get(workspacePath(env.workspaceId,
        `/conversation-execution-requests?session_id=${sessionId}`));
      assert.equal(requestList.status, 200, requestList.text);
      const request = (requestList.body as { items: { request_id: string; source_message_id: string;
        decision: string; status: string; candidate: Record<string, unknown> | null }[] })
        .items.find((item) => item.source_message_id === sentIds.user_message_id);
      assert.ok(request, '主流程必须为这条原用户消息留下执行请求行');
      assert.equal(request!.decision, 'PREPARE',
        `明确要求改文件的请求必须成为执行候选，而不是澄清：${JSON.stringify(request)}`);
      assert.equal(request!.candidate?.writes_files, true);
      const changes = request!.candidate?.file_changes;
      assert.ok(Array.isArray(changes) && changes.length > 0,
        `候选必须声明要改的路径：${JSON.stringify(request!.candidate)}`);

      const applied = await api.post(workspacePath(env.workspaceId,
        `/conversation-execution-requests/${request!.request_id}/applications`), {});
      assert.equal(applied.status, 200, applied.text);
      const runId = (applied.body as { result: { run_id: string } }).result.run_id;

      // 生产图 + 真实模型工具循环：每条命令推进一段，直到停在人工验收点。
      for (let step = 0; step < 24; step += 1) {
        const delivered = await runOneCommand(app.db, { workerId: `real-chat-run-${randomUUID()}`,
          dataRoot: api.dataRoot, checkpointUrl: APP_DATABASE_URL });
        if (delivered === undefined) break;
        assert.equal(delivered.runId, runId, 'Worker 必须消费本次请求的 Run');
        if (delivered.outcome === 'DONE') break;
      }

      const written = await readFile(join(env.root, 'src', 'greeter.ts'), 'utf8');
      const rows = await new RunToolCallRepository(app.db).listByRun(runId);
      console.log('real-chat-edit trace>>', JSON.stringify({ runId,
        tools: rows.map((row) => ({ tool: row.tool_name, status: row.status,
          reason: row.result_ref?.reason ?? null })) }));
      assert.match(written, /RELAY-CHAT-OK/u,
        `磁盘内容必须由工具循环真实写出，而不是模型自称完成：${written}`);
      assert.ok(written.includes('用户原有注释，必须保留'),
        '修改必须保留文件里原有的无关内容');
      assert.equal(await readFile(join(env.root, 'src', 'unrelated.ts'), 'utf8'),
        '// 与本任务无关，必须原样保留\nexport const keep = true;\n');
      assert.ok(rows.some((row) => row.tool_name === 'read_file' && row.status === 'SETTLED'),
        '模型必须先读到真实文件');
      assert.ok(rows.some((row) => row.tool_name === 'apply_changeset' && row.status === 'SETTLED'),
        `模型必须发出真实写入并结算：${JSON.stringify(rows.map((row) => row.status))}`);
    } finally {
      await api.stop();
    }
  });
