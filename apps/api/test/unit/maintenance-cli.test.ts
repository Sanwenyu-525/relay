import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { parseMaintenanceArguments } from '../../src/cli/maintenance.js';

test('maintenance CLI requires exact action, original UUID and explicit CAS', () => {
  const commandId = randomUUID();
  assert.deepEqual(parseMaintenanceArguments(['status']), { action: 'status' });
  assert.deepEqual(parseMaintenanceArguments(['begin-drain', '--command-id', commandId,
    '--expected-revision', '0']), { action: 'begin-drain', commandId, expectedRevision: '0' });
  assert.deepEqual(parseMaintenanceArguments(['resume-admission', '--expected-revision', '1',
    '--command-id', commandId]), { action: 'resume-admission', commandId, expectedRevision: '1' });
  for (const argv of [[], ['status', '--command-id', commandId], ['freeze'],
    ['begin-drain'], ['begin-drain', '--command-id', commandId],
    ['begin-drain', '--command-id', commandId, '--expected-revision', '-1'],
    ['begin-drain', '--command-id', commandId, '--expected-revision', '0', '--bypass', 'true'],
    ['begin-drain', '--command-id', commandId, '--command-id', commandId,
      '--expected-revision', '0']]) assert.throws(() => parseMaintenanceArguments(argv));
});

test('desktop stop CLI requires explicit package/data roots and has no freeze or bypass flag', () => {
  const packageRoot = join(tmpdir(), 'relay-package');
  const dataRoot = join(tmpdir(), 'relay-data');
  assert.deepEqual(parseMaintenanceArguments(['hold-desktop-stop', '--package-root', packageRoot,
    '--data-root', dataRoot]), { action: 'hold-desktop-stop', packageRoot, dataRoot });
  for (const argv of [
    ['hold-desktop-stop'], ['hold-desktop-stop', '--package-root', packageRoot],
    ['hold-desktop-stop', '--package-root', 'relative', '--data-root', dataRoot],
    ['hold-desktop-stop', '--package-root', packageRoot, '--data-root', dataRoot, '--freeze', 'true'],
    ['hold-desktop-stop', '--package-root', packageRoot, '--package-root', packageRoot, '--data-root', dataRoot],
  ]) assert.throws(() => parseMaintenanceArguments(argv));
});
