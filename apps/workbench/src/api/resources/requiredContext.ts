import { RelayContractError } from "../core/errors";
import { isRecord } from "../core/primitives";
import type { RelayHttp } from "../core/http";

/**
 * 项目必读文件体积审计（2026-10-30）。
 *
 * 这是**预计加载量**的读数，和上下文圆环（最近一次真实调用的实测用量）是两回事：
 * 圆环说「刚才那一轮用了多少」，这份说「下一轮开始前有多少必读内容要进去」。两者不互相
 * 覆盖，也不共用一个分母——混用会让用户以为「还没发送就已经超预算」。
 *
 * 阈值、比例、原因文案全部由服务端给出：前端只负责显示与交互，不复制一份判定逻辑，
 * 因此调整阈值不需要改界面，也不会出现界面比服务端更晚知道风险的情况。
 */

export type RequiredContextSeverity = "NONE" | "NOTICE" | "HIGH" | "SEVERE";

export type RequiredContextState = "OK" | "NO_FILE_ACCESS" | "SCAN_UNAVAILABLE";

export interface RequiredContextFileRisk {
  readonly path: string;
  readonly category: "AUTO_INJECTED" | "TASK_REQUIRED";
  readonly scope: "ROOT" | "NESTED" | "DECLARED";
  readonly reason: string;
  readonly bytes: number;
  readonly estimatedTokens: number;
  readonly modifiedAt: string;
  /** 占有效输入预算的比例；`null` = 分母不可用，界面不得画成 0%。 */
  readonly share: number | null;
  readonly severity: RequiredContextSeverity;
}

export interface RequiredContextBudget {
  readonly providerWindowTokens: number | null;
  readonly providerWindowKnown: boolean;
  readonly callBudgetTokens: number;
  readonly callBudgetSource: "SESSION" | "WORKSPACE_TIER" | "APPLICATION_DEFAULT";
  readonly effectiveInputTokens: number | null;
  readonly effectiveBasis: "PROVIDER_WINDOW" | "CALL_BUDGET" | "UNAVAILABLE";
  readonly reserves: { readonly outputTokens: number; readonly systemPromptTokens: number;
    readonly toolDefinitionTokens: number; readonly historyTokens: number };
  readonly estimatedTotalInputTokens: number | null;
  readonly requiredTotalTokens: number;
  readonly requiredTotalShare: number | null;
  readonly confidence: "EXACT_WINDOW" | "WINDOW_UNKNOWN" | "UNAVAILABLE";
  readonly estimate: { readonly method: string; readonly bytesPerToken: number;
    readonly note: string };
}

export interface RequiredContextAudit {
  readonly state: RequiredContextState;
  readonly detail: string;
  readonly agent: { readonly id: string; readonly label: string };
  readonly root: string | null;
  readonly scannedAt: string;
  /** 必读文件集合的指纹：变化即代表「本次忽略」需要重新评估。 */
  readonly fingerprint: string;
  readonly severity: RequiredContextSeverity;
  readonly files: readonly RequiredContextFileRisk[];
  readonly budget: RequiredContextBudget;
  readonly reasons: readonly { readonly code: string; readonly text: string;
    readonly ratio: number | null; readonly path: string | null }[];
  readonly suggestions: readonly { readonly code: string; readonly text: string }[];
  readonly skipped: readonly { readonly path: string; readonly reason: string }[];
  /** 「查看文件」复用的同一读取入口；无权限时为 null。 */
  readonly access: { readonly projectId: string; readonly connectionId: string } | null;
  readonly thresholds: { readonly singleFile: { readonly notice: number; readonly high: number;
    readonly severe: number }; readonly totalFiles: { readonly notice: number;
    readonly high: number; readonly severe: number } };
}

const SEVERITIES: readonly RequiredContextSeverity[] = ["NONE", "NOTICE", "HIGH", "SEVERE"];

function severityValue(value: unknown, name: string): RequiredContextSeverity {
  if (typeof value !== "string" || !SEVERITIES.includes(value as RequiredContextSeverity)) {
    throw new RelayContractError(`${name} 响应格式无效。`);
  }
  return value as RequiredContextSeverity;
}

function text(row: Record<string, unknown>, key: string, name: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new RelayContractError(`${name}.${key} 响应格式无效。`);
  return value;
}

function count(row: Record<string, unknown>, key: string, name: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new RelayContractError(`${name}.${key} 响应格式无效。`);
  }
  return value;
}

function nullableCount(row: Record<string, unknown>, key: string, name: string): number | null {
  return row[key] === null ? null : count(row, key, name);
}

/** 比例可以是小数；形状不对就显式失败，不用 0 兜底（0% 与「算不出来」必须分开）。 */
function ratio(row: Record<string, unknown>, key: string, name: string): number | null {
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new RelayContractError(`${name}.${key} 响应格式无效。`);
  }
  return value;
}

/** 阈值是 0..1 的小数，不能用整数校验。 */
function fraction(row: Record<string, unknown>, key: string, name: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new RelayContractError(`${name}.${key} 响应格式无效。`);
  }
  return value;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) throw new RelayContractError(`${name} 响应格式无效。`);
  return value;
}

function list(row: Record<string, unknown>, key: string, name: string): readonly unknown[] {
  const value = row[key];
  if (!Array.isArray(value)) throw new RelayContractError(`${name}.${key} 响应格式无效。`);
  return value;
}

function parseFile(value: unknown, index: number): RequiredContextFileRisk {
  const name = `required-context.files[${String(index)}]`;
  const row = record(value, name);
  const category = text(row, "category", name);
  const scope = text(row, "scope", name);
  if (category !== "AUTO_INJECTED" && category !== "TASK_REQUIRED") {
    throw new RelayContractError(`${name}.category 响应格式无效。`);
  }
  if (scope !== "ROOT" && scope !== "NESTED" && scope !== "DECLARED") {
    throw new RelayContractError(`${name}.scope 响应格式无效。`);
  }
  return {
    path: text(row, "path", name),
    category, scope,
    reason: text(row, "reason", name),
    bytes: count(row, "bytes", name),
    estimatedTokens: count(row, "estimated_tokens", name),
    modifiedAt: text(row, "modified_at", name),
    share: ratio(row, "share", name),
    severity: severityValue(row.severity, `${name}.severity`),
  };
}

function parseBudget(value: unknown): RequiredContextBudget {
  const name = "required-context.budget";
  const row = record(value, name);
  const source = text(row, "call_budget_source", name);
  const basis = text(row, "effective_basis", name);
  const confidence = text(row, "confidence", name);
  if (source !== "SESSION" && source !== "WORKSPACE_TIER" && source !== "APPLICATION_DEFAULT") {
    throw new RelayContractError(`${name}.call_budget_source 响应格式无效。`);
  }
  if (basis !== "PROVIDER_WINDOW" && basis !== "CALL_BUDGET" && basis !== "UNAVAILABLE") {
    throw new RelayContractError(`${name}.effective_basis 响应格式无效。`);
  }
  if (confidence !== "EXACT_WINDOW" && confidence !== "WINDOW_UNKNOWN" &&
      confidence !== "UNAVAILABLE") {
    throw new RelayContractError(`${name}.confidence 响应格式无效。`);
  }
  const reserves = record(row.reserves, `${name}.reserves`);
  const estimate = record(row.estimate, `${name}.estimate`);
  return {
    providerWindowTokens: nullableCount(row, "provider_window_tokens", name),
    providerWindowKnown: row.provider_window_known === true,
    callBudgetTokens: count(row, "call_budget_tokens", name),
    callBudgetSource: source,
    effectiveInputTokens: nullableCount(row, "effective_input_tokens", name),
    effectiveBasis: basis,
    reserves: { outputTokens: count(reserves, "output_tokens", `${name}.reserves`),
      systemPromptTokens: count(reserves, "system_prompt_tokens", `${name}.reserves`),
      toolDefinitionTokens: count(reserves, "tool_definition_tokens", `${name}.reserves`),
      historyTokens: count(reserves, "history_tokens", `${name}.reserves`) },
    estimatedTotalInputTokens: nullableCount(row, "estimated_total_input_tokens", name),
    requiredTotalTokens: count(row, "required_total_tokens", name),
    requiredTotalShare: ratio(row, "required_total_share", name),
    confidence,
    estimate: { method: text(estimate, "method", `${name}.estimate`),
      bytesPerToken: count(estimate, "bytes_per_token", `${name}.estimate`),
      note: text(estimate, "note", `${name}.estimate`) },
  };
}

export function requiredContextAuditFrom(value: unknown): RequiredContextAudit {
  const name = "required-context";
  const row = record(value, name);
  const state = text(row, "state", name);
  if (state !== "OK" && state !== "NO_FILE_ACCESS" && state !== "SCAN_UNAVAILABLE") {
    throw new RelayContractError(`${name}.state 响应格式无效。`);
  }
  const agent = record(row.agent, `${name}.agent`);
  const thresholds = record(row.thresholds, `${name}.thresholds`);
  const single = record(thresholds.single_file, `${name}.thresholds.single_file`);
  const total = record(thresholds.total_files, `${name}.thresholds.total_files`);
  return {
    state,
    detail: text(row, "detail", name),
    agent: { id: text(agent, "id", `${name}.agent`), label: text(agent, "label", `${name}.agent`) },
    root: row.root === null ? null : text(row, "root", name),
    scannedAt: text(row, "scanned_at", name),
    fingerprint: text(row, "fingerprint", name),
    severity: severityValue(row.severity, `${name}.severity`),
    files: list(row, "files", name).map(parseFile),
    budget: parseBudget(row.budget),
    reasons: list(row, "reasons", name).map((entry, index) => {
      const item = record(entry, `${name}.reasons[${String(index)}]`);
      return { code: text(item, "code", `${name}.reasons`), text: text(item, "text", `${name}.reasons`),
        ratio: ratio(item, "ratio", `${name}.reasons`),
        path: item.path === null ? null : text(item, "path", `${name}.reasons`) };
    }),
    suggestions: list(row, "suggestions", name).map((entry) => {
      const item = record(entry, `${name}.suggestions`);
      return { code: text(item, "code", `${name}.suggestions`),
        text: text(item, "text", `${name}.suggestions`) };
    }),
    skipped: list(row, "skipped", name).map((entry) => {
      const item = record(entry, `${name}.skipped`);
      return { path: text(item, "path", `${name}.skipped`),
        reason: text(item, "reason", `${name}.skipped`) };
    }),
    access: row.access === null ? null : (() => {
      const item = record(row.access, `${name}.access`);
      return { projectId: text(item, "project_id", `${name}.access`),
        connectionId: text(item, "connection_id", `${name}.access`) };
    })(),
    thresholds: {
      singleFile: { notice: fraction(single, "notice", `${name}.thresholds.single_file`),
        high: fraction(single, "high", `${name}.thresholds.single_file`),
        severe: fraction(single, "severe", `${name}.thresholds.single_file`) },
      totalFiles: { notice: fraction(total, "notice", `${name}.thresholds.total_files`),
        high: fraction(total, "high", `${name}.thresholds.total_files`),
        severe: fraction(total, "severe", `${name}.thresholds.total_files`) },
    },
  };
}

export interface RequiredContextAuditQuery {
  readonly resourceId: string;
  /** 按哪类 Agent 的规则入口枚举；省略即服务端默认（Relay 内置 Agent）。 */
  readonly agent?: string | null;
  readonly model?: string | null;
  /** 会话 id：0145 起单次调用预算以会话档位为准，有会话就必须传。 */
  readonly sessionId?: string | null;
  /** 新会话首条消息尚无会话行时，用户已选的上下文档位（与建会话载荷同一个数）。 */
  readonly budgetTokens?: number | null;
  /** 跳过服务端的目录遍历缓存（发送前与手动刷新用）。 */
  readonly refresh?: boolean;
}

export async function getRequiredContextAudit(http: RelayHttp,
  query: RequiredContextAuditQuery): Promise<RequiredContextAudit> {
  const search = new URLSearchParams();
  if (query.agent !== undefined && query.agent !== null && query.agent !== "") {
    search.set("agent", query.agent);
  }
  if (query.model !== undefined && query.model !== null && query.model !== "") {
    search.set("model", query.model);
  }
  if (query.sessionId !== undefined && query.sessionId !== null && query.sessionId !== "") {
    search.set("session_id", query.sessionId);
  }
  if (typeof query.budgetTokens === "number" && query.budgetTokens > 0) {
    search.set("budget_tokens", String(Math.round(query.budgetTokens)));
  }
  if (query.refresh === true) search.set("refresh", "1");
  const query0 = search.toString();
  const suffix = query0 === "" ? "" : `?${query0}`;
  return requiredContextAuditFrom(await http.request(
    http.workspacePath(`/working-directories/${query.resourceId}/required-context-audit${suffix}`)));
}
