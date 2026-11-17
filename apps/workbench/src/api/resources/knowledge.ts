import { RelayTransportError } from "../core/errors";
import { RelayHttp } from "../core/http";
import { commandEnvelopeFrom } from "../parse/projects";
import {
  knowledgeCollectionListFrom, knowledgeHealthFrom,
  knowledgeImportPreviewFrom, knowledgeOrganizationFrom, knowledgeOverviewFrom, knowledgePageFrom,
  knowledgeTagListFrom,
} from "../parse/knowledge";
import type {
  RelayKnowledgeCollection, RelayKnowledgeHealth, RelayKnowledgeImportPreview,
  RelayKnowledgeImportPreviewFile, RelayKnowledgeOrganization, RelayKnowledgeOverview,
  RelayKnowledgePage, RelayKnowledgePageQuery, RelayKnowledgeTag,
} from "../dtos/knowledge";
import type { RelayCommandEnvelope } from "../dtos/projects";
import type { DecimalRevision } from "../../types";

/**
 * 知识库 API（0167）。
 *
 * 统一在这里构造查询串与命令体，页面不拼路径、不猜字段：
 *   * 读取统一带 workspace 前缀（由 RelayHttp.workspacePath 负责）；
 *   * 写命令校验回执里的 command_id，与服务端回执不一致时抛「无法核对」；
 *   * 删除用 DELETE + JSON body（服务端命令仍要求 command_id）。
 */

function queryPath(http: RelayHttp, path: string, query: RelayKnowledgePageQuery = {}): string {
  const params = new URLSearchParams();
  if (query.projectId !== undefined && query.projectId !== null) params.set("project_id", query.projectId);
  if (query.scope !== undefined) params.set("scope", query.scope);
  if (query.status !== undefined) params.set("status", query.status);
  if (query.q !== undefined && query.q.trim() !== "") params.set("q", query.q.trim());
  if (query.collectionId !== undefined && query.collectionId !== null) params.set("collection_id", query.collectionId);
  if (query.tagId !== undefined && query.tagId !== null) params.set("tag_id", query.tagId);
  if (query.sort !== undefined) params.set("sort", query.sort);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.cursor !== undefined && query.cursor !== null) params.set("cursor", query.cursor);
  const base = http.workspacePath(path);
  const search = params.toString();
  return search === "" ? base : `${base}?${search}`;
}

async function knowledgeCommand(http: RelayHttp, path: string, payload: Record<string, unknown>,
  method: "POST" | "PATCH" | "PUT" | "DELETE", status: number): Promise<RelayCommandEnvelope> {
  const body = await http.request(http.workspacePath(path),
    { method, body: JSON.stringify(payload) }, status);
  try {
    const envelope = commandEnvelopeFrom(body);
    if (envelope.commandId !== payload.command_id) throw new Error("command ID mismatch");
    return envelope;
  } catch {
    throw new RelayTransportError("命令回执无法核对，请查询原 command_id。");
  }
}

export async function getKnowledgePage(http: RelayHttp,
  query: RelayKnowledgePageQuery): Promise<RelayKnowledgePage> {
  return knowledgePageFrom(await http.request(queryPath(http, "/knowledge/page", query)));
}

export async function getKnowledgeOverview(http: RelayHttp,
  projectId: string | null): Promise<RelayKnowledgeOverview> {
  return knowledgeOverviewFrom(await http.request(
    queryPath(http, "/knowledge/overview", { projectId })));
}

export async function getKnowledgeHealth(http: RelayHttp,
  projectId: string | null): Promise<RelayKnowledgeHealth> {
  return knowledgeHealthFrom(await http.request(
    queryPath(http, "/knowledge/health", { projectId })));
}

export async function getKnowledgeOrganization(http: RelayHttp,
  knowledgeId: string): Promise<RelayKnowledgeOrganization> {
  return knowledgeOrganizationFrom(await http.request(
    http.workspacePath(`/knowledge/${encodeURIComponent(knowledgeId)}/organization`)));
}

export async function listKnowledgeCollections(http: RelayHttp,
  projectId: string | null): Promise<readonly RelayKnowledgeCollection[]> {
  return knowledgeCollectionListFrom(await http.request(
    queryPath(http, "/knowledge-collections", { projectId })));
}

export async function createKnowledgeCollection(http: RelayHttp, input: {
  commandId: string; projectId: string | null; name: string; description?: string | null;
}): Promise<RelayCommandEnvelope> {
  return knowledgeCommand(http, "/knowledge-collections", {
    command_id: input.commandId, project_id: input.projectId, name: input.name,
    ...(input.description === undefined ? {} : { description: input.description }),
  }, "POST", 201);
}

export async function updateKnowledgeCollection(http: RelayHttp, input: {
  id: string; commandId: string; expectedRevision: DecimalRevision; name: string;
  description?: string | null;
}): Promise<RelayCommandEnvelope> {
  return knowledgeCommand(http, `/knowledge-collections/${encodeURIComponent(input.id)}`, {
    command_id: input.commandId, expected_revision: input.expectedRevision, name: input.name,
    ...(input.description === undefined ? {} : { description: input.description }),
  }, "PATCH", 200);
}

export async function deleteKnowledgeCollection(http: RelayHttp, input: {
  id: string; commandId: string;
}): Promise<RelayCommandEnvelope> {
  return knowledgeCommand(http, `/knowledge-collections/${encodeURIComponent(input.id)}`, {
    command_id: input.commandId,
  }, "DELETE", 200);
}

export async function setKnowledgeCollections(http: RelayHttp, input: {
  knowledgeId: string; commandId: string; collectionIds: readonly string[];
}): Promise<RelayCommandEnvelope> {
  return knowledgeCommand(http, `/knowledge/${encodeURIComponent(input.knowledgeId)}/collections`, {
    command_id: input.commandId, collection_ids: input.collectionIds,
  }, "PUT", 200);
}

/** 集合详情：服务端没有独立的详情端点，集合列表已包含展示所需字段。 */
export function collectionOf(collections: readonly RelayKnowledgeCollection[],
  id: string): RelayKnowledgeCollection | null {
  return collections.find((collection) => collection.id === id) ?? null;
}

export async function listKnowledgeTags(http: RelayHttp,
  projectId: string | null): Promise<readonly RelayKnowledgeTag[]> {
  return knowledgeTagListFrom(await http.request(queryPath(http, "/knowledge-tags", { projectId })));
}

export async function createKnowledgeTag(http: RelayHttp, input: {
  commandId: string; name: string;
}): Promise<RelayCommandEnvelope> {
  return knowledgeCommand(http, "/knowledge-tags", {
    command_id: input.commandId, name: input.name,
  }, "POST", 201);
}

export async function renameKnowledgeTag(http: RelayHttp, input: {
  id: string; commandId: string; name: string;
}): Promise<RelayCommandEnvelope> {
  return knowledgeCommand(http, `/knowledge-tags/${encodeURIComponent(input.id)}`, {
    command_id: input.commandId, name: input.name,
  }, "PATCH", 200);
}

export async function deleteKnowledgeTag(http: RelayHttp, input: {
  id: string; commandId: string;
}): Promise<RelayCommandEnvelope> {
  return knowledgeCommand(http, `/knowledge-tags/${encodeURIComponent(input.id)}`, {
    command_id: input.commandId,
  }, "DELETE", 200);
}

export async function setKnowledgeTags(http: RelayHttp, input: {
  knowledgeId: string; commandId: string; tags: readonly string[];
}): Promise<RelayCommandEnvelope> {
  return knowledgeCommand(http, `/knowledge/${encodeURIComponent(input.knowledgeId)}/tags`, {
    command_id: input.commandId, tags: input.tags,
  }, "PUT", 200);
}

export async function createKnowledgeRelation(http: RelayHttp, input: {
  fromKnowledgeId: string; commandId: string; toKnowledgeId: string; relationKind: string;
  targetVersion?: DecimalRevision | null; note?: string | null;
}): Promise<RelayCommandEnvelope> {
  return knowledgeCommand(http,
    `/knowledge/${encodeURIComponent(input.fromKnowledgeId)}/relations`, {
      command_id: input.commandId, to_knowledge_id: input.toKnowledgeId,
      relation_kind: input.relationKind,
      ...(input.targetVersion === undefined ? {} : { target_version: input.targetVersion }),
      ...(input.note === undefined ? {} : { note: input.note }),
    }, "POST", 201);
}

export async function deleteKnowledgeRelation(http: RelayHttp, input: {
  id: string; commandId: string;
}): Promise<RelayCommandEnvelope> {
  return knowledgeCommand(http, `/knowledge-relations/${encodeURIComponent(input.id)}`, {
    command_id: input.commandId,
  }, "DELETE", 200);
}

export interface KnowledgeImportUpload {
  readonly name: string;
  readonly mediaType: string;
  readonly contentBase64: string;
}

export async function previewKnowledgeImport(http: RelayHttp, input: {
  projectId: string | null; files: readonly KnowledgeImportUpload[];
}): Promise<RelayKnowledgeImportPreview> {
  return knowledgeImportPreviewFrom(await http.request(
    http.workspacePath("/knowledge-import/preview"), {
      method: "POST",
      body: JSON.stringify({ project_id: input.projectId, files: input.files.map((file) => ({
        name: file.name, media_type: file.mediaType, content_base64: file.contentBase64,
      })) }),
    }));
}

export async function importKnowledge(http: RelayHttp, input: {
  commandId: string; projectId: string | null; file: KnowledgeImportUpload;
  title?: string | null; tags?: readonly string[]; collectionIds?: readonly string[];
  duplicateStrategy?: "SKIP" | "NEW_VERSION" | "NEW";
  targetKnowledgeId?: string; expectedRevision?: DecimalRevision;
}): Promise<RelayCommandEnvelope> {
  return knowledgeCommand(http, "/knowledge-import", {
    command_id: input.commandId, project_id: input.projectId,
    file: { name: input.file.name, media_type: input.file.mediaType,
      content_base64: input.file.contentBase64 },
    ...(input.title === undefined ? {} : { title: input.title }),
    ...(input.tags === undefined ? {} : { tags: input.tags }),
    ...(input.collectionIds === undefined ? {} : { collection_ids: input.collectionIds }),
    ...(input.duplicateStrategy === undefined
      ? {} : { duplicate_strategy: input.duplicateStrategy }),
    ...(input.targetKnowledgeId === undefined
      ? {} : { target_knowledge_id: input.targetKnowledgeId }),
    ...(input.expectedRevision === undefined
      ? {} : { expected_revision: input.expectedRevision }),
  }, "POST", 201);
}

/** 预览里唯一可提交的文件：REJECTED 不得进入提交。 */
export function submittablePreviewFiles(
  preview: RelayKnowledgeImportPreview): readonly RelayKnowledgeImportPreviewFile[] {
  return preview.files.filter((file) => file.status === "READY" && file.text !== null);
}
