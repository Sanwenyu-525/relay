import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkIsolatedRestore } from '../runtime/restore-check.js';
import { RestoreCheckError } from '../runtime/restore-materials.js';
import { CliConfigError, readRequiredDatabaseUrl, CONFIG_FAILURE_EXIT_CODE, FAILURE_EXIT_CODE } from './cli-support.js';

export function parseRestoreCheckArguments(argv: readonly string[]): { dataRoot: string; runtimePackageRoot: string } {
  const flags = ['--data-root', '--runtime-package-root'] as const;
  if (argv.length !== 5 || argv[0] !== 'restore-check-isolated') throw new CliConfigError('invalid restore check arguments');
  const values = new Map<string, string>();
  for (let i = 1; i < argv.length; i += 2) {
    const flag = argv[i]!, value = argv[i + 1]!;
    if (!(flags as readonly string[]).includes(flag) || values.has(flag) || !isAbsolute(value)) {
      throw new CliConfigError('invalid restore check arguments');
    }
    values.set(flag, value);
  }
  return { dataRoot: values.get(flags[0])!, runtimePackageRoot: values.get(flags[1])! };
}
async function main(): Promise<void> {
  const controller = new AbortController(), stop = () => controller.abort();
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    const report = await checkIsolatedRestore({ ...parseRestoreCheckArguments(process.argv.slice(2)), signal: controller.signal,
      migrationUrl: readRequiredDatabaseUrl(process.env, 'RELAY_MIGRATION_DB_URL') });
    process.stdout.write(`${JSON.stringify({ type: 'restore_checked_isolated', ...report })}\n`);
  } catch (cause) {
    const config = cause instanceof CliConfigError;
    process.stderr.write(`${JSON.stringify({ code: config ? 'CONFIGURATION_ERROR' :
      cause instanceof RestoreCheckError ? cause.code : 'RESTORE_CHECK_UNAVAILABLE' })}\n`);
    process.exitCode = config ? CONFIG_FAILURE_EXIT_CODE : FAILURE_EXIT_CODE;
  } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
}
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
