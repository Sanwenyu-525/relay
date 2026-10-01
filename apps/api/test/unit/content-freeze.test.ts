import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { link, mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseContentFreezeArguments } from '../../src/cli/content-freeze.js';
import { observeContentFreezeSession, openContentFreezeSession, parseContentFreezeEvent } from
  '../../src/runtime/content-freeze-session.js';
import { ManagedContentStore, MAX_MARKDOWN_BYTES, StorageUnavailableError, contentHashOf,
  resolveStoredContentPath } from '../../src/storage/managed-content-store.js';
import { CONTENT_PROTOCOL, parseContentReply, WindowsContentError } from '../../src/storage/windows-content-publisher.js';

const native = { skip: process.platform !== 'win32' };
const encoded = (value: unknown) => Buffer.from(JSON.stringify(value));
const identity = '0000000000000001:00000000000000000000000000000001';
async function withRoot(work: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'relay-content-freeze-unit-'));
  try { await work(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('content freeze CLI admits only its single absolute root and fixed action', () => {
  assert.deepEqual(parseContentFreezeArguments(['hold-content-freeze', '--data-root', tmpdir()]), { dataRoot: tmpdir() });
  for (const argv of [[], ['status'], ['hold-content-freeze', '--data-root', 'relative'],
    ['hold-content-freeze', '--data-root', tmpdir(), '--data-root', tmpdir()],
    ['hold-content-freeze', '--package-root', tmpdir()], ['hold-content-freeze', '--data-root']]) {
    assert.throws(() => parseContentFreezeArguments(argv));
  }
});

test('private replies require exact version, nonce, identities, schema and bounded UTF8', () => {
  const nonce = randomUUID();
  const ready = { version: CONTENT_PROTOCOL, ok: true, event: 'content_freeze_ready', nonce,
    root_id: identity, sentinel_id: identity };
  assert.deepEqual(parseContentFreezeEvent(encoded(ready), nonce), {
    event: 'content_freeze_ready', rootId: identity, sentinelId: identity });
  for (const reply of [{ ...ready, version: 'old' }, { ...ready, nonce: randomUUID() },
    { ...ready, root_id: 'path' }, { ...ready, frozen: true }, { ...ready, ok: 'true' }]) {
    assert.throws(() => parseContentFreezeEvent(encoded(reply), nonce), WindowsContentError);
  }
  assert.throws(() => parseContentReply(Buffer.from([0xff])), WindowsContentError);
  assert.throws(() => parseContentReply(Buffer.alloc(16 * 1024 + 1)), WindowsContentError);
  assert.throws(() => parseContentReply(encoded({ version: CONTENT_PROTOCOL, ok: false,
    error: { code: 'CONTENT_FROZEN', message: 'safe' } })), { code: 'CONTENT_FROZEN' });
  assert.throws(() => parseContentReply(encoded({ version: CONTENT_PROTOCOL, ok: false,
    error: { code: 'synthetic-private-message', message: 'secret' } })), { message: 'CONTENT_IO_FAILED' });
});

test('protocol failure after release stays sticky even when the child already exited zero', async () => {
  class ControlledNative extends EventEmitter {
    readonly stdin = new PassThrough(); readonly stdout = new PassThrough(); readonly stderr = new PassThrough();
    exitCode: number | null = null; signalCode: NodeJS.Signals | null = null;
    kill() { return false; }
  }
  const child = new ControlledNative();
  const nonce = randomUUID();
  child.stdin.once('data', () => child.stdout.write(encoded({ version: CONTENT_PROTOCOL,
    ok: true, event: 'content_freeze_ready', nonce, root_id: identity, sentinel_id: identity }).toString() + '\n'));
  const held = await observeContentFreezeSession(child, nonce, 'C:\\synthetic-root');
  child.stdin.once('finish', () => {
    child.exitCode = 0;
    child.stdout.write(encoded({ version: CONTENT_PROTOCOL, ok: true, event: 'content_freeze_released', nonce }).toString() + '\n');
    child.stdout.write(encoded({ version: CONTENT_PROTOCOL, ok: true, event: 'unexpected', nonce }).toString() + '\n');
    child.emit('close', 0, null);
  });
  await assert.rejects(() => held.release(), { code: 'CONTENT_PROTOCOL_INVALID' });
  assert.equal((await held.closed).failure?.code, 'CONTENT_PROTOCOL_INVALID');
  assert.equal(held.isHeld(), false);
});

test('failed content release waits for the owned helper close before rejecting', async () => {
  class ControlledNative extends EventEmitter {
    readonly stdin = new PassThrough(); readonly stdout = new PassThrough(); readonly stderr = new PassThrough();
    exitCode: number | null = null; signalCode: NodeJS.Signals | null = null; stopped = false;
    kill() { setTimeout(() => { this.stopped = true; this.exitCode = 1; this.emit('close', 1, null); }, 20); return true; }
  }
  const child = new ControlledNative(), nonce = randomUUID();
  child.stdin.once('data', () => child.stdout.write(`${JSON.stringify({ version: CONTENT_PROTOCOL, ok: true,
    event: 'content_freeze_ready', nonce, root_id: identity, sentinel_id: identity })}\n`));
  const session = await observeContentFreezeSession(child, nonce, 'C:\\synthetic-test-root');
  child.stdout.write('invalid\n');
  await assert.rejects(session.release());
  assert.equal(child.stopped, true);
});

test('real native freeze rejects all Node publication before staging and restores exact bytes afterwards', native, async () => {
  await withRoot(async (root) => {
    const store = new ManagedContentStore(root);
    const input = { artifactId: randomUUID().toUpperCase(), versionId: randomUUID().toUpperCase(),
      content: Buffer.from([0xff, 0x00, 0xe4, 0xb8, 0xad, 0x0a]) };
    const held = await openContentFreezeSession(root);
    try {
      assert.equal(held.isHeld(), true);
      await assert.rejects(() => openContentFreezeSession(root), { code: 'CONTENT_FREEZE_BUSY' });
      await assert.rejects(() => store.publish(input), StorageUnavailableError);
      assert.deepEqual(await readdir(root), ['.relay-content-admission.lock']);
    } finally { if (held.isHeld()) await held.release(); }
    assert.equal(held.isHeld(), false);
    assert.equal((await held.closed).code, 0);
    const next = await openContentFreezeSession(root);
    assert.equal(next.rootId, held.rootId); assert.equal(next.sentinelId, held.sentinelId);
    await next.release();
    const published = await store.publish(input);
    assert.deepEqual(await readFile(resolveStoredContentPath(root, published.storageRef)), input.content);
    assert.ok(published.contentHash.equals(contentHashOf(input.content)));
    assert.equal(published.size, BigInt(input.content.length));
    await assert.rejects(() => store.publish({ ...input, content: Buffer.from('overwrite') }), /immutable content already exists/u);
  });
});

test('Windows helper absence fails closed without creating any content', native, async () => {
  await withRoot(async (root) => {
    const original = process.env.RELAY_FILE_IO_HELPER;
    process.env.RELAY_FILE_IO_HELPER = join(root, 'missing-helper.exe');
    try {
      await assert.rejects(() => new ManagedContentStore(root).publish({ artifactId: randomUUID(),
        versionId: randomUUID(), content: Buffer.from('must not use Node fs fallback') }), StorageUnavailableError);
      await assert.rejects(() => openContentFreezeSession(root), { code: 'CONTENT_IO_FAILED' });
      assert.deepEqual(await readdir(root), []);
    } finally {
      if (original === undefined) delete process.env.RELAY_FILE_IO_HELPER;
      else process.env.RELAY_FILE_IO_HELPER = original;
    }
  });
});

test('256 KiB is accepted and larger buffers leave no staging/target', native, async () => {
  await withRoot(async (root) => {
    const store = new ManagedContentStore(root);
    await assert.rejects(() => store.publish({ artifactId: randomUUID(), versionId: randomUUID(),
      content: Buffer.alloc(MAX_MARKDOWN_BYTES + 1) }), StorageUnavailableError);
    assert.deepEqual(await readdir(root), []);
    const result = await store.publish({ artifactId: randomUUID(), versionId: randomUUID(),
      content: Buffer.alloc(MAX_MARKDOWN_BYTES, 0x61) });
    assert.equal(result.size, BigInt(MAX_MARKDOWN_BYTES));
  });
});

test('Node rejects linked roots and native rejects multi-link sentinels', native, async () => {
  await withRoot(async (root) => {
    const linked = join(root, 'linked');
    await symlink(root, linked, 'junction');
    await assert.rejects(() => openContentFreezeSession(linked), { code: 'INVALID_ROOT' });
    await assert.rejects(() => new ManagedContentStore(linked).publish({ artifactId: randomUUID(),
      versionId: randomUUID(), content: Buffer.from('blocked') }), StorageUnavailableError);
    const held = await openContentFreezeSession(root); await held.release();
    await link(join(root, '.relay-content-admission.lock'), join(root, 'alias.lock'));
    await assert.rejects(() => openContentFreezeSession(root), { code: 'HARD_LINK' });
    await assert.rejects(() => new ManagedContentStore(root).publish({ artifactId: randomUUID(),
      versionId: randomUUID(), content: Buffer.from('blocked') }), StorageUnavailableError);
    assert.equal((await readdir(root)).includes('staging'), false);
  });
});

async function cli(root: string, input: string | null): Promise<{ code: number | null; lines: unknown[]; stderr: string }> {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../../src/cli/content-freeze.js', import.meta.url)),
    'hold-content-freeze', '--data-root', root], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let stdout = ''; let stderr = '';
  const timeout = setTimeout(() => child.kill(), 10_000);
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  child.stdout.once('data', async () => {
    try {
      await assert.rejects(() => new ManagedContentStore(root).publish({ artifactId: randomUUID(),
        versionId: randomUUID(), content: Buffer.from('during CLI hold') }), StorageUnavailableError);
    } finally { child.stdin.end(input ?? undefined); }
  });
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject); child.once('close', (code) => resolve(code));
  }).finally(() => clearTimeout(timeout));
  return { code, lines: stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as unknown), stderr };
}

test('actual CLI holds native admission and releases on exact input or EOF', native, async () => {
  await withRoot(async (root) => {
    for (const input of ['release\n', null]) {
      const result = await cli(root, input);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stderr, '');
      assert.equal(result.lines.length, 2);
      assert.equal((result.lines[0] as { scope: string }).scope, 'MANAGED_CONTENT_PUBLISH_ONLY');
      assert.equal((result.lines[0] as { database_frozen: boolean }).database_frozen, false);
      assert.equal((result.lines[1] as { type: string }).type, 'content_freeze_released');
    }
    await new ManagedContentStore(root).publish({ artifactId: randomUUID(), versionId: randomUUID(), content: Buffer.from('after CLI') });
  });
});

test('actual CLI bad/trailing/oversize release has no success frame and still closes native lock', native, async () => {
  await withRoot(async (root) => {
    for (const input of ['wrong\n', 'release\nextra\n', 'x'.repeat(257)]) {
      const result = await cli(root, input);
      assert.equal(result.code, 2);
      assert.deepEqual(JSON.parse(result.stderr), { code: 'CONFIGURATION_ERROR' });
      assert.equal(result.lines.length, 1, 'no release success after invalid input');
      const held = await openContentFreezeSession(root); await held.release();
    }
  });
});
