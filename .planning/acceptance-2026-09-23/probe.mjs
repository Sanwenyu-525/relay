// Temporary probes reuse the compiled integration fixtures; production and test sources stay unchanged.
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = process.cwd();
const verification = resolve(root, 'apps/api/dist/test/integration/verification.integration.test.js');
const steps = resolve(root, 'apps/api/dist/test/integration/run-steps.integration.test.js');
const originals = new Map([verification, steps].map(path => [path, readFileSync(path, 'utf8')]));
try {
  const original = originals.get(verification);
  if (!original.includes('async function setupDelegatedRun(criteria)') || !original.includes('requiredOutputSpec: {},')) {
    throw new Error('Fixture layout changed; inspect before running this historical probe.');
  }
  writeFileSync(verification, original
    .replace('async function setupDelegatedRun(criteria)', 'async function setupDelegatedRun(criteria, requiredOutputSpec = {})')
    .replace('requiredOutputSpec: {},', 'requiredOutputSpec,') + `
test('ACCEPTANCE-P06-OUTPUT: missing declared output must not complete', async () => {
  const fixture = await setupDelegatedRun([
    { criterionId: 'structure', statement: 'Required Markdown structure', required: true, method: 'MARKDOWN_STRUCTURE' },
  ], { artifacts: ['MARKDOWN_DOCUMENT', 'TEST_REPORT'] });
  await advanceToVerifying(fixture);
  await advance(fixture);
  const result = await advance(fixture);
  const task = await readTask(fixture.taskId);
  const kinds = await sql\`select a.artifact_kind from artifacts a where a.task_id = \${fixture.taskId}\`.execute(app.db);
  console.log('ACCEPTANCE-P06-OUTPUT', JSON.stringify({ result, taskStatus: task.status, kinds: kinds.rows }));
  assert.notEqual(task.status, 'DONE', 'missing TEST_REPORT must block automatic completion');
});
`);
  writeFileSync(steps, originals.get(steps) + `
test('ACCEPTANCE-P05-STALE: stale result must preserve the current valid claim', async () => {
  const fixture = await setupDelegatedRun();
  const draftId = await stepId(fixture.runId, 'DRAFT');
  const current = await withTransaction(app.db, async repositories => {
    const inserted = await repositories.runs.insertStepAttempt({ id: randomUUID(), stepId: draftId, attemptNumber: 1n, attemptKey: 'acceptance-current-claim' });
    return repositories.runs.claimAttempt({ attemptId: inserted.row.id, workerId: 'current-worker', leaseUntil: new Date(Date.now() + 30000) });
  });
  assert.ok(current);
  const stale = await recordStaleAttemptResult(app.db, { attemptId: current.id, expectedClaimEpoch: 0n, resultRef: { content: 'stale' }, evidence: { reason: 'STALE_CLAIM_EPOCH' } });
  assert.equal(stale.accepted, false);
  const valid = await recordStaleAttemptResult(app.db, { attemptId: current.id, expectedClaimEpoch: current.claim_epoch, resultRef: { content: 'current' }, evidence: { reason: 'CURRENT_RESULT' } });
  console.log('ACCEPTANCE-P05-STALE', JSON.stringify({ afterStale: stale.attempt?.status, currentAccepted: valid.accepted }));
  assert.equal(valid.accepted, true, 'stale delivery must not poison the newer valid attempt');
});
`);
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'apps/api/scripts/run-integration.ps1', '-SkipBuild'], { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  writeFileSync(resolve(root, '.planning/acceptance-2026-09-23/probe.log'), output);
  console.log(output.split(/\r?\n/u).filter(line => /ACCEPTANCE|tests |pass |fail |status:|exit code:|removed:|AssertionError|actual:|expected:/u.test(line)).join('\n'));
  process.exitCode = result.status ?? 1;
} finally {
  for (const [path, original] of originals) writeFileSync(path, original);
  console.log('Compiled fixtures restored; source files unchanged.');
}
