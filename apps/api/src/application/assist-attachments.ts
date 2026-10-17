import { createHash, randomUUID } from 'node:crypto';

import type { DbExecutor } from '../infrastructure/database.js';
import type { AssistMessageAttachmentRow } from '../infrastructure/database-schema.js';
import { invalidTransition, resourceNotFound, validationFailed } from './domain-error.js';
import { withTransaction } from './unit-of-work.js';

/**
 * Assist 消息图片附件（0093 / HTTP §10.85）。
 *
 * 定位是**会话输入快照的暂存**，不是幂等业务命令：上传只落一行不可变内容，
 * 不改变任何业务状态；真正把附件变成消息输入的是消息命令（RequestAssistMessage
 * 在同一事务内绑定 attachment_ids）。因此上传端点返回简单 JSON，不走命令回执。
 *
 * 上限与媒体类型是前后端共用的同一组常量：服务端是唯一准绳，前端用同值预检，
 * 两份定义由测试锁定一致（见 workbench attachmentLimits.spec.ts）。
 */

export const ASSIST_ATTACHMENT_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export type AssistAttachmentMediaType = typeof ASSIST_ATTACHMENT_MEDIA_TYPES[number];

/** 单张图片原始字节上限：2 MiB。 */
export const MAX_ASSIST_ATTACHMENT_BYTES = 2 * 1024 * 1024;
/** 每条消息附件数量上限。 */
export const MAX_ASSIST_ATTACHMENTS_PER_MESSAGE = 4;
/** 每条消息附件总量上限（原始字节合计）。 */
export const MAX_ASSIST_ATTACHMENT_TOTAL_BYTES = 6 * 1024 * 1024;
/** 上传端点 JSON 体的路由级上限：base64 后约 2.7 MiB + JSON 结构余量。 */
export const MAX_ASSIST_ATTACHMENT_BODY_BYTES = 4 * 1024 * 1024;

export function isAssistAttachmentMediaType(value: string): value is AssistAttachmentMediaType {
  return (ASSIST_ATTACHMENT_MEDIA_TYPES as readonly string[]).includes(value);
}

const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/u;

export interface AssistAttachmentUploadResult {
  readonly attachment_id: string;
  readonly byte_length: number;
  readonly content_hash: string;
}

/**
 * 上传一张图片附件：校验会话准入与内容形状，落一行未引用附件（message_id 为 NULL），
 * 返回附件身份。内容由 0093 的 CHECK 兜底（类型白名单、字节上限、byte_length 与实际
 * 字节一致）；这里先做类型化拒绝，让调用方拿到可解释的错误而不是裸约束失败。
 */
export async function uploadAssistMessageAttachment(
  db: DbExecutor,
  input: { workspaceId: string; sessionId: string; name: string; mediaType: string;
    dataBase64: string },
): Promise<AssistAttachmentUploadResult> {
  const name = input.name.trim();
  if (!name || name.length > 200) {
    throw validationFailed([{ field: 'name', message: '附件名须为 1–200 个字符' }]);
  }
  if (!isAssistAttachmentMediaType(input.mediaType)) {
    throw validationFailed([{ field: 'media_type',
      message: '当前版本仅支持图片附件：image/png、image/jpeg、image/gif、image/webp' }]);
  }
  if (!BASE64_PATTERN.test(input.dataBase64) || input.dataBase64.length % 4 !== 0) {
    throw validationFailed([{ field: 'data_base64', message: '附件内容必须是合法 base64' }]);
  }
  const content = Buffer.from(input.dataBase64, 'base64');
  if (content.byteLength === 0 || content.byteLength > MAX_ASSIST_ATTACHMENT_BYTES) {
    throw validationFailed([{ field: 'data_base64',
      message: `图片须大于 0 且不超过 ${MAX_ASSIST_ATTACHMENT_BYTES} 字节` }]);
  }

  return withTransaction(db, async (repositories) => {
    const session = await repositories.assist.readSession(input.sessionId, true);
    if (session === undefined || session.workspace_id !== input.workspaceId) {
      throw resourceNotFound('Assist session');
    }
    if (session.status !== 'ACTIVE') {
      throw invalidTransition('会话已归档，不能再上传附件。', { sessionId: session.id });
    }
    const id = randomUUID();
    await repositories.assist.insertAttachment({
      id, workspaceId: input.workspaceId, sessionId: session.id, name,
      mediaType: input.mediaType as AssistMessageAttachmentRow['media_type'],
      content, contentHash: createHash('sha256').update(content).digest(),
    });
    return { attachment_id: id, byte_length: content.byteLength,
      content_hash: createHash('sha256').update(content).digest('hex') };
  });
}
