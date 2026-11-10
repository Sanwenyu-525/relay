import { useEffect, useRef, useState } from "react";
import type { RelayApiClient } from "../api/relayClient";
import type { RelayAssistRecallUndo } from "../api/dtos/assist";
import { RelayApiError } from "../api/core/errors";
import { createCommandId } from "../api/core/command-id";
import { describeLiveError, needsReceiptCheck } from "../lib/liveErrors";

/** UI-RECALL-UNDO-20261105：取得原回执后挂载；刷新保留原命令身份，GET 不执行恢复。 */
export default function AssistRecallUndo({ client, recallId, eligible, disabledReason }: {
  client: RelayApiClient; recallId: string; eligible: boolean; disabledReason: string | null;
}) {
  const storageKey = `relay.recall-undo:${recallId}`;
  const active = useRef<RelayApiClient | null>(null);
  const running = useRef(false);
  const requestVersion = useRef(0);
  const [receipt, setReceipt] = useState<RelayAssistRecallUndo | null>(null);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(() => {
    try { return sessionStorage.getItem(storageKey); } catch { return null; }
  });

  function clearPending() {
    try { sessionStorage.removeItem(storageKey); } catch { /* 终态仍由服务端读回，不猜未执行。 */ }
    setPendingId(null);
  }

  function store(result: RelayAssistRecallUndo) {
    setReceipt(result);
    if (result.status !== "RUNNING") {
      clearPending();
    }
    setChecked(true);
    setError(null);
  }

  async function read() {
    const version = ++requestVersion.current;
    try {
      const result = await client.getAssistRecallUndo(recallId);
      if (active.current === client && version === requestVersion.current) store(result);
    } catch (caught) {
      if (active.current !== client || version !== requestVersion.current) return;
      if (caught instanceof RelayApiError && caught.problem.status === 404
        && caught.problem.code === "RESOURCE_NOT_FOUND") {
        setChecked(true);
        setError(null);
      } else {
        setChecked(false);
        setError(describeLiveError(caught).message);
      }
    }
  }

  useEffect(() => {
    active.current = client;
    void read();
    return () => { active.current = null; };
  }, [client, recallId]);

  async function submit() {
    if (running.current || !eligible || disabledReason !== null || !checked || receipt !== null) return;
    running.current = true;
    setBusy(true);
    setError(null);
    const commandId = pendingId ?? createCommandId();
    try {
      // 无法保存恢复身份就不外发；只存 UUID，不存目录、消息或凭据。
      sessionStorage.setItem(storageKey, commandId);
      setPendingId(commandId);
    } catch {
      running.current = false;
      setBusy(false);
      setError("浏览器无法保存撤销身份，尚未提交；请恢复会话存储后重试。");
      return;
    }
    const version = ++requestVersion.current;
    try {
      const result = await client.undoAssistRecall(recallId, commandId);
      if (active.current === client && version === requestVersion.current) store(result);
    } catch (caught) {
      if (active.current !== client) return;
      if (needsReceiptCheck(caught) || (caught instanceof RelayApiError
        && caught.problem.code === "RECALL_UNDO_IN_PROGRESS")) {
        setError("撤销结果待核对；请读取进度或按原命令重试。");
        await read();
      } else {
        clearPending();
        setError(describeLiveError(caught).message);
      }
    } finally {
      running.current = false;
      if (active.current === client) setBusy(false);
    }
  }

  const label = receipt?.status === "COMPLETED" ? "已撤销这次回退；文件已恢复到回退前状态。"
    : receipt?.status === "PARTIAL" ? "撤销部分完成，请核对逐文件结果。"
      : receipt?.status === "FAILED" ? "撤销未完成，请核对逐文件结果。"
        : receipt?.status === "RUNNING" ? "正在撤销这次回退，请核对实际进度。" : null;
  return <div data-testid={`assist-recall-undo-${recallId}`}>
    {label !== null && <p className="helper-text" role="status">{label}</p>}
    {receipt !== null && <ul className="assist-recall-files">
      {receipt.files.map((file) => <li key={file.path}><code>{file.path}</code>
        <span>{file.status === "RESTORED" || file.status === "ALREADY_RESTORED" ? "已恢复"
          : file.status === "CONFLICT" ? "冲突" : file.status === "UNAVAILABLE" ? "不可恢复"
            : file.status === "FAILED" ? "恢复失败" : file.status === "SKIPPED" ? "未执行" : file.status}</span>
        {file.reason !== null && <span className="helper-text">{file.reason}</span>}</li>)}
    </ul>}
    {receipt === null && checked && eligible && <button type="button" className="text-link"
      disabled={busy || disabledReason !== null} title={disabledReason ?? "只恢复本次回退的文件，不恢复任务完成状态"}
      onClick={() => void submit()} aria-busy={busy || undefined}>
      {busy ? "正在撤销…" : pendingId !== null ? "按原命令重试撤销" : "撤销这次回退"}</button>}
    {(!checked || pendingId !== null || receipt?.status === "RUNNING") && <button type="button"
      className="text-link" disabled={busy} onClick={() => void read()}>核对撤销进度</button>}
    {error !== null && <p className="action-error" role="alert">{error}</p>}
  </div>;
}
