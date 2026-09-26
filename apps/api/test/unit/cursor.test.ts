import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { decodeProjectListCursor, decodeTaskListCursor, decodeWorkspaceTaskListCursor,
  encodeProjectListCursor, encodeTaskListCursor, encodeWorkspaceTaskListCursor,
} from '../../src/api/cursor.js';
import { DomainError } from '../../src/application/domain-error.js';

/** 列表游标：绑定过滤条件与稳定排序键，非法游标返回 400 INVALID_CURSOR。 */

const filter = { projectId: randomUUID() };
const createdAt = new Date('2026-09-20T03:04:05.678Z');
const id = randomUUID();

test('round-trips a bound cursor', () => {
  const encoded = encodeTaskListCursor({ filter, createdAt, id });
  const decoded = decodeTaskListCursor(encoded, filter);

  assert.equal(decoded.createdAt.toISOString(), createdAt.toISOString());
  assert.equal(decoded.id, id);
  assert.equal(decoded.filter.projectId, filter.projectId);
});

test('rejects a cursor used with a different filter', () => {
  const encoded = encodeTaskListCursor({ filter, createdAt, id });

  assert.throws(
    () => decodeTaskListCursor(encoded, { projectId: null }),
    (error: unknown) => {
      assert.ok(error instanceof DomainError);
      assert.equal(error.code, 'INVALID_CURSOR');
      assert.equal(error.status, 400);
      assert.equal(error.retryAction, 'NONE');
      return true;
    },
  );
});

test('rejects unparsable, tampered and oversized cursors', () => {
  for (const raw of [
    'not-a-cursor',
    Buffer.from('{"v":1}', 'utf8').toString('base64url'),
    Buffer.from(
      JSON.stringify({
        v: 2,
        filter: { project_id: filter.projectId, inbox: false },
        created_at: createdAt.toISOString(),
        id,
      }),
      'utf8',
    ).toString('base64url'),
    Buffer.from(
      JSON.stringify({
        v: 1,
        filter: { project_id: filter.projectId },
        created_at: 'not-a-timestamp',
        id,
      }),
      'utf8',
    ).toString('base64url'),
    Buffer.from(
      JSON.stringify({
        v: 1,
        filter: { project_id: filter.projectId },
        created_at: createdAt.toISOString(),
        id: 'not-a-uuid',
      }),
      'utf8',
    ).toString('base64url'),
    'a'.repeat(600),
  ]) {
    assert.throws(
      () => decodeTaskListCursor(raw, filter),
      (error: unknown) => error instanceof DomainError && error.code === 'INVALID_CURSOR',
      `expected INVALID_CURSOR for ${raw.slice(0, 24)}`,
    );
  }
});

test('encodes the inbox filter explicitly', () => {
  const encoded = encodeTaskListCursor({ filter: { projectId: null }, createdAt, id });

  assert.equal(decodeTaskListCursor(encoded, { projectId: null }).filter.projectId, null);
  assert.throws(
    () => decodeTaskListCursor(encoded, filter),
    (error: unknown) => error instanceof DomainError && error.code === 'INVALID_CURSOR',
  );
});

test('new list cursors keep the exact microsecond key and bind scope or status', () => {
  const key = { createdAt: '2026-09-20T03:04:05.678901Z', id };
  const workspaceId = randomUUID();
  const allTasks = encodeWorkspaceTaskListCursor(workspaceId, key);
  assert.deepEqual(decodeWorkspaceTaskListCursor(allTasks, workspaceId), key);
  assert.throws(() => decodeTaskListCursor(allTasks, filter),
    (error: unknown) => error instanceof DomainError && error.code === 'INVALID_CURSOR');
  assert.throws(() => decodeWorkspaceTaskListCursor(allTasks, randomUUID()),
    (error: unknown) => error instanceof DomainError && error.code === 'INVALID_CURSOR');

  const activeProjects = encodeProjectListCursor(workspaceId, 'active', key);
  assert.deepEqual(decodeProjectListCursor(activeProjects, workspaceId, 'active'), key);
  assert.throws(() => decodeProjectListCursor(activeProjects, workspaceId, 'archived'),
    (error: unknown) => error instanceof DomainError && error.code === 'INVALID_CURSOR');
  assert.throws(() => decodeProjectListCursor(activeProjects, randomUUID(), 'active'),
    (error: unknown) => error instanceof DomainError && error.code === 'INVALID_CURSOR');
  assert.throws(() => decodeWorkspaceTaskListCursor(activeProjects, workspaceId),
    (error: unknown) => error instanceof DomainError && error.code === 'INVALID_CURSOR');
});
