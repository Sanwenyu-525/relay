import assert from 'node:assert/strict';
import test from 'node:test';
import { Client, Pool, type ClientConfig } from 'pg';
import { maintenanceConnectionOptions } from '../../src/runtime/maintenance-connection.js';

interface Parameters {
  host: string; port: number; user: string; database: string; password: () => Promise<string>;
  ssl: ClientConfig['ssl']; options: string; client_encoding: string;
}
const parameters = (client: Client) => (client as Client & { connectionParameters: Parameters }).connectionParameters;
const sslOptions = (ssl: ClientConfig['ssl']) => typeof ssl === 'object' && ssl !== null ? { ...ssl } : ssl;

test('actual Client and Pool parameters ignore missing critical PG environment defaults without network', async () => {
  const environment = { PGHOST: 'unselected.invalid', PGPORT: '15432', PGUSER: 'unselected',
    PGDATABASE: 'unselected', PGPASSWORD: 'synthetic-only', PGSSLMODE: 'require',
    PGOPTIONS: '-c role=unselected', PGCLIENT_ENCODING: 'LATIN1' };
  const original = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  const pool = new Pool({ ...maintenanceConnectionOptions('postgresql://relay_app@127.0.0.1/selected'), max: 1 });
  try {
    Object.assign(process.env, environment);
    const config = maintenanceConnectionOptions('postgresql://relay_migrator@127.0.0.1/selected');
    for (const client of [new Client(config), new Client((pool as Pool & { options: ClientConfig }).options)]) {
      const actual = parameters(client);
      assert.equal(actual.host, '127.0.0.1'); assert.equal(actual.port, 5432);
      assert.equal(actual.database, 'selected'); assert.match(actual.user, /^relay_(app|migrator)$/u);
      assert.equal(actual.ssl, false); assert.equal(actual.options, '-c default_transaction_read_only=off');
      assert.equal(actual.client_encoding, 'UTF8'); assert.equal(typeof actual.password, 'function');
      assert.equal(await actual.password(), '');
    }
  } finally {
    await pool.end();
    for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test('explicit remote target, TLS and options preserve actual driver parsing and snapshot password', async () => {
  const url = 'postgresql://relay_migrator:explicit-secret@remote.example:5544/selected?sslmode=verify-full&options=-c%20statement_timeout%3D1234&client_encoding=UTF8';
  const original = new Client({ connectionString: url });
  const config = maintenanceConnectionOptions(url);
  const actual = parameters(new Client(config));
  for (const key of ['host', 'port', 'user', 'database', 'ssl', 'options', 'client_encoding'] as const) {
    assert.deepEqual(key === 'ssl' ? sslOptions(actual[key]) : actual[key],
      key === 'ssl' ? sslOptions(parameters(original)[key]) : parameters(original)[key]);
  }
  assert.equal(await actual.password(), 'explicit-secret');
  config.password = 'changed-after-construction';
  assert.equal(await actual.password(), 'explicit-secret');
});

test('legacy explicit ssl=no-verify keeps TLS enabled like the actual driver', () => {
  const url = 'postgresql://relay_migrator@remote.example:5544/selected?ssl=no-verify';
  const actual = parameters(new Client(maintenanceConnectionOptions(url)));
  assert.deepEqual(sslOptions(actual.ssl), sslOptions(parameters(new Client({ connectionString: url })).ssl));
  assert.deepEqual(sslOptions(actual.ssl), { rejectUnauthorized: false });
});

test('a nested connectionString query cannot select another driver target', async () => {
  const config = maintenanceConnectionOptions('postgresql://relay_migrator@127.0.0.1/selected?connectionString=postgresql%3A%2F%2Funselected%40remote.example%3A5544%2Fother');
  assert.equal(Object.hasOwn(config, 'connectionString'), false);
  const actual = parameters(new Client(config));
  assert.equal(actual.host, '127.0.0.1'); assert.equal(actual.port, 5432);
  assert.equal(actual.user, 'relay_migrator'); assert.equal(actual.database, 'selected');
  assert.equal(await actual.password(), '');
});

test('URL query fields cannot replace actual Client/Pool machinery or fixed caller budgets', async () => {
  const config = maintenanceConnectionOptions('postgresql://relay_migrator@127.0.0.1/selected?connection=synthetic&stream=x&Promise=x&Client=x&types=x&statement_timeout=1&connectionTimeoutMillis=1');
  assert.deepEqual(Object.keys(config).sort(), ['client_encoding', 'database', 'host', 'options', 'password', 'port', 'ssl', 'user']);
  const client = new Client({ ...config, statement_timeout: 5000, connectionTimeoutMillis: 5000 });
  const pool = new Pool({ ...config, max: 1 });
  assert.equal(parameters(client).host, '127.0.0.1');
  assert.equal((client as Client & { connectionParameters: { statement_timeout: number } }).connectionParameters.statement_timeout, 5000);
  await pool.end();
});

test('invalid or implicit maintenance targets fail with a fixed error without URL contents', () => {
  for (const url of ['postgresql://127.0.0.1/selected', 'postgresql://relay_migrator@127.0.0.1/',
    'postgresql:///selected', 'https://relay_migrator:synthetic-secret@remote.example/selected',
    'postgresql://relay_migrator@127.0.0.1/selected?port=123abc',
    'postgresql://relay_migrator@127.0.0.1/selected?port=65536',
    'postgresql://relay_migrator@127.0.0.1/selected?port=0']) {
    assert.throws(() => maintenanceConnectionOptions(url), { message: 'MAINTENANCE_CONNECTION_INVALID' });
  }
});
