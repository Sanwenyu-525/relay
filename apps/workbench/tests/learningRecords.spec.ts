import { afterEach, expect, it, vi } from "vitest";
import { createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import LearningRecordsPanel, { learningRoundText } from "../src/components/LearningRecordsPanel";
import { activateRelayConnection, liveClient, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { flush, mountReact } from "./mountApp";

const sessionId = "22222222-2222-4222-8222-222222222222";
const conceptId = "33333333-3333-4333-8333-333333333333";
const evidenceId = "44444444-4444-4444-8444-444444444444";
const evidence = { evidence_id: evidenceId, kind: "GAP", scenario: "重复提交", detail: "混淆请求和任务的身份",
  disposition: "PENDING_REVIEW", source_kind: "LEARNING_MESSAGE", source_message_id: evidenceId,
  session_id: sessionId, observed_at: "2026-10-13T00:00:00Z" };
const concept = { concept_id: conceptId, topic: "可靠性", display_name: "幂等性", generation: "2", revision: "4", evidence: [evidence] };
const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as Response;
afterEach(() => { resetRelayConnectionForTest(); vi.unstubAllGlobals(); window.localStorage.clear(); });

async function setup(options: { loseDelete?: boolean; conflict?: boolean } = {}) {
  activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId: "11111111-1111-4111-8111-111111111111", bearerToken: "test" });
  const posts: Record<string, unknown>[] = [];
  let concepts = [concept]; let enabled = false; let revision = "2"; let readFailed = false; let wrongReceipt = true;
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (path.includes("/commands/")) return json({ command_id: posts[0]!.command_id,
      command_type: wrongReceipt ? "ClearLearningRecords" : "DeleteLearningEvidence",
      committed_at: "2026-10-13T00:00:00Z", result: { deleted: true, concept_id: conceptId, generation: "3" } });
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>; posts.push(body);
      if (options.conflict) return json({ status: 409, code: "REVISION_CONFLICT", detail: "记录已变化，请刷新后决定。" }, 409);
      let result: unknown;
      if (path.endsWith("deletions")) {
        concepts = []; result = { deleted: true, concept_id: conceptId, generation: "3" };
        if (options.loseDelete) { options.loseDelete = false; throw new TypeError("response lost"); }
      } else if (path.endsWith("corrections")) {
        result = { concept_id: conceptId, evidence_id: evidenceId, generation: "3" };
      } else if (path.endsWith("clearances")) {
        concepts = []; result = { epoch: "1", cleared_evidence: 1, cleared_concepts: 1, cancelled_rounds: 0 };
      } else { enabled = body.records_enabled as boolean; revision = "3";
        result = { session_id: sessionId, records_enabled: enabled, revision }; }
      return json({ command_id: body.command_id, committed_at: "2026-10-13T00:00:00Z", result });
    }
    if (readFailed) return json({ status: 503, code: "DATABASE_UNAVAILABLE", detail: "暂不可读" }, 503);
    if (path.endsWith("learning-records")) return json({ epoch: "0", cleared_at: null, concepts });
    if (path.endsWith("state")) return json({ session_id: sessionId, records_enabled: enabled, revision, rounds: [] });
    if (path.endsWith("continuation")) return json({ session_id: sessionId, goal: "理解幂等性", last_observed_at: evidence.observed_at,
      topics: [], open_items: concepts.length ? [{ concept_id: conceptId, display_name: "幂等性", kind: "GAP", disposition: "PENDING_REVIEW", detail: evidence.detail, scenario: evidence.scenario }] : [] });
    throw new Error(`unexpected ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  const navigation = vi.fn(); const transfer = vi.fn();
  const view = await mountReact(createElement(MemoryRouter, null, createElement(LearningRecordsPanel,
    { client: liveClient()!, sessionId, refreshKey: "1", blocked: false, writeBlocked: false,
      inflight: false, defaultBackground: "方案：在原命令中保存回执；未决项：作用域。",
      onStateChange: vi.fn(), onNavigationChange: navigation, onTransfer: transfer })));
  await flush();
  return { ...view, posts, navigation, transfer, fetchMock,
    failReads: () => { readFailed = true; }, validReceipt: () => { wrongReceipt = false; } };
}
const button = (view: Awaited<ReturnType<typeof setup>>, text: string) => view.wrapper.findAll("button").find((item) => item.text() === text)!;

it("读取恢复会话关闭开关，按性质显示依据；UI 查看不启动模型", async () => {
  const view = await setup();
  expect(view.wrapper.text()).toContain("具体缺口 · 待复核");
  expect((view.wrapper.get('[data-testid="learning-record-control"]').element as HTMLInputElement).checked).toBe(false);
  expect(view.posts).toHaveLength(0);
  await view.wrapper.get('[data-testid="learning-record-control"]').setValue(true);
  await flush();
  expect(view.posts[0]).toMatchObject({ records_enabled: true, expected_revision: "2" });
  expect(view.wrapper.text()).toContain("后续学习记录已开启");
  view.unmount();
});

it("删除响应丢失保留原命令，错回执不放行；核对后重读，不从回执复原旧正文", async () => {
  const view = await setup({ loseDelete: true });
  await button(view, "删除这条依据").trigger("click"); await flush();
  expect(view.posts[0]).toMatchObject({ evidence_id: evidenceId, expected_generation: "2" });
  expect(view.navigation.mock.lastCall?.[0].pending.commandId).toBe(view.posts[0]!.command_id);
  await button(view, "核对学习命令回执").trigger("click"); await flush();
  expect(view.wrapper.text()).toContain("回执与原学习命令不匹配");
  view.validReceipt();
  await button(view, "核对学习命令回执").trigger("click"); await flush();
  expect(view.posts).toHaveLength(1);
  expect(view.wrapper.text()).not.toContain(evidence.detail);
  expect(view.navigation.mock.lastCall?.[0].pending).toBeNull();
  view.unmount();
});

it("纠正保存为明确用户控制，不伪造来源消息；草稿交给原导航守卫", async () => {
  const view = await setup();
  await button(view, "纠正我的记录").trigger("click");
  await view.wrapper.get("form input").setValue("重试作用域");
  await view.wrapper.get("form textarea").setValue("上次其实没懂");
  expect(view.navigation.mock.lastCall?.[0].dirty).toBe(true);
  await view.wrapper.get("form").trigger("submit"); await flush();
  expect(view.posts[0]).toMatchObject({ session_id: sessionId, concept_id: conceptId, scenario: "重试作用域", detail: "上次其实没懂" });
  expect(view.posts[0]).not.toHaveProperty("source_message_id");
  expect(view.wrapper.text()).toContain("作为用户自述保存");
  view.unmount();
});

it("冲突不显示保存成功，读取失败清掉旧记录并保留可恢复入口", async () => {
  const view = await setup({ conflict: true });
  await button(view, "删除这条依据").trigger("click"); await flush();
  expect(view.wrapper.text()).toContain("服务端版本已经变化");
  expect(view.wrapper.text()).not.toContain("已删除");
  view.failReads(); await button(view, "刷新学习记录").trigger("click"); await flush();
  expect(view.wrapper.text()).not.toContain(evidence.detail);
  expect(view.wrapper.text()).toContain("记录暂不可读");
  view.unmount();
});

it("全清必须说明范围并确认；清后不显示已删依据", async () => {
  const view = await setup();
  await button(view, "清空全部学习记录").trigger("click");
  expect(view.posts).toHaveLength(0);
  expect(view.wrapper.text()).toContain("原聊天、项目资料和执行事实保留");
  await button(view, "确认清除学习记录").trigger("click"); await flush();
  expect(view.posts).toHaveLength(1);
  expect(view.wrapper.text()).not.toContain(evidence.detail);
  expect(view.wrapper.text()).toContain("原聊天保留");
  view.unmount();
});

it("明确转执行自动带入可编辑方案，未输入执行要求时不放行", async () => {
  const view = await setup();
  const summary = view.wrapper.findAll("summary").find((item) => item.text() === "转入普通执行会话")!;
  await summary.trigger("click");
  const inputs = view.wrapper.findAll("textarea");
  expect((inputs[1]!.element as HTMLTextAreaElement).value).toContain("未决项");
  expect((button(view, "转入执行").element as HTMLButtonElement).disabled).toBe(true);
  await inputs[0]!.setValue("按这个方案实现");
  await button(view, "转入执行").trigger("click");
  expect(view.transfer).toHaveBeenCalledWith("按这个方案实现", expect.stringContaining("未决项"));
  expect(view.posts).toHaveLength(0);
  view.unmount();
});

it("保存失败和未结算不可伪装为已保存，关闭记录单独呈现", () => {
  expect(learningRoundText({ messageId: "m", status: "REJECTED", rejectionReason: "LEARNING_EVIDENCE_REF_INVALID", recordEnabled: true })).toContain("未更新");
  expect(learningRoundText({ messageId: "m", status: "PENDING", rejectionReason: null, recordEnabled: true })).toContain("尚未确认");
  expect(learningRoundText({ messageId: "m", status: "SETTLED", rejectionReason: null, recordEnabled: false })).toContain("不记录");
});
