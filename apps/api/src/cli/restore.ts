import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { restoreIsolated, RestoreError } from '../runtime/restore.js';
import { CliConfigError, readRequiredDatabaseUrl, CONFIG_FAILURE_EXIT_CODE, FAILURE_EXIT_CODE } from './cli-support.js';

export function parseRestoreArguments(argv: readonly string[]): {
  backupRoot: string; sourcePackageRoot: string; runtimePackageRoot: string; dataRoot: string; postgresBin: string;
} {
  const flags = ['--backup-root', '--source-package-root', '--runtime-package-root', '--data-root', '--postgres-bin'] as const;
  if (argv.length !== 11 || argv[0] !== 'restore-isolated') throw new CliConfigError('invalid restore arguments');
  const values = new Map<string, string>();
  for (let i = 1; i < argv.length; i += 2) {
    const flag = argv[i]!, value = argv[i + 1]!;
    if (!(flags as readonly string[]).includes(flag) || values.has(flag) || !isAbsolute(value)) throw new CliConfigError('invalid restore arguments');
    values.set(flag, value);
  }
  return { backupRoot: values.get(flags[0])!, sourcePackageRoot: values.get(flags[1])!,
    runtimePackageRoot: values.get(flags[2])!, dataRoot: values.get(flags[3])!, postgresBin: values.get(flags[4])! };
}
async function main(): Promise<void> {
  const controller = new AbortController(), stop = () => controller.abort();
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    const result = await restoreIsolated({ ...parseRestoreArguments(process.argv.slice(2)), signal: controller.signal,
      migrationUrl: readRequiredDatabaseUrl(process.env, 'RELAY_MIGRATION_DB_URL') });
    process.stdout.write(`${JSON.stringify({ type: 'restore_verified_isolated', ...result })}\n`);
  } catch (cause) {
    const config = cause instanceof CliConfigError;
    process.stderr.write(`${JSON.stringify({ code: config ? 'CONFIGURATION_ERROR' :
      cause instanceof RestoreError ? cause.code : 'RESTORE_UNAVAILABLE' })}\n`);
    process.exitCode = config ? CONFIG_FAILURE_EXIT_CODE : FAILURE_EXIT_CODE;
  } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
}
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
