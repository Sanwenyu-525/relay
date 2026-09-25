import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runMigrations } from '../infrastructure/migration-runner.js';
import {
  readOptionalEnvironment,
  readRequiredDatabaseUrl,
  reportFailure,
} from './cli-support.js';

/**
 * 迁移入口：node dist/src/cli/migrate.js
 *
 * 需要 RELAY_MIGRATION_DB_URL（迁移角色，持有 DDL）；可选 RELAY_MIGRATION_DIRECTORY 覆盖迁移目录。
 * 不使用 RELAY_DB_URL：应用角色不允许 DDL，两种连接必须分开。
 */

const DEFAULT_MIGRATION_DIRECTORY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'migrations',
);

async function main(): Promise<void> {
  try {
    const connectionString = readRequiredDatabaseUrl(process.env, 'RELAY_MIGRATION_DB_URL');
    const directory =
      readOptionalEnvironment(process.env, 'RELAY_MIGRATION_DIRECTORY') ?? DEFAULT_MIGRATION_DIRECTORY;
    const result = await runMigrations({ connectionString, directory });

    process.stdout.write(
      `${JSON.stringify(
        {
          applied: result.applied,
          already_applied: result.alreadyApplied,
          ledger_rows: result.ledgerRows,
        },
        null,
        2,
      )}\n`,
    );
  } catch (error) {
    process.exitCode = reportFailure(error);
  }
}

await main();