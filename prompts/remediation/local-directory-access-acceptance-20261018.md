# 本地目录免配置：独立验收后的四项整改

日期：2026-10-18。执行模型：**`gpt-6-luna`（GPT-6 Luna）**。由本会话新派子代理执行，**不再向原 Codex 会话发消息**。本任务是实际修复与验证，不是再做一轮泛化审查。

## 1. 范围与责任

工作区 `D:/Develop/Relay-Agent`，共享工作树中有大量在途浏览器/输入器改动。你不是唯一执行者，修改前重读 status 与目标 diff，不回退他人代码，不整仓 stash/reset/clean，不派下级子代理，不 commit/push。

你负责：

- `apps/api/src/application/local-directory-access.ts`；必要时在 `gateway-repository.ts` 及对应接口/测试中添加有当前调用方的最小历史判定或查询。
- `apps/workbench/src/components/WritePermissionControl.tsx`、`FolderScope.tsx` 与实际同一目录选择入口中的最小告知接线；保留其他 Agent 添加的状态回调、布局及菜单行为。
- 正式回归：`apps/api/test/integration/local-directory-access-review.integration.test.ts`、已有 `local-directory-access`/`agent-file-crud-readiness-review`/`folder-first-conversation`；`apps/workbench/tests/writePermissionTier.spec.tsx`、`localDirectorySelectionNotice.spec.tsx`。
- 相关 API/架构/数据库说明按实际改变定点同步，结果只更新统一验收表、阶段只更新 CODEX_NEXT_STEP。

协调者负责最终独立复核与集成结论。不要重写已通的目录配置、主消息/Run 链、CRUD、浏览器或全站样式。`AssistView.tsx` 正在被其他 Agent 修改，默认不编辑；确实影响本任务验证时先报告具体缺口，不能回退新布局/状态工作。

## 2. 已验事实与不可改变的产品规则

先读当前 `CODEX_NEXT_STEP.md`、统一验收表最新独立验收行，然后按需读 `prompts/local-directory-access.md`、工作台 §18.1.4、领域模型 §12.2.1、HTTP §10.86、恢复/审批契约及 LA-01–12。旧任务书若仍写“简化待确认”不再适用。

当前实现已包括 `0109`、默认读配置、SetLocalDirectoryWriteTier、按根匹配及 DELETE 拒绝结算。协调者重新构建并运行真实临时 PG 的 `local-directory-access` 2 项、`agent-file-crud-readiness-review` 1 项、`folder-first-conversation` 17 项，**20/20 通过**，其中包括生产 Worker/图与受控模型驱动的实际 CREATE/MODIFY、DELETE 批准与拒绝、原消息关联。109 项迁移/Graph/PG 启停通过，临时集群已清理。该证据不等于真实 Provider 或 Windows 通过。

保留：选目录默认基础读取，写档位三选一，用户无需建连接/策略；原 Gateway/Run、确切动作确认、基线与 UNKNOWN 不变。模型输出不能授权，GET/恢复旧会话不能创建权限，旧拒绝/撤销/停用不能通过新 ID 绕过。

## 3. D1：旧读取权限被默认配置重新开放（P1）

正式真实 PG 反例：`local-directory-access-review.integration.test.ts` 的 `first directory setup does not replace a manually revoked read policy with AUTO`。

复现：已有受管根、ACTIVE FILE_QUERY/FILE_READ 连接、READ_FILE AUTO 策略；用户通过原命令撤销该策略。目录尚无 local_directory_access 元数据时，主动打开同一目录，当前 `ensureLocalDirectoryReadAccess` 只看活动策略，创建一条新的 AUTO，断言得到 **1，预期 0**。

修复要求：在补默认基础配置前保留并核对相关范围/能力/动作的撤销历史。没有后续明确重新授权时不能用新策略 ID 恢复读取；给原目录入口可理解的限制原因，不重新要求逐动作手工配置。保留合法的更新授权与其他无关目录，不把任意历史撤销永久变成全局拒绝。覆盖同根旧手工设置、上层范围与已应用管理来源的相关路径；不要删除历史策略、默认全部授权或新增第二套权限状态。

## 4. D2：回执重放错误依赖当前磁盘（P2）

同一正式 PG 套件的 `a committed directory tier command replays after its directory has disappeared` 已失败：设置 ASK 成功后删除自有空目录，原 ID/载荷重放返回 `INVALID_TRANSITION`，原因是 `validateRoot` 在读取原幂等回执前执行。

修复要求：历史命令回执应按原命令身份/载荷重放，不要求原目录仍存在。首次调用仍在事务外核对路径与 Windows 身份，提交时重查事实；不能把原生 I/O 塞进长事务，也不能简单返回任何同 ID 回执而绕过 payload hash/目标/命令类型校验。复用现有 OpenWorkingDirectory/受管根命令的正确模式，并补同 ID 改载荷仍拒绝、重放零新增配置/revision 的断言。

## 5. D3：前端重试改变原请求载荷（P2）

`writePermissionTier.spec.tsx` 新增正式反例「丢响应后重读到新 revision，原命令重试仍保留首次提交的完整载荷」已失败：首次发 `expectedRevision=7`，丢响应后重新核对读到 8，再点击原命令重试，同一 command_id 被发为 revision 8。

修复要求：pending 命令在首次发送前冻结完整请求（project/resource、档位、expected_revision、command_id），查询回执或重试都使用同一份。投影更新只改变显示事实，不改原请求；确定的 409/拒绝后重新决策才可新建命令。换目录/客户端时旧请求不能提交到新作用域；成功提示区分历史回执与当前实际档位。不要通过禁止重新核对、换新 ID 或删除失败断言回避。

## 6. D4：目录选择告知与实际权限相反（P2）

`tests/localDirectorySelectionNotice.spec.tsx` 已失败。首次选择前当前文本仍是「不会自动读取整棵树、外发内容或开启任何权限」，没有说明新目录默认只读；实际上打开目录会建立读取连接与 AUTO 策略。

按已确认产品规则，在实际目录选择入口使用简短说明：新目录可读取本目录文件、默认只读；已配置目录恢复原档位。保留“不扫描整棵树、不自动外发内容”的准确限制，删除“不开启任何权限”的错误承诺。不要新增表单/二次授权确认页或让用户回高级设置；原生取消、无目录讨论及草稿保护不变。检查首次/会话内目录入口是否共用实际告知，不为测试单独造一个用户看不到的说明。

## 7. 验证、当前环境与停点

原始独立输出位于 `output/acceptance-raw/local-directory-access-review-20261018/`：`existing-pg.log`、`recovery-red.log`、`ui-payload-red.log`、`ui-notice-red.log`。复跑正式反例先确认 RED，然后逐项转绿。若已被并行修好，核对当前代码并记录，不重复实现。

必要检查：

1. 真实临时 PG：新增两反例全部通过，并补 D1/D2 相关最小反例，复跑 `local-directory-access`、根匹配及普通聊天 CRUD 套件。使用现有 `apps/api/scripts/run-integration.ps1` 串行执行并正常清理。
2. 组件：权限载荷冻结、目录告知与原权限/会话回归。两端 typecheck 和必要构建，修复代码导致的失败不能以“并行问题”笼统排除。
3. 尽可能接续 LA-12 的真实 API/Worker＋浏览器零预置权限路径，至少默认读→切档→一次实际编辑→原会话回读；受控模型和真实 Provider 分开。已有模型 16K/65K 预算失败及 192K/120s 超时不算 Provider 通过，不再为本四项反复放大预算；先完成确定性修复。
4. 真实 Windows/安装态、当前用户活动桌面的重启不自动执行。此前电脑操作被物理 Escape 停止，本提示词不恢复接管。核对 staging 与实际加载副本，不能以资源复制或 hash 相等宣称活动窗口已更新。

注意：协调者第一次 Workbench 大组件复跑在其他 Agent 正编辑 `AssistView.tsx` 时遇到 firstWriteTier/sessionWriteTier 未定义，声明随后出现。这是受运行时点限定的共享文件漂移，不是已证实的本四项根因。保留实际失败日志，待源码稳定定向再验，不回退他人状态回调，不修改断言掩盖页面错误。

协调者在声明补齐后的末次定向复跑 `folderFirstConversation.spec.ts` **20/20、exit0**，记录在 `folder-final-isolated.log`。因此当前不派发 AssistView 未定义变量的修复，保留该文件并行工作；D3/D4 的独立失败仍需整改。

测试日志放本机忽略输出目录，不新建长篇验收报告或导出全仓 SHA。只清理自有临时资源；未经证明无关的进程/数据库不得终止。若新增/修改 schema/API，先给出必要性、兼容、migration 与 Breaking Change Yes/No；本四项优先不新增 schema。

最终用中文报告每个 D1–D4 的根因、修复文件、RED→GREEN、相关回归、文档同步与剩余真实环境限制。更新统一验收表的当前状态，保留先前正常路径证据；自检不要标成独立验收。交付后由协调者复核。
