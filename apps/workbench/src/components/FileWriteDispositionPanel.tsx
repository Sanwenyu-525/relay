import { useEffect, useRef, useState } from "react";
import AppDialog from "./AppDialog";
import FileWriteFrozenDiffPanel from "./FileWriteFrozenDiffPanel";
import { createCommandId, RelayApiError, RelayTransportError, type RelayApiClient,
  type RelayClosePartialFileWriteInput, type RelayFileWriteChangeSet,
  type RelayFileWriteDispositionPreview, type RelayFileWriteFrozenDiff } from "../api/relayClient";
import { describeLiveError } from "../lib/liveErrors";

const blockingLabels: Record<string, string> = {
  ACTION_NOT_UNKNOWN: "原动作或调用已不是待核对状态",
  PARTIAL_LEDGER_REQUIRED: "缺少匹配原调用的部分应用账本或无回执观察",
  TRUSTED_STOP_PROOF_REQUIRED: "缺少可信旧 Worker 停机证明",
  TRUSTED_STOP_PROOF_MISMATCH: "停机证明与原调用或投递不匹配",
  RESOURCE_NOT_QUARANTINED: "受管资源尚未保持隔离",
  OTHER_UNRESOLVED_ACTIONS: "旧 Run 仍有其他未决动作",
  RUN_STEP_ACTIVE: "旧 Run 仍有运行中的步骤",
  CURRENT_FILES_UNREADABLE: "当前文件无法安全回读",
  RUN_NOT_READY: "旧 Run 或任务尚未到达处置安全点"
};
function statusLabel(status: string): string {
  return ({ UNKNOWN: "待核对", PARTIAL: "部分应用", APPLIED: "账本记录已应用",
    CONFLICT: "冲突", FAILED: "失败", MANUALLY_CLOSED: "人工结清" } as Record<string, string>)[status] ?? status;
}

function pendingKey(client: RelayApiClient, operationId: string): string {
  return `relay:file-write-disposition:${client.baseUrl}:${client.workspaceId}:${operationId}`;
}
function readPending(key: string, operationId: string, runId: string): RelayClosePartialFileWriteInput | null {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(key) ?? "null");
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>;
    if (row.operationId !== operationId || row.runId !== runId ||
        typeof row.invocationId !== "string" || typeof row.commandId !== "string" ||
        typeof row.expectedRunRevision !== "string" || !/^\d+$/u.test(row.expectedRunRevision) ||
        typeof row.expectedTaskRevision !== "string" || !/^\d+$/u.test(row.expectedTaskRevision) ||
        typeof row.expectedObservationSha256 !== "string" ||
        !/^[0-9a-f]{64}$/u.test(row.expectedObservationSha256)) return null;
    return row as unknown as RelayClosePartialFileWriteInput;
  } catch { return null; }
}
function savePending(key: string, pending: RelayClosePartialFileWriteInput | null): boolean {
  try {
    if (pending) sessionStorage.setItem(key, JSON.stringify(pending));
    else sessionStorage.removeItem(key);
    return true;
  } catch { return false; }
}

export default function FileWriteDispositionPanel({ client, operationId, runId, runRevision, onFactsChanged }: {
  client: RelayApiClient; operationId: string; runId: string; runRevision: string;
  onFactsChanged: () => Promise<void>;
}) {
  const [ledgers, setLedgers] = useState<readonly RelayFileWriteChangeSet[]>([]);
  const [preview, setPreview] = useState<RelayFileWriteDispositionPreview | null>(null);
  const [frozenDiff, setFrozenDiff] = useState<RelayFileWriteFrozenDiff | null>(null);
  const [diffOpen, setDiffOpen] = useState(false);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const storageKey = pendingKey(client, operationId);
  const [pendingCommand, setPendingCommand] = useState<RelayClosePartialFileWriteInput | null>(
    () => readPending(storageKey, operationId, runId));
  const [mayRetry, setMayRetry] = useState(false);
  const requestVersion = useRef(0);
  const diffRequestVersion = useRef(0);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    diffRequestVersion.current++;
    setPendingCommand(readPending(storageKey, operationId, runId)); setMayRetry(false);
    setFrozenDiff(null); setDiffOpen(false); setDiffError(null); setDiffLoading(false);
    return () => { diffRequestVersion.current++; };
  }, [storageKey, operationId, runId]);

  useEffect(() => {
    const request = ++requestVersion.current;
    setLoading(true); setError(null); setPreview(null); setLedgers([]); setConfirming(false);
    void Promise.all([client.getFileWriteChangeSets(operationId),
      client.getFileWriteDispositionPreview(operationId)]).then(([nextLedgers, nextPreview]) => {
      if (request !== requestVersion.current) return;
      if (nextPreview.runId !== runId || (nextPreview.changeSetId !== null &&
        !nextLedgers.some((ledger) => ledger.id === nextPreview.changeSetId &&
          ledger.invocationId === nextPreview.invocationId))) {
        throw new Error("处置预览与本次 Run 的逐文件账本不匹配。");
      }
      setLedgers(nextLedgers); setPreview(nextPreview);
    }).catch((caught: unknown) => {
      if (request === requestVersion.current) setError(describeLiveError(caught).message);
    }).finally(() => { if (request === requestVersion.current) setLoading(false); });
    return () => { requestVersion.current++; };
  }, [client, operationId, runId, runRevision, reload]);

  async function refreshFacts() {
    setReload((value) => value + 1);
    await onFactsChanged();
  }

  async function showFrozenDiff() {
    if (diffLoading) return;
    if (frozenDiff) { setDiffOpen((value) => !value); return; }
    const request = ++diffRequestVersion.current;
    setDiffOpen(true); setDiffLoading(true); setDiffError(null);
    try {
      const result = await client.getFileWriteFrozenDiff(operationId);
      if (request === diffRequestVersion.current) setFrozenDiff(result);
    } catch (caught) {
      if (request === diffRequestVersion.current) setDiffError(describeLiveError(caught).message);
    } finally { if (request === diffRequestVersion.current) setDiffLoading(false); }
  }

  async function sendCommand(command: RelayClosePartialFileWriteInput, retry: boolean) {
    if (submitting || retry && (!mayRetry || pendingCommand?.commandId !== command.commandId)) return;
    if (!retry && !savePending(storageKey, command)) {
      setError("无法暂存原处置命令，尚未发送。请检查浏览器会话存储后重试。"); return;
    }
    setPendingCommand(command); setMayRetry(false); setSubmitting(true); setConfirming(false); setError(null); setMessage(null);
    try {
      await client.closePartialFileWrite(command);
    } catch (caught) {
      if (caught instanceof RelayTransportError || caught instanceof RelayApiError &&
          (caught.problem.status >= 500 || caught.problem.code === "COMMAND_ID_REUSED")) {
        setError("处置响应无法核对；先查询原 command_id 回执。只有明确未找到后，才可用原 ID 和原载荷重试。");
      } else {
        savePending(storageKey, null); setPendingCommand(null);
        setError(describeLiveError(caught).message);
        if (caught instanceof RelayApiError && caught.problem.status === 409) {
          try { await refreshFacts(); }
          catch (refreshError) { setError(`处置未受理，最新事实读取失败：${describeLiveError(refreshError).message}`); }
        }
      }
      setSubmitting(false); return;
    }
    savePending(storageKey, null); setPendingCommand(null); setSubmitting(false);
    setMessage("原 FILE_WRITE 已人工结清；保留当前文件，旧 Run 记为失败。正在重新查询任务和证据。");
    try { await refreshFacts(); }
    catch (caught) { setError(`命令已结清，但最新事实读取失败：${describeLiveError(caught).message}`); }
  }

  async function submit() {
    if (!preview?.canDispose || !preview.invocationId || !preview.observationSha256 ||
        loading || submitting || pendingCommand) return;
    await sendCommand({ operationId, invocationId: preview.invocationId,
      runId, commandId: createCommandId(), expectedRunRevision: preview.runRevision,
      expectedTaskRevision: preview.taskRevision,
      expectedObservationSha256: preview.observationSha256 }, false);
  }

  async function checkReceipt() {
    if (!pendingCommand || submitting) return;
    setSubmitting(true); setMayRetry(false);
    try {
      const receipt = await client.getCommandReceipt(pendingCommand.commandId);
      if (receipt.commandId !== pendingCommand.commandId || receipt.commandType !== "ClosePartialFileWrite" ||
          receipt.result.operation_id !== operationId || receipt.result.invocation_id !== pendingCommand.invocationId ||
          receipt.result.run_id !== runId ||
          receipt.result.run_status !== "FAILED" ||
          receipt.result.decision !== "KEEP_CURRENT_AND_FAIL_RUN") {
        setError("原命令回执与本次处置不匹配；结果仍待核对。"); return;
      }
      savePending(storageKey, null); setPendingCommand(null); setError(null);
      setMessage("已找到原命令回执；保留当前文件，旧 Run 记为失败。正在重新读取任务与证据。");
      await refreshFacts();
    } catch (caught) {
      if (caught instanceof RelayApiError && caught.problem.code === "COMMAND_NOT_FOUND") {
        setMayRetry(true);
        setError("服务端明确未找到原命令；可继续查询，或用同一个 command_id 和冻结载荷重试。");
      } else setError(describeLiveError(caught).message);
    }
    finally { setSubmitting(false); }
  }

  return <div data-testid={`file-write-disposition-${operationId}`}>
    <button className="secondary-button" type="button" disabled={loading || submitting}
      onClick={() => setReload((value) => value + 1)}>刷新逐文件证据</button>
    <button className="secondary-button" type="button" disabled={diffLoading}
      data-testid="file-write-diff-open" onClick={() => void showFrozenDiff()}>
      {diffOpen && frozenDiff ? "收起冻结计划差异" : "查看冻结计划差异"}
    </button>
    {diffLoading && <p className="helper-text" role="status">正在读取冻结计划文本差异。</p>}
    {diffError && <p className="action-error" role="alert">文本差异读取失败：{diffError}</p>}
    {diffOpen && frozenDiff && <FileWriteFrozenDiffPanel diff={frozenDiff} ledgers={ledgers} />}
    {loading && <p className="helper-text" role="status">正在读取原账本与当前文件摘要。</p>}
    {error && <p className="action-error" role="alert">{error}</p>}
    {message && <p className="receipt-message" role="status">{message}</p>}
    {pendingCommand && <p className="helper-text">原 command_id：{pendingCommand.commandId} <button className="secondary-button" type="button"
      disabled={submitting} onClick={() => void checkReceipt()}>查询原命令回执</button>{mayRetry && <button
        className="secondary-button" type="button" data-testid="file-write-dispose-retry" disabled={submitting}
        onClick={() => void sendCommand(pendingCommand, true)}>用原 ID 和载荷重试</button>}</p>}
    {!loading && ledgers.map((ledger) => <div key={ledger.id} data-testid="file-write-ledger">
      <p><strong>逐文件账本：{ledger.status}（{statusLabel(ledger.status)}）</strong> · change_set_id：{ledger.id} · 原 invocation_id：{ledger.invocationId}</p>
      <ul className="run-list">{ledger.files.map((file) => <li key={file.relativePath}>
        {file.relativePath} · {file.action} · 账本 {file.status}（{statusLabel(file.status)}）{file.error && <> · 错误 {file.error}</>}
      </li>)}</ul>
    </div>)}
    {!loading && preview && <div data-testid="file-write-preview">
      <p>原 Operation：{preview.operationStatus}（{statusLabel(preview.operationStatus)}） · 停机证明：{preview.stopProofRecorded ? "已记录" : "未记录"}</p>
      {preview.observationMode === "NO_RECEIPT" && <p className="action-error">原助手没有留下执行回执。下列目标和候选残留只是当前磁盘观察，不能归因于原调用；程序不会自动移动或删除它们。</p>}
      {preview.disposition ? <><p>人工处置：保留当时文件并结束旧 Run · {preview.disposition.createdAt} · 当时观察 sha256 {preview.disposition.observationSha256}。不能据此认定所有文件均已写入。</p>
        <ul className="run-list">{preview.disposition.observationFiles.map((file) => <li key={file.path}>
          {file.path} · 当时账本 {file.ledgerStatus}（{statusLabel(file.ledgerStatus)}） · 当时文件 {file.currentSha256 ?? "不存在"}
          <div>当时账本实际 sha256：{file.ledgerActualSha256 ?? "无"}</div>
          {preview.disposition?.observationMode === "NO_RECEIPT" && <><div>当时目标 File ID：{file.currentTargetId ?? "不存在"}</div>
            <div>当时候选残留（不归因于原调用）：{file.residualCandidates.length === 0 ? "无" : ""}</div>
            <ul className="run-list">{file.residualCandidates.map((candidate) => <li key={candidate.path}>
              {candidate.path} · File ID {candidate.id ?? "不可用"} · sha256 {candidate.sha256 ?? "不可用"} · {candidate.status}
            </li>)}</ul></>}
        </li>)}</ul></>
        : <><p>当前文件观察 sha256：{preview.observationSha256 ?? "无法安全计算"}。当前摘要是读取时的状态，不能据此认定原动作已完成全部文件。</p>
          <ul className="run-list">{preview.files.map((file) => <li key={file.relativePath}>
            {file.relativePath} · 账本 {file.ledgerStatus}（{statusLabel(file.ledgerStatus)}） · 当前 {file.readable ? (file.currentSha256 ?? "文件不存在") : "不可读取"}
            <div>账本实际 sha256：{file.ledgerActualSha256 ?? "无"}</div>
            {preview.observationMode === "NO_RECEIPT" && <><div>当前目标 File ID：{file.currentTargetId ?? "不存在"}</div>
              <div>候选残留（不归因于原调用）：{file.residualCandidates.length === 0 ? "无" : ""}</div>
              <ul className="run-list">{file.residualCandidates.map((candidate) => <li key={candidate.path}>
                {candidate.path} · File ID {candidate.id ?? "不可用"} · sha256 {candidate.sha256 ?? "不可用"} · {candidate.status}
              </li>)}</ul></>}
          </li>)}</ul>
          {preview.blockingReasons.length > 0 && <p className="disabled-reason">处置受阻：{preview.blockingReasons.map((reason) => `${blockingLabels[reason] ?? reason}（${reason}）`).join("、")}</p>}
          {preview.canDispose && !pendingCommand && <button className="danger-button" type="button"
            data-testid="file-write-dispose-open" disabled={loading || submitting}
            onClick={() => setConfirming(true)}>{preview.observationMode === "NO_RECEIPT"
              ? "保留当前目标与候选残留并结束旧 Run" : "保留当前文件并结束旧 Run"}</button>}</>}
    </div>}
    <AppDialog open={confirming && preview?.canDispose === true} title={preview?.observationMode === "NO_RECEIPT"
      ? "确认人工结清无回执文件写入" : "确认人工结清部分文件写入"}
      initialFocusSelector='[data-testid="file-write-dispose-cancel"]'
      onClose={() => { if (!submitting) setConfirming(false); }}>
      <p>{preview?.observationMode === "NO_RECEIPT"
        ? "原调用没有执行回执。你将保留当前目标与列出的候选残留，不自动修复文件；仅结束旧 Run、将任务交还人工。候选文件不能归因于原调用。"
        : "将保留当前文件内容，把原 FILE_WRITE 动作人工结清，并将旧 Run 记为失败；任务回到待执行。不能据此认定原动作已完成全部文件。"}</p>
      <p>原 operation_id：{operationId}<br />原 invocation_id：{preview?.invocationId}<br />当前观察 sha256：{preview?.observationSha256}</p>
      <div className="run-actions"><button className="secondary-button" type="button" data-testid="file-write-dispose-cancel"
        onClick={() => setConfirming(false)}>返回核对</button>
        <button className="danger-button" type="button" data-testid="file-write-dispose-confirm"
          disabled={submitting || loading || !preview?.canDispose || !preview.invocationId || !preview.observationSha256}
          onClick={() => void submit()}>确认保留当前文件并结束旧 Run</button></div>
    </AppDialog>
  </div>;
}
