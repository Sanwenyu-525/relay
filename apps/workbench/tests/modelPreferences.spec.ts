import { afterEach, describe, expect, it, vi } from "vitest";
import { readLastModelChoice, writeLastModelChoice } from "../src/lib/modelPreferences";

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
  it("型号与已登记连接一起写入并可原样读回", () => {
    writeLastModelChoice(workspaceA, { model: "vendor/registered", connectionId: "conn-1" });
    expect(readLastModelChoice(workspaceA)).toEqual({ model: "vendor/registered", connectionId: "conn-1" });
    expect(JSON.parse(window.localStorage.getItem(key(workspaceA))!))
      .toEqual({ model: "vendor/registered", connectionId: "conn-1" });
  });

  it("只记型号时连接身份为 null，旧格式 {model} 仍按型号读回", () => {
    writeLastModelChoice(workspaceA, { model: "agnes-3.0-flash", connectionId: null });
    expect(readLastModelChoice(workspaceA)).toEqual({ model: "agnes-3.0-flash", connectionId: null });
    expect(JSON.parse(window.localStorage.getItem(key(workspaceA))!)).toEqual({ model: "agnes-3.0-flash" });
    window.localStorage.setItem(key(workspaceA), JSON.stringify({ model: "legacy/model" }));
    expect(readLastModelChoice(workspaceA)).toEqual({ model: "legacy/model", connectionId: null });
  });

  it("连接身份只在字符串非空时保留，空串不冒充连接", () => {
    window.localStorage.setItem(key(workspaceA),
      JSON.stringify({ model: "v/a:free", connectionId: "   " }));
    expect(readLastModelChoice(workspaceA)).toEqual({ model: "v/a:free", connectionId: null });
  });

  it("按工作区分开：一个工作区的选择不带到另一个", () => {
    writeLastModelChoice(workspaceA, { model: "v/a:free", connectionId: null });
    expect(readLastModelChoice(workspaceB)).toBeNull();
  });

  it.each(["null", "{", JSON.stringify({ model: 42 }), JSON.stringify({ model: "  " }),
    JSON.stringify([1, 2]), JSON.stringify({ note: "no model field" })])(
    "无效值按「没有上次选择」处理：%s", (raw) => {
      window.localStorage.setItem(key(workspaceA), raw);
      expect(readLastModelChoice(workspaceA)).toBeNull();
    });

  it("空值即删除，不留下占位记录", () => {
    writeLastModelChoice(workspaceA, { model: "v/a:free", connectionId: "conn-1" });
    writeLastModelChoice(workspaceA, null);
    expect(window.localStorage.getItem(key(workspaceA))).toBeNull();
    expect(readLastModelChoice(workspaceA)).toBeNull();
    writeLastModelChoice(workspaceA, { model: "v/a:free", connectionId: null });
    writeLastModelChoice(workspaceA, { model: "   ", connectionId: null });
    expect(window.localStorage.getItem(key(workspaceA))).toBeNull();
  });

  it("存储不可读或不可写时不抛，选择本身不受影响", () => {
    const read = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("disabled"); });
    expect(readLastModelChoice(workspaceA)).toBeNull();
    read.mockRestore();
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("full"); });
    expect(() => writeLastModelChoice(workspaceA, { model: "v/a:free", connectionId: null })).not.toThrow();
    expect(() => writeLastModelChoice(workspaceA, null)).not.toThrow();
    write.mockRestore();
  });
});
