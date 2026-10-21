import { useCallback, useEffect, useRef, useState } from "react";
import { Ban, ChevronDown, CircleAlert, CircleCheck, Eye, Hand, ShieldX, TriangleAlert } from "lucide-react";
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
 *
 * **芯片文字里哪些是档位、哪些不是**（2026-10-21 用户指认「未开放写入这个权限是从哪来的」）：
 * 服务端可存的档位只有四档——`RelayWriteTier = READ_ONLY | ASK | AUTO | FULL`（`api/dtos/gateway.ts`），
 * 菜单里可选的也正是这四行。芯片还可能读出另外三个词，它们都不是档位、也不会被写进任何请求：
 * `写入档位待核对`＝本机还没读到服务端投影，`已拒绝写入`＝另有 DENY 策略行压着档位，
 * `不可写入`＝这一处作用域此刻写不了（`blocked`：读到的前置条件不满足；`unbound`：还没有
 * 目录／项目可查，因此根本不发起查询）。两者按 2026-10-18 指令仍读作一句权限结论，差别只写在
 * 悬停说明与输入卡上方摘要里（`未就绪` / `未就绪（未绑定目录）`）。
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
  // 「不可写入」不是第五档权限：服务端只有 READ_ONLY/ASK/AUTO/FULL 四档（`RelayWriteTier`），
  // 芯片上的这两个状态是「此刻写不了」的投影，档位菜单里也没有这一行可选（2026-10-21 措辞修正，
  // 见本文件顶部说明）。原先写作「未开放写入」，用户实机读成了「未开发写入」＝功能没做。
  blocked: "不可写入", unknown: "写入档位待核对",
  /**
   * 2026-10-18 用户指认「这个下拉框功能是调整权限，所以默认状态不应该显示未选择目录而
   * 应该显示哪个权限」：未绑定目录时的真实权限就是「什么都写不了」，因此这里也读作一个
   * 档位，而不是复述目录状态。2026-10-19 用户指令删掉菜单首行与提示行后，芯片只回答
   * 「权限是什么」这一件事；2026-10-21 用户指认四行全灰却无解释，菜单在**禁用态**补回
   * 一行原因＋下一步（见 `write-permission-reason`），可选态仍只由悬停承载。
   */
  unbound: "不可写入",
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

/**
 * 图标按「这一档允许我做什么」选：只读＝只能看（眼睛），请求批准＝每次伸手问（手掌），
 * 自动批准＝普通编辑自动放行（圆勾），完全访问＝这一档免掉删除确认，用危险三角（红色）。
 * 2026-10-19 用户实机指认「完全访问应该是代表危险的图标」，开锁改回危险符号。
 */
const tierIcons: Record<Tier, typeof Hand> = {
  full: TriangleAlert, auto: CircleCheck, ask: Hand, none: Eye, denied: ShieldX, blocked: Ban,
  unknown: CircleAlert, unbound: Ban,
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
  const [mayRetry, setMayRetry] = useState(false);
  const scope = useRef(0);
  const currentScope = useRef({ client, projectId, resourceId, canonicalRoot });
  currentScope.current = { client, projectId, resourceId, canonicalRoot };
  // 档位菜单是锚在芯片上方的浮层：点到外面、按 Esc、或打开别的浮层时都要收起，
  // 否则多个绝对定位菜单会叠在一起（2026-10-17 用户指认）。语义收口在 popoverMenu。
  const detailsRef = useRef<HTMLDetailsElement>(null);
  useDetailsMenu(detailsRef);
  // 入口在两处输入器常驻：没有绑定目录或项目时不隐藏，而是读作「不可写入」这一句权限结论
  // （它不是第五档档位，菜单里也没有这一行），入口不消失——隐藏会被读成功能不存在。
  // 缺什么写在菜单里（2026-10-18 用户指认：芯片属于权限控件，就读权限，不复述目录状态）。
  const scopeMissing = projectId === null || resourceId === null;
  const readinessTier = tierOf(readiness);
  const tier: Tier = scopeMissing ? "unbound" : readinessTier;
  const label = tierLabels[tier];
  const TierIcon = tierIcons[tier];
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
    setSubmitting(true); setActionError(null); setConfirmed(null); setPending(command); setMayRetry(false);
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
        // 结果不明时不再把「原 command_id / 查询回执」摆给用户（2026-10-20，P1-4）：
        // 先由程序做一次有界核对——查询同一条命令的回执。查到就是已保存，查不到才请用户
        // 决定重新核对还是重试；原 ID 与原载荷在此期间保持冻结。
        await verify(command);
      }
    } finally {
      setSubmitting(false);
    }
  }

  /**
   * 核对一次保存结果。只查这一条命令的回执，不重发、不改载荷、不换 ID。
   * 返回结论供调用方决定是否继续（自动核对只用一次，不做轮询）。
   */
  async function verify(command: PendingTier): Promise<"CONFIRMED" | "NOT_FOUND" | "FAILED"> {
    if (!matchesCurrentScope(command)) {
      setActionError("目录或连接已更换；请返回原目录核对该命令。");
      return "FAILED";
    }
    setSubmitting(true); setActionError(null);
    try {
      const receipt = await command.client.getCommandReceipt(command.request.commandId);
      if (!matchesCurrentScope(command)) return "FAILED";
      if (receipt.commandType !== command.type || receipt.commandId !== command.request.commandId) {
        throw new Error("查到的回执与这次保存对不上，请重新核对。");
      }
      const next = await load();
      if (!matchesCurrentScope(command)) return "FAILED";
      setPending(null); setMayRetry(false);
      setConfirmed(confirmationForCommand(command, next, receipt.result));
      return "CONFIRMED";
    } catch (caught) {
      if (!matchesCurrentScope(command)) return "FAILED";
      if (caught instanceof RelayApiError && caught.problem.code === "COMMAND_NOT_FOUND") {
        setMayRetry(true);
        setActionError("还没查到这次保存的结果。可以重新核对；确认没有保存时再重试。");
        return "NOT_FOUND";
      }
      setActionError(describeLiveError(caught).message);
      return "FAILED";
    } finally {
      setSubmitting(false);
    }
  }

  async function checkPending() {
    if (pending === null || submitting) return;
    await verify(pending);
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

  const rows: readonly { readonly choice: Choice; readonly body: string }[] = [
    { choice: "ASK", body: "每次写入单独批准" },
    { choice: "AUTO", body: "任务内普通编辑自动，删除仍确认" },
    { choice: "FULL", body: "本目录内新建、修改与删除免确认" },
    { choice: "NONE", body: "本目录只读" },
  ];
  const currentChoice: Choice | null = tier === "full" ? "FULL" : tier === "auto" ? "AUTO"
    : tier === "ask" ? "ASK" : tier === "none" ? "NONE" : null;
  // 菜单首行与提示行按 2026-10-19 用户指令删除后，「这条档位属于哪个目录」与「缺了哪一步」
  // 只剩悬停说明这一个载体，因此把目录与说明都收在这里，不再出现在可见文字里。
  const description = [canonicalRoot, readiness?.detail ?? actionError ?? hint ?? "正在核对服务端档位"]
    .filter((part): part is string => part !== null).join("｜");

  return <details className="agent-chat-permission" data-testid="write-permission" ref={detailsRef}>
    <summary className="agent-chat-tool agent-chat-permission-chip" data-testid="write-permission-chip"
      data-tier={tier}
      aria-label={`写入权限：${label}`}
      title={`写入权限：${label} · ${description}`}>
      <TierIcon aria-hidden="true" />{checking && readiness === null && !scopeMissing ? "正在核对档位" : label}
      <ChevronDown aria-hidden="true" className="agent-chat-chip-chevron" /></summary>
    <div className="agent-chat-permission-menu" role="group" aria-label="本目录写入档位">
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
      {/* 2026-10-21 用户指认「权限选择下拉框选项是禁用状态」：四行一起变灰却什么都不说，
          是一条没有出口的死路。闸门本身一行没改（用户口径：不放宽，只说清为什么＋下一步），
          只在禁用态补这一行——可选态仍只由悬停承载（2026-10-19 指令不变）。
          错误态不在此列：它已有 `write-permission-error` 那一条可见说明，不重复挂第二行。 */}
      {!canChoose && actionError === null && hint !== null && <div className="agent-chat-permission-reason"
        data-testid="write-permission-reason">
        <p className="helper-text">{hint}</p>
        {/* 服务端答了、但当前状态不属于可调整那一类：唯一能做的事就是再看一次。 */}
        {readiness !== null && !prereqOk && <button className="secondary-button" type="button"
          data-testid="write-permission-recheck-tier" disabled={checking}
          onClick={() => void load()}>{checking ? "正在核对" : "重新核对"}</button>}
      </div>}
      {pending !== null && <div className="agent-chat-permission-pending" data-testid="write-permission-pending">
        {/* 2026-10-20（P1-4）：用户看到的是「保存有没有成功」，不是命令协议。
            核对由程序先做一次；这里的两个键只在没查到时才需要人决定。 */}
        <p className="helper-text" data-testid="write-permission-pending-text">
          {submitting ? "正在核对是否保存成功…" : "保存结果还没确认"}</p>
        <div className="agent-chat-permission-pending-actions">
          <button className="secondary-button" type="button" data-testid="write-permission-receipt" disabled={submitting}
            onClick={() => void checkPending()}>{submitting ? "正在核对" : "重新核对"}</button>
          {mayRetry && <button className="secondary-button" type="button" data-testid="write-permission-retry" disabled={submitting}
            onClick={() => void send(pending)}>{submitting ? "正在重试" : "重试保存"}</button>}
        </div>
        <details className="tech-details" data-testid="write-permission-diagnostics">
          <summary>诊断信息</summary>
          <p className="helper-text">命令：{pending.type} · 标识：<code className="hash-code">{pending.request.commandId}</code></p>
          <p className="helper-text">原档位修订：{pending.request.expectedRevision} · 目标档位：{tierLabels[pending.intended]}</p>
        </details>
      </div>}
      {actionError !== null && <p className="agent-chat-permission-error" role="alert"
        data-testid="write-permission-error">{actionError}</p>}
      {confirmed !== null && <p className="helper-text" data-testid="write-permission-confirmed">{confirmed}</p>}
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
