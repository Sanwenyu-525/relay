import { describe, expect, it, afterEach } from "vitest";
import { fixtureAdapter } from "../src/fixtures/fixtureAdapter";
import { flush, mountWorkbench } from "./mountApp";

let unmount: (() => void) | null = null;

afterEach(() => {
  unmount?.();
  unmount = null;
});

describe("生成验收方案", () => {
  it("缺少必需检查器时阻止应用，并说明是执行方式未明确", async () => {
    const mounted = await mountWorkbench("/tasks/task-evaluation-metrics?skill=verification");
    unmount = mounted.unmount;

    expect(mounted.wrapper.get('[data-testid="verification-apply"]').attributes("disabled")).toBeDefined();
    const reason = mounted.wrapper.get('[data-testid="verification-apply-reason"]').text();
    expect(reason).toContain("执行方式尚未明确");
    expect(reason).not.toContain("人工检查");
    expect(mounted.wrapper.get('[data-testid="verification-warning"]').text()).toContain("语义核对缺少可用检查器");
    expect(mounted.wrapper.text()).toContain("缺少可用检查器");
    expect(mounted.wrapper.text()).toContain("待人工检查");
    expect(mounted.wrapper.text()).toContain("缺少检查器和待人工检查都不等于通过");
  });

  it("人工检查未完成不是应用被阻止的理由", async () => {
    const mounted = await mountWorkbench("/tasks/task-evaluation-metrics?skill=verification&fixture=checkers-registered");
    unmount = mounted.unmount;

    expect(mounted.wrapper.find('[data-testid="verification-warning"]').exists()).toBe(false);
    expect(mounted.wrapper.text()).toContain("待人工检查");
    const reason = mounted.wrapper.get('[data-testid="verification-apply-reason"]').text();
    expect(reason).toContain("写入口尚未接入");
    expect(reason).not.toContain("人工检查尚未完成");
    expect(mounted.wrapper.get('[data-testid="verification-apply"]').attributes("disabled")).toBeDefined();
  });

  it("必需检查项不可删除，方案应用到写入口前不生效", async () => {
    const mounted = await mountWorkbench("/tasks/task-evaluation-metrics?skill=verification");
    unmount = mounted.unmount;

    expect(mounted.wrapper.text()).toContain("检查方案不是检查结果，检查通过也不等于任务完成。");
    expect(fixtureAdapter.getCallCount("saveVerificationSuggestion")).toBe(0);

    await mounted.wrapper.findAll("button").find((button) => button.text().includes("修改检查方案"))?.trigger("click");
    await flush();

    expect(mounted.wrapper.text()).toContain("必需检查项不可删除或降级");
    expect(mounted.wrapper.text()).toContain("验收标准保持 v2 不变");
    expect(mounted.wrapper.findAll('textarea[name="verification-note"]')).toHaveLength(1);
  });

  it("接受新任务修订后方案基线标记过期并可阻止应用", async () => {
    const mounted = await mountWorkbench("/tasks/task-evaluation-metrics?skill=definition");
    unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="definition-accept"]').trigger("click");
    await flush();
    mounted.unmount();

    const verification = await mountWorkbench("/tasks/task-evaluation-metrics?skill=verification");
    unmount = verification.unmount;

    expect(verification.wrapper.text()).toContain("基线已过期");
    expect(verification.wrapper.get('[data-testid="verification-stale"]').text()).toContain("旧建议不能直接应用");
    expect(verification.wrapper.get('[data-testid="verification-apply-reason"]').text()).toContain("重新生成方案");
    expect(verification.wrapper.get('[data-testid="verification-apply"]').attributes("disabled")).toBeDefined();
  });

  it("保存待确认建议可操作并保留说明，取消不清空草稿", async () => {
    const mounted = await mountWorkbench("/tasks/task-evaluation-metrics?skill=verification");
    unmount = mounted.unmount;

    await mounted.wrapper.get('[data-testid="verification-save-rail"]').trigger("click");
    await flush();
    await mounted.wrapper.get('textarea[name="verification-note"]').setValue("等待登记语义核对检查器后再应用");
    await mounted.wrapper.findAll("button").find((button) => button.text().includes("取消"))?.trigger("click");
    await flush();

    expect(mounted.wrapper.text()).toContain("已保留待确认说明草稿");
    expect(fixtureAdapter.getCallCount("saveVerificationSuggestion")).toBe(0);

    await mounted.wrapper.findAll("button").find((button) => button.text().includes("修改检查方案"))?.trigger("click");
    await flush();
    expect((mounted.wrapper.get('textarea[name="verification-note"]').element as HTMLTextAreaElement).value).toContain(
      "等待登记语义核对检查器后再应用"
    );

    await mounted.wrapper.get('[data-testid="verification-save"]').trigger("click");
    await flush();

    expect(fixtureAdapter.getCallCount("saveVerificationSuggestion")).toBe(1);
    expect(mounted.wrapper.get(".receipt-message").text()).toContain("未应用检查计划");
    expect(mounted.wrapper.find('textarea[name="verification-note"]').exists()).toBe(false);
  });

  it("相关来源按钮打开的标题与内容一致", async () => {
    const mounted = await mountWorkbench("/tasks/task-evaluation-metrics?skill=verification");
    unmount = mounted.unmount;

    const buttons = mounted.wrapper.findAll("button").filter((button) => button.text().includes("当前可用检查器"));
    await buttons[0].trigger("click");
    await flush();

    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.getAttribute("aria-label")).toBe("当前可用检查器 v1");
    expect(dialog?.textContent).toContain("语义核对尚无注册检查器");
  });
});