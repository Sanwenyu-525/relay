import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Info, RotateCcw, ShieldCheck } from "lucide-react";
import type { RelayModelPortStatus, RelayModelVerificationState,
  RelayModelVerifyResult } from "../api/relayClient";
import PackCatalogPanel from "../components/PackCatalogPanel";
import { describeLiveError } from "../lib/liveErrors";
import { useRelayConnection } from "../lib/relayConnection";
import "./SettingsView.css";

const providerLabels: Record<RelayModelPortStatus["provider"], string> = {
  fake: "Mock 模型端口",
  "openai-compatible": "真实 Provider（OpenAI 兼容）",
  invalid: "真实 Provider 配置残缺"
};

/** 模型验证六态：互斥，各自回答不同问题，绝不互相冒充。 */
export type ModelVerificationStateKind =
  | "UNCONFIGURED"      // 未配置
  | "UNVERIFIED"        // 已配置未验证
  | "VERIFYING"         // 验证中
  | "VERIFIED"          // 验证通过
  | "VERIFY_FAILED"     // 验证失败
  | "UNAVAILABLE";      // 当前不可用

export function resolveVerificationState(input: {
  readonly status: RelayModelPortStatus | null;
  readonly verification: RelayModelVerificationState | null;
  readonly verifying: boolean;
}): ModelVerificationStateKind {
  if (input.status === null) return "UNAVAILABLE";
  if (input.status.provider === "invalid") return "UNAVAILABLE";
  if (input.status.provider === "fake" || !input.status.configured) return "UNCONFIGURED";
  if (input.verifying) return "VERIFYING";
  const last = input.verification?.last ?? null;
  const matches = input.verification?.matchesCurrentConfig === true;
  if (last !== null && matches) return last.ok ? "VERIFIED" : "VERIFY_FAILED";
  return "UNVERIFIED";
}

const verificationLabels: Record<ModelVerificationStateKind,
  { chip: string; tone: StateRow["tone"]; detail: string }> = {
  UNCONFIGURED: {
    chip: "未配置",
    tone: "neutral",
    detail: "当前服务实例使用 Mock 端口，没有真实模型可验证。这不是故障，也不表示任务执行成功。"
  },
  UNVERIFIED: {
    chip: "已配置未验证",
    tone: "warning",
    detail: "服务端已读到配置，但还没有与当前配置指纹匹配的验证记录。配置格式通过不等于网络调用成功；"
      + "配置变更后旧验证结果自动失效。连接验证通过也不等于真实任务执行成功。"
  },
  VERIFYING: {
    chip: "验证中",
    tone: "neutral",
    detail: "正在用固定短文本发起一次连接验证（非任务调用）。请稍候；验证结果只证明当前配置可连通。"
  },
  VERIFIED: {
    chip: "验证通过",
    tone: "success",
    detail: "最近一次连接验证通过：认证、端点与模型对固定短文本调用有响应。"
      + "这只证明连接可用，不表示任何真实任务已经执行成功。"
  },
  VERIFY_FAILED: {
    chip: "验证失败",
    tone: "danger",
    detail: "最近一次连接验证未通过。请按错误分类核对 API Key、配额、网络或端点后重新验证。"
      + "失败不会回退 Mock，也不代表任务执行结果。"
  },
  UNAVAILABLE: {
    chip: "当前不可用",
    tone: "danger",
    detail: "真实模型配置残缺或服务状态无法读取，连接验证不可用。生产进程会拒绝残缺配置，不会静默回退。"
  }
};

const errorCategoryGuides: Record<string, string> = {
  AUTH: "认证失败（401/403）：请核对 API Key 是否有效、是否有该模型权限。",
  RATE_LIMIT: "限流（429）：请稍后重试，或核对配额与账户额度。",
  TIMEOUT: "超时：请检查网络到端点的连通性，或调大 RELAY_MODEL_TIMEOUT_MS 后重启。",
  STREAM_BROKEN: "流中断：端点协议兼容性异常，请核对 Provider 是否为 OpenAI 兼容接口。",
  PROTOCOL: "响应结构异常或模型无效：请核对模型名称与端点是否匹配。",
  NETWORK: "网络不可达：请核对服务端点域名/DNS/防火墙，确认端点可公开访问。"
};

interface StateRow {
  readonly key: string;
  readonly label: string;
  readonly tone: "success" | "warning" | "danger" | "neutral";
  readonly chip: string;
  readonly detail: string;
}

/**
 * 四态各自独立：连接、配置、验证、Worker 执行是四个不同事实。
 * 「已配置」只表示服务端读到了配置格式，绝不能冒充网络验证成功；
 * 验证态来自 model_calls 账本（比对 config_fingerprint），不再写死。
 */
function ServiceStateCard({ loading, error, status, verification, verifying, onVerify }: {
  loading: boolean; error: string | null; status: RelayModelPortStatus | null;
  verification: RelayModelVerificationState | null; verifying: boolean;
  onVerify: (() => void) | null;
}) {
  const verifyState = resolveVerificationState({ status, verification, verifying });
  const verifyMeta = verificationLabels[verifyState];
  const last = verification?.last ?? null;
  const showGuide = verifyState === "VERIFY_FAILED" && last?.errorCategory != null;
  const workerProbe = verification?.workerStartupValidation;
  const rows: StateRow[] = [
    { key: "connected", label: "本机服务已连接",
      tone: error ? "danger" : loading || status === null ? "neutral" : "success",
      chip: error ? "读取失败" : loading || status === null ? "读取中" : "已连接",
      detail: error
        ? "本页最近一次与本机 API 的通信没有成功，可重新读取。"
        : loading || status === null
          ? "正在向本机 API 读取状态。"
          : "本页已从本机 API 读到服务实例状态。" },
    { key: "configured", label: "模型已配置",
      tone: status === null || loading ? "neutral"
        : status.configured ? "success" : status.provider === "invalid" ? "danger" : "neutral",
      chip: status === null || loading ? "未读取"
        : status.configured ? "已配置" : status.provider === "invalid" ? "配置残缺" : "未配置",
      detail: status === null || loading
        ? "等待服务实例状态。"
        : status.configured
          ? `服务端已读到模型配置：${status.model ?? "（缺模型名）"}。这只说明配置存在。`
          : status.provider === "invalid"
            ? "配置格式残缺（例如缺少 API Key 或模型名）；生产进程会拒绝启动，不会静默回退。"
            : "当前服务实例使用 Mock 端口，未配置真实模型。" },
    { key: "verified", label: "模型验证成功",
      tone: verifyMeta.tone, chip: verifyMeta.chip, detail: verifyMeta.detail },
    { key: "worker", label: "Worker 可执行",
      tone: "neutral", chip: "未探测",
      detail: "Worker 可执行性未探测：本页不探测 Worker 进程，也不确认 Worker 与 API 是否使用同一配置来源。"
        + (workerProbe === "OK"
          ? "（诊断：API 进程环境的配置启动校验通过，仅供核对，不代表 Worker 已执行。）"
          : workerProbe === "FAILED"
            ? "（诊断：API 进程环境的配置启动校验失败；若 Worker 使用同一环境，启动会被拒绝。）"
            : workerProbe === "NOT_CONFIGURED"
              ? "（诊断：API 进程环境未配置真实模型。）"
              : "") },
  ];
  return <section className="surface-panel settings-card" data-testid="service-state">
    <h2>连接与模型状态</h2>
    <p className="helper-text">四个状态分别回答四个问题：连上了吗、配置了吗、验证过了吗、Worker 能执行吗。
      「连接验证通过」只表示固定短文本调用成功，不等于真实任务执行成功。</p>
    <dl className="settings-definition-list">
      {rows.map((row) => <div key={row.key} data-testid={`service-state-${row.key}`}>
        <dt>{row.label}</dt>
        <dd><span className={`status-chip status-chip--${row.tone}`}>{row.chip}</span> {row.detail}</dd>
      </div>)}
    </dl>
    {showGuide && last?.errorCategory != null && <p className="helper-text" data-testid="verify-error-guide">
      <Info aria-hidden="true" />{errorCategoryGuides[last.errorCategory] ?? ""}</p>}
    {onVerify !== null && <p className="settings-verify-actions">
      <button className="secondary-button" type="button" data-testid="verify-model-port"
        disabled={verifying} onClick={onVerify}>
        <ShieldCheck aria-hidden="true" />{verifying ? "验证中…" : "验证连接"}</button>
      <span className="helper-text">用固定短文本发起一次连接验证，结果写入调用账本；不携带项目资料。</span>
    </p>}
  </section>;
}

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

function VerificationDetailCard({ verification, verifying }: {
  verification: RelayModelVerificationState | null; verifying: boolean;
}) {
  const last = verification?.last ?? null;
  const matches = verification?.matchesCurrentConfig === true;
  return <section className="surface-panel settings-card" data-testid="verification-detail">
    <h2>最近一次验证</h2>
    {last === null
      ? <p className="helper-text">尚无验证记录。配置后可点击「验证连接」发起一次固定短文本调用。</p>
      : <dl className="settings-definition-list">
        <div><dt>结果</dt><dd>
          <span className={`status-chip status-chip--${last.ok ? "success" : "danger"}`}>
            {last.ok ? "通过" : "失败"}</span>
          {" "}验证于 {last.verifiedAt}{last.latencyMs === null ? "" : ` · ${last.latencyMs} ms`}</dd></div>
        <div><dt>目标</dt><dd>{last.provider} / {last.model}</dd></div>
        <div><dt>配置指纹</dt><dd><code className="hash-code">{last.configFingerprint}</code>
          {matches
            ? "（与当前配置一致）"
            : "（与当前配置不一致：配置已变更，旧结果不再算已验证）"}</dd></div>
        {last.errorCategory !== null && <div><dt>错误分类</dt><dd>
          <span className="status-chip status-chip--danger">{last.errorCategory}</span>
          {" "}{errorCategoryGuides[last.errorCategory] ?? ""}</dd></div>}
      </dl>}
    {verifying && <p role="status">正在验证…</p>}
    <p className="helper-text">「连接验证通过」≠「真实任务执行成功」：验证只使用固定短文本，不读取项目资料，也不代表任何 Task/Run 结果。</p>
  </section>;
}

export default function SettingsView() {
  const connection = useRelayConnection();
  const client = connection.mode === "live" ? connection.client : null;
  const [status, setStatus] = useState<RelayModelPortStatus | null>(null);
  const [verification, setVerification] = useState<RelayModelVerificationState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const requestVersion = useRef(0);

  const refresh = useCallback(() => {
    const request = ++requestVersion.current;
    if (client === null) {
      setLoading(false); setError(null); setStatus(null); setVerification(null);
      return;
    }
    setLoading(true); setError(null); setStatus(null);
    void Promise.all([client.getModelPortStatus(), client.getModelPortVerification()])
      .then(([nextStatus, nextVerification]) => {
        if (request === requestVersion.current) {
          setStatus(nextStatus); setVerification(nextVerification); setLoading(false);
        }
      }).catch((caught: unknown) => {
        if (request === requestVersion.current) {
          setError(describeLiveError(caught).message); setLoading(false);
        }
      });
  }, [client]);

  useEffect(() => {
    refresh();
    return () => { requestVersion.current++; };
  }, [refresh, connection.epoch]);

  const onVerify = client === null ? null : () => {
    setVerifying(true); setVerifyError(null);
    void client.verifyModelPort().then((result: RelayModelVerifyResult) => {
      setVerifying(false);
      setVerification((previous) => ({
        currentConfigFingerprint: previous?.currentConfigFingerprint ??
          result.configFingerprint,
        last: result,
        matchesCurrentConfig: previous?.currentConfigFingerprint == null
          ? true
          : previous.currentConfigFingerprint === result.configFingerprint,
        workerStartupValidation: previous?.workerStartupValidation ?? "NOT_CONFIGURED"
      }));
    }).catch((caught: unknown) => {
      setVerifying(false);
      setVerifyError(describeLiveError(caught).message);
    });
  };

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
          onClick={refresh}>
          <RotateCcw aria-hidden="true" />重新读取</button></div>}
      {verifyError && <div className="action-error" role="alert" data-testid="verify-error">
        <p>验证未完成：{verifyError}</p></div>}
      <ServiceStateCard loading={loading} error={error} status={status}
        verification={verification} verifying={verifying} onVerify={onVerify} />
      {status && <ModelPortCard status={status} />}
      {status?.configured === true && <VerificationDetailCard verification={verification}
        verifying={verifying} />}
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
          <div><dt>通知偏好</dt><dd><span className="status-chip status-chip--neutral">暂不可用</span>
            人工介入提醒规则已确认（工作台 11.5）：仅提醒必须由用户介入的事项；Relay 运行期间应用内保留待处理标记，窗口外另发 Windows 通知；同一事项只提醒一次；短时间多个事项合并为一条通知。本页暂无写接口，不提供假开关。</dd></div>
          <div><dt>工作空间级显示偏好持久化</dt><dd><span className="status-chip status-chip--neutral">暂不可用</span> 没有对应的写接口；项目级「默认工作台视图」在项目设置内按 ViewConfiguration 契约管理。</dd></div>
        </dl>
        <p className="helper-text"><Info aria-hidden="true" />界面时区只在「今日」页作为显示核对，不改变 Later 的存储语义；切换通用/论文/开发视图只改展示，不改变活动 Run 的契约。两者均不在本页写入。</p>
      </section>
  </section>;
}
