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
