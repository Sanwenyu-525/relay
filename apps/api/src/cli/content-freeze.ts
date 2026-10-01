import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openContentFreezeSession } from '../runtime/content-freeze-session.js';
import { readMaintenanceReleaseInput, MaintenanceReleaseInputError } from '../runtime/maintenance-release-input.js';
import { WindowsContentError } from '../storage/windows-content-publisher.js';
import { CliConfigError, CONFIG_FAILURE_EXIT_CODE, FAILURE_EXIT_CODE } from './cli-support.js';

export function parseContentFreezeArguments(argv: readonly string[]): { readonly dataRoot: string } {
  if (argv.length !== 3 || argv[0] !== 'hold-content-freeze' || argv[1] !== '--data-root' ||
      argv[2] === undefined || !isAbsolute(argv[2])) throw new CliConfigError('require absolute --data-root');
  return { dataRoot: argv[2] };
}

async function main(): Promise<void> {
  try {
    const { dataRoot } = parseContentFreezeArguments(process.argv.slice(2));
    const session = await openContentFreezeSession(dataRoot);
    const input = readMaintenanceReleaseInput(process.stdin);
    const releaseSignal = () => input.requestBySignal();
    try {
      if (!session.isHeld()) throw new WindowsContentError();
      process.stdout.write(`${JSON.stringify({ type: 'content_freeze_held', nonce: session.nonce,
        scope: 'MANAGED_CONTENT_PUBLISH_ONLY', database_frozen: false,
        root_id: session.rootId, sentinel_id: session.sentinelId })}\n`);
      for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) process.on(signal, releaseSignal);
      await Promise.race([input.requested, session.closed.then(() => { throw new WindowsContentError(); })]);
      await session.release();
      input.assertValid();
      process.stdout.write(`${JSON.stringify({ type: 'content_freeze_released', nonce: session.nonce })}\n`);
    } finally {
      for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) process.off(signal, releaseSignal);
      input.dispose();
      if (session.isHeld()) await session.release();
    }
  } catch (error) {
    const configuration = error instanceof CliConfigError || error instanceof MaintenanceReleaseInputError;
    process.stderr.write(`${JSON.stringify({ code: configuration ? 'CONFIGURATION_ERROR' :
      error instanceof WindowsContentError ? error.code : 'CONTENT_IO_FAILED' })}\n`);
    process.exitCode = configuration ? CONFIG_FAILURE_EXIT_CODE : FAILURE_EXIT_CODE;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
