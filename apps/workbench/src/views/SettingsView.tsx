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
      <section className="surface-panel settings-card">
        <h2>偏好与暂不可用项</h2>
        <p className="helper-text">本页只呈现当前服务实例已定义、且可安全只读的事实。以下偏好尚无对应的服务端契约，明确标记为暂不可用，不提供假开关，也不新建万能 settings 保存接口。</p>
        <dl className="settings-definition-list">
          <div><dt>深色主题 / 主题切换</dt><dd><span className="status-chip status-chip--neutral">暂不可用</span> 当前设计系统只定义浅色实现，未决定深色主题，不提供切换开关。</dd></div>
          <div><dt>界面语言</dt><dd><span className="status-chip status-chip--neutral">暂不可用</span> 尚无语言偏好接口。</dd></div>
          <div><dt>通知偏好</dt><dd><span className="status-chip status-chip--neutral">暂不可用</span> 人工介入提醒的策略与调度尚未冻结，不在本页写入。</dd></div>
          <div><dt>工作空间级显示偏好持久化</dt><dd><span className="status-chip status-chip--neutral">暂不可用</span> 没有对应的写接口；项目级「默认工作台视图」在项目设置内按 ViewConfiguration 契约管理。</dd></div>
        </dl>
        <p className="helper-text"><Info aria-hidden="true" />界面时区只在「今日」页作为显示核对，不改变 Later 的存储语义；切换通用/论文/开发视图只改展示，不改变活动 Run 的契约。两者均不在本页写入。</p>
      </section>
  </section>;
}
