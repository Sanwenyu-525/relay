import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import test, { after, before } from 'node:test';

import { sql } from 'kysely';

import { createAssistSession, requestAssistMessage }
  from '../../src/application/assist-commands.js';
import {
  MAX_ASSIST_ATTACHMENTS_PER_MESSAGE, MAX_ASSIST_ATTACHMENT_BYTES,
  uploadAssistMessageAttachment,
} from '../../src/application/assist-attachments.js';
import { listAssistMessageAttachmentMeta, readAssistMessageAttachment }
  from '../../src/application/assist-queries.js';
import { withTransaction } from '../../src/application/unit-of-work.js';
import { DomainError } from '../../src/application/domain-error.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { createDataRoot, startTestApi, workspacePath } from './api-harness.js';
import { APP_DATABASE_URL, MIGRATIONS_DIRECTORY, MIGRATION_DATABASE_URL,
  openDatabase } from './integration-support.js';

/**
 * 0093 图片附件的真实 PG 验证（HTTP §10.85、工作台 §33）：
 * 上传暂存 → 消息命令同一事务绑定 → 消息投影的元数据 → 单张内容读取的作用域隔离；
 * 以及 2026-10-18 放开的两件事：「只有图片、没有正文」的讨论轮与未入目录模型的能力声明。
 *
 * 不用 Fake 模型端口：这里验证的是命令与存储契约，生成链路另在 assist.integration 覆盖。
 */

const app = openDatabase(APP_DATABASE_URL, 'relay-api-test-assist-attachments');
let dataRoot: string;
before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
  dataRoot = await createDataRoot();
});
after(async () => { await app.close(); await rm(dataRoot, { recursive: true, force: true }); });

/** 一个工作空间 + 项目，够建 Assist 会话即可（附件不参与项目业务）。 */
async function workspaceFixture(): Promise<{ workspaceId: string; projectId: string }> {
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  await withTransaction(app.db, async (r) => {
    await r.workspaces.insertWorkspace({ id: workspaceId, name: `p93-${workspaceId}` });
    await r.workspaces.insertAuthorityRow(workspaceId);
    await r.projects.insertProject({ id: projectId, workspaceId, title: 'P93 项目',
      projectType: 'GENERAL' });
    await r.projects.insertProjectState(projectId, 'PLANNING');
  });
  return { workspaceId, projectId };
}

async function newSession(workspaceId: string, projectId: string): Promise<string> {
  const created = await createAssistSession(app.db, { workspaceId, commandId: randomUUID(),
    projectId, taskId: null, title: '图片附件会话' });
  return created.result.session_id;
}

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);

async function uploadPng(sessionId: string, workspaceId: string, name = '截图.png'):
Promise<string> {
  const uploaded = await uploadAssistMessageAttachment(app.db, { workspaceId, sessionId, name,
    mediaType: 'image/png', dataBase64: PNG_BYTES.toString('base64') });
  return uploaded.attachment_id;
}

function domainError(error: unknown): DomainError {
  assert.ok(error instanceof DomainError, `expected DomainError, got ${String(error)}`);
  return error;
}

async function readUserMessage(messageId: string): Promise<{ content: string | null }> {
  const row = await sql<{ content: string | null }>`select content from assist_messages
    where id = ${messageId}`.execute(app.db);
  return row.rows[0]!;
}

test('图片随消息绑定：元数据进投影，内容按单张读取，跨会话按不可见拒绝', async () => {
  const f = await workspaceFixture();
  const sessionId = await newSession(f.workspaceId, f.projectId);
  const attachmentId = await uploadPng(sessionId, f.workspaceId);

  // 只有图片、没有正文：2026-10-18 起这是合法的讨论轮（content 落空串，不是 NULL）。
  const requested = await requestAssistMessage(app.db, { workspaceId: f.workspaceId,
    sessionId, commandId: randomUUID(), content: ' ', intent: 'DISCUSS',
    attachmentIds: [attachmentId], chatModelName: undefined, declaredImageInput: true });
  const userMessageId = requested.result.user_message_id;
  assert.equal((await readUserMessage(userMessageId)).content, '');

  const meta = await listAssistMessageAttachmentMeta(app.db, { workspaceId: f.workspaceId,
    sessionId, messageIds: [userMessageId] });
  assert.deepEqual(meta.get(userMessageId)?.map((item) => [item.name, item.mediaType, item.byteLength]),
    [['截图.png', 'image/png', PNG_BYTES.byteLength]]);

  const content = await readAssistMessageAttachment(app.db, { workspaceId: f.workspaceId,
    sessionId, attachmentId });
  assert.equal(content.dataBase64, PNG_BYTES.toString('base64'));

  // 同一张图不能再被第二条消息绑定：绑定入口只接受 message_id IS NULL。
  const reused = domainError(await requestAssistMessage(app.db, { workspaceId: f.workspaceId,
    sessionId, commandId: randomUUID(), content: '再来一次', attachmentIds: [attachmentId],
    declaredImageInput: true }).catch((error) => error));
  assert.equal(reused.code, 'RESOURCE_NOT_FOUND');

  // 另一个会话（同 Workspace、同附件 id）看不到这张图。
  const otherSession = await newSession(f.workspaceId, f.projectId);
  const crossSession = domainError(await readAssistMessageAttachment(app.db, {
    workspaceId: f.workspaceId, sessionId: otherSession, attachmentId }).catch((error) => error));
  assert.equal(crossSession.code, 'RESOURCE_NOT_FOUND');
  // 另一个 Workspace 同样看不到：workspace 与 session 两个归属条件都核对。
  const otherWorkspace = await workspaceFixture();
  const crossWorkspace = domainError(await readAssistMessageAttachment(app.db, {
    workspaceId: otherWorkspace.workspaceId, sessionId, attachmentId }).catch((error) => error));
  assert.equal(crossWorkspace.code, 'RESOURCE_NOT_FOUND');
});

test('空正文的例外只给带图片的讨论轮：无附件、Skill 与提案意图仍按原规则拒绝', async () => {
  const f = await workspaceFixture();
  const sessionId = await newSession(f.workspaceId, f.projectId);

  const empty = domainError(await requestAssistMessage(app.db, { workspaceId: f.workspaceId,
    sessionId, commandId: randomUUID(), content: '   ' }).catch((error) => error));
  assert.equal(empty.code, 'VALIDATION_FAILED');

  const attachmentId = await uploadPng(sessionId, f.workspaceId);
  const withSkill = domainError(await requestAssistMessage(app.db, { workspaceId: f.workspaceId,
    sessionId, commandId: randomUUID(), content: '', attachmentIds: [attachmentId],
    skillRef: { id: 'task-to-execution-contract', version: '1.1.0' }, skillInput: {},
    declaredImageInput: true }).catch((error) => error));
  assert.equal(withSkill.code, 'VALIDATION_FAILED');

  const propose = domainError(await requestAssistMessage(app.db, { workspaceId: f.workspaceId,
    sessionId, commandId: randomUUID(), content: '',
    attachmentIds: [attachmentId], intent: 'PROPOSE_CANDIDATE',
    declaredImageInput: true }).catch((error) => error));
  assert.equal(propose.code, 'VALIDATION_FAILED');
});

test('能力闸门：目录无条目时只有显式声明放行，未声明一律拒绝', async () => {
  const f = await workspaceFixture();
  const sessionId = await newSession(f.workspaceId, f.projectId);
  const attachmentId = await uploadPng(sessionId, f.workspaceId);

  // 本机默认模型（例如自建 Provider）通常不在 OpenRouter 目录里：未声明就是未知，按拒绝处理。
  const rejected = domainError(await requestAssistMessage(app.db, { workspaceId: f.workspaceId,
    sessionId, commandId: randomUUID(), content: '看这张图',
    attachmentIds: [attachmentId], chatModelName: 'not-in-catalog-model' }).catch((error) => error));
  assert.equal(rejected.code, 'VALIDATION_FAILED');
  assert.match(String(rejected.fieldErrors[0]?.message ?? ''), /RELAY_MODEL_IMAGE_INPUT/u);

  // 声明之后放行；声明只补「目录里没有条目」这处空白，不放宽目录里明确说不支持的模型。
  const accepted = await requestAssistMessage(app.db, { workspaceId: f.workspaceId,
    sessionId, commandId: randomUUID(), content: '看这张图',
    attachmentIds: [attachmentId], chatModelName: 'not-in-catalog-model',
    declaredImageInput: true });
  assert.equal(typeof accepted.result.assistant_message_id, 'string');
});

test('上传裁决：类型白名单、单张上限、每消息数量与总量都在写入前拒绝', async () => {
  const f = await workspaceFixture();
  const sessionId = await newSession(f.workspaceId, f.projectId);

  const wrongType = domainError(await uploadAssistMessageAttachment(app.db, {
    workspaceId: f.workspaceId, sessionId, name: '说明.pdf', mediaType: 'application/pdf',
    dataBase64: PNG_BYTES.toString('base64') }).catch((error) => error));
  assert.equal(wrongType.code, 'VALIDATION_FAILED');

  const tooBig = Buffer.alloc(MAX_ASSIST_ATTACHMENT_BYTES + 1, 1);
  const oversize = domainError(await uploadAssistMessageAttachment(app.db, {
    workspaceId: f.workspaceId, sessionId, name: '大图.png', mediaType: 'image/png',
    dataBase64: tooBig.toString('base64') }).catch((error) => error));
  assert.equal(oversize.code, 'VALIDATION_FAILED');

  const ids: string[] = [];
  for (let index = 0; index <= MAX_ASSIST_ATTACHMENTS_PER_MESSAGE; index += 1) {
    ids.push(await uploadPng(sessionId, f.workspaceId, `图${index}.png`));
  }
  const tooMany = domainError(await requestAssistMessage(app.db, { workspaceId: f.workspaceId,
    sessionId, commandId: randomUUID(), content: '五张图', attachmentIds: ids,
    declaredImageInput: true }).catch((error) => error));
  assert.equal(tooMany.code, 'VALIDATION_FAILED');

  const duplicate = domainError(await requestAssistMessage(app.db, { workspaceId: f.workspaceId,
    sessionId, commandId: randomUUID(), content: '重复引用', attachmentIds: [ids[0]!, ids[0]!],
    declaredImageInput: true }).catch((error) => error));
  assert.equal(duplicate.code, 'VALIDATION_FAILED');

  // 已被拒绝的命令没有绑定任何一行：四张以内仍可正常绑定。
  const accepted = await requestAssistMessage(app.db, { workspaceId: f.workspaceId, sessionId,
    commandId: randomUUID(), content: '', attachmentIds: ids.slice(0, 2),
    declaredImageInput: true });
  const bound = await withTransaction(app.db, async (r) =>
    r.assist.listAttachmentsByMessage(accepted.result.user_message_id));
  assert.equal(bound.length, 2);
  // 未引用的行仍在：附件不是幂等命令，被拒绝的尝试不会伪造或删除已上传内容。
  // 用原始查询而不是 listAttachmentsByMessages：后者按 `message_id in (…)` 过滤，
  // 恰好只会返回已绑定的行，读不到「暂存未引用」这一态。
  const orphans = await sql<{ count: string }>`select count(*)::text as count
    from assist_message_attachments where message_id is null
      and id in (${sql.join(ids.slice(2))})`.execute(app.db);
  assert.equal(orphans.rows[0]!.count, '3');
});

/**
 * HTTP 面：上传/消息列表/内容读取三个端点的真实形状。
 *
 * 这条用例存在的原因很具体：用例层用 camelCase，响应 schema 用 snake_case，
 * schema 会把未声明字段直接丢掉——只测应用函数的话，「字段名对不上所以返回空体」
 * 这类缺陷完全看不出来（本轮就是这样发现 GET 投影被漏掉的）。
 */
test('HTTP：上传返回身份、消息列表带附件元数据、内容端点按契约形状读回', async () => {
  const api = await startTestApi();
  try {
    const f = await workspaceFixture();
    const sessionId = await newSession(f.workspaceId, f.projectId);
    const base = workspacePath(f.workspaceId);

    const uploaded = await api.post(`${base}/assist-sessions/${sessionId}/message-attachments`, {
      name: '截图.png', media_type: 'image/png', data_base64: PNG_BYTES.toString('base64') });
    assert.equal(uploaded.status, 201);
    const attachmentId = (uploaded.body as { attachment_id: string }).attachment_id;
    assert.equal(typeof attachmentId, 'string');

    const sent = await api.post(`${base}/assist-sessions/${sessionId}/messages`, {
      command_id: randomUUID(), content: '', attachment_ids: [attachmentId] });
    // 能力闸门在 HTTP 层按进程默认模型裁决：测试进程没有模型目录条目，
    // 因此这里断言的是「拒绝且说明可声明」，而不是假装图片能发。
    assert.equal(sent.status, 422);
    assert.match(JSON.stringify(sent.body), /RELAY_MODEL_IMAGE_INPUT/u);

    const direct = await requestAssistMessage(app.db, { workspaceId: f.workspaceId, sessionId,
      commandId: randomUUID(), content: '', attachmentIds: [attachmentId],
      declaredImageInput: true });

    const messages = await api.get(`${base}/assist-sessions/${sessionId}/messages`);
    assert.equal(messages.status, 200);
    const items = (messages.body as { items: Array<{ id: string; content: string | null;
      attachments: Array<{ id: string; name: string; media_type: string; byte_length: number }> }> }).items;
    const userMessage = items.find((item) => item.id === direct.result.user_message_id);
    assert.equal(userMessage?.content, '');
    assert.deepEqual(userMessage?.attachments, [{ id: attachmentId, name: '截图.png',
      media_type: 'image/png', byte_length: PNG_BYTES.byteLength }]);

    const content = await api.get(`${base}/assist-sessions/${sessionId}` +
      `/message-attachments/${attachmentId}`);
    assert.equal(content.status, 200);
    assert.deepEqual(content.body, { attachment_id: attachmentId, name: '截图.png',
      media_type: 'image/png', byte_length: PNG_BYTES.byteLength,
      data_base64: PNG_BYTES.toString('base64') });
  } finally { await api.stop(); }
});
