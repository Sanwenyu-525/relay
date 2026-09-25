import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { Annotation, Command, END, START, StateGraph, interrupt } from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import pg from "pg";

const CHECKPOINT_SCHEMA = "relay_graph_m01";
const PROBE_SCHEMA = "relay_probe_m01";
const migrationUrl = process.env.RELAY_M01_MIGRATION_URL;
const appUrl = process.env.RELAY_M01_APP_URL;
assert.ok(migrationUrl && appUrl, "run through scripts/run-real-pg.ps1");

const migration = new pg.Client({ connectionString: migrationUrl });
const app = new pg.Client({ connectionString: appUrl });
let saver;

before(async () => {
  await migration.connect();
  await app.connect();

  // setup() is run once by a DDL role with a fixed, trusted schema name.
  const installer = PostgresSaver.fromConnString(migrationUrl, { schema: CHECKPOINT_SCHEMA });
  try {
    await installer.setup();
  } finally {
    await installer.end();
  }
  await migration.query(`grant usage on schema ${CHECKPOINT_SCHEMA} to relay_app`);
  await migration.query(`
    grant select, insert, update, delete on
      ${CHECKPOINT_SCHEMA}.checkpoints,
      ${CHECKPOINT_SCHEMA}.checkpoint_blobs,
      ${CHECKPOINT_SCHEMA}.checkpoint_writes
    to relay_app
  `);

  await migration.query(`create schema ${PROBE_SCHEMA}`);
  await migration.query(`
    create table ${PROBE_SCHEMA}.node_visits (
      node text not null,
      operation_id text not null,
      visited_at timestamptz not null default now()
    );
    create table ${PROBE_SCHEMA}.business_effects (
      operation_id text primary key,
      result text not null
    );
    create table ${PROBE_SCHEMA}.run_commands (
      id text primary key,
      operation_id text not null unique
    );
    create table ${PROBE_SCHEMA}.run_outbox (
      command_id text primary key references ${PROBE_SCHEMA}.run_commands(id),
      status text not null default 'READY',
      claim_epoch bigint not null default 0,
      worker_id text
    );
  `);
  await migration.query(`grant usage on schema ${PROBE_SCHEMA} to relay_app`);
  await migration.query(`grant select, insert, update, delete on all tables in schema ${PROBE_SCHEMA} to relay_app`);

  saver = PostgresSaver.fromConnString(appUrl, { schema: CHECKPOINT_SCHEMA });
});

after(async () => {
  if (saver) await saver.end();
  await app.end();
  await migration.end();
});

test("PostgresSaver setup is separate from Relay migration and runtime DDL authority", async () => {
  const { rows } = await app.query(`
    select
      has_schema_privilege(current_user, '${CHECKPOINT_SCHEMA}', 'USAGE') as can_use,
      has_schema_privilege(current_user, '${CHECKPOINT_SCHEMA}', 'CREATE') as can_create,
      has_table_privilege(current_user, '${CHECKPOINT_SCHEMA}.checkpoints', 'INSERT') as can_insert
  `);
  assert.deepEqual(rows[0], { can_use: true, can_create: false, can_insert: true });
  await assert.rejects(app.query(`create table ${CHECKPOINT_SCHEMA}.runtime_ddl_denied (id int)`),
    { code: "42501" });
  await assert.rejects(app.query(`update ${CHECKPOINT_SCHEMA}.checkpoint_migrations set v=v`),
    { code: "42501" });

  const migrations = await migration.query(`select count(*)::int as count from ${CHECKPOINT_SCHEMA}.checkpoint_migrations`);
  assert.ok(migrations.rows[0].count > 0);
  const relayLedger = await migration.query(`select to_regclass('public.relay_schema_migrations') as name`);
  assert.equal(relayLedger.rows[0].name, null);
});

const State = Annotation.Root({
  operationId: Annotation(),
  approved: Annotation(),
  result: Annotation(),
});

function createGraph(checkpointer, crashAfterBusinessCommit) {
  return new StateGraph(State)
    .addNode("approval", async (state) => {
      await app.query(`insert into ${PROBE_SCHEMA}.node_visits (node, operation_id) values ('approval', $1)`, [state.operationId]);
      const decision = interrupt({ operation_id: state.operationId, type: "APPROVE" });
      return { approved: decision.approved };
    })
    .addNode("business", async (state) => {
      assert.equal(state.approved, true);
      await app.query(`insert into ${PROBE_SCHEMA}.node_visits (node, operation_id) values ('business', $1)`, [state.operationId]);
      // A short business transaction under a stable operation identity.
      await app.query("begin");
      try {
        await app.query(`
          insert into ${PROBE_SCHEMA}.business_effects (operation_id, result)
          values ($1, 'committed') on conflict (operation_id) do nothing
        `, [state.operationId]);
        await app.query("commit");
      } catch (error) {
        await app.query("rollback");
        throw error;
      }
      if (crashAfterBusinessCommit()) throw new Error("m01_after_business_commit_before_checkpoint");
      const result = await app.query(`select result from ${PROBE_SCHEMA}.business_effects where operation_id=$1`, [state.operationId]);
      return { result: result.rows[0].result };
    })
    .addEdge(START, "approval")
    .addEdge("approval", "business")
    .addEdge("business", END)
    .compile({ checkpointer });
}

test("official PostgresSaver persists interrupt; resumed node re-enters; business commit before checkpoint replays", async () => {
  const operationId = "m01-graph-operation-1";
  const config = { configurable: { thread_id: "m01-graph-thread-1" }, durability: "sync" };
  let crash = true;
  let graph = createGraph(saver, () => {
    if (!crash) return false;
    crash = false;
    return true;
  });

  await graph.invoke({ operationId }, config);
  let state = await graph.getState(config);
  assert.deepEqual(state.next, ["approval"]);
  assert.equal(state.tasks[0].interrupts[0].value.operation_id, operationId);

  // A new saver/graph uses the database checkpoint after the simulated process restart.
  await saver.end();
  saver = PostgresSaver.fromConnString(appUrl, { schema: CHECKPOINT_SCHEMA });
  graph = createGraph(saver, () => {
    if (!crash) return false;
    crash = false;
    return true;
  });
  await assert.rejects(graph.invoke(new Command({ resume: { approved: true } }), config),
    /m01_after_business_commit_before_checkpoint/);

  const committed = await app.query(`select result from ${PROBE_SCHEMA}.business_effects where operation_id=$1`, [operationId]);
  assert.equal(committed.rowCount, 1);
  state = await graph.getState(config);
  assert.deepEqual(state.next, ["business"]);
  assert.equal(state.values.result, undefined);

  await saver.end();
  saver = PostgresSaver.fromConnString(appUrl, { schema: CHECKPOINT_SCHEMA });
  graph = createGraph(saver, () => false);
  const final = await graph.invoke(null, config);
  assert.equal(final.result, "committed");
  const visits = await app.query(`
    select node, count(*)::int as count from ${PROBE_SCHEMA}.node_visits
    where operation_id=$1 group by node order by node
  `, [operationId]);
  assert.deepEqual(visits.rows, [
    { node: "approval", count: 2 },
    { node: "business", count: 2 },
  ]);
  const effects = await app.query(`select count(*)::int as count from ${PROBE_SCHEMA}.business_effects where operation_id=$1`, [operationId]);
  assert.equal(effects.rows[0].count, 1);
});

test("one PG transaction creates command and outbox; two workers cannot claim one row", async () => {
  const commandId = "m01-command-1";
  const operationId = "m01-command-operation-1";
  await app.query("begin");
  await app.query(`insert into ${PROBE_SCHEMA}.run_commands (id, operation_id) values ($1,$2)`, [commandId, operationId]);
  await app.query(`insert into ${PROBE_SCHEMA}.run_outbox (command_id) values ($1)`, [commandId]);
  await app.query("rollback");
  const absent = await app.query(`select count(*)::int as count from ${PROBE_SCHEMA}.run_commands`);
  assert.equal(absent.rows[0].count, 0);

  await app.query("begin");
  await app.query(`insert into ${PROBE_SCHEMA}.run_commands (id, operation_id) values ($1,$2)`, [commandId, operationId]);
  await app.query(`insert into ${PROBE_SCHEMA}.run_outbox (command_id) values ($1)`, [commandId]);
  await app.query("commit");

  const first = new pg.Client({ connectionString: appUrl });
  const second = new pg.Client({ connectionString: appUrl });
  await Promise.all([first.connect(), second.connect()]);
  try {
    const claimSql = `
      with candidate as (
        select command_id from ${PROBE_SCHEMA}.run_outbox
        where status='READY' order by command_id
        for update skip locked limit 1
      )
      update ${PROBE_SCHEMA}.run_outbox o
      set status='CLAIMED', claim_epoch=o.claim_epoch+1, worker_id=$1
      from candidate where o.command_id=candidate.command_id
      returning o.command_id, o.claim_epoch::text, o.worker_id
    `;
    const [a, b] = await Promise.all([
      first.query(claimSql, ["worker-a"]),
      second.query(claimSql, ["worker-b"]),
    ]);
    assert.equal(a.rowCount + b.rowCount, 1);
    const winner = a.rows[0] ?? b.rows[0];
    assert.equal(winner.claim_epoch, "1");
    const loser = winner.worker_id === "worker-a" ? "worker-b" : "worker-a";
    const stale = await app.query(`
      update ${PROBE_SCHEMA}.run_outbox set status='DONE'
      where command_id=$1 and worker_id=$2 and claim_epoch=1 and status='CLAIMED'
    `, [commandId, loser]);
    assert.equal(stale.rowCount, 0);
    const done = await app.query(`
      update ${PROBE_SCHEMA}.run_outbox set status='DONE'
      where command_id=$1 and worker_id=$2 and claim_epoch=1 and status='CLAIMED'
    `, [commandId, winner.worker_id]);
    assert.equal(done.rowCount, 1);
  } finally {
    await Promise.all([first.end(), second.end()]);
  }
});
