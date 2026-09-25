import type { FastifyInstance } from 'fastify';

import { resolveReview } from '../application/review-decisions.js';
import { listInboxReviews, listRunReviews, readReview } from '../application/review-queries.js';
import {
  ReviewDecisionBodySchema,
  ReviewDecisionResultSchema,
  ReviewListQuerySchema,
  ReviewListSchema,
  ReviewSchema,
  WorkspaceReviewParamsSchema,
  WorkspaceRunParamsSchema,
  WorkspaceParamsSchema,
  commandEnvelopeSchema,
} from './domain-schemas.js';
import { createCommandHandler, sendReadError, type RouteDependencies } from './envelope.js';

export function registerReviewRoutes(app: FastifyInstance, dependencies: RouteDependencies): void {
  app.get('/reviews', { schema: { params: WorkspaceParamsSchema, querystring: ReviewListQuerySchema, response: { 200: ReviewListSchema } } }, async (request, reply) => {
    try {
      const params = request.params as { workspace_id: string };
      const query = request.query as { status?: 'OPEN' | 'DECIDED' | 'EXPIRED' };
      return await listInboxReviews(dependencies.database.executor, params.workspace_id, query.status);
    } catch (error) { return sendReadError(reply, error, request.id); }
  });

  app.get('/runs/:run_id/reviews', { schema: { params: WorkspaceRunParamsSchema, response: { 200: ReviewListSchema } } }, async (request, reply) => {
    try {
      const params = request.params as { workspace_id: string; run_id: string };
      return await listRunReviews(dependencies.database.executor, params.workspace_id, params.run_id);
    } catch (error) { return sendReadError(reply, error, request.id); }
  });

  app.get('/reviews/:review_id', { schema: { params: WorkspaceReviewParamsSchema, response: { 200: ReviewSchema } } }, async (request, reply) => {
    try {
      const params = request.params as { workspace_id: string; review_id: string };
      return await readReview(dependencies.database.executor, params.workspace_id, params.review_id);
    } catch (error) { return sendReadError(reply, error, request.id); }
  });

  app.post('/reviews/:review_id/decisions', {
    schema: { params: WorkspaceReviewParamsSchema, body: ReviewDecisionBodySchema, response: { 200: commandEnvelopeSchema(ReviewDecisionResultSchema) } },
  }, createCommandHandler(dependencies, {
    commandType: 'ResolveReview', bodySchema: ReviewDecisionBodySchema,
    execute: async ({ executor, body, params }) => {
      const outcome = await resolveReview(executor, {
        workspaceId: params.workspace_id ?? '', reviewId: params.review_id ?? '', commandId: body.command_id,
        expectedRevision: body.expected_revision, targetHash: body.target_hash, decision: body.decision,
        ...(body.feedback === undefined ? {} : { feedback: body.feedback }),
        ...(body.retry_budget === undefined ? {} : { retryBudget: body.retry_budget }),
      });
      return { outcome, result: outcome.result };
    },
  }));
}
