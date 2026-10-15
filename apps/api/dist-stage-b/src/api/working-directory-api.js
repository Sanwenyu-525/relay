import { Type } from '@sinclair/typebox';
import { openWorkingDirectory } from '../application/open-working-directory.js';
import { createCommandHandler } from './envelope.js';
import { commandEnvelopeSchema } from './domain-schemas.js';
const strict = { additionalProperties: false };
const uuid = Type.String({ format: 'uuid' });
const candidateSchema = Type.Object({
    project_id: uuid,
    project_title: Type.String(),
    project_archived: Type.Boolean(),
    resource_id: uuid,
    resource_status: Type.String(),
    file_write_identity_bound: Type.Boolean(),
}, strict);
const openResultSchema = Type.Object({
    canonical_root: Type.String(),
    display_name: Type.String(),
    status: Type.Union([Type.Literal('READY'), Type.Literal('AMBIGUOUS'), Type.Literal('NOT_READY')]),
    reason: Type.Union([Type.String(), Type.Null()]),
    association: Type.Union([candidateSchema, Type.Null()]),
    created_project: Type.Boolean(),
    created_resource: Type.Boolean(),
    candidates: Type.Array(candidateSchema),
    write_readiness: Type.Object({
        status: Type.String(),
        detail: Type.String(),
    }, strict),
}, strict);
const openBody = Type.Object({
    command_id: uuid,
    root_path: Type.String({ minLength: 1, maxLength: 1024 }),
    project_id: Type.Optional(Type.Union([uuid, Type.Null()])),
}, strict);
/**
 * 工作台 §18.1 的文件夹入口。写命令：可能建立最小 Project/受管资源，因此读取页面不得调用它。
 * 取消选择、目录无效和登记失败都由调用方保留草稿并说明，不在这里伪造就绪状态。
 */
export function registerWorkingDirectoryRoutes(app, dependencies) {
    app.post('/working-directories/open', {
        schema: { body: openBody, response: { 200: commandEnvelopeSchema(openResultSchema) } },
    }, createCommandHandler(dependencies, { commandType: 'OpenWorkingDirectory', bodySchema: openBody,
        execute: async ({ executor, params, body }) => {
            const outcome = await openWorkingDirectory(executor, { workspaceId: params.workspace_id ?? '',
                commandId: body.command_id, rootPath: body.root_path, projectId: body.project_id ?? null });
            return { outcome, result: outcome.result };
        } }));
}
