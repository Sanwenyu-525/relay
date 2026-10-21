/**
 * 插件状态 API（2026-10-20，P0-2）。
 *
 *   GET /plugins/status   三个内置插件的**运行时**可用性（安装、运行时、登录）
 *
 * 为什么单独一个端点：插件此前只有「项目连接登记」这一个事实来源，于是没有项目归属时
 * 界面读不到任何状态，用户被送去通用配置页猜。运行时事实是安装级的（与项目无关），
 * 项目级授权仍由 `/projects/{id}/connections` 回答——两个问题分开问，界面才能只说
 * 缺的那一步。
 *
 * 这里不做授权判定，也不返回任何凭据：只回答「能不能跑」。
 */

import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';

import { readBrowserBackendState } from '../browser/state.js';
import { computerRuntimeStatus, githubRuntimeStatus, type PluginRuntimeStatus }
  from '../plugins/runtime-status.js';
import { sendReadError, type RouteDependencies } from './envelope.js';

const strict = { additionalProperties: false } as const;

const itemSchema = Type.Object({
  plugin: Type.Union([Type.Literal('computer'), Type.Literal('browser'), Type.Literal('github')]),
  state: Type.String(),
  detail: Type.String(),
  remediation: Type.Union([Type.String(), Type.Null()]),
}, strict);

const responseSchema = Type.Object({ items: Type.Array(itemSchema) }, strict);

/** 浏览器后端的六种状态映射成同一套插件状态词表；未知状态一律 UNAVAILABLE，不猜成可用。 */
function browserStatus(state: Awaited<ReturnType<typeof readBrowserBackendState>>): PluginRuntimeStatus {
  const mapped: PluginRuntimeStatus['state'] =
    state.status === 'READY' ? 'READY'
      : state.status === 'NOT_STARTED' || state.status === 'DISCONNECTED' ? 'NOT_PAIRED'
        : state.status === 'CHROME_MISSING' || state.status === 'BACKEND_MISSING' ? 'NOT_INSTALLED'
          : 'UNAVAILABLE';
  return { plugin: 'browser', state: mapped, detail: state.detail, remediation: state.remediation };
}

export function registerPluginRoutes(app: FastifyInstance, dependencies: RouteDependencies): void {
  app.get('/plugins/status', { schema: { response: { 200: responseSchema } } },
    async (request, reply) => {
      // 与其它运行时投影一致：结论随本机状态变化，绝不缓存。
      reply.header('Cache-Control', 'no-store');
      try {
        const [browser, github] = await Promise.all([
          readBrowserBackendState(dependencies.database.executor),
          githubRuntimeStatus(),
        ]);
        return { items: [computerRuntimeStatus(), browserStatus(browser), github] };
      } catch (error) {
        return sendReadError(reply, error, request.id);
      }
    });
}
