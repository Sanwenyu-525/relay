import { useEffect, useRef, useState } from "react";
import { KeyRound, Plug, RotateCcw, ShieldCheck } from "lucide-react";

import { createCommandId, RelayApiError, type RelayApiClient,
  type RelayModelVerificationState } from "../api/relayClient";
import type { RelayModelConnection } from "../api/dtos/information";
import { describeLiveError } from "../lib/liveErrors";
import { modelErrorGuides } from "../lib/modelErrorGuides";
import { serverVerificationKind, verificationLabels,
  type ModelVerificationStateKind } from "../lib/modelVerification";

/**
 * 模型连接登记与作用域指派（ADR-036；MODEL-SETTINGS-01）。
 *
 * 四条界面纪律：
 *   1. **作用域分开**：Run 默认只决定新任务执行冻结哪条连接；聊天默认只在会话没有显式
 *      选择时生效。两者互不写回，既有会话、已排队/生成中的消息和已冻结 Run 都不受影响。
 *   2. **验证按连接独立**：每条连接各自回答「当前凭据与配置能否连通」，验证通过不等于
 *      任务执行成功；编辑或轮换凭据后旧结论自动失效，界面重读服务端事实。
 *   3. **凭据只进不出**：Key 只在密码框里出现一次，提交后服务端只留不透明引用；
 *      界面既不回显也不保存，刷新后只剩「凭据代数」与系统凭据库的存在性。
 *   4. **优先停用而非删除**：停用保留身份与历史，冻结在旧身份上的 Run 会停止；
 *      界面不提供删除，避免把仍有 Run 引用的身份从历史里抹掉。
 *
 * 懒加载：默认折叠，点「管理连接」才发请求——设置页其他卡片不该为一张未展开的表付代价。
 */
export function ModelConnectionsCard({ client, defaultExpanded = false, onDefaultsChanged }: {
  readonly client: RelayApiClient;
  /** 测试与嵌入场景可要求展开；设置页保持默认折叠。 */
  readonly defaultExpanded?: boolean;
  readonly onDefaultsChanged?: () => void;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connections, setConnections] = useState<readonly RelayModelConnection[]>([]);
  const [runDefaultId, setRunDefaultId] = useState<string | null>(null);
  const [chatDefaultId, setChatDefaultId] = useState<string | null>(null);
  const [verifications, setVerifications] = useState<
    Readonly<Record<string, RelayModelVerificationState>>>({});
  /** null＝这次没读成（凭据库不可用/网络失败），不能解释为「没有凭据」。 */
  const [credentialPresence, setCredentialPresence] =
    useState<Readonly<Record<string, boolean | null>>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [verifyingId, setVerifyingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [rotatingId, setRotatingId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const expandedRef = useRef(false);
  const loadVersion = useRef(0);
  expandedRef.current = expanded;

  /**
   * 换 API / Workspace 立即清空上一条连接列表与表单草稿：连接身份、凭据代数和默认标记
   * 都属于旧范围，不能在新范围里继续显示。已展开时只重读新范围的一份事实。
   */
  useEffect(() => {
    loadVersion.current += 1;
    setConnections([]); setRunDefaultId(null); setChatDefaultId(null);
    setVerifications({}); setCredentialPresence({});
    setError(null); setNotice(null); setFormOpen(false); setRotatingId(null);
    setEditingId(null); setBusyId(null); setVerifyingId(null);
    if (expandedRef.current) { setLoading(true); void load(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  async function load(): Promise<void> {
    const version = ++loadVersion.current;
    setLoading(true);
    setError(null);
    try {
      const [items, runDefault, chatDefault] = await Promise.all([
        client.listModelConnections(),
        client.getDefaultModelConnection(),
        client.getChatDefaultModelConnection()
      ]);
      if (version !== loadVersion.current) return;
      setConnections(items);
      setRunDefaultId(runDefault.connectionId);
      setChatDefaultId(chatDefault.connectionId);
      // 每条连接各自读验证态与凭据存在性；单条失败只让那一行显示未知，不拖垮整张表。
      const facts = await Promise.all(items.map(async (item) => {
        const [verification, presence] = await Promise.allSettled([
          client.getModelPortVerification({ connection: "registered", connectionId: item.id }),
          client.getModelConnectionCredentialPresence(item.id)
        ]);
        return { id: item.id,
          verification: verification.status === "fulfilled" ? verification.value : null,
          presence: presence.status === "fulfilled" ? presence.value : null };
      }));
      if (version !== loadVersion.current) return;
      const nextVerifications: Record<string, RelayModelVerificationState> = {};
      const nextPresence: Record<string, boolean | null> = {};
      for (const fact of facts) {
        if (fact.verification !== null) nextVerifications[fact.id] = fact.verification;
        nextPresence[fact.id] = fact.presence;
      }
      setVerifications(nextVerifications);
      setCredentialPresence(nextPresence);
    } catch (cause) {
      if (version !== loadVersion.current) return;
      setError(cause instanceof RelayApiError ? cause.message : "读取模型连接失败。");
    } finally {
      if (version === loadVersion.current) setLoading(false);
    }
  }

  async function open(): Promise<void> {
    setExpanded(true);
    await load();
  }

  /** 统一包一层：成功刷新列表，失败只显示这一行的问题，不把整页打挂。 */
  async function act(id: string, work: () => Promise<void>): Promise<void> {
    setBusyId(id);
    setNotice(null);
    setError(null);
    try {
      await work();
      await load();
    } catch (cause) {
      setError(cause instanceof RelayApiError ? cause.message : "操作失败，请重试。");
    } finally {
      setBusyId(null);
    }
  }

  /** 验证只发固定短文本；命令成功不等于事实已刷新，结论一律以重读到的目标级状态为准。 */
  async function verify(connection: RelayModelConnection): Promise<void> {
    setVerifyingId(connection.id);
    setNotice(null);
    setError(null);
    try {
      await client.verifyModelPort({ connection: "registered", connectionId: connection.id });
      const next = await client.getModelPortVerification({
        connection: "registered", connectionId: connection.id });
      setVerifications((current) => ({ ...current, [connection.id]: next }));
      const kind = connectionVerificationKind(next);
      setNotice(`已用固定短文本验证「${connection.name}」：${verificationLabels[kind].chip}。`
        + "验证只证明当前配置能否连通，不代表任何任务已执行成功。");
    } catch (cause) {
      setError(describeLiveError(cause).message);
    } finally {
      setVerifyingId(null);
    }
  }

  const blocked = busyId !== null || verifyingId !== null;

  if (!expanded) {
    return <section className="surface-panel settings-card" data-testid="model-connections">
      <h2>模型连接</h2>      <p className="helper-text">登记 OpenAI 兼容连接（端点、确切型号、调用预算）；凭据存系统凭据库，业务库只有不透明引用。</p>
      <p className="settings-verify-actions">
        <button className="secondary-button" type="button" data-testid="model-connections-open"
          onClick={() => { void open(); }}>
          <Plug aria-hidden="true" />管理连接</button>
      </p>
    </section>;
  }

  return <section className="surface-panel settings-card" data-testid="model-connections">
    <h2>模型连接</h2>    <p className="helper-text">每条连接可独立验证；改配置或轮换凭据后旧结论失效。</p>
    {loading && <p role="status">正在读取模型连接…</p>}
    {error !== null && <div className="action-error" role="alert" data-testid="model-connections-error">
      <p>{error}</p>
      <button className="secondary-button" type="button" onClick={() => { void load(); }}>
        <RotateCcw aria-hidden="true" />重新读取</button>
    </div>}
    {notice !== null && <p className="helper-text" role="status" data-testid="model-connections-notice">
      {notice}</p>}

    {!loading && error === null && connections.length === 0 &&
      <p className="helper-text" data-testid="model-connections-empty">
        还没有登记任何连接；此时会话与新任务执行都跟随进程默认。</p>}

    {connections.length > 0 && <dl className="settings-definition-list">
      {connections.map((connection) => {
        const verification = verifications[connection.id] ?? null;
        const kind = verification === null ? null : connectionVerificationKind(verification);
        const label = kind === null ? null : verificationLabels[kind];
        const last = verification?.targetLast ?? null;
        const presence = credentialPresence[connection.id];
        const isRunDefault = runDefaultId === connection.id;
        const isChatDefault = chatDefaultId === connection.id;
        return <div key={connection.id} data-testid={`model-connection-${connection.id}`}>
          <dt>{connection.name}
            {isRunDefault && <span className="status-chip status-chip--neutral"
              data-testid="model-connection-default-badge">Run 默认</span>}
            {isChatDefault && <span className="status-chip status-chip--neutral"
              data-testid="model-connection-chat-default-badge">聊天默认</span>}</dt>
          <dd>
            <span className={`status-chip status-chip--${
              connection.status === "ACTIVE" ? "success" : "warning"}`}>
              {connection.status === "ACTIVE" ? "已启用" : "已停用"}</span>
            {" "}
            {presence === false
              ? <span className="status-chip status-chip--danger"
                data-testid={`model-connection-credential-${connection.id}`}
                title="系统凭据库里找不到这条连接引用的秘密；请轮换 API Key。">凭据缺失</span>
              : presence === null
                ? <span className="status-chip status-chip--neutral"
                  data-testid={`model-connection-credential-${connection.id}`}
                  title="这次没有读到系统凭据库；不能据此判断凭据是否存在。">凭据状态未知</span>
                : <span className="status-chip status-chip--success"
                  data-testid={`model-connection-credential-${connection.id}`}>凭据就绪</span>}
            {" "}
            {label === null
              ? <span className="status-chip status-chip--neutral"
                data-testid={`model-connection-verification-${connection.id}`}>验证状态未读取</span>
              : <span className={`status-chip status-chip--${label.tone}`}
                data-testid={`model-connection-verification-${connection.id}`}
                title={label.detail}>{label.chip}</span>}
            {" "}
            <code className="hash-code">{connection.defaultModel}</code>
            {" · "}
            {connection.baseUrl === null ? "内置默认端点" : connection.baseUrl}
            {" · 凭据第 "}{connection.credentialVersion}{" 代"}
            {last !== null && last.ok === false && last.errorCategory !== null &&
              <span className="helper-text" data-testid={`model-connection-verify-guide-${connection.id}`}>
                {modelErrorGuides[last.errorCategory]}</span>}
            <span className="settings-connection-actions">
              <button className="secondary-button" type="button"
                data-testid={`model-connection-verify-${connection.id}`}
                disabled={blocked || connection.status !== "ACTIVE"}
                title={connection.status !== "ACTIVE" ? "先启用连接再验证。" : undefined}
                onClick={() => { void verify(connection); }}>
                <ShieldCheck aria-hidden="true" />{verifyingId === connection.id ? "验证中…" : "验证"}</button>
              <button className="secondary-button" type="button"
                data-testid={`model-connection-edit-${connection.id}`}
                disabled={blocked}
                onClick={() => {
                  setEditingId(editingId === connection.id ? null : connection.id);
                  setRotatingId(null);
                }}>编辑</button>
              {!isRunDefault && <button className="secondary-button" type="button"
                data-testid={`model-connection-default-${connection.id}`}
                disabled={blocked || connection.status !== "ACTIVE"}
                onClick={() => { void act(connection.id, async () => {
                  await client.setDefaultModelConnection(connection.id, createCommandId());
                  onDefaultsChanged?.();
                  setNotice(`已把「${connection.name}」设为 Run 默认连接；已创建的 Run 不受影响。`);
                }); }}>设为 Run 默认</button>}
              {!isChatDefault && <button className="secondary-button" type="button"
                data-testid={`model-connection-chat-default-${connection.id}`}
                disabled={blocked || connection.status !== "ACTIVE"}
                onClick={() => { void act(connection.id, async () => {
                  await client.setChatDefaultModelConnection(connection.id, createCommandId());
                  onDefaultsChanged?.();
                  setNotice(`已把「${connection.name}」设为工作区聊天默认；没有显式会话选择的新消息`
                    + "将使用它。已排队或正在生成的消息保持原连接。");
                }); }}>设为聊天默认</button>}
              {isChatDefault && <button className="secondary-button" type="button"
                data-testid={`model-connection-chat-default-clear-${connection.id}`}
                disabled={blocked}
                onClick={() => { void act(connection.id, async () => {
                  await client.setChatDefaultModelConnection(null, createCommandId());
                  onDefaultsChanged?.();
                  setNotice("已取消工作区聊天默认；没有显式会话选择的新消息改为跟随进程默认。");
                }); }}>取消聊天默认</button>}
              <button className="secondary-button" type="button"
                data-testid={`model-connection-status-${connection.id}`}
                disabled={blocked}
                onClick={() => { void act(connection.id, async () => {
                  await client.setModelConnectionStatus(connection.id, {
                    commandId: createCommandId(),
                    expectedRevision: connection.revision,
                    status: connection.status === "ACTIVE" ? "DISABLED" : "ACTIVE"
                  });
                  onDefaultsChanged?.();
                  setNotice(connection.status === "ACTIVE"
                    ? `已停用「${connection.name}」；已冻结在它上面的 Run 会停止，不再发起新调用。`
                    : `已启用「${connection.name}」。`);
                }); }}>{connection.status === "ACTIVE" ? "停用" : "启用"}</button>
              <button className="secondary-button" type="button"
                data-testid={`model-connection-rotate-${connection.id}`}
                disabled={blocked}
                onClick={() => {
                  setRotatingId(rotatingId === connection.id ? null : connection.id);
                  setEditingId(null);
                }}>
                <KeyRound aria-hidden="true" />轮换凭据</button>
            </span>
            {editingId === connection.id && <EditConnectionForm
              connection={connection} busy={blocked}
              onSubmit={async (changes) => {
                await act(connection.id, async () => {
                  await client.updateModelConnection(connection.id, {
                    commandId: createCommandId(),
                    expectedRevision: connection.revision,
                    ...changes
                  });
                  setEditingId(null);
                  setNotice(`已保存「${connection.name}」的设置；配置指纹变化后旧验证结果失效，请重新验证。`);
                });
              }}
              onCancel={() => { setEditingId(null); }} />}
            {rotatingId === connection.id && <RotateCredentialForm
              connection={connection} busy={blocked}
              onSubmit={async (apiKey) => {
                await act(connection.id, async () => {
                  await client.rotateModelConnectionCredential(connection.id, {
                    commandId: createCommandId(),
                    expectedRevision: connection.revision,
                    apiKey
                  });
                  setRotatingId(null);
                  setNotice(`已轮换「${connection.name}」的凭据；凭据代数 +1，`
                    + "旧验证结论已失效，冻结在旧代数上的 Run 会停止。");
                });
              }}
              onCancel={() => { setRotatingId(null); }} />}
          </dd>
        </div>;
      })}
    </dl>}

    {formOpen
      ? <CreateConnectionForm client={client} busy={blocked}
        onCreated={async (name) => {
          setFormOpen(false);
          setNotice(`已登记「${name}」。它还不是默认连接（聊天默认与 Run 默认都未改变），`
            + "也不会自动用于执行；可在这一行点「验证」检查连通性。");
          await load();
        }}
        onCancel={() => { setFormOpen(false); }} />
      : <p className="settings-verify-actions">
        <button className="secondary-button" type="button" data-testid="model-connection-add"
          onClick={() => { setFormOpen(true); }}>
          <ShieldCheck aria-hidden="true" />新增连接</button>
        <button className="secondary-button" type="button" onClick={() => { void load(); }}>
          <RotateCcw aria-hidden="true" />刷新</button>
      </p>}
  </section>;
}

/** 目标级 13 态优先；旧服务端没有 state 时只按本目标的最近一次结果推导，不拿别的型号顶替。 */
function connectionVerificationKind(verification: RelayModelVerificationState): ModelVerificationStateKind {
  const mapped = serverVerificationKind(verification.state);
  if (mapped !== null) return mapped;
  const last = verification.targetLast ?? null;
  if (last !== null && verification.matchesCurrentConfig) return last.ok ? "VERIFIED" : "VERIFY_FAILED";
  return "UNVERIFIED";
}

/** 编辑连接：只改身份与端点，不碰凭据；Key 的变更走独立的轮换入口。 */
function EditConnectionForm({ connection, busy, onSubmit, onCancel }: {
  readonly connection: RelayModelConnection;
  readonly busy: boolean;
  readonly onSubmit: (changes: { readonly name: string; readonly baseUrl: string | null;
    readonly defaultModel: string }) => Promise<void>;
  readonly onCancel: () => void;
}) {
  const [name, setName] = useState(connection.name);
  const [model, setModel] = useState(connection.defaultModel);
  const [baseUrl, setBaseUrl] = useState(connection.baseUrl ?? "");
  const [localError, setLocalError] = useState<string | null>(null);
  return <div className="settings-inline-form" data-testid="model-connection-edit-form">
    <label><span>名称</span>
      <input value={name} aria-label="连接名称" maxLength={60}
        onChange={(event) => { setName(event.target.value); }} /></label>
    <label><span>确切型号</span>
      <input value={model} aria-label="确切型号" maxLength={200}
        onChange={(event) => { setModel(event.target.value); }} /></label>
    <label><span>服务端点（留空＝内置默认端点）</span>
      <input value={baseUrl} aria-label="服务端点" placeholder="https://…/v1"
        onChange={(event) => { setBaseUrl(event.target.value); }} /></label>
    <p className="helper-text">API Key 不变；更换凭据请用「轮换凭据」。保存后旧验证结论失效。</p>
    {localError !== null && <p className="action-error" role="alert">{localError}</p>}
    <p className="settings-verify-actions">
      <button className="secondary-button" type="button" disabled={busy}
        data-testid="model-connection-edit-submit"
        onClick={() => {
          if (name.trim() === "") { setLocalError("请填写连接名称。"); return; }
          if (model.trim() === "") { setLocalError("请填写确切型号。"); return; }
          setLocalError(null);
          void onSubmit({ name: name.trim(), defaultModel: model.trim(),
            baseUrl: baseUrl.trim() === "" ? null : baseUrl.trim() });
        }}>保存设置</button>
      <button className="secondary-button" type="button" onClick={onCancel}>取消</button>
    </p>
  </div>;
}

/** 轮换凭据：Key 只在这个密码框里出现一次，提交后界面不再保留它。 */
function RotateCredentialForm({ connection, busy, onSubmit, onCancel }: {
  readonly connection: RelayModelConnection;
  readonly busy: boolean;
  readonly onSubmit: (apiKey: string) => Promise<void>;
  readonly onCancel: () => void;
}) {
  const [apiKey, setApiKey] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  return <div className="settings-inline-form" data-testid="model-connection-rotate-form">
    <label>
      <span>新的 API Key</span>
      <input type="password" autoComplete="off" value={apiKey}
        aria-label={`${connection.name} 的新 API Key`}
        onChange={(event) => { setApiKey(event.target.value); }} />
    </label>
    <p className="helper-text">轮换后旧验证结论失效；冻结在旧凭据代数上的 Run 会停止。</p>
    {localError !== null && <p className="action-error" role="alert">{localError}</p>}
    <p className="settings-verify-actions">
      <button className="secondary-button" type="button" disabled={busy}
        data-testid="model-connection-rotate-submit"
        onClick={() => {
          const trimmed = apiKey.trim();
          if (trimmed === "") { setLocalError("请填写新的 API Key。"); return; }
          setLocalError(null);
          setApiKey("");
          void onSubmit(trimmed);
        }}>保存新凭据</button>
      <button className="secondary-button" type="button" onClick={onCancel}>取消</button>
    </p>
  </div>;
}

/** 第一阶段只保证已实现的 OpenAI-Compatible 路径；预设只填端点，不代替用户选择确切型号。 */
const connectionPresets = [
  { id: "openai", label: "OpenAI", baseUrl: "", modelHint: "例如 gpt-4o-mini" },
  { id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1",
    modelHint: "例如 openai/gpt-4o-mini" },
  // 2026-11-03：星火只是自定义 OpenAI 兼容连接的预置模板，不新增枚举、不写死型号；
  // 端点预填，型号由用户按账号订阅填写（当前 MaaS 账号仅有 spark-x2.6）。
  { id: "spark", label: "讯飞星火（MaaS）", baseUrl: "https://maas-api.cn-huabei-1.xf-yun.com/v2",
    modelHint: "例如 spark-x2.6" },
  { id: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1",
    modelHint: "例如 deepseek-chat" },
  { id: "custom", label: "自定义", baseUrl: "", modelHint: "例如 provider/model-id" }
] as const;
type ConnectionPresetId = typeof connectionPresets[number]["id"];

/** 新增连接：服务端会先落秘密再落行；失败时不会留下孤儿凭据。 */
function CreateConnectionForm({ client, busy, onCreated, onCancel }: {
  readonly client: RelayApiClient;
  readonly busy: boolean;
  readonly onCreated: (name: string) => Promise<void>;
  readonly onCancel: () => void;
}) {
  const [preset, setPreset] = useState<ConnectionPresetId>("openai");
  const [name, setName] = useState("");
  const [model, setModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const selectedPreset = connectionPresets.find((item) => item.id === preset) ?? connectionPresets[0];
  return <div className="settings-inline-form" data-testid="model-connection-create-form">
    <label><span>服务预设</span>
      <select value={preset} aria-label="服务预设"
        onChange={(event) => {
          const nextId = event.target.value as ConnectionPresetId;
          const next = connectionPresets.find((item) => item.id === nextId) ?? connectionPresets[0];
          setPreset(nextId);
          setBaseUrl(next.baseUrl);
          if (next.id !== "custom" && name.trim() === "") setName(next.label);
        }}>
        {connectionPresets.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
      </select></label>
    <label><span>名称</span>
      <input value={name} aria-label="连接名称" maxLength={60}
        onChange={(event) => { setName(event.target.value); }} /></label>
    <label><span>确切型号（由你确认，不由预设代填）</span>
      <input value={model} aria-label="确切型号" maxLength={200}
        placeholder={selectedPreset.modelHint}
        onChange={(event) => { setModel(event.target.value); }} /></label>
    <label><span>服务端点（留空＝内置默认端点）</span>
      <input value={baseUrl} aria-label="服务端点" placeholder="https://…/v1"
        onChange={(event) => { setBaseUrl(event.target.value); }} /></label>
    <label><span>API Key（只在此出现一次，保存后只留代数）</span>
      <input type="password" autoComplete="off" value={apiKey} aria-label="API Key"
        onChange={(event) => { setApiKey(event.target.value); }} /></label>
    <p className="helper-text">只保证 OpenAI-Compatible 路径；保存不等于验证通过，登记后点这一行的「验证」。</p>
    {localError !== null && <p className="action-error" role="alert">{localError}</p>}
    <p className="settings-verify-actions">
      <button className="secondary-button" type="button" disabled={busy}
        data-testid="model-connection-create-submit"
        onClick={() => {
          if (name.trim() === "") { setLocalError("请填写连接名称。"); return; }
          if (model.trim() === "") { setLocalError("请填写确切型号。"); return; }
          if (apiKey.trim() === "") { setLocalError("请填写 API Key。"); return; }
          setLocalError(null);
          const created = { name: name.trim(), model: model.trim(),
            baseUrl: baseUrl.trim() === "" ? null : baseUrl.trim(), apiKey: apiKey.trim() };
          setName(""); setModel(""); setBaseUrl(""); setApiKey("");
          void client.createModelConnection({ commandId: createCommandId(),
            name: created.name, baseUrl: created.baseUrl, defaultModel: created.model,
            apiKey: created.apiKey })
            .then(() => onCreated(created.name))
            .catch((cause: unknown) => {
              setLocalError(cause instanceof RelayApiError ? cause.message : "创建连接失败。");
            });
        }}>创建连接</button>
      <button className="secondary-button" type="button" onClick={onCancel}>取消</button>
    </p>
  </div>;
}
