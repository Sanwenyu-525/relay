# 普通 Agent 文件新建、修改、删除真实闭环整改

日期：2026-10-17。执行者：**GPT-6 Luna（`gpt-6-luna`）**。状态：**已执行两处工程修复，协调独立验收要求整改；完整出口未闭合**。实际成绩只归统一验收表，不以本任务书维护第二份结果。

**同日新授权接续**：用户已确认本地文件不应手工配置连接/策略，当前执行入口改为[本地目录免手工配置与 CRUD 接续](../local-directory-access.md)。本文原 CRUD 正确性与恢复要求继续适用，第 8 节“不实施入口简化”的旧范围限制由新任务书替代；本文件不再作为当前产品范围的唯一输入。

用户反馈：「现在能识别目录了但是还不能写文件，估计删改功能也没有通」。目录识别是用户已观察到的进展；写入不可用是待复现问题，修改和删除尚属用户怀疑，不能直接写成已确认根因。

本任务是实际开发与修复，包含自动化回归、真实文件验证及当前桌面运行产物同步；不能只审查、只列计划或只改模型措辞。由当前 Luna 单独执行，不派子代理、不切换模型、不 commit/push。执行者的自检不冒充独立验收。

## 1. 目标、范围与成功条件

工作区：`D:/Develop/Relay-Agent`。沿用普通 Agent 已实现的目录绑定与连续工具主流程，补通：

`原用户消息 → 主流程执行候选 → 原请求准备/应用/委托 → Task/Run → Gateway/必要 Review → apply_changeset → 真实磁盘 → 原会话结果`

必须逐项证实：

1. **新建**：在绑定目录内创建指定 UTF-8 文本文件，路径和字节内容正确，重放不重复执行。
2. **修改**：读取真实文件取得基线，仅在基线未变时修改；用户同期改动不能被覆盖。
3. **删除**：读取基线，经既有确切动作确认后删除；确认前文件存在，拒绝后不删除，重放不再次执行。
4. **反馈**：原会话能看到真实等待、成功、失败及成果依据；模型说完成不能代替落盘事实，也不能自动完成业务 Task。
5. **可用入口**：从普通聊天发送请求即可进入已有执行机制；权限或信息缺失时明确指出阻塞项。不能依靠测试脚本预先建立 Task/Run 才显得可用。

不扩展到目录递归删除、移动/重命名、二进制编辑、任意 Shell、Git 提交/推送、浏览器自动化、免费模型额度、Skill 重构或全站 UI 改版。已有相关能力回归保留。

## 2. 开工前按范围核对事实

先读 `AGENTS.md`、`CODEX_NEXT_STEP.md` 与统一验收表中的「Agent 入口统一与目录读取」「普通 Agent 连续工具主流程」「读写主链与写能力开关」「对话输入器本目录写入档位」相关行。然后按需读取：

- `docs/frontend/workbench-design.md` §18.1.3、§18.10：目录权限档位、普通 Agent 交互与直接执行规则。
- `docs/architecture/domain-model.md` §12.6、`docs/architecture/runtime-context.md` §2.7、`docs/decisions/ADR-022-agent-conversation-main-loop.md`（若路径有变化，用 `rg --files` 查当前文件）：主流程与 Run 的责任。
- `docs/testing/verification-plan.md` §17.2、§20.4 相关规格；契约包 01–04 中本次涉及的不变量。
- `prompts/agent-conversation-main-loop-refactor.md`：只作已确认目标与历史实施导航，不能重启已完成阶段。

先检查 `git status --short` 和准备修改文件的 `git diff`。本任务交付时工作树存在浏览器与前端等并行改动，实施时必须重新检查；不能整仓 stash/reset/clean，也不能回退、覆盖或顺手修理其他任务。

2026-10-17 编制任务书时已只读核对的源码事实，执行时仍以最新代码为准：

| 已有入口 | 本次重点 |
|---|---|
| `apps/api/src/workflow/tool-catalog.ts` | `apply_changeset` 已声明 CREATE/MODIFY/DELETE；不要再造 `write_file` 或删除工具绕过它 |
| `apps/api/src/application/assistant-readonly-round.ts` | 会话工具明确只读；不能直接往这个身份塞写工具放宽权限 |
| `apps/api/src/application/assist-runner.ts`、`workflow/prompts/conversation-prompts.ts` | 主流程原消息如何得到执行候选；真实下发工具、模板与输出解析是否一致 |
| `apps/api/src/application/conversation-execution.ts` | 候选已有 `writes_files`/`file_changes`；`planToolLoop` 按写意图加入 FILE_WRITE、`apply_changeset`、`read_change_set`；核对候选、auto_start、原消息与目录身份 |
| `apps/workbench/src/views/AssistView.tsx` | 已有候选读取、`applyConversationExecution` 与 autoStart 逻辑，不能假定自动接线完全不存在；查首条、后续消息与恢复是否都抵达 |
| `apps/api/src/application/tool-loop.ts`、`worker/tool-loop-action.ts` | 参数规范化、工具请求持久身份、派发、审批恢复与结果回放 |
| `apps/api/src/application/gateway-actions.ts`、`gateway-commands.ts`、`run-scope-grant.ts` | 真实连接、策略排序、范围授权、Review、撤销；含删除的 changeset 已明确不能由范围授权自动带走 |
| `apps/api/src/files/file-changeset.ts`、`files/windows-file-io.ts` 及相关 repositories | 真实路径、冻结基线、磁盘写入、实际结果、Windows 文件句柄保护 |
| `apps/workbench/src/components/WritePermissionControl.tsx`、`apps/api/src/application/open-working-directory.ts` | 权限芯片是配置/投影入口，显示允许不等于 Run 已有执行权，也不等于桌面 API/Worker 已更新 |

普通聊天只读机制与 Run 写机制分离是既有边界，**本身不是 Bug 根因**。真实断点可能在候选生成、应用、权限配置、参数、Worker 或旧运行产物，必须用证据确定。

## 3. A：先复现，再改代码

在自有隔离临时受管根放入 README、待修改文件、待删除文件和根外哨兵，各带随机标记。目标文件只能是本任务创建的合成样本，不拿用户真实项目文件试删。

用产品目录选择/绑定与既有配置 Owner 准备环境，分别发送自然语言：

- 「在当前目录新建 `luna-create.txt`，内容为 `<本次随机标记>`。」
- 「读取 `luna-modify.txt`，把其中 `<旧标记>` 替换为 `<新标记>`，保留其他内容。」
- 「删除当前目录的 `luna-delete.txt`。」

沿下列节点记录最小必要证据，并指出首次偏离预期的位置：

1. 真实运行实例对应的源码/dist、API/Worker、前端来源及模型 ID；核查桌面暂存 API 是否过期，不凭「源码有了」推断运行实例有了。
2. 原消息 ID、会话模式、持久 `working_resource_id`、canonical root；目录换绑不能让旧请求改写新目录。
3. 该轮真实发出的模板/工具 schema 与模型输出形状；是否产出合法 `execution`，`writes_files`/`file_changes` 是否丢失。
4. 原 `conversation_execution_requests` 行、候选状态、auto_start、准备/应用/委托命令回执、Task/Run 指向；首条和后续消息都检查。
5. 冻结工具集、FILE_QUERY/FILE_READ/FILE_WRITE 连接与策略命中、Review 或范围授权判定、typed reason。
6. `run_tool_calls`、Operation/Invocation、冻结 changeset、实际路径与写前/写后 hash；在确认前后核对真实磁盘。
7. 原会话读取了什么结果，是否只是正文自称完成或等待状态未刷新。

先补能在当前实现上失败的正式回归，再最小修复。若某项已通，保留通过证据，不为制造红灯改坏代码。无法拿到原故障消息时写「原实例未核实」，可另建隔离复现，不能混为同一证据。

受控模型用于稳定验证接线和故障恢复；真实 Provider 用于核对自然语言与工具协议。不能只让 Fake 预设成功，或直接调用文件函数证明整个聊天入口已通。

## 4. B：按真实断点完成最小修复

### 4.1 普通聊天到执行链

- 沿原消息主流程提交类型化候选，复用原请求 Owner、prepare/apply/delegate 与既有自动执行规则；不要重新引入每条消息额外的独立意图解释模型。
- 明确写请求不能因模型尚不知具体文件名而失去写工具；保留 `wantsConversationFileWrite` 的单一判定与旧候选兼容。
- 首条与后续消息、刷新/重挂载、迟到响应走同一持久请求身份。已有活动 Run 时接续原链或明确冲突，不创建第二套工作。
- 用户已明确要求且既有规则允许的写入，不能新增无条件「开始执行」门；必要信息、范围和高风险动作决定仍按原规则保留。
- 不把主流程会话只读身份改为可直接写盘，不从前端/assist-runner 绕过 Run 和 Gateway 调 `fs.writeFile`。

### 4.2 文件动作与权限

- CREATE 校验不存在；MODIFY/DELETE 用真实读取的 `baselineSha256`，按原冻结与落盘机制重查。数组和嵌套字段不能在通用参数校验中被丢掉。
- 使用既有 FILE_WRITE 连接和策略，不默认开放所有目录、不直接 SQL 造权限、不用 CLI 替代受控写文件。
- 核对三档真实语义：ASK 进入原审批；AUTO 仅在策略与有效本次范围授权共同成立时生效；不开放写入或 DENY 时零落盘。上层根策略、撤销及 revision 冲突遵守既有 Owner。
- **DELETE 始终走既有确切动作确认**；含 DELETE 的混合 changeset 也不能借 APPLY_CHANGESET 范围授权跳过确认。拒绝、撤销或基线变化后不能继续删除。
- 根外、`..`、受保护路径、Windows junction/symlink 与根身份变化保留既有拒绝；不能为通过测试解除句柄或安全检查。
- 暂停/取消、UNKNOWN/PARTIAL、响应丢失继续查原工具请求/Operation/Invocation；不换动作 ID 盲重试。多文件部分成功如实按已有账本核对，不能伪称磁盘与 PG 原子事务。

### 4.3 回到原会话

- 复用既有工具轨迹、变更账本、成果与错误投影，仅补本次必要接线，不另建第二套结果存储。
- 明确显示等待审批、被拒绝、权限不足、基线冲突、结果未知及真正成功。等待时不宣称已写；失败时不只给无依据的「没有能力」。
- 成功反馈包含实际相对路径、动作与可追溯结果；新建/修改可读回核对，删除核对不存在。文件副作用成功仍不等于 Task 已完成。

## 5. C：正式验证与红绿证据

优先复用当前单元与集成套件：`file-changeset`、`file-write-frozen-diff`、`conversation-execution`、`tool-loop`、`agent-conversation-main-loop`、`folder-first-conversation`、`real-tools-gateway`、`gateway`；前端只跑受影响的会话执行/权限/恢复用例，确需新增时放在对应职责套件。

每项列出预期、实际命令/退出码与磁盘/账本事实：

| 场景 | 必须检查 |
|---|---|
| CREATE | 普通入口触发，精确路径与 UTF-8 内容；目标已存在拒绝且不覆盖 |
| MODIFY | 真实读取→基线→写入→读回；保留无关内容；冻结后用户改文件则拒绝覆盖 |
| DELETE 批准/拒绝 | 批准前存在；确切 Review 批准后不存在；拒绝后保持原字节；AUTO 不免确认 |
| 缺连接/权限 | 类型化原因与可达配置入口；零磁盘副作用；补齐合成目录配置后原合法流程可用 |
| 越界/保护 | 根外哨兵和受保护样本不变；至少覆盖正常路径与一次实际 Windows 重解析点拒绝 |
| 重放/恢复 | 重复 apply、审批恢复或丢回执后核对不新增副作用；原 ID/Task/Run/Operation 可追溯 |
| 控制 | 尚未准入时暂停/取消零落盘；已有 UNKNOWN 时禁止自动重执行，沿原处置入口核对 |
| 会话与目录身份 | 首条与后续请求均可达；换目录/刷新不能错写其他根、重复创建任务或丢失真实结果 |
| 只读回归 | 列目录/读文件仍能直接工作，零新增 Task/Run/执行请求；ASSISTANT/LEARNING 不能取得写权 |
| 完成边界 | 有实际写结果和账本，不自动产生未经验证/人工接受的 CompletionRecord |

按改动跑两端 typecheck、必要构建、相关单元、真实 PG/HTTP＋真实文件的完整消息入口链；不要用单函数测试代替端到端。新增失败反例先 RED→修复后 GREEN；测试本身有错时说明依据，不能删除或弱化正确失败断言。

真实 PG 使用 `apps/api/scripts/run-integration.ps1` 的临时集群，先读当前参数，再按实际套件名使用 `-TestFile`/`-TestNamePattern` 定向串行运行。不停用户实例，不并发争抢共享 dist/native helper。保留必要原始输出到忽略的 `output/acceptance-raw/agent-file-crud-20261017/`，只清理本任务自有临时资源。

## 6. D：当前运行产物与真实桌面出口

不能在源码和 Fake 测试转绿后就结束。查当前桌面是 dev、test-release 还是安装态，按现有脚本同步本次 API/Worker 与前端产物，核对运行身份。参考 `apps/desktop/scripts/start-acceptance-session.ps1`、`stop-acceptance-session.ps1` 与当前开发启动脚本的实际参数；`-RefreshApi` 仅在确实支持的入口使用，不凭记忆拼命令。

使用已有获授权模型配置进行有界真实 Provider 验证，只发送本任务合成目录/内容；不打印、写入提示词或擅自复制密钥，不新增付费来源或更换模型掩盖协议问题。配置不可用时继续完成可独立进行的修复和隔离验证，真实 Provider 如实标未验并说明原因。

在可用的真实 Windows/WebView2 窗口从聊天入口依次走 CREATE、MODIFY、DELETE（批准与拒绝），观察原会话状态和磁盘；若需要操作插件，先读适用 skill。不得使用浏览器 fixture、直调 HTTP 或测试驱动替代窗口成绩。电脑输入访问失败或没有可用窗口时，明确记录阻塞，不自报桌面通过。

版本过期若就是原实例失败原因，应明确区分「产品源码修复」与「同步运行产物」，不给本来正确的源码添加无关改动。发布安装包的升级/卸载不在本任务范围，未验就保留限制。

## 7. 文档、停点与交付

同步受影响的既有主文档：行为变化归 workbench-design；协议/API 变化注明 Breaking Change 与兼容；数据库变化关联 migration（先核对当前编号，勿抢并行序号）；重大复发根因记录到既有合适开发记录。没有相关变化不新增空文档或 ADR。

当前进度只更新 `CODEX_NEXT_STEP.md`，实际结果只更新 `docs/testing/overall-acceptance-2026-09-28.md` 的相关行；新增必要场景归 verification-plan。运行 `node scripts/check-docs.mjs`，人工核对链接和事实。不要把本任务书的“尚未执行”当成实际开发状态主表。

仅遇到缺少关键业务决定、必须扩大执行授权、不可安全合并的同段冲突或外部环境不可用时，说明证据和具体阻塞；能独立完成的部分继续。例行读取/最小修复/测试/文档维护不反复求确认；不能为避开阻塞放宽权限、UNKNOWN 或完成边界。

最终中文交付必须包含：

1. 原问题的已证实断点与根因；未复现/推测项单列。
2. 实际修改文件及新建/修改/删除各自是否闭合，不能合成一个模糊「已支持」。
3. RED→GREEN、类型/构建、真实 PG/HTTP/文件、真实 Provider、Windows 的分层结果与未运行原因。
4. 一条可复用的普通聊天操作路径，包含实际需要的目录权限与删除确认位置。
5. 文档同步、当前运行产物是否已刷新、自有资源清理及剩余限制。

这是一次完整的文件 CRUD 链路修复任务。不要止步于「已找到原因」「写工具已声明」「权限芯片可见」或模型回复「完成」；成功判断必须落到真实入口、真实磁盘、原账本和原会话。

## 8. 2026-10-17 协调独立验收后的接续

接续原会话「修复普通聊天文件 CRUD 链路」（`01a149e8-2ed5-7522-bb55-fbb633ef28e4`），保留现有模型设置。用户已明确授权协调者直接发送后续提示词，无需用户搬运。本节不重新启动已完成的两处工程修复。

1. 先复跑正式反例 `apps/api/test/integration/agent-file-crud-readiness-review.integration.test.ts`：同一项目 A/B 两个独立受管根，只有 A 有 FILE_WRITE 连接，B 有 AUTO 写策略；当前 B 的只读就绪投影返回 READY，正确应是 NEEDS_CONNECTION。修复 `open-working-directory.ts` 的连接匹配，不得只修改期望值。沿实际 Gateway 根规则核对，不能把「同项目存在写能力」当成「当前目录可写」。
2. 对 `conversation-execution.ts` 中 `findConnection` 当前按能力任取第一个 ACTIVE 连接的逻辑补执行反例：正确连接不是首项、根不匹配、无匹配和同根成功。确认后修实际选择，投影与准入规则同源；勿引入无调用方的通用连接框架，也勿放宽父根/子根、停用、DENY 或越界规则。
3. 将 CREATE/MODIFY/DELETE 的普通消息入口链路补为真实 PG/HTTP/实际文件测试；删除批准/拒绝、请求重放、原会话结果读回单列。既有组件自动 Apply 用例和直接工具调用不能替代这些出口，删除「等待审批」通过不等于「批准后删除与拒绝后不删」通过。
4. 完成当前运行产物核对与文档收口。原线程曾因物理 Escape 停止电脑控制，不把后续工程整改授权推定成自动恢复那次桌面操作；无可用/获授权窗口时先完成非 UI 部分，准确保留 Windows 未验限制，不再用大段手工建连接/策略代替产品链路验证。
5. 本项原限制“入口简化待确认、当前不实施”已由用户同日新授权替代。当前按[工作台 §18.1.4](../../docs/frontend/workbench-design.md#1814-本地目录权限设置2026-10-18已确认已实施)及[新任务书](../local-directory-access.md)实施应用管理的本地文件配置；不删除原权限模型或自动给其他目录/能力授权。无写策略的旧说明与真实 Gateway 判定仍须一致，不能绕过准入直接放行。

先回复本次接手范围与预计改动文件，然后实际修复、运行必要回归并更新统一验收表和 CODEX_NEXT_STEP。保持共享文件定点编辑，不覆盖协调者新增反例或其他并行改动；不 commit/push。协调者会按实际产物继续独立验收。
