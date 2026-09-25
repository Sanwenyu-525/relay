import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { ProblemError, authRequired, invalidHost, invalidOrigin } from './problem.js';

export interface BoundaryConfig {
  readonly bindHost: string;
  readonly port: number;
  readonly allowedOrigins: readonly string[];
  readonly bearerToken: string;
  readonly desktopMode?: boolean;
}

const ALLOWED_METHODS = 'GET,POST,PATCH,OPTIONS';
const ALLOWED_HEADERS = 'authorization,content-type,x-request-id,last-event-id';
const PREFLIGHT_MAX_AGE_SECONDS = '600';

export function registerBoundary(app: FastifyInstance, config: BoundaryConfig): void {
  const allowedHostnames = new Set(config.desktopMode
    ? [config.bindHost]
    : [config.bindHost, 'localhost']);
  const allowedOrigins = new Set(config.allowedOrigins);

  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);

    const address = app.server.address();
    const boundPort = address !== null && typeof address !== 'string'
      ? address.port
      : config.port;
    if (!allowedHostnames.has(request.hostname) || request.port !== boundPort) {
      throw new ProblemError(invalidHost());
    }

    const origin = request.headers.origin;

    if (origin !== undefined) {
      if (!allowedOrigins.has(origin)) {
        throw new ProblemError(invalidOrigin());
      }

      reply.header('access-control-allow-origin', origin);
      reply.header('access-control-expose-headers', 'X-Request-Id');
      reply.header('vary', 'Origin');
    }

    if (request.method === 'OPTIONS') {
      reply.header('access-control-allow-methods', ALLOWED_METHODS);
      reply.header('access-control-allow-headers', ALLOWED_HEADERS);
      reply.header('access-control-max-age', PREFLIGHT_MAX_AGE_SECONDS);
      await reply.code(204).send();
    }
  });
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

export function createBearerGuard(bearerToken: string) {
  const expectedDigest = digest(bearerToken);

  return async function bearerGuard(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const header = request.headers.authorization;
    const provided = typeof header === 'string' ? /^Bearer[ ](.+)$/u.exec(header)?.[1] : undefined;

    if (provided === undefined || !timingSafeEqual(digest(provided), expectedDigest)) {
      reply.header('www-authenticate', 'Bearer');
      throw new ProblemError(authRequired());
    }
  };
}
