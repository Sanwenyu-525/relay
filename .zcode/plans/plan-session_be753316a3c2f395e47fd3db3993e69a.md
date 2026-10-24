# 工具面板后端：人工侧受管目录浏览与文件读取（LIST_DIRECTORY + READ_FILE）

## 范围结论（用户未答问，按推荐口径）

工具面板六页签中，**真正缺后端的是「文件」页签**：现在只能列受管目录登记项，面板文案明示"目录浏览接口尚未接入（待接入）"。本轮放行人工只读的 **LIST_DIRECTORY（目录浏览）+ READ_FILE（文件正文读取）**，完全复用 Agent 侧已有的适配器、权限与账本机制。终端按设计文档维持"待设计"占位（协议未定：执行身份、生命周期、审计、排他、断连恢复）；FIND_PATHS/SEARCH_TEXT 与 Git 写入不做（后续按需，服务端增量小）；前端接线按 AGENTS 惯例以可直接执行的前端提示词交付，本轮不实施。

## 已核对的事实基础

- Agent 侧 FILE_QUERY/FILE_READ 完备：`files/file-query.ts`（有界一层枚举，limit/truncated 显式）、`fileReadExecute`（128 KiB 上限、二进制/超大/替换链接类型化失败、sha256）、AUTO 穿透策略、`SAFE_REREAD_CAPABILITIES` 已含 FILE_READ/FILE_QUERY 且 reconcile 接受 USER_ACTION 来源。
- 人工侧先例 `git-user-action.ts` + `git-user-action-api.ts`：prepareGatewayAction（USER_ACTION origin + HUMAN 审计同事务）→ ASK 停 WAITING_APPROVAL → AUTO dispatch → 有界投影；命令回执两段式幂等。
- 阻挡点两处：`originAllows` 的 USER_ACTION 分支只放行 GIT_READ 词表（gateway-actions.ts:198/:276）；DB CHECK `ck_logical_operation_resource` 同样只放行 GIT_READ×USER_ACTION（0058 起，每条 origin 迁移镜像重写）。
- 刷新语义关键差异：git 人工读取的 Operation ID 仅按参数确定性导出（同参数永远返回同一次落库结果，无法刷新）。目录浏览不能沿用——否则目录树展开一次即冻结。

## 实施步骤

1. **迁移 `0134_user_action_file_read.sql`**（写入 apps/api/migrations 与 apps/desktop/src-tauri/resources/api/migrations 两处真实镜像；target/ 为构建产物不碰）：只放宽 `ck_logical_operation_resource`，追加 `(capability_key IN ('FILE_READ','FILE_QUERY') AND origin='USER_ACTION' AND resource_id IS NOT NULL)` 一支；无新表/列/回填，回滚＝恢复原约束，兼容既有行。头注释按惯例引用 tool-adapters.md 契约出处。开工前重新核对 git status（并行会话 0132/0133 在途，编号顺延为 0134）。
2. **词表放宽**（gateway-actions.ts）：`USER_ACTION_ALLOWED_ACTIONS` 增 LIST_DIRECTORY、READ_FILE；`originAllows` USER_ACTION 分支改为按 capability×action 精确放行（FILE_QUERY×LIST_DIRECTORY、FILE_READ×READ_FILE，git 两项不变）；`originDenialDetail` 文案同步。
3. **应用模块 `application/file-user-action.ts`**（结构仿 git-user-action.ts）：参数规范化（relative_path/path 不接受绝对路径与 `..`；limit 只管投影不进冻结参数）；**Operation ID＝参数＋command_id 的确定性摘要**——同一命令崩溃重投收敛到同一次读取不二次执行，新命令（每次点击）产生新鲜读取事实，与 git 的差异及理由写入模块注释；prepareGatewayAction 携新审计事件 `MANAGED_FILE_READ_REQUESTED`；ASK/DENY/UNKNOWN 分支、并发 unique violation 收敛、维护准入门、命令回执幂等全部同 git 语义。
4. **API `api/file-user-action-api.ts`**：`POST /projects/:project_id/managed-resources/:resource_id/file-read`，body `{command_id, connection_id, action_type: LIST_DIRECTORY|READ_FILE, path?, limit?}`；响应三形态（settled 有界结果／pending 无结果字段冒充），命令信封＋`Command-Replayed`；在 routes.ts 按 git 同款注册。
5. **权限**：不新开闸门——FILE_QUERY/FILE_READ 连接 root_path 匹配受管根（targetMatches）＋PermissionPolicy AUTO/ASK/DENY，全部由 prepareGatewayAction 既有路径裁决。
6. **测试**：新建 `apps/api/test/integration/file-user-action.integration.test.ts`（真实临时 PG，仿 git-user-action 套件）：AUTO 列目录/读文件、截断显式、越界路径拒绝、目录不存在/非目录、二进制/超大类型化失败、幂等重放＋换内容拒绝、ASK 等待不含结果字段、DENY、根变化 409、HTTP 契约＋重放头、确定性（同命令重投不二次执行、新命令新事实）；更新 originAllows 相关单测；git-user-action 套件回归（词表改动影响面）。
7. **文档**：tool-adapters.md 新增人工 FILE_READ/FILE_QUERY 入口段；http-command-contract 新 §（端点/DTO/幂等/错误码）；physical-design-postgresql 新 §（0134）；workbench-design §50.5 及文件页相关行（服务端接口已具备、前端接入待做）；verification-plan 目标验收；统一验收表新行；CODEX_NEXT_STEP 当前阶段段。
8. **前端提示词 `prompts/devtools-file-browse-frontend.md`**：已实现接口与 DTO、连接选择（复用 `getGatewayConnections` 过滤 FILE_QUERY/FILE_READ，仿 GitReadPanel）、树形懒展开与刷新语义（新命令＝新事实）、ASK/pending/回执核对复用既有模式、截断与类型化失败呈现、测试要求与未验边界。

## 验证与保护

- `pnpm --dir apps/api typecheck`；新集成套件＋git-user-action 回归＋词表单测（真实临时 PG）；`node scripts/check-docs.mjs`。
- 并行工作保护：不触碰消息撤回（0132 系）与禅道批次文件；共享文件（gateway-actions.ts、routes.ts、验收表）只做定点段落编辑，编辑前查 diff。
- 明确不做：交互终端、FIND_PATHS/SEARCH_TEXT、Git 写入、任意路径读取（不越过受管根与连接 root）、前端实施。

## 交付说明口径

完成后按 AGENTS 汇报：改了什么、实际验证（区分真实 PG 集成与单测）、文档同步、剩余限制（前端未接线、独立验收未做）。