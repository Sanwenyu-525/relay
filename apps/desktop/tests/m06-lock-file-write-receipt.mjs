// Hold the original Invocation row in a disposable acceptance database so a
// packaged FILE_WRITE can finish on disk before its adapter receipt is saved.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

const [rootArg, operationId, readyArg, releaseArg] = process.argv.slice(2);
const root = resolve(rootArg ?? '');
assert.match(basename(root), /^relay-m02-acceptance-[0-9a-f]{32}$/iu);
assert.match(operationId ?? '', /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu);
assert.equal(await realpath(root), root);
const ready = resolve(readyArg ?? '');
const release = resolve(releaseArg ?? '');
assert.equal(dirname(ready), root);
assert.equal(dirname(release), root);
const session = JSON.parse(await readFile(join(root, 'session.json'), 'utf8'));
assert.ok(Number.isInteger(session.desktop_pid) && session.desktop_pid >= 0);
assert.equal(resolve(session.data_root), join(root, 'data'));
const config = await readFile(session.config_path, 'utf8');
const line = config.replace(/^\uFEFF/u, '').split(/\r?\n/u)
  .find((entry) => entry.startsWith('RELAY_DB_URL='));
assert.ok(line);
const url = new URL(line.slice('RELAY_DB_URL='.length));
assert.equal(url.hostname, '127.0.0.1');
assert.equal(Number(url.port), session.postgres_port);
const requireRelease = createRequire(join(dirname(session.release_exe), 'api', 'package.json'));
const { Client } = requireRelease('pg');
const db = new Client({ connectionString: url.href, connectionTimeoutMillis: 5000 });
await db.connect();
let locked = false;
try {
  const deadline = Date.now() + 70_000;
  while (Date.now() < deadline) {
    const candidate = (await db.query(`select id, status, result_ref from invocation_attempts
      where operation_id=$1 order by attempt_number desc limit 1`, [operationId])).rows[0];
    if (candidate?.result_ref !== null && candidate !== undefined) {
      throw new Error('FILE_WRITE receipt was saved before the row lock');
    }
    if (candidate?.status === 'DISPATCHING') {
      await db.query('begin');
      try {
        await db.query("set local lock_timeout = '100ms'");
        const row = (await db.query(`select id, status, result_ref from invocation_attempts
          where id=$1 for update`, [candidate.id])).rows[0];
        if (row?.status === 'DISPATCHING' && row.result_ref === null) {
          locked = true;
          await writeFile(ready, JSON.stringify({ invocation_id: row.id, pid: process.pid }));
          while (Date.now() < deadline && !(await readFile(release).then(() => true, () => false))) {
            await new Promise((done) => setTimeout(done, 20));
          }
          if (!(await readFile(release).then(() => true, () => false))) {
            throw new Error('receipt row lock release timed out');
          }
          // Windows Job death does not synchronously cancel a PostgreSQL backend
          // already waiting for this row. Terminate only the original receipt
          // UPDATE in this disposable database before dropping the lock.
          const waiting = (await db.query(`select pid from pg_stat_activity
            where pid <> pg_backend_pid() and usename = current_user
              and state = 'active' and query ~* '^[[:space:]]*update[[:space:]]+invocation_attempts[[:space:]]+set[[:space:]]+result_ref'`)).rows;
          for (const row of waiting) {
            const stopped = (await db.query('select pg_terminate_backend($1) as stopped',
              [row.pid])).rows[0]?.stopped;
            if (stopped !== true) throw new Error('blocked receipt database backend could not be terminated');
          }
          if (waiting.length > 0) await new Promise((done) => setTimeout(done, 250));
          break;
        }
      } catch (error) {
        if (error.code !== '55P03') throw error;
      } finally {
        await db.query('rollback');
      }
    }
    await new Promise((done) => setTimeout(done, 5));
  }
  if (!locked) throw new Error('original DISPATCHING Invocation was not locked');
} finally {
  await db.end();
}
