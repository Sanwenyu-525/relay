import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  isProtectedPath,
  validateSafeRelativePath,
  canonicalRelativePath,
  computeSha256,
  isFrozenBaseline,
  requireFrozenBaseline,
  executeFileChangeset,
  reconcileFileChangeset,
} from '../../src/files/file-changeset.js';

test('isProtectedPath correctly detects protected system and sensitive directories', () => {
  assert.equal(isProtectedPath('.git'), true);
  assert.equal(isProtectedPath('.git/HEAD'), true);
  assert.equal(isProtectedPath('.git\\config'), true);
  assert.equal(isProtectedPath('.env'), true);
  assert.equal(isProtectedPath('.env.production'), true);
  assert.equal(isProtectedPath('.env.local'), true);
  assert.equal(isProtectedPath('node_modules'), true);
  assert.equal(isProtectedPath('node_modules/package/index.js'), true);
  assert.equal(isProtectedPath('.relay/config.json'), true);
  assert.equal(isProtectedPath('data/db.sqlite'), true);

  // Normal safe project paths
  assert.equal(isProtectedPath('src/main.ts'), false);
  assert.equal(isProtectedPath('docs/README.md'), false);
  assert.equal(isProtectedPath('package.json'), false);
  assert.equal(isProtectedPath('tests/unit.test.ts'), false);
});

test('validateSafeRelativePath prevents directory traversal, null bytes, and absolute paths', () => {
  const root = resolve('D:/dummy/project');

  // Valid relative path
  const valid = validateSafeRelativePath(root, 'src/app.ts');
  assert.equal(valid, resolve(root, 'src/app.ts'));

  // Null byte injection
  assert.throws(
    () => validateSafeRelativePath(root, 'src/test\u0000.ts'),
    /null bytes/,
  );

  // Absolute path
  assert.throws(
    () => validateSafeRelativePath(root, 'C:/Windows/System32'),
    /must be relative/,
  );

  // Traversal out of root
  assert.throws(
    () => validateSafeRelativePath(root, '../other/file.txt'),
    /escapes the resource root/,
  );
  assert.throws(
    () => validateSafeRelativePath(root, 'src/../../outside.txt'),
    /escapes the resource root/,
  );

  // Protected file
  assert.throws(
    () => validateSafeRelativePath(root, '.git/config'),
    /protected and cannot be modified/,
  );
});

test('computeSha256 produces exact hex digest', () => {
  const hash = computeSha256('hello world');
  assert.equal(
    hash,
    'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9',
  );
});

// P1-3: 路径别名等价必须在归一后仍命中保护规则（Prepare 与 Execute 共用本函数）。
test('isProtectedPath catches alias, case and separator equivalents', () => {
  assert.equal(isProtectedPath('./.env'), true);
  assert.equal(isProtectedPath('./.env.local'), true);
  assert.equal(isProtectedPath('.ENV'), true);
  assert.equal(isProtectedPath('.Env.Production'), true);
  assert.equal(isProtectedPath('.git\\config'), true);
  assert.equal(isProtectedPath('./node_modules/x'), true);
  assert.equal(isProtectedPath('./src/app.ts'), false);
});

test('validateSafeRelativePath normalizes aliases before applying protection', () => {
  const root = resolve('D:/dummy/project');
  for (const alias of ['./.env', 'src/../.env', '.ENV', '.git/config', 'foo/../.git/config', '.git\\config']) {
    assert.throws(() => validateSafeRelativePath(root, alias), /protected/, `${alias} must be denied after normalization`);
  }
  // 合法别名不受影响，且返回解析后的绝对路径。
  assert.equal(validateSafeRelativePath(root, 'src/./app.ts'), resolve(root, 'src/app.ts'));
  // 根内 '..' 逃逸仍被拒绝，修复不放宽禁止目录范围。
  assert.throws(() => validateSafeRelativePath(root, 'src/../../outside.txt'), /escapes the resource root/);
});

test('Windows relative paths reject stream, device and trailing alias segments before prepare',
  { skip: process.platform !== 'win32' }, () => {
    const root = resolve('D:/dummy/project');
    const unsafe = [
      'src/config.txt:secret', 'src/name:stream:$DATA', 'src/dir:stream/file.txt',
      'src\\file.txt:secret', 'CON', 'src/con.txt', 'src/CON .txt', 'PRN.json',
      'src/AUX', 'nul.log', 'COM1', 'src/com9.txt', 'COM¹', 'src/com².txt', 'COM³.log',
      'LPT1', 'src/lpt9.log', 'src\\LPT2.txt', 'LPT¹', 'src/lpt².txt', 'LPT³.log',
      'src/name.', 'src/name ', 'src/dir./file.txt', 'src/dir /file.txt',
      'src/bad?.txt', 'src/bad*.txt', 'src/bad<.txt', 'src/bad>.txt',
      'src/bad".txt', 'src/bad|.txt', 'src/bad\u0001.txt', 'src/bad\u001f.txt',
    ];
    for (const path of unsafe) {
      assert.throws(() => validateSafeRelativePath(root, path), /Windows path segment/, path);
      assert.throws(() => canonicalRelativePath(root, path), /Windows path segment/, `prepare: ${path}`);
    }
    for (const path of ['src/app.ts', 'src/console.txt', 'src/com0.txt', 'src/com10.txt',
      'src/lpt0.txt', 'src/name with space.txt', 'src/name.with.dots.txt']) {
      assert.equal(validateSafeRelativePath(root, path), resolve(root, path));
      assert.equal(canonicalRelativePath(root, path), path);
    }
    assert.equal(canonicalRelativePath(root, 'src\\app.ts'), 'src/app.ts');
  });

// P1-2: 修改/删除必须携带格式有效的冻结基线；CREATE 无基线放行。
test('isFrozenBaseline accepts only 64-hex sha256 digests', () => {
  assert.equal(isFrozenBaseline('a'.repeat(64)), true);
  assert.equal(isFrozenBaseline('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'), true);
  assert.equal(isFrozenBaseline(undefined), false);
  assert.equal(isFrozenBaseline(null), false);
  assert.equal(isFrozenBaseline(''), false);
  assert.equal(isFrozenBaseline('a'.repeat(63)), false);
  assert.equal(isFrozenBaseline('g'.repeat(64)), false);
});

test('requireFrozenBaseline enforces a baseline only for MODIFY/DELETE', () => {
  assert.doesNotThrow(() => requireFrozenBaseline({ action: 'CREATE', baselineSha256: undefined }));
  assert.doesNotThrow(() => requireFrozenBaseline({ action: 'MODIFY', baselineSha256: 'a'.repeat(64) }));
  assert.throws(() => requireFrozenBaseline({ action: 'MODIFY', baselineSha256: undefined }), /requires a valid frozen baseline/);
  assert.throws(() => requireFrozenBaseline({ action: 'DELETE', baselineSha256: 'short' }), /requires a valid frozen baseline/);
});

test('executeFileChangeset rejects CREATE/MODIFY without explicit content before any write', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-file-changeset-'));
  try {
    const create = await executeFileChangeset(root, [{ path: 'new.txt', action: 'CREATE' }]);
    assert.equal(create.changes[0]?.status, 'FAILED');
    await assert.rejects(readFile(join(root, 'new.txt')), (error: unknown) =>
      (error as NodeJS.ErrnoException).code === 'ENOENT');
    await writeFile(join(root, 'existing.txt'), 'original\n');
    const modify = await executeFileChangeset(root, [{ path: 'existing.txt', action: 'MODIFY',
      baselineSha256: computeSha256('original\n') }]);
    assert.equal(modify.changes[0]?.status, 'FAILED');
    assert.equal(await readFile(join(root, 'existing.txt'), 'utf8'), 'original\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('MODIFY/DELETE of absent nested targets conflict without creating parent directories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-file-absent-parent-'));
  try {
    for (const action of ['MODIFY', 'DELETE'] as const) {
      const parent = join(root, action.toLowerCase());
      const result = await executeFileChangeset(root, [{ path: `${action.toLowerCase()}/nested/absent.txt`,
        action, baselineSha256: computeSha256('old\n'),
        ...(action === 'MODIFY' ? { content: 'new\n' } : {}) }]);
      assert.equal(result.changes[0]?.status, 'CONFLICT');
      await assert.rejects(realpath(parent), (error: unknown) =>
        (error as NodeJS.ErrnoException).code === 'ENOENT');
    }
    const created = await executeFileChangeset(root, [{ path: 'create/nested/new.txt',
      action: 'CREATE', content: 'new\n' }]);
    assert.equal(created.changes[0]?.status, 'APPLIED');
    assert.equal(await readFile(join(root, 'create', 'nested', 'new.txt'), 'utf8'), 'new\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('MODIFY/DELETE accept an uppercase frozen baseline digest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-file-uppercase-baseline-'));
  try {
    const baselineSha256 = computeSha256('old\n').toUpperCase();
    assert.notEqual(baselineSha256, baselineSha256.toLowerCase());
    for (const action of ['MODIFY', 'DELETE'] as const) {
      const path = `${action.toLowerCase()}.txt`;
      await writeFile(join(root, path), 'old\n');
      const result = await executeFileChangeset(root, [{ path, action, baselineSha256,
        ...(action === 'MODIFY' ? { content: 'new\n' } : {}) }]);
      assert.equal(result.changes[0]?.status, 'APPLIED');
      if (action === 'MODIFY') assert.equal(await readFile(join(root, path), 'utf8'), 'new\n');
      else await assert.rejects(readFile(join(root, path)), (error: unknown) =>
        (error as NodeJS.ErrnoException).code === 'ENOENT');
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('DELETE reconciliation distinguishes an absent path from a dangling symlink', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'relay-file-reconcile-'));
  try {
    const absent = await reconcileFileChangeset(root, [{ path: 'absent.txt', action: 'DELETE' }]);
    assert.equal(absent.outcome, 'SUCCEEDED');
    try {
      await symlink('missing-target.txt', join(root, 'link.txt'), 'file');
    } catch (error) {
      if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        try {
          await symlink(join(root, 'missing-target-directory'), join(root, 'link.txt'), 'junction');
        } catch (junctionError) {
          if (!['EPERM', 'EACCES'].includes((junctionError as NodeJS.ErrnoException).code ?? '')) throw junctionError;
          t.skip('file symlinks and junctions are unavailable on this Windows host');
          return;
        }
      } else {
        throw error;
      }
    }
    const linked = await reconcileFileChangeset(root, [{ path: 'link.txt', action: 'DELETE' }]);
    assert.equal(linked.outcome, 'FAILED');
    assert.equal(linked.checks[0]?.matches, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a replaced frozen root cannot redirect execution or reconciliation', async () => {
  const base = await mkdtemp(join(tmpdir(), 'relay-root-anchor-'));
  const root = join(base, 'root');
  const outside = join(base, 'outside');
  try {
    await mkdir(root);
    await mkdir(outside);
    const frozenRoot = await realpath(root);
    await rename(root, join(base, 'old-root'));
    await symlink(outside, root, 'junction');
    const change = { path: 'payload.txt', action: 'CREATE' as const, content: 'expected\n' };
    const executed = await executeFileChangeset(frozenRoot, [change]);
    assert.equal(executed.outcome, 'FAILED');
    await assert.rejects(readFile(join(outside, 'payload.txt')), (error: unknown) =>
      (error as NodeJS.ErrnoException).code === 'ENOENT');
    await writeFile(join(outside, 'payload.txt'), 'expected\n');
    const reconciled = await reconcileFileChangeset(frozenRoot, [change]);
    assert.equal(reconciled.outcome, 'FAILED');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('reconciliation cannot confirm matching content through a parent junction', async () => {
  const base = await mkdtemp(join(tmpdir(), 'relay-parent-anchor-'));
  const root = join(base, 'root');
  const outside = join(base, 'outside');
  try {
    await mkdir(root);
    await mkdir(outside);
    await writeFile(join(outside, 'payload.txt'), 'expected\n');
    await symlink(outside, join(root, 'nested'), 'junction');
    const change = { path: 'nested/payload.txt', action: 'CREATE' as const, content: 'expected\n' };
    const reconciled = await reconcileFileChangeset(root, [change]);
    assert.equal(reconciled.outcome, 'FAILED');
    assert.equal(reconciled.checks[0]?.matches, false);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('execution does not create directories through a parent junction outside the frozen root', async () => {
  const base = await mkdtemp(join(tmpdir(), 'relay-parent-write-'));
  const root = join(base, 'root');
  const outside = join(base, 'outside');
  try {
    await mkdir(root);
    await mkdir(outside);
    await symlink(outside, join(root, 'nested'), 'junction');
    const result = await executeFileChangeset(root,
      [{ path: 'nested/new/deep/payload.txt', action: 'CREATE', content: 'expected\n' }]);
    assert.equal(result.outcome, 'FAILED');
    await assert.rejects(readFile(join(outside, 'new', 'deep', 'payload.txt')),
      (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT');
    await assert.rejects(realpath(join(outside, 'new')),
      (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT',
      'even parent directory creation must stay inside the frozen root');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('an in-root junction cannot bypass protected .git in execution or reconciliation', async () => {
  const base = await mkdtemp(join(tmpdir(), 'relay-protected-link-'));
  const root = join(base, 'root');
  const protectedDir = join(root, '.git');
  try {
    await mkdir(protectedDir, { recursive: true });
    await symlink(protectedDir, join(root, 'alias'), 'junction');
    const change = { path: 'alias/config', action: 'CREATE' as const, content: 'expected\n' };
    const executed = await executeFileChangeset(root, [change]);
    const leaked = await readFile(join(protectedDir, 'config'), 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    await writeFile(join(protectedDir, 'config'), 'expected\n');
    const reconciled = await reconcileFileChangeset(root, [change]);
    assert.deepEqual({ execution: executed.outcome, leaked, reconciliation: reconciled.outcome },
      { execution: 'FAILED', leaked: null, reconciliation: 'FAILED' });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
