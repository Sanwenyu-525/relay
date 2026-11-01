import { describe, expect, it } from "vitest";
import type { RelayAssistLivePreview, RelayAssistMessage, RelayAssistProposal } from "../src/api/dtos/assist";
import { candidateProposalsFor, livePreviewFor } from "../src/views/AssistView";
import { assistantMessage, candidateProposal, livePreview, userMessage } from "../src/dev/scenarioFixtures";

/**
 * 渲染决策的单一事实来源（UI-LAB-REAL-PARITY-01 P0-B）。
 *
 * 钉的是「同一组产品级输入必须导出同一组呈现决策」这件事本身：草稿可见性、候选成果挂载
 * 这两个判断过去在正式会话的调用方与场景实验室各写一份，两份会随时间分叉。现在它们都是
 * `AssistView` 导出的纯函数，产品调用方与实验室宿主读同一个答案，这里逐条钉住输入组合。
 *
 * 这些用例不是「实验室的特殊要求」：每一条都对应正式会话里真会出现的读数——
 * 在途与终态、失权那一刻、迟到的别条消息的帧、非 DISCUSS 意图、带 Skill 的回复、取消中。
 */

const frame = (patch: Partial<RelayAssistLivePreview> = {}): RelayAssistLivePreview =>
  livePreview(patch);

describe("livePreviewFor：草稿可见性只有一处定义", () => {
  it.each([
    ["PENDING（已提交、Worker 未领取）", assistantMessage({ status: "PENDING", content: null })],
    ["RUNNING（正在生成）", assistantMessage({ status: "RUNNING", content: null })]
  ] as const)("%s + 属于它自己的一帧 → 可见", (_label, message) => {
    expect(livePreviewFor(message, frame(), false)).not.toBeNull();
  });

  it.each([
    ["正文已落定", assistantMessage({ status: "COMPLETED", content: "终态正文" })],
    ["生成失败", assistantMessage({ status: "FAILED", content: null, errorCode: "MODEL_TIMEOUT" })],
    ["已取消", assistantMessage({ status: "CANCELLED", content: null })],
    ["取消请求已发出", assistantMessage({ status: "RUNNING", content: null, cancelRequested: true })],
    ["非 DISCUSS 意图（请求任务提案）", assistantMessage({ status: "RUNNING", content: null,
      intent: "PROPOSE_TASK" })],
    ["Skill 回复", assistantMessage({ status: "RUNNING", content: null, skill: { id: "s", version: "1",
      sha256: null, definitionAvailability: "AVAILABLE", outputAvailability: "PENDING", target: null,
      availability: null, missingCapabilities: [] } })]
  ] as const)("%s → 不画草稿", (_label, message) => {
    expect(livePreviewFor(message, frame(), false)).toBeNull();
  });

  it("写栅栏落下（失权）时连同过渡草稿一起撤掉", () => {
    const message = assistantMessage({ status: "RUNNING", content: null });
    expect(livePreviewFor(message, frame(), true)).toBeNull();
  });

  it("一帧只属于它那一条消息：别条消息的帧不能画到这一行", () => {
    const message = assistantMessage({ id: "mock-msg-a2", status: "RUNNING", content: null });
    expect(livePreviewFor(message, frame(), false)).toBeNull();
    // 同一轮的另一条读数（会话换了）同样不透传。
    expect(livePreviewFor(message, frame({ sessionId: "mock-session-other" }), false)).toBeNull();
  });

  it("用户消息永远不画草稿：哪怕这一帧的身份正好对上它", () => {
    // 身份核对放在角色之后：这里刻意让 messageId 与 sessionId 都匹配，
    // 排除「其实是被身份挡掉的」，把这条断言钉在角色上。
    const message = userMessage("提问");
    expect(livePreviewFor(message, frame({ messageId: message.id }), false)).toBeNull();
  });

  it("没有帧就是没有帧，不返回一个空对象撑出草稿区", () => {
    expect(livePreviewFor(assistantMessage({ status: "RUNNING", content: null }), null, false)).toBeNull();
  });

  it("同一份输入在产品与实验室读出同一个对象（引用同一处判定，不是两份等价实现）", () => {
    const message = assistantMessage({ status: "RUNNING", content: null });
    const preview = frame({ previewText: "一段草稿", previewAvailable: true });
    expect(livePreviewFor(message, preview, false)).toBe(preview);
    expect(livePreviewFor(message as RelayAssistMessage, preview, false)).toBe(
      livePreviewFor(message, preview, false));
  });
});

describe("candidateProposalsFor：候选成果卡的挂载条件只有一处定义", () => {
  const proposals: readonly RelayAssistProposal[] = [
    candidateProposal(),
    candidateProposal({ id: "mock-proposal-2", messageId: "mock-msg-other" })
  ];

  it("已完成的助手消息只拿到属于它自己的那份", () => {
    const message = assistantMessage({ status: "COMPLETED", content: "正文" });
    expect(candidateProposalsFor(message, proposals).map((item) => item.id)).toEqual(["mock-proposal-1"]);
  });

  it("在途、失败、取消的助手消息不挂候选卡", () => {
    for (const status of ["PENDING", "RUNNING", "FAILED", "CANCELLED"] as const) {
      expect(candidateProposalsFor(assistantMessage({ status, content: null }), proposals)).toEqual([]);
    }
  });

  it("用户消息不挂候选卡", () => {
    expect(candidateProposalsFor(userMessage("提问"), proposals)).toEqual([]);
  });
});
