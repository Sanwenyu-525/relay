import type { RequiredContextAudit, RequiredContextSeverity } from "../api/resources/requiredContext";
import type { RelayChatMode } from "../api/relayClient";
import { chatModeCommandFromText } from "./chatModeCommand";

/**
 * 发送前风险预检的判定与失效规则（2026-10-30，P0-C）。
 *
 * 只做纯判定：不读 React 状态、不发请求、不生成命令 ID。界面用同一份规则回答三件事——
 * 这一次能不能直接发、要不要先停下来问人、刚才那次确认还算不算数。
 *
 * 放在组件外面是因为这几条最容易写成「读代码看着没问题」：超时放行、审计不可用被当成
 * 没有风险、确认期间换了模型或改了正文却沿用旧确认。只有纯函数才能用单测钉住。
 */

/** 审计没能给出结论的原因：界面据此说「未知」，不说成「没有风险」。 */
export type RiskAuditFailureCode = "TIMEOUT" | "NO_FILE_ACCESS" | "SCAN_UNAVAILABLE" | "AUDIT_FAILED";

/** 一次预检的作用域：模型、目录、会话、档位任一变化都必须重新检查。 */
export interface RiskSendScope {
  readonly resourceId: string | null;
  readonly sessionId: string | null;
  readonly model: string | null;
  readonly budgetTokens: number | null;
}

/** 预检的原始读数：`failureCode` 只在真的失败时出现。 */
export interface RiskAuditResult {
  readonly audit: RequiredContextAudit | null;
  readonly failure: string | null;
  readonly failureCode: RiskAuditFailureCode | null;
}

export type RiskAuditOutcome =
  | { readonly kind: "PROCEED" }
  | { readonly kind: "CONFIRM"; readonly audit: RequiredContextAudit }
  | { readonly kind: "UNKNOWN"; readonly code: RiskAuditFailureCode; readonly message: string };

/** 一次发送意图：正文与 `/plan`、`/goal` 解析出的模式，在预检之前就固定。 */
export interface SendIntent {
  readonly content: string;
  readonly chatMode: RelayChatMode | null;
}

/** 屏上那一条风险确认：只记数据不记闭包，确认时由界面重算当前状态再核对。 */
export interface RiskGateWindow {
  readonly kind: "CONFIRM" | "UNKNOWN";
  readonly severity: RequiredContextSeverity | null;
  readonly files: number | null;
  readonly share: number | null;
  readonly code: RiskAuditFailureCode | null;
  readonly message: string | null;
  readonly fingerprint: string | null;
  readonly scopeSignature: string;
  readonly payloadSignature: string;
}

/** 已经确认过的风险：同一指纹 + 同一作用域才算数。 */
export interface RiskConfirmation {
  readonly fingerprint: string;
  readonly scopeSignature: string;
}

const UNKNOWN_TEXT: Record<RiskAuditFailureCode, string> = {
  TIMEOUT: "风险检查超时，必读文件有多大目前未知。",
  NO_FILE_ACCESS: "这个目录的必读文件读不到（没有读取权限），风险未知。",
  SCAN_UNAVAILABLE: "现在无法扫描必读文件，风险未知。",
  AUDIT_FAILED: "风险检查没有完成，风险未知。",
};

/**
 * 判定一次预检的结果。
 *
 * 关键：**没有结论不等于没有风险**。超时、请求失败、无权限、扫描不可用一律走 UNKNOWN，
 * 停下来由用户当面选「仍然发送 / 取消」；只有服务端明确给出 `state === "OK"` 才可能放行。
 */
export function classifyRiskAudit(result: RiskAuditResult): RiskAuditOutcome {
  const { audit, failure, failureCode } = result;
  if (audit === null) {
    // 压根没发审计（未绑定目录）：这不是失败，调用方本就不该走到判定这一步。
    if (failure === null && failureCode === null) return { kind: "PROCEED" };
    const code = failureCode ?? "AUDIT_FAILED";
    const detail = failure === null || failure.trim() === "" ? "" : `（${failure}）`;
    return { kind: "UNKNOWN", code, message: `${UNKNOWN_TEXT[code]}${detail}` };
  }
  if (audit.state === "NO_FILE_ACCESS" || audit.state === "SCAN_UNAVAILABLE") {
    const detail = audit.detail.trim() === "" ? "" : `（${audit.detail}）`;
    return { kind: "UNKNOWN", code: audit.state, message: `${UNKNOWN_TEXT[audit.state]}${detail}` };
  }
  if (audit.state === "OK" && (audit.severity === "HIGH" || audit.severity === "SEVERE")) {
    return { kind: "CONFIRM", audit };
  }
  return { kind: "PROCEED" };
}

/** 作用域指纹：任何一个入参变化都算另一次预检，也意味着旧确认作废。 */
export function riskScopeSignature(scope: RiskSendScope): string {
  return [scope.resourceId ?? "-", scope.sessionId ?? "-", scope.model ?? "-",
    scope.budgetTokens === null ? "-" : String(scope.budgetTokens)].join("|");
}

/**
 * 待发内容的指纹：只判断「确认期间有没有改过要发的东西」，不参与命令身份。
 * 命令 ID 与正文在真正发送那一步才固定，这里不必把正文留在预检状态里。
 */
export function payloadSignature(content: string): string {
  let hash = 2166136261;
  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return `${content.length}:${hash.toString(16)}`;
}

/** 意图指纹：模式也算在内——同一段正文换了模式就是另一次发送。 */
export function intentSignature(intent: SendIntent): string {
  return payloadSignature(`${intent.chatMode ?? "-"}\u0000${intent.content}`);
}

/** 同一指纹、同一作用域才算「这次已经确认过」；换了模型或目录必须重新问一次。 */
export function confirmationApplies(confirmation: RiskConfirmation | null,
  scopeSignature: string, fingerprint: string): boolean {
  return confirmation !== null && confirmation.fingerprint === fingerprint &&
    confirmation.scopeSignature === scopeSignature;
}

/**
 * 确认条还管不管用：作用域或待发内容有一个变了，旧确认就不代表这一次发送。
 * 既不能沿用「已确认」直接发，也不能拿旧正文的确认去发新正文。
 */
export function isGateStale(gate: Pick<RiskGateWindow, "scopeSignature" | "payloadSignature">,
  current: { readonly scopeSignature: string; readonly payloadSignature: string }): boolean {
  return gate.scopeSignature !== current.scopeSignature ||
    gate.payloadSignature !== current.payloadSignature;
}

/**
 * 首条消息这一拍实际会发出去的正文与模式（P0-2）。
 *
 * '/plan 内容' 发出去的是内容本身，模式随命令一起走；普通文本就是 trim 后的原样。
 * 它在预检之前只被用来计算指纹，真正生成命令时再用一次；因此预检取消后原文与模式
 * 都还在，也不会把「先改了草稿再说」的情况混过去。
 */
export function firstSendPayload(draft: string): SendIntent {
  const trimmed = draft.trim();
  const modeCommand = chatModeCommandFromText(trimmed);
  if (modeCommand !== null && modeCommand.rest !== "") {
    return { content: modeCommand.rest, chatMode: modeCommand.mode };
  }
  return { content: trimmed, chatMode: null };
}
