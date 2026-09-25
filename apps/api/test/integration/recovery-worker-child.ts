import { advanceRunStep } from '../../src/application/run-steps.js';
import { recoverStoppedWorker, scanRecoveryCandidates } from '../../src/application/recover-run.js';
import { ManagedContentStore } from '../../src/storage/managed-content-store.js';
import { APP_DATABASE_URL, openDatabase } from './integration-support.js';

const mode = process.env.RELAY_P08_CHILD_MODE;
const runId = process.env.RELAY_P08_RUN_ID;
const workerId = process.env.RELAY_P08_WORKER_ID;
const dataRoot = process.env.RELAY_P08_DATA_ROOT;
if (!mode || !runId || !workerId || !dataRoot) throw new Error('missing P08 child test input');

const database = openDatabase(APP_DATABASE_URL, `relay-p08-worker-${mode}`);
const storage = new ManagedContentStore(dataRoot);
try {
  if (mode === 'crash-after-dispatch') {
    await advanceRunStep(database.db, { runId, workerId, storage,
      hooks: { afterEffectDispatch: async () => { process.exit(92); } } });
    throw new Error('crash fault point was not reached');
  }
  if (mode === 'recover') {
    const candidate = (await scanRecoveryCandidates(database.db)).some((row) => row.run_id === runId);
    const recovered = await recoverStoppedWorker(database.db, { runId,
      stoppedWorkerId: workerId, stoppedEvidence: 'test: prior child process exit observed', storage });
    const result = await advanceRunStep(database.db, { runId, workerId: `${workerId}-next`, storage });
    process.stdout.write(JSON.stringify({ candidate, fenced: recovered.fenced, status: result.status }));
  } else {
    throw new Error('invalid P08 child mode');
  }
} finally {
  await database.close();
}
