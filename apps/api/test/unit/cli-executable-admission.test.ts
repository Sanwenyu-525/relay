import test from 'node:test';
import assert from 'node:assert/strict';
import { join, sep } from 'node:path';

import { EXECUTABLE_ADMISSION_REASON, evaluateExecutableAdmission, isWithinRoot } from
  '../../src/application/cli-executable-admission.js';

/**
 * 准入判定是纯函数：调用方取事实，这里只判定。
 *
 * 这些用例锁的是「模型只提出入口、准入由受管根与连接 config 决定」这条边界。
 * 根身份不在这里判定：`evaluateScopeGrant` 先于任何清单比对核对它。
 */

const ROOT = join(sep, 'srv', 'project');
const REFUSED = (reason: string) => ({ covered: false, reason });
const ADMITTED = { covered: true };

test('a check entry inside the managed root is admitted without any configured allowlist', () => {
  assert.deepEqual(evaluateExecutableAdmission({ canonicalRoot: ROOT,
    frozenExecutable: join(ROOT, 'check.ps1'),
    allowedExecutables: undefined }), ADMITTED);
});

test('an entry outside the managed root is refused when no allowlist is configured', () => {
  assert.deepEqual(evaluateExecutableAdmission({ canonicalRoot: ROOT,
    frozenExecutable: join(sep, 'Windows', 'System32', 'cmd.exe'),
    allowedExecutables: undefined }),
  REFUSED(EXECUTABLE_ADMISSION_REASON.NOT_ALLOWED));
});

test('an entry outside the managed root is admitted once the connection config lists it', () => {
  const outside = join(sep, 'tools', 'node.exe');
  assert.deepEqual(evaluateExecutableAdmission({ canonicalRoot: ROOT, frozenExecutable: outside,
    allowedExecutables: [outside] }), ADMITTED);
});

test('a configured allowlist does not admit an entry it does not name', () => {
  assert.deepEqual(evaluateExecutableAdmission({ canonicalRoot: ROOT,
    frozenExecutable: join(sep, 'tools', 'node.exe'),
    allowedExecutables: [join(sep, 'tools', 'other.exe'), join(ROOT, 'check.ps1')] }),
  REFUSED(EXECUTABLE_ADMISSION_REASON.NOT_ALLOWED));
});

test('an allowlist match follows the casing Windows resolves paths with', () => {
  const decision = evaluateExecutableAdmission({ canonicalRoot: ROOT,
    frozenExecutable: join(sep, 'tools', 'node.exe'),
    allowedExecutables: [join(sep, 'TOOLS', 'NODE.EXE')] });
  // Windows 上两者是同一个文件，必须放行；其他平台上它们是两个不同路径，不许混淆。
  if (process.platform === 'win32') {
    assert.deepEqual(decision, ADMITTED);
  } else {
    assert.deepEqual(decision, REFUSED(EXECUTABLE_ADMISSION_REASON.NOT_ALLOWED));
  }
});

test('an empty allowlist admits nothing beyond the managed root', () => {
  assert.deepEqual(evaluateExecutableAdmission({ canonicalRoot: ROOT,
    frozenExecutable: join(sep, 'tools', 'node.exe'), allowedExecutables: [] }),
  REFUSED(EXECUTABLE_ADMISSION_REASON.NOT_ALLOWED));
});

test('a trailing separator on the root does not turn a sibling into an admitted entry', () => {
  assert.deepEqual(evaluateExecutableAdmission({ canonicalRoot: ROOT + sep,
    frozenExecutable: join(sep, 'srv', 'project-sibling', 'check.ps1'),
    allowedExecutables: undefined }),
  REFUSED(EXECUTABLE_ADMISSION_REASON.NOT_ALLOWED));
});

test('isWithinRoot accepts a descendant and rejects the root itself and its siblings', () => {
  assert.equal(isWithinRoot(ROOT, join(ROOT, 'a', 'b')), true);
  assert.equal(isWithinRoot(ROOT, ROOT), false);
  assert.equal(isWithinRoot(ROOT, join(sep, 'srv', 'project-sibling', 'check.ps1')), false);
  assert.equal(isWithinRoot(ROOT, join(ROOT, '..', 'escaped.ps1')), false);
});
