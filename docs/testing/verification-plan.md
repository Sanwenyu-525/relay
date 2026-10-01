# 测试、故障注入与发布出口

当前功能通过、未通过与未验收统一维护在[功能验收表](overall-acceptance-2026-09-28.md#当前功能验收表)。本页维护规格；下文既有运行数字为各自时点的历史样本，不作为第二份当前成绩表。原始输出保留规则见[文档规范](../README.md#6-验收结果与原始输出保留)。

日期：2026-09-19。状态：生产测试设计，尚未执行生产验收。业务场景编号以[契约包](../../contracts/README.md)的 A01–A09、B01–B08、C01–C09、D01–D11 为准，共 37 项。P00 已另行运行隔离实验，范围和结果见[实验记录](../research/p00-source-study.md)，不能据此将这 37 项标为通过。

## 1. 分层证据

| 层 | 方法 | 证明范围 |
|---|---|---|
| 领域 | 确定性单元测试 | 转移、验收条件、规则合并、资格判断 |
| 持久化 | 与部署同大版本 PG，独立 test DB | FK/唯一/CAS/锁、真正回滚、并发顺序 |
| 恢复 | Fake Adapter + 可控闩锁/断点 + 重启执行器 | durable 意图、UNKNOWN、迟到结果、幂等推进 |
| HTTP | 实际应用路由 + 测试身份 | schema、Problem Details、command replay、作用域 |
| UI | 组件测试 + 真实桌面壳与后端 E2E | Loading/冲突/接手/版本、重载恢复、窗口/DPI |
| Adapter | 临时仓库、模拟网络、受控进程 | 平台边界、执行证据与取消；不碰用户项目 |
| 发布 | 清洁环境安装/升级/备份还原 | 可运行交付与数据可恢复 |

Mock DB 不替代事务测试；固定 sleep 不作为并发顺序证明，使用 barrier/latch 控制两个连接的提交时序。可用 Testcontainers，也可显式测试 PG；不能自动连接生产 DB 或把缺环境的测试静默跳过后宣称全绿。

## 2. 37 项责任映射

| 验收编号 | 主要提示词 | 验证方法 |
|---|---|---|
| A01、A02 | P02、P07、P12 | 类型化 State 命令、过期提案与同 ID 重放 |
| A03 | P02、P03、P10、P11 | 重开/替代后投影和 Context 失效，历史保留 |
| A04 | P06、P10、P11 | HARD 交集、偏好覆盖和冲突 |
| A05 | P04、P14 | 切换 kind 前后 Run contract hash 不变 |
| A06 | P10、P11、P17 | 更新网页/文件后可定位旧实际片段 |
| A07 | P13 | 时区/午夜/Later 重启，Pin 不越权 |
| A08、A09 | P02、P05 | Inbox 人工可用，Delegate 无 Project 拒绝，Goal 子集 |
| B01 | P05 | 两 DB 连接竞争 Delegate，最多一个 live Run |
| B02 | P07 | Review 决定不改变 executor |
| B03、B04 | P08 | 控制持久化、控制/完成双提交次序 |
| B05 | P08、P16、P19 | 旧写入结束/核对前不 Handoff |
| B06 | P05、P08 | 终态再试新 Run、retry_of 正确 |
| B07、B08 | P08、P09 | 跨 Task 资源争用、旧 epoch 提交拒绝 |
| C01、C02 | P03、P06、P07 | 换验收/版本不继承 PASS/批准 |
| C03、C09 | P07、P09、P18 | 目标变更和批准重放、占用恢复 |
| C04 | P06、P07 | required HUMAN 未决不完成 |
| C05、C06、C07 | P06、P17、P19 | 论断无支持、测试删减、checker ERROR、HARD 不可豁免 |
| C08 | P11、P15 | 证据版本不被当前正文替换 |
| D01、D02、D03 | P08、P09 | PREPARED/DISPATCHING/SUCCEEDED 各断点恢复 |
| D04、D05、D06 | P03、P06、P08 | PASS 后崩溃、完成事务注入失败、响应丢失 |
| D07 | P09、P19 | 租约过期仍有进程，不授予新冲突写权 |
| D08、D09 | P16、P19 | 脚本变更、链接/环境/参数范围 |
| D10 | P16 | 外部编辑与多文件部分应用 |
| D11 | P17 | 重定向/DNS 指向受限网络 |

## 3. 故障点接口

仅测试 profile 注入：BEFORE_INTENT_COMMIT、AFTER_PREPARED_COMMIT、AFTER_DISPATCH_ADMIT、AFTER_EXTERNAL_EFFECT、AFTER_OUTCOME_COMMIT、AFTER_PASS_COMMIT、DURING_COMPLETION_TX、AFTER_COMPLETION_COMMIT。生产构建不开放 HTTP 触发故障的接口。

Fake Adapter 用独立持久效果日志表达“外部已发生”，不能与业务 DB 同事务回滚，否则无法模拟真实裂缝。计数器证明调用次数；证据记录证明恢复不是靠重新执行得到结果。杀进程类测试记录退出点与恢复数据库，不能只抛异常充当所有崩溃场景。

数据库约束测试必须尝试真实错误写入，包括 NULL 绕 CHECK、跨 Task FK、延迟 FK 在 COMMIT 失败、重复周期完成、QUARANTINED 占用、双批准消费。

## 4. 额外产品与安全验收

桌面 UI 与受控测试客户端同时编辑（不要求产品多窗口）；HTTP 超时后查回执；旧查询结果不能覆盖新数据；无 Project 的人工事项；纯展示切换；Review 页面加载后目标过期；Assist 切页后迟到响应；明文凭据不进入日志/Trace/产物。

中文基础搜索、信息版本和 Decision 替代、Goal 显式空集、Focus 无候选、产物 Lineage 循环拒绝均需对应单测/集成测试。来源不可用必须清晰错误，不用假数据填补。

2026-09-26 M05/P13 后端开发自检：`apps/api/test/integration/today.integration.test.ts` 使用隔离 PostgreSQL 与真实 HTTP 覆盖 Task 计划元数据、Workspace 级选择版本、跨午夜与 DST 的 Later、进程重启/命令重放、阻塞 Pin、Goal 显式空集、不同保存时区 Focus、同项目多 Task 排序及跨 Workspace 拒绝，6/6 通过；迁移 7/7、CLI 5/5，API TypeScript 构建和文档检查通过。该证据只覆盖后端开发自检，不代表 M05 独立验收或 Windows 桌面验收。

UI 视觉、组件状态与可访问性按[设计系统验收](../frontend/design-system.md#8-验证与交付边界)核对；token 的纯色组合检查只是静态证据，不能代替桌面 WebView 字体、窗口/DPI、键盘与辅助技术验收。

能力配置中 AUTO 不代表任意调用免检查。测试应覆盖连接存在但 DENY、批准已给但权限被撤销、配置更新使旧脚本授权失效，以及伪造外部文本要求扩大权限。

Schema readiness 使用真实 PostgreSQL + 应用角色 HTTP 测试：`/health/live` 在空库仍为 200；`/health/ready` 维持 Bearer 边界，并分别覆盖空库、缺最新迁移、完整当前清单、数据库账本出现未知未来迁移、已应用摘要不匹配，以及 schema 查询失败后数据库已断开的复核。数据库不可连必须是 `DATABASE_UNAVAILABLE`（`schema=unknown`）；数据库可连但兼容检查失败必须是 `SCHEMA_UNAVAILABLE`（`schema=down`）。检查不得执行 migration，应用角色直读台账仍须返回 42501，只允许读取受限兼容视图。

## 5. 阶段出口

- A：人工闭环真实 PG/API/桌面窗口可运行，启动连接、版本/完成/重开/幂等通过；浏览器页面不能单独代替交付。
- B：Fake Worker、验证、Review 完整走通；没有真实工具副作用。
- C：控制/恢复/Gateway/资源互斥与关键故障点通过，才能接真实执行。
- D：真实模型、Context、长期信息、Today、三套工作台与审计；首批 Skill、最小第一方 Pack、基础 Eval 与轻量来源视图按第 8–9 节验收；模型失败路径同样通过。
- E：四类适配器在受信边界内真实验证；禁用的承诺功能计为未完成，不静默缩小 V1。

Git读取另覆[机器协议/扩展边界](../../apps/api/test/unit/git-adapter.test.ts)：真实暂存/未暂存列、空格/中文路径与NUL重命名、unborn/detached、完整patch尾换行、textconv/external diff/fsmonitor程序不运行且index不变；clean/process拒绝，实际无匹配与配置/启动/取消故障分开。submodule仅核对gitlink commit，不进入nested工作树，未覆盖内容不得称全树干净。[Gateway原集合](../../apps/api/test/integration/real-tools-gateway.integration.test.ts)保留真实回执operation/invocation身份和已知FAILED，原写入审批/commit/push/UNKNOWN与CLI进程树仍回归。结果只归功能验收表；本规格不代表HTTP/UI协议或支持外部filter仓库的完整出口。
- F：OpenAPI/实现一致、安装/升级/备份还原演练、全部 required 场景证据齐全；研究实验另行报告。

每份报告写 commit、依赖/DB 版本、运行命令、通过/失败/跳过原因与证据路径。失败或未运行仍是未完成；不要以测试数量取代对应不变量证明。

## 6. TypeScript-first 冻结前 Spike

状态：完整出口尚未通过。本节为 [ADR-006](../decisions/ADR-006-typescript-first.md) 的验证规格，不是完成成绩；2026-09-20 起补齐的独立准备实验及实际覆盖范围见 [P00 研究记录](../research/p00-source-study.md)。原有 Pi/LangGraph/Rig 实验不能证明 TypeScript + AI SDK + PostgreSQL 组合通过。

### Spike 1：审批后跨进程恢复

使用真实 PostgreSQL、AI SDK 边界和可控模型/WRITE_FILE Adapter。完整工具请求及规范化参数、逻辑动作 ID、Review 绑定保存后退出 Worker；重启 API/Worker，批准原 Review，由新 Worker 继续原步骤。

通过条件：

- Review、原模型请求/响应与待执行动作可恢复；不重跑已完成模型轮次来重新生成工具参数。
- 两个批准请求/两个 Worker 竞争时，批准最多消费一次、领取唯一；正常已知结果路径只产生一个效果。
- 参数、目标基线、权限、验收或执行权变化后拒绝旧批准；消费后但执行前崩溃能按原身份核对恢复。
- 批准消费与效果落库之间各断点转入 Spike 2 协议；不以“批准已消费”推断工具成功。

映射：B02、B08、C01–C03、C09、D01–D03。真实 PG 验证事务；模型 Fake 的范围必须单列。

### Spike 2：外部成功但结果未落库

受管临时文件写入已成功，在 AFTER_EXTERNAL_EFFECT 强制退出进程，保留独立效果日志；新 Worker 从持久化 Invocation 恢复。可在后续安全准入完成后扩展临时 Git 仓库，不为 Spike 提前开放真实项目 Git/CLI。

通过条件：

- UNKNOWN 先核对原动作 ID、资源、目标基线和效果证据，不再次执行、不更换 Adapter/动作 ID。
- 已证明成功只补记结果；能证明未发生才允许按契约恢复；证据不足转 Review/暂停等待人工，不能标记 COMPLETED。
- “目标内容相同”不足以证明本次动作造成该结果；覆盖外部编辑、部分写入、冲突和证据缺失。
- 租约过期但旧 Worker/子进程仍可能写入时保持资源隔离；旧 epoch 结果不能覆盖新执行者。

映射：B07–B08、D01–D07、D10。报告分别记录调用次数、效果次数和业务提交次数，不用队列投递语义宣称任意外部效果 exactly-once。

### Spike 3：Provider 可替换性

相同 Task、Context、工具 schema 和验收条件，分别接入 OpenAI 与另一 Provider/本地兼容模型。两个端点都真实运行才证明适配性；缺少端点或凭据记未验证，Fake 只证明协议逻辑，不在文档保存凭据。

通过条件：

- Domain/Workflow 不因 Provider 更换而修改；转换和特殊能力只在 Adapter；用相同工具语义验证，不要求生成内容完全相同。
- 流式文本、完整工具参数及输出校验正常；半截参数、断流、非法 JSON/引用、拒绝、超时、取消均进入有界 typed failure/既定恢复路径。
- 结构化输出失败不执行工具、不误报 PASS；新模型尝试独立记账，不重新执行已有未知动作。
- 两 Provider 的 schema 子集、用量缺失、调用 ID 与必要恢复元数据有明确映射；不承诺等待中的 Run 可随意换 Provider。

映射：A06、C05–C08，并补充 ModelPort 兼容测试。

### 共同冻结门槛

三个 Spike 是必要证据，仍须补真实 PG 的 B01 并发 Delegate、B03–B05 控制/完成竞争、迁移并发及历史内容校验、应用角色权限、bigint 无损映射、schema 兼容和同事务 Repository 测试。SSE 引入时验证鉴权、断流/背压和 GET 重建；中文搜索使用短词和混合文本样本。

性能报告按[技术选型](../architecture/技术选型.md)同时列 API/审批分位延迟、事件循环延迟、整体 RSS、吞吐及数据库竞争；测试前明确工作量和预算，当前预算数值待确认。API/Worker 分进程须比较总资源，不只报告其中一个进程。新包版本以锁文件记录；没有 Git commit 时记录输入文件摘要，不伪造提交号。

## 7. Windows 桌面交付验证

状态：完整出口尚未通过；2026-09-20 的最小宿主局部实测见 [P00 研究记录](../research/p00-source-study.md#最小-windows-桌面宿主实验)。依据 [ADR-007](../decisions/ADR-007-windows-desktop.md)；这组验证补充交付和宿主边界，不替代上面的三个业务 Spike 或 37 项验收。

P00 先做隔离最小桌面 Spike：随包 Vue、Node API 与 Fake Worker，从打包产物验证启动/鉴权/退出，不等待 P20 才发现运行时无法分发。真实安装、签名及最终业务回归在 P20 完成；Fake Worker 不证明业务恢复正确。框架版本、Node 打包方式、Windows/CPU 与 WebView2 版本写入证据。

| 场景 | 必须证明 |
|---|---|
| 安装与运行前提 | 干净 Windows 能安装并从入口打开独立窗口；无开发 Node/Rust 环境仍运行；WebView2/PG 缺失有明确引导 |
| 启动身份 | 端口冲突、伪造 readiness、错误实例、重复启动不会连接陌生服务；短期 token 不出现在日志/URL/持久存储 |
| IPC 与 HTTP | 未授权窗口/frame、远程导航、非法 IPC、错误 Host/Origin 与无令牌请求被拒；生产 CORS/CSP 在真实 WebView 中成立 |
| 重载与服务失败 | 窗口重载重新取得连接；服务退出/重启显示错误并轮换凭据，保留原命令回执查询，不重复执行 |
| 退出与恢复 | 有草稿、有在途写入、停机超时、壳/Worker 强杀与系统退出路径；不误记完成/取消，不因旧进程租约到期释放资源 |
  | 窗口交互 | 自定义标题栏左侧无历史禁用、应用内后退/前进、Ctrl+K 搜索复用、项目上下文新建任务及草稿离开保护；中间空白拖动/双击、右侧按钮最小化/最大化/还原/关闭及草稿关闭保护；贴边、边框缩放、窄工作区、多屏/DPI、200% 内容缩放、中文输入法和键盘焦点。浏览器辅助链接默认不可见且不可命中，Tab 显示、Enter 聚焦主内容 |
| 性能对照 | 相同 UI/工作量下比较 Tauri+Node 与 Electron；列冷启动、总进程树 RSS、PG 占用、API p95/吞吐、安装大小，不仅测空壳 |
| 升级与卸载 | 运行中升级先安全退出；schema 不兼容停止；卸载保留独立 PG/用户数据；备份可恢复 |

Windows 进程树终止、孤儿检测、支持版本、签名与杀毒软件影响均须实际记录。未测平台不宣称支持，未签名测试包不宣称正式签名发布。截图或 Vite 开发服务器成功不能替代安装产物证据。

M07 维护准入首片按 [ADR-014](../decisions/ADR-014-database-maintenance-admission.md) 验证数据库级 NORMAL/DRAINING：真实 PG 独立连接覆盖 SHARE/UPDATE 两种提交顺序、等待后回执重读、原命令重放/异载荷冲突、CAS/锁超时整事务回滚；跨 Workspace 同门，普通命令与两类自定义接受拒绝时零业务效果/回执。新 Run/Assist/Web 与无原 delivery 的 Gateway 领取保持原待处理身份；已取得原领取的结算、发布和 Saver 不误挡。新 VERIFY 预约被拒时零调用记录/外呼，已经预约的原探针可结算，Run/Assist 原计量预算回归。停止/取消、原停机证明恢复和 UNKNOWN/PARTIAL 安全终结沿原门禁；正常 GET/SSE、readiness 和旧回执可读。CLI 重启持久、缺状态行/权限失败关闭、应用角色不能 INSERT/DELETE/改身份列，错误输出不含配置明细；中文维护拒绝不覆盖响应丢失核对规则。DRAINING 不等于 FROZEN，完整快照静止、备份/还原和旧二进制升级分别另验，实际结果只写功能验收表。

维护原宿主停机另验真实 Windows Job 与私有管道：旧包缺能力声明在执行前拒绝；已有 guard 忙时零 READY，真实 API/Worker/孙进程整组停止且原 ARMED 保留；READY 期间第二入口仍忙，原 nonce release 与 EOF 释放，坏记录/版本/字段/过界或部分帧拒绝。Node 握手后收到协议错误即持续失效，RELEASED 后非法帧加退出0也不能输出释放成功；CLI 尾随/重复/过界输入拒绝成功，错误路径释放自身 guard，不使用或输出 DB/模型凭据。真实进程句柄与 Job 检查必须独立于响应 JSON；debug EXE/native-test-package 组合不当作完整包、GUI、跨登录会话或数据库静止证明。

Windows 受管内容安全点按 [ADR-015](../decisions/ADR-015-managed-content-native-publication.md)另验：实际原生共享发布阻挡排他，排他期间各 ManagedContentStore 调用零part/目标；共享/排他helper退出后 OS锁确实释放。真实写part后、rename前强杀原helper，不得由Node继续发布；保留原证据，新版本正常发布。不可覆盖、字节/hash/256KiB、根/祖先junction及多链接sentinel、缺helper失败关闭回归。真实PG人工提交在冻结时零版本/审计/回执，解除后按原命令重试及旧回执重放；原Run发布失败保留原effect/operation的UNKNOWN，解除后核对不得换ID。CLI准确输入/EOF正常释放、尾随/超界输入拒绝成功、协议失效不因exit0变正常。完整数据库/Saver冻结、旧二进制停机及备份/恢复另验，不继承本片成绩。

本库权限/DDL组合先用原角色机制探针验证：CONNECT撤销COMMIT后原app连接仍能实写、新连接拒绝，而migrator原/新连接及完整dump可用；持原两把会话advisory锁跨COMMIT后，观察两个原DDL入口真实锁等待，显式释放才结束。控制app成员继承及grant-option漂移，bootstrap不收敛，预检/有效权限复核须拒绝；原有效ACL刷盘后故障断开维护连接，已提交撤销继续保留，并依据原ACL恢复。dump/空库restore机制不代替完整角色预检、残余连接/prepared transaction拒绝、持锁生命周期与备份/恢复协调CLI，后者另验；结果仍仅写功能验收表。

生产数据库连接维护另以[实际入口集成测试](../../apps/api/test/integration/database-connect-fence.integration.test.ts)验证：真实Application切DRAINING并关池；原grant option与完整有效ACL精确恢复、不重写凭据；新app42501而受信migrator dump可用；两个原DDL入口跨COMMIT阻塞，锁忙有界且不泄部分锁。NORMAL、旧空闲app/Saver/migrator、权限/成员/额外CONNECT漂移和真实PREPARE后断连均拒绝。授权后启动窗口使用唯一application_name、未登记datid及目标对象锁观测；普通角色看不到其他用户类型也不能漏检。文件已存在/链接/损坏/目标错配拒绝，撤销前的外部ACL变更不被补偿覆盖；解除与显式恢复遇ACL漂移均拒绝。验证实际CLI的release/EOF、尾随/超界输入、READY前坏帧、强杀及已验证backend断连，撤销持久与原凭据幂等恢复，不输出凭据或误报released。管理员仅控制临时库生命周期/故障；测试用prepared槽不修改用户PG。整体备份协调、新包Windows和恢复放行另验。

维护连接回归覆盖备份attest/应用Pool、源fence hold/recover及新空目标隔离：合成PGHOST/PORT/USER/DATABASE/PASSWORD/SSLMODE/OPTIONS/CLIENT_ENCODING不改变显式目标及缺省会话设置；密码缺省不回退pgpass，缺省端口固定5432。实际Client/Pool无网络参数对比显式远程/TLS/options与旧ssl=no-verify，未知SSL字符串拒绝，query不能替换构造器/内部连接/时间预算或再解析connectionString。真实PG仅在产品调用期间改环境，观察前恢复，核对源完整ACL恢复/原journal不变及目标42501/关闭后仍隔离；显式只读options必须仍拒权限写入。真实备份组合保留Job、全归档与故障断言，native guard忙不能算成功或被绕过。TLS字段对比不声明真实TLS握手/证书验收，旧冻结结果不覆盖新连接代码。

备份文件与原包内部入口另验：原样保留已引用/orphan正文、staging与ARMED，证据目录不进入活动启动路径；未知条目/非空未受管缓存、目标占用、原生链接/ADS、预算超界、目录/字节漂移及持锁断言失效均拒绝且不删原文件。固定系统元数据进程只读JSON路径，不继承DB/Provider环境。包资源与实际清单一一对应，协议/Node版本正确，EXE及所有资源hash一致；旧包缺导出拒绝，归档完整历史Skill/Pack正文和依赖需能重建原hash，同ID/version的原包定义不被协调应用新版覆盖。导出后改包、缺成员/正文、重复身份、错误hash和超时/输出超界拒绝。小资源fixture不证明完整发布包、数据库静止或恢复可启动。

[完整备份组合](../../apps/api/test/integration/backup.integration.test.ts)另验真实原生Job停止及持续guard、原包helper内容锁、独立migrator连接门同时存活，DB引用与复制hash一致，业务/Graph完整归档可在随机空库读取核对；正常释放后才有complete标记且保持DRAINING。正文不一致、无原停止证明的过期Worker或独立旧连接拒绝；不改原身份、不杀陌生进程。实际CLI在CONNECT撤销COMMIT后强杀，留partial/原ACL凭据、无成功输出，显式原ACL恢复幂等，父管道EOF后native确实退出。协议错误早于owned close也应等待close后拒绝。历史人工关闭另用[真实Owner回归](../../apps/api/test/integration/backup-history.integration.test.ts)核对PARTIAL/NO_RECEIPT原UNKNOWN保留，精确处置+stop proof+RELEASED claim才排除当前写者，缺任一证据仍拒绝。取得fence前真实准入revision变化或同名私有空库替换时，初始/最终目标与原准入动作须精确相符，漂移不得生成成功标记。PG归档另验真实regular fd、8表逐行对照、占用/失锁/在途Abort；子进程退出不自动等于PG backend消失。确切发布包、恢复隔离/兼容/放行与安装总验收另验，成绩只写功能验收表。

恢复启动隔离另验[Node真实入口](../../apps/api/test/unit/restore-isolation.test.ts)与[Rust宿主入口](../../apps/desktop/src-tauri/src/restore_isolation.rs)：标记为空/损坏/伪造成功JSON/目录/链接均拒，元数据错误及文件祖先不误作缺失；无标记首次安装与目录别名保持可用。普通/桌面API、Worker、普通/桌面监督器在数据库连接、监听、ready、旧launch核销前拒绝，固定错误不泄露正文；桌面API拒绝后自然退出。Rust监督器在源ARMED消费、新Job目录与spawn前拒绝，原bytes/条目数不变；实际链接类型与权限不足的未覆盖分支分别说明。包诊断另验缺协议/旧协议、未摘要绑定的模块、任一个Node入口脱线或旧EXE，即使hash更新自洽仍拒作目标运行包；保留旧包历史诊断。标记不代表在线停机、目标CONNECT隔离或产品restore，空库还原/失败保隔离/原UNKNOWN与Graph正文核对另验，不把内部fixture当完整发布包。

新空库还原另验[目标隔离入口](../../apps/api/test/integration/restore-database-isolation.integration.test.ts)、[PG完整还原](../../apps/api/test/integration/restore-postgres.integration.test.ts)及[实际备份到还原组合](../../apps/api/test/integration/restore.integration.test.ts)。目标须为不同源身份、标准角色/PG18且无用户对象、额外schema/setting/extension、残余/启动连接或prepared事务；初始及权限COMMIT前后复核，失锁/断连/ACL或原凭据漂移拒绝，成功/取消/close不恢复CONNECT。包含系统schema的用户对象、原本机CIDR地址、与旧源journal互斥回归；旧源fence仍恢复原ACL。

[源根只读保护](../../apps/api/test/unit/restore-source-root.test.ts)使用真实助手核对完整File ID；原根、现存子目录、大小写别名及同卷搬迁的源祖先须拒绝，原ARMED/目录条目不变；合法异根不创建条目。非法ID、真实junction/缺父、错误或缺工具、环境helper/Node注入及取消均拒，子进程不继承凭据或任意环境工具。产品组合对原/搬迁源根验证拒绝发生在任何目录或CONNECT变更之前；源删除重建/跨卷移动后的选址仍属于可信运维前提，不以历史ID断言完整源路径隔离。末段另在真实PG连接和pin凭据都已关闭后换向restore目录，要求原根无新增verified且不报告成功，不能把未注入的EPERM当作该反例通过。

归档固定原hash/TOC/PG18工具、裸dbname及最小环境，完整单事务保留原Owner/ACL。核对public/Graph每表逐行、原UNKNOWN operation/run/step/attempt/dispatch_count、确切正文/孤儿与历史定义；不能因还原调用模型或重派发。错元数据/hash/tool/TOC、非空冲突、真实catalog锁阻塞后的Abort回滚均拒绝，PGbackend退出单独观察。组合中新根发布前已有刷盘标记，源staging/ARMED仅进入evidence；已占根不覆，篡改正文/自洽重hash但缺迁移或revision错配在修改目标前拒绝。真实CLI在CONNECT撤销后强杀须留标记/专用journal，无verified或成功输出，原数据/原ACL不变。成功也保持隔离，核对凭据不授予启动；确切发布包、激活/配置切换、旧包升级与Windows安装仍另验，实际成绩仅归功能验收表。

M07非空恢复维护核对规格归[专用会话集成](../../apps/api/test/integration/restore-check-database-isolation.integration.test.ts)、[材料单元](../../apps/api/test/unit/restore-materials.test.ts)及[实际备份/还原组合](../../apps/api/test/integration/restore.integration.test.ts)。既有journal只读pin/原字节与File ID、实际目标六字段、完整fenced ACL、精确DRAINING revision、两把锁/残余或启动连接/prepared事务均须匹配；取消、断连、失锁、ACL/准入/材料漂移拒绝，不写ACL/准入/journal，关闭实际完成后才宣告closed。受控状态连接另覆合法URL省略端口/密码时不继承合成PG环境，纯参数反例不得访问其他实例，真实SQL只读拒绝零行UPDATE。

[目标包离线依赖探针](../../apps/api/test/unit/restore-runtime-probe.test.ts)另验普通完整生产依赖及包内Node：10项直接依赖声明须为确切版本，实际metadata/ESM入口与每个传递ESM/CJS加载文件绑定资源hash，不借祖先node_modules。真实内存调用覆盖参数解析、Client/Pool与Saver/模型构造、Kysely SQL编译、TypeBox与Fastify inject、LangGraph本地图和JSON解析；不连接PG、不监听或调用模型。反例覆盖缺文件/绑定、版本或hash漂移、错误行为、非法声明/UTF8、中文跨stdin帧、外部解析及独立DNS/子进程/Worker入口；真实挂起、超输出和取消必须在自己的child实际close后拒绝。实际维护函数和CLI使用完整普通生产依赖目录，分别断言有限报告的Node/metadata/直接入口绑定，同时保留全表/UNKNOWN/材料与隔离断言。仅证明PACKAGED_DEPENDENCIES_OFFLINE_ONLY；真实数据库Saver、模型/工具及全部历史执行兼容仍待验，历史source包核验不新增此探针要求。

受管资源根身份观察另验真实Windows普通私有根：存量原生File ID匹配、同路径替换后ID不同、同卷搬迁的新路径/旧路径、大小写别名、合法null基线及链接/祖先junction拒绝。报告仅为MATCH、NO_STORED_ID、ID_MISMATCH或UNAVAILABLE；粗ROOT_UNAVAILABLE不推断路径缺失。固定目标包助手不带managed-content参数，核对其SHA及普通文件身份，环境限五项OS变量；128根上限、30秒合作预算和单次10秒预算、输入/输出上限、取消与故障均检查actual child close。持锁前后及末段包/材料复核保留，观测绑定此次选定状态SHA与资源Owner字段/revision/epoch，不补写资源ID。实际PG组合的源夹具经既有登记Owner创建三种私有根，null仅在初始fixture中设置合法存量字段，并在备份快照前完成；函数及CLI报告须一致，根正文与目录项（无新sentinel）、所有数据库行/UNKNOWN/ACL/准入/材料均保持。加强before夹具后重跑完整八项，不继承历史成绩；有限根身份不证明外部内容、全外部资源、配置或唯一Owner，不清除EXTERNAL_RESOURCE_LIVE_IDENTITY pending或授激活。

材料覆盖六文件跨绑定、严格UTF8/预算、wrong version/operation/目标、凭据多字段、重hash不能改ARMED路由、same-byte leaf替换与真实junction/hardlink/ADS。产品组合使用真实备份与隔离还原后运行维护函数及实际CLI，原备份路径移走仍仅声明stored binding；public/Graph全表原行、正文/evidence、原UNKNOWN身份/dispatch_count、六材料字节及源数据不变，目标app仍42501、普通启动仍拒绝、无活动ARMED。首次允许创建锁sentinel，再次核对保持其身份；篡改标记/正文拒绝且不放行。输出限定SELECTED投影/NOT_GRANTED、native/PG实际关闭后报告，不把全表测试比对等同生产核对全历史内容。完整兼容、外部身份、激活和安装另验；实际成绩仅归功能验收表。

## 8. Relay Skill 与蓝图应用验收

2026-09-20，待执行的补充规格。依据 [Skill 专题](../architecture/relay-skills.md)，在 D 阶段验证 F24；不修改既有 37 项编号，也不把新增场景称为已通过。V1.5 Page Schema 与第三方包不纳入 V1 实现测试。

| 场景 | 必须证明 | 证据方法 / 关联 |
|---|---|---|
| Onboarding 与目标歧义 | 无模型可手工创建；歧义有澄清；拒绝/失败保留最小项目；不创建虚假 Run | Assist Fake + UI；A08 |
| 输出与模板边界 | 错误 schema、未知页面/筛选、脚本/SQL/远程引用、非法阶段被拒；合法内置模板可预览 | schema/registry 单元测试 + HTTP |
| 作用域与指令注入 | 非授权资料不可读；资料/Skill 不能删 Mandatory、授予权限；Preview 不发工具动作或加载候选 URL | Context/Gateway 测试；A04、A06、D11 回归 |
| 预览与分别接受 | 预览零业务写入；显示配置应用不启用 Rules、不改活动 Run contract；后续 Rule 接受仍触发原失效协议 | UI + 真实 API；A01、A05、C01–C03 |
| 修改与过期 | 改候选/选中项后旧 hash 不可接受；State/View/Goal/资料/规则变化使旧提案拒绝；切页迟到结果不落新项目 | HTTP + PG 竞争；A02、C08 |
| 原子应用 | 在新 Task、State、View 与回执写入之间注入失败，所有效果均回滚；Next Action 引用正确创建的 Task | 真实 PG 故障注入；D05 |
| 并发与重放 | 相同/不同 command_id 竞争同提案只应用一次；人工编辑/归档与接受竞争不丢更新；响应丢失查回执不重复创建任务 | 两 DB 连接 + barrier；D06 |
| 版本与追溯 | v1 应用后发布 v2 不改旧项目/Run；同标签不同内容拒绝；旧定义缺失或禁用明确报错；来源可追溯到候选、Manifest 与效果 | 注册表/存储集成；A03、C08 |
| 验证与执行边界 | 结构通过不算 Task PASS；Worker 不能改有效 CheckPlan；Skill 升级不绕过原 UNKNOWN 核对 | Verification/恢复 Fake；C06、C07、D01–D03 |

P12/P14 实施报告必须附真实 schema/OpenAPI/迁移版本与上述证据。输出大小上限、历史定义存储及锁落点尚待冻结；文档链接/token 检查只能证明静态文档通过，不能替代本表。

### 首批闭环 Skill 的补充场景

三项既有 Skill 的真实模型 opt-in 组合见 `real-model-skills.integration.test.ts`：仅有效显式模型配置启用，缺失/Fake/残缺配置须全部跳过，不启动 API 或外呼。使用隔离合成项目，经 HTTP 冻结 Skill id/version/SHA 与事实基线，由原 Assist Owner 生成；待接受前 Task/验收/Project State 不变。任务契约及验收方案按原 payload hash、Task/验收双 revision 人工接受，同原命令重放只产生一次业务效果，旧必需条件、其他产物约束及执行权保留，不创建 Run、PASS 或完成。恢复摘要只引用当前事实与 revision，比较基线为空、零提案、只读。每项沿原唯一真实 call 核对配置指纹、request ID、实际用量及输出 hash；严格 schema 失败须保留首轮分母与失败，不拼成单轮全绿。实际结论只见[功能验收表](overall-acceptance-2026-09-28.md#当前功能验收表)，本组合不替代 Skill UI、长期质量或 Windows 验收。

依据[首批目录](../architecture/relay-skills.md#7-首批闭环能力与后续目录)，以下均待执行。首批四项在 D 阶段交付；修复、交接、状态提交复用 B/C 阶段核心测试再回归，不能推迟既有核心安全出口。

| 场景 | 必须证明 | 对应依据 |
|---|---|---|
| 契约与验收准备 | 提案未接受不得充当有效契约；未知 checker、缺必需能力、删 HARD 或接受过期验收均被拒；检查方案在 Delegate 前确认冻结 | A04、C01、C06–C07；P06/P12 |
| 组合确认与委托 | 提案接受成功而 Delegate 冲突时显示真实状态；命令重放不重复应用或创建 Run | B01、D06；P05/P12/P14 |
| 项目恢复 | 重开 Task、已替代 Decision、撤销验证不再算当前有效；来源不可用可见；无比较基线不编造变化；摘要不写状态或自动启动 | A03、A06、C08；P11/P12/P15 |
| 定向修复 | 固定失败项和产物/验收版本，保护用户修改；新版本不能自动继承旧 PASS；ERROR 重试 checker，耗尽预算进入原 Review | B06、C01–C02、C06–C07；P05/P06/P12 |
| 交接包与执行权 | UNKNOWN/旧进程未停止不显示已接手；模型说明失败仍可完成安全控制并提供事实包；Review 不转 Owner；接手后重新 Delegate 新建 Run | B02、B05、B08、D07；P08/P12/P14 |
| State 更新 | 模型自称 deterministic 的补丁不直写；PASS 未业务提交不显示已完成；完成事务失败无部分 delta，重放不重复；阶段/风险推断单独确认 | A01–A02、D04–D06；P03/P06/P12 |

P07 开发自检使用真实 PostgreSQL 与 API 进程，新增针对 Review 的 C02/C04/C09、A02 局部用例：同版本人工证据生成后继 PASS、旧会话保留、切换当前候选后拒绝旧决定、预算上调有界且供 VERIFY 使用、State 提案基线冲突及与类型化 State 命令争同一 revision、操作拒绝后不派发下一步；真实 API 进程重启后仍可读取并决定原 Review。P07 当时尚无 P08 安全控制与 P09 实际批准消费；当前 P08 的开发自检见下段，完整桌面验收仍需单独执行。

P08 开发自检在 `apps/api/test/integration/recovery.integration.test.ts` 使用真实 PostgreSQL、真实 API 子进程及独立 Worker 子进程：控制意图先 PENDING、冲突/显式 supersede、PAUSE/Resume 与 Task WAITING 对齐、AI CancelTask 202 与人工 cancel 200、控制在 Fake 发布派发前后到达、控制与完成两种提交顺序、旧 epoch 拒绝、未决 UNKNOWN 阻止 Handoff。故障点覆盖派发后无目标、发布成功后步骤未提交、fence 已提交而核对前再次退出，以及成功日志对应目标文件丢失/损坏；恢复必须持有旧进程已停止的可信依据，检查持久 fence/attempt 身份，并复用原 operation_id。独立 API 进程重启后仍能读取 PENDING；旧 Worker 子进程退出后，新 Worker 子进程扫描并处理原动作。HANDOFF 测试分别核对有候选版本和无候选版本的确定性事实引用。`pnpm --filter @relay-agent/api run test:integration` 在临时 PG 18.6 上为 137/137，构建/PG 启停与临时目录清理均成功；这是开发自检，不是正式验收。

P08 批次效果适配器仅为同机受管 Markdown 文件发布，不能以这些 P08 用例声称真实模型、Gateway、权限撤销或通用跨 Task 工作目录资源排他（B07/D07 的全量场景）已通过。扫描是内部显式调用，没有生产调度器；旧进程停机依据由内部调用方提供，没有生产进程管理器自动证明任意进程已经退出。目录项断电持久性、孤儿文件自动报告/清理和 Windows 桌面端到端行为仍需各自验证。

P09 的 `gateway.integration.test.ts` 在真实临时 PostgreSQL 上覆盖：Connection/Capability/Permission 分离，默认无权，AUTO 与 ASK，Review 两次并发决定、批准后新 Worker epoch 和旧 Worker 拒绝，USER_IMPORT 的真实 Job 来源与 ASK 决定；authority 撤销和 Admit 两种提交顺序，跨 Workspace 的父子资源根争用恰一方持有；直接 SQL 非法来源、跨 Project 引用、claim token、Review/Operation 错配和 Fake 配置含凭据均被约束拒绝。Fake 效果在 Admit 后崩溃、PREPARED 停机后同 ID 重试、DISPATCHING 目标缺失保持 UNKNOWN、内容篡改隔离、控制先到抢占、RUN/USER_IMPORT 换 intent 绕行阻断均有定向用例。真实 API 子进程覆盖配置命令回执/重放/版本冲突/404 隔离、资源目录移除后原命令重放和两次 Invocation 历史读取。P09 阶段定向 13/13、API 单元 57/57、完整 PG 集成 150/150；构建、PG 启停、临时目录清理及文档检查通过。此为开发自检；不代表 B07/D07 对任意外部进程、junction/别名、真实 Web/Git/CLI 或正式桌面验收已通过。

P10 开发自检在 `information.integration.test.ts` 的真实 PostgreSQL 上覆盖四类类型化事实与不可变版本、Memory 显式确认、Decision 替代历史/环和跨范围拒绝、ArtifactVersion 提升并发幂等与直接 SQL 跨范围约束；HARD Rule 冻结到 Delegate/CheckPlan、上层冲突、同层 PREFERENCE 冲突、缺失 PRE_ACTION 与 Fake SEMANTIC 路径拒绝，以及 Rule mutation/Delegate 两种 authority 锁提交顺序。受管效果已发生后 Rule 更新仍登记原结果，下一步被栅栏阻止；Gateway 已准入 Invocation 的结果也可登记，新动作拒绝。中文 1–2 字、`%` 字面查询、Workspace/Project 范围和排序游标分页使用真实查询；API 子进程覆盖命令回执重放与范围隔离。定向 P10 7/7、Gateway 回归 14/14，完整真实 PG 集成 158/158，API 单元 57/57；构建、类型检查、PG 启停、临时目录清理和文档检查通过。`rule_revision` 为 Workspace 级保守栅栏，无关 Project 更新也可使旧 Run stale。P10 当时 Knowledge/Memory/Decision 尚未成为自动 Context 输入；P11 已另以 `context_revision` 接入，不能把旧 P10 数字当作 P11 结果。URL/PDF/向量、真实语义检查器与大数据量搜索性能留后续验证。

P11 `context.integration.test.ts` 使用真实临时 PostgreSQL 和受管 Artifact 文件：覆盖中文标题字面命中与同范围最近资料补位、实际片段与全文 hash/UTF-8 范围（包括 surrogate 边界）、Fake DRAFT 消费；必需 Context 超预算不写成功 Manifest、可选来源按预算裁剪并记录原因；信息版本变化、Project 修订及装配/提交竞争不提交过期快照，DRAFT 前重建，旧 Manifest 留作历史；Memory 到期、Knowledge 归档、Decision 替代、跨 Project 请求和受管文件损坏在历史读取时重新过滤。已发布候选的 VERIFY/COMPLETE 沿冻结契约和当前 Gate 判定，资料或 Task 修订不抹掉真实效果证据；修正回路重新 BUILD_CONTEXT。定向 P11 9/9、Verification 回归 24/24、既有 Run Steps 6/6；完整真实 PG 集成 167/167、API 单元 57/57，构建、类型检查、PG 启停、临时目录清理与文档检查通过。这些是开发自检，不是正式验收。`selection_reason` 区分标题字面命中与最近资料补位；补位上限 3，总 Relevant 上限 10，均是确定性有界降级，不是语义相关性。P12 接真实 Provider 前需补显式选择并复核最小必要输入，避免将无关近期资料外发。当前未运行真实模型、Assist、Skill 注册表或真实 token 计量，不能据 Fake 路径推断这些能力已验证。

`apps/api/scripts/run-integration.ps1` 在单个临时 PostgreSQL 数据库内串行运行测试文件：并行文件共享数据库，而已有并发回归用例会临时全局切换 `tasks` 的 RLS 策略；文件并行会让无关用例短时看不到 Task。这只隔离测试文件，不改变产品运行时的并发假设；各用例内部的双命令竞争仍并发执行。

后续候选落地时另验证：AI 生成的 Decision 理由不编造来源；Next Action 不绕过资格或虚构时长；Artifact 的智能提升建议后置不影响已有显式提升幂等测试。P10 已覆盖用户显式 Decision 替代无环和 ArtifactVersion 显式提升幂等；未实施候选不作为本轮功能成绩。

## 9. 扩展组合与版本评测

2026-09-20，待执行。依据[扩展模型](../architecture/relay-skills.md#8-可组合扩展模型)。V1 为实际交付的 Skill 和第一方 Pack 提供工程回归用例，不依赖可选论文任务 P22，也不建设通用评测平台。现有 B/C 核心测试继续作为前置，不以 Pack 演示取代它们。

| 层次 | 最低验证 | 证据要求 |
|---|---|---|
| Contract Eval | 输出 schema、注册引用、版本完整性、模板/检查器兼容 | 固定样例覆盖合法、缺字段、未知引用、循环依赖、同 ID/version 不同摘要、不兼容宿主与超预算；错误不得改 current 绑定 |
| Behavior Eval | Permission、Scope、Mandatory、领域 Owner、应用及恢复边界 | 选择 Pack 不授权/激活规则；Profile 不删约束；Projection 不改 Today 资格；模型输出不触发隐式应用；真实 PG 验证必要原子性与重放 |
| Outcome Eval | 质量、错误接受/拒绝、首轮及最终完成率、修正/人工介入、耗时和用量 | 固定独立 rubric/案例版本；区分内部 Verification 结论与独立评价，保留失败、超时、缺失用量及分母 |

每次版本比较固定输入/资料快照、案例/rubric、模型/工具配置、执行预算和比较条件；记录 Skill/Pack/Profile/Recipe/检查器版本及摘要、实际 Manifest、尝试与结果。为隔离修改效果尽量保持其他变量一致；若改了评价标准，旧新结果不可直接比较，需用同一标准重新评价。随机模型按预先确定的重复次数报告分布，阈值/样本量在运行前确定，当前尚未冻结；不能运行后挑成功样例或宣称已证明“没有退化”。

候选包携带的 Eval Cases 是测试输入，不是自我认证：发布方控制必要的独立基准，Skill/Worker 不能删改；导入的用例不能执行任意脚本或绕过 Gateway。程序性安全/契约失败阻止受影响定义启用；质量退化按预先标准处理，证据不足标未验证。Fake 只证明流程/边界；真实模型回归在独立测试项目与受控资料上进行，缺合法端点时明确未执行，不用 synthetic 成绩冒充结果。

2026-09-26 第一段开发自检：`apps/api/test/unit/first-party-skills.test.ts` 覆盖定义依赖内容摘要、未知 Pack 成员、三类输出的严格字段/大小/引用/检查器边界；`apps/api/test/integration/assist.integration.test.ts` 在隔离真实 PostgreSQL 覆盖普通 Assist 回归、Skill 冻结/命令重放/首次结算、生成本身不写 Task、跨 Workspace/来源撤销、历史读时脱敏、Project Resume 新鲜 revision 与撤销/旧验收 Verification 排除。该批当时只属于首批三项 Skill 与两份只读最小 Pack；第二段 Task Owner 接受见下段，Blueprint/Pack 应用、真实模型质量和独立验收仍未覆盖。

2026-09-26 蓝图开发自检补充：`apps/api/test/integration/view-configuration.integration.test.ts` 检查独立 View CAS/重放/跨范围/页面解析；`apps/api/test/integration/project-blueprint.integration.test.ts` 在隔离真实 PostgreSQL 检查 USER_DRAFT 候选的 Goal/Task/State/View 同事务效果和映射、重复接受、跨 Workspace、未知字段/零效果、View stale 无局部提交，`goal-to-project-blueprint` Assist Skill 的冻结来源、同候选 Apply、生成基线竞争 typed FAILED、取消零候选、来源归档后 GET 隐藏与 Apply 拒绝。定向复跑结果：Blueprint 5/5、Assist 29/29、migration 8/8、CLI 5/5、Skill 单测 5/5；0024 View 1/1 在 0025 后的真实 PG 迁移链上通过。类型检查、API 构建、Graph 安装与文档检查通过，临时 PostgreSQL 均已清理。这些开发自检不构成独立模块、真实 Provider 或 Windows 桌面验收。Pack 1.3.0 只作精确来源清单，不能将选择等同配置效果。

2026-09-26 M04 Provider 开发自检补充：`model-endpoint-policy`/`openai-compatible-model-port` 单测用受控 SSE transport 覆盖 endpoint 解析、同源/路径、DNS 复核、重定向、完整 `[DONE]`、片段合并、结构化 JSON、usage 缺失、取消、超时、断流与单次预算；`model-call-budget.integration.test.ts` 在隔离真实 PostgreSQL 覆盖 Run DRAFT/SEMANTIC 共享额度、AssistSession 双 Worker 竞争、STARTED 与历史未知用量、实际用量超预留、网络调用在短事务外、额度耗尽时 Run 明确失败。Context 定向回归区分 Mock 最近来源补位与真实模型排除，并由模型端口拒绝升级前旧 Manifest 的该来源。定向结果：Provider/配置单测 10/10、预算 PG 5/5、Context PG 13/13、迁移 PG 8/8、CLI PG 5/5、Mock Run Steps PG 8/8、Assist PG 29/29；API 类型/构建、Graph 安装与文档检查通过，临时 PG 均清理。本片未连接获授权真实 Provider，也未证明 socket 与 DNS 预解析同地址、兼容端点全部 schema、前端首 token 反馈延迟或全 M04 出口。

第二段开发自检针对 0023：真实 PostgreSQL 定向回归 Task/acceptance 双版本 CAS、同命令回放与并发不同命令、仅人工持有及活动 Run/历史 UNKNOWN 阻断、跨 Workspace 与撤销来源、已确认 required criterion 和 Expected Result 原约束保留、新描述受控合并、旧验证适用性撤销与非 Run OPEN Review 过期、审计故障下业务/提案/回执整体回滚；HTTP 回归预览、缺 CAS 拒绝、接受最终结果与 replay。纯输出测试涵盖 Task Definition 1.1.0 的描述约束、Verification Plan 1.1.0 只追加检查，原版本摘要保留。CheckPlan GET 只核对当前准入预览的来源 revision/hash，不能当成冻结 Run 或执行过的 PASS。仍需独立模块与 Windows 桌面验收，且不据 Fake 模型回归宣称真实 Provider 质量。

额外组合验收：

- 第一方 Thesis/Development Pack 只引用已交付成员；清单全部可解析，缺能力清楚显示，不产生假成功。
- 旧版已应用且用户手改后，新模板预览能识别冲突；拒绝更新保留原配置；不同包的 HARD/DENY 不被加载顺序覆盖。
- 配置/规则应用按真实事务边界报告结果；规则变化影响活动 Run 时走原失效控制，不能展示无影响；响应丢失使用原回执。
- 历史定义保留及旧记录无 Pack 来源可读取；包/模板升级不改历史 Run/Manifest，不用新版顶替旧依赖。
- 来源视图取实际输入，读取时鉴权；无权对象的名称/ID/数量不可见，撤销权限后历史正文不可读，缺失证据不由新正文替代。
- 配置恢复走新 revision 和当前合法性检查，不恢复审批/PASS/执行权；重放在隔离环境进行，不重发真实已完成或 UNKNOWN 副作用。

V1.5 Importer、自动 Trigger、完整 Inspector 与 Project Checkpoint 的运行验证随对应功能另补：特别覆盖仓库指令不执行、重复触发去重和检查点恢复冲突。当前记录设计边界，不计为 V1 已实现或已验证。P12/P14/P15 提交基础证据，P21 核对实际交付版本及上述回归；论文扩展仍按[实验协议](../research/评价协议.md)独立确认。


## 10. 技术栈改造的大模块验收

日期：2026-09-23。角色：M01–M07 的验收规格；本节没有测试通过结论。执行包见 [大模块提示词](../../prompts/stack-migration.md)，目标技术取舍见 [ADR-010](../decisions/ADR-010-agent-stack-react-desktop.md)，当前状态只维护在 [CODEX_NEXT_STEP](../../CODEX_NEXT_STEP.md)。

### 10.1 模块状态与独立验收

状态为 NOT_STARTED → IN_PROGRESS → READY_FOR_ACCEPTANCE → ACCEPTED；问题进入 CHANGES_REQUESTED，缺必需外部条件记 BLOCKED。修复后重新提交验收，不保留已失效的通过结论。这是项目文档状态，与 Codex goal 工具状态无关。

具体代码、测试和修复由执行者完成。协调 Agent 在执行者自检之后独立核对当前输入文件基准、运行结果和关键反例，复跑必要检查，不能复制执行者总结充当验收。每个模块通过后才推进依赖它的模块；普通出口通过自动继续，不另设例行用户审批。必须关闭所有影响模块要求的缺陷；范围外问题明确登记，不能用低优先级标签掩盖必需能力缺失。

每次验收只更新[功能验收表](overall-acceptance-2026-09-28.md#当前功能验收表)中受影响的行，简记模块/范围、commit 与受影响的未提交差异、命令/退出码、环境、结果及未运行项。默认不新建验收报告、不导出全仓 SHA 清单、不入库完整过程日志；重要故障才在已有根因记录保留必要片段或归档引用。没有可用 commit 或需独立绑定发布产物时，仅对必要受验对象使用摘要。数据库测试仍使用隔离实例/数据，并简记清理结果；历史成绩不自动覆盖本次代码。输出保留统一按[文档规则](../README.md#6-验收结果与原始输出保留)，本页只维护规格。

### 10.2 M03 必需可靠性场景

| 编号 | 触发与反例 | 必须观察的结果 |
|---|---|---|
| G01 | Mock 创建 Task/Run 后关闭页面/API 重启，再查询与订阅；同 Key 同/异载荷 | 已受理任务不丢失；同载荷回执一致、异载荷冲突；可靠事件连续重放且客户端去重 |
| G02 | 审批暂停、重复批准、参数/目标/hash/权限版本变化 | 等待无 Worker/模型槽占用；新 resume command；副作用不重复，过期批准拒绝且不能绕过恢复 |
| G03 | 工具效果完成后、检查点/业务结果提交前强杀 Worker | 使用原 operation_id 核对；不能幂等且结果不明时保持 UNKNOWN 和资源隔离，不自动换 ID 重发 |
| G04 | API/分发器/Worker 重启、领取后通知丢失、重复分发 | PG 的 command/outbox 找回未完成指令；数据库幂等裁决，不依赖进程 Map 或通知唯一历史 |
| G05 | 同 thread 双 Worker、租约过期/续租失败、旧 Worker 迟到 | 最多一个有效 invocation；fencing 拒绝旧写，新效果停止；旧进程停机未知时资源不能假释放 |
| G06 | 用户取消、取消与完成竞争、在途模型/子进程 | 意图持久化并传到真实执行端，停止后续步骤、收敛状态可测；已发生效果保留，取消终态不可复活 |
| G07 | 无 Bearer、错误 Host/Origin、跨 workspace/project ID | Run/SSE/审批/产物/文件均不可越权；无客户端 actor 冒充，无密钥 URL、日志或持久前端存储 |
| G08 | SSE 补历史/实时竞态、跨提交事件顺序、大输出、失败与预算耗尽 | 每 Run seq 与提交顺序一致；漏通知仍补查；只有持久数据拥有可靠 ID；快照/最终消息可校正尾部增量 |

0013 Review/RESUME 顺序片的定向反例还须拆开两种旧 START 竞跑：审批在 VERIFY 等待安全点与旧投递结清之间提交，以及旧 Worker 在写出 Review 后、结清前退出并由监督器重排原 START。两者都必须观察旧 START 不执行审批后的 COMPLETE；新 RESUME 仅在前驱 DONE 和 invocation IDLE 后领取。另验证 ordinal 前驱阻塞、Review/业务状态/RESUME/outbox/回执故障回滚、同 `command_id` 重放唯一决定、过期或拒绝不入队、ACTION_APPROVAL 在正式图/Gateway 节点接入前被固定 Worker 排除。该片通过也只覆盖 G02/G04/G05 的这些运输边界；图检查点、在途取消、真实工具与完整 G01–G08 仍需后续独立反例。

0013 独立审查补充：已批准的 ACTION_APPROVAL 在 PAUSE 后被拒绝，原 deferred RESUME 必须与 operation/Run/control 同事务撤回，Review/operation 身份留存；故障注入 outbox 更新时全部业务变化回滚，后续手工 RESUME 不受旧 ordinal 阻塞。旧 START 遇批准后紧接 PAUSE/CANCEL/HANDOFF，待处理控制必须先于 `COMMAND_SUPERSEDED` 获得安全点。批准到期、Connection 停用、Permission 版本变化在 Gateway claim 前拒绝；claim 后至 Admit 前撤权，若未创建 Invocation/效果则释放同 epoch Worker claim，控制可撤回原投递；DISPATCHING/UNKNOWN 保持隔离，不把 lease 或拒绝错误当旧动作停止证据。以上均需真实隔离 PG 反例，拒收前日志与新修复日志分别冻结。

LangGraph/PostgresSaver 分片须从独立 migrator 安装后才允许 Worker 领取：缺 schema、损坏 Saver 列或错误版本应在 claim 前失败；runtime 不获 DDL/台账写权，两个安装进程串行。固定图的每个 `advance` 节点只调用一次业务步骤；仅 OPEN 验证 Review 可保存 interrupt，原决定 RESUME 才唤醒，终态恰在预算边界不能误标 BLOCKED。真实 PG/独立 Worker 故障点分别覆盖 WAITING_APPROVAL 业务提交后且 interrupt 前退出、interrupt 已持久但旧 START 未结清、RESUME claim 后且恢复 checkpoint 前退出，以及受管效果业务提交后且图 checkpoint 前退出；恢复保留原 command/Review/attempt/operation 身份并核对 Artifact 版本唯一。PAUSE→恢复等待→批准的旧 START 仍须先结清，不能让后继 RESUME 越序或由旧 START 执行获批步骤。旧 epoch 在业务节点提交后、写正常 checkpoint 前失效时不能继续写正常后继 checkpoint。该片证据不替代 G06 在途取消、ACTION_APPROVAL 工具节点、任意外部效果或 Windows 组合验收。

后续固定 Mock Gateway 图动作片须用真实 PG 与独立 Worker 分别证明：可选 Delegate 工具意图只在 DRAFT 后/PERSIST 前进 Gateway；ASK 的旧 START 在批准前和快速批准竞跑时只结清，只有原 Review/operation 绑定的 RESUME 派 `WRITE_MARKER`；DENY、到期或准入前 Connection/Permission 撤销不派效果且 Run/Task 明确收敛。旧 P07 预留 operation ID 的 APPROVE/DENY 和 P09 直接 Gateway 仍保留原决定/直接动作，但无冻结 Mock 意图就不能产生固定图无法消费的 RESUME；同 Run 另一 operation ID 即使配上重算的 Review 目标/hash，也不能冒充冻结动作。批准后效果前、Fake 写入后而数据库结算前、Admit 后目标缺失、业务效果提交后而图 checkpoint 前各窗口按原 operation/Invocation 身份核对，UNKNOWN 不换 ID 重发；旧 ACTION RESUME 不得唤醒后继 CRITERION Review。内层 Gateway claim 的租约与外层 invocation 分别验证：用真实 PG 的短租约在 Admit 后阻止 adapter，在 Fake 写入后失租则原 Invocation UNKNOWN、资源 claim QUARANTINED；两者都不能因外层 heartbeat 仍活跃而误记 SUCCEEDED。PAUSE/CANCEL/HANDOFF 与权限拒绝竞争以已持久控制优先；外层 invocation ACTIVE 时控制保持 PENDING，结清后自动应用，结清与应用间退出由重启 supervisor 的 PG 扫描补偿；双 Worker 只能有一个有效外层/内层 Invocation。冻结 Mock APPROVE 后控制撤销的 outbox 故障注入必须使 operation/Run/control 同事务回滚，不能用无图命令的直接 Gateway 用例代替。重复 `command_id`、并发不同决定、目标/参数/hash/策略版本、批准到期、受管目标损坏和 Workspace 隔离仍应结合既有 P09/0013 与本片反例核对，不能凭直接 Gateway 单测宣称图组合通过。后续 G03 查询片已将 Gateway UNKNOWN 原 ID 投影到 `readRunById.unresolved_operation_ids`，仍须核对刷新后的用户可见性；G06 在途模型取消与完成竞争不由本片覆盖。

固定 Mock 图还须区分 Task 状态修订与 Context 输入变化：ACTION 审批/RESUME 只改状态时，已成功 BUILD_CONTEXT/DRAFT 的 Attempt ID、key 与 Manifest 保持不变；标题、验收版本、Project 或长期来源在 ASK 等待期间变化时，Gateway Admit 在 Fake 写入前拒绝旧操作并保留原 `operation_id`；效果成功后、候选发布前来源变化不得重做草稿。直接 P09 Gateway 不以 M03 固定图 Manifest 作为准入前提。

G01–G08 必须使用真实 PostgreSQL、实际独立 API/Worker 和可控 Mock Model/工具。所选方案为 PG 分发，因此本阶段不虚构 Redis 断线测试；未来若引入 Redis/BullMQ，必须另加 Redis 停机/丢消息后由 PG 重分发的实测出口。测试还须覆盖既有 A01–D11 中受改造影响的不变量。新增场景不得代替旧业务回归。

M03 Task 产物历史增量另以真实隔离 PG 核对：空 Task 为确切空列表，跨 Workspace Task 404，同 Workspace 跨 Task 不串数据；同 Task 多个 Artifact 各自 v1、同 Artifact 不可变版本与 revision、当前完成指针接受旧版而最新为新版、重开后仅当前接受集合清空。无 Bearer 拒绝读取。浏览器刷新后重新建立内存连接，从服务端恢复既有版本并向原 Artifact 追加版本；项目“当前选用”与 Task“本轮接受”分别标注，刷新不自动勾选最新版作为待接受版本。查询失败时保留草稿并阻止 create/complete。该增量的开发自检见 [任务产物证据](../../apps/workbench/results/m03-task-artifacts-evidence.txt)，不替代真实 Windows 发行包或完整 G01–G08 验收。

### 10.3 前端、真实模型与最终交付

M02 按旧→新路由/组件/真实交互覆盖表验收全部 React 迁移。组件和 Chromium 结果只证明各自层次；Windows 真窗口需运行真实 API 人工闭环、中文 IME、键盘、长文本、DPI/缩放、鉴权引导、单实例和进程生命周期。M07 才将安装、升级/卸载、干净环境、强杀恢复与数据保留纳入最终放行；能打开开发窗口不等于安装通过。

M04 在 M03 独立验收后才启用真实 Provider；记录模型/配置、实际来源选择、工具/结构化输出能力、用量与未知用量、错误和取消。至少一个实际获授权 Provider 的真实闭环是模块必要出口；历史两 Provider 对照要求保持单列，不用一次成功宣称全部协议兼容。缺凭据为未验证，不能以 Mock 顶替。

2026-09-29 的历史真实模型用例覆盖显式选源 DRAFT 与完成门、HARD SEMANTIC、生成中取消及中途 abort；当时只检查选源 Manifest 和非 Fake 候选，没有断言候选原样回显随机标记。后续强化该证据须沿原 call_id 核对实际持久 Manifest、来源确切版本、完整正文 hash，再检查候选回显资料中的唯一标记，不能将新增断言追溯算入旧成绩。当前成绩与真实 Windows 定向闭环统一见[功能验收表](overall-acceptance-2026-09-28.md#当前功能验收表)；用户授权的真实外发仍限隔离数据，SOFT SEMANTIC 维持 Fake。Provider 失败必须区别实际服务故障、受控 SDK/本地 HTTP 与 Fake 反例；诊断设计见[Assist 失败记录](../development/ui-live-integration-2026-09-28.md#12-m04-assist-provider-失败诊断2026-09-30)和[Run 诊断记录](../development/ui-live-integration-2026-09-28.md#14-m04-run-模型调用诊断与本地错误归因2026-09-30)。一次真实成功不替代能力/质量、工具组合或完整 Windows 状态矩阵。

M04 FILE_READ/WEB_FETCH 模型输入切片的定向自测还需分别核对：AUTO 在 DRAFT 前取得原 `SUCCEEDED` Invocation，模型调用记录的 `input_sha256` 与原 operation/invocation 身份可重建；ASK 等待时零 DRAFT Attempt/模型调用，原 Review 的 RESUME 仅执行一次；读取后、图 checkpoint 前崩溃沿原动作核对并复用成功证据；默认 DENY/撤权/Context 失效、控制意图或 UNKNOWN 均不把正文交模型。文件超限与网页非 2xx 等类型化 `FAILED` 应保留原 Invocation/operation 失败证据、停止 DRAFT 模型调用，并将 Run 及 Task 安全收敛。长 UTF-8 文本既要按完整字符限 16 KiB，也须计入 Manifest 总预算和输出预留，超预算时缩小读片段或停止 DRAFT，不能绕开预算。升级前已成功 DRAFT 且原读 Review 待续的 Run 应保持原 DRAFT/operation 绑定、不重做模型。Mock/隔离 PostgreSQL 定向通过仍不替代真实 Provider、Windows 会话或 M04 独立验收。

真实读源组合仅使用临时合成文件和自有 HTTP 服务；本机网页的 `allow_private` 必须在该隔离 Connection 显式声明，不修改生产默认 SSRF 门禁。沿 HTTP Delegate、原图命令和人工 Review 完成入口，验证原读 Operation/Invocation 唯一、模型调用绑定的实际 Manifest 与可重建输入 hash、候选原样回显正文中的唯一标记及用量，接受前零完成、之后唯一完成。标准回归缺真实模型配置应跳过，不自动花费模型调用。

模型原生工具参数的能力拒绝由[受控 SDK/PG 矩阵](../../apps/api/test/integration/model-provider-faults.integration.test.ts)构造合法 SSE `delta.tool_calls` 分片，经过真实 Adapter 和 Assist Owner；应以 `ModelToolOutputError` 结清原调用、Provider 类别为空，且无 Gateway 动作、回复正文、提案或残留预览。它不是 Provider `PROTOCOL`，也不证明原生工具执行已接入。拒绝时保留此前确实观察到的请求 ID/合法用量，不携带原生工具参数、正文或原始响应；未知值保持 null。当前 SDK 在流结束时才发规范化用量，拒绝前未读到的 wire usage 不能算已观察；已知用量分支用公开 SDK stream 的受控 chunk 和错误封套落库分别验证。首文本/预览发生后再遇工具拒绝，应删除暂存但保留原调用的观察时间；空 ID 不写为空字符串。不得由这些拒绝测试推断真实服务行为或计费为零。

M05/P15 后端定向回归覆盖：0021 对 Workspace 初始化、Goal 创建及清空 Focus 的历史审计归属回填，孤立行使迁移整体回滚；Activity 按 Workspace/Project/Task/Run 和时间过滤、`(created_at,id)` 游标续页、跨域 ID 隐藏、命令重放不新增审计、业务回滚不留事件、自由字段/凭据不出 DTO；Trace 只展示原 Step/Attempt/模型调用/Manifest/验证/Review/Gateway/效果证据，当前来源权限变化后失效，不泄露原正文或越权引用，批准和效果状态保持分离；Lineage 的自环、跨域、版本环及错误 typed 关系由数据库拒绝，重复写只留一条，源缺失时保留不可用状态而不替换历史父版本。对应真实隔离 PostgreSQL 自动化仅证明开发切片，M05 独立与 Windows 工作台验收另行执行。

完成凭据详情增量在既有人工完成与自动验证测试中补充定向反例：真实 API 对 HUMAN 完成返回原验收版本、人工判断和原接受产物，不把同 Artifact 新版替代旧版；重开后凭据仍可读但 `is_current=false`；跨 Workspace ID 为 404、错误 Bearer 为 401；受管内容删除后原版本项标 `UNAVAILABLE` 且隐藏 ID/hash。自动 PASS 的真实 PostgreSQL 完成闭环从同一 CompletionRecord 读取原 Run/VerificationSession、verdict、适用性和原产物。读取不写业务事实；异常引用只可显式不可用，不推断当前完成。此增量仍需 M05 独立及 Windows 工作台验收。

M05/P14 Workspace 列表后端定向回归覆盖：Project `active/archived/all` 默认与显式过滤、State 阶段/Next Action 确切投影、全 Workspace Task 对 Project/Inbox/终态的覆盖、跨项目 blocker 不串值、跨 Workspace 不泄漏、缺省 Task 过滤仍拒绝、混用过滤拒绝、limit 上界与游标绑定。对相邻 PostgreSQL 微秒时间的项目和任务逐页检查无重复/漏项；换 Workspace 或状态复用游标返回 `INVALID_CURSOR`。`api-lists.integration.test.ts` 走隔离 PostgreSQL 和真实 HTTP；开发自检不替代 M05 独立或 Windows 工作台验收。归档写命令及归档后写权限协议另片设计。

M05/P14 归档写保护 A 段以 `project-archive-gate.integration.test.ts` 在真实隔离 PostgreSQL/HTTP 验证：手工设置归档字段的夹具下，各类关联写命令返回 `PROJECT_ARCHIVED`、跨 Workspace 继续隐藏，Workspace Rule 和历史读取不受单个 Project 影响；Project `FOR UPDATE` 先到时并发 Task 写等待后拒绝，业务写 `FOR KEY SHARE` 先到时归档行锁等待其提交；Artifact 请求在受管文件发布之前被拒，未登记版本，也不留下文件。B 段 `project-archive.integration.test.ts` 以真实归档 HTTP/PG 反例覆盖作用域/CAS/回执与审计单次、历史可读/新写拒绝、HUMAN 与 AI Run、未决 Gateway/UNKNOWN/资源 claim、Import/Assist/STARTED 模型调用/OPEN Review，以及写者先持栅栏、归档先持排他锁两种次序。模型预约补测 Project 栅栏与 STARTED 插入相对归档的两种顺序，并让旧终态 Run/Step 路径确认不能在归档后外呼 Provider。两段定向通过仍只是开发自检；独立与 Windows 桌面验收后置，涉及旧包升级、故障后核对的真实会话仍须另验。

M04 Assist `DISCUSS` 临时草稿的开发自检使用 `assist-live-preview.integration.test.ts` 的隔离 PostgreSQL 和独立 API 进程：首片段在完整消息结算前可读，累计 revision 支持重读；Workspace/Session/Message 与 Bearer 作用域不能串读；取消、Provider 失败、来源撤销、租约过期隐藏并清理暂存；结构化提案不暴露未校验 JSON，完成仍回到原消息投影。`assist-live-preview.test.ts` 核对 16 KiB UTF-8 完整字符截取、拆开的 surrogate 与更新节流；模型端口单测证实普通 DISCUSS 在 SSE 完成前回调片段、结构化 Assist 不回调。首次 PG 用例因夹具把 Project 会话误用 TASK 专属 `PROPOSE_CANDIDATE` 而 4/5，修正为合法 `PROPOSE_TASK` 后定向复跑 5/5；新增失败/取消竞态反例后最终定向 6/6、既有 Assist 回归 29/29、草稿与端口单测 6/6，类型检查与构建通过。上述只证明受控 Fake/transport 的开发路径，真实 Provider 网络、前端轮询首字延迟、Windows 桌面及独立验收仍待运行。

M04 Run DRAFT 临时草稿的开发自检使用 `run-draft-preview.integration.test.ts` 的隔离真实 PostgreSQL、受控 Fake 生成与独立 API 进程：DRAFT 完整候选提交前可读首批 Markdown，重读保持 Attempt/claim/model call/revision 身份；尚未生成 Artifact；跨 Workspace 和错误 Bearer 拒绝；成功结算删除草稿。fence 旧 Worker 后迟到写入被拒，新领取只能以新 claim/model call 发布。待处理控制、Task Context 变化或已选 Knowledge 退役时，读取立即遮蔽前缀且不回显来源 ID。实际 AUTO FILE_READ/WEB_FETCH 图链在 DRAFT 模型 STARTED 时分别证明原读证据仍可授权预览，FILE_READ Policy 随后撤销时 GET 即时隐藏；读动作先将 Run 置 RUNNING 的情况现在由原 Run CAS 把 current_step_id 推进 DRAFT。共用 `AssistLivePreviewPublisher` 的单元测试覆盖 16 KiB UTF-8 安全截取及节流；端口受控 SSE 单测覆盖完整输出前 DRAFT 片段回调。定向结果为预览 PG/HTTP 5/5、实际读链补测 2/2、撤权 1/1、Run Steps 8/8、完整 Run Graph 53/53、相关单测 7/7；项目 Node24 类型检查/构建、29 个迁移、Graph 安装、PG 启停与临时目录清理、文档检查通过。首轮新增来源测试 3/4 是把只读遮蔽误断言为业务 STALE_RESULT 的测试错误，修正后 4/4；首轮 Graph 47/53 的 6 个读链失败已由上述 Run 位置修复并复跑 53/53。真实 Provider 网络首字延迟、桌面流畅度、独立验收仍待运行；Run SSE 仍仅是事实提示，文字预览走单独 GET。

0047 首输出计时的回归检查原 `model_calls`：首个非空回调才记录 `first_text_delta_at`，同原调用首次合法预览写入与 `first_preview_persisted_at` 在同一事务；后续片段不覆盖，清预览后保留，旧行不回填。空帧、首字前取消/失败、控制请求、旧 Worker 与错误 call 身份不得补写；Run Trace 的真实 HTTP 响应保留可空字段，旧客户端兼容。普通 Assist 的最终 flush 顺序保持原语义。Windows [定向脚本](../../apps/desktop/tests/m04-real-model-webview.mjs)只将此前授权项目配置的模型白名单键复制到新隔离会话，以合成资料来源标记和普通 Assist 两轮历史取证，不复制业务数据库配置。绑定原 DRAFT call/Manifest/来源版本与正文 hash，人工接受前零完成记录，之后唯一完成记录；第三轮以明确字面量提出类型化任务，待接受不得写业务，UI 接受与同原命令重放应返回同回执，只新增 HUMAN/INBOX Task 而不委托。该第三轮不代替第二轮不重供标记的历史检索反例。窗口正文进入视口并经动画帧观察的点击延迟与上述服务端时间分别报告；标题栏自然退出及原进程树、PG、临时目录均须清理。实际结果见[功能验收表](overall-acceptance-2026-09-28.md#当前功能验收表)，脚本存在不代表已经通过。

性能分别报告 Mock 自身开销与真实模型端到端指标。固定任务、输入/输出规模、工具行为、并发、权限、检查点和持久化语义，报告接受/排队/首输出/完成 P50/P95/P99、成功吞吐、重试、取消收敛、事件循环、CPU/RSS、数据库/分发等待及每成功任务的调用/token 成本；样本不足和未知值明确说明。不得靠降低成功率、关闭 checkpoint 或取消准入来制造改善。

M07 按 V1 范围 F01–F22/F24、A01–D11 和 G01–G08 汇总，所有必需能力及真实桌面安装出口通过才能完成总目标。P22 研究和 V1.5 保持可选，不扩大默认 goal。未来执行中的凭据/环境阻塞可允许独立工作继续，但不能将受阻模块标记 ACCEPTED。

M04 Skill/读取 UI 的 Windows 定向入口为 [`m04-real-read-skill-webview.mjs`](../../apps/desktop/tests/m04-real-read-skill-webview.mjs)，显式输入确切 EXE、0013、manifest、0047 摘要与已授权原项目模型配置路径，可按 `read`、`skills` 或 `all` 选择固定场景；`skills` 可再传一个确切 Skill ID 单项定位，不覆盖或删除此前失败。合成项目、目录、连接和策略由 HTTP Owner 准备，Delegate、读取审批、三个 Skill 生成、两个任务提案接受及 CRITERION 接受均走真实 WebView2 控件与原请求；独立 Worker 执行，SQL 仅观察原事实。文件 ASK 等待期必须零 Invocation/模型调用，网页 AUTO 不制造审批；唯一来源标记仅在物理正文，沿原读取证据重建原 DRAFT 输入 hash。最终 Artifact 实际 bytes/SHA 与候选、Review、Verification 和 Completion 必须绑定同一版本，HUMAN 检查引用原界面决定。三个 Skill 复用上文冻结定义、事实基线、双 revision 与只读约束，两类任务提案新增条件须为必需 HUMAN；严格失败即停止并保留原失败，不换 schema 或暗重试。核对原配置未改变、标题栏自然关闭、原进程树、HTTP 来源 listener、PG 与临时根清理；UI 自动化接受只证明命令路径和完成门，回复质量及真人交互体验单独验收。实际成绩仍只写功能验收表。

## 11. AI 并行开发体验验证提案

2026-09-26，Proposed，尚未执行。用于评价[产品目标](../../Personal_Workflow_OS_Master_Spec.md#04-ai-并行开发中的注意力与验收依据)与[候选交互](../frontend/workbench-design.md#11-ai-并行开发的注意力与验收体验)，不追加当前 M01–M07 必需出口，也不以本节替代既有业务、恢复及 Windows 验收。具体实验协议与通过阈值须在实现排期前讨论。

### 11.1 场景与反例

候选主场景：两个项目、多个并行任务，开发者中途离开后返回，处理决定、复验和验收；首轮复用一个真实执行入口。至少准备以下可判定情况，预先固定要求与预期结果：

| 情况 | 需要观察的结果 |
|---|---|
| 正常推进、重复事件、用户暂缓查看 | 无需逐个翻阅执行日志；同一事项不重复打断，必需待办与阻塞仍可找到 |
| 缺少关键决定、冲突或预算耗尽 | 能理解等待原因及下一步；不把静音、Focus 或延后当作执行授权 |
| 无上次查看基线、摘要生成后事实又变化 | 区分当前快照与变化；过期摘要不能提交旧决定，引用可核对 |
| 现有测试通过但遗漏已声明的重要行为 | 明示覆盖缺口；不因通过数或代码覆盖率较高宣称完整验收 |
| 测试被删改、跳过或检查器出错 | 受保护基准和缺口可见，原必需条件不能被自评或笼统接受绕过 |
| 两个任务各自通过，组合版本出现接口或数据冲突 | 独立成绩不成为组合版本证据；按组合对象复验并保留失败原因 |
| 外部执行失联、回执缺失或迟到、重复 | 不从聊天或超时推断完成；按原身份核对，不重复应用成果 |

### 11.2 指标与证据限制

| 评价问题 | 候选测量方式 |
|---|---|
| 回来后能否更快接手？ | 从打开项目到正确说明当前状态、关键缺口并完成首个有效操作的时间；同时记录判断错误，不能只计点击速度 |
| 注意力是否更集中？ | 任务期间实际打断及上下文切换次数，同时记录遗漏的关键待办与处理延迟；提醒少不能单独算改善 |
| 验收是否更容易且可靠？ | 接受/退回成果所需时间、已知缺陷发现率、误报与漏报；已知缺陷可由固定缺陷集或人工注入构成，不能推广为全部真实缺陷覆盖率 |
| 人工积压是否减少？ | 待决定/待验收事项数量、等待时长及完成量；结合总交付时长与质量判断，不能仅靠停止所有执行改善积压 |

对照候选为现有逐任务查看聊天/日志/测试结果的方式；待选定后固定任务难度、代码与需求基线、执行入口、模型/工具配置和缺陷集合。记录参与者对项目的熟悉程度、任务顺序与学习效应，避免仅因重复做同一任务得到更短时间。先做小规模可用性观察，保留原始证据、失败案例和样本限制，再决定是否形成正式研究协议；不预填改善比例或实验成绩。

文档检查、fixture 演示和人工注入反例仅证明各自范围。真实工作流中的注意力负担、恢复理解与验收质量需要实际使用证据，不能由页面存在、Agent 数、生成代码量或测试数量代替。

执行接续：[公共产品映射](../../prompts/README.md#产品补充的执行映射)分配本节候选到相关模块与页面，[P21/P22 提示词](../../prompts/F-release-research.md)区分本次工程交付结论和可选研究。仅实施已选定范围的相应检查，未选定项保留状态与原因；正式研究候选衔接[研究协议](../research/评价协议.md#与并行开发体验评价的边界)，不自动同时启动原四组策略实验与新体验实验。

## 12. 共享知识库的阅读与来源验证

实施接续：下述表格保留最初验收规格，并不表示每项均已运行。本轮按 [27 日执行包](../../prompts/product-supplement-2026-09-27.md)补齐定向检查；实际结果须关联开发记录，真实 Windows 阅读与项目理解效果仍须单独验证。25、26 日补充的已运行场景和范围分别见 [恢复与成果记录](../development/product-supplement-2026-09-25.md)、[人工待处理与验收记录](../development/product-supplement-2026-09-26.md)，不将工程测试折算为本计划第 10–12 节的体验实验成绩。

2026-09-27，规格补充，尚未运行。对应[工作台第 12 节](../frontend/workbench-design.md#12-人和-ai-共用的知识库体验)和 F10/F15 的已有阅读/版本义务；候选导读与沉淀按本次实际选定范围验证，不以本文新增场景改变现有模块验收状态。

| 场景 | 应有证据 |
|---|---|
| 用户不发起 AI 对话，从项目/搜索打开长 Markdown 或纯文本 | 可读完整受管正文而非仅摘录；目录适用时可定位，缺段明确提示；键盘、长中文和桌面缩放下可读 |
| Provider 关闭或外网断开，本机 API 与保存内容可用 | 浏览、搜索、读取已保存版本不依赖模型或外部原件；请求记录没有因阅读而新增模型调用/正文外发 |
| 当前 v2、历史引用 v1；切换版本或并发更新 | 展示所选确切正文及来源；迟到响应不串版本，旧引用不偷换，新内容不会继承旧验证 |
| 原件变化、来源不可访问、正文缺失或读取失败 | 可读快照与当前原件区别清楚；未知、不支持、错误分别可辨，无最新正文兜底冒充历史 |
| 人与 AI 使用同一份资料 | 人可核对 AI 实际采用的确切版本/片段和来源；按既有预算裁剪可解释，不另有无来源正文；失权与跨项目访问仍受限制 |
| 笔记修订、原件引用或 Artifact 提升 | 修订产生新版本且冲突保稿；提升绑定原版本，原件/产物未被暗中修改；重复命令不重复收录 |
| 外部导入、AI 整理建议和人工确认 | 导入不显示为已验证；保存前的建议与已收录分开；确认含义及证据可查，缺能力时不制造确认状态 |
| 选定项目导读体验后，由未参与编码的人接手 | 能从已有引用找到项目目标、关键决定及其原因、重要验收要求，并指出资料缺口；无资料时不生成虚假的完整说明 |

核对类型/作用域、来源、不可变版本和命令时复用现有自动化测试，涉及持久化/回执使用真实数据库；阅读交互需真实 API 与 Windows 窗口证据。项目理解效果另记录任务、参与者熟悉程度、答案依据及错误，不能仅因“找到页面”或模型回答正确就判定人已理解。无本轮运行记录时保持未验证，不预填测试成绩或改善比例。

## 13. 锁定影响检查与提醒的已确认规则验收

2026-09-28，产品规则已确认。以下仍是**完整验收规格**；协调侧独立验收原发现的无效候选、空态与确切原文失败证据保留在[本轮验收记录](../development/collaboration-controls-2026-09-28.md#协调侧独立验收2026-09-28)。退回项已完成开发修复自检：锁定单测 6/6、隔离真实 PG 专项 6/6 与原 Artifact 保存回归 18/18、指定 Workbench 六文件 43/43。隔离 Windows EXE 已[实测原生通知、点击和回窗](evidence/collaboration-controls-windows-notifications.txt)；故障路径使用定向注入。这些都不是协调侧独立复验，**独立验收仍待复跑**，也不能把定向通过数当作本表全部通过。依据为[工作台 10.1](../frontend/workbench-design.md#101-已确认的锁定与影响检查规则)与[11.5](../frontend/workbench-design.md#115-已确认的人工介入提醒规则)。

| 场景 | 必须核对的行为 |
|---|---|
| 章节/段落锁定后 AI 修改相邻内容 | 锁定原文未变；AI 可以提示问题或提出候选，但未由用户解锁时不能应用到受保护区域。区域删除、移动、拆分/合并须有服务端反例，防止绕过保护。 |
| 用户直接修改锁定段落 | 保存为新版本后仍保持锁定，保护新原文；并发 AI 候选不得按旧基线覆盖人工修改。 |
| 锁定结论与新数据冲突 | 原文不变、冲突可见；仅依赖冲突的工作暂停，独立工作可继续；未解决事项不被整体完成声明隐藏。 |
| 连续修改后才点击检查影响 | 未点击时不自动启动影响分析；检查显示来源版本、明确引用、推测和未分析范围，不把未检查状态说成无影响。 |
| 明确引用与 AI 语义推测并存 | 分组展示依据，引用存在不自动等于必须修改；推测项未确认不能进入处理范围；用户选范围前不生成修改候选，不自动应用。 |
| Provider 不可用或无外发授权 | 不绕过现有门槛进行 AI 推测；不能将未完成的推测展示成完整清单或无影响。 |
| 必须介入、普通进度和成功完成同时出现 | 仅必须介入事项主动通知；成功后需要人工验收时保留独立待验收事项。 |
| Relay 前台、非前台、退出与系统拒绝通知 | 运行时应用内保留事项，窗口非前台才额外发系统通知；退出后的投递不属本次承诺；系统通知未显示不能抹掉待处理事实。 |
| 同一事项重复事件、刷新、重查或重启 | 按冻结的事项/变化身份去重，不因为重复信号再次催促；跨重启的实现方式在工程契约中给出。新的必须介入变化可产生一次新提醒。 |
| 短时多个事项与单个事项 | 在选定聚合窗口内合并通知、数量可核对；合并入口到待处理列表，单项到原事项，原因与业务身份不被合并丢失。 |
| 通知生成后事项已解决或版本改变 | 打开时核对当前事实，不复活旧事项、不据过期通知批准；应用内仍保留其他未解决项。 |

定向测试已覆盖部分身份、版本、锁定继承、无效候选拒绝、持久去重和默认 3 秒聚合边界；包含本次修复的确切隔离 Windows 宿主已验证焦点、原生系统通知、点击、重启与受控拒绝/失败路径，详见上方证据。3 秒是实现默认值，并非用户指定。安装包、协调侧复验及通知效果与真实注意力改善仍需各自证据。

## 14. V1 后续长期协作验收提案

2026-09-28，Proposed，以下均未执行。只适用于未来明确授权的[后续 N 工作包](../requirements/post-v1-roadmap.md)，不增加当前 M01–M07 必需出口，不替代第 11–13 节或既有 A–D/G 验证。PV 为后续规格引用，不是成绩或发布状态。

| 编号 / 工作包 | 正向路径 | 必须包含的反例 | 证据层次 |
|---|---|---|---|
| PV00 / N00 | 同一固定任务集测量受理、领取、首内容、持久化、总时间及人工返工 | 错误、超时、取消与未知用量保留分母；样本太少不报告可靠分位数；Mock 与真模型分开 | 可复跑脚本、配置/样本基准和真实使用记录；瓶颈修复再定向回归 |
| PV01 / N01 | 保存接续点，隔日返回比较并查到变化来源 | 捕获同时人工修改/Run 完成；读快照不能混合不同时间事实；删除/失权/跨项目、摘要迟到；开页面不改基线 | 真实 PG 快照/回执/权限测试；真实 API 与 Windows 接续路径 |
| PV02 / N02 | 一个来源变化生成多项候选，选择后产生新版本并验组合 | 锁定/人工编辑冲突、来源过期、缺失依赖、环/截断、应用部分成功、响应丢失与重复提交；单项 PASS 不冒充组合 PASS | 真实 PG 与故障点；确切源/目标/组合版本和 Windows 差异审阅 |
| PV03 / N03 | 人工组织导读，接受有来源的知识候选，再显式用于任务 | 重复收录、并发编辑、失权/缺正文、旧候选、相似条目误合并；保存知识不调用模型；未批准不改 Rule/Decision | 真实 PG/HTTP 与 Windows 人工阅读；模型实测仅用获授权资料 |
| PV04 / N04 | 手动生成周期计划，解释变化并逐项接受 | 任务/目标 revision 变化、依赖环、容量不足、重复提交、活动 Run 契约受影响；接受后零自动 Delegate | 真实 PG 幂等/冲突及 UI 请求观察；Windows 查看依赖与缺口 |
| PV05 / N05 | 用户启用一种时间触发，运行期生成一次候选并通知 | 双领取、禁用竞争、提交后崩溃、模型回执不明、时钟前后跳/夏令时、关闭重启漏触发、通知失败/旧点击 | 可控时钟单测、真实 PG/进程故障和 Windows 生命周期；不以真实等待时间代替确定性时钟测试 |
| PV06 / N06 | 一个明确授权的短任务链逐项经原验证/完成后推进，人工 Review 可暂停链 | 撤销/Delegate/完成竞争、预算双预留、未知用量、过期配置、未决 UNKNOWN、回执丢失、旧 Worker 与重启；无授权新任务零准入 | 真实 PG/进程故障先行，再用确切模型/工具/Windows 包验证；记录原 command/operation 身份 |
| PV07 / N07 | 编辑一个受限配置，Eval 后启用新版本，旧 Run 保持原绑定 | 恶意代码/SQL/schema、扩大权限、依赖缺失、过期预览、并发启用、Eval 失败、回退误复活批准 | schema/规则单测、真实 PG 版本/回执与实际配置 Eval、Windows 编辑使用 |
| PV08 / 所选批次 | 未参与实现的人完成接续、共创、知识复用或有限委托路径 | 分不清事实/推测、找不到依据、错误接受、过量提醒、停止状态误判；将失败和人工兜底纳入报告 | 确切 Windows 包与真实业务/模型条件；单列用户体验记录，不由工程测试推导收益 |

### 14.1 使用效果的可复核口径

- 接续理解：从打开项目到能正确指出当前目标、上次以来的关键变化、未决事项和下一步的时间；答案须由事实源核对，同时记录错误数，不能以点击速度代替理解。
- 共创：预埋或人工标注关键影响，记录漏检、误报、错误接受和人工修订量；标注不直接采用执行模型的自评。检查范围不完整时报告分母限制。
- 知识复用：能否找到确切依据、成功引用所需步骤与耗时、重复收录及错用旧版本次数；搜索命中不等于知识正确。
- 有限委托：记录完成/失败/人工接管率、每个成功任务的主动操作次数、错误接受、预算越界与停止收敛；更少审批不自动等于更好体验。
- 性能：记录固定规模与配置下的各段延迟、取消收敛、冷启动、全进程内存和空闲 CPU。新旧方案保持模型/来源/权限/持久化语义可比。

N00 先确定任务集与基线，再在对比运行前冻结阈值、样本数量和判定方法；不在看到结果后改成功标准。任何新增范围中的越权写、锁定绕过、重复副作用或已知不满足契约的完成均阻止相应包放行，不以平均体验提升抵消。产品试用属于工程/体验证据，P22 的研究样本、对照与统计仍需单独确认，不宣称已证明普遍收益。

### 14.2 每包放行材料

记录确切代码/构建、迁移、配置、模型/权限和输入版本；列出规格→实现→测试/人工证据→未覆盖项。运行时证据与文档检查分开；没有真实模型或 Windows 条件时可以交自检，但相应最终出口保持未验证。关闭应用后常驻执行、外部执行器、PDF/OCR 或新索引不因主线通过自动放行，须补各自所选场景。

## 15. 交互状态与反馈验收

2026-09-29 新增设计验收场景；本次仅维护规范与状态图，下表均未在本轮运行。规则来源为[工作台第13节](../frontend/workbench-design.md#13-交互反馈与业务状态绑定)及[控件状态](../frontend/design-system.md#61-交互状态的统一表达2026-09-29)。不替代原业务不变量、数据库和 Windows 出口。

| 编号 | 场景与期望 | 所需证据层 |
|---|---|---|
| UXI-01 | 同一控件分别用指针、Tab、Enter/Space 激活；hover 不等于选中，focus 独立可见，按下不显示成功，不重复提交 | 组件事件计数＋键盘实测 |
| UXI-02 | 禁用仍有可读原因；菜单和任务行互不误触；浮层关闭正确回焦，Esc 不丢草稿 | 组件＋实际页面 |
| UXI-03 | 保存失败保留输入，冲突不覆盖；回执丢失后按原命令核对，不生成重复版本 | 真实 API/数据库＋UI |
| UXI-04 | 查看旧版本不改变当前选用；接受时依据变化或权限撤销阻止提交，不继承 PASS | 业务集成＋UI |
| UXI-05 | 接受请求受理但提交未确认时不显示完成；成功回执绑定确切完成记录；未知回执可恢复 | 故障注入＋数据库＋UI |
| UXI-06 | 暂停/取消/接手请求等待中保持真实执行者；暂停后不可冒充人工；接手确认后才允许编辑 | Fake 在途动作＋真实持久化＋UI |
| UXI-07 | 外部 UNKNOWN 仅有契约允许的核对/处置入口；刷新、重启不换动作身份，结清不伪装成功 | 恢复集成＋桌面 |
| UXI-08 | 切 Task/Project/Workspace 时注入旧响应；无错对象数据/通知/重放，失权清理受限内容 | UI＋真实鉴权 |
| UXI-09 | 标题栏按钮不触发拖动，无历史时前进/后退不可用；窗口控制与业务加载独立，搜索仅展示支持范围 | Windows 原生窗口实测 |
| UXI-10 | 减少动态效果、键盘阅读、缩放与错误长文下仍能辨识状态与操作；关键状态播报不逐 token 重复 | 页面＋辅助技术人工检查 |
| UXI-11 | 阅读知识不选入 Context；显式选择绑定确切来源版本；锁定/影响检查和介入提醒不因普通控件激活绕过既定条件 | 对应业务集成＋UI |

每份证据标出代码/构建、测试数据、输入版本、触发步骤、预期与实际结果，以及未覆盖项。静态 PNG 只能证明所示状态的视觉方向；组件 Mock 不能证明持久化、执行权交接或 Windows 行为。

## 16. Agent 协作主线验收提案

本节先保留 2026-09-29/30 方向 1 的历史设计与当时运行边界；其中“本轮”指原记录时点，不代表工作主线重做后的当前成绩。2026-10-01 的补充规格见第 16.1 节，当前结果只维护[功能验收表](overall-acceptance-2026-09-28.md#当前功能验收表)。

2026-09-29，用户已选方向 1「对话主轴 · 双页工作桌」并授权实施。来源为[工作台第 14 节](../frontend/workbench-design.md#14-以目标协作为中心的工作台改造)和[视觉层级](../frontend/design-system.md#51-协作工作区的视觉层级)，视觉参考使用[完整窗口修订图](../frontend/mockups/2026-09-29/collaboration-dialogue-window.png)。

**本轮已运行的范围（开发自检，非 Windows 验收）**：`/agent` 端到端路径在真实本机 API 与真实数据上以浏览器核对通过 50 项（`apps/workbench/scripts/collab-live-check.mjs`，证据见[协作工作区证据](evidence/collaboration-workspace-2026-09-29/)），并由 `apps/workbench/tests/collaborationWorkspace.spec.ts` 覆盖状态反例。**AGUX-08、AGUX-10 的真实 Windows 窗口与 DPI 项本轮未运行**；AGUX-11 的 Git、AGUX-12 的交互终端因缺协议未接入，不得据此判定通过。AGUX 各项的具体结论：

| 编号 | 场景与验收预期 | 本轮状态 |
|---|---|---|
| AGUX-01 | 首次进入无需理解模块目录即可找到表达目标或人工工作的入口；打开页面不产生业务对象或模型调用；新目标发送前可辨识并确认归属 | 浏览器核对通过（重新进入 0 个写请求；先选任务才可发送）；Windows 入口未验 |
| AGUX-02 | 从近期工作恢复同一 Project/Task、实际进展、产物和待判断项；无变化基线不制造"上次之后"的比较，失权清除内容 | 浏览器核对通过（范围与排序写明、显示读取时点、无比较基线）；失权反例由组件测试覆盖 |
| AGUX-03 | 同一工作完成讨论、明确范围、显式委托、查看进展、判断、验收；用户无需手动往返多个管理页 | 原 2026-09-29 浏览器范围不含真实 Windows 完整链。2026-09-30 接续的定向真实 Provider＋Windows 结果及限制只看[功能验收表](overall-acceptance-2026-09-28.md#当前功能验收表)，不将独立 Assist/任务子页的通过算作 `/agent` 所有交互已闭合 |
| AGUX-04 | 执行中能阅读产物和访问停止/暂停；草稿与不可变版本分开，控制请求中、已暂停与可编辑不混同 | 组件测试覆盖（PENDING/PAUSED/HANDOFF 三态分别表达、草稿与版本分开）；真实执行中未验 |
| AGUX-05 | 判断显示确切对象、影响、版本和证据；条件改变后失效；完成绑定确切产物和验收 | 2026-09-30 浏览器核对正常判断可用及确切对象常驻；组件反例覆盖刷新挂起/失败、Task/Project不匹配、合法null Project、归档、页签切换保留反馈及响应丢失原命令，原接口原revision/targetHash提交；最终前端全量407/407。真实API判断提交与Windows未验 |
| AGUX-06 | 执行失败、普通查询失败与外部 UNKNOWN 可区分；保留可读成果 | 组件测试覆盖（局部失败不渲染为无数据、UNKNOWN 沿原 operation_id 核对） |
| AGUX-07 | 模型不可用时人工阅读/编辑仍可达；旧列表、知识、搜索、设置与深链接没有因重排消失 | 组件测试与浏览器核对通过（/projects、/tasks、/knowledge、命令面板仍在） |
| AGUX-08 | 窄窗、中文输入、键盘与 DPI 下目标、正文、判断和控制可达 | 2026-09-30 浏览器1487×1010、960×640、390×844复验；目标与状态、底部输入及滚动后判断可达，无根横向溢出，页签保留讨论/反馈草稿。最新图与指标见[视觉QA](../../design-qa.md)；**本增量真实Windows、IME与DPI未运行** |
| AGUX-09 | 切会话/目标保护未提交输入并隔离迟到响应 | 组件测试通过；跨窗口草稿恢复仍未接入，限制已写明 |
| AGUX-10 | 完整窗口包含共享标题栏与独立上下文栏；按钮命中正确 | **未运行**（本轮 Tauri 开发窗口未创建成功，见[当前状态](../../CODEX_NEXT_STEP.md)） |
| AGUX-11 | 开发工具绑定确切项目和受管目录；Git 不把他人改动归因给 Agent | 受管目录与真实命令输出已接；**Git 未接入**，面板显式声明而非显示"干净" |
| AGUX-12 | 终端与执行输出分开；打开不执行命令、关闭不停止进程 | 执行输出只读服务端已存 `result_ref`；交互终端无协议，**未接入** |

方向 1 的设计走查与后续运行验收采用以下状态样本；静态稿只检查信息与动作是否表达正确，运行证据在另获实现授权后提交。

| 状态样本 | 重点反例与观察点 |
|---|---|
| 首次 / 空态 | 页面 GET 不创建对象或外呼；输入归属未确认不能发送；人工入口可达，无虚构近期工作 |
| 恢复 / 局部失败 | 保持同一 Project/Task/会话与版本，不拿最新会话替代；某区域失败不渲染为无数据；失权清除内容 |
| 范围 / 显式委托 | 聊天中的“开始”不触发 Delegate；采用提案、委托命令与 Run 创建逐项核对，重复提交仍绑定原命令 |
| 执行 / 生成草稿 | 草稿不会显示已保存/已接受；新增预览不抢焦点；查看旧版本不改变 Run；在途输入不能暗示修改执行合同 |
| 暂停 / 接手 | 请求受理不显示 PAUSED；等待判断不显示暂停；PAUSED 仍不解锁编辑，取得执行权后才允许保存 |
| 判断 / 完成 | Review 版本或条件改变使操作失效；批准只确认判断；完成提交绑定确切产物与验收，回执不明不显示成功 |
| 失败 / UNKNOWN | 普通读错不变成外部未知；原动作证据可查；缺核对接口不造可点击成功按钮，不切换身份重试 |
| 长文 / diff / 窄窗 | 在含标题栏的 1280×800、960×640 客户区及规定 DPI/内容缩放检查重排；输入、证据与末尾按钮不遮挡；独立阅读返回保持位置 |
| 窗口 / 草稿 | 标题栏前进后退、关闭、还原后的草稿保护；跨窗口恢复如未支持须明确限制，不以当前组件内保护代替宿主生命周期验证 |

检查记录分别标明“设计提案”“用户已选方向”“代码实现”“开发自检”“真实 Windows 验收”；方向选择及图片修订只能更新前两项。无新 API/schema 变更，缺接口项先记录设计/接入工作，不能用 fixture 消除阻塞。

体验对照使用相同任务、数据与初始状态，记录完成核心路径的页面切换、重复录入、找到下一步的耗时及误判状态的次数。目标是减少寻找与重复操作，同时保留必要确认；不得通过删除审批、验收或人工路径改善数字。量化阈值和参与人数待基线采集后确定，不伪造“提升百分比”。设计稿只能验证所画信息层级；完整体验仍需实现后的端到端与真实 Windows 证据。

### 16.1 工作主线整套重做的补充规格（2026-10-01）

用户选择[工作主线图](../frontend/mockups/2026-10-01/work-first.png)后，七类页面已采用共享壳层与阅读纸面；本表只定义验收期望，已跑组件/浏览器样本及剩余出口归唯一功能验收表。页面/状态覆盖和四条完整回归路径归[工作台第 17 节](../frontend/workbench-design.md#17-整套-ui-重做提案2026-10-01)，不得用几张样本截图将全部 33 页面/状态或完整路径判为通过。

| 编号 | 触发与必须成立的反例 | 证据层与边界 |
|---|---|---|
| WUX-01 | 至少九条 Task、多 Project 与多个游标页；续页按 ID 去重并按 Project 分组，导航/底部入口可达；403 后清除受限缓存，后续503不恢复旧事实 | 组件游标/错误反例＋真实只读页面；固定前八条和加载页不冒充完整列表 |
| WUX-02 | Task A→B 或断开重连时让 A 的读取晚到；面包屑与页面仅展示当前 workId/连接 epoch，读失败不沿用旧对象名称 | 受控晚到组件反例＋实际路由；新连接不能复用旧作用域 |
| WUX-03 | 同 Task 两个 Session 来回切换，非空 Markdown/Task 候选可见；讨论/提议/Skill 标签与原载荷一致；预览读失败与模型失败分开 | 组件载荷/候选反例＋真实 API/数据库完整接受链；只读 fixture 不证明提交或持久化 |
| WUX-04 | Assist 与 Review 同时有草稿或原未决命令；切 work/Review/连接、关闭和旧会话 record lookup 均受组合保护；pending 时拒绝丢弃，每个 Owner cleanup 不移除另一注册 | 组件导航与原回执故障点＋真实原命令核对；旧回执晚到不更新新路由，不生成新 ID 绕过 |
| WUX-05 | Review 列表重排、所选项移除或 Task 读取失败；保留原决定 Owner 和原命令入口，禁新决定，成功核对后才能结束 pending；反馈不串新 Review | 组件刷新/读取反例＋真实判断回执；接受 Review 不变成 Task 完成 |
| WUX-06 | 绑定历史产物 v2、最新为v3；正文与比较对象确为v2，v2缺失明确失败；条件文字仅在 acceptanceRevision 与 criterion_id 同时匹配时显示，技术ID可展开核对 | 组件确切版本/缺失/比较反例＋真实 API版本与判断绑定；不能用latest替代 |
| WUX-07 | 知识编辑后切 kind、成果行、搜索命中或导入入口；确认前保留原输入；取消收录可继续，保存失败/冲突保留草稿，pending只核对原命令 | 组件本地切换＋真实版本/冲突写入；浏览阅读不自动选入 Context |
| WUX-08 | 同页水平页签用方向键/Home/End、跳过禁用项，IME组合期不触发切换；设置宽窄均横向，Task/成果及协作页签切换不卸载草稿或命令Owner | 组件事件/DOM语义＋真实键盘/中文IME；模拟isComposing或keyCode229不能代替原生IME验收 |
| WUX-09 | 长Skill表格、输入选项、普通判断详情与长ACTION_APPROVAL；宽/窄/短窗口可读正文、条件/影响、真实风险及末尾动作，展开依据时整成果区域可纵滚；展开导航后Tab到末尾连接不会卷走固定外壳；浏览器只有真实业务快捷入口 | 实际浏览器1487/960/390及480px短窗样本＋Windows实际客户区/DPI；不靠裁切、隐藏风险或复制Owner通过 |
| WUX-10 | 项目→Task→产物、新建任务及连接设置错误/只读状态；名称/当前目标优先、技术身份仍可查，项目picker与手动ID沿原载荷/显式归属，数据来源切换受pending保护 | 组件载荷/错误/readonly＋四条真实业务回归；最终构建与确切桌面包/安装另验 |

浏览器验证记录具体视口、所见状态、fixture或真实API、是否写入及图片真实格式，不能把生成图像素尺寸当作DPI或CSS客户区。最新生产构建、真实Windows窗口、125%/150% DPI、原生IME与安装矩阵分别绑定最终源码/包；旧EXE和原方向图不自动继承。API、数据库、依赖和判读模型未因本轮呈现变化而修改，原领域、数据库及恢复出口继续保留。
