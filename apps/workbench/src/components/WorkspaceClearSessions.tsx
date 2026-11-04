import { useCallback, useRef, useState } from "react";
import { BrushCleaning, LoaderCircle } from "lucide-react";
import AppDialog from "./AppDialog";
import { Toast } from "./Feedback";
import { createCommandId, type RelayApiClient, type RelayAssistSession } from "../api/relayClient";
import { describeLiveError } from "../lib/liveErrors";
import { usePathTooltip } from "../lib/pathTooltip";
import {
  deleteSessionAndVerify,
  verifyDeleteReceipt,
  type SessionDeleteOutcome
} from "../lib/sessionDelete";

/**
 * 「清空该工作区会话」的唯一 UI 入口（2026-11-04）。
 *
 * 语义与边界：
 * * **清空 = 逐条走既有 DeleteAssistSession 命令**，不新写数据库入口，也不在界面里维护
 *   第二份「已删除」状态。服务端仍按产物、验收记录等引用关系拒绝删除，被拒绝的会话
 *   保留并逐条说明原因。
 * * **范围 = 当前连接工作区的近工作栏会话**（`taskId` 与 `parentSessionId` 都为空）。
 *   任务执行会话与临时委派子会话不属于左栏讨论，不在这里删除；`workspaceId` 由
 *   `RelayApiClient` 固定，请求路径天然只指向当前工作区。
 * * **不可撤销**，因此点击后先读一次当前事实、显示确切条数，再由用户二次确认。
 *
 * 结果四态沿用 `sessionDelete`：删除成功、被业务引用阻断、明确失败、结果未确认。
 * 结果未确认只核对原 `command_id` 的回执，绝不换新命令重复删除。
 */

const TOOLTIP_TEXT = "该操作会清空该工作区所有会话";

type Phase = "idle" | "loading" | "confirm" | "running" | "empty" | "error" | "result";

interface RowResult {
  readonly session: RelayAssistSession;
  readonly outcome: SessionDeleteOutcome;
}

export default function WorkspaceClearSessions({ client, onCleared }: {
  readonly client: RelayApiClient;
  /** 只传服务端已确认删除的会话 id：外壳据此刷新左栏，并在当前会话被删时切到新对话。 */
  readonly onCleared: (deletedSessionIds: readonly string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [targets, setTargets] = useState<readonly RelayAssistSession[]>([]);
  const [results, setResults] = useState<readonly RowResult[]>([]);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [errorText, setErrorText] = useState("");
  const [toastText, setToastText] = useState<string | null>(null);
  const [rechecking, setRechecking] = useState<string | null>(null);
  const [recheckNote, setRecheckNote] = useState<string | null>(null);
  const running = useRef(false);
  const { tooltipHandlers, tooltipNode, dismissTooltip } = usePathTooltip(
    () => TOOLTIP_TEXT, "workspace-clear-tooltip");

  const resetDialog = useCallback(() => {
    if (running.current) return;
    setOpen(false);
    setPhase("idle");
    setTargets([]);
    setResults([]);
    setErrorText("");
    setRecheckNote(null);
  }, []);

  const readTargets = useCallback(async () => {
    if (running.current) return;
    dismissTooltip();
    setOpen(true);
    setToastText(null);
    setPhase("loading");
    setTargets([]);
    setResults([]);
    setErrorText("");
    setRecheckNote(null);
    try {
      const sessions = await client.getAssistSessions({ status: "ALL" });
      const clearable = sessions.filter((session) =>
        session.taskId === null && (session.parentSessionId ?? null) === null);
      setTargets(clearable);
      setPhase(clearable.length === 0 ? "empty" : "confirm");
    } catch (caught) {
      setErrorText(describeLiveError(caught).message);
      setPhase("error");
    }
  }, [client, dismissTooltip]);

  const run = useCallback(async () => {
    if (running.current || targets.length === 0) return;
    running.current = true;
    setPhase("running");
    setProgress({ done: 0, total: targets.length });
    setResults([]);
    const collected: RowResult[] = [];
    for (const session of targets) {
      const outcome = await deleteSessionAndVerify(client, session, createCommandId());
      collected.push({ session, outcome });
      setProgress({ done: collected.length, total: targets.length });
    }
    running.current = false;
    setResults(collected);
    const deletedIds = collected
      .filter((item) => item.outcome.state === "deleted")
      .map((item) => item.session.id);
    if (deletedIds.length > 0) onCleared(deletedIds);
    if (deletedIds.length === collected.length) {
      setOpen(false);
      setPhase("idle");
      setTargets([]);
      setToastText(`已清空 ${deletedIds.length} 条会话`);
      return;
    }
    setPhase("result");
  }, [client, onCleared, targets]);

  const recheck = useCallback(async (item: RowResult) => {
    if (item.outcome.state !== "unresolved" || rechecking !== null) return;
    setRechecking(item.outcome.commandId);
    setRecheckNote(null);
    const verdict = await verifyDeleteReceipt(client, item.outcome.commandId);
    setRechecking(null);
    if (verdict === "deleted") {
      setResults((current) => current.map((row) => row === item
        ? { ...row, outcome: { state: "deleted", viaReceipt: true } } : row));
      onCleared([item.session.id]);
      setRecheckNote(`已确认「${item.session.title}」删除成功。`);
    } else {
      setRecheckNote("仍未查到这条命令的回执：服务端可能还在处理。请稍后再核对，不要重复删除。");
    }
  }, [client, onCleared, rechecking]);

  const busy = phase === "loading" || phase === "running";
  const deletedCount = results.filter((item) => item.outcome.state === "deleted").length;
  const blocked = results.filter((item) => item.outcome.state === "blocked");
  const failed = results.filter((item) => item.outcome.state === "failed");
  const unresolved = results.filter((item) => item.outcome.state === "unresolved");

  return (
    <>
      <button className="icon-button context-rail-clear-sessions" type="button"
        data-testid="workspace-clear-sessions"
        aria-label="清空该工作区会话：该操作会清空该工作区所有会话"
        aria-busy={busy || undefined}
        disabled={busy}
        {...tooltipHandlers}
        onClick={() => void readTargets()}>
        {busy
          ? <LoaderCircle className="workspace-clear-spin" aria-hidden="true" />
          : <BrushCleaning aria-hidden="true" />}
      </button>
      {tooltipNode}
      {toastText !== null && <Toast testId="workspace-clear-success">{toastText}</Toast>}
      <AppDialog open={open} title="清空该工作区会话"
        subtitle="仅影响当前工作区，不影响其他工作区"
        onClose={resetDialog}>
        {phase === "loading" && <p className="helper-text" data-testid="workspace-clear-loading">正在读取该工作区的会话…</p>}
        {phase === "empty" && (
          <>
            <p data-testid="workspace-clear-empty">当前工作区没有可清空的会话。</p>
            <div className="dialog-actions">
              <button className="primary-button" type="button" data-testid="workspace-clear-done"
                onClick={resetDialog}>知道了</button>
            </div>
          </>
        )}
        {phase === "error" && (
          <>
            <p role="alert" data-testid="workspace-clear-error">{errorText}</p>
            <div className="dialog-actions">
              <button className="secondary-button" type="button" onClick={resetDialog}>取消</button>
              <button className="primary-button" type="button" data-testid="workspace-clear-retry"
                onClick={() => void readTargets()}>重试读取</button>
            </div>
          </>
        )}
        {phase === "confirm" && (
          <>
            <p>将永久删除当前工作区的 <strong data-testid="workspace-clear-count">{targets.length}</strong> 条会话（含已归档讨论）。</p>
            <p className="helper-text">
              只处理当前工作区。任务执行会话与临时委派子会话不在清空范围内。
              删除不可撤销；仍被产物、验收记录或其他业务对象引用的会话会被服务端拒绝并保留。
            </p>
            <div className="dialog-actions">
              <button className="secondary-button" type="button" data-testid="workspace-clear-cancel"
                onClick={resetDialog}>取消</button>
              <button className="danger-button" type="button" data-testid="workspace-clear-confirm"
                onClick={() => void run()}>清空 {targets.length} 条会话</button>
            </div>
          </>
        )}
        {phase === "running" && (
          <p data-testid="workspace-clear-progress">
            正在清空 {progress.done}/{progress.total} 条会话…
          </p>
        )}
        {phase === "result" && (
          <>
            <p data-testid="workspace-clear-summary">
              已清空 {deletedCount} 条会话。
              {blocked.length > 0 ? ` ${blocked.length} 条被业务引用保留。` : ""}
              {failed.length > 0 ? ` ${failed.length} 条被服务端拒绝。` : ""}
              {unresolved.length > 0 ? ` ${unresolved.length} 条结果未确认。` : ""}
            </p>
            {blocked.length > 0 && (
              <ul className="workspace-clear-list" data-testid="workspace-clear-blocked">
                {blocked.map((item) => item.outcome.state === "blocked" && (
                  <li key={item.session.id}><span>{item.session.title}</span>：{item.outcome.reasons.join("；")}</li>
                ))}
              </ul>
            )}
            {failed.length > 0 && (
              <ul className="workspace-clear-list" data-testid="workspace-clear-failed">
                {failed.map((item) => item.outcome.state === "failed" && (
                  <li key={item.session.id}><span>{item.session.title}</span>：{item.outcome.message}</li>
                ))}
              </ul>
            )}
            {unresolved.length > 0 && (
              <ul className="workspace-clear-list" data-testid="workspace-clear-unresolved">
                {unresolved.map((item) => item.outcome.state === "unresolved" && (
                  <li key={item.session.id}>
                    <span>{item.session.title}</span>：这次删除是否生效还没有确定。
                    <button className="text-button" type="button"
                      data-testid={`workspace-clear-recheck-${item.session.id}`}
                      disabled={rechecking !== null} aria-busy={rechecking === item.outcome.commandId || undefined}
                      onClick={() => void recheck(item)}>核对回执</button>
                  </li>
                ))}
              </ul>
            )}
            {recheckNote !== null && <p className="helper-text" role="status" data-testid="workspace-clear-recheck-note">{recheckNote}</p>}
            {unresolved.length > 0 && (
              <details className="workspace-clear-diagnostics">
                <summary>诊断详情</summary>
                {unresolved.map((item) => item.outcome.state === "unresolved" && (
                  <p key={item.session.id}>{item.session.title}：<code>{item.outcome.commandId}</code></p>
                ))}
              </details>
            )}
            <div className="dialog-actions">
              <button className="secondary-button" type="button" data-testid="workspace-clear-reread"
                onClick={() => void readTargets()}>重新读取</button>
              <button className="primary-button" type="button" data-testid="workspace-clear-done"
                onClick={resetDialog}>完成</button>
            </div>
          </>
        )}
      </AppDialog>
    </>
  );
}
