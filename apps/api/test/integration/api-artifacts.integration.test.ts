import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

import { Client } from 'pg';
import { sql } from 'kysely';

import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import {
  managedContentRef,
  resolveStoredContentPath,
} from '../../src/storage/managed-content-store.js';
import {
  APP_DATABASE_URL,
  MIGRATIONS_DIRECTORY,
  MIGRATION_DATABASE_URL,
  openDatabase,
} from './integration-support.js';
import {
  createWorkspace,
  delay,
  expectCommandAccepted,
  expectProblem,
  sendRequest,
  startTestApi,
  withTimeout,
  workspacePath,
  type HttpResponse,
  type TestApi,
} from './api-harness.js';

/**
 * P03：受管 Markdown 内容存储、Artifact 版本、人工接受、完成与重开的真实验收。
 *
 * 使用真实临时 PostgreSQL、真实监听端口与真实的临时 data_root（本文件独享），
 * 覆盖 A03、C01/C02 的人工适用部分、D05/D06。
 *
 * 故障注入用迁移角色建立的行级触发器，并且只对本次用例创建的对象生效，
 * 因此与其他测试文件并行运行时不会影响它们的写入。
 */

const appDatabase = openDatabase(APP_DATABASE_URL, 'relay-api-test-p03-app');

let api: TestApi;
let workspaceId: string;

before(async () => {
  await runMigrations({
    connectionString: MIGRATION_DATABASE_URL,
    directory: MIGRATIONS_DIRECTORY,
  });

  api = await startTestApi();
  workspaceId = await createWorkspace(appDatabase.db);
});

after(async () => {
  try {
    await dropFailingTrigger('state_completion_refs');
    await dropFailingTrigger('artifact_versions');
    await dropFailingTrigger('project_states');
    await dropProjectStateDelayTrigger();
    await dropTaskReadDelayPolicy();
  } finally {
    // before 失败时 api 可能未赋值；清理不能抛 undefined.stop
    try {
      await api?.stop();
    } finally {
      await appDatabase.close();
    }
  }
});

/* -------------------------------------------------------------------------- */
/* 辅助                                                                        */
/* -------------------------------------------------------------------------- */

interface TaskFixture {
  readonly task_id: string;
  readonly revision: string;
  readonly acceptance_revision: string;
  readonly status: string;
}

interface ArtifactFixture {
  readonly artifact_id: string;
  readonly version_id: string;
  readonly version_number: string;
  readonly artifact_revision: string;
  readonly task_revision: string;
  readonly sha256: string;
}

function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function storedContentPath(artifactId: string, versionId: string): string {
  return resolveStoredContentPath(api.dataRoot, managedContentRef(artifactId, versionId));
}

async function createProject(title = 'p03-project'): Promise<string> {
  const commandId = randomUUID();
  const response = await api.post(workspacePath(workspaceId, '/projects'), {
    command_id: commandId,
    title,
    project_type: 'GENERAL',
  });

  return expectCommandAccepted(response, 201, commandId).project_id as string;
}

async function createTask(input: {
  readonly projectId: string | null;
  readonly criteria?: readonly { readonly statement: string; readonly criterion_id: string }[];
  readonly expectedOutputs?: unknown;
}): Promise<TaskFixture> {
  const commandId = randomUUID();
  const response = await api.post(workspacePath(workspaceId, '/tasks'), {
    command_id: commandId,
    project_id: input.projectId,
    title: 'p03-task',
    objective: '验证人工产物与完成重开',
    ...(input.expectedOutputs === undefined ? {} : { expected_outputs: input.expectedOutputs }),
    criteria: input.criteria ?? [
      { criterion_id: 'c1', statement: '人工核对产物与引用' },
    ],
  });
  const result = expectCommandAccepted(response, 201, commandId);

  return {
    task_id: result.task_id as string,
    revision: result.revision as string,
    acceptance_revision: result.acceptance_revision as string,
    status: result.status as string,
  };
}

async function startTask(task: TaskFixture): Promise<TaskFixture> {
  const ready = await api.post(workspacePath(workspaceId, `/tasks/${task.task_id}/ready`), {
    command_id: randomUUID(),
    expected_revision: task.revision,
  });

  assert.equal(ready.status, 200, ready.text);

  const readyResult = (ready.body as { result: { revision: string } }).result;

  return startReadyTask({
    ...task,
    revision: readyResult.revision,
    status: 'READY',
  });
}

/** 已经是 READY（例如刚重开）的 Task 只能直接 start，不能再次 ready。 */
async function startReadyTask(task: TaskFixture): Promise<TaskFixture> {
  const started = await api.post(workspacePath(workspaceId, `/tasks/${task.task_id}/start`), {
    command_id: randomUUID(),
    expected_revision: task.revision,
  });

  assert.equal(started.status, 200, started.text);

  return { ...task, ...(started.body as { result: TaskFixture }).result };
}

async function saveFirstVersion(
  task: TaskFixture,
  content: string,
  title = '受管文档',
): Promise<ArtifactFixture> {
  const commandId = randomUUID();
  const response = await api.post(workspacePath(workspaceId, `/tasks/${task.task_id}/artifacts`), {
    command_id: commandId,
    expected_task_revision: task.revision,
    title,
    media_type: 'text/markdown',
    content,
  });
  const result = expectCommandAccepted(response, 201, commandId);

  return {
    artifact_id: result.artifact_id as string,
    version_id: result.version_id as string,
    version_number: result.version_number as string,
    artifact_revision: result.artifact_revision as string,
    task_revision: result.task_revision as string,
    sha256: result.sha256 as string,
  };
}

async function saveNextVersion(input: {
  readonly task: TaskFixture;
  readonly artifact: ArtifactFixture;
  readonly content: string;
  readonly expectedStatus?: 201;
}): Promise<ArtifactFixture> {
  const commandId = randomUUID();
  const response = await api.post(
    workspacePath(workspaceId, `/artifacts/${input.artifact.artifact_id}/versions`),
    {
      command_id: commandId,
      expected_artifact_revision: input.artifact.artifact_revision,
      expected_task_revision: input.artifact.task_revision,
      media_type: 'text/markdown',
      content: input.content,
    },
  );
  const result = expectCommandAccepted(response, 201, commandId);

  return {
    artifact_id: result.artifact_id as string,
    version_id: result.version_id as string,
    version_number: result.version_number as string,
    artifact_revision: result.artifact_revision as string,
    task_revision: result.task_revision as string,
    sha256: result.sha256 as string,
  };
}

async function readTask(taskId: string): Promise<Record<string, unknown>> {
  const response = await api.get(workspacePath(workspaceId, `/tasks/${taskId}`));

  assert.equal(response.status, 200, response.text);

  return response.body as Record<string, unknown>;
}

async function readProjectState(projectId: string): Promise<Record<string, unknown>> {
  const response = await api.get(workspacePath(workspaceId, `/projects/${projectId}/state`));

  assert.equal(response.status, 200, response.text);

  return response.body as Record<string, unknown>;
}

async function readArtifact(artifactId: string): Promise<Record<string, unknown>> {
  const response = await api.get(workspacePath(workspaceId, `/artifacts/${artifactId}`));

  assert.equal(response.status, 200, response.text);

  return response.body as Record<string, unknown>;
}

async function readContent(versionId: string): Promise<HttpResponse> {
  return api.get(workspacePath(workspaceId, `/artifact-versions/${versionId}/content`));
}

async function countCompletionRecords(taskId: string): Promise<number> {
  const result = await sql<{ count: bigint }>`
    select count(*) as count from completion_records where task_id = ${taskId}
  `.execute(appDatabase.db);

  return Number(result.rows[0]?.count ?? 0n);
}

async function countHumanAcceptances(taskId: string): Promise<number> {
  const result = await sql<{ count: bigint }>`
    select count(*) as count from human_acceptances where task_id = ${taskId}
  `.execute(appDatabase.db);

  return Number(result.rows[0]?.count ?? 0n);
}

async function countAcceptanceVersions(taskId: string): Promise<number> {
  const result = await sql<{ count: bigint }>`
    select count(*) as count from task_acceptances where task_id = ${taskId}
  `.execute(appDatabase.db);

  return Number(result.rows[0]?.count ?? 0n);
}

async function countAcceptanceCriteria(taskId: string): Promise<number> {
  const result = await sql<{ count: bigint }>`
    select count(*) as count from acceptance_criteria where task_id = ${taskId}
  `.execute(appDatabase.db);

  return Number(result.rows[0]?.count ?? 0n);
}

async function countCommandWrites(commandId: string): Promise<{
  readonly receipts: bigint;
  readonly activities: bigint;
}> {
  const result = await sql<{ receipt_count: bigint; activity_count: bigint }>`
    select
      (select count(*) from command_receipts where command_id = ${commandId}::uuid) as receipt_count,
      (select count(*) from activity_records where command_id = ${commandId}::uuid) as activity_count
  `.execute(appDatabase.db);

  return {
    receipts: result.rows[0]?.receipt_count ?? 0n,
    activities: result.rows[0]?.activity_count ?? 0n,
  };
}

async function countTaskArtifacts(taskId: string): Promise<number> {
  const result = await sql<{ count: bigint }>`
    select count(*) as count from artifacts where task_id = ${taskId}
  `.execute(appDatabase.db);

  return Number(result.rows[0]?.count ?? 0n);
}

async function artifactFileCount(): Promise<number> {
  return countManagedFiles(join(api.dataRoot, 'artifacts'));
}

async function countManagedFiles(directory: string): Promise<number> {
  let entries;

  try {
    entries = await readdir(directory, { recursive: true, withFileTypes: true });
  } catch {
    return 0;
  }

  return entries.filter((entry) => entry.isFile() && entry.name === 'content.md').length;
}

/**
 * 用迁移角色注入一次性失败触发器：模拟“Task/State 之间失败”与“版本登记失败”两个故障点。
 * 触发条件只针对本次用例创建的对象，因此其他测试文件并行写入不受影响。
 */
async function createFailingTrigger(input: {
  readonly table: 'state_completion_refs' | 'artifact_versions' | 'project_states';
  /** 行级作用范围：Project（状态引用）或 Task（版本登记，经 artifacts 反查）。 */
  readonly scopeId: string;
}): Promise<void> {
  const body =
    input.table === 'state_completion_refs'
      ? `if new.project_id = '${input.scopeId}'::uuid then
           raise exception 'injected failure: state_completion_refs is blocked for this project';
         end if;`
      : input.table === 'artifact_versions'
        ? `if exists (
           select 1 from artifacts a
           where a.id = new.artifact_id and a.task_id = '${input.scopeId}'::uuid
         ) then
           raise exception 'injected failure: artifact_versions is blocked for this task';
         end if;`
        : `if new.project_id = '${input.scopeId}'::uuid then
             raise exception 'injected failure: project_states revision update is blocked for this project';
           end if;`;
  const event = input.table === 'project_states' ? 'before update' : 'before insert';

  await withMigrationClient(async (client) => {
    await client.query(
      `create or replace function relay_test_fail_${input.table}() returns trigger language plpgsql as $$
       begin
         ${body}
         return new;
       end;
       $$`,
    );
    await client.query(`drop trigger if exists trg_relay_test_fail on ${input.table}`);
    await client.query(
      `create trigger trg_relay_test_fail ${event} on ${input.table}
         for each row execute function relay_test_fail_${input.table}()`,
    );
  });
}

async function dropFailingTrigger(
  table: 'state_completion_refs' | 'artifact_versions' | 'project_states',
): Promise<void> {
  await withMigrationClient(async (client) => {
    await client.query(`drop trigger if exists trg_relay_test_fail on ${table}`);
    await client.query(`drop function if exists relay_test_fail_${table}()`);
  });
}

/**
 * 只在旧的“State → 非锁定 Task 读取”窗口暂停，让并发 Reopen 可先锁 Task。
 * 修复后 SET_NEXT_ACTION 先以 FOR UPDATE 锁 Task，不会触发该延迟；两种情况下都经过真实 HTTP。
 */
async function createTaskReadDelayPolicy(taskId: string): Promise<void> {
  await withMigrationClient(async (client) => {
    await client.query(`create or replace function relay_test_delay_unlocked_task_read(
      target_task_id uuid,
      candidate_task_id uuid
    ) returns boolean language plpgsql as $$
      begin
        if candidate_task_id = target_task_id
          and position('for update' in lower(current_query())) = 0 then
          perform pg_sleep(0.35);
        end if;
        return true;
      end;
      $$`);
    await client.query('alter table tasks enable row level security');
    await client.query('alter table tasks force row level security');
    await client.query('drop policy if exists relay_test_task_access on tasks');
    await client.query('drop policy if exists relay_test_task_read_delay on tasks');
    await client.query(
      'create policy relay_test_task_access on tasks for all to relay_app using (true) with check (true)',
    );
    await client.query(
      `create policy relay_test_task_read_delay on tasks as restrictive for select to relay_app
         using (relay_test_delay_unlocked_task_read('${taskId}'::uuid, id))`,
    );
  });
}

async function dropTaskReadDelayPolicy(): Promise<void> {
  await withMigrationClient(async (client) => {
    await client.query('drop policy if exists relay_test_task_read_delay on tasks');
    await client.query('drop policy if exists relay_test_task_access on tasks');
    await client.query('alter table tasks no force row level security');
    await client.query('alter table tasks disable row level security');
    await client.query('drop function if exists relay_test_delay_unlocked_task_read(uuid, uuid)');
  });
}

/** 修复后也保留足够的锁持有时间，确保两个 HTTP 请求确实在同一临界区竞争。 */
async function createProjectStateDelayTrigger(projectId: string): Promise<void> {
  await withMigrationClient(async (client) => {
    await client.query(`create or replace function relay_test_delay_project_state_update() returns trigger
      language plpgsql as $$
      begin
        if new.project_id = '${projectId}'::uuid then
          perform pg_sleep(0.35);
        end if;
        return new;
      end;
      $$`);
    await client.query('drop trigger if exists trg_relay_test_delay_project_state on project_states');
    await client.query(`create trigger trg_relay_test_delay_project_state before update on project_states
      for each row execute function relay_test_delay_project_state_update()`);
  });
}

async function dropProjectStateDelayTrigger(): Promise<void> {
  await withMigrationClient(async (client) => {
    await client.query('drop trigger if exists trg_relay_test_delay_project_state on project_states');
    await client.query('drop function if exists relay_test_delay_project_state_update()');
  });
}

async function withMigrationClient(work: (client: Client) => Promise<void>): Promise<void> {
  const client = new Client({
    connectionString: MIGRATION_DATABASE_URL,
    application_name: 'relay-api-test-p03-migrator',
  });

  await client.connect();

  try {
    await work(client);
  } finally {
    await client.end();
  }
}

async function startedTask(options?: {
  readonly expectedOutputs?: unknown;
  readonly criteria?: readonly { readonly statement: string; readonly criterion_id: string }[];
}): Promise<TaskFixture> {
  const projectId = await createProject();

  return startTask(await createTask({ projectId, ...options }));
}

/* -------------------------------------------------------------------------- */
/* Artifact 版本与受管内容                                                     */
/* -------------------------------------------------------------------------- */

test('lists only the visible Task artifact history and its current accepted versions', async () => {
  const projectId = await createProject('artifact-list-project');
  const task = await startTask(await createTask({ projectId }));
  const otherTask = await startTask(await createTask({ projectId }));
  const path = workspacePath(workspaceId, `/tasks/${task.task_id}/artifacts`);
  const otherPath = workspacePath(workspaceId, `/tasks/${otherTask.task_id}/artifacts`);

  const empty = await api.get(path);
  assert.equal(empty.status, 200, empty.text);
  assert.deepEqual(empty.body, { items: [], current_accepted_version_ids: [] });

  const first = await saveFirstVersion(task, '# first');
  const second = await saveNextVersion({ task, artifact: first, content: '# second' });
  const foreignArtifact = await saveFirstVersion(otherTask, '# other task');

  const listed = await api.get(path);
  assert.equal(listed.status, 200, listed.text);
  const beforeCompletion = listed.body as {
    items: { id: string; revision: string; latest_version_id: string; version_count: number;
      versions: { artifact_version_id: string; version_number: string }[] }[];
    current_accepted_version_ids: string[];
  };
  assert.equal(beforeCompletion.items.length, 1);
  assert.equal(beforeCompletion.items[0]?.id, first.artifact_id);
  assert.equal(beforeCompletion.items[0]?.revision, second.artifact_revision);
  assert.equal(beforeCompletion.items[0]?.latest_version_id, second.version_id);
  assert.equal(beforeCompletion.items[0]?.version_count, 2);
  assert.deepEqual(beforeCompletion.items[0]?.versions.map((version) => version.artifact_version_id),
    [first.version_id, second.version_id]);
  assert.deepEqual(beforeCompletion.items[0]?.versions.map((version) => version.version_number), ['1', '2']);
  assert.deepEqual(beforeCompletion.current_accepted_version_ids, []);
  assert.equal(JSON.stringify(listed.body).includes('storage_ref'), false);

  const secondArtifact = await saveFirstVersion(
    { ...task, revision: second.task_revision }, '# another artifact', '另一份产物');
  const multiple = await api.get(path);
  assert.equal(multiple.status, 200, multiple.text);
  const multipleItems = (multiple.body as { items: { id: string; versions: { version_number: string }[] }[] }).items;
  assert.deepEqual(multipleItems.map((item) => item.id).sort(),
    [first.artifact_id, secondArtifact.artifact_id].sort());
  assert.deepEqual(multipleItems.map((item) => item.versions[0]?.version_number), ['1', '1']);

  const other = await api.get(otherPath);
  assert.equal(other.status, 200, other.text);
  assert.deepEqual((other.body as { items: { id: string }[] }).items.map((item) => item.id),
    [foreignArtifact.artifact_id]);

  const completionCommandId = randomUUID();
  const completed = await api.post(workspacePath(workspaceId, `/tasks/${task.task_id}/complete`), {
    command_id: completionCommandId,
    expected_revision: secondArtifact.task_revision,
    acceptance_revision: task.acceptance_revision,
    artifact_version_ids: [first.version_id],
    acceptance: { statement: 'accept first version', accepted_criterion_ids: ['c1'] },
  });
  const completion = expectCommandAccepted(completed, 200, completionCommandId);
  const accepted = await api.get(path);
  assert.equal(accepted.status, 200, accepted.text);
  assert.deepEqual((accepted.body as { current_accepted_version_ids: string[] }).current_accepted_version_ids,
    [first.version_id]);

  const reopened = await api.post(workspacePath(workspaceId, `/tasks/${task.task_id}/reopen`), {
    command_id: randomUUID(), expected_revision: completion.revision, reason: 'new acceptance cycle',
  });
  assert.equal(reopened.status, 200, reopened.text);
  const afterReopen = await api.get(path);
  assert.equal(afterReopen.status, 200, afterReopen.text);
  assert.deepEqual((afterReopen.body as { current_accepted_version_ids: string[] }).current_accepted_version_ids, []);
  assert.equal((afterReopen.body as { items: unknown[] }).items.length, 2);

  const otherWorkspaceId = await createWorkspace(appDatabase.db);
  expectProblem(await api.get(workspacePath(otherWorkspaceId, `/tasks/${task.task_id}/artifacts`)),
    404, 'RESOURCE_NOT_FOUND');
  expectProblem(await sendRequest(api.port, 'GET', path), 401, 'AUTH_REQUIRED');
});

test('creates a managed markdown version that is complete on disk and readable through the API', async () => {
  const filesBefore = await artifactFileCount();
  const task = await startedTask();
  const content = '# 摘要\n\n第一版受管内容\n';
  const artifact = await saveFirstVersion(task, content);

  assert.equal(artifact.version_number, '1');
  assert.equal(artifact.artifact_revision, '0');
  assert.equal(artifact.sha256, sha256Hex(content));
  assert.equal(artifact.task_revision, '3');

  const stored = await readFile(storedContentPath(artifact.artifact_id, artifact.version_id), 'utf8');

  assert.equal(stored, content);
  assert.equal(await artifactFileCount(), filesBefore + 1);

  const detail = await readArtifact(artifact.artifact_id);

  assert.equal(detail.task_id, task.task_id);
  assert.equal(detail.revision, '0');
  assert.equal(detail.latest_version_id, artifact.version_id);
  assert.equal(detail.version_count, 1);

  const versions = detail.versions as readonly Record<string, unknown>[];

  assert.equal(versions.length, 1);
  assert.equal(versions[0]?.artifact_version_id, artifact.version_id);
  assert.equal(versions[0]?.version_number, '1');
  assert.equal(versions[0]?.media_type, 'text/markdown');
  assert.equal(versions[0]?.sha256, sha256Hex(content));
  assert.equal(versions[0]?.size, String(Buffer.byteLength(content)));
  assert.equal(versions[0]?.source_kind, 'HUMAN');

  const contentResponse = await readContent(artifact.version_id);

  assert.equal(contentResponse.status, 200, contentResponse.text);
  assert.match(String(contentResponse.headers['content-type']), /^text\/markdown/u);
  assert.equal(contentResponse.text, content);

  // 读取投影与下载都不暴露宿主绝对路径或存储内部结构。
  const serialized = JSON.stringify(detail);

  assert.equal(serialized.includes(api.dataRoot), false);
  assert.equal(serialized.includes('storage_ref'), false);
  assert.equal(serialized.includes('staging'), false);
});

test('rejects an unsupported media type with 415 and oversized content with 413', async () => {
  const task = await startedTask();

  const unsupported = await api.post(
    workspacePath(workspaceId, `/tasks/${task.task_id}/artifacts`),
    {
      command_id: randomUUID(),
      expected_task_revision: task.revision,
      title: '不受支持的类型',
      media_type: 'text/plain',
      content: 'hello',
    },
  );
  const mediaTypeProblem = expectProblem(unsupported, 415, 'UNSUPPORTED_MEDIA_TYPE');

  assert.ok(
    (mediaTypeProblem.field_errors ?? []).some((error) => error.field === 'media_type'),
  );

  const oversized = await api.post(
    workspacePath(workspaceId, `/tasks/${task.task_id}/artifacts`),
    {
      command_id: randomUUID(),
      expected_task_revision: task.revision,
      title: '超限正文',
      media_type: 'text/markdown',
      content: 'a'.repeat(262_145),
    },
  );
  const sizeProblem = expectProblem(oversized, 413, 'CONTENT_TOO_LARGE');

  assert.ok((sizeProblem.field_errors ?? []).some((error) => error.field === 'content'));

  // 上限本身是允许的，判定按 UTF-8 字节数而不是字符数。
  const atLimit = await api.post(workspacePath(workspaceId, `/tasks/${task.task_id}/artifacts`), {
    command_id: randomUUID(),
    expected_task_revision: task.revision,
    title: '刚好 256 KiB',
    media_type: 'text/markdown',
    content: 'a'.repeat(262_144),
  });

  assert.equal(atLimit.status, 201, atLimit.text);

  const taskAfter = await readTask(task.task_id);

  assert.equal(taskAfter.status, 'IN_PROGRESS');
  assert.equal(await countTaskArtifacts(task.task_id), 1);
});

test('rejects user-supplied paths, non-uuid ids and cross-scope artifact reads', async () => {
  const task = await startedTask();
  const artifact = await saveFirstVersion(task, '生成路径由服务端决定\n');

  for (const field of ['storage_ref', 'content_path', 'path', 'absolute_path']) {
    const response = await api.post(workspacePath(workspaceId, `/tasks/${task.task_id}/artifacts`), {
      command_id: randomUUID(),
      expected_task_revision: task.revision,
      title: '尝试传入路径',
      media_type: 'text/markdown',
      content: 'x',
      [field]: '../../outside/content.md',
    });
    const problem = expectProblem(response, 422, 'VALIDATION_FAILED');

    assert.ok(
      (problem.field_errors ?? []).some((error) => error.field.includes(field)),
      `expected a field error for ${field}`,
    );
  }

  for (const candidate of [
    'not-a-uuid',
    '..%2F..%2Fwindows%2Fwin.ini',
    '..%2F..%2Fetc%2Fpasswd',
    'C%3A%5Cwindows%5Cwin.ini',
  ]) {
    const response = await api.get(
      workspacePath(workspaceId, `/artifact-versions/${candidate}/content`),
    );

    assert.notEqual(response.status, 200, response.text);
    assert.equal(response.text.includes('root:'), false);
    assert.equal(response.text.includes('[extensions]'), false);
  }

  const unauthenticated = await api.get(
    workspacePath(workspaceId, `/artifact-versions/${artifact.version_id}/content`),
    { headers: { authorization: '' } },
  );

  assert.equal(unauthenticated.status, 401);

  // 另一个 Workspace 的读取按不可见处理，不返回“存在但无权限”。
  const otherWorkspace = await createWorkspace(appDatabase.db);
  const foreignArtifact = await api.get(
    workspacePath(otherWorkspace, `/artifacts/${artifact.artifact_id}`),
  );

  expectProblem(foreignArtifact, 404, 'RESOURCE_NOT_FOUND');

  const foreignContent = await api.get(
    workspacePath(otherWorkspace, `/artifact-versions/${artifact.version_id}/content`),
  );

  assert.equal(foreignContent.status, 404);
});

test('appends a new immutable version without overwriting the previous one', async () => {
  const filesBefore = await artifactFileCount();
  const task = await startedTask();
  const first = await saveFirstVersion(task, '第一版\n');
  const second = await saveNextVersion({
    task,
    artifact: first,
    content: '第二版\n',
  });

  assert.equal(second.version_number, '2');
  assert.equal(second.artifact_revision, '1');
  assert.equal(second.sha256, sha256Hex('第二版\n'));

  const detail = await readArtifact(first.artifact_id);

  assert.equal(detail.revision, '1');
  assert.equal(detail.version_count, 2);
  assert.equal(detail.latest_version_id, second.version_id);

  assert.equal(
    await readFile(storedContentPath(first.artifact_id, first.version_id), 'utf8'),
    '第一版\n',
  );
  assert.equal(
    await readFile(storedContentPath(first.artifact_id, second.version_id), 'utf8'),
    '第二版\n',
  );
  assert.equal(await artifactFileCount(), filesBefore + 2);

  const staleArtifactRevision = await api.post(
    workspacePath(workspaceId, `/artifacts/${first.artifact_id}/versions`),
    {
      command_id: randomUUID(),
      expected_artifact_revision: '0',
      expected_task_revision: second.task_revision,
      media_type: 'text/markdown',
      content: '第三版\n',
    },
  );
  const conflict = expectProblem(staleArtifactRevision, 409, 'REVISION_CONFLICT');

  assert.equal(conflict.conflict?.entity_type, 'ARTIFACT');
  assert.equal(await artifactFileCount(), filesBefore + 2, 'a rejected version must not publish content');
});

/* -------------------------------------------------------------------------- */
/* 人工完成                                                                    */
/* -------------------------------------------------------------------------- */

test('completes a task against a fixed version and never marks the newer version as accepted', async () => {
  const task = await startedTask();
  const first = await saveFirstVersion(task, '第一版（被接受的版本）\n');
  const second = await saveNextVersion({ task, artifact: first, content: '第二版（未接受）\n' });

  const commandId = randomUUID();
  const response = await api.post(workspacePath(workspaceId, `/tasks/${task.task_id}/complete`), {
    command_id: commandId,
    expected_revision: second.task_revision,
    acceptance_revision: task.acceptance_revision,
    artifact_version_ids: [first.version_id],
    acceptance: {
      statement: '已核对第一版摘要与引用，同意完成本轮任务',
      accepted_criterion_ids: ['c1'],
    },
  });
  const result = expectCommandAccepted(response, 200, commandId);

  assert.equal(result.status, 'DONE');
  assert.equal(result.acceptance_revision, '1');
  assert.deepEqual(result.artifact_version_ids, [first.version_id]);

  const acceptanceRows = await sql<{ accepted_version_refs: readonly string[] }>`
    select accepted_version_refs from human_acceptances where id = ${result.human_acceptance_id as string}
  `.execute(appDatabase.db);

  assert.deepEqual(acceptanceRows.rows[0]?.accepted_version_refs, [first.version_id]);

  const completionRows = await sql<{
    state_delta: { readonly artifact_version_ids: readonly string[]; readonly next_action_cleared: boolean };
  }>`
    select state_delta from completion_records where id = ${result.completion_id as string}
  `.execute(appDatabase.db);

  assert.deepEqual(completionRows.rows[0]?.state_delta.artifact_version_ids, [first.version_id]);

  const artifactRefs = await sql<{ count: bigint }>`
    select count(*) as count from state_artifact_refs
    where artifact_version_id = any(${[first.version_id, second.version_id]}::uuid[])
  `.execute(appDatabase.db);

  assert.equal(artifactRefs.rows[0]?.count, 0n, 'completion must not select a version implicitly');

  const detail = await readTask(task.task_id);

  assert.equal(detail.status, 'DONE');
  assert.equal(detail.current_completion_id, result.completion_id);
  assert.deepEqual(detail.allowed_actions, ['REOPEN']);
  assert.equal((detail.acceptance as { acceptance_revision: string }).acceptance_revision, '1');

  const artifactDetail = await readArtifact(first.artifact_id);

  assert.equal(artifactDetail.revision, '1');
  assert.equal(artifactDetail.version_count, 2, 'a newer version must stay untouched');
  assert.equal(artifactDetail.latest_version_id, second.version_id);

  // 同 ID 同内容重放返回原回执，不产生第二份完成凭据。
  const replay = await api.post(workspacePath(workspaceId, `/tasks/${task.task_id}/complete`), {
    command_id: commandId,
    expected_revision: second.task_revision,
    acceptance_revision: task.acceptance_revision,
    artifact_version_ids: [first.version_id],
    acceptance: {
      statement: '已核对第一版摘要与引用，同意完成本轮任务',
      accepted_criterion_ids: ['c1'],
    },
  });

  assert.equal(replay.status, 200, replay.text);
  assert.equal(replay.headers['command-replayed'], 'true');
  assert.deepEqual((replay.body as { result: unknown }).result, result);
  assert.equal(await countCompletionRecords(task.task_id), 1);

  // 同 ID 异内容被拒绝，不覆盖已提交的完成凭据。
  const reused = await api.post(workspacePath(workspaceId, `/tasks/${task.task_id}/complete`), {
    command_id: commandId,
    expected_revision: second.task_revision,
    acceptance_revision: task.acceptance_revision,
    artifact_version_ids: [second.version_id],
    acceptance: {
      statement: '改成接受第二版',
      accepted_criterion_ids: ['c1'],
    },
  });

  expectProblem(reused, 409, 'COMMAND_ID_REUSED');
  assert.equal(await countCompletionRecords(task.task_id), 1);
});

test('completes a task that requires no artifacts with an empty version set', async () => {
  const task = await startedTask();

  const commandId = randomUUID();
  const response = await api.post(workspacePath(workspaceId, `/tasks/${task.task_id}/complete`), {
    command_id: commandId,
    expected_revision: task.revision,
    acceptance_revision: task.acceptance_revision,
    acceptance: {
      statement: '无产物要求，人工确认后完成',
      accepted_criterion_ids: ['c1'],
    },
  });
  const result = expectCommandAccepted(response, 200, commandId);

  assert.deepEqual(result.artifact_version_ids, []);
  assert.equal(result.status, 'DONE');
});

test('requires declared outputs to be covered and required human criteria to be confirmed', async () => {
  const outputsTask = await startedTask({
    expectedOutputs: { artifacts: ['MARKDOWN_DOCUMENT'] },
  });

  const missingOutput = await api.post(
    workspacePath(workspaceId, `/tasks/${outputsTask.task_id}/complete`),
    {
      command_id: randomUUID(),
      expected_revision: outputsTask.revision,
      acceptance_revision: outputsTask.acceptance_revision,
      artifact_version_ids: [],
      acceptance: { statement: '空集合提交', accepted_criterion_ids: ['c1'] },
    },
  );
  const outputProblem = expectProblem(missingOutput, 409, 'INVALID_TRANSITION');

  assert.deepEqual(outputProblem.conflict?.artifact_kinds, ['MARKDOWN_DOCUMENT']);

  const artifact = await saveFirstVersion(outputsTask, '满足产物要求的版本\n');
  const satisfied = await api.post(
    workspacePath(workspaceId, `/tasks/${outputsTask.task_id}/complete`),
    {
      command_id: randomUUID(),
      expected_revision: artifact.task_revision,
      acceptance_revision: outputsTask.acceptance_revision,
      artifact_version_ids: [artifact.version_id],
      acceptance: { statement: '产物齐备', accepted_criterion_ids: ['c1'] },
    },
  );

  assert.equal(satisfied.status, 200, satisfied.text);

  const unknownKindTask = await startedTask({ expectedOutputs: { artifacts: ['PDF'] } });
  const unknownKind = await api.post(
    workspacePath(workspaceId, `/tasks/${unknownKindTask.task_id}/complete`),
    {
      command_id: randomUUID(),
      expected_revision: unknownKindTask.revision,
      acceptance_revision: unknownKindTask.acceptance_revision,
      acceptance: { statement: '不受支持的产物种类', accepted_criterion_ids: ['c1'] },
    },
  );

  expectProblem(unknownKind, 409, 'INVALID_TRANSITION');

  const criteriaTask = await startedTask({
    criteria: [
      { criterion_id: 'c1', statement: '人工核对产物' },
      { criterion_id: 'c2', statement: '人工核对引用' },
    ],
  });

  const missingCriterion = await api.post(
    workspacePath(workspaceId, `/tasks/${criteriaTask.task_id}/complete`),
    {
      command_id: randomUUID(),
      expected_revision: criteriaTask.revision,
      acceptance_revision: criteriaTask.acceptance_revision,
      acceptance: { statement: '只确认了一项', accepted_criterion_ids: ['c1'] },
    },
  );
  const criterionProblem = expectProblem(missingCriterion, 409, 'INVALID_TRANSITION');

  assert.deepEqual(criterionProblem.conflict?.criterion_ids, ['c2']);

  const unknownCriterion = await api.post(
    workspacePath(workspaceId, `/tasks/${criteriaTask.task_id}/complete`),
    {
      command_id: randomUUID(),
      expected_revision: criteriaTask.revision,
      acceptance_revision: criteriaTask.acceptance_revision,
      acceptance: { statement: '凭空确认', accepted_criterion_ids: ['c1', 'c9'] },
    },
  );

  expectProblem(unknownCriterion, 422, 'VALIDATION_FAILED');

  const completed = await api.post(
    workspacePath(workspaceId, `/tasks/${criteriaTask.task_id}/complete`),
    {
      command_id: randomUUID(),
      expected_revision: criteriaTask.revision,
      acceptance_revision: criteriaTask.acceptance_revision,
      acceptance: { statement: '两项都确认', accepted_criterion_ids: ['c2', 'c1'] },
    },
  );

  assert.equal(completed.status, 200, completed.text);
});

/* -------------------------------------------------------------------------- */
/* 重开与周期                                                                */
/* -------------------------------------------------------------------------- */

test('reopens with a new acceptance revision, keeps history and blocks new uploads until started again', async () => {
  const task = await startedTask();
  const artifact = await saveFirstVersion(task, '第一周期产物\n');

  const completionCommandId = randomUUID();
  const completed = await api.post(workspacePath(workspaceId, `/tasks/${task.task_id}/complete`), {
    command_id: completionCommandId,
    expected_revision: artifact.task_revision,
    acceptance_revision: '1',
    artifact_version_ids: [artifact.version_id],
    acceptance: { statement: '第一周期完成', accepted_criterion_ids: ['c1'] },
  });
  const completionResult = expectCommandAccepted(completed, 200, completionCommandId);

  const blockedUpload = await api.post(
    workspacePath(workspaceId, `/tasks/${task.task_id}/artifacts`),
    {
      command_id: randomUUID(),
      expected_task_revision: completionResult.revision,
      title: '完成后继续上传',
      media_type: 'text/markdown',
      content: '不应该被保存\n',
    },
  );
  const blockedProblem = expectProblem(blockedUpload, 409, 'INVALID_TRANSITION');

  assert.match(blockedProblem.detail, /重开/u);

  const reopenCommandId = randomUUID();
  const reopened = await api.post(workspacePath(workspaceId, `/tasks/${task.task_id}/reopen`), {
    command_id: reopenCommandId,
    expected_revision: completionResult.revision,
    reason: '引用需要补充第二版内容',
  });
  const reopenResult = expectCommandAccepted(reopened, 200, reopenCommandId);

  assert.equal(reopenResult.status, 'READY');
  assert.equal(reopenResult.acceptance_revision, '2');
  assert.equal(reopenResult.previous_acceptance_revision, '1');
  assert.equal(reopenResult.previous_completion_id, completionResult.completion_id);

  const detail = await readTask(task.task_id);

  assert.equal(detail.status, 'READY');
  assert.equal(detail.acceptance_revision, '2');
  assert.equal(detail.current_completion_id, null);
  assert.equal((detail.acceptance as { source: string }).source, 'REOPEN');
  assert.deepEqual(
    (detail.acceptance as { criteria: readonly unknown[] }).criteria,
    [
      {
        criterion_id: 'c1',
        statement: '人工核对产物与引用',
        required: true,
        method: 'HUMAN',
        target_spec: {},
      },
    ],
  );

  // 历史凭据保留：完成记录、人工接受与旧回执都还在。
  assert.equal(await countCompletionRecords(task.task_id), 1);
  assert.equal(await countHumanAcceptances(task.task_id), 1);

  const historicalReceipt = await api.get(
    workspacePath(workspaceId, `/commands/${completionCommandId}`),
  );

  assert.equal(historicalReceipt.status, 200);
  assert.equal(
    (historicalReceipt.body as { result: { completion_id: string } }).result.completion_id,
    completionResult.completion_id,
  );

  // 重开后的新周期必须先重新开始才能继续上传版本。
  const uploadWhileReady = await api.post(
    workspacePath(workspaceId, `/tasks/${task.task_id}/artifacts`),
    {
      command_id: randomUUID(),
      expected_task_revision: reopenResult.revision,
      title: '重开后直接上传',
      media_type: 'text/markdown',
      content: '仍不应被保存\n',
    },
  );

  expectProblem(uploadWhileReady, 409, 'INVALID_TRANSITION');

  const secondCycle = await startReadyTask({
    task_id: task.task_id,
    revision: reopenResult.revision as string,
    acceptance_revision: reopenResult.acceptance_revision as string,
    status: 'READY',
  });
  const appended = await saveNextVersion({
    task: secondCycle,
    artifact: { ...artifact, artifact_revision: '0', task_revision: secondCycle.revision },
    content: '第二周期新增版本\n',
  });

  assert.equal(appended.version_number, '2');
});

test('replaying an old completion command after reopen returns the historical receipt only', async () => {
  const task = await startedTask();
  const artifact = await saveFirstVersion(task, '第一周期产物\n');

  const completionCommandId = randomUUID();
  const completionBody = {
    command_id: completionCommandId,
    expected_revision: artifact.task_revision,
    acceptance_revision: '1',
    artifact_version_ids: [artifact.version_id],
    acceptance: { statement: '第一周期完成', accepted_criterion_ids: ['c1'] },
  };
  const completed = await api.post(
    workspacePath(workspaceId, `/tasks/${task.task_id}/complete`),
    completionBody,
  );
  const completionResult = expectCommandAccepted(completed, 200, completionCommandId);

  const reopenCommandId = randomUUID();
  const reopened = await api.post(workspacePath(workspaceId, `/tasks/${task.task_id}/reopen`), {
    command_id: reopenCommandId,
    expected_revision: completionResult.revision,
    reason: '重新整理引用',
  });

  assert.equal(reopened.status, 200, reopened.text);

  const replay = await api.post(
    workspacePath(workspaceId, `/tasks/${task.task_id}/complete`),
    completionBody,
  );

  assert.equal(replay.status, 200, replay.text);
  assert.equal(replay.headers['command-replayed'], 'true');
  assert.deepEqual((replay.body as { result: unknown }).result, completionResult);

  const detail = await readTask(task.task_id);

  assert.equal(detail.status, 'READY');
  assert.equal(detail.acceptance_revision, '2');
  assert.equal(detail.current_completion_id, null);
  assert.equal(await countCompletionRecords(task.task_id), 1);

  // 新命令用旧周期提交：拒绝，且不改变当前周期。
  const stale = await api.post(workspacePath(workspaceId, `/tasks/${task.task_id}/complete`), {
    command_id: randomUUID(),
    expected_revision: (reopened.body as { result: { revision: string } }).result.revision,
    acceptance_revision: '1',
    artifact_version_ids: [artifact.version_id],
    acceptance: { statement: '沿用过旧凭据', accepted_criterion_ids: ['c1'] },
  });
  const staleProblem = expectProblem(stale, 409, 'ACCEPTANCE_STALE');

  assert.equal(staleProblem.conflict?.actual_revision, '2');
  assert.equal(await countCompletionRecords(task.task_id), 1);

  const after = await readTask(task.task_id);

  assert.equal(after.status, 'READY');
  assert.equal(after.acceptance_revision, '2');
});

test('keeps reopened completion history but removes only that cycle from the current State projection', async () => {
  const projectId = await createProject('p03-current-completion-projection');
  const reopenedTask = await startTask(await createTask({ projectId }));
  const unaffectedTask = await startTask(await createTask({ projectId }));
  const reopenedCompletionCommandId = randomUUID();
  const reopenedCompletionBody = {
    command_id: reopenedCompletionCommandId,
    expected_revision: reopenedTask.revision,
    acceptance_revision: reopenedTask.acceptance_revision,
    artifact_version_ids: [],
    acceptance: { statement: '第一周期完成', accepted_criterion_ids: ['c1'] },
  };
  const firstCompletion = expectCommandAccepted(
    await api.post(
      workspacePath(workspaceId, `/tasks/${reopenedTask.task_id}/complete`),
      reopenedCompletionBody,
    ),
    200,
    reopenedCompletionCommandId,
  );
  const unaffectedCompletionCommandId = randomUUID();
  const unaffectedCompletion = expectCommandAccepted(
    await api.post(workspacePath(workspaceId, `/tasks/${unaffectedTask.task_id}/complete`), {
      command_id: unaffectedCompletionCommandId,
      expected_revision: unaffectedTask.revision,
      acceptance_revision: unaffectedTask.acceptance_revision,
      artifact_version_ids: [],
      acceptance: { statement: '持续有效的完成', accepted_criterion_ids: ['c1'] },
    }),
    200,
    unaffectedCompletionCommandId,
  );

  const beforeReopen = await readProjectState(projectId);

  assert.deepEqual(
    new Set(
      (beforeReopen.completed_highlight_refs as readonly { readonly completion_id: string }[]).map(
        (reference) => reference.completion_id,
      ),
    ),
    new Set([firstCompletion.completion_id as string, unaffectedCompletion.completion_id as string]),
  );
  assert.equal(beforeReopen.revision, '2');

  const reopenCommandId = randomUUID();
  const reopened = expectCommandAccepted(
    await api.post(workspacePath(workspaceId, `/tasks/${reopenedTask.task_id}/reopen`), {
      command_id: reopenCommandId,
      expected_revision: firstCompletion.revision,
      reason: '进入新的人工验收周期',
    }),
    200,
    reopenCommandId,
  );
  const afterReopen = await readProjectState(projectId);

  assert.equal(reopened.status, 'READY');
  assert.equal(reopened.acceptance_revision, '2');
  assert.equal(afterReopen.revision, '3', '重开必须使 State 视图失效');
  const currentRefs = afterReopen.completed_highlight_refs as readonly {
    readonly completion_id: string;
    readonly task_id: string;
    readonly acceptance_revision: string;
  }[];

  assert.equal(currentRefs.length, 1);
  assert.equal(currentRefs[0]?.completion_id, unaffectedCompletion.completion_id);
  assert.equal(currentRefs[0]?.task_id, unaffectedTask.task_id);
  assert.equal(currentRefs[0]?.acceptance_revision, '1');
  assert.deepEqual(
    (afterReopen.dependency_versions as { readonly completion_refs: readonly string[] }).completion_refs,
    [unaffectedCompletion.completion_id],
  );
  assert.equal(await countCompletionRecords(reopenedTask.task_id), 1);
  assert.equal(await countHumanAcceptances(reopenedTask.task_id), 1);

  const history = await sql<{ count: bigint }>`
    select count(*) as count
    from state_completion_refs
    where project_id = ${projectId}
  `.execute(appDatabase.db);

  assert.equal(history.rows[0]?.count, 2n, 'State 历史引用不得因重开删除');

  const replay = await api.post(
    workspacePath(workspaceId, `/tasks/${reopenedTask.task_id}/complete`),
    reopenedCompletionBody,
  );

  assert.equal(replay.status, 200, replay.text);
  assert.equal(replay.headers['command-replayed'], 'true');
  assert.deepEqual((replay.body as { result: unknown }).result, firstCompletion);
  assert.equal((await readProjectState(projectId)).revision, '3');

  const secondCycleTask = await startReadyTask({
    task_id: reopenedTask.task_id,
    revision: reopened.revision as string,
    acceptance_revision: reopened.acceptance_revision as string,
    status: 'READY',
  });
  const secondCompletionCommandId = randomUUID();
  const secondCompletion = expectCommandAccepted(
    await api.post(workspacePath(workspaceId, `/tasks/${reopenedTask.task_id}/complete`), {
      command_id: secondCompletionCommandId,
      expected_revision: secondCycleTask.revision,
      acceptance_revision: secondCycleTask.acceptance_revision,
      artifact_version_ids: [],
      acceptance: { statement: '第二周期完成', accepted_criterion_ids: ['c1'] },
    }),
    200,
    secondCompletionCommandId,
  );
  const afterSecondCompletion = await readProjectState(projectId);

  assert.equal(afterSecondCompletion.revision, '4');
  assert.deepEqual(
    new Set(
      (afterSecondCompletion.completed_highlight_refs as readonly { readonly completion_id: string }[]).map(
        (reference) => reference.completion_id,
      ),
    ),
    new Set([unaffectedCompletion.completion_id as string, secondCompletion.completion_id as string]),
  );
  assert.equal(
    (afterSecondCompletion.dependency_versions as { readonly completion_refs: readonly string[] })
      .completion_refs.includes(firstCompletion.completion_id as string),
    false,
  );
  assert.equal(await countCompletionRecords(reopenedTask.task_id), 2);
});

test('lets only one of two concurrent completion commands win the cycle', async () => {
  const task = await startedTask();
  const artifact = await saveFirstVersion(task, '并发完成产物\n');

  const bodies = [randomUUID(), randomUUID()].map((commandId) => ({
    command_id: commandId,
    expected_revision: artifact.task_revision,
    acceptance_revision: '1',
    artifact_version_ids: [artifact.version_id],
    acceptance: { statement: '并发提交', accepted_criterion_ids: ['c1'] },
  }));
  const responses = await Promise.all(
    bodies.map((body) =>
      api.post(workspacePath(workspaceId, `/tasks/${task.task_id}/complete`), body),
    ),
  );
  const statuses = responses.map((response) => response.status).sort();

  assert.deepEqual(statuses, [200, 409], responses.map((r) => r.text).join('\n'));

  const losing = responses.find((response) => response.status === 409);

  assert.ok(losing !== undefined);
  assert.ok(
    ['REVISION_CONFLICT', 'INVALID_TRANSITION'].includes(
      (losing.body as { code: string }).code,
    ),
  );

  assert.equal(await countCompletionRecords(task.task_id), 1);
  assert.equal(await countHumanAcceptances(task.task_id), 1);

  const detail = await readTask(task.task_id);

  assert.equal(detail.status, 'DONE');
  assert.equal(await countTaskArtifacts(task.task_id), 1);
});

/* -------------------------------------------------------------------------- */
/* 故障注入                                                                    */
/* -------------------------------------------------------------------------- */

test('serializes SET_NEXT_ACTION and reopen in Task → ProjectState order without a deadlock', async () => {
  const projectId = await createProject('p03-state-reopen-lock-order');
  const task = await startTask(await createTask({ projectId }));
  const completionCommandId = randomUUID();
  const completed = expectCommandAccepted(
    await api.post(workspacePath(workspaceId, `/tasks/${task.task_id}/complete`), {
      command_id: completionCommandId,
      expected_revision: task.revision,
      acceptance_revision: task.acceptance_revision,
      artifact_version_ids: [],
      acceptance: { statement: '完成后验证并发锁序', accepted_criterion_ids: ['c1'] },
    }),
    200,
    completionCommandId,
  );

  const completedState = await readProjectState(projectId);
  const stateBody = {
    command_id: randomUUID(),
    expected_revision: completedState.revision,
    action: 'SET_NEXT_ACTION',
    next_action_task_id: task.task_id,
  };
  const reopenBody = {
    command_id: randomUUID(),
    expected_revision: completed.revision as string,
    reason: '并发操作下重开新的验收周期',
  };

  await createTaskReadDelayPolicy(task.task_id);
  await createProjectStateDelayTrigger(projectId);

  try {
    const stateRequest = api.post(
      workspacePath(workspaceId, `/projects/${projectId}/state-commands`),
      stateBody,
    );

    // 修复前，State 已锁住 ProjectState 并在非锁定 Task 读取处暂停；
    // Reopen 随后锁住 Task，两个事务会形成反向等待。修复后 State 先锁 Task。
    await delay(100);
    const reopenRequest = api.post(
      workspacePath(workspaceId, `/tasks/${task.task_id}/reopen`),
      reopenBody,
    );
    const responses = await withTimeout(
      Promise.all([stateRequest, reopenRequest]),
      10000,
      'SET_NEXT_ACTION and reopen concurrent requests',
    );

    for (const response of responses) {
      assert.ok([200, 409].includes(response.status), response.text);
      assert.equal(response.text.includes('40P01'), false);
    }

    assert.ok(responses.some((response) => response.status === 200));

    for (const response of responses.filter((candidate) => candidate.status === 409)) {
      assert.equal((response.body as { code: string }).code, 'REVISION_CONFLICT');
    }
  } finally {
    await dropProjectStateDelayTrigger();
    await dropTaskReadDelayPolicy();
  }
});

test('rolls the whole completion transaction back when the state delta fails and converges on retry', async () => {
  const projectId = await createProject('p03-state-fault-project');
  const task = await startTask(await createTask({ projectId }));
  const artifact = await saveFirstVersion(task, '完成事务故障注入产物\n');

  const stateBefore = await api.get(workspacePath(workspaceId, `/projects/${projectId}/state`));
  const stateRevision = (stateBefore.body as { revision: string }).revision;
  const setNextAction = await api.post(
    workspacePath(workspaceId, `/projects/${projectId}/state-commands`),
    {
      command_id: randomUUID(),
      expected_revision: stateRevision,
      action: 'SET_NEXT_ACTION',
      next_action_task_id: task.task_id,
    },
  );

  assert.equal(setNextAction.status, 200, setNextAction.text);

  const stateRevisionBefore = (setNextAction.body as { result: { revision: string } }).result
    .revision;
  const commandId = randomUUID();
  const body = {
    command_id: commandId,
    expected_revision: artifact.task_revision,
    acceptance_revision: '1',
    artifact_version_ids: [artifact.version_id],
    acceptance: { statement: '完成并清理下一步', accepted_criterion_ids: ['c1'] },
  };

  await createFailingTrigger({ table: 'state_completion_refs', scopeId: projectId });

  try {
    const failed = await api.post(workspacePath(workspaceId, `/tasks/${task.task_id}/complete`), body);

    // 事务在 Task 更新与 State 更新之间失败：整笔回滚，不留下半完成的完成凭据。
    assert.equal(failed.status, 500, failed.text);
    assert.equal((failed.body as { code: string }).code, 'INTERNAL_ERROR');

    const afterFailure = await readTask(task.task_id);

    assert.equal(afterFailure.status, 'IN_PROGRESS');
    assert.equal(afterFailure.revision, artifact.task_revision);
    assert.equal(afterFailure.current_completion_id, null);
    assert.equal(await countCompletionRecords(task.task_id), 0);
    assert.equal(await countHumanAcceptances(task.task_id), 0);

    const stateAfterFailure = await api.get(workspacePath(workspaceId, `/projects/${projectId}/state`));

    assert.equal((stateAfterFailure.body as { revision: string }).revision, stateRevisionBefore);
  } finally {
    await dropFailingTrigger('state_completion_refs');
  }

  // 原样重试同一 command_id（回执也一起回滚了，因此这是安全路径）。
  const retried = await api.post(workspacePath(workspaceId, `/tasks/${task.task_id}/complete`), body);
  const result = expectCommandAccepted(retried, 200, commandId);

  assert.equal(result.status, 'DONE');
  assert.equal(result.state_revision, String(BigInt(stateRevisionBefore) + 1n));
  assert.equal(await countCompletionRecords(task.task_id), 1);
  assert.equal(await countHumanAcceptances(task.task_id), 1);

  const stateAfter = await api.get(workspacePath(workspaceId, `/projects/${projectId}/state`));

  assert.equal((stateAfter.body as { next_action_task_id: string | null }).next_action_task_id, null);
  assert.equal(
    (stateAfter.body as { revision: string }).revision,
    String(BigInt(stateRevisionBefore) + 1n),
  );

  const refs = await sql<{ count: bigint }>`
    select count(*) as count from state_completion_refs where project_id = ${projectId}
  `.execute(appDatabase.db);

  assert.equal(refs.rows[0]?.count, 1n, 'a retried completion must not append a second delta');

  // 再次重放同一命令仍是回执重放，不重复追加 delta。
  const replay = await api.post(workspacePath(workspaceId, `/tasks/${task.task_id}/complete`), body);

  assert.equal(replay.status, 200, replay.text);
  assert.equal(replay.headers['command-replayed'], 'true');
  assert.equal(refs.rows[0]?.count, 1n);
});

test('rolls the whole reopen transaction back when the State revision update fails and converges on replay', async () => {
  const projectId = await createProject('p03-reopen-state-fault-project');
  const task = await startTask(await createTask({ projectId }));
  const completionCommandId = randomUUID();
  const completion = expectCommandAccepted(
    await api.post(workspacePath(workspaceId, `/tasks/${task.task_id}/complete`), {
      command_id: completionCommandId,
      expected_revision: task.revision,
      acceptance_revision: task.acceptance_revision,
      artifact_version_ids: [],
      acceptance: { statement: '为重开故障回滚建立完成事实', accepted_criterion_ids: ['c1'] },
    }),
    200,
    completionCommandId,
  );
  const stateBefore = await readProjectState(projectId);
  const commandId = randomUUID();
  const body = {
    command_id: commandId,
    expected_revision: completion.revision as string,
    reason: '故障注入后原样重试重开',
  };
  const historyBefore = await sql<{
    readonly completion_id: string;
    readonly completion_acceptance_revision: bigint;
    readonly acceptance_id: string;
    readonly acceptance_revision: bigint;
  }>`
    select c.id as completion_id, c.acceptance_revision as completion_acceptance_revision,
           h.id as acceptance_id, h.acceptance_revision
    from completion_records c
    join human_acceptances h on h.id = c.human_acceptance_id
    where c.task_id = ${task.task_id}
  `.execute(appDatabase.db);

  assert.equal(await countAcceptanceVersions(task.task_id), 1);
  assert.equal(await countAcceptanceCriteria(task.task_id), 1);
  assert.equal(historyBefore.rows.length, 1);

  await createFailingTrigger({ table: 'project_states', scopeId: projectId });

  try {
    const failed = await api.post(workspacePath(workspaceId, `/tasks/${task.task_id}/reopen`), body);

    assert.equal(failed.status, 500, failed.text);
    assert.equal((failed.body as { code: string }).code, 'INTERNAL_ERROR');

    const taskAfterFailure = await readTask(task.task_id);

    assert.equal(taskAfterFailure.status, 'DONE');
    assert.equal(taskAfterFailure.revision, completion.revision);
    assert.equal(taskAfterFailure.acceptance_revision, '1');
    assert.equal(taskAfterFailure.current_completion_id, completion.completion_id);
    assert.equal(await countCompletionRecords(task.task_id), 1);
    assert.equal(await countHumanAcceptances(task.task_id), 1);
    assert.equal(await countAcceptanceVersions(task.task_id), 1);
    assert.equal(await countAcceptanceCriteria(task.task_id), 1);
    assert.deepEqual(
      (
        await sql<{
          readonly completion_id: string;
          readonly completion_acceptance_revision: bigint;
          readonly acceptance_id: string;
          readonly acceptance_revision: bigint;
        }>`
          select c.id as completion_id, c.acceptance_revision as completion_acceptance_revision,
                 h.id as acceptance_id, h.acceptance_revision
          from completion_records c
          join human_acceptances h on h.id = c.human_acceptance_id
          where c.task_id = ${task.task_id}
        `.execute(appDatabase.db)
      ).rows,
      historyBefore.rows,
    );
    assert.equal((await readProjectState(projectId)).revision, stateBefore.revision);
    assert.deepEqual(await countCommandWrites(commandId), { receipts: 0n, activities: 0n });
  } finally {
    await dropFailingTrigger('project_states');
  }

  const retried = expectCommandAccepted(
    await api.post(workspacePath(workspaceId, `/tasks/${task.task_id}/reopen`), body),
    200,
    commandId,
  );

  assert.equal(retried.status, 'READY');
  assert.equal(retried.acceptance_revision, '2');
  assert.equal(await countCompletionRecords(task.task_id), 1);
  assert.equal(await countHumanAcceptances(task.task_id), 1);
  assert.equal(await countAcceptanceVersions(task.task_id), 2);
  assert.equal(await countAcceptanceCriteria(task.task_id), 2);
  assert.equal(
    (await readProjectState(projectId)).revision,
    String(BigInt(stateBefore.revision as string) + 1n),
  );
  assert.deepEqual(await countCommandWrites(commandId), { receipts: 1n, activities: 1n });

  const replay = await api.post(workspacePath(workspaceId, `/tasks/${task.task_id}/reopen`), body);

  assert.equal(replay.status, 200, replay.text);
  assert.equal(replay.headers['command-replayed'], 'true');
  assert.deepEqual((replay.body as { result: unknown }).result, retried);
  assert.equal(await countAcceptanceVersions(task.task_id), 2);
  assert.equal(await countAcceptanceCriteria(task.task_id), 2);
  assert.equal(
    (await readProjectState(projectId)).revision,
    String(BigInt(stateBefore.revision as string) + 1n),
  );
  assert.deepEqual(await countCommandWrites(commandId), { receipts: 1n, activities: 1n });
});

test('leaves a reconcilable orphan content file when the version row cannot be registered', async () => {
  const task = await startedTask();
  const filesBefore = await artifactFileCount();
  const commandId = randomUUID();
  const body = {
    command_id: commandId,
    expected_task_revision: task.revision,
    title: '登记失败的产物',
    media_type: 'text/markdown',
    content: '内容已发布但版本未登记\n',
  };

  await createFailingTrigger({ table: 'artifact_versions', scopeId: task.task_id });

  try {
    const failed = await api.post(
      workspacePath(workspaceId, `/tasks/${task.task_id}/artifacts`),
      body,
    );

    assert.equal(failed.status, 500, failed.text);
    assert.equal((failed.body as { code: string }).code, 'INTERNAL_ERROR');
  } finally {
    await dropFailingTrigger('artifact_versions');
  }

  // 内容在数据库提交前就已经完整发布：留下可核对的孤儿，但 Task 不误完成、也不存在版本行。
  assert.equal(await artifactFileCount(), filesBefore + 1);
  assert.equal(await countTaskArtifacts(task.task_id), 0);

  const afterFailure = await readTask(task.task_id);

  assert.equal(afterFailure.status, 'IN_PROGRESS');
  assert.equal(afterFailure.revision, task.revision);

  const retried = await api.post(
    workspacePath(workspaceId, `/tasks/${task.task_id}/artifacts`),
    body,
  );

  assert.equal(retried.status, 201, retried.text);
  assert.equal(await countTaskArtifacts(task.task_id), 1);

  // V1 不自动清理孤儿：失败留下的内容仍在，供核对报告使用。
  assert.equal(await artifactFileCount(), filesBefore + 2);
});

test('refuses completion when the accepted evidence file is missing or tampered', async () => {
  const tamperedTask = await startedTask();
  const tampered = await saveFirstVersion(tamperedTask, '原始内容\n');
  const tamperedPath = storedContentPath(tampered.artifact_id, tampered.version_id);

  await writeFile(tamperedPath, '被篡改的内容\n', 'utf8');

  const tamperedAttempt = await api.post(
    workspacePath(workspaceId, `/tasks/${tamperedTask.task_id}/complete`),
    {
      command_id: randomUUID(),
      expected_revision: tampered.task_revision,
      acceptance_revision: '1',
      artifact_version_ids: [tampered.version_id],
      acceptance: { statement: '篡改后提交', accepted_criterion_ids: ['c1'] },
    },
  );
  const tamperedProblem = expectProblem(tamperedAttempt, 503, 'EVIDENCE_UNAVAILABLE');

  assert.equal(tamperedProblem.retryable, false);

  const afterTamper = await readTask(tamperedTask.task_id);

  assert.equal(afterTamper.status, 'IN_PROGRESS');
  assert.equal(await countCompletionRecords(tamperedTask.task_id), 0);

  await writeFile(tamperedPath, '原始内容\n', 'utf8');

  const restored = await api.post(
    workspacePath(workspaceId, `/tasks/${tamperedTask.task_id}/complete`),
    {
      command_id: randomUUID(),
      expected_revision: tampered.task_revision,
      acceptance_revision: '1',
      artifact_version_ids: [tampered.version_id],
      acceptance: { statement: '恢复原内容后提交', accepted_criterion_ids: ['c1'] },
    },
  );

  assert.equal(restored.status, 200, restored.text);

  const missingTask = await startedTask();
  const missing = await saveFirstVersion(missingTask, '将被删除的内容\n');

  await rm(storedContentPath(missing.artifact_id, missing.version_id));

  const missingContent = await readContent(missing.version_id);

  assert.equal(missingContent.status, 503);

  const missingAttempt = await api.post(
    workspacePath(workspaceId, `/tasks/${missingTask.task_id}/complete`),
    {
      command_id: randomUUID(),
      expected_revision: missing.task_revision,
      acceptance_revision: '1',
      artifact_version_ids: [missing.version_id],
      acceptance: { statement: '文件缺失后提交', accepted_criterion_ids: ['c1'] },
    },
  );

  expectProblem(missingAttempt, 503, 'EVIDENCE_UNAVAILABLE');

  const afterMissing = await readTask(missingTask.task_id);

  assert.equal(afterMissing.status, 'IN_PROGRESS');
  assert.equal(await countCompletionRecords(missingTask.task_id), 0);
});

test('reads the exact historical human completion evidence after reopen and hides lost content', async () => {
  const task = await startedTask();
  const first = await saveFirstVersion(task, '# First accepted version\n');
  const second = await saveNextVersion({ task, artifact: first,
    content: '# Later unaccepted version\n' });
  const commandId = randomUUID();
  const completed = expectCommandAccepted(await api.post(workspacePath(workspaceId,
    `/tasks/${task.task_id}/complete`), {
    command_id: commandId, expected_revision: second.task_revision,
    acceptance_revision: task.acceptance_revision,
    artifact_version_ids: [first.version_id],
    acceptance: { statement: 'I checked this exact version',
      accepted_criterion_ids: ['c1'], reason: 'Verified against the original' },
  }), 200, commandId);
  const completionId = completed.completion_id as string;
  const path = workspacePath(workspaceId, `/completion-records/${completionId}`);
  const firstRead = await api.get(path);
  assert.equal(firstRead.status, 200, firstRead.text);
  assert.equal(firstRead.headers['cache-control'], 'no-store');
  const evidence = firstRead.body as { completion_id: string; task_id: string;
    basis_kind: string; acceptance_revision: string; is_current: boolean;
    acceptance: { availability: string; objective: string; criteria: { criterion_id: string }[] };
    human_acceptance: { availability: string; id: string; actor_kind: string;
      statement: string; accepted_criterion_ids: string[]; reason: string };
    verification_session: null;
    artifact_versions: { availability: string; artifact_version_id: string | null;
      sha256: string | null }[] };
  assert.equal(evidence.completion_id, completionId);
  assert.equal(evidence.task_id, task.task_id);
  assert.equal(evidence.basis_kind, 'HUMAN');
  assert.equal(evidence.acceptance_revision, '1');
  assert.equal(evidence.is_current, true);
  assert.equal(evidence.acceptance.availability, 'AVAILABLE');
  assert.deepEqual(evidence.acceptance.criteria.map((item) => item.criterion_id), ['c1']);
  assert.equal(evidence.human_acceptance.availability, 'AVAILABLE');
  assert.equal(evidence.human_acceptance.actor_kind, 'HUMAN');
  assert.equal(evidence.human_acceptance.statement, 'I checked this exact version');
  assert.deepEqual(evidence.human_acceptance.accepted_criterion_ids, ['c1']);
  assert.equal(evidence.human_acceptance.reason, 'Verified against the original');
  assert.equal(evidence.verification_session, null);
  assert.deepEqual(evidence.artifact_versions.map((item) => item.artifact_version_id),
    [first.version_id]);
  assert.equal(evidence.artifact_versions[0]?.sha256, first.sha256);
  assert.notEqual(evidence.artifact_versions[0]?.artifact_version_id, second.version_id);

  const foreign = await createWorkspace(appDatabase.db);
  assert.equal((await api.get(path, { headers: {
    authorization: 'Bearer wrong' } })).status, 401);
  expectProblem(await api.get(workspacePath(foreign,
    `/completion-records/${completionId}`)), 404, 'RESOURCE_NOT_FOUND');
  expectProblem(await api.get(workspacePath(workspaceId,
    `/completion-records/${randomUUID()}`)), 404, 'RESOURCE_NOT_FOUND');

  const reopenedId = randomUUID();
  expectCommandAccepted(await api.post(workspacePath(workspaceId,
    `/tasks/${task.task_id}/reopen`), { command_id: reopenedId,
    expected_revision: completed.revision, reason: 'A new acceptance cycle' }),
  200, reopenedId);
  const historical = await api.get(path);
  assert.equal(historical.status, 200, historical.text);
  assert.equal((historical.body as { is_current: boolean; acceptance_revision: string })
    .is_current, false);
  assert.equal((historical.body as { acceptance_revision: string }).acceptance_revision, '1');

  await rm(storedContentPath(first.artifact_id, first.version_id));
  const lost = await api.get(path);
  assert.equal(lost.status, 200, lost.text);
  const hidden = (lost.body as { artifact_versions: { availability: string;
    artifact_version_id: string | null; sha256: string | null }[] }).artifact_versions[0];
  assert.deepEqual(hidden, { availability: 'UNAVAILABLE', artifact_version_id: null,
    artifact_id: null, version_number: null, sha256: null });
  assert.equal(lost.text.includes(first.version_id), false);
});
