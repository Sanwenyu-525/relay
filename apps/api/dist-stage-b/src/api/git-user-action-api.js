import { Type } from '@sinclair/typebox';
import { LOCAL_ACTOR_REF } from '../application/actor.js';
import { validationFailed } from '../application/domain-error.js';
import { assertUserGitAction, runUserGitReadCommand } from '../application/git-user-action.js';
import { commandEnvelopeSchema } from './domain-schemas.js';
import { createCommandHandler } from './envelope.js';
/**
 * 人工触发的 Git 只读端点。
 *
 * 形状与既有 Gateway 端点一致：作用域在路径上、命令身份在正文里、成功回执走 command envelope，
 * 重放附 `Command-Replayed: true`。端点本身不判定权限、不解析路径、不碰磁盘——准入与规范化
 * 全在 `git-user-action.ts` 与 `prepareGatewayAction` 里，因此新增第二个调用方不会绕过同一套栅栏。
 *
 * 这是**只读**入口：只接受 GIT_STATUS 与 GIT_DIFF。暂存、提交、推送与受控 CLI 不在此处，
 * 它们仍只有 RUN 来源。
 */
const strict = { additionalProperties: false };
const uuid = Type.String({ format: 'uuid' });
const actionTypeSchema = Type.Union([Type.Literal('GIT_STATUS'), Type.Literal('GIT_DIFF')]);
const params = Type.Object({
    workspace_id: uuid, project_id: uuid, resource_id: uuid,
}, strict);
const readBody = Type.Object({
    command_id: uuid,
    connection_id: uuid,
    action_type: actionTypeSchema,
    /** 根内相对路径。不接受绝对路径，也不接受 '..'——解析不到就是 409/422，不猜。 */
    path: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
    cached: Type.Optional(Type.Boolean()),
    /** GIT_STATUS 是路径条目数上限，GIT_DIFF 是正文字节上限。 */
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 262144 })),
}, strict);
/**
 * 结果三形态并存，客户端不靠「字段缺失」猜成败：
 *   * 状态投影：三个路径列表 + `limit` + `truncated` + 真实计数；
 *   * 差异投影：正文 + 字节上限 + 实际返回与省略字节数；
 *   * 失败投影：只有类型化 `reason`。空列表绝不冒充「干净」。
 */
const gitReadResult = Type.Union([
    Type.Object({
        branch: Type.String(), head_commit: Type.Union([Type.String(), Type.Null()]),
        staged: Type.Array(Type.String()), unstaged: Type.Array(Type.String()),
        untracked: Type.Array(Type.String()), limit: Type.Integer(),
        truncated: Type.Boolean(),
        totals: Type.Object({ staged: Type.Integer(), unstaged: Type.Integer(), untracked: Type.Integer() }, strict),
    }, strict),
    Type.Object({
        diff: Type.String(), limit_bytes: Type.Integer(), truncated: Type.Boolean(),
        returned_bytes: Type.Integer(), omitted_bytes: Type.Integer(),
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
    result: gitReadResult,
}, strict);
export const GitUserActionReadResultSchema = Type.Union([settledResult, pendingResult]);
export function registerGitUserActionRoutes(app, dependencies) {
    app.post('/projects/:project_id/managed-resources/:resource_id/git-read', {
        schema: { params, body: readBody, response: { 200: commandEnvelopeSchema(GitUserActionReadResultSchema) } },
    }, createCommandHandler(dependencies, {
        commandType: 'ReadManagedGitState',
        bodySchema: readBody,
        execute: async ({ executor, body, params: pathParams }) => {
            assertUserGitAction(body.action_type);
            if (body.action_type === 'GIT_STATUS' && (body.path !== undefined || body.cached !== undefined)) {
                throw validationFailed([{ field: 'action_type', message: 'git_status takes no path or cached' }]);
            }
            const outcome = await runUserGitReadCommand(executor, {
                workspaceId: pathParams.workspace_id ?? '',
                projectId: pathParams.project_id ?? '',
                resourceId: pathParams.resource_id ?? '',
                connectionId: body.connection_id,
                actionType: body.action_type,
                ...(body.path === undefined ? {} : { relativePath: body.path }),
                ...(body.cached === undefined ? {} : { cached: body.cached }),
                ...(body.limit === undefined ? {} : { limit: body.limit }),
                // 人工主体是服务端固定的本机单用户；客户端不能通过任何字段替换它。
                actorRef: LOCAL_ACTOR_REF,
                commandId: body.command_id,
            });
            // 读取本身在事务外执行并已结算，因此回执描述的是本次读取的真实结果；等待确认或在途
            // 未决时 result 里是 pending 形态（只有 reason，没有结果字段）。
            const result = outcome.result;
            return { outcome: { result, replayed: outcome.replayed, committedAt: outcome.committedAt }, result };
        },
    }));
}
