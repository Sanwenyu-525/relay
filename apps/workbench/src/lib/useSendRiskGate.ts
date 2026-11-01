import { useCallback, useRef, useState } from "react";

import type { RelayApiClient } from "../api/relayClient";
import { RELAY_REQUIRED_CONTEXT_AGENT, type RequiredContextAudit } from "../api/resources/requiredContext";
import { describeLiveError } from "./liveErrors";
import { liveClient } from "./relayConnection";
import { classifyRiskAudit, confirmationApplies, isGateStale, riskScopeSignature,
  riskUnknownMessage, snapshotSignature, type RiskAuditResult, type RiskConfirmation,
  type RiskGateWindow, type RiskSendScope, type SendSnapshot } from "./sendRiskGate";

/**
 * 发送前预检的控制器（2026-10-30 P0-C，2026-10-31 P0-2 改为快照制）。
 *
 * 两个输入器（新会话首条、已有会话）用的是同一套判定；此前两条 `gateSend` 是逐字复制的
 * 同一段代码，改一处漏一处的风险太高，因此收成这一个 hook。
 *
 * 它只做三件事：取一次审计、把结论变成「放行 / 拦住问人」、确认时核对这次确认还管不管用。
 * 命令 ID、正文与附件都不经过它——放行之后由调用方用**同一次**发送意图去建命令，
 * 因此超时有界、取消是真取消、重发也不会换身份。
 *
 * P0-2（2026-10-31）：「同一次发送意图」不再靠调用方自觉。`check` 拿一份完整快照
 * （作用域 + 正文/模式/附件/Skill/资料/会话身份）出发，审计返回后**重新取一次当前快照**：
 *   · 一致 → 结论生效，并把**被核验过的那份快照**交回去，调用方按它提交；
 *   · 不一致 → 旧结论作废，按新快照重查一次（有界，最多两轮）；仍不稳定就判风险未知。
 * 这样「预检期间换了模型 / 切了目录 / 改了正文 / 删了附件」都不会拿旧的低风险结果发出去。
 */

const AUDIT_TIMEOUT_MS = 6_000;
/** 一次发送最多核验两轮：第一轮的结果被改动作废后，给当前状态一次机会。 */
const MAX_CHECK_ATTEMPTS = 2;

/** 超时是「没结论」，不是「没风险」：单独一个类型，才能和普通失败分开说。 */
class RiskAuditTimeoutError extends Error {}

async function requestSendAudit(client: RelayApiClient,
  scope: RiskSendScope): Promise<RiskAuditResult> {
  if (scope.resourceId === null) return { audit: null, failure: null, failureCode: null };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const audit = await Promise.race([
      client.getRequiredContextAudit({ resourceId: scope.resourceId,
        // P1-1：显式说明按哪类 Agent 的规则入口数，不依赖服务端默认值。
        agent: RELAY_REQUIRED_CONTEXT_AGENT,
        sessionId: scope.sessionId, model: scope.model,
        budgetTokens: scope.budgetTokens, refresh: true }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => { reject(new RiskAuditTimeoutError("风险检查超时（6 秒）。")); },
          AUDIT_TIMEOUT_MS);
      }),
    ]);
    return { audit, failure: null, failureCode: null };
  } catch (caught) {
    return { audit: null, failure: describeLiveError(caught).message,
      failureCode: caught instanceof RiskAuditTimeoutError ? "TIMEOUT" : "AUDIT_FAILED" };
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

/** 放行 = 「按这一份被核验过的快照发」；拦住 = 什么都不发。 */
export type RiskCheckOutcome =
  | { readonly kind: "SEND"; readonly snapshot: SendSnapshot }
  | { readonly kind: "BLOCKED" };
export type RiskConfirmVerdict = "SEND" | "STALE" | "NONE";

export interface SendRiskGateController {
  /** 屏上那一条确认（高风险或风险未知）；null 表示没有拦住发送。 */
  readonly gate: RiskGateWindow | null;
  /** 正在取审计：此时不允许再产生第二条发送。 */
  readonly busy: boolean;
  /**
   * 取一次审计并判定。
   *
   * `snapshot` 是这次要发的全部事实，`current` 用来在迟到响应里核对「还是当初那一次吗」：
   * 返回 null 表示已经不能发了（组件卸载、已有别的发送在途）；返回不同快照表示状态变了，
   * 这次读数作废并按新快照重查。`guard` 是调用方额外的存活判定（例如会话是不是还是那条）。
   */
  check(snapshot: SendSnapshot, current: () => SendSnapshot | null,
    guard?: () => boolean): Promise<RiskCheckOutcome>;
  /** 用户点「仍然发送」：STALE 表示确认不再适用，调用方必须放弃这一次发送。 */
  confirm(current: SendSnapshot): RiskConfirmVerdict;
  cancel(): void;
  /** 作用域变了就收回屏上的确认条：它已经不代表当前状态。 */
  syncScope(scopeSignature: string): void;
}

export function useSendRiskGate(client: RelayApiClient | null,
  options: { readonly onAudit?: (audit: RequiredContextAudit) => void } = {}): SendRiskGateController {
  const [gate, setGate] = useState<RiskGateWindow | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const confirmedRef = useRef<RiskConfirmation | null>(null);
  const onAuditRef = useRef(options.onAudit);
  onAuditRef.current = options.onAudit;

  /** 把一份快照变成屏上的确认条：它的指纹就是这一份快照，改动任何一项都会让它失效。 */
  const openGate = useCallback((next: RiskGateWindow): void => { setGate(next); }, []);

  const check = useCallback(async (snapshot: SendSnapshot,
    current: () => SendSnapshot | null, guard?: () => boolean): Promise<RiskCheckOutcome> => {
    // 没有连接：没有可查的东西，也不声称查过。
    if (client === null) return { kind: "SEND", snapshot };
    if (busyRef.current) return { kind: "BLOCKED" };
    busyRef.current = true;
    setBusy(true);
    try {
      let candidate = snapshot;
      for (let attempt = 0; attempt < MAX_CHECK_ATTEMPTS; attempt += 1) {
        const result = candidate.unknownReason === null || candidate.unknownReason === undefined
          ? await requestSendAudit(client, candidate.scope)
          : { audit: null, failure: null, failureCode: "SCOPE_UNKNOWN" as const };
        // 迟到响应的第一道闸：这次读数还是给「当前这个输入器/这条会话」的吗？
        if (guard !== undefined && !guard()) return { kind: "BLOCKED" };
        if (client !== liveClient()) return { kind: "BLOCKED" };
        const now = current();
        if (now === null) return { kind: "BLOCKED" };
        if (snapshotSignature(now) !== snapshotSignature(candidate)) {
          // 预检期间要发的东西变了：旧读数不代表这一次发送，废弃它并按当前状态重查。
          candidate = now;
          continue;
        }
        const scopeSignature = riskScopeSignature(candidate.scope);
        const payloadSignature = snapshotSignature(candidate);
        if (candidate.unknownReason !== null && candidate.unknownReason !== undefined) {
          // 连该扫哪个目录都确定不了：把调用方写清的原因原样说出来，不套一层「未知」。
          openGate({ kind: "UNKNOWN", severity: null, files: null, share: null,
            code: "SCOPE_UNKNOWN", message: candidate.unknownReason, fingerprint: null,
            scopeSignature, payloadSignature });
          return { kind: "BLOCKED" };
        }
        const outcome = classifyRiskAudit(result);
        if (outcome.kind === "PROCEED") { setGate(null); return { kind: "SEND", snapshot: candidate }; }
        if (outcome.kind === "CONFIRM") {
          if (confirmationApplies(confirmedRef.current, scopeSignature, outcome.audit.fingerprint)) {
            setGate(null);
            return { kind: "SEND", snapshot: candidate };
          }
          onAuditRef.current?.(outcome.audit);
          openGate({ kind: "CONFIRM", severity: outcome.audit.severity,
            files: outcome.audit.files.length, share: outcome.audit.budget.requiredTotalShare,
            code: null, message: null, fingerprint: outcome.audit.fingerprint,
            scopeSignature, payloadSignature });
          return { kind: "BLOCKED" };
        }
        // 未知风险：不自动放行，也不冒充安全，交互交给用户这一次选择。
        openGate({ kind: "UNKNOWN", severity: null, files: null, share: null, code: outcome.code,
          message: outcome.message, fingerprint: null, scopeSignature, payloadSignature });
        return { kind: "BLOCKED" };
      }
      // 两轮都没稳定下来：既不自动放行，也不假装查过。用户在确认条上看到的是当前状态。
      const latest = current();
      if (latest === null) return { kind: "BLOCKED" };
      openGate({ kind: "UNKNOWN", severity: null, files: null, share: null, code: "STATE_CHANGED",
        message: riskUnknownMessage("STATE_CHANGED"), fingerprint: null,
        scopeSignature: riskScopeSignature(latest.scope),
        payloadSignature: snapshotSignature(latest) });
      return { kind: "BLOCKED" };
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [client, openGate]);

  const confirm = useCallback((current: SendSnapshot): RiskConfirmVerdict => {
    const window = gate;
    if (window === null) return "NONE";
    setGate(null);
    if (isGateStale(window, { scopeSignature: riskScopeSignature(current.scope),
      payloadSignature: snapshotSignature(current) })) {
      confirmedRef.current = null;
      return "STALE";
    }
    if (window.kind === "CONFIRM" && window.fingerprint !== null) {
      confirmedRef.current = { fingerprint: window.fingerprint, scopeSignature: window.scopeSignature };
    }
    return "SEND";
  }, [gate]);

  const cancel = useCallback((): void => { setGate(null); }, []);

  const syncScope = useCallback((scopeSignature: string): void => {
    setGate((current) => current !== null && current.scopeSignature !== scopeSignature ? null : current);
  }, []);

  return { gate, busy, check, confirm, cancel, syncScope };
}
