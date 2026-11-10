import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';

// Explicit live smoke: uses only SPARK_API_KEY, an isolated PostgreSQL cluster,
// and a task-owned directory. Never modifies a pre-existing workspace or service.
// Run from any directory with Node 24. Requires SPARK_API_KEY and a local Bearer
// token (process environment or apps/api/.env). Existing runtime/helper artifacts
// are required; this command never builds. Stopped test data is kept for review.
const repo = path.resolve(import.meta.dirname, '..');
const id = randomUUID().slice(0, 8);
const out = path.join(repo, 'tmp/BASIC-CHAIN-20261105', `files-${id}`);
const state = path.resolve(repo, '..', `.relay-file-smoke-${id}`);
const pgBin = path.join(repo, '.research/runtime-cache/postgresql-18.6-2/pgsql/bin');
const apiRoot = path.join(repo, 'apps/api');
const node = path.join(repo, '.research/runtime-cache/node-v24.21.0-win-x64/node.exe');
const cluster = path.join(out, 'cluster');
const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8', windowsHide: true });
if (head.status !== 0) throw Error('Cannot determine source baseline');
const evidence = { id, head: head.stdout.trim(), nodeVersion: process.version, checks: {} };
const disk = fs.statfsSync(repo);
if (disk.bavail * disk.bsize < 10 * 1024 ** 3) throw Error('Less than 10 GiB free; small isolated test not started');
for (const required of [node, path.join(repo, 'test-release/relay-file-io-helper.exe')]) {
  if (!fs.existsSync(required)) throw Error(`Required artifact missing: ${required}`);
}
const children = [];
let pgStarted = false;
let stage = 'setup';
const input = `SPARK_FILE_CHAIN_${randomUUID()}\n`;
const localEnv = {};
for (const line of fs.readFileSync(path.join(apiRoot, '.env'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Za-z0-9_]+)=(.*)$/.exec(line);
  if (m) localEnv[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
}
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (key.startsWith('RELAY_') || key === 'NODE_ENV') delete env[key];
}
if (!process.env.SPARK_API_KEY) throw Error('SPARK_API_KEY missing');
const bearer = process.env.RELAY_API_BEARER_TOKEN ?? localEnv.RELAY_API_BEARER_TOKEN;
if (!bearer) throw Error('RELAY_API_BEARER_TOKEN missing');
fs.mkdirSync(out, { recursive: true });
fs.mkdirSync(state);
fs.mkdirSync(path.join(out, 'workspace'));
fs.writeFileSync(path.join(out, 'workspace/input.txt'), input);
Object.assign(env, {
  RELAY_API_BEARER_TOKEN: bearer,
  RELAY_DATA_ROOT: state, RELAY_MODEL_PROVIDER: 'openai-compatible',
  RELAY_MODEL_API_KEY: process.env.SPARK_API_KEY,
  RELAY_MODEL_NAME: 'spark-x2.6', RELAY_MODEL_BASE_URL: 'https://maas-api.cn-huabei-1.xf-yun.com/v2',
  RELAY_MODEL_TIMEOUT_MS: '120000', RELAY_API_BIND_HOST: '127.0.0.1',
  RELAY_API_ALLOWED_ORIGINS: 'http://127.0.0.1:5173', RELAY_DB_POOL_MAX: '6',
  RELAY_DB_CONNECT_TIMEOUT_MS: '2000', RELAY_LOG_LEVEL: 'warn',
  RELAY_API_STOP_ON_STDIN_EOF: 'true',
  RELAY_FILE_IO_HELPER: path.join(repo, 'test-release/relay-file-io-helper.exe'),
  RELAY_CREDENTIAL_HELPER: path.join(repo, 'apps/credential-helper/target/x86_64-pc-windows-msvc/debug/relay-credential-helper.exe'),
});
function command(exe, args, name) {
  const log = fs.openSync(path.join(out, `${name}.log`), 'a');
  try {
    const result = spawnSync(exe, args, { cwd: apiRoot, env, windowsHide: true, stdio: ['ignore', log, log], timeout: 120000 });
    if (result.error || result.status !== 0) throw Error(`${name} failed (${result.error?.code ?? result.status})`);
  } finally { fs.closeSync(log); }
}
function launch(entry, name) {
  const log = fs.openSync(path.join(out, `${name}.log`), 'a');
  const child = spawn(node, [path.join(apiRoot, entry)], { cwd: apiRoot, env, windowsHide: true, stdio: ['pipe', log, log] });
  fs.closeSync(log);
  children.push(child);
  return child;
}
async function freePort() {
  const s = net.createServer();
  await new Promise((r, j) => { s.once('error', j); s.listen(0, '127.0.0.1', r); });
  const port = s.address().port;
  await new Promise(r => s.close(r));
  return port;
}
const delay = ms => new Promise(r => setTimeout(r, ms));
let base;
async function request(method, suffix, body) {
  const r = await fetch(base + suffix, { method, headers: { authorization: `Bearer ${env.RELAY_API_BEARER_TOKEN}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  const data = await r.json();
  if (!r.ok) throw Error(`${method} ${suffix}: ${r.status} ${data.code ?? ''} ${data.detail ?? ''}`);
  return data;
}
try {
  const pgPort = await freePort();
  const apiPort = await freePort();
  env.RELAY_API_PORT = String(apiPort);
  const url = user => `postgresql://${user}@127.0.0.1:${pgPort}/relay_file_smoke`;
  env.RELAY_DB_URL = url('relay_app');
  env.RELAY_MIGRATION_DB_URL = url('relay_migrator');
  stage = 'database';
  command(path.join(pgBin, 'initdb.exe'), ['-D', cluster, '-U', 'relay_api_admin', '-A', 'trust', '--encoding=UTF8', '--locale=C'], 'initdb');
  command(path.join(pgBin, 'pg_ctl.exe'), ['start', '-D', cluster, '-l', path.join(out, 'pg.log'), '-o', `-h 127.0.0.1 -p ${pgPort}`, '-w'], 'pg-start');
  pgStarted = true;
  const admin = `postgresql://relay_api_admin@127.0.0.1:${pgPort}/postgres`;
  command(path.join(pgBin, 'psql.exe'), [admin, '-w', '-v', 'ON_ERROR_STOP=1', '-f', path.join(apiRoot, 'sql/bootstrap-roles.sql')], 'roles');
  command(path.join(pgBin, 'psql.exe'), [admin, '-w', '-v', 'ON_ERROR_STOP=1', '-c', 'create database relay_file_smoke owner relay_migrator'], 'create-db');
  command(node, ['dist/src/cli/migrate.js'], 'migrate');
  command(node, ['dist/src/cli/install-graph.js'], 'graph');
  const workspaceId = randomUUID();
  command(node, ['dist/src/cli/init-workspace.js', '--name', 'Spark file smoke', '--workspace-id', workspaceId], 'workspace');
  evidence.workspaceId = workspaceId;
  evidence.apiPort = apiPort;
  base = `http://127.0.0.1:${apiPort}`;
  const api = launch('dist/src/main.js', 'api');
  stage = 'api-start';
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (api.exitCode !== null) throw Error('fresh API exited');
    try { await request('GET', '/health/ready'); ready = true; break; } catch {}
    await delay(300);
  }
  if (!ready) throw Error('fresh API readiness timeout');
  base += `/api/v1/workspaces/${workspaceId}`;
  stage = 'directory';
  const opened = (await request('POST', '/working-directories/open', { command_id: randomUUID(), root_path: path.join(out, 'workspace') })).result;
  const { project_id: projectId, resource_id: resourceId } = opened.association;
  await request('POST', `/projects/${projectId}/managed-resources/${resourceId}/local-access`, { command_id: randomUUID(), expected_revision: opened.write_readiness.access_revision, write_tier: 'FULL' });
  const session = (await request('POST', '/assist-sessions', { command_id: randomUUID(), project_id: projectId, title: 'Spark 单文件读写' })).result;
  const sessionId = session.session_id;
  evidence.sessionId = sessionId;
  await request('POST', `/assist-sessions/${sessionId}/working-directory`, { command_id: randomUUID(), resource_id: resourceId });
  stage = 'spark-file-round';
  const sent = (await request('POST', `/assist-sessions/${sessionId}/messages`, { command_id: randomUUID(), content: '请实际读取工作目录中的 input.txt，将它的完整原文（包括末尾换行）写入新文件 output.txt。请使用文件工具执行，不修改 input.txt，不创建其他文件，完成后简短回复。', intent: 'DISCUSS' })).result;
  evidence.assistantMessageId = sent.assistant_message_id;
  launch('dist/src/worker/main.js', 'worker');
  let message;
  for (let i = 0; i < 240; i++) {
    const messages = await request('GET', `/assist-sessions/${sessionId}/messages?limit=50`);
    message = messages.items.find(x => x.id === sent.assistant_message_id);
    if (message && ['COMPLETED', 'FAILED', 'CANCELLED'].includes(message.status)) break;
    await delay(1000);
  }
  evidence.message = message;
  // Content can complete before auxiliary model analysis. Keep our Worker alive
  // until the persisted calls settle; do not mistake an in-flight call for failure.
  let runtime;
  let settledSnapshots = 0;
  for (let i = 0; i < 90; i++) {
    runtime = await request('GET', `/assist-messages/${sent.assistant_message_id}/model-runtime`);
    settledSnapshots = runtime.calls?.length > 0 && runtime.calls.every(c => c.status !== 'STARTED')
      ? settledSnapshots + 1 : 0;
    if (settledSnapshots >= 2) break;
    await delay(1000);
  }
  evidence.runtime = runtime;
  evidence.checks.messageCompleted = message?.status === 'COMPLETED';
  evidence.checks.realSpark = runtime.calls?.length > 0 && runtime.calls.every(c => c.model === 'spark-x2.6' && c.status === 'COMPLETED');
  evidence.checks.outputMatchesInput = fs.existsSync(path.join(out, 'workspace/output.txt')) && fs.readFileSync(path.join(out, 'workspace/output.txt'), 'utf8') === input;
  evidence.checks.inputUnchanged = fs.readFileSync(path.join(out, 'workspace/input.txt'), 'utf8') === input;
  evidence.checks.noUnexpectedFiles = fs.readdirSync(path.join(out, 'workspace')).sort().join(',') === 'input.txt,output.txt';
  evidence.toolCalls = await request('GET', `/assist-sessions/${sessionId}/messages/${sent.assistant_message_id}/tool-calls`);
  const calls = evidence.toolCalls.rounds.flatMap(round => round.calls);
  evidence.checks.actualReadAndWrite = calls.some(c => c.tool_name === 'read_file' && c.status === 'SETTLED') &&
    calls.some(c => c.tool_name === 'apply_changeset' && c.status === 'SETTLED' && c.rejection_reason === null);
  const reread = await request('GET', `/assist-sessions/${sessionId}/messages?limit=50`);
  evidence.checks.persistedMessage = reread.items.some(m => m.id === sent.assistant_message_id && m.status === 'COMPLETED' && m.content === message.content);
  evidence.passed = Object.values(evidence.checks).every(Boolean);
  if (!evidence.passed) throw Error('file round did not satisfy all checks');
} catch (error) {
  evidence.passed = false;
  evidence.failedStage = stage;
  evidence.error = String(error.message).replaceAll(process.env.SPARK_API_KEY, '[redacted]');
  process.exitCode = 1;
} finally {
  for (const child of children.reverse()) {
    child.stdin.end();
    if (child.exitCode === null) child.kill();
    await Promise.race([new Promise(r => child.once('exit', r)), delay(5000)]);
  }
  if (pgStarted) command(path.join(pgBin, 'pg_ctl.exe'), ['stop', '-D', cluster, '-m', 'fast', '-w'], 'pg-stop');
  evidence.cleanup = { ownProcessesStopped: children.every(c => c.exitCode !== null || c.signalCode !== null), postgresStopped: pgStarted };
  fs.writeFileSync(path.join(out, 'evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ evidence: path.join(out, 'evidence.json'), passed: evidence.passed, stage: evidence.failedStage, error: evidence.error }));
}
