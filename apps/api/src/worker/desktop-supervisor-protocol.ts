export interface DesktopDispatchReady {
  readonly nonce: string;
  readonly launchId: string;
  readonly requeuedRunIds: readonly string[];
  readonly blockedRunIds: readonly string[];
}

export interface DesktopLaunchRecoveryAck {
  readonly nonce: string;
  readonly launchId: string;
  readonly retainedClaims: bigint;
}

const RUST_SUPERVISOR_LINE_LIMIT_BYTES = 64 * 1024;
const MAX_SAMPLE_IDS_PER_OUTCOME = 512;

export function desktopLaunchRecoveryAckLine(input: DesktopLaunchRecoveryAck): string {
  if (typeof input.retainedClaims !== 'bigint' || input.retainedClaims < 0n ||
      input.retainedClaims > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('desktop launch retained claim count is not a safe JSON integer');
  }
  const line = `${JSON.stringify({ type: 'launch_recovery_ack',
    nonce: input.nonce, launchId: input.launchId,
    retainedClaims: Number(input.retainedClaims) })}\n`;
  if (Buffer.byteLength(line, 'utf8') >= RUST_SUPERVISOR_LINE_LIMIT_BYTES) {
    throw new Error('desktop launch recovery acknowledgement exceeds the private output line limit');
  }
  return line;
}

export function desktopDispatchReadyLine(input: DesktopDispatchReady): string {
  const requeuedRunIds = input.requeuedRunIds.slice(0, MAX_SAMPLE_IDS_PER_OUTCOME);
  const blockedRunIds = input.blockedRunIds.slice(0, MAX_SAMPLE_IDS_PER_OUTCOME);
  while (true) {
    const line = `${JSON.stringify({ type: 'dispatch_ready',
      nonce: input.nonce, launchId: input.launchId,
      requeuedRunIds, blockedRunIds,
      requeuedRunCount: input.requeuedRunIds.length,
      blockedRunCount: input.blockedRunIds.length,
      runIdsTruncated: requeuedRunIds.length < input.requeuedRunIds.length ||
        blockedRunIds.length < input.blockedRunIds.length })}\n`;
    if (Buffer.byteLength(line, 'utf8') < RUST_SUPERVISOR_LINE_LIMIT_BYTES) return line;
    if (requeuedRunIds.length === 0 && blockedRunIds.length === 0) {
      throw new Error('desktop dispatch readiness exceeds the private output line limit');
    }
    if (requeuedRunIds.length >= blockedRunIds.length && requeuedRunIds.length > 0) {
      requeuedRunIds.pop();
    } else {
      blockedRunIds.pop();
    }
  }
}
