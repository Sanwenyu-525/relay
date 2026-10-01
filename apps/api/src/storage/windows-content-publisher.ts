import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { TextDecoder } from 'node:util';

export const CONTENT_PROTOCOL = 'relay-managed-content-v1';
export const CONTENT_FRAME_BYTES = 16 * 1024;
export const CONTENT_IDENTITY = /^[0-9a-f]{16}:[0-9a-f]{32}$/u;
const ERROR_CODES = new Set(['CONTENT_FROZEN', 'CONTENT_FREEZE_BUSY', 'CONFLICT', 'STAGING_OCCUPIED',
  'INVALID_INPUT', 'INVALID_VERSION', 'INVALID_CONTENT', 'UNSUPPORTED_PLATFORM', 'INVALID_ROOT',
  'ROOT_UNAVAILABLE', 'ROOT_PATH_UNAVAILABLE', 'ROOT_CHANGED', 'LOCK_UNAVAILABLE', 'UNSAFE_ENTRY',
  'HARD_LINK', 'PARENT_CHANGED', 'IDENTITY_UNAVAILABLE', 'CREATE_FAILED', 'READ_FAILED',
  'WRITE_FAILED', 'FLUSH_FAILED', 'DELETE_FAILED', 'RENAME_FAILED', 'IO_FAILED', 'NT_OPEN_FAILED']);

export class WindowsContentError extends Error {
  override readonly name = 'WindowsContentError';
  constructor(readonly code: string = 'CONTENT_IO_FAILED') { super(code); }
}

export function exactContentObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/** Only this fixed native helper performs managed Windows publication. No Node IO fallback. */
export function spawnContentHelper(executableOverride?: string) {
  if (process.platform !== 'win32') throw new WindowsContentError('UNSUPPORTED_PLATFORM');
  const executable = executableOverride ?? process.env.RELAY_FILE_IO_HELPER ?? join(dirname(process.execPath), 'relay-file-io-helper.exe');
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['SystemRoot', 'WINDIR', 'SystemDrive', 'TEMP', 'TMP']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return spawn(executable, ['--managed-content'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env });
}

export function parseContentReply(bytes: Buffer): Record<string, unknown> {
  let value: unknown;
  if (bytes.length > CONTENT_FRAME_BYTES) throw new WindowsContentError('CONTENT_PROTOCOL_INVALID');
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new WindowsContentError('CONTENT_PROTOCOL_INVALID'); }
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
      !('version' in value) || value.version !== CONTENT_PROTOCOL || !('ok' in value)) {
    throw new WindowsContentError('CONTENT_PROTOCOL_INVALID');
  }
  if (value.ok === false) {
    const reply = value as Record<string, unknown>;
    if (!exactContentObject(reply, ['version', 'ok', 'error']) ||
        !exactContentObject(reply.error, ['code', 'message']) ||
        typeof reply.error.code !== 'string' || typeof reply.error.message !== 'string' ||
        reply.error.message.length > 1024) throw new WindowsContentError('CONTENT_PROTOCOL_INVALID');
    throw new WindowsContentError(ERROR_CODES.has(reply.error.code) ? reply.error.code : 'CONTENT_IO_FAILED');
  }
  if (value.ok !== true) throw new WindowsContentError('CONTENT_PROTOCOL_INVALID');
  return value as Record<string, unknown>;
}

export async function publishWindowsContent(input: { readonly dataRoot: string;
  readonly artifactId: string; readonly versionId: string; readonly content: Buffer;
  readonly storageRef: string }): Promise<void> {
  if (input.content.length > 256 * 1024) throw new WindowsContentError('INVALID_CONTENT');
  const child = spawnContentHelper();
  await new Promise<void>((resolve, reject) => {
    let bytes = Buffer.alloc(0);
    let failure: WindowsContentError | undefined;
    const fail = (code: string) => { failure ??= new WindowsContentError(code); child.kill(); };
    const timeout = setTimeout(() => fail('CONTENT_IO_FAILED'), 30_000);
    child.once('error', () => fail('CONTENT_IO_FAILED'));
    child.stdin.on('error', () => fail('CONTENT_IO_FAILED'));
    child.stderr.resume();
    child.stdout.on('data', (chunk: Buffer) => {
      if (bytes.length + chunk.length > CONTENT_FRAME_BYTES) return fail('CONTENT_PROTOCOL_INVALID');
      bytes = Buffer.concat([bytes, chunk]);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      if (failure !== undefined) return reject(failure);
      try {
        const reply = parseContentReply(bytes);
        if (code !== 0 || signal !== null || !exactContentObject(reply,
          ['version', 'ok', 'op', 'root_id', 'sentinel_id', 'storage_ref', 'sha256', 'size']) ||
            reply.op !== 'publish-content' || typeof reply.root_id !== 'string' || !CONTENT_IDENTITY.test(reply.root_id) ||
            typeof reply.sentinel_id !== 'string' || !CONTENT_IDENTITY.test(reply.sentinel_id) ||
            reply.storage_ref !== input.storageRef || reply.size !== String(input.content.length) ||
            reply.sha256 !== createHash('sha256').update(input.content).digest('hex')) {
          throw new WindowsContentError('CONTENT_PROTOCOL_INVALID');
        }
        resolve();
      } catch (error) { reject(error); }
    });
    child.stdin.end(`${JSON.stringify({ version: CONTENT_PROTOCOL, op: 'publish-content',
      root_path: input.dataRoot, artifact_id: input.artifactId, version_id: input.versionId,
      content_hex: input.content.toString('hex') })}\n`);
  });
}
