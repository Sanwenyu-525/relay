import { describe, expect, it } from "vitest";

import { assistSessionFrom, assistantProfileFrom } from "../src/api/parse/assist";

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