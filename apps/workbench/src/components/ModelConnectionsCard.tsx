import { useState } from "react";
import { KeyRound, Plug, RotateCcw, ShieldCheck } from "lucide-react";

import { createCommandId, RelayApiError, type RelayApiClient } from "../api/relayClient";
import type { RelayModelConnection } from "../api/dtos/information";

/**
 * 模型连接登记（ADR-036）。
 *
 * 三条界面纪律：
 *   1. **作用域必须说清**：默认连接只决定**新的任务执行（Run）**用哪条连接冻结模型身份；
 *      会话聊天仍按会话选择或进程默认。不写清楚，用户会以为改了默认就换了聊天模型。
 *   2. **不冒充已验证/可执行**：这里只展示「已登记 / 已停用 / 凭据代数」，验证仍走上面那张
 *      连接状态卡（它按目标给出 13 态）。登记成功不等于能跑通。
 *   3. **凭据只进不出**：Key 只在一个密码框里出现一次，提交后服务端只留不透明引用；
 *      界面既不回显也不保存，刷新后只剩「凭据代数」。
 *
 * 懒加载：默认折叠，点「管理连接」才发请求——设置页其他卡片不该为一张未展开的表付代价。
 */
export function ModelConnectionsCard({ client }: { readonly client: RelayApiClient }) {
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connections, setConnections] = useState<readonly RelayModelConnection[]>([]);
  const [defaultId, setDefaultId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [rotatingId, setRotatingId] = useState<string | null>(null);

  async function load(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const [items, fallback] = await Promise.all([
        client.listModelConnections(),
        client.getDefaultModelConnection()
      ]);
      setConnections(items);
      setDefaultId(fallback.connectionId);
    } catch (cause) {
      setError(cause instanceof RelayApiError ? cause.message : "读取模型连接失败。");
    } finally {
      setLoading(false);
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

  if (!expanded) {
    return <section className="surface-panel settings-card" data-testid="model-connections">
      <h2>模型连接</h2>
      <p className="helper-text">登记多条 OpenAI 兼容连接（端点、确切型号、调用预算），
        凭据保存在系统凭据库，业务库里只有不透明引用。</p>
      <p className="helper-text">默认连接只影响**新的任务执行**：Run 冻结时会记住这条连接；
        会话聊天仍按会话选择或进程默认，两者互不改写。</p>
      <p className="settings-verify-actions">
        <button className="secondary-button" type="button" data-testid="model-connections-open"
          onClick={() => { void open(); }}>
          <Plug aria-hidden="true" />管理连接</button>
      </p>
    </section>;
  }

  return <section className="surface-panel settings-card" data-testid="model-connections">
    <h2>模型连接</h2>
    <p className="helper-text">默认连接只影响新的任务执行；会话聊天仍按会话选择或进程默认。
      登记成功不等于验证通过，连接是否可用见上方「连接与模型状态」。</p>
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
        还没有登记任何连接。未登记时新的任务执行仍走进程默认模型。</p>}

    {connections.length > 0 && <dl className="settings-definition-list">
      {connections.map((connection) => <div key={connection.id}
        data-testid={`model-connection-${connection.id}`}>
        <dt>{connection.name}
          {defaultId === connection.id && <span className="status-chip status-chip--neutral"
            data-testid="model-connection-default-badge">默认</span>}</dt>
        <dd>
          <span className={`status-chip status-chip--${
            connection.status === "ACTIVE" ? "success" : "warning"}`}>
            {connection.status === "ACTIVE" ? "已启用" : "已停用"}</span>
          {" "}
          <code className="hash-code">{connection.defaultModel}</code>
          {" · "}
          {connection.baseUrl === null ? "内置默认端点" : connection.baseUrl}
          {" · 凭据第 "}{connection.credentialVersion}{" 代"}
          <span className="settings-connection-actions">
            {defaultId !== connection.id && <button className="secondary-button" type="button"
              data-testid={`model-connection-default-${connection.id}`}
              disabled={busyId !== null || connection.status !== "ACTIVE"}
              onClick={() => { void act(connection.id, async () => {
                await client.setDefaultModelConnection(connection.id, createCommandId());
                setNotice(`已把「${connection.name}」设为默认连接；已创建的 Run 不受影响。`);
              }); }}>设为默认</button>}
            <button className="secondary-button" type="button"
              data-testid={`model-connection-status-${connection.id}`}
              disabled={busyId !== null}
              onClick={() => { void act(connection.id, async () => {
                await client.setModelConnectionStatus(connection.id, {
                  commandId: createCommandId(),
                  expectedRevision: connection.revision,
                  status: connection.status === "ACTIVE" ? "DISABLED" : "ACTIVE"
                });
                setNotice(connection.status === "ACTIVE"
                  ? `已停用「${connection.name}」；已冻结在它上面的 Run 会停止，不再发起新调用。`
                  : `已启用「${connection.name}」。`);
              }); }}>{connection.status === "ACTIVE" ? "停用" : "启用"}</button>
            <button className="secondary-button" type="button"
              data-testid={`model-connection-rotate-${connection.id}`}
              disabled={busyId !== null}
              onClick={() => { setRotatingId(rotatingId === connection.id ? null : connection.id); }}>
              <KeyRound aria-hidden="true" />轮换凭据</button>
          </span>
          {rotatingId === connection.id && <RotateCredentialForm
            connection={connection} busy={busyId !== null}
            onSubmit={async (apiKey) => {
              await act(connection.id, async () => {
                await client.rotateModelConnectionCredential(connection.id, {
                  commandId: createCommandId(),
                  expectedRevision: connection.revision,
                  apiKey
                });
                setRotatingId(null);
                setNotice(`已轮换「${connection.name}」的凭据；凭据代数 +1，`
                  + "冻结在旧代数上的 Run 会停止。");
              });
            }}
            onCancel={() => { setRotatingId(null); }} />}
        </dd>
      </div>)}
    </dl>}

    {formOpen
      ? <CreateConnectionForm client={client} busy={busyId !== null}
        onCreated={async (name) => {
          setFormOpen(false);
          setNotice(`已登记「${name}」。它还不是默认连接，也不会自动用于执行。`);
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

/** 新增连接：服务端会先落秘密再落行；失败时不会留下孤儿凭据。 */
function CreateConnectionForm({ client, busy, onCreated, onCancel }: {
  readonly client: RelayApiClient;
  readonly busy: boolean;
  readonly onCreated: (name: string) => Promise<void>;
  readonly onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [model, setModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  return <div className="settings-inline-form" data-testid="model-connection-create-form">
    <label><span>名称</span>
      <input value={name} aria-label="连接名称" maxLength={60}
        onChange={(event) => { setName(event.target.value); }} /></label>
    <label><span>确切型号</span>
      <input value={model} aria-label="确切型号" maxLength={200}
        placeholder="例如 provider/model-id"
        onChange={(event) => { setModel(event.target.value); }} /></label>
    <label><span>服务端点（可留空＝内置默认端点）</span>
      <input value={baseUrl} aria-label="服务端点" placeholder="https://…/v1"
        onChange={(event) => { setBaseUrl(event.target.value); }} /></label>
    <label><span>API Key</span>
      <input type="password" autoComplete="off" value={apiKey} aria-label="API Key"
        onChange={(event) => { setApiKey(event.target.value); }} /></label>
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
