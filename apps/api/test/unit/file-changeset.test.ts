import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import {
  isProtectedPath,
  validateSafeRelativePath,
  computeSha256,
  isFrozenBaseline,
  requireFrozenBaseline,
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
