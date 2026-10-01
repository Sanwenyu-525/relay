import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { assertBackupWindowsPaths } from './backup-paths.js';

const NAMES = ['@langchain/core', '@langchain/langgraph', '@langchain/langgraph-checkpoint',
  '@langchain/langgraph-checkpoint-postgres', '@langchain/openai', '@sinclair/typebox',
  'fastify', 'kysely', 'pg', 'pg-connection-string'] as const;
const CODES = ['RESTORE_PROBE_INVALID_INPUT', 'RESTORE_PROBE_PATH_UNAVAILABLE', 'RESTORE_PROBE_HASH_MISMATCH',
  'RESTORE_PROBE_DEPENDENCY_INVALID', 'RESTORE_PROBE_RESOLUTION_REJECTED', 'RESTORE_PROBE_LOAD_REJECTED',
  'RESTORE_PROBE_OFFLINE_CHECK_FAILED', 'RESTORE_PROBE_OUTPUT_LIMIT', 'RESTORE_PROBE_ABORTED',
  'RESTORE_PROBE_TIMEOUT', 'RESTORE_PROBE_CHILD_FAILED'] as const;
type Code = typeof CODES[number];
export class RestoreRuntimeProbeError extends Error {
  override readonly name = 'RestoreRuntimeProbeError';
  readonly code: Code;
  constructor(code: Code = 'RESTORE_PROBE_CHILD_FAILED') {
    const safe = CODES.includes(code) ? code : 'RESTORE_PROBE_CHILD_FAILED';
    super(safe); this.code = safe;
  }
}
export interface RestoreRuntimeProbeReport {
  readonly format: 'relay-restore-runtime-probe-v1';
  readonly scope: 'PACKAGED_DEPENDENCIES_OFFLINE_ONLY';
  readonly node_version: string;
  readonly node_sha256: string;
  readonly package_metadata_sha256: string;
  readonly direct_dependencies: readonly {
    readonly name: string; readonly version: string; readonly entry_ref: string; readonly entry_sha256: string;
    readonly package_ref: string; readonly package_sha256: string;
  }[];
  readonly loaded_file_count: number;
  readonly loaded_files_canonical_sha256: string;
  readonly checks: Readonly<Record<typeof CHECKS[number], true>>;
}
const CHECKS = ['pg_construct', 'kysely_compile', 'typebox_schema', 'fastify_inject', 'langgraph_local',
  'memory_saver_construct', 'postgres_saver_construct', 'chat_openai_construct', 'connection_string_parse'] as const;
const HASH = /^[0-9a-f]{64}$/u;
const INTEGER = '(?:0|[1-9][0-9]*)';
const SEMVER = new RegExp(`^${INTEGER}\\.${INTEGER}\\.${INTEGER}(?:-(?:${INTEGER}|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*)(?:\\.(?:${INTEGER}|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\\+[0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*)?$`, 'u');
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
function safeRef(ref: string): boolean {
  return ref.length > 0 && ref.length <= 1024 && !/[\\:\x00-\x1f]/u.test(ref) &&
    ref.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..' && !/[. ]$/u.test(part));
}
function dependencies(value: unknown): Record<string, string> {
  if (!object(value) || !object(value.dependencies) || Object.keys(value.dependencies).sort().join('\n') !== [...NAMES].sort().join('\n')) {
    throw new RestoreRuntimeProbeError('RESTORE_PROBE_DEPENDENCY_INVALID');
  }
  const result: Record<string, string> = {};
  for (const name of NAMES) {
    const version = value.dependencies[name];
    if (typeof version !== 'string' || version.length > 128 || !SEMVER.test(version)) {
      throw new RestoreRuntimeProbeError('RESTORE_PROBE_DEPENDENCY_INVALID');
    }
    result[name] = version;
  }
  return result;
}
async function ordinary(path: string): Promise<Awaited<ReturnType<typeof lstat>>> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) || (stat.isFile() && stat.nlink !== 1) ||
      (await realpath(path)).toLowerCase() !== path.toLowerCase()) throw new RestoreRuntimeProbeError('RESTORE_PROBE_PATH_UNAVAILABLE');
  return stat;
}
async function boundFile(path: string, expected: string, limit: number, content = false): Promise<Buffer> {
  const before = await ordinary(path);
  if (!before.isFile() || before.size > limit) throw new RestoreRuntimeProbeError('RESTORE_PROBE_PATH_UNAVAILABLE');
  const fd = await open(path, 'r');
  try {
    const opened = await fd.stat(), hash = createHash('sha256'), chunks: Buffer[] = [];
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1) throw new RestoreRuntimeProbeError('RESTORE_PROBE_PATH_UNAVAILABLE');
    let total = 0;
    for await (const chunk of fd.createReadStream({ autoClose: false })) {
      total += chunk.length;
      if (total > limit) throw new RestoreRuntimeProbeError('RESTORE_PROBE_PATH_UNAVAILABLE');
      hash.update(chunk); if (content) chunks.push(chunk);
    }
    const after = await ordinary(path), held = await fd.stat();
    if ([after, held].some((stat) => stat.dev !== before.dev || stat.ino !== before.ino || stat.size !== before.size ||
      stat.mtimeMs !== before.mtimeMs || stat.ctimeMs !== before.ctimeMs || stat.nlink !== 1) || total !== before.size) {
      throw new RestoreRuntimeProbeError('RESTORE_PROBE_PATH_UNAVAILABLE');
    }
    if (hash.digest('hex') !== expected) throw new RestoreRuntimeProbeError('RESTORE_PROBE_HASH_MISMATCH');
    return content ? Buffer.concat(chunks) : Buffer.alloc(0);
  } finally { await fd.close(); }
}

// A fixed synchronous Node 24 hook covers ESM and CJS. nextLoad preserves Node's
// format/attribute checks; its actual source is compared with the bound bytes.
// These guards bind trusted package bytes; they do not provide an OS sandbox.
const SCRIPT = String.raw`
import { registerHooks, isBuiltin, syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { lstatSync, realpathSync, openSync, fstatSync, readSync, closeSync } from 'node:fs';
import { resolve, relative, isAbsolute, sep, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import net from 'node:net'; import tls from 'node:tls'; import http from 'node:http'; import https from 'node:https';
import dgram from 'node:dgram';
import childProcess from 'node:child_process'; import workerThreads from 'node:worker_threads';
import dns from 'node:dns'; import dnsPromises from 'node:dns/promises';
const names = $NAMES_JSON$;
const checks = $CHECKS_JSON$;
const codes = $CODES_JSON$;
const fail = code => { const error = new Error(code); error.probeCode = code; throw error; };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
try {
const inputChunks = []; let inputBytes = 0;
for await (const bytes of process.stdin) {
  inputBytes += bytes.length;
  if (inputBytes > 32 * 1024 * 1024) fail('RESTORE_PROBE_INVALID_INPUT');
  inputChunks.push(bytes);
}
const config = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(inputChunks))),
  root = resolve(config.packageRoot), api = resolve(root, 'api');
if (process.version !== config.nodeVersion) fail('RESTORE_PROBE_DEPENDENCY_INVALID');
const resources = config.resourceHashes, loaded = new Map(), direct = new Map(), directories = new Set();
let bytesRead = 0, sealed = false;
function ordinary(path, directory) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) ||
      realpathSync(path).toLowerCase() !== path.toLowerCase()) fail('RESTORE_PROBE_RESOLUTION_REJECTED');
  return stat;
}
function location(url) {
  if (!url.startsWith('file:')) fail('RESTORE_PROBE_RESOLUTION_REJECTED');
  const parsed = new URL(url);
  if (parsed.search || parsed.hash) fail('RESTORE_PROBE_RESOLUTION_REJECTED');
  const path = fileURLToPath(parsed), ref = relative(root, path).split(sep).join('/');
  if (isAbsolute(ref) || !ref.startsWith('api/') || ref.split('/').some(p => p === '..' || p.includes(':')) ||
      !Object.hasOwn(resources, ref)) fail('RESTORE_PROBE_RESOLUTION_REJECTED');
  for (let parent = dirname(path);; parent = dirname(parent)) {
    if (!directories.has(parent)) { ordinary(parent, true); directories.add(parent); }
    if (parent.toLowerCase() === root.toLowerCase()) break;
    if (dirname(parent) === parent) fail('RESTORE_PROBE_RESOLUTION_REJECTED');
  }
  ordinary(path, false); return { path, ref };
}
function readBound(url, max = 16 * 1024 * 1024) {
  const { path, ref } = location(url), before = ordinary(path, false);
  if (before.size > max) fail('RESTORE_PROBE_LOAD_REJECTED');
  const fd = openSync(path, 'r');
  try {
    const held = fstatSync(fd);
    if (held.dev !== before.dev || held.ino !== before.ino || held.nlink !== 1) fail('RESTORE_PROBE_LOAD_REJECTED');
    const bytes = Buffer.alloc(before.size); let offset = 0;
    while (offset < bytes.length) { const count = readSync(fd, bytes, offset, bytes.length - offset, offset); if (!count) break; offset += count; }
    const after = ordinary(path, false), opened = fstatSync(fd);
    if (offset !== before.size || [after, opened].some(s => s.dev !== before.dev || s.ino !== before.ino ||
      s.size !== before.size || s.mtimeMs !== before.mtimeMs || s.ctimeMs !== before.ctimeMs || s.nlink !== 1)) fail('RESTORE_PROBE_LOAD_REJECTED');
    bytesRead += bytes.length;
    if (bytesRead > 256 * 1024 * 1024) fail('RESTORE_PROBE_LOAD_REJECTED');
    if (hash(bytes) !== resources[ref]) fail('RESTORE_PROBE_HASH_MISMATCH');
    return { ref, bytes };
  } finally { closeSync(fd); }
}
function json(ref) { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readBound(pathToFileURL(resolve(root, ref)).href, 1024 * 1024).bytes)); }
const apiPackage = json('api/package.json');
if (hash(readBound(pathToFileURL(resolve(api, 'package.json')).href).bytes) !== config.packageHash) fail('RESTORE_PROBE_HASH_MISMATCH');
if (Object.keys(apiPackage.dependencies).sort().join('\n') !== [...names].sort().join('\n')) fail('RESTORE_PROBE_DEPENDENCY_INVALID');
const metadata = new Map();
for (const name of names) {
  const ref = 'api/node_modules/' + name + '/package.json', value = json(ref);
  if (value.name !== name || value.version !== apiPackage.dependencies[name] || value.version !== config.dependencies[name]) fail('RESTORE_PROBE_DEPENDENCY_INVALID');
  metadata.set(name, { package_ref: ref, package_sha256: resources[ref] });
}
function offline() { fail('RESTORE_PROBE_OFFLINE_CHECK_FAILED'); }
net.Socket.prototype.connect = offline; net.connect = offline; net.createConnection = offline;
net.Server.prototype.listen = offline; tls.connect = offline; http.request = offline; http.get = offline;
https.request = offline; https.get = offline; dgram.createSocket = offline; globalThis.fetch = offline;
for (const key of ['send', 'connect', 'bind']) dgram.Socket.prototype[key] = offline;
for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork', '_forkChild']) childProcess[key] = offline;
childProcess.ChildProcess.prototype.spawn = offline; workerThreads.Worker = offline;
const dnsQueries = ['lookup', 'lookupService', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCaa', 'resolveCname',
  'resolveMx', 'resolveNaptr', 'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTlsa', 'resolveTxt', 'reverse'];
for (const surface of [dns, dnsPromises, dns.Resolver.prototype, dnsPromises.Resolver.prototype]) {
  for (const key of dnsQueries) if (typeof surface[key] === 'function') surface[key] = offline;
}
syncBuiltinESMExports();
const probeURL = import.meta.url, anchor = pathToFileURL(resolve(api, 'package.json')).href;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const top = context.parentURL === probeURL && (names.includes(specifier) || specifier === '@langchain/core/output_parsers');
    const result = nextResolve(specifier, top ? { ...context, parentURL: anchor } : context);
    if (result.url.startsWith('node:') && isBuiltin(result.url)) return result;
    const entry = location(result.url);
    if (top && names.includes(specifier)) {
      if (!entry.ref.startsWith('api/node_modules/' + specifier + '/')) fail('RESTORE_PROBE_RESOLUTION_REJECTED');
      direct.set(specifier, entry.ref);
    }
    return result;
  },
  load(url, context, nextLoad) {
    if (sealed) fail('RESTORE_PROBE_LOAD_REJECTED');
    if (url.startsWith('node:') && isBuiltin(url)) return nextLoad(url, context);
    const { ref, bytes } = readBound(url);
    const source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    const result = nextLoad(url, { ...context, source: bytes });
    if (!['module', 'commonjs', 'json', undefined].includes(result.format) || result.source == null) fail('RESTORE_PROBE_LOAD_REJECTED');
    const actual = typeof result.source === 'string' ? Buffer.from(result.source) : Buffer.from(result.source.buffer ?? result.source,
      result.source.byteOffset ?? 0, result.source.byteLength);
    if (hash(actual) !== resources[ref] || hash(Buffer.from(source)) !== resources[ref]) fail('RESTORE_PROBE_HASH_MISMATCH');
    loaded.set(ref, resources[ref]);
    if (loaded.size > 100000) fail('RESTORE_PROBE_LOAD_REJECTED');
    return { ...result, source: bytes };
  }
});
const cleanup = []; let report, failed;
try {
  const modules = new Map();
  for (const name of names) modules.set(name, await import(name));
  const pg = modules.get('pg').default;
  const pgConfig = { host: '127.0.0.1', port: 1, user: 'offline_probe', database: 'offline_probe', password: async () => '', ssl: false,
    options: '-c default_transaction_read_only=on', connectionTimeoutMillis: 100, max: 1 };
  const client = new pg.Client(pgConfig), pool = new pg.Pool(pgConfig); cleanup.push(() => client.end(), () => pool.end());
  if (!(client instanceof pg.Client) || !(pool instanceof pg.Pool)) offline();
  const { Kysely, PostgresDialect } = modules.get('kysely');
  const db = new Kysely({ dialect: new PostgresDialect({ pool: new pg.Pool(pgConfig) }) }); cleanup.push(() => db.destroy());
  const query = db.selectFrom('offline_probe').select('id').where('id', '=', 7).compile();
  if (query.sql !== 'select "id" from "offline_probe" where "id" = $1' || query.parameters[0] !== 7) offline();
  const schema = modules.get('@sinclair/typebox').Type.Object({ valid: modules.get('@sinclair/typebox').Type.Boolean() });
  if (schema.type !== 'object' || schema.properties.valid.type !== 'boolean') offline();
  const server = modules.get('fastify').default(); cleanup.push(() => server.close());
  server.get('/offline-probe', { schema: { response: { 200: schema } } }, async () => ({ valid: true }));
  const response = await server.inject({ method: 'GET', url: '/offline-probe' });
  if (response.statusCode !== 200 || response.json().valid !== true) offline();
  const { StateGraph, Annotation, START, END } = modules.get('@langchain/langgraph');
  const { MemorySaver } = modules.get('@langchain/langgraph-checkpoint');
  const memory = new MemorySaver(); if (!(memory instanceof MemorySaver)) offline();
  const graph = new StateGraph(Annotation.Root({ value: Annotation() })).addNode('local', () => ({ value: 'offline-ok' }))
    .addEdge(START, 'local').addEdge('local', END).compile();
  if ((await graph.invoke({ value: '' })).value !== 'offline-ok') offline();
  const { PostgresSaver } = modules.get('@langchain/langgraph-checkpoint-postgres');
  const saverPool = new pg.Pool(pgConfig); cleanup.push(() => saverPool.end());
  const saver = new PostgresSaver(saverPool, undefined, { schema: 'relay_graph_v1' });
  if (!(saver instanceof PostgresSaver) || saver.isSetup !== false) offline();
  const { ChatOpenAI } = modules.get('@langchain/openai');
  const model = new ChatOpenAI({ model: 'offline-probe', apiKey: 'offline-probe-no-credential', maxRetries: 0, timeout: 100,
    configuration: { fetch: offline } }); if (!(model instanceof ChatOpenAI)) offline();
  const { JsonOutputParser } = await import('@langchain/core/output_parsers');
  if ((await new JsonOutputParser().parse('{"valid":true}')).valid !== true) offline();
  const parsed = modules.get('pg-connection-string').parse('postgresql://offline_probe@127.0.0.1:1/offline_probe?sslmode=disable');
  if (parsed.host !== '127.0.0.1' || parsed.port !== '1' || parsed.database !== 'offline_probe') offline();
  const entries = names.map(name => {
    const ref = direct.get(name);
    if (!ref || !loaded.has(ref)) fail('RESTORE_PROBE_LOAD_REJECTED');
    return { name, version: apiPackage.dependencies[name], entry_ref: ref, entry_sha256: loaded.get(ref), ...metadata.get(name) };
  });
  report = { format: 'relay-restore-runtime-probe-v1', scope: 'PACKAGED_DEPENDENCIES_OFFLINE_ONLY', node_version: process.version,
    node_sha256: config.nodeHash, package_metadata_sha256: config.packageHash, direct_dependencies: entries,
    loaded_file_count: loaded.size,
    loaded_files_canonical_sha256: hash(JSON.stringify([...loaded].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([ref, sha256]) => ({ ref, sha256 })))), checks: Object.fromEntries(checks.map(key => [key, true])) };
} catch (cause) { failed = cause; }
finally {
  const closed = await Promise.allSettled(cleanup.reverse().map(close => close()));
  if (closed.some(value => value.status === 'rejected')) failed = new Error('RESTORE_PROBE_OFFLINE_CHECK_FAILED');
}
if (failed) {
  const code = codes.includes(failed.probeCode) ? failed.probeCode : 'RESTORE_PROBE_OFFLINE_CHECK_FAILED';
  process.stdout.write(JSON.stringify({ error: code })); process.exitCode = 1;
} else {
  // Cleanup may itself load code. Seal only after it finishes, and keep the hooks
  // active through natural process close so delayed imports cannot evade binding.
  report.loaded_file_count = loaded.size;
  report.loaded_files_canonical_sha256 = hash(JSON.stringify([...loaded].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([ref, sha256]) => ({ ref, sha256 }))));
  sealed = true;
  process.stdout.write(JSON.stringify(report));
}
} catch (cause) {
  const code = codes.includes(cause?.probeCode) ? cause.probeCode : 'RESTORE_PROBE_CHILD_FAILED';
  process.stdout.write(JSON.stringify({ error: code })); process.exitCode = 1;
}
`.replace('$NAMES_JSON$', JSON.stringify(NAMES)).replace('$CHECKS_JSON$', JSON.stringify(CHECKS)).replace('$CODES_JSON$', JSON.stringify(CODES));

function report(value: unknown, versions: Record<string, string>, resources: Readonly<Record<string, string>>, nodeVersion: string): RestoreRuntimeProbeReport {
  if (!object(value) || Object.keys(value).sort().join(',') !== ['format', 'scope', 'node_version', 'node_sha256', 'package_metadata_sha256',
    'direct_dependencies', 'loaded_file_count', 'loaded_files_canonical_sha256', 'checks'].sort().join(',') ||
    value.format !== 'relay-restore-runtime-probe-v1' || value.scope !== 'PACKAGED_DEPENDENCIES_OFFLINE_ONLY' ||
    value.node_version !== nodeVersion || value.node_sha256 !== resources['node.exe'] ||
    value.package_metadata_sha256 !== resources['api/package.json'] || !Array.isArray(value.direct_dependencies) ||
    value.direct_dependencies.length !== NAMES.length || !Number.isSafeInteger(value.loaded_file_count) ||
    typeof value.loaded_file_count !== 'number' || value.loaded_file_count < NAMES.length || value.loaded_file_count > 100_000 ||
    typeof value.loaded_files_canonical_sha256 !== 'string' || !HASH.test(value.loaded_files_canonical_sha256) || !object(value.checks) ||
    Object.keys(value.checks).sort().join(',') !== [...CHECKS].sort().join(',')) {
    throw new RestoreRuntimeProbeError('RESTORE_PROBE_CHILD_FAILED');
  }
  if (CHECKS.some(key => (value.checks as Record<string, unknown>)[key] !== true)) throw new RestoreRuntimeProbeError('RESTORE_PROBE_CHILD_FAILED');
  const entries: RestoreRuntimeProbeReport['direct_dependencies'][number][] = [];
  for (let index = 0; index < NAMES.length; index++) {
    const name = NAMES[index]!, entry = value.direct_dependencies[index];
    if (!object(entry) || Object.keys(entry).sort().join(',') !== ['name', 'version', 'entry_ref', 'entry_sha256', 'package_ref', 'package_sha256'].sort().join(',') ||
      entry.name !== name || entry.version !== versions[name] || typeof entry.entry_ref !== 'string' || !safeRef(entry.entry_ref) ||
      !entry.entry_ref.startsWith(`api/node_modules/${name}/`) || entry.entry_sha256 !== resources[entry.entry_ref] ||
      typeof entry.entry_sha256 !== 'string' || !HASH.test(entry.entry_sha256) || entry.package_ref !== `api/node_modules/${name}/package.json` ||
      entry.package_sha256 !== resources[`api/node_modules/${name}/package.json`] || typeof entry.package_sha256 !== 'string' || !HASH.test(entry.package_sha256)) {
      throw new RestoreRuntimeProbeError('RESTORE_PROBE_CHILD_FAILED');
    }
    entries.push({ name, version: versions[name]!, entry_ref: entry.entry_ref, entry_sha256: entry.entry_sha256,
      package_ref: `api/node_modules/${name}/package.json`, package_sha256: entry.package_sha256 });
  }
  return { format: 'relay-restore-runtime-probe-v1', scope: 'PACKAGED_DEPENDENCIES_OFFLINE_ONLY', node_version: nodeVersion,
    node_sha256: resources['node.exe']!, package_metadata_sha256: resources['api/package.json']!, direct_dependencies: entries,
    loaded_file_count: value.loaded_file_count, loaded_files_canonical_sha256: value.loaded_files_canonical_sha256,
    checks: Object.fromEntries(CHECKS.map(key => [key, true])) as RestoreRuntimeProbeReport['checks'] };
}

export async function probeRestoreRuntime(input: {
  packageRoot: string; resourceHashes: Readonly<Record<string, string>>; nodeVersion: string; signal: AbortSignal;
}): Promise<RestoreRuntimeProbeReport> {
  if (input.signal.aborted) throw new RestoreRuntimeProbeError('RESTORE_PROBE_ABORTED');
  try {
    if (process.platform !== 'win32' || !isAbsolute(input.packageRoot) || !/^[a-z]:[\\/]/iu.test(input.packageRoot) ||
      input.packageRoot.includes('\0') || input.packageRoot.slice(3).split(/[\\/]/u).some(p => p === '.' || p === '..' || p.includes(':')) ||
      !/^v24\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.test(input.nodeVersion) || !object(input.resourceHashes)) {
      throw new RestoreRuntimeProbeError('RESTORE_PROBE_INVALID_INPUT');
    }
    const resources: Record<string, string> = {}, aliases = new Set<string>();
    if (Object.keys(input.resourceHashes).length > 100_000) throw new RestoreRuntimeProbeError('RESTORE_PROBE_INVALID_INPUT');
    for (const [ref, hash] of Object.entries(input.resourceHashes)) {
      if (!safeRef(ref) || !HASH.test(hash) || aliases.has(ref.toLowerCase())) throw new RestoreRuntimeProbeError('RESTORE_PROBE_INVALID_INPUT');
      aliases.add(ref.toLowerCase()); resources[ref] = hash;
    }
    if (!resources['node.exe'] || !resources['api/package.json']) throw new RestoreRuntimeProbeError('RESTORE_PROBE_INVALID_INPUT');
    const root = resolve(input.packageRoot), node = join(root, 'node.exe'), packageFile = join(root, 'api/package.json');
    const paths = new Set([node, packageFile]);
    for (const path of [node, packageFile]) for (let parent = dirname(path);; parent = dirname(parent)) {
      paths.add(parent); const stat = await ordinary(parent);
      if (!stat.isDirectory()) throw new RestoreRuntimeProbeError('RESTORE_PROBE_PATH_UNAVAILABLE');
      if (parent === dirname(parent)) break;
    }
    await assertBackupWindowsPaths([...paths]);
    const initialNode = await ordinary(node), initialPackage = await ordinary(packageFile);
    await boundFile(node, resources['node.exe'], 256 * 1024 * 1024);
    const bytes = await boundFile(packageFile, resources['api/package.json'], 1024 * 1024, true);
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw new RestoreRuntimeProbeError('RESTORE_PROBE_DEPENDENCY_INVALID'); }
    const versions = dependencies(parsed);
    for (const name of NAMES) if (!resources[`api/node_modules/${name}/package.json`]) {
      throw new RestoreRuntimeProbeError('RESTORE_PROBE_DEPENDENCY_INVALID');
    }
    const payload = JSON.stringify({ packageRoot: root, resourceHashes: resources, nodeVersion: input.nodeVersion,
      dependencies: versions, packageHash: resources['api/package.json'], nodeHash: resources['node.exe'] });
    if (Buffer.byteLength(payload) > 32 * 1024 * 1024) throw new RestoreRuntimeProbeError('RESTORE_PROBE_INVALID_INPUT');
    if (input.signal.aborted) throw new RestoreRuntimeProbeError('RESTORE_PROBE_ABORTED');
    const env: NodeJS.ProcessEnv = {};
    for (const key of ['SystemRoot', 'WINDIR', 'SystemDrive', 'TEMP', 'TMP']) if (process.env[key] !== undefined) env[key] = process.env[key];
    const child = spawn(node, ['--input-type=module', '--eval', SCRIPT], { cwd: join(root, 'api'), env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const output: Buffer[] = []; let size = 0, errors = 0, failed: Code | undefined;
    const stop = (code: Code) => { failed ??= code; child.kill(); };
    const abort = () => stop('RESTORE_PROBE_ABORTED');
    const timer = setTimeout(() => stop('RESTORE_PROBE_TIMEOUT'), 60_000);
    input.signal.addEventListener('abort', abort, { once: true });
    if (input.signal.aborted) abort();
    child.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 65_536) stop('RESTORE_PROBE_OUTPUT_LIMIT'); else output.push(chunk); });
    child.stderr.on('data', (chunk: Buffer) => { errors += chunk.length; if (errors > 65_536) stop('RESTORE_PROBE_OUTPUT_LIMIT'); });
    child.stdin.on('error', () => stop('RESTORE_PROBE_CHILD_FAILED'));
    child.on('error', () => stop('RESTORE_PROBE_CHILD_FAILED'));
    const exit = await new Promise<number | null>(done => { child.once('close', done); child.stdin.end(payload); });
    clearTimeout(timer); input.signal.removeEventListener('abort', abort);
    if (failed) throw new RestoreRuntimeProbeError(failed);
    let result: unknown;
    try { result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(output))); }
    catch { throw new RestoreRuntimeProbeError('RESTORE_PROBE_CHILD_FAILED'); }
    if (exit !== 0) {
      const code = object(result) && Object.keys(result).length === 1 && typeof result.error === 'string' && CODES.includes(result.error as Code)
        ? result.error as Code : 'RESTORE_PROBE_CHILD_FAILED';
      throw new RestoreRuntimeProbeError(code);
    }
    const checked = report(result, versions, resources, input.nodeVersion);
    await assertBackupWindowsPaths([...paths]);
    await boundFile(node, resources['node.exe'], 256 * 1024 * 1024);
    await boundFile(packageFile, resources['api/package.json'], 1024 * 1024);
    for (const [path, before] of [[node, initialNode], [packageFile, initialPackage]] as const) {
      const after = await ordinary(path);
      if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size ||
          after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new RestoreRuntimeProbeError('RESTORE_PROBE_PATH_UNAVAILABLE');
    }
    if (input.signal.aborted) throw new RestoreRuntimeProbeError('RESTORE_PROBE_ABORTED');
    return checked;
  } catch (cause) {
    if (cause instanceof RestoreRuntimeProbeError) throw cause;
    throw new RestoreRuntimeProbeError('RESTORE_PROBE_PATH_UNAVAILABLE');
  }
}
