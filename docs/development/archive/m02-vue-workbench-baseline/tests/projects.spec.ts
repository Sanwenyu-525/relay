import { describe, expect, it, afterEach } from "vitest";
import { fixtureAdapter } from "../src/fixtures/fixtureAdapter";
import { flush, mountWorkbench } from "./mountApp";

let unmount: (() => void) | null = null;

afterEach(() => {
  unmount?.();
  unmount = null;
});

describe("项目列表", () => {
  it("按进行中/已归档分区并给出计数，搜索保持当前作用域", async () => {
    const mounted = await mountWorkbench("/projects");
    unmount = mounted.unmount;

    expect(mounted.wrapper.text()).toContain("每一个长期目标，都有可继续的下一步。");
    expect(mounted.wrapper.get('[data-testid="projects-tab-active"]').text()).toContain("进行中 (3)");
    expect(mounted.wrapper.get('[data-testid="projects-tab-archived"]').text()).toContain("已归档 (1)");

    await mounted.wrapper.get('input[name="project-search"]').setValue("Workflow");
    await flush(60);
    expect(mounted.wrapper.text()).toContain("Workflow OS");
    expect(mounted.wrapper.text()).not.toContain("个人知识整理");

    await mounted.wrapper.get('input[name="project-search"]').setValue("");
    await mounted.wrapper.get('[data-testid="projects-tab-archived"]').trigger("click");
    await flush(60);
    expect(mounted.wrapper.text()).toContain("论文选题调研");
    expect(mounted.wrapper.find('[data-testid="project-row-project-hci"]').exists()).toBe(false);
  });

  it("选择项目后展示目标与状态，并给出打开项目入口", async () => {
    const mounted = await mountWorkbench("/projects");
    unmount = mounted.unmount;

    await mounted.wrapper.get('[data-testid="project-row-project-knowledge"]').trigger("click");
    await flush();

    expect(mounted.wrapper.text()).toContain("建立可持续的个人知识体系");
    expect(mounted.wrapper.text()).toContain("状态修订 v2");
    expect(mounted.wrapper.get('[data-testid="project-open"]').attributes("href")).toBe("/projects/project-knowledge");
  });

  it("归档被拒绝时给出原因，可归档项目完成后列表计数同步", async () => {
    const mounted = await mountWorkbench("/projects");
    unmount = mounted.unmount;

    await mounted.wrapper.get('[data-testid="project-row-project-workflow-os"]').trigger("click");
    await flush();

    expect(mounted.wrapper.get('[data-testid="project-archive"]').attributes("disabled")).toBeDefined();
    expect(mounted.wrapper.get('[data-testid="project-archive-reason"]').text()).toContain("正在进行的执行");

    await mounted.wrapper.get('[data-testid="project-row-project-hci"]').trigger("click");
    await flush();
    await mounted.wrapper.get('[data-testid="project-archive"]').trigger("click");
    await flush(80);

    expect(mounted.wrapper.text()).toContain("本次演示已归档");
    expect(mounted.wrapper.get('[data-testid="projects-tab-active"]').text()).toContain("进行中 (2)");
    expect(mounted.wrapper.get('[data-testid="projects-tab-archived"]').text()).toContain("已归档 (2)");
    expect(fixtureAdapter.getCallCount("archiveProject")).toBe(1);
  });

  it("归档项目只读，不提供打开入口", async () => {
    const mounted = await mountWorkbench("/projects?archived=1");
    unmount = mounted.unmount;

    await mounted.wrapper.get('[data-testid="project-row-project-thesis-topic"]').trigger("click");
    await flush();

    expect(mounted.wrapper.text()).toContain("已归档项目在本轮交互预览中只读");
    expect(mounted.wrapper.find('[data-testid="project-open"]').exists()).toBe(false);
  });

  it("读取失败可重试，空列表提供新建入口", async () => {
    const failed = await mountWorkbench("/projects?fixture=load-error");
    unmount = failed.unmount;
    expect(failed.wrapper.text()).toContain("暂时无法显示项目");
    failed.unmount();

    const empty = await mountWorkbench("/projects?fixture=empty");
    unmount = empty.unmount;
    expect(empty.wrapper.text()).toContain("还没有进行中的项目。");
    expect(empty.wrapper.text()).toContain("新建项目");
  });
});

describe("创建项目", () => {
  it("必填错误就地显示并与字段关联，不发起创建", async () => {
    const mounted = await mountWorkbench("/projects?view=create");
    unmount = mounted.unmount;

    await mounted.wrapper.get('[data-testid="project-create-submit"]').trigger("click");
    await flush();

    const titleInput = mounted.wrapper.get('input[name="project-title"]');
    expect(titleInput.attributes("aria-invalid")).toBe("true");
    expect(titleInput.attributes("aria-describedby")).toBe("project-title-error");
    expect(mounted.wrapper.text()).toContain("请填写项目名称");
    expect(mounted.wrapper.text()).toContain("请选择项目类型");
    expect(fixtureAdapter.getCallCount("createProject")).toBe(0);
  });

  it("填写后创建成功并进入项目列表，选中新项目", async () => {
    const mounted = await mountWorkbench("/projects?view=create");
    unmount = mounted.unmount;

    await mounted.wrapper.get('input[name="project-title"]').setValue("新的研究项目");
    await mounted.wrapper.get('textarea[name="project-goal"]').setValue("验证前端创建闭环。");
    await mounted.wrapper.findAll('input[name="project-type"]')[1].setValue();
    await mounted.wrapper.get('[data-testid="project-create-submit"]').trigger("click");
    await flush(120);

    expect(fixtureAdapter.getCallCount("createProject")).toBe(1);
    expect(mounted.router.currentRoute.value.path).toBe("/projects");
    expect(mounted.wrapper.text()).toContain("新的研究项目");
    expect(mounted.wrapper.text()).toContain("本次演示已创建项目");
    expect(mounted.wrapper.text()).toContain("未导入资料，也未连接模型");
    expect(mounted.wrapper.find('[data-testid="project-import-status"]').exists()).toBe(false);
  });

  it("导入失败不回滚已创建的项目，导入状态独立显示", async () => {
    const mounted = await mountWorkbench("/projects?view=create&fixture=import-failed");
    unmount = mounted.unmount;

    await mounted.wrapper.get('input[name="project-title"]').setValue("带资料的项目");
    await mounted.wrapper.get('textarea[name="project-goal"]').setValue("验证导入失败处理。");
    await mounted.wrapper.findAll('input[name="project-type"]')[0].setValue();

    const fileInput = mounted.wrapper.get('input[name="project-import"]');
    Object.defineProperty(fileInput.element, "files", {
      value: [new File(["# 笔记"], "notes.md", { type: "text/markdown" })],
      configurable: true
    });
    await fileInput.trigger("change");
    expect(mounted.wrapper.text()).toContain("notes.md");

    await mounted.wrapper.get('[data-testid="project-create-submit"]').trigger("click");
    await flush(120);

    expect(mounted.wrapper.text()).toContain("带资料的项目");
    expect(mounted.wrapper.get('[data-testid="project-import-status"]').text()).toContain("失败，项目仍然保留");
  });

  it("只接受 md/txt，其他格式就地说明原因", async () => {
    const mounted = await mountWorkbench("/projects?view=create");
    unmount = mounted.unmount;

    const fileInput = mounted.wrapper.get('input[name="project-import"]');
    Object.defineProperty(fileInput.element, "files", {
      value: [new File(["x"], "paper.pdf", { type: "application/pdf" })],
      configurable: true
    });
    await fileInput.trigger("change");

    expect(mounted.wrapper.text()).toContain("只支持 .md 与 .txt 文本资料");
  });

  it("提交结果不明时先查回执，不重复创建", async () => {
    const mounted = await mountWorkbench("/projects?view=create&fixture=timeout");
    unmount = mounted.unmount;

    await mounted.wrapper.get('input[name="project-title"]').setValue("超时项目");
    await mounted.wrapper.get('textarea[name="project-goal"]').setValue("验证超时处理。");
    await mounted.wrapper.findAll('input[name="project-type"]')[0].setValue();
    await mounted.wrapper.get('[data-testid="project-create-submit"]').trigger("click");
    await flush(80);

    expect(mounted.wrapper.text()).toContain("提交结果暂不明确");
    expect(mounted.wrapper.text()).toContain("不要直接再点创建");
    expect(fixtureAdapter.getCallCount("createProject")).toBe(1);

    await mounted.wrapper.get('[data-testid="project-create-receipt"]').trigger("click");
    await flush(80);
    expect(fixtureAdapter.getCallCount("lookupReceipt")).toBe(1);
    expect(mounted.wrapper.text()).toContain("本次提交仍未确认");
  });
});
