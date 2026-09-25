import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  CONTENT_FILE_NAME,
  ManagedContentStore,
  STAGING_DIRECTORY,
  UnsafeStorageRefError,
  contentHashOf,
  managedContentRef,
  resolveStoredContentPath,
} from '../../src/storage/managed-content-store.js';

/**
 * 受管内容存储的路径与发布语义（物理设计第 7 节、契约 04 第 6 节）。
 * 这些用例不接触数据库，只验证“内容路径不能由调用方拼出来”和“发布不可覆盖”两条硬约束。
 */

async function withDataRoot<T>(work: (dataRoot: string) => Promise<T>): Promise<T> {
  const dataRoot = await mkdtemp(join(tmpdir(), 'relay-content-store-unit-'));

  try {
    return await work(dataRoot);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
}

test('builds the managed content path from internal ids only', () => {
  const artifactId = randomUUID();
  const versionId = randomUUID();

  assert.equal(
    managedContentRef(artifactId, versionId),
    `artifacts/${artifactId}/${versionId}/${CONTENT_FILE_NAME}`,
  );
});

test('refuses to build a storage path from anything that is not a uuid', () => {
  for (const value of [
    '../../../windows/win.ini',
    '..\\..\\etc\\passwd',
    'C:/windows/win.ini',
    '/etc/passwd',
    '',
    'not-a-uuid',
  ]) {
    assert.throws(
      () => managedContentRef(value, randomUUID()),
      (error: unknown) => error instanceof UnsafeStorageRefError,
      `expected ${value} to be rejected`,
    );
  }
});

test('rejects storage refs that are absolute, traversing or escaping the data root', () => {
  const dataRoot = join(tmpdir(), 'relay-content-store-unit-root');

  for (const ref of [
    '/etc/passwd',
    '\\etc\\passwd',
    'C:\\windows\\win.ini',
    'artifacts/../../etc/passwd',
    '..\\artifacts\\content.md',
    'artifacts/./content.md',
    'artifacts//content.md',
    'artifacts/content.md\0.txt',
    '',
  ]) {
    assert.throws(
      () => resolveStoredContentPath(dataRoot, ref),
      (error: unknown) => error instanceof UnsafeStorageRefError,
      `expected ${ref} to be rejected`,
    );
  }
});

test('publishes immutable content, flushes it and ignores the staging file afterwards', async () => {
  await withDataRoot(async (dataRoot) => {
    const store = new ManagedContentStore(dataRoot);
    const artifactId = randomUUID();
    const versionId = randomUUID();
    const content = Buffer.from('# 标题\n\n正文内容\n', 'utf8');

    const published = await store.publish({ artifactId, versionId, content });

    assert.equal(published.storageRef, managedContentRef(artifactId, versionId));
    assert.equal(published.size, BigInt(content.byteLength));
    assert.ok(published.contentHash.equals(contentHashOf(content)));

    const stored = await readFile(resolveStoredContentPath(dataRoot, published.storageRef));

    assert.deepEqual(stored, content);

    const staged = await readFile(join(dataRoot, STAGING_DIRECTORY, `${versionId}.part`)).catch(
      () => undefined,
    );

    assert.equal(staged, undefined, 'staging file must not remain after a successful publish');

    const verified = await store.readWithHashCheck(published.storageRef, {
      contentHash: published.contentHash,
      size: published.size,
    });

    assert.equal(verified.status, 'OK');
    assert.deepEqual(verified.status === 'OK' ? verified.content : undefined, content);
  });
});

test('never overwrites an already published version directory', async () => {
  await withDataRoot(async (dataRoot) => {
    const store = new ManagedContentStore(dataRoot);
    const artifactId = randomUUID();
    const versionId = randomUUID();

    await store.publish({
      artifactId,
      versionId,
      content: Buffer.from('first', 'utf8'),
    });

    await assert.rejects(
      store.publish({ artifactId, versionId, content: Buffer.from('second', 'utf8') }),
      /immutable content already exists/u,
    );

    const stored = await readFile(
      resolveStoredContentPath(dataRoot, managedContentRef(artifactId, versionId)),
    );

    assert.equal(stored.toString('utf8'), 'first');
  });
});

test('reports missing and tampered content instead of returning it', async () => {
  await withDataRoot(async (dataRoot) => {
    const store = new ManagedContentStore(dataRoot);
    const artifactId = randomUUID();
    const versionId = randomUUID();
    const published = await store.publish({
      artifactId,
      versionId,
      content: Buffer.from('original', 'utf8'),
    });
    const path = resolveStoredContentPath(dataRoot, published.storageRef);

    await writeFile(path, 'tampered', 'utf8');

    const tampered = await store.readWithHashCheck(published.storageRef, {
      contentHash: published.contentHash,
      size: published.size,
    });

    assert.equal(tampered.status, 'TAMPERED');

    await rm(path);

    const missing = await store.readWithHashCheck(published.storageRef, {
      contentHash: published.contentHash,
      size: published.size,
    });

    assert.equal(missing.status, 'MISSING');

    const escaping = await store.readWithHashCheck('../../outside/content.md', {
      contentHash: published.contentHash,
      size: published.size,
    });

    assert.equal(escaping.status, 'UNREADABLE');
  });
});