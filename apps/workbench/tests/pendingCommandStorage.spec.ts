import { afterEach, expect, it, vi } from "vitest";
import { clearPendingCommand, hasDurablePendingCommand, readPendingCommand,
  reservePendingCommand } from "../src/lib/pendingCommandStorage";

const key = "relay:test:workspace:object";
const command = { commandId: "original", title: "用户输入" };
function parse(value: unknown): typeof command | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  return typeof row.commandId === "string" && typeof row.title === "string"
    ? { commandId: row.commandId, title: row.title } : null;
}
afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); sessionStorage.clear(); });

it("迁移旧会话中的原命令后，即使会话结束仍可按原载荷恢复", () => {
  sessionStorage.setItem(key, JSON.stringify(command));
  expect(readPendingCommand(key, parse)).toEqual({ pending: command, available: true });
  sessionStorage.clear();
  expect(readPendingCommand(key, parse)).toEqual({ pending: command, available: true });
  expect(hasDurablePendingCommand(key, command, parse)).toBe(true);
});

it("本机存储与旧会话的命令不同，禁止覆盖或清理任一身份", () => {
  localStorage.setItem(key, JSON.stringify({ version: 1, pending: command }));
  const other = { commandId: "other", title: "另一条" };
  sessionStorage.setItem(key, JSON.stringify(other));
  expect(readPendingCommand(key, parse).available).toBe(false);
  expect(reservePendingCommand(key, command, parse)).toBe(false);
  expect(clearPendingCommand(key, command, parse)).toBe(false);
  expect(JSON.parse(sessionStorage.getItem(key)!)).toEqual(other);
  expect(JSON.parse(localStorage.getItem(key)!).pending).toEqual(command);
});

it("旧命令迁移失败时保留页内身份并禁止宣称持久恢复", () => {
  sessionStorage.setItem(key, JSON.stringify(command));
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("unavailable", "QuotaExceededError"); });
  expect(readPendingCommand(key, parse)).toEqual({ pending: command, available: false });
  expect(hasDurablePendingCommand(key, command, parse)).toBe(false);
  expect(JSON.parse(sessionStorage.getItem(key)!)).toEqual(command);
});

it("回执已确认但本机清理失败时保留记录，不能覆盖成新命令", () => {
  expect(reservePendingCommand(key, command, parse)).toBe(true);
  vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => { throw new DOMException("unavailable", "SecurityError"); });
  expect(clearPendingCommand(key, command, parse)).toBe(false);
  expect(reservePendingCommand(key, { commandId: "new", title: "另一条" }, parse)).toBe(false);
  expect(readPendingCommand(key, parse).pending).toEqual(command);
});

it("损坏或不可读取的恢复记录阻止新命令覆盖", () => {
  localStorage.setItem(key, "{bad json");
  expect(readPendingCommand(key, parse).available).toBe(false);
  expect(reservePendingCommand(key, command, parse)).toBe(false);
  expect(localStorage.getItem(key)).toBe("{bad json");
});
