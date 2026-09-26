import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import {
  isProtectedPath,
  validateSafeRelativePath,
  computeSha256,
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
