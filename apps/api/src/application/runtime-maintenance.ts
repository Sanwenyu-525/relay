import type { DbExecutor } from '../infrastructure/database.js';
import { computePayloadHash } from '../receipt/payload-hash.js';
import { resolveExistingReceipt, type CommandOutcome } from './command.js';
import { invalidTransition, revisionConflict } from './domain-error.js';
import { readAdmission } from './maintenance-admission.js';
import { requireRevision } from './revisions.js';
import { createRepositories, withTransaction } from './unit-of-work.js';

// Separate from Workspace/user scopes: the target is the whole business database.
const SCOPE_KEY = 'runtime:database-admission';
export const ADMISSION_TARGET = 'DATABASE';
export type AdmissionStatus = { readonly target: 'DATABASE';
  readonly mode: 'NORMAL' | 'DRAINING'; readonly revision: string };

export async function readAdmissionStatus(db: DbExecutor): Promise<AdmissionStatus> {
  const gate = await readAdmission(createRepositories(db));
  return { target: ADMISSION_TARGET, mode: gate.mode, revision: gate.revision.toString() };
}

/** Trusted CLI only. UPDATE precedes receipt lookup and all other mutable locks. */
export async function changeAdmission(db: DbExecutor, input: {
  readonly commandId: string; readonly action: 'begin-drain' | 'resume-admission';
  readonly expectedRevision: string;
}): Promise<CommandOutcome<AdmissionStatus>> {
  const expected = requireRevision(input.expectedRevision, 'expected_revision');
  const commandType = input.action === 'begin-drain' ? 'BeginMaintenanceDrain' : 'ResumeAdmission';
  const mode = input.action === 'begin-drain' ? 'DRAINING' : 'NORMAL';
  const payloadHash = computePayloadHash({ commandType, target: ADMISSION_TARGET,
    body: { expected_revision: expected.toString() } });
  return withTransaction(db, async (r) => {
    const gate = await readAdmission(r, 'update');
    const receipt = await r.receipts.findReceipt({ scopeKey: SCOPE_KEY, commandId: input.commandId });
    if (receipt !== undefined) return resolveExistingReceipt<AdmissionStatus>(receipt, payloadHash);
    if (gate.revision !== expected) throw revisionConflict({ entityType: 'RUNTIME_ADMISSION',
      expectedRevision: expected.toString(), actualRevision: gate.revision.toString() });
    if (gate.mode === mode) throw invalidTransition('维护准入状态已处于请求的状态。');
    const next = await r.admission.compareAndSet(expected, mode);
    if (next === undefined) throw new Error('runtime admission CAS failed');
    const result: AdmissionStatus = { target: ADMISSION_TARGET, mode: next.mode,
      revision: next.revision.toString() };
    const saved = await r.receipts.insertReceipt({ scopeKey: SCOPE_KEY,
      commandId: input.commandId, commandType, payloadHash, result });
    return { result, replayed: false, committedAt: saved.created_at };
  });
}
