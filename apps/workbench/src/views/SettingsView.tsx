import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { FolderOpen, Info, RotateCcw, ShieldCheck, X } from "lucide-react";
import { createCommandId, RelayApiError, type RelayApiClient, type RelayModelPortStatus,
  type RelayModelVerificationState, type RelayModelVerifyErrorCategory, type RelayViewKind,
  type RelayWorkingDirectory, type RelayWriteTier, type RelayWorkspaceDefaultDirectory } from "../api/relayClient";
import PackCatalogPanel from "../components/PackCatalogPanel";
import MemorySettingsCard from "../components/MemorySettingsCard";
import PageHeader from "../components/PageHeader";
import { describeLiveError } from "../lib/liveErrors";
import { modelErrorGuides } from "../lib/modelErrorGuides";
import { useRelayConnection } from "../lib/relayConnection";
import { formatReadableDateTime, saveDisplayPreferences, useDisplayPreferences } from "../lib/displayPreferences";
import { handleTabListKeyDown } from "../lib/tabNavigation";
import { nativeFolderPickerAvailable, selectWorkingDirectory } from "../lib/desktopHost";
import "./SettingsView.css";

/** 验证错误分类的中文短名；原枚举保留在 chip 的 title 供核对。 */
const verifyErrorCategoryLabels: Record<RelayModelVerifyErrorCategory, string> = {
  AUTH: "认证失败",
  RATE_LIMIT: "限流",
  TIMEOUT: "超时",
  STREAM_BROKEN: "流中断",
  PROTOCOL: "协议或模型无效",
  NETWORK: "网络不可达"
};

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
          : "" },
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
    {/* 2026-10-24 用户指令：导语不再复述下方四行标签，只留连接验证的边界说明。 */}
    <p className="helper-text">「连接验证通过」只表示固定短文本调用成功，不等于真实任务执行成功。</p>
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
  return <section className="surface-panel settings-card" data-testid="model-port-status">
    <h2>模型端口</h2>
    <dl className="settings-definition-list">
      <div><dt>当前端口</dt><dd><strong>{providerLabels[status.provider]}</strong></dd></div>
      <div><dt>模型名称</dt><dd>{status.model ?? "未配置（Mock 端口不需要模型名）"}</dd></div>
      <div><dt>服务端点</dt><dd>{status.baseUrl
        ? <code className="hash-code">{status.baseUrl}</code>
        : status.provider === "openai-compatible" ? "未自定义（使用内置默认端点）" : "—"}</dd></div>
      <div><dt>图片输入</dt><dd data-testid="model-port-image-input">{imageInputText(status)}</dd></div>
      {/* 2026-10-20（P1-5）：把「这条配置影响谁」写在页面上。此前用户要自己推断
          端点是进程级的、声明是按模型的、会话选择是另一层。 */}
      <div><dt>生效范围</dt><dd data-testid="model-port-scope">本实例的所有会话共用；图片能力声明跟随
        provider 与模型名，换模型后要为新的模型名单独声明。</dd></div>
    </dl>
    {status.provider === "fake" && <p className="helper-text"><Info aria-hidden="true" />当前服务实例未配置真实模型：任务委托与 Assist 使用确定性 Mock 模型，不调用外部服务。这是当前阶段的既定门槛，不是故障。</p>}
    {status.provider === "invalid" && <p className="action-error" role="alert">服务实例的模型配置残缺（例如缺少 API Key 或模型名）；真实模型调用不可用，也不会静默回退。请检查服务端启动配置后重启实例。</p>}
    {client !== null && status.provider === "openai-compatible" && status.model !== null &&
      <ImageInputDeclaration client={client} model={status.model} onSaved={onSaved} />}
    <p className="helper-text">配置来自服务实例的环境变量；API 密钥只保存在服务端配置中，本页面不读取、不显示、也不修改任何密钥。</p>
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
    <p className="helper-text">模型目录里没有这个模型时（自建 Provider 常见），只有这条声明能让带图消息通过；
      目录里有条目时以目录为准，声明不生效。声明立即生效，不需要重启服务。</p>
    <label className="field"><span className="field-label">声明依据（可选，最多 500 字）</span>
      <input value={note} maxLength={500} disabled={saving}
        onChange={(event) => { setNote(event.target.value); setSaved(null); }}
        placeholder="例如：官方文档写明原生支持图片输入" data-testid="model-image-input-note" /></label>
    <div className="settings-save-actions">
      <button className="secondary-button" type="button" disabled={saving}
        data-testid="model-image-input-support" onClick={() => void write(true)}>声明支持图片</button>
      <button className="secondary-button" type="button" disabled={saving}
        data-testid="model-image-input-deny" onClick={() => void write(false)}>声明不支持</button>
      <button className="text-link" type="button" disabled={saving}
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
  const last = verification?.last ?? null;
  const matches = verification?.matchesCurrentConfig === true;
  const { timeZone } = useDisplayPreferences();
  return <section className="surface-panel settings-card" data-testid="verification-detail">
    <h2>最近一次验证</h2>
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
 * 设置 › 基本设置 › 默认工作目录（工作台 §18.1.5 / HTTP §10.96）。
 *
 * 这一行只做三件事：读服务端投影、走 `OpenWorkingDirectory` 选一个已登记目录、
 * 用最近一次读取的修订设置或清除。它**不提供写档位选项**——配置默认目录不等于授予
 * 写能力，档位仍在该目录的输入器里按 §18.1.3 调整。
 *
 * 零写入边界：挂载、刷新、切回本页只发 GET。真正的写只有「选目录后 READY 才设置」
 * 与「清除」两条幂等命令，且都保留原 command_id；传输失败停在「结果未知」等核对，
 * 不换 ID 重发、不把命令成功当成事实已刷新。
 */
function DefaultWorkingDirectoryRow({ client }: { client: RelayApiClient | null }) {
  const [projection, setProjection] = useState<RelayWorkspaceDefaultDirectory | null>(null);
  const [loading, setLoading] = useState(client !== null);
  const [readError, setReadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "OPEN" | "SET" | "CLEAR">(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState<DefaultDirectoryCommand | null>(null);
  const [checking, setChecking] = useState(false);
  const [manualPath, setManualPath] = useState("");
  const [pickerError, setPickerError] = useState<string | null>(null);
  const version = useRef(0);
  const pendingRef = useRef<DefaultDirectoryCommand | null>(null);
  pendingRef.current = pending;
  const pickerAvailable = nativeFolderPickerAvailable();

  const read = useCallback(async () => {
    const request = ++version.current;
    if (client === null) {
      setLoading(false); setProjection(null); setReadError(null);
      return;
    }
    setLoading(true); setReadError(null);
    try {
      const next = await client.getWorkspaceDefaultDirectory();
      if (request !== version.current) return;
      setProjection(next); setLoading(false);
    } catch (caught) {
      if (request !== version.current) return;
      setProjection(null); setReadError(describeLiveError(caught).message); setLoading(false);
    }
  }, [client]);

  /**
   * 换 API / Workspace 立即清空旧投影与在途命令：旧工作区的目录名、修订与回执身份
   * 都不能落进新范围。清理后只读一次新范围的事实，不发任何写命令。
   */
  useEffect(() => {
    version.current++;
    setProjection(null); setReadError(null); setNotice(null); setProblem(null);
    setPending(null); setChecking(false); setBusy(null); setManualPath(""); setPickerError(null);
    void read();
    return () => { version.current++; };
  }, [read]);

  async function save(resourceId: string | null) {
    if (client === null) return;
    const current = projection;
    if (current === null) {
      setProblem("默认工作目录尚未读取成功，先重新读取再设置。");
      setBusy(null);
      return;
    }
    const command: DefaultDirectoryCommand = { commandId: createCommandId(),
      action: resourceId === null ? "CLEAR" : "SET", resourceId, expectedRevision: current.revision };
    pendingRef.current = command; setPending(command);
    setBusy(resourceId === null ? "CLEAR" : "SET"); setProblem(null); setNotice(null);
    try {
      const result = resourceId === null
        ? await client.clearWorkspaceDefaultDirectory({ commandId: command.commandId,
            expectedRevision: command.expectedRevision })
        : await client.setWorkspaceDefaultDirectory({ commandId: command.commandId,
            expectedRevision: command.expectedRevision, resourceId });
      if (pendingRef.current?.commandId !== command.commandId) return;
      pendingRef.current = null; setPending(null); setBusy(null);
      const label = projection?.displayName ?? "所选目录";
      // 命令成功不等于事实已刷新：以重读到的投影为准，不用回执结果拼接第二份事实。
      await read();
      setNotice(resourceId === null
        ? `已清除默认工作目录（修订 ${result.revision}）；已存在的会话与既有目录绑定保持不变。`
        : `已把「${label}」设为默认工作目录（修订 ${result.revision}）。只引用这个已登记目录，不扩大任何权限。`);
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
      setNotice(record.action === "CLEAR"
        ? `原命令已确认：默认工作目录已清除（修订 ${result.revision}）。`
        : `原命令已确认：默认工作目录已设置（修订 ${result.revision}）。`);
    } catch (caught) {
      if (pendingRef.current?.commandId !== record.commandId) return;
      setProblem(`${describeLiveError(caught).message} 原命令仍未确认，不能换 ID 重发。`);
    } finally { setChecking(false); }
  }

  const status = projection?.status ?? null;
  const disabled = client === null || loading || busy !== null || pending !== null;
  const name = projection?.displayName ?? projection?.canonicalRoot ?? null;
  const reasonText = projection === null ? null : defaultDirectoryReasonText(projection.reason);

  return <div className="settings-field settings-default-directory" data-testid="settings-default-directory">
    <span className="field-label" id="settings-default-directory-label">默认工作目录</span>
    <div className="settings-default-directory-body" role="group" aria-labelledby="settings-default-directory-label">
      <p className="settings-default-directory-value" data-testid="settings-default-directory-value"
        data-status={status ?? "LOADING"}>
        {client === null
          ? <span className="status-chip status-chip--neutral">未连接</span>
          : loading && projection === null
            ? <span className="status-chip status-chip--neutral">读取中</span>
            : readError !== null
              ? <><span className="status-chip status-chip--danger">读取失败</span>{" "}{readError}</>
              : status === "READY"
                ? <><span className="status-chip status-chip--success">有效</span>{" "}
                  <strong>{name ?? "未命名目录"}</strong>{" "}
                  <code className="hash-code" data-testid="settings-default-directory-path">{projection?.canonicalRoot}</code></>
                : status === "UNAVAILABLE"
                  ? <><span className="status-chip status-chip--danger">失效</span>{" "}
                    <strong>{name ?? "未命名目录"}</strong>{projection?.canonicalRoot === null || projection?.canonicalRoot === undefined
                      ? null : <>{" "}<code className="hash-code">{projection.canonicalRoot}</code></>}
                    <span className="settings-default-directory-reason" data-testid="settings-default-directory-reason">
                      {" "}原因：{reasonText}。新普通会话会退回「没有默认目录」的行为，已存在的会话不改作用域。</span></>
                  : <><span className="status-chip status-chip--neutral">未设置</span>{" "}
                    还没有默认目录：未主动选过目录的新会话仍可普通讨论，读取文件前需要选择目录。</>}
      </p>
      {projection?.writeTier != null && status !== "UNSET" && <p className="helper-text" data-testid="settings-default-directory-tier">
        当前目录写入档位：{writeTierLabels[projection.writeTier]}。设置默认目录只确定作用域，不授予写权限；
        档位在对话页的目录行里调整，这一行不提供档位开关。
      </p>}
      {notice !== null && <p className="settings-save-result" role="status" data-testid="settings-default-directory-notice">{notice}</p>}
      {problem !== null && <p className="action-error" role="alert" data-testid="settings-default-directory-problem">{problem}</p>}
      {pending !== null && <div className="settings-default-directory-pending" data-testid="settings-default-directory-pending">
        <p className="helper-text">原命令 {pending.commandId} 结果待核对（目标：
          {pending.resourceId === null ? "清除默认目录" : "设置默认目录"}，基准修订 {pending.expectedRevision}）。</p>
        <button className="secondary-button secondary-button--compact" type="button"
          data-testid="settings-default-directory-receipt" disabled={checking} onClick={() => void checkReceipt()}>
          {checking ? "正在查询" : "查询原命令回执"}</button>
      </div>}
      {pickerError !== null && <p className="action-error" role="alert">{pickerError}</p>}
      <div className="settings-default-directory-actions">
        <button className="secondary-button" type="button" data-testid="settings-default-directory-choose"
          disabled={disabled || !pickerAvailable} onClick={() => void pick()}
          title={pickerAvailable ? "选择本机文件夹；只有已登记且就绪的目录才能设为默认"
            : "这个宿主没有原生目录选择器，请在下方填写本机绝对路径"}>
          <FolderOpen aria-hidden="true" />{status === null || status === "UNSET" ? "选择目录" : "更换目录"}</button>
        {status !== null && status !== "UNSET" && <button className="secondary-button" type="button"
          data-testid="settings-default-directory-clear" disabled={disabled} onClick={() => void save(null)}>
          <X aria-hidden="true" />{busy === "CLEAR" ? "正在清除…" : "清除"}</button>}
        {readError !== null && <button className="secondary-button secondary-button--compact" type="button"
          data-testid="settings-default-directory-reload" onClick={() => void read()}>
          <RotateCcw aria-hidden="true" />重读默认目录</button>}
        {busy === "OPEN" && <span className="helper-text" role="status">正在打开并核对这个目录…</span>}
        {busy === "SET" && <span className="helper-text" role="status">正在保存默认目录…</span>}
      </div>
      {!pickerAvailable && <div className="settings-default-directory-manual">
        <label className="field-label" htmlFor="settings-default-directory-manual">本机已有绝对目录</label>
        <input id="settings-default-directory-manual" data-testid="settings-default-directory-manual"
          value={manualPath} disabled={disabled} placeholder={"D:\\Develop\\MyProject"}
          onChange={(event) => setManualPath(event.target.value)} />
        <button className="secondary-button secondary-button--compact" type="button"
          data-testid="settings-default-directory-manual-submit"
          disabled={disabled || manualPath.trim() === ""} onClick={() => void choose(manualPath.trim())}>
          使用这个目录</button>
      </div>}
      <p className="helper-text">
        这里只引用一个已登记的受管目录：选择时会走与对话页文件夹入口相同的登记，未就绪或需要再选项目时不写入默认值。
        默认目录不提供自动批准或完全访问，也不扩大 Git、CLI、浏览器或电脑权限。
      </p>
    </div>
  </div>;
}

function DisplayPreferencesCard({ client }: { client: RelayApiClient | null }) {
  const preferences = useDisplayPreferences();
  const [timeZone, setTimeZone] = useState(preferences.timeZone);
  const [defaultWorkbench, setDefaultWorkbench] = useState<RelayViewKind>(preferences.defaultWorkbench ?? "general");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changed = () => { setSaved(false); setError(null); };

  return <section id="settings-preferences" className="settings-basic" aria-labelledby="settings-basic-title">
    <h2 id="settings-basic-title">基本设置</h2>
    <p className="settings-basic-intro">设置时区、界面外观、默认工作台与默认工作目录，定制你的工作环境。</p>
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
    {/* 默认工作目录是服务端 Workspace 配置，不是本设备偏好：它不进上面的表单，
        也不写 localStorage——作用域是事实，本机偏好不能冒充授权。 */}
    <DefaultWorkingDirectoryRow client={client} />
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

return <section className="settings-page pv-page" data-testid="settings-page">
    <PageHeader testId="settings-page-head" title="设置" overline="Settings" lede="以服务状态、模型端口、基本设置和执行策略为主；选项即时生效，不需要填写配置表。" />
    <div className="settings-layout">
      <nav className="settings-navigation" role="tablist" aria-label="设置分组" onKeyDown={handleTabListKeyDown}>
        {([['basic', '基本设置'], ['model', 'AI 设置'], ['execution', '执行策略'], ['workbench', '工作台']] as const)
          .map(([value, label]) => <button key={value} type="button" data-testid={`settings-group-${value}`}
            role="tab" id={`settings-tab-${value}`} aria-controls={`settings-panel-${value}`} aria-selected={group === value}
            tabIndex={group === value ? 0 : -1} onClick={() => setGroup(value)}>{label}</button>)}
      </nav>
      <div className="settings-content">
      <div role="tabpanel" id="settings-panel-basic" aria-labelledby="settings-tab-basic" hidden={group !== "basic"}><DisplayPreferencesCard client={client} /></div>
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
      {status && <ModelPortCard status={status} client={client} onSaved={refresh} />}
      {status?.configured === true && <VerificationDetailCard verification={verification}
        verifying={verifying} />}
      {/* 记忆设置与模型端口同为「AI 行为」配置，但两者独立：模型不可用不影响这两个开关的读写。 */}
      <MemorySettingsCard client={client} />
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
        {/* 2026-10-20（P2）：两行「暂不可用」在这里没有任何可做的动作，占的是设置项的位置。
            合成一句如实说明——语言偏好仍缺读写接口，通知规则已确认但还不能在此修改——
            既不摆假开关，也不把待实现的需求从文档里删掉。 */}
        <p className="helper-text" data-testid="settings-pending-preferences"
          title="完整通知规则见《工作台交互设计》11.5：仅提醒必须由用户介入的事项；Relay 运行期间应用内保留待处理标记，窗口外另发 Windows 通知；同一事项只提醒一次；短时间多个事项合并为一条通知。">
          界面语言与通知偏好暂不可修改：语言偏好的读写接口尚未提供；通知规则已确认——
          仅提醒必须由用户介入的事项，同一事项只提醒一次。
        </p>
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
