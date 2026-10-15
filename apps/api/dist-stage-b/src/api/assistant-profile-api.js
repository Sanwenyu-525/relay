import { Type } from '@sinclair/typebox';
import { archiveAssistantProfile, createAssistantProfile, reviseAssistantProfile } from '../application/assistant-profile-commands.js';
import { AssistantProfileRepository } from '../assist/assistant-profile-repository.js';
import { toDecimalString } from '../shared/decimal.js';
import { commandEnvelopeSchema } from './domain-schemas.js';
import { createCommandHandler, sendReadError } from './envelope.js';
/**
 * 人设 助手配置端点（迁移 0059、ADR-018）。
 *
 * 形状与既有命令端点一致：作用域在路径上、命令身份在正文里、成功回执走 command envelope，
 * 重放附 `Command-Replayed: true`。
 *
 * 这里**只管配置文本**：能力、连接与权限不出现在本文件的任何 schema 里。
 * 只读范围 `read_scope` 只接受 `{}` 或 `{ roots: [...] }`（受管根内相对路径），
 * 由 `validateReadScope` 判定——助手只能缩小范围，不能靠配置扩大自己的授权。
 *
 * Breaking Change：Yes（新增端点，不改既有端点）。
 */
const strict = { additionalProperties: false };
const uuid = Type.String({ format: 'uuid' });
const rev = Type.String({ pattern: '^(0|[1-9][0-9]*)$' });
const workspaceParams = Type.Object({ workspace_id: uuid }, strict);
const assistantParams = Type.Object({ workspace_id: uuid, id: uuid }, strict);
const readScope = Type.Union([
    Type.Object({}, strict),
    Type.Object({
        roots: Type.Array(Type.String({ minLength: 1, maxLength: 400 }), { maxItems: 20 }),
    }, strict),
]);
const createBody = Type.Object({
    command_id: uuid,
    name: Type.String({ minLength: 1, maxLength: 60 }),
    role_description: Type.String({ minLength: 1, maxLength: 2000 }),
    tone: Type.Optional(Type.String({ minLength: 1, maxLength: 400 })),
    read_scope: Type.Optional(readScope),
}, strict);
const reviseBody = Type.Object({
    command_id: uuid,
    expected_revision: rev,
    name: Type.String({ minLength: 1, maxLength: 60 }),
    role_description: Type.String({ minLength: 1, maxLength: 2000 }),
    tone: Type.Optional(Type.String({ minLength: 1, maxLength: 400 })),
    read_scope: Type.Optional(readScope),
}, strict);
const archiveBody = Type.Object({ command_id: uuid, expected_revision: rev }, strict);
const AssistantProfileResult = Type.Object({
    assistant_profile_id: uuid, workspace_id: uuid,
    name: Type.String(), role_description: Type.String(),
    tone: Type.Union([Type.String(), Type.Null()]),
    read_scope: Type.Object({}, { additionalProperties: true }),
    status: Type.Union([Type.Literal('ACTIVE'), Type.Literal('ARCHIVED')]),
    revision: rev,
}, strict);
const AssistantProfileDto = Type.Object({
    id: uuid, workspace_id: uuid,
    name: Type.String(), role_description: Type.String(),
    tone: Type.Union([Type.String(), Type.Null()]),
    read_scope: Type.Object({}, { additionalProperties: true }),
    status: Type.Union([Type.Literal('ACTIVE'), Type.Literal('ARCHIVED')]),
    revision: rev,
    created_at: Type.String(), updated_at: Type.String(),
}, strict);
/** 归档的 助手 也在列表里：既有会话要能显示「这个 助手已归档」。只列活跃的用 status=ACTIVE。 */
const listQuery = Type.Object({ status: Type.Optional(Type.Union([Type.Literal('ACTIVE'), Type.Literal('ARCHIVED')])) }, strict);
function profileDto(row) {
    return { id: row.id, workspace_id: row.workspace_id, name: row.name,
        role_description: row.role_description, tone: row.tone, read_scope: row.read_scope,
        status: row.status, revision: toDecimalString(row.revision),
        created_at: row.created_at.toISOString(), updated_at: row.updated_at.toISOString() };
}
export function registerAssistantProfileRoutes(app, dependencies) {
    app.post('/assistant-profiles', { schema: { params: workspaceParams, body: createBody,
            response: { 201: commandEnvelopeSchema(AssistantProfileResult) } } }, createCommandHandler(dependencies, { commandType: 'CreateAssistantProfile',
        bodySchema: createBody,
        execute: async ({ executor, params, body }) => {
            const outcome = await createAssistantProfile(executor, {
                workspaceId: params.workspace_id ?? '', commandId: body.command_id,
                name: body.name, roleDescription: body.role_description,
                ...(body.tone === undefined ? {} : { tone: body.tone }),
                ...(body.read_scope === undefined ? {} : { readScope: body.read_scope }),
            });
            return { outcome, result: outcome.result };
        } }));
    app.post('/assistant-profiles/:id/revision', { schema: { params: assistantParams, body: reviseBody,
            response: { 200: commandEnvelopeSchema(AssistantProfileResult) } } }, createCommandHandler(dependencies, { commandType: 'ReviseAssistantProfile',
        bodySchema: reviseBody,
        execute: async ({ executor, params, body }) => {
            const outcome = await reviseAssistantProfile(executor, {
                workspaceId: params.workspace_id ?? '', assistantProfileId: params.id ?? '',
                commandId: body.command_id, expectedRevision: body.expected_revision,
                name: body.name, roleDescription: body.role_description,
                ...(body.tone === undefined ? {} : { tone: body.tone }),
                ...(body.read_scope === undefined ? {} : { readScope: body.read_scope }),
            });
            return { outcome, result: outcome.result };
        } }));
    app.post('/assistant-profiles/:id/archive', { schema: { params: assistantParams, body: archiveBody,
            response: { 200: commandEnvelopeSchema(AssistantProfileResult) } } }, createCommandHandler(dependencies, { commandType: 'ArchiveAssistantProfile',
        bodySchema: archiveBody,
        execute: async ({ executor, params, body }) => {
            const outcome = await archiveAssistantProfile(executor, {
                workspaceId: params.workspace_id ?? '', assistantProfileId: params.id ?? '',
                commandId: body.command_id, expectedRevision: body.expected_revision
            });
            return { outcome, result: outcome.result };
        } }));
    app.get('/assistant-profiles', { schema: { params: workspaceParams, querystring: listQuery,
            response: { 200: Type.Object({ items: Type.Array(AssistantProfileDto) }, strict) } } }, async (request, reply) => {
        try {
            const p = request.params;
            const q = request.query;
            const repository = new AssistantProfileRepository(dependencies.database.executor);
            const rows = q.status === 'ARCHIVED'
                ? (await repository.listAll(p.workspace_id)).filter((row) => row.status === 'ARCHIVED')
                : await repository.listActive(p.workspace_id);
            return { items: rows.map(profileDto) };
        }
        catch (error) {
            return sendReadError(reply, error, request.id);
        }
    });
}
