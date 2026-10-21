import { afterEach, describe, expect, it, vi } from "vitest";
import { readLastModel, writeLastModel } from "../src/lib/modelPreferences";

const workspaceA = "11111111-1111-4111-8111-111111111111";
const workspaceB = "22222222-2222-4222-8222-222222222222";
function key(workspaceId: string): string {
  return `relay.workbench.lastModel:1:${workspaceId}`;
}

afterEach(() => {
  window.localStorage.removeItem(key(workspaceA));
  window.localStorage.removeItem(key(workspaceB));
  vi.restoreAllMocks();
});

describe("模型选择的本机偏好", () => {
  it("写入后可原样读回，存储里只有型号没有业务身份", () => {
    writeLastModel(workspaceA, "agnes-3.0-flash");
    expect(readLastModel(workspaceA)).toBe("agnes-3.0-flash");
    expect(JSON.parse(window.localStorage.getItem(key(workspaceA))!)).toEqual({ model: "agnes-3.0-flash" });
  });

  it("按工作区分开：一个工作区的选择不带到另一个", () => {
    writeLastModel(workspaceA, "v/a:free");
    expect(readLastModel(workspaceB)).toBeNull();
  });

  it.each(["null", "{", JSON.stringify({ model: 42 }), JSON.stringify({ model: "  " }),
    JSON.stringify([1, 2]), JSON.stringify({ note: "no model field" })])(
    "无效值按「没有上次选择」处理：%s", (raw) => {
      window.localStorage.setItem(key(workspaceA), raw);
      expect(readLastModel(workspaceA)).toBeNull();
    });

  it("空值即删除，不留下占位记录", () => {
    writeLastModel(workspaceA, "v/a:free");
    writeLastModel(workspaceA, "   ");
    expect(window.localStorage.getItem(key(workspaceA))).toBeNull();
    expect(readLastModel(workspaceA)).toBeNull();
  });

  it("存储不可读或不可写时不抛，选择本身不受影响", () => {
    const read = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("disabled"); });
    expect(readLastModel(workspaceA)).toBeNull();
    read.mockRestore();
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("full"); });
    expect(() => writeLastModel(workspaceA, "v/a:free")).not.toThrow();
    write.mockRestore();
  });
});
