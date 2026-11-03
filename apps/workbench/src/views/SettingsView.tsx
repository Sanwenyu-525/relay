import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { FolderOpen, Info, RotateCcw, ShieldCheck, X } from "lucide-react";
import { createCommandId, RelayApiError, type RelayApiClient, type RelayModelPortStatus,
  type RelayModelVerificationState, type RelayViewKind,
  type RelayWorkingDirectory, type RelayWriteTier, type RelayWorkspaceDefaultDirectory } from "../api/relayClient";
import { resolveVerificationState, verificationLabels, verifyErrorCategoryLabels,
  type ModelVerificationStateKind } from "../lib/modelVerification";
import PackCatalogPanel from "../components/PackCatalogPanel";
import MemorySettingsCard from "../components/MemorySettingsCard";
import ContextBudgetCard from "../components/ContextBudgetCard";
import { CurrentModelUsageCard } from "../components/CurrentModelUsageCard";
import { ModelConnectionsCard } from "../components/ModelConnectionsCard";
import PageHeader from "../components/PageHeader";
import { describeLiveError } from "../lib/liveErrors";
import { modelErrorGuides } from "../lib/modelErrorGuides";
import { useRelayConnection } from "../lib/relayConnection";
import { formatReadableDateTime, saveDisplayPreferences, useDisplayPreferences } from "../lib/displayPreferences";
import { saveNavigationPlacement, useNavigationPlacement, type NavigationPlacement } from "../lib/navigationPreferences";
import { applyMotionPreference, storeMotionPreference, storedMotionPreference,
  type MotionPreference } from "../lib/motionPreference";
import { handleTabListKeyDown } from "../lib/tabNavigation";
import { nativeFolderPickerAvailable, selectWorkingDirectory } from "../lib/desktopHost";
import "./SettingsView.css";

// 验证态映射与文案由 lib/modelVerification 统一维护；此处保留导出，兼容既有调用方与测试。
export { resolveVerificationState };
export type { ModelVerificationStateKind };

type SettingsGroup = "basic" | "model" | "execution" | "workbench";

const providerLabels: Record<RelayModelPortStatus["provider"], string> = {
  fake: "Mock 模型端口",
  "openai-compatible": "真实 Provider（OpenAI 兼容）",
  invalid: "真实 Provider 配置残缺"
};

interface StateRow {
  readonly key: string;
  readonly label: string;
  readonly tone: "success" | "warning" | "danger" | "neutral";
  readonly chip: string;
  readonly detail: string;
}

/**
 * 三态各自独立：连接、配置、验证是三个不同事实。
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
  const rows: StateRow[] = [
    { key: "connected", label: "本机服务已连接",
      tone: error ? "danger" : loading || status === null ? "neutral" : "success",
      chip: error ? "读取失败" : loading || status === null ? "读取中" : "已连接",
      detail: error
        ? "本页最近一次与本机 API 的通信没有成功，可重新读取。"
        : loading || status === null
          ? "正在向本机 API 读取状态。"
          : "" },
    { key: "configured", label: "模型已配置",
      tone: status === null || loading ? "neutral"
        : status.configured ? "success" : status.provider === "invalid" ? "danger" : "neutral",
      chip: status === null || loading ? "未读取"
        : status.configured ? "已配置" : status.provider === "invalid" ? "配置残缺" : "未配置",
      detail: status === null || loading
        ? "等待服务实例状态。"
        : status.configured
          ? `服务端已读到模型配置：${status.model ?? "（缺模型名）"}。`
          : status.provider === "invalid"
            ? "配置格式残缺（例如缺少 API Key 或模型名）；生产进程会拒绝启动，不会静默回退。"
            : "当前服务实例使用 Mock 端口，未配置真实模型。" },
    { key: "verified", label: "模型验证成功",
      tone: verifyMeta.tone, chip: verifyMeta.chip, detail: verifyMeta.detail },
  ];
  return <section className="settings-card" data-testid="service-state">    <h2>连接与模型状态</h2>
    <p className="helper-text">连接验证通过只表示固定短文本调用成功，不等于真实任务执行成功。</p>
    <dl className="settings-definition-list">
      {rows.map((row) => <div key={row.key} data-testid={`service-state-${row.key}`}>
        <dt>{row.label}</dt>
        <dd><span className={`status-chip status-chip--${row.tone}`}>{row.chip}</span> {row.detail}</dd>
      </div>)}
    </dl>
    {showGuide && last?.errorCategory != null && <p className="helper-text" data-testid="verify-error-guide">
      <Info aria-hidden="true" />{modelErrorGuides[last.errorCategory]}</p>}
    {onVerify !== null && <div className="settings-verify-actions">
      <button className="secondary-button" type="button" data-testid="verify-model-port"
        disabled={verifying} onClick={onVerify}>
        <ShieldCheck aria-hidden="true" />{verifying ? "验证中…" : "验证连接"}</button>
      <span className="helper-text">用固定短文本发起一次连接验证，不携带项目资料。</span>
    </div>}
  </section>;
}

/**
 * 图片输入能力的一句话说明（2026-10-19）。
 *
 * 关键是让「目录判定的」与「人声明的」可区分：同样是「支持」，来源不同意味着可信度
 * 不同——目录是公开事实，声明是人的主张。`UNKNOWN` 只说这次读不到，不冒充不支持。
 */
function imageInputText(status: RelayModelPortStatus): string {
  const bySource = status.imageInputSource === "DECLARED" ? "你的声明"
    : status.imageInputSource === "ENV" ? "服务端环境声明" : "模型目录";
  switch (status.imageInput) {
    case "SUPPORTED": return `支持（${bySource}）`;
    case "DECLARED": return `支持（${bySource}）`;
    case "MODEL_LACKS_IMAGE_INPUT": return `不支持（${bySource}）；带图片的消息会被拒绝。`;
    case "MODEL_NOT_IN_CATALOG":
      return "未确认：模型目录里没有这个模型，也没有人为它声明；带图片的消息会被拒绝。";
    case "NOT_CONFIGURED": return "不适用（未配置真实模型端口）。";
    default: return "暂不可核对（这次读不到模型目录）；发送时的裁决仍以服务端为准。";
  }
}

function ModelPortCard({ status, client, onSaved }: {
  readonly status: RelayModelPortStatus;
  readonly client: RelayApiClient | null;
  readonly onSaved: () => void;
}) {
  return <section className="settings-card" data-testid="model-port-status">
    <h2>模型端口</h2>
    <dl className="settings-definition-list">
      <div><dt>当前端口</dt><dd><strong>{providerLabels[status.provider]}</strong></dd></div>
      <div><dt>模型名称</dt><dd>{status.model ?? "未配置（Mock 端口不需要模型名）"}</dd></div>
      <div><dt>服务端点</dt><dd>{status.baseUrl
        ? <code className="hash-code">{status.baseUrl}</code>
        : status.provider === "openai-compatible" ? "未自定义（使用内置默认端点）" : "—"}</dd></div>
      <div><dt>图片输入</dt><dd data-testid="model-port-image-input">{imageInputText(status)}</dd></div>
      {/* 2026-10-20（P1-5）：把「这条配置影响谁」写在页面上。 */}
      <div><dt>生效范围</dt><dd data-testid="model-port-scope">本实例所有会话共用。</dd></div>
    </dl>
    {status.provider === "fake" && <p className="helper-text"><Info aria-hidden="true" />当前服务实例未配置真实模型：使用确定性 Mock 模型，不调用外部服务。</p>}
    {status.provider === "invalid" && <p className="action-error" role="alert">服务实例的模型配置残缺（例如缺少 API Key 或模型名）；真实模型调用不可用，也不会静默回退。请检查服务端启动配置后重启实例。</p>}
    {client !== null && status.provider === "openai-compatible" && status.model !== null &&
      <ImageInputDeclaration client={client} model={status.model} onSaved={onSaved} />}    <p className="helper-text">配置来自服务实例环境变量；本页不读取、不显示、也不修改任何密钥。</p>
  </section>;
}

/**
 * 图片输入能力声明（2026-10-19，迁移 0121）。
 *
 * 为什么需要人来说：模型目录只收录公开目录里的模型，自建 Provider 的模型不在其中，
 * 服务商也不报 modalities。于是「这个模型能不能读图」没有可核实的来源，只能由人声明。
 * 目录里有条目时以目录为准，这里的声明不生效——所以按钮旁的说明必须写清这一条。
 */
function ImageInputDeclaration({ client, model, onSaved }: {
  readonly client: RelayApiClient; readonly model: string; readonly onSaved: () => void;
}) {
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const write = async (imageInput: boolean | null) => {
    setSaving(true); setError(null); setSaved(null);
    try {
      if (imageInput === null) {
        await client.deleteModelCapability({ provider: "openai-compatible", model });
        setSaved("已撤销声明：该模型回到「未声明」。");
      } else {
        await client.putModelCapability({ provider: "openai-compatible", model, imageInput,
          note: note.trim() === "" ? null : note.trim() });
        setSaved(imageInput ? "已声明支持图片输入。" : "已声明不支持图片输入。");
      }
      onSaved();
    } catch (caught) { setError(describeLiveError(caught).message); }
    finally { setSaving(false); }
  };
  return <div className="settings-image-input" data-testid="model-image-input-declaration">
    <h3>图片输入能力声明</h3>
    <p className="helper-text">目录里没有这个模型时（自建 Provider 常见）以本声明为准；有目录条目时以目录为准。</p>
    <label className="field"><span className="field-label">声明依据（可选，最多 500 字）</span>
      <input value={note} maxLength={500} disabled={saving}
        onChange={(event) => { setNote(event.target.value); setSaved(null); }}
        placeholder="例如：官方文档写明原生支持图片输入" data-testid="model-image-input-note" /></label>
    <div className="settings-save-actions">
      <button className="secondary-button" type="button" disabled={saving}
        data-testid="model-image-input-support" onClick={() => void write(true)}>声明支持图片</button>
      <button className="secondary-button" type="button" disabled={saving}
        data-testid="model-image-input-deny" onClick={() => void write(false)}>声明不支持</button>
      <button className="text-button" type="button" disabled={saving}
        data-testid="model-image-input-revoke" onClick={() => void write(null)}>撤销声明</button>
    </div>
    {saved !== null && <p className="settings-save-result" role="status"
      data-testid="model-image-input-saved">{saved}</p>}
    {error !== null && <p className="action-error" role="alert"
      data-testid="model-image-input-error">声明未保存：{error}</p>}
  </div>;
}

function VerificationDetailCard({ verification, verifying }: {
  verification: RelayModelVerificationState | null; verifying: boolean;
}) {
  // 本目标最近一次（另一个型号的成功不算）。旧服务端没有 target_last 时，解析层已经把它
  // 归一到实例级 last，所以这里只认 targetLast，不再二次回退——否则「本目标没有验证行」
  // 会被另一个型号的成功顶替。
  const last = verification?.targetLast ?? null;
  const matches = verification?.matchesCurrentConfig === true;
  const credentialChanged = verification?.credentialIdentity === "CHANGED";
  const targetLabel = verification === null || verification === undefined ? null
    : verification.connection === "default" ? "应用默认连接"
      : `OpenRouter 免费型号 · ${verification.model ?? verification.target}`;
  const { timeZone } = useDisplayPreferences();
  return <section className="settings-card" data-testid="verification-detail">
    <h2>最近一次验证</h2>
    {targetLabel !== null && <p className="helper-text" data-testid="verification-target">
      验证目标：{targetLabel}。目标按确切型号区分：另一个型号验证通过，不代表这个型号可执行。</p>}
    {credentialChanged && <p className="helper-text" role="alert" data-testid="verification-credential">
      凭据已更换：最近一次验证用的是另一份 API Key，旧结论不再代表当前连接可执行。</p>}
    {last === null
      ? <p className="helper-text">尚无验证记录。配置后可点击「验证连接」发起一次固定短文本调用。</p>
      : <dl className="settings-definition-list">
        <div><dt>结果</dt><dd>
          <span className={`status-chip status-chip--${last.ok ? "success" : "danger"}`}>
            {last.ok ? "通过" : "失败"}</span>
          {" "}验证于 <time dateTime={last.verifiedAt}>{formatReadableDateTime(last.verifiedAt, timeZone)}</time>
          {last.latencyMs === null ? "" : ` · ${last.latencyMs} ms`}</dd></div>
        <div><dt>目标</dt><dd>{last.provider} / {last.model}</dd></div>
        <div><dt>配置指纹</dt><dd><code className="hash-code">{last.configFingerprint}</code>
          {matches
            ? "（与当前配置一致）"
            : "（与当前配置不一致：配置已变更，旧结果不再算已验证）"}</dd></div>
        {last.errorCategory !== null && <div><dt>错误分类</dt><dd>
          <span className="status-chip status-chip--danger" title={last.errorCategory}>
            {verifyErrorCategoryLabels[last.errorCategory] ?? last.errorCategory}</span>
          {" "}{modelErrorGuides[last.errorCategory]}</dd></div>}
      </dl>}
    {verifying && <p role="status">正在验证…</p>}
    <p className="helper-text">连接验证只用固定短文本，不读取项目资料，也不代表真实任务执行成功。</p>
  </section>;
}

/**
 * 高级诊断：端点、配置指纹、Worker 启动校验与图片能力声明。
 * 这些是排查连接问题的工程事实，不参与任务执行判定，默认折叠。
 */
function ModelAdvancedDiagnostics({ client, status, verification, verifying, onSaved }: {
  readonly client: RelayApiClient | null;
  readonly status: RelayModelPortStatus | null;
  readonly verification: RelayModelVerificationState | null;
  readonly verifying: boolean;
  readonly onSaved: () => void;
}) {
  const workerProbe = verification?.workerStartupValidation;
  return <details className="settings-advanced" data-testid="settings-model-advanced">
    <summary>高级诊断与能力声明</summary>
    <div className="settings-advanced-body">
      <p className="helper-text">以下内容用于排查连接问题，不代表任务可执行。</p>
      {status !== null && <ModelPortCard status={status} client={client} onSaved={onSaved} />}
      {status?.configured === true && <VerificationDetailCard verification={verification}
        verifying={verifying} />}
      <p className="helper-text" data-testid="worker-diagnostic">Worker 可执行性未探测：本页不探测 Worker 进程，也不确认它与 API 是否同源配置。
        {workerProbe === "OK"
          ? "（诊断：API 进程环境的配置启动校验通过，仅供核对，不代表 Worker 已执行。）"
          : workerProbe === "FAILED"
            ? "（诊断：API 进程环境的配置启动校验失败；若 Worker 使用同一环境，启动会被拒绝。）"
            : workerProbe === "NOT_CONFIGURED"
              ? "（诊断：API 进程环境未配置真实模型。）"
              : ""}
      </p>
    </div>
  </details>;
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

const writeTierLabels: Record<RelayWriteTier, string> = {
  READ_ONLY: "只读",
  ASK: "请求批准",
  AUTO: "自动批准",
  FULL: "完全访问"
};

/** 默认目录失效原因（HTTP §10.96 的 reason 词表）；未知码原样保留，不静默吞掉。 */
const defaultDirectoryReasonLabels: Record<string, string> = {
  RESOURCE_UNAVAILABLE: "这个目录的受管资源已不可见",
  RESOURCE_DISABLED: "这个目录的受管资源已停用",
  PROJECT_ARCHIVED: "这个目录所属的项目已归档",
  RESOURCE_OVERLAP: "这个目录与另一个活动受管根重叠",
  DIRECTORY_UNAVAILABLE: "这个目录当前无法访问",
  DIRECTORY_IDENTITY_CHANGED: "这个目录的实际路径身份已变化"
};

/** OpenWorkingDirectory 的未就绪原因；与目录细条同一口径，不在这里另造一套解释。 */
const openNotReadyLabels: Record<string, string> = {
  MULTIPLE_PROJECTS: "同一实际目录关联了多个项目",
  OVERLAPPING_OTHER_PROJECT: "这个目录落在另一个已受管根之内或包含它",
  PROJECT_ARCHIVED: "这个目录关联的项目已归档",
  RESOURCE_DISABLED: "这个目录的受管资源已停用"
};

function defaultDirectoryReasonText(reason: string | null): string {
  if (reason === null) return "原因未提供";
  const label = defaultDirectoryReasonLabels[reason];
  // 保留服务端原因码一起显示：翻译是给人读的，码是给核对用的，二者不互相替代。
  return label === undefined ? reason : `${label}（${reason}）`;
}

type DefaultDirectoryCommand = { readonly commandId: string; readonly action: "SET" | "CLEAR";
  readonly resourceId: string | null; readonly expectedRevision: string };

/**
 * 工作区默认目录的唯一读取 Owner。
 *
 * 基本设置行与权限页签消费同一份投影：读取一次、写入后重读一次，避免同一页对同一事实
 * 维护两份互相漂移的状态。换 API / Workspace 立即清空，迟到的旧响应不落进新范围。
 */
function useWorkspaceDefaultDirectoryProjection(client: RelayApiClient | null) {
  const [projection, setProjection] = useState<RelayWorkspaceDefaultDirectory | null>(null);
  const [loading, setLoading] = useState(client !== null);
  const [readError, setReadError] = useState<string | null>(null);
  const requestVersion = useRef(0);

  const read = useCallback(async () => {
    const request = ++requestVersion.current;
    if (client === null) {
      setLoading(false); setProjection(null); setReadError(null);
      return;
    }
    setLoading(true); setReadError(null);
    try {
      const next = await client.getWorkspaceDefaultDirectory();
      if (request !== requestVersion.current) return;
      setProjection(next); setLoading(false);
    } catch (caught) {
      if (request !== requestVersion.current) return;
      setProjection(null); setReadError(describeLiveError(caught).message); setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    requestVersion.current += 1;
    setProjection(null); setReadError(null); setLoading(client !== null);
    void read();
    return () => { requestVersion.current += 1; };
  }, [read, client]);

  return { projection, loading, readError, read };
}

/**
 * 设置 › 通用设置 › 默认工作目录（工作台 §18.1.5 / HTTP §10.96）。
 *
 * 这一行只做三件事：读服务端投影、走 `OpenWorkingDirectory` 选一个已登记目录、
 * 用最近一次读取的修订设置或清除。它**不提供写档位选项**——配置默认目录不等于授予
 * 写能力，档位仍在该目录的输入器里按 §18.1.3 调整。
 *
 * 零写入边界：挂载、刷新、切回本页只发 GET。真正的写只有「选目录后 READY 才设置」
 * 与「清除」两条幂等命令，且都保留原 command_id；传输失败停在「结果未知」等核对，
 * 不换 ID 重发、不把命令成功当成事实已刷新。
 */
function DefaultWorkingDirectoryRow({ client, projection, loading, readError, read }: {
  readonly client: RelayApiClient | null;
  readonly projection: RelayWorkspaceDefaultDirectory | null;
  readonly loading: boolean;
  readonly readError: string | null;
  readonly read: () => Promise<void>;
}) {
  const [busy, setBusy] = useState<null | "OPEN" | "SET" | "CLEAR">(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState<DefaultDirectoryCommand | null>(null);
  const [checking, setChecking] = useState(false);
  const [manualPath, setManualPath] = useState("");
  const [pickerError, setPickerError] = useState<string | null>(null);
  const manualInputRef = useRef<HTMLInputElement>(null);
  const pendingRef = useRef<DefaultDirectoryCommand | null>(null);
  pendingRef.current = pending;
  const pickerAvailable = nativeFolderPickerAvailable();

  /** 换 API / Workspace 立即清空旧范围的在途命令与结果，旧目录名与回执身份不落进新范围。 */
  useEffect(() => {
    setNotice(null); setProblem(null); setPending(null); setChecking(false); setBusy(null);
    setManualPath(""); setPickerError(null);
  }, [client]);

  async function save(resourceId: string | null) {
    if (client === null) return;
    const current = projection;
    if (current === null) {
      setProblem("默认工作目录尚未读取成功，先重新检查再设置。");
      setBusy(null);
      return;
    }
    const command: DefaultDirectoryCommand = { commandId: createCommandId(),
      action: resourceId === null ? "CLEAR" : "SET", resourceId, expectedRevision: current.revision };
    pendingRef.current = command; setPending(command);
    setBusy(resourceId === null ? "CLEAR" : "SET"); setProblem(null); setNotice(null);
    try {
      if (resourceId === null) {
        await client.clearWorkspaceDefaultDirectory({ commandId: command.commandId,
          expectedRevision: command.expectedRevision });
      } else {
        await client.setWorkspaceDefaultDirectory({ commandId: command.commandId,
          expectedRevision: command.expectedRevision, resourceId });
      }
      if (pendingRef.current?.commandId !== command.commandId) return;
      pendingRef.current = null; setPending(null); setBusy(null);
      const label = projection?.displayName ?? "所选目录";
      // 命令成功不等于事实已刷新：以重读到的投影为准，不用回执结果拼接第二份事实。
      await read();
      setNotice(resourceId === null
        ? "已清除默认工作目录；已存在的会话与既有目录绑定保持不变。"
        : `已把「${label}」设为默认工作目录。只引用这个已登记目录，不扩大任何权限。`);
    } catch (caught) {
      if (pendingRef.current?.commandId !== command.commandId) return;
      setBusy(null);
      const described = describeLiveError(caught);
      if (described.kind === "transport") {
        // 结果未知：保留原命令与原载荷，等按原 command_id 核对；不用说成成功或失败。
        setProblem("保存结果未知：原命令与原载荷已保留。请按原 command_id 查询回执，不要换 ID 重发。");
        return;
      }
      pendingRef.current = null; setPending(null);
      if (caught instanceof RelayApiError && caught.problem.status === 409) {
        // 冲突不自动覆盖：重读当前事实，由用户在新事实上重新决定。
        await read();
        const actual = caught.problem.actualRevision;
        setProblem(`设置已被其他操作更新（409${actual === null ? "" : `，当前修订 ${actual}`}）；`
          + "已重新读取当前默认目录，本次没有覆盖新设置。请确认后重新选择。");
        return;
      }
      setProblem(describeLiveError(caught).message);
    }
  }

  async function choose(rootPath: string) {
    if (client === null || busy !== null || pending !== null) return;
    setBusy("OPEN"); setProblem(null); setNotice(null); setPickerError(null);
    let directory: RelayWorkingDirectory;
    try {
      directory = await client.openWorkingDirectory({ commandId: createCommandId(), rootPath });
    } catch (caught) {
      setBusy(null);
      setProblem(describeLiveError(caught).message);
      return;
    }
    setBusy(null);
    // 只有 READY 且确有受管关联才能设置；未就绪不写默认值、不另建项目、不换一个根兜底。
    if (directory.status !== "READY" || directory.association === null) {
      const code = directory.reason;
      const label = code === null ? null : openNotReadyLabels[code];
      const reasonText = code === null ? "服务端未给出原因"
        : label === undefined ? code : `${label}（${code}）`;
      setProblem(`默认工作目录没有更改：这个目录尚未就绪（${reasonText}）。原设置保持不变，也不会为它新建第二个项目或写 Owner。`);
      return;
    }
    await save(directory.association.resourceId);
  }

  async function pick() {
    setPickerError(null);
    try {
      const picked = await selectWorkingDirectory();
      // 取消选择：保留原设置，不发任何写命令。
      if (picked !== null) await choose(picked);
    } catch (caught) { setPickerError(describeLiveError(caught).message); }
  }

  /** 只按原 command_id 查询：核对命令类型、Workspace、目标资源与修订，任一处不符都不算确认。 */
  async function checkReceipt() {
    const record = pendingRef.current;
    if (client === null || record === null || checking) return;
    setChecking(true); setProblem(null);
    try {
      const receipt = await client.getCommandReceipt(record.commandId);
      const expectedType = record.action === "CLEAR"
        ? "ClearWorkspaceDefaultDirectory" : "SetWorkspaceDefaultDirectory";
      const result = receipt.result;
      const resultResource = result.resource_id === null || result.resource_id === undefined
        ? null : result.resource_id;
      if (receipt.commandId !== record.commandId || receipt.commandType !== expectedType ||
          result.workspace_id !== client.workspaceId || resultResource !== record.resourceId ||
          typeof result.revision !== "string" || !/^\d+$/u.test(result.revision)) {
        throw new Error("回执与原命令不匹配。");
      }
      if (pendingRef.current?.commandId !== record.commandId) return;
      pendingRef.current = null; setPending(null);
      await read();
      setNotice("原命令已确认：默认工作目录已更新。");
    } catch (caught) {
      if (pendingRef.current?.commandId !== record.commandId) return;
      setProblem(`${describeLiveError(caught).message} 原命令仍未确认，不能换 ID 重发。`);
    } finally { setChecking(false); }
  }

  const status = projection?.status ?? null;
  const disabled = client === null || loading || busy !== null || pending !== null;
  const name = projection?.displayName ?? projection?.canonicalRoot ?? null;

  return <section className="settings-card settings-default-directory" data-testid="settings-default-directory">
    <h2>默认工作目录</h2>
    <p className="helper-text">新会话沿用的目录；只引用已登记目录，不授予写权限。</p>
    <div className="settings-directory-body" role="group" aria-label="默认工作目录">
      <div className="settings-default-directory-value" data-testid="settings-default-directory-value"
        data-status={status ?? "LOADING"}>
        {client === null
          ? <span className="status-chip status-chip--neutral">未连接</span>
          : loading && projection === null
            ? <span className="status-chip status-chip--neutral">读取中</span>
            : readError !== null
              ? <><span className="status-chip status-chip--danger">读取失败</span>{" "}
                <strong>无法读取默认目录</strong></>
              : status === "READY"
                ? <><span className="status-chip status-chip--success">有效</span>{" "}
                  <strong>{name ?? "未命名目录"}</strong></>
                : status === "UNAVAILABLE"
                  ? <><span className="status-chip status-chip--danger">不可用</span>{" "}
                    <strong>默认目录不可用</strong></>
                  : <><span className="status-chip status-chip--neutral">未设置</span>{" "}
                    <strong>没有默认目录</strong></>}
      </div>

      {client === null
        ? <p className="helper-text">连接本机 API 后可读取和修改默认工作目录。</p>
        : loading && projection === null
          ? <p className="helper-text" role="status">正在读取默认目录…</p>
          : readError !== null
            ? <p className="action-error" role="alert" data-testid="settings-default-directory-problem">
              读取失败：{readError}。原设置没有被清除，重新检查后再操作。</p>
            : status === "READY"
              ? <>
                <p className="helper-text">新会话会沿用这个目录；已存在的会话保持原有绑定。</p>
                <p className="settings-directory-path" data-testid="settings-default-directory-path">
                  {projection?.canonicalRoot}</p>
              </>
              : status === "UNAVAILABLE"
                ? <p className="settings-directory-unavailable" data-testid="settings-default-directory-unavailable">
                  已保存的文件夹不存在或暂时无法访问。新会话不会继续使用该目录；已存在的会话保持原有绑定。</p>
                : <p className="helper-text">未主动选过目录的新会话仍可普通讨论；读取文件前需要选择目录。</p>}

      {projection?.writeTier != null && status === "READY" &&
        <p className="helper-text" data-testid="settings-default-directory-tier">
          当前目录写入档位：{writeTierLabels[projection.writeTier]}。它属于这个目录，设置默认目录只确定作用域，
          不授予写权限；档位在对话页的目录行里调整。
        </p>}

      {notice !== null && <p className="settings-save-result" role="status"
        data-testid="settings-default-directory-notice">{notice}</p>}
      {problem !== null && <p className="action-error" role="alert"
        data-testid="settings-default-directory-problem">{problem}</p>}
      {pending !== null && <div className="settings-default-directory-pending"
        data-testid="settings-default-directory-pending">
        <p className="helper-text">原命令 {pending.commandId} 结果待核对（
          {pending.resourceId === null ? "清除默认目录" : "设置默认目录"}，基准修订 {pending.expectedRevision}）。</p>
        <button className="secondary-button secondary-button--compact" type="button"
          data-testid="settings-default-directory-receipt" disabled={checking}
          onClick={() => void checkReceipt()}>
          {checking ? "正在查询" : "查询原命令回执"}</button>
      </div>}
      {pickerError !== null && <p className="action-error" role="alert">{pickerError}</p>}
      <div className="settings-default-directory-actions">
        <button className={status === "READY" ? "secondary-button" : "primary-button"} type="button"
          data-testid="settings-default-directory-choose"
          disabled={disabled}
          onClick={() => { if (pickerAvailable) void pick(); else manualInputRef.current?.focus(); }}
          title={pickerAvailable ? "选择本机文件夹；只有已登记且就绪的目录才能设为默认"
            : "这个宿主没有原生目录选择器；点击后在下方填写本机已有绝对路径"}>
          <FolderOpen aria-hidden="true" />{status === null || status === "UNSET" ? "选择目录" : "更换目录"}</button>
        {status !== null && status !== "UNSET" && <button className="secondary-button" type="button"
          data-testid="settings-default-directory-clear" disabled={disabled} onClick={() => void save(null)}>
          <X aria-hidden="true" />{busy === "CLEAR" ? "正在清除…" : "清除默认目录"}</button>}
        {(readError !== null || status === "UNAVAILABLE" || status === "READY") &&
          <button className="secondary-button secondary-button--compact" type="button"
            data-testid="settings-default-directory-recheck" disabled={loading} onClick={() => void read()}>
            <RotateCcw aria-hidden="true" />重新检查</button>}
        {busy === "OPEN" && <span className="helper-text" role="status">正在打开并核对这个目录…</span>}
        {busy === "SET" && <span className="helper-text" role="status">正在保存默认目录…</span>}
      </div>
      {!pickerAvailable && <div className="settings-default-directory-manual">
        <label className="field-label" htmlFor="settings-default-directory-manual">本机已有绝对目录</label>
        <input id="settings-default-directory-manual" data-testid="settings-default-directory-manual"
          ref={manualInputRef} value={manualPath} disabled={disabled} placeholder={"D:\\Develop\\MyProject"}
          onChange={(event) => setManualPath(event.target.value)} />
        <button className="secondary-button secondary-button--compact" type="button"
          data-testid="settings-default-directory-manual-submit"
          disabled={disabled || manualPath.trim() === ""} onClick={() => void choose(manualPath.trim())}>
          使用这个目录</button>
      </div>}
      {client !== null && (projection !== null || readError !== null) &&
        <details className="settings-diagnostics" data-testid="settings-default-directory-diagnostics">
          <summary>诊断详情</summary>
          <dl className="settings-diagnostic-list">
            <div><dt>状态</dt><dd>{status ?? "未读取"}</dd></div>
            <div><dt>完整路径</dt><dd>{projection?.canonicalRoot === null || projection?.canonicalRoot === undefined
              ? "—" : <code className="hash-code">{projection.canonicalRoot}</code>}</dd></div>
            <div><dt>原因</dt><dd>{projection?.reason === null || projection?.reason === undefined
              ? "—" : defaultDirectoryReasonText(projection.reason)}</dd></div>
            <div><dt>修订</dt><dd>{projection?.revision ?? "—"}</dd></div>
            <div><dt>资源 ID</dt><dd>{projection?.resourceId ?? "—"}</dd></div>
          </dl>
          {readError !== null && <p className="helper-text">读取错误：{readError}</p>}
        </details>}
      <p className="helper-text">
        默认目录不提供自动批准或完全访问，也不扩大 Git、CLI、浏览器或电脑权限。
      </p>
    </div>
  </section>;
}

/**
 * 通用设置：只放本设备展示偏好与工作区默认目录。
 *
 * 时区与外观只写本机存储；默认目录是服务端 Workspace 配置，独立提交，
 * 不参与这张表单的保存——本机偏好不能冒充服务端事实。
 */
function GeneralPreferencesCard() {
  const preferences = useDisplayPreferences();
  const [timeZone, setTimeZone] = useState(preferences.timeZone);
  const [motion, setMotion] = useState<MotionPreference>(storedMotionPreference() ?? "system");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changed = () => { setSaved(false); setError(null); };

  // 导航栏位置即时生效、独立保存，不随「保存显示偏好」表单提交——
  // 切换是纯外壳布局，没有可「先草稿再确认」的事实要核对。
  const placement = useNavigationPlacement();
  const [placementError, setPlacementError] = useState<string | null>(null);
  const changePlacement = (value: NavigationPlacement) => {
    if (value === placement) return;
    try {
      saveNavigationPlacement(value);
      setPlacementError(null);
    } catch {
      // 写失败时存储不变，useSyncExternalStore 读回的仍是旧值，单选框自动回弹。
      setPlacementError("导航栏位置未保存：本设备存储不可写，请检查浏览器或应用的存储权限后重试。");
    }
  };

  return <section className="settings-card settings-basic" data-testid="settings-general-preferences">
    <h2>显示与界面</h2>
    <p className="helper-text">仅保存在本设备，不改变服务端事实或任务状态。</p>
    <form className="settings-form" onSubmit={(event) => {
      event.preventDefault(); setError(null); setSaved(false);
      try {
        // 尚未选择默认工作台时保留 null：保存时区不应顺手把「项目初始视图」覆盖成 general。
        saveDisplayPreferences({ timeZone, defaultWorkbench: preferences.defaultWorkbench });
        // 动效偏好同样是本设备事实：存储失败只影响下次启动，不阻断显示偏好保存。
        storeMotionPreference(motion);
        applyMotionPreference(motion);
        setSaved(true);
      } catch {
        setError("设置未保存：本设备存储不可写，请检查浏览器或应用的存储权限后重试。");
      }
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
        <span className="field-label" id="settings-appearance-label">界面外观</span>
        <div id="settings-appearance" className="settings-readonly-value" role="group"
          aria-labelledby="settings-appearance-label" data-testid="settings-appearance">
          <span className="status-chip status-chip--neutral">浅色</span>
          <span className="helper-text">当前仅支持浅色主题；深色与 Aurora Glass 仍在开发中。</span>
        </div>
      </div>
      {/* UI-NAV-01：导航栏位置是纯外壳布局偏好，即时生效并独立保存，不随「保存显示偏好」表单提交；
          原生 radio 同名分组天然支持方向键切换，焦点环走 .segmented-option:focus-within。 */}
      <div className="settings-field">
        <span className="field-label" id="settings-navigation-placement-label">导航栏位置</span>
        <div className="segmented settings-navigation-placement" role="radiogroup" aria-labelledby="settings-navigation-placement-label"
          data-testid="settings-navigation-placement">
          <label className={`segmented-option${placement === "sidebar" ? " segmented-option--selected" : ""}`}>
            <input className="visually-hidden" type="radio" name="settings-navigation-placement"
              value="sidebar" checked={placement === "sidebar"} onChange={() => changePlacement("sidebar")} />
            左侧导航</label>
          <label className={`segmented-option${placement === "titlebar" ? " segmented-option--selected" : ""}`}>
            <input className="visually-hidden" type="radio" name="settings-navigation-placement"
              value="titlebar" checked={placement === "titlebar"} onChange={() => changePlacement("titlebar")} />
            标题栏导航</label>
        </div>
        <p className="helper-text">切换立即生效并保存在本设备；标题栏模式把全局导航移到窗口标题栏，为内容区腾出左侧空间。</p>
        {placementError && <p role="alert" className="action-error" data-testid="settings-navigation-placement-error">{placementError}</p>}
      </div>
      <div className="settings-field">
        <label htmlFor="settings-motion">动效</label>
        <select id="settings-motion" data-testid="settings-motion" value={motion}
          aria-describedby="settings-motion-help"
          onChange={(event) => { setMotion(event.target.value as MotionPreference); changed(); }}>
          <option value="system">跟随系统</option>
          <option value="on">开启</option>
          <option value="off">关闭</option>
        </select>
        <p id="settings-motion-help" className="helper-text">只影响装饰动画，不隐藏状态文字、进度或操作入口。</p>
      </div>
      <div className="settings-save-actions">
        <button type="submit" className="primary-button" data-testid="settings-save">保存显示偏好</button>
        {saved && <p role="status" className="settings-save-result" data-testid="settings-save-result">
          显示偏好已保存，仅在本设备生效。</p>}
        {error && <p role="alert" className="action-error">{error}</p>}
      </div>
    </form>
  </section>;
}

/**
 * 工作台默认视图（本设备偏好）。项目自己保存的视图优先，这里的值只用于
 * 项目尚未保存视图时的工作台入口。
 */
function WorkbenchPreferencesCard() {
  const preferences = useDisplayPreferences();
  const [defaultWorkbench, setDefaultWorkbench] = useState<RelayViewKind>(preferences.defaultWorkbench ?? "general");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return <section className="settings-card" data-testid="settings-workbench-preferences">
    <h2>默认工作台</h2>
    <p className="helper-text">打开项目工作台时使用；项目已保存的默认视图优先，可随时在工作台内切换。</p>
    <form className="settings-form" onSubmit={(event) => {
      event.preventDefault(); setSaved(false); setError(null);
      try {
        saveDisplayPreferences({ timeZone: preferences.timeZone, defaultWorkbench });
        setSaved(true);
      } catch {
        setError("默认工作台未保存：本设备存储不可写，请检查浏览器或应用的存储权限后重试。");
      }
    }}>
      <div className="settings-field">
        <label htmlFor="settings-default-workbench">默认视图</label>
        <select id="settings-default-workbench" data-testid="settings-default-workbench" value={defaultWorkbench}
          onChange={(event) => { setDefaultWorkbench(event.target.value as RelayViewKind); setSaved(false); setError(null); }}>
          <option value="general">通用</option><option value="thesis">论文</option><option value="development">开发</option>
        </select>
        <p className="helper-text">这是本设备偏好，不修改项目的模板配置，也不改变活动任务的执行契约。</p>
      </div>
      <div className="settings-save-actions">
        <button type="submit" className="primary-button" data-testid="settings-default-workbench-save">
          保存默认工作台</button>
        {saved && <p role="status" className="settings-save-result" data-testid="settings-default-workbench-result">
          默认工作台已保存。</p>}
        {error && <p role="alert" className="action-error">{error}</p>}
      </div>
    </form>
  </section>;
}

/**
 * 权限与执行：只读展示能核实的执行权限状态，并提供真实管理入口。
 *
 * 写入档位属于具体目录；新建目录的默认档位属于工作区。两者都不是全局开关，
 * 因此本页不提供模拟的「全局执行策略」控件。
 */
function ExecutionPermissionsCard({ client, projection, loading, readError }: {
  readonly client: RelayApiClient | null;
  readonly projection: RelayWorkspaceDefaultDirectory | null;
  readonly loading: boolean;
  readonly readError: string | null;
}) {
  const status = projection?.status ?? null;
  const currentTier = projection?.writeTier ?? null;
  const defaultTier = projection?.defaultWriteTier ?? null;
  return <section className="settings-card" data-testid="execution-permissions">
    <h2>当前执行权限</h2>
    <p className="helper-text">以下状态来自服务端投影；本页不改 Project、Directory、Run 或审批策略。</p>
    <dl className="settings-definition-list">
      <div>
        <dt>默认目录写入档位</dt>
        <dd data-testid="execution-current-write-tier">
          {client === null
            ? <><span className="status-chip status-chip--neutral">未连接</span>{" "}连接本机 API 后可读取。</>
            : loading && projection === null
              ? <><span className="status-chip status-chip--neutral">读取中</span></>
              : readError !== null
                ? <><span className="status-chip status-chip--danger">读取失败</span>{" " }{readError}</>
                : status === "READY" && currentTier !== null
                  ? <><span className={`status-chip status-chip--${currentTier === "READ_ONLY" ? "neutral" : "warning"}`}>
                    {writeTierLabels[currentTier]}</span>{" "}绑定这个目录的所有会话共用；档位在对话页的目录行调整。</>
                  : status === "UNAVAILABLE"
                    ? <><span className="status-chip status-chip--danger">不可读取</span>{" "}默认目录不可用，无法读取该目录的写入档位。</>
                    : <><span className="status-chip status-chip--neutral">暂无目录</span>{" "}选择默认目录后才能读取它的写入档位。</>}
        </dd>
      </div>
      <div>
        <dt>新目录默认档位</dt>
        <dd data-testid="execution-default-write-tier">
          {defaultTier === null
            ? <><span className="status-chip status-chip--neutral">未设置</span>{" "}新打开的目录按「只读」起步。</>
            : <><span className={`status-chip status-chip--${defaultTier === "READ_ONLY" ? "neutral" : "warning"}`}>
              {writeTierLabels[defaultTier]}</span>{" "}只作用于以后新打开的目录，不改已有目录。</>}
        </dd>
      </div>
      <div>
        <dt>连接、插件与策略</dt>
        <dd>按项目查看真实连接、受管目录与逐动作策略。<Link className="inline-link" to="/connections">
          打开连接与权限</Link></dd>
      </div>
    </dl>
    <p className="helper-text" data-testid="settings-pending-preferences"
      title="完整通知规则见《工作台交互设计》11.5：仅提醒必须由用户介入的事项；Relay 运行期间应用内保留待处理标记，窗口外另发 Windows 通知；同一事项只提醒一次；短时间多个事项合并为一条通知。">
      界面语言与通知偏好暂不可修改：语言偏好的读写接口尚未提供；通知规则已确认——
      仅提醒必须由用户介入的事项，同一事项只提醒一次。
    </p>
    <p className="helper-text">推进与审批由服务端负责；本页不保存执行策略开关，也不改变任何 Run 的执行权。</p>
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
  /** 聊天/Run 默认连接写入后递增：当前使用情况卡按服务端事实重读，不拼回执。 */
  const [defaultsRevision, setDefaultsRevision] = useState(0);
  const requestVersion = useRef(0);
  const [group, setGroup] = useState<SettingsGroup>("basic");
  // 页签首次访问才挂载内容：未访问过的页签不发起读取；访问过之后保持挂载，草稿不因切换丢失。
  const [visited, setVisited] = useState<Record<SettingsGroup, boolean>>({
    basic: true, model: false, execution: false, workbench: false });
  const directory = useWorkspaceDefaultDirectoryProjection(client);

  const selectGroup = (value: SettingsGroup) => {
    setGroup(value);
    setVisited((current) => current[value] ? current : { ...current, [value]: true });
  };

  const refresh = useCallback(() => {
    const request = ++requestVersion.current;
    if (client === null) {
      setLoading(false); setError(null); setStatus(null); setVerification(null);
      return;
    }
    setLoading(true); setError(null); setStatus(null); setVerification(null);
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
    // 验证是否与当前配置匹配只能由服务端回答：本地拼一个 matchesCurrentConfig 会在配置指纹
    // 读不到时凭空变成「通过」，等于在组件里维护第二套已确认事实。命令成功不等于事实已刷新，
    // 因此这里重读一次权威状态，而不是就地改写上一次的读取结果。
    void client.verifyModelPort()
      .then(() => client.getModelPortVerification())
      .then((nextVerification) => {
        setVerifying(false);
        setVerification(nextVerification);
      }).catch((caught: unknown) => {
      setVerifying(false);
      setVerifyError(describeLiveError(caught).message);
    });
  };

  const groups: readonly (readonly [SettingsGroup, string])[] = [
    ["basic", "通用设置"], ["model", "AI 与模型"], ["execution", "权限与执行"], ["workbench", "工作台"]];

  return <section className="settings-page" data-testid="settings-page">    <PageHeader testId="settings-page-head" title="设置"
      lede="显示偏好只保存在本机；模型、执行权限与工作目录各自独立保存，改哪一项只影响那一块。" />
    <div className="settings-layout">
      <nav className="settings-navigation" role="tablist" aria-label="设置分组" onKeyDown={handleTabListKeyDown}>
        {groups.map(([value, label]) => <button key={value} type="button" data-testid={`settings-group-${value}`}
          role="tab" id={`settings-tab-${value}`} aria-controls={`settings-panel-${value}`}
          aria-selected={group === value} tabIndex={group === value ? 0 : -1}
          onClick={() => selectGroup(value)}>{label}</button>)}
      </nav>
      <div className="settings-content">
        <div role="tabpanel" id="settings-panel-basic" aria-labelledby="settings-tab-basic" hidden={group !== "basic"}>
          <GeneralPreferencesCard />
          <DefaultWorkingDirectoryRow client={client} projection={directory.projection}
            loading={directory.loading} readError={directory.readError} read={directory.read} />
        </div>

        <div role="tabpanel" id="settings-panel-model" aria-labelledby="settings-tab-model" hidden={group !== "model"}>
          {visited.model && (client === null ? <div className="warning-callout" role="status">
            当前是示例数据预览，没有真实服务实例状态。<Link to="/projects">打开项目</Link>，
            或通过顶栏「数据来源」连接本机 API。
          </div> : <>            <p className="settings-scope-note" data-testid="settings-ai-scope">
              以下设置按工作空间生效，只影响之后的新消息与新 Run；已排队、生成中或已冻结的执行保持原连接。
            </p>
            {loading && status === null && <p role="status">正在读取服务实例配置状态…</p>}
            {error && <div className="action-error" role="alert">
              <p>读取失败：{error}</p>
              <button className="secondary-button" type="button" data-testid="model-port-retry"
                onClick={refresh}>
                <RotateCcw aria-hidden="true" />重新读取</button>
            </div>}
            {verifyError && <div className="action-error" role="alert" data-testid="verify-error">
              <p>验证未完成：{verifyError}</p></div>}
            <CurrentModelUsageCard client={client} status={status}
              refreshToken={defaultsRevision} />
            <ServiceStateCard loading={loading} error={error} status={status}
              verification={verification} verifying={verifying} onVerify={onVerify} />
            <ModelConnectionsCard client={client}
              onDefaultsChanged={() => { setDefaultsRevision((current) => current + 1); }} />
            <ContextBudgetCard client={client} />
            <MemorySettingsCard client={client} />
            <ModelAdvancedDiagnostics client={client} status={status} verification={verification}
              verifying={verifying} onSaved={refresh} />
          </>)}
        </div>

        <div role="tabpanel" id="settings-panel-execution" aria-labelledby="settings-tab-execution"
          hidden={group !== "execution"}>
          {visited.execution && <ExecutionPermissionsCard client={client} projection={directory.projection}
            loading={directory.loading} readError={directory.readError} />}
        </div>

        <div role="tabpanel" id="settings-panel-workbench" aria-labelledby="settings-tab-workbench"
          hidden={group !== "workbench"}>
          {visited.workbench && <>
            <WorkbenchPreferencesCard />
            <div id="settings-packs"><PackCatalogPanel /></div>
          </>}
        </div>
      </div>
    </div>
  </section>;
}
