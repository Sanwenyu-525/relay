import { describe, expect, it, afterEach } from "vitest";
import { flush, mountWorkbench } from "./mountApp";

let unmount: (() => void) | null = null;
afterEach(() => { unmount?.(); unmount = null; });

describe("项目总览（UI-02）", () => {
  it("裸项目路由默认显示总览，按真实 revision/阶段/目标呈现", async () => {
    const mounted = await mountWorkbench("/projects/project-hci");
    unmount = mounted.unmount;
    const text = mounted.wrapper.text();
    expect(mounted.wrapper.find('[data-testid="project-overview-fixture"]').exists()).toBe(true);
    expect(text).toContain("项目当前状态");
    expect(text).toContain("状态 v");
    expect(text).toContain("研究可追溯");
    expect(text).toContain("关键产物与摘要");
    expect(text).toContain("下一步");
    expect(text).toContain("AI 提案不会自动改写 State");
  });

  it("确认人/确认时间等缺口明确标注为待接入，不伪造", async () => {
    const mounted = await mountWorkbench("/projects/project-hci");
    unmount = mounted.unmount;
    expect(mounted.wrapper.text()).toContain("服务端接口待接入");
  });

  it("来源不可用时不以摘要当真相", async () => {
    const mounted = await mountWorkbench("/projects/project-hci?fixture=source-unavailable");
    unmount = mounted.unmount;
    expect(mounted.wrapper.text()).toContain("来源不可用");
  });

  it("技能子页仍可达：蓝图标签切换到蓝图预览", async () => {
    const mounted = await mountWorkbench("/projects/project-hci?skill=blueprint");
    unmount = mounted.unmount;
    await flush();
    expect(mounted.wrapper.text()).toContain("本次蓝图变更");
    expect(mounted.wrapper.find('[data-testid="project-overview-fixture"]').exists()).toBe(false);
  });
});
