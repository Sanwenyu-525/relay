import type { FastifyInstance } from 'fastify';
import { isIP } from 'node:net';

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { registerRoutes } from './api/routes.js';
import { createServer } from './api/server.js';
import { ConfigError, findRepositoryRoot, loadConfig, type ApiConfig } from './config/config.js';
import { RelayDatabase } from './infrastructure/database.js';
import { SchemaReadinessChecker } from './infrastructure/schema-readiness.js';
import { assertRestoreNotIsolated, RestoreIsolationError } from './runtime/restore-isolation.js';
import {
  desktopWorkspaceId,
  probeDesktopBoundary,
  probeDesktopReadiness,
  readDesktopStartupFrame,
  writeDesktopEvent,
  type DesktopStartupFrame,
} from './desktop/child.js';

const CONFIG_FAILURE_EXIT_CODE = 2;
const FAILURE_EXIT_CODE = 1;
const CLEANUP_TIMEOUT_MS = 5000;
const MIGRATIONS_DIRECTORY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'migrations',
);

async function settle(work: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;

  try {
    await Promise.race([
      work,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } catch {
    // 清理失败不应阻止本次进程退出
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function installShutdownHandlers(
  app: FastifyInstance,
  database: RelayDatabase,
  config: ApiConfig,
): void {
  let stopping = false;

  const requestShutdown = (reason: string): void => {
    if (stopping) {
      // A pipe close can emit both 'end' and 'close'; the first event owns cleanup.
      return;
    }

    stopping = true;
    app.log.info({ reason }, 'api_stopping');

    void (async () => {
      await settle(app.close(), CLEANUP_TIMEOUT_MS);
      await settle(database.close(), CLEANUP_TIMEOUT_MS);
      process.exit(process.exitCode ?? 0);
    })();
  };

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) {
    process.on(signal, () => {
      requestShutdown(signal);
    });
  }

  if (config.stopOnStdinEof) {
    process.stdin.resume();
    process.stdin.on('end', () => {
      requestShutdown('stdin_end');
    });
    process.stdin.on('close', () => {
      requestShutdown('stdin_close');
    });
  }
}

async function main(): Promise<void> {
  let config: ApiConfig;
  const desktopChild = process.argv.includes('--desktop-child');
  let desktopFrame: DesktopStartupFrame | undefined;
  let workspaceId: string | undefined;

  try {
    if (desktopChild) {
      desktopFrame = await readDesktopStartupFrame();
      workspaceId = desktopWorkspaceId(process.env.RELAY_DESKTOP_WORKSPACE_ID);
    }
    const env = desktopFrame === undefined ? process.env : {
      ...process.env,
      RELAY_API_BIND_HOST: '127.0.0.1',
      RELAY_API_PORT: '0',
      // 桌面宿主仅在 tauri dev 构建注入该变量；打包产物保持 tauri.localhost 单一来源。
      RELAY_API_ALLOWED_ORIGINS: process.env.RELAY_DESKTOP_EXTRA_ORIGIN
        ? `http://tauri.localhost,${process.env.RELAY_DESKTOP_EXTRA_ORIGIN}`
        : 'http://tauri.localhost',
      RELAY_API_BEARER_TOKEN: desktopFrame.bearerToken,
      RELAY_API_STOP_ON_STDIN_EOF: 'true',
      RELAY_LOG_LEVEL: 'fatal',
    };
    config = {
      ...loadConfig(env, findRepositoryRoot(), { desktop: desktopChild }),
      desktopMode: desktopChild,
    };
    await assertRestoreNotIsolated(config.dataRoot);
  } catch (error) {
    if (error instanceof RestoreIsolationError) {
      if (desktopChild) {
        writeDesktopEvent({ type: 'desktop_error', nonce: desktopFrame?.nonce ?? '', code: error.code });
        process.stdin.destroy();
      }
      process.stderr.write(`${error.code}\n`);
      process.exitCode = CONFIG_FAILURE_EXIT_CODE;
      return;
    }
    if (desktopChild) {
      writeDesktopEvent({
        type: 'desktop_error', nonce: desktopFrame?.nonce ?? '',
        code: error instanceof ConfigError ? 'CONFIG_INVALID' : 'DESKTOP_STARTUP_INVALID',
      });
      process.stderr.write('Desktop configuration is missing or invalid. Check the documented desktop.env fields.\n');
      process.exitCode = CONFIG_FAILURE_EXIT_CODE;
      return;
    }
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = CONFIG_FAILURE_EXIT_CODE;
      return;
    }

    throw error;
  }

  const app = createServer(config);
  const database = new RelayDatabase(config, (error) => {
    app.log.error({ err: error }, 'database_pool_error');
  });

  registerRoutes(app, {
    config,
    dataRoot: config.dataRoot,
    database,
    schemaReadiness: new SchemaReadinessChecker(MIGRATIONS_DIRECTORY),
  });

  try {
    await app.listen({ host: config.bindHost, port: config.port });
  } catch (error) {
    if (desktopFrame !== undefined) {
      writeDesktopEvent({ type: 'desktop_error', nonce: desktopFrame.nonce, code: 'LISTEN_FAILED' });
    }
    app.log.error({ err: error }, 'api_listen_failed');
    await settle(database.close(), CLEANUP_TIMEOUT_MS);
    process.exitCode = FAILURE_EXIT_CODE;
    return;
  }

  app.log.info(
    {
      bind_host: config.bindHost,
      port: config.port,
      log_level: config.logLevel,
      allowed_origins: config.allowedOrigins.length,
    },
    'api_listening',
  );

  installShutdownHandlers(app, database, config);

  if (desktopFrame !== undefined && workspaceId !== undefined) {
    try {
      const address = app.server.address();
      if (address === null || typeof address === 'string' || isIP(config.bindHost) === 0) {
        throw new Error('DESKTOP_LISTENER_INVALID');
      }
      const schemaReadiness = new SchemaReadinessChecker(MIGRATIONS_DIRECTORY);
      await probeDesktopReadiness(database, schemaReadiness, workspaceId);
      await probeDesktopBoundary(address.port, desktopFrame.bearerToken);
      writeDesktopEvent({
        type: 'desktop_ready', nonce: desktopFrame.nonce,
        port: address.port, workspaceId, nodeVersion: process.version,
      });
    } catch (error) {
      process.exitCode = FAILURE_EXIT_CODE;
      const knownCodes = new Set([
        'DATABASE_UNAVAILABLE', 'SCHEMA_UNAVAILABLE', 'WORKSPACE_UNAVAILABLE',
        'DESKTOP_BOUNDARY_FAILED', 'DESKTOP_LISTENER_INVALID',
      ]);
      writeDesktopEvent({
        type: 'desktop_error', nonce: desktopFrame.nonce,
        code: error instanceof Error && knownCodes.has(error.message)
          ? error.message : 'DESKTOP_READY_FAILED',
      });
      await settle(app.close(), CLEANUP_TIMEOUT_MS);
      await settle(database.close(), CLEANUP_TIMEOUT_MS);
    }
    return;
  }

  const startupProbe = await database.ping();

  if (!startupProbe.ok) {
    app.log.error({ database: 'down' }, 'database_unavailable_at_startup');
  }

}

await main();
