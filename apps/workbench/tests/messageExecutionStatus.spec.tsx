import { afterEach, describe, expect, it } from "vitest";

import type { RelayActivityItem, RelayActivityRecovery,
  RelayExecutionActivityMessage } from "../src/api/dtos/assist";
import { MessageExecutionStatus } from "../src/components/MessageExecutionStatus";
import { DomWrapper, flush, mountReact } from "./mountApp";

/**
 * ENG-OBS-02 P0-C：消息级执行状态只呈现服务端活动投影给出的事实。
 *
 * 这里锁住三条产品口径：
 *   * 默认只显示一句真实阶段，不用固定时间切换；
 *   * 展开后能看到模型调用、工具调用、待办与子 Agent 的真实记录；
 *   * 未确认的操作不用成功色，正常在途的动作也不冒充「待核对」。
 */

let unmount: (() => void) | null = null;
afterEach(() => { unmount?.(); unmount = null; });

function recovery(overrides: Partial<RelayActivityRecovery> = {}): RelayActivityRecovery {
  return { disposition: "UNRESOLVED_OPEN", effectiveOutcome: null, operationRef: null,
    operationStatus: "PREPARED", invocationStatus: null, effectState: "NOT_APPLICABLE",
    reconcileRequired: true, reconciled: false, resolvedAt: null, provenance: "LIVE",
    reason: "gateway_action_not_committed", ...overrides };
}

function item(overrides: Partial<RelayActivityItem> = {}): RelayActivityItem {
  return { activityId: "tool-call:t1", kind: "TOOL_CALL", rawState: "REQUESTED",
    view: "PENDING", tone: "wait", terminal: false,
    startedAt: "2026-11-01T00:00:00.000Z", endedAt: null, round: 0, ordinal: 0,
    modelCallId: null, toolCallId: "t1", operationId: null, invocationId: null,
    waitCode: "gateway_action_not_committed", errorCode: null, resultAvailable: false,
    resultDigest: null, failureKind: null, recovery: recovery(), toolName: "read_file",
    ...overrides };
}

function message(overrides: Partial<RelayExecutionActivityMessage> = {}):
RelayExecutionActivityMessage {
  return { messageId: "m1", seq: "2", role: "ASSISTANT", status: "RUNNING", intent: "DISCUSS",
    createdAt: "2026-11-01T00:00:00.000Z", claimedAt: "2026-11-01T00:00:01.000Z",
    settledAt: null, updatedAt: "2026-11-01T00:00:05.000Z", cancelRequested: false,
    sourceUserMessageId: "u1", contentFingerprint: "f1", processEvidence: "RECORDED",
    phase: { raw: "RUNNING", view: "RUNNING_TOOL", tone: "active",
      since: "2026-11-01T00:00:01.000Z", detail: "正在执行工具",
      waitCode: "TOOL_RUNNING", waitDetail: null },
    executionRequest: null, runSummary: null,
    activities: [item()],
    activityCounts: { modelCalls: 1, toolCalls: 1, todoWrites: 0, delegations: 0 },
    gaps: [], ...overrides };
}

async function mount(activity: RelayExecutionActivityMessage) {
  const mounted = await mountReact(<MessageExecutionStatus activity={activity} />);
  unmount = mounted.unmount;
  await flush(20);
  return mounted.wrapper;
}

const root = (wrapper: DomWrapper) => wrapper.get('[data-testid="message-execution-status"]');
const list = (wrapper: DomWrapper) => wrapper.get(".message-execution-status__list");

describe("消息执行状态", () => {
  it("默认只显示一条真实阶段；展开后列出模型、工具、待办与子 Agent 记录", async () => {
    const wrapper = await mount(message({ activities: [
      item({ activityId: "model-call:c1", kind: "MODEL_CALL", view: "RECEIVING_TEXT",
        tone: "active", terminal: false, toolName: undefined, recovery: null }),
      item(),
      item({ activityId: "todo-write:t2", kind: "TODO_WRITE", toolCallId: "t2",
        toolName: "todo_write", recovery: recovery({ disposition: "CONFIRMED_SUCCESS",
        effectiveOutcome: "SUCCEEDED", reconcileRequired: false }) }),
      item({ activityId: "delegation:d1", kind: "DELEGATION", toolCallId: null,
        view: "RUNNING", terminal: false, delegationRole: "INVESTIGATE",
        childSessionId: "child-1", recovery: null }),
    ], activityCounts: { modelCalls: 1, toolCalls: 2, todoWrites: 1, delegations: 1 },
    runSummary: { runId: "run-1", status: "RUNNING", currentStepKind: "BUILD_CONTEXT",
      waitReason: null, unresolvedCount: 0, updatedAt: "2026-11-01T00:00:05.000Z" } }));
    expect(root(wrapper).attributes("data-view")).toBe("RUNNING_TOOL");
    expect(root(wrapper).attributes("data-tone")).toBe("active");
    expect(root(wrapper).text()).toContain("正在执行工具");
    expect(root(wrapper).text()).toContain("查看执行过程（5 项）");
    expect(root(wrapper).text()).toContain("模型 1 · 工具 2 · 待办 1 · 子 Agent 1");
    // <details> 未展开时也只是折叠，不伪造条目。
    await wrapper.get("summary").trigger("click");
    expect(list(wrapper).text()).toContain("模型调用 · 正在接收回复");
    expect(list(wrapper).text()).toContain("read_file");
    expect(list(wrapper).text()).toContain("更新待办清单");
    expect(list(wrapper).text()).toContain("子 Agent · 调查 · 运行中");
    expect(list(wrapper).text()).toContain("执行 Run · RUNNING");
    expect(list(wrapper).text()).toContain("BUILD_CONTEXT");
  });

  it("在途工具写「正在执行」而不是「结果待核对」，且状态点保持活动色", async () => {
    const wrapper = await mount(message());
    await wrapper.get("summary").trigger("click");
    expect(list(wrapper).text()).toContain("read_file · 正在执行");
    expect(list(wrapper).text()).not.toContain("结果待核对");
    expect(list(wrapper).find('li[data-kind="TOOL_CALL"]').attributes("data-tone")).toBe("active");
    expect(root(wrapper).text()).not.toContain("项待核对");
  });

  it("结果未知与已知失败分开表达，未确认操作不用成功色", async () => {
    const wrapper = await mount(message({
      phase: { ...message().phase, view: "WAITING_CONFIRMATION", tone: "wait",
        detail: "工具有结果待核对" },
      gaps: [{ code: "UNRESOLVED_UNKNOWN" }],
      activities: [
        item({ view: "UNKNOWN", recovery: recovery({ disposition: "UNRESOLVED_UNKNOWN",
          operationStatus: "UNKNOWN", reason: "result_unresolved" }) }),
        item({ activityId: "tool-call:t2", toolCallId: "t2", view: "FAILED", terminal: true,
          tone: "error", recovery: recovery({ disposition: "CONFIRMED_FAILURE",
            effectiveOutcome: "FAILED", operationStatus: "FAILED", reconcileRequired: false }) }),
      ] }));
    expect(root(wrapper).text()).toContain("1 项待核对");
    await wrapper.get("summary").trigger("click");
    expect(list(wrapper).text()).toContain("read_file · 结果待核对");
    expect(list(wrapper).text()).toContain("read_file · 已确认失败");
    const tones = list(wrapper).findAll("li").map((row) => row.attributes("data-tone"));
    expect(tones[0]).toBe("wait");
    expect(tones[1]).toBe("error");
    for (const tone of tones) expect(tone).not.toBe("success");
  });

  it("已完成的回复不产生进度动画；没有过程记录时不编造条目", async () => {
    const wrapper = await mount(message({ status: "COMPLETED", settledAt: "2026-11-01T00:00:09.000Z",
      phase: { raw: "COMPLETED", view: "COMPLETED", tone: "success",
        since: "2026-11-01T00:00:09.000Z", detail: "回复已完成", waitCode: null,
        waitDetail: null },
      processEvidence: "UNKNOWN", activities: undefined,
      activityCounts: { modelCalls: 0, toolCalls: 0, todoWrites: 0, delegations: 0 } }));
    expect(root(wrapper).attributes("data-active")).toBe("false");
    expect(root(wrapper).text()).toContain("回复已完成");
    expect(root(wrapper).text()).toContain("历史数据没有可核对的过程记录。");
    expect(root(wrapper).text()).not.toContain("查看执行过程");
    expect(root(wrapper).find(".message-execution-status__elapsed").exists()).toBe(false);
  });
});
