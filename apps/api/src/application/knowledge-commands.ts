import { randomUUID } from 'node:crypto';

import type { DbExecutor } from '../infrastructure/database.js';
import type { KnowledgeVersionRow } from '../infrastructure/database-schema.js';
import type { JsonObject } from '../infrastructure/json.js';
import { isPostgresError, POSTGRES_ERROR_CODES } from '../infrastructure/postgres-error.js';
import { toDecimalString } from '../shared/decimal.js';
import { httpCommandScopeKey } from './actor.js';
import { runIdempotentCommand, type CommandResult } from './command.js';
import { DomainError, invalidTransition, knowledgeImportRejected, resourceNotFound,
  revisionConflict, validationFailed } from './domain-error.js';
import { requireRevision } from './revisions.js';
import { lockWritableProjectInWorkspace } from './guards.js';
import type { Repositories } from './unit-of-work.js';
import { createRepositories } from './unit-of-work.js';
import { addKnowledgeVersionInTransaction, createKnowledgeInTransaction,
  type KnowledgeSource } from './information-commands.js';
import { extractDocument, displayFileName, IMPORT_LIMITS } from './knowledge-import.js';
import { KNOWLEDGE_COLLECTION_NAME_MAX, KNOWLEDGE_RELATION_KINDS, KNOWLEDGE_TAG_LIMIT,
  KNOWLEDGE_TAG_NAME_MAX, knowledgeLabelKey, normalizeKnowledgeTagName,
  type KnowledgeRelationKind } from './knowledge-model.js';
import { requireCollection, requireKnowledgeRoot } from '../information/knowledge-repository.js';

/**
 * 知识库组织层与导入用例（0167）。
 *
 * 统一遵守既有命令体系：
 *   * 每个写入都是 `runIdempotentCommand`，同 command_id 重放返回原结果，不做静默重试；
 *   * 组织写入不写知识正文：集合/标签/关联只保存对 knowledge id 的确切引用；
 *   * 导入先在事务外做纯提取，提取失败不进入事务、也不会留下半条知识；
 *     事务内复用 `createKnowledgeInTransaction` / `addKnowledgeVersionInTransaction`，
 *     保证知识根与版本的写入仍只有一条领域路径。
 */

type Scope = { readonly workspaceId: string; readonly commandId: string };

function textValue(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') throw validationFailed([{ field, message: 'must be a string' }]);
  const trimmed = value.replace(/\s+/gu, ' ').trim();
  if (trimmed === '' || [...trimmed].length > max) {
    throw validationFailed([{ field, message: `must be nonempty up to ${max} characters` }]);
  }
  return trimmed;
}

function optionalText(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw validationFailed([{ field, message: 'must be a string' }]);
  const trimmed = value.trim();
  if ([...trimmed].length > max) {
    throw validationFailed([{ field, message: `must be up to ${max} characters` }]);
  }
  return trimmed === '' ? null : trimmed;
}

function idValue(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f-]{36}$/iu.test(value)) {
    throw validationFailed([{ field, message: 'must be a UUID' }]);
  }
  return value;
}

function idList(value: unknown, field: string, max: number): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > max) {
    throw validationFailed([{ field, message: `must be an array of up to ${max} ids` }]);
  }
  return [...new Set(value.map((item) => idValue(item, field)))];
}

async function authority(r: Repositories, workspaceId: string): Promise<void> {
  if (await r.workspaces.lockAuthority(workspaceId, 'update') === undefined) {
    throw resourceNotFound('Workspace authority');
  }
}

async function projectScope(r: Repositories, workspaceId: string,
  projectId: string | null): Promise<void> {
  if (projectId === null) {
    if (await r.workspaces.readWorkspace(workspaceId) === undefined) throw resourceNotFound('Workspace');
    return;
  }
  await lockWritableProjectInWorkspace(r, workspaceId, projectId);
}

function sameRevision(entity: string, actual: bigint, expected: bigint): void {
  if (actual !== expected) throw revisionConflict({ entityType: entity,
    expectedRevision: toDecimalString(expected), actualRevision: toDecimalString(actual) });
}

function uniqueNameTaken(field: string): DomainError {
  return validationFailed([{ field, message: '同名已存在；请换一个名称或直接复用已有条目。' }]);
}

// ---- 知识集合 -------------------------------------------------------------

export async function createKnowledgeCollection(db: DbExecutor, input: Scope & {
  projectId: string | null; name: string; description?: string | null | undefined;
}) {
  const name = textValue(input.name, 'name', KNOWLEDGE_COLLECTION_NAME_MAX);
  const norm = knowledgeLabelKey(name);
  const description = optionalText(input.description, 'description', 400);
  return runIdempotentCommand<CommandResult>(db, {
    scopeKey: httpCommandScopeKey(input.workspaceId), commandId: input.commandId,
    commandType: 'CreateKnowledgeCollection',
    target: { project_id: input.projectId },
    body: { name, description },
    execute: async (r) => {
      await authority(r, input.workspaceId);
      await projectScope(r, input.workspaceId, input.projectId);
      const id = randomUUID();
      try {
        await r.knowledge.insertCollection({ id, workspaceId: input.workspaceId,
          projectId: input.projectId, name, normName: norm, description });
      } catch (error) {
        if (isPostgresError(error, POSTGRES_ERROR_CODES.uniqueViolation)) throw uniqueNameTaken('name');
        throw error;
      }
      return { collection_id: id, revision: '0' };
    },
  });
}

export async function updateKnowledgeCollection(db: DbExecutor, input: Scope & {
  collectionId: string; expectedRevision: string; name: string; description?: string | null | undefined;
}) {
  const name = textValue(input.name, 'name', KNOWLEDGE_COLLECTION_NAME_MAX);
  const norm = knowledgeLabelKey(name);
  const description = optionalText(input.description, 'description', 400);
  const expected = requireRevision(input.expectedRevision, 'expected_revision');
  return runIdempotentCommand<CommandResult>(db, {
    scopeKey: httpCommandScopeKey(input.workspaceId), commandId: input.commandId,
    commandType: 'UpdateKnowledgeCollection', target: { collection_id: input.collectionId },
    body: { expected_revision: input.expectedRevision, name, description },
    execute: async (r) => {
      await authority(r, input.workspaceId);
      const collection = await requireCollection(db, input.workspaceId, input.collectionId);
      if (collection.project_id !== null) {
        await lockWritableProjectInWorkspace(r, input.workspaceId, collection.project_id);
      }
      sameRevision('KNOWLEDGE_COLLECTION', collection.revision, expected);
      let revision: bigint;
      try {
        revision = await r.knowledge.updateCollection({ id: input.collectionId,
          workspaceId: input.workspaceId, name, normName: norm, description,
          expectedRevision: expected });
      } catch (error) {
        if (isPostgresError(error, POSTGRES_ERROR_CODES.uniqueViolation)) throw uniqueNameTaken('name');
        throw error;
      }
      if (revision < 0n) throw revisionConflict({ entityType: 'KNOWLEDGE_COLLECTION',
        expectedRevision: input.expectedRevision,
        actualRevision: toDecimalString(collection.revision) });
      return { collection_id: input.collectionId, revision: toDecimalString(revision) };
    },
  });
}

export async function deleteKnowledgeCollection(db: DbExecutor, input: Scope & {
  collectionId: string;
}) {
  return runIdempotentCommand<CommandResult>(db, {
    scopeKey: httpCommandScopeKey(input.workspaceId), commandId: input.commandId,
    commandType: 'DeleteKnowledgeCollection', target: { collection_id: input.collectionId },
    body: {},
    execute: async (r) => {
      await authority(r, input.workspaceId);
      const collection = await requireCollection(db, input.workspaceId, input.collectionId);
      if (collection.project_id !== null) {
        await lockWritableProjectInWorkspace(r, input.workspaceId, collection.project_id);
      }
      // 只删成员关系；知识本身与正文版本不受影响（外键 ON DELETE CASCADE 只作用于成员行）。
      await r.knowledge.deleteCollection(input.workspaceId, input.collectionId);
      return { collection_id: input.collectionId, status: 'DELETED' };
    },
  });
}

export async function setKnowledgeCollections(db: DbExecutor, input: Scope & {
  knowledgeId: string; collectionIds: readonly string[];
}) {
  const collectionIds = idList(input.collectionIds, 'collection_ids', 20);
  return runIdempotentCommand<CommandResult>(db, {
    scopeKey: httpCommandScopeKey(input.workspaceId), commandId: input.commandId,
    commandType: 'SetKnowledgeCollections', target: { knowledge_id: input.knowledgeId },
    body: { collection_ids: collectionIds },
    execute: async (r) => {
      await authority(r, input.workspaceId);
      const root = await requireKnowledgeRoot(db, input.workspaceId, input.knowledgeId);
      if (root.project_id !== null) {
        await lockWritableProjectInWorkspace(r, input.workspaceId, root.project_id);
      }
      for (const collectionId of collectionIds) {
        const collection = await requireCollection(db, input.workspaceId, collectionId);
        // 项目集合不能收纳其他项目（或工作空间）的知识：集合不改变知识作用域，也不能成为越权通道。
        if (collection.project_id !== null && collection.project_id !== root.project_id) {
          throw validationFailed([{ field: 'collection_ids',
            message: 'collection belongs to another project' }]);
        }
      }
      await r.knowledge.replaceCollectionItems(input.workspaceId, input.knowledgeId, collectionIds);
      return { knowledge_id: input.knowledgeId, collection_ids: collectionIds };
    },
  });
}

// ---- 标签 -----------------------------------------------------------------

export async function createKnowledgeTag(db: DbExecutor, input: Scope & { name: string }) {
  const name = normalizeKnowledgeTagName(input.name);
  if (name === null) {
    throw validationFailed([{ field: 'name',
      message: `must be 1..${KNOWLEDGE_TAG_NAME_MAX} characters and contain letters or digits` }]);
  }
  const norm = knowledgeLabelKey(name);
  return runIdempotentCommand<CommandResult>(db, {
    scopeKey: httpCommandScopeKey(input.workspaceId), commandId: input.commandId,
    commandType: 'CreateKnowledgeTag', target: { name },
    body: { name },
    execute: async (r) => {
      await authority(r, input.workspaceId);
      try {
        const ensured = await r.knowledge.ensureTags(input.workspaceId, [{ name, norm }]);
        const tag = ensured[0];
        return { tag_id: tag?.id ?? '', name: tag?.name ?? name };
      } catch (error) {
        if (isPostgresError(error, POSTGRES_ERROR_CODES.uniqueViolation)) throw uniqueNameTaken('name');
        throw error;
      }
    },
  });
}

export async function renameKnowledgeTag(db: DbExecutor, input: Scope & {
  tagId: string; name: string;
}) {
  const name = normalizeKnowledgeTagName(input.name);
  if (name === null) {
    throw validationFailed([{ field: 'name',
      message: `must be 1..${KNOWLEDGE_TAG_NAME_MAX} characters and contain letters or digits` }]);
  }
  const norm = knowledgeLabelKey(name);
  return runIdempotentCommand<CommandResult>(db, {
    scopeKey: httpCommandScopeKey(input.workspaceId), commandId: input.commandId,
    commandType: 'RenameKnowledgeTag', target: { tag_id: input.tagId }, body: { name },
    execute: async (r) => {
      await authority(r, input.workspaceId);
      try {
        const renamed = await r.knowledge.renameTag(input.workspaceId, input.tagId, name, norm);
        if (!renamed) throw resourceNotFound('KnowledgeTag');
      } catch (error) {
        if (isPostgresError(error, POSTGRES_ERROR_CODES.uniqueViolation)) throw uniqueNameTaken('name');
        throw error;
      }
      return { tag_id: input.tagId, name };
    },
  });
}

export async function deleteKnowledgeTag(db: DbExecutor, input: Scope & { tagId: string }) {
  return runIdempotentCommand<CommandResult>(db, {
    scopeKey: httpCommandScopeKey(input.workspaceId), commandId: input.commandId,
    commandType: 'DeleteKnowledgeTag', target: { tag_id: input.tagId }, body: {},
    execute: async (r) => {
      await authority(r, input.workspaceId);
      // 只删标签与链接；知识正文与版本完全不受影响。
      const deleted = await r.knowledge.deleteTag(input.workspaceId, input.tagId);
      if (!deleted) throw resourceNotFound('KnowledgeTag');
      return { tag_id: input.tagId, status: 'DELETED' };
    },
  });
}

/** 设置一条知识的标签：整体替换（空数组即清空），规范化后去重，最多 12 个。 */
export async function setKnowledgeTags(db: DbExecutor, input: Scope & {
  knowledgeId: string; tags: readonly string[];
}) {
  if (!Array.isArray(input.tags) || input.tags.length > KNOWLEDGE_TAG_LIMIT) {
    throw validationFailed([{ field: 'tags', message: `must be up to ${KNOWLEDGE_TAG_LIMIT} tags` }]);
  }
  const normalized = input.tags.map((tag) => {
    const name = normalizeKnowledgeTagName(tag);
    if (name === null) {
      throw validationFailed([{ field: 'tags',
        message: `each tag must be 1..${KNOWLEDGE_TAG_NAME_MAX} characters` }]);
    }
    return { name, norm: knowledgeLabelKey(name) };
  });
  const unique = [...new Map(normalized.map((tag) => [tag.norm, tag])).values()];
  return runIdempotentCommand<CommandResult>(db, {
    scopeKey: httpCommandScopeKey(input.workspaceId), commandId: input.commandId,
    commandType: 'SetKnowledgeTags', target: { knowledge_id: input.knowledgeId },
    body: { tags: unique.map((tag) => tag.name) },
    execute: async (r) => {
      await authority(r, input.workspaceId);
      const root = await requireKnowledgeRoot(db, input.workspaceId, input.knowledgeId);
      if (root.project_id !== null) {
        await lockWritableProjectInWorkspace(r, input.workspaceId, root.project_id);
      }
      const ensured = await r.knowledge.ensureTags(input.workspaceId, unique);
      await r.knowledge.replaceKnowledgeTags(input.workspaceId, input.knowledgeId,
        ensured.map((tag) => tag.id));
      return { knowledge_id: input.knowledgeId,
        tags: ensured.map((tag) => ({ id: tag.id, name: tag.name })) as unknown as JsonObject[] };
    },
  });
}

// ---- 知识关联 -------------------------------------------------------------

export async function createKnowledgeRelation(db: DbExecutor, input: Scope & {
  fromKnowledgeId: string; toKnowledgeId: string; relationKind: string;
  targetVersion?: string | null | undefined; note?: string | null | undefined;
}) {
  const fromId = idValue(input.fromKnowledgeId, 'from_knowledge_id');
  const toId = idValue(input.toKnowledgeId, 'to_knowledge_id');
  if (fromId === toId) {
    throw validationFailed([{ field: 'to_knowledge_id', message: 'cannot relate to itself' }]);
  }
  if (!(KNOWLEDGE_RELATION_KINDS as readonly string[]).includes(input.relationKind)) {
    throw validationFailed([{ field: 'relation_kind',
      message: `expected one of ${KNOWLEDGE_RELATION_KINDS.join(', ')}` }]);
  }
  const kind = input.relationKind as KnowledgeRelationKind;
  const note = optionalText(input.note, 'note', 400);
  const targetVersion = input.targetVersion === undefined || input.targetVersion === null ||
    input.targetVersion === '' ? null : requireRevision(input.targetVersion, 'target_version');
  return runIdempotentCommand<CommandResult>(db, {
    scopeKey: httpCommandScopeKey(input.workspaceId), commandId: input.commandId,
    commandType: 'CreateKnowledgeRelation',
    target: { from_knowledge_id: fromId, to_knowledge_id: toId, relation_kind: kind },
    body: { target_version: input.targetVersion ?? null, note },
    execute: async (r) => {
      await authority(r, input.workspaceId);
      const from = await requireKnowledgeRoot(db, input.workspaceId, fromId);
      const to = await requireKnowledgeRoot(db, input.workspaceId, toId);
      if (from.project_id !== null) {
        await lockWritableProjectInWorkspace(r, input.workspaceId, from.project_id);
      }
      // 可见性：关联目标必须是工作空间共享知识，或与来源同属一个项目；
      // 否则工作空间/其他项目的读者会通过关联标题看到无权知识的元数据。
      if (to.project_id !== null && to.project_id !== from.project_id) {
        throw validationFailed([{ field: 'to_knowledge_id',
          message: 'target knowledge is not visible in this scope' }]);
      }
      if (targetVersion !== null) {
        const version = await r.information.readVersion<KnowledgeVersionRow>('knowledge', toId,
          targetVersion);
        if (version === undefined) throw resourceNotFound('KnowledgeVersion');
      }
      const id = randomUUID();
      try {
        await r.knowledge.insertRelation({ id, workspaceId: input.workspaceId, fromId, toId,
          kind, targetVersion, note });
      } catch (error) {
        if (isPostgresError(error, POSTGRES_ERROR_CODES.uniqueViolation)) {
          throw invalidTransition('相同类型的知识关联已存在。');
        }
        if (isPostgresError(error, POSTGRES_ERROR_CODES.foreignKeyViolation)) {
          throw resourceNotFound('KnowledgeVersion');
        }
        throw error;
      }
      return { relation_id: id, from_knowledge_id: fromId, to_knowledge_id: toId,
        relation_kind: kind };
    },
  });
}

export async function deleteKnowledgeRelation(db: DbExecutor, input: Scope & {
  relationId: string;
}) {
  return runIdempotentCommand<CommandResult>(db, {
    scopeKey: httpCommandScopeKey(input.workspaceId), commandId: input.commandId,
    commandType: 'DeleteKnowledgeRelation', target: { relation_id: input.relationId }, body: {},
    execute: async (r) => {
      await authority(r, input.workspaceId);
      const relation = await r.knowledge.readRelation(input.workspaceId, input.relationId);
      if (relation === undefined) throw resourceNotFound('KnowledgeRelation');
      const from = await requireKnowledgeRoot(db, input.workspaceId, relation.from_knowledge_id);
      if (from.project_id !== null) {
        await lockWritableProjectInWorkspace(r, input.workspaceId, from.project_id);
      }
      await r.knowledge.deleteRelation(input.workspaceId, input.relationId);
      return { relation_id: input.relationId, status: 'DELETED' };
    },
  });
}

// ---- 导入 -----------------------------------------------------------------

export interface ImportFilePayload {
  readonly name: string;
  readonly mediaType: string;
  /** 原始字节的 base64（可带 data: 前缀）；不接受本地路径。 */
  readonly contentBase64: string;
}

/**
 * 预览：只做格式判定、正文提取与去重提示，不写任何数据库行。
 *
 * 预览返回的正文供用户确认/编辑标题；提交时仍会重新提取并校验 hash，
 * 因此预览与提交之间即使文件被改动，也不会把未经校验的正文写进知识。
 */
export async function previewKnowledgeImport(db: DbExecutor, input: {
  workspaceId: string; projectId: string | null; files: readonly ImportFilePayload[];
}) {
  const repositories = createRepositories(db);
  if (!Array.isArray(input.files) || input.files.length === 0) {
    throw validationFailed([{ field: 'files', message: 'at least one file is required' }]);
  }
  if (input.files.length > IMPORT_LIMITS.maxBatchFiles) {
    throw validationFailed([{ field: 'files',
      message: `at most ${IMPORT_LIMITS.maxBatchFiles} files per batch` }]);
  }
  let totalBytes = 0;
  const files: JsonObject[] = [];
  for (const file of input.files) {
    const name = displayFileName(file.name);
    const buffer = decodeBase64(file.contentBase64);
    if (buffer === null) {
      files.push({ name, status: 'REJECTED', failure: 'MALFORMED',
        message: 'content_base64 不是有效的 base64。' });
      continue;
    }
    totalBytes += buffer.length;
    if (totalBytes > IMPORT_LIMITS.maxBatchBytes) {
      throw validationFailed([{ field: 'files',
        message: `total upload must not exceed ${IMPORT_LIMITS.maxBatchBytes / 1024 / 1024} MB` }]);
    }
    const extracted = extractDocument({ name, mediaType: file.mediaType, buffer });
    if (!extracted.ok) {
      files.push({ name, status: 'REJECTED', failure: extracted.failure,
        message: extracted.message, size: buffer.length });
      continue;
    }
    const document = extracted.document;
    const duplicates = await repositories.knowledge.findByContentHash(input.workspaceId,
      document.contentSha256, input.projectId);
    const similar = await repositories.knowledge.findSimilarTitles(input.workspaceId,
      input.projectId, document.title, 5);
    const metas = await repositories.knowledge.readRootMeta(input.workspaceId,
      [...duplicates.map((row) => row.id), ...similar.map((row) => row.id)]);
    const metaById = new Map(metas.map((row) => [row.id, row]));
    const describe = (row: { id: string; title: string; project_id: string | null }) => {
      const meta = metaById.get(row.id);
      return { id: row.id, title: row.title, project_id: row.project_id,
        revision: meta === undefined ? null : toDecimalString(meta.revision),
        current_version: meta === undefined ? null : toDecimalString(meta.current_version),
        status: meta?.status ?? null };
    };
    files.push({ name, status: 'READY', format: document.format,
      media_type: document.mediaType, title_suggestion: document.title,
      text: document.text, text_length: document.text.length,
      content_sha256: document.contentSha256, detail: document.detail,
      duplicates: duplicates.map(describe) as unknown as JsonObject[],
      similar: similar.map(describe) as unknown as JsonObject[] });
  }
  return { files };
}

function decodeBase64(value: string): Buffer | null {
  if (typeof value !== 'string') return null;
  const body = value.startsWith('data:') ? value.slice(value.indexOf(',') + 1) : value;
  if (!/^[A-Za-z0-9+/=\s]+$/u.test(body)) return null;
  try {
    const buffer = Buffer.from(body, 'base64');
    return buffer.length === 0 ? null : buffer;
  } catch { return null; }
}

/** 提交导入：在事务外重新提取（不信任客户端正文），事务内写入知识、标签与集合。 */
export async function commitKnowledgeImport(db: DbExecutor, input: Scope & {
  projectId: string | null;
  file: ImportFilePayload;
  title?: string | null | undefined;
  tags?: readonly string[] | undefined;
  collectionIds?: readonly string[] | undefined;
  duplicateStrategy?: 'SKIP' | 'NEW_VERSION' | 'NEW' | undefined;
  targetKnowledgeId?: string | undefined;
  expectedRevision?: string | undefined;
}) {
  const name = displayFileName(input.file.name);
  const buffer = decodeBase64(input.file.contentBase64);
  if (buffer === null) {
    throw knowledgeImportRejected({ failure: 'MALFORMED', message: 'content_base64 不是有效的 base64。' });
  }
  const extracted = extractDocument({ name, mediaType: input.file.mediaType, buffer });
  if (!extracted.ok) {
    throw knowledgeImportRejected({ failure: extracted.failure, message: extracted.message });
  }
  const document = extracted.document;
  const title = textValue(input.title ?? document.title, 'title', 200);
  const strategy = input.duplicateStrategy ?? 'NEW';
  const tags = Array.isArray(input.tags) ? input.tags : [];
  const collectionIds = idList(input.collectionIds, 'collection_ids', 20);
  const sourceRefs: JsonObject = {
    import_format: document.format,
    file_name: name,
    file_size: String(buffer.length),
    extracted_text_bytes: String(document.textBytes),
    content_sha256: document.contentSha256,
    ...(document.detail.page_title === undefined || document.detail.page_title === ''
      ? {} : { page_title: document.detail.page_title }),
    ...(document.detail.paragraphs === undefined
      ? {} : { paragraphs: document.detail.paragraphs }),
  };
  return runIdempotentCommand<CommandResult>(db, {
    scopeKey: httpCommandScopeKey(input.workspaceId), commandId: input.commandId,
    commandType: 'ImportKnowledge', target: { project_id: input.projectId },
    body: { file_name: name, content_sha256: document.contentSha256, title,
      duplicate_strategy: strategy, tags: [...tags], collection_ids: collectionIds,
      target_knowledge_id: input.targetKnowledgeId ?? null },
    execute: async (r): Promise<CommandResult> => {
      await authority(r, input.workspaceId);
      await projectScope(r, input.workspaceId, input.projectId);
      for (const collectionId of collectionIds) {
        const collection = await requireCollection(db, input.workspaceId, collectionId);
        if (collection.project_id !== null && collection.project_id !== input.projectId) {
          throw validationFailed([{ field: 'collection_ids',
            message: 'collection belongs to another project' }]);
        }
      }
      const existing = await r.knowledge.findByContentHash(input.workspaceId,
        document.contentSha256, input.projectId);
      if (existing.length > 0 && strategy === 'SKIP') {
        // 跳过也要返回可追溯的根元数据：命令回执 schema 与前端回执都要求 revision/version，
        // 不能只返回 id 让调用方猜当前修订。
        const target = existing[0]!;
        const meta = (await r.knowledge.readRootMeta(input.workspaceId, [target.id]))[0];
        return { knowledge_id: target.id, status: 'SKIPPED', created: 'false',
          duplicate_of: target.id,
          revision: meta === undefined ? '0' : toDecimalString(meta.revision),
          version: meta === undefined ? '0' : toDecimalString(meta.current_version) };
      }
      const source: KnowledgeSource = { sourceKind: 'MANAGED_TEXT', text: document.text,
        mediaType: document.mediaType, sourceRefs, sourceUri: null };
      const normalizedTags = tags.map((tag) => {
        const normalized = normalizeKnowledgeTagName(tag);
        if (normalized === null) {
          throw validationFailed([{ field: 'tags', message: 'invalid tag name' }]);
        }
        return { name: normalized, norm: knowledgeLabelKey(normalized) };
      }).slice(0, KNOWLEDGE_TAG_LIMIT);
      const uniqueTags = [...new Map(normalizedTags.map((tag) => [tag.norm, tag])).values()];
      const ensured = await r.knowledge.ensureTags(input.workspaceId, uniqueTags);
      const applyOrganization = async (knowledgeId: string): Promise<void> => {
        await r.knowledge.replaceKnowledgeTags(input.workspaceId, knowledgeId,
          ensured.map((tag) => tag.id));
        await r.knowledge.replaceCollectionItems(input.workspaceId, knowledgeId, collectionIds);
      };
      if (strategy === 'NEW_VERSION') {
        const targetId = idValue(input.targetKnowledgeId ?? '', 'target_knowledge_id');
        const target = await requireKnowledgeRoot(db, input.workspaceId, targetId);
        if (target.project_id !== input.projectId) throw resourceNotFound('knowledge');
        if (existing.length > 0 && !existing.some((row) => row.id === targetId)) {
          throw validationFailed([{ field: 'target_knowledge_id',
            message: 'target is not a duplicate of this content' }]);
        }
        const added = await addKnowledgeVersionInTransaction(r, {
          workspaceId: input.workspaceId, commandId: input.commandId, knowledgeId: targetId,
          expectedRevision: input.expectedRevision ?? '0', source,
        });
        await applyOrganization(targetId);
        return { knowledge_id: targetId, revision: added.revision,
          version: added.version ?? '', status: added.status, created: 'true', duplicate_of: '' };
      }
      const created = await createKnowledgeInTransaction(r, {
        workspaceId: input.workspaceId, commandId: input.commandId,
        projectId: input.projectId, title, source,
      });
      const knowledgeId = created.knowledge_id ?? '';
      await applyOrganization(knowledgeId);
      return { knowledge_id: knowledgeId, revision: created.revision,
        version: created.version ?? '1', status: created.status, created: 'true',
        duplicate_of: existing[0]?.id ?? '' };
    },
  });
}
