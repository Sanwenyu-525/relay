import { beforeEach, describe, expect, it } from "vitest";
import {
  EMPTY_PREVIEW_RESTORE, PREVIEW_RESTORE_ENTRY_LIMIT, PREVIEW_RESTORE_SCOPE_LIMIT,
  PREVIEW_RESTORE_STORAGE_KEY, localPreviewRestoreStore
} from "../src/lib/previewRestore";

/**
 * 恢复数据只允许「安全描述」：来源 + 顺序 + 选中项。
 *
 * 这些断言是隐私边界的一部分：URL 的 path 与 query 可能带一次性凭据，
 * 一旦写进 localStorage 就等于在磁盘上留了副本，而且下次启动还会自动提示打开。
 */

class MemoryStorage implements Storage {
  private readonly items = new Map<string, string>();
  failWrites = false;
  get length() { return this.items.size; }
  clear() { this.items.clear(); }
  getItem(key: string) { return this.items.get(key) ?? null; }
  key(index: number) { return [...this.items.keys()][index] ?? null; }
  removeItem(key: string) { this.items.delete(key); }
  setItem(key: string, value: string) {
    if (this.failWrites) throw new Error("QuotaExceededError");
    this.items.set(key, value);
  }
  raw() { return this.items.get(PREVIEW_RESTORE_STORAGE_KEY) ?? ""; }
}

const scope = "workspace-1:conversation-1";

describe("内置网页预览的恢复描述", () => {
  let storage: MemoryStorage;
  beforeEach(() => { storage = new MemoryStorage(); });

  it("只保存来源，不保存 path、query、fragment 与正文", () => {
    const store = localPreviewRestoreStore(storage);
    store.write(scope, { entries: [{ origin: "https://example.com" }], selected: 0 });
    const raw = storage.raw();
    expect(raw).toContain("https://example.com");
    // 写入前上游已经只给来源；这里再确认落盘内容没有夹带其它字段。
    expect(raw.includes("token")).toBe(false);
    expect(raw.includes("path")).toBe(false);
    expect(raw.includes("title")).toBe(false);
    expect(JSON.parse(raw).version).toBe(1);
  });

  it("带 path 或凭据的值被丢弃，而不是猜一个来源写下去", () => {
    const store = localPreviewRestoreStore(storage);
    storage.setItem(PREVIEW_RESTORE_STORAGE_KEY, JSON.stringify({
      version: 1,
      scopes: {
        [scope]: {
          entries: [
            { origin: "https://example.com/patients/42?token=abc" },
            { origin: "http://user:pass@example.com" },
            { origin: "javascript:alert(1)" },
            { origin: "http://tauri.localhost/" },
            { origin: "https://kept.example" }
          ],
          selected: 3
        }
      }
    }));
    const read = store.read(scope);
    expect(read.entries.map((entry) => entry.origin)).toEqual(["https://kept.example"]);
    // 选中项被夹到有效范围内：不会指向已被丢弃的项。
    expect(read.selected).toBe(0);
  });

  it("同一来源的重复标签只留一个，数量有上限", () => {
    const store = localPreviewRestoreStore(storage);
    const entries = [
      { origin: "https://a.example" }, { origin: "https://a.example" },
      ...Array.from({ length: PREVIEW_RESTORE_ENTRY_LIMIT + 3 }, (_, index) => ({ origin: `https://s${index}.example` }))
    ];
    store.write(scope, { entries, selected: 99 });
    const read = store.read(scope);
    expect(read.entries.length).toBe(PREVIEW_RESTORE_ENTRY_LIMIT);
    expect(read.entries[0]!.origin).toBe("https://a.example");
    expect(read.selected).toBe(PREVIEW_RESTORE_ENTRY_LIMIT - 1);
  });

  it("作用域之间互不串页，且作用域数量有上限", () => {
    const store = localPreviewRestoreStore(storage);
    store.write("ws:a", { entries: [{ origin: "https://a.example" }], selected: 0 });
    store.write("ws:b", { entries: [{ origin: "https://b.example" }], selected: 0 });
    expect(store.read("ws:a").entries[0]!.origin).toBe("https://a.example");
    expect(store.read("ws:b").entries[0]!.origin).toBe("https://b.example");
    expect(store.read("ws:missing")).toEqual(EMPTY_PREVIEW_RESTORE);

    for (let index = 0; index < PREVIEW_RESTORE_SCOPE_LIMIT + 4; index += 1) {
      store.write(`ws:many-${index}`, { entries: [{ origin: `https://m${index}.example` }], selected: 0 });
    }
    const scopes = Object.keys(JSON.parse(storage.raw()).scopes);
    expect(scopes.length).toBeLessThanOrEqual(PREVIEW_RESTORE_SCOPE_LIMIT);
    // 最近写入的作用域必须在，早期作用域按淘汰规则消失。
    expect(scopes).toContain(`ws:many-${PREVIEW_RESTORE_SCOPE_LIMIT + 3}`);
    expect(scopes).not.toContain("ws:a");
  });

  it("清空一个作用域不影响其它作用域", () => {
    const store = localPreviewRestoreStore(storage);
    store.write("ws:a", { entries: [{ origin: "https://a.example" }], selected: 0 });
    store.write("ws:b", { entries: [{ origin: "https://b.example" }], selected: 0 });
    store.write("ws:a", { entries: [], selected: 0 });
    expect(store.read("ws:a")).toEqual(EMPTY_PREVIEW_RESTORE);
    expect(store.read("ws:b").entries.length).toBe(1);
  });

  it("损坏的存储与写入失败都退化为空状态，不抛错", () => {
    storage.setItem(PREVIEW_RESTORE_STORAGE_KEY, "{not json");
    const store = localPreviewRestoreStore(storage);
    expect(store.read(scope)).toEqual(EMPTY_PREVIEW_RESTORE);
    storage.setItem(PREVIEW_RESTORE_STORAGE_KEY, JSON.stringify({ version: 99, scopes: { [scope]: { entries: [{ origin: "https://x.example" }] } } }));
    expect(store.read(scope)).toEqual(EMPTY_PREVIEW_RESTORE);

    storage.failWrites = true;
    expect(() => store.write(scope, { entries: [{ origin: "https://example.com" }], selected: 0 })).not.toThrow();
    expect(() => store.clear()).not.toThrow();
    storage.failWrites = false;
    // 写失败之后仍能读到之前的内容（旧值没有被半写坏）。
    expect(store.read(scope)).toEqual(EMPTY_PREVIEW_RESTORE);
  });

  it("用户清理入口删除全部待恢复描述", () => {
    const store = localPreviewRestoreStore(storage);
    store.write(scope, { entries: [{ origin: "https://example.com" }], selected: 0 });
    expect(storage.raw()).not.toBe("");
    store.clear();
    expect(storage.raw()).toBe("");
    expect(store.read(scope)).toEqual(EMPTY_PREVIEW_RESTORE);
  });
});
