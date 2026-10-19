# 内置浏览器自动化（F26）架构审查与实施方案

状态：**架构审查与选型完成；未实施、未验收、未 commit**。日期：2026-10-17。
角色：本页是浏览器能力的**唯一设计与集成入口**（选型、模块责任、集成点、打包、测试口径）。范围边界归[范围矩阵 F26](../requirements/v1-scope.md#内置浏览器自动化范围补充2026-10-17)；取舍与被拒方案归 [ADR-024](../decisions/ADR-024-builtin-browser-automation.md)；未运行规格归[测试计划 §36](../testing/verification-plan.md#36-内置浏览器自动化验收规格2026-10-17)；成绩只归[统一验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)。
与 [Computer Plugin V2 审计](computer-plugin-v2-migration-audit.md) Phase 3 的关系：该审计把 Browser/CDP 列为「本仓库没有可复用实现、需新建」；本页承接该结论并**改变接入形态**——浏览器不再作为 `COMPUTER_*` 的后台 provider，而是独立的能力族与工具词表。理由见 §4.1。

---

## 1. 审查方法与实际依据

只读审查，未改任何产品源码。依据为源码事实（非文档转述）：

| 审查项 | 实际读取 |
|---|---|
| 桌面宿主与 IPC | `apps/desktop/src-tauri/src/lib.rs`（1484 行）、`tauri.conf.json`、`Cargo.toml`、`esc_hook.rs`、`job_sidecar.rs` |
| 前端栈与通信 | `apps/workbench/package.json`、`apps/workbench/src/views/ConnectionsView.tsx`、`api/dtos/gateway.ts` |
| 工具注册与词表 | `apps/api/src/workflow/tool-catalog.ts`、`application/tool-loop.ts`、`assistant-readonly-round.ts`、`assist-read-tools.ts` |
| 权限与准入 | `application/gateway-actions.ts`（2793 行）、`gateway/adapter-metadata.ts`、`application/run-scope-grant.ts`、`gateway-configuration.ts` |
| 既有电脑操控 | `apps/api/src/computer/*`（8 文件 1365 行）、`apps/computer-runtime/src/*.rs`、`api/computer-api.ts`、迁移 `0092`/`0096` |
| 取消与状态 | `computer/control-state.ts`、`application/control-requests.ts`、`esc_hook.rs`、`desktop/control_overlay.rs` |
| 打包与升级 | `apps/desktop/scripts/build-release.ps1`（240+ 行）、`worker/supervisor.ts`、迁移目录 `0001`–`0104` |
| 上游候选 | `ChromeDevTools/chrome-devtools-mcp`（README/configuration/advanced-usage/tool-reference + npm registry）、`leeguooooo/chrome-use`（README） |
| 本机环境 | Chrome `155.0.8059.84`（`C:\Program Files\Google\Chrome\Application`）；打包 Node `v24.21.0`；Windows 11 家庭中文版 22631 |

**MCP 事实（关键）**：`apps/api/src`、`apps/workbench/src`、`apps/desktop/src-tauri/src` 中 `mcp` 命中数为 0。**本仓库没有 MCP 运行时、没有 MCP 客户端、没有任何 MCP 配置入口。** 因此任务书「若已有 MCP 运行时直接用」不成立，需要新建最小 MCP stdio 客户端。

---

## 2. 现状事实（决定集成形态）

| 维度 | 事实 | 对浏览器能力的影响 |
|---|---|---|
| 桌面框架 | Tauri `2.11.6`（`tauri-build 2.6.3`），`@tauri-apps/api 2.11.1`；React `19.3.0` + Vite `8.3.0` | 外部进程只能由 Rust 宿主或 API 子进程管理，**不得由 React 直接拉起** |
| 前后端通信 | 桌面宿主起 `node.exe` 跑 `api/dist/src/main.js`，用私有 stdin 帧换 loopback HTTP 端口 + bearer token；前端走 HTTP | 浏览器后端健康态与操作必须经 API/Worker，不新增 Tauri IPC 通道 |
| 执行进程模型 | **模型工具循环全部在 Worker 进程**：`worker/main.ts` 既跑 Run 命令也跑 `runAssistGenerationTick`；`supervisor.ts` 用 `...process.env` 派生 worker | BrowserSessionManager 必须是 **Worker 进程内的进程级单例**（与 `getComputerRuntimeClient()` 同形），不能放 API 进程 |
| 工具注册 | `tool-catalog.ts` 冻结词表：模型可见工具名、JSON Schema、`actionType`、`capability` 三者一处定义；词表外工具名落库前即被拒 | 新工具必须进这份词表，不能走"动态注册" |
| 权限 | 能力（DB `gateway_capabilities`）→ 连接（ACTIVE + 能力）→ 策略（`AUTO/ASK/DENY` + `target_prefix`）→ 单动作 Review / 本次任务范围授权（`SCOPE_GRANT_ACTIONS` 闭集） | 复用现成四段；新增能力必须进 `ADAPTER_DESCRIPTORS`（TS `Record` 强制）与迁移 CHECK |
| 执行身份 | `RUN`（Task/Run 工具循环，可写）/ `ASSISTANT_READ`、`AGENT_SESSION_READ`（会话轮次，**只读**）/ `USER_ACTION` | 会话里只能读浏览器；动作必须走 Run。见 §9 D1 |
| 既有电脑操控 | Rust 运行时 + `SendInput` + GDI 截图 = **桌面 GUI 自动化**；`COMPUTER_INPUT` 默认需授权，`allow_foreground` 由 Gateway 注入 | 与浏览器 DOM/CDP 自动化是**两条不同能力**，不得混用同一能力键 |
| 既有浏览器痕迹 | `CaptureTarget` 含 `browser_page`、`CoordinateSpace` 含 `browser_viewport`、`execution-router` 有 `browser_cdp` 优先级位（Rust 侧上报 `not_configured`） | 是**占位与优先级声明**，不是实现。V1 不改路由器，页面截图走 `browser_screenshot` |
| 打包 | `build-release.ps1` 把 `pnpm deploy --prod` 的 API、`node.exe`、`relay-file-io-helper.exe`、`relay-computer-runtime.exe`、`browser-extension/`、`api/` 逐项校验后进 `src-tauri/resources`，并在 Tauri 构建后核对产物清单 | 浏览器后端按同一纪律新增一个 staging 目录；**不能**用 `npx latest` |
| 桌面资源清单 | 2026-10-18 更新：`tauri.conf.json` 的 `bundle.resources` 现列 5 项（含 computer-runtime 与 browser-extension）。`tauri-build` 在**编译期**逐条校验这些路径，任一条缺失即 `tauri dev` 的 build script 报 `resource path ... doesn't exist`，报错不指向"缺打包资源"。`dev-desktop.ps1` 已就地补齐这两项（runtime 取 computer-runtime 的 release 产物，扩展拷四个源文件），不再要求先跑一次完整 release | 本行原先记的是"只列 4 项、resources/ 里没有 computer-runtime"这个随包缺口；现已随包，但 `apps/desktop/src-tauri/src` 仍**没有**读取这两项的代码（grep 无命中），即"分发到位、消费未接"。**新增随包资源必须同时补 dev 暂存**，否则别人 `tauri dev` 直接编不过 |

### 2.1 明确缺口

1. 无 MCP 客户端（需新建，见 §4.6）。
2. 无浏览器后端、无 CDP/Playwright 依赖、无浏览器连接配置。
3. 前端 `RelayGatewayCapability` 只有 9 项，**缺 `COMPUTER_READ`/`COMPUTER_INPUT`/`GITHUB_READ`**；`ConnectionsView.tsx` 的能力下拉与标签表同为硬编码 9 项。既有后端能力在 UI 里**不可见、不可配**——浏览器能力若照抄现状，会重演同一缺口。
4. 无任何浏览器相关 UI、控制状态表或诊断入口。

---

## 3. 选型结论

### 3.1 默认候选：`chrome-devtools-mcp`（采纳）

| 事实 | 值 | 出处 |
|---|---|---|
| 版本 | `1.11.0`（`chrome-devtools-mcp@1.11.0`） | npm registry |
| 许可 | **Apache-2.0**，作者 Google LLC，npm provenance 已签名 | registry `license`/`attestations` |
| 引擎要求 | `node: ^20.19.0 \|\| ^22.12.0 \|\| >=23` | 打包 Node `v24.21.0` **满足** |
| 运行时依赖 | **无**（`dependencies` 字段缺失，发布物为 rollup 自包含包） | registry |
| 体积 | `unpackedSize` 14,062,824 B / 370 文件 | registry |
| 工具数 | 59（分类可开关） | `docs/tool-reference.md` |
| 页面路由 | `--pageIdRouting` **默认 true**：page-scoped 工具接受 `pageId` | `docs/advanced-usage.md` |
| 默认 profile | `%USERPROFILE%\.cache\chrome-devtools-mcp\chrome-profile`，**不碰用户默认 Chrome 配置** | `docs/configuration.md` |
| 遥测 | 使用统计**默认开启**（`--no-usage-statistics` 可关）；CrUX 外呼默认开启（`--no-performance-crux` 可关）；更新检查默认开启 | `README.md` |

采纳理由：官方维护、协议成熟（a11y 快照 + uid 定位，正是"DOM/无障碍树优先"的要求）、`pageId` 路由天然支持"不依赖当前聚焦标签页"、自包含可离线打包、不读写用户默认 profile。

### 3.2 连接模式：Relay 拉起自有 Chrome，MCP 以 `--browserUrl` 附着（采纳 B）

| 方案 | 形态 | 判定 |
|---|---|---|
| A：MCP 自己拉 Chrome（默认） | MCP 用 `--userDataDir` 指向 Relay 数据目录 | 可用，但 **Relay 不持有 chrome.exe**：MCP 崩溃后 Chrome 成孤儿，无法确定性清理，也无法在取消后保证"底层真的停下" |
| **B：Relay 拉 Chrome（`--remote-debugging-port=0` + 独立 profile）→ MCP `--browserUrl=http://127.0.0.1:<port>`** | Relay 持有 PID、端口、profile 目录；MCP 只是客户端 | **采纳**：进程所有权明确、崩溃可重建、退出可清理；Chrome 本身要求远程调试必须配非默认 `--user-data-dir`，与"不碰用户配置"一致 |
| C：`--autoConnect` / 连用户已开 Chrome | 需用户在 `chrome://inspect` 手工开启远程调试 | **V1 不采纳**：连的是用户默认 profile 与全部窗口，直接违反"不得默认操作正在使用的标签页"；留作后续"复用登录态"的独立决策 |

端口获取：Chrome 以 `--remote-debugging-port=0` 启动后写 `<profile>/DevToolsActivePort`（首行端口、次行 ws 路径），Relay 读该文件得到真实端口，不做端口猜测。

Chrome 启动参数基线：`--user-data-dir=<data-root>/browser/profile`、`--no-first-run`、`--no-default-browser-check`、`--disable-features=...`（仅必要项）、`--remote-debugging-port=0`、独立 `--window-position/--window-size` 便于用户旁观；**不传**任何 stealth/反检测参数。

MCP 启动参数基线（关闭与本功能无关的面）：

```text
--browserUrl=http://127.0.0.1:<port>
--no-usage-statistics            # 关闭 Google 使用统计
--performance-crux=false         # 关闭 CrUX 外呼
--no-update-checks               # 关闭 npm 更新检查（版本由安装包固定）
--category-performance=false --category-network=false
--category-memory=false --category-extensions=false
--category-experimental-webmcp=false --category-experimental-third-party=false
--screenshot-format=png
```

### 3.3 `chrome-use`：V1 不接入（保留 provider 位）

评估结论（依据其 README）：Apache-2.0；架构为 Chrome 扩展 + native messaging，扩展用 `chrome.debugger` 驱动**用户真实标签页**；12 项扩展权限、无 `<all_urls>`；Windows 安装走 `install.ps1`（写 `%LOCALAPPDATA%` + 改用户 PATH）+ `chrome-use extension install`（注册 native messaging host）。

不接入的五条理由：

1. **与"不擅自修改用户 Chrome 配置"直接冲突**：安装扩展 + 注册 native host 都是对用户浏览器的持久改动，本需求明确禁止静默安装。
2. **与"不操作用户正在使用的标签页"天然对立**：它驱动的就是用户真实浏览器；其"每个 session 一个彩色标签组"正是本需求第 5 条点名**不能当作隔离机制**的东西。
3. **能力面过宽且带反检测取向**：stealth/反机器人检测不是本项目需求，对部分站点还存在合规风险。
4. **维护形态**：单一维护者、版本节奏快（README 自述 v1.5.x 频繁迭代），无 npm 包、靠 GitHub Release 二进制，Windows 打包需自带 exe + 版本锁定 + 安装/卸载编排。
5. **不是 V1 的必要条件**：任务书明确"不要求复用登录会话时优先 chrome-devtools-mcp"。

保留方式：`BrowserProvider` 接口不暴露任何 chrome-devtools-mcp 特有概念（见 §4.3），后续接入 `chrome-use` 只需新增一个实现类 + 一套用户可见的安装/卸载流程，不改工具词表与权限模型。

### 3.4 明确否决的做法

| 做法 | 否决理由 |
|---|---|
| `npx -y chrome-devtools-mcp@latest` | 不可复现、随上游漂移、离线安装失败；与 `build-release.ps1` 的锁定纪律冲突 |
| 连用户默认 Chrome profile（含 `--remote-debugging-port=9222` 指向日常实例） | 需关掉用户全部 Chrome、调试端口对整机开放、直接暴露用户登录态 |
| 桌面坐标点击兜底（`COMPUTER_CLICK`）当网页操作默认路径 | 违反"不争抢鼠标键盘"；页面坐标随滚动/缩放/DOM 变化失效 |
| 静默安装扩展或改写 Chrome 配置 | 需求明令禁止 |
| V1 同时实现 MCP 与 chrome-use 两套引擎 | 首个版本只做一条链路，避免双份失败面 |
| 暴露 `evaluate_script`（任意页面 JS） | 等于把"在用户已登录页面里执行任意脚本"作为工具交给模型；V1 词表不含该工具 |

---

## 4. 架构设计

### 4.1 责任边界与进程图

```text
React 工作台（浏览器面板 / 工具轨迹 / 审批卡）
   │  HTTP（既有 client，无新通道）
API 进程（fastify）
   ├─ GET  /browser/status            后端健康 + 诊断（只读投影）
   ├─ GET  /browser/sessions          当前浏览器任务（跨进程可见，读 PG）
   └─ POST /browser/sessions/:id/stop 复用既有 run_control_requests 取消通道
   │
Worker 进程（模型工具循环：RUN 与会话轮次都在这里）
   ├─ workflow/tool-catalog.ts        12 个 browser_* 工具（冻结词表）
   ├─ application/gateway-actions.ts  prepare/admit/dispatch（能力= BROWSER_READ/ACTION/COMMIT）
   ├─ browser/browser-adapter.ts      参数白名单 + 结果投影 + 风险分类（纯函数优先）
   ├─ browser/session-manager.ts      进程级单例：Chrome 生命周期、页面所有权、串行化、恢复
   ├─ browser/mcp-client.ts           MCP stdio 客户端（JSON-RPC 2.0，新增）
   ├─ browser/provider.ts             BrowserProvider 接口 + McpBrowserProvider 实现
   └─ browser/chrome-launcher.ts      拉起/关闭自有 Chrome、读 DevToolsActivePort
   │  stdio JSON-RPC
chrome-devtools-mcp 1.11.0（随包 node.exe 运行，resources/browser-mcp/）
   │  CDP over ws（loopback）
Relay 自有 Chrome（独立 profile，独立窗口）
```

为什么**不**做成 `COMPUTER_*` 的后台 provider：

- 权限语义不同：网页操作要区分"读/普通交互/有外部影响的提交"，桌面输入是另一套（`FOREGROUND_NOT_AUTHORIZED` + 接管确认）。
- 结果形状不同：桌面返回坐标与窗口；浏览器返回 pageId/url/a11y 快照/uid。
- 恢复语义不同：页面读取廉价可重取，桌面输入不可重放。
- 若混入同一能力键，`SCOPE_GRANT_ACTIONS` 会把"允许操作电脑"与"允许点网页"合成一条，用户无法分辨自己授权了什么。

### 4.2 能力与工具词表（12 个工具）

| 工具 | 能力 | 参数要点 | 说明 |
|---|---|---|---|
| `browser_list_pages` | `BROWSER_READ` | — | 列出页面：`page_id`/`url`/`title`/`owned`；上限 32，截断显式标记 |
| `browser_read_page` | `BROWSER_READ` | `page_id?` | 结构化页面信息：url、title、readyState、**a11y 快照 + 元素 uid**（有界 12k 字符）、截断标记 |
| `browser_screenshot` | `BROWSER_READ` | `page_id?` | 只返回摘要（宽高/字节/sha256/时戳），**正文不进账本**（沿用 `computer-adapter` 纪律） |
| `browser_wait_for` | `BROWSER_READ` | `page_id?`、`text`、`timeout_ms` | 等待文本出现；不产生外部效果，超时是类型化失败 |
| `browser_new_page` | `BROWSER_ACTION` | `url?` | 新建**本次会话专属**页并绑为默认页；返回 `page_id` |
| `browser_navigate` | `BROWSER_ACTION` | `page_id?`、`url` 或 `history` | 只允许操作自有页；不接受 `file://`（可配置） |
| `browser_click` | `BROWSER_ACTION` | `page_id?`、`uid`、`double?` | **只接受快照 uid**，不接受 CSS/XPath/坐标；uid 失效即失败并提示重读 |
| `browser_fill` | `BROWSER_ACTION` | `page_id?`、`uid`、`text` | 单次上限 64 KiB |
| `browser_press_key` | `BROWSER_ACTION` | `page_id?`、`key` | 单键或组合键（`Control+A` 形式由上游规范） |
| `browser_close_page` | `BROWSER_ACTION` | `page_id` | **仅允许关闭自有页**；用户页一律拒绝 |
| `browser_submit_form` | `BROWSER_COMMIT` | `page_id?`、`uid` | 显式提交；不接受范围授权，永远单动作批准 |
| `browser_upload_file` | `BROWSER_COMMIT` | `page_id?`、`uid`、`relative_path` | 只允许上传受管根内文件；永远单动作批准 |

`page_id` 语义（核心安全规则）：

- 缺省 = **本次 Run/会话自己绑定的默认页**，该页只可能是本会话 `browser_new_page` 创建的；
- **永远不存在"缺省 = 用户当前聚焦标签页"的分支**；实现上不调用上游 `select_page`，每次都显式传 `pageId`。
- 传入未登记的 `page_id`（用户自己开的页、或别的 Run 的页）→ `BROWSER_PAGE_NOT_OWNED`，不执行、不关闭、不导航。

### 4.2.1 上游实测映射（M1 冻结，2026-10-17）

用真实 Chrome 155 + `chrome-devtools-mcp@1.11.0` 实测 `tools/list` 与返回形状后冻结。**这四条实测事实推翻了按文档写的假设**，必须以此为准：

1. **`pageId` 是 number，且在所有页面工具里都是必填**——上游没有"隐式当前页"，因此"误操作当前聚焦标签页"在协议层就不可能发生。Relay 侧对外仍用字符串 `page_id`，只在适配层转换一次。
2. **`new_page` 返回页面列表而不是新页 id**，新 id 必须用「调用前后的列表求差」得到。
3. **`navigate_page` 把导航失败写进正文**（`Unable to navigate …`）而不置 `isError`，必须按正文判定，否则会把失败当成功。
4. **`includeSnapshot` 在导航提交之前取样**：点提交按钮后拿到的是「新 URL + 旧 DOM」。因此动作后**不用**它，改为重新读取并等页面稳定（连续两次 URL 与正文一致才返回，最多多读两次）。

| Relay 工具 | 上游工具 | 上游参数（实测） |
|---|---|---|
| `browser_list_pages` | `list_pages` | `{}` |
| `browser_read_page` | `take_snapshot` | `{ pageId }` |
| `browser_screenshot` | `take_screenshot` | `{ pageId, format: 'png' }` |
| `browser_wait_for` | `wait_for` | `{ pageId, text, timeout }`（毫秒） |
| `browser_new_page` | `new_page` | `{ url }`（必填，缺省 `about:blank`）+ 前后列表求差 |
| `browser_navigate` | `navigate_page` | `{ pageId, type: 'url'\|'back'\|'forward'\|'reload', url? }` |
| `browser_click` | `click` | `{ pageId, uid, dblClick? }`（**不是** `double`） |
| `browser_fill` | `fill` | `{ pageId, uid, value }`（**不是** `text`） |
| `browser_press_key` | `press_key` | `{ pageId, key }` |
| `browser_close_page` | `close_page` | `{ pageId }` |
| `browser_submit_form` | `click` | `{ pageId, uid }`（上游无独立 submit；Relay 侧仍是独立工具与独立能力） |
| `browser_upload_file` | `upload_file` | `{ pageId, uid, filePaths: [绝对路径] }` |

上游启动参数（实测校准）：

```text
--browserUrl=http://127.0.0.1:<port>
--no-usage-statistics --performance-crux=false
--category-performance=false --category-network=false
--category-memory=false --category-extensions=false
--category-experimental-webmcp=false --category-experimental-third-party=false
--screenshot-format=png
--experimentalStructuredContent=true     # 页面列表给机器可读结构，缺失时退回文本解析
--file-navigations=false                 # 从引擎层关掉 file://（上游默认允许）
# 环境变量（不是参数）：CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS=1
# 实测 `--no-update-checks` 不是合法参数（报 Unknown arguments: --updateChecks）
```

快照文本有三种行形状，解析器必须都认（`uid=1_3 "关键词 "` 是**没有角色**的静态文本节点，把第一个引号串当角色会得到 `"关键词`）：

```text
uid=1_0 RootWebArea "Relay Fixture" url="http://127.0.0.1:4839/"
  uid=1_2 form
    uid=1_3 "关键词 "
    uid=1_4 textbox "关键词"
    uid=1_5 button "提交查询"
```

### 4.3 `BrowserProvider` 接口

只保留"一次页面级操作"，不泄漏 MCP 概念；后续换后端只换实现。

```ts
export interface BrowserPageRef { readonly pageId: string; readonly url: string;
  readonly title: string; readonly owned: boolean; }

export interface BrowserSnapshot { readonly url: string; readonly title: string;
  readonly readyState: string; readonly text: string; readonly truncated: boolean;
  /** uid → 角色/名称，供风险分类与后续点击共用；不落账本正文。 */
  readonly elements: ReadonlyArray<{ readonly uid: string; readonly role: string;
    readonly name: string; readonly inForm: boolean; readonly submitLike: boolean }>; }

export interface BrowserProvider {
  readonly kind: 'chrome-devtools-mcp';
  ensureStarted(signal?: AbortSignal): Promise<BrowserHealth>;
  health(): Promise<BrowserHealth>;
  listPages(signal?: AbortSignal): Promise<readonly BrowserPageRef[]>;
  newPage(input: { url?: string; signal?: AbortSignal }): Promise<BrowserPageRef>;
  closePage(pageId: string, signal?: AbortSignal): Promise<void>;
  readPage(pageId: string, signal?: AbortSignal): Promise<BrowserSnapshot>;
  navigate(input: { pageId: string; url?: string;
    history?: 'back' | 'forward' | 'reload'; signal?: AbortSignal }): Promise<BrowserSnapshot>;
  click(input: { pageId: string; uid: string; double?: boolean;
    signal?: AbortSignal }): Promise<BrowserSnapshot>;
  fill(input: { pageId: string; uid: string; text: string;
    signal?: AbortSignal }): Promise<BrowserSnapshot>;
  pressKey(input: { pageId: string; key: string; signal?: AbortSignal }): Promise<BrowserSnapshot>;
  waitFor(input: { pageId: string; text: string; timeoutMs: number;
    signal?: AbortSignal }): Promise<BrowserSnapshot>;
  submitForm(input: { pageId: string; uid: string; signal?: AbortSignal }): Promise<BrowserSnapshot>;
  uploadFile(input: { pageId: string; uid: string; absolutePath: string;
    signal?: AbortSignal }): Promise<BrowserSnapshot>;
  screenshot(pageId: string, signal?: AbortSignal):
    Promise<{ width: number; height: number; bytes: number; sha256: string }>;
  dispose(): Promise<void>;
}
```

`BrowserHealth`：`{ status: 'READY' | 'CHROME_MISSING' | 'BACKEND_MISSING' | 'INCOMPATIBLE'
| 'DISCONNECTED'; backendVersion: string | null; chromeVersion: string | null;
tools: readonly string[]; detail: string; remediation: string | null }`。`remediation` 是**可操作**的诊断句（"未找到 Chrome，请安装或设置浏览器路径"），直接供 UI 展示。

工具→上游工具的映射表是**冻结表 + 启动自检**：`ensureStarted` 时 `tools/list` 取真实清单，逐项比对映射所需工具是否齐全；缺任何一个 → `INCOMPATIBLE`，不做"降级猜测"。这样上游大版本变化会在启动期暴露，而不是在用户任务中途变成莫名的点击失败。

### 4.4 `BrowserSessionManager`

进程级单例（Worker），职责与硬规则：

1. **生命周期**：懒启动（第一次 browser 工具调用才拉 Chrome + MCP）；Chrome 与 MCP 一并启动、一并关闭；**不做空闲回收**（用户可能在旁观该窗口，悄悄关掉比留着更糟）；随 Worker 退出而关闭；桌面宿主退出时由既有 Job（kill-on-close）兜底。
2. **页面所有权**：内存表 `pageId → { ownerKind: 'RUN' | 'SESSION', ownerId, createdAt }`；未登记即"用户页"，只读可见、绝不写。
3. **默认页**：每个 owner 首次 `browser_new_page` 绑定；页被用户关掉后默认页失效 → 要求重新 `new_page`，不静默挑别的页。
4. **串行化**：同一 `pageId` 上的操作串行（页级互斥）；不同页可并行（两个 Run 各操作各的页）。
5. **取消**：`AbortSignal` → 发 MCP `notifications/cancelled`（协议原生取消）→ 该次动作按 **UNKNOWN** 结算（`effectKind=WRITE`、`resumable=false`，与 `COMPUTER_INPUT` 同纪律）；页面被标记 `STALE`，下一次读取前必须重新快照。
6. **崩溃/断连恢复**：MCP 退出或 CDP 断开 → 关闭 Chrome、丢弃所有权表、重建实例；所有在途动作按 UNKNOWN；UI 显示"浏览器已重启，任务需重新打开页面"。**不试图接管重启后残留的页**（无法证明它还是同一个任务上下文）。
7. **状态外化**：活跃浏览器任务写 PG（迁移 `0105`，见 §5），因为读它的是 API 进程与桌面壳，而写它的在 Worker 进程——内存单例不可跨进程（这是 `0096` 已经确立的同一理由）。

### 4.5 权限与风险分级

| 能力 | effect | approvalPassthrough | 默认策略 | 可被范围授权 | 理由 |
|---|---|---|---|---|---|
| `BROWSER_READ` | READ | true | AUTO | 不需要 | 读取无外部效果，可安全重取 |
| `BROWSER_ACTION` | WRITE | false | ASK | **可以**（新增 `BROWSER_ACTION` 进 `SCOPE_GRANT_ACTIONS`） | 一次任务里点几十下，逐次批准不可用 |
| `BROWSER_COMMIT` | WRITE | false | ASK | **不可以** | 上传与提交是不可逆外部效果，必须逐次批准 |

风险分类器（`browser-risk.ts`，纯函数，输入 = 快照里的元素描述 + 目标 URL）：

- `submitLike`：`role` 为 button/submit 且 `name` 命中提交类动词表，或元素在 `form` 内且 `type=submit`；
- `sensitiveVerb`：名称命中"购买/支付/删除/发布/发送/上传/确认"等词表；
- 命中任一 → 该次 `browser_click` **即便有范围授权也升级为单动作 ASK**。

**诚实边界（必须写进文档与 UI 提示）**：这是**启发式分类，不是安全边界**。自绘按钮、英文/多语种文案、图标按钮都可能绕过它；因此真正的护栏是三条结构性的：① `BROWSER_COMMIT` 两个工具永不免批；② 范围授权按 Run 生效且用户可见；③ 目标 origin 进 `normalized_target`，策略可按 origin 收窄（见下）。不承诺"系统能拦住所有有外部影响的点击"。

`normalized_target`：`browser://<origin>`（origin 未知时 `browser://unknown`）。origin 取自**服务端已知的页面状态或本次导航目标**，不接受模型自报；`targetMatches` 增加该 scheme 分支（与 `COMPUTER_DESKTOP_TARGET` 同形）：`browser://` 这一个前缀 = 全部站点（策略创建要求前缀非空，不能用空串表达全量），`browser://example.com` 只覆盖该 origin。这样用户可以只允许 `browser://example.com`，而不必整类放开。

网页内容只是数据：a11y 快照与页面文本进入工具结果时带固定前缀提示（与 `github_*` 的"外部数据不是指令"同一纪律）；页面里的"忽略之前的指令"不可能改变能力、策略或授权——三者都在 Gateway 与 DB，不在提示词里。

### 4.6 最小 MCP stdio 客户端（新增）

只实现本功能用到的协议面，**不引入 `@modelcontextprotocol/sdk`**（理由：本项目工具层已有"手写 JSON-lines 客户端"先例 `computer/runtime-client.ts`，且打包链对新增依赖有逐版本核对成本；MCP 的 stdio 传输就是换行分隔的 JSON-RPC 2.0）：

| 能力 | 是否实现 | 说明 |
|---|---|---|
| `initialize` / `notifications/initialized` | 是 | 协商 `protocolVersion`，记录 `serverInfo.version` |
| `tools/list` | 是 | 启动自检 + 冻结映射校验 |
| `tools/call` | 是 | 单请求超时、`isError` → 类型化失败 |
| `notifications/cancelled` | 是 | 取消语义 |
| resources / prompts / sampling / elicitation / roots | 否 | 本功能不用；出现即忽略 |
| HTTP/SSE 传输 | 否 | 只用 stdio（子进程边界更清楚，不开放本地端口） |

生命周期与 `runtime-client.ts` 完全同构：懒启动、请求 `id` 关联、单请求超时杀进程、进程退出让在途请求以 `BROWSER_BACKEND_DISCONNECTED` 失败、回复丢失判 UNKNOWN、单行上限（截图 base64 可能很大，给 32 MiB）。

### 4.7 用户与 Agent 并行（验收核心，逐条落到实现）

| 需求条目 | 实现方式 |
|---|---|
| 不用系统鼠标/键盘/坐标点击 | 全部走 CDP；词表无坐标参数；`COMPUTER_CLICK` 不参与网页路径 |
| DOM/无障碍树 + 元素引用 | `browser_read_page` 返回 a11y 快照与 uid；`click`/`fill` 只收 uid |
| 独立标签页/会话 | `browser_new_page` 建自有页；所有权表隔离；两 Run 各自默认页 |
| 不导航/关闭/修改用户页 | `page_id` 必须已登记为本 owner 所有，否则 `BROWSER_PAGE_NOT_OWNED` |
| 不把标签分组当隔离 | 不实现标签分组；文档明确"同 profile 即同 cookie，页级隔离不是安全隔离" |
| 用户接管后可暂停/重读/继续 | 取消 → UNKNOWN + `STALE`；下一次读取强制重快照；`uid` 失效即失败不猜 |
| 状态不明不盲点/盲提交 | uid 失效、快照版本变化、`STALE` 未清 → 拒绝执行并要求重读 |
| 截图是补充而非替代 | `browser_screenshot` 只给摘要；主路径是快照 + uid |

---

## 5. 集成点清单（实施时按此顺序）

| # | 文件 | 改动 |
|---|---|---|
| 1 | `apps/api/migrations/0105_browser_automation.sql` | `gateway_capabilities` 增 3 行（`BROWSER_READ`/`BROWSER_ACTION`/`BROWSER_COMMIT`）；逐条重述 `logical_operations` 的 origin×resource CHECK 再追加分支（`0092`/`0103` 的教训：漏分支会让历史动作在下次写入时违约） |
| 1b | `apps/api/migrations/0106_browser_backend_state.sql`（M2） | 单行表 `browser_backend_state`：Worker 实测的后端健康结论，API 经 `GET /browser/status` 只读。**M3 另建** `browser_sessions`（按任务的活跃页状态）——那是另一张表、另一个写入方，不塞进这一行 |
| 2 | `apps/api/src/infrastructure/database-schema.ts` | `GatewayCapability` 增 3 项；`BrowserSessionRow` 类型 |
| 3 | `apps/api/src/gateway/adapter-metadata.ts` | 3 条 `AdapterDescriptor`（`Record` 类型会强制补齐） |
| 4 | `apps/api/src/workflow/tool-catalog.ts` | `InternalToolName`、`capability` 联合、12 条 `definition(...)`；描述内联使用纪律（观察→定位→操作→再观察） |
| 5 | `apps/api/src/application/gateway-actions.ts` | `GatewayActionType` 12 项；`capabilityFor`；`targetMatches` 的 `browser://` 分支；dispatch 分支调 `browserExecute`；风险升级钩子（提交类动作转 ASK） |
| 6 | `apps/api/src/application/run-scope-grant.ts` | `SCOPE_GRANT_ACTIONS` + `BROWSER_ACTION`（**不加** `BROWSER_COMMIT`）；动作→能力映射 |
| 7 | `apps/api/src/application/tool-loop.ts` | `gatewayParamsFor` 12 条白名单转发；`toolTargetFor` 的 `browser://` 目标 |
| 8 | `apps/api/src/application/assistant-readonly-round.ts` | 会话只读能力集合加 `BROWSER_READ`；只读工具名集合加 4 个读工具 |
| 9 | `apps/api/src/browser/*`（新建） | `protocol.ts`（错误码/动作词表）、`config.ts`（Chrome 路径、MCP 入口、mode）、`mcp-client.ts`、`chrome-launcher.ts`、`provider.ts`、`session-manager.ts`、`browser-adapter.ts`、`risk.ts`、`action-labels.ts`、`client-holder.ts` |
| 10 | `apps/api/src/api/browser-api.ts` + `routes.ts` | M2 已做：`GET /browser/status`。M3/M5 再加：`GET /browser/sessions`、`POST /browser/sessions/:id/stop`（复用取消通道） |
| 11 | `apps/desktop/src-tauri/src/lib.rs` | 解析 `browser-mcp/build/src/bin/chrome-devtools-mcp.js`，向 API 与 supervisor 注入 `RELAY_BROWSER_MCP_ENTRY`；`SupervisorSpawnContext` 同步（否则 supervisor 重启后丢失） |
| 12 | `apps/desktop/src-tauri/tauri.conf.json` | `bundle.resources` 增 `"resources/browser-mcp/": "browser-mcp/"` |
| 13 | `apps/desktop/scripts/build-release.ps1` | 新增 staging 与校验：入口文件存在、`package.json.version == 1.11.0`、`LICENSE` 与 `THIRD-PARTY-NOTICES` 存在、无 `.env*`/`*.pem`、构建后产物清单核对 |
| 14 | `scripts/fetch-browser-mcp.mjs`（新建） | 按固定版本 + registry `integrity` 下载并校验，缓存到 `.research/runtime-cache/browser-mcp/1.11.0/`；离线可复用，不做 `@latest` |
| 15 | `apps/workbench/src/api/dtos/gateway.ts` | `RelayGatewayCapability` 补 `COMPUTER_READ`/`COMPUTER_INPUT`/`GITHUB_READ`/`BROWSER_*`（顺带修既有缺口） |
| 16 | `apps/workbench/src/views/ConnectionsView.tsx` | 能力标签表与动作表补新能力（含既有缺口） |
| 17 | `apps/workbench/src/components/BrowserPanel.tsx`（新建） | 开关、健康/诊断、当前任务与目标页、正在执行的动作、暂停/继续/停止、权限入口 |
| 18 | `apps/workbench/src/components/RunToolTrajectoryPanel.tsx` | 浏览器工具的动作文案与分组（轨迹渲染本身已按 `tool_name` 泛化，不需新机制） |

不改：`apps/computer-runtime/**`、`computer/*`、`execution-router.ts`（浏览器不接管 `COMPUTER_*` 路径）。

---

## 6. Windows 打包与运行

| 事项 | 方案 |
|---|---|
| 运行时 | 复用随包 `node.exe v24.21.0`（MCP 要求 `>=23`，满足）；不新增 Node 版本 |
| 后端分发 | `scripts/fetch-browser-mcp.mjs` 固定 `1.11.0` + `integrity` 校验 → 解包到 `src-tauri/resources/browser-mcp/` → Tauri 随包 |
| 版本锁定 | 版本号写死在脚本与 `build-release.ps1` 两处，且以 `package.json.version` 实测比对；升级是显式动作（改常量 + 跑映射自检 + 复跑 T6） |
| Chrome | **不随包**。使用用户已安装的 Chrome（本机 155.0.8059.84）。查找顺序：`RELAY_BROWSER_CHROME_PATH` → 注册表/常见安装路径 → 失败即 `CHROME_MISSING` + 可操作诊断 |
| 许可 | 随包保留 `LICENSE`（Apache-2.0）与 `THIRD-PARTY-NOTICES`（MCP 自带第三方声明）；`UPSTREAM.md` 记固定版本与来源 URL |
| 安装/卸载 | **零系统改动**：不写注册表、不装扩展、不改 PATH、不装服务；卸载即删安装目录（含 `<data-root>/browser/profile`，由用户选择是否保留） |
| 升级 | 随安装包整体升级；不做运行时自更新（已关 `--no-update-checks`） |
| 端口 | 每次启动 `--remote-debugging-port=0`，只监听 loopback；端口不写入任何日志之外的持久位置 |
| 失败诊断 | `BROWSER_BACKEND_MISSING`/`CHROME_MISSING`/`INCOMPATIBLE`/`DISCONNECTED` 四类，各自带一句可执行建议；UI 直接展示 `remediation` |

---

## 7. UI 集成（复用现有设计规范，不新建视觉体系）

- **入口**：`ConnectionsView` 增"浏览器"分区（启用开关 = 建/停用 `BROWSER_*` 连接）；任务页与会话页的右翼面板增只读"浏览器"卡片。
- **状态**：未启用 / 就绪 / Chrome 未安装 / 后端缺失 / 版本不兼容 / 已断开 —— 每态一句诊断 + 一个动作（重试/查看说明）。
- **任务**：Run/会话、目标页标题与 URL、当前动作（"正在点击『提交订单』"）、已用时。
- **控制**：暂停/继续/停止复用既有 Run 控制；会话轮次的停止复用既有"停止本次回答"。
- **权限**：复用既有审批卡（Allow once / 本次任务允许）；`BROWSER_COMMIT` 只出现 Allow once。
- **轨迹**：浏览器工具自动出现在既有工具轨迹与聊天工具调用区（渲染已按 `tool_name` 泛化）。
- **token**：零新增；沿用 `docs/frontend/design-tokens.json`。

---

## 8. 测试计划（对应任务书 10 场景）

| # | 场景 | 验证方式 | 本机可取证 |
|---|---|---|---|
| T1 | Chrome 正常启动与连接 | 真实 Chrome + 真实 MCP；`ensureStarted` 返回 READY 且 `tools/list` 覆盖映射表 | 是 |
| T2 | 未安装 / 版本不兼容 | `RELAY_BROWSER_CHROME_PATH` 指向不存在文件 → `CHROME_MISSING`；伪造 `tools/list` 缺工具 → `INCOMPATIBLE` | 是 |
| T3 | 页面加载超时、元素不存在 | 本地 fixture 页 + 不存在 uid + 慢端点 | 是 |
| T4 | 取消后底层操作确实停止 | 假 MCP 断言收到 `notifications/cancelled`；真实链路在慢导航中取消，断言不再有新动作、结果结算为 UNKNOWN | 部分（真实"底层已停"需 CDP 侧证据） |
| T5 | 用户切到别的标签页时 Agent 不误操作 | 真实 Chrome 开两个页，Agent 只传自有 pageId；断言用户页 URL/内容不变 | 是 |
| T6 | 用户与 Agent 同时操作不同标签页 | 两个 Run 各绑一页交错执行；断言各自结果独立、无串页 | 是（需真实 PG + Worker） |
| T7 | 用户接管页面后 Agent 安全恢复 | 另一 CDP 连接改动 DOM → 旧 uid 失效 → 断言失败为类型化原因且要求重读，不重复点击 | 是 |
| T8 | 浏览器/扩展异常退出后的恢复 | `taskkill chrome.exe` → 断言检测、重建、所有权清空、任务得到明确提示 | 是 |
| T9 | 高风险操作的权限确认 | 集成测试：`browser_submit_form` 在有范围授权时仍 `WAITING_APPROVAL` | 是 |
| T10 | Windows 安装包安装/启动/卸载 | `build-release.ps1 -TestPackage` + 安装/卸载实测 | **受限**：本机装 EDR（深信服）+ Defender，安装态与冷启动需实测；不得以 dev 窗口代替 |

另需回归：`tool-catalog` 词表封闭性、迁移 CHECK 重述（历史动作仍合法）、`assistant-readonly-round` 只读集合、`ConnectionsView` 能力表。

---

## 9. 风险与未决项

| # | 风险/未决 | 影响 | 处置 |
|---|---|---|---|
| R1 | 上游工具名/参数随大版本变化 | 映射断裂 | 启动期 `tools/list` 自检 + 版本写死；升级走显式动作并复跑 T1/T6 |
| R2 | Chrome 自动更新跨大版本 | CDP 行为漂移 | 只声明支持"当前 stable 及以上"；`INCOMPATIBLE` 给可操作诊断 |
| R3 | MCP 崩溃后 Chrome 成孤儿 | 残留进程 | 由 Relay 持有 PID 并主动关闭（选 B 方案的直接收益）；Worker 在 Job 内，宿主退出兜底 |
| R4 | 同 profile = 同 cookie | 页级隔离不是安全隔离 | 文档与 UI 明确；不做"标签组=隔离"的表述；后续可加"每 Run 独立 profile"开关 |
| R5 | 风险分类器是启发式 | 可能漏判 | 三条结构性护栏（§4.5）；不承诺全覆盖 |
| R6 | 大截图 base64 撑爆内存/账本 | 账本污染 | 结果只留摘要；MCP 单行上限 32 MiB；截图正文不落库 |
| R7 | 本机 EDR（深信服）拖慢子进程冷启动 | 首启超时 | 沿用 `DESKTOP_READY_TIMEOUT=180s` 的量级；浏览器后端按需启动，不进桌面就绪路径 |
| R8 | 会话（chat）只能读浏览器 | 与用户预期不符 | **D1 待定**，见下 |
| R9 | 页面所有权只在内存 | API/Worker 重启后丢所有权 | 重启后一律不认领旧页（安全优先）；任务需重新 `new_page`；如用户要求跨重启保留，再评估持久化 |

### 待用户确认的三项（D1–D3）

- **D1 会话内是否允许浏览器动作？** 现状：`ASSISTANT_READ`/`AGENT_SESSION_READ` 只放行只读能力，写动作只能发生在 Run（`COMPUTER_INPUT` 同样如此；会话写执行链是 ADR-022 的未闭合项）。**建议 V1 保持边界**：chat 里可读页面/快照/截图，动作经既有"转执行"入口创建 Run。若要求 chat 直接点击，属于另一项架构变更（新增会话写身份），不应塞进本功能。
- **D2 是否允许"复用用户已登录 Chrome"？** 建议 V1 不做（chrome-use 路径），按 §3.3 的五条理由。若确需，单独走"用户显式同意 + 扩展安装/卸载流程 + 独立权限审查"。
- **D3 每 Run 独立浏览器实例（独立 profile）是否进 V1？** 建议不进：成本是每次任务一个 Chrome 窗口与一份 profile，收益是 cookie 级隔离；V1 用页级隔离 + 明确说明。

---

## 10. 分阶段实施计划（每阶段有明确出口，不跨阶段预建）

| 阶段 | 内容 | 出口（可验证） |
|---|---|---|
| **M1 后端骨架与映射冻结** | 迁移 `0105`、能力/描述符/词表/动作类型、`mcp-client.ts`、`chrome-launcher.ts`、`provider.ts`（仅 `ensureStarted`/`health`/`listPages`/`newPage`/`closePage`/`readPage`）、`session-manager.ts` 骨架 | `tsc` 全绿；假 MCP 单测；真实 Chrome 起停与 `tools/list` 自检通过；`tools/list` 实测结果写回本文 §4.2 映射表 |
| **M2 读工具端到端** | `browser_list_pages`/`read_page`/`screenshot`/`wait_for` 进词表与 Gateway（`BROWSER_READ`）；`GET /browser/status` | 真实 Chrome 上跑通四工具；会话只读轮次可调用；T1/T2/T3 通过 |
| **M3 动作工具与权限** | `BROWSER_ACTION`/`BROWSER_COMMIT`、范围授权接线、风险分类器、`browser_sessions` 状态写入 | T5/T6/T9 通过；历史动作迁移 CHECK 回归通过 |
| **M4 取消、恢复与接管** | `notifications/cancelled`、UNKNOWN/STALE 语义、崩溃重建、所有权清空 | T4/T7/T8 通过 |
| **M5 UI** | `BrowserPanel`、ConnectionsView 能力补齐、轨迹文案 | jsdom + 真实 Chromium（伪造 API）规格；`tsc`/`vite build` 通过 |
| **M6 打包与实机** | `fetch-browser-mcp.mjs`、`build-release.ps1`、`tauri.conf.json`、`lib.rs` 注入 | `-TestPackage` 构建成功；安装/启动/卸载实测（T10）；未通过则如实标未验收 |

停止条件：M6 未完成时，F26 只能记"部分通过（工程自检）"，不得记"已交付"。每个阶段结束更新本页状态行、[测试计划 §36](../testing/verification-plan.md#36-内置浏览器自动化验收规格2026-10-17) 的实际覆盖与[验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)对应行，并保留可回滚的提交边界（一阶段一提交，不把 UI 与打包混进后端提交）。

---

## 11. 明确不做（V1 范围外）

- 不暴露 `evaluate_script` / 任意页面 JS 执行。
- 不做浏览器扩展、不做 native messaging、不改用户 Chrome 配置。
- 不做多浏览器（Edge/Firefox）适配、不做移动端仿真、不做性能 trace/Lighthouse/网络面板工具（上游有，本功能不需要）。
- 不做标签分组隔离、不做每 Run 独立 profile（见 D3）。
- 不接管 `COMPUTER_*` 与 `execution-router` 的 `browser_cdp` 位；页面截图统一用 `browser_screenshot`。
- 不做会话内浏览器写动作（见 D1）。

---

## 12. M1 实施记录（2026-10-17，开发自检）

**已实施（未 commit）**：迁移 `0105`（三个能力 + CHECK 重述）；`GatewayCapability`/`ADAPTER_DESCRIPTORS`/`tool-catalog`（12 个 `browser_*`）/`GatewayActionType`/`capabilityFor`/`targetMatches` 的 `browser://` 分支/`normalizedBrowserTarget`/`SCOPE_GRANT_ACTIONS`（只加 `BROWSER_ACTION`）/`delegate-task` 信封能力/`assistant-readonly-round` 只读词表与目标/`tool-loop` 的参数白名单与目标/`worker/tool-loop-action` 传入 origin；新增 `apps/api/src/browser/`（`protocol`/`config`/`mcp-client`/`chrome-launcher`/`provider`/`snapshot-parse`/`mcp-browser-provider`/`session-manager`/`client-holder`/`browser-adapter`）；新增 `scripts/fetch-browser-mcp.mjs`（固定 `1.11.0` + sha512 校验 + 解包 + LICENSE/版本核对）。

**已运行证据**：

- `apps/api` `tsc --noEmit` 与 `tsc -p tsconfig.json` 均 exit 0。
- 新增浏览器单测 **23/23**（`browser-protocol` 5、`browser-snapshot-parse` 4、`browser-adapter` 7、`browser-mcp-client` 6 之外的其余断言）：覆盖三族能力映射、范围授权只覆盖交互族、目标合成值、`file://` 拒绝、页面所有权、缺省页、并行隔离、STALE 恢复、取消 → UNKNOWN、参数白名单、上传路径越界、按站点收窄、页面被改走后拒绝、MCP 握手/崩溃/取消/超时。
- 真实链路冒烟（真实 Chrome `155.0.8059.40` + 真实后端 `1.11.0`，`output/acceptance-raw/browser-f26-m1-20261017/smoke.log`）：`READY`（26 个上游工具通过自检）→ 建页 → 快照（7 个元素，`inForm` 推导正确）→ 填写 → 错误 uid 得到 `BROWSER_ELEMENT_NOT_FOUND` → 截图 762×484 / 19,789 B / sha256 → 点提交后**拿到的是导航后的新页面**（`/next?q=…`，正文含「已提交」）→ 后退 → `file://` 得到 `BROWSER_NAVIGATION_BLOCKED` → 关闭自有页 → `dispose`。
- `scripts/fetch-browser-mcp.mjs --verify` 通过：缓存包 sha512 与 registry `integrity` 逐字一致，`version=1.11.0`、`license=Apache-2.0`、`LICENSE` 存在。

**实测推翻的三条假设**（已写回 §4.2.1）：`pageId` 是数字且必填；`new_page` 返回列表而非新 id；`navigate_page` 把失败写进正文；另外 `includeSnapshot` 在导航提交前取样。

**M1 未做（按计划留给后续阶段）**：`browser_sessions` 状态表（M3，`0106`）、风险分类器升级（M3）、`GET /browser/status` 等 HTTP 端点（M2）、UI（M5）、随包资源与 `lib.rs` 注入（M6）。**未验收**：真实 Windows 窗口、安装态、多任务并发下的真实 PG 链路、用户接管场景的浏览器实测。

**顺带发现的既有缺口（未修，不在本片范围）**：迁移 `0096` 建的 `computer_control_state` 没有对 `relay_app` 的 `GRANT`，而 `computer-api.ts` 的读取路径依赖它；若应用角色不是表所有者，该端点会在运行期报权限错误。本片的新表（M3）会显式授权，不回改 `0096`。

---

## 13. M2 实施记录（2026-10-17，开发自检）

**已实施（未 commit）**：迁移 `0106`（单行表 `browser_backend_state`）；`browser/state.ts`（写入与读取投影）；`session-manager.ensureWithHealth()`（不抛异常，把失败也作为要带回去的结论）；`browserExecute` 接 `db` 并在每次动作前写健康投影（**写失败不阻断执行**）；`api/browser-api.ts` + `routes.ts` 注册 `GET /workspaces/{id}/browser/status`（`Cache-Control: no-store`）。

**实测修正的第二处设计**（与 §4.2.1 的四条同等重要）：目标合成值**不能**是 `browser://https://example.com` 这种"协议塞进 scheme"的形状——它无法用 URL 语义解释，而且会被自己的目标归一拒绝（集成测试第一次跑就撞上了）。已改为**主机形式** `browser://example.com` / `browser://127.0.0.1:5155`，`browser://` 单独作为「全部站点」前缀（策略创建要求前缀非空，不能用空串表达全量），`browser://unknown` 表示站点未知。`browserTargetForOrigin` 同时做了防御性归一（剥协议与路径），`normalizedBrowserTarget` 拒绝带 `/ ? # @` 的目标。

**已运行证据**：

- `apps/api` `tsc --noEmit` / `tsc -p` exit 0；浏览器单测 **25/25**（新增：来源边界——会话只读只放行 `BROWSER_READ`、交互与提交只属于 RUN；健康投影形状）。
- 真实 PostgreSQL：`browser-read.integration.test.ts` **6/6**（`run-integration.ps1 -TestFile browser-read` 整体 PASSED，临时集群已删除）：BROWSER_READ 全链路（prepare → dispatch → 账本）成功且投影 READY；按站点收窄（前缀内 PREPARED、前缀外被拒）；非法目标形状 `GATEWAY_TARGET_DENIED`；后端不可用 → 派发 `FAILED BROWSER_CHROME_MISSING` 且投影 `CHROME_MISSING`；`BROWSER_ACTION` 在 AUTO 策略下仍降级 `WAITING_APPROVAL`（`approvalPassthrough=false`）；真实 API 进程经 HTTP 读到同一行（`no-store`）。日志：`output/acceptance-raw/browser-f26-m1-20261017/integration-browser-read-3.log`。

**M2 未做（后续阶段）**：`GET /browser/sessions` 与 `POST …/stop`（M3，等 `browser_sessions` 表）、风险分类器升级（M3）、UI（M5）、随包与安装态（M6）。**未验收**：真实 Windows 窗口、安装态、多任务真实 PG 并发、用户接管实测。

---

## 14. 路线变更：扩展桥接（M4a，2026-10-17，开发中）

用户下达新任务书，技术路线改为**用户现有 Chrome + Chrome 扩展桥接 + Agent 专属标签页**（复用登录态、非激活标签页、不抢前台）。取舍与依据归 [ADR-025](../decisions/ADR-025-extension-bridge.md)。本节记录已落地的代码与**尚未打通**的部分，两者不得混淆。

**已实现（未 commit）**：

- `apps/browser-extension/`：Manifest V3 扩展（`background.js` ~470 行）——`chrome.debugger` 按标签页附着 CDP、`chrome.tabs.create({active:false})` 建非激活专属页、标签页所有权登记（session storage）、与 Relay 的本机 WebSocket 客户端（hello 认证 + 指数退避重连）、a11y 快照（与 chrome-devtools-mcp 同构文本格式，Relay 解析器零改动）、click/fill/press_key/navigate/wait_for/screenshot/upload_file/submit_form 全套命令；**代码中不存在** `tabs.update({active:true})` 与 `windows.update({focused:true})`。
- `apps/api/src/browser/websocket.ts`：手写 RFC 6455 服务端（握手、掩码客户端帧、文本/close/ping 帧、单帧上限），不引入 `ws` 依赖。
- `apps/api/src/browser/bridge.ts`：扩展连接注册表（hello 令牌认证、单连接顶替、按命令订阅/退订、超时与断连 → 类型化错误）。
- `apps/api/src/browser/extension-provider.ts`：`BrowserProvider` 的第二个实现（HTTP → API → WS → 扩展），`readBridgeRegistration` 从数据根 `browser/bridge.json` 读取端口与令牌。
- 提供方选择：`RELAY_BROWSER_PROVIDER=extension`（默认）| `cdp`（M1 的自有 Chrome 后端，保留为开发/对照）。
- `GET /api/v1/browser-bridge/commands`（桥接令牌鉴权的独立 scope）+ 主入口的注册与 WS upgrade 挂接。

**未打通（如实）**：端到端冒烟（`.research/tmp/browser-bridge-smoke.mjs`：真实 Chrome + 未打包扩展 + 桥接协议全链路）**在扩展连接一步失败**——30 秒内扩展未连上桥接端口，Chrome stderr 只有 updater/GCM 噪音。已尝试：随包 `config.json` 兜底配置、`--disable-features=DisableLoadExtensionCommandLineSwitch`（Chrome 137 起默认忽略 `--load-extension`）。**尚未定位到根因**，候选：Chrome 155 stable 对该开关的处理、service worker 未启动、EDR 对本机 WebSocket 的拦截。因此 M4a 的全部能力（含所有权闸门、非激活页实测）**都没有真实浏览器证据**，不得当作可用。

**仍然有效的既有证据**：M1–M3 的全部结论（12/12 集成、25/30 单测、真实 Chrome CDP 链路冒烟）针对的是 **cdp 后端**；切到 extension 后端后，`Provider` 接口以上的层（词表/权限/会话管理/端点）不变，但**其行为尚未在 extension 后端上验证过**。

### 14.1 扩展命令层补齐（2026-10-18）

对照工具词表逐条核过扩展实现后，改的是**扩展侧与 Provider 侧**（`apps/browser-extension/background.js`、`src/browser/extension-provider.ts`），词表、权限与端点未变：

| 缺陷 | 受影响的承诺 | 修法 |
|---|---|---|
| `chrome.debugger.onEvent` 监听写成 `(message, sender)` | 每次 `browser_navigate` 都只能等满 30 秒超时，导航"成功"也无法确认 | 改成真实签名 `(source, method, params)`，抽成可取消的 `createLoadWaiter`；`Page.navigate` 返回的 `errorText` 变成 `BROWSER_NAVIGATION_BLOCKED`，同文档导航（无新 `loaderId`）不再空等 |
| 快照只走嵌套 `node.nodes` | 真实 CDP 的 `Accessibility.getFullAXTree` 是**扁平数组 + `childIds`**，实际只能渲染出根节点，`uid` 也就无从指认 | `flattenAx` 先拍平再按 `childIds` 遍历，两种形状都吃；`backendNode` 同样在拍平后的集合里找 `uid` |
| 没有后退/前进/刷新命令 | `browser_navigate` 的 `history` 分支被 Provider 直接拒绝（"暂未支持"） | 新增 `history` 操作：`Page.getNavigationHistory` + `Page.navigateToHistoryEntry` / `Page.reload`；到边界时给 `BROWSER_INVALID_REQUEST`，不猜别的页 |
| 双击参数被忽略 | `browser_click` 的 `double` 被 Provider 拒绝 | 扩展按 clickCount 1→2 连发两组 pressed/released（只改 clickCount 页面收不到 `dblclick`） |
| 截图没有尺寸与摘要 | `browser_screenshot` 承诺"返回尺寸、字节数与可核对摘要"，实际是 `width:null / sha256:'unavailable'` | 扩展从 PNG 字节算 IHDR 宽高与 SHA-256，Provider 消费；扩展没给时如实降级 |

**证据层级**：新增 `apps/api/test/unit/browser-extension-ops.test.ts` **8/8**——在 VM 里跑真实 `background.js`，用假 `chrome`（tabs + debugger + CDP 事件）与假 WebSocket 驱动命令；覆盖导航等待、失败透出、历史边界、双击按键序列、截图摘要、旧 uid 拒绝、所有权闸门。这仍是**协议层与命令层**证据，不等于真实 Chrome 已验证：扩展需要在 Chrome 里手动加载（`chrome://extensions` → 开发者模式 → 加载已解压的扩展程序），本机 Chrome 155 已忽略 `--load-extension`，命令行装载这条路走不通。

### 14.2 真实扩展安装与配对（部分验证）

扩展需要用户手动加载一次，并在 `options.html` 里填入 Relay 本机 API 地址与数据根 `browser/bridge.json` 里的配对令牌（令牌不写入日志、不出现在普通 UI 文案里）。2026-10-18 已用测试专属 Chromium 配置验证实际 MV3 扩展；用户日常 Chrome 的手动安装与登录态复用仍未验收。

### 14.3 桥接与快照修复（2026-10-18）

真实配对先暴露扩展连接 `/api/v1/browser/bridge` 与 API `/api/v1/browser-bridge` 不符、hello 缺少令牌；统一路径并发送令牌后，鉴权及后台建页走通。随后实际页面只返回根节点：CDP 的 `ignored`/`none` 包装节点被直接返回，连有效后代也跳过。现在只省略该节点本身，继续遍历子节点；回归覆盖包装节点下的输入框。此问题不能仅靠平铺 AX 夹具发现，须保留真实扩展页面检查。

Provider 对已派发后的网络断开、取消、超时及响应截断使用类型化错误并保留效果不确定性；变更动作进入 UNKNOWN/STALE，阻止盲重放，重新读取后才恢复。发送前取消不派发；HTTP 等待有界。接口与权限范围未改变，Breaking Change：No。测试结果与未验范围归统一验收表。

日常有界面 Chrome 实测发现后台页文本插入成功但鼠标点击未到页面；在自有页点击前启用 `Emulation.setFocusEmulationEnabled`，不调用标签页激活或窗口聚焦，实机点击与已有页激活状态保持均通过。页面焦点模拟只影响自有文档。另在空闲后复现 MV3 worker 断线：已认证的 API WebSocket 每 20 秒发送可忽略的文本 `keepalive` 帧，关闭或连接被替换时清理计时器；不依赖扩展页定时器。依据 [Chrome MV3 WebSocket 生命周期说明](https://developer.chrome.com/docs/extensions/how-to/web-platform/websockets)，需实际消息交换延长 30 秒活动窗口。保活空闲实机结果归统一验收表，不以接口存在推定通过。

同文档 hash/SPA 历史导航不会触发 `Page.loadEventFired`；历史条目等待同时接受 `Page.navigatedWithinDocument`，普通刷新仍等待完整加载。跳转命令抛错时撤销等待器，避免留下事件监听。该缺陷由实际扩展的同文档后退/前进场景复现并验证，不能以跨文档导航结果替代。

### 14.4 空闲保活兜底：`chrome.alarms`（2026-10-18）

§14.3 的「服务端每 20 秒发一帧 `keepalive`」解决的是**连接存在时**的 worker 生命周期：MV3 的 30 秒空闲计时靠真实消息交换重置。它管不到另一种情形——**连接已经断了，而 worker 也被回收**。此时 `onclose` 里的退避重连连同定时器一起消失（定时器属于被终止的 worker），扩展不会自己醒来；原代码顶部注释写的「service worker 被 Chrome 回收后由 WS 重连唤醒」不成立，是一次把「浏览器启动」当成「worker 重启」的误读：`chrome.runtime.onStartup` 只在浏览器启动时触发，不覆盖 worker 被回收后的重启。

**改法**：`manifest.json` 增加 `alarms` 权限；`background.js` 注册 30 秒周期闹钟 `relay.keepalive`（Chrome 120+ 的最小粒度，更早版本由浏览器钳到 1 分钟），`onAlarm` 里调用 `reconnectIfDown()`——socket 为空或已关闭才重连，`OPEN`/`CONNECTING` 一律不动，避免握手期间被闹钟插出第二条连接。`onStartup` 与 `onInstalled` 也各补一次 `ensureKeepalive()` + `reconnectIfDown()`。闹钟只负责**唤醒**，不承担心跳语义：连接是否健康仍由 WS 的 open/close 判定，服务端 20 秒帧仍是主保活。

**证据层级**：`browser-extension-ops.test.ts` 追加 4 例（manifest 权限、周期闹钟与回调注册、连接断开后由闹钟在退避计时器之前重建连接、连接正常时闹钟不重建），VM 里跑真实 `background.js` + 假 `chrome.alarms`。这仍不是真实 Chrome 的空闲实测：真实空闲保活要用户在日常 Chrome 里装好扩展后观察，成绩归统一验收表。

### 14.5 两处「静默失效」的修复（2026-10-18）

| 缺陷 | 受影响的承诺 | 修法 |
|---|---|---|
| Provider 先 `slice(0, MAX_PAGES)`，适配层再判 `pages.length > MAX_PAGES` | `browser_list_pages` 承诺「页面很多时会截断并显式标记」，但 Provider 截完长度永远等于上限，`truncated` 字段**不可能**出现——真实 Chrome 开 40 个标签页时，模型拿到 32 条且不知道还有 8 条 | 截断只保留在适配层一处：`mcp-browser-provider` 与 `extension-provider` 都返回完整列表，适配层按 `MAX_PAGES` 收窄并置 `truncated`；`count` 保留真实总数。`MAX_PAGES` 从 Provider 的「输出上限」改为「回显上限」 |
| `browser_read_page` 承诺「URL、标题、**加载状态**」，但快照结果里没有这个字段 | 只读快照正文分不出「页面就这些内容」和「内容还没渲染出来」，模型只能靠固定 sleep 或重复读 | 扩展新增 `readyStateOf()`（CDP `Runtime.evaluate('document.readyState')`，取不到给 `null` 不猜 `complete`），`read_page` 与所有动作后的快照都带 `readyState`；`BrowserSnapshot` 增加必填 `readyState`（MCP 后端如实给 `null`），适配层输出 `ready_state` |
| `registration()` 把 `null` 也缓存进 `cachedRegistration` | 桥接文件由 API 启动时写入，Provider 可能先被构造。一旦那一刻文件还没落盘，`null` 就被永久固化：此后 `ensureStarted` 恒为 `BACKEND_MISSING`，只能重启进程才恢复。`dispose()` 也不清缓存，API 换端口后仍打旧端口 | 只缓存成功结果；`dispose()` 清空缓存。新增用例：先在无 `bridge.json` 的临时数据根上探测（应为 `BACKEND_MISSING`），写入后再探测必须变 `READY` |

**证据**：`browser-adapter.test.ts` 新增「40 个页面 → 32 条 + `truncated: true` + `count: 41`」与「读页面结果带 `ready_state`」两例；`browser-extension-bridge.test.ts` 新增注册缓存一例；`browser-extension-ops.test.ts` 新增「`read_page` 走 `Runtime.evaluate` 取 `document.readyState`」一例。四套件合计 **35/35**。仍属开发自检：真实 Chrome 多标签页未实测（用户日常 Chrome 尚未装载扩展），成绩归统一验收表。

### 14.6 桌面端临时端口与桥接文件（2026-10-18，真实扩展复验暴露）

桌面模式给 API 的请求端口是 **0**（`config.ts`：`options.desktop ? 0 : 1024`，取临时端口避免与开发服务器抢端口）。但 `ensureBridgeRegistration` 在 **listen 之前**执行，写进 `bridge.json` 的就是这个请求值 0。后果分两层：

1. **API→扩展的命令路径直接不可用**：Worker 里的 `ExtensionBridgeProvider` 读 `bridge.json` 的 `port` 去 POST `/api/v1/browser-bridge/commands`，`http://127.0.0.1:0` 永远失败，所有 `browser_*` 动作都会落到 `BROWSER_BACKEND_DISCONNECTED`，而扩展本身可能连得好好的。本机实测：`<repo>/.relay-test/data/browser/bridge.json` 与 `%APPDATA%/dev.relay.agent/data/browser/bridge.json` 都写着 `"port": 0`。
2. **扩展侧的配对地址随每次启动失效**：扩展只认 `chrome.storage.local` 里的 `serverUrl`（它读不到文件系统），而桌面端端口每次启动都变。本机实测扩展里存的是 `http://127.0.0.1:4672`——上一次运行的临时端口，重启后没有任何进程在听。

**本轮修了第 1 层**：`listen` 之后用实际绑定端口重写 `bridge.json`（`syncBridgePort`，沿用原令牌——换令牌会把已连上的扩展判成非法），`api_listening` 日志也改成报实际端口。单测覆盖「写实际端口 + 令牌不变 + 端口未变不重写」。

**第 2 层（2026-10-18 用户选定）**：桌面模式改用**固定端口 43117**（`DESKTOP_DEFAULT_API_PORT`），被占用时回退临时端口（`main.ts` 捕获 `EADDRINUSE` 后以 0 重试，桥接文件随后写实际端口）。桌面宿主的环境模板抽成 `desktopChildEnvironment`，因此「端口是固定值」可被单测锁定。代价写在明处：固定端口可能被别的程序占，占不到就退回临时端口，此时扩展需重新配对；ADR-025 的「单端口 + 手动配对」前提不变，只是端口从「每次随机」变成「默认稳定」。

**配对操作（一次即可）**：扩展选项页填 `http://127.0.0.1:43117` 与数据根 `browser/bridge.json` 里的令牌。开发态若用 `apps/api/.env` 的 8787，则填 8787。
