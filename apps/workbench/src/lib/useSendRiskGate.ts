import { useCallback, useRef, useState } from "react";

import type { RelayApiClient } from "../api/relayClient";
import type { RequiredContextAudit } from "../api/resources/requiredContext";
import { describeLiveError } from "./liveErrors";
import { liveClient } from "./relayConnection";
import { classifyRiskAudit, confirmationApplies, intentSignature, isGateStale,
  riskScopeSignature, type RiskAuditResult, type RiskConfirmation, type RiskGateWindow,
  type RiskSendScope, type SendIntent } from "./sendRiskGate";

/**
 * 发送前预检的控制器（2026-10-30，P0-C）。
 *
 * 两个输入器（新会话首条、已有会话）用的是同一套判定；此前两条 `gateSend` 是逐字复制的
 * 同一段代码，改一处漏一处的风险太高，因此收成这一个 hook。
 *
 * 它只做三件事：取一次审计、把结论变成「放行 / 拦住问人」、确认时核对这次确认还管不管用。
 * 命令 ID、正文与附件都不经过它——放行之后由调用方用**同一次**发送意图去建命令，
 * 因此超时有界、取消是真取消、重发也不会换身份。
 */

const AUDIT_TIMEOUT_MS = 6_000;

/** 超时是「没结论」，不是「没风险」：单独一个类型，才能和普通失败分开说。 */
class RiskAuditTimeoutError extends Error {}

async function requestSendAudit(client: RelayApiClient,
  scope: RiskSendScope): Promise<RiskAuditResult> {
  if (scope.resourceId === null) return { audit: null, failure: null, failureCode: null };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const audit = await Promise.race([
      client.getRequiredContextAudit({ resourceId: scope.resourceId,
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

export type RiskCheckVerdict = "PROCEED" | "BLOCKED";
export type RiskConfirmVerdict = "SEND" | "STALE" | "NONE";

export interface SendRiskGateController {
  /** 屏上那一条确认（高风险或风险未知）；null 表示没有拦住发送。 */
  readonly gate: RiskGateWindow | null;
  /** 正在取审计：此时不允许再产生第二条发送。 */
  readonly busy: boolean;
  /**
   * 取一次审计并判定。
   *
   * `guard` 用来在迟到响应里核对「还是当初那一次吗」：返回 false 时这次读数作废，
   * 既不写当前会话的显示状态，也不放行。
   */
  check(intent: SendIntent, scope: RiskSendScope, guard?: () => boolean): Promise<RiskCheckVerdict>;
  /** 用户点「仍然发送」：STALE 表示确认不再适用，调用方必须放弃这一次发送。 */
  confirm(scope: RiskSendScope, intent: SendIntent): RiskConfirmVerdict;
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

  const check = useCallback(async (intent: SendIntent, scope: RiskSendScope,
    guard?: () => boolean): Promise<RiskCheckVerdict> => {
    // 没有连接或没有绑定目录：没有可查的东西，也不声称查过。
    if (client === null || scope.resourceId === null) return "PROCEED";
    if (busyRef.current) return "BLOCKED";
    busyRef.current = true;
    setBusy(true);
    try {
      const result = await requestSendAudit(client, scope);
      if (guard !== undefined && !guard()) return "BLOCKED";
      if (client !== liveClient()) return "BLOCKED";
      const outcome = classifyRiskAudit(result);
      const scopeSignature = riskScopeSignature(scope);
      const payload = intentSignature(intent);
      if (outcome.kind === "PROCEED") { setGate(null); return "PROCEED"; }
      if (outcome.kind === "CONFIRM") {
        if (confirmationApplies(confirmedRef.current, scopeSignature, outcome.audit.fingerprint)) {
          setGate(null);
          return "PROCEED";
        }
        onAuditRef.current?.(outcome.audit);
        setGate({ kind: "CONFIRM", severity: outcome.audit.severity,
          files: outcome.audit.files.length, share: outcome.audit.budget.requiredTotalShare,
          code: null, message: null, fingerprint: outcome.audit.fingerprint,
          scopeSignature, payloadSignature: payload });
        return "BLOCKED";
      }
      // 未知风险：不自动放行，也不冒充安全，交互交给用户这一次选择。
      setGate({ kind: "UNKNOWN", severity: null, files: null, share: null, code: outcome.code,
        message: outcome.message, fingerprint: null, scopeSignature, payloadSignature: payload });
      return "BLOCKED";
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [client]);

  const confirm = useCallback((scope: RiskSendScope, intent: SendIntent): RiskConfirmVerdict => {
    const window = gate;
    if (window === null) return "NONE";
    setGate(null);
    const current = { scopeSignature: riskScopeSignature(scope),
      payloadSignature: intentSignature(intent) };
    if (isGateStale(window, current)) { confirmedRef.current = null; return "STALE"; }
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
