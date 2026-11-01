import { afterEach, expect, it } from "vitest";
import { reserveSessionExportFileName, saveExportFile } from "../src/lib/sessionExportFile";

/**
 * 会话导出文件的本机命名与落盘（任务书 §六）。
 *
 * 这四件事各自对应一次真实故障，不是「名字好看一点」：
 *   1. **只能有一段。** 标题里出现 `/`、`\`、`:` 时留着它们，等于让一次导出往别的目录写文件。
 *   2. **中文与 Emoji 不能切坏。** 按 UTF-16 码元截会把代理对劈成半个字符，
 *      产出的名字在 Windows 上读不通——所以长度按码点收。
 *   3. **同名不覆盖。** 同一天导出两次同一条会话，基础名必然相同。
 *   4. **空正文不落盘。** 「导出失败却有一个文件」会让人以为证据已经拿到手了。
 */

/** 本地时刻 2026-11-01 中午：换任何一个时区跑，文件名上的这一天都还是 11 月 1 日。 */
const at = new Date(2026, 10, 1, 12, 0, 0);

const restores: (() => void)[] = [];
afterEach(() => { restores.splice(0, restores.length).forEach((restore) => restore()); });

function stubDownload(): { readonly names: string[]; readonly blobs: Blob[]; readonly live: number[] } {
  const names: string[] = [];
  const blobs: Blob[] = [];
  // 点击那一刻文档里有几个下载锚点：用完就该是 0，不能往 body 上堆残留节点。
  const live: number[] = [];
  Object.defineProperty(URL, "createObjectURL", { configurable: true,
    value: (blob: Blob) => { blobs.push(blob); return `blob:export-${blobs.length}`; } });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: () => {} });
  Object.defineProperty(HTMLAnchorElement.prototype, "click", { configurable: true,
    value: function anchorClick(this: HTMLAnchorElement) {
      names.push(this.download);
      live.push(document.querySelectorAll("a[download]").length);
    } });
  restores.push(() => {
    // 三个都是本用例加上去的自有属性：jsdom 里 `click` 长在 HTMLElement.prototype 上，
    // 因此还原方式是 delete，让锚点重新落回继承来的那一个。
    delete (URL as unknown as Record<string, unknown>).createObjectURL;
    delete (URL as unknown as Record<string, unknown>).revokeObjectURL;
    delete (HTMLAnchorElement.prototype as unknown as Record<string, unknown>).click;
  });
  return { names, blobs, live };
}

it("文件名是 Relay 前缀 + 标题 + 导出当天：中文标题原样进名字", () => {
  expect(reserveSessionExportFileName("给 ChatGPT 复盘的这段讨论", at))
    .toBe("Relay-给 ChatGPT 复盘的这段讨论-20261101.json");
});

it("分隔符、Windows 保留字符与控制字符一律挡在一段之内", () => {
  const name = reserveSessionExportFileName("a/b\\c:d*e?f\"g<h>i|j", at);
  expect(name).toBe("Relay-a-b-c-d-e-f-g-h-i-j-20261101.json");

  // 相对路径写法：标题由用户写，`../../` 这类内容不能被解释成目录。
  const traversal = reserveSessionExportFileName("../../Windows/System32 或 /etc/passwd", at);
  expect(traversal).not.toContain("/");
  expect(traversal).not.toContain("\\");
  expect(traversal.startsWith("Relay-")).toBe(true);

  // 换行与制表符在 Windows 上是非法名字。
  const control = reserveSessionExportFileName("第一行\n第二行\t制表", at);
  expect(control).not.toContain("\n");
  expect(control).not.toContain("\t");

  // 首尾的点与空格会被 Windows 静默去掉：界面报出的名字必须和真正落盘的那个一致。
  expect(reserveSessionExportFileName("  首尾留白  ", at)).toBe("Relay-首尾留白-20261101.json");
  expect(reserveSessionExportFileName("...只有点...", at)).toBe("Relay-只有点-20261101.json");
  // 连续分隔符收成一根：标题里的「 -- 」不该在文件名里排成一串横线。
  expect(reserveSessionExportFileName("上 -- 下", at)).toBe("Relay-上-下-20261101.json");
});

it("按码点收长度：表情符号落在截断边界上也不会被劈成半个字符", () => {
  const emoji = reserveSessionExportFileName(`${"标".repeat(79)}🚀尾`, at);
  // 按码元截会在这里留下一个孤立的高代理，Windows 读不出这个名字。
  expect(emoji).toContain("🚀");
  expect(emoji).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
  expect(emoji).not.toMatch(/(^|[^\uDC00-\uDFFF])[\uDC00-\uDFFF]/u);

  expect(reserveSessionExportFileName("长".repeat(300), at))
    .toBe(`Relay-${"长".repeat(80)}-20261101.json`);

  // 截断边界正好落在分隔符上：尾巴那根横线不能和日期前的横线连成 `--`。
  expect(reserveSessionExportFileName(`${"标".repeat(79)}-尾巴很长`, at))
    .toBe(`Relay-${"标".repeat(79)}-20261101.json`);
});

it("标题为空也留得下认得出的名字", () => {
  // 三个日期各不相同：这一条只验兜底名，不掺进上面那套同名序号里。
  const day = (date: number) => new Date(2026, 10, date, 12);
  expect(reserveSessionExportFileName("", day(2))).toBe("Relay-会话-20261102.json");
  // 只剩空白与控制字符：非法字符换成横线之后仍然「什么都没有」，同样落到这个兜底名。
  expect(reserveSessionExportFileName("   \n ", day(3))).toBe("Relay-会话-20261103.json");
  expect(reserveSessionExportFileName("---", day(4))).toBe("Relay-会话-20261104.json");
});

it("同一天第二次导出同一条会话不覆盖：本页面会话内自己加 -2、-3", () => {
  const title = "要导出两次的讨论";
  expect(reserveSessionExportFileName(title, at)).toBe(`Relay-${title}-20261101.json`);
  expect(reserveSessionExportFileName(title, at)).toBe(`Relay-${title}-20261101-2.json`);
  expect(reserveSessionExportFileName(title, at)).toBe(`Relay-${title}-20261101-3.json`);
  // 另一条会话不共享这套序号：它第一次导出就该用自己那个名字。
  expect(reserveSessionExportFileName("另一段讨论", at)).toBe("Relay-另一段讨论-20261101.json");
});

it("保存只走 <a download>：正文原样进 Blob，用完的锚点不留在文档里", async () => {
  const download = stubDownload();
  const text = `${JSON.stringify({ format: "relay-session-export" }, null, 2)}\n`;
  saveExportFile("Relay-一段讨论-20261101.json", text);

  expect(download.names).toEqual(["Relay-一段讨论-20261101.json"]);
  expect(download.live).toEqual([1]);
  expect(document.querySelectorAll("a[download]")).toHaveLength(0);
  expect(download.blobs[0]).toBeInstanceOf(Blob);
  expect(download.blobs[0]?.type).toBe("application/json;charset=utf-8");
  // 交出去的就是那份正文，一个字符都没改：导出文件的价值在于它是服务端同一份投影。
  expect(await download.blobs[0]?.text()).toBe(text);
});

it("空正文拒绝落盘：不产出一个假装成功的文件", () => {
  const download = stubDownload();
  expect(() => saveExportFile("Relay-空正文-20261101.json", "   ")).toThrow(/放弃保存/u);
  expect(download.names).toEqual([]);
  expect(download.blobs).toEqual([]);
});
