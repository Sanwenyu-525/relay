import { useCallback, useRef, useState } from "react";
import type { RelayApiClient, RelayMessageMemoryUse } from "../api/relayClient";
import { describeLiveError } from "../lib/liveErrors";
import "./MemorySources.css";

/**
 * 一条消息的记忆使用足迹（HTTP §10.99）。
 *
 * 展开才读：一次会话里绝大多数消息没有记忆足迹，预读会给每条消息加一次请求。
 * 三种「空」必须分开说：
 * - `recorded=false`：没有采集记录 →「未采集」，不能说成「没有使用记忆」；
 * - `recorded=true, available=false`：采集过但来源已失效 → 内容不回显；
 * - `recorded=true, available=true, sources=[]`：确实没用任何记忆或资料。
 */

const kindLabels: Record<string, string> = {
  KNOWLEDGE: "资料",
  MEMORY: "记忆",
  DECISION: "决定"
};

const selectionLabels: Record<string, string> = {
  LITERAL_MATCH: "按字面匹配自动召回",
  RECENT_CONFIRMED: "近期已确认回退"
};

export default function MessageMemorySources({ client, sessionId, messageId }: {
  readonly client: RelayApiClient;
  readonly sessionId: string;
  readonly messageId: string;
}) {
  const [use, setUse] = useState<RelayMessageMemoryUse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestVersion = useRef(0);
  const loaded = useRef(false);

  const read = useCallback(async () => {
    const request = ++requestVersion.current;
    setLoading(true); setError(null);
    try {
      const next = await client.getMessageMemoryUse(sessionId, messageId);
      if (request !== requestVersion.current) return;
      setUse(next); loaded.current = true;
    } catch (caught) {
      if (request !== requestVersion.current) return;
      setError(describeLiveError(caught).message);
    } finally {
      if (request === requestVersion.current) setLoading(false);
    }
  }, [client, sessionId, messageId]);

  return <details className="message-memory-sources" data-testid={`message-memory-${messageId}`}
    onToggle={(event) => {
      // 只读一次：折叠再展开不重复请求；读取失败时由「重新读取」显式重试。
      if (event.currentTarget.open && !loaded.current && !loading) void read();
    }}>
    <summary>记忆来源</summary>
    <div className="message-memory-body">
      {loading && <p className="helper-text" role="status">正在读取这条消息的记忆来源…</p>}
      {error !== null && <div className="action-error" role="alert" data-testid={`message-memory-error-${messageId}`}>
        <p>记忆来源读取失败：{error}</p>
        <button className="secondary-button" type="button" data-testid={`message-memory-retry-${messageId}`}
          disabled={loading} onClick={() => void read()}>重新读取</button>
      </div>}
      {use !== null && <>
        {!use.recorded && <p className="helper-text" data-testid={`message-memory-unrecorded-${messageId}`}>
          这条消息没有采集记录（可能是旧版本产生的消息）。未采集不等于没有使用记忆，不能据此断言「未使用」。</p>}
        {use.recorded && !use.available && <p className="helper-text" data-testid={`message-memory-unavailable-${messageId}`}>
          这次生成使用过的来源已失效（被停用、过期或权限/范围变化）。失效内容不会在这里回显，也不会再被后续生成使用。</p>}
        {use.recorded && use.available && use.sources.length === 0 && <p className="helper-text"
          data-testid={`message-memory-none-${messageId}`}>这次生成没有使用长期记忆或资料。</p>}
        {use.recorded && use.available && use.sources.length > 0 && <>
          <p className="helper-text">这次生成使用了 {use.sources.length} 个来源
            {use.checkpointId !== null
              ? <>，并读取了当时的会话摘要（检查点 <code className="hash-code">{use.checkpointId}</code>）</>
              : ""}。版本号是确切使用的那一版。</p>
          <ul className="message-memory-list" data-testid={`message-memory-list-${messageId}`}>
            {use.sources.map((source, index) => <li key={index} data-available={source.status === "AVAILABLE"}>
              {source.status === "AVAILABLE" ? <>
                <span className="message-memory-ref">{kindLabels[source.kind ?? ""] ?? source.kind} {source.sourceRef}</span>
                {source.version !== null && <span className="helper-text">版本 v{source.version}</span>}
                {source.selection === "AUTO_MEMORY" && <span className="message-memory-tag">
                  自动召回{source.selectionBasis !== null ? ` · ${selectionLabels[source.selectionBasis] ?? source.selectionBasis}` : ""}</span>}
                {source.origin === "AUTO_CAPTURE" && <span className="message-memory-tag"
                  data-testid={`message-memory-auto-${messageId}`}>自动记住</span>}
                {source.origin === "AUTO_CAPTURE" && source.sourceKind !== null &&
                  source.sourceKind !== undefined && source.sourceKind !== "UNKNOWN" &&
                  <span className="message-memory-tag"
                  data-testid={`message-memory-source-kind-${messageId}`}>
                  {source.sourceKind === "USER_STATEMENT" ? "用户原话"
                    : source.sourceKind === "MODEL_OBSERVATION" ? "模型观察" : "人工保存"}
                </span>}
              </> : <span className="helper-text">一个来源已失效（身份不再返回）</span>}
            </li>)}
          </ul>
        </>}
        <p className="helper-text">这里只记录「这次生成读到了哪些确切版本」，不代表这些内容已被确认或已写回业务状态。</p>
      </>}
    </div>
  </details>;
}

/**
 * 长期记忆的保存来源（GET /memories/{id}/provenance）。
 *
 * 手工创建的记忆来源为空——这是合法事实，不是读取失败；历史版本也不会冒充当前版本。
 */
export function MemoryProvenancePanel({ client, memoryId }: {
  readonly client: RelayApiClient; readonly memoryId: string;
}) {
  const [sources, setSources] = useState<readonly { memoryVersion: string; sessionId: string;
    messageId: string; contentSha256: string }[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestVersion = useRef(0);

  const read = useCallback(async () => {
    const request = ++requestVersion.current;
    setLoading(true); setError(null);
    try {
      const provenance = await client.getMemoryProvenance(memoryId);
      if (request !== requestVersion.current) return;
      setSources(provenance.sources);
    } catch (caught) {
      if (request !== requestVersion.current) return;
      setError(describeLiveError(caught).message);
    } finally {
      if (request === requestVersion.current) setLoading(false);
    }
  }, [client, memoryId]);

  return <details className="memory-provenance" data-testid="memory-provenance"
    onToggle={(event) => { if (event.currentTarget.open && sources === null && !loading && error === null) void read(); }}>
    <summary>保存来源</summary>
    <div className="message-memory-body">
      {loading && <p className="helper-text" role="status">正在读取保存来源…</p>}
      {error !== null && <div className="action-error" role="alert" data-testid="memory-provenance-error">
        <p>保存来源读取失败：{error}</p>
        <button className="secondary-button" type="button" disabled={loading}
          onClick={() => void read()}>重新读取</button>
      </div>}
      {sources !== null && (sources.length === 0
        ? <p className="helper-text" data-testid="memory-provenance-empty">
          这条记忆没有消息来源：它是在资料页手工创建的。来源为空是事实，不会补造一条。</p>
        : <ul className="message-memory-list" data-testid="memory-provenance-list">
          {sources.map((source) => <li key={`${source.sessionId}:${source.messageId}:${source.memoryVersion}`}>
            <span className="message-memory-ref">版本 v{source.memoryVersion}</span>
            <span className="helper-text">会话 <code className="hash-code">{source.sessionId}</code> ·
              消息 <code className="hash-code">{source.messageId}</code></span>
            <span className="helper-text">原文摘要 <code className="hash-code">{source.contentSha256}</code></span>
          </li>)}
        </ul>)}
      <p className="helper-text">来源记录的是保存那一刻的原消息与确切版本；之后的修订不会改写它。</p>
    </div>
  </details>;
}
