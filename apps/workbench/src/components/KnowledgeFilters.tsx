import Button from "../ui/Button";
import type { RelayKnowledgeCollection, RelayKnowledgeScopeFilter, RelayKnowledgeSort, RelayKnowledgeTag } from "../api/dtos/knowledge";

/**
 * 知识库范围与筛选条。
 *
 * 从 KnowledgeView 抽出：页面只负责数据与请求，筛选控件集中在这里，避免继续在
 * 单文件里堆原生 select。所有值都来自服务端真实查询参数，不引入本地推断。
 */
export interface KnowledgeFiltersProps {
  readonly projectId: string | null;
  readonly scopeFilter: RelayKnowledgeScopeFilter;
  readonly statusFilter: "ACTIVE" | "ARCHIVED" | "ALL";
  readonly collectionFilter: string | null;
  readonly tagFilter: string | null;
  readonly sortOrder: RelayKnowledgeSort;
  readonly query: string;
  readonly pendingCommand: boolean;
  readonly collections: readonly RelayKnowledgeCollection[];
  readonly tags: readonly RelayKnowledgeTag[];
  readonly onScopeChange: (value: RelayKnowledgeScopeFilter) => void;
  readonly onStatusChange: (value: "ACTIVE" | "ARCHIVED" | "ALL") => void;
  readonly onCollectionChange: (value: string | null) => void;
  readonly onTagChange: (value: string | null) => void;
  readonly onSortChange: (value: RelayKnowledgeSort) => void;
  readonly onOrganize: () => void;
  readonly onClear: () => void;
}

export default function KnowledgeFilters({
  projectId, scopeFilter, statusFilter, collectionFilter, tagFilter, sortOrder, query, pendingCommand,
  collections, tags, onScopeChange, onStatusChange, onCollectionChange, onTagChange, onSortChange, onOrganize, onClear
}: KnowledgeFiltersProps) {
  return <div className="knowledge-filter" data-testid="knowledge-filter" aria-label="知识范围与筛选">
    <div className="knowledge-filter-group"><span className="knowledge-filter-label">范围</span>
      <div className="segmented" role="group" aria-label="按范围筛选">
        {([["ALL", projectId === null ? "全部知识" : "全部（共享+项目）"],
          ["WORKSPACE", "仅工作空间共享"], ["PROJECT", "仅当前项目"]] as const).map(([value, label]) =>
          <button key={value} type="button" className={`segmented-option${scopeFilter === value ? " segmented-option--selected" : ""}`}
            aria-pressed={scopeFilter === value} data-testid={`knowledge-scope-${value}`}
            disabled={value === "PROJECT" && projectId === null || pendingCommand}
            onClick={() => onScopeChange(value)}>{label}</button>)}
      </div>
    </div>
    <label className="knowledge-filter-field"><span>状态</span>
      <select value={statusFilter} disabled={pendingCommand}
        onChange={(event) => onStatusChange(event.target.value as "ACTIVE" | "ARCHIVED" | "ALL")}>
        <option value="ACTIVE">有效</option><option value="ARCHIVED">已归档</option><option value="ALL">全部</option>
      </select></label>
    <label className="knowledge-filter-field"><span>集合</span>
      <select value={collectionFilter ?? ""} disabled={pendingCommand}
        data-testid="knowledge-collection-filter"
        onChange={(event) => onCollectionChange(event.target.value === "" ? null : event.target.value)}>
        <option value="">全部集合</option>
        {collections.map((collection) => <option key={collection.id} value={collection.id}>{collection.name}</option>)}
      </select></label>
    <label className="knowledge-filter-field"><span>标签</span>
      <select value={tagFilter ?? ""} disabled={pendingCommand}
        data-testid="knowledge-tag-filter"
        onChange={(event) => onTagChange(event.target.value === "" ? null : event.target.value)}>
        <option value="">全部标签</option>
        {tags.map((tag) => <option key={tag.id} value={tag.id}>{tag.name}（{tag.usageCount}）</option>)}
      </select></label>
    <label className="knowledge-filter-field"><span>排序</span>
      <select value={sortOrder} disabled={pendingCommand}
        onChange={(event) => onSortChange(event.target.value as RelayKnowledgeSort)}>
        <option value="UPDATED_DESC">最近更新</option><option value="CREATED_DESC">最近创建</option><option value="TITLE_ASC">标题 A→Z</option>
      </select></label>
    <Button variant="text" data-testid="knowledge-organize-open" disabled={pendingCommand}
      onClick={onOrganize}>管理集合与标签</Button>
    {(scopeFilter !== "ALL" || statusFilter !== "ACTIVE" || collectionFilter !== null || tagFilter !== null || query.trim() !== "") &&
      <Button variant="text" data-testid="knowledge-filter-clear" onClick={onClear}>清空条件</Button>}
  </div>;
}
