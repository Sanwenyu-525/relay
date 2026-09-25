import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { sql } from 'kysely';
import { Client } from 'pg';

import type { DbExecutor } from './database.js';

// Root StateGraph invocations use checkpoint_ns="" in LangGraph 1.4.17.
// A new graph contract therefore gets a new physical schema, not a namespace.
export const GRAPH_CHECKPOINT_SCHEMA = 'relay_graph_v1';
const GRAPH_INSTALL_LOCK = 'relay:graph-checkpoints:v1';
const EXPECTED_MIGRATIONS = [0, 1, 2, 3, 4] as const;

/** Only the trusted migration process calls the official Saver setup. */
export async function installGraphCheckpoints(connectionString: string): Promise<void> {
  const lock = new Client({ connectionString, application_name: 'relay-graph-installer',
    connectionTimeoutMillis: 10_000 });
  await lock.connect();
  let held = false;
  try {
    // setup() obtains its own Pool client and does not run in our transaction.
    // Hold a session lock across its full migration and grants instead.
    await lock.query('select pg_advisory_lock(hashtextextended($1, 0))', [GRAPH_INSTALL_LOCK]);
    held = true;
    const saver = PostgresSaver.fromConnString(connectionString, { schema: GRAPH_CHECKPOINT_SCHEMA });
    try {
      await saver.setup();
    } finally {
      await saver.end();
    }
    const versions = await lock.query<{ v: number }>(
      `select v from ${GRAPH_CHECKPOINT_SCHEMA}.checkpoint_migrations order by v`,
    );
    if (!sameVersions(versions.rows.map((row) => row.v))) {
      throw new Error('graph checkpoint schema migration version mismatch');
    }
    await lock.query(`grant usage on schema ${GRAPH_CHECKPOINT_SCHEMA} to relay_app`);
    await lock.query(`grant select on ${GRAPH_CHECKPOINT_SCHEMA}.checkpoint_migrations to relay_app`);
    await lock.query(`grant select, insert, update on
      ${GRAPH_CHECKPOINT_SCHEMA}.checkpoints,
      ${GRAPH_CHECKPOINT_SCHEMA}.checkpoint_blobs,
      ${GRAPH_CHECKPOINT_SCHEMA}.checkpoint_writes to relay_app`);
  } finally {
    if (held) {
      await lock.query('select pg_advisory_unlock(hashtextextended($1, 0))', [GRAPH_INSTALL_LOCK]);
    }
    await lock.end();
  }
}

/** Runtime roles only inspect this fixed schema; they never run setup or DDL. */
export async function graphCheckpointsReady(db: DbExecutor, connectionString: string): Promise<boolean> {
  try {
    const versions = await sql<{ v: number }>`
      select v from relay_graph_v1.checkpoint_migrations order by v
    `.execute(db);
    if (!sameVersions(versions.rows.map((row) => row.v))) return false;
    const permission = await sql<{ usable: boolean; writable: boolean }>`
      select has_schema_privilege(current_user, 'relay_graph_v1', 'USAGE') as usable,
        (select bool_and(
          has_table_privilege(current_user, table_name, 'SELECT') and
          has_table_privilege(current_user, table_name, 'INSERT') and
          has_table_privilege(current_user, table_name, 'UPDATE'))
         from (values ('relay_graph_v1.checkpoints'),
                      ('relay_graph_v1.checkpoint_blobs'),
                      ('relay_graph_v1.checkpoint_writes')) as tables(table_name)) as writable
    `.execute(db);
    if (permission.rows[0]?.usable !== true || permission.rows[0]?.writable !== true) return false;
    // An empty official read checks the actual Saver SQL against the installed
    // tables/columns before any Run command can be claimed.
    const saver = PostgresSaver.fromConnString(connectionString, { schema: GRAPH_CHECKPOINT_SCHEMA });
    try {
      return await saver.getTuple({ configurable: {
        thread_id: 'relay:graph-readiness:reserved', checkpoint_ns: '',
      } }) === undefined;
    } finally {
      await saver.end();
    }
  } catch {
    return false;
  }
}

function sameVersions(actual: readonly number[]): boolean {
  return actual.length === EXPECTED_MIGRATIONS.length &&
    actual.every((version, index) => version === EXPECTED_MIGRATIONS[index]);
}
