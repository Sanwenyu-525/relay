import { useRef, useState } from "react";

import {
  createCommandId, type RelayApiClient, type RelayKnowledgeCollection,
  type RelayKnowledgeImportPreviewFile,
} from "../api/relayClient";
import { describeLiveError } from "../lib/liveErrors";
import { Button } from "../ui";

/**
 * 知识导入面板（0167）。
 *
 * 流程严格按「选择文件 → 服务端校验/提取 → 预览 → 设置标题/标签/集合 → 确认收录」：
 *   * 正文由服务端重新提取，客户端只提交原始字节，不提交正文；
 *   * REJECTED 的文件不会出现在提交按钮上，扫描 PDF 会明确说「无文本层」；
 *   * 重复检测只提示，不自动覆盖；NEW_VERSION 必须指定确切知识与修订。
 */
interface Props {
  readonly client: RelayApiClient;
  readonly projectId: string | null;
  readonly collections: readonly RelayKnowledgeCollection[];
  readonly onImported: (knowledgeId: string) => void;
}

const MAX_FILES = 20;
const MAX_BYTES = 10 * 1024 * 1024;

function mediaTypeOf(name: string): string {
  const extension = name.toLowerCase().split(".").pop() ?? "";
  if (extension === "md" || extension === "markdown") return "text/markdown";
  if (extension === "pdf") return "application/pdf";
  if (extension === "docx") return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (extension === "html" || extension === "htm") return "text/html";
  return "text/plain";
}

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`无法读取文件 ${file.name}。`));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const comma = result.indexOf(",");
      if (comma < 0) { reject(new Error(`无法读取文件 ${file.name}。`)); return; }
      resolve(result.slice(comma + 1));
    };
    reader.readAsDataURL(file);
  });
}

interface DraftState {
  readonly title: string;
  readonly tags: string;
  readonly collectionIds: readonly string[];
  readonly strategy: "SKIP" | "NEW_VERSION" | "NEW";
  readonly targetKnowledgeId: string;
}

function draftOf(file: RelayKnowledgeImportPreviewFile): DraftState {
  const duplicate = file.duplicates[0] ?? null;
  return {
    title: file.titleSuggestion ?? file.name,
    tags: "",
    collectionIds: [],
    strategy: duplicate === null ? "NEW" : "SKIP",
    targetKnowledgeId: duplicate?.id ?? "",
  };
}

export default function KnowledgeImportPanel({ client, projectId, collections, onImported }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<readonly { readonly name: string; readonly mediaType: string;
    readonly base64: string; readonly preview: RelayKnowledgeImportPreviewFile }[]>([]);
  const [drafts, setDrafts] = useState<Readonly<Record<string, DraftState>>>({});
  const [previewing, setPreviewing] = useState(false);
  const [importing, setImporting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function choose(list: FileList | null) {
    if (list === null || list.length === 0) return;
    setError(null); setMessage(null);
    const selected = Array.from(list);
    if (selected.length > MAX_FILES) {
      setError(`一次最多导入 ${MAX_FILES} 个文件；本次选择了 ${selected.length} 个。`);
      return;
    }
    const invalid = selected.filter((file) => file.size > MAX_BYTES);
    if (invalid.length > 0) {
      setError(`以下文件超过单文件 10MB 上限：${invalid.map((file) => file.name).join("、")}`);
      return;
    }
    setPreviewing(true);
    try {
      const uploads = await Promise.all(selected.map(async (file) => ({
        name: file.name, mediaType: mediaTypeOf(file.name), contentBase64: await readBase64(file)
      })));
      const preview = await client.previewKnowledgeImport({ projectId, files: uploads });
      const next = preview.files.map((item, index) => ({
        name: item.name, mediaType: uploads[index]?.mediaType ?? "text/plain",
        base64: uploads[index]?.contentBase64 ?? "", preview: item,
      }));
      setFiles(next);
      setDrafts(Object.fromEntries(next.filter((entry) => entry.preview.status === "READY")
        .map((entry) => [entry.name, draftOf(entry.preview)])));
    } catch (caught) {
      setError(describeLiveError(caught).message);
    } finally {
      setPreviewing(false);
      if (inputRef.current !== null) inputRef.current.value = "";
    }
  }

  function update(name: string, patch: Partial<DraftState>) {
    setDrafts((current) => ({ ...current, [name]: { ...(current[name] ?? draftOf(
      files.find((entry) => entry.name === name)?.preview as RelayKnowledgeImportPreviewFile)),
      ...patch } }));
  }

  async function commit(entry: typeof files[number]) {
    const draft = drafts[entry.name];
    if (draft === undefined) return;
    setImporting(entry.name); setError(null); setMessage(null);
    try {
      const duplicate = entry.preview.duplicates[0] ?? null;
      const tagList = draft.tags.split(/[,，、\s]+/u).map((tag) => tag.trim()).filter((tag) => tag !== "");
      const envelope = await client.importKnowledge({
        commandId: createCommandId(), projectId,
        file: { name: entry.name, mediaType: entry.mediaType, contentBase64: entry.base64 },
        title: draft.title.trim() === "" ? null : draft.title.trim(),
        tags: tagList,
        collectionIds: draft.collectionIds,
        duplicateStrategy: draft.strategy,
        ...(draft.strategy === "NEW_VERSION"
          ? { targetKnowledgeId: draft.strategy === "NEW_VERSION" ? draft.targetKnowledgeId.trim() : "",
            ...(duplicate !== null && duplicate.revision !== null
              ? { expectedRevision: duplicate.revision } : {}) }
          : {}),
      });
      const result = envelope.result as { knowledge_id?: string } | null;
      const knowledgeId = result?.knowledge_id ?? null;
      setMessage(`已收录「${draft.title.trim() === "" ? entry.name : draft.title.trim()}」。`);
      setFiles((current) => current.filter((item) => item.name !== entry.name));
      if (knowledgeId !== null) onImported(knowledgeId);
    } catch (caught) {
      setError(describeLiveError(caught).message);
    } finally {
      setImporting(null);
    }
  }

  return <section className="knowledge-import" data-testid="knowledge-import-panel" aria-label="导入知识">
    <div className="knowledge-import-head">
      <div>
        <h2>导入知识</h2>
        <p className="helper-text">支持 Markdown、TXT、PDF、DOCX、HTML 网页快照。正文由服务端重新提取；
          扫描版 PDF 没有文本层时会明确拒绝，不做 OCR。</p>
      </div>
      <div className="knowledge-actions">
        <input ref={inputRef} type="file" multiple hidden
          accept=".md,.markdown,.txt,.pdf,.docx,.html,.htm,text/plain,text/markdown,application/pdf"
          data-testid="knowledge-import-input" onChange={(event) => { void choose(event.target.files); }} />
        <Button variant="primary" disabled={previewing}
          onClick={() => inputRef.current?.click()}>{previewing ? "正在提取正文" : "选择文件"}</Button>
      </div>
    </div>
    {error !== null && <p className="action-error" role="alert" data-testid="knowledge-import-error">{error}</p>}
    {message !== null && <p className="receipt-message" role="status" data-testid="knowledge-import-message">{message}</p>}
    {files.length === 0 && <p className="helper-text" data-testid="knowledge-import-empty">
      还没有选择文件。预览会显示每个文件的格式、字符数、重复与相似提示，确认前不会写入知识库。</p>}
    {files.length > 0 && <ul className="knowledge-import-list">
      {files.map((entry) => {
        const draft = drafts[entry.name];
        const ready = entry.preview.status === "READY" && draft !== undefined;
        const duplicate = entry.preview.duplicates[0] ?? null;
        return <li key={entry.name} className="knowledge-import-item">
          <header><strong>{entry.preview.name}</strong>
            <span className={`knowledge-import-status knowledge-import-status--${entry.preview.status.toLowerCase()}`}>
              {ready ? `${entry.preview.format ?? "文本"} · ${entry.preview.textLength ?? 0} 字` : "无法提取正文"}
            </span></header>
          {!ready && <p className="action-error" role="alert" data-testid={`knowledge-import-rejected-${entry.preview.name}`}>
            {entry.preview.message ?? "服务端拒绝了这个文件。"}</p>}
          {ready && <>
            {duplicate !== null && <p className="knowledge-import-duplicate" data-testid={`knowledge-import-duplicate-${entry.preview.name}`}>
              已有相同内容的资料：<strong>{duplicate.title}</strong>（当前 v{duplicate.currentVersion}）。
              选择「跳过」「作为新版本」或「作为独立知识」；不会自动覆盖。</p>}
            <div className="knowledge-import-fields">
              <label className="field"><span className="field-label">标题</span>
                <input value={draft.title} maxLength={200}
                  onChange={(event) => update(entry.name, { title: event.target.value })} /></label>
              <label className="field"><span className="field-label">标签（逗号分隔，最多 12 个）</span>
                <input value={draft.tags} placeholder="TypeScript, PostgreSQL"
                  onChange={(event) => update(entry.name, { tags: event.target.value })} /></label>
              {collections.length > 0 && <fieldset className="knowledge-import-collections">
                <legend>知识集合</legend>
                {collections.map((collection) => <label key={collection.id} className="knowledge-check">
                  <input type="checkbox" checked={draft.collectionIds.includes(collection.id)}
                    onChange={(event) => update(entry.name, { collectionIds: event.target.checked
                      ? [...draft.collectionIds, collection.id]
                      : draft.collectionIds.filter((id) => id !== collection.id) })} />
                  {collection.name}</label>)}
              </fieldset>}
              {duplicate !== null && <div className="knowledge-import-strategy" role="group" aria-label="重复处理">
                {([["SKIP", "跳过"], ["NEW_VERSION", "作为新版本"], ["NEW", "作为独立知识"]] as const)
                  .map(([value, label]) => <label key={value} className="knowledge-check">
                    <input type="radio" name={`strategy-${entry.name}`} checked={draft.strategy === value}
                      onChange={() => update(entry.name, { strategy: value })} />{label}</label>)}
                {draft.strategy === "NEW_VERSION" && <label className="field">
                  <span className="field-label">追加到资料 ID</span>
                  <input value={draft.targetKnowledgeId}
                    onChange={(event) => update(entry.name, { targetKnowledgeId: event.target.value })} />
                </label>}
              </div>}
            </div>
            {entry.preview.text !== null && <details className="knowledge-import-preview">
              <summary>预览提取正文</summary><pre>{entry.preview.text}</pre></details>}
            <div className="knowledge-actions">
              <Button variant="primary" disabled={importing !== null || draft.strategy === "NEW_VERSION" && draft.targetKnowledgeId.trim() === ""}
                data-testid={`knowledge-import-commit-${entry.preview.name}`}
                onClick={() => { void commit(entry); }}>
                {importing === entry.name ? "正在收录" : "确认收录"}</Button>
            </div>
          </>}
        </li>;
      })}
    </ul>}
  </section>;
}
