# 工具适配器与真实执行准入

2026-10-20 会话写来源（[ADR-031](../decisions/ADR-031-session-direct-write.md)）：会话轮次的写入口从「只有 RUN」扩展为「RUN 或 `AGENT_SESSION_WRITE`」。新增来源与 `AGENT_SESSION_READ` 同形（无 Run/Task/Step/ImportJob，绑定受管资源），但能力词表互不相交：读身份仍只读，写身份只放行 `FILE_WRITE` 能力下的 `APPLY_CHANGESET` 与 `READ_CHANGE_SET`。`WRITE_FILE` 全文覆盖不开放——会话没有 `resource_claims` 保护（该表强制绑定 task/run/worker），并发写同一文件时唯一可靠的闸门是同一条 SHA-256 基线，prepare 与落盘前各无条件比对一次。排他口径与 `USER_ACTION` 一致：不建 claim，靠 prepare 与 admit 各自按 `listOccupiedResources()` 拒绝在途目录。会话直写只在 `AUTO`/`FULL` 且本轮真实写工具可用时启用，包含明确 MODIFY 的内置方法；`ASK` 走已有 Run 审批恢复入口，AUTO 删除在创建 Operation 前转交 Run。已成功修改不重复入队，检查与浏览器/电脑操作可作为剩余工作推进；具体责任与未闭合边界归[运行架构 §2.10](runtime-context.md#210-日常工具工作与正式交付分层2026-10-20-实施)，验证结果只归统一验收表。

2026-10-18 实施状态：基础本地文件不要求用户手工建立连接和策略，目录打开与本地档位由 Application 通过原连接/策略 Owner 协调。日常入口、档位与历史限制以[工作台 §18.1.4](../frontend/workbench-design.md#1814-本地目录权限设置2026-10-18已确认已实施)为准，Application 责任归[领域模型 §12.2.1](domain-model.md#1221-本地目录访问设置的应用责任2026-10-18已实施)。下文能力注册、连接边界、策略准入、范围授权及确切动作审批继续作为内部执行机制；这项接续改变基础配置由谁建立和用户入口，不删除 Gateway、当轮不新增会话写身份（写身份由上方 2026-10-20 的 ADR-031 另行引入），也不自动开放 CLI/浏览器/电脑或外部服务。**2026-10-20 更正**：Git **只读**（`GIT_READ` 的 status/diff/log）已在打开 Git 仓库根目录时随目录授权自动建立（迁移 0124），理由与边界见[HTTP §10.103](../api/http-command-contract.md#10103-目录打开结果中的-git-只读投影2026-10-20-源码实现迁移-0124)；仓库子目录不授权、`GIT_WRITE`（stage/commit/push）仍必须单独授权。运行证据与未验边界归统一功能验收表。

2026-09-28 Windows 受管根登记身份增量：0038 将新登记资源的根卷号/File ID 单独留存，新 Windows `FILE_WRITE` 准备前必须与当前原生助手捕获结果相同；旧资源登记身份不可回填。0039 允许停用无占用旧资源后以同一路径登记新资源 ID，同时保持活动资源同项目路径唯一；历史动作与占用不改绑。助手不支持的目录仍可登记用于其他能力，但不开放新 Windows 文件写入。根普通目录在登记之后、动作准备之前被替换的真实 PG/Windows 反例已转为准备期 409，且不产生 Operation；现有准备后的 0036 冻结身份继续保护后续执行/恢复。含 0039 的确切桌面包 EXE SHA-256 `577a731e3022e540e38edc6a152301afc31b5a585e75eabb999919bbd5863efc` 已通过资源清单核验、旧 `PARTIAL` Windows Job 恢复链及 WebView2 冻结差异与身份提示复验，见 M06 增量 H。无回执的“助手完成后、保存回执前”强杀及 WebView2 处置已由同一确切包定向复验；MODIFY 换名空窗候选残留的确切包桌面同场景、人工交互与 M06 总验收仍待完成。下文 2026-09-27 段落保留当时边界。

2026-09-27 当前 Windows `FILE_WRITE` 开发状态：新 Operation 经 0036 冻结受管根、父目录链与目标的卷号/File ID，Worker 调用随包 Rust 助手执行捕获、写入和恢复核对；旧 Operation 缺物理身份不从当前磁盘回填。助手逐段相对持有的目录句柄打开，拒绝重解析、别名与硬链接；CREATE/MODIFY 用已写完并核验的暂存对象提交，MODIFY 不原地改旧文件，目标名抢占或任何提交后证据不明返回 `effect_uncertain`，Gateway 保持原调用 `UNKNOWN` 与资源隔离。单文件 1 MiB、最多 16 文件；新 `WRITE_FILE` 账本和冻结差异均用受管根相对路径，历史行保留原值。真实 Windows 助手 16/16、隔离 PG real-tools 49/49、迁移 8/8 已通过；新增反例证明 MODIFY 换名空窗强杀后旧内容备份和新内容暂存同时残留，当前尚无可安全自动处置的原调用证据链。桌面 Job 恢复链与 WebView2 自动差异页已按确切 release 包复验；人工交互和 M06 总出口另验。下文保留各阶段当时的实现与证据，不作为本段新边界的当前声明。

2026-09-27 增量 E 时点边界（历史）：M06 变化集证据账本增量 A 与固定图文件写意图增量 B 已通过各自定向独立复验，部分效果状态缺口也已修复；增量 C 提供原 Operation 的逐文件历史账本只读查询。增量 D 新增可信桌面 Job 停机证明、部分写入人工处置及 React Run 页入口，已完成分片开发自检和隔离 Windows Job 部分写入恢复复验。后续增量 E 为**新** FILE_WRITE 意图在准备时核验并冻结有界基线文本，以原 Operation 冻结的目标文本生成只读计划差异；旧意图不回填，缺证据明确不可用，不拿当前磁盘充当原基线。此新增差异已做真实 PG/HTTP 和 React 定向开发自检，**M06 总体仍为 IN_PROGRESS**。执行报告先在原 Invocation 上形成不可覆盖回执，恢复需同时核对冻结输入、回执与磁盘；图中的写意图在 DRAFT 后以冻结 `operation_id` 经 Gateway 执行，ASK/RESUME 不重建动作。部分文件已应用的动作保持 `UNKNOWN`、原资源隔离且在 Run 未决列表可见，账本 `PARTIAL` 不被后续观察覆写；全部文件确定无写入时才可 `FAILED` 并释放 claim。仅在旧 Job 可信停机、原调用与逐文件现状复核以及明确人工决定均成立时，处置命令才保留当前文件、结束旧 Run 并释放资源，原 UNKNOWN/PARTIAL 保留为历史。冻结根与父目录链接绕行已补反例；路径检查到实际 I/O 间仍有 Windows 父目录或目标替换竞争，可能导致根外写入或错误核对，是 M06 总出口的当前阻断，不能把前后路径核验视为句柄级约束。新 release 的真实 WebView2 自动化点击与截图检查已通过；人工交互及 M06 整体出口仍未验收，安装包总验收属 M07；隔离 Windows Job 的部分写入恢复和人工处置全链已通过，详见 [M06 复验记录](../testing/m06-independent-acceptance.md#增量-d真实-windows-job-部分写入恢复复验2026-09-27)。下方较早的开发自检文字保留其当时语境。

句柄级边界的候选、代价和 Windows 竞争反例见 [ADR-012](../decisions/ADR-012-windows-file-io-handle-boundary.md)（Proposed）；当前没有把方案当作已实现保护。

2026-10-02 root-bound 能力配置可达性：`FILE_READ`/`FILE_WRITE`/`GIT_READ`/`GIT_WRITE`/`CLI_RUN` 一直是 `resolveConnectionConfig` 认定的 root-bound 能力，但工作台连接与权限页此前只提供 `WEB_FETCH`/`FILE_READ`/`FAKE_WRITE`/`FAKE_PUBLIC_READ`，因此这四种能力只能由 HTTP 或运维 CLI 建立。现 UI 按同一 `rootBoundCaps` 词表展示全部 8 项，root-bound 必填绝对目录、Fake 不绑定边界，策略侧除 `WEB_FETCH`/`FAKE_PUBLIC_READ` 外必须绑定 ACTIVE 受管资源；一条真实连接只绑定一个边界的 422 拒绝由服务端保留。真实 PG 集成反例覆盖 `GIT_READ`/`CLI_RUN` 连接创建、查询不回显目录、混入主机/混入 `WEB_FETCH`/缺目录/目录不存在，以及 `GIT_READ` 策略按受管资源前缀落 `GIT_STATUS`。这只闭合**配置**入口：当时 `prepareGatewayAction` 只接受 `RUN` 与 `USER_IMPORT` 两种 origin，且非 RUN 只放行 `FAKE_PUBLIC_READ`/`WEB_FETCH`，所以人工触发的 Git 状态/diff、暂存、提交、推送与受控 CLI 无公开入口。

2026-10-05 人工触发 Git 只读入口已补齐：迁移 `0058_m06_user_action_origin.sql` 新增第三种 origin `USER_ACTION`，**只放宽三条 CHECK**，不改表结构、不新增表/列/函数、不回填、不改任何已应用迁移。`git-user-action.ts` 协调 prepare →（按判定）dispatch → 投影，`git-read-projection.ts` 做有界化（`GIT_STATUS` 路径条目上限 200、`GIT_DIFF` 正文字节上限 256 KiB、UTF-8 边界安全截断），与 `files/file-query.ts` 同口径显式带 `truncated`/`limit`。`USER_ACTION` 词表**只放行 `GIT_READ`**；人工触发的目录浏览（`FILE_QUERY`）、暂存、提交、推送与受控 CLI 仍无公开入口。

该切片的三条取舍必须一并记住：

1. **只读动作不建资源 claim。** `resource_claims` 强制绑定 `task_id`/`run_id`/`worker_*`，人工动作没有这些，在不新增可空列的前提下无法建 claim。因此资源排他改由 prepare 与 admit 两处按 `listOccupiedResources()` 拒绝在途目录（`RESOURCE_OCCUPIED`，retryable）——同一口径的另一种表达，不是更弱的检查。**代价**：一次已派发的只读不与随后开始的写动作互斥，可能把一次在途写入读成「干净」；挡住的是「读取先于写入开始」这个方向。
2. **人工主体落在 `activity_records`**（`MANAGED_GIT_READ_REQUESTED`），在 prepare 的同一事务内写入，不留「动作已存在但查不到谁触发」的不可追溯状态。迁移只放宽 CHECK、不加列，所以 `USER_ACTION` 词表里没有 actor 列位。
3. **幂等锚点是确定性 `logical_operations.id`**（sha256(workspace+project+resource+action+path+cached) → uuid 形态），因为 `uq_logical_operation_run_intent` 在 `run_id IS NULL` 时因 NULL 互异而**不提供任何唯一性**。`limit` 刻意不进身份——它是展示上限，进 params 会改动 `params_hash` 并虚增 `max_payload_bytes`。

只读免 `ACTION_APPROVAL` 栅栏的**前提是策略 AUTO，不是「只读就免审」**：`GIT_READ.approvalPassthrough: true`，故 `effectiveDecision` 不把它从 AUTO 降级为 ASK；策略 ASK 仍创建绑定确切目录与参数的 `ACTION_APPROVAL`，确认后需用同一 `command_id` 再次投递才读取。人工动作没有 Run，因此没有 `run_scope_grants` 豁免（`evaluateScopeGrant` 在 `run === undefined` 时返回 undefined，`scopeCovered` 恒 false）——没有放松任何既有栅栏。

**`USER_ACTION` 的崩溃后自动恢复驱动尚未接入**：`reconcileGatewayInvocation` 已加 USER_ACTION 分支（锁受管资源），`GIT_READ` 本就在 `safeReread` 内，但没有任何恢复调度器会自动调用它。停在 `DISPATCHING`/`UNKNOWN` 的调用会如实返回 `UNRESOLVED` 并要求先人工核对，**不盲重试**。属 M06 剩余出口，本切片不因此放行 M06。路径检查到 I/O 之间仍有替换窗口（Windows junction/hardlink），与 `FILE_READ`/`FILE_QUERY` 同一未闭合限制。

Windows 路径语法补强已在 `validateSafeRelativePath` 拒绝 ADS 冒号、保留设备名（含 COM/LPT 上标数字）、禁用字符与控制字符及尾随空格/点；变化集、Delegate 和单文件 `WRITE_FILE` 的 Prepare 共用该校验。此处只阻断确定性的路径别名，不能消除已登记根、父目录或目标在检查与 I/O 之间被替换的竞争。

2026-09-27 验收退回项修复增量：M06 真实工具原 14 项 PG 用例独立复跑通过，但新增 3 项反例失败并整体退回。三项 P1 已按下述修复并完成开发自检——CLI 在 `DISPATCHING` 丢失结果（含缺 PID）时保守判 `UNKNOWN` 且隔离资源，不再误作 `STOPPED/FAILED` 释放资源；`APPLY_CHANGESET` 的 `MODIFY`/`DELETE` 强制有效冻结基线并在落盘前无条件比对，人工批准不可替代；受保护路径改为「先按规范化后的根内相对路径再判定」，`./.env`、`src/../.env`、`foo/../.git/config`、Windows 反斜杠与大小写等价形式均在 prepare 拒绝。定向 real-tools 隔离 PG 复跑 21/21 全绿（含 3 项原反例转绿与 4 项边界反例），Gateway 28/28、恢复 17/17、CLI 5/5、单测 107/107 与类型检查通过。**当时 M06 仍为 IN_PROGRESS，三项 P1 待协调 Agent 独立复验；本日后续结果见上方当前边界**；下文各节的保护与恢复描述据此更新为已成立边界。根因、修复出口与验收日志见 [M06 独立验收](../testing/m06-independent-acceptance.md)。

日期：2026-09-19。`FILE_READ`/`WEB_FETCH` 已有真实 PG Gateway 开发自检；M06 进一步落地 `FILE_WRITE`/`APPLY_CHANGESET`、`GIT_READ`/`GIT_WRITE` 与 `CLI_RUN` 适配器、Gateway prepare/dispatch/reconcile 分支，以及 `adapter-metadata.ts` 的逐适配器 resumable/cancellable/approval_passthrough/sandboxed 声明。这些新写/Git/CLI 能力除纯逻辑单元测试外，已有 `real-tools-gateway.integration.test.ts` 的真实隔离 PG 准入/基线冲突/UNKNOWN 核对与进程树恢复反例（见 §2/§4/§5）；Windows Job Object 实测与独立验收仍待补。P09 的固定 Fake Gateway 早有代码与开发自检。所有适配器服从[恢复契约](../../contracts/04-recovery-and-commit.md)与[物理锁协议](../database/physical-design-postgresql.md)，不直接修改 Task、State 或 Run。

## 1. 公共端口

CapabilityDescriptor：capability_id、adapter_id/version、输入输出 schema、效果类别、所需资源、支持的核对方式。Connection 只保存连接配置/健康/secret_ref，不表达授权；ExecutionConfig 定义可用能力和运行预算；Permission 针对规范化动作判定 AUTO/ASK/DENY。

Adapter 接口：prepareTarget（无副作用的规范化/验证）、execute（一次受准入调用）、reconcile（根据已存动作身份查证）。不支持核对的写调用必须声明，UNKNOWN 保持隔离。execute 不自行重试写入、不换 Provider、不自动新建 operation。

输入公共字段：operation_id、invocation_id、结构化 payload、resource_bindings、取消信号、deadline。输出：明确结果/typed failure/unknown、证据、实际影响范围。stderr/exit code 只是证据，不等于副作用未发生。

### 1.1 P09 当前 Fake Gateway 边界

当前内部用例只有 `FAKE_WRITE/WRITE_MARKER`（RUN 来源，显式 Project 资源根内创建 marker 文件）与 `FAKE_PUBLIC_READ/READ_PUBLIC`（USER_IMPORT 来源，固定 `public.example` HTTPS URL 的确定性假读）。Connection 的可用性、Capability 和独立可撤销的 Permission 分表保存；默认 DENY。Permission 由最终规范目标的路径段、动作类型、参数大小和活动版本判定 AUTO/ASK/DENY；ASK 在 Review 决定后仍于 Admit 重新检查 Connection、活动策略和目标摘要。Connection 当前只能用空配置，公开查询不返回凭据。

Prepare 持久化原 Operation；RUN 的 Worker/Task/Run 与 USER_IMPORT 的 Job/用户/来源各自核验。Admit 在 Workspace authority 共享锁和资源全局串行点下冻结 Invocation/claim，短事务提交后 FakeAdapter 执行一次，再记录结果。不同 Project 可登记重叠根，只有 HELD/QUARANTINED 占用互斥；旧 epoch 和被撤销权限不能取得新准入。DISPATCHING 后效果不确定时 UNKNOWN 保持原动作与资源隔离，目标缺失也不作为未执行证明。P08 受管 Markdown 发布是另一条固定专用出口，不能借用本 Fake marker 身份绕过自己的恢复门。

P09 初版当时没有真实网络请求或 Git/CLI 执行；后续 M04/M06 已分别加入受控 WEB_FETCH、Git 和 CLI 适配器，具体边界见下文。当前仍没有进程沙箱或生产 Worker 管理器。`reconcileGatewayInvocation` 是内部端口，调用方须给出与旧 Worker ID/epoch 对应的停机依据；公开 HTTP 只提供配置命令及脱敏的 Operation/Invocation 历史查询，不提供强制成功或绕行准入的入口。链接/重定向、目录变化、子进程和可核对效果须按真实工具分别验证，不从 Fake 测试推断这些边界已通过。

### 1.2 本次任务范围内的工具授权（2026-10-03）

状态：用户已确认交互规则，准入协议已实现（2026-10-04）。Relay 内部工具循环采用本次任务范围授权：有效权限及已确认范围内的文件搜索、读取、Git status/diff 自动进行；普通文件编辑和已配置检查命令可以连续执行。删除文件、Git 提交/推送与扩大任务范围须再次确认；系统禁止项仍为 DENY。范围授权不由模型生成或工具正文授予。2026-10-18 接续：目录档位为「完全访问」（`FULL`，见工作台 §18.1.3）时，本目录内的删除不再产生单动作 Review；Git 提交/推送、CLI 与目录外动作不受该档位影响，范围授权本身也仍然永远不含删除。

范围授权与单动作 ACTION_APPROVAL 分开：前者用于限定本次任务可 AUTO 执行的动作，后者仍按[契约 03](../../contracts/03-verification-and-approval.md#6-approval-的精确授权对象)绑定确切动作及参数，不用一次 Review 批准覆盖未来未知动作。每次执行仍复核当前权限、作用域、文件基线、资源互斥与取消状态；权限撤销、基线冲突和 UNKNOWN 继续阻止后续不满足准入的动作。

持久协议（`run_scope_grants`，迁移 `0056`）：授权在 Delegate 事务里与 Run 同批落库，因此不存在「Run 已存在但授权漏写」的中间态，也没有脱离 Run 的孤儿授权。边界列（`version`、`root_identity`、`allowed_actions`、`checks`、`boundary_digest`）写入后不可改写，应用角色只被授予撤销列的 UPDATE；`uq_run_scope_grants_run` 保证一个 Run 至多一份授权。授权进入命令摘要，同一个 `commandId` 不能换一个更宽的授权重放。

`allowed_actions` 首批只接受 `WRITE_FILE`、`APPLY_CHANGESET`、`CLI_RUN`。检查统一记作 `CLI_RUN` 而不是 `RUN_TEST`/`RUN_BUILD`：工具循环里模型只能按 `check_id` 点名冻结清单中的某一次检查，「测什么/构建什么」的粒度由那份清单决定，不由动作名决定。`DELETE` 不在集合内，且 `ck_run_scope_grants_no_delete` 显式禁止它出现；即使 `APPLY_CHANGESET` 已放行，含删除的声明仍退回单动作确认（`SCOPE_GRANT_DELETE_REQUIRES_APPROVAL`）。校验为「授权只能收窄信封」：`resource_id` 必须与 `tool_loop_action` 同一个受管资源，放行的每个动作都要求信封里已冻结对应能力连接，放行检查命令时必须至少配置一个检查。

失效与撤销：已撤销、已过期、Run 已终止（除非显式 `survives_run_terminal`）、根身份已变、动作不在集合内、检查程序摘要已变——任一条成立都不放行，回落到既有 Permission 判定。`evaluateScopeGrant` 是唯一范围授权判定入口，`prepareGatewayAction` 与 `dispatchGatewayAction` 调用的是同一个函数，因此准备与执行前复核必然一致；两处都重新判定而不是信任对方的结论，因为撤销、过期与脚本改动都可能发生在两次调用之间。2026-10-18 起，本目录档位为 `FULL` 时的文件写入豁免同样由**两处共用的一个读取函数**按 `resource_id` 现算（只并入 `scopeCovered` 这一个条件，不改 `evaluateScopeGrant` 的结论，也不新增第四种 Gateway 判定），与范围授权共用「同一函数必然同结论」这条约束；档位语义与边界只在工作台 §18.1.3 与 HTTP §10.86 维护。全局 `approval_passthrough` 不改：`FILE_WRITE`/`CLI_RUN` 仍是非穿透适配器，AUTO 降级为 ASK 的既有行为只在本次 Run 的有效授权或本目录 `FULL` 档位下被局部豁免。

已配置检查的可信依据来自两处摘要比对：授权时冻结一份 `executable_sha256`，prepare 与 dispatch 各实测一份。实测缺失或与冻结值不同即判定「配置已变」（`SCOPE_GRANT_CHECK_CHANGED`），退回人工确认，而不是拿旧摘要继续放行。模型只能提交 `check_id`；真实程序与参数由冻结清单展开成 Gateway 的结构化参数，工具正文里不出现任何可执行内容。

### 1.3 首批内部工具范围（2026-10-03）

状态：用户已确认首批范围，读类已实施（2026-10-04 见 §1.4、§1.5），写与检查已实施（见 §1.6）。首批目标是完整本地开发闭环：目录浏览、文件名/路径查找、内容搜索、文件读取、新建/编辑/删除、文件修改差异、Git status/diff/log，以及已配置的测试和构建检查。删除仍按 §1.2 再次确认，并继续受既有禁止项约束；非 Git 目录也应提供基于实际基线和修改结果的文件差异，不要求先建立 Git 仓库。

接入复用现有 FILE_READ、FILE_WRITE/APPLY_CHANGESET、GIT_READ 与 CLI_RUN 适配器及 Run/Gateway 入口；目录浏览与搜索能力、模型连续调用及 Git 只读触发链须补齐。检查只使用已配置的检查命令，首批不开放任意 Shell。工具名称、输入输出及持久化协议在实施前冻结，不能把本段能力名称直接当作已发布 API 或新增持久枚举。

Git 暂存、提交和推送不进入本轮新增模型工具集，后续再接入；已有 GIT_WRITE 底层适配器与历史动作保留。首批按「查找/读取 → 修改 → 查看差异 → 检查 → 根据实际结果继续修正」闭合，不以模型自报完成代替原验证与业务完成入口。

### 1.4 FILE_QUERY：目录浏览、路径查找与内容搜索（2026-10-03 实施）

模型可自主调用的三类文件查询共用一个只读能力 `FILE_QUERY`（`REAL`/`READ`，适配器 `file-query-v1`），逻辑动作分别是 `LIST_DIRECTORY`、`FIND_PATHS`、`SEARCH_TEXT`。合成一个能力而不是三个，是因为三者共享同一套根边界、同一份权限前缀判定和同一种有界结果形状；Gateway 的 `capability_key` 决定适配器，`action_type` 决定查询形态，这是既有 `FILE_READ`/`GIT_READ` 已有的分层。

查询目标是被冻结的**目录**而非文件：`normalized_target` 是受管根内某个现存目录的 realpath，`params.relative_path` 是根内相对子目录（缺省即根自身）。三个动作都返回有界结果、相对路径与定位信息，并显式带 `truncated` 与 `limit` 标记；截断不冒充完整证据。默认跳过受保护内容与构建产物（与 `isProtectedPath` 同一词表加 `node_modules`/构建目录），不做全仓扫描后把全文塞给模型。

恢复沿用只读动作的既有形状：`PREPARED` 保持 `NOT_EXECUTED`，在途丢失按安全重读结算，读取失败记类型化 `FAILED` 而不是「干净」。因为查询无副作用，reconcile 不产生 `UNKNOWN`。

`FILE_QUERY` 的 `approval_passthrough` 为 true，因此策略 AUTO 即 AUTO；策略 ASK 仍创建绑定确切目录与参数的 ACTION_APPROVAL。这与 `FILE_WRITE`/`CLI_RUN` 的非穿透降级是不同事实，不因本节改写任何既有适配器声明。

### 1.5 范围授权与准备/执行前一致校验（2026-10-04 实施）

授权判定收口在 `application/run-scope-grant.ts` 的 `evaluateScopeGrant`，判定依据只有持久化的授权行与当前实际事实（资源规范身份、Run 状态、检查程序实测摘要、变化集是否含删除）。模型说了什么、UI 传了什么、工具正文写了什么都不参与判定，因此不存在「模型自行扩大范围」这条路径。

一致校验同时落在 prepare 与 admit 两处，缺任一处都会留下真实漏洞：只在 prepare 判定的动作，可以被「准备之后撤销授权再派发」绕过；只在 admit 判定的动作，会在 Review 文案里显示成无需批准、实际却要人工判断。两侧调用同一个函数、同样的输入结构，差异只在 admit 多带一次实测摘要。

写工具的基线校验与授权判定是两件事，不能互相替代：授权决定「这类动作可不可以自动执行」，`executeFileChangeset` 的冻结基线比对决定「这一次声明的内容是不是仍然基于用户看到的文件」。用户在模型读取之后改了同一个文件时，授权照样覆盖 `APPLY_CHANGESET`，但落盘前基线比对会失败，用户的改动保留，冲突如实回到模型。

### 1.6 写、差异与检查工具（2026-10-04 实施）

`apply_changeset` 复用既有 `FILE_WRITE` 能力与 `APPLY_CHANGESET` 动作，一次 1–8 项 `CREATE`/`MODIFY`/`DELETE`。声明比通用 JSON Schema 更严格：修改与删除必须带实际读取到的 64 位基线摘要，新建不接受基线、删除不接受内容，单文件内容上限 64 KiB。校验在派发之前就以类型化原因回到模型，不留半可信的动作。

词表里的 `changes` 必须把**变更项字段**逐个声明出来（`path`/`action`/`content`/`baselineSha256`，`required` 只含 `path` 与 `action`），不能只写 `items: { type: 'object' }`。声明是模型唯一能看到的写入契约：写 `items: { type: 'object' }` 时模型无从得知修改必须带 64 位基线摘要，会按自己的理解提交参数并被确定性拒绝。相应地，`validateToolArguments` 必须处理 `type: 'array'` 属性——只处理标量的校验器会把 `changes` 从规范化结果里丢掉，随后的必填检查随即报「缺少必填参数」，使每一次真实写请求都不可用。数组只做形状检查（必须是数组、每项必须是对象），逐项语义仍由 `normalizeToolChanges` 判定，两层职责不合并。2026-10-04 真实 Provider 定向验证实测：修这两处之前模型连续 4 次 `apply_changeset` 全部 `REJECTED`，修之后 `find_paths → search_text → read_file → apply_changeset` 四步全 `SETTLED`。

`read_change_set`（动作 `READ_CHANGE_SET`，同属 `FILE_WRITE` 能力）只读账本、不碰磁盘：基线与目标摘要来自 prepare 冻结的输入，实际摘要来自执行账本，因此「计划差异 / 已应用差异 / 当前磁盘」三者的来源保持可辨。它只能读本 Run 自己的文件变更证据，否则按 `GATEWAY_TARGET_DENIED` 拒绝。

`run_check`（动作 `CLI_RUN`）只能按 `check_id` 点名冻结清单中的检查。`resolveToolCheck` 在 prepare 与 dispatch 各解析一次：清单里没有该 id 就按 `TOOL_CHECK_NOT_CONFIGURED` 拒绝，且不留下 Operation、不启动任何子进程。`ToolRequestRejected` 与准入拒绝走同一条出口（`REFUSED` → 行落 `REJECTED`），因此 Worker 不会因为一个非法 `check_id` 抛出未知异常。

2026-10-05 补齐检查后的修正：工具声明列出本 Run 的合法冻结检查 ID，普通非零退出回传错误标志和原输出；取得明确正常关闭回执的 `run_check` 可以释放 claim 并让原 DRAFT 继续读取和修正。每次复检都是新工具请求/Operation，原失败回执保留，不重放原失败进程，不把 exit 0 自动写成验收 PASS。取消、超时、失权与 UNKNOWN 不进入自动修正，规则归[运行架构 §2.3](runtime-context.md#23-内部工具循环的对象身份与恢复2026-10-03-实施设计)。**Breaking Change: No（HTTP 形状、动作状态、授权与审批契约不变）**；新增的 `CHECK_FAILED` 是内部 Worker 分类。

**检查入口的信任摘要（2026-10-07 实施）。** 授权冻结时不再只存入口程序的 `executable_sha256`，而是由 `application/check-trust-basis.ts` 的 `computeCheckTrustBasis` 实测一份 `check-trust-v1` 依据并随授权落库：

- **材料集合是有限、明确、可枚举的**：入口可执行程序（根内或根外都算）、**第一个位置脚本参数**（`node <script>` / `python <script>` 形态里真正被执行的脚本）、受管根**顶层**直接决定检查行为的构建/测试配置（`package.json`、`tsconfig.json`/`tsconfig.base.json`、`vitest.config.*`、`vite.config.*`、`jest.config.*`）。每条材料记录规范绝对路径、根内相对路径（根外为 `null`）、SHA-256 与角色（`EXECUTABLE` / `REFERENCED_SCRIPT` / `BUILD_CONFIG`），按规范路径排序后取摘要。
- **后续位置参数是这次检查的输入（工作集），不进材料**。把它算进材料会让「检查失败 → 读取修正 → 再跑同一检查」这条主链直接不可用；同理，检查程序自己 import 的兄弟模块不在本版材料内——这是明确的**范围限制**，不用静默少算材料维持 AUTO。
- **读不到就是读不到**：材料不存在、是目录或不可读返回 `CHECK_TRUST_MATERIAL_UNREADABLE`；解释器内联求值（`-e`/`-c`/`--eval` 等）、shell 组合（`&&`/`|`/`;`/反引号/`$()`）与通配符返回 `CHECK_TRUST_DYNAMIC_EXECUTION_UNSUPPORTED`。两种都在**冻结期**拒绝该授权，不给一个没有依据的检查去 AUTO 放行。
- **同路径、同命令名不能掩盖内容变化**：`evaluateScopeGrant` 在 `CLI_RUN` 分支先比 `executable_sha256`，再比信任摘要；`resolveFrozenCheck` 解析并校验落库的 `trust_basis`，形状不合法即视为该检查不可解析。历史授权行（只有入口摘要、没有材料依据）仍可读出，但按「依据不一致」退回人工确认，不当成摘要相同。
- **不放宽任何既有边界**：本机制不改连接允许的可执行入口清单，不改用户授予的动作权限，也不把检查出口当作 Windows Job Object 或脱离进程树的安全证明。

摘要只回答「磁盘上的材料是什么」。`run_check` 的可信 exit0 仍只表示这一次检查对其受验输入正常结束，不代表业务验收 PASS。规则归[运行架构 §2.3](runtime-context.md#23-内部工具循环的对象身份与恢复2026-10-03-实施设计)，规格见[测试计划 §20.10](../testing/verification-plan.md#2010-检查入口的信任摘要与检查证据适用性2026-10-07-实施)。

**人工批准与检查材料绑定（2026-10-09 实施）。** 上面这套范围授权摘要只保护 AUTO 那条路。2026-10-08 后端独立验收确认的缺口是：材料漂移让范围授权退回 ASK 后，`createGatewayReview` 建的那条 `ACTION_APPROVAL` 的 target 只绑定动作、路径、参数与连接/策略版本，**没有绑定创建时观察到的材料**；`requireCurrentGatewayGrant` 接受有效单动作批准后也不再要求当前材料与该批准的材料相同。因此「Review 创建后至批准前改脚本」与「批准后至派发前改脚本」都能凭同一条旧批准真实执行新脚本。现由 `application/approval-check-material.ts` 在既有 Owner 内补齐，不新建第二套授权判定：

- **绑定**：`prepareGatewayAction` 建 Review 时，用服务端自己实测到的整份 `CheckTrustBasis` 写进 target 的 `check_trust_basis` 字段，因此它一并进入 `target_hash` 的完整性校验。批准对象从此不只包含「跑什么」，还包含「跑的是磁盘上哪一份材料」；`evidence.check_material` 另存一份可读清单给前端展示。
- **核对输入全部来自已持久化的 Operation 事实**：重算用的是 `op.params` 里的 executable/args 与受管资源的 canonical root，不是调用方自报的摘要，也不重新解析调用点名的 check_id。因此 prepare、批准提交、最终派发准入三处重算的是同一份依据。
- **两处核对，保守失败**：`resolveRunReview` 在保存 APPROVE 之前核对一次（材料已变则拒绝这次批准，而不是记下一份永远不该生效的判断），`requireCurrentGatewayGrant` 在真实执行前再核对一次。判定为 `run_check` 驱动（有 `run_tool_calls` 且 `tool_name = 'run_check'`）的动作缺依据、读不出依据或摘要不同，一律拒绝。
- **拒绝后的收口与原任务接续（2026-10-09 修复）**：材料绑定挡住了旧批准执行新材料，但**派发前的确定性拒绝此前只结算了工具行**——原 Operation 仍停在 `WAITING_APPROVAL`、Review 已 `DECIDED`、Run 与 Task 悬在等待态，两条命令结算后没有下一条能唤醒它，`advanceRunStep` 又把这条零 Invocation 的动作投影成 `ACTION_UNKNOWN`。现在工具循环与固定动作链走**同一个领域入口** `denyGraphActionBeforeInvocation`：单个短事务内把 `PREPARED` 的 Invocation 落 `NOT_EXECUTED` 并释放资源 claim、原 Operation 落 `DENIED`、绑定的工具行落 `SETTLED`、释放 Worker claim、Run 落 `FAILED`、Task 释放回 `READY`，并写 `RUN_FAILED` 审计。恢复领取（`claimGatewayWorker`）与派发准入（`dispatchGatewayAction`）两处拒绝都走它，因此不需要新的状态枚举或第二个授权/恢复 Owner。
  - **收口与 UNKNOWN 的分界**：`ACTION_UNKNOWN` 只能由「可能已产生外部效果」的动作触发。`advanceRunStep` 的兼容分支因此只对处于 `DISPATCHING`/`UNKNOWN` 的 Operation 返回它；`PREPARED` 与 `WAITING_APPROVAL` 从未派发，不得被投影成未知。
  - **合法接续路径**：收口把 Run 置为终态并把 AI 执行权释放回用户。用户在**原 Task、原受管资源**上按既有 Delegate 入口重新委托（`retry_of_run_id` 指向已终态的原 Run），新 Run 按磁盘上的当前材料重新冻结范围授权并正常执行；旧 Run、旧 Operation、旧 Review 与其绑定的材料摘要全部保持可追溯。复制一个新工作区/目录/Task 只能证明「新任务能跑」，不构成原任务恢复。
  - **拒绝不追溯撤销已确定的单动作批准**（契约 SC-13）：范围授权撤销后，那条已保存的精确批准仍可执行它绑定的材料；Permission 撤销则相反，旧批准不能覆盖撤销，必须零 Invocation 并按上述口径收口。两者是不同的对象，本版分别验证。
  - **不绕过控制与竞态**：已有待处理控制时收口入口不生效，由 `applySafeControl` 按既有安全点处理；Worker 身份或命令投递已失效时收口入口同样拒绝，调用方继续抛出原异常而不是谎称已安全结束。
- **权限与身份优先**：撤销、过期、连接/策略版本变化、UNKNOWN 与在途动作保护都不因这条绑定而放宽；APPROVE 仍不豁免当前权限。真实 `DISPATCHING`/`UNKNOWN` 不走上面的捷径，仍按原 Operation/Invocation 身份走核对与隔离。
- **已知边界**：最终核对与外部进程真正读取之间仍是同机普通文件系统上的时间差，因此这不是操作系统级隔离；材料集合仍是 `check-trust-v1` 的有限可枚举集合（见上），检查程序自己 import 的兄弟模块与动态依赖不在其中。

**Breaking Change: No**（Review target 增加只读字段，HTTP 形状、动作状态与授权判定不变）；没有新增或修改数据库结构，因此没有 migration。`denyGraphActionBeforeInvocation` 的 `delivery` 改为可选与该文件其余 Gateway 入口一致（图驱动时仍提供并核对），调用方行为不变。

变化集证据读取没有外部效果，因此 reconcile 按同一冻结引用安全重读一次即可（`SAFE_RE_READ`），不需要 `UNKNOWN` 隔离。这与 `FILE_WRITE` 落盘路径的核对要求不同。

信封能力清单已包含 `FILE_WRITE` 与 `CLI_RUN`：信封是模型自主调用的**上界**，说明「模型可以请求」，不代表放行——没有对应范围授权时这些动作仍然退回落单动作审批。

一次基线冲突后的自动适配由 `decideToolAdaptation` 判定，只回答「这一次请求是不是对某个已结算冲突的合法重新适配」，不执行写入也不猜测模型意图。合法要同时满足四件事：针对的确实是一个已结算的真实冲突（不是模型自称）；基线等于冲突回执里实测到的当前摘要（证明真的重新读取过）；目标内容与被拒那次不同（挡住「新基线 + 旧目标全文」的冒充适配）；一次只针对一个明确冲突的路径，且只适配原始请求。任一条不满足就返回类型化停止原因，请求不连 Operation、不产生副作用。`TOOL_ADAPTATION_STALE_BASELINE` 的拒绝详情带上回执实测值，因为不给这个值模型只能反复盲猜同一个摘要，把一次可修正的冲突拖成终止。

目标在冲突后已不存在（`TOOL_ADAPTATION_TARGET_MISSING`）时同样停下：文件是否继续由用户决定，不由系统推断。

## 2. Files

2026-10-03 用户确认默认修改位置：Relay 内部工具循环直接在用户打开并登记为受管资源的原目录执行文件修改。编辑前记录实际读取基线并在写入前复核，保留用户及其他执行者的已有改动；发现基线变化时停止覆盖并处理冲突。原目录修改继续受任务范围授权、资源互斥及逐文件执行证据约束。

此规则替代此前优先隔离副本/worktree 的默认建议。隔离执行保留为后续可选方向，首批接入不要求自动创建副本或 worktree；Git 和非 Git 目录均采用上述默认位置。此次只确认目标交互与默认流程，不代表新的工具循环已实现。

2026-10-03 用户确认基线冲突处理：在能够确定原修改尚未产生副作用时，保留用户的新改动，重新读取文件并生成新的变化集；能够明确区分且互不冲突的修改可在原授权范围内自动适配一次。修改相互冲突、无法判断影响或再次发生冲突时停止并展示差异，等待用户确认。新变化集绑定新的读取基线，旧意图及冲突证据保留；不能仅将旧目标内容配上新的基线摘要来覆盖用户修改，单动作审批也不能继承给内容或参数已变化的新动作。

上述自动适配只处理已确定没有写入的基线冲突。部分写入、缺回执或 UNKNOWN 仍先按原 Operation/Invocation 核对，不创建新动作绕过未决效果或资源隔离。

2026-10-04 已在模型工具循环中实现这一次适配（`apply_changeset`）。「合法适配」按可核对的三件事判定，不采信模型自称：针对的确实是变化集逐文件结果里已结算的 `CONFLICT`；一次只针对一个路径；提交的 `baselineSha256` 等于该冲突回执的实测 `actualBaselineSha256`（证明真的重读过），且目标内容与被拒那次不同（挡住「新基线 + 旧目标全文」）。不满足时按类型化原因拒绝且不连 Operation、不写盘：`TOOL_ADAPTATION_STALE_BASELINE`、`TOOL_ADAPTATION_CONTENT_UNCHANGED`、`TOOL_ADAPTATION_AMBIGUOUS`（一次涉及多个冲突路径）、`TOOL_ADAPTATION_TARGET_MISSING`（冲突后目标已消失）。同一条冲突第二次冲突落 `TOOL_ADAPTATION_REQUIRES_HUMAN`，按循环终止规则停下并把差异留给用户，不再自动改写。合法适配在 `run_tool_calls.adaptation_of`/`adapted_path` 指回原始请求与那一个路径，因此恢复后仍可追溯来源；新行是新动作身份，不继承旧的单动作审批。深度限制（适配过的行不再作为新的适配来源、原始请求只被适配一次）由应用层判定实现，`0056` 的 CHECK 只保证两列同在同缺。出口与未覆盖项见[测试计划 §20.3](../testing/verification-plan.md)。

2026-10-04 用户选定方案 B：文件夹首条对话的明确执行请求不再冻结预制的 `file_write_action` / `cli_run_action`，改为冻结工具循环信封加本次任务范围授权。理由是解释阶段没有任何目录访问，给不出可信正文，而原提示词自己就要求「缺少实际内容就 CLARIFY」——最常见的「帮我改一下这个文件」因此反复被追问。现在解释只产出目标与范围，正文由 Run 内的模型在读过真实文件之后决定，基线因此总是真实的。这不放松任何栅栏：范围授权只放行本次受管目录内的 `APPLY_CHANGESET` 与那份已配置检查（删除永远不在其中），每一次真实动作仍单独产生绑定确切目标与参数的 `ACTION_APPROVAL` Review。代价是用户确认的对象从「精确内容」变为「目标 + 范围」，交互语义归[工作台 §18.4.1](../frontend/workbench-design.md#1841-文件改动由执行时的真实读取决定2026-10-04方案-b)。

2026-10-04 补齐方案 B 的写能力开关缺口（用户提示词「先跑通读文件、改代码」第 2 项）。写工具此前只按「解释候选列出了非空 `file_changes`」授予，而解释模型恰恰没有目录访问、拿不准文件名是常态——于是「目录里那个把字符串转数字的解析函数修一下」这类明确修改请求永远拿不到写工具，主链在设计上就走不通。现在解释候选多一个与路径无关的布尔 `writes_files`（用户是否明确要求改动这个目录里的文件），写能力按 `writes_files === true || file_changes.length > 0` 判定并收敛在单一纯函数 `wantsConversationFileWrite`；缺省值按「列出了文件变更」推导，因此既有调用方不改也得到同一个判定。`file_changes` 降级为辅助定位信息，不再是唯一开关；只读盘点与讨论声明 `writes_files: false` 就得不到写权，因此「不因为补齐缺口而扩大授权」。

同时移除一处恒真判断：只读准备此前无条件 `requireConnection(FILE_WRITE)`，等于每次只读请求都被一条用不上的写能力挡住，报出的原因还指向错误的缺失项。现在 `FILE_WRITE` 连接只在本次确实授予写工具时解析；缺哪项能力就报哪一项。纯只读任务不再落一条 `allowed_actions` 为空的范围授权——`run_scope_grants` 的 `cardinality(allowed_actions) >= 1` 是有意的非空约束，空授权改为不产生该事实。范围授权、ACTION_APPROVAL 与 `approval_passthrough` 边界都不变。

READ_MANAGED_VERSION 读取不可变资料；READ_WORKSPACE_FILE 只对已连接根读取并记录 hash。WRITE_CANDIDATE 始终发布新受管版本；APPLY_CHANGESET 才是工作目录写操作。

change_sets + change_set_files 保存冻结基线摘要、相对路径、操作（新增/修改/删除）、目标 hash、diff 引用、逐文件结果。

2026-09-25 FILE_READ 已实现（开发自检）：Gateway 新增首个 `REAL` 适配器能力 `FILE_READ`/`READ_FILE`（RUN 来源）。Connection 绑定一个现存目录的 realpath 作为规范 allowed root（0014 migration 放宽守卫形态，凭据仍不入库）；Permission 沿用策略分表按根前缀判定，默认 DENY。Prepare 规范化拒绝穿越、符号链接/junction 逃逸并要求现存普通文件；Execute 读取前重新 realpath 比对冻结路径，受调用方 deadline 与 AbortSignal 约束，输出限额 128 KiB，二进制按类型化失败拒绝；结果记录目标、大小与全文 SHA-256。读取幂等无副作用：类型化失败按 FAILED 结算并释放资源 claim，恢复核对采用安全重读（PREPARED 保持 NOT_EXECUTED，在途成功以新读取结算 SUCCEEDED、目标缺失结算 FAILED），不产生 UNKNOWN。机制对照：Codex `core/src/safety.rs` 的 `FileSystemSandboxPolicy` 以配置的可写根加路径包含判定约束补丁目标；Relay 差异是把包含检查放在 Gateway 准入（资源锁 + 策略前缀）与执行前 realpath 重验两处，而非进程内沙箱策略，且只读动作无需 UNKNOWN 恢复。READ_MANAGED_VERSION、WRITE_CANDIDATE、APPLY_CHANGESET 与固定图文件读意图仍未实现。

change_sets + change_set_files 保存基线版本、相对路径、操作（新增/修改/删除）、目标 hash、diff 引用、逐文件结果。V1 默认禁止批量删除和受保护路径（凭据、数据库数据目录、应用自身配置）；权限设置不能隐式扩大为任意磁盘。

2026-09-26 M06 开发自检：`FILE_WRITE`/`WRITE_FILE`、`APPLY_CHANGESET` 作为第三个 `REAL` 能力接入 Gateway（0030 登记，RUN 来源，绑定受管资源根）。`files/file-changeset.ts` 的 `executeFileChangeset` 以 `realpath` 规范根、拒绝绝对路径/穿越/`\u0000`/符号链接目标；`MODIFY`/`DELETE` 必须先携带格式有效的 64 位十六进制冻结 `baseline_sha256`——`requireFrozenBaseline` 在解析路径、创建父目录等任何副作用之前校验，缺失或非法即记 FAILED，且落盘前的基线比对无条件执行（不再是「仅在摘要存在时比较」），当前内容与冻结摘要不符记 CONFLICT 不覆盖；CREATE 目标已存在记 CONFLICT、MODIFY/DELETE 目标缺失记 CONFLICT，逐文件产出 APPLIED/CONFLICT/FAILED 并整体标 `SOME_CHANGES_FAILED_OR_CONFLICTED`（不用 DB 回滚假装撤销已落盘文件），受调用方 AbortSignal 约束；`reconcileFileChangeset` 只读观察目标/期望 hash；Gateway 仅在原 Invocation 的持久适配器回执与冻结输入自洽、路径仍在冻结根内且逐文件回读匹配时收敛 SUCCEEDED，缺回执或部分/失配保持 UNKNOWN（写动作不能凭终态或 exit code 断言本次调用已执行）。保护路径（`.git`/`.env*`/`node_modules`/`.relay`/`data`）在 prepare 与 execute 两处拒绝，且 `validateSafeRelativePath`/`isProtectedPath` 先把输入 `resolve` 归一再据以计算根内相对路径并按前缀匹配（统一反斜杠、剥离根锚点前缀、大小写不敏感），逃逸检查仍先于保护检查，使 `./.env`、`src/../.env`、`foo/../.git/config`、`.\\ENV` 等等价别名无法绕过；`WRITE_FILE` 缺基线派生为 CREATE，因而对既有文件同样不能静默覆盖。`gateway/adapter-metadata.ts` 声明 FILE_WRITE 的 `approval_passthrough:false`——非穿透适配器即便策略 AUTO 也降为 ASK，自动写不承担需审批的动作。边界（2026-09-26 恢复类反例增量，2026-09-27 P1 修复补强）：FILE_WRITE/APPLY_CHANGESET 已有真实隔离 PG Gateway 反例（`real-tools-gateway.integration.test.ts`）——AUTO→ASK 降级后批准再写、真实文件按内容落盘且结果记目标 hash、基线失配判 CONFLICT 不动原文件、`.env`/`.git`/`../` 等保护路径与穿越在 prepare 拒绝、崩溃于写后未结算时按原回执与真实内容核对（有回执且内容相符 SUCCEEDED、被篡改 UNKNOWN 且阻断原 Run 再领取）。P1-2/P1-3 修复另补真实 PG 反例：`MODIFY`/`DELETE` 缺有效冻结基线在 prepare 即 `VALIDATION_FAILED` 且不触碰磁盘、携匹配基线的合法 `MODIFY` 仍正常应用、`WRITE_FILE` 缺基线派生 CREATE 因而不能覆盖既有文件、`./.env`/`src/../.env`/`foo/../.git/config` 等规范化别名在真实 prepare 一律 `GATEWAY_TARGET_DENIED`。这仍属开发自检，不构成 M06 出口放行；逐文件 diff UI 与固定图写意图接线未实现，真实 Windows 会话与独立验收后置。

2026-09-27 M06 增量A 开发自检：`change_sets`/`change_set_files` 持久证据表落地（0031 migration，`apps/api/src/files/change-set-repository.ts` 为唯一 SQL Owner）。一次 `FILE_WRITE` invocation 至多一份账本头（`uq_change_set_invocation` 幂等锚点），逐文件行写入即固定——应用角色只有 `SELECT/INSERT`（账本头仅开放 `status/evidence_source/file_count/updated_at` 的 UPDATE 供核对收敛），核对阶段按 `ON CONFLICT DO NOTHING` 只补记执行缺失的路径，绝不改写执行时已记录的状态与原因。执行结算（`settleGatewayInvocation`）把 `executeFileChangeset` 的逐文件结果与调用结果在同一短事务固化（磁盘 I/O 全在事务外），崩溃于结算之前则由恢复核对（`reconcileGatewayInvocation`）按原 Invocation 回执、冻结输入和真实内容共同补记：三者全匹配才收敛 `SUCCEEDED`，缺回执、部分应用或失配保持 `UNKNOWN`。整体状态 `SUCCEEDED`/`PARTIAL`/`UNKNOWN`（部分应用不整体成功），逐文件状态 `APPLIED`/`CONFLICT`/`FAILED`，`guardFile` 落库前再校验摘要自洽（声称成功必须有与目标一致的实际摘要，缺可信冻结基线的非 CREATE 记 `FAILED`）。真实隔离 PG 反例（`real-tools-gateway.integration.test.ts`）：成功写固化为唯一一份 `SUCCEEDED` 账本且逐文件哈希与磁盘一致、基线冲突固化为 `PARTIAL` 且冲突文件记磁盘原值不被覆盖、崩溃后核对分别收敛 `SUCCEEDED`/`UNKNOWN` 且唯一一份、多文件单冲突按路径逐条固化混合状态、多文件全成功（`CREATE`+`MODIFY`+`DELETE`）按账本记录的规范根回读磁盘复核并在库层验证幂等与不可篡改（换主键重复插同一 invocation 撞 `23505`，改写/删除逐文件行、删除账本头、把账本头指向别的 invocation 均 `42501`）。real-tools 定向 23 例全绿仍属开发自检；`diff_ref` 仅留字段，逐文件 diff 生成与展示 UI 未实现。

2026-09-27 增量 A 定向独立复验：0032 追加来源联合外键，把账本的 Project、Run、资源和动作类型绑定到产生它的 operation；不重写 0031。Gateway 在批准前核对内容摘要、规范路径唯一性和逐文件相对路径的 UTF-8 长度；仓储汇总以守卫后的实际文件行为准。执行和恢复均锚定登记的冻结根，拒绝根或父目录经 junction/符号链接改指根外或受保护的根内路径；恢复读不到原根时逐文件留未确认观测。适配器返回后先将报告一次性绑定原 `DISPATCHING` Invocation，恢复只凭该回执与回读共同确认本次效果；部分报告的已应用文件可以逐条保留，整体仍 UNKNOWN。协调侧 Node 24 单测 113/113、隔离 PG real-tools 37/37、migration 8/8、Gateway 28/28、recovery 17/17、CLI 5/5 均通过。普通 Node 文件 API 的检查与使用仍有竞态，不能把这些检查当作 OS 沙箱；真实 Windows/模块出口继续待验。

2026-09-27 M06 后续增量：可信桌面 Job 停机恢复在旧 Run claim 的会话锁内，把原 FILE_WRITE Invocation、Worker ID/epoch、外层投递 epoch 与 launch ID 绑定到不可改写的 0033 证明；租约到期和普通子进程退出不产生该证明。只有原 Operation/Invocation `UNKNOWN`、账本 `PARTIAL`、资源隔离且旧 Worker 已 fence 时，应用层人工处置用例才能接受 `KEEP_CURRENT_AND_FAIL_RUN`。它重读账本列出的全部路径并比对用户所见快照，0034 处置事实与原投递结清、claim 释放、Run 失败和 Task 返 READY 原子提交；原 Invocation/账本继续保留未知与部分写入的历史，不把当前文件状态解释为原调用整体成功。此处不生成 diff 文本，也不保证外部编辑器与回读之间的 OS 级隔离；公开契约见 [10.43](../api/http-command-contract.md#1043-m06-部分文件写入的人工处置2026-09-27)。

2026-09-27 无回执崩溃恢复增量：新 Windows 动作若在助手备份换名空窗中断，原目标名可缺失，旧内容备份和新内容暂存均可能留在受管父目录。缺原执行回执时账本保持 `UNKNOWN`，不能从残留文件名、摘要或最终目标反推原调用效果。助手新增只读 `inspect-residuals`，以冻结根与父链 File ID 为锚，限量枚举目标同目录的残留候选并读取其 File ID/摘要；当前观察和候选清单绑定原 Invocation、变化集与快照哈希供人工判断，但不证明候选由这次 Invocation 创建。旧 Operation 缺物理身份、观察不完整或不安全时继续隔离。可信桌面停机证明和其他原有栅栏成立后，人工可选择保留当前目标与候选并结束旧 Run；原 Invocation 和账本 `UNKNOWN` 保持历史，程序不自动清理、补写或重试。该扩展复用 0034 处置表和原命令 API，无数据库迁移。

应用前解析规范根/实际父路径，拒绝路径穿越、重叠根绕行及不能可靠处理的链接/reparse point。先在隔离副本生成变化集，再展示并显式应用；申请 Resource claim，核对当前文件基线，有冲突保留候选。逐文件记录，部分应用进入核对，不显示整体成功。

V1 不承诺对系统外编辑器的绝对并发隔离。对受管存储可控制写入口；对自由仓库，应用动作显示基线/冲突，必要时要求用户暂停外部编辑或只导出 patch。不能用 hash 检查声称消除了所有 TOCTOU 竞态。

## 3. Web

只开放公共 HTTP/HTTPS GET/HEAD，不开放任意方法、Cookie/Authorization 转发或任意本地代理。标准化 URL，逐跳验证 scheme、目标主机及解析出的地址；禁止 loopback、私网、link-local、云元数据和其他保留地址。不能只校验初始 URL。

客户端需要将地址验证与实际连接关联，避免 DNS 重绑定；每次重定向重新校验，不自动携带敏感 headers。开发测试使用显式 Fake HTTP 服务，不能为了测试把生产 SSRF 策略关闭。[OWASP SSRF 防护](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html)

推荐默认：连接 10 秒、总请求 30 秒、最多 3 次重定向、解压后 5 MiB，配置版本化。HTML 清洗提取正文并保存原 URL、最终 URL、获取时间、状态码、内容 hash 和提取器版本。不运行 JavaScript，不将网页指令视为授权。付费/登录正文不可用时明确证据不足，不用摘要冒充全文。

2026-09-25 WEB_FETCH 已实现（开发自检）：Gateway 新增第二个 `REAL` 适配器能力 `WEB_FETCH`（RUN 来源，只读 GET）。Connection 绑定一个 DNS 主机名（`allowed_host`，存库小写）作为允许边界，可显式附 `allow_private: true` 登记受控环境例外；WEB_FETCH 逻辑动作不绑定受管资源、无资源 claim（只读无需排他），Permission 按 URL 主机前缀判定，默认 DENY。Prepare 规范化仅接受 http(s)、无 userinfo/片段的 URL，主机必须等于连接允许主机；Execute 每一跳重新校验 scheme/主机、解析 DNS 并对全部地址做保留地址检查后直连该地址（防 DNS 重绑定），重定向最多 3 次且跨主机确定性拒绝，连接不活跃 10 秒、总请求 30 秒、响应体 5 MiB 上限，不携带 Cookie/Authorization；`text/html` 以 `web-text-extract-v1` 确定性提取正文，`text/*`/JSON 记原文，二进制仅记 hash 并标 `text_available: false`。类型化失败（HTTP 错误状态、DNS 失败、超时、超限）结算 FAILED 并释放，恢复核对安全重读，不产生 UNKNOWN。源码对照缺口：.research/upstream/codex 的网络工具走审批门（network_approval）+ 沙箱策略，无 URL/IP 级 SSRF 校验实现可复用，本实现按本节与 OWASP 指南自行完成。2026-09-25 后续增量：网页读意图已接入固定 Mock 图——Delegate 可选冻结 web_fetch_action {connection_id, url}（与写标记/文件读三选一），意图识别统一 readMockActionOperationId，deny 路径支持无资源形态；冻结期仅做 URL 语法校验，主机-连接绑定仍在 Gateway 准入，跨主机冻结 URL 为确定性拒绝（prepare 前无 operation/invocation，投递重排，永久失配需人工取消重新委派）。

2026-09-26 P17 窄切片已把 URL 导入 Job 接到同一 Gateway（USER_IMPORT）和 Knowledge：创建时冻结规范 URL 与 WEB_FETCH Connection，执行前重核活动 Permission/批准与逐跳 SSRF 边界；成功的抓取证据生成不可变 WEB_PAGE 版本。Job/Operation 使用各自持久身份；RUNNING 且未准备动作、以及 Operation 已终结但 Job 未结算的崩溃窗口可重扫，Knowledge/Job/Context revision 同事务提交。已处于 DISPATCHING 的导入仍须可信停机证明后按原 Invocation 安全重读，后台 tick 不自动推断进程已停。公开路径和未验收边界见 [HTTP 契约](../api/http-command-contract.md#1027-m04p17-url-导入-job-到-knowledge2026-09-26开发自检)。

2026-10-22（DEV-0046 澄清）`allow_private` 的治理链与已接受边界：该开关只存在于 Gateway 连接 config（显式 `true` 才落库，缺省即拒绝），设置者是能在该 Workspace/Project 创建或编辑连接的参与者；连接写命令走命令回执与历史，读取方 DTO 不返回 `allow_private`。它只解除保留地址检查，**不解除**主机绑定、Permission 主机前缀门（默认 DENY）与逐跳 SSRF 校验。已接受风险：单开关整体关掉私网黑名单，意味着持有该连接编辑权的人可让本机服务访问 loopback 与云元数据地址；当前缓解只有连接编辑授权与命令审计，不做逐地址审批。若将来需要按地址粒度控制，应扩展为地址清单而非布尔开关（未做）。

## 4. Git

只对显式登记仓库/隔离副本使用可信 git executable 和结构化参数。读取 status/diff/log 禁用外部 diff/textconv 等非必要执行路径；受信配置需考虑 hooks、filter、credential helper 等真实可执行因素。Git 只读命令名称不代表任意仓库配置都无副作用。

默认修改位置按 [Files 的原目录规则](#2-files)执行，原先优先隔离 worktree 的建议已于 2026-10-03 调整。隔离 worktree 保留为后续可选方向；接入时仍须记录原仓库身份、基线 commit、分支和 worktree，并保护共享仓库元数据对应的资源锁。Git worktree 不是安全沙箱。[Git worktree 文档](https://git-scm.com/docs/git-worktree)

| 能力 | 默认策略 | 审批/证据 |
|---|---|---|
| status/diff/log | 有限作用域 AUTO | 仓库身份、基线与输出摘要 |
| 创建非保护分支、暂存指定文件 | 明确配置后 AUTO，否则 ASK | 确切路径/分支；不允许 git add . 隐式纳入未知文件 |
| commit | ASK | 分支、预期 parent、tree/change set、消息、hooks 配置版本 |
| push | ASK | remote URL 指纹、完整 ref、待推 commit、预期远端状态；目标变化失效 |
| force push、reset --hard、clean、删除远端/保护分支 | V1 DENY | 不通过换 Adapter 绕过 |

Commit 后断连：检查绑定仓库、预期父/tree/消息或动作标识与实际提交，证据不足保持 UNKNOWN。Push 后断连：读取确切 remote/ref 的对象 ID；相同为成功证据，其他情况记录并核对，不默认重推。禁止因为本地 exit code 丢失就新建同样动作。

2026-09-26 M06 开发自检：`GIT_READ`（status/diff/log）与 `GIT_WRITE`（stage/commit/push）作为 `REAL` 能力接入 Gateway（0030 登记，RUN 来源，绑定受管资源根为工作目录）。`git/git-adapter.ts` 的 `runSafeGit` 用 `execFile` 结构化参数数组（非 shell）、`GIT_CONFIG_NOSYSTEM=1`、`-c core.quotePath=false`、`-c diff.external=false` 与最小环境，禁用外部 diff；`gitStageFile` 拒绝 `.`/`*`/`..`（不允许隐式全量暂存），`gitCommit` 绑定预期 parent SHA（不匹配即拒），`gitPush` 拒绝以 `-`/`+` 开头或含 `:` 的 ref/remote（不开放强推/refspec/删远端），`reconcileGitCommit` 按预期 parent+message 只读核对 HEAD、`reconcileGitPush` 以 `ls-remote` 读回确切 ref 对象 ID（相同为 SUCCEEDED、否则 UNKNOWN，不默认重推）。`adapter-metadata.ts` 声明 GIT_WRITE `approval_passthrough:false`（AUTO 降为 ASK）、commit/push 可核对故 `resumable:true`。边界（2026-09-26 恢复类反例增量）：已有真实隔离 PG + 一次性测试仓库/本地 bare remote 的 Gateway 反例（`real-tools-gateway.integration.test.ts`）——GIT_READ status 以 AUTO 穿透真实执行、GIT_WRITE 非穿透强制 ASK、commit 绑定预期 parent（不符即 FAILED 且 HEAD 不变）、真实 commit/push 落库、`--force`/`+ref`/`-u` 等在 prepare 拒绝、push 崩溃于结算前后按真实 `ls-remote` 回读对象 ID 收敛（命中 SUCCEEDED 不重推，远端被外部推进后不匹配记 UNKNOWN 且阻断原 Run 再领取）。这仍属开发自检，不构成 M06 出口放行；重复动作幂等与审批内容变更（C03/C09/D02）专项反例、hooks/filter/credential helper 等真实可执行因素的信任审查、隔离 worktree 与共享元数据资源锁未实现，真实 Windows 会话与独立验收后置。

### 4.1 GitHub 只读查询（0103，2026-10-17 开发自检）

F25 首片按 [ADR-023](../decisions/ADR-023-builtin-github-skill.md) 新增 `GITHUB_READ`（`REAL`/`READ`）与专用只读 adapter，**不复用 `CLI_RUN`**：后者是写效果（`approvalPassthrough=false`、`resumable=false`、失败即隔离、核对恒 UNKNOWN），入口还必须是在连接上点名的绝对路径文件。决策层面的取舍不重复，这里只记实际实现边界。

**动作与来源。** 词表固定四个动作：`GITHUB_REPO_VIEW`、`GITHUB_PR_LIST`、`GITHUB_PR_VIEW`、`GITHUB_ISSUE_LIST`；`githubParamsForAction` 只收该动作允许的字段（列表的 `state`/`limit`、PR 查看的 `number`），未知键拒绝而不是静默丢弃。能力只对 `ASSISTANT_READ` / `AGENT_SESSION_READ` 放行且必须绑定受管资源；`RUN`、`USER_ACTION`、`USER_IMPORT` 与写能力一样被 `0103` 的 CHECK 拒掉。工具循环信封的 `connections` 形状是冻结协议，本片不借它给 Run 增开后门。

**仓库身份。** Connection 的 `config` 为 `{}`，不绑定目录边界；目标来自用例层选定的受管根 canonical path，Permission 再按该目标的前缀判定。适配器在受管根里让本地 `git config --get-regexp '^remote\..*\.url$'` 解析 remote，只认 `github.com`（https/ssh/scp 三种写法），多个候选按 remote 名确定性取第一个；解析不到就 `GH_REPO_UNIDENTIFIED`，不猜、不换仓库。模型参数里没有 `repo` 字段，`gh` 的 argv 只由适配器拼装成 `['--repo', <解析结果>, ...固定参数]`，因此模型不能指名任何仓库，也没有任何 `gh api` 入口进入词表。

**执行与投影。** `gh` 的解析顺序是 `RELAY_GH_PATH` → Node 可执行文件同目录的 `gh.exe`（安装态随包 sidecar）→ `PATH` 里的 `gh`（`src/github/gh-executable.ts`，与 `computer-runtime`/`file-io-helper` 同一套先例）；原先只认 `PATH`，本机把 gh 解包到 `.research/runtime-cache` 后仍然查不到，失败提示也说不清查过哪里。`execFile` 结构化参数数组、`shell:false`、30 秒超时、可取消；环境变量为显式白名单，不转发 `RELAY_`/`GH_TOKEN` 等调用方环境。只读结果做有界投影而不是透传：列表最多 50 项、PR 正文 8 KiB（截断必须显式标 `body_truncated`）、状态检查最多 25 项且保留总数，所有结果带 `untrusted_external_content: true`——Issue/PR 正文与检查日志始终是数据。失败以 `FAILED` + 类型化原因结算（`GH_CLI_UNAVAILABLE`、`GH_UNAUTHENTICATED`、`GH_NETWORK_ERROR`、`GH_REPO_UNIDENTIFIED`、`GH_NOT_FOUND`、`GH_FORBIDDEN`、`GH_TIMEOUT`、`GH_CANCELLED`），并给可行动提示；不把「没装 gh」或「没登录」降级成空的查询结果。`GH_CLI_UNAVAILABLE` 的文案会写出实际查过的位置与 `RELAY_GH_PATH` 用法（见 `github-executable.test.ts` 5/5）。会话只读轮次对已派发但非 SUCCEEDED 的读取记 `UNKNOWN`，同时把类型化正文回传模型，避免同一失败被重复计成成功。

**按需激活。** 四个工具只在当轮存在 `GITHUB_READ` 的 ACTIVE 连接时进入词表；停用连接后下一轮立即消失。本片不注入上游 `SKILL.md` 正文，工具描述自带用途与「失败≠空结果」的约束。

2026-10-24 官方 Skill 登记与按需注入落地：`src/skills/official-skills.ts` 固化不可变身份（`github-gh@4537a92f…`、MIT、来源 `cli/cli`）并对随包 `SKILL.md`/`RELAY_NOTES.md`/`LICENSE` 三份文件按钉住 SHA-256 逐字校验（`apps/api/skills/builtin/gh/`，Relay 边界附录 `RELAY_NOTES.md` 为新增的 Relay 自有文件，上游正文未改一字）；仅当本轮词表真实出现 `github_` 工具时，才在会话主流程 system 的能力事实块之后附加约 1 KiB 的冻结摘要与边界块，上游 20 KB 正文从不进入上下文；`RELAY_OFFICIAL_SKILL_GITHUB=disabled` 设备级禁用注入（能力与账本不受影响）。单测 `official-skills.test.ts` 13/13（身份冻结、三文件逐字校验、缺失/篡改失败关闭、无工具不注入、禁用生效、注入块与附录同源防漂移）。人设档/子代理/学习档轮次与 Run 内工具循环暂不注入此块，属已记边界。

2026-10-18 修复网络环境边界：原白名单漏掉代理变量，导致用户终端可以经代理登录、Relay 子进程却直连失败。现在显式保留 `HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY` 及对应小写变量，仍排除调用方的 `GH_TOKEN`、Provider 密钥及其他非必要环境。凭据来自用户在 Relay 外完成认证后的 CLI 存储，不自动登录、不输出 token。真实已认证四动作的结果与限制归统一验收表，不再以「本机未安装 gh」作为当前阻塞。

2026-10-18 补第五个只读动作 `GITHUB_ISSUE_VIEW`（`gh issue view <n> --json ...`）：此前只有 `issue list`，能列出编号却读不到正文与评论，模型要判断「这个 issue 到底说什么」没有任何合法入口。动作仍属 `GITHUB_READ`，没有新增能力、迁移或权限分支；`--json` 一次取 `number,title,body,state,author,url,labels,createdAt,updatedAt,comments`（评论走 `--json ...,comments` 而不是 `--comments`——后者只配人类可读输出，上游 `gh` Skill 原文明确区分）。投影沿用有界口径：正文 8 KiB、评论最多 10 条且单条 2 KiB，`comments_total`／`comments_truncated`／`body_truncated` 三个字段把「被剪掉」显式说出来，结果同样带 `untrusted_external_content`。写动作（开 PR、评论、合并）仍不在词表里。

**证据与未闭合。** 单测 `github-read.test.ts` **16/16**（词表封闭、来源拒绝、参数收窄、真实临时 git 仓库的 remote 解析、环境白名单、失败归类、缺失 `gh` 的真实探测、投影上限）；集成 `github-read.integration.test.ts` 在真实 PostgreSQL 上 **8/8**（`0103` 分支完整性、原始 INSERT 反例、连接启停、`GH_REPO_UNIDENTIFIED`、身份闸门后真实 `gh` 探测、`repo` 参数到不了适配器、逐动作 Permission、与 `FILE_READ` 共存）。未闭合：本机没有安装 `gh`，**无法验证已认证的真实 GitHub 读取**；GitHub 侧写动作不存在；官方 Skill 原文尚未接入打包与运行时提示；未跑真实 Windows 窗口与安装包验收，未 commit。

### 4.2 GitHub 写动作最小工程协议（2026-10-24 冻结，未实施）

长期目标（ADR-023）：「提交当前修改并创建 PR」一句话完成。GitHub 侧写动作（创建 PR/Issue、评论）在**核对协议冻结之前不进入 Gateway 词表**——本节就是那份协议，作为后续切片的工程前置；实施仍需用户对该切片单独授权，本文不构成放行。

**对象与身份。** 新动作属新能力 `GITHUB_WRITE`（`REAL`/`WRITE`），照 0103 先例出迁移并重述 `ck_logical_operation_resource`；**只放行 `RUN` 来源**（外部副作用不在会话轮次内发生，与 BROWSER_ACTION/COMPUTER_INPUT 同界）。目标仓库沿用只读片同一闸门：受管根真实 Git remote 本地解析，模型不提供 `repo`；`head` 分支必须取自该受管根的当前分支或显式给出且存在于本仓库，`base` 分支必须经只读查询证实存在。argv 仍由适配器逐字段构造，`gh api`、`--jq`、任意 flag 永不进入。

**批准与撤销。** `adapter-metadata` 声明 `approval_passthrough:false`（AUTO 一律降 ASK）、`resumable` 按各动作核对能力分别声明；范围授权不覆盖写动作（不入 `SCOPE_GRANT_ACTIONS`）。逐动作 Permission 撤销后，在途未结算动作仍按原准入完成结算，但不得启动新动作——撤销语义与既有 Gateway 一致，不另设第二套。

**幂等与回执。** 每个动作带**客户端幂等键**：创建类用 `CreateOperation` 时已冻结的 `operation_id` 派生（如 PR 的 `Relay-Operation: <operation_id>` 头或标题内嵌标记），重放同一动作不得产生第二个对象。回执绑定确切对象（PR/Issue 编号与 URL），写回 Operation result。

**结果丢失后的只读核对（每动作一个核对函数，核对不到即 UNKNOWN）。** 创建 PR 丢失：按 `head`+`base`+幂等标记 `gh pr list --json number,url,headRefName` 查回；命中唯一对象即 SUCCEEDED，查不到保持 UNKNOWN（可能尚未建出，禁止盲重试）。创建 Issue 丢失：按幂等标记搜索本仓库 Issue。评论丢失：按评论正文内嵌幂等标记在该对象评论列表中查回。合并/关闭等高危动作另需先冻结核对语义再议，首片不含。

**UNKNOWN 与恢复。** 派发后断连/超时/响应丢失一律 UNKNOWN + 隔离（`listUnresolvedRunOperations` 阻断该 Run 再领取），由人工或恢复流程执行上述只读核对后结算；禁止自动重放，禁止换 Adapter 或动作 ID 绕过。失败原因分类复用只读片词表并补 `GH_ALREADY_EXISTS`（幂等冲突）。

**首片边界。** 不做：Issue/PR 正文模板引擎、批量动作、跨仓库动作、PR review 评论。需要的新基建只有：`GITHUB_WRITE` 能力迁移、写 adapter 与三到四个动作的核对函数、会话侧「创建 PR」执行候选的落点（复用既有执行请求链，不新增账本）。


## 5. 受控 CLI

V1 明确采用受信宿主项目模式，不提供恶意代码隔离。固定程序真实路径/版本、参数模板、工作根、允许环境变量、凭据引用、输出上限、超时、网络能力声明与脚本/构建配置 hash 组成 ExecutionConfig。脚本变化重新校验，任意 shell 字符串不作为输入。

进程 API 的 cwd 和环境只是进程属性，不构成 OS 沙箱；默认继承的环境必须改为最小白名单。原 Java 方案示例为 [ProcessBuilder](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/lang/ProcessBuilder.html)，当前 TypeScript/Python 提案也不改变这一隔离要求；固定入口/参数数组、cwd 与超时不等于 OS 沙箱。

初版能力只注册 RUN_BUILD/RUN_TEST 两个已配置模板。默认超时 5 分钟、输出 4 MiB，截断后记录 truncated 和完整性限制；根据真实工具需要调整。测试结果保存基线 commit/changeset、测试配置 hash、实际 argv、exit code、输出与可得的测试清单；不因返回 0 就认定所有 required tests 都执行。

取消须管理进程树及身份（pid + 创建时间/执行记录），不能只 kill 一个可能复用的 PID。Windows 优先利用经验证的 Job Object 管理自启动进程组，并测试不允许 breakaway 的行为；这属于生命周期控制，不等同恶意代码隔离。[Windows Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)

实际进程与 OS 封装在 P19 按选定语言验证；若无法证明旧执行已停止，保持 QUARANTINED，不发新写权。未知代码要求真实隔离方案后才能支持，不能用“用户点了允许”扩大本模式的安全承诺。

2026-09-26 M06 开发自检：`CLI_RUN` 作为 `REAL`+`WRITE` 能力接入 Gateway（0030 登记，RUN 来源，绑定受管资源根为工作目录）。`cli-worker/cli-adapter.ts` 的 `executeCliCommand` 用 `spawn(..., { shell:false, windowsHide:true })` 与结构化参数数组执行（不接受任意 shell 字符串），`buildSafeEnvironment` 只透传系统必需变量白名单并显式剥离含 `KEY`/`SECRET`/`TOKEN`/`PASSWORD` 前缀及 `RELAY_`/`DATABASE_` 的项；输出按 `maxOutputBytes`（默认 4 MiB）截断并标 `truncated`，超时（默认 5 分钟）与调用方 AbortSignal 均经 `killProcessTree` 收敛，结果记 exit code/stdout/stderr/pid/durationMs/reason；`reconcileCliExecution` 只在 `DISPATCHING` 丢失结果这条恢复路径上被调用（pid 仅在结算时落库，崩溃-未结算路径无确定效果证据），因此一律保守返回 `UNKNOWN` 且 `quarantined:true`——缺 PID 记 `DISPATCHING_RESULT_LOST_NO_PID`，有 PID 则连同存活证据一并记录但无论进程是否已退出都不足以证明外部命令未执行或已知失败，绝不返回 `STOPPED`/`FAILED` 而释放资源。`cli-worker/process-tree.ts` 在 Windows 用 `taskkill /pid <pid> /T /F` 终止整棵进程树、POSIX 先试组信号。`adapter-metadata.ts` 声明 CLI_RUN `approval_passthrough:false`（AUTO 降为 ASK）、`sandboxed:false`（子进程不是 OS 沙箱）、`resumable:false`（任意构建/测试不可盲目重放）。边界（2026-09-26 恢复类反例增量）：已有真实隔离 PG + 真实子进程的 Gateway CLI 反例（`real-tools-gateway.integration.test.ts`）——CLI_RUN 非穿透强制 ASK、真实子进程 exit code/stdout 采集、`buildSafeEnvironment` 经真实进程验证剥离 `TOKEN`/`RELAY_` 前缀变量、deadline 到点判 TIMEOUT 而非挂起、超时经 `killProcessTree`（Windows `taskkill /T`）连带终止孙进程（父进程 spawn 长命孙进程并落 PID，断言超时后孙进程消失不残留孤儿）。这仍属开发自检，不构成 M06 出口放行；P1-1 修复已补真实 PG + 真实子进程反例：`CLI_RUN` 走 prepare→批准→`afterFakeEffect` 于真实写入后抛 `SimulatedGatewayCrash`→按原 Worker 身份 reconcile，断言 `reconciled=UNKNOWN`、claim `QUARANTINED`、再领取被 `GATEWAY_OPERATION_UNRESOLVED` 阻断，实证丢失结果不再错误开放后续执行（但 pid 仅在结算时持久化，仍在途运行的在途 PID 无法直接观测，`STILL_RUNNING` 分支不作单独断言）；未采用经验证的 Windows Job Object 封装（不允许 breakaway 的行为未在目标 Windows 实测）、无固定 `RUN_BUILD`/`RUN_TEST` ExecutionConfig 模板与脚本/构建配置 hash 变更再校验、输出过量/D07–D10/C06 其余反例未全，真实 Windows 会话与独立验收后置。

## 6. 准入验收

D01–D11 全覆盖，另外验证：Git 外部 diff/hook 配置变化、CLI 输出过量/孙进程/超时、Web DNS 与重定向、变化集部分应用、远端状态变化、参数被当作选项注入。先 Fake 故障，再在一次性仓库与受控服务真实验证。未通过的能力保持 DISABLED，并在交付中明确未完成，而非计入完整 V1。
