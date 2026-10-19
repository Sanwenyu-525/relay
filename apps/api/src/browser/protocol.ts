/**
 * 浏览器能力的冻结词表（F26，docs/architecture/browser-automation-v1.md）。
 *
 * 这里只放「Relay 自己的口径」——动作分类、错误码、目标合成值。**不含**上游
 * chrome-devtools-mcp 的工具名与参数：那些属于 `provider.ts` 的映射表，且必须由
 * 启动时的 `tools/list` 自检来核对，不允许在别处再写一份。
 */

/** 浏览器动作的三个能力族。读、交互、提交的默认策略与可授权性都不同。 */
export const BROWSER_READ_ACTIONS = [
  'BROWSER_LIST_PAGES',
  'BROWSER_READ_PAGE',
  'BROWSER_SCREENSHOT',
  'BROWSER_WAIT_FOR',
] as const;

export const BROWSER_INTERACTION_ACTIONS = [
  'BROWSER_NEW_PAGE',
  'BROWSER_NAVIGATE',
  'BROWSER_CLICK',
  'BROWSER_FILL',
  'BROWSER_PRESS_KEY',
  'BROWSER_CLOSE_PAGE',
] as const;

/**
 * 有外部影响的动作：提交表单、上传文件。
 *
 * 它们**不在** `SCOPE_GRANT_ACTIONS` 里，因此「本次任务允许」永远覆盖不到它们；
 * 每次都必须走单动作 Review。这是本功能唯一一条结构性护栏，不依赖风险分类器的启发式判断。
 */
export const BROWSER_COMMIT_ACTIONS = [
  'BROWSER_SUBMIT_FORM',
  'BROWSER_UPLOAD_FILE',
] as const;

export const BROWSER_ACTIONS: readonly string[] = [
  ...BROWSER_READ_ACTIONS, ...BROWSER_INTERACTION_ACTIONS, ...BROWSER_COMMIT_ACTIONS,
];

export function isBrowserAction(actionType: string): boolean {
  return BROWSER_ACTIONS.includes(actionType);
}

export function isBrowserReadAction(actionType: string): boolean {
  return (BROWSER_READ_ACTIONS as readonly string[]).includes(actionType);
}

export function isBrowserCommitAction(actionType: string): boolean {
  return (BROWSER_COMMIT_ACTIONS as readonly string[]).includes(actionType);
}

/** 逻辑动作 → 能力。三族一一对应，不再有第二处映射。 */
export function browserCapabilityFor(actionType: string):
'BROWSER_READ' | 'BROWSER_ACTION' | 'BROWSER_COMMIT' | null {
  if (isBrowserReadAction(actionType)) return 'BROWSER_READ';
  if ((BROWSER_INTERACTION_ACTIONS as readonly string[]).includes(actionType)) return 'BROWSER_ACTION';
  if (isBrowserCommitAction(actionType)) return 'BROWSER_COMMIT';
  return null;
}

/**
 * Gateway 目标合成值。
 *
 * 浏览器动作没有受管根，但需要让 Permission 能按站点收窄，因此目标形如
 * `browser://<host>`——**主机形式，不带协议**（`browser://example.com:8080`）。
 * 带协议会把合成值撑成 `browser://https://…`，既无法用 URL 语义解释，也会被
 * 目标归一拒绝（实测踩过）。origin 只来自**服务端已知的页面状态或本次导航目标**，
 * 不接受模型自报；拿不到时退到 `browser://unknown`（只能被 `browser://` 全量或全等策略放行）。
 */
export const BROWSER_TARGET_SCHEME = 'browser://';
export const BROWSER_UNKNOWN_TARGET = 'browser://unknown';
export const BROWSER_ALL_TARGET = 'browser://';

export function browserTargetForOrigin(origin: string | null | undefined): string {
  if (origin === null || origin === undefined || origin === '') return BROWSER_UNKNOWN_TARGET;
  // 防御性归一：调用方应当传 originOfUrl 的结果，但这里再剥一次协议与路径，
  // 避免任何调用点把完整 URL 递进来时把 `/path` 带进策略目标。
  const host = origin.toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/[/?#].*$/, '');
  if (host === '' || host === 'null') return BROWSER_UNKNOWN_TARGET;
  return `${BROWSER_TARGET_SCHEME}${host}`;
}

/** 从 `browser://<host>` 取回 host；不是该 scheme 时返回 null。 */
export function originFromBrowserTarget(target: string): string | null {
  if (!target.startsWith(BROWSER_TARGET_SCHEME)) return null;
  const host = target.slice(BROWSER_TARGET_SCHEME.length);
  return host === '' ? null : host;
}

/** 只允许 http/https：file:// 会让"网页操作"变成读本地任意文件。 */
export function isAllowedNavigationUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function originOfUrl(value: string): string | null {
  try {
    return new URL(value).origin.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * 类型化错误码（对外稳定）。
 *
 * 与 `computer/protocol.ts` 同一纪律：错误码是给模型和 UI 看的稳定标识，
 * 不把上游 MCP 的报错原文当契约——原文只进 `detail`。
 */
export const BROWSER_ERROR_CODES = [
  /** 后端入口缺失（打包资源不全）。 */
  'BROWSER_BACKEND_MISSING',
  /** 浏览器扩展未安装或未连接（扩展桥接路线的"未就绪"态）。 */
  'BROWSER_EXTENSION_MISSING',
  /** 后端进程起不来或已不可用。 */
  'BROWSER_BACKEND_UNAVAILABLE',
  /** 后端进程在请求中途断开：在途动作效果未知。 */
  'BROWSER_BACKEND_DISCONNECTED',
  /** 上游工具集与冻结映射不一致（版本不兼容）。 */
  'BROWSER_BACKEND_INCOMPATIBLE',
  /** 未找到 Chrome 可执行文件。 */
  'BROWSER_CHROME_MISSING',
  /** Chrome 启动失败（profile 被占用、端口未写出等）。 */
  'BROWSER_CHROME_START_FAILED',
  /** page_id 不存在（可能已被用户关闭）。 */
  'BROWSER_PAGE_NOT_FOUND',
  /** page_id 存在但不属于本任务：用户页或别的任务的页，一律不动。 */
  'BROWSER_PAGE_NOT_OWNED',
  /** uid 不存在或已失效：必须重新读取页面，不允许猜。 */
  'BROWSER_ELEMENT_NOT_FOUND',
  /** 页面实际 origin 与本次动作冻结的目标 origin 不一致（用户改了地址或页面跳走了）。 */
  'BROWSER_PAGE_STATE_CHANGED',
  /** 上一次动作结果未知，页面状态未确认：必须先读取再继续。 */
  'BROWSER_PAGE_STALE',
  /** 等待或导航超时。 */
  'BROWSER_TIMEOUT',
  /** 目标地址被拒绝（非 http/https 等）。 */
  'BROWSER_NAVIGATION_BLOCKED',
  /** 动作被用户取消。 */
  'BROWSER_USER_CANCELLED',
  /** 动作已发出但结果未知：必须先重新观察，不得盲目重试。 */
  'BROWSER_EFFECT_UNCERTAIN',
  /** 动作本身失败（上游报错或工具返回 isError）。 */
  'BROWSER_ACTION_FAILED',
  /** 上游协议违规（响应形状不符）。 */
  'BROWSER_PROTOCOL_VIOLATION',
  /** 参数不合法。 */
  'BROWSER_INVALID_REQUEST',
] as const;

export type BrowserErrorCode = (typeof BROWSER_ERROR_CODES)[number];

/** 浏览器任务状态的展示态（与 computer_control_state 同构，但按任务维度而不是单行）。 */
export type BrowserSessionState = 'RUNNING' | 'STOP_REQUESTED' | 'STOPPED';
