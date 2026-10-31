import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RelayApiError, RelayTransportError, type RelaySubagentSupplement } from "../src/api/relayClient";
import SubagentSupplements from "../src/components/SubagentSupplements";
import { mountReact } from "./mountApp";

let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); dispose = undefined; sessionStorage.clear(); vi.useRealTimers(); });
const row: RelaySubagentSupplement = { id: "supplement", delegationId: "delegation",
  sourceMessageId: "source", sourceSessionId: "child", parentSessionId: "parent",
  content: "请核对 README", delegationStatus: "SUCCEEDED", parentSeenAt: null,
  childSeenAt: null, createdAt: "2026-10-30T00:00:00Z" };
const receiptResult = { supplement_id: "supplement", source_message_id: "source",
  child_session_id: "child", parent_session_id: "parent", delegation_id: "delegation" };
function missing() {
  return new RelayApiError({ status: 404, code: "RESOURCE_NOT_FOUND", detail: "尚无回执",
    retryable: false, retryAction: null, fieldErrors: [], expectedRevision: null, actualRevision: null });
}

describe("子任务补充", () => {
  it("成功仅显示已记录和真实读取状态，不把补充当成自动重跑", async () => {
    let records: readonly RelaySubagentSupplement[] = [];
    const send = vi.fn(async () => { records = [row]; return {
      supplementId: "supplement", sourceMessageId: "source", childSessionId: "child",
      parentSessionId: "parent", delegationId: "delegation" }; });
    const recorded = vi.fn();
    const client = { workspaceId: "workspace", getSubagentSupplements: vi.fn(async () => records),
      supplementSubagent: send };
    const view = await mountReact(<SubagentSupplements client={client} sessionId="child" child onRecorded={recorded} />);
    dispose = view.unmount;
    await view.wrapper.get("textarea").setValue("请核对 README");
    await view.wrapper.get('[data-testid="subagent-supplement-send"]').trigger("click");
    expect(send).toHaveBeenCalledTimes(1);
    expect(view.wrapper.text()).toContain("主会话待读取");
    expect(view.wrapper.text()).toContain("此前返回的结果未覆盖这条补充");
    expect((view.wrapper.get("textarea").element as HTMLTextAreaElement).value).toBe("");
    expect(recorded).toHaveBeenCalledTimes(1);
  });

  it("响应丢失后保留原请求，查不到回执才允许同身份重试", async () => {
    const send = vi.fn().mockRejectedValueOnce(new RelayTransportError()).mockResolvedValueOnce({
      supplementId: "supplement", sourceMessageId: "source", childSessionId: "child",
      parentSessionId: "parent", delegationId: "delegation" });
    const client = { workspaceId: "workspace", getSubagentSupplements: vi.fn().mockResolvedValue([]),
      supplementSubagent: send, getCommandReceipt: vi.fn().mockRejectedValue(missing()) };
    const view = await mountReact(<SubagentSupplements client={client} sessionId="child" child />);
    dispose = view.unmount;
    await view.wrapper.get("textarea").setValue("保持同一条补充");
    await view.wrapper.get('[data-testid="subagent-supplement-send"]').trigger("click");
    expect(view.wrapper.find('[data-testid="subagent-supplement-retry"]').exists()).toBe(false);
    await view.wrapper.get('[data-testid="subagent-supplement-check"]').trigger("click");
    await view.wrapper.get('[data-testid="subagent-supplement-retry"]').trigger("click");
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]).toEqual(send.mock.calls[0]);
  });

  it("重挂载后按原回执核对成功，不再发送", async () => {
    sessionStorage.setItem("relay:subagent-supplement:workspace:child", JSON.stringify({
      commandId: "original", content: "已发送但响应丢失" }));
    const send = vi.fn();
    const client = { workspaceId: "workspace", getSubagentSupplements: vi.fn().mockResolvedValue([]),
      supplementSubagent: send, getCommandReceipt: vi.fn().mockResolvedValue({ commandId: "original",
        commandType: "SupplementSubagent", result: receiptResult }) };
    const view = await mountReact(<SubagentSupplements client={client} sessionId="child" child />);
    dispose = view.unmount;
    expect((view.wrapper.get("textarea").element as HTMLTextAreaElement).disabled).toBe(true);
    await view.wrapper.get('[data-testid="subagent-supplement-check"]').trigger("click");
    expect(send).not.toHaveBeenCalled();
    expect(view.wrapper.find('[data-testid="subagent-supplement-send"]').exists()).toBe(true);
  });

  it("错误会话回执不清除待核对身份", async () => {
    sessionStorage.setItem("relay:subagent-supplement:workspace:child", JSON.stringify({
      commandId: "original", content: "待核对" }));
    const client = { workspaceId: "workspace", getSubagentSupplements: vi.fn().mockResolvedValue([]),
      getCommandReceipt: vi.fn().mockResolvedValue({ commandId: "original", commandType: "SupplementSubagent",
        result: { ...receiptResult, child_session_id: "other" } }), supplementSubagent: vi.fn() };
    const view = await mountReact(<SubagentSupplements client={client} sessionId="child" child />);
    dispose = view.unmount;
    await view.wrapper.get('[data-testid="subagent-supplement-check"]').trigger("click");
    expect(view.wrapper.text()).toContain("会话身份无法核对");
    expect(sessionStorage.getItem("relay:subagent-supplement:workspace:child")).not.toBeNull();
  });

  it("切换会话不混入晚到的补充原文", async () => {
    let release!: (items: readonly RelaySubagentSupplement[]) => void;
    const client = { workspaceId: "workspace", getSubagentSupplements: vi.fn((id: string) => id === "old"
      ? new Promise<readonly RelaySubagentSupplement[]>((resolve) => { release = resolve; })
      : Promise.resolve([{ ...row, content: "新会话的补充" }])) };
    const view = await mountReact(<SubagentSupplements client={client} sessionId="old" />);
    dispose = view.unmount;
    await view.rerender(<SubagentSupplements client={client} sessionId="new" />);
    await act(async () => { release([{ ...row, content: "旧会话的补充" }]); });
    expect(view.wrapper.text()).toContain("新会话的补充");
    expect(view.wrapper.text()).not.toContain("旧会话的补充");
  });

  it("切换后晚到的发送回执不刷新旧页面或清掉新草稿", async () => {
    let complete!: (value: { supplementId: string; sourceMessageId: string;
      childSessionId: string; parentSessionId: string; delegationId: string }) => void;
    const recorded = vi.fn();
    const client = { workspaceId: "workspace", getSubagentSupplements: vi.fn().mockResolvedValue([]),
      supplementSubagent: vi.fn(() => new Promise<{ supplementId: string; sourceMessageId: string;
        childSessionId: string; parentSessionId: string; delegationId: string }>((resolve) => { complete = resolve; })) };
    const view = await mountReact(<SubagentSupplements client={client} sessionId="child" child onRecorded={recorded} />);
    dispose = view.unmount;
    await view.wrapper.get("textarea").setValue("旧请求");
    await view.wrapper.get('[data-testid="subagent-supplement-send"]').trigger("click");
    await view.rerender(<SubagentSupplements client={client} sessionId="new-child" child onRecorded={recorded} />);
    await view.wrapper.get("textarea").setValue("新草稿");
    await act(async () => { complete({ supplementId: "supplement", sourceMessageId: "source",
      childSessionId: "child", parentSessionId: "parent", delegationId: "delegation" }); });
    expect((view.wrapper.get("textarea").element as HTMLTextAreaElement).value).toBe("新草稿");
    expect(recorded).not.toHaveBeenCalled();
  });
});
