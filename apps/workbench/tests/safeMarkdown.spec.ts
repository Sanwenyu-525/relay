import { afterEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import SafeMarkdown from "../src/components/SafeMarkdown";
import { mountReact } from "./mountApp";

let unmount: (() => void) | null = null;
afterEach(() => { unmount?.(); unmount = null; });

async function render(source: string) {
  const mounted = await mountReact(createElement(SafeMarkdown, { source }));
  unmount = mounted.unmount;
  return mounted.wrapper;
}

describe("安全 Markdown 表格", () => {
  it("渲染表头、正文与列对齐，前后正文仍保持独立，支持可选外侧管道", async () => {
    const wrapper = await render("评价指标如下：\n指标 | 计算方法 | 验收标准\n:--- | :---: | ---:\n任务成功率 | 成功 / 总数 | 80%\n恢复正确率 | 恢复成功 / 次数 | 90%\n\n以下仍是正文。");
    expect(wrapper.findAll("table")).toHaveLength(1);
    expect(wrapper.findAll("thead th").map((cell) => cell.text())).toEqual(["指标", "计算方法", "验收标准"]);
    expect(wrapper.findAll("tbody tr")).toHaveLength(2);
    expect(wrapper.findAll("tbody tr")[0]!.findAll("td").map((cell) => cell.text()))
      .toEqual(["任务成功率", "成功 / 总数", "80%"]);
    expect(wrapper.findAll("thead th").map((cell) => cell.attributes("scope"))).toEqual(["col", "col", "col"]);
    expect(wrapper.findAll("thead th").map((cell) => (cell.element as HTMLElement).style.textAlign))
      .toEqual(["left", "center", "right"]);
    expect(wrapper.findAll(".markdown-preview__paragraph").map((paragraph) => paragraph.text()))
      .toEqual(["评价指标如下：", "以下仍是正文。"]);
    expect(wrapper.text()).not.toContain(":---");
  });

  it("escaped pipe 与行内代码中的 pipe 留在确切单元格，复用加粗/代码安全渲染", async () => {
    const wrapper = await render("| 名称\\|标签 | 命令 | 结果 |\n| --- | --- | --- |\n| A\\|B | `a|b` | **成功** |");
    expect(wrapper.findAll("thead th").map((cell) => cell.text())).toEqual(["名称|标签", "命令", "结果"]);
    expect(wrapper.findAll("tbody td").map((cell) => cell.text())).toEqual(["A|B", "a|b", "成功"]);
    expect(wrapper.get("tbody td code").text()).toBe("a|b");
    expect(wrapper.get("tbody td strong").text()).toBe("成功");
  });

  it("双反斜线不会吞掉下一条管道分列", async () => {
    const wrapper = await render("| 路径 | 状态 |\n| --- | --- |\n| root\\\\| 已完成 |");
    expect(wrapper.findAll("tbody td").map((cell) => cell.text())).toEqual(["root\\\\", "已完成"]);
  });

  it.each([
    "| A | B |\n| 值 A | 值 B |",
    "| A | B |\n| -- | --- |\n| 值 A | 值 B |",
    "| A | B |\n| --- |\n| 值 A | 值 B |",
    "| A | B |\n| --- | ordinary |\n| 值 A | 值 B |",
    "| A | B |\n| --- | --- |\n| 值 A | 值 B | 多余内容 |",
    "A\\|B\n---\\|---\n值 A\\|值 B",
    "`A|B`\n---|---\n值 A|值 B"
  ])("无效或缺失分隔符/错列内容保留为正文：%s", async (source) => {
    const wrapper = await render(source);
    expect(wrapper.find("table").exists()).toBe(false);
    expect(wrapper.get(".markdown-preview__paragraph").text()).not.toBe("");
    expect(wrapper.text()).toContain(source.includes("多余内容") ? "多余内容" : "|");
  });

  it("fenced code 内的完整表格源保持代码，不作为表格或行内语法解析", async () => {
    const source = "| 指标 | 依据 |\n| --- | --- |\n| **成功率** | `code` |";
    const wrapper = await render(`\`\`\`markdown\n${source}\n\`\`\``);
    expect(wrapper.find("table").exists()).toBe(false);
    expect(wrapper.get("pre code").text()).toBe(source.replaceAll("\n", " "));
    expect(wrapper.find("strong").exists()).toBe(false);
    expect(wrapper.findAll("code")).toHaveLength(1);
  });

  it("表格单元格中的原始 HTML 与危险链接仍是纯文本，仅 HTTP(S) 生成安全链接", async () => {
    const wrapper = await render('| 类型 | 内容 |\n| --- | --- |\n| HTML | <img src=x onerror="window.__tableXss = true"> |\n| 危险 | [脚本](javascript:alert(1)) |\n| 安全 | [依据](https://example.com/evidence) |');
    expect(wrapper.find("img").exists()).toBe(false);
    expect(wrapper.find("script").exists()).toBe(false);
    expect((window as unknown as { __tableXss?: boolean }).__tableXss).toBeUndefined();
    expect(wrapper.text()).toContain("<img src=x onerror=");
    expect(wrapper.text()).toContain("链接协议不受支持，未渲染");
    const links = wrapper.findAll("a");
    expect(links).toHaveLength(1);
    expect(links[0]!.attributes("href")).toBe("https://example.com/evidence");
    expect(links[0]!.attributes("rel")).toBe("noreferrer noopener");
  });

  it("宽表滚动容器可键盘聚焦且保留原生 table 语义", async () => {
    const wrapper = await render("| 一 | 二 | 三 | 四 | 五 |\n| --- | --- | --- | --- | --- |\n| A | B | C | D | E |");
    const region = wrapper.get(".markdown-preview__table-scroll");
    expect(region.attributes("role")).toBe("region");
    expect(region.attributes("tabindex")).toBe("0");
    expect(region.attributes("aria-label")).toContain("横向滚动");
    (region.element as HTMLElement).focus();
    expect(document.activeElement).toBe(region.element);
    expect(region.find("table > thead > tr > th").exists()).toBe(true);
    expect(region.find("table > tbody > tr > td").exists()).toBe(true);
  });
});

describe("段落与列表的边界", () => {
  /* 2026-10-20 用户截图：AI 回复里「当前状态：」下面跟的是一行行 `- 分支：main`，
     实机却渲染成「当前状态： - 分支：main - HEAD：…」一整段。根因是段落收集循环
     只在空行/标题/fence/表格处断开，遇到列表行继续 join(" ")，把列表吞进段落。 */
  it("段落下一行紧跟无序列表（没有空行）时列表另起一块，不被 join 成一行", async () => {
    const wrapper = await render("**当前状态：**\n- 分支：main\n- HEAD：119f51dc\n- 未暂存改动文件很多");
    expect(wrapper.findAll(".markdown-preview__paragraph").map((paragraph) => paragraph.text()))
      .toEqual(["当前状态："]);
    expect(wrapper.findAll("ul.markdown-preview__list")).toHaveLength(1);
    expect(wrapper.findAll("ul.markdown-preview__list li").map((item) => item.text()))
      .toEqual(["分支：main", "HEAD：119f51dc", "未暂存改动文件很多"]);
    expect(wrapper.text()).not.toContain("- 分支");
  });

  it("有序列表同样能打断段落，序号从原文保留", async () => {
    const wrapper = await render("步骤如下：\n1. 读文件\n2. 改内容\n3. 复跑");
    expect(wrapper.findAll(".markdown-preview__paragraph").map((paragraph) => paragraph.text()))
      .toEqual(["步骤如下："]);
    expect(wrapper.findAll("ol.markdown-preview__list li").map((item) => item.text()))
      .toEqual(["读文件", "改内容", "复跑"]);
  });

  it("段落中间不带列表标记的行仍然续成同一段（不误断行）", async () => {
    const wrapper = await render("第一句。\n第二句仍属同一段。\n\n另一段。");
    expect(wrapper.findAll(".markdown-preview__paragraph").map((paragraph) => paragraph.text()))
      .toEqual(["第一句。 第二句仍属同一段。", "另一段。"]);
  });
});

describe("引用块", () => {
  /* 2026-10-20：模型常把前提或用户原话写成 `> …`。此前不支持，那一行会连同 `>` 原样显示成
     正文（「> 引用块在回复里也会出现」），读起来像排版坏了。 */
  it("连续的引用行并成一个引用块，`>` 不再出现在正文里", async () => {
    const wrapper = await render("> 用户原话：先别动执行策略\n> 这句是同一段引用");
    expect(wrapper.findAll("blockquote.markdown-preview__quote")).toHaveLength(1);
    expect(wrapper.get("blockquote.markdown-preview__quote").text())
      .toBe("用户原话：先别动执行策略 这句是同一段引用");
    expect(wrapper.text()).not.toContain(">");
  });

  it("段落下一行紧跟引用（没有空行）时引用另起一块，不被吞进段落", async () => {
    const wrapper = await render("前提是这样的：\n> 只改样式，不动行为");
    expect(wrapper.findAll(".markdown-preview__paragraph").map((paragraph) => paragraph.text()))
      .toEqual(["前提是这样的："]);
    expect(wrapper.get("blockquote.markdown-preview__quote").text()).toBe("只改样式，不动行为");
  });
});

describe("代码 fence 的可复制形态", () => {
  it("默认仍是朴素 pre：文档预览等阅读面不多出交互键", async () => {
    const wrapper = await render("```bash\npnpm build\n```");
    expect(wrapper.find(".msg-code").exists()).toBe(false);
    expect(wrapper.get("pre.markdown-preview__code code").text()).toBe("pnpm build");
  });

  it("codeCopy 时 fence 升级为可复制文本块：顶行是语言，正文逐字保留", async () => {
    const mounted = await mountReact(createElement(SafeMarkdown, {
      source: "```TypeScript\nconst a: number = 1;\n\nconst b = a + 1;\n```", codeCopy: true }));
    unmount = mounted.unmount;
    const block = mounted.wrapper.get(".msg-code");
    expect(block.find(".msg-code-label").text()).toBe("typescript");
    // 逐字断言走 textContent：wrapper.text() 会把换行折叠成空格。
    expect((block.get("pre code").element as HTMLElement).textContent)
      .toBe("const a: number = 1;\n\nconst b = a + 1;");
    expect(block.find(".msg-code-copy").exists()).toBe(true);
  });

  it("没有语言标注的 fence 顶行只说「代码」，仍可复制", async () => {
    const mounted = await mountReact(createElement(SafeMarkdown, { source: "```\nplain\n```", codeCopy: true }));
    unmount = mounted.unmount;
    expect(mounted.wrapper.get(".msg-code-label").text()).toBe("代码");
    expect(mounted.wrapper.get("pre code").text()).toBe("plain");
  });
});
