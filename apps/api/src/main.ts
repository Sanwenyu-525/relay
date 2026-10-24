import type { FastifyInstance } from 'fastify';
import { isIP } from 'node:net';

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { registerBrowserBridgeRoutes } from './api/routes.js';
import { ensureBridgeRegistration, registerBridgeUpgrade, syncBridgePort }
  from './browser/bridge.js';
import { registerRoutes } from './api/routes.js';
import { createServer } from './api/server.js';
import { ConfigError, findRepositoryRoot, loadConfig, type ApiConfig } from './config/config.js';
import { shutdownComputerRuntimeClient } from './computer/client-holder.js';
import { RelayDatabase } from './infrastructure/database.js';
import { SchemaReadinessChecker } from './infrastructure/schema-readiness.js';
import { assertRestoreNotIsolated, RestoreIsolationError } from './runtime/restore-isolation.js';
import {
  desktopChildEnvironment,
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
      // 电脑运行时是本进程懒拉起的子进程：停机时显式回收，不留孤儿输入通道
      // （没有在跑就是无害空操作）。
      shutdownComputerRuntimeClient();
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
    const env = desktopFrame === undefined ? process.env : desktopChildEnvironment({
      frame: desktopFrame,
      base: process.env,
      extraOrigin: process.env.RELAY_DESKTOP_EXTRA_ORIGIN,
    });
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

  // F26/M4a：浏览器扩展桥接。路由必须在 Fastify 开始 listen 前注册；
  // 令牌与端口写入数据根的 bridge.json（Worker 与扩展共用）。
  const bridge = await ensureBridgeRegistration(config.dataRoot, config.port);
  registerBrowserBridgeRoutes(app, {
    dataRoot: config.dataRoot, database, bridgeToken: bridge.token,
  });
  registerBridgeUpgrade(app.server, { dataRoot: config.dataRoot, token: bridge.token });

  const failListen = async (error: unknown): Promise<void> => {
    if (desktopFrame !== undefined) {
      writeDesktopEvent({ type: 'desktop_error', nonce: desktopFrame.nonce, code: 'LISTEN_FAILED' });
    }
    app.log.error({ err: error }, 'api_listen_failed');
    await settle(database.close(), CLEANUP_TIMEOUT_MS);
    process.exitCode = FAILURE_EXIT_CODE;
  };

  try {
    await app.listen({ host: config.bindHost, port: config.port });
  } catch (error) {
    // 桌面模式的固定端口被占用（另一个实例、或别的程序占了）：回退临时端口。
    // 功能不降级，代价是扩展的配对地址失效（桥接文件随后会写实际端口）。
    const busy = (error as NodeJS.ErrnoException | undefined)?.code === 'EADDRINUSE';
    if (config.desktopMode && busy && config.port !== 0) {
      app.log.warn({ port: config.port }, 'desktop_fixed_port_busy_falling_back');
      try {
        await app.listen({ host: config.bindHost, port: 0 });
      } catch (retryError) {
        await failListen(retryError);
        return;
      }
    } else {
      await failListen(error);
      return;
    }
  }

  // 端口 0（临时端口）时，真实端口只有 listen 之后才知道。桥接文件在 listen 之前
  // 写的是**请求**端口，扩展会照着它去连 127.0.0.1:0——永远连不上。
  const bound = app.server.address();
  const boundPort = await syncBridgePort(config.dataRoot, config.port,
    bound !== null && typeof bound !== 'string' ? bound.port : config.port);

  app.log.info(
    {
      bind_host: config.bindHost,
      port: boundPort,
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
