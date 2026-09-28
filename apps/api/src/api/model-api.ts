import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { describeModelPortStatus } from '../workflow/model-port-config.js';
import { UuidSchema } from './domain-schemas.js';
import { sendReadError, type RouteDependencies } from './envelope.js';

const ParamsSchema = Type.Object({ workspace_id: UuidSchema }, { additionalProperties: false });
const StatusSchema = Type.Object({
  provider: Type.Union([Type.Literal('fake'), Type.Literal('openai-compatible'), Type.Literal('invalid')]),
  configured: Type.Boolean(),
  model: Type.Union([Type.String(), Type.Null()]),
  base_url: Type.Union([Type.String(), Type.Null()]),
}, { additionalProperties: false });

/**
 * 当前服务实例的模型端口状态（M04 只读面）：来自进程环境变量，不含密钥，
 * 不依赖 Workspace 事实；任何持本实例 Bearer 的客户端可见。
 */
export function registerModelRoutes(app: FastifyInstance, dependencies: RouteDependencies): void {
  void dependencies;
  app.get('/model-port', { schema: { params: ParamsSchema, response: { 200: StatusSchema } } },
    async (request, reply) => {
      try {
        const p = request.params as { workspace_id: string };
        void p;
        const status = describeModelPortStatus(process.env);
        return { provider: status.provider, configured: status.configured,
          model: status.model, base_url: status.baseUrl };
      } catch (error) { return sendReadError(reply, error, request.id); }
    });
}
