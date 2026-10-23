import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { parseManagedStagingAuditArguments } from '../../src/cli/managed-staging-audit.js';
import { CliConfigError } from '../../src/cli/cli-support.js';

/** 孤儿暂存核对 CLI 的参数解析：只接受绝对 --data-root，与同目录其他运维 CLI 一致。 */

test('accepts an absolute data root', () => {
  assert.deepEqual(
    parseManagedStagingAuditArguments(['audit-managed-staging', '--data-root', tmpdir()]),
    { dataRoot: tmpdir() },
  );
});

test('rejects relative roots, wrong command names and malformed arguments', () => {
  for (const argv of [
    [],
    ['audit-managed-staging'],
    ['audit-managed-staging', '--data-root'],
    ['audit-managed-staging', '--data-root', 'relative/data-root'],
    ['audit-managed-staging', '--data-root', tmpdir(), '--extra'],
    ['audit-managed-staging', '--data-root', tmpdir(), tmpdir()],
    ['audit-managed-staging', '--other-flag', tmpdir()],
    ['wrong-command', '--data-root', tmpdir()],
  ]) {
    assert.throws(
      () => parseManagedStagingAuditArguments(argv),
      (error: unknown) => error instanceof CliConfigError,
      `expected ${JSON.stringify(argv)} to be rejected`,
    );
  }
});
