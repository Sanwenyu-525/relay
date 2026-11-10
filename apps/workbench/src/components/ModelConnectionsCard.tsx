import { useEffect, useRef, useState } from "react";
import { KeyRound, Plus, Plug, RotateCcw, ShieldCheck } from "lucide-react";

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
  /** 主从布局选中项；null 表示只显示列表/空态/新增表单。 */
  const [selectedId, setSelectedId] = useState<string | null>(null);
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
    setEditingId(null); setBusyId(null); setVerifyingId(null); setSelectedId(null);
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
      // 主从布局保持当前选中；选中项消失时优先落到 Run 默认，再退到第一条。
      setSelectedId((current) => {
        if (current !== null && items.some((item) => item.id === current)) return current;
        const preferred = runDefault.connectionId;
        if (preferred !== null && items.some((item) => item.id === preferred)) return preferred;
        return items[0]?.id ?? null;
      });
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
      setNotice(`已用固定短文本验证「${connection.name}」：${verificationLabels[kind].chip}。`);
    } catch (cause) {
      setError(describeLiveError(cause).message);
    } finally {
      setVerifyingId(null);
    }
  }

  /** 主从布局切换选中项时收起该连接上的表单，避免旧表单落到另一条连接上。 */
  function selectConnection(id: string): void {
    setSelectedId(id);
    setFormOpen(false);
    setEditingId(null);
    setRotatingId(null);
  }

  function openCreate(): void {
    setFormOpen(true);
    setEditingId(null);
    setRotatingId(null);
  }

  /** 创建成功后选中新连接；列表重读仍由 load 负责，不用返回值拼第二份列表。 */
  async function afterCreate(name: string, id: string): Promise<void> {
    setFormOpen(false);
    setSelectedId(id);
    setNotice(`已登记「${name}」；它还不是默认连接。可在右侧点「验证」检查连通性。`);
    await load();
  }

  const blocked = busyId !== null || verifyingId !== null;

  if (!expanded) {
    return <section className="surface-panel settings-card" data-testid="model-connections">
      <h2>模型连接</h2>      <p className="helper-text">登记 OpenAI 兼容或 Anthropic 连接（协议、端点、确切型号、调用预算）；凭据存系统凭据库，业务库只有不透明引用。</p>
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

    {!loading && error === null && connections.length === 0 && !formOpen &&
      <p className="helper-text" data-testid="model-connections-empty">
        还没有登记任何连接；此时会话与新任务执行都跟随进程默认。</p>}

    {connections.length === 0 && !formOpen && <p className="settings-verify-actions">
      <button className="secondary-button" type="button" data-testid="model-connection-add"
        onClick={openCreate}>
        <Plus aria-hidden="true" />新增连接</button>
    </p>}

    {connections.length === 0 && formOpen &&
      <CreateConnectionForm client={client} busy={blocked}
        onCreated={afterCreate}
        onCancel={() => { setFormOpen(false); }} />}

    {connections.length > 0 && <div className="settings-connections-shell">
      <aside className="settings-connections-list" aria-label="已登记连接">
        <div className="settings-connections-list-head">
          <span className="settings-connections-list-title">已登记连接</span>
          <button className="icon-button" type="button" aria-label="刷新模型连接"
            title="刷新模型连接" disabled={loading} onClick={() => { void load(); }}>
            <RotateCcw aria-hidden="true" /></button>
        </div>
        <ul>
          {connections.map((connection) => {
            const isRunDefault = runDefaultId === connection.id;
            const isChatDefault = chatDefaultId === connection.id;
            const selected = !formOpen && selectedId === connection.id;
            return <li key={connection.id}>
              <button type="button" className="settings-connection-nav"
                data-testid={`model-connection-nav-${connection.id}`}
                data-selected={selected ? "true" : undefined}
                aria-current={selected ? "true" : undefined}
                onClick={() => { selectConnection(connection.id); }}>
                <span className={`settings-connection-dot settings-connection-dot--${
                  connection.status === "ACTIVE" ? "active" : "disabled"}`} aria-hidden="true" />
                <span className="settings-connection-nav-text">
                  <span className="settings-connection-nav-name">{connection.name}</span>
                  {(isRunDefault || isChatDefault) && <span className="settings-connection-nav-meta">
                    {isChatDefault ? "聊天默认" : ""}
                    {isChatDefault && isRunDefault ? " · " : ""}
                    {isRunDefault ? "Run 默认" : ""}</span>}
                </span>
              </button>
            </li>;
          })}
        </ul>
        <button className="secondary-button settings-connections-add" type="button"
          data-testid="model-connection-add" aria-pressed={formOpen}
          onClick={openCreate}>
          <Plus aria-hidden="true" />新增连接</button>
      </aside>
      <div className="settings-connections-detail">
        {formOpen && <CreateConnectionForm client={client} busy={blocked}
          onCreated={afterCreate}
          onCancel={() => { setFormOpen(false); }} />}
        {!formOpen && connections.map((connection) => {
          const verification = verifications[connection.id] ?? null;
          const kind = verification === null ? null : connectionVerificationKind(verification);
          const label = kind === null ? null : verificationLabels[kind];
          const last = verification?.targetLast ?? null;
          const presence = credentialPresence[connection.id];
          const isRunDefault = runDefaultId === connection.id;
          const isChatDefault = chatDefaultId === connection.id;
          return <section key={connection.id} className="settings-connection"
            data-testid={`model-connection-${connection.id}`}
            hidden={connection.id !== selectedId}>
            <div className="settings-connection-detail-head">
              <div className="settings-connection-detail-title">
                <h3>{connection.name}</h3>
                <div className="settings-connection-badges">
                  <span className={`status-chip status-chip--${
                    connection.status === "ACTIVE" ? "success" : "warning"}`}>
                    {connection.status === "ACTIVE" ? "已启用" : "已停用"}</span>
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
                  {label === null
                    ? <span className="status-chip status-chip--neutral"
                      data-testid={`model-connection-verification-${connection.id}`}>验证状态未读取</span>
                    : <span className={`status-chip status-chip--${label.tone}`}
                      data-testid={`model-connection-verification-${connection.id}`}
                      title={label.detail}>{label.chip}</span>}
                </div>
              </div>
              <div className="settings-connection-head-actions">
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
              </div>
            </div>
            {presence === false && <p className="settings-connection-warning">
              系统凭据库里找不到这条连接的 Key；请轮换凭据后再验证或设为默认。</p>}
            {last !== null && last.ok === false && last.errorCategory !== null &&
              <p className="helper-text" data-testid={`model-connection-verify-guide-${connection.id}`}>
                {modelErrorGuides[last.errorCategory]}</p>}
            {editingId === connection.id
              ? <EditConnectionForm
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
                onCancel={() => { setEditingId(null); }} />
              : rotatingId === connection.id
                ? <RotateCredentialForm
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
                  onCancel={() => { setRotatingId(null); }} />
                : <>
                  <dl className="settings-connection-fields">
                    <div><dt>Base URL</dt><dd>{connection.baseUrl === null ? "内置默认端点"
                      : <code className="hash-code">{connection.baseUrl}</code>}</dd></div>
                    <div><dt>API 格式</dt><dd><code className="hash-code">{
                      protocolLabels[connection.providerKind]}</code></dd></div>
                    <div><dt>凭据</dt><dd>凭据第 {connection.credentialVersion} 代
                      <button className="secondary-button" type="button"
                        data-testid={`model-connection-rotate-${connection.id}`}
                        disabled={blocked}
                        onClick={() => {
                          setRotatingId(rotatingId === connection.id ? null : connection.id);
                          setEditingId(null);
                        }}>
                        <KeyRound aria-hidden="true" />轮换凭据</button></dd></div>
                  </dl>
                  <div className="settings-connection-defaults">
                    <span className="field-label">默认用途</span>
                    <div className="settings-connection-defaults-actions">
                      {isChatDefault
                        ? <>
                          <span className="status-chip status-chip--neutral"
                            data-testid="model-connection-chat-default-badge">聊天默认</span>
                          <button className="secondary-button" type="button"
                            data-testid={`model-connection-chat-default-clear-${connection.id}`}
                            disabled={blocked}
                            onClick={() => { void act(connection.id, async () => {
                              await client.setChatDefaultModelConnection(null, createCommandId());
                              onDefaultsChanged?.();
                              setNotice("已取消工作区聊天默认。");
                            }); }}>取消聊天默认</button>
                        </>
                        : <button className="secondary-button" type="button"
                          data-testid={`model-connection-chat-default-${connection.id}`}
                          disabled={blocked || connection.status !== "ACTIVE"}
                          onClick={() => { void act(connection.id, async () => {
                            await client.setChatDefaultModelConnection(connection.id, createCommandId());
                            onDefaultsChanged?.();
                            setNotice(`已把「${connection.name}」设为工作区聊天默认。`);
                          }); }}>设为聊天默认</button>}
                      {isRunDefault
                        ? <span className="status-chip status-chip--neutral"
                          data-testid="model-connection-default-badge">Run 默认</span>
                        : <button className="secondary-button" type="button"
                          data-testid={`model-connection-default-${connection.id}`}
                          disabled={blocked || connection.status !== "ACTIVE"}
                          onClick={() => { void act(connection.id, async () => {
                            await client.setDefaultModelConnection(connection.id, createCommandId());
                            onDefaultsChanged?.();
                            setNotice(`已把「${connection.name}」设为 Run 默认连接。`);
                          }); }}>设为 Run 默认</button>}
                    </div>
                  </div>
                  <div className="settings-connection-models">
                    <div className="settings-connection-models-head">
                      <span className="field-label">模型</span>
                      <button className="text-button" type="button"
                        data-testid={`model-connection-model-edit-${connection.id}`}
                        onClick={() => {
                          setEditingId(connection.id);
                          setRotatingId(null);
                        }}>编辑型号</button>
                    </div>
                    <div className="settings-connection-model-row">
                      <span className="settings-connection-model-name">
                        <code className="hash-code">{connection.defaultModel}</code>
                        <span className="status-chip status-chip--neutral">当前型号</span>
                      </span>
                      <span className="helper-text">
                        一条连接只配置一个默认型号；更换会改变配置指纹并要求重新验证。</span>
                    </div>
                  </div>
                </>}
          </section>;
        })}
      </div>
    </div>}
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
  readonly onSubmit: (changes: { readonly name: string;
    readonly protocol: ConnectionProtocol; readonly baseUrl: string | null;
    readonly defaultModel: string; readonly timeoutMs?: number }) => Promise<void>;
  readonly onCancel: () => void;
}) {
  const [name, setName] = useState(connection.name);
  const [protocol, setProtocol] = useState<ConnectionProtocol>(connection.providerKind);
  const [model, setModel] = useState(connection.defaultModel);
  const [baseUrl, setBaseUrl] = useState(connection.baseUrl ?? "");
  const [timeoutSeconds, setTimeoutSeconds] = useState(String(Math.round(connection.budget.timeoutMs / 1_000)));
  const [localError, setLocalError] = useState<string | null>(null);
  return <div className="settings-inline-form" data-testid="model-connection-edit-form">
    <h3>编辑连接</h3>
    <div className="settings-form-row">
      <label><span>连接名称</span>
        <input value={name} aria-label="连接名称" maxLength={60}
          onChange={(event) => { setName(event.target.value); }} /></label>
      <label><span>API 格式</span>
        <select value={protocol} aria-label="API 格式" data-testid="model-connection-edit-protocol"
          onChange={(event) => { setProtocol(event.target.value as ConnectionProtocol); }}>
          <option value="openai-compatible">OpenAI-Compatible</option>
          <option value="anthropic-messages">Anthropic</option>
        </select></label>
    </div>
    <div className="settings-form-row">
      <label><span>Model ID</span>
        <input value={model} aria-label="Model ID" maxLength={200}
          onChange={(event) => { setModel(event.target.value); }} /></label>
      <label><span>Base URL（留空＝该协议默认端点）</span>
        <input value={baseUrl} aria-label="Base URL" placeholder="https://…/v1"
          onChange={(event) => { setBaseUrl(event.target.value); }} /></label>
    </div>
    <label><span>调用超时（秒，1–600）</span>
      <input value={timeoutSeconds} aria-label="调用超时秒数" inputMode="numeric" placeholder="30"
        onChange={(event) => { setTimeoutSeconds(event.target.value); }} /></label>
    <p className="helper-text">API Key 不变；更换凭据请用「轮换凭据」。改协议会改变配置指纹：旧验证结论失效，冻结在旧协议上的在途执行会停止。</p>
    {localError !== null && <p className="action-error" role="alert">{localError}</p>}
    <p className="settings-verify-actions">
      <button className="secondary-button" type="button" disabled={busy}
        data-testid="model-connection-edit-submit"
        onClick={() => {
          if (name.trim() === "") { setLocalError("请填写连接名称。"); return; }
          if (model.trim() === "") { setLocalError("请填写 Model ID。"); return; }
          const timeoutMs = timeoutMsFromSeconds(timeoutSeconds);
          if (timeoutMs === null) { setLocalError("调用超时需为 1–600 的整数秒。"); return; }
          setLocalError(null);
          void onSubmit({ name: name.trim(), protocol, defaultModel: model.trim(),
            baseUrl: baseUrl.trim() === "" ? null : baseUrl.trim(), timeoutMs });
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
    <h3>轮换凭据</h3>
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

/**
 * 可选预设只负责**预填已确认的配置**（协议 + 端点 + 名称建议），不代替用户确认型号，
 * 也不按品牌猜协议：协议是用户可见、可改的字段。
 */
const connectionPresets = [
  { id: "openai", label: "OpenAI", protocol: "openai-compatible",
    baseUrl: "https://api.openai.com/v1", modelHint: "例如 gpt-4o-mini" },
  { id: "anthropic", label: "Anthropic", protocol: "anthropic-messages",
    baseUrl: "https://api.anthropic.com/v1", modelHint: "例如 claude-sonnet-4-5" },
  { id: "deepseek", label: "DeepSeek", protocol: "openai-compatible",
    baseUrl: "https://api.deepseek.com/v1", modelHint: "例如 deepseek-chat" },
  { id: "openrouter", label: "OpenRouter", protocol: "openai-compatible",
    baseUrl: "https://openrouter.ai/api/v1", modelHint: "例如 openai/gpt-4o-mini" },
  // 星火只是自定义 OpenAI 兼容连接的预置模板，不新增枚举、不写死型号。
  { id: "spark", label: "讯飞星火（MaaS）", protocol: "openai-compatible",
    baseUrl: "https://maas-api.cn-huabei-1.xf-yun.com/v2", modelHint: "例如 spark-x2.6" },
  { id: "custom", label: "自定义", protocol: "openai-compatible", baseUrl: "",
    modelHint: "例如 provider/model-id" }
] as const;
type ConnectionPresetId = typeof connectionPresets[number]["id"];
type ConnectionProtocol = "openai-compatible" | "anthropic-messages";

const protocolLabels: Record<ConnectionProtocol, string> = {
  "openai-compatible": "OpenAI-Compatible",
  "anthropic-messages": "Anthropic"
};

/** 秒 → 毫秒；空串表示沿用服务端默认/原值，非法值返回 null 由表单报错。与迁移 CHECK 的 1–600 秒一致。 */
function timeoutMsFromSeconds(value: string): number | undefined | null {
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  const seconds = Number(trimmed);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 600) return null;
  return seconds * 1_000;
}

/**
 * 新增模型（MODEL-SETTINGS-03）：默认只问五件事——连接名称、API 格式、API Key、
 * Base URL、Model ID。超时与输出上限收进「高级设置」，默认值由服务端给出。
 *
 * 两条硬约束：
 *   1. **测试与保存互相独立**：测试只发一次草稿探针（不落任何事实），保存才建连接；
 *      两者的成功/失败各自反馈，谁也不冒充谁。
 *   2. **失败不清空已填内容**：只有保存成功才清空表单，失败时保留全部输入供重试。
 *      API Key 只在这个密码框里存在，不写 localStorage / sessionStorage。
 */
function CreateConnectionForm({ client, busy, onCreated, onCancel }: {
  readonly client: RelayApiClient;
  readonly busy: boolean;
  readonly onCreated: (name: string, id: string) => Promise<void>;
  readonly onCancel: () => void;
}) {
  const [preset, setPreset] = useState<ConnectionPresetId>("custom");
  const [protocol, setProtocol] = useState<ConnectionProtocol>("openai-compatible");
  const [name, setName] = useState("");
  const [model, setModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [timeoutSeconds, setTimeoutSeconds] = useState("");
  const [maxOutputTokens, setMaxOutputTokens] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [probing, setProbing] = useState(false);
  /** 草稿探针的独立反馈；与保存结果分开显示，避免「测试通过」被读成「已保存」。 */
  const [probe, setProbe] = useState<{ readonly ok: boolean;
    readonly message: string } | null>(null);
  const selectedPreset = connectionPresets.find((item) => item.id === preset)
    ?? connectionPresets[connectionPresets.length - 1];

  const timeoutValue = (): number | undefined | null => timeoutMsFromSeconds(timeoutSeconds);
  const maxOutputValue = (): number | undefined | null => {
    const trimmed = maxOutputTokens.trim();
    if (trimmed === "") return undefined;
    const value = Number(trimmed);
    return Number.isInteger(value) && value >= 256 && value <= 65_536 ? value : null;
  };
  const checkCommon = (): boolean => {
    if (model.trim() === "") { setLocalError("请填写 Model ID。"); return false; }
    if (apiKey.trim() === "") { setLocalError("请填写 API Key。"); return false; }
    if (timeoutValue() === null) { setLocalError("调用超时需为 1–600 的整数秒。"); return false; }
    if (maxOutputValue() === null) {
      setLocalError("最大输出 Token 需为 256–65536 的整数。"); return false;
    }
    return true;
  };
  const draft = {
    protocol,
    baseUrl: baseUrl.trim() === "" ? null : baseUrl.trim(),
    defaultModel: model.trim(),
    apiKey: apiKey.trim(),
    ...(timeoutValue() === undefined || timeoutValue() === null
      ? {} : { timeoutMs: timeoutValue() as number })
  };

  return <div className="settings-inline-form" data-testid="model-connection-create-form">
    <h3>新增连接</h3>
    <label className="settings-preset-field"><span>从预设填入（可选）</span>
      <select value={preset} aria-label="服务预设"
        onChange={(event) => {
          const nextId = event.target.value as ConnectionPresetId;
          const next = connectionPresets.find((item) => item.id === nextId)
            ?? connectionPresets[connectionPresets.length - 1];
          setPreset(nextId);
          setProtocol(next.protocol);
          setBaseUrl(next.baseUrl);
          // 星火实测一次 43 秒，30 秒预算会误判 MODEL_TIMEOUT；按连接预算放宽到 120 秒。
          if (next.id === "spark") setTimeoutSeconds("120");
          if (next.id !== "custom" && name.trim() === "") setName(next.label);
        }}>
        {connectionPresets.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
      </select></label>
    <div className="settings-form-row">
      <label><span>连接名称</span>
        <input value={name} aria-label="连接名称" maxLength={60} placeholder="例如 工作区主力模型"
          onChange={(event) => { setName(event.target.value); }} /></label>
      <label><span>API 格式</span>
        <select value={protocol} aria-label="API 格式" data-testid="model-connection-protocol"
          onChange={(event) => {
            const next = event.target.value as ConnectionProtocol;
            setProtocol(next);
            // 换协议时端点若仍是另一协议的默认值，同步换成新协议的默认值；
            // 用户自填的端点保持不动。
            const previous = connectionPresets.find((item) =>
              item.protocol === protocol && item.baseUrl === baseUrl.trim());
            if (previous !== undefined) {
              const nextPreset = connectionPresets.find((item) => item.protocol === next);
              if (nextPreset !== undefined) setBaseUrl(nextPreset.baseUrl);
            }
            setProbe(null);
          }}>
          <option value="openai-compatible">OpenAI-Compatible</option>
          <option value="anthropic-messages">Anthropic</option>
        </select></label>
    </div>
    <div className="settings-form-row">
      <label><span>Base URL</span>
        <input value={baseUrl} aria-label="Base URL" placeholder="https://…/v1"
          onChange={(event) => { setBaseUrl(event.target.value); setProbe(null); }} /></label>
      <label><span>Model ID</span>
        <input value={model} aria-label="Model ID" maxLength={200}
          placeholder={selectedPreset.modelHint}
          onChange={(event) => { setModel(event.target.value); setProbe(null); }} /></label>
    </div>
    <label><span>API Key</span>
      <input type="password" autoComplete="off" value={apiKey} aria-label="API Key"
        placeholder="只在保存时写入系统凭据库"
        onChange={(event) => { setApiKey(event.target.value); setProbe(null); }} /></label>
    <details className="settings-advanced" open={advancedOpen}
      onToggle={(event) => { setAdvancedOpen((event.target as HTMLDetailsElement).open); }}>
      <summary>高级设置</summary>
      <div className="settings-form-row">
        <label><span>调用超时（秒，默认 30）</span>
          <input value={timeoutSeconds} aria-label="调用超时秒数" inputMode="numeric"
            placeholder="30"
            onChange={(event) => { setTimeoutSeconds(event.target.value); }} /></label>
        <label><span>最大输出 Token（默认 8192）</span>
          <input value={maxOutputTokens} aria-label="最大输出 Token" inputMode="numeric"
            placeholder="8192"
            onChange={(event) => { setMaxOutputTokens(event.target.value); }} /></label>
      </div>
    </details>
    {localError !== null && <p className="action-error" role="alert">{localError}</p>}
    {probe !== null && <p className={probe.ok ? "helper-text" : "action-error"} role="status"
      data-testid="model-connection-probe-result">{probe.message}</p>}
    {saveError !== null && <p className="action-error" role="alert"
      data-testid="model-connection-create-error">{saveError}</p>}
    <p className="settings-verify-actions">
      <button className="secondary-button" type="button" disabled={busy || probing || saving}
        data-testid="model-connection-probe"
        onClick={() => {
          setLocalError(null); setSaveError(null); setProbe(null);
          if (!checkCommon()) return;
          setProbing(true);
          void client.probeModelConnection(draft)
            .then((result) => {
              setProbe({ ok: result.ok, message: result.ok
                ? `连接可用（${result.protocol === "anthropic-messages" ? "Anthropic" : "OpenAI 兼容"}，${result.latencyMs} ms）。这只是测试，尚未保存。`
                : `测试未通过：${result.errorCategory ?? "未知错误"}${result.message === null ? "" : ` · ${result.message}`}。已填内容保留，可修改后重试。` });
            })
            .catch((cause: unknown) => {
              setProbe({ ok: false, message: cause instanceof RelayApiError
                ? cause.message : "测试连接失败，请稍后重试。" });
            })
            .finally(() => { setProbing(false); });
        }}>{probing ? "测试中…" : "测试连接"}</button>
      <button className="primary-button" type="button" disabled={busy || probing || saving}
        data-testid="model-connection-create-submit"
        onClick={() => {
          setLocalError(null); setSaveError(null);
          if (name.trim() === "") { setLocalError("请填写连接名称。"); return; }
          if (!checkCommon()) return;
          setSaving(true);
          const created = { name: name.trim(), protocol, model: model.trim(),
            baseUrl: baseUrl.trim() === "" ? null : baseUrl.trim(), apiKey: apiKey.trim(),
            timeoutMs: timeoutValue() as number | undefined,
            maxOutputTokens: maxOutputValue() as number | undefined };
          void client.createModelConnection({ commandId: createCommandId(),
            name: created.name, protocol: created.protocol, baseUrl: created.baseUrl,
            defaultModel: created.model, timeoutMs: created.timeoutMs,
            maxOutputTokens: created.maxOutputTokens, apiKey: created.apiKey })
            .then(async (saved) => {
              // 只有成功才清空：失败时用户还要按原值重试。
              setName(""); setModel(""); setBaseUrl(""); setApiKey("");
              setTimeoutSeconds(""); setMaxOutputTokens(""); setProbe(null);
              await onCreated(saved.name, saved.id);
            })
            .catch((cause: unknown) => {
              setSaveError(cause instanceof RelayApiError ? cause.message
                : "创建连接失败；已填内容保留，可直接重试。");
            })
            .finally(() => { setSaving(false); });
        }}>{saving ? "保存中…" : "保存模型"}</button>
      <button className="secondary-button" type="button" onClick={onCancel}>取消</button>
    </p>
  </div>;
}
