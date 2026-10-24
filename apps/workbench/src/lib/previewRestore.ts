/**
 * 内置网页预览的「可恢复描述」存储。
 *
 * 保守规则（对应[工作台 §50.3]）：
 * - 只保存**来源**（scheme + 主机 + 端口）、标签顺序和选中项；path / query / fragment /
 *   页面正文 / 浏览器存储一律不落盘。URL 的 path 也可能带私密标识，来源已是能安全保留的
 *   最大粒度。
 * - 带用户名或密码的地址不保存。
 * - 重启后只显示「待恢复」提示，用户点击才把地址填进地址栏并由用户确认加载；不自动重放。
 * - 存储有版本号；读取损坏、版本不符或写入失败都回退空状态，不影响对话与业务回执。
 *
 * 这里不新建数据库表：它是本机展示偏好，不是业务事实。
 */

export interface PreviewRestoreEntry {
  /** 只含 `scheme://host[:port]`。 */
  readonly origin: string;
}

export interface PreviewRestoreScopeState {
  readonly entries: readonly PreviewRestoreEntry[];
  readonly selected: number;
}

export interface PreviewRestoreStore {
  read(scope: string): PreviewRestoreScopeState;
  write(scope: string, state: PreviewRestoreScopeState): void;
  /** 用户显式清理入口：删掉全部待恢复描述，不影响工作台登录或业务数据。 */
  clear(): void;
}

export const PREVIEW_RESTORE_STORAGE_KEY = "relay.workbench.previewRestore.v1";
export const PREVIEW_RESTORE_VERSION = 1;
/** 最多记住多少个作用域；超出按最近写入淘汰。 */
export const PREVIEW_RESTORE_SCOPE_LIMIT = 12;
/** 单个作用域最多记住几个待恢复标签。 */
export const PREVIEW_RESTORE_ENTRY_LIMIT = 6;

export const EMPTY_PREVIEW_RESTORE: PreviewRestoreScopeState = { entries: [], selected: 0 };

interface StoredScope {
  entries: { origin: string }[];
  selected: number;
  /** 淘汰顺序用；不是业务时间。 */
  touched: number;
}

interface StoredDocument {
  version: number;
  /**
   * 单调递增的写入序号。用它而不是 `Date.now()` 做淘汰顺序：同一毫秒内的多次写入
   * 会让时间戳打平，淘汰结果就变成「看排序实现」而不是「看谁更旧」。
   */
  sequence: number;
  scopes: Record<string, StoredScope>;
}

function safeOrigin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > 512) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (parsed.username !== "" || parsed.password !== "") return null;
    // 只接受「已经是来源」的输入：带 path 的值说明上游没有按规则裁剪，直接丢弃而不是猜。
    if (parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") return null;
    const host = parsed.hostname.toLowerCase();
    if (host === "tauri.localhost" || host === "ipc.localhost") return null;
    return parsed.origin === "null" ? null : parsed.origin;
  } catch {
    return null;
  }
}

function sanitizeScope(value: unknown): PreviewRestoreScopeState {
  if (value === null || typeof value !== "object") return EMPTY_PREVIEW_RESTORE;
  const stored = value as { entries?: unknown; selected?: unknown };
  const rawEntries = Array.isArray(stored.entries) ? stored.entries : [];
  const entries: PreviewRestoreEntry[] = [];
  for (const item of rawEntries) {
    const origin = safeOrigin((item as { origin?: unknown } | null)?.origin);
    // 同一来源的重复标签没有恢复价值，按顺序去重。
    if (origin !== null && !entries.some((entry) => entry.origin === origin)) entries.push({ origin });
    if (entries.length >= PREVIEW_RESTORE_ENTRY_LIMIT) break;
  }
  const selected = typeof stored.selected === "number" && Number.isInteger(stored.selected)
    ? Math.min(Math.max(stored.selected, 0), Math.max(entries.length - 1, 0)) : 0;
  return { entries, selected };
}

function readDocument(storage: Storage): StoredDocument | null {
  const raw = storage.getItem(PREVIEW_RESTORE_STORAGE_KEY);
  if (raw === null) return null;
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object") return null;
  const document = parsed as { version?: unknown; scopes?: unknown; sequence?: unknown };
  if (document.version !== PREVIEW_RESTORE_VERSION) return null;
  if (document.scopes === null || typeof document.scopes !== "object") return null;
  return parsed as StoredDocument;
}

/** 本机存储实现。存储不可用（隐私模式、配额满、被禁用）时全部退化为「没有待恢复页」。 */
export function localPreviewRestoreStore(storage?: Storage): PreviewRestoreStore {
  const resolve = (): Storage | null => {
    if (storage !== undefined) return storage;
    try {
      return window.localStorage;
    } catch {
      return null;
    }
  };

  return {
    read(scope) {
      const target = resolve();
      if (target === null || scope === "") return EMPTY_PREVIEW_RESTORE;
      try {
        const document = readDocument(target);
        if (document === null) return EMPTY_PREVIEW_RESTORE;
        return sanitizeScope(document.scopes[scope]);
      } catch {
        // 损坏的 JSON 只丢恢复描述，不影响会话与业务回执。
        return EMPTY_PREVIEW_RESTORE;
      }
    },
    write(scope, state) {
      const target = resolve();
      if (target === null || scope === "") return;
      const clean = sanitizeScope(state);
      try {
        const document = readDocument(target) ?? { version: PREVIEW_RESTORE_VERSION, sequence: 0, scopes: {} };
        const sequence = (Number.isInteger(document.sequence) ? document.sequence : 0) + 1;
        document.sequence = sequence;
        if (clean.entries.length === 0) delete document.scopes[scope];
        else {
          document.scopes[scope] = { entries: clean.entries.map((entry) => ({ origin: entry.origin })),
            selected: clean.selected, touched: sequence };
        }
        const scopes = Object.entries(document.scopes);
        if (scopes.length > PREVIEW_RESTORE_SCOPE_LIMIT) {
          // 保留最近写入的若干个：序号大的先留，超出部分按最旧淘汰。
          scopes.sort((left, right) => (right[1].touched ?? 0) - (left[1].touched ?? 0));
          document.scopes = Object.fromEntries(scopes.slice(0, PREVIEW_RESTORE_SCOPE_LIMIT));
        }
        target.setItem(PREVIEW_RESTORE_STORAGE_KEY,
          JSON.stringify({ version: PREVIEW_RESTORE_VERSION, sequence, scopes: document.scopes }));
      } catch {
        // 写失败（配额/禁用）只影响下次恢复提示，不影响本次浏览。
      }
    },
    clear() {
      const target = resolve();
      if (target === null) return;
      try {
        target.removeItem(PREVIEW_RESTORE_STORAGE_KEY);
      } catch { /* 存储不可写时无需处理 */ }
    }
  };
}
