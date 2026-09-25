import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import test from 'node:test';

import { sql } from 'kysely';

import { RelayDatabase } from '../../src/infrastructure/database.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import type { SchemaReadinessChecker } from '../../src/infrastructure/schema-readiness.js';
import {
  MIGRATIONS_DIRECTORY,
  createMigrationDirectoryFixture,
  createTemporaryDatabase,
  openDatabase,
} from './integration-support.js';
import {
  baseEnvironment,
  createDataRoot,
  pickFreePort,
  sendRequest,
  startApi,
  stopApi,
  waitForLiveness,
} from './api-harness.js';

interface ReadinessApi {
  readonly port: number;
  readonly token: string;
  readonly dataRoot: string;
  readonly running: ReturnType<typeof startApi>;
}

async function startReadinessApi(databaseUrl: string): Promise<ReadinessApi> {
  const port = await pickFreePort();
  const token = randomBytes(32).toString('hex');
  const dataRoot = await createDataRoot();
  const running = startApi(
    baseEnvironment({
      port,
      allowedOrigin: `http://127.0.0.1:${await pickFreePort()}`,
      bearerToken: token,
      dataRoot,
      databaseUrl,
    }),
  );

  await waitForLiveness(running, port);
  return { port, token, dataRoot, running };
}

async function stopReadinessApi(api: ReadinessApi): Promise<void> {
  try {
    assert.equal(await stopApi(api.running), 0);
  } finally {
    await rm(api.dataRoot, { recursive: true, force: true });
  }
}

async function getReadiness(api: ReadinessApi) {
  return sendRequest(api.port, 'GET', '/health/ready', {
    headers: { authorization: `Bearer ${api.token}` },
  });
}

function assertSchemaUnavailable(response: Awaited<ReturnType<typeof getReadiness>>): void {
  assert.equal(response.status, 503);
  assert.equal((response.body as { code: string }).code, 'SCHEMA_UNAVAILABLE');
  assert.deepEqual((response.body as { components: unknown }).components, {
    database: { status: 'up' },
    schema: { status: 'down' },
  });
}

test('keeps liveness available but rejects readiness for an empty database', async () => {
  const database = await createTemporaryDatabase('schema_empty');
  const api = await startReadinessApi(database.appUrl);

  try {
    const live = await sendRequest(api.port, 'GET', '/health/live');
    assert.deepEqual(live.body, { status: 'alive' });
    assertSchemaUnavailable(await getReadiness(api));
  } finally {
    await stopReadinessApi(api);
    await database.drop();
  }
});

test('rechecks database reachability when the schema check fails', async () => {
  const database = await createTemporaryDatabase('schema_disconnect');
  const relayDatabase = new RelayDatabase(
    {
      databaseUrl: database.appUrl,
      databasePoolMax: 1,
      databaseConnectTimeoutMs: 2000,
    },
    () => {},
  );
  let dropped = false;

  const disconnectingChecker = {
    check: async () => {
      await database.drop();
      dropped = true;
      return { compatible: false };
    },
  } as unknown as SchemaReadinessChecker;

  try {
    const probe = await relayDatabase.checkReadiness(disconnectingChecker);
    assert.deepEqual(probe, { database: 'down', schema: 'unknown' });
  } finally {
    await relayDatabase.close();
    if (!dropped) {
      await database.drop();
    }
  }
});

test('rejects readiness when the latest schema compatibility migration is missing', async () => {
  const database = await createTemporaryDatabase('schema_missing');
  // 移除最新的兼容性迁移：本地发布物的 manifest 与数据库已应用集合不再一致。
  const directory = await createMigrationDirectoryFixture((files) => {
    files.delete('0010_v005_context_revision.sql');
  });

  try {
    await runMigrations({ connectionString: database.migrationUrl, directory });
    const api = await startReadinessApi(database.appUrl);

    try {
      assertSchemaUnavailable(await getReadiness(api));
    } finally {
      await stopReadinessApi(api);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
    await database.drop();
  }
});

test('reports database and schema as up only for the current migration manifest', async () => {
  const database = await createTemporaryDatabase('schema_current');

  try {
    await runMigrations({ connectionString: database.migrationUrl, directory: MIGRATIONS_DIRECTORY });
    const api = await startReadinessApi(database.appUrl);

    try {
      const response = await getReadiness(api);
      assert.equal(response.status, 200);
      assert.deepEqual(response.body, {
        status: 'ready',
        components: {
          database: { status: 'up' },
          schema: { status: 'up' },
        },
      });
    } finally {
      await stopReadinessApi(api);
    }
  } finally {
    await database.drop();
  }
});

test('rejects an unknown future migration recorded by the database', async () => {
  const database = await createTemporaryDatabase('schema_future');

  try {
    await runMigrations({ connectionString: database.migrationUrl, directory: MIGRATIONS_DIRECTORY });
    const migration = openDatabase(database.migrationUrl, 'relay-api-test-schema-future');

    try {
      await sql`
        insert into relay_schema_migrations (name, content_sha256)
        values ('9999_future_schema', ${Buffer.alloc(32, 7)})
      `.execute(migration.db);
    } finally {
      await migration.close();
    }

    const api = await startReadinessApi(database.appUrl);
    try {
      assertSchemaUnavailable(await getReadiness(api));
    } finally {
      await stopReadinessApi(api);
    }
  } finally {
    await database.drop();
  }
});

test('rejects a recorded migration whose SHA-256 no longer matches the release manifest', async () => {
  const database = await createTemporaryDatabase('schema_hash');

  try {
    await runMigrations({ connectionString: database.migrationUrl, directory: MIGRATIONS_DIRECTORY });
    const migration = openDatabase(database.migrationUrl, 'relay-api-test-schema-hash');

    try {
      await sql`
        update relay_schema_migrations
        set content_sha256 = ${Buffer.alloc(32, 9)}
        where name = '0001_v001_human_core'
      `.execute(migration.db);
    } finally {
      await migration.close();
    }

    const api = await startReadinessApi(database.appUrl);
    try {
      assertSchemaUnavailable(await getReadiness(api));
    } finally {
      await stopReadinessApi(api);
    }
  } finally {
    await database.drop();
  }
});
