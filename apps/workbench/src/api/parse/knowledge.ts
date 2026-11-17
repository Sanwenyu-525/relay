import type {
  RelayKnowledgeCollection, RelayKnowledgeCollectionRef, RelayKnowledgeHealth,
  RelayKnowledgeImportDuplicate, RelayKnowledgeImportFailure, RelayKnowledgeImportPreview, RelayKnowledgeImportPreviewFile,
  RelayKnowledgeListItem, RelayKnowledgeOrganization, RelayKnowledgeOverview, RelayKnowledgePage,
  RelayKnowledgeRelation, RelayKnowledgeTag, RelayKnowledgeUsageRecord,
} from "../dtos/knowledge";
import { RelayContractError } from "../core/errors";
import { array, decimal, integer, nullableString, object, string } from "../core/primitives";

/**
 * 知识库响应解析（0167）。
 *
 * 解析器只做「字段存在且类型正确」的核对，不补默认值：
 * 服务端缺字段时宁可抛出合约错误，也不让界面把一个未知状态说成有效/正常。
 */

function collectionRef(value: unknown, name: string): RelayKnowledgeCollectionRef {
  const row = object(value, name);
  return { id: string(row, "id", name), name: string(row, "name", name) };
}

export function knowledgeListItemFrom(value: unknown): RelayKnowledgeListItem {
  const row = object(value, "knowledge list item");
  return {
    id: string(row, "id", "knowledge list item"),
    title: string(row, "title", "knowledge list item"),
    projectId: nullableString(row, "project_id", "knowledge list item"),
    status: string(row, "status", "knowledge list item"),
    revision: decimal(row, "revision", "knowledge list item"),
    currentVersion: decimal(row, "current_version", "knowledge list item"),
    summary: nullableString(row, "summary", "knowledge list item"),
    sourceKind: string(row, "source_kind", "knowledge list item"),
    mediaType: string(row, "media_type", "knowledge list item"),
    availability: string(row, "availability", "knowledge list item"),
    sourceUri: nullableString(row, "source_uri", "knowledge list item"),
    tags: array(row, "tags", "knowledge list item").map((tag) => {
      if (typeof tag !== "string") throw new RelayContractError("knowledge list item.tags 响应格式无效。");
      return tag;
    }),
    collections: array(row, "collections", "knowledge list item")
      .map((entry) => collectionRef(entry, "knowledge list item.collections")),
    matchedFields: array(row, "matched_fields", "knowledge list item").map((field) => {
      if (typeof field !== "string") throw new RelayContractError("knowledge list item.matched_fields 响应格式无效。");
      return field;
    }),
    snippet: nullableString(row, "snippet", "knowledge list item"),
    createdAt: string(row, "created_at", "knowledge list item"),
    updatedAt: string(row, "updated_at", "knowledge list item"),
  };
}

export function knowledgePageFrom(value: unknown): RelayKnowledgePage {
  const row = object(value, "knowledge page");
  return { items: array(row, "items", "knowledge page").map(knowledgeListItemFrom),
    nextCursor: nullableString(row, "next_cursor", "knowledge page") };
}

export function knowledgeOverviewFrom(value: unknown): RelayKnowledgeOverview {
  const row = object(value, "knowledge overview");
  const number = (key: string): number => integer(row, key, "knowledge overview");
  return {
    knowledgeTotal: number("knowledge_total"), decisionTotal: number("decision_total"),
    ruleTotal: number("rule_total"), recentNew: number("recent_new"),
    recentUpdated: number("recent_updated"), unavailable: number("unavailable"),
    stale: number("stale"), curationPending: number("curation_pending"),
    collectionTotal: number("collection_total"), tagTotal: number("tag_total"),
    unorganized: number("unorganized"),
    latestCreatedAt: nullableString(row, "latest_created_at", "knowledge overview"),
    latestUpdatedAt: nullableString(row, "latest_updated_at", "knowledge overview"),
  };
}

export function knowledgeCollectionFrom(value: unknown): RelayKnowledgeCollection {
  const row = object(value, "knowledge collection");
  return {
    id: string(row, "id", "knowledge collection"),
    projectId: nullableString(row, "project_id", "knowledge collection"),
    name: string(row, "name", "knowledge collection"),
    description: nullableString(row, "description", "knowledge collection"),
    revision: decimal(row, "revision", "knowledge collection"),
    itemCount: integer(row, "item_count", "knowledge collection"),
    createdAt: string(row, "created_at", "knowledge collection"),
    updatedAt: string(row, "updated_at", "knowledge collection"),
  };
}

export function knowledgeCollectionListFrom(value: unknown): readonly RelayKnowledgeCollection[] {
  const row = object(value, "knowledge collections");
  return array(row, "items", "knowledge collections").map(knowledgeCollectionFrom);
}

export function knowledgeTagFrom(value: unknown): RelayKnowledgeTag {
  const row = object(value, "knowledge tag");
  return { id: string(row, "id", "knowledge tag"), name: string(row, "name", "knowledge tag"),
    usageCount: integer(row, "usage_count", "knowledge tag") };
}

export function knowledgeTagListFrom(value: unknown): readonly RelayKnowledgeTag[] {
  const row = object(value, "knowledge tags");
  return array(row, "items", "knowledge tags").map(knowledgeTagFrom);
}

function relationFrom(value: unknown): RelayKnowledgeRelation {
  const row = object(value, "knowledge relation");
  const direction = string(row, "direction", "knowledge relation");
  if (direction !== "OUT" && direction !== "IN") {
    throw new RelayContractError("knowledge relation.direction 响应格式无效。");
  }
  return {
    id: string(row, "id", "knowledge relation"), direction,
    kind: string(row, "kind", "knowledge relation"),
    otherId: string(row, "other_id", "knowledge relation"),
    otherTitle: string(row, "other_title", "knowledge relation"),
    otherStatus: string(row, "other_status", "knowledge relation"),
    targetVersion: nullableString(row, "target_version", "knowledge relation"),
    note: nullableString(row, "note", "knowledge relation"),
    createdAt: string(row, "created_at", "knowledge relation"),
  };
}

function usageFrom(value: unknown): RelayKnowledgeUsageRecord {
  const row = object(value, "knowledge usage");
  return {
    messageId: string(row, "message_id", "knowledge usage"),
    sessionId: string(row, "session_id", "knowledge usage"),
    sessionTitle: string(row, "session_title", "knowledge usage"),
    seq: string(row, "seq", "knowledge usage"),
    role: string(row, "role", "knowledge usage"),
    createdAt: string(row, "created_at", "knowledge usage"),
    version: nullableString(row, "version", "knowledge usage"),
    status: nullableString(row, "status", "knowledge usage"),
  };
}

export function knowledgeOrganizationFrom(value: unknown): RelayKnowledgeOrganization {
  const row = object(value, "knowledge organization");
  return {
    tags: array(row, "tags", "knowledge organization").map((entry) => {
      const tag = object(entry, "knowledge organization.tags");
      return { id: string(tag, "id", "knowledge organization.tags"),
        name: string(tag, "name", "knowledge organization.tags") };
    }),
    collections: array(row, "collections", "knowledge organization").map((entry) => {
      const collection = object(entry, "knowledge organization.collections");
      return { id: string(collection, "id", "knowledge organization.collections"),
        name: string(collection, "name", "knowledge organization.collections"),
        description: nullableString(collection, "description", "knowledge organization.collections") };
    }),
    relations: array(row, "relations", "knowledge organization").map(relationFrom),
    usage: array(row, "usage", "knowledge organization").map(usageFrom),
  };
}

export function knowledgeHealthFrom(value: unknown): RelayKnowledgeHealth {
  const row = object(value, "knowledge health");
  return {
    duplicates: array(row, "duplicates", "knowledge health").map((entry) => {
      const group = object(entry, "knowledge health.duplicates");
      return { contentSha256: string(group, "content_sha256", "knowledge health.duplicates"),
        ids: array(group, "ids", "knowledge health.duplicates").map((id) => {
          if (typeof id !== "string") throw new RelayContractError("knowledge health.duplicates.ids 响应格式无效。");
          return id;
        }) };
    }),
    unavailable: integer(row, "unavailable", "knowledge health"),
    stale: integer(row, "stale", "knowledge health"),
    unorganized: integer(row, "unorganized", "knowledge health"),
    curationPending: integer(row, "curation_pending", "knowledge health"),
    staleAfterDays: integer(row, "stale_after_days", "knowledge health"),
  };
}

function duplicateFrom(value: unknown): RelayKnowledgeImportDuplicate {
  const row = object(value, "knowledge import duplicate");
  return {
    id: string(row, "id", "knowledge import duplicate"),
    title: string(row, "title", "knowledge import duplicate"),
    projectId: nullableString(row, "project_id", "knowledge import duplicate"),
    revision: nullableString(row, "revision", "knowledge import duplicate"),
    currentVersion: nullableString(row, "current_version", "knowledge import duplicate"),
    status: nullableString(row, "status", "knowledge import duplicate"),
  };
}

function previewFileFrom(value: unknown): RelayKnowledgeImportPreviewFile {
  const row = object(value, "knowledge import file");
  const status = string(row, "status", "knowledge import file");
  if (status !== "READY" && status !== "REJECTED") {
    throw new RelayContractError("knowledge import file.status 响应格式无效。");
  }
  const nullableInteger = (key: string): number | null => {
    const entry = row[key];
    if (entry === undefined || entry === null) return null;
    if (typeof entry !== "number" || !Number.isInteger(entry)) {
      throw new RelayContractError(`knowledge import file.${key} 响应格式无效。`);
    }
    return entry;
  };
  const optionalString = (key: string): string | null => {
    const entry = row[key];
    if (entry === undefined || entry === null) return null;
    if (typeof entry !== "string") throw new RelayContractError(`knowledge import file.${key} 响应格式无效。`);
    return entry;
  };
  return {
    name: string(row, "name", "knowledge import file"), status,
    failure: optionalString("failure") as RelayKnowledgeImportFailure | null,
    message: optionalString("message"),
    size: nullableInteger("size"),
    format: optionalString("format"),
    mediaType: optionalString("media_type"),
    titleSuggestion: optionalString("title_suggestion"),
    text: optionalString("text"),
    textLength: nullableInteger("text_length"),
    contentSha256: optionalString("content_sha256"),
    duplicates: row.duplicates === undefined ? [] : array(row, "duplicates", "knowledge import file")
      .map(duplicateFrom),
    similar: row.similar === undefined ? [] : array(row, "similar", "knowledge import file")
      .map(duplicateFrom),
  };
}

export function knowledgeImportPreviewFrom(value: unknown): RelayKnowledgeImportPreview {
  const row = object(value, "knowledge import preview");
  return { files: array(row, "files", "knowledge import preview").map(previewFileFrom) };
}
