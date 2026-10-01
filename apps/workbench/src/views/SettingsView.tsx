import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Info, RotateCcw, ShieldCheck } from "lucide-react";
import type { RelayModelPortStatus, RelayModelVerificationState,
  RelayModelVerifyResult, RelayViewKind } from "../api/relayClient";
import PackCatalogPanel from "../components/PackCatalogPanel";
import { describeLiveError } from "../lib/liveErrors";
import { modelErrorGuides } from "../lib/modelErrorGuides";
import { useRelayConnection } from "../lib/relayConnection";
import { saveDisplayPreferences, useDisplayPreferences } from "../lib/displayPreferences";
import { handleTabListKeyDown } from "../lib/tabNavigation";
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
  return <section id="settings-model" className="surface-panel settings-card" data-testid="service-state">
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
      <Info aria-hidden="true" />{modelErrorGuides[last.errorCategory]}</p>}
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
          {" "}{modelErrorGuides[last.errorCategory]}</dd></div>}
      </dl>}
    {verifying && <p role="status">正在验证…</p>}
    <p className="helper-text">「连接验证通过」≠「真实任务执行成功」：验证只使用固定短文本，不读取项目资料，也不代表任何 Task/Run 结果。</p>
  </section>;
}

const timeZoneOptions = [
  ["Asia/Shanghai", "Asia/Shanghai（北京时间）"],
  ["Asia/Hong_Kong", "Asia/Hong_Kong（香港时间）"],
  ["Asia/Tokyo", "Asia/Tokyo（日本时间）"],
  ["Europe/London", "Europe/London（伦敦时间）"],
  ["America/New_York", "America/New_York（纽约时间）"],
  ["America/Los_Angeles", "America/Los_Angeles（洛杉矶时间）"],
  ["UTC", "UTC（协调世界时）"]
] as const;

function DisplayPreferencesCard() {
  const preferences = useDisplayPreferences();
  const [timeZone, setTimeZone] = useState(preferences.timeZone);
  const [defaultWorkbench, setDefaultWorkbench] = useState<RelayViewKind>(preferences.defaultWorkbench ?? "general");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changed = () => { setSaved(false); setError(null); };

  return <section id="settings-preferences" className="settings-basic" aria-labelledby="settings-basic-title">
    <h2 id="settings-basic-title">基本设置</h2>
    <p className="settings-basic-intro">设置时区、界面外观和默认工作台，定制你的工作环境。</p>
    <form onSubmit={(event) => {
      event.preventDefault(); setError(null); setSaved(false);
      try { saveDisplayPreferences({ timeZone, defaultWorkbench }); setSaved(true); }
      catch { setError("设置未保存：本设备存储不可写，请检查浏览器或应用的存储权限后重试。"); }
    }}>
      <div className="settings-field">
        <label htmlFor="settings-timezone">界面时区</label>
        <select id="settings-timezone" data-testid="settings-timezone" value={timeZone}
          aria-describedby="settings-timezone-help" onChange={(event) => { setTimeZone(event.target.value); changed(); }}>
          {!timeZoneOptions.some(([value]) => value === timeZone) && <option value={timeZone}>{timeZone}</option>}
          {timeZoneOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <p id="settings-timezone-help" className="helper-text">用于顶栏日期显示，不改变已保存的稍后处理日期。</p>
      </div>
      <div className="settings-field">
        <label htmlFor="settings-appearance">界面外观</label>
        <select id="settings-appearance" value="light" disabled aria-describedby="settings-appearance-help">
          <option value="light">浅色</option>
        </select>
        <p id="settings-appearance-help" className="helper-text">当前仅支持浅色主题。</p>
      </div>
      <div className="settings-field">
        <label htmlFor="settings-default-workbench">默认工作台</label>
        <select id="settings-default-workbench" data-testid="settings-default-workbench" value={defaultWorkbench}
          aria-describedby="settings-workbench-help" onChange={(event) => { setDefaultWorkbench(event.target.value as RelayViewKind); changed(); }}>
          <option value="general">通用</option><option value="thesis">论文</option><option value="development">开发</option>
        </select>
        <p id="settings-workbench-help" className="helper-text">打开项目工作台时使用；项目已保存的默认视图优先，可随时在工作台内切换。</p>
      </div>
      <div className="settings-save-actions">
        <button type="submit" className="primary-button" data-testid="settings-save">保存设置</button>
        {saved && <p role="status" className="settings-save-result">设置已保存，仅在本设备生效。</p>}
        {error && <p role="alert" className="action-error">{error}</p>}
      </div>
      <p className="settings-device-note helper-text">显示偏好仅保存在本设备。</p>
    </form>
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
  const [group, setGroup] = useState<"basic" | "model" | "execution" | "workbench">("basic");

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
    <header className="settings-heading"><h1>设置</h1><p className="page-lede">本设备偏好与服务配置</p></header>
    <div className="settings-layout">
      <nav className="settings-navigation" role="tablist" aria-label="设置分组" onKeyDown={handleTabListKeyDown}>
        {([['basic', '基本设置'], ['model', 'AI 设置'], ['execution', '执行策略'], ['workbench', '工作台']] as const)
          .map(([value, label]) => <button key={value} type="button" data-testid={`settings-group-${value}`}
            role="tab" id={`settings-tab-${value}`} aria-controls={`settings-panel-${value}`} aria-selected={group === value}
            tabIndex={group === value ? 0 : -1} onClick={() => setGroup(value)}>{label}</button>)}
      </nav>
      <div className="settings-content">
      <div role="tabpanel" id="settings-panel-basic" aria-labelledby="settings-tab-basic" hidden={group !== "basic"}><DisplayPreferencesCard /></div>
      <div role="tabpanel" id="settings-panel-model" aria-labelledby="settings-tab-model" hidden={group !== "model"}>{client === null ? <>
      <div className="warning-callout" role="status">
      当前是示例数据预览，没有真实服务实例状态。<Link to="/projects">打开项目</Link>，或通过顶栏「数据来源」连接本机 API。</div>
      </> : <>
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
      <section className="surface-panel settings-card">
        <h2>相关入口</h2>
        <ul className="settings-links">
          <li><Link to="/connections">连接与权限</Link>：Gateway 连接、受管资源与策略在项目级管理。</li>
          <li><Link to="/projects">项目</Link>：项目设置内可管理默认工作台视图与 Pack 清单。</li>
        </ul>
      </section>
    </>}</div>
      <div role="tabpanel" id="settings-panel-workbench" aria-labelledby="settings-tab-workbench" hidden={group !== "workbench"}>{group === "workbench" && <div id="settings-packs"><PackCatalogPanel /></div>}</div>
      <div role="tabpanel" id="settings-panel-execution" aria-labelledby="settings-tab-execution" hidden={group !== "execution"}><section className="surface-panel settings-card">
        <h2>执行策略</h2>
        <p className="helper-text">执行连接与权限按项目管理，通知偏好尚无写接口。</p>
        <dl className="settings-definition-list">
          <div><dt>界面语言</dt><dd><span className="status-chip status-chip--neutral">暂不可用</span> 尚无语言偏好接口。</dd></div>
          <div><dt>通知偏好</dt><dd><span className="status-chip status-chip--neutral">暂不可用</span>
            人工介入提醒规则已确认（工作台 11.5）：仅提醒必须由用户介入的事项；Relay 运行期间应用内保留待处理标记，窗口外另发 Windows 通知；同一事项只提醒一次；短时间多个事项合并为一条通知。本页暂无写接口，不提供假开关。</dd></div>
        </dl>
        <Link className="inline-link" to="/connections">查看连接与权限</Link>
      </section></div>
      <details className="settings-explanation"><summary>显示与执行说明</summary>
        <p>切换工作台只改变展示，不改变活动任务的执行约定。</p>
        <p>界面时区用于显示日期和时间，不会改写已保存的稍后处理日期。</p>
        <p>AI 与执行权限在对应设置中单独管理。</p>
      </details>
      </div>
    </div>
  </section>;
}
