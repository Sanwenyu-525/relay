// Seed real HTTP commands into a disposable release database before the desktop supervisor starts.
// The temporary API bearer exists only in this process and is never printed or written.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? '');
const count = Number(process.argv[3] ?? '1');
if (!/^relay-m02-acceptance-[0-9a-f]{32}$/iu.test(root.split(/[\\/]/u).at(-1) ?? '') ||
    !Number.isInteger(count) || count < 1 || count > 64) {
  throw new Error('Usage: node m03-seed-run.mjs <session-root> [1..64 Runs]');
}
const session = JSON.parse(readFileSync(join(root, 'session.json'), 'utf8').replace(/^\uFEFF/u, ''));
assert.equal(session.desktop_pid, 0, 'seed API must run before the Tauri host');
assert.equal(resolve(session.data_root), join(root, 'data'));
const releaseRoot = dirname(session.release_exe);
const environment = { ...process.env, RELAY_DATA_ROOT: session.data_root };
for (const key of Object.keys(environment)) {
  if (key.startsWith('NODE_') || key.startsWith('RELAY_')) delete environment[key];
}
environment.RELAY_DATA_ROOT = session.data_root;
const api = spawn(join(releaseRoot, 'node.exe'), [
  `--env-file=${session.config_path}`,
  join(releaseRoot, 'api', 'dist', 'src', 'main.js'), '--desktop-child',
], { cwd: releaseRoot, env: environment, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
const nonce = randomUUID().replaceAll('-', '');
const bearerToken = randomBytes(32).toString('hex');
const closed = new Promise((done, fail) => {
  api.once('error', fail);
  api.once('close', done);
});
async function closeWithin(milliseconds) {
  let timer;
  try {
    return await Promise.race([closed, new Promise((done) => {
      timer = setTimeout(() => done('timeout'), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}
let stopped = false;
try {
  const lines = createInterface({ input: api.stdout });
  const ready = new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error('Seed API did not become ready')), 30000);
    lines.on('line', (line) => {
      let event;
      try { event = JSON.parse(line); } catch { return; }
      if (event.nonce !== nonce) return;
      if (event.type === 'desktop_error') {
        clearTimeout(timer); fail(new Error(`Seed API rejected startup: ${event.code}`));
      } else if (event.type === 'desktop_ready') {
        clearTimeout(timer); done(event);
      }
    });
    api.once('close', () => { clearTimeout(timer); fail(new Error('Seed API exited before readiness')); });
  });
  api.stdin.write(`${JSON.stringify({ nonce, bearerToken })}\n`);
  const event = await ready;
  assert.equal(event.workspaceId, session.workspace_id);
  assert.equal(event.nodeVersion, 'v24.21.0');
  assert.ok(Number.isInteger(event.port) && event.port >= 1 && event.port <= 65535);
  const baseUrl = `http://127.0.0.1:${event.port}/api/v1/workspaces/${session.workspace_id}`;
  async function post(suffix, body, expectedStatus) {
    const response = await fetch(`${baseUrl}${suffix}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bearerToken}`,
        origin: 'http://tauri.localhost', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, expectedStatus, `POST ${suffix} returned ${response.status}`);
    const envelope = await response.json();
    assert.equal(envelope.command_id, body.command_id);
    return envelope.result;
  }
  const project = await post('/projects', {
    command_id: randomUUID(), title: 'M03 desktop Job recovery', project_type: 'GENERAL',
  }, 201);
  const runs = [];
  for (let index = 0; index < count; index += 1) {
    const task = await post('/tasks', {
      command_id: randomUUID(), project_id: project.project_id,
      title: `M03 controlled Mock Worker ${index + 1}`,
      objective: 'Verify one durable Mock Run after host stop',
      criteria: [{ statement: 'The Mock result remains attributable to this task' }],
    }, 201);
    const readyTask = await post(`/tasks/${task.task_id}/ready`, {
      command_id: randomUUID(), expected_revision: task.revision,
    }, 200);
    const commandId = randomUUID();
    const delegated = await post(`/tasks/${task.task_id}/delegations`, {
      command_id: commandId, expected_task_revision: readyTask.revision,
    }, 202);
    assert.equal(delegated.task_id, task.task_id);
    runs.push({ task_id: task.task_id, run_id: delegated.run_id, command_id: commandId });
  }
  api.stdin.end();
  assert.equal(await closeWithin(7000),
    0, 'Seed API failed to stop on private stdin EOF');
  stopped = true;
  console.log(JSON.stringify({ ...runs[0], runs, seed_api_exit: 0 }));
} finally {
  if (!stopped) {
    api.stdin.end();
    const result = await closeWithin(3000);
    if (result === 'timeout') { api.kill(); await closed; }
  }
}
