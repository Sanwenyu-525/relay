import type { Repositories } from './unit-of-work.js';

const TERMINAL_RUN_STATUSES = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);

/** Foreground browser capture shares the physical desktop, without gaining COMPUTER_INPUT permission. */
export function usesDesktopInputLease(capabilityKey: string, actionType: string): boolean {
  return capabilityKey === 'COMPUTER_INPUT' || actionType === 'BROWSER_CAPTURE_FOREGROUND';
}

/** Release the desktop only after a stopped/terminal Run has no worker or unresolved effect. */
export async function releaseComputerDesktopLeaseAtSafeBoundary(
  repositories: Repositories, runId: string, allowPaused = false,
): Promise<boolean> {
  const run = await repositories.runs.readRun(runId);
  if (run === undefined || run.worker_id !== null ||
      (!TERMINAL_RUN_STATUSES.has(run.status) && !(allowPaused && run.status === 'PAUSED')) ||
      (await repositories.gateway.listUnresolvedRunOperations(run.id)).length > 0 ||
      (await repositories.recovery.listUnresolvedEffects(run.id)).length > 0) return false;
  await repositories.computerDesktopLease.releaseRun(run.id);
  await repositories.computerControl.markStopped(run.id);
  return true;
}
