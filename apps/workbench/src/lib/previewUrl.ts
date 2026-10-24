/**
 * 内置网页预览的地址预检。
 *
 * 权威判定在原生宿主：`apps/desktop/src-tauri/src/preview_webview.rs` 的 `PreviewUrlPolicy`
 * 会在创建容器时和**每一次**导航（含服务端重定向）时重新校验。这里只按同一套规则做前置
 * 检查，让用户按下回车时立刻看到原因，而不是等一次 IPC 往返。
 *
 * 两处规则必须保持一致；唯一例外是「本机 Relay API 端口」：前端不知道本次启动的端口，
 * 由宿主判定并回传明确原因。
 */

export type PreviewUrlProblem =
  | "EMPTY"
  | "TOO_LONG"
  | "MALFORMED"
  | "UNSUPPORTED_SCHEME"
  | "EMBEDDED_CREDENTIALS"
  | "APPLICATION_ORIGIN"
  | "WORKBENCH_ORIGIN";

export interface PreviewUrlAccepted {
  readonly ok: true;
  /** 规范化后的完整地址，交给宿主导航。 */
  readonly url: string;
  /** 只含协议 + 主机 + 端口的来源描述；恢复数据只允许保存这个粒度。 */
  readonly origin: string;
}

export interface PreviewUrlRejected {
  readonly ok: false;
  readonly problem: PreviewUrlProblem;
  readonly message: string;
}

export type PreviewUrlCheck = PreviewUrlAccepted | PreviewUrlRejected;

/** 与宿主 `PREVIEW_URL_LIMIT` 一致：超长输入多为粘贴事故。 */
export const PREVIEW_URL_LIMIT = 4096;

/** 工作台前端开发服务器来源；它出现在桌面 capability 的 remote 白名单里，必须拒绝。 */
const WORKBENCH_DEV_HOSTS: readonly string[] = ["127.0.0.1", "localhost", "[::1]", "0.0.0.0"];
const WORKBENCH_DEV_PORT = "5173";

const messages: Record<PreviewUrlProblem, string> = {
  EMPTY: "请输入完整网址（以 http:// 或 https:// 开头）。",
  TOO_LONG: "网址过长，无法作为预览地址。",
  MALFORMED: "无法解析这个网址；请检查是否缺少协议或包含非法字符。",
  UNSUPPORTED_SCHEME: "内置预览只接受 http 与 https 地址。",
  EMBEDDED_CREDENTIALS: "网址里不能包含用户名或密码；请在页面里登录。",
  APPLICATION_ORIGIN: "这是 Relay 应用自身的地址，不能作为预览页打开。",
  WORKBENCH_ORIGIN: "这是工作台前端的开发服务器地址，不能作为预览页打开。"
};

function reject(problem: PreviewUrlProblem): PreviewUrlRejected {
  return { ok: false, problem, message: messages[problem] };
}

/** 只保留 scheme://host[:port]。用于恢复数据：path / query / fragment 一律不落盘。 */
export function previewOriginOf(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (parsed.username !== "" || parsed.password !== "") return null;
    if (parsed.hostname === "") return null;
    // `URL.origin` 已经按规范省略默认端口，不会把 80/443 写成显式端口。
    const origin = parsed.origin;
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
}

/**
 * 校验用户输入。不做「自动补协议」也不做搜索引擎跳转：首版只接受完整 http/https 地址，
 * 猜错的协议比让用户补三个字符更糟。
 */
export function checkPreviewUrl(raw: string): PreviewUrlCheck {
  const trimmed = raw.trim();
  if (trimmed === "") return reject("EMPTY");
  if (trimmed.length > PREVIEW_URL_LIMIT) return reject("TOO_LONG");

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return reject("MALFORMED");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return reject("UNSUPPORTED_SCHEME");
  if (parsed.username !== "" || parsed.password !== "") return reject("EMBEDDED_CREDENTIALS");
  if (parsed.hostname === "") return reject("MALFORMED");

  const host = parsed.hostname.toLowerCase();
  if (host === "tauri.localhost" || host === "ipc.localhost") return reject("APPLICATION_ORIGIN");
  if (parsed.port === WORKBENCH_DEV_PORT && WORKBENCH_DEV_HOSTS.includes(host)) return reject("WORKBENCH_ORIGIN");

  const origin = parsed.origin;
  if (origin === "null") return reject("MALFORMED");
  return { ok: true, url: parsed.toString(), origin };
}

/** 地址栏显示用的紧凑形式：只去掉「根路径」的尾斜杠。
 *
 * `https://a.example/` 显示成 `https://a.example`，但 `https://a.example/a/` 原样保留——
 * 带路径时 `/a` 与 `/a/` 可能是不同资源，显示层不该替用户抹平这个差别。
 */
export function previewDisplayUrl(raw: string): string {
  if (raw.length <= 1) return raw;
  try {
    const parsed = new URL(raw);
    if (parsed.pathname === "/" && parsed.search === "" && parsed.hash === "") {
      return raw.endsWith("/") ? raw.slice(0, -1) : raw;
    }
    return raw;
  } catch {
    return raw;
  }
}
