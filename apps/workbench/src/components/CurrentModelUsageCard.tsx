import { useEffect, useRef, useState } from "react";
import { RotateCcw } from "lucide-react";

import type { RelayApiClient, RelayModelPortStatus } from "../api/relayClient";
import type { RelayDefaultModelConnection, RelayModelConnection } from "../api/dtos/information";
import { describeLiveError } from "../lib/liveErrors";
import { Button } from "../ui";

interface UsageSnapshot {
  readonly connections: readonly RelayModelConnection[];
  readonly chatDefault: RelayDefaultModelConnection;
  readonly runDefault: RelayDefaultModelConnection;
}

/**
 * 当前使用的模型：把三类作用域摊开，避免用户把「聊天默认」和「Run 默认」当成同一件事。
 *
 * 这里只读服务端事实，不做推断：连接不可见就如实说不可见；未设置就说明跟随进程默认。
 * 已排队/生成中的消息与已冻结 Run 各自持有冻结身份，不因这里的默认变更而切换。
 */
export function CurrentModelUsageCard({ client, status, refreshToken = 0 }: {
  readonly client: RelayApiClient;
  readonly status: RelayModelPortStatus | null;
  /** 默认连接写入后由上层递增，触发重读；不用回执结果拼接第二份事实。 */
  readonly refreshToken?: number;
}) {
  const [snapshot, setSnapshot] = useState<UsageSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestVersion = useRef(0);

  function read(): void {
    const request = ++requestVersion.current;
    setLoading(true);
    setError(null);
    void Promise.all([client.listModelConnections(), client.getDefaultModelConnection(),
      client.getChatDefaultModelConnection()])
      .then(([connections, runDefault, chatDefault]) => {
        if (request !== requestVersion.current) return;
        setSnapshot({ connections, runDefault, chatDefault });
        setLoading(false);
      })
      .catch((caught: unknown) => {
        if (request !== requestVersion.current) return;
        setSnapshot(null);
        setError(describeLiveError(caught).message);
        setLoading(false);
      });
  }

  useEffect(() => {
    requestVersion.current += 1;
    setSnapshot(null); setError(null); setLoading(true);
    read();
    return () => { requestVersion.current += 1; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, refreshToken]);

  const processText = status === null
    ? "读取中"
    : status.provider === "fake"
      ? "Mock 端口（仅供开发，不调用外部服务）"
      : status.provider === "invalid"
        ? "配置残缺：真实模型不可用，也不会静默回退"
        : null;

  return <section className="settings-card" data-testid="current-model-usage">
    <h2>当前使用的模型</h2>
    <p className="helper-text">生效顺序：会话显式选择 → 工作区聊天默认 → 进程默认。</p>
    {loading && <p role="status">正在读取当前模型使用情况…</p>}
    {error !== null && <div className="action-error" role="alert" data-testid="current-model-usage-error">
      <p>读取失败：{error}</p>
      <Button variant="secondary" onClick={read}>
        <RotateCcw aria-hidden="true" />重新读取</Button>
    </div>}
    {snapshot !== null && <dl className="settings-usage-list">
      <div className="settings-usage-row" data-testid="current-model-chat-default">
        <dt>聊天 · 新消息（无会话选择）</dt>
        <dd><DefaultConnectionLine connectionId={snapshot.chatDefault.connectionId}
          connections={snapshot.connections} unsetText="跟随进程默认" />
        </dd>
      </div>
      <div className="settings-usage-row" data-testid="current-model-session">
        <dt>聊天 · 会话显式选择</dt>
        <dd>在输入器里选择，只对该会话之后的新消息生效。</dd>
      </div>
      <div className="settings-usage-row" data-testid="current-model-run-default">
        <dt>任务执行 · 新 Run</dt>
        <dd><DefaultConnectionLine connectionId={snapshot.runDefault.connectionId}
          connections={snapshot.connections} unsetText="跟随进程默认" />
          <span className="helper-text">连接停用、凭据缺失或配置变化会让它停止并明确报错。</span></dd>
      </div>
      <div className="settings-usage-row" data-testid="current-model-process">
        <dt>进程默认（环境变量）</dt>
        <dd>
          {processText === null && status !== null
            ? <>
              <span className="settings-usage-value">
                <code className="hash-code">{status.model ?? "缺少模型名"}</code>
              </span>
              {status.baseUrl !== null && <span className="settings-usage-endpoint">
                <code className="hash-code">{status.baseUrl}</code>
              </span>}
            </>
            : processText}
          <span className="helper-text">本机兜底，不是页面保存的设置。</span>
        </dd>
      </div>
    </dl>}
  </section>;
}

function DefaultConnectionLine({ connectionId, connections, unsetText }: {
  readonly connectionId: string | null;
  readonly connections: readonly RelayModelConnection[];
  readonly unsetText: string;
}) {
  if (connectionId === null) {
    return <><span className="status-chip status-chip--neutral">未指定</span>{" "}{unsetText}</>;
  }
  const connection = connections.find((item) => item.id === connectionId) ?? null;
  if (connection === null) {
    return <><span className="status-chip status-chip--danger">连接不可见</span>{" "}
      已指定的连接在当前工作区不可见；执行端会明确报错，不会换用其他连接。</>;
  }
  return <><span className={`status-chip status-chip--${
    connection.status === "ACTIVE" ? "success" : "danger"}`}>
    {connection.status === "ACTIVE" ? "已启用" : "已停用"}</span>{" "}
    <strong>{connection.name}</strong>{" · "}<code className="hash-code">{connection.defaultModel}</code>
    {connection.status !== "ACTIVE" && <>{" "}（已停用：新消息/新 Run 会明确拒绝，不会静默回退）</>}</>;
}
