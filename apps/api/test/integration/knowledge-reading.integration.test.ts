import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import test, { after, before } from 'node:test';
import { sql } from 'kysely';
import { createKnowledge } from '../../src/application/information-commands.js';
import { createRepositories, withTransaction } from '../../src/application/unit-of-work.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { ManagedContentStore, resolveStoredContentPath } from '../../src/storage/managed-content-store.js';
import { APP_DATABASE_URL, MIGRATIONS_DIRECTORY, MIGRATION_DATABASE_URL, openDatabase } from './integration-support.js';
import { createWorkspace, expectCommandAccepted, startTestApi, workspacePath, type TestApi } from './api-harness.js';

const database = openDatabase(APP_DATABASE_URL, 'relay-knowledge-reading');
let api: TestApi;
let workspaceId: string;
before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
  api = await startTestApi();
  workspaceId = await createWorkspace(database.db);
});
after(async () => { await api?.stop(); await database.close(); });
const endpoint = (id: string, version = '1', workspace = workspaceId) =>
  workspacePath(workspace, `/knowledge/${id}/versions/${version}/content`);
const digest = (text: string) => createHash('sha256').update(text).digest();

test('HTTP reads complete historical text without replacing v1 with v2 or changing excerpt API', async () => {
  const text = '# 历史资料\n\n' + '长中文与 English 内容。\n'.repeat(600);
  const command = randomUUID();
  const created = expectCommandAccepted(await api.post(workspacePath(workspaceId, '/knowledge'), {
    command_id: command, project_id: null, title: '历史资料', source_kind: 'MANAGED_TEXT',
    media_type: 'text/markdown', text,
  }), 201, command);
  const id = created.knowledge_id as string;
  const revisionCommand = randomUUID();
  expectCommandAccepted(await api.post(workspacePath(workspaceId, `/knowledge/${id}/versions`), {
    command_id: revisionCommand, expected_revision: created.revision,
    source_kind: 'NOTE', media_type: 'text/plain', text: '新的纯文本',
  }), 200, revisionCommand);
  const historical = await api.get(endpoint(id));
  assert.equal(historical.status, 200, historical.text);
  assert.equal(historical.headers['cache-control'], 'no-store');
  const body = historical.body as Record<string, unknown>;
  assert.equal(body.content, text);
  assert.equal(body.content_status, 'FULL');
  assert.equal(body.version, '1');
  assert.equal(body.current_version, '2');
  assert.equal(body.content_sha256, digest(text).toString('hex'));
  const current = await api.get(endpoint(id, '2'));
  assert.equal((current.body as Record<string, unknown>).content, '新的纯文本');
  const versions = await api.get(workspacePath(workspaceId, `/knowledge/${id}/versions`));
  assert.equal((versions.body as { excerpt: string }[])[1]?.excerpt.length, 240);
  assert.equal((await api.get(endpoint(id, '3'))).status, 404);
  const otherWorkspace = await createWorkspace(database.db);
  assert.equal((await api.get(endpoint(id, '1', otherWorkspace))).status, 404);
  for (const version of ['0', '-1', '01', '9223372036854775808', '99999999999999999999']) {
    assert.equal((await api.get(endpoint(id, version))).status, 422, version);
  }
});

async function seedText(options: { text: string; hash?: Buffer; unavailable?: boolean; web?: boolean }) {
  const id = randomUUID();
  await database.db.transaction().execute(async (transaction) => {
    const r = createRepositories(transaction);
    await r.information.insertKnowledgeRoot(id, workspaceId, null, '只读反例');
    await sql`insert into knowledge_versions (id, workspace_id, knowledge_id, version,
      source_kind, media_type, content_text, content_sha256, availability, source_uri)
      values (${randomUUID()}, ${workspaceId}, ${id}, 1,
      ${options.web ? 'WEB_PAGE' : 'NOTE'}, 'text/plain', ${options.text},
      ${options.hash ?? digest(options.text)}, ${options.unavailable ? 'UNAVAILABLE' : 'AVAILABLE'},
      ${options.web ? 'http://127.0.0.1:1/unreachable-original' : null})`.execute(transaction);
  });
  return id;
}

test('unavailable stored text stays hidden, and an inline hash mismatch is READ_FAILED', async () => {
  const unavailable = await seedText({ text: '仍保留的正文', unavailable: true });
  const broken = await seedText({ text: '损坏正文', hash: digest('原正文') });
  for (const [id, expected] of [[unavailable, 'UNAVAILABLE'], [broken, 'READ_FAILED']] as const) {
    const response = await api.get(endpoint(id));
    assert.equal(response.status, 200, response.text);
    assert.equal((response.body as Record<string, unknown>).content_status, expected);
    assert.equal((response.body as Record<string, unknown>).content, null);
  }
});

test('saved web snapshot is readable with unreachable original and creates no execution work', async () => {
  const id = await seedText({ text: '离线保存的网页快照全文', web: true });
  const counts = async () => (await sql<{ runs: bigint; operations: bigint }>`select
    (select count(*) from runs where workspace_id = ${workspaceId}) as runs,
    (select count(*) from logical_operations where workspace_id = ${workspaceId}) as operations`
    .execute(database.db)).rows[0];
  const before = await counts();
  const response = await api.get(endpoint(id));
  assert.equal(response.status, 200, response.text);
  assert.equal((response.body as Record<string, unknown>).content_status, 'FULL');
  assert.equal((response.body as Record<string, unknown>).content, '离线保存的网页快照全文');
  assert.equal((response.body as Record<string, unknown>).source_uri, 'http://127.0.0.1:1/unreachable-original');
  assert.deepEqual(await counts(), before);
});

test('Artifact source reads exact managed bytes; corrupt/missing bytes never fall back and cross-project promotion fails', async () => {
  const projectId = randomUUID();
  const otherProjectId = randomUUID();
  const taskId = randomUUID();
  const artifactId = randomUUID();
  const versionId = randomUUID();
  const text = '# 受管产物\n\n' + '确切版本正文。'.repeat(400);
  const stored = await new ManagedContentStore(api.dataRoot).publish({ artifactId,
    versionId, content: Buffer.from(text) });
  await withTransaction(database.db, async (r) => {
    for (const id of [projectId, otherProjectId]) {
      await r.projects.insertProject({ id, workspaceId, title: '知识范围测试', projectType: 'GENERAL' });
      await r.projects.insertProjectState(id, 'PLANNING');
    }
    await r.tasks.insertTask({ id: taskId, workspaceId, projectId, title: '产物来源',
      status: 'READY', mode: 'ME', acceptanceRevision: 1n, executorKind: 'HUMAN',
      ownershipEpoch: 0n, currentCompletionId: null });
    await r.tasks.insertAcceptanceVersion({ taskId, acceptanceRevision: 1n,
      objective: '来源核对', requiredOutputSpec: {}, source: 'CREATE' });
    await r.tasks.insertCriterion({ taskId, acceptanceRevision: 1n, criterionId: 'human',
      statement: '人工验收', required: true, method: 'HUMAN', targetSpec: {} });
    await r.artifacts.insertArtifact({ id: artifactId, workspaceId, projectId, taskId,
      artifactKind: 'MARKDOWN_DOCUMENT', title: '受管正文' });
    await r.artifacts.insertArtifactVersion({ id: versionId, artifactId, versionNumber: 1n,
      ...stored, mediaType: 'text/markdown', sourceKind: 'HUMAN', sourceRef: null });
  });
  const promote = { workspaceId, projectId, title: '来源引用',
    source: { sourceKind: 'ARTIFACT_VERSION' as const, artifactVersionId: versionId } };
  const commandId = randomUUID();
  const created = await createKnowledge(database.db, { ...promote, commandId });
  const repeated = await createKnowledge(database.db, { ...promote, commandId });
  assert.equal(repeated.result.knowledge_id, created.result.knowledge_id);
  const id = created.result.knowledge_id!;
  assert.equal((await api.get(endpoint(id))).status, 200);
  assert.equal(((await api.get(endpoint(id))).body as Record<string, unknown>).content, text);
  await assert.rejects(createKnowledge(database.db, { ...promote, projectId: otherProjectId,
    commandId: randomUUID() }), (error: unknown) => (error as { code: string }).code === 'RESOURCE_NOT_FOUND');
  // The database itself rejects an Artifact reference carrying fallback inline text.
  await assert.rejects(sql`insert into knowledge_versions (id, workspace_id, knowledge_id,
    project_id, version, source_kind, media_type, content_text, content_sha256,
    source_artifact_id, artifact_version_id) values (${randomUUID()}, ${workspaceId}, ${id},
    ${projectId}, 2, 'ARTIFACT_VERSION', 'text/markdown', 'fallback', ${stored.contentHash},
    ${artifactId}, ${versionId})`.execute(database.db),
  (error: unknown) => (error as { code: string }).code === '23514');
  const path = resolveStoredContentPath(api.dataRoot, stored.storageRef);
  await writeFile(path, 'tampered');
  const corrupt = await api.get(endpoint(id));
  assert.equal((corrupt.body as Record<string, unknown>).content_status, 'READ_FAILED');
  assert.equal((corrupt.body as Record<string, unknown>).content, null);
  await rm(path);
  const missing = await api.get(endpoint(id));
  assert.equal((missing.body as Record<string, unknown>).content_status, 'UNAVAILABLE');
  assert.equal((missing.body as Record<string, unknown>).content, null);
});
