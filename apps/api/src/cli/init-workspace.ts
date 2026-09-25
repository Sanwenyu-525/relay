import { randomUUID } from 'node:crypto';

import { initializeWorkspace } from '../application/initialize-workspace.js';
import { RelayDatabase } from '../infrastructure/database.js';
import {
  CliConfigError,
  readFlag,
  readRequiredDatabaseUrl,
  readRequiredEnvironment,
  readOptionalEnvironment,
  reportFailure,
} from './cli-support.js';

/**
 * Workspace 初始化入口：node dist/src/cli/init-workspace.js --name "<名称>"
 *
 * 使用 RELAY_DB_URL（应用角色）：Workspace 与 authority 行是业务事实，必须由应用入口写入，
 * 不依赖手工改库。
 *
 * 原样重试必须同时复用 --workspace-id 与 --command-id：命令目标（Workspace ID）也进入 payload_hash，
 * 只复用 command_id 而换一个目标会被判为不同命令，从而再建一个 Workspace。首次运行会把 workspace_id
 * 打印出来，重试时原样传回即可得到 replayed=true 与同一结果。
 */

const POOL_MAX = 2;
const CONNECT_TIMEOUT_MS = 5000;

async function main(): Promise<void> {
  let database: RelayDatabase | undefined;

  try {
    const argv = process.argv.slice(2);
    const connectionString = readRequiredDatabaseUrl(process.env, 'RELAY_DB_URL');
    const name =
      readFlag(argv, '--name') ?? readRequiredEnvironment(process.env, 'RELAY_WORKSPACE_NAME');
    const requestedWorkspaceId = readFlag(argv, '--workspace-id');
    const requestedCommandId =
      readFlag(argv, '--command-id') ?? readOptionalEnvironment(process.env, 'RELAY_COMMAND_ID');

    if (requestedCommandId !== undefined && requestedWorkspaceId === undefined) {
      throw new CliConfigError(
        '--command-id requires --workspace-id: a retry must reuse the same command target',
      );
    }

    const workspaceId = requestedWorkspaceId ?? randomUUID();
    const commandId = requestedCommandId ?? randomUUID();

    database = new RelayDatabase(
      {
        databaseUrl: connectionString,
        databasePoolMax: POOL_MAX,
        databaseConnectTimeoutMs: CONNECT_TIMEOUT_MS,
      },
      (error) => {
        process.stderr.write(`database pool error: ${error.message}\n`);
      },
    );

    const outcome = await initializeWorkspace(database.executor, {
      workspaceId,
      name,
      commandId,
      actorRef: 'cli:init-workspace',
    });

    process.stdout.write(
      `${JSON.stringify(
        {
          command_id: commandId,
          replayed: outcome.replayed,
          committed_at: outcome.committedAt.toISOString(),
          result: outcome.result,
        },
        null,
        2,
      )}\n`,
    );
  } catch (error) {
    process.exitCode = reportFailure(error);
  } finally {
    if (database !== undefined) {
      await database.close();
    }
  }
}

await main();