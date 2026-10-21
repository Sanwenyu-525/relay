import { afterEach, describe, expect, it, vi } from "vitest";

import { assistSessionFrom, assistantProfileFrom } from "../src/api/parse/assist";
import { RelayApiClient, RelayTransportError } from "../src/api/relayClient";

afterEach(() => vi.unstubAllGlobals());

/**
 * 助手会话的客户端解析（ADR-018 §25、命令契约 §10.60）。
 *
 * 只覆盖不依赖 DOM 与网络的判定：响应解析与会话身份字段。组件呈现在
 * `assistantModeSwitch.spec.ts`，浏览器几何在 `tests/browser/`。
 *
 * 解析层必须逐字核对：模式是词表外的值就报错，不静默回落成普通档——
 * 回落会让界面显示成「普通会话」而服务端按另一种身份处理。
 */

const baseSession = {
  id: "s1",
  project_id: "p1",
  task_id: null,
  title: "人设会话",
  status: "ACTIVE",
  revision: "1",
  created_at: "2026-10-06T00:00:00Z",
  updated_at: "2026-10-06T00:00:00Z",
};

describe("助手配置解析", () => {
  it("读出配置文本、修订与只读范围", () => {
    const profile = assistantProfileFrom({
      id: "a1", workspace_id: "w1", name: "审读", role_description: "只读复核这份改动",
      tone: "简短", read_scope: { roots: ["src"] }, status: "ACTIVE", revision: "3",
      created_at: "2026-10-06T00:00:00Z", updated_at: "2026-10-06T00:00:00Z",
    });
    expect(profile.name).toBe("审读");
    expect(profile.revision).toBe("3");
    expect(profile.readScope).toEqual({ roots: ["src"] });
    expect(profile.optionLabel).toBe("审读 · v3");
  });

  it("归档的助手仍可解析，选项据此标注", () => {
    const profile = assistantProfileFrom({
      id: "a2", workspace_id: "w1", name: "旧助手", role_description: "只读复核", tone: null,
      read_scope: {}, status: "ARCHIVED", revision: "1",
      created_at: "2026-10-06T00:00:00Z", updated_at: "2026-10-06T00:00:00Z",
    });
    expect(profile.status).toBe("ARCHIVED");
    expect(profile.optionLabel).toBe("旧助手 · v1 · 已归档");
  });

  it("缺字段时报错，不静默取默认值", () => {
    // 断言的是「报错」这件事，不是逐字文案：既有解析原语已经报 `字段 响应格式无效。`，
    // 助手配置复用同一原语，重复维护一份自己的措辞只会多一个能漂移的地方。
    expect(() => assistantProfileFrom({ id: "a1", workspace_id: "w1", name: "审读" }))
      .toThrow(/响应格式无效/u);
  });
});

describe("会话身份解析", () => {
  it("读出冻结身份与人设标签，标签用冻结修订", () => {
    const session = assistSessionFrom({
      ...baseSession,
      conversation_mode: "ASSISTANT",
      assistant_profile_id: "a1",
      assistant_profile_revision: "3",
      assistant_role: { name: "审读", role_description: "只读复核", tone: "简短", read_scope: {} },
      remember: true,
    });
    expect(session.conversationMode).toBe("ASSISTANT");
    expect(session.assistantProfileId).toBe("a1");
    // 显示的是建会话时冻结的那一版人设，不是助手的当前修订。
    expect(session.personaLabel).toBe("审读 · 人设 v3");
    expect(session.remember).toBe(true);
  });

  it("普通会话的身份字段为空，不虚构助手关系", () => {
    const session = assistSessionFrom({
      ...baseSession,
      conversation_mode: "AGENT",
      assistant_profile_id: null,
      assistant_profile_revision: null,
      assistant_role: null,
      remember: true,
    });
    expect(session.conversationMode).toBe("AGENT");
    expect(session.assistantProfileId).toBeNull();
    expect(session.personaLabel).toBeNull();
  });

  it("「一次性问答」读出 remember=false", () => {
    const session = assistSessionFrom({
      ...baseSession,
      conversation_mode: "ASSISTANT",
      assistant_profile_id: "a1",
      assistant_profile_revision: "1",
      assistant_role: { name: "审读", role_description: "只读复核", tone: null, read_scope: {} },
      remember: false,
    });
    expect(session.remember).toBe(false);
  });

  it("模式是词表外的值时报错，不回落成普通档", () => {
    // 回落会让界面显示「普通会话」而服务端按另一种身份处理，这是最糟的一种错。
    expect(() => assistSessionFrom({ ...baseSession, conversation_mode: "SOMETHING_ELSE" }))
      .toThrow(/会话响应格式无效/u);
  });

  it("模式字段缺失时按普通档读出，不报错", () => {
    // 缺失只可能来自迁移 0059 之前的响应——那时本来只有一种身份。
    const legacy = assistSessionFrom(baseSession);
    expect(legacy.conversationMode).toBe("AGENT");
    expect(legacy.assistantProfileId).toBeNull();
    expect(legacy.personaLabel).toBeNull();
    expect(legacy.remember).toBe(true);
  });

  it("助手会话缺人设快照时报错，不当成普通会话", () => {
    expect(() => assistSessionFrom({ ...baseSession, conversation_mode: "ASSISTANT",
      assistant_profile_id: "a1", assistant_profile_revision: "1", assistant_role: null }))
      .toThrow(/会话响应格式无效/u);
  });
});
/**
 * 默认工作目录（0117 / HTTP §10.96、运行架构 §2.8）。
 *
 * 这里只锁客户端读法与核对口径：三接口的请求形状、UNSET 与 UNAVAILABLE 互斥、
 * 修订单调、回执不符不冒充成功，以及会话上下文 `source` 的三态与旧字段缺省。
 * 页面可达性在 settingsDefaultDirectory.spec.ts，建会话继承在 folderFirstConversation.spec.ts。
 */
const defaultPrefix = "/api/v1/workspaces/w1";

function jsonBody(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function defaultApi() {
  return new RelayApiClient({ baseUrl: "http://127.0.0.1:8787", workspaceId: "w1", bearerToken: "synthetic" });
}

const unsetProjection = { resource_id: null, canonical_root: null, display_name: null,
  write_tier: null, status: "UNSET", reason: null, revision: "0" };
const readyProjection = { resource_id: "res-1", canonical_root: "D://Work//Demo",
  display_name: "Demo", write_tier: "READ_ONLY", status: "READY", reason: null, revision: "3" };

describe("Workspace 默认工作目录客户端", () => {
  it("UNSET：revision 读成 0、其余字段为 null，且读取不发写命令", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonBody(unsetProjection));
    vi.stubGlobal("fetch", fetcher);
    const value = await defaultApi().getWorkspaceDefaultDirectory();
    expect(value).toEqual({ resourceId: null, canonicalRoot: null, displayName: null,
      writeTier: null, status: "UNSET", reason: null, revision: "0" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[1]?.method).toBeUndefined();
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(`http://127.0.0.1:8787${defaultPrefix}/default-working-directory`);
  });

  it("READY 与 UNAVAILABLE 是两件事：失效保留原目录与档位并带原因", async () => {
    const fetcher = vi.fn(async () => jsonBody({ ...readyProjection, status: "UNAVAILABLE",
      reason: "PROJECT_ARCHIVED" }));
    vi.stubGlobal("fetch", fetcher);
    const value = await defaultApi().getWorkspaceDefaultDirectory();
    expect(value.status).toBe("UNAVAILABLE");
    expect(value.reason).toBe("PROJECT_ARCHIVED");
    // 失效不等于未配置：目录名与档位仍是读取到的事实，界面据此说清「哪个目录失效了」。
    expect(value.displayName).toBe("Demo");
    expect(value.writeTier).toBe("READ_ONLY");
    expect(value.revision).toBe("3");
  });

  it("UNSET 却带资源时按契约错误拒绝，不静默读成未设置", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonBody({ ...unsetProjection, resource_id: "res-1" })));
    await expect(defaultApi().getWorkspaceDefaultDirectory())
      .rejects.toThrow(/与 status 不一致/u);
  });

  it("设置命令提交最近修订与确切资源，回执按身份核对后返回新修订", async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>; bodies.push(body);
      return jsonBody({ command_id: body.command_id, committed_at: "2026-10-19T00:00:00Z",
        result: { workspace_id: "w1", resource_id: body.resource_id, revision: "4" } });
    }));
    const result = await defaultApi().setWorkspaceDefaultDirectory({ commandId: "cmd-1",
      expectedRevision: "3", resourceId: "res-1" });
    expect(bodies).toEqual([{ command_id: "cmd-1", expected_revision: "3", resource_id: "res-1" }]);
    expect(result).toEqual({ workspaceId: "w1", resourceId: "res-1", revision: "4" });
  });

  it("清除走 /clear、不携带 resource_id，且资源语义是 null", async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ url: String(input), body });
      return jsonBody({ command_id: body.command_id, committed_at: "2026-10-19T00:00:00Z",
        result: { workspace_id: "w1", resource_id: null, revision: "5" } });
    }));
    const result = await defaultApi().clearWorkspaceDefaultDirectory({
      commandId: "cmd-2", expectedRevision: "4" });
    expect(calls[0]?.url).toBe(`http://127.0.0.1:8787${defaultPrefix}/default-working-directory/clear`);
    expect(calls[0]?.body).toEqual({ command_id: "cmd-2", expected_revision: "4" });
    expect(result.resourceId).toBeNull();
    expect(result.revision).toBe("5");
  });

  it("回执命令 ID、Workspace 或目标资源不符时只报无法核对", async () => {
    for (const result of [
      { workspace_id: "w1", resource_id: "res-2", revision: "4" },
      { workspace_id: "w2", resource_id: "res-1", revision: "4" },
    ]) {
      vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonBody({ command_id: body.command_id, committed_at: "2026-10-19T00:00:00Z", result });
      }));
      await expect(defaultApi().setWorkspaceDefaultDirectory({ commandId: "cmd-3",
        expectedRevision: "3", resourceId: "res-1" })).rejects.toBeInstanceOf(RelayTransportError);
    }
    vi.stubGlobal("fetch", vi.fn(async () => jsonBody({ command_id: "other",
      committed_at: "2026-10-19T00:00:00Z",
      result: { workspace_id: "w1", resource_id: "res-1", revision: "4" } })));
    await expect(defaultApi().setWorkspaceDefaultDirectory({ commandId: "cmd-4",
      expectedRevision: "3", resourceId: "res-1" })).rejects.toBeInstanceOf(RelayTransportError);
  });
});

describe("会话工作目录来源", () => {
  const directory = (extra: Record<string, unknown>) => ({
    resource_id: "res-1", canonical_root: "D://Work//Demo", ...extra });
  const withContext = (workingDirectory: unknown) => assistSessionFrom({ ...baseSession,
    context: { project_goals: [], working_directory: workingDirectory } });

  it("WORKSPACE_DEFAULT 与 USER_PICKED 分别读出，不合并成一种来源", () => {
    expect(withContext(directory({ source: "WORKSPACE_DEFAULT" })).context?.workingDirectory?.source)
      .toBe("WORKSPACE_DEFAULT");
    expect(withContext(directory({ source: "USER_PICKED" })).context?.workingDirectory?.source)
      .toBe("USER_PICKED");
  });

  it("缺字段与显式 null 都读成历史未知，不编造来源", () => {
    expect(withContext(directory({})).context?.workingDirectory?.source).toBeNull();
    expect(withContext(directory({ source: null })).context?.workingDirectory?.source).toBeNull();
  });

  it("来源是词表外的值时显式失败，不猜成用户选择或默认目录", () => {
    expect(() => withContext(directory({ source: "SYSTEM" }))).toThrow(/source 响应格式无效/u);
  });
});
