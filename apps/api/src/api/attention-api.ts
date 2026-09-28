import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { claimInterventionNotifications, listInterventionItems,
  settleInterventionNotification } from '../application/attention-notifications.js';
import { UuidSchema } from './domain-schemas.js';
import { sendReadError, type RouteDependencies } from './envelope.js';

const ItemSchema = Type.Object({ item_key: Type.String(), change_key: Type.String(),
  kind: Type.Union([Type.Literal('REVIEW'), Type.Literal('LOCK_CONFLICT'),
    Type.Literal('RUN_FAILED'), Type.Literal('UNKNOWN')]),
  title: Type.String(), reason: Type.String(), target_url: Type.String(),
}, { additionalProperties: false });
const ParamsSchema = Type.Object({ workspace_id: UuidSchema }, { additionalProperties: false });
const SettleBodySchema = Type.Object({ item_key: Type.String({ minLength: 1, maxLength: 160 }),
  change_key: Type.String({ minLength: 1, maxLength: 160 }),
  status: Type.Union([Type.Literal('DISPATCHED'), Type.Literal('DENIED'), Type.Literal('FAILED')]),
}, { additionalProperties: false });

export function registerAttentionRoutes(app: FastifyInstance, dependencies: RouteDependencies): void {
  app.get('/attention/interventions', { schema: { params: ParamsSchema,
    response: { 200: Type.Object({ items: Type.Array(ItemSchema) }, { additionalProperties: false }) } } },
  async (request, reply) => {
    try { const p = request.params as { workspace_id: string };
      return { items: await listInterventionItems(dependencies.database.executor, p.workspace_id) };
    } catch (error) { return sendReadError(reply, error, request.id); }
  });
  app.post('/attention/notifications/claim', { schema: { params: ParamsSchema,
    response: { 200: Type.Object({ items: Type.Array(ItemSchema) }, { additionalProperties: false }) } } },
  async (request, reply) => {
    try { const p = request.params as { workspace_id: string };
      return { items: await claimInterventionNotifications(dependencies.database.executor, p.workspace_id) };
    } catch (error) { return sendReadError(reply, error, request.id); }
  });
  app.post('/attention/notifications/settle', { schema: { params: ParamsSchema,
    body: SettleBodySchema, response: { 200: Type.Object({ status: Type.Literal('recorded') },
      { additionalProperties: false }) } } }, async (request, reply) => {
    try { const p = request.params as { workspace_id: string };
      const body = request.body as { item_key: string; change_key: string;
        status: 'DISPATCHED' | 'DENIED' | 'FAILED' };
      await settleInterventionNotification(dependencies.database.executor,
        p.workspace_id, body.item_key, body.change_key, body.status);
      return { status: 'recorded' as const };
    } catch (error) { return sendReadError(reply, error, request.id); }
  });
}
