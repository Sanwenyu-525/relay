import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';

import { listChatCommands, resolveChatCommand } from '../application/chat-commands.js';
import { detectMethodIntent, isMethodDiscussion } from '../application/method-intent.js';
import { executeChatCommand } from '../application/execute-chat-command.js';
import { commandEnvelopeSchema } from './domain-schemas.js';
import { problemFromError, sendProblem, type RouteDependencies } from './envelope.js';

/**
 * 聊天 `/命令` 的登记查询、只读解析与有限执行端点。
 *
 * GET 菜单与 POST resolve 是纯解析：不写存储、不调用模型、不执行动作。前端用它在输入位置展开菜单
 * 并显示「本次采用的方法及范围」；因此「选中只插入输入、浏览/关闭菜单」天然零效果，
 * 未登记命令也不会被偷偷转成任意工具请求。
 *
 * 之所以用 POST 而不是 GET：输入文本可能较长且含换行，放进 query 既难编码也容易截断；
 * resolve 不携带 command_id，也不产生命令回执，语义上仍是只读查询。
 * POST 会话 chat-commands 才执行 /clear、/new、/undo，并沿原应用 Owner 返回持久回执。
 */

const strict = { additionalProperties: false } as const;
const base = Type.Object({ workspace_id: Type.String({ format: 'uuid' }) }, strict);

const resolveBody = Type.Object({ text: Type.String({ minLength: 0, maxLength: 32_768 }) }, strict);
const executeBody = Type.Object({ command_id: Type.String({ format: 'uuid' }),
  text: Type.String({ minLength: 1, maxLength: 32_768 }) }, strict);
const executeParams = Type.Object({ workspace_id: Type.String({ format: 'uuid' }),
  session_id: Type.String({ format: 'uuid' }) }, strict);
const nullableUuid = Type.Union([Type.String({ format: 'uuid' }), Type.Null()]);
const revision = Type.String({ pattern: '^(0|[1-9][0-9]*)$' });
const executeResult = Type.Union([
  Type.Object({ kind: Type.Literal('NEW_SESSION'),
    system: Type.Union([Type.Literal('clear'), Type.Literal('new')]),
    source_session_id: Type.String({ format: 'uuid' }), session_id: Type.String({ format: 'uuid' }),
    project_id: nullableUuid, task_id: nullableUuid,
    conversation_mode: Type.Union([Type.Literal('AGENT'), Type.Literal('ASSISTANT'), Type.Literal('LEARNING')]),
    assistant_profile_id: nullableUuid,
    assistant_profile_revision: Type.Union([revision, Type.Null()]), revision }, strict),
  Type.Object({ kind: Type.Literal('STATE_WITHDRAWAL'), system: Type.Literal('undo'),
    session_id: Type.String({ format: 'uuid' }), request_id: Type.String({ format: 'uuid' }),
    status: Type.String(), revision, undo_command_id: Type.String({ format: 'uuid' }) }, strict),
]);

const menuEntry = Type.Object({
  kind: Type.Union([Type.Literal('METHOD'), Type.Literal('SYSTEM')]),
  name: Type.String(), aliases: Type.Array(Type.String()), title: Type.String(),
  summary: Type.String(), usage: Type.String(),
  method_id: Type.Optional(Type.String()),
  system_id: Type.Optional(Type.String()),
}, { additionalProperties: false });

const resolutionDto = Type.Object({
  kind: Type.Union([Type.Literal('NOT_COMMAND'), Type.Literal('MENU'),
    Type.Literal('METHOD'), Type.Literal('SYSTEM'), Type.Literal('UNKNOWN_COMMAND'),
    Type.Literal('INVALID_ARGUMENT')]),
  /** 命令菜单：`/` 单独输入时返回登记项，不执行任何动作。 */
  menu: Type.Optional(Type.Array(menuEntry)),
  /** 已登记方法：冻结身份 + 本次行动与作用范围。 */
  method: Type.Optional(Type.Object({}, { additionalProperties: true })),
  argument: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  action: Type.Optional(Type.Union([Type.Literal('INSPECT'), Type.Literal('MODIFY')])),
  scope: Type.Optional(Type.Union([Type.Literal('CURRENT_TASK'), Type.Literal('CURRENT_CHANGES'),
    Type.Literal('RELATED_IMPACT'), Type.Literal('PROJECT')])),
  explicit_scope: Type.Optional(Type.Boolean()),
  system: Type.Optional(Type.String()),
  /** 自然语言识别到的候选方法（仅当未输入 `/` 命令时给出），供界面显示方法提示。 */
  detected_method: Type.Optional(Type.Object({}, { additionalProperties: true })),
  name: Type.Optional(Type.String()),
  detail: Type.Optional(Type.String()),
}, { additionalProperties: false });

export function registerChatCommandRoutes(app: FastifyInstance,
  dependencies: RouteDependencies): void {
  app.post('/assist-sessions/:session_id/chat-commands', {
    schema: { params: executeParams, body: executeBody,
      response: { 200: commandEnvelopeSchema(executeResult) } },
  }, async (request, reply) => {
    const params = request.params as { workspace_id: string; session_id: string };
    const body = request.body as { command_id: string; text: string };
    try {
      const outcome = await executeChatCommand(dependencies.database.executor, {
        workspaceId: params.workspace_id, sessionId: params.session_id,
        commandId: body.command_id, text: body.text });
      if (outcome.replayed) reply.header('command-replayed', 'true');
      const resource = outcome.result.kind === 'NEW_SESSION'
        ? `assist-sessions/${outcome.result.session_id}`
        : `conversation-state-requests/${outcome.result.request_id}`;
      return reply.code(200).send({ command_id: body.command_id,
        committed_at: outcome.committedAt.toISOString(), result: outcome.result,
        links: { resource: `/api/v1/workspaces/${params.workspace_id}/${resource}` } });
    } catch (error) {
      return sendProblem(reply, problemFromError(error, body.command_id), request.id);
    }
  });

  app.post('/chat-commands/resolve', {
    schema: { params: base, body: resolveBody, response: { 200: resolutionDto } },
  }, async (request) => {
    const body = request.body as { text: string };
    const resolution = resolveChatCommand(body.text);
    switch (resolution.kind) {
      case 'NOT_COMMAND': {
        // 普通自然语言：附上识别到的方法候选，讨论时明确标出"只是讨论"。
        const intent = detectMethodIntent(body.text);
        return { kind: 'NOT_COMMAND' as const,
          ...(intent === null ? {} : { detected_method: {
            id: intent.method_id, action: intent.action, scope: intent.scope,
            explicit_scope: intent.explicit_scope,
            discussion: intent.discussion || isMethodDiscussion(body.text),
            matched: [...intent.matched],
          } }) };
      }
      case 'MENU':
        return { kind: 'MENU' as const, menu: resolution.entries.map((entry) => ({
          kind: entry.kind, name: entry.name, aliases: [...entry.aliases],
          title: entry.title, summary: entry.summary, usage: entry.usage,
          ...(entry.method_id === undefined ? {} : { method_id: entry.method_id }),
          ...(entry.system_id === undefined ? {} : { system_id: entry.system_id }),
        })) };
      case 'METHOD':
        return { kind: 'METHOD' as const,
          method: { id: resolution.method.id, version: resolution.method.version,
            sha256: resolution.method.sha256, title: resolution.method.title,
            command: resolution.method.command,
            default_scope: resolution.method.default_scope,
            default_action: resolution.method.default_action },
          argument: resolution.argument === '' ? null : resolution.argument,
          action: resolution.action, scope: resolution.scope, explicit_scope: false };
      case 'SYSTEM':
        return { kind: 'SYSTEM' as const, system: resolution.system,
          argument: resolution.argument };
      case 'UNKNOWN_COMMAND':
        return { kind: 'UNKNOWN_COMMAND' as const, name: resolution.name,
          detail: resolution.detail };
      default:
        return { kind: 'INVALID_ARGUMENT' as const, name: resolution.name,
          detail: resolution.detail };
    }
  });

  /** 菜单登记项：英文固定名与中文别名共用同一条目，供前端输入位置渲染。 */
  app.get('/chat-commands', { schema: { params: base,
    response: { 200: Type.Object({ items: Type.Array(menuEntry) }, strict) } } },
  async () => ({ items: listChatCommands().map((entry) => ({
    kind: entry.kind, name: entry.name, aliases: [...entry.aliases], title: entry.title,
    summary: entry.summary, usage: entry.usage,
    ...(entry.method_id === undefined ? {} : { method_id: entry.method_id }),
    ...(entry.system_id === undefined ? {} : { system_id: entry.system_id }),
  })) }));
}
