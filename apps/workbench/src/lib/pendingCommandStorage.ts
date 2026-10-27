/** 本机恢复线索不是业务事实：只保存冻结命令，结论仍以服务端回执为准。 */
type Parser<T> = (value: unknown) => T | null;
type PendingRead<T> = { readonly pending: T | null; readonly available: boolean };

function same<T>(left: T, right: T): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function decode<T>(raw: string, parse: Parser<T>, durable: boolean): T | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!durable) return parse(value);
    if (!value || typeof value !== "object") return null;
    const envelope = value as Record<string, unknown>;
    return envelope.version === 1 ? parse(envelope.pending) : null;
  } catch { return null; }
}

/** 兼容旧会话记录；迁移失败、数据损坏或两份记录冲突时禁止创建新命令。 */
export function readPendingCommand<T>(key: string, parse: Parser<T>): PendingRead<T> {
  try {
    const durableRaw = localStorage.getItem(key);
    const legacyRaw = sessionStorage.getItem(key);
    const durable = durableRaw === null ? null : decode(durableRaw, parse, true);
    const legacy = legacyRaw === null ? null : decode(legacyRaw, parse, false);
    if ((durableRaw !== null && durable === null) || (legacyRaw !== null && legacy === null) ||
      (durable !== null && legacy !== null && !same(durable, legacy))) {
      return { pending: null, available: false };
    }
    if (durable === null && legacy !== null) {
      const serialized = JSON.stringify({ version: 1, pending: legacy });
      try {
        localStorage.setItem(key, serialized);
        if (localStorage.getItem(key) !== serialized) return { pending: legacy, available: false };
      } catch { return { pending: legacy, available: false }; }
      try { sessionStorage.removeItem(key); } catch { /* 两份记录相同，后续清理时继续核对。 */ }
      return { pending: legacy, available: true };
    }
    return { pending: durable, available: true };
  } catch { return { pending: null, available: false }; }
}

/** 发送前先确认同作用域没有另一条命令，并验证持久化写入。 */
export function reservePendingCommand<T>(key: string, pending: T, parse: Parser<T>): boolean {
  const current = readPendingCommand(key, parse);
  if (!current.available || (current.pending !== null && !same(current.pending, pending))) return false;
  if (current.pending !== null && hasDurablePendingCommand(key, pending, parse)) return true;
  try {
    const serialized = JSON.stringify({ version: 1, pending });
    localStorage.setItem(key, serialized);
    return localStorage.getItem(key) === serialized;
  } catch { return false; }
}

/** 只清除与当前已结算命令一致的记录；清理失败时保留页内 pending。 */
export function clearPendingCommand<T>(key: string, expected: T | null, parse: Parser<T>): boolean {
  const current = readPendingCommand(key, parse);
  if (!current.available || (current.pending !== null &&
    (expected === null || !same(current.pending, expected)))) return false;
  try {
    localStorage.removeItem(key);
    sessionStorage.removeItem(key);
    return localStorage.getItem(key) === null && sessionStorage.getItem(key) === null;
  } catch { return false; }
}

export function hasDurablePendingCommand<T>(key: string, expected: T, parse: Parser<T>): boolean {
  try {
    const raw = localStorage.getItem(key);
    const stored = raw === null ? null : decode(raw, parse, true);
    return stored !== null && same(stored, expected);
  } catch { return false; }
}
