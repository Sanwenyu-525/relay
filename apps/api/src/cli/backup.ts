import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BackupError, createBackup } from '../runtime/backup.js';
import { CliConfigError, readRequiredDatabaseUrl, CONFIG_FAILURE_EXIT_CODE, FAILURE_EXIT_CODE } from './cli-support.js';

export function parseBackupArguments(argv: readonly string[]): {
  packageRoot: string; dataRoot: string; backupRoot: string; postgresBin: string;
} {
  const flags = ['--package-root', '--data-root', '--backup-root', '--postgres-bin'] as const;
  if (argv.length !== 9 || argv[0] !== 'create-backup') throw new CliConfigError('invalid backup arguments');
  const values = new Map<string, string>();
  for (let i = 1; i < argv.length; i += 2) {
    const flag = argv[i]!, value = argv[i + 1]!;
    if (!(flags as readonly string[]).includes(flag) || values.has(flag) || !isAbsolute(value)) throw new CliConfigError('invalid backup arguments');
    values.set(flag, value);
  }
  return { packageRoot: values.get(flags[0])!, dataRoot: values.get(flags[1])!,
    backupRoot: values.get(flags[2])!, postgresBin: values.get(flags[3])! };
}
async function main(): Promise<void> {
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    const args = parseBackupArguments(process.argv.slice(2));
    const result = await createBackup({ ...args, signal: abort.signal,
      appUrl: readRequiredDatabaseUrl(process.env, 'RELAY_DB_URL'),
      migrationUrl: readRequiredDatabaseUrl(process.env, 'RELAY_MIGRATION_DB_URL') });
    process.stdout.write(`${JSON.stringify({ type: 'backup_created', ...result })}\n`);
  } catch (cause) {
    const config = cause instanceof CliConfigError;
    process.stderr.write(`${JSON.stringify({ code: config ? 'CONFIGURATION_ERROR' :
      cause instanceof BackupError ? cause.code : 'BACKUP_UNAVAILABLE' })}\n`);
    process.exitCode = config ? CONFIG_FAILURE_EXIT_CODE : FAILURE_EXIT_CODE;
  } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
}
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
