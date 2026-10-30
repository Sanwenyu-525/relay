import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readContextBudgetDraft, writeContextBudgetDraft } from "../src/lib/contextBudgetDraft";

/**
 * 新会话上下文档位（256K／512K／1024K）的**边界与回归反例**。
 *
 * 这里只钉一件事：本机草稿层对「来源缺失 / 来源值不合法 / 重复新建 / 存储不可用」的处置。
 * 跨会话继承链与空白会话选档的界面路径由 tests/contextBudgetInheritance.spec.tsx 验，
 * 两层合起来才是完整覆盖；本文件不冒充那一层。
 */
const workspaceA = "11111111-1111-4111-8111-111111111111";
const workspaceB = "22222222-2222-4222-8222-222222222222";
const scopeProject = "project:22222222-2222-4222-8222-222222222222";
const scopeTask = "task:33333333-3333-4333-8333-333333333333";
const key = (workspace: string, scope: string): string =>
  `relay.workbench.contextBudgetDraft:1:${workspace}:${scope}`;

const seed = (workspace: string, scope: string, raw: string): void => {
  window.localStorage.setItem(key(workspace, scope), raw);
};

describe("新会话上下文档位的边界与回归反例", () => {
  beforeEach(() => { window.localStorage.clear(); });
  afterEach(() => { vi.restoreAllMocks(); window.localStorage.clear(); });

  it("① 来源缺失：没有任何草稿时读回 null，由调用方取缺省档", () => {
    expect(readContextBudgetDraft(workspaceA, scopeProject)).toBeNull();
  });

  it("② 三档都能落库并原样读回（256K／512K／1024K）", () => {
    for (const tier of [262_144, 524_288, 1_048_576] as const) {
      writeContextBudgetDraft(workspaceA, scopeProject, tier);
      expect(readContextBudgetDraft(workspaceA, scopeProject)).toBe(tier);
    }
  });

  it("③ 重复新建：同一作用域反复写入只留最后一份，不叠加也不漂移", () => {
    writeContextBudgetDraft(workspaceA, scopeProject, 262_144);
    writeContextBudgetDraft(workspaceA, scopeProject, 1_048_576);
    writeContextBudgetDraft(workspaceA, scopeProject, 1_048_576);
    expect(readContextBudgetDraft(workspaceA, scopeProject)).toBe(1_048_576);
    const mine = Object.keys(window.localStorage)
      .filter((item) => item.startsWith("relay.workbench.contextBudgetDraft"));
    expect(mine).toHaveLength(1);
  });

  it("④ 无效来源：落库值不在三档之内时读回 null，不继承非法档", () => {
    for (const bad of [0, -1, 128_000, 131_072, 262_143, 2_097_152]) {
      seed(workspaceA, scopeProject, JSON.stringify({ tokens: bad }));
      expect(readContextBudgetDraft(workspaceA, scopeProject)).toBeNull();
    }
  });

  it("⑤ 无效来源：tokens 是字符串／null／数组／对象时读回 null", () => {
    for (const bad of ["512K", null, [], {}, true]) {
      seed(workspaceA, scopeProject, JSON.stringify({ tokens: bad }));
      expect(readContextBudgetDraft(workspaceA, scopeProject)).toBeNull();
    }
  });

  it("⑥ 无效来源：坏 JSON 不抛错，读回 null", () => {
    seed(workspaceA, scopeProject, "{oops");
    expect(() => readContextBudgetDraft(workspaceA, scopeProject)).not.toThrow();
    expect(readContextBudgetDraft(workspaceA, scopeProject)).toBeNull();
  });

  it("⑦ 无效来源：顶层不是对象（数字／数组／null／字符串）时读回 null", () => {
    for (const bad of ["512", "[]", "null", "\"524288\"", "true"]) {
      seed(workspaceA, scopeProject, bad);
      expect(readContextBudgetDraft(workspaceA, scopeProject)).toBeNull();
    }
  });

  it("⑧ 重复新建不串档：工作区与作用域各自独立", () => {
    writeContextBudgetDraft(workspaceA, scopeProject, 262_144);
    writeContextBudgetDraft(workspaceA, scopeTask, 1_048_576);
    writeContextBudgetDraft(workspaceB, scopeProject, 524_288);
    expect(readContextBudgetDraft(workspaceA, scopeProject)).toBe(262_144);
    expect(readContextBudgetDraft(workspaceA, scopeTask)).toBe(1_048_576);
    expect(readContextBudgetDraft(workspaceB, scopeProject)).toBe(524_288);
    expect(readContextBudgetDraft(workspaceB, scopeTask)).toBeNull();
  });

  it("⑨ 显式撤销：write(null) 之后不再继承这份草稿", () => {
    writeContextBudgetDraft(workspaceA, scopeProject, 524_288);
    expect(readContextBudgetDraft(workspaceA, scopeProject)).toBe(524_288);
    writeContextBudgetDraft(workspaceA, scopeProject, null);
    expect(readContextBudgetDraft(workspaceA, scopeProject)).toBeNull();
    expect(window.localStorage.getItem(key(workspaceA, scopeProject))).toBeNull();
  });

  it("⑩ 存储不可用：读失败返回 null，写失败不抛", () => {
    vi.spyOn(window.localStorage, "getItem").mockImplementation(() => { throw new Error("storage 不可用"); });
    expect(() => readContextBudgetDraft(workspaceA, scopeProject)).not.toThrow();
    expect(readContextBudgetDraft(workspaceA, scopeProject)).toBeNull();
    vi.restoreAllMocks();
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => { throw new Error("storage 不可用"); });
    expect(() => writeContextBudgetDraft(workspaceA, scopeProject, 262_144)).not.toThrow();
  });
});