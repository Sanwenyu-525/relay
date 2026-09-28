# 工具适配器与真实执行准入

2026-09-28 Windows 受管根登记身份增量：0038 将新登记资源的根卷号/File ID 单独留存，新 Windows `FILE_WRITE` 准备前必须与当前原生助手捕获结果相同；旧资源登记身份不可回填。0039 允许停用无占用旧资源后以同一路径登记新资源 ID，同时保持活动资源同项目路径唯一；历史动作与占用不改绑。助手不支持的目录仍可登记用于其他能力，但不开放新 Windows 文件写入。根普通目录在登记之后、动作准备之前被替换的真实 PG/Windows 反例已转为准备期 409，且不产生 Operation；现有准备后的 0036 冻结身份继续保护后续执行/恢复。含 0039 的确切桌面包 EXE SHA-256 `577a731e3022e540e38edc6a152301afc31b5a585e75eabb999919bbd5863efc` 已通过资源清单核验、旧 `PARTIAL` Windows Job 恢复链及 WebView2 冻结差异与身份提示复验，见 M06 增量 H。无回执的“助手完成后、保存回执前”强杀及 WebView2 处置已由同一确切包定向复验；MODIFY 换名空窗候选残留的确切包桌面同场景、人工交互与 M06 总验收仍待完成。下文 2026-09-27 段落保留当时边界。

2026-09-27 当前 Windows `FILE_WRITE` 开发状态：新 Operation 经 0036 冻结受管根、父目录链与目标的卷号/File ID，Worker 调用随包 Rust 助手执行捕获、写入和恢复核对；旧 Operation 缺物理身份不从当前磁盘回填。助手逐段相对持有的目录句柄打开，拒绝重解析、别名与硬链接；CREATE/MODIFY 用已写完并核验的暂存对象提交，MODIFY 不原地改旧文件，目标名抢占或任何提交后证据不明返回 `effect_uncertain`，Gateway 保持原调用 `UNKNOWN` 与资源隔离。单文件 1 MiB、最多 16 文件；新 `WRITE_FILE` 账本和冻结差异均用受管根相对路径，历史行保留原值。真实 Windows 助手 16/16、隔离 PG real-tools 49/49、迁移 8/8 已通过；新增反例证明 MODIFY 换名空窗强杀后旧内容备份和新内容暂存同时残留，当前尚无可安全自动处置的原调用证据链。桌面 Job 恢复链与 WebView2 自动差异页已按确切 release 包复验；人工交互和 M06 总出口另验。下文保留各阶段当时的实现与证据，不作为本段新边界的当前声明。

2026-09-27 增量 E 时点边界（历史）：M06 变化集证据账本增量 A 与固定图文件写意图增量 B 已通过各自定向独立复验，部分效果状态缺口也已修复；增量 C 提供原 Operation 的逐文件历史账本只读查询。增量 D 新增可信桌面 Job 停机证明、部分写入人工处置及 React Run 页入口，已完成分片开发自检和隔离 Windows Job 部分写入恢复复验。后续增量 E 为**新** FILE_WRITE 意图在准备时核验并冻结有界基线文本，以原 Operation 冻结的目标文本生成只读计划差异；旧意图不回填，缺证据明确不可用，不拿当前磁盘充当原基线。此新增差异已做真实 PG/HTTP 和 React 定向开发自检，**M06 总体仍为 IN_PROGRESS**。执行报告先在原 Invocation 上形成不可覆盖回执，恢复需同时核对冻结输入、回执与磁盘；图中的写意图在 DRAFT 后以冻结 `operation_id` 经 Gateway 执行，ASK/RESUME 不重建动作。部分文件已应用的动作保持 `UNKNOWN`、原资源隔离且在 Run 未决列表可见，账本 `PARTIAL` 不被后续观察覆写；全部文件确定无写入时才可 `FAILED` 并释放 claim。仅在旧 Job 可信停机、原调用与逐文件现状复核以及明确人工决定均成立时，处置命令才保留当前文件、结束旧 Run 并释放资源，原 UNKNOWN/PARTIAL 保留为历史。冻结根与父目录链接绕行已补反例；路径检查到实际 I/O 间仍有 Windows 父目录或目标替换竞争，可能导致根外写入或错误核对，是 M06 总出口的当前阻断，不能把前后路径核验视为句柄级约束。新 release 的真实 WebView2 自动化点击与截图检查已通过；人工交互及 M06 整体出口仍未验收，安装包总验收属 M07；隔离 Windows Job 的部分写入恢复和人工处置全链已通过，详见 [M06 复验记录](../testing/m06-independent-acceptance.md#增量-d真实-windows-job-部分写入恢复复验2026-09-27)。下方较早的开发自检文字保留其当时语境。

句柄级边界的候选、代价和 Windows 竞争反例见 [ADR-012](../decisions/ADR-012-windows-file-io-handle-boundary.md)（Proposed）；当前没有把方案当作已实现保护。

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

## 2. Files

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

2026-09-26 M06 开发自检：`GIT_READ`（status/diff/log）与 `GIT_WRITE`（stage/commit/push）作为 `REAL` 能力接入 Gateway（0030 登记，RUN 来源，绑定受管资源根为工作目录）。`git/git-adapter.ts` 的 `runSafeGit` 用 `execFile` 结构化参数数组（非 shell）、`GIT_CONFIG_NOSYSTEM=1`、`-c core.quotePath=false`、`-c diff.external=false` 与最小环境，禁用外部 diff；`gitStageFile` 拒绝 `.`/`*`/`..`（不允许隐式全量暂存），`gitCommit` 绑定预期 parent SHA（不匹配即拒），`gitPush` 拒绝以 `-`/`+` 开头或含 `:` 的 ref/remote（不开放强推/refspec/删远端），`reconcileGitCommit` 按预期 parent+message 只读核对 HEAD、`reconcileGitPush` 以 `ls-remote` 读回确切 ref 对象 ID（相同为 SUCCEEDED、否则 UNKNOWN，不默认重推）。`adapter-metadata.ts` 声明 GIT_WRITE `approval_passthrough:false`（AUTO 降为 ASK）、commit/push 可核对故 `resumable:true`。边界（2026-09-26 恢复类反例增量）：已有真实隔离 PG + 一次性测试仓库/本地 bare remote 的 Gateway 反例（`real-tools-gateway.integration.test.ts`）——GIT_READ status 以 AUTO 穿透真实执行、GIT_WRITE 非穿透强制 ASK、commit 绑定预期 parent（不符即 FAILED 且 HEAD 不变）、真实 commit/push 落库、`--force`/`+ref`/`-u` 等在 prepare 拒绝、push 崩溃于结算前后按真实 `ls-remote` 回读对象 ID 收敛（命中 SUCCEEDED 不重推，远端被外部推进后不匹配记 UNKNOWN 且阻断原 Run 再领取）。这仍属开发自检，不构成 M06 出口放行；重复动作幂等与审批内容变更（C03/C09/D02）专项反例、hooks/filter/credential helper 等真实可执行因素的信任审查、隔离 worktree 与共享元数据资源锁未实现，真实 Windows 会话与独立验收后置。

## 5. 受控 CLI

V1 明确采用受信宿主项目模式，不提供恶意代码隔离。固定程序真实路径/版本、参数模板、工作根、允许环境变量、凭据引用、输出上限、超时、网络能力声明与脚本/构建配置 hash 组成 ExecutionConfig。脚本变化重新校验，任意 shell 字符串不作为输入。

进程 API 的 cwd 和环境只是进程属性，不构成 OS 沙箱；默认继承的环境必须改为最小白名单。原 Java 方案示例为 [ProcessBuilder](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/lang/ProcessBuilder.html)，当前 TypeScript/Python 提案也不改变这一隔离要求；固定入口/参数数组、cwd 与超时不等于 OS 沙箱。

初版能力只注册 RUN_BUILD/RUN_TEST 两个已配置模板。默认超时 5 分钟、输出 4 MiB，截断后记录 truncated 和完整性限制；根据真实工具需要调整。测试结果保存基线 commit/changeset、测试配置 hash、实际 argv、exit code、输出与可得的测试清单；不因返回 0 就认定所有 required tests 都执行。

取消须管理进程树及身份（pid + 创建时间/执行记录），不能只 kill 一个可能复用的 PID。Windows 优先利用经验证的 Job Object 管理自启动进程组，并测试不允许 breakaway 的行为；这属于生命周期控制，不等同恶意代码隔离。[Windows Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)

实际进程与 OS 封装在 P19 按选定语言验证；若无法证明旧执行已停止，保持 QUARANTINED，不发新写权。未知代码要求真实隔离方案后才能支持，不能用“用户点了允许”扩大本模式的安全承诺。

2026-09-26 M06 开发自检：`CLI_RUN` 作为 `REAL`+`WRITE` 能力接入 Gateway（0030 登记，RUN 来源，绑定受管资源根为工作目录）。`cli-worker/cli-adapter.ts` 的 `executeCliCommand` 用 `spawn(..., { shell:false, windowsHide:true })` 与结构化参数数组执行（不接受任意 shell 字符串），`buildSafeEnvironment` 只透传系统必需变量白名单并显式剥离含 `KEY`/`SECRET`/`TOKEN`/`PASSWORD` 前缀及 `RELAY_`/`DATABASE_` 的项；输出按 `maxOutputBytes`（默认 4 MiB）截断并标 `truncated`，超时（默认 5 分钟）与调用方 AbortSignal 均经 `killProcessTree` 收敛，结果记 exit code/stdout/stderr/pid/durationMs/reason；`reconcileCliExecution` 只在 `DISPATCHING` 丢失结果这条恢复路径上被调用（pid 仅在结算时落库，崩溃-未结算路径无确定效果证据），因此一律保守返回 `UNKNOWN` 且 `quarantined:true`——缺 PID 记 `DISPATCHING_RESULT_LOST_NO_PID`，有 PID 则连同存活证据一并记录但无论进程是否已退出都不足以证明外部命令未执行或已知失败，绝不返回 `STOPPED`/`FAILED` 而释放资源。`cli-worker/process-tree.ts` 在 Windows 用 `taskkill /pid <pid> /T /F` 终止整棵进程树、POSIX 先试组信号。`adapter-metadata.ts` 声明 CLI_RUN `approval_passthrough:false`（AUTO 降为 ASK）、`sandboxed:false`（子进程不是 OS 沙箱）、`resumable:false`（任意构建/测试不可盲目重放）。边界（2026-09-26 恢复类反例增量）：已有真实隔离 PG + 真实子进程的 Gateway CLI 反例（`real-tools-gateway.integration.test.ts`）——CLI_RUN 非穿透强制 ASK、真实子进程 exit code/stdout 采集、`buildSafeEnvironment` 经真实进程验证剥离 `TOKEN`/`RELAY_` 前缀变量、deadline 到点判 TIMEOUT 而非挂起、超时经 `killProcessTree`（Windows `taskkill /T`）连带终止孙进程（父进程 spawn 长命孙进程并落 PID，断言超时后孙进程消失不残留孤儿）。这仍属开发自检，不构成 M06 出口放行；P1-1 修复已补真实 PG + 真实子进程反例：`CLI_RUN` 走 prepare→批准→`afterFakeEffect` 于真实写入后抛 `SimulatedGatewayCrash`→按原 Worker 身份 reconcile，断言 `reconciled=UNKNOWN`、claim `QUARANTINED`、再领取被 `GATEWAY_OPERATION_UNRESOLVED` 阻断，实证丢失结果不再错误开放后续执行（但 pid 仅在结算时持久化，仍在途运行的在途 PID 无法直接观测，`STILL_RUNNING` 分支不作单独断言）；未采用经验证的 Windows Job Object 封装（不允许 breakaway 的行为未在目标 Windows 实测）、无固定 `RUN_BUILD`/`RUN_TEST` ExecutionConfig 模板与脚本/构建配置 hash 变更再校验、输出过量/D07–D10/C06 其余反例未全，真实 Windows 会话与独立验收后置。

## 6. 准入验收

D01–D11 全覆盖，另外验证：Git 外部 diff/hook 配置变化、CLI 输出过量/孙进程/超时、Web DNS 与重定向、变化集部分应用、远端状态变化、参数被当作选项注入。先 Fake 故障，再在一次性仓库与受控服务真实验证。未通过的能力保持 DISABLED，并在交付中明确未完成，而非计入完整 V1。
