// Deterministic fault fixture after the old Job is proven stopped: tamper one published Mock effect.
// The production recovery path must keep the original operation UNKNOWN and never resend it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(process.argv[2] ?? '');
const runId = process.argv[3] ?? '';
const workerId = process.argv[4] ?? '';
const epoch = process.argv[5] ?? '';
if (!/^relay-m02-acceptance-[0-9a-f]{32}$/iu.test(root.split(/[\\/]/u).at(-1) ?? '') ||
    !/^[0-9a-f]{8}-[0-9a-f-]{27}$/iu.test(runId) ||
    !/^worker:desktop:[0-9a-f-]{36}:[0-9a-f-]{36}$/iu.test(workerId) ||
    !/^[1-9][0-9]*$/u.test(epoch)) {
  throw new Error('Usage: node m03-inject-unknown.mjs <session-root> <run-id> <worker-id> <epoch>');
}
const session = JSON.parse(readFileSync(join(root, 'session.json'), 'utf8').replace(/^\uFEFF/u, ''));
assert.equal(resolve(session.data_root), join(root, 'data'));
const releaseRoot = dirname(session.release_exe);
const requireApi = createRequire(join(releaseRoot, 'api', 'package.json'));
const { sql } = requireApi('kysely');
const load = (relative) => import(pathToFileURL(join(releaseRoot, 'api', 'dist', 'src', relative)).href);
const [{ RelayDatabase }, { advanceRunStep, SimulatedWorkerCrash },
  { ManagedContentStore, resolveStoredContentPath }] = await Promise.all([
  load('infrastructure/database.js'), load('application/run-steps.js'),
  load('storage/managed-content-store.js'),
]);
const databaseUrl = `postgresql://relay_app@127.0.0.1:${session.postgres_port}/relay_m02_acceptance`;
const database = new RelayDatabase({ databaseUrl, databasePoolMax: 4,
  databaseConnectTimeoutMs: 3000 }, (error) => { throw error; });
const storage = new ManagedContentStore(session.data_root);
const input = { runId, workerId, invocationEpoch: BigInt(epoch), leaseMs: 600_000, storage };
try {
  for (const kind of ['BUILD_CONTEXT', 'DRAFT']) {
    const result = await advanceRunStep(database.executor, input);
    assert.equal(result.status, 'STEP_SUCCEEDED', `${kind} did not advance`);
  }
  let operationId;
  await assert.rejects(advanceRunStep(database.executor, {
    ...input, hooks: { afterEffectDispatch: async () => {
      const effect = await sql`
        select operation_id, target_ref from run_effect_actions where run_id = ${runId}
      `.execute(database.executor);
      const draft = await sql`
        select result_ref from run_steps where run_id = ${runId} and step_kind = 'DRAFT'
      `.execute(database.executor);
      operationId = effect.rows[0]?.operation_id;
      assert.equal(typeof operationId, 'string');
      const content = draft.rows[0]?.result_ref?.content;
      assert.equal(typeof content, 'string');
      await storage.publish({ artifactId: runId, versionId: operationId,
        content: Buffer.from(content, 'utf8') });
      await writeFile(resolveStoredContentPath(session.data_root, effect.rows[0].target_ref),
        'tampered by the isolated M03 fault fixture');
      throw new SimulatedWorkerCrash('old launch stopped after ambiguous publish');
    } },
  }), SimulatedWorkerCrash);
  console.log(JSON.stringify({ run_id: runId, operation_id: operationId,
    injected_effect: 'DISPATCHING_WITH_TAMPERED_TARGET' }));
} finally {
  await database.close();
}
