/**
 * 会话导出文件的本地命名与落盘（浏览器与 Tauri 共用的既有下载通道）。
 *
 * 三条约束决定了这里不是简单的字符串拼接：
 *
 * 1. **文件名只能有一段。** 标题由用户写，里面可以出现 `/`、`\`、`..`、`:`、换行——留着它们
 *    就等于让一次导出往别的目录写文件（路径注入）。分隔符与 Windows 保留字符一律替换，
 *    交给下载的是一个纯文件名，不含任何路径段。
 * 2. **中文与 Emoji 不能切坏。** 按 UTF-16 码元 `slice` 会把代理对劈成半个字符，标题带表情时
 *    就会产出 Windows 上读不通的名字。长度因此按**码点**收，不按码元收。
 * 3. **同名不覆盖。** 同一天导出两次同一条会话，基础名必然相同。浏览器在默认设置下会自己加
 *    `(1)`，但那不是本项目能依赖的行为，所以本页面会话内自己记一次已交出去的名字，第二次起
 *    加 `-2`、`-3`。两层各自生效，谁先碰到都不会覆盖旧文件。
 *
 * 保存只走 `<a download>`：不申请任何 Tauri 高权限命令，也不自动上传外部平台——文件落在用户
 * 自己的下载目录，接下来给谁看由用户决定。
 */

/** 标题段的最大码点数：留出前缀、日期与扩展名，整个名字远短于 Windows 的路径上限。 */
const TITLE_MAX_CODE_POINTS = 80;

/** 控制字符（含换行、制表）与 Windows 保留字符、Unicode 分隔符都换成连字符。 */
const ILLEGAL_NAME_CHARACTERS = /[\u0000-\u001f\u007f\u2028\u2029<>:"/\\|?*]/gu;

function stemOf(title: string, exportedAt: Date): string {
  const cleaned = title
    .replace(ILLEGAL_NAME_CHARACTERS, "-")
    // 首尾的点、空格与刚换出来的分隔符都会被 Windows 静默去掉或读成怪名字；
    // 先自己处理，落盘的名字与界面说出的那个才是同一个。
    .replace(/^[.\s-]+/u, "").replace(/[.\s-]+$/u, "")
    // 一连串分隔符收成一根：标题里的「 -- 」不该在文件名里排成一串横线。
    .replace(/\s*-{2,}\s*/gu, "-")
    .trim();
  const characters = Array.from(cleaned);
  // 截断边界正好落在分隔符上时，尾巴那根横线会和日期前的横线连成 `--`：收掉。
  const clipped = (characters.length > TITLE_MAX_CODE_POINTS
    ? characters.slice(0, TITLE_MAX_CODE_POINTS).join("")
    : cleaned).replace(/[-.\s]+$/u, "");
  // 前缀固定：一眼认出这是 Relay 导出的会话文件；标题只剩空白或分隔符时也不会只剩一个日期。
  return `Relay-${clipped === "" ? "会话" : clipped}-${stampOf(exportedAt)}`;
}

function stampOf(value: Date): string {
  const pad = (part: number) => String(part).padStart(2, "0");
  // 本地日期：文件名上这一天要和用户在界面上看到的「今天」是同一个日子。
  return `${value.getFullYear()}${pad(value.getMonth() + 1)}${pad(value.getDate())}`;
}

/** 本页面会话内已交出去过的文件名：同名再导出时改用 `-2`、`-3`，不覆盖旧文件。 */
const handedOut = new Set<string>();

/**
 * 取一个本页内尚未用过的 `.json` 名字。
 *
 * 只在**决定落盘**时调用：拿号之后不保存会白白占掉这个名字，所以调用点紧跟 `saveExportFile`。
 */
export function reserveSessionExportFileName(title: string, exportedAt: Date): string {
  const stem = stemOf(title, exportedAt);
  let candidate = `${stem}.json`;
  for (let index = 2; handedOut.has(candidate); index += 1) {
    candidate = `${stem}-${String(index)}.json`;
  }
  handedOut.add(candidate);
  return candidate;
}

/**
 * 触发本地下载。正文必须已经是完整文档：这里拒绝空正文，因为「导出失败却落了一个空文件」
 * 会让人以为证据已经拿到手了。
 */
export function saveExportFile(fileName: string, text: string): void {
  if (text.trim() === "") throw new Error("导出正文为空，已放弃保存。");
  const url = URL.createObjectURL(new Blob([text], { type: "application/json;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  // `download` 里的值就是纯文件名：浏览器把它解释为「存到下载目录」，不是路径。
  link.download = fileName;
  // Firefox 需要节点在文档里才认这次下载。
  link.style.display = "none";
  document.body.append(link);
  link.click();
  link.remove();
  // 立刻 revoke 会让还没开始的下载读不到对象：给浏览器留出取走的时间。
  window.setTimeout(() => { URL.revokeObjectURL(url); }, 4000);
}
