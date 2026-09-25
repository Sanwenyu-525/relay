import { useRef, useState, type FormEvent } from "react";
import { Info, Link2, Unplug } from "lucide-react";
import { RelayApiClient } from "../api/relayClient";
import AppDialog from "./AppDialog";
import { describeLiveError } from "../lib/liveErrors";
import { hasUnsavedDraft } from "../lib/draftGuard";
import { activateRelayConnection, relayConnection, useFixtureData, useRelayConnection } from "../lib/relayConnection";

export default function RelayConnectionDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const connection = useRelayConnection();
  const [baseUrl, setBaseUrl] = useState("http://127.0.0.1:8787");
  const [workspaceId, setWorkspaceId] = useState("");
  const [bearerToken, setBearerToken] = useState("");
  const [checking, setChecking] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const requestVersion = useRef(0);

  function close(): void {
    requestVersion.current++;
    setChecking(false);
    setBearerToken("");
    onClose();
  }

  async function connect(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (checking || connection.mode === "live") return;
    if (hasUnsavedDraft()) { setFailure("当前页面有未保存的草稿。请先保存或离开页面时选择丢弃，再切换数据来源。"); return; }
    const request = ++requestVersion.current;
    const connectionEpoch = relayConnection.epoch;
    setFailure(null);
    setSuccess(null);
    setChecking(true);
    try {
      const input = { baseUrl, workspaceId, bearerToken };
      // Readiness is checked before changing mode; liveness alone is insufficient.
      await new RelayApiClient(input).getHealthReady();
      if (request !== requestVersion.current || connectionEpoch !== relayConnection.epoch) return;
      if (hasUnsavedDraft()) { setFailure("检查期间出现未保存的草稿，数据来源未切换。请先处理草稿。"); return; }
      activateRelayConnection(input);
      setBearerToken("");
      setSuccess("已连接：/health/ready 返回 200，数据库与 schema 均匹配。");
    } catch (caught) {
      if (request !== requestVersion.current || connectionEpoch !== relayConnection.epoch) return;
      useFixtureData();
      setFailure(describeLiveError(caught).message);
    } finally {
      if (request === requestVersion.current) setChecking(false);
    }
  }

  function disconnect(): void {
    requestVersion.current++;
    setChecking(false);
    if (hasUnsavedDraft()) { setFailure("当前页面有未保存的草稿。请先保存或离开页面时选择丢弃，再切换数据来源。"); return; }
    useFixtureData();
    setBearerToken("");
    setSuccess(null);
    setFailure("已断开：页面回到示例数据，内存中的凭据已清除。");
  }

  return <AppDialog open={open} title="连接本机 API" onClose={close}>
    <p className="helper-text">工作台默认使用示例数据。连接本机 API 后，创建项目、创建任务、开始任务等操作会写入真实 PostgreSQL。</p>
    {connection.mode === "live"
      ? <p className="receipt-message" role="status" data-testid="relay-connection-state">已连接 {connection.baseUrl}</p>
      : <p className="helper-text" data-testid="relay-connection-state">当前：示例数据（fixture），不调用任何 API。</p>}
    <form className="create-form" noValidate onSubmit={(event) => { void connect(event); }}>
      <label className="field"><span className="field-label">API 地址<span className="field-required" aria-hidden="true">*</span></span>
        <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} name="relay-base-url" required autoComplete="off" />
        <span className="field-hint">只接受 http 或 https 的完整地址；本机 API 默认监听 http://127.0.0.1:8787。</span>
      </label>
      <label className="field"><span className="field-label">Workspace ID<span className="field-required" aria-hidden="true">*</span></span>
        <input value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)} name="relay-workspace-id" required autoComplete="off" />
        <span className="field-hint">由 apps/api 的 Workspace 初始化入口创建；未初始化时后端会按不可见处理。</span>
      </label>
      <label className="field"><span className="field-label">Bearer 令牌<span className="field-required" aria-hidden="true">*</span></span>
        <input value={bearerToken} onChange={(event) => setBearerToken(event.target.value)} name="relay-bearer-token" type="password" required autoComplete="off" disabled={connection.mode === "live"} />
        <span className="field-hint">令牌只保存在当前页面内存，不写入浏览器存储、URL 或日志，刷新即清除。</span>
      </label>
      <div className="form-actions">
        <button className="primary-button" type="submit" data-testid="relay-connect" disabled={checking || connection.mode === "live"}>{checking ? "正在检查" : "连接并检查就绪"}</button>
        {connection.mode === "live" && <button className="secondary-button" type="button" data-testid="relay-disconnect" onClick={disconnect}><Unplug aria-hidden="true" />断开并回到示例数据</button>}
        <button className="text-button" type="button" onClick={close}>关闭</button>
      </div>
      {success && <p className="receipt-message" role="status">{success}</p>}
      {failure && <p className="action-error" role="alert" data-testid="relay-connection-error">{failure}</p>}
      <p className="helper-text"><Info aria-hidden="true" />连接前请先启动本机 PostgreSQL、执行迁移入口与 Workspace 初始化；未通过 /health/ready 时工作台不会进入 live 模式。</p>
      <p className="helper-text"><Link2 aria-hidden="true" />真实 API 尚未提供的入口仍会显示未接入。</p>
    </form>
  </AppDialog>;
}
