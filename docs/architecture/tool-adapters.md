# 工具适配器与真实执行准入

日期：2026-09-19。`FILE_READ`/`WEB_FETCH` 已有真实 PG Gateway 开发自检；M06 进一步落地 `FILE_WRITE`/`APPLY_CHANGESET`、`GIT_READ`/`GIT_WRITE` 与 `CLI_RUN` 适配器、Gateway prepare/dispatch/reconcile 分支，以及 `adapter-metadata.ts` 的逐适配器 resumable/cancellable/approval_passthrough/sandboxed 声明——但这些新写/Git/CLI 能力当前仅有单元测试覆盖其纯逻辑，真实 PG Gateway 准入/故障/冲突反例与 Windows/独立验收仍待补；P09 的固定 Fake Gateway 早有代码与开发自检。所有适配器服从[恢复契约](../../contracts/04-recovery-and-commit.md)与[物理锁协议](../database/physical-design-postgresql.md)，不直接修改 Task、State 或 Run。

## 1. 公共端口

CapabilityDescriptor：capability_id、adapter_id/version、输入输出 schema、效果类别、所需资源、支持的核对方式。Connection 只保存连接配置/健康/secret_ref，不表达授权；ExecutionConfig 定义可用能力和运行预算；Permission 针对规范化动作判定 AUTO/ASK/DENY。

Adapter 接口：prepareTarget（无副作用的规范化/验证）、execute（一次受准入调用）、reconcile（根据已存动作身份查证）。不支持核对的写调用必须声明，UNKNOWN 保持隔离。execute 不自行重试写入、不换 Provider、不自动新建 operation。

输入公共字段：operation_id、invocation_id、结构化 payload、resource_bindings、取消信号、deadline。输出：明确结果/typed failure/unknown、证据、实际影响范围。stderr/exit code 只是证据，不等于副作用未发生。

### 1.1 P09 当前 Fake Gateway 边界

当前内部用例只有 `FAKE_WRITE/WRITE_MARKER`（RUN 来源，显式 Project 资源根内创建 marker 文件）与 `FAKE_PUBLIC_READ/READ_PUBLIC`（USER_IMPORT 来源，固定 `public.example` HTTPS URL 的确定性假读）。Connection 的可用性、Capability 和独立可撤销的 Permission 分表保存；默认 DENY。Permission 由最终规范目标的路径段、动作类型、参数大小和活动版本判定 AUTO/ASK/DENY；ASK 在 Review 决定后仍于 Admit 重新检查 Connection、活动策略和目标摘要。Connection 当前只能用空配置，公开查询不返回凭据。

Prepare 持久化原 Operation；RUN 的 Worker/Task/Run 与 USER_IMPORT 的 Job/用户/来源各自核验。Admit 在 Workspace authority 共享锁和资源全局串行点下冻结 Invocation/claim，短事务提交后 FakeAdapter 执行一次，再记录结果。不同 Project 可登记重叠根，只有 HELD/QUARANTINED 占用互斥；旧 epoch 和被撤销权限不能取得新准入。DISPATCHING 后效果不确定时 UNKNOWN 保持原动作与资源隔离，目标缺失也不作为未执行证明。P08 受管 Markdown 发布是另一条固定专用出口，不能借用本 Fake marker 身份绕过自己的恢复门。

当前没有真实网络请求、Git/CLI 执行、进程沙箱或生产 Worker 管理器。`reconcileGatewayInvocation` 是内部端口，调用方须给出与旧 Worker ID/epoch 对应的停机依据；公开 HTTP 只提供配置命令及脱敏的 Operation/Invocation 历史查询，不提供强制成功或绕行准入的入口。真实工具阶段必须重新评估链接/重定向、目录变化、子进程和可核对效果，不从 Fake 测试推断这些边界已验证。

## 2. Files

READ_MANAGED_VERSION 读取不可变资料；READ_WORKSPACE_FILE 只对已连接根读取并记录 hash。WRITE_CANDIDATE 始终发布新受管版本；APPLY_CHANGESET 才是工作目录写操作。

change_sets + change_set_files 保存基线版本、相对路径、操作（新增/修改/删除）、目标 hash、diff 引用、逐文件结果。

2026-09-25 FILE_READ 已实现（开发自检）：Gateway 新增首个 `REAL` 适配器能力 `FILE_READ`/`READ_FILE`（RUN 来源）。Connection 绑定一个现存目录的 realpath 作为规范 allowed root（0014 migration 放宽守卫形态，凭据仍不入库）；Permission 沿用策略分表按根前缀判定，默认 DENY。Prepare 规范化拒绝穿越、符号链接/junction 逃逸并要求现存普通文件；Execute 读取前重新 realpath 比对冻结路径，受调用方 deadline 与 AbortSignal 约束，输出限额 128 KiB，二进制按类型化失败拒绝；结果记录目标、大小与全文 SHA-256。读取幂等无副作用：类型化失败按 FAILED 结算并释放资源 claim，恢复核对采用安全重读（PREPARED 保持 NOT_EXECUTED，在途成功以新读取结算 SUCCEEDED、目标缺失结算 FAILED），不产生 UNKNOWN。机制对照：Codex `core/src/safety.rs` 的 `FileSystemSandboxPolicy` 以配置的可写根加路径包含判定约束补丁目标；Relay 差异是把包含检查放在 Gateway 准入（资源锁 + 策略前缀）与执行前 realpath 重验两处，而非进程内沙箱策略，且只读动作无需 UNKNOWN 恢复。READ_MANAGED_VERSION、WRITE_CANDIDATE、APPLY_CHANGESET 与固定图文件读意图仍未实现。

change_sets + change_set_files 保存基线版本、相对路径、操作（新增/修改/删除）、目标 hash、diff 引用、逐文件结果。V1 默认禁止批量删除和受保护路径（凭据、数据库数据目录、应用自身配置）；权限设置不能隐式扩大为任意磁盘。

2026-09-26 M06 开发自检：`FILE_WRITE`/`WRITE_FILE`、`APPLY_CHANGESET` 作为第三个 `REAL` 能力接入 Gateway（0030 登记，RUN 来源，绑定受管资源根）。`files/file-changeset.ts` 的 `executeFileChangeset` 以 `realpath` 规范根、拒绝绝对路径/穿越/`\u0000`/符号链接目标、逐文件比对冻结 `baseline_sha256`（外部编辑冲突记 CONFLICT 不覆盖），CREATE 目标已存在记 CONFLICT、MODIFY/DELETE 目标缺失记 CONFLICT，逐文件产出 APPLIED/CONFLICT/FAILED 并整体标 `SOME_CHANGES_FAILED_OR_CONFLICTED`（不用 DB 回滚假装撤销已落盘文件），受调用方 AbortSignal 约束；`reconcileFileChangeset` 按目标/期望 hash 只读核对，命中记 SUCCEEDED、部分或失配记 UNKNOWN（写动作不能凭 exit code 断言未执行）。保护路径（`.git`/`.env*`/`node_modules`/`.relay`/`data`）在 prepare 与 execute 两处按相对路径前缀拒绝。`gateway/adapter-metadata.ts` 声明 FILE_WRITE 的 `approval_passthrough:false`——非穿透适配器即便策略 AUTO 也降为 ASK，自动写不承担需审批的动作。边界：本轮仅落地适配器与 Gateway 分支并补单元测试（路径保护纯逻辑）；FILE_WRITE/APPLY_CHANGESET 在真实隔离 PG 下的准入/执行/基线冲突/部分应用/UNKNOWN 核对反例尚未编写，`change_sets`/`change_set_files` 持久表、逐文件 diff UI 与固定图写意图接线均未实现，真实 Windows 会话与独立验收后置——现有单元覆盖不构成 M06「真实工具与故障/冲突测试通过」出口。

应用前解析规范根/实际父路径，拒绝路径穿越、重叠根绕行及不能可靠处理的链接/reparse point。先在隔离副本生成变化集，再展示并显式应用；申请 Resource claim，核对当前文件基线，有冲突保留候选。逐文件记录，部分应用进入核对，不显示整体成功。

V1 不承诺对系统外编辑器的绝对并发隔离。对受管存储可控制写入口；对自由仓库，应用动作显示基线/冲突，必要时要求用户暂停外部编辑或只导出 patch。不能用 hash 检查声称消除了所有 TOCTOU 竞态。

## 3. Web

只开放公共 HTTP/HTTPS GET/HEAD，不开放任意方法、Cookie/Authorization 转发或任意本地代理。标准化 URL，逐跳验证 scheme、目标主机及解析出的地址；禁止 loopback、私网、link-local、云元数据和其他保留地址。不能只校验初始 URL。

客户端需要将地址验证与实际连接关联，避免 DNS 重绑定；每次重定向重新校验，不自动携带敏感 headers。开发测试使用显式 Fake HTTP 服务，不能为了测试把生产 SSRF 策略关闭。[OWASP SSRF 防护](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html)

推荐默认：连接 10 秒、总请求 30 秒、最多 3 次重定向、解压后 5 MiB，配置版本化。HTML 清洗提取正文并保存原 URL、最终 URL、获取时间、状态码、内容 hash 和提取器版本。不运行 JavaScript，不将网页指令视为授权。付费/登录正文不可用时明确证据不足，不用摘要冒充全文。

2026-09-25 WEB_FETCH 已实现（开发自检）：Gateway 新增第二个 `REAL` 适配器能力 `WEB_FETCH`（RUN 来源，只读 GET）。Connection 绑定一个 DNS 主机名（`allowed_host`，存库小写）作为允许边界，可显式附 `allow_private: true` 登记受控环境例外；WEB_FETCH 逻辑动作不绑定受管资源、无资源 claim（只读无需排他），Permission 按 URL 主机前缀判定，默认 DENY。Prepare 规范化仅接受 http(s)、无 userinfo/片段的 URL，主机必须等于连接允许主机；Execute 每一跳重新校验 scheme/主机、解析 DNS 并对全部地址做保留地址检查后直连该地址（防 DNS 重绑定），重定向最多 3 次且跨主机确定性拒绝，连接不活跃 10 秒、总请求 30 秒、响应体 5 MiB 上限，不携带 Cookie/Authorization；`text/html` 以 `web-text-extract-v1` 确定性提取正文，`text/*`/JSON 记原文，二进制仅记 hash 并标 `text_available: false`。类型化失败（HTTP 错误状态、DNS 失败、超时、超限）结算 FAILED 并释放，恢复核对安全重读，不产生 UNKNOWN。源码对照缺口：.research/upstream/codex 的网络工具走审批门（network_approval）+ 沙箱策略，无 URL/IP 级 SSRF 校验实现可复用，本实现按本节与 OWASP 指南自行完成。2026-09-25 后续增量：网页读意图已接入固定 Mock 图——Delegate 可选冻结 web_fetch_action {connection_id, url}（与写标记/文件读三选一），意图识别统一 readMockActionOperationId，deny 路径支持无资源形态；冻结期仅做 URL 语法校验，主机-连接绑定仍在 Gateway 准入，跨主机冻结 URL 为确定性拒绝（prepare 前无 operation/invocation，投递重排，永久失配需人工取消重新委派）。

2026-09-26 P17 窄切片已把 URL 导入 Job 接到同一 Gateway（USER_IMPORT）和 Knowledge：创建时冻结规范 URL 与 WEB_FETCH Connection，执行前重核活动 Permission/批准与逐跳 SSRF 边界；成功的抓取证据生成不可变 WEB_PAGE 版本。Job/Operation 使用各自持久身份；RUNNING 且未准备动作、以及 Operation 已终结但 Job 未结算的崩溃窗口可重扫，Knowledge/Job/Context revision 同事务提交。已处于 DISPATCHING 的导入仍须可信停机证明后按原 Invocation 安全重读，后台 tick 不自动推断进程已停。公开路径和未验收边界见 [HTTP 契约](../api/http-command-contract.md#1027-m04p17-url-导入-job-到-knowledge2026-09-26开发自检)。

## 4. Git

只对显式登记仓库/隔离副本使用可信 git executable 和结构化参数。读取 status/diff/log 禁用外部 diff/textconv 等非必要执行路径；受信配置需考虑 hooks、filter、credential helper 等真实可执行因素。Git 只读命令名称不代表任意仓库配置都无副作用。

开发候选优先放隔离 worktree，并记录原仓库身份、基线 commit、分支和 worktree；Git worktree 有共享仓库元数据，仍需对应资源锁，不是安全沙箱。[Git worktree 文档](https://git-scm.com/docs/git-worktree)

| 能力 | 默认策略 | 审批/证据 |
|---|---|---|
| status/diff/log | 有限作用域 AUTO | 仓库身份、基线与输出摘要 |
| 创建非保护分支、暂存指定文件 | 明确配置后 AUTO，否则 ASK | 确切路径/分支；不允许 git add . 隐式纳入未知文件 |
| commit | ASK | 分支、预期 parent、tree/change set、消息、hooks 配置版本 |
| push | ASK | remote URL 指纹、完整 ref、待推 commit、预期远端状态；目标变化失效 |
| force push、reset --hard、clean、删除远端/保护分支 | V1 DENY | 不通过换 Adapter 绕过 |

Commit 后断连：检查绑定仓库、预期父/tree/消息或动作标识与实际提交，证据不足保持 UNKNOWN。Push 后断连：读取确切 remote/ref 的对象 ID；相同为成功证据，其他情况记录并核对，不默认重推。禁止因为本地 exit code 丢失就新建同样动作。

2026-09-26 M06 开发自检：`GIT_READ`（status/diff/log）与 `GIT_WRITE`（stage/commit/push）作为 `REAL` 能力接入 Gateway（0030 登记，RUN 来源，绑定受管资源根为工作目录）。`git/git-adapter.ts` 的 `runSafeGit` 用 `execFile` 结构化参数数组（非 shell）、`GIT_CONFIG_NOSYSTEM=1`、`-c core.quotePath=false`、`-c diff.external=false` 与最小环境，禁用外部 diff；`gitStageFile` 拒绝 `.`/`*`/`..`（不允许隐式全量暂存），`gitCommit` 绑定预期 parent SHA（不匹配即拒），`gitPush` 拒绝以 `-`/`+` 开头或含 `:` 的 ref/remote（不开放强推/refspec/删远端），`reconcileGitCommit` 按预期 parent+message 只读核对 HEAD、`reconcileGitPush` 以 `ls-remote` 读回确切 ref 对象 ID（相同为 SUCCEEDED、否则 UNKNOWN，不默认重推）。`adapter-metadata.ts` 声明 GIT_WRITE `approval_passthrough:false`（AUTO 降为 ASK）、commit/push 可核对故 `resumable:true`。边界：本轮只落地适配器与 Gateway 分支并有 `git-adapter` 编译/单元级覆盖；对一次性测试仓库与本地测试 remote 的真实 PG Gateway 反例（C03/C09/D02/D03/D09：审批内容变更、重复动作、remote 变化、失败状态、恢复）尚未编写，hooks/filter/credential helper 等真实可执行因素的信任审查未落地，隔离 worktree 与共享元数据资源锁未实现，真实 Windows 会话与独立验收后置。

## 5. 受控 CLI

V1 明确采用受信宿主项目模式，不提供恶意代码隔离。固定程序真实路径/版本、参数模板、工作根、允许环境变量、凭据引用、输出上限、超时、网络能力声明与脚本/构建配置 hash 组成 ExecutionConfig。脚本变化重新校验，任意 shell 字符串不作为输入。

进程 API 的 cwd 和环境只是进程属性，不构成 OS 沙箱；默认继承的环境必须改为最小白名单。原 Java 方案示例为 [ProcessBuilder](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/lang/ProcessBuilder.html)，当前 TypeScript/Python 提案也不改变这一隔离要求；固定入口/参数数组、cwd 与超时不等于 OS 沙箱。

初版能力只注册 RUN_BUILD/RUN_TEST 两个已配置模板。默认超时 5 分钟、输出 4 MiB，截断后记录 truncated 和完整性限制；根据真实工具需要调整。测试结果保存基线 commit/changeset、测试配置 hash、实际 argv、exit code、输出与可得的测试清单；不因返回 0 就认定所有 required tests 都执行。

取消须管理进程树及身份（pid + 创建时间/执行记录），不能只 kill 一个可能复用的 PID。Windows 优先利用经验证的 Job Object 管理自启动进程组，并测试不允许 breakaway 的行为；这属于生命周期控制，不等同恶意代码隔离。[Windows Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)

实际进程与 OS 封装在 P19 按选定语言验证；若无法证明旧执行已停止，保持 QUARANTINED，不发新写权。未知代码要求真实隔离方案后才能支持，不能用“用户点了允许”扩大本模式的安全承诺。

2026-09-26 M06 开发自检：`CLI_RUN` 作为 `REAL`+`WRITE` 能力接入 Gateway（0030 登记，RUN 来源，绑定受管资源根为工作目录）。`cli-worker/cli-adapter.ts` 的 `executeCliCommand` 用 `spawn(..., { shell:false, windowsHide:true })` 与结构化参数数组执行（不接受任意 shell 字符串），`buildSafeEnvironment` 只透传系统必需变量白名单并显式剥离含 `KEY`/`SECRET`/`TOKEN`/`PASSWORD` 前缀及 `RELAY_`/`DATABASE_` 的项；输出按 `maxOutputBytes`（默认 4 MiB）截断并标 `truncated`，超时（默认 5 分钟）与调用方 AbortSignal 均经 `killProcessTree` 收敛，结果记 exit code/stdout/stderr/pid/durationMs/reason；`reconcileCliExecution` 以记录 pid 的存活判定核对——`STILL_RUNNING` 记 UNKNOWN 且 `quarantined:true`（无法证明旧进程停止即不发新写权），仅在确认停止后作已终结。`cli-worker/process-tree.ts` 在 Windows 用 `taskkill /pid <pid> /T /F` 终止整棵进程树、POSIX 先试组信号。`adapter-metadata.ts` 声明 CLI_RUN `approval_passthrough:false`（AUTO 降为 ASK）、`sandboxed:false`（子进程不是 OS 沙箱）、`resumable:false`（任意构建/测试不可盲目重放）。边界：本轮只落地适配器与 Gateway 分支并有 `cli-adapter` 单元测试（安全环境净化、退出码/stderr 捕获）；未采用经验证的 Windows Job Object 封装（现用 `taskkill`，不允许 breakaway 的行为未在目标 Windows 实测）、无固定 `RUN_BUILD`/`RUN_TEST` ExecutionConfig 模板与脚本/构建配置 hash 变更再校验、无真实 PG Gateway 的 CLI 反例（D07–D10/C06：孙进程、超时、输出过量、改脚本、环境凭据、非法参数、重启后迟到结果），真实 Windows 会话与独立验收后置。

## 6. 准入验收

D01–D11 全覆盖，另外验证：Git 外部 diff/hook 配置变化、CLI 输出过量/孙进程/超时、Web DNS 与重定向、变化集部分应用、远端状态变化、参数被当作选项注入。先 Fake 故障，再在一次性仓库与受控服务真实验证。未通过的能力保持 DISABLED，并在交付中明确未完成，而非计入完整 V1。
