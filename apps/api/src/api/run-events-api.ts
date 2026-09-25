import type { ServerResponse } from 'node:http';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { resourceNotFound } from '../application/domain-error.js';
import type { DbExecutor } from '../infrastructure/database.js';
import { RunEventRepository } from '../run/run-event-repository.js';
import { sendReadError } from './envelope.js';
import { ProblemError, validationFailed } from './problem.js';

const MAX_CURSOR = 9223372036854775807n;
const CURSOR_PATTERN = /^(0|[1-9]\d{0,18})$/u;
const EVENT_BATCH_SIZE = 100;
const POLL_MS = 1000;
const HEARTBEAT_MS = 15000;
const DRAIN_TIMEOUT_MS = 5000;

/** `after` wins when both cursor forms are present. The header is never a token. */
export function runEventCursor(query: unknown, lastEventId: unknown): bigint {
  const params = query as Record<string, unknown> | null;
  const hasAfter = params !== null && typeof params === 'object' &&
    Object.prototype.hasOwnProperty.call(params, 'after');
  const value = hasAfter ? params.after : lastEventId ?? '0';
  const field = hasAfter ? 'after' : 'Last-Event-ID';
  if (typeof value !== 'string' || !CURSOR_PATTERN.test(value)) {
    throw new ProblemError(validationFailed([{ field, message: 'must be a canonical nonnegative int64 decimal' }]));
  }
  const cursor = BigInt(value);
  if (cursor > MAX_CURSOR) {
    throw new ProblemError(validationFailed([{ field, message: 'must not exceed signed int64' }]));
  }
  return cursor;
}

export async function sendRunEventStream(
  request: FastifyRequest,
  reply: FastifyReply,
  db: DbExecutor,
  workspaceId: string,
  runId: string,
): Promise<FastifyReply | void> {
  const events = new RunEventRepository(db);
  let after: bigint;
  try {
    after = runEventCursor(request.query, request.headers['last-event-id']);
    const latest = await events.latestVisibleSeq(workspaceId, runId);
    if (latest === null) throw resourceNotFound('Run');
    if (after > latest) {
      throw new ProblemError(validationFailed([{
        field: 'after', message: 'cursor is newer than committed Run history',
      }]));
    }
  } catch (error) {
    return sendReadError(reply, error, request.id);
  }

  const headers = reply.getHeaders();
  reply.hijack();
  const response = reply.raw;
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) response.setHeader(name, value);
  }
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    'x-content-type-options': 'nosniff',
  });
  response.flushHeaders();

  const stopped = new AbortController();
  const onClose = () => stopped.abort();
  response.once('close', onClose);
  let cursor = after;
  let lastWrite = Date.now();
  try {
    while (!stopped.signal.aborted) {
      const batch = await events.listAfter(runId, cursor, EVENT_BATCH_SIZE);
      if (stopped.signal.aborted) break;
      if (batch.length > 0) {
        for (const event of batch) {
          if (event.seq !== cursor + 1n) throw new Error('Run event history is not contiguous');
          const frame = `id: ${event.seq.toString()}\nevent: run_hint\ndata: ${JSON.stringify({ kind: event.kind })}\n\n`;
          if (!(await writeRunEventFrame(response, frame, stopped.signal))) {
            response.destroy();
            return;
          }
          cursor = event.seq;
          lastWrite = Date.now();
        }
        continue;
      }
      if (Date.now() - lastWrite >= HEARTBEAT_MS) {
        if (!(await writeRunEventFrame(response, ': keepalive\n\n', stopped.signal))) {
          response.destroy();
          return;
        }
        lastWrite = Date.now();
      }
      await waitForPoll(stopped.signal);
    }
  } catch (error) {
    if (!stopped.signal.aborted) request.log.error({ err: error }, 'run_event_stream_failed');
    response.destroy();
  } finally {
    response.off('close', onClose);
    if (!response.destroyed) response.end();
  }
}

export function writeRunEventFrame(response: ServerResponse, frame: string, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted || response.destroyed) return Promise.resolve(false);
  if (response.write(frame)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timeout = setTimeout(() => finish(false), DRAIN_TIMEOUT_MS);
    const onDrain = () => finish(true);
    const onClose = () => finish(false);
    const onAbort = () => finish(false);
    function finish(drained: boolean): void {
      clearTimeout(timeout);
      response.off('drain', onDrain);
      response.off('close', onClose);
      signal.removeEventListener('abort', onAbort);
      resolve(drained);
    }
    response.once('drain', onDrain);
    response.once('close', onClose);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted || response.destroyed) finish(false);
  });
}

function waitForPoll(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(finish, POLL_MS);
    function finish(): void {
      clearTimeout(timeout);
      signal.removeEventListener('abort', finish);
      resolve();
    }
    signal.addEventListener('abort', finish, { once: true });
    if (signal.aborted) finish();
  });
}
