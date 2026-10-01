import assert from 'node:assert/strict';

import { claimNextRunCommand, settleRunCommand } from '../../src/application/run-dispatch.js';
import { advanceRunStep } from '../../src/application/run-steps.js';
import { ManagedContentStore } from '../../src/storage/managed-content-store.js';
import { openDatabase } from './integration-support.js';

const databaseUrl = process.env.RELAY_G06_DATABASE_URL;
const dataRoot = process.env.RELAY_G06_DATA_ROOT;
const runId = process.env.RELAY_G06_RUN_ID;
const workerId = process.env.RELAY_G06_WORKER_ID;
assert.ok(databaseUrl && dataRoot && runId && workerId && process.send);

const database = openDatabase(databaseUrl, 'relay-g06-complete-barrier');
try {
  const claim = await claimNextRunCommand(database.db, workerId);
  assert.ok(claim);
  assert.equal(claim.runId, runId);
  assert.equal(claim.kind, 'RESUME');
  const step = await advanceRunStep(database.db, {
    runId, workerId, invocationEpoch: claim.epoch,
    storage: new ManagedContentStore(dataRoot),
    hooks: { beforeCommit: async () => {
      const released = new Promise<void>((done, fail) => {
        process.once('message', (message) => {
          if (message !== 'release') fail(new Error('invalid G06 barrier release'));
          else done();
        });
      });
      process.send!({ type: 'complete_before_commit', command_id: claim.commandId,
        epoch: claim.epoch.toString() });
      await released;
    } },
  });
  assert.equal(step.status, 'CONTROL_PENDING');
  assert.equal(await settleRunCommand(database.db, claim, 'DONE'), true);
  process.stdout.write(`${JSON.stringify({ step_status: step.status, outcome: 'DONE' })}\n`);
} finally {
  await database.close();
  process.disconnect();
}
