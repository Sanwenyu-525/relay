import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Info, RotateCcw } from "lucide-react";
import type { RelayModelPortStatus } from "../api/relayClient";
import PackCatalogPanel from "../components/PackCatalogPanel";
import { describeLiveError } from "../lib/liveErrors";
import { useRelayConnection } from "../lib/relayConnection";
import "./SettingsView.css";

const providerLabels: Record<RelayModelPortStatus["provider"], string> = {
  fake: "Mock 模型端口",
  "openai-compatible": "真实 Provider（OpenAI 兼容）",
  invalid: "真实 Provider 配置残缺"
};

function ModelPortCard({ status }: { status: RelayModelPortStatus }) {
  return <section className="surface-panel settings-card" data-testid="model-port-status">
    <h2>模型端口</h2>
    <dl className="settings-definition-list">
      <div><dt>当前端口</dt><dd><strong>{providerLabels[status.provider]}</strong></dd></div>
      <div><dt>模型名称</dt><dd>{status.model ?? "未配置（Mock 端口不需要模型名）"}</dd></div>
      <div><dt>服务端点</dt><dd>{status.baseUrl
        ? <code className="hash-code">{status.baseUrl}</code>
        : status.provider === "openai-compatible" ? "未自定义（使用内置默认端点）" : "—"}</dd></div>
    </dl>
    {status.provider === "fake" && <p className="helper-text"><Info aria-hidden="true" />当前服务实例未配置真实模型：任务委托与 Assist 使用确定性 Mock 模型，不调用外部服务。这是当前阶段的既定门槛，不是故障。</p>}
    {status.provider === "invalid" && <p className="action-error" role="alert">服务实例的模型配置残缺（例如缺少 API Key 或模型名）；真实模型调用不可用，也不会静默回退。请检查服务端启动配置后重启实例。</p>}
    <p className="helper-text">配置来自服务实例的环境变量；API 密钥只保存在服务端配置中，本页面不读取、不显示、也不修改任何密钥。</p>
  </section>;
}

export default function SettingsView() {
  const connection = useRelayConnection();
  const client = connection.mode === "live" ? connection.client : null;
  const [status, setStatus] = useState<RelayModelPortStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestVersion = useRef(0);

  useEffect(() => {
    const request = ++requestVersion.current;
    setLoading(client !== null); setError(null); setStatus(null);
    if (client === null) return;
    void client.getModelPortStatus().then((next) => {
      if (request === requestVersion.current) { setStatus(next); setLoading(false); }
    }).catch((caught: unknown) => {
      if (request === requestVersion.current) { setError(describeLiveError(caught).message); setLoading(false); }
    });
    return () => { requestVersion.current++; };
  }, [client, connection.epoch]);

  return <section className="settings-page" data-testid="settings-page">
    <p className="eyebrow">工作空间</p>
    <h1>设置</h1>
    <p className="page-lede">这里汇总当前服务实例的只读状态；业务连接、权限与凭据仍在各自的页面管理。</p>
    {client === null ? <>
      <div className="warning-callout" role="status">
      当前是示例数据预览，没有真实服务实例状态。<Link to="/projects">打开项目</Link>，或通过顶栏「数据来源」连接本机 API。</div>
      <PackCatalogPanel /></> : <>
      {loading && <p role="status">正在读取服务实例配置状态…</p>}
      {error && <div className="action-error" role="alert"><p>读取失败：{error}</p>
        <button className="secondary-button" type="button"
          onClick={() => { void client.getModelPortStatus().then((next) => { setStatus(next); setError(null); }).catch((caught: unknown) => setError(describeLiveError(caught).message)); }}>
          <RotateCcw aria-hidden="true" />重新读取</button></div>}
      {status && <ModelPortCard status={status} />}
      <PackCatalogPanel />
      <section className="surface-panel settings-card">
        <h2>相关入口</h2>
        <ul className="settings-links">
          <li><Link to="/connections">连接与权限</Link>：Gateway 连接、受管资源与策略在项目级管理。</li>
          <li><Link to="/projects">项目</Link>：项目设置内可管理默认工作台视图与 Pack 清单。</li>
        </ul>
      </section>
    </>}
  </section>;
}
