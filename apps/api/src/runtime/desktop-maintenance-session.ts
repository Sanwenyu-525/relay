import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { TextDecoder } from 'node:util';

import type { DesktopStopEvidence } from '../worker/supervisor.js';

export const DESKTOP_MAINTENANCE_PROTOCOL = 'relay-desktop-maintenance-v1';
const MAX_FRAME_BYTES = 64 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ERROR_CODES = new Set(['MAINTENANCE_SESSION_BUSY', 'MAINTENANCE_SESSION_INVALID',
  'MAINTENANCE_SESSION_STOP_FAILED', 'MAINTENANCE_SESSION_IO_FAILED']);

export class DesktopMaintenanceSessionError extends Error {
  override readonly name = 'DesktopMaintenanceSessionError';
  constructor(readonly code: string = 'MAINTENANCE_SESSION_INVALID') { super(code); }
}

export interface StoppedDesktopLaunch {
  readonly launchId: string;
  readonly stopEvidence: DesktopStopEvidence;
}

type NativeEvent = { readonly type: 'maintenance_ready'; readonly version: 1;
  readonly nonce: string; readonly stoppedLaunches: readonly StoppedDesktopLaunch[] } |
  { readonly type: 'maintenance_released'; readonly version: 1; readonly nonce: string } |
  { readonly type: 'maintenance_error'; readonly version: 1; readonly nonce: string | null;
    readonly code: string };

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/** Native output is a private protocol, never a general stop-proof import API. */
export function parseDesktopMaintenanceEvent(bytes: Buffer, nonce: string): NativeEvent {
  const invalid = () => new DesktopMaintenanceSessionError();
  if (bytes.length > MAX_FRAME_BYTES || !UUID.test(nonce)) throw invalid();
  let event: unknown;
  try { event = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw invalid(); }
  if (!exactObject(event, ['type', 'version', 'nonce', 'stoppedLaunches']) &&
      !exactObject(event, ['type', 'version', 'nonce']) &&
      !exactObject(event, ['type', 'version', 'nonce', 'code'])) throw invalid();
  if (event.version !== 1) throw invalid();
  if (event.type === 'maintenance_error') {
    if ((event.nonce !== null && event.nonce !== nonce) ||
        typeof event.code !== 'string' || !ERROR_CODES.has(event.code) ||
        !exactObject(event, ['type', 'version', 'nonce', 'code'])) throw invalid();
    return { type: 'maintenance_error', version: 1, nonce: event.nonce, code: event.code };
  }
  if (event.nonce !== nonce) throw invalid();
  if (event.type === 'maintenance_released' && exactObject(event, ['type', 'version', 'nonce'])) {
    return { type: 'maintenance_released', version: 1, nonce };
  }
  if (event.type !== 'maintenance_ready' ||
      !exactObject(event, ['type', 'version', 'nonce', 'stoppedLaunches']) ||
      !Array.isArray(event.stoppedLaunches) || event.stoppedLaunches.length > 64) throw invalid();
  const stoppedLaunches: StoppedDesktopLaunch[] = [];
  const seen = new Set<string>();
  for (const stopped of event.stoppedLaunches) {
    if (!exactObject(stopped, ['launchId', 'stopEvidence']) ||
        typeof stopped.launchId !== 'string' || !UUID.test(stopped.launchId) ||
        seen.has(stopped.launchId) ||
        (stopped.stopEvidence !== 'armed_job_terminated_and_active_count_zero' &&
         stopped.stopEvidence !== 'armed_job_absent_after_last_handle_closed')) throw invalid();
    seen.add(stopped.launchId);
    stoppedLaunches.push({ launchId: stopped.launchId, stopEvidence: stopped.stopEvidence });
  }
  return { type: 'maintenance_ready', version: 1, nonce, stoppedLaunches };
}

/** Reject old packages before execution: an old EXE may ignore the new flag and open a window. */
export async function verifiedDesktopMaintenanceExecutable(packageRoot: string): Promise<string> {
  try {
    if (!isAbsolute(packageRoot)) throw new Error();
    const rootStat = await lstat(packageRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error();
    const root = await realpath(packageRoot);
    const manifestFile = join(root, 'desktop-build-manifest.json');
    const manifestStat = await lstat(manifestFile);
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > 8 * 1024 * 1024) {
      throw new Error();
    }
    const manifest = JSON.parse((await readFile(manifestFile, 'utf8')).replace(/^\uFEFF/u, '')) as {
      schema_version?: unknown; maintenance_session_protocol?: unknown; artifact_sha256?: unknown;
    };
    if (manifest.schema_version !== 1 || manifest.maintenance_session_protocol !== DESKTOP_MAINTENANCE_PROTOCOL ||
        typeof manifest.artifact_sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(manifest.artifact_sha256)) {
      throw new Error();
    }
    const executable = join(root, 'relay-desktop.exe');
    const executableStat = await lstat(executable);
    if (!executableStat.isFile() || executableStat.isSymbolicLink() ||
        executableStat.size > 256 * 1024 * 1024 || await realpath(executable) !== executable) throw new Error();
    const actualHash = createHash('sha256').update(await readFile(executable)).digest('hex');
    if (actualHash !== manifest.artifact_sha256) throw new Error();
    return executable;
  } catch { throw new DesktopMaintenanceSessionError('MAINTENANCE_PACKAGE_UNSUPPORTED'); }
}

export interface DesktopMaintenanceSession {
  readonly nonce: string;
  readonly stoppedLaunches: readonly StoppedDesktopLaunch[];
  readonly closed: Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null;
    readonly failure: DesktopMaintenanceSessionError | null }>;
  isHeld(): boolean;
  release(): Promise<void>;
}

/** Holds only the current Windows session's desktop guard. It is not a database/content freeze. */
export async function openDesktopMaintenanceSession(input: {
  readonly packageRoot: string; readonly dataRoot: string;
}): Promise<DesktopMaintenanceSession> {
  if (process.platform !== 'win32') throw new DesktopMaintenanceSessionError('MAINTENANCE_PLATFORM_UNSUPPORTED');
  const executable = await verifiedDesktopMaintenanceExecutable(input.packageRoot);
  if (!isAbsolute(input.dataRoot)) throw new DesktopMaintenanceSessionError();
  let dataRoot: string;
  try {
    const rootStat = await lstat(input.dataRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error();
    dataRoot = await realpath(input.dataRoot);
  } catch { throw new DesktopMaintenanceSessionError(); }
  const nonce = randomUUID();
  // The native stop/hold helper needs no database, model, or dotenv credentials.
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['SystemRoot', 'WINDIR', 'SystemDrive', 'TEMP', 'TMP']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  const child = spawn(executable, ['--maintenance-session'], {
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env,
  });
  return observeDesktopMaintenanceSession(child, nonce, dataRoot);
}

/** Internal process transport seam; production always obtains it from the verified native EXE. */
export async function observeDesktopMaintenanceSession(child: Pick<ChildProcessWithoutNullStreams,
  'stdin' | 'stdout' | 'stderr' | 'kill' | 'exitCode' | 'signalCode'> & {
    once(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
    once(event: 'error', listener: (error: Error) => void): unknown;
  },
  nonce: string, dataRoot: string): Promise<DesktopMaintenanceSession> {
  let held = false;
  let releaseRequested = false;
  let releaseConfirmed = false;
  let readySeen = false;
  let output = Buffer.alloc(0);
  let outputBytes = 0;
  let stoppedLaunches: readonly StoppedDesktopLaunch[] = [];
  let failure: DesktopMaintenanceSessionError | null = null;
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null;
    failure: DesktopMaintenanceSessionError | null }>((resolve) => {
    child.once('close', (code, signal) => {
      held = false;
      if (output.length !== 0) failure ??= new DesktopMaintenanceSessionError();
      if (!readySeen || !releaseRequested || !releaseConfirmed || code !== 0 || signal !== null) {
        failure ??= new DesktopMaintenanceSessionError('MAINTENANCE_SESSION_IO_FAILED');
      }
      resolve({ code, signal, failure });
    });
  });
  try { await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => fail('MAINTENANCE_SESSION_IO_FAILED'), 45_000);
    const fail = (code: string) => {
      failure ??= new DesktopMaintenanceSessionError(code);
      held = false;
      clearTimeout(timeout);
      child.kill();
      reject(failure);
    };
    child.once('error', () => fail('MAINTENANCE_SESSION_IO_FAILED'));
    child.stdin.on('error', () => fail('MAINTENANCE_SESSION_IO_FAILED'));
    child.stderr.resume(); // Never include native diagnostics in a credential-bearing CLI error.
    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > 2 * MAX_FRAME_BYTES) return fail('MAINTENANCE_SESSION_INVALID');
      output = Buffer.concat([output, chunk]);
      while (output.includes(10)) {
        const end = output.indexOf(10);
        const line = output.subarray(0, end);
        output = output.subarray(end + 1);
        try {
          const event = parseDesktopMaintenanceEvent(line, nonce);
          if (event.type === 'maintenance_error') return fail(event.code);
          if (event.type === 'maintenance_ready' && !readySeen && !releaseRequested) {
            readySeen = true;
            held = true;
            stoppedLaunches = event.stoppedLaunches;
            clearTimeout(timeout);
            resolve();
          } else if (event.type === 'maintenance_released' && readySeen && releaseRequested && !releaseConfirmed) {
            releaseConfirmed = true;
            held = false;
          } else return fail('MAINTENANCE_SESSION_INVALID');
        } catch { return fail('MAINTENANCE_SESSION_INVALID'); }
      }
      if (output.length > MAX_FRAME_BYTES) fail('MAINTENANCE_SESSION_INVALID');
    });
    child.once('close', () => {
      clearTimeout(timeout);
      if (!readySeen) reject(new DesktopMaintenanceSessionError('MAINTENANCE_SESSION_IO_FAILED'));
    });
    child.stdin.write(`${JSON.stringify({ type: 'maintenance_session_start', version: 1, nonce, dataRoot })}\n`);
  }); } catch (cause) { await closed; throw cause; }
  return { nonce, stoppedLaunches, closed,
    isHeld: () => failure === null && held && child.exitCode === null && child.signalCode === null,
    release: async () => {
      if (failure !== null) { await closed; throw failure; }
      if (!held || releaseRequested) throw new DesktopMaintenanceSessionError('MAINTENANCE_SESSION_IO_FAILED');
      releaseRequested = true;
      child.stdin.end(`${JSON.stringify({ type: 'maintenance_session_release', version: 1, nonce })}\n`);
      const timeout = setTimeout(() => child.kill(), 5000);
      try {
        const result = await closed;
        if (result.failure !== null) throw result.failure;
        if (result.code !== 0 || result.signal !== null || !releaseConfirmed || output.length !== 0) {
          throw new DesktopMaintenanceSessionError('MAINTENANCE_SESSION_IO_FAILED');
        }
      } finally { clearTimeout(timeout); }
    } };
}
