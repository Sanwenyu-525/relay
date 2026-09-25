import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

import type { ProbeDatabase } from '../src/database.js';

export function createProbeMigration(schema: string): Migration {
  return {
    async up(db: Kysely<ProbeDatabase>): Promise<void> {
      const pauseMilliseconds = Number(process.env.P00_MIGRATION_PAUSE_MS ?? '0');
      if (Number.isInteger(pauseMilliseconds) && pauseMilliseconds > 0) {
        await sql`select pg_sleep(${pauseMilliseconds / 1_000})`.execute(db);
      }

      await db.schema
        .withSchema(schema)
        .createTable('p00_probe_records')
        .addColumn('id', 'varchar(64)', (column) => column.primaryKey())
        .addColumn('revision', 'bigint', (column) =>
          column.notNull().defaultTo(0),
        )
        .addColumn('note', 'text', (column) => column.notNull())
        .execute();
    },
  };
}
