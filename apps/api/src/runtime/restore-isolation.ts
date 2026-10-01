import { lstat, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export const RESTORE_ISOLATION_MARKER = 'restore-isolation.json';

export class RestoreIsolationError extends Error {
  override readonly name = 'RestoreIsolationError';
  constructor(readonly code: 'RESTORE_ISOLATED' | 'RESTORE_ISOLATION_UNAVAILABLE') { super(code); }
}

/** Ordinary startup may proceed only when the isolation directory entry is absent.
 * The marker's contents cannot grant execution permission, even after a successful restore.
 */
export async function assertRestoreNotIsolated(dataRoot: string): Promise<void> {
  if (!isAbsolute(dataRoot)) throw new RestoreIsolationError('RESTORE_ISOLATION_UNAVAILABLE');
  try {
    await lstat(join(dataRoot, RESTORE_ISOLATION_MARKER));
  } catch (error) {
    if (!missing(error)) throw new RestoreIsolationError('RESTORE_ISOLATION_UNAVAILABLE');
    // Windows can report ENOENT for a lookup below a file. Confirm the nearest
    // existing ancestor is a directory; a missing root still permits first setup.
    let ancestor = resolve(dataRoot);
    for (;;) {
      try {
        if (!(await stat(ancestor)).isDirectory()) throw new RestoreIsolationError('RESTORE_ISOLATION_UNAVAILABLE');
        return;
      } catch (error) {
        if (!missing(error)) throw new RestoreIsolationError('RESTORE_ISOLATION_UNAVAILABLE');
      }
      const parent = dirname(ancestor);
      if (parent === ancestor) throw new RestoreIsolationError('RESTORE_ISOLATION_UNAVAILABLE');
      ancestor = parent;
    }
  }
  throw new RestoreIsolationError('RESTORE_ISOLATED');
}

function missing(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
}
