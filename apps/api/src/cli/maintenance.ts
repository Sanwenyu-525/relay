import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { isAbsolute } from 'node:path';

import { DomainError } from '../application/domain-error.js';
import { CommandIdReusedError } from '../application/command.js';
import { changeAdmission, readAdmissionStatus } from '../application/runtime-maintenance.js';
import { RelayDatabase } from '../infrastructure/database.js';
import { DesktopMaintenanceSessionError, openDesktopMaintenanceSession } from
  '../runtime/desktop-maintenance-session.js';
import { MaintenanceReleaseInputError, readMaintenanceReleaseInput } from '../runtime/maintenance-release-input.js';
import { CliConfigError, readRequiredDatabaseUrl, FAILURE_EXIT_CODE,
  CONFIG_FAILURE_EXIT_CODE } from './cli-support.js';

type MaintenanceArguments = { readonly action: 'status' } | {
  readonly action: 'hold-desktop-stop'; readonly packageRoot: string; readonly dataRoot: string;
} | {
  readonly action: 'begin-drain' | 'resume-admission';
  readonly commandId: string; readonly expectedRevision: string;
};

export function parseMaintenanceArguments(argv: readonly string[]): MaintenanceArguments {
  const action = argv[0];
  if (action === 'status' && argv.length === 1) return { action };
  if (action === 'hold-desktop-stop') {
    const flags = new Map<string, string>();
    for (let index = 1; index < argv.length; index += 2) {
      const key = argv[index];
      const value = argv[index + 1];
      if ((key !== '--package-root' && key !== '--data-root') || value === undefined ||
          !isAbsolute(value) || flags.has(key)) throw new CliConfigError('require unique absolute package/data roots');
      flags.set(key, value);
    }
    const packageRoot = flags.get('--package-root');
    const dataRoot = flags.get('--data-root');
    if (packageRoot === undefined || dataRoot === undefined) throw new CliConfigError('require package/data roots');
    return { action, packageRoot, dataRoot };
  }
  if (action !== 'begin-drain' && action !== 'resume-admission') {
    throw new CliConfigError('usage: maintenance status | begin-drain | resume-admission');
  }
  const values = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if ((key !== '--command-id' && key !== '--expected-revision') ||
        value === undefined || value.startsWith('--') || values.has(key)) {
      throw new CliConfigError('require unique --command-id and --expected-revision flags');
    }
    values.set(key, value);
  }
  const commandId = values.get('--command-id');
  const expectedRevision = values.get('--expected-revision');
  if (commandId === undefined ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(commandId) ||
      expectedRevision === undefined || !/^(0|[1-9][0-9]*)$/u.test(expectedRevision)) {
    throw new CliConfigError('require UUID --command-id and decimal --expected-revision');
  }
  return { action, commandId, expectedRevision };
}

async function holdDesktopStop(input: { readonly packageRoot: string; readonly dataRoot: string }): Promise<void> {
  const session = await openDesktopMaintenanceSession(input);
  if (!session.isHeld()) throw new DesktopMaintenanceSessionError('MAINTENANCE_SESSION_IO_FAILED');
  process.stdout.write(`${JSON.stringify({ type: 'desktop_stop_held', nonce: session.nonce,
    scope: 'CURRENT_WINDOWS_SESSION_DESKTOP_ONLY', frozen: false,
    stoppedLaunches: session.stoppedLaunches })}\n`);
  const inputReader = readMaintenanceReleaseInput(process.stdin);
  const releaseSignal = () => inputReader.requestBySignal();
  try {
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) process.on(signal, releaseSignal);
    await Promise.race([inputReader.requested, session.closed.then(() => {
      throw new DesktopMaintenanceSessionError('MAINTENANCE_SESSION_IO_FAILED');
    })]);
    await session.release();
    inputReader.assertValid();
    process.stdout.write(`${JSON.stringify({ type: 'desktop_stop_released', nonce: session.nonce })}\n`);
  } finally {
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) process.off(signal, releaseSignal);
    inputReader.dispose();
    if (session.isHeld()) await session.release();
  }
}

async function main(): Promise<void> {
  let database: RelayDatabase | undefined;
  try {
    const args = parseMaintenanceArguments(process.argv.slice(2));
    if (args.action === 'hold-desktop-stop') return await holdDesktopStop(args);
    const databaseUrl = readRequiredDatabaseUrl(process.env, 'RELAY_DB_URL');
    database = new RelayDatabase({ databaseUrl, databasePoolMax: 1,
      databaseConnectTimeoutMs: 5000 }, () => {
      process.stderr.write('maintenance database pool unavailable\n');
    });
    const result = args.action === 'status'
      ? await readAdmissionStatus(database.executor)
      : await changeAdmission(database.executor, args);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    const code = error instanceof DesktopMaintenanceSessionError ? error.code : error instanceof DomainError ? error.code :
      error instanceof CommandIdReusedError ? 'COMMAND_ID_REUSED' :
        error instanceof CliConfigError || error instanceof MaintenanceReleaseInputError
          ? 'CONFIGURATION_ERROR' : 'MAINTENANCE_UNAVAILABLE';
    // Only trusted codes: driver/configuration messages may contain credentials.
    process.stderr.write(`${JSON.stringify({ code })}\n`);
    process.exitCode = error instanceof CliConfigError || error instanceof MaintenanceReleaseInputError
      ? CONFIG_FAILURE_EXIT_CODE : FAILURE_EXIT_CODE;
  } finally {
    if (database !== undefined) await database.close();
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
