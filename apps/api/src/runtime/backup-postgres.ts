import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { TextDecoder } from 'node:util';

import { assertBackupWindowsPaths, BackupWindowsPathsError } from './backup-paths.js';

const CODES = ['BACKUP_PG_INVALID_CONNECTION', 'BACKUP_PG_INVALID_PATH', 'BACKUP_PG_UNSAFE_TOOL',
  'BACKUP_PG_TOOL_CHANGED', 'BACKUP_PG_TOOL_VERSION', 'BACKUP_PG_TARGET_EXISTS',
  'BACKUP_PG_TARGET_CHANGED', 'BACKUP_PG_ABORTED', 'BACKUP_PG_TIMEOUT', 'BACKUP_PG_OUTPUT_LIMIT',
  'BACKUP_PG_ARCHIVE_INVALID', 'BACKUP_PG_CATALOG_INVALID', 'BACKUP_PG_LOCK_LOST',
  'BACKUP_PG_TOOL_FAILED', 'BACKUP_PG_UNSUPPORTED_PLATFORM', 'BACKUP_PG_IO_FAILED'] as const;
type Code = typeof CODES[number];
const MAX_ARCHIVE_BYTES = 32n * 1024n * 1024n * 1024n;
const MAX_TOOL_BYTES = 256n * 1024n * 1024n;

export class BackupPostgresError extends Error {
  override readonly name = 'BackupPostgresError';
  readonly code: Code;
  constructor(code: Code = 'BACKUP_PG_IO_FAILED') {
    const safe = CODES.includes(code) ? code : 'BACKUP_PG_IO_FAILED';
    super(safe); this.code = safe;
  }
}
function fail(code: Code): never { throw new BackupPostgresError(code); }
function interrupted(signal: AbortSignal): void { if (signal.aborted) fail('BACKUP_PG_ABORTED'); }
async function held(assertHeld: () => Promise<void>): Promise<void> {
  try { await assertHeld(); } catch { fail('BACKUP_PG_LOCK_LOST'); }
}
function systemEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['SystemRoot', 'WINDIR', 'SystemDrive', 'TEMP', 'TMP']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

/** Finite URL contract: explicit migrator, one database, optional sslmode=disable only. */
export function postgresBackupEnvironment(migrationUrl: string): NodeJS.ProcessEnv {
  try {
    if (migrationUrl.length > 8192) throw new Error();
    const url = new URL(migrationUrl);
    const user = decodeURIComponent(url.username);
    const password = decodeURIComponent(url.password);
    const database = decodeURIComponent(url.pathname.slice(1));
    const host = url.hostname.replace(/^\[|\]$/gu, '');
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hash !== '' || user !== 'relay_migrator' ||
        !/^(?:localhost|127\.0\.0\.1|::1)$/u.test(host) || database === '' ||
        Buffer.byteLength(database) > 63 || /[\x00-\x1f/\\]/u.test(database) || /[\x00-\x1f]/u.test(password) ||
        (url.port !== '' && (!/^[0-9]+$/u.test(url.port) || Number(url.port) < 1 || Number(url.port) > 65535))) throw new Error();
    const options = [...url.searchParams];
    if (options.length > 1 || options.some(([key, value]) => key !== 'sslmode' || value !== 'disable')) throw new Error();
    return { ...systemEnvironment(), PGHOST: host, PGPORT: url.port || '5432', PGUSER: user,
      PGPASSWORD: password, PGDATABASE: database, PGAPPNAME: 'relay-backup-pg-dump',
      PGCONNECT_TIMEOUT: '5', PGSSLMODE: 'disable', PGPASSFILE: 'NUL' };
  } catch { fail('BACKUP_PG_INVALID_CONNECTION'); }
}

function safeSegment(name: string): boolean {
  return name !== '' && name !== '.' && name !== '..' && name.length <= 255 &&
    !/[\x00-\x1f<>:"/\\|?*]/u.test(name) && !/[. ]$/u.test(name) &&
    !/^(con|prn|aux|nul|com[1-9]|lpt[1-9]|conin\$|conout\$)(\.|$)/iu.test(name);
}
function absolute(value: string): string {
  if (!isAbsolute(value) || !/^[a-z]:[\\/]/iu.test(value) || value.includes('\0')) fail('BACKUP_PG_INVALID_PATH');
  const parts = value.slice(parse(value).root.length).split(/[\\/]/u);
  if (parts.some(part => !safeSegment(part))) fail('BACKUP_PG_INVALID_PATH');
  return resolve(value);
}
interface Entry { path: string; stat: BigIntStats }
function identity(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.birthtimeNs === b.birthtimeNs;
}
function unchanged(a: BigIntStats, b: BigIntStats): boolean {
  return identity(a, b) && a.nlink === b.nlink && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
async function entry(path: string): Promise<Entry> {
  const stat = await lstat(path, { bigint: true });
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()) ||
      (stat.isFile() && stat.nlink !== 1n) || (await realpath(path)).toLowerCase() !== path.toLowerCase()) {
    fail('BACKUP_PG_INVALID_PATH');
  }
  return { path, stat };
}
async function parents(path: string): Promise<Entry[]> {
  const paths: string[] = [];
  for (let current = path;; current = dirname(current)) {
    paths.unshift(current);
    if (dirname(current) === current) break;
  }
  await assertBackupWindowsPaths(paths);
  const result: Entry[] = [];
  for (const path of paths) {
    const current = await entry(path);
    if (!current.stat.isDirectory()) fail('BACKUP_PG_INVALID_PATH');
    result.push(current);
  }
  return result;
}
async function verifyParents(entries: readonly Entry[]): Promise<void> {
  await assertBackupWindowsPaths(entries.map(entry => entry.path));
  for (const expected of entries) {
    if (!identity(expected.stat, (await entry(expected.path)).stat)) fail('BACKUP_PG_TARGET_CHANGED');
  }
}
async function digest(handle: FileHandle, signal: AbortSignal, maximum: bigint): Promise<{ size: string; sha256: string }> {
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(64 * 1024);
  let count = 0;
  for (;;) {
    interrupted(signal);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, count);
    if (bytesRead === 0) break;
    count += bytesRead;
    if (BigInt(count) > maximum) fail('BACKUP_PG_OUTPUT_LIMIT');
    hash.update(buffer.subarray(0, bytesRead));
  }
  return { size: String(count), sha256: hash.digest('hex') };
}
interface Tool extends Entry { sha256: string }
async function tool(path: string, signal: AbortSignal): Promise<Tool> {
  await assertBackupWindowsPaths([path]);
  const current = await entry(path);
  if (!current.stat.isFile() || current.stat.size === 0n || current.stat.size > MAX_TOOL_BYTES) fail('BACKUP_PG_UNSAFE_TOOL');
  const handle = await open(path, 'r');
  try {
    if (!unchanged(current.stat, await handle.stat({ bigint: true }))) fail('BACKUP_PG_TOOL_CHANGED');
    const result = await digest(handle, signal, MAX_TOOL_BYTES);
    if (!unchanged(current.stat, await handle.stat({ bigint: true })) ||
        !unchanged(current.stat, (await entry(path)).stat)) fail('BACKUP_PG_TOOL_CHANGED');
    return { ...current, sha256: result.sha256 };
  } finally { await handle.close(); }
}

async function child(input: { executable: string; args: readonly string[]; env: NodeJS.ProcessEnv;
  signal: AbortSignal; timeout: number; maxOutput: number; output?: FileHandle }): Promise<Buffer> {
  interrupted(input.signal);
  const process = spawn(input.executable, [...input.args], { env: input.env, windowsHide: true,
    stdio: ['ignore', input.output?.fd ?? 'pipe', 'pipe'] });
  const chunks: Buffer[] = [];
  let size = 0; let stderrBytes = 0; let failure: Code | null = null;
  const stop = (code: Code) => { failure ??= code; process.kill(); };
  const abort = () => stop('BACKUP_PG_ABORTED');
  const timeout = setTimeout(() => stop('BACKUP_PG_TIMEOUT'), input.timeout);
  const monitor = input.output === undefined ? undefined : setInterval(() => {
    void input.output!.stat({ bigint: true }).then(stat => {
      if (stat.size > MAX_ARCHIVE_BYTES) stop('BACKUP_PG_OUTPUT_LIMIT');
    }).catch(() => stop('BACKUP_PG_TARGET_CHANGED'));
  }, 250);
  process.stdout?.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > input.maxOutput) stop('BACKUP_PG_OUTPUT_LIMIT'); else chunks.push(chunk);
  });
  process.stderr?.on('data', (chunk: Buffer) => {
    stderrBytes += chunk.length;
    if (stderrBytes > 64 * 1024) stop('BACKUP_PG_OUTPUT_LIMIT');
  });
  process.once('error', () => stop('BACKUP_PG_TOOL_FAILED'));
  input.signal.addEventListener('abort', abort, { once: true });
  if (input.signal.aborted) abort();
  const ended = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    process.once('close', (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timeout); if (monitor !== undefined) clearInterval(monitor);
  input.signal.removeEventListener('abort', abort);
  if (failure !== null) fail(failure);
  if (ended.code !== 0 || ended.signal !== null) fail('BACKUP_PG_TOOL_FAILED');
  return Buffer.concat(chunks);
}

/** Verifies required tables AND data entries; returns only a digest of the original bounded TOC. */
export function inspectPostgresBackupCatalog(bytes: Buffer): string {
  try {
    if (bytes.length > 8 * 1024 * 1024) throw new Error();
    const text = new TextDecoder('utf8', { fatal: true }).decode(bytes);
    const tables = [['public', 'relay_schema_migrations'], ['public', 'runtime_admission_gate'],
      ['public', 'artifact_versions'], ['relay_graph_v1', 'checkpoint_migrations'],
      ['relay_graph_v1', 'checkpoints'], ['relay_graph_v1', 'checkpoint_blobs'],
      ['relay_graph_v1', 'checkpoint_writes']];
    for (const [schema, table] of tables) {
      for (const kind of ['TABLE', 'TABLE DATA']) {
        const regex = new RegExp(`^[0-9]+; [0-9]+ [0-9]+ ${kind} ${schema} ${table} relay_migrator\\r?$`, 'mu');
        if (!regex.test(text)) throw new Error();
      }
    }
    return createHash('sha256').update(bytes).digest('hex');
  } catch { fail('BACKUP_PG_CATALOG_INVALID'); }
}

/** Requires caller-held complete maintenance boundaries; never claims whole-product restore acceptance. */
export async function createPostgresBackupArchive(input: { migrationUrl: string; postgresBin: string;
  dumpFile: string; signal: AbortSignal; assertHeld: () => Promise<void> }): Promise<{
    size: string; sha256: string; toolVersion: string; dumpToolSha256: string;
    restoreToolSha256: string; catalogSha256: string;
  }> {
  try {
    interrupted(input.signal);
    if (process.platform !== 'win32') fail('BACKUP_PG_UNSUPPORTED_PLATFORM');
    const env = postgresBackupEnvironment(input.migrationUrl);
    const bin = absolute(input.postgresBin); const dumpFile = absolute(input.dumpFile);
    await held(input.assertHeld);
    const binParents = await parents(bin); const dumpParents = await parents(dirname(dumpFile));
    const dump = await tool(join(bin, 'pg_dump.exe'), input.signal);
    const restore = await tool(join(bin, 'pg_restore.exe'), input.signal);
    const checkTools = async () => {
      await verifyParents(binParents);
      for (const original of [dump, restore]) {
        const current = await tool(original.path, input.signal);
        if (!unchanged(original.stat, current.stat) || original.sha256 !== current.sha256) fail('BACKUP_PG_TOOL_CHANGED');
      }
    };
    const run = async (tool: Tool, args: readonly string[], timeout: number, maxOutput: number,
      output?: FileHandle): Promise<Buffer> => {
      await checkTools(); interrupted(input.signal);
      try { return await child({ executable: tool.path, args, env, signal: input.signal,
        timeout, maxOutput, ...(output === undefined ? {} : { output }) }); }
      finally { await held(input.assertHeld); }
    };
    const dumpVersion = (await run(dump, ['--version'], 10_000, 4096)).toString('utf8').trim();
    const restoreVersion = (await run(restore, ['--version'], 10_000, 4096)).toString('utf8').trim();
    const match = /^pg_dump \(PostgreSQL\) (18\.[0-9]+)$/u.exec(dumpVersion);
    if (match === null || restoreVersion !== `pg_restore (PostgreSQL) ${match[1]}`) fail('BACKUP_PG_TOOL_VERSION');
    await verifyParents(dumpParents); interrupted(input.signal);
    let handle: FileHandle;
    try { handle = await open(dumpFile, 'wx+', 0o600); }
    catch (cause) {
      if (typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'EEXIST') fail('BACKUP_PG_TARGET_EXISTS');
      throw cause;
    }
    try {
      const created = await handle.stat({ bigint: true });
      await held(input.assertHeld); interrupted(input.signal);
      await run(dump, ['--format=custom', '--no-password', '--lock-wait-timeout=5s'], 5 * 60_000, 0, handle);
      await handle.sync();
      const completed = await handle.stat({ bigint: true });
      if (!identity(created, completed) || completed.nlink !== 1n || completed.size < 5n) fail('BACKUP_PG_ARCHIVE_INVALID');
      const header = Buffer.alloc(5); await handle.read(header, 0, 5, 0);
      if (!header.equals(Buffer.from('PGDMP'))) fail('BACKUP_PG_ARCHIVE_INVALID');
      const result = await digest(handle, input.signal, MAX_ARCHIVE_BYTES);
      await assertBackupWindowsPaths([dumpFile]);
      if (!unchanged(completed, await handle.stat({ bigint: true })) ||
          !unchanged(completed, (await entry(dumpFile)).stat)) fail('BACKUP_PG_TARGET_CHANGED');
      const catalog = await run(restore, ['--list', dumpFile], 10_000, 8 * 1024 * 1024);
      const catalogSha256 = inspectPostgresBackupCatalog(catalog);
      await checkTools(); await verifyParents(dumpParents);
      const final = await digest(handle, input.signal, MAX_ARCHIVE_BYTES);
      await assertBackupWindowsPaths([dumpFile]);
      if (!unchanged(completed, await handle.stat({ bigint: true })) ||
          !unchanged(completed, (await entry(dumpFile)).stat) ||
          final.size !== result.size || final.sha256 !== result.sha256) fail('BACKUP_PG_TARGET_CHANGED');
      await held(input.assertHeld); interrupted(input.signal);
      return { ...result, toolVersion: match[1]!, dumpToolSha256: dump.sha256,
        restoreToolSha256: restore.sha256, catalogSha256 };
    } finally { await handle.close(); }
  } catch (cause) {
    if (cause instanceof BackupPostgresError) throw cause;
    if (cause instanceof BackupWindowsPathsError) throw new BackupPostgresError('BACKUP_PG_INVALID_PATH');
    throw new BackupPostgresError();
  }
}

/** Restores only into the caller's separately isolated target; no cleanup, creation or replay. */
export async function restorePostgresBackupArchive(input: { migrationUrl: string; postgresBin: string;
  dumpFile: string; expectedArchive: { size: string; sha256: string; toolVersion: string;
    restoreToolSha256: string; catalogSha256: string };
  signal: AbortSignal; assertHeld: () => Promise<void> }): Promise<void> {
  try {
    interrupted(input.signal);
    if (process.platform !== 'win32') fail('BACKUP_PG_UNSUPPORTED_PLATFORM');
    const expected = input.expectedArchive;
    if (!/^[1-9][0-9]{0,10}$/u.test(expected.size) || BigInt(expected.size) < 5n ||
        BigInt(expected.size) > MAX_ARCHIVE_BYTES || !/^[0-9a-f]{64}$/u.test(expected.sha256) ||
        !/^[0-9a-f]{64}$/u.test(expected.restoreToolSha256) ||
        !/^[0-9a-f]{64}$/u.test(expected.catalogSha256)) fail('BACKUP_PG_ARCHIVE_INVALID');
    if (expected.toolVersion.length > 32 || !/^18\.[0-9]+$/u.test(expected.toolVersion)) fail('BACKUP_PG_TOOL_VERSION');
    const env = postgresBackupEnvironment(input.migrationUrl);
    // libpq treats a dbname containing '=' as conninfo, which could override the fixed environment.
    if (env.PGDATABASE!.includes('=')) fail('BACKUP_PG_INVALID_CONNECTION');
    env.PGAPPNAME = 'relay-restore-pg-archive';
    env.PGOPTIONS = '-c lock_timeout=5000 -c statement_timeout=300000';
    const bin = absolute(input.postgresBin), dumpFile = absolute(input.dumpFile);
    await held(input.assertHeld);
    const binParents = await parents(bin), sourceParents = await parents(dirname(dumpFile));
    const restore = await tool(join(bin, 'pg_restore.exe'), input.signal);
    if (restore.sha256 !== expected.restoreToolSha256) fail('BACKUP_PG_TOOL_CHANGED');
    await assertBackupWindowsPaths([dumpFile]);
    const source = await entry(dumpFile);
    if (!source.stat.isFile() || String(source.stat.size) !== expected.size) fail('BACKUP_PG_ARCHIVE_INVALID');
    const handle = await open(dumpFile, 'r');
    try {
      const checkSource = async (hashBytes: boolean): Promise<void> => {
        await verifyParents(sourceParents); await assertBackupWindowsPaths([dumpFile]);
        if (!unchanged(source.stat, await handle.stat({ bigint: true })) ||
            !unchanged(source.stat, (await entry(dumpFile)).stat)) fail('BACKUP_PG_TARGET_CHANGED');
        if (hashBytes) {
          const current = await digest(handle, input.signal, MAX_ARCHIVE_BYTES);
          if (current.size !== expected.size || current.sha256 !== expected.sha256) fail('BACKUP_PG_ARCHIVE_INVALID');
          if (!unchanged(source.stat, await handle.stat({ bigint: true })) ||
              !unchanged(source.stat, (await entry(dumpFile)).stat)) fail('BACKUP_PG_TARGET_CHANGED');
        }
      };
      const checkTool = async () => {
        await verifyParents(binParents);
        const current = await tool(restore.path, input.signal);
        if (!unchanged(restore.stat, current.stat) || current.sha256 !== restore.sha256) fail('BACKUP_PG_TOOL_CHANGED');
      };
      const run = async (args: readonly string[], timeout: number, maxOutput: number): Promise<Buffer> => {
        await held(input.assertHeld); await checkTool(); await checkSource(false); interrupted(input.signal);
        try { return await child({ executable: restore.path, args, env, signal: input.signal, timeout, maxOutput }); }
        finally { await held(input.assertHeld); }
      };
      await checkSource(true);
      const header = Buffer.alloc(5); await handle.read(header, 0, 5, 0);
      if (!header.equals(Buffer.from('PGDMP'))) fail('BACKUP_PG_ARCHIVE_INVALID');
      const version = (await run(['--version'], 10_000, 4096)).toString('utf8').trim();
      if (version !== `pg_restore (PostgreSQL) ${expected.toolVersion}`) fail('BACKUP_PG_TOOL_VERSION');
      const catalog = await run(['--list', dumpFile], 10_000, 8 * 1024 * 1024);
      if (inspectPostgresBackupCatalog(catalog) !== expected.catalogSha256) fail('BACKUP_PG_CATALOG_INVALID');
      await checkSource(true);
      await run(['--exit-on-error', '--single-transaction', '--no-password', `--dbname=${env.PGDATABASE!}`, dumpFile],
        5 * 60_000, 0);
      await checkTool(); await checkSource(true);
      await held(input.assertHeld); interrupted(input.signal);
    } finally { await handle.close(); }
  } catch (cause) {
    if (cause instanceof BackupPostgresError) throw cause;
    if (cause instanceof BackupWindowsPathsError) throw new BackupPostgresError('BACKUP_PG_INVALID_PATH');
    throw new BackupPostgresError();
  }
}
