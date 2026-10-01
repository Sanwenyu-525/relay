import { createHash } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { lstat, open, type FileHandle } from 'node:fs/promises';
import { basename, dirname } from 'node:path';

import type { BackupDatabaseState } from './backup-state.js';
import { inspectRestoreRootIdentity, readRestoreMetadata, restoreRoot, RestoreFilesError } from './restore-files.js';
import { CONTENT_IDENTITY } from '../storage/windows-content-publisher.js';

const CODES = ['RESTORE_RESOURCE_ROOTS_INVALID', 'RESTORE_RESOURCE_ROOTS_LIMIT', 'RESTORE_RESOURCE_ROOTS_ABORTED',
  'RESTORE_RESOURCE_ROOTS_UNAVAILABLE', 'RESTORE_RESOURCE_ROOTS_HELPER_CHANGED', 'RESTORE_RESOURCE_ROOTS_PROTOCOL',
  'RESTORE_RESOURCE_ROOTS_TIMEOUT', 'RESTORE_RESOURCE_ROOTS_HOLD_LOST'] as const;
type Code = typeof CODES[number];
export class RestoreResourceRootsError extends Error {
  override readonly name = 'RestoreResourceRootsError';
  readonly code: Code;
  constructor(code: Code = 'RESTORE_RESOURCE_ROOTS_UNAVAILABLE') {
    const safe = CODES.includes(code) ? code : 'RESTORE_RESOURCE_ROOTS_UNAVAILABLE';
    super(safe); this.code = safe;
  }
}
type Result = 'MATCH' | 'NO_STORED_ID' | 'ID_MISMATCH' | 'UNAVAILABLE';
export interface RestoreResourceRootsReport {
  readonly version: 'relay-restore-resource-roots-v1';
  readonly scope: 'REGISTERED_MANAGED_ROOT_IDENTITIES_ONLY';
  readonly selected_state_sha256: string;
  readonly helper_sha256: string;
  readonly root_count: number;
  readonly results: readonly {
    readonly id: string; readonly workspace_id: string; readonly project_id: string;
    readonly status: 'ACTIVE' | 'DISABLED'; readonly revision: string; readonly resource_epoch: string;
    readonly stored_root_id: string | null; readonly observed_root_id: string | null; readonly result: Result;
  }[];
}
const HASH = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const ROW_KEYS = ['canonical_root', 'file_write_root_id', 'id', 'identity_key', 'project_id',
  'resource_epoch', 'revision', 'status', 'workspace_id'];
const fail = (code: Code): never => { throw new RestoreResourceRootsError(code); };
function counter(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 19 && /^(0|[1-9][0-9]*)$/u.test(value) && BigInt(value) <= 9223372036854775807n;
}
function rows(input: BackupDatabaseState['external_resources']) {
  if (!Array.isArray(input)) fail('RESTORE_RESOURCE_ROOTS_INVALID');
  if (input.length > 128) fail('RESTORE_RESOURCE_ROOTS_LIMIT');
  const ids = new Set<string>(); let bytes = 0;
  return input.map(row => {
    if (row === null || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).sort().join(',') !== ROW_KEYS.join(',')) {
      throw new RestoreResourceRootsError('RESTORE_RESOURCE_ROOTS_INVALID');
    }
    const { id, workspace_id, project_id, canonical_root, identity_key, file_write_root_id, status, revision, resource_epoch } = row;
    if (typeof id !== 'string' || !UUID.test(id) || typeof workspace_id !== 'string' || !UUID.test(workspace_id) ||
        typeof project_id !== 'string' || !UUID.test(project_id) || typeof canonical_root !== 'string' || canonical_root.length === 0 ||
        Buffer.byteLength(canonical_root) > 4096 || canonical_root.includes('\0') || typeof identity_key !== 'string' ||
        identity_key.length === 0 || Buffer.byteLength(identity_key) > 4096 || identity_key.includes('\0') ||
        (file_write_root_id !== null && (typeof file_write_root_id !== 'string' || !CONTENT_IDENTITY.test(file_write_root_id))) ||
        (status !== 'ACTIVE' && status !== 'DISABLED') || !counter(revision) || !counter(resource_epoch) || ids.has(id)) {
      throw new RestoreResourceRootsError('RESTORE_RESOURCE_ROOTS_INVALID');
    }
    ids.add(id); bytes += Buffer.byteLength(JSON.stringify(row));
    if (bytes > 1024 * 1024) fail('RESTORE_RESOURCE_ROOTS_LIMIT');
    return { id, workspace_id, project_id, canonical_root, file_write_root_id, status, revision, resource_epoch } as const;
  });
}
function unchanged(a: BigIntStats, b: BigIntStats): boolean {
  return b.isFile() && !b.isSymbolicLink() && b.nlink === 1n && a.dev === b.dev && a.ino === b.ino &&
    a.mode === b.mode && a.size === b.size && a.birthtimeNs === b.birthtimeNs && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

/** Identity observations of the selected managed rows; neither external content verification nor activation. */
export async function probeRestoreResourceRoots(input: {
  externalResources: BackupDatabaseState['external_resources']; selectedStateSha256: string;
  helperExecutable: string; helperSha256: string; signal: AbortSignal; assertHeld: () => Promise<void>;
}): Promise<RestoreResourceRootsReport> {
  const { signal, selectedStateSha256, helperSha256, assertHeld } = input;
  const deadline = Date.now() + 30_000;
  let pin: FileHandle | undefined;
  try {
    if (signal.aborted) fail('RESTORE_RESOURCE_ROOTS_ABORTED');
    if (process.platform !== 'win32' || !HASH.test(selectedStateSha256) || !HASH.test(helperSha256)) fail('RESTORE_RESOURCE_ROOTS_INVALID');
    const resources = rows(input.externalResources), helper = restoreRoot(input.helperExecutable);
    if (Buffer.byteLength(helper) > 4096) fail('RESTORE_RESOURCE_ROOTS_INVALID');
    const budget = () => {
      if (signal.aborted) fail('RESTORE_RESOURCE_ROOTS_ABORTED');
      if (Date.now() >= deadline) fail('RESTORE_RESOURCE_ROOTS_TIMEOUT');
    };
    const held = async () => {
      budget();
      try { await assertHeld(); } catch { fail('RESTORE_RESOURCE_ROOTS_HOLD_LOST'); }
      budget();
    };
    await held();
    const before = await lstat(helper, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > 24n * 1024n * 1024n) {
      fail('RESTORE_RESOURCE_ROOTS_UNAVAILABLE');
    }
    pin = await open(helper, 'r');
    const identity = async () => {
      if (!unchanged(before, await pin!.stat({ bigint: true })) || !unchanged(before, await lstat(helper, { bigint: true }))) {
        fail('RESTORE_RESOURCE_ROOTS_HELPER_CHANGED');
      }
      budget();
    };
    const bound = async () => {
      await identity();
      const bytes = await readRestoreMetadata(dirname(helper), basename(helper), signal);
      if (createHash('sha256').update(bytes).digest('hex') !== helperSha256) fail('RESTORE_RESOURCE_ROOTS_HELPER_CHANGED');
      await identity();
    };
    await bound();
    const results: RestoreResourceRootsReport['results'][number][] = [];
    for (const resource of resources) {
      await held(); await identity();
      const observed = resource.file_write_root_id === null ? null : await inspectRestoreRootIdentity({
        rootPath: resource.canonical_root, helperExecutable: helper, signal, deadline });
      await identity(); await held();
      const result: Result = resource.file_write_root_id === null ? 'NO_STORED_ID' : observed === null ? 'UNAVAILABLE' :
        observed === resource.file_write_root_id ? 'MATCH' : 'ID_MISMATCH';
      results.push({ id: resource.id, workspace_id: resource.workspace_id, project_id: resource.project_id,
        status: resource.status, revision: resource.revision, resource_epoch: resource.resource_epoch,
        stored_root_id: resource.file_write_root_id, observed_root_id: observed, result });
    }
    await bound(); await held();
    return { version: 'relay-restore-resource-roots-v1', scope: 'REGISTERED_MANAGED_ROOT_IDENTITIES_ONLY',
      selected_state_sha256: selectedStateSha256, helper_sha256: helperSha256, root_count: results.length, results };
  } catch (cause) {
    if (signal.aborted) fail('RESTORE_RESOURCE_ROOTS_ABORTED');
    if (cause instanceof RestoreResourceRootsError) throw cause;
    if (cause instanceof RestoreFilesError) {
      const code: Code = cause.code === 'RESTORE_ROOT_INSPECT_TIMEOUT' ? 'RESTORE_RESOURCE_ROOTS_TIMEOUT' :
        cause.code === 'RESTORE_ROOT_INSPECT_OUTPUT_LIMIT' ? 'RESTORE_RESOURCE_ROOTS_LIMIT' :
        cause.code === 'RESTORE_ROOT_INSPECT_PROTOCOL' ? 'RESTORE_RESOURCE_ROOTS_PROTOCOL' : 'RESTORE_RESOURCE_ROOTS_UNAVAILABLE';
      fail(code);
    }
    throw new RestoreResourceRootsError('RESTORE_RESOURCE_ROOTS_UNAVAILABLE');
  } finally {
    if (pin !== undefined) {
      try { await pin.close(); } catch { fail('RESTORE_RESOURCE_ROOTS_UNAVAILABLE'); }
    }
  }
}
