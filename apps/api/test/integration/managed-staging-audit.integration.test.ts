import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { afterEach, beforeEach } from 'node:test';

import { createProject } from '../../src/application/create-project.js';
import { createTask } from '../../src/application/create-task.js';
import { withTransaction } from '../../src/application/unit-of-work.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { auditManagedStaging } from '../../src/runtime/managed-staging-audit.js';
import {
  CONTENT_FILE_NAME,
  ManagedContentStore,
  managedContentRef,
} from '../../src/storage/managed-content-store.js';
import { createWorkspace } from './api-harness.js';
import { createTemporaryDatabase, MIGRATIONS_DIRECTORY, openDatabase, type TemporaryDatabase } from './integration-support.js';

/**
 * 孤儿暂存核对（DEV-0032）：受管暂存目录与 artifact_versions 的一致性报告。
 * 判定依赖真实数据库——「已提交」的语义就是版本表里存在这一行，因此这里使用
 * 真实临时 PostgreSQL，不用内存假执行器替代。
 *
 * 发布路径本身依赖本地 native helper（Windows 上 publish 调用 relay-file-io-helper），
 * 本套件核对的是「暂存目录 × 版本表」而不是发布动作，因此按发布布局直接构造
 * 文件系统状态，不引入对 native exe 的依赖。
 */

let database: TemporaryDatabase;
let app: ReturnType<typeof openDatabase>;
let root: string;

beforeEach(async () => {
  database = await createTemporaryDatabase('managed_staging_audit');
  await runMigrations({ connectionString: database.migrationUrl, directory: MIGRATIONS_DIRECTORY });
  app = openDatabase(database.appUrl, 'relay-managed-staging-audit-integration');
  root = await mkdtemp(join(tmpdir(), 'relay-managed-staging-audit-'));
});

afterEach(async () => {
  try {
    await app?.close();
    await database?.drop();
    await rm(root, { recursive: true, force: true });
  } finally {
    app = undefined as unknown as ReturnType<typeof openDatabase>;
    database = undefined as unknown as TemporaryDatabase;
  }
});

async function seedArtifact(): Promise<{ readonly artifactId: string }> {
  const workspaceId = await createWorkspace(app.db);
  const project = await createProject(app.db, { workspaceId, commandId: randomUUID(),
    title: 'managed staging audit', projectType: 'GENERAL' });
  const taskId = (await createTask(app.db, { workspaceId, commandId: randomUUID(),
    projectId: project.result.project_id, title: 'staging audit', objective: 'audit',
    criteria: [], expectedOutputs: {}, mode: 'ME' })).result.task_id;
  const artifactId = randomUUID();

  await withTransaction(app.db, async (repositories) => {
    await repositories.artifacts.insertArtifact({ id: artifactId, workspaceId,
      projectId: project.result.project_id, taskId, artifactKind: 'MARKDOWN_DOCUMENT',
      title: 'audit-artifact' });
  });

  return { artifactId };
}

async function recordVersion(artifactId: string, versionId: string, content: Buffer): Promise<void> {
  await withTransaction(app.db, async (repositories) => {
    await repositories.artifacts.insertArtifactVersion({ id: versionId, artifactId,
      versionNumber: 1n, storageRef: managedContentRef(artifactId, versionId),
      contentHash: createHash('sha256').update(content).digest(), size: BigInt(content.byteLength),
      mediaType: 'text/markdown', sourceKind: 'HUMAN', sourceRef: null });
  });
}

/** 按发布布局落盘不可变版本内容：artifacts/<artifact-id>/<version-id>/content.md。 */
async function publishContentFile(artifactId: string, versionId: string, content: Buffer): Promise<void> {
  await mkdir(join(root, 'artifacts', artifactId, versionId), { recursive: true });
  await writeFile(join(root, 'artifacts', artifactId, versionId, CONTENT_FILE_NAME), content);
}

async function stagingFiles(): Promise<readonly string[]> {
  return (await readdir(join(root, 'staging'))).sort();
}

test('orphan staging files are listed with committed staging excluded, and nothing is deleted', async () => {
  const { artifactId } = await seedArtifact();
  const committedVersionId = randomUUID();
  const orphanVersionId = randomUUID();
  const committedContent = Buffer.from('# 已提交版本\n', 'utf8');
  const orphanContent = Buffer.from('# 孤儿暂存\n崩溃残留\n', 'utf8');

  // 已提交：内容已发布到不可变版本目录且数据库登记了版本行。
  const storageRef = managedContentRef(artifactId, committedVersionId);
  await publishContentFile(artifactId, committedVersionId, committedContent);
  await recordVersion(artifactId, committedVersionId, committedContent);
  // 「版本已登记但暂存仍在」的异常态：核对不得把它算成孤儿。
  await mkdir(join(root, 'staging'), { recursive: true });
  await writeFile(join(root, 'staging', `${committedVersionId}.part`), committedContent);
  // 孤儿：发布未走到 rename，版本表没有这一行。
  await writeFile(join(root, 'staging', `${orphanVersionId}.part`), orphanContent);

  const report = await auditManagedStaging(app.db, root);

  assert.equal(report.staging_entry_count, 2);
  assert.equal(report.orphan_count, 1);
  assert.equal(report.orphans.length, 1);
  assert.equal(report.orphans[0]?.version_id, orphanVersionId);
  assert.equal(report.orphans[0]?.staging_ref, `staging/${orphanVersionId}.part`);
  assert.equal(report.orphans[0]?.reason, 'NO_ARTIFACT_VERSION');
  assert.equal(report.orphans[0]?.size_bytes, orphanContent.byteLength);
  assert.equal(typeof report.orphans[0]?.modified_at, 'string');
  assert.ok(report.orphans.every((orphan) => orphan.version_id !== committedVersionId),
    'committed staging must not be reported as orphan');

  assert.deepEqual(report.referenced_staging_entries.map((entry) => entry.version_id),
    [committedVersionId]);

  // 只报告不删除：核对之后暂存文件与已发布内容都原样存在。
  const remaining = await stagingFiles();
  assert.equal(remaining.length, 2);
  assert.ok(remaining.includes(`${committedVersionId}.part`));
  assert.ok(remaining.includes(`${orphanVersionId}.part`));
  assert.equal(
    (await new ManagedContentStore(root).readWithHashCheck(storageRef, {
      contentHash: createHash('sha256').update(committedContent).digest(),
      size: BigInt(committedContent.byteLength),
    })).status,
    'OK',
  );
});

test('a fully published version leaves nothing to report', async () => {
  const { artifactId } = await seedArtifact();
  const versionId = randomUUID();
  const content = Buffer.from('# 正常发布\n', 'utf8');

  await publishContentFile(artifactId, versionId, content);
  await recordVersion(artifactId, versionId, content);

  const report = await auditManagedStaging(app.db, root);

  assert.equal(report.staging_entry_count, 0);
  assert.equal(report.orphan_count, 0);
  assert.deepEqual(report.orphans, []);
  assert.deepEqual(report.referenced_staging_entries, []);
});

test('a missing or empty staging directory is an empty report, not a failure', async () => {
  const missing = await auditManagedStaging(app.db, root);
  assert.equal(missing.orphan_count, 0);
  assert.deepEqual(missing.orphans, []);

  await mkdir(join(root, 'staging'), { recursive: true });
  const empty = await auditManagedStaging(app.db, root);
  assert.equal(empty.orphan_count, 0);
  assert.equal(empty.staging_entry_count, 0);
});

test('staging entries that cannot name any version are reported as orphans', async () => {
  await mkdir(join(root, 'staging'), { recursive: true });
  await writeFile(join(root, 'staging', 'README.md'), 'not managed content\n', 'utf8');
  await writeFile(join(root, 'staging', 'not-a-uuid.part'), 'not managed content\n', 'utf8');

  const report = await auditManagedStaging(app.db, root);

  assert.equal(report.orphan_count, 2);
  assert.deepEqual(report.orphans.map((orphan) => orphan.reason),
    ['UNRECOGNIZED_STAGING_NAME', 'UNRECOGNIZED_STAGING_NAME']);
  assert.deepEqual(report.orphans.map((orphan) => orphan.version_id), [null, null]);
  assert.deepEqual(report.orphans.map((orphan) => orphan.staging_ref),
    ['staging/README.md', 'staging/not-a-uuid.part']);
  assert.deepEqual(report.referenced_staging_entries, []);
});
