# 工具面板「文件」页签前端接入：受管目录浏览与文件读取

日期：2026-10-24。工作区：D:/Develop/Relay-Agent。
状态：**已于同日执行完成**（`FileBrowsePanel` 接入文件页签；`managedFileBrowse` 8/8＋受影响回归全绿，实施记录归[工作台 §50.6](../docs/frontend/workbench-design.md)与统一验收表）。本文保留为当时的执行规格与依据，不重复执行。

## 1. 可直接复制的启动提示词

> 请在 D:/Develop/Relay-Agent 执行 prompts/devtools-file-browse-frontend.md，把右侧工具面板「文件」页签接到已实现的人工目录浏览与文件读取后端。先核对现有源码与未提交改动（工作树有并行会话在途），只改 apps/workbench 及其测试，不动 apps/api、迁移与任何服务端契约。复用 GitReadPanel 的连接选择、命令回执与待核对模式；按 §3 的交互与三态要求实现；补组件测试并跑定向回归与 `tsc --noEmit`；文档只更新 workbench-design 受影响行。不得把截断列表当完整证据，不得把读取失败显示为空目录，无连接/无策略时如实给出配置指引而不是伪造数据。

## 2. 已实现的后端事实（契约出处：HTTP §10.112）

- **端点**：`POST /workspaces/{workspace_id}/projects/{project_id}/managed-resources/{resource_id}/file-read`，请求体 `{command_id, connection_id, action_type: 'LIST_DIRECTORY' | 'READ_FILE', path?, limit?}`，响应命令信封（`outcome.replayed`、头 `Command-Replayed: true`）。
- **LIST_DIRECTORY**（FILE_QUERY 能力）：浏览 `path`（受管根内相对路径，缺省＝根本身）**一层**条目；`limit` 1..200（默认 200）在服务端适配器内生效。成功投影 `{directory, entries:[{path,kind:'directory'|'file'|'other',size}], count, limit, truncated, skipped, ...}`——`truncated:true` 表示还有条目未返回，`skipped` 是受保护/构建产物目录被跳过的数量。受保护路径（`.git`/`.env`/`node_modules`/`.relay`/`data` 等）与构建产物目录（`dist`/`build`/`out`/`coverage`/`target` 等）不出现在 entries 里，属预期。
- **READ_FILE**（FILE_READ 能力）：读取 `path` 全文（≤128 KiB）。成功投影 `{target, size, sha256, truncated, content, ...}`。二进制（含 NUL 字节）→ 失败投影 `reason:'FILE_BINARY_UNSUPPORTED'`；超 128 KiB → `reason:'FILE_TOO_LARGE'`（带 `size`）；失败投影统一是 `{reason, detail?}`，**绝无 entries/content 字段**。
- **三形态**：`state:'SUCCEEDED'|'FAILED'`（settled，带 `result`）或 `state:'WAITING_APPROVAL'|'UNRESOLVED'`（pending，**只有 reason**，无任何结果字段）。pending 形态不得渲染成空目录或空文件。
- **幂等与刷新**：每次用户点击生成**新 command_id**（新命令＝新的读取事实，这就是刷新语义）；同一 command_id 重放返回原回执；传输失败/5xx 按 `needsReceiptCheck` 口径保留原命令可重试或查回执——复用工作台既有 PendingCommand 模式，与 GitReadPanel 同一套。
- **错误码**（problem details）：`VALIDATION_FAILED`（422：READ_FILE 缺 path/带 limit、绝对路径、`..` 段）；`GATEWAY_TARGET_DENIED`（409：路径不存在/非目录/非普通文件/受保护路径）；`GATEWAY_CONNECTION_DENIED`（409：连接缺对应能力或不存在）；`GATEWAY_PERMISSION_DENIED`（409：策略 DENY 或缺该动作的策略——注意 LIST_DIRECTORY 与 READ_FILE 是**两条独立策略**，只配其一时另一个 409 是正确的失败关闭）；`RESOURCE_OCCUPIED`（409，可重试：目录正被在途写入占用）；`GATEWAY_ORIGIN_DENIED`（409：动作不在人工词表）。
- **权限前提**：会话需已关联 Project 且该 Project 有 ACTIVE 受管资源；连接需具备 FILE_QUERY / FILE_READ 能力且 root_path 匹配受管根。连接与策略在 `/connections`（项目连接页）配置。

## 3. 前端接入范围（apps/workbench）

1. **API client**：`src/api/relayClient.ts` 加 `readManagedFileState(input)`（建议）与 DTO 类型（`RelayManagedFileReadInput/Outcome`），形状对齐 §2；注册到 `api/file-user-action-api.ts` 的响应 schema（settled/pending 联合）。client 方法生成新 `command_id`（`createCommandId()` 同款）。
2. **连接选择**：复用 `GitReadPanel` 的加载模式（`client.getGatewayConnections(projectId)`，按 capability 过滤出 FILE_QUERY 与 FILE_READ 连接；无连接时给出「先在项目连接页配置 FILE_QUERY / FILE_READ 连接与策略」指引，不可用但不伪造）。LIST_DIRECTORY 与 READ_FILE 可能对应**不同连接**，按动作各自选择/回退。
3. **文件页签 UI**（`DevToolsPanel.tsx` FILES 分支替换「目录浏览接口尚未接入」占位）：
   - 受管目录列表（既有 `getManagedResources`）下新增树形浏览：选资源 → 根级 LIST_DIRECTORY；`kind:'directory'` 的条目可展开（懒加载子目录，再次 LIST_DIRECTORY）与收起；`kind:'file'` 条目可点开 → READ_FILE 预览。
   - 刷新＝当前目录重新 LIST_DIRECTORY（新 command_id）；不自动轮询。
   - 三态硬性要求：`truncated:true` 必须可见（「已截断，仅前 N 项」）；失败投影按 `reason` 类型化呈现（对照 §2 码表），**不得显示为空目录**；pending（ASK 等待确认）复用 GitReadPanel 的 review 链接与「核对原命令回执」出口。
   - 文件预览：正文只读展示（`content`，UTF-8 文本；128 KiB 内全文）；二进制/超大给类型化提示不渲染正文；显示 `size` 与 `sha256` 摘要。
   - 保留既有事实口径：「工作目录文件是受管目录下的普通文件，与任务产物版本不同源」的说明不删。
4. **测试**：`tests/` 新增 spec（jsdom＋可控 fetch，参照 `gitReadPanel.spec.tsx` 的回执/重放夹具）：一层浏览与展开、截断显式、路径失败三态、READ_FILE 成功/二进制/超大、缺连接指引、ASK pending 无结果字段、原命令重试；`DevToolsPanel` 现有 5 例中涉及占位文案的断言同步更新。

## 4. 验证要求

- `pnpm --dir apps/workbench typecheck`；新增 spec＋`devToolsPanel`/`gitReadPanel` 定向回归全绿。
- `node scripts/check-docs.mjs`；workbench-design §50.6 的「前端接线未做」表述在完成后更新为已实施（含测试成绩），验收结果归统一验收表。
- 不改 `apps/api`、迁移、契约文档；发现后端缺陷先停下报告，不代改服务端。

## 5. 未验边界与明确不做

- 真实 Windows/WebView2、大目录性能、真实 ASK 审批路径未在本文范围；交互终端维持搁置（协议未设计）；FIND_PATHS/SEARCH_TEXT 服务端未开放，前端不得提供搜索入口。
- 后端未验边界沿验收表「工具面板『文件』页签后端」行（独立验收未做、junction/替换窗口沿 FILE_READ/FILE_QUERY 既有限制）。
