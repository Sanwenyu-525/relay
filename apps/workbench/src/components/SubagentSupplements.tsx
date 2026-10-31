import { useEffect, useRef, useState } from "react";
import { RelayApiError, type RelayApiClient, type RelaySubagentSupplement } from "../api/relayClient";
import { subagentSupplementResultFrom } from "../api/resources/subagentSupplements";
import { describeLiveError } from "../lib/liveErrors";
import "./SessionDelegations.css";

type Client = Pick<RelayApiClient, "workspaceId" | "getSubagentSupplements" | "supplementSubagent">
  & Partial<Pick<RelayApiClient, "getCommandReceipt">>;
interface Props {
  readonly client: Client;
  readonly sessionId: string;
  readonly child?: boolean;
  readonly refreshKey?: string;
  readonly onRecorded?: () => void;
}
interface Pending { readonly commandId: string; readonly content: string }
function readStored(key: string): Pending | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) ?? "null") as Pending | null;
    return value !== null && typeof value.commandId === "string" && typeof value.content === "string"
      ? value : null;
  } catch { return null; }
}

export default function SubagentSupplements(props: Props) {
  if (props.client.getSubagentSupplements === undefined) return null;
  return <SupplementContent key={`${props.client.workspaceId}:${props.sessionId}`} {...props} />;
}

function SupplementContent({ client, sessionId, child = false, refreshKey = "", onRecorded }: Props) {
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const key = `relay:subagent-supplement:${client.workspaceId}:${sessionId}`;
  const [pending, setPending] = useState<Pending | null>(() => readStored(key));
  const [draft, setDraft] = useState(() => sessionStorage.getItem(`${key}:draft`) ?? "");
  const [items, setItems] = useState<readonly RelaySubagentSupplement[]>([]);
  const [readError, setReadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [missingReceipt, setMissingReceipt] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let alive = true;
    let timer: number | undefined;
    async function read() {
      try {
        const next = await client.getSubagentSupplements!(sessionId);
        if (!alive) return;
        setItems(next); setReadError(null);
        if (next.some((item) => item.parentSeenAt === null ||
            (item.childSeenAt === null && item.delegationStatus === "RUNNING"))) {
          timer = window.setTimeout(() => void read(), 2500);
        }
      } catch (caught) { if (alive) setReadError(describeLiveError(caught).message); }
    }
    void read();
    return () => { alive = false; window.clearTimeout(timer); };
  }, [client, sessionId, reload, refreshKey]);

  function confirmed() {
    sessionStorage.removeItem(key); sessionStorage.removeItem(`${key}:draft`);
    if (!active.current) return;
    setPending(null); setDraft(""); setError(null); setMissingReceipt(false);
    setReload((value) => value + 1); onRecorded?.();
  }

  async function send(retry?: Pending) {
    if (busy || client.supplementSubagent === undefined) return;
    const request = retry ?? { commandId: crypto.randomUUID(), content: draft };
    if (request.content.trim() === "") return;
    sessionStorage.setItem(key, JSON.stringify(request));
    setPending(request); setBusy(true); setError(null); setMissingReceipt(false);
    try {
      await client.supplementSubagent({ childSessionId: sessionId, ...request });
      confirmed();
    } catch (caught) {
      // A prior ambiguous attempt stays pending even if a later retry is rejected.
      if (retry === undefined && caught instanceof RelayApiError && caught.problem.status < 500) {
        sessionStorage.removeItem(key); setPending(null);
      }
      setError(describeLiveError(caught).message);
    } finally { setBusy(false); }
  }

  async function checkReceipt() {
    if (pending === null || client.getCommandReceipt === undefined || busy) return;
    setBusy(true); setError(null);
    try {
      const receipt = await client.getCommandReceipt(pending.commandId);
      if (receipt.commandId !== pending.commandId || receipt.commandType !== "SupplementSubagent") {
        throw new Error("补充回执身份不匹配，请保留原请求核对。");
      }
      subagentSupplementResultFrom(receipt.result, sessionId);
      confirmed();
    } catch (caught) {
      if (caught instanceof RelayApiError && caught.problem.status === 404) {
        setMissingReceipt(true); setError("暂未查到原请求回执，可按原请求重试。");
      } else setError(describeLiveError(caught).message);
    } finally { setBusy(false); }
  }

  if (!child && items.length === 0 && readError === null) return null;
  return <section className="subagent-supplements" data-testid="subagent-supplements">
    <details open={child || undefined}>
      <summary>子任务补充{items.length > 0 ? ` · ${items.length} 条` : ""}</summary>
      {readError !== null && <p role="alert">补充记录读取失败：{readError}
        <button type="button" className="text-button" onClick={() => setReload((value) => value + 1)}>重试读取</button></p>}
      <ul className="session-delegations-list">
        {items.map((item) => <li className="session-delegations-item" key={item.id} data-testid="subagent-supplement">
          <p className="session-delegations-result">{item.content}</p>
          <p className="helper-text">已记录 · {item.parentSeenAt === null ? "主会话待读取" : "主会话已读取"}
            {" · "}{item.childSeenAt !== null ? "子任务已读取"
              : item.delegationStatus === "RUNNING" || item.delegationStatus === "QUEUED"
                ? "子任务待下轮读取" : "子任务已结束，补充待主会话处理"}</p>
          {item.childSeenAt === null && item.delegationStatus === "SUCCEEDED" &&
            <p className="helper-text">此前返回的结果未覆盖这条补充。</p>}
        </li>)}
      </ul>
    </details>
    {child && client.supplementSubagent !== undefined && <div className="subagent-supplement-form">
      <label>补充子任务要求<textarea data-testid="subagent-supplement-draft" value={pending?.content ?? draft}
        maxLength={32768} disabled={busy || pending !== null} rows={3} onChange={(event) => {
          setDraft(event.target.value); sessionStorage.setItem(`${key}:draft`, event.target.value);
        }} /></label>
      <p className="helper-text">补充会同步主会话。运行中的子任务在下一轮读取；已结束的子任务不会自动重跑。</p>
      {error !== null && <p role="alert">{error}</p>}
      {pending === null ? <button type="button" className="secondary-button"
        data-testid="subagent-supplement-send" disabled={busy || draft.trim() === ""}
        onClick={() => void send()}>发送补充</button>
        : <div aria-live="polite"><p>{busy ? "正在核对补充…" : "补充结果待核对，请保留原请求。"}</p>
          <button type="button" className="secondary-button" data-testid="subagent-supplement-check"
            disabled={busy || client.getCommandReceipt === undefined} onClick={() => void checkReceipt()}>核对原请求</button>
          {missingReceipt && <button type="button" className="secondary-button"
            data-testid="subagent-supplement-retry" disabled={busy}
            onClick={() => void send(pending)}>按原请求重试</button>}</div>}
    </div>}
  </section>;
}
