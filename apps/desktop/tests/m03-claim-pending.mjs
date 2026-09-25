// Measurement fixture: assign additional pending commands to the same old desktop launch.
// It runs only against the disposable acceptance database and does not assert OS stop evidence.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(process.argv[2] ?? '');
const launchId = process.argv[3] ?? '';
const expectedIds = (process.argv[4] ?? '').split(',').filter(Boolean);
if (!/^relay-m02-acceptance-[0-9a-f]{32}$/iu.test(root.split(/[\\/]/u).at(-1) ?? '') ||
    !/^[0-9a-f]{8}-[0-9a-f-]{27}$/iu.test(launchId) ||
    expectedIds.length < 1 || expectedIds.length > 63 ||
    expectedIds.some((id) => !/^[0-9a-f]{8}-[0-9a-f-]{27}$/iu.test(id))) {
  throw new Error('Usage: node m03-claim-pending.mjs <session-root> <launch-id> <run-ids-csv>');
}
const session = JSON.parse(readFileSync(join(root, 'session.json'), 'utf8').replace(/^\uFEFF/u, ''));
assert.equal(resolve(session.data_root), join(root, 'data'));
const releaseRoot = resolve(session.release_exe, '..');
const databaseUrl = `postgresql://relay_app@127.0.0.1:${session.postgres_port}/relay_m02_acceptance`;
const load = (relative) => import(pathToFileURL(join(releaseRoot, 'api', 'dist', 'src', relative)).href);
const { RelayDatabase } = await load('infrastructure/database.js');
const { claimNextRunCommand } = await load('application/run-dispatch.js');
const database = new RelayDatabase({ databaseUrl, databasePoolMax: 4,
  databaseConnectTimeoutMs: 3000 }, (error) => { throw error; });
try {
  const expected = new Set(expectedIds);
  const claimed = [];
  for (const _ of expectedIds) {
    const workerId = `worker:desktop:${launchId}:${randomUUID()}`;
    const claim = await claimNextRunCommand(database.executor, workerId, 30_000);
    assert.ok(claim, 'pending Run was not claimable');
    assert.equal(expected.delete(claim.runId), true, 'claimed a Run outside the measurement set');
    claimed.push({ run_id: claim.runId, worker_id: workerId, epoch: claim.epoch.toString() });
  }
  assert.equal(expected.size, 0);
  console.log(JSON.stringify({ launch_id: launchId, claimed }));
} finally {
  await database.close();
}
