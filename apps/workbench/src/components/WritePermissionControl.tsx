import { useCallback, useEffect, useRef, useState } from "react";
import { Ban, ChevronDown, CircleAlert, Flame, Hand, Lock, RefreshCw, ShieldX, Zap } from "lucide-react";
import { createCommandId, RelayApiError, type RelayApiClient, type RelayWriteReadiness, type RelayWriteTier } from "../api/relayClient";
import { describeLiveError } from "../lib/liveErrors";
import { useDetailsMenu } from "../lib/popoverMenu";
import "./WritePermissionControl.css";

/**
 * 对话页输入器上的「本目录写入档位」入口（工作台 §18.1、tool-adapters §1.2）。
 *
 * 形态与通用 Agent 的权限档位一致（一颗芯片 + 档位菜单），语义按本项目改写：档位属于
 * 「项目 × 受管目录 × APPLY_CHANGESET」这一条策略，不是全局开关。四档从最保守到最宽松是
 * 只读 → 请求批准 → 自动批准 → 完全访问；完全访问（红色）只放宽本目录内的文件写入，
 * 含删除，Git、CLI、浏览器与目录外动作仍按各自策略逐次确认。
 * 界面只显示服务端投影出的档位，不自己排序策略。
 */

export type Tier = "full" | "auto" | "ask" | "none" | "denied" | "blocked" | "unknown" | "unbound";
type Choice = "ASK" | "AUTO" | "FULL" | "NONE";

type PendingTier = {
  readonly type: "SetLocalDirectoryWriteTier";
  readonly label: string;
  readonly intended: Tier;
  readonly client: RelayApiClient;
  readonly canonicalRoot: string;
  readonly request: { readonly projectId: string; readonly resourceId: string; readonly commandId: string;
    readonly expectedRevision: string; readonly tier: RelayWriteTier };
};

export const tierLabels: Record<Tier, string> = {
  full: "完全访问", auto: "自动批准", ask: "请求批准", none: "只读", denied: "已拒绝写入",
  blocked: "未开放写入", unknown: "写入档位待核对",
  /**
   * 2026-10-18 用户指认「这个下拉框功能是调整权限，所以默认状态不应该显示未选择目录而
   * 应该显示哪个权限」：未绑定目录时的真实权限就是「什么都写不了」，因此这里也读作一个
   * 档位，而不是复述目录状态。缺的是目录还是项目归属，由菜单头与下一句说明承担——
   * 芯片只回答「权限是什么」这一件事。
   */
  unbound: "未开放写入",
};

const choiceTiers: Record<Choice, Tier> = { ASK: "ask", AUTO: "auto", FULL: "full", NONE: "none" };

function tierOf(readiness: RelayWriteReadiness | null): Tier {
  if (readiness === null) return "unknown";
  if (readiness.status === "READ_ONLY") return "none";
  if (readiness.policyDecision === null) {
    if (readiness.status === "NEEDS_PERMISSION" || readiness.status === "NEEDS_CONNECTION") return "blocked";
    return readiness.status === "READY" ? "unknown" : "blocked";
  }
  if (readiness.policyDecision === "DENY") return "denied";
  // 完全访问与自动批准在策略行上同为 AUTO，只有目录档位这一列能把两者分开。
  if (readiness.policyDecision === "AUTO") return readiness.writeTier === "FULL" ? "full" : "auto";
  if (readiness.policyDecision === "ASK") return "ask";
  return "blocked";
}

/** 四档取轮廓互异的一组图标（闪电／手掌／火焰／锁），盾牌族彼此太像，扫一眼分不出来。 */
const tierIcons: Record<Tier, typeof Lock> = {
  full: Flame, auto: Zap, ask: Hand, none: Lock, denied: ShieldX, blocked: Ban, unknown: CircleAlert,
  unbound: Ban,
};

export default function WritePermissionControl({ client, projectId, resourceId, canonicalRoot, disabled = false, onTier }: {
  client: RelayApiClient | null;
  projectId: string | null;
  resourceId: string | null;
  canonicalRoot: string | null;
  disabled?: boolean;
  /** 档位上报（2026-10-17 输入卡上方状态行）：父组件据此显示「写入权限：xx」摘要，
   *  与本芯片同源同值，不另发第二份查询。 */
  readonly onTier?: (tier: Tier) => void;
}) {
  const [readiness, setReadiness] = useState<RelayWriteReadiness | null>(null);
  const [checking, setChecking] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingTier | null>(null);
  const scope = useRef(0);
  const currentScope = useRef({ client, projectId, resourceId, canonicalRoot });
  currentScope.current = { client, projectId, resourceId, canonicalRoot };
  // 档位菜单是锚在芯片上方的浮层：点到外面、按 Esc、或打开别的浮层时都要收起，
  // 否则多个绝对定位菜单会叠在一起（2026-10-17 用户指认）。语义收口在 popoverMenu。
  const detailsRef = useRef<HTMLDetailsElement>(null);
  useDetailsMenu(detailsRef);
  // 入口在两处输入器常驻：没有绑定目录或项目时不隐藏，而是显示「未开放写入」这一档，
  // 缺什么写在菜单里（2026-10-18 用户指认：芯片属于权限控件，就读权限，不复述目录状态）。
  const scopeMissing = projectId === null || resourceId === null;
  const readinessTier = tierOf(readiness);
  const tier: Tier = scopeMissing ? "unbound" : readinessTier;
  const label = tierLabels[tier];
  const TierIcon = tierIcons[tier];
  const directoryName = (canonicalRoot ?? "").replace(/[\\/]+$/u, "").split(/[\\/]/u).at(-1) ?? "";
  const onTierRef = useRef(onTier);
  onTierRef.current = onTier;
  useEffect(() => { onTierRef.current?.(tier); }, [tier]);

  const load = useCallback(async (): Promise<RelayWriteReadiness | null> => {
    if (client === null || projectId === null || resourceId === null) return null;
    const token = scope.current;
    setChecking(true);
    try {
      const next = await client.getWriteReadiness(projectId, resourceId);
      if (token !== scope.current) return null;
      setReadiness(next);
      return next;
    } catch (caught) {
      if (token === scope.current) setActionError(caught instanceof RelayApiError && caught.problem.status === 404
        ? "当前 API 未更新，档位暂不可改；刷新 API 后重试。"
        : describeLiveError(caught).message);
      return null;
    } finally {
      if (token === scope.current) setChecking(false);
    }
  }, [client, projectId, resourceId]);

  useEffect(() => {
    scope.current += 1;
    setReadiness(null); setPending(null); setConfirmed(null); setActionError(null);
    void load();
    return () => { scope.current += 1; };
  }, [load]);

  // 能改档位的只有「连接已绑定 + 目录可用」这一类状态；其余一律说明缺什么，不给点了没反应的键。
  const prereqOk = readiness !== null && ["READY", "READ_ONLY", "NEEDS_PERMISSION", "NEEDS_CONNECTION"]
    .includes(readiness.status);
  const canChoose = prereqOk && canonicalRoot !== null && !disabled && pending === null && !submitting;
  const hint = actionError === null ? readinessHint(readiness, tier, disabled, {
    rootKnown: canonicalRoot !== null, projectBound: projectId !== null, resourceBound: resourceId !== null }) : null;

  function matchesCurrentScope(command: PendingTier): boolean {
    const current = currentScope.current;
    return current.client === command.client && current.projectId === command.request.projectId &&
      current.resourceId === command.request.resourceId && current.canonicalRoot === command.canonicalRoot;
  }

  async function send(command: PendingTier) {
    if (!matchesCurrentScope(command)) {
      setActionError("目录或连接已更换；请返回原目录核对该命令。");
      return;
    }
    setSubmitting(true); setActionError(null); setConfirmed(null); setPending(command);
    try {
      const result = await command.client.setLocalDirectoryWriteTier(command.request);
      if (!matchesCurrentScope(command)) return;
      // 回执之后必须重新读服务端投影：界面不能把自己刚发的命令当成已生效的事实。
      const next = await load();
      if (!matchesCurrentScope(command)) return;
      setPending(null);
      setConfirmed(confirmationForCommand(command, next, result.result));
    } catch (caught) {
      if (!matchesCurrentScope(command)) return;
      if (caught instanceof RelayApiError && caught.problem.status < 500 &&
          caught.problem.code !== "COMMAND_ID_REUSED") {
        setPending(null);
        setActionError(describeLiveError(caught).message);
        if (caught.problem.status === 409) void load();
      } else {
        setActionError("提交结果尚不明确。先用原 command_id 查询回执；查不到时只能原样重试，不换命令 ID。");
      }
    } finally {
      setSubmitting(false);
    }
  }

  function buildCommand(choice: Choice): PendingTier | null {
    if (client === null || projectId === null || resourceId === null || canonicalRoot === null || readiness === null) return null;
    const commandId = createCommandId();
    return { type: "SetLocalDirectoryWriteTier",
      label: choice === "NONE" ? "切换只读" : choice === "FULL" ? "开放完全访问" : "目录档位设置",
      intended: choiceTiers[choice], client, canonicalRoot,
      request: { projectId, resourceId, commandId, expectedRevision: readiness.accessRevision,
        tier: choice === "NONE" ? "READ_ONLY" : choice } };
  }

  async function checkPending() {
    if (pending === null || submitting) return;
    const command = pending;
    if (!matchesCurrentScope(command)) {
      setActionError("目录或连接已更换；请返回原目录核对该命令。");
      return;
    }
    setSubmitting(true); setActionError(null);
    try {
      const receipt = await command.client.getCommandReceipt(command.request.commandId);
      if (!matchesCurrentScope(command)) return;
      if (receipt.commandType !== command.type) throw new Error("原命令回执的类型与本次操作不符，请核对后再处理。");
      const next = await load();
      if (!matchesCurrentScope(command)) return;
      setPending(null);
      setConfirmed(confirmationForCommand(command, next, receipt.result));
    } catch (caught) {
      if (!matchesCurrentScope(command)) return;
      if (caught instanceof RelayApiError && caught.problem.code === "COMMAND_NOT_FOUND") {
        setActionError("原命令回执暂未找到；仍用原 command_id 重试，或稍后再查。");
      } else setActionError(describeLiveError(caught).message);
    } finally {
      setSubmitting(false);
    }
  }

  const rows: readonly { readonly choice: Choice; readonly body: string }[] = [
    { choice: "ASK", body: "每次写入单独批准" },
    { choice: "AUTO", body: "本次任务范围内普通编辑自动，删除仍逐次确认" },
    { choice: "FULL", body: "本目录内新建、修改与删除不再逐次确认" },
    { choice: "NONE", body: "本目录只读" },
  ];
  const currentChoice: Choice | null = tier === "full" ? "FULL" : tier === "auto" ? "AUTO"
    : tier === "ask" ? "ASK" : tier === "none" ? "NONE" : null;
  const description = readiness?.detail ?? actionError ?? hint ?? "正在核对服务端档位";

  return <details className="agent-chat-permission" data-testid="write-permission" ref={detailsRef}>
    <summary className="agent-chat-tool agent-chat-permission-chip" data-testid="write-permission-chip"
      data-tier={tier}
      aria-label={`写入权限：${label}`}
      title={`写入权限：${label} · ${description}`}>
      <TierIcon aria-hidden="true" />{checking && readiness === null && !scopeMissing ? "正在核对档位" : label}
      <ChevronDown aria-hidden="true" className="agent-chat-chip-chevron" /></summary>
    <div className="agent-chat-permission-menu" role="group" aria-label="本目录写入档位">
      <div className="agent-chat-permission-head">
        <p className="agent-chat-permission-target" title={canonicalRoot ?? undefined}>{scopeMissing
          ? (canonicalRoot === null ? "尚未选择工作目录"
            : projectId === null ? "这个目录还没有归入项目" : "这个目录还没有绑定受管资源")
          : `本目录${directoryName === "" ? "" : `：${directoryName}`}`}</p>
        <button className="agent-chat-permission-recheck" type="button" data-testid="write-permission-recheck"
          disabled={submitting || checking} aria-label="重新核对写入档位" title="重新核对写入档位"
          onClick={() => void load()}>
          <RefreshCw aria-hidden="true" /></button>
      </div>
      {rows.map((row) => { const RowIcon = tierIcons[choiceTiers[row.choice]];
        return <button key={row.choice} className="agent-chat-permission-row" type="button"
          data-testid={`write-permission-${row.choice.toLowerCase()}`} data-tier={choiceTiers[row.choice]}
          data-current={currentChoice === row.choice ? "true" : "false"}
          aria-pressed={currentChoice === row.choice}
          disabled={!canChoose}
          onClick={() => { const command = buildCommand(row.choice); if (command !== null) void send(command); }}>
          <RowIcon aria-hidden="true" className="agent-chat-permission-row-icon" />
          <span className="agent-chat-permission-row-text">
            <span className="agent-chat-permission-row-title">{tierLabels[choiceTiers[row.choice]]}</span>
            <span className="agent-chat-permission-row-body">{row.body}</span>
          </span>
        </button>; })}
      {hint !== null && <p className="agent-chat-permission-hint" role="status"
        data-testid="write-permission-hint">{hint}</p>}
      {pending !== null && <div className="agent-chat-permission-pending" data-testid="write-permission-pending">
        <p className="helper-text">结果待核对 · 原 command_id：{pending.request.commandId}</p>
        <button className="secondary-button" type="button" data-testid="write-permission-receipt" disabled={submitting}
          onClick={() => void checkPending()}>{submitting ? "正在查询" : "查询原回执"}</button>
        <button className="secondary-button" type="button" data-testid="write-permission-retry" disabled={submitting}
          onClick={() => void send(pending)}>{submitting ? "正在重试" : "按原命令重试"}</button>
      </div>}
      {actionError !== null && <p className="agent-chat-permission-error" role="alert"
        data-testid="write-permission-error">{actionError}</p>}
      {confirmed !== null && <p className="helper-text" data-testid="write-permission-confirmed">{confirmed}</p>}
      <p className="agent-chat-permission-footnote">完全访问仅本目录文件写入 · Git 与 CLI 仍逐次确认</p>
    </div>
  </details>;
}

function confirmationForCommand(command: PendingTier, readiness: RelayWriteReadiness | null,
  result: Readonly<Record<string, unknown>>): string {
  if (readiness === null) return "回执已确认，档位待重新核对。";
  const currentTier = tierOf(readiness);
  if (typeof result.revision === "string" && result.revision !== readiness.accessRevision) {
    return `历史命令回执已确认；当前档位：${tierLabels[currentTier]}（仅对本目录）。`;
  }
  return currentTier === command.intended ? `已生效：${tierLabels[currentTier]}（仅对本目录）。`
    : `${command.label}已提交，但当前档位是「${tierLabels[currentTier]}」；${readiness.detail}`;
}

/** 缺前置条件时说清楚缺什么、去哪里补，而不是把按钮禁用后什么都不说（工作台 §18.10）。 */
function readinessHint(readiness: RelayWriteReadiness | null, tier: Tier,
  disabled: boolean, binding: { readonly rootKnown: boolean; readonly projectBound: boolean;
    readonly resourceBound: boolean }): string | null {
  // 未绑定是最常见的一种：入口仍要出现，否则用户会以为没有这个功能。
  if (!binding.projectBound) return binding.rootKnown
    ? "先把这个目录归入项目。"
    : "先选择目录并归入项目。";
  if (!binding.resourceBound) return "先选择受管目录。";
  if (readiness === null) return "正在核对档位…";
  if (disabled) return "提交中，稍后再改。";
  if (!binding.rootKnown) return "目录暂不可读；先重新核对。";
  if (tier === "denied") return "已有拒绝规则仍然生效；目录档位不会覆盖它。";
  if (!prerequisiteAdjustable(readiness.status)) return readiness.detail;
  if (tier === "unknown") return readiness.detail;
  return null;
}

function prerequisiteAdjustable(status: string): boolean {
  return status === "READY" || status === "READ_ONLY" ||
    status === "NEEDS_PERMISSION" || status === "NEEDS_CONNECTION";
}
