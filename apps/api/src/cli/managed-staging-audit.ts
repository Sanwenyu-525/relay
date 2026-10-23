import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { auditManagedStaging } from '../runtime/managed-staging-audit.js';
import { RelayDatabase } from '../infrastructure/database.js';
import { CliConfigError, readRequiredDatabaseUrl, CONFIG_FAILURE_EXIT_CODE,
  FAILURE_EXIT_CODE } from './cli-support.js';

export function parseManagedStagingAuditArguments(argv: readonly string[]): { readonly dataRoot: string } {
  if (argv.length !== 3 || argv[0] !== 'audit-managed-staging' || argv[1] !== '--data-root' ||
      argv[2] === undefined || !isAbsolute(argv[2])) throw new CliConfigError('require absolute --data-root');
  return { dataRoot: argv[2] };
}

async function main(): Promise<void> {
  let database: RelayDatabase | undefined;
  try {
    const { dataRoot } = parseManagedStagingAuditArguments(process.argv.slice(2));
    const databaseUrl = readRequiredDatabaseUrl(process.env, 'RELAY_DB_URL');
    database = new RelayDatabase({ databaseUrl, databasePoolMax: 1,
      databaseConnectTimeoutMs: 5000 }, () => {
      process.stderr.write('managed staging audit database pool unavailable\n');
    });
    // 只报告不删除：发现孤儿不是命令失败，退出码只表达核对本身是否完成。
    const report = await auditManagedStaging(database.executor, dataRoot);
    process.stdout.write(`${JSON.stringify({ type: 'managed_staging_audited', ...report })}\n`);
  } catch (error) {
    const configuration = error instanceof CliConfigError;
    process.stderr.write(`${JSON.stringify({ code: configuration ? 'CONFIGURATION_ERROR' :
      'MANAGED_STAGING_AUDIT_UNAVAILABLE' })}\n`);
    process.exitCode = configuration ? CONFIG_FAILURE_EXIT_CODE : FAILURE_EXIT_CODE;
  } finally {
    if (database !== undefined) await database.close();
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
