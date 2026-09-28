import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { computeSha256, MAX_FILE_WRITE_DIFF_TEXT_BYTES,
  readFrozenFileWriteBaseline } from '../../src/files/file-changeset.js';

test('frozen baseline read accepts exact bounded UTF-8 and rejects stale, binary and oversized content', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-frozen-diff-'));
  try {
    await mkdir(join(root, 'src'));
    const text = '\uFEFF你好\n';
    await writeFile(join(root, 'src', 'a.txt'), text);
    const sha = computeSha256(text);
    assert.deepEqual(await readFrozenFileWriteBaseline(root, 'src/a.txt', sha), {
      baselineSha256: sha, baselineText: text, unavailableReason: null,
    });
    assert.equal((await readFrozenFileWriteBaseline(root, 'src/a.txt', computeSha256('old')))
      .unavailableReason, 'BASELINE_SHA_MISMATCH');
    const binary = Buffer.from([0, 1, 2]);
    await writeFile(join(root, 'src', 'binary'), binary);
    assert.equal((await readFrozenFileWriteBaseline(root, 'src/binary', computeSha256(binary)))
      .unavailableReason, 'BINARY_OR_INVALID_UTF8');
    const large = 'x'.repeat(MAX_FILE_WRITE_DIFF_TEXT_BYTES + 1);
    await writeFile(join(root, 'src', 'large'), large);
    assert.equal((await readFrozenFileWriteBaseline(root, 'src/large', computeSha256(large)))
      .unavailableReason, 'TEXT_TOO_LARGE');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('frozen baseline read refuses root escape and linked target', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-frozen-diff-'));
  const outside = await mkdtemp(join(tmpdir(), 'relay-frozen-outside-'));
  try {
    const content = 'secret';
    await writeFile(join(outside, 'outside.txt'), content);
    assert.equal((await readFrozenFileWriteBaseline(root, '../outside.txt', computeSha256(content)))
      .unavailableReason, 'UNSAFE_OR_UNREADABLE');
    try {
      await symlink(join(outside, 'outside.txt'), join(root, 'linked.txt'), 'file');
      assert.equal((await readFrozenFileWriteBaseline(root, 'linked.txt', computeSha256(content)))
        .unavailableReason, 'TARGET_NOT_REGULAR');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
    }
    await mkdir(dirname(join(root, 'nested', 'file.txt')), { recursive: true });
    assert.equal((await readFrozenFileWriteBaseline(root, 'nested/missing.txt', computeSha256(content)))
      .unavailableReason, 'UNSAFE_OR_UNREADABLE');
    await symlink(outside, join(root, 'linked-dir'), 'junction');
    assert.equal((await readFrozenFileWriteBaseline(root, 'linked-dir/outside.txt', computeSha256(content)))
      .unavailableReason, 'PARENT_CHANGED');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
