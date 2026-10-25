# 测试规格与发布出口：分册 01

角色：所属专题的唯一正文分册；2026-10-25 按原章节迁移，不改变原业务规则、日期、状态与证据范围。

[返回专题路由](../verification-plan.md) · [文档总入口](../../README.md)

按需读取本分册内的相关小节；跨章节约束沿链接核对，不能把本分册或历史措辞单独当作完整实现/验收结论。正文中的源码与命令路径沿用原有口径。

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

全量集成的套件隔离还须覆盖数据库级领取队列与维护状态。串行运行文件不能代替隔离：前一套件遗留的 PENDING Assist/影响检查不得被后一套件的 Fake Worker 当作自己的消息领取；应由独立测试库或明确的 fixture 收尾保证，不为满足测试而改变生产 Worker 的全局领取语义。等待模型回调的故障用例须有有限截止时间，失败也要关闭自有 API、数据库连接和临时目录。完整迁移集的断言应绑定当前 migration 清单及其摘要，不写死历史条数，也不删除失败检查以取得全绿。

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
| C03、C09 | P07、P09、P18 | 目标变更和批准重放、占用恢复；Run ACTION_APPROVAL 投影与决策须同时核对当前 Operation 状态及冻结 target/hash，绑定漂移不得保留旧授权 |
| C04 | P06、P07 | required HUMAN 未决不完成 |
| C05、C06、C07 | P06、P17、P19 | 论断无支持、测试删减、checker ERROR、HARD 不可豁免；普通 `SEMANTIC` 仅由冻结的真实模型检查，未配置模型时等待人工证据，Fake 只允许显式测试夹具 |
| C08 | P11、P15 | 证据版本不被当前正文替换 |
| D01、D02、D03 | P08、P09 | PREPARED/DISPATCHING/SUCCEEDED 各断点恢复 |
| D04、D05、D06 | P03、P06、P08 | PASS 后崩溃、完成事务注入失败、响应丢失；完成前复核 Verification target 与 ArtifactVersion 的 ID 和 SHA-256 一致 |
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

UI 视觉、组件状态与可访问性按[设计系统验收](../../frontend/design-system/part-02.md#8-验证与交付边界)核对；token 的纯色组合检查只是静态证据，不能代替桌面 WebView 字体、窗口/DPI、键盘与辅助技术验收。

能力配置中 AUTO 不代表任意调用免检查。测试应覆盖连接存在但 DENY、批准已给但权限被撤销、配置更新使旧脚本授权失效，以及伪造外部文本要求扩大权限。

Schema readiness 使用真实 PostgreSQL + 应用角色 HTTP 测试：`/health/live` 在空库仍为 200；`/health/ready` 维持 Bearer 边界，并分别覆盖空库、缺最新迁移、完整当前清单、数据库账本出现未知未来迁移、已应用摘要不匹配，以及 schema 查询失败后数据库已断开的复核。数据库不可连必须是 `DATABASE_UNAVAILABLE`（`schema=unknown`）；数据库可连但兼容检查失败必须是 `SCHEMA_UNAVAILABLE`（`schema=down`）。检查不得执行 migration，应用角色直读台账仍须返回 42501，只允许读取受限兼容视图。

## 5. 阶段出口

- A：人工闭环真实 PG/API/桌面窗口可运行，启动连接、版本/完成/重开/幂等通过；浏览器页面不能单独代替交付。
- B：Fake Worker、验证、Review 完整走通；没有真实工具副作用。
- C：控制/恢复/Gateway/资源互斥与关键故障点通过，才能接真实执行。
- D：真实模型、Context、长期信息、Today、三套工作台与审计；首批 Skill、最小第一方 Pack、基础 Eval 与轻量来源视图按第 8–9 节验收；模型失败路径同样通过。
- E：四类适配器在受信边界内真实验证；禁用的承诺功能计为未完成，不静默缩小 V1。

Git读取另覆[机器协议/扩展边界](../../../apps/api/test/unit/git-adapter.test.ts)：真实暂存/未暂存列、空格/中文路径与NUL重命名、unborn/detached、完整patch尾换行、textconv/external diff/fsmonitor程序不运行且index不变；clean/process拒绝，实际无匹配与配置/启动/取消故障分开。submodule仅核对gitlink commit，不进入nested工作树，未覆盖内容不得称全树干净。[Gateway原集合](../../../apps/api/test/integration/real-tools-gateway.integration.test.ts)保留真实回执operation/invocation身份和已知FAILED，原写入审批/commit/push/UNKNOWN与CLI进程树仍回归。结果只归功能验收表；本规格不代表HTTP/UI协议或支持外部filter仓库的完整出口。
- F：OpenAPI/实现一致、安装/升级/备份还原演练、全部 required 场景证据齐全；研究实验另行报告。

每份报告写 commit、依赖/DB 版本、运行命令、通过/失败/跳过原因与证据路径。失败或未运行仍是未完成；不要以测试数量取代对应不变量证明。

## 6. TypeScript-first 冻结前 Spike

状态：完整出口尚未通过。本节为 [ADR-006](../../decisions/ADR-006-typescript-first.md) 的验证规格，不是完成成绩；2026-09-20 起补齐的独立准备实验及实际覆盖范围见 [P00 研究记录](../../research/p00-source-study.md)。原有 Pi/LangGraph/Rig 实验不能证明 TypeScript + AI SDK + PostgreSQL 组合通过。

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

性能报告按[技术选型](../../architecture/技术选型.md)同时列 API/审批分位延迟、事件循环延迟、整体 RSS、吞吐及数据库竞争；测试前明确工作量和预算，当前预算数值待确认。API/Worker 分进程须比较总资源，不只报告其中一个进程。新包版本以锁文件记录；没有 Git commit 时记录输入文件摘要，不伪造提交号。

## 7. Windows 桌面交付验证

状态：完整出口尚未通过；2026-09-20 的最小宿主局部实测见 [P00 研究记录](../../research/p00-source-study.md#最小-windows-桌面宿主实验)。依据 [ADR-007](../../decisions/ADR-007-windows-desktop.md)；这组验证补充交付和宿主边界，不替代上面的三个业务 Spike 或 37 项验收。

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

M07 维护准入首片按 [ADR-014](../../decisions/ADR-014-database-maintenance-admission.md) 验证数据库级 NORMAL/DRAINING：真实 PG 独立连接覆盖 SHARE/UPDATE 两种提交顺序、等待后回执重读、原命令重放/异载荷冲突、CAS/锁超时整事务回滚；跨 Workspace 同门，普通命令与两类自定义接受拒绝时零业务效果/回执。新 Run/Assist/Web 与无原 delivery 的 Gateway 领取保持原待处理身份；已取得原领取的结算、发布和 Saver 不误挡。新 VERIFY 预约被拒时零调用记录/外呼，已经预约的原探针可结算，Run/Assist 原计量预算回归。停止/取消、原停机证明恢复和 UNKNOWN/PARTIAL 安全终结沿原门禁；正常 GET/SSE、readiness 和旧回执可读。CLI 重启持久、缺状态行/权限失败关闭、应用角色不能 INSERT/DELETE/改身份列，错误输出不含配置明细；中文维护拒绝不覆盖响应丢失核对规则。DRAINING 不等于 FROZEN，完整快照静止、备份/还原和旧二进制升级分别另验，实际结果只写功能验收表。

维护原宿主停机另验真实 Windows Job 与私有管道：旧包缺能力声明在执行前拒绝；已有 guard 忙时零 READY，真实 API/Worker/孙进程整组停止且原 ARMED 保留；READY 期间第二入口仍忙，原 nonce release 与 EOF 释放，坏记录/版本/字段/过界或部分帧拒绝。Node 握手后收到协议错误即持续失效，RELEASED 后非法帧加退出0也不能输出释放成功；CLI 尾随/重复/过界输入拒绝成功，错误路径释放自身 guard，不使用或输出 DB/模型凭据。真实进程句柄与 Job 检查必须独立于响应 JSON；debug EXE/native-test-package 组合不当作完整包、GUI、跨登录会话或数据库静止证明。

Windows 受管内容安全点按 [ADR-015](../../decisions/ADR-015-managed-content-native-publication.md)另验：实际原生共享发布阻挡排他，排他期间各 ManagedContentStore 调用零part/目标；共享/排他helper退出后 OS锁确实释放。真实写part后、rename前强杀原helper，不得由Node继续发布；保留原证据，新版本正常发布。不可覆盖、字节/hash/256KiB、根/祖先junction及多链接sentinel、缺helper失败关闭回归。真实PG人工提交在冻结时零版本/审计/回执，解除后按原命令重试及旧回执重放；原Run发布失败保留原effect/operation的UNKNOWN，解除后核对不得换ID。CLI准确输入/EOF正常释放、尾随/超界输入拒绝成功、协议失效不因exit0变正常。完整数据库/Saver冻结、旧二进制停机及备份/恢复另验，不继承本片成绩。

本库权限/DDL组合先用原角色机制探针验证：CONNECT撤销COMMIT后原app连接仍能实写、新连接拒绝，而migrator原/新连接及完整dump可用；持原两把会话advisory锁跨COMMIT后，观察两个原DDL入口真实锁等待，显式释放才结束。控制app成员继承及grant-option漂移，bootstrap不收敛，预检/有效权限复核须拒绝；原有效ACL刷盘后故障断开维护连接，已提交撤销继续保留，并依据原ACL恢复。dump/空库restore机制不代替完整角色预检、残余连接/prepared transaction拒绝、持锁生命周期与备份/恢复协调CLI，后者另验；结果仍仅写功能验收表。

生产数据库连接维护另以[实际入口集成测试](../../../apps/api/test/integration/database-connect-fence.integration.test.ts)验证：真实Application切DRAINING并关池；原grant option与完整有效ACL精确恢复、不重写凭据；新app42501而受信migrator dump可用；两个原DDL入口跨COMMIT阻塞，锁忙有界且不泄部分锁。NORMAL、旧空闲app/Saver/migrator、权限/成员/额外CONNECT漂移和真实PREPARE后断连均拒绝。授权后启动窗口使用唯一application_name、未登记datid及目标对象锁观测；普通角色看不到其他用户类型也不能漏检。文件已存在/链接/损坏/目标错配拒绝，撤销前的外部ACL变更不被补偿覆盖；解除与显式恢复遇ACL漂移均拒绝。验证实际CLI的release/EOF、尾随/超界输入、READY前坏帧、强杀及已验证backend断连，撤销持久与原凭据幂等恢复，不输出凭据或误报released。管理员仅控制临时库生命周期/故障；测试用prepared槽不修改用户PG。整体备份协调、新包Windows和恢复放行另验。

维护连接回归覆盖备份attest/应用Pool、源fence hold/recover及新空目标隔离：合成PGHOST/PORT/USER/DATABASE/PASSWORD/SSLMODE/OPTIONS/CLIENT_ENCODING不改变显式目标及缺省会话设置；密码缺省不回退pgpass，缺省端口固定5432。实际Client/Pool无网络参数对比显式远程/TLS/options与旧ssl=no-verify，未知SSL字符串拒绝，query不能替换构造器/内部连接/时间预算或再解析connectionString。真实PG仅在产品调用期间改环境，观察前恢复，核对源完整ACL恢复/原journal不变及目标42501/关闭后仍隔离；显式只读options必须仍拒权限写入。真实备份组合保留Job、全归档与故障断言，native guard忙不能算成功或被绕过。TLS字段对比不声明真实TLS握手/证书验收，旧冻结结果不覆盖新连接代码。

备份文件与原包内部入口另验：原样保留已引用/orphan正文、staging与ARMED，证据目录不进入活动启动路径；未知条目/非空未受管缓存、目标占用、原生链接/ADS、预算超界、目录/字节漂移及持锁断言失效均拒绝且不删原文件。固定系统元数据进程只读JSON路径，不继承DB/Provider环境。包资源与实际清单一一对应，协议/Node版本正确，EXE及所有资源hash一致；旧包缺导出拒绝，归档完整历史Skill/Pack正文和依赖需能重建原hash，同ID/version的原包定义不被协调应用新版覆盖。导出后改包、缺成员/正文、重复身份、错误hash和超时/输出超界拒绝。小资源fixture不证明完整发布包、数据库静止或恢复可启动。

[完整备份组合](../../../apps/api/test/integration/backup.integration.test.ts)另验真实原生Job停止及持续guard、原包helper内容锁、独立migrator连接门同时存活，DB引用与复制hash一致，业务/Graph完整归档可在随机空库读取核对；正常释放后才有complete标记且保持DRAINING。正文不一致、无原停止证明的过期Worker或独立旧连接拒绝；不改原身份、不杀陌生进程。实际CLI在CONNECT撤销COMMIT后强杀，留partial/原ACL凭据、无成功输出，显式原ACL恢复幂等，父管道EOF后native确实退出。协议错误早于owned close也应等待close后拒绝。历史人工关闭另用[真实Owner回归](../../../apps/api/test/integration/backup-history.integration.test.ts)核对PARTIAL/NO_RECEIPT原UNKNOWN保留，精确处置+stop proof+RELEASED claim才排除当前写者，缺任一证据仍拒绝。取得fence前真实准入revision变化或同名私有空库替换时，初始/最终目标与原准入动作须精确相符，漂移不得生成成功标记。PG归档另验真实regular fd、8表逐行对照、占用/失锁/在途Abort；子进程退出不自动等于PG backend消失。确切发布包、恢复隔离/兼容/放行与安装总验收另验，成绩只写功能验收表。

恢复启动隔离另验[Node真实入口](../../../apps/api/test/unit/restore-isolation.test.ts)与[Rust宿主入口](../../../apps/desktop/src-tauri/src/restore_isolation.rs)：标记为空/损坏/伪造成功JSON/目录/链接均拒，元数据错误及文件祖先不误作缺失；无标记首次安装与目录别名保持可用。普通/桌面API、Worker、普通/桌面监督器在数据库连接、监听、ready、旧launch核销前拒绝，固定错误不泄露正文；桌面API拒绝后自然退出。Rust监督器在源ARMED消费、新Job目录与spawn前拒绝，原bytes/条目数不变；实际链接类型与权限不足的未覆盖分支分别说明。包诊断另验缺协议/旧协议、未摘要绑定的模块、任一个Node入口脱线或旧EXE，即使hash更新自洽仍拒作目标运行包；保留旧包历史诊断。标记不代表在线停机、目标CONNECT隔离或产品restore，空库还原/失败保隔离/原UNKNOWN与Graph正文核对另验，不把内部fixture当完整发布包。

新空库还原另验[目标隔离入口](../../../apps/api/test/integration/restore-database-isolation.integration.test.ts)、[PG完整还原](../../../apps/api/test/integration/restore-postgres.integration.test.ts)及[实际备份到还原组合](../../../apps/api/test/integration/restore.integration.test.ts)。目标须为不同源身份、标准角色/PG18且无用户对象、额外schema/setting/extension、残余/启动连接或prepared事务；初始及权限COMMIT前后复核，失锁/断连/ACL或原凭据漂移拒绝，成功/取消/close不恢复CONNECT。包含系统schema的用户对象、原本机CIDR地址、与旧源journal互斥回归；旧源fence仍恢复原ACL。

[源根只读保护](../../../apps/api/test/unit/restore-source-root.test.ts)使用真实助手核对完整File ID；原根、现存子目录、大小写别名及同卷搬迁的源祖先须拒绝，原ARMED/目录条目不变；合法异根不创建条目。非法ID、真实junction/缺父、错误或缺工具、环境helper/Node注入及取消均拒，子进程不继承凭据或任意环境工具。产品组合对原/搬迁源根验证拒绝发生在任何目录或CONNECT变更之前；源删除重建/跨卷移动后的选址仍属于可信运维前提，不以历史ID断言完整源路径隔离。末段另在真实PG连接和pin凭据都已关闭后换向restore目录，要求原根无新增verified且不报告成功，不能把未注入的EPERM当作该反例通过。

归档固定原hash/TOC/PG18工具、裸dbname及最小环境，完整单事务保留原Owner/ACL。核对public/Graph每表逐行、原UNKNOWN operation/run/step/attempt/dispatch_count、确切正文/孤儿与历史定义；不能因还原调用模型或重派发。错元数据/hash/tool/TOC、非空冲突、真实catalog锁阻塞后的Abort回滚均拒绝，PGbackend退出单独观察。组合中新根发布前已有刷盘标记，源staging/ARMED仅进入evidence；已占根不覆，篡改正文/自洽重hash但缺迁移或revision错配在修改目标前拒绝。真实CLI在CONNECT撤销后强杀须留标记/专用journal，无verified或成功输出，原数据/原ACL不变。成功也保持隔离，核对凭据不授予启动；确切发布包、激活/配置切换、旧包升级与Windows安装仍另验，实际成绩仅归功能验收表。

M07非空恢复维护核对规格归[专用会话集成](../../../apps/api/test/integration/restore-check-database-isolation.integration.test.ts)、[材料单元](../../../apps/api/test/unit/restore-materials.test.ts)及[实际备份/还原组合](../../../apps/api/test/integration/restore.integration.test.ts)。既有journal只读pin/原字节与File ID、实际目标六字段、完整fenced ACL、精确DRAINING revision、两把锁/残余或启动连接/prepared事务均须匹配；取消、断连、失锁、ACL/准入/材料漂移拒绝，不写ACL/准入/journal，关闭实际完成后才宣告closed。受控状态连接另覆合法URL省略端口/密码时不继承合成PG环境，纯参数反例不得访问其他实例，真实SQL只读拒绝零行UPDATE。

[目标包离线依赖探针](../../../apps/api/test/unit/restore-runtime-probe.test.ts)另验普通完整生产依赖及包内Node：10项直接依赖声明须为确切版本，实际metadata/ESM入口与每个传递ESM/CJS加载文件绑定资源hash，不借祖先node_modules。真实内存调用覆盖参数解析、Client/Pool与Saver/模型构造、Kysely SQL编译、TypeBox与Fastify inject、LangGraph本地图和JSON解析；不连接PG、不监听或调用模型。反例覆盖缺文件/绑定、版本或hash漂移、错误行为、非法声明/UTF8、中文跨stdin帧、外部解析及独立DNS/子进程/Worker入口；真实挂起、超输出和取消必须在自己的child实际close后拒绝。实际维护函数和CLI使用完整普通生产依赖目录，分别断言有限报告的Node/metadata/直接入口绑定，同时保留全表/UNKNOWN/材料与隔离断言。仅证明PACKAGED_DEPENDENCIES_OFFLINE_ONLY；真实数据库Saver、模型/工具及全部历史执行兼容仍待验，历史source包核验不新增此探针要求。

受管资源根身份观察另验真实Windows普通私有根：存量原生File ID匹配、同路径替换后ID不同、同卷搬迁的新路径/旧路径、大小写别名、合法null基线及链接/祖先junction拒绝。报告仅为MATCH、NO_STORED_ID、ID_MISMATCH或UNAVAILABLE；粗ROOT_UNAVAILABLE不推断路径缺失。固定目标包助手不带managed-content参数，核对其SHA及普通文件身份，环境限五项OS变量；128根上限、30秒合作预算和单次10秒预算、输入/输出上限、取消与故障均检查actual child close。持锁前后及末段包/材料复核保留，观测绑定此次选定状态SHA与资源Owner字段/revision/epoch，不补写资源ID。实际PG组合的源夹具经既有登记Owner创建三种私有根，null仅在初始fixture中设置合法存量字段，并在备份快照前完成；函数及CLI报告须一致，根正文与目录项（无新sentinel）、所有数据库行/UNKNOWN/ACL/准入/材料均保持。加强before夹具后重跑完整八项，不继承历史成绩；有限根身份不证明外部内容、全外部资源、配置或唯一Owner，不清除EXTERNAL_RESOURCE_LIVE_IDENTITY pending或授激活。

材料覆盖六文件跨绑定、严格UTF8/预算、wrong version/operation/目标、凭据多字段、重hash不能改ARMED路由、same-byte leaf替换与真实junction/hardlink/ADS。产品组合使用真实备份与隔离还原后运行维护函数及实际CLI，原备份路径移走仍仅声明stored binding；public/Graph全表原行、正文/evidence、原UNKNOWN身份/dispatch_count、六材料字节及源数据不变，目标app仍42501、普通启动仍拒绝、无活动ARMED。首次允许创建锁sentinel，再次核对保持其身份；篡改标记/正文拒绝且不放行。输出限定SELECTED投影/NOT_GRANTED、native/PG实际关闭后报告，不把全表测试比对等同生产核对全历史内容。完整兼容、外部身份、激活和安装另验；实际成绩仅归功能验收表。

## 8. Relay Skill 与蓝图应用验收

2026-09-20，待执行的补充规格。依据 [Skill 专题](../../architecture/relay-skills.md)，在 D 阶段验证 F24；不修改既有 37 项编号，也不把新增场景称为已通过。V1.5 Page Schema 与第三方包不纳入 V1 实现测试。

| 场景 | 必须证明 | 证据方法 / 关联 |
|---|---|---|
| Onboarding 与目标歧义 | 无模型可手工创建；歧义有澄清；拒绝/失败保留最小项目；不创建虚假 Run | Assist Fake + UI；A08 |
| 输出与模板边界 | 错误 schema、未知页面/筛选、脚本/SQL/远程引用、非法阶段被拒；合法内置模板可预览 | schema/registry 单元测试 + HTTP |
| 作用域与指令注入 | 非授权资料不可读；资料/Skill 不能删 Mandatory、授予权限；Preview 不发工具动作或加载候选 URL | Context/Gateway 测试；A04、A06、D11 回归 |
| 预览与分别接受 | 预览零业务写入；显示配置应用不启用 Rules、不改活动 Run contract；后续 Rule 接受仍触发原失效协议 | UI + 真实 API；A01、A05、C01–C03 |
| 修改与过期 | 改候选/选中项后旧 hash 不可接受；State/View/Goal/资料/规则变化使旧提案拒绝；切页迟到结果不落新项目 | HTTP + PG 竞争；A02、C08 |
| 原子应用 | 在新 Task、State、View 与回执写入之间注入失败，所有效果均回滚；Next Action 引用正确创建的 Task | 真实 PG 故障注入；D05 |
| 并发与重放 | 相同/不同 command_id 竞争同提案只应用一次；同 command_id 同内容的并发请求在原事务提交后返回原成功回执，不能因已 ACCEPTED 误报 409 或重复插回执报 500；同工作空间同 command_id 跨候选/跨 Project（不同请求摘要）竞争，胜出成功、另一请求返回 409 COMMAND_ID_REUSED 且事务完整回滚，不得返回 500；人工编辑/归档与接受竞争不丢更新；响应丢失查回执不重复创建任务 | 真实 HTTP + 两 DB 连接 + barrier；同候选确认两请求均等候候选锁，跨候选以不同业务行锁确认两请求已越过锁后回执查询再放行；分别覆盖 Task Skill 接受与 Blueprint Apply，核对业务效果、回执、审计与失败候选均无额外提交；D06 |
| 版本与追溯 | v1 应用后发布 v2 不改旧项目/Run；同标签不同内容拒绝；旧定义缺失或禁用明确报错；来源可追溯到候选、Manifest 与效果 | 注册表/存储集成；A03、C08 |
| 验证与执行边界 | 结构通过不算 Task PASS；Worker 不能改有效 CheckPlan；Skill 升级不绕过原 UNKNOWN 核对 | Verification/恢复 Fake；C06、C07、D01–D03 |

P12/P14 实施报告必须附真实 schema/OpenAPI/迁移版本与上述证据。输出大小上限、历史定义存储及锁落点尚待冻结；文档链接/token 检查只能证明静态文档通过，不能替代本表。

### 首批闭环 Skill 的补充场景

三项既有 Skill 的真实模型 opt-in 组合见 `real-model-skills.integration.test.ts`：仅有效显式模型配置启用，缺失/Fake/残缺配置须全部跳过，不启动 API 或外呼。使用隔离合成项目，经 HTTP 冻结 Skill id/version/SHA 与事实基线，由原 Assist Owner 生成；待接受前 Task/验收/Project State 不变。任务契约及验收方案按原 payload hash、Task/验收双 revision 人工接受，同原命令重放只产生一次业务效果，旧必需条件、其他产物约束及执行权保留，不创建 Run、PASS 或完成。恢复摘要只引用当前事实与 revision，比较基线为空、零提案、只读。每项沿原唯一真实 call 核对配置指纹、request ID、实际用量及输出 hash；严格 schema 失败须保留首轮分母与失败，不拼成单轮全绿。实际结论只见[功能验收表](../overall-acceptance-2026-09-28.md#当前功能验收表)，本组合不替代 Skill UI、长期质量或 Windows 验收。

依据[首批目录](../../architecture/relay-skills.md#7-首批闭环能力与后续目录)，以下均待执行。首批四项在 D 阶段交付；修复、交接、状态提交复用 B/C 阶段核心测试再回归，不能推迟既有核心安全出口。

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

2026-09-20，待执行。依据[扩展模型](../../architecture/relay-skills.md#8-可组合扩展模型)。V1 为实际交付的 Skill 和第一方 Pack 提供工程回归用例，不依赖可选论文任务 P22，也不建设通用评测平台。现有 B/C 核心测试继续作为前置，不以 Pack 演示取代它们。

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

V1.5 Importer、自动 Trigger、完整 Inspector 与 Project Checkpoint 的运行验证随对应功能另补：特别覆盖仓库指令不执行、重复触发去重和检查点恢复冲突。当前记录设计边界，不计为 V1 已实现或已验证。P12/P14/P15 提交基础证据，P21 核对实际交付版本及上述回归；论文扩展仍按[实验协议](../../research/评价协议.md)独立确认。


## 10. 技术栈改造的大模块验收

日期：2026-09-23。角色：M01–M07 的验收规格；本节没有测试通过结论。执行包见 [大模块提示词](../../../prompts/stack-migration.md)，目标技术取舍见 [ADR-010](../../decisions/ADR-010-agent-stack-react-desktop.md)，当前状态只维护在 [CODEX_NEXT_STEP](../../../CODEX_NEXT_STEP.md)。

### 10.1 模块状态与独立验收

状态为 NOT_STARTED → IN_PROGRESS → READY_FOR_ACCEPTANCE → ACCEPTED；问题进入 CHANGES_REQUESTED，缺必需外部条件记 BLOCKED。修复后重新提交验收，不保留已失效的通过结论。这是项目文档状态，与 Codex goal 工具状态无关。

具体代码、测试和修复由执行者完成。协调 Agent 在执行者自检之后独立核对当前输入文件基准、运行结果和关键反例，复跑必要检查，不能复制执行者总结充当验收。每个模块通过后才推进依赖它的模块；普通出口通过自动继续，不另设例行用户审批。必须关闭所有影响模块要求的缺陷；范围外问题明确登记，不能用低优先级标签掩盖必需能力缺失。

每次验收只更新[功能验收表](../overall-acceptance-2026-09-28.md#当前功能验收表)中受影响的行，简记模块/范围、commit 与受影响的未提交差异、命令/退出码、环境、结果及未运行项。默认不新建验收报告、不导出全仓 SHA 清单、不入库完整过程日志；重要故障才在已有根因记录保留必要片段或归档引用。没有可用 commit 或需独立绑定发布产物时，仅对必要受验对象使用摘要。数据库测试仍使用隔离实例/数据，并简记清理结果；历史成绩不自动覆盖本次代码。输出保留统一按[文档规则](../../README.md#6-验收结果与原始输出保留)，本页只维护规格。

