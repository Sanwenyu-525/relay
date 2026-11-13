import { useCallback, useRef, useState } from "react";
import { BrushCleaning, LoaderCircle } from "lucide-react";
import AppDialog from "./AppDialog";
import { createCommandId, type RelayApiClient, type RelayAssistSession } from "../api/relayClient";
import { describeLiveError } from "../lib/liveErrors";
import { usePathTooltip } from "../lib/pathTooltip";
import { Button } from "../ui";
import {
  deleteSessionAndVerify,
  verifyDeleteReceipt,
  type SessionDeleteOutcome
} from "../lib/sessionDelete";

/**
 * 「清空该工作区会话」的唯一 UI 入口（2026-11-04，2026-11-10 按用户指认收窄到「会话的集合区域」）。
 *
 * 语义与边界：
 * * **清空 = 逐条走既有 DeleteAssistSession 命令**，不新写数据库入口，也不在界面里维护
 *   第二份「已删除」状态。服务端仍按产物、验收记录等引用关系拒绝删除，被拒绝的会话
 *   保留并逐条说明原因。
 * * **范围 = 左栏「会话（按目录）」这一段收集的会话**（用户口径：这一段指会话的集合区域，
 *   不是某单个目录；段名 2026-11-10 由「工作区（目录）」改来）。各目录分组里的讨论都在范围内，
 *   含已归档讨论；任务执行会话（归「任务」段）与任务行不在这里删除。委派子会话虽然不单独列出，
 *   但会随所属主会话在服务端级联清理（2026-11-10 ADR-027 修订）。
 * * **按钮位置 = 段标题「会话（按目录）」的右侧**，就放在该段 summary 里；点击只开清空确认，
 *   不折叠这一段（click 同时 preventDefault 与 stopPropagation，挡掉 summary 的默认动作）。
 * * **不可撤销**，因此点击后先读一次当前事实、显示确切条数，再由用户二次确认。
 *
 * 结果四态沿用 `sessionDelete`：删除成功、被业务引用阻断、明确失败、结果未确认。
 * 结果未确认只核对原 `command_id` 的回执，绝不换新命令重复删除。
 */

type Phase = "idle" | "loading" | "confirm" | "running" | "empty" | "error" | "result";

interface RowResult {
  readonly session: RelayAssistSession;
  readonly outcome: SessionDeleteOutcome;
}

export default function WorkspaceClearSessions({ client, onCleared }: {
  readonly client: RelayApiClient;
  /**
   * 只传服务端已确认删除的会话 id，`allDeleted` 表示这一轮目标是否全部删成。
   * 左栏据此收行、在当前会话被删时切到新对话，并在整段清空时给一条全局成功回执
   * （组件自己会随空段卸载，不能把回执挂在它身上）。
   */
  readonly onCleared: (deletedSessionIds: readonly string[], allDeleted: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [targets, setTargets] = useState<readonly RelayAssistSession[]>([]);
  const [results, setResults] = useState<readonly RowResult[]>([]);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [errorText, setErrorText] = useState("");
  const [rechecking, setRechecking] = useState<string | null>(null);
  const [recheckNote, setRecheckNote] = useState<string | null>(null);
  const running = useRef(false);
  const tooltipText = "清空「会话（按目录）」里的讨论（含已归档）；「任务」段的执行会话不在范围内";
  const { tooltipHandlers, tooltipNode, dismissTooltip } = usePathTooltip(
    () => tooltipText, "workspace-clear-tooltip");

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
    setPhase("loading");
    setTargets([]);
    setResults([]);
    setErrorText("");
    setRecheckNote(null);
    try {
      // 范围与左栏同一判据（`onRail`）：task_id 为空、不是委派子会话的讨论。
      // 不再按目录收窄——用户口径里的工作区是「会话的集合区域」，各目录分组都算在内。
      // 归档会话也读回来（含已归档），否则「清空」会漏掉这一段自己的历史。
      const sessions = await client.getAssistSessions({ status: "ALL", includeContext: true });
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
    const allDeleted = deletedIds.length === collected.length;
    if (deletedIds.length > 0) onCleared(deletedIds, allDeleted);
    if (allDeleted) {
      setOpen(false);
      setPhase("idle");
      setTargets([]);
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
      onCleared([item.session.id], false);
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
      {/* 按钮就在「会话（按目录）」段标题右侧（summary 内）。click 必须在这里同时
          preventDefault + stopPropagation：summary 的激活行为会把同一击读成「折叠这一段」，
          只停冒泡挡不住它的默认动作，清空确认框还没开这一段就收起了。 */}
      <button className="icon-button recent-work-section-clear" type="button"
        data-testid="workspace-clear-sessions"
        aria-label="清空「会话（按目录）」里的讨论：删除左栏这一段收集的会话，「任务」段里的执行会话不受影响"
        aria-busy={busy || undefined}
        disabled={busy}
        {...tooltipHandlers}
        onClick={(event) => { event.preventDefault(); event.stopPropagation(); void readTargets(); }}>
        {busy
          ? <LoaderCircle className="workspace-clear-spin" aria-hidden="true" />
          : <BrushCleaning aria-hidden="true" />}
      </button>
      {tooltipNode}
      <AppDialog open={open} title="清空「会话（按目录）」里的讨论"
        subtitle="只清左栏这一段收集的讨论（含已归档），不影响「任务」段"
        onClose={resetDialog}>
        {phase === "loading" && <p className="helper-text" data-testid="workspace-clear-loading">正在读取「会话（按目录）」里的讨论…</p>}
        {phase === "empty" && (
          <>
            <p data-testid="workspace-clear-empty">「会话（按目录）」下没有可清空的讨论。</p>
            <div className="dialog-actions">
              <Button variant="primary" data-testid="workspace-clear-done"
                onClick={resetDialog}>知道了</Button>
            </div>
          </>
        )}
        {phase === "error" && (
          <>
            <p role="alert" data-testid="workspace-clear-error">{errorText}</p>
            <div className="dialog-actions">
              <Button variant="secondary" onClick={resetDialog}>取消</Button>
              <Button variant="primary" data-testid="workspace-clear-retry"
                onClick={() => void readTargets()}>重试读取</Button>
            </div>
          </>
        )}
        {phase === "confirm" && (
          <>
            <p>将永久删除「会话（按目录）」里的 <strong data-testid="workspace-clear-count">{targets.length}</strong> 条讨论（含已归档）。</p>
            <p className="helper-text">
              只处理左栏「会话（按目录）」收集的讨论，「任务」段里的执行会话不在清空范围内；
              委派子会话随所属主会话一起删除。删除不可撤销；仍被产物、验收记录或其他业务对象
              引用的会话会被服务端拒绝并保留。
            </p>
            <div className="dialog-actions">
              <Button variant="secondary" data-testid="workspace-clear-cancel"
                onClick={resetDialog}>取消</Button>
              <Button variant="danger" data-testid="workspace-clear-confirm"
                onClick={() => void run()}>清空 {targets.length} 条会话</Button>
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
                    <Button variant="text"
                      data-testid={`workspace-clear-recheck-${item.session.id}`}
                      disabled={rechecking !== null} aria-busy={rechecking === item.outcome.commandId || undefined}
                      onClick={() => void recheck(item)}>核对回执</Button>
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
              <Button variant="secondary" data-testid="workspace-clear-reread"
                onClick={() => void readTargets()}>重新读取</Button>
              <Button variant="primary" data-testid="workspace-clear-done"
                onClick={resetDialog}>完成</Button>
            </div>
          </>
        )}
      </AppDialog>
    </>
  );
}
