import { randomUUID } from 'node:crypto';

import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply } from 'fastify';

import { CommandIdReusedError } from '../application/command.js';
import { DomainError } from '../application/domain-error.js';
import type { ApiConfig } from '../config/config.js';
import { registerBoundary } from './boundary.js';
import { problemFromError } from './envelope.js';
import {
  ProblemError,
  internalError,
  malformedRequest,
  problemBody,
  resourceNotFound,
  validationFailed,
  type FieldError,
  type ProblemDetails,
} from './problem.js';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;

const CLIENT_ERROR_CODES: Readonly<Record<number, { type: string; code: string }>> = {
  400: { type: '/problems/malformed-request', code: 'MALFORMED_REQUEST' },
  413: { type: '/problems/content-too-large', code: 'CONTENT_TOO_LARGE' },
  415: { type: '/problems/unsupported-media-type', code: 'UNSUPPORTED_MEDIA_TYPE' },
};

function sendProblem(
  reply: FastifyReply,
  problem: ProblemDetails,
  requestId: string,
): FastifyReply {
  return reply
    .code(problem.status)
    .type('application/problem+json')
    .send(problemBody(problem, requestId));
}

/**
 * AJV 校验失败 → 字段级错误。
 *
 * additionalProperties / required 两类问题的 instancePath 是所在对象（通常为空），
 * 具体字段名在 params 里；不补出字段名会让 field_errors 无法定位（契约第 7 节要求指向字段）。
 */
function mapValidationIssue(issue: {
  readonly instancePath?: string;
  readonly params?: unknown;
  readonly message?: string;
}): FieldError {
  const path = issue.instancePath ?? '';
  const params = (issue.params ?? {}) as Record<string, unknown>;
  const additional = params.additionalProperty;
  const missing = params.missingProperty;
  const suffix =
    typeof additional === 'string'
      ? additional
      : typeof missing === 'string'
        ? missing
        : undefined;
  const field = suffix === undefined ? path : `${path}/${suffix}`;

  return {
    field: field === '' ? '(request)' : field,
    message: issue.message ?? 'invalid value',
  };
}

export function createServer(config: ApiConfig): FastifyInstance {
  const app = Fastify({
    logger: config.desktopMode ? false : {
      level: config.logLevel,
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers["proxy-authorization"]',
          'res.headers["set-cookie"]',
        ],
        censor: '[redacted]',
      },
    },
    genReqId: (request) => {
      const header = request.headers['x-request-id'];

      if (typeof header === 'string' && REQUEST_ID_PATTERN.test(header)) {
        return header;
      }

      return `req-${randomUUID()}`;
    },
    ajv: {
      customOptions: {
        coerceTypes: false,
        removeAdditional: false,
        allErrors: true,
      },
    },
    forceCloseConnections: true,
  });

  registerBoundary(app, config);

  app.setNotFoundHandler(async (request, reply) => {
    return sendProblem(reply, resourceNotFound(), request.id);
  });

  app.setErrorHandler<FastifyError>(async (error, request, reply) => {
    if (error instanceof ProblemError) {
      return sendProblem(reply, error.problem, request.id);
    }

    // 领域错误（含回执幂等冲突）在路由内已映射；这里是兜底，保证同样不泄漏内部信息。
    if (error instanceof DomainError || error instanceof CommandIdReusedError) {
      request.log.warn({ err: error }, 'domain_error_reached_global_handler');

      return sendProblem(reply, problemFromError(error), request.id);
    }

    if (error.validation !== undefined && error.validation.length > 0) {
      const fieldErrors: FieldError[] = error.validation.map(mapValidationIssue);

      return sendProblem(reply, validationFailed(fieldErrors), request.id);
    }

    const statusCode = error.statusCode;
    const clientError =
      typeof statusCode === 'number' ? CLIENT_ERROR_CODES[statusCode] : undefined;

    if (clientError !== undefined && typeof statusCode === 'number') {
      return sendProblem(
        reply,
        {
          type: clientError.type,
          title: '请求无法处理',
          status: statusCode,
          detail: '请求不符合端点契约，未执行任何业务写入。',
          code: clientError.code,
          retryable: false,
          retryAction: 'NONE',
        },
        request.id,
      );
    }

    request.log.error({ err: error }, 'unhandled_request_error');

    return sendProblem(reply, internalError(), request.id);
  });

  return app;
}
