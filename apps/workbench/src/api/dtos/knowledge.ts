import type { DecimalRevision } from "../../types";

/**
 * 知识库读取面（0167）。字段与 API schema 的 snake_case 一一对应，
 * 解析器负责转换成这里的 camelCase；没有任何可选字段被悄悄补默认值。
 */

export interface RelayKnowledgeCollectionRef {
  readonly id: string;
  readonly name: string;
}

/** 列表行：列表只依赖这一行就能说明「是什么、属于哪、多新、来源是什么」。 */
export interface RelayKnowledgeListItem {
  readonly id: string;
  readonly title: string;
  readonly projectId: string | null;
  readonly status: string;
  readonly revision: DecimalRevision;
  readonly currentVersion: DecimalRevision;
  readonly summary: string | null;
  readonly sourceKind: string;
  readonly mediaType: string;
  readonly availability: string;
  readonly sourceUri: string | null;
  readonly tags: readonly string[];
  readonly collections: readonly RelayKnowledgeCollectionRef[];
  readonly matchedFields: readonly string[];
  readonly snippet: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RelayKnowledgePage {
  readonly items: readonly RelayKnowledgeListItem[];
  /** 为空表示没有下一页；查询条件变化后旧游标会被服务端拒绝。 */
  readonly nextCursor: string | null;
}

export type RelayKnowledgeScopeFilter = "ALL" | "WORKSPACE" | "PROJECT";
export type RelayKnowledgeStatusFilter = "ACTIVE" | "ARCHIVED" | "ALL";
export type RelayKnowledgeSort = "UPDATED_DESC" | "CREATED_DESC" | "TITLE_ASC";

export interface RelayKnowledgePageQuery {
  readonly projectId?: string | null;
  readonly scope?: RelayKnowledgeScopeFilter;
  readonly status?: RelayKnowledgeStatusFilter;
  readonly q?: string;
  readonly collectionId?: string | null;
  readonly tagId?: string | null;
  readonly sort?: RelayKnowledgeSort;
  readonly limit?: number;
  readonly cursor?: string | null;
}

export interface RelayKnowledgeOverview {
  readonly knowledgeTotal: number;
  readonly decisionTotal: number;
  readonly ruleTotal: number;
  readonly recentNew: number;
  readonly recentUpdated: number;
  readonly unavailable: number;
  readonly stale: number;
  readonly curationPending: number;
  readonly collectionTotal: number;
  readonly tagTotal: number;
  readonly unorganized: number;
  readonly latestCreatedAt: string | null;
  readonly latestUpdatedAt: string | null;
}

export interface RelayKnowledgeCollection {
  readonly id: string;
  readonly projectId: string | null;
  readonly name: string;
  readonly description: string | null;
  readonly revision: DecimalRevision;
  readonly itemCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RelayKnowledgeTag {
  readonly id: string;
  readonly name: string;
  readonly usageCount: number;
}

export interface RelayKnowledgeRelation {
  readonly id: string;
  readonly direction: "OUT" | "IN";
  readonly kind: string;
  readonly otherId: string;
  readonly otherTitle: string;
  readonly otherStatus: string;
  readonly targetVersion: DecimalRevision | null;
  readonly note: string | null;
  readonly createdAt: string;
}

export interface RelayKnowledgeUsageRecord {
  readonly messageId: string;
  readonly sessionId: string;
  readonly sessionTitle: string;
  readonly seq: string;
  readonly role: string;
  readonly createdAt: string;
  readonly version: string | null;
  readonly status: string | null;
}

export interface RelayKnowledgeOrganization {
  readonly tags: readonly { readonly id: string; readonly name: string }[];
  readonly collections: readonly { readonly id: string; readonly name: string;
    readonly description: string | null }[];
  readonly relations: readonly RelayKnowledgeRelation[];
  readonly usage: readonly RelayKnowledgeUsageRecord[];
}

export interface RelayKnowledgeHealth {
  readonly duplicates: readonly { readonly contentSha256: string;
    readonly ids: readonly string[] }[];
  readonly unavailable: number;
  readonly stale: number;
  readonly unorganized: number;
  readonly curationPending: number;
  readonly staleAfterDays: number;
}

export type RelayKnowledgeImportFailure = "EMPTY_FILE" | "TOO_LARGE" | "FORMAT_MISMATCH" |
  "UNSUPPORTED_FORMAT" | "INVALID_ENCODING" | "NO_TEXT" | "TEXT_TOO_LARGE" | "MALFORMED";

export interface RelayKnowledgeImportDuplicate {
  readonly id: string;
  readonly title: string;
  readonly projectId: string | null;
  readonly revision: DecimalRevision | null;
  readonly currentVersion: DecimalRevision | null;
  readonly status: string | null;
}

/** 预览结果：READY 才带正文；REJECTED 必须带 failure 与原因，不伪装成功。 */
export interface RelayKnowledgeImportPreviewFile {
  readonly name: string;
  readonly status: "READY" | "REJECTED";
  readonly failure: RelayKnowledgeImportFailure | null;
  readonly message: string | null;
  readonly size: number | null;
  readonly format: string | null;
  readonly mediaType: string | null;
  readonly titleSuggestion: string | null;
  readonly text: string | null;
  readonly textLength: number | null;
  readonly contentSha256: string | null;
  readonly duplicates: readonly RelayKnowledgeImportDuplicate[];
  readonly similar: readonly RelayKnowledgeImportDuplicate[];
}

export interface RelayKnowledgeImportPreview {
  readonly files: readonly RelayKnowledgeImportPreviewFile[];
}
