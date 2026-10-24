import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';

import { LOCAL_ACTOR_REF } from '../application/actor.js';
import { assertUserFileAction, runUserFileReadCommand } from '../application/file-user-action.js';
import type { JsonObject } from '../infrastructure/json.js';
import { commandEnvelopeSchema } from './domain-schemas.js';
import { createCommandHandler, type RouteDependencies } from './envelope.js';

/**
 * 人工触发的受管目录浏览与文件读取端点（工具面板「文件」页签后端，2026-10-24）。
 *
 * 形状与既有 git-read 端点一致：作用域在路径上、命令身份在正文里、成功回执走 command envelope，
 * 重放附 `Command-Replayed: true`。端点本身不判定权限、不解析路径、不碰磁盘——准入与规范化
 * 全在 `file-user-action.ts` 与 `prepareGatewayAction` 里，因此新增第二个调用方不会绕过同一套栅栏。
 *
 * 这是**只读**入口：只接受 LIST_DIRECTORY 与 READ_FILE。FIND_PATHS / SEARCH_TEXT / 写动作
 * 不在此处，它们仍只有 RUN 来源。
 */

const strict = { additionalProperties: false } as const;
const uuid = Type.String({ format: 'uuid' });
const actionTypeSchema = Type.Union([Type.Literal('LIST_DIRECTORY'), Type.Literal('READ_FILE')]);

const params = Type.Object({
  workspace_id: uuid, project_id: uuid, resource_id: uuid,
}, strict);

const readBody = Type.Object({
  command_id: uuid,
  connection_id: uuid,
  action_type: actionTypeSchema,
  /** 根内相对路径。LIST_DIRECTORY 缺省表示受管根自身；READ_FILE 必填。不接受绝对路径或 '..'。 */
  path: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
  /** LIST_DIRECTORY 的条目数上限（适配器硬上限 200）；READ_FILE 不接受。 */
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
}, strict);

/** 目录条目：path 是查询目录内的一层相对名，kind 区分 directory/file/other。 */
const listEntry = Type.Object({
  path: Type.String(), kind: Type.String(), size: Type.Union([Type.Integer(), Type.Null()]),
}, strict);

/**
 * 结果三形态并存，客户端不靠「字段缺失」猜成败：
 *   * 目录投影：一层条目 + count + limit + truncated + skipped；
 *   * 文件投影：正文 + 字节数 + SHA-256（上限与二进制拒绝由适配器裁决并类型化失败）；
 *   * 失败投影：只有类型化 `reason`。空条目列表绝不冒充「目录为空读取成功以外的东西」。
 */
const fileReadResult = Type.Union([
  Type.Object({
    directory: Type.String(), entries: Type.Array(listEntry), count: Type.Integer(),
    limit: Type.Integer(), truncated: Type.Boolean(), skipped: Type.Integer(),
    target: Type.String(), action_type: Type.String(), invocation_id: Type.String(),
    operation_id: Type.String(),
  }, strict),
  Type.Object({
    target: Type.String(), size: Type.Integer(), sha256: Type.String(),
    truncated: Type.Boolean(), content: Type.String(),
    invocation_id: Type.String(), operation_id: Type.String(),
  }, strict),
  Type.Object({ reason: Type.String(), detail: Type.Optional(Type.String()) }, strict),
]);

/** 等待确认或在途未决：此形态不携带任何结果字段冒充已读到内容。 */
const pendingResult = Type.Object({
  state: Type.Union([Type.Literal('WAITING_APPROVAL'), Type.Literal('UNRESOLVED')]),
  action_type: actionTypeSchema,
  operation_id: uuid,
  review_id: Type.Union([uuid, Type.Null()]),
  reason: Type.String(),
}, strict);

const settledResult = Type.Object({
  state: Type.Union([Type.Literal('SUCCEEDED'), Type.Literal('FAILED')]),
  action_type: actionTypeSchema,
  operation_id: uuid,
  invocation_id: Type.Union([uuid, Type.Null()]),
  result: fileReadResult,
}, strict);

export const FileUserActionReadResultSchema = Type.Union([settledResult, pendingResult]);

export function registerFileUserActionRoutes(app: FastifyInstance, dependencies: RouteDependencies): void {
  app.post('/projects/:project_id/managed-resources/:resource_id/file-read', {
    schema: { params, body: readBody, response: { 200: commandEnvelopeSchema(FileUserActionReadResultSchema) } },
  }, createCommandHandler(dependencies, {
    commandType: 'ReadManagedFileState',
    bodySchema: readBody,
    execute: async ({ executor, body, params: pathParams }) => {
      assertUserFileAction(body.action_type);
      const outcome = await runUserFileReadCommand(executor, {
        workspaceId: pathParams.workspace_id ?? '',
        projectId: pathParams.project_id ?? '',
        resourceId: pathParams.resource_id ?? '',
        connectionId: body.connection_id,
        actionType: body.action_type,
        ...(body.path === undefined ? {} : { relativePath: body.path }),
        ...(body.limit === undefined ? {} : { limit: body.limit }),
        // 人工主体是服务端固定的本机单用户；客户端不能通过任何字段替换它。
        actorRef: LOCAL_ACTOR_REF,
        commandId: body.command_id,
      });
      // 读取本身在事务外执行并已结算，因此回执描述的是本次读取的真实结果；等待确认或在途
      // 未决时 result 里是 pending 形态（只有 reason，没有结果字段）。
      const result = outcome.result as unknown as JsonObject;
      return { outcome: { result, replayed: outcome.replayed, committedAt: outcome.committedAt }, result };
    },
  }));
}
