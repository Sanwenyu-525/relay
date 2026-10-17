import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';

import { ComposerDraftGate, runComposerDraftAssist,
  type ComposerDraftOutcome } from '../application/composer-draft-assist.js';
import { UuidSchema } from './domain-schemas.js';
import { sendReadError, type RouteDependencies } from './envelope.js';

/**
 * 发送前草稿辅助（工作台 §30、HTTP §10.84）。
 *
 * 它**不是**业务命令：没有 command_id、没有幂等回执、不写任何业务事实，因此走
 * 「读取端点的错误映射 + 自己的成功体」而不是命令信封。它与 `/model-port/verify`
 * 同一形态：一次有界、有闸门、可能计费的真实模型调用，只是调用的是草稿处理模板。
 *
 * 权限边界沿用既有 Bearer 守卫与工作区前缀；草稿辅助没有额外的业务权限要求
 * （它不读项目资料、不执行草稿内容），因此不新增准入判定。
 */

const ParamsSchema = Type.Object({ workspace_id: UuidSchema }, { additionalProperties: false });

const BodySchema = Type.Object({
  operation: Type.Union([Type.Literal('OUTLINE'), Type.Literal('POLISH')]),
  // 上界按 UTF-16 单元给，留出代理对余量；真正的码点上界由用例按唯一口径判定。
  text: Type.String({ minLength: 1, maxLength: 8192 }),
}, { additionalProperties: false });

const ResultSchema = Type.Object({
  operation: Type.Union([Type.Literal('OUTLINE'), Type.Literal('POLISH')]),
  status: Type.Union([Type.Literal('OUTLINE'), Type.Literal('POLISH'),
    Type.Literal('NO_SUGGESTION')]),
  /** 分点建议的条目数；润色与「没有建议」时为 null。 */
  item_count: Type.Union([Type.Integer(), Type.Null()]),
  /** 分点建议文本或润色文本；「没有建议」时为 null。 */
  text: Type.Union([Type.String(), Type.Null()]),
}, { additionalProperties: false });

export function registerComposerRoutes(app: FastifyInstance,
  dependencies: RouteDependencies): void {
  // 每个实例一个闸门：最小间隔与并发上限，避免草稿辅助变成调用放大器。
  const gate = new ComposerDraftGate();

  app.post('/composer/draft-assist', {
    schema: { params: ParamsSchema, body: BodySchema, response: { 200: ResultSchema } },
  }, async (request, reply) => {
    try {
      const params = request.params as { workspace_id: string };
      const body = request.body as { operation: 'OUTLINE' | 'POLISH'; text: string };
      const outcome = await runComposerDraftAssist({
        db: dependencies.database.executor,
        workspaceId: params.workspace_id,
        env: process.env,
        operation: body.operation,
        text: body.text,
        gate,
      });
      return bodyOf(body.operation, outcome);
    } catch (error) {
      return sendReadError(reply, error, request.id);
    }
  });
}

function bodyOf(operation: 'OUTLINE' | 'POLISH', outcome: ComposerDraftOutcome): {
  operation: 'OUTLINE' | 'POLISH'; status: ComposerDraftOutcome['status'];
  item_count: number | null; text: string | null;
} {
  switch (outcome.status) {
    case 'OUTLINE':
      return { operation, status: 'OUTLINE', item_count: outcome.itemCount, text: outcome.text };
    case 'POLISH':
      return { operation, status: 'POLISH', item_count: null, text: outcome.text };
    case 'NO_SUGGESTION':
      return { operation, status: 'NO_SUGGESTION', item_count: null, text: null };
  }
}
