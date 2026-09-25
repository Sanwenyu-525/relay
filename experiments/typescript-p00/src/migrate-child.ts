import { access, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { requireEnvironment } from './config.js';
import {
  connectProbeDatabase,
  destroyProbeDatabase,
} from './database.js';
import {
  migrateWithIntegrity,
  migrateWithKyselyOnly,
} from './migrations.js';

const databaseUrl = requireEnvironment('P00_PG_URL');
const migrationDirectory = resolve(requireEnvironment('P00_MIGRATION_DIRECTORY'));
const schema = requireEnvironment('P00_MIGRATION_SCHEMA');
const mode = requireEnvironment('P00_MIGRATION_MODE');
const connection = connectProbeDatabase(databaseUrl);

try {
  await waitForStartBarrier();
  const result =
    mode === 'raw'
      ? await migrateWithKyselyOnly(
          connection.db,
          migrationDirectory,
          schema,
        )
      : mode === 'integrity'
        ? await migrateWithIntegrity(connection, migrationDirectory, schema)
        : (() => {
            throw new Error('P00_MIGRATION_MODE must be raw or integrity');
          })();

  process.stdout.write(
    `${JSON.stringify({ executed: result.executed, ok: true })}\n`,
  );
} finally {
  await destroyProbeDatabase(connection);
}

async function waitForStartBarrier(): Promise<void> {
  const directory = process.env.P00_MIGRATION_BARRIER_DIRECTORY;
  if (!directory) {
    return;
  }

  await writeFile(join(directory, `ready-${process.pid}`), '', { flag: 'wx' });
  const releaseFile = join(directory, 'release');

  for (let attempt = 0; attempt < 400; attempt += 1) {
    try {
      await access(releaseFile);
      return;
    } catch {
      await new Promise<void>((resolveDelay) => {
        setTimeout(resolveDelay, 25);
      });
    }
  }

  throw new Error('timed out waiting for the controlled migration start barrier');
}
