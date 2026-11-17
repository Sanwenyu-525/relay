import { afterEach, describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router-dom";

import type { RelayAssistMessage } from "../src/api/dtos/assist";
import { MessageExecutionTraces } from "../src/components/MessageExecutionTraces";
import { mountReact } from "./mountApp";

let unmount: (() => void) | null = null;
afterEach(() => { unmount?.(); unmount = null; });

function message(overrides: Partial<RelayAssistMessage> = {}): RelayAssistMessage {
  return { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    sessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", seq: "3", role: "ASSISTANT",
    status: "COMPLETED", createdAt: "2026-11-15T01:00:00.000Z",
    updatedAt: "2026-11-15T01:00:01.000Z", intent: "DISCUSS", content: "完成",
    errorCode: null, providerErrorKind: null, sources: [], skill: null, skillInput: null,
    skillOutput: null, usage: { inputTokens: null, outputTokens: null, cacheReadTokens: null,
      cacheCreationTokens: null }, cancelRequested: false, steerRequested: false,
    attachments: [], withdrawnAt: null, withdrawnByRecallId: null, recall: null,
    ...overrides } as RelayAssistMessage;
}

async function render(data: RelayAssistMessage) {
  const mounted = await mountReact(<MemoryRouter><MessageExecutionTraces message={data} /></MemoryRouter>);
  unmount = mounted.unmount;
  return mounted.wrapper;
}

describe("聊天执行轨迹", () => {
  it("没有捕获任务和 Skill 事件时不渲染任何状态", async () => {
    const wrapper = await render(message());
    expect(wrapper.find(".assist-execution-traces").exists()).toBe(false);
  });

  it("把同一轮 AUTO + EXPLICIT 的真实聚合状态显示为一个记忆状态", async () => {
    const wrapper = await render(message({
      memoryCapture: { status: "FAILED", taskCount: 2, savedCount: 1, failedCount: 1,
        tasks: [
          { id: "11111111-1111-4111-8111-111111111111", kind: "EXPLICIT", status: "SUCCEEDED",
            attempts: 1, maxAttempts: 3, errorKind: null, lastError: null,
            updatedAt: "2026-11-15T01:00:05.000Z", completedAt: "2026-11-15T01:00:05.000Z" },
          { id: "22222222-2222-4222-8222-222222222222", kind: "AUTO", status: "FAILED",
            attempts: 3, maxAttempts: 3, errorKind: "PROVIDER", lastError: "模型超时",
            updatedAt: "2026-11-15T01:00:06.000Z", completedAt: "2026-11-15T01:00:06.000Z" },
        ] },
    }));
    const traces = wrapper.get(".assist-execution-traces");
    expect(traces.get(".assist-trace-status").text()).toBe("记忆保存失败");
    expect(traces.text()).toContain("部分保存：1 条已保存，1 条失败");
    expect(traces.text()).toContain("明确记住");
    expect(traces.text()).toContain("PROVIDER");
    expect(traces.text()).toContain("模型超时");
  });

  it("Skill 事件按真实顺序展示，失败与执行中使用各自状态", async () => {
    const wrapper = await render(message({
      skillInvocations: [
        { id: "33333333-3333-4333-8333-333333333333", skillId: "research",
          skillVersion: "1.0.0", skillSha256: "a".repeat(64), status: "SUCCEEDED",
          inputSummary: "整理资料", outputSummary: "摘要已生成", errorKind: null, errorDetail: null,
          requestedAt: "2026-11-15T01:00:01.000Z", startedAt: "2026-11-15T01:00:02.000Z",
          settledAt: "2026-11-15T01:00:10.000Z" },
        { id: "44444444-4444-4444-8444-444444444444", skillId: "contract",
          skillVersion: "2.0.0", skillSha256: "b".repeat(64), status: "FAILED",
          inputSummary: "生成合同", outputSummary: null, errorKind: "SKILL_OUTPUT_INVALID",
          errorDetail: "输出不是合法 JSON", requestedAt: "2026-11-15T01:00:11.000Z",
          startedAt: "2026-11-15T01:00:12.000Z", settledAt: "2026-11-15T01:00:14.000Z" },
      ],
    }));
    const skill = wrapper.get(".assist-skill-traces");
    expect(skill.text().indexOf("调用 Skill · research")).toBeLessThan(
      skill.text().indexOf("调用 Skill · contract"));
    expect(skill.text()).toContain("执行成功");
    expect(skill.text()).toContain("执行失败");
    expect(skill.text()).toContain("SKILL_OUTPUT_INVALID");
    expect(skill.text()).toContain("输出不是合法 JSON");
  });
});
