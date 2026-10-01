import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DatabaseConnectFenceError, holdDatabaseConnectFence, recoverDatabaseConnectFence } from '../runtime/database-connect-fence.js';
import { readMaintenanceReleaseInput, MaintenanceReleaseInputError } from '../runtime/maintenance-release-input.js';
import { CliConfigError, readRequiredDatabaseUrl, CONFIG_FAILURE_EXIT_CODE, FAILURE_EXIT_CODE } from './cli-support.js';

export function parseDatabaseConnectFenceArguments(argv: readonly string[]): {
  readonly action: 'hold-database-connect-fence' | 'recover-database-connect-fence'; readonly journalFile: string;
} {
  const action = argv[0];
  if ((action !== 'hold-database-connect-fence' && action !== 'recover-database-connect-fence') ||
    argv.length !== 3 || argv[1] !== '--journal-file' || argv[2] === undefined || !isAbsolute(argv[2])) {
    throw new CliConfigError('require fixed action and absolute --journal-file');
  }
  return { action, journalFile: argv[2] };
}

async function main(): Promise<void> {
  try {
    const args = parseDatabaseConnectFenceArguments(process.argv.slice(2));
    const url = readRequiredDatabaseUrl(process.env, 'RELAY_MIGRATION_DB_URL');
    if (args.action === 'recover-database-connect-fence') {
      const result = await recoverDatabaseConnectFence(url, args.journalFile);
      process.stdout.write(`${JSON.stringify({ type: 'database_connect_fence_recovered', ...result })}\n`);
      return;
    }
    const session = await holdDatabaseConnectFence(url, args.journalFile);
    const input = readMaintenanceReleaseInput(process.stdin);
    // Input can fail while the PG quiescence check is still in flight.
    // Attach a handler immediately; the original promise still rejects at the awaited race.
    void input.requested.catch(() => {});
    const signal = () => input.requestBySignal();
    try {
      await session.assertQuiescent();
      input.assertValid();
      process.stdout.write(`${JSON.stringify({ type: 'database_connect_fence_held', operationId: session.operationId,
        backendPid: session.backendPid, scope: 'DATABASE_CONNECTION_ADMISSION_ONLY', frozen: false })}\n`);
      for (const name of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) process.on(name, signal);
      await Promise.race([input.requested, session.closed.then(() => { throw new DatabaseConnectFenceError('DATABASE_FENCE_CONNECTION_LOST'); })]);
      await session.release(); input.assertValid();
      process.stdout.write(`${JSON.stringify({ type: 'database_connect_fence_released', operationId: session.operationId })}\n`);
    } finally {
      for (const name of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) process.off(name, signal);
      input.dispose();
      if (session.isHeld()) await session.release();
    }
  } catch (cause) {
    const config = cause instanceof CliConfigError || cause instanceof MaintenanceReleaseInputError;
    process.stderr.write(`${JSON.stringify({ code: config ? 'CONFIGURATION_ERROR' :
      cause instanceof DatabaseConnectFenceError ? cause.code : 'DATABASE_FENCE_UNAVAILABLE' })}\n`);
    process.exitCode = config ? CONFIG_FAILURE_EXIT_CODE : FAILURE_EXIT_CODE;
  }
}
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
