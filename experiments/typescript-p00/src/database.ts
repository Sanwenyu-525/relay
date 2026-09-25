import { Kysely, PostgresDialect } from 'kysely';
import { Pool, types } from 'pg';

types.setTypeParser(types.builtins.INT8, (value: string) => BigInt(value));

export interface ProbeDatabase {
  p00_bigint_values: {
    id: string;
    value: bigint;
  };
  p00_cas_rows: {
    id: string;
    revision: bigint;
  };
  p00_kysely_migration: {
    name: string;
    timestamp: string;
  };
  p00_migration_integrity: {
    content_sha256: Buffer;
    name: string;
  };
  p00_probe_records: {
    id: string;
    note: string;
    revision: bigint;
  };
}

export interface ProbeConnection {
  connectionString: string;
  db: Kysely<ProbeDatabase>;
  pool: Pool;
}

export function connectProbeDatabase(connectionString: string): ProbeConnection {
  const pool = new Pool({
    connectionString,
    max: 8,
  });

  return {
    connectionString,
    db: new Kysely<ProbeDatabase>({
      dialect: new PostgresDialect({ pool }),
    }),
    pool,
  };
}

export async function destroyProbeDatabase(
  connection: ProbeConnection,
): Promise<void> {
  await connection.db.destroy();
}
