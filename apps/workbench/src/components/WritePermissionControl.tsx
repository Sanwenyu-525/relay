import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronDown, CircleAlert, Lock, RefreshCw, ShieldAlert, ShieldCheck, ShieldX } from "lucide-react";
import { createCommandId, RelayApiError, type RelayApiClient, type RelayCommandEnvelope, type RelayWriteReadiness } from "../api/relayClient";
import { describeLiveError } from "../lib/liveErrors";
import "./WritePermissionControl.css";

/**
 * 对话页输入器上的「本目录写入档位」入口（工作台 §18.1、tool-adapters §1.2）。
 *
 * 形态与通用 Agent 的权限档位一致（一颗芯片 + 三档菜单），语义按本项目改写：
 * 档位属于「项目 × 受管目录 × APPLY_CHANGESET」这一条策略，不是全局开关；第三档不是
 * 「完全访问」而是「不开放写入」——V1 不提供始终允许，删除永远不在范围授权动作里，
 * 拒绝条目也不会被批准或范围授权覆盖。界面只显示服务端投影出的档位，不自己排序策略。
 */

/** 本入口新建策略条目时取服务端允许的最大参数上限（契约 §10.55：0 到 262144）。 */
const MAX_POLICY_PAYLOAD_BYTES = 262144;

type Tier = "auto" | "ask" | "none" | "denied" | "blocked" | "unknown" | "unbound";
type Choice = "ASK" | "AUTO" | "NONE";

type PendingTier = {
  readonly commandId: string;
  readonly type: "CreateGatewayPolicy" | "AddGatewayPolicyVersion" | "RevokeGatewayPolicy";
  readonly label: string;
  readonly intended: Tier;
  readonly run: (api: RelayApiClient, commandId: string) => Promise<RelayCommandEnvelope>;
};

const tierLabels: Record<Tier, string> = {
  auto: "本次任务自动", ask: "每次确认", none: "不开放写入", denied: "已拒绝写入",
  blocked: "未开放写入", unknown: "写入档位待核对", unbound: "未绑定目录",
};

const choiceTiers: Record<Choice, Tier> = { ASK: "ask", AUTO: "auto", NONE: "none" };

function tierOf(readiness: RelayWriteReadiness | null): Tier {
  if (readiness === null) return "unknown";
  if (readiness.policyDecision === null) {
    // 旧回执里没有档位字段：已就绪的目录如实报「待核对」，不能猜成逐次确认。
    if (readiness.status === "NEEDS_PERMISSION") return "none";
    return readiness.status === "READY" ? "unknown" : "blocked";
  }
  if (readiness.policyDecision === "DENY") return "denied";
  if (readiness.policyDecision === "AUTO") return "auto";
  if (readiness.policyDecision === "ASK") return "ask";
  return "blocked";
}

const tierIcons: Record<Tier, typeof ShieldCheck> = {
  auto: ShieldAlert, ask: ShieldCheck, none: Lock, denied: ShieldX, blocked: Lock, unknown: CircleAlert,
  unbound: Lock,
};

export default function WritePermissionControl({ client, projectId, resourceId, canonicalRoot, disabled = false }: {
  client: RelayApiClient | null;
  projectId: string | null;
  resourceId: string | null;
  canonicalRoot: string | null;
  disabled?: boolean;
}) {
  const [readiness, setReadiness] = useState<RelayWriteReadiness | null>(null);
  const [checking, setChecking] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingTier | null>(null);
  const scope = useRef(0);
  // 入口在两处输入器常驻：没有绑定目录或项目时不隐藏，而是显示未绑定态并说明缺什么。
  const scopeMissing = projectId === null || resourceId === null;
  const readinessTier = tierOf(readiness);
  const tier: Tier = scopeMissing ? "unbound" : readinessTier;
  const label = scopeMissing
    ? (projectId === null ? (canonicalRoot === null ? "未选择目录" : "未归入项目") : "未绑定目录")
    : tierLabels[readinessTier];
  const TierIcon = tierIcons[tier];
  const directoryName = (canonicalRoot ?? "").replace(/[\\/]+$/u, "").split(/[\\/]/u).at(-1) ?? "";

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
        ? "当前 API 未更新，三档暂不可改；刷新 API 后重试。"
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
  const prereqOk = readiness !== null && (readiness.status === "READY" || readiness.status === "NEEDS_PERMISSION");
  // 命中的策略也可能属于上层受管根：改它等于改写别的目录的档位，所以只允许改本目录自己的条目。
  const prefix = readiness?.policyTargetPrefix ?? null;
  const sameScope = prefix === null || (canonicalRoot !== null && prefix.toLowerCase() === canonicalRoot.toLowerCase());
  const canChoose = prereqOk && sameScope && canonicalRoot !== null && !disabled && pending === null && !submitting;
  const policyId = readiness?.policyId ?? null;
  const policyRevision = readiness?.policyRevision ?? null;
  const canClose = canChoose && policyId !== null && policyRevision !== null;
  const hint = actionError === null ? readinessHint(readiness, tier, sameScope, disabled, {
    rootKnown: canonicalRoot !== null, projectBound: projectId !== null, resourceBound: resourceId !== null }) : null;

  async function send(command: PendingTier) {
    if (client === null) return;
    setSubmitting(true); setActionError(null); setConfirmed(null); setPending(command);
    try {
      await command.run(client, command.commandId);
      // 回执之后必须重新读服务端投影：界面不能把自己刚发的命令当成已生效的事实。
      const next = await load();
      const shown = tierOf(next);
      setPending(null);
      setConfirmed(next === null || next === undefined ? `${command.label}已提交；档位待重新核对。`
        : shown === command.intended ? `已生效：${tierLabels[shown]}（仅对本目录）。`
          : `${command.label}已提交，但投影显示当前档位是「${tierLabels[shown]}」；${next.detail}`);
    } catch (caught) {
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
    if (projectId === null || resourceId === null) return null;
    const commandId = createCommandId();
    if (choice === "NONE") {
      if (policyId === null || policyRevision === null) return null;
      return { commandId, type: "RevokeGatewayPolicy", label: "关闭该目录写入", intended: "none",
        run: (api, id) => api.revokeGatewayPolicy({ projectId, policyId, commandId: id, expectedRevision: policyRevision }) };
    }
    const decision = choice === "AUTO" ? "AUTO" : "ASK";
    if (policyId === null) {
      return { commandId, type: "CreateGatewayPolicy", label: "写入档位设置", intended: choiceTiers[choice],
        run: (api, id) => api.createGatewayPolicy({ projectId, commandId: id, capability: "FILE_WRITE", resourceId,
          decision, maxPayloadBytes: MAX_POLICY_PAYLOAD_BYTES, actionType: "APPLY_CHANGESET" }) };
    }
    if (policyRevision === null) return null;
    return { commandId, type: "AddGatewayPolicyVersion", label: "写入档位调整", intended: choiceTiers[choice],
      run: (api, id) => api.addGatewayPolicyVersion({ projectId, policyId, commandId: id,
        expectedRevision: policyRevision, capability: "FILE_WRITE", resourceId, decision,
        maxPayloadBytes: MAX_POLICY_PAYLOAD_BYTES, actionType: "APPLY_CHANGESET" }) };
  }

  async function checkPending() {
    if (client === null || pending === null || submitting) return;
    setSubmitting(true); setActionError(null);
    try {
      const receipt = await client.getCommandReceipt(pending.commandId);
      if (receipt.commandType !== pending.type) throw new Error("原命令回执的类型与本次操作不符，请核对后再处理。");
      const next = await load();
      setPending(null);
      setConfirmed(next === null ? "回执已确认，档位待重新核对。"
        : `已生效：${tierLabels[tierOf(next)]}（仅对本目录）。`);
    } catch (caught) {
      if (caught instanceof RelayApiError && caught.problem.code === "COMMAND_NOT_FOUND") {
        setActionError("原命令回执暂未找到；仍用原 command_id 重试，或稍后再查。");
      } else setActionError(describeLiveError(caught).message);
    } finally {
      setSubmitting(false);
    }
  }

  const rows: readonly { readonly choice: Choice; readonly body: string }[] = [
    { choice: "ASK", body: "每次写入单独批准" },
    { choice: "AUTO", body: "普通编辑自动，删除与 Git 仍确认" },
    { choice: "NONE", body: "本目录只读" },
  ];
  const currentChoice: Choice | null = tier === "auto" ? "AUTO" : tier === "ask" ? "ASK" : tier === "none" ? "NONE" : null;
  const description = readiness?.detail ?? actionError ?? hint ?? "正在核对服务端档位";

  return <details className="agent-chat-permission" data-testid="write-permission">
    <summary className="agent-chat-tool agent-chat-permission-chip" data-testid="write-permission-chip"
      data-tier={tier}
      aria-label={`本目录写入档位：${label}`}
      title={`${label} · ${description}`}>
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
      {rows.map((row) => <button key={row.choice} className="agent-chat-permission-row" type="button"
        data-testid={`write-permission-${row.choice.toLowerCase()}`}
        data-current={currentChoice === row.choice ? "true" : "false"}
        aria-pressed={currentChoice === row.choice}
        disabled={!canChoose || (row.choice === "NONE" && !canClose)}
        onClick={() => { const command = buildCommand(row.choice); if (command !== null) void send(command); }}>
        <span className="agent-chat-permission-row-title">{tierLabels[choiceTiers[row.choice]]}</span>
        <span className="agent-chat-permission-row-body">{row.body}</span>
      </button>)}
      {hint !== null && <p className="agent-chat-permission-hint" role="status"
        data-testid="write-permission-hint">{hint}</p>}
      {readiness !== null && !prereqOk && projectId !== null &&
        <Link className="text-link agent-chat-permission-manage" to={`/projects/${projectId}/connections`}>连接与权限</Link>}
      {pending !== null && <div className="agent-chat-permission-pending" data-testid="write-permission-pending">
        <p className="helper-text">结果待核对 · 原 command_id：{pending.commandId}</p>
        <button className="secondary-button" type="button" data-testid="write-permission-receipt" disabled={submitting}
          onClick={() => void checkPending()}>{submitting ? "正在查询" : "查询原回执"}</button>
        <button className="secondary-button" type="button" data-testid="write-permission-retry" disabled={submitting}
          onClick={() => void send(pending)}>{submitting ? "正在重试" : "按原命令重试"}</button>
      </div>}
      {actionError !== null && <p className="agent-chat-permission-error" role="alert"
        data-testid="write-permission-error">{actionError}</p>}
      {confirmed !== null && <p className="helper-text" data-testid="write-permission-confirmed">{confirmed}</p>}
      <p className="agent-chat-permission-footnote">无「完全访问」档 · 删除与 Git 始终确认</p>
    </div>
  </details>;
}

/** 缺前置条件时说清楚缺什么、去哪里补，而不是把按钮禁用后什么都不说（工作台 §18.10）。 */
function readinessHint(readiness: RelayWriteReadiness | null, tier: Tier, sameScope: boolean,
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
  if (tier === "denied") return "拒绝条目请到「连接与权限」处理。";
  if (!sameScope) return "这是上层目录的策略；请到「连接与权限」修改。";
  if (!prerequisiteAdjustable(readiness.status)) return readiness.detail;
  if (tier === "unknown") return readiness.detail;
  return null;
}

function prerequisiteAdjustable(status: string): boolean {
  return status === "READY" || status === "NEEDS_PERMISSION";
}
