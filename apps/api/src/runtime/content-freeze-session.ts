import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

import { CONTENT_PROTOCOL, CONTENT_FRAME_BYTES, CONTENT_IDENTITY, exactContentObject,
  parseContentReply, spawnContentHelper, WindowsContentError } from '../storage/windows-content-publisher.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

type FreezeEvent = { readonly event: 'content_freeze_ready'; readonly rootId: string; readonly sentinelId: string } |
  { readonly event: 'content_freeze_released' };

export function parseContentFreezeEvent(bytes: Buffer, nonce: string): FreezeEvent {
  const value = parseContentReply(bytes);
  const invalid = () => new WindowsContentError('CONTENT_PROTOCOL_INVALID');
  if (!UUID.test(nonce) || value.nonce !== nonce) throw invalid();
  if (value.event === 'content_freeze_released' &&
      exactContentObject(value, ['version', 'ok', 'event', 'nonce'])) return { event: value.event };
  if (value.event !== 'content_freeze_ready' || !exactContentObject(value,
    ['version', 'ok', 'event', 'nonce', 'root_id', 'sentinel_id']) ||
      typeof value.root_id !== 'string' || !CONTENT_IDENTITY.test(value.root_id) ||
      typeof value.sentinel_id !== 'string' || !CONTENT_IDENTITY.test(value.sentinel_id)) throw invalid();
  return { event: value.event, rootId: value.root_id, sentinelId: value.sentinel_id };
}

export interface ContentFreezeSession {
  readonly nonce: string; readonly rootId: string; readonly sentinelId: string;
  readonly closed: Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null;
    readonly failure: WindowsContentError | null }>;
  isHeld(): boolean;
  release(): Promise<void>;
}

/** Excludes current managed content publishers only; it does not freeze PG or external FILE_WRITE. */
export async function openContentFreezeSession(dataRoot: string, helperExecutable?: string): Promise<ContentFreezeSession> {
  if (process.platform !== 'win32') throw new WindowsContentError('UNSUPPORTED_PLATFORM');
  try {
    if (!isAbsolute(dataRoot)) throw new Error();
    const entry = await lstat(dataRoot);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error();
  } catch { throw new WindowsContentError('INVALID_ROOT'); }
  // Do not realpath through a junction: the native owner rejects every reparse ancestor.
  return observeContentFreezeSession(spawnContentHelper(helperExecutable), randomUUID(), resolve(dataRoot));
}

/** Internal process transport seam. Production always starts the fixed native content helper. */
export async function observeContentFreezeSession(child: Pick<ChildProcessWithoutNullStreams,
  'stdin' | 'stdout' | 'stderr' | 'kill' | 'exitCode' | 'signalCode'> & {
    once(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
    once(event: 'error', listener: (error: Error) => void): unknown;
  }, nonce: string, dataRoot: string): Promise<ContentFreezeSession> {
  let held = false;
  let readySeen = false;
  let releaseRequested = false;
  let releaseConfirmed = false;
  let output = Buffer.alloc(0);
  let outputBytes = 0;
  let rootId = '';
  let sentinelId = '';
  let failure: WindowsContentError | null = null;
  let readyResolve!: () => void;
  let readyReject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const timeout = setTimeout(() => fail(new WindowsContentError()), 30_000);
  const fail = (error: WindowsContentError) => {
    failure ??= error;
    held = false;
    clearTimeout(timeout);
    child.kill();
    readyReject(failure);
  };
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null;
    failure: WindowsContentError | null }>((resolve) => {
    child.once('close', (code, signal) => {
      held = false;
      clearTimeout(timeout);
      if (output.length !== 0) failure ??= new WindowsContentError('CONTENT_PROTOCOL_INVALID');
      if (!readySeen || !releaseConfirmed || code !== 0 || signal !== null) failure ??= new WindowsContentError();
      if (failure !== null) readyReject(failure);
      resolve({ code, signal, failure });
    });
  });
  child.once('error', () => fail(new WindowsContentError()));
  child.stdin.on('error', () => fail(new WindowsContentError()));
  child.stderr.resume();
  child.stdout.on('data', (chunk: Buffer) => {
    outputBytes += chunk.length;
    if (outputBytes > 2 * CONTENT_FRAME_BYTES) return fail(new WindowsContentError('CONTENT_PROTOCOL_INVALID'));
    output = Buffer.concat([output, chunk]);
    while (output.includes(10)) {
      const end = output.indexOf(10);
      const line = output.subarray(0, end);
      output = output.subarray(end + 1);
      try {
        const event = parseContentFreezeEvent(line, nonce);
        if (event.event === 'content_freeze_ready' && !readySeen && !releaseRequested) {
          readySeen = true;
          held = true;
          rootId = event.rootId;
          sentinelId = event.sentinelId;
          clearTimeout(timeout);
          readyResolve();
        } else if (event.event === 'content_freeze_released' && readySeen && releaseRequested && !releaseConfirmed) {
          releaseConfirmed = true;
          held = false;
        } else return fail(new WindowsContentError('CONTENT_PROTOCOL_INVALID'));
      } catch (error) {
        return fail(error instanceof WindowsContentError ? error : new WindowsContentError('CONTENT_PROTOCOL_INVALID'));
      }
    }
    if (output.length > CONTENT_FRAME_BYTES) fail(new WindowsContentError('CONTENT_PROTOCOL_INVALID'));
  });
  child.stdin.write(`${JSON.stringify({ version: CONTENT_PROTOCOL, op: 'hold-content-freeze', root_path: dataRoot, nonce })}\n`);
  try { await ready; }
  catch (error) { await closed; throw error; }
  return { nonce, rootId, sentinelId, closed,
    isHeld: () => failure === null && held && child.exitCode === null && child.signalCode === null,
    release: async () => {
      if (failure !== null) { await closed; throw failure; }
      if (!held || releaseRequested) throw new WindowsContentError();
      releaseRequested = true;
      child.stdin.end(`${JSON.stringify({ version: CONTENT_PROTOCOL, op: 'release-content-freeze', nonce })}\n`);
      const releaseTimeout = setTimeout(() => fail(new WindowsContentError()), 5000);
      try {
        const result = await closed;
        if (result.failure !== null) throw result.failure;
        if (!releaseConfirmed) throw new WindowsContentError();
      } finally { clearTimeout(releaseTimeout); }
    } };
}
