import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { createCommandId, type RelayApiClient, type RelayKnowledgeCollection,
  type RelayKnowledgeOrganization } from "../api/relayClient";
import { describeLiveError } from "../lib/liveErrors";
import { Button } from "../ui";

/**
 * 知识组织面板（0167）：集合、标签、关联与使用记录。
 *
 * 只通过既有命令端点写入（PUT tags / PUT collections / POST relations / DELETE relation），
 * 不在前端维护第二份组织状态；每次命令后重读服务端事实，失败保留原值并说明原因。
 */
interface Props {
  readonly client: RelayApiClient;
  readonly knowledgeId: string;
  readonly projectId: string | null;
  readonly collections: readonly RelayKnowledgeCollection[];
  readonly onChanged: () => void;
}

const relationLabels: Readonly<Record<string, string>> = {
  RELATES_TO: "相关", SUPERSEDES: "替代", DERIVED_FROM: "派生自",
  CONSTRAINS: "约束", REFERENCES: "引用",
};

export default function KnowledgeOrganizationPanel({ client, knowledgeId, projectId,
  collections, onChanged }: Props) {
  const [data, setData] = useState<RelayKnowledgeOrganization | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [tagInput, setTagInput] = useState("");
  const [relationTarget, setRelationTarget] = useState("");
  const [relationKind, setRelationKind] = useState("RELATES_TO");
  const [relationNote, setRelationNote] = useState("");
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true); setError(null);
    void client.getKnowledgeOrganization(knowledgeId).then((result) => {
      if (active) { setData(result); setTagInput(result.tags.map((tag) => tag.name).join(", ")); }
    }).catch((caught: unknown) => {
      if (active) setError(describeLiveError(caught).message);
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [client, knowledgeId, version]);

  async function run(key: string, action: () => Promise<unknown>): Promise<void> {
    setBusy(key); setActionError(null);
    try { await action(); setVersion((value) => value + 1); onChanged(); }
    catch (caught) { setActionError(describeLiveError(caught).message); }
    finally { setBusy(null); }
  }

  const savedCollectionIds = data?.collections.map((collection) => collection.id) ?? [];

  return <section className="knowledge-organization" data-testid="knowledge-organization" aria-label="知识组织">
    <header className="section-heading-row"><h2>组织与关联</h2>
      {loading && <span className="helper-text" role="status">正在读取…</span>}</header>
    {error !== null && <p className="action-error" role="alert">{error}
      <Button variant="text" onClick={() => setVersion((value) => value + 1)}>重新读取</Button></p>}
    {actionError !== null && <p className="action-error" role="alert" data-testid="knowledge-organization-error">{actionError}</p>}
    {data !== null && <>
      <div className="knowledge-org-block">
        <h3>知识集合</h3>
        {collections.length === 0
          ? <p className="helper-text">当前范围还没有知识集合。在筛选栏「管理集合」里创建第一个。</p>
          : <div className="knowledge-org-choices">{collections.map((collection) => <label key={collection.id} className="knowledge-check">
            <input type="checkbox" checked={savedCollectionIds.includes(collection.id)}
              disabled={busy !== null}
              onChange={(event) => {
                const next = event.target.checked
                  ? [...savedCollectionIds, collection.id]
                  : savedCollectionIds.filter((id) => id !== collection.id);
                void run("collections", () => client.setKnowledgeCollections({
                  knowledgeId, commandId: createCommandId(), collectionIds: next }));
              }} />{collection.name}</label>)}</div>}
      </div>

      <div className="knowledge-org-block">
        <h3>标签</h3>
        {data.tags.length === 0 && <p className="helper-text">还没有标签。</p>}
        <div className="knowledge-tag-chips">{data.tags.map((tag) => <span key={tag.id} className="knowledge-tag">
          {tag.name}<button type="button" aria-label={`移除标签 ${tag.name}`} disabled={busy !== null}
            onClick={() => void run("tags", () => client.setKnowledgeTags({ knowledgeId,
              commandId: createCommandId(),
              tags: data.tags.filter((item) => item.id !== tag.id).map((item) => item.name) }))}>×</button>
        </span>)}</div>
        <div className="knowledge-org-inline">
          <label className="field"><span className="field-label">标签（逗号分隔，最多 12 个）</span>
            <input value={tagInput} maxLength={400} onChange={(event) => setTagInput(event.target.value)}
              data-testid="knowledge-tags-input" /></label>
          <Button variant="secondary" disabled={busy !== null} data-testid="knowledge-tags-save"
            onClick={() => { void run("tags", () => client.setKnowledgeTags({ knowledgeId,
              commandId: createCommandId(),
              tags: tagInput.split(/[,，、\s]+/u).map((tag) => tag.trim()).filter((tag) => tag !== "") })); }}>
            保存标签</Button>
        </div>
      </div>

      <div className="knowledge-org-block">
        <h3>关联知识</h3>
        {data.relations.length === 0
          ? <p className="helper-text">还没有关联。关联必须指向真实知识 ID 与确切版本。</p>
          : <ul className="knowledge-relations">{data.relations.map((relation) => <li key={relation.id}>
            <span className="knowledge-relation-kind">{relation.direction === "IN" ? "被" : ""}
              {relationLabels[relation.kind] ?? relation.kind}</span>
            <Link to={`/knowledge?kind=KNOWLEDGE&item=${relation.otherId}`}>{relation.otherTitle}</Link>
            {relation.targetVersion !== null && <small>v{relation.targetVersion}</small>}
            {relation.otherStatus !== "ACTIVE" && <small>（{relation.otherStatus === "ARCHIVED" ? "已归档" : "不可用"}）</small>}
            {relation.note !== null && <small>{relation.note}</small>}
            <Button variant="text" disabled={busy !== null}
              onClick={() => void run("relation", () => client.deleteKnowledgeRelation({
                id: relation.id, commandId: createCommandId() }))}>移除</Button>
          </li>)}</ul>}
        <div className="knowledge-org-inline">
          <label className="field"><span className="field-label">目标知识 ID</span>
            <input value={relationTarget} placeholder="确切知识 ID" maxLength={36}
              onChange={(event) => setRelationTarget(event.target.value)}
              data-testid="knowledge-relation-target" /></label>
          <label className="field"><span className="field-label">关系</span>
            <select value={relationKind} onChange={(event) => setRelationKind(event.target.value)}>
              {Object.entries(relationLabels).map(([kind, label]) =>
                <option key={kind} value={kind}>{label} · {kind}</option>)}</select></label>
          <label className="field"><span className="field-label">说明（可选）</span>
            <input value={relationNote} maxLength={400} onChange={(event) => setRelationNote(event.target.value)} /></label>
          <Button variant="secondary" disabled={busy !== null || !/^[0-9a-f-]{36}$/iu.test(relationTarget.trim())}
            data-testid="knowledge-relation-create"
            onClick={() => { void run("relation", () => client.createKnowledgeRelation({
              fromKnowledgeId: knowledgeId, commandId: createCommandId(),
              toKnowledgeId: relationTarget.trim(), relationKind,
              ...(relationNote.trim() === "" ? {} : { note: relationNote.trim() }) }))
                .then(() => { setRelationTarget(""); setRelationNote(""); }); }}>建立关联</Button>
        </div>
      </div>

      <div className="knowledge-org-block">
        <h3>Agent 使用记录</h3>
        {data.usage.length === 0
          ? <p className="helper-text" data-testid="knowledge-usage-empty">没有可靠的 Agent 使用记录。
            只有服务端确切的来源引用才会出现在这里；不展示推测的使用次数。</p>
          : <ul className="knowledge-usage">{data.usage.map((record) => <li key={record.messageId}>
            <Link to={`/assist?session=${record.sessionId}`}>{record.sessionTitle || "未命名会话"}</Link>
            <small>{record.createdAt} · {record.role} · {record.version === null ? "未记录版本" : `v${record.version}`}</small>
          </li>)}</ul>}
      </div>

      {projectId !== null && <p className="helper-text">所属项目：{projectId}（项目范围 = 工作空间共享知识 + 当前项目知识）。</p>}
      {projectId === null && <p className="helper-text">范围：工作空间共享知识。</p>}
    </>}
  </section>;
}
