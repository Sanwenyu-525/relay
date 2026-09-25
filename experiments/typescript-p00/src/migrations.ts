import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import type { Kysely } from 'kysely';
import type { Migration, MigrationProvider } from 'kysely/migration';

import { assertSafeIdentifier } from './config.js';
import {
  connectProbeDatabase,
  destroyProbeDatabase,
} from './database.js';
import type { ProbeConnection, ProbeDatabase } from './database.js';

const MIGRATION_GATE_NAMESPACE = 'relay_p00_migration_integrity_v1';

interface LoadedMigration {
  migration: Migration;
  name: string;
  sha256: Buffer;
}

interface MigrationCatalog {
  byName: ReadonlyMap<string, LoadedMigration>;
  provider: MigrationProvider;
}

interface MigrationResult {
  executed: readonly string[];
}

export class MigrationIntegrityError extends Error {
  override name = 'MigrationIntegrityError';
}

export async function migrateWithKyselyOnly(
  db: Kysely<ProbeDatabase>,
  migrationDirectory: string,
  schema: string,
): Promise<MigrationResult> {
  const catalog = await loadMigrationCatalog(migrationDirectory, schema);
  return migrateCatalogWithKysely(db, catalog, schema);
}

async function migrateCatalogWithKysely(
  db: Kysely<ProbeDatabase>,
  catalog: MigrationCatalog,
  schema: string,
): Promise<MigrationResult> {
  const migrator = new Migrator({
    db,
    migrationLockTableName: 'p00_kysely_migration_lock',
    migrationTableName: 'p00_kysely_migration',
    migrationTableSchema: schema,
    provider: catalog.provider,
  });
  const result = await migrator.migrateToLatest();

  if (result.error) {
    throw result.error;
  }

  const failed = result.results?.find((item) => item.status === 'Error');
  if (failed) {
    throw new Error(`Kysely migration failed: ${failed.migrationName}`);
  }

  return {
    executed:
      result.results
        ?.filter((item) => item.status === 'Success')
        .map((item) => item.migrationName) ?? [],
  };
}

export async function migrateWithIntegrity(
  connection: ProbeConnection,
  migrationDirectory: string,
  schema: string,
): Promise<MigrationResult> {
  assertSafeIdentifier(schema, 'schema');

  const migrationConnection = connectProbeDatabase(connection.connectionString);
  try {
    return await migrateWithDedicatedConnection(
      migrationConnection,
      migrationDirectory,
      schema,
    );
  } finally {
    await destroyProbeDatabase(migrationConnection);
  }
}

async function migrateWithDedicatedConnection(
  connection: ProbeConnection,
  migrationDirectory: string,
  schema: string,
): Promise<MigrationResult> {
  return connection.db.transaction().execute(async (transaction) => {
    await sql`select pg_advisory_xact_lock(hashtextextended(${`${MIGRATION_GATE_NAMESPACE}:${schema}`}, 0))`.execute(
      transaction,
    );
    await ensureIntegrityTable(transaction, schema);

    const catalog = await loadMigrationCatalog(migrationDirectory, schema);
    const executedBefore = await listExecutedMigrations(transaction, schema);
    const recordedBefore = await listRecordedDigests(transaction, schema);

    verifyAppliedMigrationIntegrity(catalog, executedBefore, recordedBefore);

    const result = await migrateCatalogWithKysely(transaction, catalog, schema);
    const executedAfter = await listExecutedMigrations(transaction, schema);
    const recordedAfter = await listRecordedDigests(transaction, schema);

    for (const name of executedAfter) {
      const current = catalog.byName.get(name);
      if (!current) {
        throw new MigrationIntegrityError(
          `applied migration ${name} is missing from the current directory`,
        );
      }

      const recorded = recordedAfter.get(name);
      if (recorded && !recorded.equals(current.sha256)) {
        throw new MigrationIntegrityError(
          `applied migration ${name} content digest changed`,
        );
      }

      if (!recorded) {
        await transaction
          .withSchema(schema)
          .insertInto('p00_migration_integrity')
          .values({
            content_sha256: current.sha256,
            name,
          })
          .execute();
      }
    }

    return result;
  });
}

async function loadMigrationCatalog(
  migrationDirectory: string,
  schema: string,
): Promise<MigrationCatalog> {
  const entries = await readdir(migrationDirectory, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => entry.name)
    .sort();
  const migrations = new Map<string, LoadedMigration>();

  for (const fileName of files) {
    const name = fileName.slice(0, -'.ts'.length);
    const filePath = join(migrationDirectory, fileName);
    const source = await readFile(filePath);
    const sha256 = createHash('sha256').update(source).digest();
    const moduleUrl = `${pathToFileURL(filePath).href}?sha256=${sha256.toString('hex')}`;
    const loaded = (await import(moduleUrl)) as {
      createProbeMigration?: (schemaName: string) => Migration;
    };

    if (!loaded.createProbeMigration) {
      throw new Error(`${fileName} must export createProbeMigration(schema)`);
    }

    migrations.set(name, {
      migration: loaded.createProbeMigration(schema),
      name,
      sha256,
    });
  }

  return {
    byName: migrations,
    provider: {
      async getMigrations(): Promise<Record<string, Migration>> {
        return Object.fromEntries(
          [...migrations.values()].map((item) => [item.name, item.migration]),
        );
      },
    },
  };
}

async function ensureIntegrityTable(
  db: Kysely<ProbeDatabase>,
  schema: string,
): Promise<void> {
  await db.schema.createSchema(schema).ifNotExists().execute();
  await db.schema
    .withSchema(schema)
    .createTable('p00_migration_integrity')
    .ifNotExists()
    .addColumn('name', 'varchar(255)', (column) => column.notNull().primaryKey())
    .addColumn('content_sha256', 'bytea', (column) => column.notNull())
    .addCheckConstraint(
      'p00_migration_integrity_sha256_length',
      sql`octet_length(content_sha256) = 32`,
    )
    .execute();
}

async function listExecutedMigrations(
  db: Kysely<ProbeDatabase>,
  schema: string,
): Promise<readonly string[]> {
  const tableExists = await sql<{ exists: boolean }>`
    select to_regclass(${`${schema}.p00_kysely_migration`}) is not null as exists
  `.execute(db);

  if (!tableExists.rows[0]?.exists) {
    return [];
  }

  const rows = await db
    .withSchema(schema)
    .selectFrom('p00_kysely_migration')
    .select('name')
    .execute();

  return rows.map((row) => row.name);
}

async function listRecordedDigests(
  db: Kysely<ProbeDatabase>,
  schema: string,
): Promise<ReadonlyMap<string, Buffer>> {
  const rows = await db
    .withSchema(schema)
    .selectFrom('p00_migration_integrity')
    .select(['name', 'content_sha256'])
    .execute();

  return new Map(rows.map((row) => [row.name, Buffer.from(row.content_sha256)]));
}

function verifyAppliedMigrationIntegrity(
  catalog: MigrationCatalog,
  executed: readonly string[],
  recorded: ReadonlyMap<string, Buffer>,
): void {
  for (const name of executed) {
    const current = catalog.byName.get(name);
    if (!current) {
      throw new MigrationIntegrityError(
        `applied migration ${name} is missing from the current directory`,
      );
    }

    const expected = recorded.get(name);
    if (!expected) {
      throw new MigrationIntegrityError(
        `applied migration ${name} has no recorded content digest`,
      );
    }

    if (!expected.equals(current.sha256)) {
      throw new MigrationIntegrityError(
        `applied migration ${name} content digest changed`,
      );
    }
  }
}
