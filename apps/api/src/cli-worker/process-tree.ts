import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Checks if a process with the given PID is currently active.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    // Sending signal 0 tests for process existence without killing it
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error.code === 'EPERM'; // EPERM means process exists but we lack kill permission
  }
}

/**
 * Forcefully terminates a process and its entire descendant tree.
 * On Windows, leverages `taskkill /pid <pid> /T /F`.
 */
export async function killProcessTree(pid: number): Promise<boolean> {
  if (!isProcessAlive(pid)) {
    return true;
  }

  if (process.platform === 'win32') {
    try {
      await execFileAsync('taskkill', ['/pid', String(pid), '/T', '/F']);
      return true;
    } catch {
      // If taskkill fails, verify whether process exited anyway
      return !isProcessAlive(pid);
    }
  }

  // POSIX fallback
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  return !isProcessAlive(pid);
}
