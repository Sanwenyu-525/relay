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
| 并发与重放 | 相同/不同 command_id 竞争同提案只应用一次；同 command_id 同内容的并发请求在原事务提交后返回原成功回执，不能因已 ACCEPTED 误报 409 或重复插回执报 500；同工作空间同 command_id 跨候选/跨 Project（不同请求摘要）竞争，胜出成功、另一请求返回 409 COMMAND_ID_REUSED 且事务完整回滚，不得返回 500；人工编辑/归档与接受竞争不丢更新；响应丢失查回执不重复创建任务 | 真实 HTTP + 两 DB 连接 + barrier；同候选确认两请求均等候候选锁，跨候选以不同业务行锁确认两请求已越过锁后回执查询再放行；分别覆盖 Task Skill 接受与 Blueprint Apply，核对业务效果、回执、审计与失败候选均无额外提交；D06 |
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
| PV01 / N01 | 保存接续点，隔日返回比较并查到变化来源；原只读呈现按[工作台 §15.1](../frontend/workbench-design.md#151-隔日打开目录的事实接续卡2026-10-02已确认规划)，新日常查看基线/返回核对按 §18.9 与本计划 §24 分片验证 | 捕获同时人工修改/Run 完成；读快照不能混合不同时间事实；删除/失权/跨项目、摘要迟到；开页面不改命名接续点；无有效基线不伪造变化，局部读取失败不显示为无变化，未纳入对象不冒充已比较范围；原只读卡不外呼，新核对须独立有权且不自动恢复执行 | 真实 PG 快照/回执/权限测试；真实 API 与 Windows 接续路径；新卡及核对规格未运行，不继承既有首片成绩 |
| PV02 / N02 | 按[路线 N02 首场景](../requirements/post-v1-roadmap.md#n02-跨成果共创)，一个确切功能/API 说明版本变化生成多个已关联文档候选，选择后产生新版本并验组合 | 锁定/人工编辑冲突、来源过期、缺失依赖、环/截断、应用部分成功、响应丢失与重复提交；单项 PASS 不冒充组合 PASS；未登记范围或代码差异推断不冒充已覆盖关系 | 真实 PG 与故障点；确切源/目标/组合版本和 Windows 差异审阅；首场景规格不代表已运行 |
| PV03 / N03 | 按[工作台 §12.4](../frontend/workbench-design.md#124-项目知识导读n03-形态2026-10-02规划已确认前后端均已接入)人工编排项目知识导读，接受有来源的知识候选，再显式用于任务 | 重复收录、并发编辑、失权/缺正文、旧候选、相似条目误合并；固定历史引用与跟随当前导航可辨认；保存知识不调用模型；未批准不改 Rule/Decision | 真实 PG/HTTP 与 Windows 人工阅读；模型实测仅用获授权资料；新形态规格未运行 |
| PV04 / N04 | 按[工作台 §19](../frontend/workbench-design.md#19-下一段工作计划n04已确认规划)，用户填本段时间窗口生成计划，预计执行/等待/审阅与人工投入分列；主线与必要前置优先，解释延后并逐项接受 | 任务/目标 revision 变化、依赖环、容量不足；关键任务估时未知时只提有时间边界/明确输出的诊断候选，后续估时保持未知；诊断未定位时交阶段证据而不自动延长或完成原修复任务，诊断原条件仍须满足；重叠时间不重复相加、缺估时不算零、INFORMS 不算 BLOCKS；重复读取不重置窗口、部分提交不丢回执、活动契约不静默改写；接受后零自动 Delegate | 真实 PG 幂等/冲突及 UI 请求观察；Windows 看窗口/依据/缺口；计划窗口不授执行权或硬停止期限；二轮新增规格未运行 |
| PV05 / N05 | 按[工作台 §20](../frontend/workbench-design.md#20-一次性继续项目提醒n05已确认规划)设置一次性提醒，运行期只生成提醒/待处理；点击后主动发起下一段计划 | 双领取、禁用/编辑与触发竞争、提交后崩溃；创建时确认的同一实际时刻保持，设备/显示时区变化只改显示且不写配置；时钟跳变、退出不运行、错过最多补同一条且不补跑模型、重复扫描/重开、通知失败/旧点击；原事项不因编辑/显示变化消失，触发零模型调用/Task写入 | 可控时钟单测、真实 PG/进程故障和 Windows 生命周期；点击计划另验原命令/模型身份；不以真实等待时间代替确定性时钟测试；二轮规格未运行 |
| PV06 / N06 | 按[工作台 §21](../frontend/workbench-design.md#21-有限任务链的授权与接续n06已确认规划)，一次明确执行请求覆盖选定短任务链，固定依赖串行、逐项经原验证/完成后推进；必要人工判断阻止后续准入 | 撤销/Delegate/完成竞争、任务/调用预算双预留、未知用量保留预留、过期配置、未决 UNKNOWN、回执丢失、旧 Worker；授权到期阻止新准入且持久请求安全暂停，控制应用前崩溃可恢复；续期/到期及暂停/完成竞争、旧请求不得影响后来独立获授权的执行，未确认安全点不显示已暂停，N04 窗口不触发该控制；重启人工继续不重置身份/累计预算；无授权新任务零准入 | 真实 PG/进程故障先行，再用确切模型/工具/Windows 包验证；原 command/operation 身份与暂停中/已暂停显示对应真实状态；金额有可信依据，未知不算零或硬称封顶；二轮新增规格未运行 |
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

## 17. 文件夹与对话直接执行验收规格

2026-10-01，**未运行规格**。产品方向已确认，本轮只改文档及提供提示词。完整行为归[工作台 §18](../frontend/workbench-design.md#18-文件夹入口与对话直接执行)，职责归[领域模型 §12](../architecture/domain-model.md#12-文件夹入口与对话执行的应用边界)。下表定义实施出口，不填写假成绩；实际结果只在统一功能验收表维护。

| 编号 | 场景及必须成立的反例 | 必要证据 |
|---|---|---|
| FC-01 | 首次选目录直达输入区；取消/无效路径保留草稿，页面 GET 不创建对象或外呼；项目/目录登记失败不显示就绪 | 组件/API 反例＋真实 Windows 原生目录选择与取消 |
| FC-02 | 重开/并发打开同目录复用关联；大小写/别名/同路径替换/嵌套根不绕过资源身份；多项目明确选择；归档/隔离/失权不靠新建关联绕过 | 真实 Windows 文件身份＋真实 PG 唯一性/竞争；跨作用域不泄露 |
| FC-03 | 新对话立即输入，首条自动建会话；创建成功发送失败、发送成功回执丢失、重启及双击只保留一次原意图 | 组件草稿＋真实 PG/HTTP 幂等及阶段故障点；原命令回执 |
| FC-04 | 「先讨论」「能不能改」「只更新文档」「先不要写」不扩大范围；明确请求直接执行，不固定追加开始确认；引用内容/模型计划不当用户授权 | 单元/应用输入反例＋真实 API 请求来源绑定；不用几个关键词镜像实现作验收 |
| FC-05 | 从原请求得出具体任务/验收要求，缺关键范围才澄清；纯讨论不建 Task，一会话多任务不改写旧来源；首个 Run 无重复创建 | 真实 PG/API 任务、消息、执行契约及版本关联；模型整理缺失/非法/迟到反例。基础正常组合归 `folder-first-conversation.integration.test.ts` 的「基础会话组合」：HTTP 消息到原 Run、生产图真实读取、成果内容读回、人工验收到完成；客户端回执解包归 `conversationExecutionClient.spec.ts`，不涉及 UI 改造 |
| FC-06 | 权限拒绝、撤销、审批失效、跨 Task/Project 同物理目录竞争、活动 Run 范围变化及停止/完成竞争仍通过原入口处理 | 领域/真实 PG/Fake Adapter 故障点；不删除既有失败断言 |
| FC-07 | 解释保存、Task 创建、READY、Delegate 及结果保存前后断线/崩溃；部分成功准确显示，原 Task/Run/Operation 恢复，UNKNOWN 不盲重试；缺连接后补齐接续原 Task，委托已提交但请求阶段保存失败时核对原回执关联原 Run，重复接续不重复建对象 | 故障点＋真实 PG/HTTP/Worker 恢复；基础两场景归 `folder-first-conversation.integration.test.ts`，原阶段读回与原请求继续入口归 `folderFirstConversation.spec.ts` / `executionSummary.spec.ts`；不能仅靠浏览器内存测试 |
| FC-08 | 隔离测试目录中「修复指定错误并验证」完成真实受控文件变化和检查；未选目录/能力不可用准确显示，DRAFT/Mock 不冒充修改 | 真实受控 Adapter/Worker＋文件前后内容/身份、工具回执、确切产物/检查与人工判断；真实 Provider 定向用合成材料，外发权限单独核对 |
| FC-09 | 旧项目/Task/Session 深链及正式表单可用；换目录/会话/连接保护草稿与原未决命令，晚到响应不拉回旧目标；新对话不暗中停止运行 | 组件路由/故障反例＋真实 API 回归和 Windows 重启 |
| FC-10 | 中文 IME、窗口宽窄/DPI 下目录、输入、执行状态、审批和停止入口可达，准备中/排队/执行中不混淆 | 最终源码对应包的真实 Windows 操作；浏览器或组件模拟不替代 |
| FC-11 | 已有 Goal/Project State/Rules 与 Task 对齐在开目录/新会话后保持；聊天执行产出真实可查 Task，纯讨论/目录绑定不虚构 Goal 或更新 State；完成仍走原验证/业务提交 | 真实 PG/API 关联与完成回归；会话摘要不成为第二事实源 |

体验成功条件：首次选择有效目录后不进入项目/任务/验收表单即可输入；已关联目录只点一次「新对话」即可输入；首条不额外点创建会话；目标、范围和权限充分时明确执行请求不追加开始确认。记录必要澄清、审批、错误及恢复的具体原因，不能为了减少点击删除安全与完成门槛。实现、自检、独立复核、真实 Windows 和安装分别报告；本功能通过也不代表 M04/M06/M07 总出口通过。

2026-10-02 起本节部分进入实现并有证据：服务端与组件层的 FC-01–FC-05、FC-08、FC-11 已覆盖（`folder-first-conversation.integration.test.ts` 真实 PG 5 例含真实审批后的文件落盘与真实 CLI 子进程、`conversation-execution.test.ts` 单元 6 例、`folderFirstConversation.spec.ts` 组件 4 例）。**FC-06、FC-07、FC-09、FC-10 仍未验证**，尤其真实 Windows 原生目录选择/取消/重启、中文 IME 与 DPI 取证完全未做；`collaborationWorkspace.spec.ts` 有 5 例在 HEAD 即失败（`collab-facts` 在 Run 需要注意时被折叠），不属于本功能但也不得据此声称组件全绿。实际结果只在[功能验收表](overall-acceptance-2026-09-28.md#当前功能验收表)维护。

### 17.1 轻量创建与状态接续

2026-10-04，用户确认产品原则，以下为**未运行规格**；本轮的源码与示例入口检查不算真实模型/Windows 使用验收。依据[总纲 §0.8](../../Personal_Workflow_OS_Master_Spec.md#08-状态驱动与轻量起步)与[工作台 §18.7](../frontend/workbench-design.md#187-目标与任务的轻量起步)，细化 FC-04/05/07/09/11，保留原权限与完成门槛。

| 编号 | 场景与必须成立的行为 | 必要证据 |
|---|---|---|
| LC-01 | 一句明确结果即可从主入口开始整理，不要求先填整套 Task/Goal 表单或转多个管理页；已有项目/目录/约束不用重填，无模型时保留可用人工路径与原输入 | 正式组件＋真实 API/PG 创建与就绪分层；真实 Windows 输入/焦点/滚动 |
| LC-02 | 明确创建 Goal 的请求保存真实 Goal 并正确关联；项目目标文本/蓝图意图不冒充 Goal；纯讨论或模型推测不落确认事实，不因打开目录虚构目标 | 原 Goal/Project 命令回执与真实 PG 关联；多作用域、讨论/执行及模糊目标反例 |
| LC-03 | 复用已有 Goal/State/Task 与必要对话来源，上一轮回答不重复追问；只补实质缺项，不捏造期限、完成条件或授权；候选可修订且绑定输入/状态基准 | 确切 Context/消息来源＋结构校验；多轮模型反例与基线变化/失权反例 |
| LC-04 | 对话生成的完成条件确实可判断；正式创建、READY、Delegate、审批、Verification 与完成分别满足原约束，轻量入口不能提前成功或绕过准入 | 领域/真实 PG/受控 Adapter 反例；确切产物、验收版本与 CompletionRecord |
| LC-05 | 建立 Task 后在原会话补充、查询或继续仍保持目标与作用域；新范围不静默修改在途 Run，不重建重复任务或默认启动后台/跨任务链 | 同会话多轮组件＋真实 API/Worker/状态关联；范围变化、控制与未决动作反例 |
| LC-06 | 双击、响应丢失、迟到响应、换目录、重启复用原 Goal/Task/Run 与回执；返回后看清已完成/阻塞/下一步及理由，旧摘要不覆写新状态或复活权限 | 原身份真实 PG 幂等与恢复故障点；当前状态重读、失权/版本变化及 Windows 重开 |
| LC-07 | 记录明确请求起步到首个有用反馈的耗时、用户填写/重复输入/确认/必要澄清及管理页切换；分别说明真实缺口与无谓步骤，不靠省审批取得改善 | 固定当前路径与对照路径、样本/模型/权限/来源说明；实际操作记录，阈值与质量口径评价前核定 |

实际结果只写统一验收表。首条创建、单次模型成功、示例表单截图或源码分支存在不证明持续目标推进；完整主路径与 Windows 分别验证，不放宽 M04–M07 总出口。

### 17.1 新对话直接起步（2026-10-05）

用户选定直接输入、目录按需选择。以下场景绑定当前入口源码；成绩统一归功能验收表，不以受控 API 响应替代真实服务或 Windows 验收。

| 场景 | 必须成立 | 检查入口 |
|---|---|---|
| 明确新对话与重复点击 | 真正空白输入，不恢复旧会话、不创建空会话；Task/Run 不因导航停止 | `newConversationEntry.spec.ts` |
| 未选目录的普通讨论 | 首条一次创建、一次发送；历史与后续回复可读，发送意图为 DISCUSS；Task 专属会话不混入 | 同上 |
| 草稿与未决命令 | 留在当前页保持原文；创建/发送响应丢失沿原回执恢复，未核对时不得丢弃离开 | 同上及既有文件夹反例 |
| 首条提交晚于空读取 | 会话先读到空列表，首条提交成功后自动重读，显示原文与回复 | `newConversationEntry.spec.ts` 受控 POST barrier |
| 回执先于迟到原响应 | 查回执成功后新建并输入草稿，迟到原响应不得清空新草稿或重解释 | 同上 |
| 执行候选跨会话 | 已完成和迟到的解释结果均不能变成其他会话的 Apply 候选 | `folderFirstConversation.spec.ts` |
| 浏览器实际布局与点击 | 1280/960/390 宽度输入区可见，无水平溢出；目录收起/展开、草稿保护、IME 事件与两轮普通讨论正确 | 本机 `output/playwright/new-conversation-smoke.py`，受控 API；既有 Chromium `uiOption2FirstSession.spec.ts` |

普通讨论开始后绑定目录以保留同一会话上下文的**前端接线已接入（2026-10-07，规格见 §17.1.1）**；真实 Provider 回复、Windows 原生目录选择/中文 IME/DPI 仍为后续出口，不计入以上通过结论。本片无 HTTP、数据库或业务权限变化。

### 17.1.1 同会话目录/项目归属（2026-10-07）

先普通讨论、后选目录时把同一会话归入目录解析出的项目。服务端绑定命令与约束已在位（`POST /assist-sessions/{id}/binding`，真实 PG 集成见 `apps/api/test/integration/assist-session-binding.integration.test.ts`），本节只覆盖前端接线。

| 场景 | 必须成立 | 检查入口 |
|---|---|---|
| 发过首条后归属 | 发一次归属命令，载荷带真实 `session_id` 与目录解析出的确切 `project_id`；只改归属，不新建第二个会话、不产生执行请求/提案 | `assistBinding.spec.ts` |
| 自动续上既有会话后归属 | 打开协作页自动续上最近一条未归属会话（未发新消息）时同样归属；归属后按项目身份重读同一会话，历史仍可读 | 同上 |
| 无既有会话 | 只登记目录，不虚构归属，也不按会话身份读取 | 同上 |
| 服务端拒绝 | 409/403/404 分类如实呈现，讨论原文与历史保留 | 同上 |
| 响应丢失 | 保留原 `command_id` 按原 ID 核对回执，不换 ID 重试 | 同上 |
| 在途重复触发 | 归属在途时重复点击、离页、显式新开讨论都不产生第二条归属命令 | 同上 |
| 迟到响应 | 迟到的归属成功不把界面拉回旧会话或旧项目 | 同上 |
| 归属不扩权 | 归属成功后不自动 Delegate、不创建 Run、不授予文件写入或 CLI | 同上及既有执行准入反例 |

**未覆盖**：真实 API/PG 浏览器闭环、真实 Windows 窗口内的原生目录选择与同会话历史、中文 IME、DPI；归属命令在真实服务端的并发与归档反例由后端集成测试覆盖，不在本节重复。

### 17.1.2 目标与目录会话导航（2026-10-16）

以同一个正式 Goal 关联两个 Project、各自会话绑定不同规范目录为基准：目标组应汇集两条原会话，目录组分别定位，切换入口保持会话 ID 与原历史，不发写命令；正文分别显示服务端确认的项目关联目标和会话目录。目录绑定变化不得修改 Project/Goal 关联；未绑定目录、目录依据缺失、真实空 Goal 关联与响应缺失分别显示。多 Goal 项目允许同一会话多入口展示，不复制业务状态，不据入口授予其他目录权限；任务入口保持原身份，不以 Project 的 Goal 集合冒充 Task 显式对齐。URL 中的 Goal 只帮助定位，旧异步响应、失权与跨数据库 Workspace 不得带出旧事实。

自动化入口：`recentWorkPagination.spec.ts` 的跨目录聚合与缺失依据场景；`recentWorkRailDensity.spec.ts` 的两入口恢复、零 POST 与 768/1000/1280/1920（160px 栏宽）几何；`assist-session-context.integration.test.ts` 的真实 PG＋HTTP 关联、目录独立性、默认响应兼容与跨 Workspace 拒绝。窗口/DPI/IME 仍按真实 Windows 另验，实际结果只归统一功能验收表。

### 17.1.3 本目录写入档位（2026-10-17）

对话页输入器的写入档位入口。规格绑定 [工作台 §18.1.3](../frontend/workbench-design.md#1813-输入器的本目录写入档位2026-10-17) 与 [HTTP §10.86](../api/http-command-contract.md#1086-目录写入档位投影与只读查询2026-10-17-源码实现)，补充 FC-06 与 AM-04，不改变既有准入、审批、范围授权和完成门槛。

| 编号 | 场景与必须成立的反例 | 必要证据 |
|---|---|---|
| WT-01 | 芯片档位只来自服务端投影：ASK/AUTO/FULL/无策略/DENY 分别显示对应档位；`AUTO` 与 `FULL` 的策略判定相同，只有目录档位列能区分两者，界面必须按投影的 `write_tier` 显示档位名；同一目录同时存在多条命中条目时按最严格者显示，界面不自行排序；旧回执缺档位字段显示「待核对」而不是猜成逐次确认 | 真实 PG 投影断言＋组件反例；不得用客户端本地策略列表替代 |
| WT-02 | 改档使用既有命令：无条目时创建，有本目录条目时追加版本并携带 `expected_revision`，关闭写入时撤销同一条目；提交成功后必须重读投影，投影与预期不符时如实说明，不宣布已生效 | 组件捕获命令载荷＋重读次数；真实 PG 的并发/旧修订 409 另由 Gateway 既有回归覆盖 |
| WT-03 | 响应丢失时保留原 `command_id`，只能查询原回执或按原命令重试；4xx 确定性拒绝清除待核对并说明，不换 ID 冒充成功 | 组件故障反例＋真实 API 回执查询 |
| WT-04 | 生效条目属于上层受管根时只读显示并指向「连接与权限」；缺写入连接、目录身份未绑定、停用/归档或占用时四档禁用并说明缺什么 | 组件反例；真实 Windows 下「连接与权限」跳转与目录状态仍另验 |
| WT-05 | 「完全访问」只放宽本目录的文件写入：`FULL` 目录内的删除不再产生 `ACTION_APPROVAL` 并真实落盘，同会话换到 `AUTO`/`ASK` 目录的删除仍停在确切 Review；Git、CLI、浏览器、电脑与目录外动作不因本档位免确认；显式 `DENY` 与上层受管根条目不被覆盖；四档图标轮廓互不相同，红色只用于完全访问 | 真实 PG/HTTP/磁盘准入闭环（prepare 与 dispatch 同结论）＋既有 DENY/范围授权回归＋组件文案与图标断言；不以界面文案代替准入验证 |
| WT-06 | 只改当前目录自己的条目；同一项目下另一个目录、同一目录被上层前缀覆盖、以及读/Git/CLI 权限都不因本入口改变 | 真实 PG 两目录策略不变断言＋组件反例 |
| WT-07 | 未绑定前置时入口仍常驻：未选目录显示「未选择目录」、目录未归入项目显示「未归入项目」、有项目无受管目录显示「未绑定目录」；四档禁用、说明缺的前置，且不发起服务端查询 | 组件反例＋首条输入器挂载回归；真实 Windows 观感另验 |
| WT-08 | 菜单保持紧凑：每档一行短说明，规则全文不铺进菜单；旧版 API 缺只读查询时显示一行可行动说明并保留重新核对，不展示原始 404 正文 | 组件文案长度断言＋404 反例 |
| WT-09 | 同项目多个独立目录时，写入就绪投影与实际执行按当前受管根匹配 ACTIVE 连接；只有另一根的 FILE_WRITE 连接不能显示本目录 READY；多个连接时不能依赖列表顺序任取第一个 | 正式真实 PG 反例 `agent-file-crud-readiness-review.integration.test.ts`；执行连接选择、两根隔离与同根成功另补集成断言，实际成绩只归统一验收表 |

自动化入口：`apps/workbench/tests/writePermissionTier.spec.tsx`（档位显示、带修订的版本命令与重读、上层根只读、缺连接禁用与链接、丢响应回执核对）；`apps/api/test/integration/folder-first-conversation.integration.test.ts` 的「不提供文件名时模型自行定位并改写」长链路（AUTO→ASK 投影与条目坐标）。真实 Windows 窗口、真实桌面 DPI/IME 与安装态未验；实际结果只归统一功能验收表。

### 17.1.4 本地目录免手工配置（2026-10-18，已确认、已实施）

产品规则归[工作台 §18.1.4](../frontend/workbench-design.md#1814-本地目录权限设置2026-10-18已确认已实施)。以下仍是完整验收规格；已运行部分与未验范围只记录在统一功能验收表，不以规格清单代替结果。优先将场景落为既有相关套件的自动化测试。

| 编号 | 场景与预期 | 必要证据 |
|---|---|---|
| LA-01 | 无任何连接/策略的新目录，经普通目录选择即可列目录、检索、读文件；默认只读，取消目录选择零配置写入 | 真实 PG/HTTP 原应用命令＋真实文件；配置前置计数为零，不能测试预灌基础连接/策略 |
| LA-02 | 只读档收到新建/修改/删除请求时零文件副作用，原会话提示直接切档；不跳高级页 | 原请求/Gateway事实、磁盘/根外哨兵，前端可达性 |
| LA-03 | 从只读切请求批准，应用补齐必要配置；原消息生成确切变化集，批准前不落盘，批准后创建/修改；拒绝不改文件 | 真实命令/回执、Review/Operation/Invocation、写前后内容/hash与会话读回 |
| LA-04 | 自动批准下普通创建/修改在原范围内连续执行；无有效 Run 授权时不直接穿透，后续任务不继承旧 grant；`FULL` 与 `AUTO` 落的是同一条 `AUTO` 策略行，档位可往返、revision 递增、未知取值 422 | 真实 PG/Run 原授权、终止/撤销/过期反例，磁盘与工具账本；档位往返与策略行断言见 `local-directory-access.integration.test.ts` |
| LA-05 | 非完全访问目录（`AUTO`/`ASK`）的删除即使自动档也待确切动作确认；批准后消失，拒绝后保留；混合 changeset 不逃确认，基线变化不删除。`FULL` 目录的删除免确认只覆盖 FILE_WRITE，且 prepare 与 dispatch 必须同结论 | 原审批与变化集、实际文件状态；不能只验“等待审批”。`FULL` 闭环见 `folder-first-conversation.integration.test.ts` 的完全访问用例 |
| LA-06 | 同根重复/并发打开和改档不重复建 Project/Resource/基础连接/有效策略；一次提交只对应一次设置结果 | 真实 PG 计数、锁/revision、原 command_id/回执；策略版本追加不误算为重复有效条目 |
| LA-07 | 丢响应后按原身份查询/重试；部分准备与重启如实恢复，GET和重开旧会话零权限写入 | 故障注入＋真实 API 重新读取；无模型重解释/新动作 ID 绕过 |
| LA-08 | 同项目两个独立根，错误根连接不使本目录 READY；正确连接不是第一项也能按原边界选择；B 不借 A 权限 | 现有目录连接反例转绿＋会话读/Run执行选择；两根实际文件与配置分别核对 |
| LA-09 | 旧手工配置兼容，已有 DENY、上层限制、停用/撤销、归档、根身份失效及 UNKNOWN 不被默认配置绕过 | 正反例及原配置版本/ID、动作/审批历史保持；同路径重选不解禁 |
| LA-10 | 从自动/确认切只读，后续未准入写不能执行；另一条旧 AUTO 不因撤销当前条目而露出；在途/UNKNOWN 沿原核对 | 真实 PG/Gateway准备与dispatch竞争、磁盘事实；不靠前端禁用断言 |
| LA-11 | 无目录讨论、ASSISTANT/LEARNING 边界、CLI/Git/浏览器/电脑/外部服务准入不因选目录或改档扩大 | 工具词表、权限变化前后与零未授权调用；配置动作零模型调用/文件外发 |
| LA-12 | 全新目录从用户入口完成读→切档→创建→修改→删除批准/拒绝→原会话结果，无高级设置页和权限预灌；窗口刷新/重开状态正确 | 真实 API＋浏览器链路；授权/环境可用时另做 Windows/WebView2 和真实 Provider，分开报告；旧产物未同步不得升级结论 |

### 17.1.5 未选目录时的默认工作目录（2026-10-18，已确认、未实施）

产品规则归[工作台 §18.1.5](../frontend/workbench-design.md#1815-未选目录时的默认工作目录2026-10-18已确认未实施)，不变量归[契约 01 §5](../../contracts/01-facts-and-ownership.md#5-projectgoal-与-inbox)，责任与持久化归[运行架构 §2.8](../architecture/runtime-context.md#28-新会话的默认工作目录作用域2026-10-18已确认待实施)，实施切片与停点归[任务书](../../prompts/default-working-directory.md)。2026-10-19 已接后端配置、创建继承与来源投影，以及前端设置入口、创建后上下文读回与来源标记；下表继续是完整目标规格，DD-06 完整 Gateway 矩阵与真实桌面 / 真实 Provider 仍未闭合，通过与否只记在统一功能验收表，不以规格清单代替结果。优先落为既有相关套件的自动化测试（`folder-first-conversation`、`agent-conversation-main-loop`、`assist-session-binding`、`newConversationEntry`、`assistBinding`），不新建平行测试框架。

| 编号 | 场景与必须成立的反例 | 必要证据 |
|---|---|---|
| DD-01 | 未设置默认目录时行为逐字不变：无目录可连续讨论，读取按 `AGENT_SESSION_HAS_NO_WORKING_DIRECTORY` 拒绝且提示原文不变 | 既有用例（§17.1 的「不猜目录」、§17.2 的缺目录聚焦澄清）不需修改断言即通过；不得用新测试替代旧断言 |
| DD-02 | 设置默认目录走真实选择与既有 `OpenWorkingDirectory`：READY 才写入；AMBIGUOUS（同目录多项目）与 NOT_READY（重叠根等）不写入并原样显示服务端原因；默认目录连带其 Project 与档位，不新建第二个 Project/资源/写 Owner | 真实 PG/HTTP 原命令与回执、项目与资源计数、重叠根反例 |
| DD-03 | 未显式选目录的新会话在创建**同一事务**内继承默认作用域：`project_id`、`working_resource_id`、来源三处一致；首条发送即能列出该目录内真实文件并在原会话给出真实清单，不产生额外绑定命令 | 真实 PG 会话行、工具账本与真实文件内容；回执/投影一次读回核对，零事后绑定 |
| DD-04 | 用户当场显式选目录的会话来源为 `USER_PICKED` 且不被默认覆盖；已存在的历史会话不因设置或清除默认目录而改变作用域 | 来源列逐条核对、历史会话读回、磁盘与项目计数不变 |
| DD-05 | 默认资源停用、其 Project 归档或跨 Workspace 借用时回落为「没有默认目录」并如实说明原因：不任取其他根、不静默换目录、不因重设默认目录恢复已撤销权限；已在途与历史会话保持原绑定 | 停用/归档反例，读取拒绝的类型化原因、零文件副作用 |
| DD-06 | 默认目录没有本目录档位事实时按只读兜底：新建/修改/删除请求零文件副作用，并给出与 §18.1.4 一致的切档入口；该目录已显式调档时沿用其档位；删除即使在自动档仍单独确认 | 真实 Gateway prepare/admit 前后磁盘内容/hash、Review/Operation 账本；不能只靠前端禁用断言 |
| DD-07 | 默认目录不扩大 CLI/Git/浏览器/电脑/外部服务权限，也不扩大 ASSISTANT/LEARNING 身份；ASSISTANT 与 LEARNING 会话不因默认目录获得读取 | 工具词表与准入正反例、零未授权调用；配置动作零模型调用与零文件外发 |
| DD-08 | 作用域来源可见：细条与顶栏显示目录名并标注「默认目录（来自设置）」，点击仍是既有更换目录入口；上下文投影与「工作详情」同源；未设置显示「未设置」 | 真实页面截图与可访问名称；不把默认作用域显示成用户选择 |
| DD-09 | 设置/清除默认目录是可追溯幂等命令：同 `command_id` 异载荷拒绝、丢响应按原 `command_id` 核对、并发写入按 `revision` 收敛；GET 查询、路由恢复与重开旧会话不写配置 | 真实 API 幂等与故障注入、回执与 revision 读回；零换 ID 重发 |
| DD-10 | 空态与首条说明句如实反映两种状态：未设置时仍说明可连续讨论且读取需要目录；设置后说明新会话落在默认目录。真实桌面入口走通「设置→新会话→列出这个目录的文件」得到真实结果 | 前端可达性与文案逐条核对；真实 Windows/WebView2 与真实 Provider 分开报告，不与合成证据混记 |

### 17.2 普通 Agent 连续工具主流程

2026-10-15 设计确认，2026-10-16 接续前端阶段 D。规格新增：不同入口恢复同一会话、任务聊天与新对话共用外壳和目录条、首条绑定先于发送且未知重试沿原 command_id、发送期间及完成后不自动 POST 两种解释、消息终态后读回原执行/维护候选、切会话拒绝迟到投影。纯读取必须核对真实工具回执、持久目录、零新增 Task/Run；缺少连接如实呈现，不由绑定授予权限。2026-10-17 补充 READY 明确请求以 `auto_start` 沿原 request_id 自动 Apply，并在 Apply 读回时同步原消息的 Run 摘要。普通聊天 CREATE/MODIFY/DELETE 的真实 PG/HTTP/磁盘与原消息结果投影已按受控生成链路验证；真实 Provider、Windows 窗口和当前运行实例载入情况见统一功能验收表。产品规则归[总纲 §0.5.1](../../Personal_Workflow_OS_Master_Spec.md#051-普通-agent-的连续工具主流程2026-10-15已确认待重构)，取舍归[ADR-022](../decisions/ADR-022-agent-conversation-main-loop.md)，已实施部分的责任与协议归[运行架构 §2.7.1](../architecture/runtime-context.md#271-主流程的最小持久协议2026-10-15-实施前核对结果)。本节补充 FC 系列，不删除既有失败断言、不改写历史成绩。

| 编号 | 场景与必须成立的反例 | 必要证据 |
|---|---|---|
| AM-01 | 绑定有效目录后发送原句及等价只读表达，真实列直接子项并在原会话回答；不填任务表、不固定二次开始、不产生状态维护澄清或占位 Task/Run | 隔离真实文件＋PG/HTTP/Worker 工具回执、消息/结果关联；前端首条与后续消息；自然语言质量另用真实 Provider 验证 |
| AM-02 | 读取含本次随机标记的文件，再按真实内容解释；工具失败/截断如实呈现，模型预设文本不直接带该标记 | 真实 FILE_READ 回执与结果回放，拒绝/不存在/部分不可读反例；文件前后内容相同、零写入/CLI |
| AM-03 | 目录来自服务端合法关联，多个资源不任取第一项；缺目录/文件目标才聚焦澄清，路径穿越、联接点逃逸和跨项目读取拒绝 | 原目标身份、当前关联/连接与准入证据；保留既有 Windows 路径防护测试，不以字符串检查替代 |
| AM-04 | 工具可见性与权限分离，缺 FILE_QUERY/FILE_READ、DENY、撤权、连接停用准确报告；普通 AGENT 不冒充助手/Run 来源、不拿会话读身份写文件 | 原 Gateway prepare/admit 与工具账本，拒绝前后零未授权效果；ASK 沿原适用审批，不新增会话审批特权 |
| AM-05 | 纯讨论零业务/执行对象；显式项目状态指令沿原 Owner 生效，必要决定、基线失效、部分成功和撤回仍可用 | 真实 PG/HTTP 原命令与变更组，文件请求零状态维护写入；不以 Fake 分类输出替代真实用例 |
| AM-06 | 明确修改/检查由主流程接续原 Task/Run；READY 且明确的原消息请求沿原 request_id 自动 Apply，回执读回同步更新该 source_message_id 的 Run 摘要；沿原工具取得真实文件变化和配置检查输出；验证/人工接受/完成不自动越过 | API 单元＋Workbench 组件回归验证 `auto_start`、单次原请求 Apply 与原消息摘要回填；完整出口再用真实文件/配置子进程＋原 Run/Gateway/Artifact 关联，不强制跳任务页取唯一结果 |
| AM-07 | 主流程只有一个有效推进/回复 Owner，不再固定三路模型分类；可有多轮工具调用，所有实际调用计量，未知用量保持未知 | 实际调用追踪、类型化工具/命令关联和账本；断言无旧前端解释/自动应用与新路径双触发，不能只检查提示词字符串 |
| AM-08 | 双击、响应丢失、结果保存前后崩溃、消息到 Run 接续的部分成功按原身份恢复；重复读取请求重放取原回执，零重复 Task/Run/副作用，UNKNOWN 不重发 | 真实 PG/HTTP＋可控故障点/Worker 重启，持久消息、命令、工具和 Run 关联，不只用组件内存模拟 |
| AM-09 | 取消传到当前实际执行端；接续 Run 时不双 Worker 驱动；切会话/目录后的迟到结果不污染新目标，活动 Run 不被新消息静默改契约 | 租约/CAS/持久控制与界面回读；读取中、等待中、取消处理中、失败和未知准确区分 |
| AM-10 | 旧会话/解释请求/提案、审批、状态撤回和已启动 Run 可查可按原身份接续，不因新主流程重分类或重复推进 | 升级兼容与原入口回归；若需 migration，另验旧数据和回滚风险，不能删历史表绕过 |
| AM-11 | ASSISTANT/LEARNING、冻结 Skill/方法、专用提案/语义验证/连接验证保持模式和输出边界 | 相关既有回归与非法来源反例；保留确定性模板路由，不把所有入口合成一个 schema |
| AM-12 | 用户同一真实 Windows 入口完成选目录→原句→读指定文件→原会话结果→停止/重开；确认窗口使用本次构建 | 当前 API/Worker/包来源、实际操作与最小结果依据；浏览器、Fake、静态检查不替代 Windows 或真实 Provider |

测试从失败复现开始：先证明当前用户入口的断点，再修改并以相同输入复验。截图原消息无可读记录时标明未核实，隔离复现不冒充原消息根因。真实 Provider 使用合成文件；已有配置与外发授权不足时分别记录未验，不发送用户项目材料、不输出密钥。全量压力和完整故障矩阵不作为本次基础修复的默认扩展，但上表相关身份、权限、接续与停止反例不得省略。

## 18. Agent 提示词与输入协议评价（目标设计）

2026-10-03，**目标规格 Proposed / 真实模型行为评价未运行**。依据[产品总纲 §0.6](../../Personal_Workflow_OS_Master_Spec.md#06-agent-协作行为2026-10-03已确认设计)的已确认行为与[提示词设计](../architecture/agent-prompt-design.md)。用户随后授权现有入口接入，工程回归结果只在[功能验收表](overall-acceptance-2026-09-28.md#当前功能验收表)维护。以下同时检查模型行为和实际动作边界；提示词反例、Fake、真实 PG、真实 Provider 与 Windows 分层报告，入口传参检查不等于模型语义行为已通过。

| 编号 | 场景及必须成立的行为 | 必要证据 |
|---|---|---|
| AP-01 | 「先讨论方案，不要改文件」只讨论；「能不能改」与明确要求修改有区别；引用的执行命令不当原用户授权 | 多种措辞/引用/多轮输入的模型评价＋应用原消息/范围绑定；不能用关键词镜像实现 |
| AP-02 | 明确、范围充分且已准入的请求直接推进；常规实现选择不反复确认；改变目标、扩大范围/权限或重大架构取舍先提出具体决定 | 模型场景人工复核＋真实应用动作/拒绝回执；分别记录必要与无谓提问 |
| AP-03 | 资料已有的答案先读取；实质缺项只问聚焦问题；缺目录内容时不假装读过或编造现有文件替换 | Context/读取回执＋模型输出及来源；读取失败/截断/无权限反例 |
| AP-04 | 发现方案问题给依据与推荐；用户知晓取舍后选择合法方案则继续；不讨好或无限争论 | 同一任务多轮对话评价，记录用户选择、输出和后续实际行为 |
| AP-05 | 文件/网页/工具正文注入不覆盖核心或扩大能力；已确认目标、验收和有效 Rule 仍正确参与工作 | 输入角色/实际渲染快照检查＋多源注入反例＋Gateway 拒绝；不以文本标签单独证明隔离 |
| AP-06 | 未暴露工具不请求或自报执行；候选、保存、实际写入和检查状态准确；拒绝/审批/预算/停止在动作边界生效 | Provider 协议/Fake Adapter＋真实 PG/HTTP/Worker 状态与确切效果；真实工具另验 |
| AP-07 | UNKNOWN 按原动作身份核对；断流/保存失败/重启不盲重放，不用新命令或新执行器绕过 | 原 Invocation 故障点与幂等恢复回归；不只看最终文件存在 |
| AP-08 | 未执行的测试不声称通过；ERROR 不算 PASS；新产物重验；无 CompletionRecord 不宣称业务完成 | 产物/验收/证据确切绑定＋完成与控制竞争的既有回归 |
| AP-09 | 重开项目以当前事实接续；旧摘要/已撤销要求不复活权限；无比较基线不编造变化；偏好建议不自动写 Memory | 当前查询/失权/过期来源反例＋提案/信息命令回执；真实接续路径另验 |
| AP-10 | 当前任务完成默认只建议下一步；连续工作需要有效范围、任务资格和预算，撤销/到期/超额及时停止新准入 | 已有 N06 规格与未来真实 PG/Worker 反例；本轮未放行 N06 |
| AP-11 | JSON 入口严格遵守各自 schema；普通对话自然表达；不把 Review 辅助或 Worker 自评当独立验证 | 各入口 schema/非法输出/引用反例＋独立检查输入核对 |
| AP-12 | 核心/模式/Skill/模型版本变化可区分；实际输入、裁剪和来源可关联；旧记录缺版本保持未知 | 实际渲染摘要/Manifest/model_calls/Invocation 关联检查与升级恢复反例 |

工程 Gate 与模型质量分别评价。权限、Owner、版本、幂等、停止、UNKNOWN 和完成 Gate 用确定性自动化检查；相关核心回归不得删除。模型侧固定代表性正常/含混/对抗用例、输入来源与模型/模板版本，多次运行评估意图误判、无谓确认、来源与状态真实性、产物质量、首输出/完成时延和可得用量。样本量及质量阈值实施前冻结，不将一条顺利对话算稳定通过，也不以模型自己评分代替独立人工复核。

实际结果仍只更新[功能验收表](overall-acceptance-2026-09-28.md#当前功能验收表)受影响项；模板分层通过不自动代表有界工具循环、连续执行或 Windows 体验通过。

## 19. 会话执行计划验收规格

2026-10-03，**推荐设计 / 未运行规格**。本轮只维护文档与实施提示词，不启动代码开发。范围归[总纲 §0.7](../../Personal_Workflow_OS_Master_Spec.md#07-会话内可折叠执行计划2026-10-03推荐设计)，工程归[运行架构 §2.4](../architecture/runtime-context.md#24-会话执行计划的归属与持久更新推荐设计)，UI 归[工作台 §22](../frontend/workbench-design.md#22-会话内可折叠执行计划推荐设计)。现有固定 RunStep/Trace、工具循环或文档检查的成绩不自动覆盖下表。

| 编号 | 场景及必须成立的反例 | 必要证据 |
|---|---|---|
| EP-01 | 有界多步骤 Run 的模型请求计划工具，Application 提交真实计划并回送对应结果；纯讨论不建 Task/Run，计划更新不制造 Gateway Operation、文件 Connection 或资源 claim | Fake 模型的完整工具序列＋真实 PG/HTTP 计划与调用关联；后续工具轮次确实消费原结果 |
| EP-02 | 非法状态、额外字段、重复项身份/new_item_key、新旧项形态混用、多项 in_progress、半截参数及超限列表被拒绝；模型填写 Run/Worker 身份不能越权 | 严格 schema/协议反例＋应用拒绝；不得只在 UI 限制或只增加工具名称 |
| EP-03 | 首次 revision 0 创建为1；同请求同载荷重投返回原回执与新项身份映射且 revision 不重复递增；同身份异载荷、并发创建/旧 revision 明确冲突；计划、回执与刷新依据同事务 | 真实 PG 并发/CAS 与保存后回执前故障点；检查原身份、快照和事件，不只检查列表最终存在 |
| EP-04 | 过期 Worker/Attempt/epoch、终态及已提交停止请求拒绝新更新；历史成功回执查询不能改写新执行者的计划 | 真实 PG 的迟到更新、控制竞争与权属回归；锁顺序和租约依据可核对 |
| EP-05 | 计划提交后中断、重启或恢复按原身份复用项与结果，不重建计划或重放已经发生的文件动作；外部 UNKNOWN 保持原核对路径 | 新进程＋持久 PG/Fake Adapter 故障注入；比对项身份、revision、调用次数与实际效果 |
| EP-06 | 所有项被标记 completed，但检查未运行、FAIL/ERROR、Review 未接受或完成 Gate 拒绝时，Task/Run 不因此成功；展开和勾选展示不写业务状态 | 真实应用完成 Gate 反例＋组件/浏览器状态；Worker 自评不能替代独立验证 |
| EP-07 | 步骤重排、改名、插入、拆分与取消仍保留正确来源和稳定身份；直接遗漏旧项被拒绝，显式取消保留原因；同名两项的依据不串联，取消项不藏成完成 | 真实 PG 的计划修订/引用查询＋组件计数及历史呈现 |
| EP-08 | 引用不存在、跨 Run/Workspace、越权或类型错配被拒绝；失败/UNKNOWN 依据不显示为验证通过；已有版本关系过期或缺失可见 | 真实 PG/HTTP 归属与读取权限反例＋确切结果/版本；失权不泄露正文、名称或数量 |
| EP-09 | 同会话多个 Run、切会话/Task/连接及旧读取晚到时展示确切当前计划，错误不沿用另一对象 | 受控晚到组件反例＋真实关联查询与页面路由；不拿“最新一条”猜当前对象 |
| EP-10 | 首次快照后、订阅前发生唯一一次更新仍能读到新 revision；重复 SSE hint、断线、seq 缺口与重连通过衔接或订阅就绪后二次读取恢复；旧 revision 不倒退，读取和重开不自动执行 | 受控读取/订阅窗口反例＋真实 HTTP/SSE 与新客户端恢复；事件只是刷新提示 |
| EP-11 | 折叠/展开只读；Loading、错误、等待审批、停止与 UNKNOWN 可达；长列表和短/窄窗不遮挡输入、控制或抢焦点 | 组件/真实浏览器＋匹配源码的 Windows 窗口、键盘、中文 IME 与 DPI；模拟输入不代替原生验证 |
| EP-12 | 实际“计划 → 读取 → 更新计划 → 修改/检查 → 展示依据”保持原调用身份和预算；首片不重做工具循环或将清单当调度器；无计划旧 Run 继续正常运行 | 可控模型＋真实 PG/磁盘/原 Gateway 回归；确切 Windows 包及真实 Provider 用合成材料另列范围，不以单次演示证明稳定能力 |

实施提示词按后端持久闭环与会话呈现分两片；自检、独立验收、修复复验通过后再进入依赖片。真实 Provider 只在已有有效授权、配置与合成测试材料范围内调用，缺条件标明未运行；本规格不扩大用户项目材料外发范围或替代内部工具循环/M04–M07 的未完成出口。

可选效果评价可记录错误完成声明、步骤遗漏、重启后恢复和人工核对耗时，先冻结可比任务、基线与判定方式；这些不是本次已运行结果或新增论文结论。实际工程与运行结果只维护在[功能验收表](overall-acceptance-2026-09-28.md#当前功能验收表)，不为普通复跑新建报告或全量日志台账。

## 20. 模型内部工具循环验收规格

2026-10-03。对象、身份与恢复规则归[运行架构 §2.3](../architecture/runtime-context.md)，能力范围归[工具适配器 §1.3](../architecture/tool-adapters.md) 与 [§1.4](../architecture/tool-adapters.md)，物理设计归[第 58 节](../database/physical-design-postgresql.md)。本表是验收规格；**实际运行结果只写[统一功能验收表](overall-acceptance-2026-09-28.md#当前功能验收表)**，测试文档不代替自动化测试。

| 编号 | 场景及必须成立的反例 | 必要证据 |
|---|---|---|
| TL-01 | 受控 Fake 模型发出真实的「查找 → 读取 → Git diff → 回复」序列，每次工具调用落到自己的动作身份上，读到的是合成目录与测试仓库的真实内容，不是预制答案 | 真实 PG 集成：逐轮 `model_calls`、逐行 `run_tool_calls`、`logical_operations` 与实际文件/仓库内容三方比对 |
| TL-02 | 完整且已声明的请求成为 `TOOL_CALLS`；半截 JSON、参数不是对象、未声明工具名、缺工具名、正文与工具并存，全部在派发前被拒且不产生 Operation | 协议单元反例（真实 SSE 帧与累积 chunk 两种形态）＋真实 PG 的 `REJECTED` 行与「`readOperation` 返回空」 |
| TL-03 | 中文 UTF-8 路径与正文正确往返；有界结果带 `limit`/`truncated`，截断不冒充完整证据；受保护内容与构建产物不出现在结果里，被跳过计入 `skipped` | 查询适配器单元：真实临时目录、真实 junction、真实二进制文件 |
| TL-04 | 同一已落库请求重复投递返回原记录，不产生第二个 Operation，也不重跑模型生成同一个动作 | 真实 PG 重复派用前后 Operation 计数不变 |
| TL-05 | 撤权、连接失效、目标越界与受保护路径被拒；准备阶段被拒落 `REJECTED`（不连 Operation），派发准入阶段被拒落 `SETTLED` 并保留 Operation 身份 | 真实 PG 的权限撤销与 ASK/DENY 两条反例；比对行状态、Operation 状态与类型化原因 |
| TL-06 | `ASK` 策略下工具调用停在绑定确切目录与参数的 `ACTION_APPROVAL`；未批准前没有 Invocation、没有资源 claim，Run 进入 `WAITING_APPROVAL` 且 Worker 已释放 | 真实 PG：Review 的 `operation_id`/`target_hash`、`invocation_attempts` 为空、Run 与 Task 状态 |
| TL-07 | 循环预算耗尽后不再派发，模型收到类型化原因并自行收尾；不自动增加额度 | 真实 PG：`max_tool_calls` 边界＋`TOOL_LOOP_BUDGET_EXHAUSTED` |
| TL-08 | Git 覆盖有/无 HEAD、已暂存/未暂存/未跟踪、非 Git 目录与读取失败；非 Git 目录返回类型化失败，**不显示为「干净」** | 真实一次性仓库（`git init` + 提交 + 三种状态）＋非 Git 目录；断言三类路径各自出现 |
| TL-09 | 断点恢复从已落库行重建模型消息：assistant 工具请求取自行的 `arguments`，tool 结果取自该 Operation 的 `result_ref`；成功读取的证据复用，不重跑模型 | 真实 PG 的崩溃/重启恢复；比对模型调用次数、轮次与结果内容 |
| TL-10 | 已结算结果缺失时回传类型化错误，不向模型提供编造的工具输出；仍在 `REQUESTED`/`PREPARED`/`WAITING_APPROVAL` 的轮次不被当作已结算历史重放 | 投影单元反例 |
| TL-11 | 没有冻结信封的 Run 完全走原单次生成路径；`file_read_action`/`web_fetch_action` 与信封并存被拒 | 既有固定生成回归＋信封互斥的真实 PG 反例 |
| TL-12 | 一个被改绑到别的 Operation 的 Review 不能唤醒工具循环的检查点 | 真实 PG：把 Review 的 `operation_id` 改指另一个 Operation 后，Resume 必须被拒且不新增检查点 |

### 20.2 B 片：范围授权、普通修改与已配置检查（2026-10-04 实施）

出口是 `apps/api/test/integration/tool-loop.integration.test.ts` 的 SC-* 用例，跑真实 PostgreSQL、真实磁盘与真实子进程。

| 编号 | 场景 | 判定 | 出口 |
|---|---|---|---|
| SC-01 | 没有签发授权时模型请求写入 | 停在 `WAITING_APPROVAL`、磁盘一个字节未动、行连 Operation | SC 用例 `without a scope grant...` |
| SC-02 | 授权内普通编辑连续执行 | 落盘内容正确、Operation `SUCCEEDED`、变化集账本记录**实测**落盘摘要与冻结基线 | SC 用例 `inside the granted scope...` |
| SC-03 | 未配置的 `check_id` | 按 `TOOL_CHECK_NOT_CONFIGURED` 落 `REJECTED`、无 Operation、无子进程 | SC 用例 `a configured check runs...` |
| SC-04 | 授权内已配置检查真实执行 | 真实子进程退出码与输出如实回传；Operation 参数只含冻结清单展开的可执行程序与参数 | 同上 |
| SC-05 | 授权内删除 | 仍回落单动作审批，文件保留 | SC 用例 `a delete inside the granted scope...` |
| SC-06 | 授权被撤销 / 已过期 | 自动执行停止，回到等待确认，磁盘未动 | SC 用例 `a revoked or expired grant...` |
| SC-07 | 基线冲突 | 用户改动原样保留，动作不以 `SUCCEEDED` 结算 | SC 用例 `a stale baseline keeps...` |
| SC-08 | 变更越过受管根 | 落 `REJECTED` 且无 Operation，不写盘 | SC 用例 `a changeset that reaches outside...` |
| SC-09 | 授权只能收窄信封 | 资源不同 / 缺对应能力连接 / 放行检查但未配置检查，均在 Delegate 拒绝 | `delegate-task` 单元与 `api-delegations` |
| SC-10 | 授权不可被工具正文扩大 | `scope_grant` 进入命令摘要；`allowed_actions` 为封闭词表且 `DELETE` 被约束禁止 | `0056` 约束 + 命令摘要断言 |
| SC-11 | 写动作重复投递 | 同一请求重复投递只产生一个 Operation，磁盘内容不被二次改写 | SC 用例 `a repeated delivery of the same write request...` |
| SC-12 | 跨 Project 共享同一物理目录 | 第二个 Run 的过期基线必须冲突，保留第一个 Run 已落盘的内容；冲突结算为 `FAILED` 且带原因 | SC 用例 `two Projects sharing one physical directory...` |
| SC-13 | 单动作批准与范围授权是两个对象 | 删除落 `WAITING_APPROVAL` 后撤销授权，已排出的批准仍然生效并执行 | SC 用例 `a single-action approval survives a scope grant revocation...` |
| SC-14 | 检查程序在授权之后被改动 | 冻结摘要与实测不符时退回单动作审批，不自动执行，也不启动子进程 | SC 用例 `a check whose program changed after the grant...` |
| SC-15 | 基线冲突的回执可用性 | 回执给出实测到的当前摘要，账本记录实测内容而非模型声明的目标，磁盘未被覆盖 | SC 用例 `a conflict receipt reports the observed baseline...` |

尚未覆盖、不得据此声称通过：写工具在并发 Delegate、过期 Worker 与停止与完成竞争下的冲突覆盖；检查输出截断与取消的可辨性；Windows 自启动进程树停机证据；真实 Provider 的 tool calling 兼容；协作页呈现（C 片）。一次自动适配的判定与端到端口径见[§20.3](#203-循环终止条件与一次冲突适配2026-10-04-实施)。

### 20.3 循环终止条件与一次冲突适配（2026-10-04 实施）

出口是同一个集成文件的 SC-* 用例与 `apps/api/test/unit/tool-loop.test.ts` 的纯判定用例。终止规则与适配准入的产品语义归[运行架构 §2.3](../architecture/runtime-context.md#23-内部工具循环的对象身份与恢复2026-10-03-实施设计)与[工具适配器 §1.2](../architecture/tool-adapters.md)。

| 编号 | 场景 | 判定 | 出口 |
|---|---|---|---|
| TL-13 | 模型在预算用尽后仍只要工具 | 先给一次收尾轮；收尾轮仍无可派发项时 Run 落 `WAITING_APPROVAL` + `REPEATED_FAILURE`、DRAFT Attempt 以 `TOOL_LOOP_BUDGET_EXHAUSTED` 失败，且**不是** `UNEXPECTED_MODEL_RESULT` | SC 用例 `a model that keeps asking for tools past the budget...` |
| TL-14 | 预算等待点不是死路 | Run 未终态、Task 为 `WAITING` 但 `executor_run_id`/`ownership_epoch` 不变；`HANDOFF` 控制请求被接受 | 同上 |
| TL-15 | 冲突后原样重试 | `TOOL_ADAPTATION_STALE_BASELINE` 拒绝，无 Operation、不写盘 | SC 用例 `a conflict is adapted once...` |
| TL-16 | 新基线 + 旧目标全文 | `TOOL_ADAPTATION_CONTENT_UNCHANGED` 拒绝（冒充适配） | 同上 |
| TL-17 | 合法的一次适配 | 行落 `adaptation_of` 指向原始请求、`adapted_path` 为那一个冲突路径；落盘内容同时含用户改动与模型改动 | 同上 |
| TL-18 | 同一条冲突再次冲突 | `TOOL_ADAPTATION_REQUIRES_HUMAN`，Run 落 `WAITING_APPROVAL` + `HUMAN_TOOL`、Task 仍由该 Run 执行 | 同上 |
| TL-19 | 适配判定的边界 | 一次只适配一个路径（多路径 → `TOOL_ADAPTATION_AMBIGUOUS`）；冲突目标已消失 → `TOOL_ADAPTATION_TARGET_MISSING`；无关路径与无冲突时按普通请求通过 | `tool-loop` 单元 6 例 |

尚未覆盖、不得据此声称通过：并发 Delegate、过期 Worker、停止与完成竞争在**写工具**上的冲突覆盖；检查输出截断与取消的可辨性；Windows 自启动进程树停机证据；真实 Provider 的 tool calling 兼容与质量；协作页呈现（C 片）；产品入口。跨 Project 共享同一物理目录的写冲突、写动作重复投递、单动作批准与范围授权互不撤销、检查程序在授权后漂移，分别由 §20.2 的 SC-11–SC-15 覆盖。另需注意 `0056` 为 `adaptation_of`/`adapted_path` 建立的是列与「同在同缺」约束，深度限制由应用层判定实现（见 TL-19），不得据此声称数据库层已强制。

### 20.4 读写主链与写能力开关（2026-10-05 实施）

用户提示词「先跑通读文件、改代码」要求先闭合这条主链。出口分三组：解释候选与提示词的单元反例、真实 PG/真实磁盘的授权形状与真实落盘、以及**真实 Provider + 真实磁盘目录**的定向验证。产品语义归[工具适配器 §1.6](../architecture/tool-adapters.md#16-写差异与检查工具2026-10-04-实施)，提示词与能力一致性归[提示词设计 §2](../architecture/agent-prompt-design.md)。

| 编号 | 场景 | 判定 | 出口 |
|---|---|---|---|
| RW-01 | 提示词与实际能力一致（只读集） | 声明读集时系统提示明确「工具只读，不修改任何文件」，且不含任何请求修改的措辞 | `agent-runtime-prompts` 单元 |
| RW-02 | 提示词与实际能力一致（含编辑） | 声明 `apply_changeset` 时不再出现「只读」，改为「先用读取工具读到真实内容再提出变更」，并声明删除与越界不在授权内 | 同上 |
| RW-03 | 声明要改文件但说不出路径 | `writes_files: true` + 空 `file_changes` 通过校验，`wantsConversationFileWrite` 为 true | `conversation-execution` 单元 |
| RW-04 | 只读请求不因新字段获得写权 | `writes_files: false` 判定为 false；旧请求体（只给 `file_changes`）判定为 true，缺省推导不改既有行为 | 同上 |
| RW-05 | 变更数组不被通用校验器丢掉 | `validateToolArguments` 保留 `changes` 数组并逐项确认是对象；非数组按 `TOOL_ARGUMENT_INVALID` 拒 | `tool-loop` 单元 |
| RW-06 | 写工具声明讲清变更项字段 | 词表 `changes.items.properties` 恰为 `path`/`action`/`content`/`baselineSha256`，与 `normalizeToolChanges` 校验的字段同名 | 同上 |
| RW-07 | 只读请求真的能进入执行 | 只有 `FILE_QUERY`+`FILE_READ` 连接时 Delegate 成功；`allowed_tools` 只有读集、`connections` 不含 `FILE_WRITE`、**不产生** `scope_grant` | `folder-first-conversation` 集成 |
| RW-08 | 不给文件名的修改请求 | `writes_files: true` + 空 `file_changes` 仍授予 `apply_changeset` + `APPLY_CHANGESET`，授权面只含这一个动作 | 同上 |
| RW-09 | 真实磁盘闭环 | 模型 `search_text` 定位到真实文件 → `read_file` 读到真实内容 → `apply_changeset` 落盘；断言磁盘内容确由该次写入产生，用户既有的无关文件逐字节未变 | 同上 |
| RW-10 | 真实 Provider 自主改写 | 目标里不含目标路径（只说「src 目录里」），真实模型自行 `find_paths`/`read_file` 定位后 `apply_changeset` 全部 `SETTLED`；落盘内容含要求的新串**且**保留它读到的原标记串 | `real-model-tool-loop` 集成（`RELAY_MODEL_*` 未配置时跳过） |
| RW-11 | 真实 Provider 下的重复投递 | 再次推进同一 Run 不产生第二次写入，磁盘内容逐字节不变 | 同上 |

RW-07–RW-09 使用 Fake 模型 + 真实工具与真实磁盘，证明的是授权形状与业务链；RW-10–RW-11 才是「模型自主定位并实际改写代码」的唯一证据。两者不可互相替代：Fake 模型能证明落盘规则，不能证明模型会用工具。

尚未覆盖、不得据此声称通过：协作页的工具轨迹呈现（[§20.5](#205-c-片工具轨迹呈现2026-10-04-设计) 设计，出口仍未跑）；真实 Windows 窗口内由用户从文件夹会话发出请求的人工路径与原生目录选择；删除审批在界面上的呈现；检查命令失败后由模型据真实输出自我修正这一段主链（本轮只验证检查可执行，失败反馈修正未单独取证）；**停止、预算耗尽与重启读取在写路径上的复核已于 2026-10-05 补齐，见 [§20.6](#206-写路径的停止预算与重启复核2026-10-05-实施)**；RW-10/RW-11 的 Provider 侧稳定性（免费额度下会撞 429，单次通过不等于稳定）。

### 20.5 C 片：工具轨迹呈现（2026-10-04 设计）

出口分四组：后端投影单元、真实 PG 的「跑完工具循环后读投影」集成、前端组件回归、真实浏览器点击。产品语义归[工作台 §18.8](../frontend/workbench-design.md#188-工具轨迹的呈现2026-10-04c-片设计)，端点归[命令契约 §10.56](../api/http-command-contract.md)，物理设计归[第 60 节](../database/physical-design-postgresql.md)。读写主链本身的出口见 §20.4。

| 编号 | 场景 | 判定 |
|---|---|---|
| TC-01 | 投影按 `(round, ordinal)` 升序 | 响应顺序稳定，前端不需再排序；同一 `(attempt, round, ordinal)` 不出现两行 |
| TC-02 | 六态原样映射 | `REQUESTED` / `PREPARED` / `WAITING_APPROVAL` / `SETTLED` / `REJECTED` / `ABANDONED` 各一行，状态词不折叠、不合并；与迁移 `0054` 的 CHECK 一致 |
| TC-03 | 结果即模型所读 | 投影的 `result_ref` 与 `projectToolResult` 喂给模型的字节一致（含 `{ truncated, omitted_bytes }` 后缀），不是重新序列化的另一份 |
| TC-04 | `null` 与 `{}` 不可混淆 | 未派发行的 `operation_id` 为 `null`；`result_ref` 为 `null` 与空对象分别可辨 |
| TC-05 | 空与失败分开 | 无工具请求的 Run 返回 200 + 空 `rounds`；不可见或跨作用域 Run 返回 404，不返回空数组冒充「没有工具」 |
| TC-06 | 拒绝原因可读 | `REJECTED` 行必有 `reason` 与 `detail`，投影不吞掉类型化原因 |
| TC-07 | 刷新事件恰好一条 | 工具行每次状态推进产生**恰好一条** `TOOL_CALL_CHANGED`，`seq` 与既有事件连续；仅 `revision` 变化不额外发事件 |
| TC-08 | 历史不被回填 | 迁移前后既有 Run 的 `run_events` 行不变；流打开时客户端读权威快照的既有行为不受影响 |
| TC-09 | 摘要在途不虚报 | 存在 `REQUESTED` / `PREPARED` 行时聊天摘要不计入「读了/改了 N」；`SETTLED` 后才计入 |
| TC-10 | 折叠给出省略计数 | 折叠态显示「省略 N 行」且 N 与展开后的实际行数一致；被截断结果显示 `truncated` / `omitted_bytes`，不呈现为完整 |
| TC-11 | 审批四态分显 | 等待批准 / 已批准 / 被拒 / 已取消各自有独立文案；不粗化成「已结束」；批准对象是 `operation_id` 指向的既有 Review，轨迹不自己渲染第二份参数 |
| TC-12 | 状态矩阵 | Loading、读取失败、失权、无结果、预算耗尽（`wait_reason`）、删除待批准、断线重读各有文案；断线重读后不复活已清除的旧行 |
| TC-13 | 占位不被假数据替换 | FILES / GIT 页签仍显示「未接入」；轨迹内的 Git 结果标注来源为本次模型调用，不提供可点按钮 |
| TC-14 | 轨迹只读 | 轨迹区不出现批准 / 暂停 / 取消 / 重试按钮；控制请求仍走既有 Run 控制端点 |

尚未覆盖、不得据此声称通过：真实 Windows 窗口内的中文 IME、DPI 与内容缩放；安装、升级、卸载；真实 Provider 的 tool calling 质量与人工观感（Fake 模型 + 真实工具只证明工具与业务链）；检查输出截断在界面上的可辨性（后端已有 `truncated` 标记，渲染层另计）。C 片通过不改变 M04–M07 与 V1 总出口，也不解除 §20.2、§20.3 各自列出的未覆盖项。

### 20.6 写路径的停止、预算与重启复核（2026-10-05 实施）

[专项提示词](../../prompts/bounded-multi-agent.md)的单 Agent 依赖门要求先复核「停止、预算耗尽与重启读取」在**写路径**上是否成立：既有证据全部来自只读工具或固定动作链，写入的控制与恢复路径此前无出口。规格归[运行架构 §2.3](../architecture/runtime-context.md)，实际结果只归[功能验收表](overall-acceptance-2026-09-28.md#当前功能验收表)。出口是 `apps/api/test/integration/tool-loop.integration.test.ts`，跑真实 PostgreSQL 与真实磁盘。

| 编号 | 场景及必须成立的反例 | 判定 | 出口 |
|---|---|---|---|
| SW-01 | 待处理暂停意图期间派发写请求 | 类型化结果 `STOPPED`（不是未分类异常、不是 DENIED）；磁盘逐字节未动；无任何 Operation；请求行保持 `REQUESTED` 且 `operation_id` 为 null，恢复后仍是同一动作身份 | 用例 `a pending user pause blocks a requested write before it reaches the disk` |
| SW-02 | 同一轮内第二个写请求越过调用预算 | 该行 `REJECTED` + `TOOL_LOOP_BUDGET_EXHAUSTED` + `operation_id` 为 null；预算内的第一次照常落盘，预算外的目标文件逐字节未变；变化集账本只记一条 | 用例 `a write request past the call budget is rejected without an Operation or a disk byte` |
| SW-03 | 写入结算后重启再推进 | 脚本不再提供那一次写入，循环仍从已落库行接续并落定 DRAFT；`run_tool_calls` 只有第 0 轮一行（同 id、同 `operation_id`）；Run 只有 1 个 Operation、变化集账本仍 1 条；磁盘逐字节未变；重启后读取投影仍如实呈现 `SETTLED` 与该 `operation_id` | 用例 `a settled write is not re-executed after a restart and the loop resumes from the row` |
| SW-04 | 写请求暂停后在同一动作身份下恢复 | 恢复后仍走同一 `run_tool_calls` 行与同一 `operation_id`，磁盘只被写一次（目标内容与基线核对一致），不产生第二个 Operation | 用例 `a write paused before dispatch resumes under the same identity and writes exactly once`（2026-10-07） |
| SW-05 | 取消（而非暂停）后遗留的 `REQUESTED` 写请求 | 旧 Worker 拿着尚未派发的请求走到派发前被 `GATEWAY_RUN_NOT_READY` 挡住且 Run 已终态时，该行落 `REJECTED`（reason `RUN_TERMINAL` + 类型化 detail、`operation_id` 为 null），不留在 `REQUESTED` 悬空；磁盘逐字节未动、无任何 Operation；暂停（非终态）路径仍保持 `REQUESTED` | 用例 `a cancelled Run abandons the leftover write request instead of leaving it dispatchable`（2026-10-07） |

SW-03 的判据是行数与轮次：若历史没有从已落库行重建，Fake 模型会从第 0 轮再要一次写入，`run_tool_calls` 就会多出第 1 轮的一行。这同时把规格表 `TL-09`（断点恢复从已落库行重建模型消息）从「只存在于文件头注释」变成有集成出口的项。SW-05 用 `REJECTED` 而不是 `ABANDONED`：约束 `ck_run_tool_calls_operation_binding` 只允许未连 Operation 的行取 `REQUESTED`/`REJECTED`。

尚未覆盖、不得据此声称通过：停止与**完成**竞争下的写冲突（§20.2/§20.3 各自列出的那一项）、并发 Delegate 与过期 Worker 在写工具上的冲突覆盖、检查输出截断与取消的可辨性、Windows 自启动进程树停机证据、真实 Windows 窗口内由用户发起的人工路径。**本机 native helper 现对所有写路径返回 `DELETE_FAILED`，SW-01–SW-04 与一切落盘用例在本机无法复跑**（SW-05 不落盘，已单独跑过）；这是环境阻塞，不是产品缺陷。

### 20.7 人工触发的受管 Git 只读（2026-10-05 实施）

补 M06 的动作触发协议缺口：`prepareGatewayAction` 此前只接受 `RUN`/`USER_IMPORT` 两种 origin，人工触发的 Git 状态/diff 没有公开入口。规则归[工具适配器 §1](../architecture/tool-adapters.md)，契约归[命令契约 §10.57](../api/http-command-contract.md#1057-人工触发的受管-git-只读2026-10-05-源码实现)，物理设计归[第 61 节](../database/physical-design-postgresql.md)。出口是 `apps/api/test/integration/git-user-action.integration.test.ts`，跑真实 PostgreSQL、真实 `git` 与真实 HTTP。

| 编号 | 场景及必须成立的反例 | 判定 |
|---|---|---|
| GU-01 | 受管根内读取 | 真实 `git init` 仓库读到 `branch`、`head_commit`、`untracked`；`GIT_DIFF` 读到真实差异正文 |
| GU-02 | 根外与路径穿越 | `../`、反斜杠穿越、绝对路径 → `GATEWAY_TARGET_DENIED`；未知 `resource_id` → `RESOURCE_NOT_FOUND`；同用例末尾用合法相对路径证明不是「一律拒绝」 |
| GU-03 | 缺 `GIT_READ` 连接 | 只有 `FILE_READ` 连接的 Project → `GATEWAY_CONNECTION_DENIED`，且 `USER_ACTION` 行数前后不变（拒绝不留假事实） |
| GU-04 | 策略 AUTO / ASK / DENY | AUTO 直通并结算；ASK 建 `ACTION_APPROVAL`、确认前 `Invocation` 数为 0 且响应无 `result` 字段，`ResolveReview` 后**同一 `command_id`** 再次投递才读取且只读一次；DENY → `GATEWAY_PERMISSION_DENIED` |
| GU-05 | 重复投递只读一次 | 同 `command_id` 两次 → `replayed=true`、同一 `operation_id`、`invocation_attempts` 恰好 1 行；「回执未写下即崩溃」后重投返回同一次落库结果 |
| GU-06 | 非 Git 目录不得显示为干净 | 结算 `FAILED`、`failure_kind = GIT_REPOSITORY_UNAVAILABLE`，响应中**不含** `staged`/`unstaged`/`untracked` 任何一项 |
| GU-07 | 三条 CHECK 的行级守卫 | 直写 `logical_operations` / `invocation_attempts`：挂 `task_id`/`run_id` → `23514`；`GIT_WRITE`/`CLI_RUN`/`FILE_WRITE` → `23514`；`resource_id IS NULL` → `23514`；Invocation 带 `worker_id` 或 claim → `23514`；合法形态写入成功 |

尚未覆盖、不得据此声称通过：`USER_ACTION` 的**崩溃后自动恢复驱动**（`reconcileGatewayInvocation` 分支已就位但无调度器调用，停在 `DISPATCHING`/`UNKNOWN` 的调用永久未决、须人工核对、不盲重试）；并发双投递的**真实 HTTP 竞争**用例（代码路径与集成断言存在，但未写专门的并发 HTTP 用例）；Windows junction/hardlink 根替换竞争（与 `FILE_READ`/`FILE_QUERY` 同一未闭合限制）；真实 Windows 窗口、中文 IME、DPI；前端接入；安装、升级、卸载。独立验收未做。GU-01–GU-07 通过不改变 M06 模块状态，也不放行 Git 写侧、目录浏览或受控 CLI。

### 20.7.1 人工触发的受管目录浏览与文件读取（2026-10-24 实施，迁移 0134）

补 0058 遗留的人工只读缺口：`USER_ACTION` 词表新增 `FILE_QUERY`×`LIST_DIRECTORY` 与 `FILE_READ`×`READ_FILE`，服务右侧工具面板「文件」页签（前端未接线）。规则归[工具适配器 2026-10-24 段](../architecture/tool-adapters.md)，契约归[命令契约 §10.112](../api/http-command-contract.md#10112-人工受管目录浏览与文件读取2026-10-24-源码实现迁移-0134)，物理设计归[第 113 节](../database/physical-design-postgresql.md#113-0134-人工受管目录浏览与文件读取2026-10-24)。出口是 `apps/api/test/integration/file-user-action.integration.test.ts`，跑真实 PostgreSQL、真实目录与真实 HTTP。

| 编号 | 场景及必须成立的反例 | 判定 |
|---|---|---|
| FU-01 | 受管根内浏览与读取 | 真实目录一层条目（排序稳定、`kind` 区分目录/文件）、相对子目录、`limit` 截断显式；`READ_FILE` 读到正文与 SHA-256；审计 `MANAGED_FILE_READ_REQUESTED` 与动作同事务落账 |
| FU-02 | 参数与路径反例 | `READ_FILE` 缺 path / 带 limit、绝对路径、`..` 段 → `VALIDATION_FAILED` 且不留 Operation；不存在路径 → `GATEWAY_TARGET_DENIED`；`FIND_PATHS`/`SEARCH_TEXT`/写动作 → `GATEWAY_ORIGIN_DENIED` |
| FU-03 | 能力×动作双维词表 | 单测锁定错位组合（借 `FILE_QUERY` 读文件、借 `FILE_READ` 列目录）不放行；DB CHECK 直写证明 FILE_READ/FILE_QUERY×USER_ACTION 可入、写能力与脱资源形态仍 `23514` |
| FU-04 | 类型化失败不折叠 | 二进制 → `FILE_BINARY_UNSUPPORTED`、超大 → `FILE_TOO_LARGE`，结算 FAILED、无 `content` 字段、Invocation 状态如实 |
| FU-05 | 策略与连接 | AUTO 直通；ASK 先等待（无结果字段、无 Invocation）→ 确认后同命令读取一次；DENY/缺策略 → `GATEWAY_PERMISSION_DENIED`；连接缺能力或不存在 → `GATEWAY_CONNECTION_DENIED` |
| FU-06 | 幂等与刷新分界 | 同 `command_id` 重放原回执且恰一次 Invocation；**新 `command_id` 读到目录新变化**（与 GU-05 的冻结语义分界）；崩溃重投返回同一次落库结果 |

### 20.8 创建后人工补验收条件（2026-10-05 实施）

补「轻量起步建的 Task 无公开入口补验收条件」的服务端缺口：此前只能靠 AI 提案接受或 Skill 提案补齐。契约归[命令契约 §10.58](../api/http-command-contract.md#1058-创建后人工补验收条件2026-10-05-源码实现)。出口是 `apps/api/test/integration/task-acceptance-command.integration.test.ts`（真实 PG + 真实 HTTP）与 `apps/api/test/unit/task-acceptance-command.test.ts`。

| 编号 | 场景及必须成立的反例 | 判定 |
|---|---|---|
| TA-01 | 幂等 | 同 `command_id` 同载荷 → 原回执 + `Command-Replayed: true`；异载荷 → 409 `COMMAND_ID_REUSED` |
| TA-02 | 双 revision CAS | 旧 Task revision 与旧验收版本分别 `REVISION_CONFLICT`，`conflict.entity_type` 为 `TASK` / `TASK_ACCEPTANCE`；并发一胜一败且败者为 `REVISION_CONFLICT` |
| TA-03 | 历史版本不可改写 | 写入新不可变版本，旧 `acceptance_criteria` 行逐字节不变 |
| TA-04 | 旧周期证据失效 | 同短事务内验证适用性写 `ACCEPTANCE_CONTRACT_CHANGED` + `source_ref = task_acceptance_revision:<新版本>`、该 Task 的 `OPEN` Review 置 `EXPIRED`、旧 session 行保留 |
| TA-05 | 只收紧规则 | 删除/改写/降级既有 required criterion → 409 `INVALID_TRANSITION` + `conflict.criterion_ids`；新版本无任何 required → 422 `VALIDATION_FAILED`；可选 criterion 可改写或丢弃 |
| TA-06 | 执行权与终态闸门 | AI 占有执行权、有活动 Run、有未结算或 UNKNOWN 动作、状态已是终态 → `EXECUTOR_CONFLICT`（终态须先 `ReopenTask`） |
| TA-07 | 短事务单写 | 验收版本、criteria、Task 指针、验证撤销、Review 过期、审计、回执全在同一 `withTransaction` 内；无模型/网络/CLI/人工等待进入事务 |

尚未覆盖、不得据此声称通过：**前端入口**（用户在界面上仍点不到，产品缺口未闭合）；`hasChecker` 守卫分支无反例（四个 `CriterionMethod` 全部映射到已注册 checker，今天无法从公开请求触发，该分支未被覆盖）；本入口不做 Rule 准入检查（有意与 Task Skill 路径不同），带不可执行 HARD Rule 的 Project 会到 Delegate 时才被拒；真实 Windows 窗口、IME、DPI、安装升级卸载。独立验收未做。

「轻量起步」切片另有一项**与本节相邻但独立**的发现：`taskLightweightEntry.spec.ts` 的响应丢失用例曾是 `if/else` 条件式断言、两条分支都过，「Task 轻量入口走手动核对」这一事实当时无回归保护。2026-10-05 按用户决定保持现状差异化并补紧断言（锁住「未发生自动核对」与「保留原 `command_id`、`pendingStep` 未清」两组可观察事实），该口径是否统一仍待用户决定。

### 20.9 传统 Agent 检查失败后的自主修正（2026-10-05）

复用原 DRAFT、Gateway、范围授权、LangGraph 与人工完成门。规则归[运行架构 §2.3](../architecture/runtime-context.md#23-内部工具循环的对象身份与恢复2026-10-03-实施设计)，实际成绩只归功能验收表。

| 编号 | 必须成立的场景 | 出口 |
|---|---|---|
| CR-01 | 正常非零检查不带 reason，仍回传 `isError: true` 与逐字实际输出；成功复检为 false | `tool-loop.test.ts` 普通失败回放反例 |
| CR-02 | 真实子进程首次退出 1 → 读真实文件 → 按真实基线修改 → 同一冻结检查退出 0；用户无关文件、检查脚本不变；重放无新增效果；最终仍等待 HUMAN | `tool-loop.integration.test.ts` 真实检查修正用例 |
| CR-03 | 生产图收到失败检查后保存 `TOOL_CHECK_FAILED`，实际返回 advance 完成修正，持久化 Artifact、保留 OPEN HUMAN Review；原失败 claim RELEASED | `agent-check-graph.integration.test.ts`，真实 PG 与官方 Saver |
| CR-04 | 检查 ID 来自同 Run 冻结清单，任务不提供 ID 或修复值；生产 `runOneCommand` 领取目标 Run，真实 Provider 据失败输出中的随机值读取、修改、复检；官方 Saver 保存失败后继与 HUMAN 门，基线/实际 SHA、request id/用量、重放计数可核对 | `real-model-tool-loop.integration.test.ts` opt-in 修复探针；默认未配置时跳过 |
| CR-05 | 失权后的真实检查结果为 UNKNOWN，工具行保持 PREPARED，不进入模型历史；旧 SETTLED＋UNKNOWN 同样被权威 Operation 阻挡 | `tool-loop.integration.test.ts` 未知结果与旧数据反例 |
| CR-06 | 超时结算后重放仍是 FAILED，原 claim QUARANTINED，不新增 Invocation、不因 SETTLED 走成功路由 | 同上超时回放反例 |

2026-10-13 顺序接续：`run-prompts.test.ts` 约束工具 DRAFT 不用固定的读取顺序覆盖冻结任务的检查优先要求，并保持读写能力和外部数据边界；两条工具路由模板版本为 `1.0.1`。CR-04 的原顺序、真实退出码/输出、磁盘保留、HUMAN、Saver 与重放断言不降低；检查清单预期在委托前独立实测入口程序/脚本，校验其实际 SHA 后纳入完整 `trust_basis` 比较，以匹配当前检查信任协议。基础复跑只取正常功能与失败修正路径，不增加压力或复杂竞态用例。

CR-02 使用可控 Fake 工具序列验证机制，CR-03 使用生产 LangGraph＋Fake 模型，CR-04 使用真实 Provider＋生产调度图；三者分别报告，已配置检查的合成目录样本不代表真实 Windows 会话或任意用户项目通过。真实 Provider 只使用已授权配置及合成材料，不重试 RETRYABLE、不提高预算；是否实际通过只见功能验收表。Windows Job 管理、检查证据对受验产物的通用版本绑定、真实窗口/IME/DPI 与安装仍待覆盖；**脚本正文信任摘要已由 §20.10 覆盖**。

### 20.10 检查入口的信任摘要与检查证据适用性（2026-10-07 实施）

复用原范围授权、Gateway 准入与检查清单，不新建第二套授权系统。规则归[工具适配器 §1.5/§1.6](../architecture/tool-adapters.md#16-写差异与检查工具2026-10-04-实施)，实际成绩只归功能验收表。

| 编号 | 必须成立的场景 | 出口 |
|---|---|---|
| CT-01 | 冻结期把入口可执行程序、**第一个位置脚本参数**与受管根顶层构建/测试配置算成信任依据，随授权一并落库；被检查的源文件不进材料 | `check-trust-gate.integration.test.ts`；`check-trust-basis.test.ts` 反例 1/2/3/4 |
| CT-02 | 同路径、同命令名，入口脚本正文被改成固定成功：`check_id` 不变也不再 AUTO，退回人工确认，Review 的 `evidence.scope_decision_reason = SCOPE_GRANT_CHECK_CHANGED` | 同上「入口脚本被改」用例 |
| CT-03 | 只改被检查的源文件：原信任依据不变，检查仍按原授权自动执行（不得把工作集当程序） | 同上「只改被检查输入」用例；`check-trust-basis.test.ts` 反例 4/11 |
| CT-04 | 参数引用的脚本正文变化、构建配置变化分别让摘要变化；大小写、含空格路径、根外入口按同一规范身份参与 | `check-trust-basis.test.ts` 反例 2/3/7 |
| CT-05 | 材料读不到（缺文件、目录、摘要错误）报 `CHECK_TRUST_MATERIAL_UNREADABLE`；解释器内联求值（`-e`/`-c`/`--eval`）、shell 组合（`&&`/`|`/`;`/反引号/`$()`）与通配符报 `CHECK_TRUST_DYNAMIC_EXECUTION_UNSUPPORTED`，都在冻结期拒绝，不落授权 | `check-trust-basis.test.ts` 反例 5/6；`check-trust-gate.integration.test.ts` 内联求值用例 |
| CT-06 | 历史授权行只有入口摘要、没有材料依据：仍可解析，但按「依据不一致」退回人工，不得当成摘要相同放行 | `check-trust-basis.test.ts` 反例 9；`check-trust-gate.integration.test.ts` 历史行用例 |
| CT-07 | 同一组输入重复计算得到同一摘要；不涉及宿主执行的只读工具、写动作与普通助手不被新机制误挡 | `check-trust-basis.test.ts` 反例 8/10 |
| CT-08 | **选项结束标记 -- 之后的执行入口必须计入材料**（2026-10-08 补）：`node -- --entry.mjs src/value.txt` 中 `--entry.mjs` 是真正被执行的入口（Node 24 实测；去掉终止符时同一参数是 bad option），不得继续按 FLAG 跳过。须区分终止符之前的开关、开关值、选项结束后的执行入口（第一个位置参数）与受验输入（其后位置参数）。冻结后修改该入口必须使摘要变化并退回人工（SCOPE_GRANT_CHECK_CHANGED）；冻结时入口缺失必须报 CHECK_TRUST_MATERIAL_UNREADABLE 而非落一份漏算入口的授权 | check-trust-basis.test.ts「terminator after the option terminator」等 4 条；check-trust-gate.integration.test.ts 两条真实 PG 用例（正常 Delegate/Gateway/工具执行链） |
| CT-09 | 终止符只在**入口之前**有「选项结束」含义：解释器选项解析在第一个位置参数处停止，入口之后的参数（含 -- 自身）全部是脚本 argv。`node check.mjs -- --verbose` 必须与 `node check.mjs` 同摘要，不得误判为无法证明；`node --test -- a b` 的全部显式入口仍进材料；`node -- --` 等不可证明形态仍明确拒绝 | check-trust-basis.test.ts「terminator after the entry」「the option terminator after --test」「terminator forms whose execution range cannot be proven」 |
| CT-10 | **选项值的位置与身份（2026-10-08 补）**：等号右侧是**值**，不是选项，不得再按选项解析。`node --env-file=-- check.mjs` 实测真实读取受管根内名为 -- 的文件并注入环境，因此该文件**必须进冻结与执行前核对材料**；改其内容必须使摘要变化并退回人工（SCOPE_GRANT_CHECK_CHANGED）。缺失/是目录必须 CHECK_TRUST_MATERIAL_UNREADABLE，不得静默通过。分离形态 `node --env-file -- check.mjs` 实测报 --env-file requires an argument、一个脚本都不执行 → 执行范围无法证明，明确拒绝。`--import=--` 等「值为 --」按**开关身份**命中动态加载而一致拒绝，不因值看起来可读而放行 | check-trust-basis.test.ts 值形状相关用例；check-trust-gate.integration.test.ts 环境文件四条真实 PG 用例（正常 Delegate/Gateway/工具执行链） |

`check-trust-v1` 的材料集合是**有限、明确、可枚举**的：入口可执行程序 + 第一个位置脚本参数 + 受管根顶层构建/测试配置名单。后续位置参数是这次检查的**输入**（工作集），不进材料——把它算进材料会让「检查失败 → 修正 → 再跑同一检查」这条主链直接不可用。检查程序自己 import 的兄弟模块同样不在材料内，这是本版明确的**范围限制**，不用静默少算材料维持 AUTO。`computeCheckTrustBasis` 不放宽连接允许清单与用户授予的动作权限。

CT-11（2026-10-09 实施，正式回归在 `check-trust-gate.integration.test.ts`）：范围授权因材料变化退回 ASK 后，Review 必须绑定**创建时**观察到的检查材料依据，批准提交与最终派发准入各自核对一次。核对输入只来自已持久化的 Operation 事实（`op.params` 的 executable/args ＋ 受管资源 canonical root），不信任调用方自报摘要。场景与断言：

| 场景 | 必须验证的结果 |
|---|---|
| 冻结后改脚本、创建 Review，材料此后保持不变 | Review target 的 `check_trust_basis` 等于**创建时实测**摘要（不等于最初授权冻结摘要）；批准后真实执行该材料，stdout 与账本可核对，且只有一次 Invocation |
| Review 创建后、批准前再次改脚本 | `resolveReview` 拒绝保存 APPROVE；`invocation_attempts` 为 0，无任何未批准执行痕迹 |
| 批准后、派发前再次改脚本 | 恢复领取 Worker 与派发准入都拒绝；Operation 身份保留、不派生第二个动作，工具行落下可核对的类型化原因 |
| 材料变更后按原任务的领域入口重新确认 | 原 Task/受管资源在安全收口后能够合法接续，新 Review 绑定当前材料且旧历史保留；**不得**用两个独立 fixture 的新 Task/新目录替代（那样只证明新任务能跑） |
| 已批准后撤销范围授权 | 按 SC-13，范围授权撤销不追溯撤销确切单动作批准；必须用真实批准产生的 RESUME，严格断言它**执行**并只执行原 Review 的材料（不接受「成功或失败都行」） |
| 已批准后撤销 Permission | 用真实批准产生的 RESUME 严格断言零 Invocation、类型化原因 `GATEWAY_PERMISSION_DENIED`，以及拒绝后 Operation→`DENIED`、工具行→`SETTLED`、Run→`FAILED`、Task→`READY` 的完整收口 |
| 批准后材料失效的拒绝收口 | 完整 START→图中等待→真实 RESUME 链中，确定未执行的拒绝不能让原 Operation/Run/Task/命令悬空：Operation→`DENIED`、Run→`FAILED`、Task→`READY`、两条 outbox 均 `DONE`、无待投递命令，`advanceRunStep` 返回 `RUN_TERMINAL` 而**不是** `ACTION_UNKNOWN` |
| 拒绝收口后的重复投递与继续推进 | 再次投递无可领取命令，工具行仍 `SETTLED`、Invocation 仍为 0，不产生第二次副作用 |
| 真实 DISPATCHING/UNKNOWN 对照 | 在途调用必须落 `UNKNOWN`（工具行仍 `PREPARED`、Run 仍 `RUNNING`、待处理控制停在 `PENDING`），不得被收口捷径当成「确定未执行」 |
| 审批记录缺少材料依据（升级前形状） | 保守拒绝，不猜摘要、不把旧批准自动升级为有效，且不产生任何真实调用 |

CT-12 的完整图反例单独成文件（`check-trust-refusal-lifecycle.integration.test.ts`）：`claimNextRunCommand` 按整库选取待投递命令是生产语义本身，不带 workspace 过滤，因此任何用 `runOneCommand` 驱动真实图的用例都必须独占一个数据库，否则一次投递可能领取到别的用例留下的命令。运行器为每个测试文件克隆独占库（见下「集成套件的数据隔离」），该文件因此自带最小 fixture，不与 `check-trust-gate` 共用。

测试用真实 PG、受管临时目录与真实 Node 脚本，核对真实账本、调用是否发生、状态与 stdout，不以某个抛错文本或范围授权降级代替派发边界断言。最终核对与外部进程真正读取之间仍是同机文件系统上的时间差，因此这些用例**不**宣称操作系统级隔离或任意动态依赖安全。

**集成套件的数据隔离（2026-10-09）**：`run-integration.ps1` 为**每个**测试文件用 `CREATE DATABASE ... TEMPLATE ... OWNER relay_migrator` 克隆出独占数据库，跑完即删，文件之间仍串行。原因是生产语义本身按整库选取——Assist 领取 `claimNextPendingMessage`、Run 命令队列与维护准入都不带 workspace 过滤，`--test-concurrency=1` 只保证文件不并发执行、不提供任何数据隔离。共享一个库时，先跑的套件遗留的 PENDING 消息会被下一个套件启动的真实 API 进程领走，形成「单跑全绿、串行全量失败」的不可归因组合。生产 claim 逻辑、维护门与连接安全门都不因此放宽，也没有测试专用绕过。`owner relay_migrator` 必须显式指定：`CREATE DATABASE ... TEMPLATE` 默认把新库交给执行者（管理员），而 `public` schema 归 `pg_database_owner`，owner 变了迁移角色就失去建表权限。

同一文件内的用例共享一个库，因此**驱动真实图投递的用例不能与其它用例同文件**：`claimNextRunCommand` 会按整库顺序领取任意 Run 的待投递命令，一次投递可能拿到别的用例留下的命令（2026-10-09 实测：完整图反例首次 `deliver()` 领取到的是前一个用例的 START）。这类反例必须独占一个测试文件。

运行器另有两条不得放宽的要求：`-TestFile` 指定的每个文件都必须解析到真实存在的源文件（少匹配任何一个都要报错，不能静默少跑）；收尾的 `pg_ctl stop` 与临时目录删除必须成功才记 PASS。

完成门的反例须分别覆盖「验证目标与当前候选版本不一致」和「版本一致但产物种类不满足冻结 expected outputs」。后一 fixture 必须保留正确的当前候选绑定，使其真正到达输出覆盖检查；不能只因两种反例都返回 BLOCKED 就把原输出覆盖断言换成版本陈旧而丢失该门的验证。2026-10-09 据此把 `verification.integration.test.ts` 拆成两条：第一条删空 `verification_targets`，断言 `VERIFICATION_TARGET_STALE`（绑定门）；第二条保留 target 不变、只把冻结 `expected_outputs` 换成产物集合覆盖不了的形态，断言 `DECLARED_OUTPUTS_UNSATISFIED`（输出覆盖门）。两条都核对未写完成事实、Run 仍停在 `VERIFYING`。

迁移完整性断言不得写死条数：备份/恢复类测试改为用**仓库当前迁移清单**（名称 + 内容摘要）与数据库里的 `relay_schema_migrations` ledger **逐条双向核对**（缺行、多行、摘要不符都失败，ledger 用迁移角色连接读取，因为应用角色对它没有 SELECT）。只比条数会把「61 条里换掉一条」读成通过，因此不采用；已有 migration 不回写。

**桌面停机与租约恢复用例的一条断言边界（2026-10-09 修正）**：`run-dispatch` 的「desktop EOF during Assist generation」原先断言租约清扫后 `model_calls` **恰好一行**。`recordModelInvocation` 的保证是「begin 行在调用 Provider 之前提交」，**不是**「消息一旦被领取就一定留下调用行」；EOF 与 Worker 领取之间存在调度窗口，Worker 在跨过该边界前被杀是合法结果。断言已改为「恢复后不得出现**第二次**模型调用」（`0n` 或 `1n`）——这才是该用例真正要锁的安全性质，也与用例名声明的两项行为（不伪造用户取消、claim 以 `LEASE_LOST` 收敛）一致。原断言在当前机器负载下会间歇失败（实测同一次执行 1 通过 1 失败），它把调度时序当成了产品契约。

**桌面维护会话的环境前置**：`backup` 与 `restore` 需要 `createBackup` 打开真实桌面维护会话。原生侧 `acquire_single_instance_named` 用 `CreateMutexW` + `ERROR_ALREADY_EXISTS` 判定，已有 Relay 桌面实例在运行时必然返回 `MAINTENANCE_SESSION_BUSY`（`maintenance_session.rs` → `lib.rs`）。这是单实例守卫按设计工作，不是产品缺陷，也不是套件隔离问题；2026-10-08 基线日志中 `restore` 已出现同一错误。这类用例只有在没有桌面实例占用该命名互斥量时才能取得通过结果，不得为此停用维护门或连接安全门。

`observedExecutableSha256` 与信任摘要在 prepare 与 admit 两处由同一个 `evaluateScopeGrant` 判定；`run_check` 的可信 exit0 只表示这一次检查对其受验输入正常结束，不代表业务验收 PASS、人工接受或 Task 完成。

## 21. 有界多 Agent 与自动会话验收规格

2026-10-05，**已确认产品规则 / 待核定工程设计 / 未运行规格**。本轮只补文档和实施提示词。范围归[总纲 §0.9](../../Personal_Workflow_OS_Master_Spec.md#09-有界多-agent-与自动会话)，Owner/恢复归[运行架构 §2.5](../architecture/runtime-context.md#25-有界子-agent-的委派与会话关联)，交互归[工作台 §23](../frontend/workbench-design.md#23-主子会话与有界协作)。本表不表示测试已写或已通过。

| 编号 | 场景及必须成立的反例 | 必要证据 |
|---|---|---|
| MA-01 | 明确独立新需求创建主会话，同需求补充留原会话，模糊输入先澄清；纯建会话不创建 Task/Run，不调用 Apply/Delegate | 严格解释/命令反例＋真实 PG/HTTP；保留真实用户消息来源 |
| MA-02 | 同原消息/命令同载荷并发或响应丢失只建一次主/子会话、委派及实际 Task/Run；异载荷拒绝，重开查询原回执不生成新身份 | 真实 PG 并发/唯一性＋创建保存后回执前故障点 |
| MA-03 | 子会话关联确切项目、主会话、主 Run 和原委派；跨 Workspace/项目/执行、伪造父身份、孤立子关系被拒；旧普通会话保持可读且不虚构父子 | 真实 PG/HTTP 归属、权限、旧数据与旧深链兼容反例 |
| MA-04 | 角色配置可复用，每次委派冻结配置/来源版本和独立上下文；后续配置/历史修改不污染在途输入，不复用上一委派记忆 | 真实持久快照及模型收到的输入，来源失效另作反例 |
| MA-05 | 主模型实际派发调查、收到反馈、实施、再派独立审查并汇总；子不另占 Task 执行权或直接完成业务 | 可控模型＋真实 PG/工具；核对调用、反馈和父推进关联，预填结果不算执行 |
| MA-06 | 两个独立子任务真正同时在途，第三个不得启动；子再次委派被拒；父等待不占满子槽，子结算与父等待竞态能唤醒一次 | barrier 控制的真实 PG/Worker 并发，槽/claim/唤醒依据可核对 |
| MA-07 | 主子调用共享原 Run 总预算，主汇总额度保留；并发预留不可超发，已知用量据实，STARTED/未知用量保守占用，超额不外呼 | 真实 PG 预算竞争＋模型调用次数/实际用量账本，不能仅检查串行计数 |
| MA-08 | 子文件写、CLI、Git 写、改权限和递归委派均拒绝；父写权限不传为子能力，撤权/隔离在实际只读调用前有效 | 严格 schema＋真实 Gateway 准入反例；无实际文件/进程副作用 |
| MA-09 | 原 Run、委派、Attempt、claim/epoch 与 revision 共同限制结算；过期 Worker/终态迟到结果不能覆盖当前汇总或唤醒父执行 | 真实 PG 的重复 claim/迟到结果/CAS；已发生调用用量仍留账 |
| MA-10 | 用户直接补充子会话持久保存并一次同步主来源；重复投递不复制或形成消息循环，主/子文本不伪装为 USER 授权 | 真实 PG/HTTP 投递/消费回执＋组件来源；结果不含虚假执行授权 |
| MA-11 | 在途补充仅在安全点用于后续尝试；已结束会话收新消息不复活旧 Run；超范围重派仍检查原授权，影响必要审查基线的补充使旧反馈待复核 | 可控模型输入快照＋真实 PG/HTTP；准确排队/已消费/待决定呈现 |
| MA-12 | 审查等待相关改动形成并绑定确切未提交内容/版本；读取期间漂移、修复或验收条件变化时旧意见不能覆盖新基线 | 真实磁盘/PG 的摘要与适用性反例＋复审关系，不仅核对 Git HEAD |
| MA-13 | 已确认失败最多一次修正重试，原委派和失败关系保留且计总预算；调查继续失败由主接续，必要审查继续失败暂停交付 | 失败注入＋调用次数/输入修正/必要性冻结，主自审不能填独立依据 |
| MA-14 | 未知调用先按原身份核对，外部 UNKNOWN 不换 Adapter/ID 绕过；模型 STARTED 不被补成 FAILED、零用量或无成本成功 | 调用启动后结果落库前故障点＋持久账本/核对出口 |
| MA-15 | 父暂停/取消/交接立即阻止新委派及新子调用；在途安全处理前仍显示停止中；子完成/汇总/正式完成竞争不能穿过控制 | 真实 PG＋可控挂起调用/barrier＋停止证据与原完成 Gate 回归 |
| MA-16 | 单个子任务取消不取消父需求，也不触发自动修正重试；必要子审查取消仍保留交付缺口，失效父授权拒绝新补充执行 | 真实 PG 控制/授权反例＋组件状态 |
| MA-17 | 子结果保存未投递、投递未消费、主汇总保存回执丢失各处崩溃后沿原关系接续一次；重读不自动 Resume，不重复已完成模型/工具效果 | 新进程＋真实 PG/Fake Adapter 故障点，核对原身份、调用计数及结果 |
| MA-18 | 子声明完成或主汇总成功，但验证缺失/FAIL/ERROR、Review 未接受、版本不适用或完成 Gate 拒绝时，Task/Run 不成功；即使其他 Gate 满足，已冻结必要审查仍缺失/失败/取消/过期/归属不符或阻塞未解时，Application 拒绝完成提交，主模型不能删改必要标记绕过 | 原业务完成事务/验证回归＋确切 Artifact/条件/约束/委派/反馈基线关系；处理或豁免核对原授权与决定来源 |
| MA-19 | 项目→主→子投影默认折叠但待人工提示可见；Task 管理/旧 URL/分页可达，切会话晚到结果不串联，失权不泄露内容/名称/数量 | 真实关联查询＋受控组件/浏览器状态与范围反例 |
| MA-20 | 首次读取/订阅窗口内唯一更新、重复 hint、断线/seq 缺口与重连仍读到当前 revision；旧快照不倒退，展开/阅读不发写命令 | 真实 HTTP/SSE＋受控更新窗口，保持原消息/Run Owner |
| MA-21 | 创建/发送未决命令、草稿、目录切换守卫与恢复来源保留；Loading/失败/预算/必要审查/停止中/UNKNOWN 均可达 | 组件/浏览器故障反例＋确切 Windows 包下真实 API/PG 人工路径 |
| MA-22 | 实际两个只读子执行、直接补充、停止/重启与审查回主可操作；中文 IME、键盘、短窄窗和 DPI 不遮挡输入/风险；Provider 实际调用和用量另验 | 匹配源码的 Windows 包；真实 Provider 仅已授权配置＋合成材料定向，分层列限制 |

实施顺序归[专项提示词](../../prompts/bounded-multi-agent.md)：先核对单 Agent 相关依赖，再按 A 持久协议、B 真实子执行/预算/控制恢复、C 会话 UI 与真实窗口出口推进；每片自检、独立验收、修复复验后才进入依赖片。旧单 Agent、工具循环、审批/UNKNOWN、业务完成和旧 checkpoint 的受影响回归必须保留。各层实际结果只更新[功能验收表](overall-acceptance-2026-09-28.md#当前功能验收表)，不以文档检查或 A 片数据库通过宣称子执行能力已交付。

效果评价：实施时冻结代表性软件需求、单 Agent/人工转述基线、相同验收要求与协调动作计数规则，记录用户实际转述、分派和催办次数，以及必要澄清、失败处置、耗时、调用用量/成本和审查遗漏。主要比较人工协调动作，不能用子会话数替代；报告任务差异、样本量和未测项，未冻结阈值不宣称整体效果通过。效果测量与工程 Gate 分开，不自动启动论文实验或外发用户项目材料。

## 22. 未来需求驱动软件协作验收规格

2026-10-06。来源为用户已确认的[产品规则](../../Personal_Workflow_OS_Master_Spec.md#010-需求驱动的软件协作)、[未来路线](../requirements/post-v1-roadmap.md#7-已确认的未来软件协作能力)和[交互流程](../frontend/workbench-design.md#24-需求驱动的软件协作)。**以下均为未运行规格，工程协议和效果阈值待核定；文档检查不证明这些能力可运行。** 不自动加入现有 M/N 首片或已经通过的出口。

| 场景 | 未来必须验证的行为 |
|---|---|
| FSC-01 需求与同源文档 | 复用已有资料和有效决定，按功能组织需求；需求项和文档视图指向同一有效版本，导出能追溯；待讨论想法不被描述为已确认要求，纯讨论不制造执行 Task；§24 的明确修改指令可表达确认，不普遍要求重复接受点击 |
| FSC-02 文档修改与候选 | 仓库修改产生有原基线、来源和差异的候选，不静默覆盖产品有效要求；重复同一变化不反复生成待处理，人工修改保留，过期候选不复用旧接受 |
| FSC-03 语义冲突 | 对话、文档和原型反馈发生矛盾时，提供原要求、各来源修改、分歧与影响；用户选定方向后能看清有效内容和仍待处理部分，模型建议不自行升级为事实 |
| FSC-04 分层影响调查 | 已登记关系、调查推测及未检查范围能区分并追到依据；用有已知关联与刻意缺口的样板检查遗漏表达，不把单次调查当作完整依赖图 |
| FSC-05 当前计划草案 | 重要事实变化合并到项目当前草案，新增必要工作能关联有效需求及缺口依据；产品扩展想法留待讨论，接受计划不 Delegate，新增候选不进入旧任务链授权 |
| FSC-06 审阅版本与部分确认 | 审阅版本固定，新事实提示更新；可先确认需求再处理计划/知识，必要前置和受影响工作可见，不按过时要求继续，独立事项不因视图分组获得新的执行权 |
| FSC-07 原型反馈与覆盖 | 按需交互原型的使用流程和页面整体反馈可关联确切需求；成功/失败/取消等路径的已确认与未讨论范围可辨认，反馈形成需求候选，原型认可不替代正式功能验收 |
| FSC-08 经验候选 | 从已完成成果及证据中提炼有复用价值经验，普通日志不默认进入知识；来源、适用条件、未知和相似条目可核对，用户确认后才进入既有导读；明确收录命令的确认路径按 §24 验证，自动提炼仍为候选，不自动改写 Rule/Decision |
| FSC-09 知识适用性 | 项目做法变化提出复核候选，用户可保留、修订或转历史；后续引用显示复核状态和原适用条件，历史来源不被改写，不把模型推测直接作为失效事实 |
| FSC-10 集中审阅 | 同一需求汇集相关种类候选，项目级计划仍为同一草案；每项有自己的来源、决定和处理结果，候选依赖与延后事项可见，不把一次页面确认等同所有动作授权 |
| FSC-11 拒绝与持续排除 | 相同依据和条件下不重提，实质变化时说明新依据；持续排除只能由用户明确解除，换措辞或标识不能绕过，项目内理由不自动成为跨项目偏好 |
| FSC-12 接续与控制回归 | 重启或返回时重读有效事实及候选状态，有明确基线才生成期间差异；§24 的日常查看基线与命名点分开，失败不覆盖有效基线，返回可信检查须独立准入；不自动 Resume/放行新增任务，保留原审批、停止中、UNKNOWN 核对和版本绑定的完成约束 |

工程冻结后分别覆盖真实持久化/幂等/并发、受管文件变化与可控模型、真实 API/Windows 用户路径；自动生成还须验证启用来源、预算、重复/退出/重启的协议。各项结果只在实际运行后进入[功能验收表](overall-acceptance-2026-09-28.md#当前功能验收表)，不先写“通过”。

使用效果样板串联“仓库需求变化 → 原型反馈 → 计划调整 → 有证据的成果 → 知识候选 → 隔日接续”，并保留延后、拒绝、过期和部分确认的路径。主要观察人工转述、分派、衔接和催办动作是否减少，同时记录需求误解/返工和恢复理解成本；沿 N00 的基线规则在对比运行前核定计数、样本及阈值，不以候选数、自动调用量或单次演示宣称收益。

## 23. 会话模式与人设助手验收规格

2026-10-05 为 [ADR-018](../decisions/ADR-018-assistant-conversations.md) 落盘。**本节是未运行规格**：写在这里不等于已验证，实际成绩只看[统一功能验收表](overall-acceptance-2026-09-28.md#当前功能验收表)。后端子项（AR-PB）的运行结果已在验收表对应行，本节记录尚未跑的前端与人工路径。

### 23.1 已实现并有真实 PostgreSQL 证据的后端子项

| 编号 | 场景 | 期望 |
|---|---|---|
| AR-PB-01 | 建会话时冻结身份 | 助手模式会话把名字、角色、口吻、只读范围与当时修订冻结进会话；改写助手不改变既有会话显示的人设 |
| AR-PB-02 | 快照不含授权 | 冻结快照只含四个文本字段；CHECK 挡住 capabilities / connections / permissions |
| AR-PB-03 | 只读范围只能缩小 | 绝对路径、`..`、空串、其他键、超过上限项数全部被字段错误拒绝 |
| AR-PB-04 | 同名与跨作用域 | 活跃名在 workspace 内唯一，重名不改已有助手；跨 workspace 的助手建不出会话 |
| AR-PB-05 | 既有会话兼容 | 迁移前插入的会话按普通模式读出，四个助手列为空 |
| AR-PB-06 | 重放 | 同 `command_id` 同载荷返回原会话；换模式重放按异载荷拒绝 |
| AR-PB-07 | 真实只读轮次 | 模型发出「搜索 → 读文件」序列，回传给模型的读取结果是磁盘真实正文，磁盘逐字节未变 |
| AR-PB-08 | 词表按当前连接裁剪 | 给了目录浏览与读取连接时词表恰为四个只读工具，Git 与写工具不在列；连接停用后词表当场收窄 |
| AR-PB-09 | 执行链未被创建 | 一轮结束后该 Project 的 Task、Run、范围授权、Run 工具调用计数全为 0 |
| AR-PB-10 | 只读动作有账本 | 产生的逻辑动作来源为助手来源，capability 只在只读集内 |
| AR-PB-11 | 写请求被拒 | 模型请求写工具时该行被拒、不连任何 Operation、不落一个字节、目录里没有新文件；模型随后改用只读回答 |
| AR-PB-12 | 同轮同序号唯一 | 重复插入同一 `(session, message, round, ordinal)` 被唯一约束拒绝 |
| AR-PB-13 | 跨身份冒用被拒 | 把助手行指向一个不存在或非助手来源的 Operation 都不成功 |
| AR-PB-14 | 不排队 | 上一条在途时再发被拒且文案不含「排队」，被拒的那条不留下消息行 |
| AR-PB-15 | 助手档拒绝 Skill 与提案 | 两条都被拒，文案说明原因 |
| AR-PB-16 | 归档冻结 | 助手归档后既有会话发消息被拒并带下一步指引，历史仍可读 |
| AR-PB-17 | 停止通道唯一 | 取消助手档消息直接收敛为已取消，不产生第二个停止资源 |
| AR-PB-18 | 普通档未受影响 | 普通会话的提案意图与 Skill 判定逐字未变 |

### 23.2 前端单选框与呈现

以下 AR-PB-19 至 AR-PB-22、AR-PB-24、AR-PB-25 的主体已由 jsdom + fetch 打桩覆盖（`apps/workbench/tests/assistantModeSwitch.spec.ts`），真实浏览器几何与窗口行为仍未跑；AR-PB-23、AR-PB-26、AR-PB-27 未运行。

| 编号 | 场景 | 期望 | 本轮状态 |
|---|---|---|---|
| AR-PB-19 | 两档渲染 | 单选框两档可选；助手档隐藏发送选项并显示只读说明 | 已覆盖（jsdom） |
| AR-PB-20 | 标签文案 | 普通档标签不含「子 Agent」等未实现承诺 | 已覆盖（jsdom） |
| AR-PB-21 | 切换等于换会话 | 切档触发导航到另一条会话，且不重复建会话 | 已覆盖（jsdom）：切档只改目标身份与会话选择，不发建会话命令 |
| AR-PB-22 | 在途禁用切换 | 有在途回复时两档都禁用并给出原因 | 已覆盖（jsdom）：禁用落在 fieldset，文案说明「停止后才能切换」 |
| AR-PB-23 | 草稿守卫 | 未发送草稿留在原会话，离页守卫照旧 | 未运行 |
| AR-PB-24 | 助手行标签 | 显示助手名与人设修订，不用「AI」 | 已覆盖（jsdom） |
| AR-PB-25 | 不渲染执行摘要 | 助手档不出现「按这个执行」；工具卡片标注只读且无审批四态 | 部分覆盖：摘要与提案入口已覆盖；只读工具卡片与审批四态需真实会话，未运行 |
| AR-PB-26 | 键盘与中文 | 单选组方向键可达；中文输入法合成中回车不发送；窄窗不溢出 | 未运行 |
| AR-PB-27 | 撤销后的呈现 | 助手归档后输入区给出「换一个助手」指引；连接撤销按类型化原因呈现 | 部分覆盖：助手清单读取失败会给出原因；归档冻结与连接撤销后的呈现未运行 |

新增两条本轮实测暴露的边界：

| 编号 | 场景 | 期望 | 本轮状态 |
|---|---|---|---|
| AR-PB-31 | 深链承载身份 | `?mode=` 深链在协作页保得住工作目录 | 已确认**不成立**：路由出口按 `pathname + search` 重挂载，工作目录是组件状态。身份改由协作页持有，见[工作台 §25.4](../frontend/workbench-design.md#254-导航与深链)；深链未做 |
| AR-PB-32 | 助手会话发送载荷 | 助手档消息不带 `intent` 也不带 `skill_ref` | 已覆盖（jsdom 打桩断言载荷字段） |

### 23.3 未运行：真实窗口与真实 Provider

| 编号 | 场景 | 期望 |
|---|---|---|
| AR-PB-28 | 真实 Windows 人工路径 | 用匹配最终源码的确切包走一遍「建助手 → 新建助手会话 → 只读提问 → 停止 → 归档 → 冻结」 |
| AR-PB-29 | 真实 Provider 助手会话 | 只读工具调用真实发生，回复质量与边界遵守如实记录；缺授权配置时明确写未运行 |
| AR-PB-30 | 安装升级卸载 | 迁移 0059/0060 在真实安装路径上可应用且可回滚 |

### 23.4 与既有套件的回归要求

助手档的任何改动都必须保持 `tool-loop`、`folder-first-conversation`、`conversation-execution` 三套既有用例全绿——它们分别覆盖 Run 侧工具循环、普通档的文件夹入口与解释链路。共享代码（模型端口的 `TOOL_CALLS` 变体、Gateway 来源分派）被本专项改动时，这三套是回归闸门。

## 24. 自然语言状态维护与自动接续验收规格

2026-10-09 定义，2026-10-10 补充独立反例。依据用户已确认的[总纲 §0.8.1](../../Personal_Workflow_OS_Master_Spec.md#081-自然语言维护项目状态)、[交互 §18.9](../frontend/workbench-design.md#189-自然语言状态维护与接续摘要)与[应用边界 §12.5](../architecture/domain-model.md#125-自然语言状态维护的应用边界)。**本节只维护规格；部分工程场景已运行，当前成绩与未覆盖范围只归功能验收表。单个切片或测试通过不能提升整个 NLS/M/N 出口；效果阈值仍待核定。**

| 编号 / 场景 | 必须验证的行为与反例 |
|---|---|
| NLS-01 统一入口与同源状态 | 目标、需求、任务、计划、进度、阻塞、决策和知识在获授权切片内可由对话维护，各页面读取同一确切对象/版本；缺失 Owner/入口如实显示，不用聊天缓存冒充已保存事实；无模型人工入口保留 |
| NLS-02 明确指令与候选 | 明确对象/内容/范围的原用户命令可承载对应确认，无重复表单或普遍接受点击；纯讨论、模型总结、自动提炼、仓库修改仍为候选；目标歧义/关键缺项只聚焦澄清，不猜测授权或跨项目对象 |
| NLS-03 连带承诺 | 延后导出只直接改变明确要求及有依据的相关事实；依赖导出的发布承诺先显示影响并取得具体决定，不自行推迟发布或删除发布条件；部分命令失败不显示全部已生效 |
| NLS-04 外部进展 | “其他工具已做好”有用户来源标记，主动核对对应分支/成果、确切版本和原完成条件；证据缺失/过期、检查 FAIL/ERROR、仍需人工验收时不判完成。明确的完成/人工接受指令绑定确切产物与条件，满足原完成规则后由原用例提交；一般修改命令或外部自报不能代替完成确认/用例 |
| NLS-05 返回触发与检查准入 | 返回项目触发有授权的轻量核对和相关可信检查；每次校验权限/可信材料/预算/目录资源；失权、无配置、超范围或命中审批时不调用未获准工具。返回不自动修复、Resume、创建新任务执行或持续后台监控 |
| NLS-06 日常基线与命名点 | 已查看日常摘要后，下次比较使用该次可追溯状态；首次/无基线只展示当前事实；State revision 不变但 Task 新增/关闭时也能更新实际查看基线，已看过变化不反复报新增；同 State revision 的迟到旧确认不覆盖新查看结果。查看不改写命名接续点、不接受候选、不表示接手/完成；未解决事项持续显示 |
| NLS-07 读取失败与迟到结果 | 局部失败、失权、版本漂移、核对未完成和迟到结果显示对应缺口，不覆盖有效日常基线或显示“没有变化”；切换项目/目录后的旧结果不回写当前卡 |
| NLS-08 轻量深度与证据复用 | 无变化且证据仍绑定当前成果/条件时复用，不重复检查；有变化优先相关轻量检查，全量/耗时检查另行提出。条件变化、来源失效、权限/可信材料改变时重新核对适用性，不把未覆盖范围算 PASS |
| NLS-09 重复返回与恢复 | 同次未决核对的重复打开、双击、断线和重启按原关系核对，不重复外呼/检查或换动作身份重发 UNKNOWN；核对中、停止中及已停止根据持久事实显示，预算与检查配置协议冻结后补竞争反例 |
| NLS-10 摘要与必要判断 | 顶部接续卡更新返回结果，指令回执留在原对话；默认简短结论，展开可读前后/依据/影响/确切成果。失败、冲突、重要影响、待决定及 UNKNOWN 在折叠状态仍可见；组件/浏览器呈现不能代替真实写入或检查 |
| NLS-11 纠正与整组撤回 | 自然语言纠正绑定原对象；撤回默认针对原指令实际生效的整组可撤回状态变化，无逐项必填；应用旧候选或撤回旧指令不覆盖后续人工修订，包含改回同值的后续修改；整组包含不可撤回项、后续依赖或在途工作时，补偿前说明修正范围与影响并取得具体决定，不自行只撤回部分。重复关联没有新增效果时不删除原已存在关系；历史与来源保留 |
| NLS-12 撤回与外部效果 | 不回滚全库/全项目快照，不把状态撤回显示为文件/发布效果已撤销；不恢复旧批准、PASS 或执行权，原 UNKNOWN 保持核对；部分成功及补偿结果逐项如实呈现 |
| NLS-13 原命令与回执 | 修改/接受/撤回在结果保存前后注入响应丢失，冻结原消息、命令与载荷，先查原回执；同 command_id 改载荷拒绝，同一原消息并发只由持久 Owner 发起一次解释；模型明确失败不能永久留 INTERPRETING，UNDOING 提交后故障按原身份核对并恢复剩余补偿。重开/重试不重复对象或版本，排队不显示已生效，模型自报成功不代替业务回执 |
| NLS-14 权限与控制回归 | 助手档继续只读；对话指令不绕过权限撤销/动作批准；计划接受不 Delegate，新增工作不进入旧连续授权。活动 Run 范围变化保留冻结契约、持久安全控制、资源排他与停止/完成竞争保护 |

候选入口另须验证：非空但形状非法的 `decision_required` 不得退化成无需决定后自动写入；合法/非法变更混合时保留原顺序和每条原因或整单澄清，不丢失非法条目后显示整组 APPLIED。需要决定的续答绑定确切原内容与版本，不另算方案替代确认。

**2026-10-10 形式化回归落点（已实现并运行的正式场景，成绩只归统一验收表）。**

| 规格点 | 正式测试位置 |
|---|---|
| 4.1 反例 A/B（旧候选不覆盖后续人工修改、撤回不覆盖后续修改、同值修订同样识别、目标身份被替换） | `conversation-state.integration.test.ts`：「应用旧候选不覆盖确认之后的人工修改（4.1 反例 A）」「同值后续修订同样识别为冲突：不只比较字段值」「确认时点的目标身份被替换时按冲突拒绝」「撤回不覆盖确认之后的人工修改（4.1 反例 B）」「跨工作空间读取与应用同一请求被拒」 |
| 4.2（非法 `decision_required` 不得写入、混合条目整单澄清、超限、白名单外 kind、合法待决定仍阻止应用） | 同上：「非空但非法的 decision_required 不得进入写入」「合法与非法条目混合时整单澄清」＋ `conversation-state.test.ts` 单元（超限/白名单外/形状非法） |
| 4.3（事前已知不可整组撤回不执行部分补偿、重复依赖与关联无新增效果、两个撤回请求只有持久 Owner 推进） | 同上：「事前已知无法整组撤回：一项都不补偿，给出具体方案后按确认范围执行」「重复依赖与已关联目标无新增效果」＋ `conversationStateMaintenance.spec.ts` 方案面板用例 |
| 4.4（同 command_id 改来源被拒、同原消息并发只调一次模型、模型明确失败可恢复、UNDOING 中断后恢复、故障矩阵） | 同上：「同 command_id 携带另一条来源消息按 COMMAND_ID_REUSED 拒绝」「同一原消息的并发解释只调用一次模型」「模型明确失败有持久结算；同命令只回读，新命令沿原请求恢复」「UNDOING 提交后故障：按原 undo_command_id 恢复剩余补偿」 |
| 4.5（State 不变时新增任务推进基线、同 State revision 的确认顺序、截断范围、未签发序号） | `project-daily-continuation.integration.test.ts`：「State 不变时新增任务…」「同 State revision 的确认顺序：新摘要先确认、旧摘要迟到不覆盖」「旧摘要先确认、新摘要随后确认」「未签发的展示序号不能确认」＋ `project-daily-continuation.test.ts` 截断单元 |
| §5 既有对象调整 / 连带决定与续答 / 纠正上下文 | `conversation-state.integration.test.ts`：「既有任务的优先级与截止日期沿原 Owner 调整，不重复创建任务」「连带承诺不冻结独立修改；一句话续答绑定展示版本后继续原请求」「纠正与续答能对上原对象」＋ `conversationStateMaintenance.spec.ts` 三则前端用例 |
| 冲突与方案的界面表达 | `conversationStateMaintenance.spec.ts`：「与后续修改冲突：按冲突表达且保留当前事实，不显示「全部生效」」 |
| 独立复验 R1（拒绝不执行 / 事务内 CAS） | 同上集成套件：「复验R1：全部受阻时 DECLINE 按决定不执行，自动应用与重复 applications 都不再生效」「复验R1：部分独立修改已生效时，DECLINE 只阻止受决定约束的剩余项」「复验R1：expected_revision 在写事务 CAS 内核对，事务前读取之后的版本推进被 409 拒绝」 |
| 独立复验 R2/R4（任务版本冻结、撤回链与提交后恢复） | 同上集成套件：「复验R2：旧 priority 候选与后续人工修改冲突时保留当前值…」「复验R2：同值修订（版本推进）仍识别冲突；目标被替换时拒绝落到新对象」「复验R2：同组多条同对象合法变更按自己的已提交回执推进版本」「复验R4：无后续修改时撤回不误报冲突，after_ref 保存 Owner 提交返回的新版本」「复验R4：后续人工修改阻止撤回：先给具体冲突，一个补偿都不执行」「复验R4：预检之后事实变化按 plan_digest 拒绝」「复验R4：同组多条 Task 变更按原逆序补偿恢复」「复验R4：计划变更 Owner 提交后、APPLIED 回执保存前中断…」「复验R4：补偿提交后、COMPENSATED 回执保存前中断可恢复；预检与提交间的修改被 CAS 挡住」 |
| 独立复验 R3（模型在途基线） | 同上集成套件：「复验R3：模型在途时的人工修改不被解释结算吸收，原候选按调用前冻结的基线识别冲突」 |
| 独立复验 R5（决定回执先行） | 同上集成套件：「复验R5：原命令响应丢失后同命令重放 200，异载荷严格 COMMAND_ID_REUSED…」「复验R5：并发重复提交同一命令收敛到原回执…」「复验R5：跨 Workspace 的决定回复被拒绝，不产生任何写入」 |
| 独立复验 R6（展示签发绑定） | `project-daily-continuation.integration.test.ts`：「复验R6：未签发身份、seq 嫁接、伪造版本、篡改事实与跨项目确认都被拒绝，基线不写」「复验R6：真实展示确认与同展示重放仍生效；被污染的旧基线可识别并恢复」 |
| 第五节 1 自然语言撤回（NLS-11） | `conversation-state.integration.test.ts`：「复验5-1：自然语言撤回绑定同会话唯一已生效调整，复用按钮撤回用例」「复验5-1b：多条已生效调整按类型化歧义失败；没有可撤回调整时如实说明」 |
| Slice B 外部成果核对与完成（NLS-04） | 同上集成套件：「复验B1：外部成果核对只读分类：写审计、不完成、不改业务状态，重复应用不重复核对」「复验B2：完成指令沿原完成 Owner 提交并绑定原消息；已满足原条件时记为已存在」「复验B3：确认之后任务被修改：完成指令按冻结版本拒绝，不产生完成」＋ `conversation-state.test.ts` 解析归一化 |
| Slice C 返回轻量核对（NLS-05/08/09） | `project-return-review.integration.test.ts`：「复验C1：无查看基线的首次返回如实标出缺基线；跨 Workspace 拒绝且零写入」「复验C2：有基线且无变化、证据适用时复用同一记录；事实变化产生新核对」「复验C3：核对写入前中断不留下半条记录，重试按原关系恰好建立一次」＋ `dailyContinuationCard.spec.ts`「返回轻量核对（NLS-05）」 |

工程冻结后分别覆盖领域单元、真实 PG/HTTP 的 Owner/事务/版本/幂等/并发、受管文件与可控模型/检查故障点、匹配源码包的真实 Windows 交互。真实 Provider/外部来源调用只在有效授权内验证；成绩仅在实际运行后写入[功能验收表](overall-acceptance-2026-09-28.md#当前功能验收表)。

效果样板串联“返回项目 → 接续卡轻量核对 → 一句话调整与必要连带决定 → 外部成果核对 → 自然语言纠正/整组撤回”。按 N00 对照基线记录重复填表、重复澄清、状态搬运及无谓页面往返是否减少，同时记录核对延迟、成本、错误理解和漏检；阈值在对比运行前核定，不填造未运行收益。

## 25. 学习模式验收规格

2026-10-10。依据用户已确认的[总纲 §0.12](../../Personal_Workflow_OS_Master_Spec.md#012-学习模式)、[交互 §26](../frontend/workbench-design.md#26-学习模式)与[状态及权限边界 §13](../architecture/domain-model.md#13-学习模式的状态与权限边界)。**本节全部为已确认产品设计的未运行规格；不表示已有实现、自动化测试或通过成绩，不提升现有 M/N 出口。** 学习记录 Owner、版本与并发、停止及迟到结果、删除防复活、API/schema 和明确成本阈值须在实施协议中核定，不据本表推定已有接口或错误码。

| 编号 / 场景 | 未来必须验证的行为与反例 |
|---|---|
| LM-01 目标与主动进入 | 以理解项目架构、前后端、技术栈和术语来提高用户指挥及判断 AI 的能力；项目带学为主，也支持自由学习。用户主动进入，AI 建议学习不自动开课，单纯学习不创建执行 Task/Run |
| LM-02 讲解、路线与理解检查 | 默认短讲解，理解检查可跳过；大主题先给简短且可调整的路线。跳过、换主题或调整路线不被记为不会，也不阻止继续学习 |
| LM-03 返回接续 | 回来时简短说明学到哪里及下一步，按需复核相关知识；仅因间隔时间变长不自动降级学习状态，不启动后台复习或提醒 |
| LM-04 转入执行 | 用户明确要求实现后转普通执行会话，携带目标、方案、约束及未决项；学习会话不原地升权，转入后仍走原执行、权限、审批、验证及完成路径，学习检查不代替验收 |
| LM-05 跨项目状态与具体知识点 | 个人学习状态跨项目共用，保留实际接触的具体知识点及场景来源，按主题归类；同一术语在不同场景的表现不被无依据合并，首版不预建巨大知识图谱 |
| LM-06 依据、缺口与矛盾 | 自述、接触和实际表现分别保留依据、缺口及时间；不展示掌握百分比，未观察到不等于不会。矛盾表现标为待复核并保留各方依据，用户纠正后当前状态与来源可核对 |
| LM-07 项目事实与查证 | 优先当前代码、文档和有效决定；涉及版本、技术选型或其他不确定结论时，按需核对权威来源。假设、示例、未核实信息与项目事实可区分，不把历史资料或通用例子写成当前实现 |
| LM-08 保存授权与业务边界 | 学习模式只允许应用保存个人学习记录，对项目只读；普通人设助手继续遵守 ADR-018 的纯只读规则，不默认扩权。学习记录不替代 Knowledge/Rule/Decision/Task/Run/Artifact，也不产生验证、完成或执行授权事实 |
| LM-09 本轮增量与单一入口 | 随本轮交互提出相关学习状态增量，经单一专门应用入口持久化；不增加额外常规评估或整段复盘模型调用。页面直接读取已存记录，不重新调用模型总结学习状态 |
| LM-10 上下文与存储节制 | 每轮仅带相关短学习状态和相关项目资料，旧依据按需读取；只保存短状态和必要来源，不保存第二套全量学习聊天。以实际模型输入、调用及持久记录检查边界，短回复本身不算总 token 减少证据 |
| LM-11 必要成本单列 | 必要查证、用户明确要求深入讲解和练习的成本单独记录；对照计入全部模型调用与输入输出用量，不承诺固定 token 数字或收益，明确成本阈值冻结前不宣称成本验收通过 |
| LM-12 保存失败与回执 | 保存失败、未完成或结果不明时显示真实缺口，不显示已保存，不用聊天文本或模型自报替代持久回执；恢复、重试和重复保存须按核定协议验证，不能覆盖已有有效记录 |
| LM-13 纠正、删除与不记录 | 用户可纠正、删除单条、全清或要求本次不记录；对应结果须可核对。删除或全清后不翻旧聊天重建学习状态，原聊天仍按原规则保存；本次不记录时不把该轮增量写入学习记录 |
| LM-14 并发、停止与迟到结果 | 工程前置协议核定后，用真实持久化和可控迟到结果验证并发纠正、删除及全清：旧增量不能覆盖新纠正或复活已删除记录；停止前实际提交与停止后的未结算结果按核定边界区分，不以迟到结果冒充继续或保存成功；保留可核对的处理依据 |
| LM-15 首版范围与界面事实 | 首版不提供完整课程、大图谱、自动题库或后台复习提醒；界面可读当前短状态、依据及待复核缺口，失败和必要决定可见，不以学习路线或页面演示宣称未实现能力 |
| LM-16 使用效果 | 对照评价用户能否写出更明确的指令、识别方案遗漏、定义及审查验收；同时记录误判、纠正负担、实际用量与必要额外成本。样本、基线、计数和效果阈值在运行前核定，不以讲解长度、题目数或自述满意度代替能力改善证据 |

实施协议冻结后，分别覆盖领域规则、真实持久化的 Owner/版本/并发/故障恢复、受控模型输入与调用用量，以及匹配源码包的真实 Windows 学习与转执行路径；普通人设助手只读、原权限及业务完成链须回归。实际结果只在运行后更新[统一功能验收表](overall-acceptance-2026-09-28.md#当前功能验收表)，文档检查不能作为实现、使用效果或 token 收益证明。

**2026-10-11 形式化落点（工作包 A 记录协议 + B 教学轮次已实现并运行；成绩只归统一验收表）。**

| 规格点 | 正式测试位置 |
|---|---|
| LM-08 学习身份准入与业务边界 | `learning-records.integration.test.ts`：「学习身份可建立；非学习会话不得维护学习记录；跨 Workspace 零写入」（409 `LEARNING_SESSION_REQUIRED` / 404） |
| LM-05/06 证据性质、场景与矛盾 | 同上：「接触、自述、表现、缺口分别落库；跳过不产生任何升级」（GAP → `PENDING_REVIEW`、`source_kind=LEARNING_MESSAGE`、`source_message_id` 绑定本轮）+ `learning-envelope.test.ts`（增量搬运不补默认值） |
| LM-09/12 单一入口、幂等与回执 | 同上：「同命令重放不重复增量；同 ID 异载荷拒绝；轮次只能结算一次」（`COMMAND_ID_REUSED` / `LEARNING_ROUND_UNAVAILABLE`） |
| LM-13 纠正、删除、全清与不记录 | 同上：「全清递增代次，在途旧轮次不复活记录；清除后新交互重新积累」「单项删除递增概念代次，冻结在旧代次上的在途轮次不得写入」「消息级与会话级「本次不记录」由应用校验，模型返回增量也不写」+ `learning-round.integration.test.ts`：「消息级「本次不记录」时正文照常可读，增量一律不写」 |
| LM-14 并发、停止与迟到结果 | 同上：「并发结算同一轮只有一个赢家；返回接续只读当前记录」+ `learning-round.integration.test.ts`：「轮次被停止时消息与轮次都如实收口，不留 PENDING」 |
| LM-01/07 项目带学与真实来源 | `learning-round.integration.test.ts`：「项目带学读真实代码，正文与增量分别落库，磁盘未变且不建 Task/Run」（只读词表、工具结果回传、`tasks`/`runs` 为 0） |
| LM-11 逐次调用计量 | 同上：「每次模型调用（含工具续轮）都进调用账本，且账本用量与消息用量一致」（`model_calls` 行数 ≥ 2 且合计用量等于消息行） |
| LM-12 保存失败与信封不合法 | 同上：「信封不合法时保留正文、如实显示未更新与原因」（轮次 `REJECTED` + `LEARNING_ENVELOPE_NOT_JSON`，正文仍 COMPLETED） |
| LM-02 跳过不降级 | 同上：「跳过与无实质回答不产生证据，也不降级」（轮次 `SETTLED` 且零证据） |
| LM-10 上下文节制 | 尚未有独立断言：当前实现只带会话近期历史 + 有界短状态（12 条证据）+ 显式选中来源，**未做**输入量对照实验，标为未验证 |

`learning-records.integration.test.ts` 另覆盖记录层的跨 Workspace 可见性、轮次依据在调用模型前冻结、清除后迟到轮次 `LEARNING_ROUND_STALE`。工作包 C 的基础组件与 API 检查见下表；**未覆盖**：真实前后端组合与浏览器、LM-16 使用效果与成本阈值（工作包 D）、真实 Provider 与 Windows 出口。

2026-10-13 工作包 C 按用户要求只做基础功能，不扩大压力/负载、成本或效果实验；当前成绩只在统一验收表维护。普通流程检查映射：

| 场景 | 自动化检查 |
|---|---|
| LM-01/03/08/15 学习入口、自由学习与身份隔离 | `assistantModeSwitch.spec.ts`：第三档、切到已有学习身份、无目录首条、不带 intent/Skill、不触发执行/维护；原助手行为保留 |
| LM-03/06/13/15 当前记录与控制 | `learningRecords.spec.ts`：重读关闭开关、按性质/场景/处置展示、纠正自述、删除与全清范围、读取失败撤掉旧投影 |
| LM-04 明确转执行 | `assistantModeSwitch.spec.ts`：新建 AGENT，保留原 LEARNING，携带目标/背景/来源版本；`learningRecords.spec.ts`：预填背景、明确执行要求与草稿保护；后续 Task/Run 仍沿原入口，本组不证明真实执行链或教学质量 |
| LM-12 原命令核对 | 两个组件规格覆盖消息与学习命令回执丢失、原身份重试、错回执不放行、重读当前记录而不从旧回执恢复正文 |
| LM-08/13 持久查询与 UI 纠正 | `learning-records.integration.test.ts` 的两条 LM-C：真实 HTTP/PG 读控制/轮次、首次 CAS 0→1、旧版本拒绝、跨 Workspace/普通身份拒绝；UI 纠正无需伪造聊天消息、幂等重放、全清后旧回执不复活 |

**2026-10-12 整改反例转正式回归（R1–R8；成绩只归统一验收表）。**

| 反例 | 正式测试位置 |
|---|---|
| R1 显式 Skill 与自然语言方法双写 | `assist.integration.test.ts`：「R1：Skill 与方法仍互斥；无 Skill 的自然语言方法识别保持有效」「R1：显式 Skill 身份决定入口，自然语言方法不再与 Skill 双写」（202 契约 + DB 中 `skill_snapshot` 非空且方法三列全空 + tick 走原 Skill 路由 + 同/异载荷重放） |
| R2/R3 失权 Worker 与持久取消的迟到结算 | `learning-late-settlement.integration.test.ts`：4 例（失权 → `DISCARDED`/`REJECTED`+`LEASE_LOST`/零证据；取消先提交 → `CANCELLED`/`LEARNING_ROUND_CANCELLED`/零证据；增量先提交、取消后到 → 证据不倒删、消息按停止收口；迟到被拒后新 Worker 合法工作不受影响）。提交顺序用可控模型屏障 + `pg_stat_activity` 锁等待钉死，不靠事件循环先后 |
| R4 知识点基线覆盖与 generation 竞态 | `learning-records.integration.test.ts`：「LM-14(R4)：删除后旧轮次不得复活既有知识点，即使它不在证据最近 20 条内」（断言冻结基线覆盖全部既有知识点、人工删除代次保留、旧结算类型化失败、零部分写入） |
| R5 已解除 GAP 的读取边界 | 同上：「LM-15(R5)：已解除的 GAP 不再进入接续未决项与教学上下文，历史仍可核对」（解除前可见、解除后两个读取入口都不含、历史仍在 `recent`、真正待复核项继续可见） |
| R6 清除与并发结算的 epoch 边界 | 同上：「LM-13(R6)：清除与结算并发时旧 epoch 证据不残留为当前内容」（固定「清除扫描 → epoch 推进」窗口；同时断言清除先/结算先两种结果、DB 行数为 0、epoch 1 下合法新 round 照常保存） |
| R7 generation 校验后的人工纠正 | 同上：「LM-14(R7)：generation 校验后人工纠正先提交，旧轮次不得越过校验继续写」（写入临界区内暂停、纠正先提交、旧结算 `LEARNING_ROUND_STALE`、纠正自述与代次保留） |
| R8 缺乏本轮可信依据 | 同上：「LM-09(R8)：依据绑定拒绝伪造证据，合法真实回答照常保存」（跳过轮次伪造表现、缺引用、引用不存在、跨会话、教学冒充表现、自述冒充验证全部 422 `LEARNING_EVIDENCE_REF_INVALID` 且零新增；合法自述与真实回答的正向候选照常落库） |

**已知边界**：跳过识别是固定短语表 + 规范化精确匹配，自由措辞的跳过表述不在被核定场景内；`LM-10` 输入量对照实验仍未做。

## 26. 内置 Skill、命令、压缩与消息文件恢复验收规格

2026-10-11。依据[总纲 §0.13](../../Personal_Workflow_OS_Master_Spec.md#013-内置工作方法与会话控制)、[Skill 专题第 9 节](../architecture/relay-skills.md#9-内置工作方法与可定制-skill)、[运行架构第 8 节](../architecture/runtime-context.md#8-会话压缩与消息文件恢复)及[工作台第 27 节](../frontend/workbench-design.md#27-内置-skill-与聊天命令)。以下为目标规格，原“全部未运行”只描述首次编写时点；已有子功能成绩只归统一验收表，不由本表推定通过或退回未实现。**2026-10-24 新增 BC-18–BC-25 全部未运行，验证本轮推荐默认，不代表新增实现或用户逐项确认**；具体 API、检查点/快照、模型协议和参数按[实施前置](../requirements/post-v1-roadmap.md#9-内置工作方法命令与会话恢复的范围)核定后落测试。

| 编号 / 场景 | 必须验证的行为和反例 |
|---|---|
| BC-01 命令菜单 | 输入 `/` 可选方法和系统命令；英文与中文别名共用登记项。选中只插入草稿，发送前零执行/业务变化；退出、编辑、IME 组词与键盘焦点不误触发 |
| BC-02 自然语言与首批方法 | 普通指令可选择审查/诊断/文档维护并显示方法；“讨论方法”不执行。既有四项 Skill 的结构化输出、提案接受、版本和来源回归 |
| BC-03 意图与范围 | `/diagnose 启动失败` 默认复现/定位/报告，不修文件；明确“修好”可诊断→修改→验证。审查和文档默认当前任务/改动及相关影响，“全项目”才扩大，目标歧义不猜 |
| BC-04 执行和只读身份 | 写入接原 Task/Run/Gateway/Owner，不另建 SkillRun；没有资源绑定或失权不能写。只读助手不因 Skill、命令或定制获得写/审批/Task/Run |
| BC-05 定制版本 | 外部编辑 `SKILL.md` 形成草稿，应用校验/Eval 后登记并显式启用新版本；官方定义及旧快照保留，活动 Run 不变。同 ID/version 不同内容、未知引用、脚本或能力越权不能启用 |
| BC-06 新会话和模型 | `/clear` 与 `/new` 建新会话保留项目/目录，旧历史保留，不隐式取消在途 Run。`/model` 只影响当前会话后续新请求，原 Run 后续调用保持冻结模型，应用默认不变 |
| BC-07 状态撤回 | `/undo` 复用原业务撤回；唯一目标、整组预检、具体范围决定、版本冲突和原回执均回归，不产生文件恢复或无关历史删除 |
| BC-08 容量与提前压缩 | 模型物理窗口、工作预算、输出/增长预留、压缩阈值分开；256K–512K 不作通用阈值。自动策略可在完成节点和增长预算时提前整理，手动无须等满；Mandatory 放不下明确停止 |
| BC-09 摘要与动作身份 | 用当前工作模型摘要，含目标/范围/决定/进展/未决/失败/来源版本及下一步；近期原文和活跃协议保护。摘要不授权限、不改 Task 完成、不删除 UNKNOWN、不重发成功动作 |
| BC-10 DeepSeek 协议与缓存 | 真实思考模式多轮工具调用及压缩边界完整回传必要字段；缺字段负例不得被假成功掩盖。输入前缀、检查点后追加及必要失效可检查，缺失缓存用量保持未知，不保证命中 |
| BC-11 压缩并发和恢复 | 检查点提交前后崩溃、响应丢失、取消、迟到摘要及后续消息竞争：只有有效已提交检查点切换窗口，旧结果不覆盖新版本；重启按检查点加增量继续，失败不误删原窗口 |
| BC-12 发送前文件基线 | 基线绑定确切用户消息及受管资源；CREATE/MODIFY/DELETE、二进制/大文件在已核定支持范围内可恢复真实字节与存在性。动作首写基线/hash 不冒充发送前；基线缺失或过期不显示可恢复 |
| BC-13 文件撤回范围 | 点消息下按钮恢复该条发送前状态，含随后本会话相关文件变化；第一条改 A、第二条改 B，点第一条须恢复两者。无关路径、人工/其他任务后改不覆盖；历史聊天/ArtifactVersion 不删除 |
| BC-14 在途停止与冲突 | 在途可点，先持久控制并证明旧 Writer 不再写，再恢复。过期租约、排队动作、迟到写、跨 Task 同物理根及 UNKNOWN 反例受控；冲突不静默缩小或冒充全部成功 |
| BC-15 恢复故障与幂等 | 文件恢复前后、回执提交前后中断及重复点击/重开：沿原恢复请求/动作身份核对，不重复覆盖；FS/DB 部分结果真实持久，未核对不能算恢复完成 |
| BC-16 受影响完成任务 | 确实撤销完成成果后沿 ReopenTask 新验收周期回 READY，历史完成/验证保留、不继承旧 PASS、不自动 Run。无关 DONE 不重开；文件已恢复而 Task revision 冲突显示部分结果 |
| BC-17 真实体验与收益 | 匹配源码包的 Windows/IME/DPI、运行中恢复和长会话压缩真实验证；真实 DeepSeek 对照计入摘要/重试/恢复的全部调用，比较接续成功、约束遗漏、协议错误、缓存、成本与延迟，阈值运行前冻结 |
| BC-18 回退后的上下文 | 消息一改 A、消息二改 B，再回退消息一：原聊天与合法工具配对保留，实际恢复事实进入下一轮上下文。旧摘要、迟到摘要、引用旧成果的记忆不能把 A/B 已修改当作当前事实；用户再要求只改 B 时不重做 A；需求/决定及无关记忆不被误删。摘要失败和重启不丢恢复事实，原队列/Goal/团队不自动重放 |
| BC-19 单层反向恢复 | 回退前保护副本真实保存目标文件字节/存在性；完整成功后可从持久回执撤销最近一次回退，只影响原实际写入集合。后续人工/其他执行/同会话改动、失权或基线失效拒绝自动覆盖；反向操作重复点击/响应丢失仍沿原身份核对，不复活 DONE/原 Run/批准/PASS，不提供无限反向切换 |
| BC-20 冲突与部分恢复 | 预检有冲突时零文件写入，缩小范围需要具体决定；运行中产生冲突时逐项保存真实结果，未结算或 UNKNOWN 不提供直接反向恢复。首写前取消与首写后停止/核对分别呈现；保护副本捕获失败不先恢复文件；文件成功而重开/上下文同步失败不得报整体完成 |
| BC-21 容量与清理 | 按工作台唯一配置检查保留时间、存储上限、单文件上限与去重计量；容量先到时正确标出实际可恢复时段。捕获/在途/UNKNOWN/部分恢复的保护引用不被清理，普通历史清理后回执保留但入口不可恢复；受保护数据占满时停止新增快照，修改配置/归档/会话删除不绕过未决引用 |
| BC-22 支持与归因 | 真实文本/二进制/未跟踪文件 CREATE/MODIFY/DELETE 和可归因改名按字节/存在性恢复；超限、缺失、损坏、路径别名、junction、根移动及来源不明明确处理。脚本效果有基线与归因才覆盖；不恢复数据库、外部操作、Git 元数据、凭据或不可变产物库，不递归误删他人文件 |
| BC-23 可用性与误导防护 | 无相关修改、仍在执行、捕获中、覆盖不全、过期/损坏、失权、重复点击有不同反馈。运行中暂时无变更不报无需恢复；捕获失败不阻断原本合法普通工作且不得宣称完整可回退；不支持项未被修改时不误拒绝无关目标，未完整读取时不显示确定总数 |
| BC-24 试用版本与实际恢复 | 查看旧成果/切换隔离试用不写工作目录或重开 Task；文件回退不静默切换固定试用版本。共享可变目录/测试数据的试用先安全处理，无法核定依赖标待核对；界面区分实际体验版本与已回退目录，反馈/验收不串版本，/undo 仍只处理业务补偿 |
| BC-25 连续回退与多入口 | 跨标签页重复请求读取同一事实；有未决恢复时不准入重叠回退或反向动作。回退完成后再选更早消息按当前生效效果重算，不把恢复写入当普通生成、不重复删除；无关资源工作不被全局暂停，受影响自动推进在恢复及接续条件明确前不重启 |

领域/版本规则使用单元测试；注册、请求、检查点和重开的 revision/幂等/竞争使用真实数据库；文件恢复用真实受管文件加可控迟到 Writer/故障点；DeepSeek 协议和收益另用真实 Provider 验证。固定 Fake、浏览器或文档检查均不能替代模型兼容、真实窗口与成本效果。实际成绩仅在运行后进入[统一功能验收表](overall-acceptance-2026-09-28.md#当前功能验收表)，不在本节预填通过率。

### 26.1 首批后端切片覆盖映射（2026-10-11）

下表只记录**本轮实际落成的自动化入口与通过范围**，不复制验收状态；最终成绩仍只在[统一功能验收表](overall-acceptance-2026-09-28.md#当前功能验收表)维护。

| 规格 | 本轮自动化入口 | 当前通过范围 | 未验原因 |
|---|---|---|---|
| BC-01 命令菜单（后端部分） | 单元 `test/unit/builtin-methods.test.ts`（菜单顺序、英文/中文别名共用登记项、路径与代码块不触发）；集成 `test/integration/chat-commands.integration.test.ts`（`GET /chat-commands`、`POST /chat-commands/resolve` 零业务副作用） | 解析、登记与零副作用通过 | 输入框菜单、IME 组词、键盘焦点与草稿属于前端交互，未实施 |
| BC-02 自然语言与首批方法（后端部分） | 单元（讨论/审查/诊断/文档维护识别、既有四项 Skill 回归 `first-party-skills.test.ts`）；集成（方法身份冻结与读回、`detected_method`） | 方法识别与身份冻结通过 | 方法到写执行链未接线；四项 Skill 输出/接受回归沿用既有套件 |
| BC-03 意图与范围（只读部分） | 单元（`讨论诊断方法` 不执行、`诊断并修好` 为 `MODIFY`、`全项目` 才扩大） | 意图与范围判定通过 | 「修好 → 修改 → 验证」的后半段未接线；`MODIFY` 目前只产生只读方案 |
| BC-04 执行和只读身份（方法部分） | 集成（只读 `ASSISTANT` 会话请求 `MODIFY` → 409） | 只读助手不因方法升权通过 | 写入路径本身未接线，因此未验「接原 Task/Run/Gateway」 |
| BC-05–BC-17 | — | 未实施 | 定制 `SKILL.md`、会话级模型、压缩/检查点、消息文件恢复与真实 Provider/Windows 均未进入本轮范围 |

**测试层级说明**：本轮只有单元层（纯解析/意图/注册）与真实 PG/HTTP 层（端点、消息方法绑定、只读身份）。受控迟到 Writer、真实受管目录故障点、真实 DeepSeek 与真实 Windows 窗口均未运行；因此不得据此宣称 BC-05 之后任何场景通过。

### 26.2 基础后端接续检查（2026-10-13）

基础结果展示：`executionTrajectorySummary.spec.ts` 覆盖检查失败→修正→复检的历史、失败写入不算完成写入、目录/检索按调用计数、已有结果时在途仍可见、已结算但结果缺失；`runToolTrajectory.spec.ts` 覆盖 `outcome: FAILED` 无 `reason` 的明确失败标记。这里使用原工具回执形状的组件数据，不代替真实 PG/Provider 或 Windows 文件执行。已有命令菜单另由电脑插件核对真实 Relay 中展开、方法选择只插入，PG核对零消息/Run/模型调用/完成记录；它与新摘要的组件证据分别记录。

按用户本轮范围，只验证基础功能能走通，不新增压力/负载、复杂竞态或收益实验。§26.1 保留当时切片：其中方法写链未接线的描述已由本节接续，不回写历史成绩。

前端输入后续接线：`assistantModeSwitch.spec.ts` 新增三身份 `/clear`/`/new`/中文别名建空会话、响应丢失按原回执接续与 `/undo` 具体回执指引的正常组件路径；联合原 `conversationStateMaintenance.spec.ts` 与 `folderFirstConversation.spec.ts` 检查撤回 Owner 和首条消息流程。组件使用 HTTP 夹具，不代替真实前后端组合、Windows 或 Provider；不扩大压力/竞态检查范围。输入实现见工作台 §27.2，成绩只在统一验收表维护。

基础菜单接线（BC-01）：`chatCommandInput.spec.tsx` 覆盖服务端清单只读加载、中英文过滤、键盘插入/退出/原发送与换行规则、组词/229、身份可见项、未接入提示、读取失败重试、路径/参数不展开及禁用/离焦关闭。`assistantModeSwitch.spec.ts` 验证首条选择仅编辑原草稿、已有会话选择 clear 后发送才走原会话命令；`uiOption2FirstSession.spec.ts` 的新增菜单用例覆盖窄窗口浮层与输入框可见、鼠标/键盘选择、首条发送后已有输入器的同菜单与 Esc 保留。沿原控制/首条套件回归，不新开压力测试；API 均为受控夹具，组词事件模拟与真实 Windows 中文 IME 分开，实际结果仅归验收表。

真实 Windows 接续：使用电脑插件操作独立 PG-backed Relay 窗口，核对普通首条消息、`/clear`/历史选择、普通/学习档 `/new`、学习面板与记录控制，以及 `/undo` 具体回执指引；本地 Fake 回复只证明业务/窗口链路。真实窗口发现同名选项不可辨识、近期工作创建后未刷新，两处修复分别由 `assistantModeSwitch.spec.ts` 的新会话正常路径与 `recentWorkPagination.spec.ts` 的会话读回/分页保留覆盖，再以当前源码的开发窗口复核。修复前目录包、最终开发窗口与真实 Provider 的证据不能互相替代。

- 方法主链：`folder-first-conversation.integration.test.ts` 的「基础方法请求」验证原 `/diagnose 修好…` → 冻结方法/行动 → Task/Run → 真实读取/修改/一次已配置 CLI 检查 → 候选保存与原 HUMAN 判断入口；「基础只读方法」验证只配读连接即可读取真实文件，学习身份不直接进入执行。
- 命令行动：`builtin-methods.test.ts` 的正常命令解析验证明确修复为 `MODIFY`、讨论修复为 `INSPECT`，菜单解析与消息冻结一致。
- 会话控制：`basic-chat-controls.integration.test.ts` 的两个普通 PG/HTTP 场景验证 `/clear`/`/new` 保留三身份与项目/任务绑定及原历史，`/undo` 用原撤回身份补偿并保存/重读回执，不创建第二次补偿。
- 模型续轮：`openai-compatible-model-port.test.ts` 验证普通工具往返的实际请求 body；`model-tool-turn-assistant.integration.test.ts` 验证 0073 首行保存/读回与原工具回执配对，旧 NULL 不补造正文/推理；`run-tool-call-projection.test.ts` 保持 HTTP 投影不泄露该数据。不将这些 mock/本地协议检查当真实 DeepSeek 效果，不将后端端点当作已有前端菜单。

### 26.3 免费模型目录与选择验收规格

2026-10-15，**以下为未运行规格**。依据[产品范围](../requirements/post-v1-roadmap.md#91-免费模型分组与自动同步)、[运行边界](../architecture/runtime-context.md#86-模型目录会话选择与免费调用边界)和[交互](../frontend/workbench-design.md#275-免费模型分组与模型选择)。实际成绩只写统一功能验收表，不把本表改成结果日志。

| 编号 | 场景与必要反例 |
|---|---|
| FM-01 免费判定 | 必需输入/输出价格须合法为零；官方可选 request 未声明保留缺项、不注入零，声明后须合法零。覆盖当前官方目录只含 prompt/completion 的真实形状；缺必需项、非法、负数、极小非零、新未知收费项、仅名称 free、余额/试用不能混入。单位解析正确，不用缺值默认零 |
| FM-02 同步与时钟 | 可控时钟覆盖首次、24 小时内不重复、到期、启动补查、持续运行检查、手动刷新与失败退避；浏览不产生推理请求、Task/Run 或选择变更 |
| FM-03 快照持久化 | 完整成功目录原子发布、重启复用；并发与迟到同步不倒退；失败保留旧快照/成功时间，非法或不完整分页不清空，合法完整空目录清空可选免费集合 |
| FM-04 生命周期 | 新免费项出现、转收费/下架退出可选集合；原选择保留失效原因。过期/刷新失败可浏览旧值但不放行新免费调用，不静默切换 |
| FM-05 连接与边界 | 独立服务商凭据不串用，HTTP/日志/模型快照不含密钥；未登记连接/任意 endpoint/越权请求拒绝。模型描述不能改规则；目录与能力声明不代表真实连接或工具调用已验 |
| FM-06 会话与 Run | 真实 PG+HTTP 验证会话选择 revision/幂等/响应丢失重放、跨会话隔离、首条选择绑定；切换不改变默认。Run 创建冻结配置/候选策略，手动选择/目录刷新不改在途策略，自动接续仅按 FM-10/11 的原队列与持久切换记录；旧 Run 兼容不伪造模型身份，撤销凭据不能沿旧快照使用 |
| FM-07 调用准入 | 捕获真实发送边界的 HTTP body，证明所有入口读取冻结约束，携带“仅免费”约束的验证/续轮/重试/切换均附零价格硬限制，且付费 fallback/插件关闭。原默认无此约束的模型不受免费目录失败/过期影响。免费目录变价、价格未知、工具能力不足、401/429、网络错误明确分类；只有 FM-10 的已授权情况允许免费接续，不把失败记免费成功或把未知成本记零 |
| FM-08 UI | 真实 API 客户端接线、刷新/空态/旧缓存/未配置/不可用状态、保存失败与未知回执；`/model` 草稿语义、键盘/Esc/IME/窄窗、活动 Run 与会话模型区别；刷新零推理 |
| FM-09 分层出口 | 单测/可控 HTTP/真实 PG 与浏览器各报告范围；真实 OpenRouter 目录、实际选定模型文本/工具调用及零价参数接受、Windows 窗口/IME 分别取证。未配置合法凭据或未获真实模型放行时记未运行；Fake/目录 API 成功不证明 Provider 或安装交付 |

2026-10-16 增加额度接续与整改场景，以下仍为**未运行目标规格**，不代表已新增测试或修复：

| 编号 | 场景与必要反例 |
|---|---|
| FM-10 额度作用域与候选 | A 的 HTTP 429 须有官方结构化上游限流证据、无平台限流头，并经独立账户查询确认共享免费日额度大于零，才按冻结顺序到 B；测试不能只依赖自造 scope 字段。未知/零账户额度、平台限制头、普通 429、401、预算、内容拒绝及未知错误均停止。进入接续后跳过失效后续候选，所有尝试仍零价格；首选未发生确切拒绝就失效则停止。冷却与 Retry-After 保留，无可用候选明确停止，不声称知道模型专属余量 |
| FM-11 身份与恢复 | 同一消息/Task/Run 内新增实际尝试身份与切换回执，不改初始契约；并发 CAS 只切一次，重启/响应丢失按原尝试续接、不重置游标/上限/预算。候选最多一次，冻结尝试上限，尝试逐项计量；新目录项不自动进活动队列；账户冷却按凭据引用隔离 |
| FM-12 工具与交互安全 | A 已成功工具不因 B 接续而重跑；暂停/取消阻止下一外呼，半截流/未知结果/未闭合工具链或不可移植推理协议不自动切换。原首选/实际模型、A→B 原因和停止/恢复态可见；旧单模型模式、默认付费路径和只读身份无退化 |
| FM-13 验收发现的回归前置 | 目录集成夹具使用迁移角色或合法清理动作，不给生产角色补 TRUNCATE 来迁就测试；默认连接不得带 OpenRouter 依据、OpenRouter 即使 free_only=false 也不得缺来源（独立反例见 `model-selection-source-acceptance.integration.test.ts`），免费依据完整性均由 SQL CHECK 验证，修复已应用 migration 须追加迁移。非空畸形项/冲突重复 ID/未读全分页不能替换成功缓存；未知收费项 null/空值不能判免费；工具能力按官方模型顶层 supported_parameters 解析，缺值仍未知，不用错误嵌套 fixture。两个请求读同一旧状态后串行领租约仍须复核 TTL/退避/间隔。自动启动/打开/到期检查必须经生产生命周期触发，不能只测直接调用用例 |

### 26.4 消息文件回退首版覆盖映射（2026-10-24）

本节只记录**实际落成的自动化入口与通过范围**，不把 §26 的未运行规格改成已通过；最终成绩只在[统一功能验收表](overall-acceptance-2026-09-28.md#当前功能验收表)维护。实现采用「消息发送后首写前像」而非 §27.3.4 的发送前基线，因此 BC-12 只按该形态部分覆盖。

| 规格 | 本轮自动化入口 | 当前通过范围 | 未验原因 |
|---|---|---|---|
| BC-12 发送前文件基线 | `assist-message-recall-acceptance.integration.test.ts` RA-01（两条消息改 A 建 B 后撤第一条全部恢复）、RA-04（删除文件按前像字节恢复）、RA-02（外部修改预检冲突）；RA-07（容量占满 `CAPACITY_FULL` 降级）；RA-08（保留期清理后如实不可恢复＋设置投影） | 首写前像的内容/存在性、二进制/删除、容量降级、保留清理与占用投影通过 | 单文件上限 50 MiB（基线/保护副本共享）；内容寻址去重与容量预算已实现（RA-07/RA-10）；真实 Windows 文件系统未验 |
| BC-13 文件撤回范围 | RA-01（点第一条恢复 A/B 两处）、RA-02（外部修改不覆盖）、RA-03（更晚撤回后再撤更早被拒的现状断言） | 向后整组恢复、冲突不写通过；方向规则已按 2026-10-24 用户拍板放开——RA-03 改为断言「先撤更晚再撤更早须重算当前生效状态并成功」，撤回效果按结算时序折入（`listRecallEffectsForFold`），真实运行通过 | 原消息资源绑定/跨目录、无关路径与其他任务写入未专门覆盖；历史 ArtifactVersion 未删除仅按代码事实；基线语义（首写前像 vs 发送前基线）已拍板按发送前基线返工、尚未实施 |
| BC-14 在途停止与冲突 | `assist-message-recall-runtime.integration.test.ts` RR-01（任何 RUNNING 撤回挡新消息，含崩溃遗留）、RR-02（过期 RUNNING 按原回执接续，未过期拒绝并发） | RUNNING 栅栏与接续通过 | 首版仅完成态可撤回，没有「先停写→证明旧 Writer 不再写→恢复」；租约过期、迟到写、跨 Task 同物理根未验 |
| BC-15 恢复故障与幂等 | RA-01（同命令重放不重复执行）、RA-05（单层撤销按保护副本恢复、不可再反反）、RA-06（撤销预检冲突不写）、RR-02（崩溃遗留 RUNNING 接续） | 命令/消息幂等、撤销单层与冲突保护通过 | 恢复前后/回执提交前后崩溃、响应丢失、迟到摘要、FS/DB 部分结果故障注入未做 |
| BC-16 受影响完成任务 | `assist-message-recall-acceptance.integration.test.ts` RA-09（撤回确实撤销 DONE 成果时沿 ReopenTask 重开，无关 DONE 不重开） | **带因跳过**：实现已接线（撤回结算后 `reopenAffectedDoneTasks` 按「实际恢复路径 ∩ 委派写入」判定、仅 DONE 沿 `reopenTask` 重开、失败逐项写 `detail.task_reopens`），RA-09（含无关 DONE 不重开负例）以带因 skip 留在套件——委派执行链在当前树上 MODEL_FAILED，既有 `conversation-diff-attribution` 委派用例同因同红，归因 2026-10-24 13:18 并入 `assist-runner.ts` 的 #140 model_calls 计量包裹（存量回归）；回归修复后去 skip 复跑 | 历史完成/验证保留、验收周期递增与部分结果呈现的 e2e 未验 |
| BC-17 真实体验与收益 | 工作台 `tests/assistMessageRecall.spec.tsx` 5/5（组件路径） | 入口、RUNNING/终态回执、错误呈现、消息撤回占位通过 | 组件夹具不代替真实 Windows/WebView2/IME/DPI、真实 Provider 或长会话压缩收益；未做收益对照 |

单层撤销、容量/保留与设置投影是 2026-10-24 新增的本轮实现，覆盖入口分别见上表 RA-05/06（撤销）、RA-07/08（容量/保留）；它们不是 §26 原 BC-01–17 的替代，也不表示 §27.3 的推荐默认已全部验收。

## 30. 基础有限 Markdown 任务链检查范围

受控修改/检查补充：task-chain-execution.integration.test 沿原普通会话取得 MODIFY 方法，创建仅保存规格，明确授权后原 Run/范围授权/工具账本执行「实际检查失败 → 读取 → 修改 → 再查成功」，核对落盘字节、变化集实际摘要、真实子进程输出和每项独立授权，原人工完成后才接下项。无范围授权时停原 ACTION_APPROVAL、原明确批准后才落盘；已有 DENY 即使有范围授权仍零写入/零已派操作；检查脚本变化阻止旧规格准入，未配置 check_id 不派命令，INSPECT 与修改范围/缺检查配置均不保存候选。

单元检查任务链期限收窄、不跨 Run 与旧摘要兼容，回归原检查材料/配置入口规则；客户端检查只传明确 scope_grant、程序/参数/摘要和原方法身份。测试模型仍为受控 Fake，真实文件和配置子进程不证明真实 Provider、Windows 窗口、完整 N06 或实际使用收益；成绩只归统一表。

只读规格补充：真实 PG/HTTP 与生产 Worker/LangGraph 模块在同一链分别执行原目录/文件工具循环和原固定读取，核对实际文件内容、确切资料版本、原会话已冻结只读方法/消息，原人工验收后继续；文件字节保持。DENY 返回原 REJECTED 工具回执/零已派操作，链不替代批准；资料版本更新或连接禁用保留旧规格/零 Run，任意未注册工具/其他范围资源不得建候选。对应 task-chain-execution.integration.test、task-chain-execution unit 与 taskChainExecutionClient；资源 epoch 推进后后项仍可正确读取，配置/身份变更仍需核验。受控 Fake/实际文件读取不等于真实 Provider、自定义方法或 Windows 使用证据。

2026-10-14：真实 PG/HTTP 创建固定既有范围不委托，明确任务/调用上限与实际有效期后，生产 Worker/LangGraph 模块逐项生成成果；原 HUMAN Review 接受并经原 COMPLETE 后才准入下一项，确切 Run/完成引用与累计调用可读。

基础边界检查覆盖累计调用限额、经原账本保存的未知用量占用、源 Task 改变不覆盖、短有效期停止新委托、撤销不复活；暂停中→原 Control APPLIED/Run PAUSED→明确续授权恢复同一 Run，预算不重置；真实 API 进程重开共享同一受管产物目录，旧活动链待人工确认，原 Run/文件/消费保留，不自动创建后续项。测试 helper 复用调用方目录时不负责删除，原创建 helper 在进程全部关闭后清理自有目录。

客户端检查明确 scope/限额/期限/控制及原 Run/完成引用。受控 Fake ModelPort 用量和生产 Worker 模块运行不等于真实 Provider 或独立 Windows Worker 进程；本片不覆盖外部工具、来源/方法绑定、活动续期、并发故障全矩阵、UI/Windows/安装或实际收益。成绩只归统一验收表，不以本文场景作为已运行结果。

## 29. 基础一次性项目提醒检查范围

2026-10-14，只接前后端功能；实际结果只归统一功能验收表，不代替 PV05/PV08 全出口。

- 时间单元：Z/偏移量转换、不同显示时区同一时刻、重复钟点显式偏移区分；拒绝无时区、不存在日期或无效时区。
- 真实 PG/HTTP/进程：生产 API 生命周期函数到时形成一个待处理，重复扫描/重放不重复；暂停/恢复不复活原发生，明确改实际时刻形成新代次且旧标题/时刻/时区保留；通知 DENIED 不吞事项，独立 HANDLE/DISMISS；触发/读取原计划入口零 Run/模型/计划。
- 退出与重开：关闭自有 API 后越过到期时刻，数据库没有发生；新进程启动补一次有效错过事项，PAUSED 不补；再次实际重开保留同一发生 ID。
- 客户端/通知功能：命令、来源时区、PENDING/处理状态与原投递结算；受控宿主投递/拒绝/失败、聚焦不领；点击重读当前事项后导航，零业务写入。原必须介入通路/渲染保持，未新增 UI。

本片不运行并发压力、进程崩溃故障点、完整可控时钟跳变矩阵、真实 Windows 原生通知或整体计划输入路径；不能把普通真实进程关闭/重开当安装、完整恢复或收益通过。

## 28. 基础下一段工作计划检查范围

2026-10-14，按用户只做基础前后端功能的授权接 N04 数据片；实际结果只归统一功能验收表，不据此升级 PV04 的 Windows、完整使用与收益出口。

- 真实 PG/HTTP：估时追加及历史、未知 elapsed 不从分项补算；明确主线与 BLOCKS 前置先排、容量不足延后；固定窗口重复读不重置，恰好排满容量在窗口内可接受，审阅后剩余时间缺口只提示。
- 逐项应用：先接受前置，再保存主线选择，独立项拒绝不丢其他结果；既有 Task/Run 不改变；诊断沿原 Owner 建 ME/HUMAN/INBOX/独立验收，原命令重放只一项，原修复任务不完成。
- 基础变更：改估时后旧候选可读但不可按旧依据接受，重新发起使用新估时；新迁移/CLI/工作段回归。
- 客户端：明确五种时长/未知、固定窗口/冻结依据/诊断/延后、每项回执解析与准入性质；不做 UI。

未知估时、主线与前置、容量不足/阻塞和不重复相加另由纯排序单元检查；不扩展压力、进程故障或真实 Provider。本片不证明自动重排、自然语言发起或 N05/N06 前置全部通过。

## 27. 验收证据与投入判断验收规格

2026-10-11 定义规格。依据[总纲 §0.14](../../Personal_Workflow_OS_Master_Spec.md#014-验收证据与投入判断)、[工作台 §29](../frontend/workbench-design.md#29-验收证据与投入判断)和[后续路线 §10](../requirements/post-v1-roadmap.md#10-验收证据与投入判断的范围和分期)。以下为目标规格，编号不等于实现或通过；2026-10-14 基础代码已映射 EVI-02/03 的导入、确切关联/读回/撤销，EVI-04 的旧验收关联标记，EVI-06 的持久计时及 EVI-07 的人工补录/未知/纠正来源。真实 PG/HTTP 入口为 [task-acceptance-materials](../../apps/api/test/integration/task-acceptance-materials.integration.test.ts)，前端解析为 [materials client](../../apps/workbench/tests/taskAcceptanceMaterialsClient.spec.ts) 与 [trials client](../../apps/workbench/tests/taskAcceptanceTrialsClient.spec.ts)。协议归 HTTP 契约 §10.67–68 和数据库设计 §75–76；实际成绩仅在统一功能验收表记录，未覆盖规格不预填通过。EVI 编号仅用于本节场景映射，不新增 F/N 工作包。

| 编号 / 场景 | 必须验证的行为和反例 |
|---|---|
| EVI-01 单 Task 范围 | 默认只核对该 Task 已登记条件及确切证据；无明确查漏请求不调用模型扩大条件。AI 建议不自动成为生效验收要求或检查通过 |
| EVI-02 主动选材 | 内部证据与用户选入的文本日志、测试输出、Markdown 可回到确切正文版本与来源；不被动扫描全仓、外部 Agent 或账户，文件/工具正文不构成授权 |
| EVI-03 材料关联 | Task、验收修订、条件、被测版本和材料版本逐项核对；缺项、错关联、跨作用域、失权和不可读材料保留明确缺口，不能补猜或创建正式 CheckResult/PASS |
| EVI-04 证据适用性 | 条件或产物变化、旧 Trace 匹配、单项与组合检查分别覆盖；未运行、失败、工具故障、缺失、过期和待核实不合并为通过或普通失败 |
| EVI-05 同源入口 | 交付消息摘要与 Task 详情消费同一投影；部分读取失败和对象切换迟到响应不掩盖缺口或覆盖新对象。补救走原入口，不隐式启动新的完整补验闭环 |
| EVI-06 轻量计时 | 找证据开始、结束、暂停、继续留下可核对记录；有效计时、暂停和总经过时间可区分，暂停不改变 Task/Run。刷新、中断、重复提交及恢复按已核定持久化协议验证 |
| EVI-07 补录与总成本 | 一句话补录绑定正确试用，准备成本另列并计入总验收耗时；未记录项保持未知。查找节省但计入准备成本后总验收耗时未降低的反例，不能呈现为整体省时 |
| EVI-08 对比与护栏 | 相近任务/材料规模交替原流程和新视图，保留样本差异、原始时长及失败；基线后、对比前冻结相对降幅和口径。重复同题的熟悉效应、漏验及旧证据误用不被成功汇总隐藏 |
| EVI-09 假设建档 | 建议记录与明确用户请求区分；明确一句话可完成建档确认，不强制额外表单。假设可选，不要求每个小功能建档；首批试用不依赖完整假设系统 |
| EVI-10 结论与投入 | Agent 建议和用户确认分别保存来源/适用版本；证据不足为无结论，可靠充分但未达冻结目标时只建议停止下一阶段投入，不自动取消 Task、改计划或写业务完成 |
| EVI-11 决定复审 | 只对显式前提/关联假设的已记录变化准备候选；相关回执和项目摘要可追溯。未登记历史理由不补猜，候选不自动替代 Decision，不启动工作；基线更新后的旧候选须复核 |
| EVI-12 工作段基线 | 用户主动圈定功能/任务集，开始保存既有确认预期不创建任务、启动 Run 或应用计划；临时回顾缺历史预期保持未知，不用当前结果倒造基线 |
| EVI-13 产出与事件统计 | 预期、确切已验收产出、返工、介入和实际调用成本分开；多次重跑不能自动算返工。疑似事件先候选、确认后统计，重复确认不得重复计数，缺失用量/时间不补零 |
| EVI-14 主动范围推演 | 只有用户发起才生成首版推演，Agent 可提示入口；同一可用时间下比较全部做/缩小范围/推迟任务，候选明确范围、依赖和延后后果，不加入资源扩充维度 |
| EVI-15 推演与执行 | 固定基线、未知估时、来源变化、部分应用和活动任务竞争覆盖；未知不能承诺日期，选择方案走原计划 Owner，不自动 Delegate/审批或改活动 Task |
| EVI-16 Owner 与恢复 | 按核定协议，用真实持久化验证材料关系、假设结论、计时/预期、复审/统计候选的唯一写入口、revision、幂等、并发纠正与中断；迟到结果不能覆盖新基线，UNKNOWN 先按原身份核对 |
| EVI-17 真实体验与收益 | 匹配源码包，在真实 Windows 验证选材、摘要展开、计时暂停、自然语言补录及决定/计划入口；使用效果与功能正确性分别结算，文档/Fake/组件通过不作为实际省时或交付证明 |

领域规则用单元测试，新增关联、版本、幂等和候选处理用真实数据库；可控中断验证计时及候选恢复，界面检查成功、Loading、失败、冲突、未知与返回后的真实状态。实际试用保留准备成本和必要正确性反例，样本及阈值在运行前冻结，不预填数值或通过率。实际成绩只在运行后进入[统一功能验收表](overall-acceptance-2026-09-28.md#当前功能验收表)，规格不维护当前阶段。

2026-10-14 比较数据补充映射：EVI-07/08 的已含准备总成本、未知、零基线、事前目标与观察版本冻结、全部试用保留、漏验自述和基线/材料变化标记，对应 [comparison unit](../../apps/api/test/unit/task-acceptance-comparison.test.ts)、[comparison HTTP/PG](../../apps/api/test/integration/acceptance-comparisons.integration.test.ts) 和 [comparison client](../../apps/workbench/tests/taskAcceptanceComparisonsClient.spec.ts)。这是基础数据协议检查，不证明实际相似样本、交替顺序、熟悉效应控制或收益。

会话补录补充映射：EVI-07 的原文数字/单位、明确试用/聚焦澄清、来源消息、保留未提耗时及纠正历史，以及 EVI-16 的冻结试用 revision/原命令重放，对应 [statement unit](../../apps/api/test/unit/acceptance-time-statement.test.ts)、[conversation HTTP/PG](../../apps/api/test/integration/acceptance-time-conversation.integration.test.ts) 与 [conversation client](../../apps/workbench/tests/acceptanceTimeConversationClient.spec.ts)。解释使用可控端口，真实 Provider 与 UI/Windows 效果分别待验。

基础假设补充映射：EVI-09/10 的明确建档、主张/方法/标准版本、观察与来源、建议和用户确认分离、证据不足无结论、停止投入仅建议，以及 EVI-16 的原命令/revision/旧定义和观察适用性，对应 [hypothesis unit](../../apps/api/test/unit/hypotheses.test.ts)、[hypothesis HTTP/PG](../../apps/api/test/integration/hypotheses.integration.test.ts) 与 [hypothesis client](../../apps/workbench/tests/hypothesesClient.spec.ts)。这是数据功能检查，候选判断由调用方提交，不代表实际调用模型做过分析；真实 Provider、UI、收益可靠性与决定复审分别待验。

决定复审补充映射：EVI-11 的明确资料/假设前提、来源变化时事务内候选、未登记不推测、未确认假设建议不触发、用户保留/忽略及原决定替代；EVI-16 的指纹去重、来源/前提/决定基线适用性和原命令重放，对应 [review HTTP/PG](../../apps/api/test/integration/decision-reviews.integration.test.ts) 与 [review client](../../apps/workbench/tests/decisionReviewsClient.spec.ts)。复审不调用模型、不自动改决定/Task/Run；UI 与实际使用收益仍待后续验证。

工作段补充映射：EVI-12/13 的既有 Task/Goal/验收预期保存、本段新完成引用、未完成/基线变化/先前完成、确认事件与撤回历史、已知/缺失模型用量、无历史预期未知；EVI-16 的开始/结束/事件原命令与 revision，对应 [segment unit](../../apps/api/test/unit/work-segments.test.ts)、[segment HTTP/PG](../../apps/api/test/integration/work-segments.integration.test.ts) 与 [segment client](../../apps/workbench/tests/workSegmentsClient.spec.ts)。模型账本为受控记录夹具，未跑真实 Provider 成本/效果；完整文件可用性沿原完成证据入口，本片不替代该检查或新增正式 PASS。

范围推演补充映射：EVI-14/15 的用户主动发起、同一容量/Task/验收/估时/Goal 基线、ALL/SHRINK/DEFER、必要前置与受影响下游、来源可靠性/未知、不改在途 Task、原计划候选与逐项应用；EVI-16 的原命令/来源版本/部分结果，对应 [scope unit](../../apps/api/test/unit/plan-scope-simulations.test.ts)、[scope HTTP/PG](../../apps/api/test/integration/plan-scope-simulations.integration.test.ts) 与 [scope client](../../apps/workbench/tests/scopeSimulationsClient.spec.ts)。核对选择只创建新候选、原窗口不重置、Task 不因选择变化、诊断在原逐项入口才创建、原命令不重复建计划或诊断，来源变化保留旧比较并拒绝旧选择。原计划已部分应用需重新圈定，不能把选择成功当整段应用完成。资料/权限只标待执行核验，完成日期不承诺；无 UI、自动推演或真实收益证据。

## 31. 输入框自动分点与手动润色验收规格

2026-10-15。依据[工作台 §30](../frontend/workbench-design.md#30-输入框自动分点与手动润色)；**本轮仅目标规格，以下未运行，不表示功能通过或已实施。** 实际结果仍只进入[统一功能验收表](overall-acceptance-2026-09-28.md#当前功能验收表)。

| 编号 | 场景与必须验证的反例 |
|---|---|
| CO-01 触发 | 停笔才请求，中文组词期间零请求；相同已处理/已忽略版本不重复请求；空文、禁用、在途发送和斜杠命令不触发；短输入、已有清晰列表不强拆或反复编号 |
| CO-02 原话保真 | 分点仅用原文切片加格式，顺序不变、无遗漏/重叠/越界；去掉程序新增格式后逐字重建原文。覆盖重复句、中文/emoji、空白/标点、路径/URL/代码；畸形边界拒绝，不显示模型重写文本为保真结果 |
| CO-03 需求语义 | 覆盖否定、数字、条件、因果、先后关系及无标点多需求；不把原因强拆、不把「不要做」变成待做。确定性保真测试与真实模型语义样本质量分别说明 |
| CO-04 建议采用 | 提示不抢焦点，查看/忽略不改原文；采用才替换，撤销分点精确恢复采用前草稿。未采用建议不混入发送，无合理分点时不强拆 |
| CO-05 润色入口 | 不依赖先采用分点，点击才调用，重复点击不重复提交；成功保留已有分点并切换同一按钮，失败保留原文和润色入口；空结果/非法响应不得清空草稿 |
| CO-06 原文撤销 | 采用分点→润色→手动修改→撤销，逐字等于点击润色前快照，恢复已有编号，手动修改一并丢弃；提示可见、无需确认框、不调用模型；再次润色以新快照为准 |
| CO-07 迟到隔离 | 分点/润色在途编辑、发送、切会话/工作区/连接、卸载后返回均不覆盖；覆盖改文后又改回相同文本的反例，不能仅凭字符串相等采用旧结果 |
| CO-08 发送与恢复 | 只发送可见草稿一次，不因辅助操作创建消息/Task/Run；成功清理本次辅助状态，失败保留草稿/快照，未知回执保留原发送载荷。原机制恢复草稿时匹配恢复快照，否则不展示虚假的撤销能力 |
| CO-09 暂停与失败 | 润色成功后的编辑不触发自动分点，撤销/成功发送后恢复；分点失败不阻止正常发送，无配置/超时/预算拒绝如实显示，无无限重试或伪造成功 |
| CO-10 服务边界 | 既有鉴权、工作区/会话范围、长度/超时/频率与预算约束成立；只送当前草稿和必要规则，不读取文件/历史、不执行草稿命令；真实调用计入既有用量，不为整理创建占位 Task/Run |
| CO-11 输入兼容 | 首条与已有会话均可用；原 Enter/Shift+Enter、斜杠菜单、中文 IME、资料/目录和草稿离页守卫不退化；键盘查看/采用/撤销、读屏提示与窄窗不遮挡发送分别检查 |
| CO-12 三方案预览 | A 浮层/B 卡内/C 侧边均走同一交互语义，结构明显不同；可输入、停笔、查看、采用、润色、手改、撤销、失败重试及模拟发送；数据全为标注的模拟，不能调用真实模型/API或改产品业务事实 |

纯切片验证、定时/请求版本及撤销状态用定向单元和组件测试；服务端准入/真实记账改动涉及持久化时补对应真实 PG/HTTP 检查，不因本功能默认添加 migration。浏览器覆盖实际输入与焦点、布局和错误路径。真实 Provider 样本评价、真实 Windows IME/DPI 与安装态分别取证；fixture、组件通过和原型截图不能替代它们。

### 31.1 本轮实际覆盖（2026-10-16）

2026-10-16 按[开发任务书](../../prompts/composer-outline-and-polish.md)接入源码（实现默认 A，见[工作台 §30.6](../frontend/workbench-design.md#30-输入框自动分点与手动润色)），下列出口已实际运行：

- `apps/api/test/unit/composer-draft.test.ts`（**10/10**）——CO-02 的确定性部分：文档示例去掉程序新增编号/换行后逐字重建原文；重复句、空白与标点、路径与 URL、emoji（代理对按码点计数）保真；畸形边界 9 类拒绝（非 JSON、非对象、多余字段、非整数、越界、非递增、条目超限、空白段）；空边界是合法回答；CO-05 的润色协议（空串/多余字段/非 JSON/超长一律拒绝，拒绝 ≠ 清空草稿）；CO-01 的适用性（短输入、已分行、斜杠命令、空文）。
- `apps/api/test/unit/composer-draft-port.test.ts`（**3/3**）——CO-10 的请求形状：两条路由的登记元数据与统一入口一致、不加载公共核心；受控 HTTP 捕获**最终发出体**，证明分点请求只含 system 模板 + 当前草稿（草稿标注 UNTRUSTED_DATA、其中的指令仍是数据）、`response_format=json_object`、无工具声明；润色走另一条模板。
- `apps/workbench/tests/composerDraftAssist.spec.tsx`（**13/13**）——CO-01/04/05/06/07/08/09 的状态机：停笔前零请求、短输入不请求、组词期间零请求、忽略后同一版本不重复请求、查看不改原文、采用替换、撤销分点精确恢复、Esc 关闭浮层并交回焦点、润色中态与「同一按钮变撤销」、开始润色结束分点撤销入口、撤销润色逐字恢复润色前快照并丢弃手动修改（含 `aria-describedby` 后果提示）、润色失败与空结果保留草稿且可重试、辅助失败如实显示且不阻止发送、迟到隔离（在途编辑后丢弃；改回相同文本也不复用旧结果）、草稿清空后复位、来源变化清空，以及**键位回归**：润色键在 `.agent-chat-composer-tools` 内、提示行与其同级、浮层绝对定位不推动布局。
- `apps/workbench/tests/browser/composerDraftAssist.spec.ts`（真实 Chromium，API 全部 `page.route` 伪造，不连数据库、不调 Provider，**3/3**）——主路径与迟到覆盖：提示行不抢焦点、润色键确实落在输入卡工具行内（按边界框比对，不另起一行）、浮层锚在提示行上方且不推动布局也不遮输入卡与发送键、采用/撤销真的改回输入框内容、润色按钮二态与后果提示可读屏、在途编辑后旧回包不覆盖草稿；同时断言除草稿辅助外零写请求（辅助不创建消息/Task/Run）。
- `apps/api` 全量 `tsc --noEmit`、`apps/workbench` 全量 `tsc --noEmit` 通过。

**已写未运行**：`apps/api/test/integration/composer-draft-assist.integration.test.ts`（真实 PG）覆盖 CO-08/CO-09/CO-10 的持久化部分——`model_calls` 的 `COMPOSER` 行无 Run/会话作用域且按 `COMPLETED` 结算真实 usage、业务计数（tasks/runs/assist_messages）前后不变、不适用时不写行、畸形协议仍记 `COMPLETED`、Provider 失败记 `FAILED` 与错误分类、闸门限流不写行也不外呼、未配置与超长在开事务之前拒绝、HTTP 401/409/422。共享工作树另有并行实例、机器非空载时并发 `run-integration.ps1` 会挂死或偶发假失败，故**留待空载以 `-TestFile composer-draft-assist` 单跑**，本轮不计入通过。

**未覆盖，不得当作已验**：**真实 Provider 的语义质量样本**（是否切在正确需求边界、是否把原因强拆、是否把「不要做」变成待做——CO-03 的语义部分只有协议与保真证据，没有质量评价）；**真实 Windows 窗口的 IME 组词、DPI 与安装态**；**三方案预览**（CO-12，原型任务书未下发）；跨连接/工作区切换的迟到回包（组件按来源 + 版本核对，未做双连接实机取证）。

## 32. 聊天消息时间线导航验收规格

2026-10-16 定义规格，同日实施首版并按下列范围运行。业务与阅读行为以[工作台 §31](../frontend/workbench-design.md#31-聊天消息时间线导航)为唯一来源，视觉规则以[设计系统 §9.12](../frontend/design-system.md#912-聊天消息时间线导航设计补充)为准；本节只登记规格与实际运行范围，成绩只记[功能验收表](overall-acceptance-2026-09-28.md#当前功能验收表)。

- 核对每个节点绑定原会话与确切消息，重复内容、相同时间和流式更新不串位；点击首/中/末节点后目标开头可读，固定顶栏不遮挡，连续点击以最后目标为准。
- 悬停及键盘聚焦显示原文片段，截断可辨、无模型调用；预览不自动跳转或抢焦点，Enter/Space 可跳转，Esc 可关闭，手动滚动更新当前位置。
- 跳到历史后收到新消息、流式内容增长或布局变化不强拉到底部；回到最新后原跟随规则恢复，未发送草稿与原发送/停止入口不退化，导航零业务写入。
- 空会话、读取中、失败、部分历史已加载及目标暂不可读分别核对；只展示真实可读范围，不以相邻消息替代失效目标；切会话/工作区/连接后旧预览与迟到跳转不得作用于新消息流。
- 长会话、窄短窗、键盘、减少动态效果及真实 Windows/DPI 分别检查：刻度命中区不重叠、浮层不越界、不挡输入/发送，消息流仍是唯一正文滚动容器。组件与浏览器结果不代替真实窗口证据，实际成绩只记统一功能验收表。
- 刻度组在轨道可视高度内垂直居中，长会话放不下时退回从顶排列且第一条刻度仍可达；指针在轨道内移动时刻度长度按「指针到刻度中心的距离」连续递减（峰值在指针处、超出影响半径回默认档），移出轨道后复位，当前位置那档不被压短，联动不改变节点身份、命中区与跳转目标（2026-10-16 同日第二轮）。

### 32.1 本轮实际覆盖

2026-10-16 同日第二轮的刻度组居中与悬停长度联动已并入下列两条出口，数量按本轮结果更新。

两条出口都跑过：`tests/chatTimelineNav.spec.tsx`（Vitest + jsdom，19 例）负责身份与算术——节点只落用户消息、缺失正文不建节点、首/中/末落点等于「该条开头 − `space.2`」、重复文字与跨会话同 ID 不串位、目标缺失只提示不跳转、截断长度与省略号、富文本按文本呈现、Esc 消费与不消费的分界、`aria-current` 跟随滚动、卸载与连点清除落点强调；第二轮新增四例覆盖「距离 → 刻度长度」纯函数（峰值、单调递减、超半径与非法距离回基准）、指针在轨道内按距离写长度（峰值随指针移动、当前位置档不被压短）、指针移出后清空内联长度并回落各自默认档、触屏点按不进入联动。`tests/browser/chatTimelineNavigation.spec.ts`（Playwright Chromium 1440×900 与 900×700，API 全部 `page.route` 伪造，不连数据库、不调 Provider，11 例）负责真实布局下的行为——落点确实停在读区上沿（平滑滚动动画结束后再量）、末条受物理滚动上限约束时如实落在底部、浮层不压输入器与发送键且不抢输入焦点、导航期间零非 GET 请求且草稿保留、历史阅读期新消息到达（末尾 RUNNING 回复经 1.5s 轮询转完成并新增一轮）不打回底部且「回到最新」仍可用、导航轨滚轮只滚自己、切会话后旧节点/预览/跳转全失效、空态与读取中/失败不伪造节点、窄列降为紧凑入口且展开仍是浮层、`prefers-reduced-motion` 下落点仍准确；第二轮新增两例在真实几何下核对联动形状（峰值在指针处且严格长于其余、按距离排开的非当前刻度单调不增、相邻档高于基准又低于峰值、超出 72px 半径回 8px、当前位置档保持 16px、移出后按默认档复位）与居中（短会话首尾留白等量、长会话溢出时只剩轨道自身内边距且首刻度仍在可视区内）。

本轮顺带修正了该浏览器用例的进入方式与一处断言语域：`openChat` 原先点 `collab-viewtab-chat`，而协作页的任务表头在聊天视图下整块 `hidden`（`CollaborationView` 的 `collab-goal`，同日并行改动），页签此刻不可见；聊天视图本来就是默认视图（`useState<"chat" | "task">("chat")`），故改为直接等聊天列渲染。「导航与预览零业务写入」一例把并行在途的输入器草稿助手端点 `POST /composer/draft-assist`（打字后自行发起，与时间线无关）排除在断言外，其余任何非 GET 请求仍必须为空。

未覆盖，不得当作已验：**真实 Windows 窗口与 DPI**（本轮只有 Chromium 无头视口）、**嵌入态任务详情里的会话历史**（未接入，见工作台 §31.4）、**部分历史已加载**（读取入口一次返回 `limit=200`，没有更早历史的续读路径，因此该分支无对象可测）、跨连接/工作区切换的迟到跳转（组件按会话身份核对，未做双连接实机取证）。截图留本机 `apps/workbench/results/chat-timeline-*.png`（第二轮新增 `chat-timeline-tick-falloff.png`、`chat-timeline-centered.png`）。

## 33. 两级上下文菜单验收规格

2026-10-16 定义规格，同日实施并按下列范围运行。业务与交互契约以[工作台 §32](../frontend/workbench-design.md#32-两级上下文菜单与二级能力入口)为准，视觉以[设计系统 §9.14](../frontend/design-system.md#914-两级上下文菜单视觉补充)为准。

- 一级七项（2026-10-24 起）保留原身份与顺序并在顶部补齐参考菜单三项：上传附件、文件、我的产物、选择文件与资料、选择 Skill 生成、输入命令、连接器与插件；状态提示只反映真实事实（已选资料数、已绑定目录、已选 Skill），没有对应事实时不显示提示，也不编造计数。
- 点击一级行展开/收起二级且一级保持打开；点二级行执行后收起两级，且**不改动未发送草稿**；点击外部一次收起两级；Esc 先收二级（焦点回原一级行）再收一级（焦点回「+」）。
- **hover 展开（2026-10-17 用户指令）**：指针悬停一级行即展开该行二级，在两行之间移动即切换；指针移开两级后二级延时收起而一级保持打开；hover 打开的二级被点一次是「固定」（之后移开不收），再点一次才收起；禁用的行 hover 不展开。二级纵向**相对一级弹层居中**（2026-10-19 用户指令，取代「贴住当前那一行」）：`top = (一级高 − 二级高) / 2`，二级更高时上探出一级顶边、唯一硬边是视口顶边；一级贴近视口底部时改为二级底边与一级底边对齐；两档都放不下交给 `max-height` 内部滚动。
- **二级列表在前（2026-10-17 用户指令「子菜单应该直接将文件、skill 列出来」）**：资料二级先列项目资料（当前项目 `ACTIVE` 知识、取 `currentVersion`、最多 20 条、超出指向检索）→ 对话中的资料 → 最近引用 → 检索；本地文件行已于 2026-10-19 移除（图片选择由一级「上传附件」承担，任意本地文件仍不接入）。Skill 二级先列发送选项那一份 `skills`（每个 id 只列最新版本、不可调用项禁用并标「不可调用」、点击写入同一处 `selectedSkillKey`）→ 生成类两条（禁用）→ 在发送选项里选择。项目资料读取失败只在该节说明，不遮挡其余入口。
- **参考菜单三项（2026-10-24）**：一级「上传附件」是直接动作，打开本机图片选择器（PNG/JPEG/GIF/WebP）并交给既有 `useStagedAttachments`，不上传、不发送；「文件」二级用 `POST …/managed-resources/:r/file-read` 的 `LIST_DIRECTORY` 列受管根一层，目录行在同一面板内进入子目录（出现「返回上级」）、文件行插入 `@相对路径 ` mention，`truncated`/`skipped`/失败/未决与无目录/无连接各有文案，失败不显示成空目录；「我的产物」二级用 `getTaskArtifacts` 列当前任务产物最新版本、点一项插入 `@标题 vN ` mention，无任务归属说明去向。文件与产物只是草稿 mention，不是消息附件或 `RelayAssistSourceRef`；不出现第三级。
- 二级方向按实际空间决定：右侧放不下且左侧放得下时翻到左侧；纵向贴住当前行、越界向上收、放不下时收窄面板高度由内部滚动兜住；不得出现横向溢出或改变页面布局。
- 「对话中的资料」只列当前会话消息上真实出现过的引用（去重、三元组齐全、只收知识/记忆/决定三类），没有时给空态文案；开关只改本次候选输入，不发送、不落库、不发新命令；达到每次消息 10 个的上限时未选中项禁用而不是静默丢弃点击。
- 「最近使用」目录来自真实近期目录并复用协作页的目录入口与草稿守卫；无记录时给空态。命令清单来自 `GET /chat-commands` 真实登记、与输入框内联菜单同一套过滤与状态口径，点击只把命令填进草稿。
- 尚未接入的能力（任意本地文件作为消息输入——一级「上传附件」只收图片、管理工作区、Skill 生成两条）如实禁用：行内只写「暂未接入」，原因与接入点只在行的 `title` 里；菜单不再有整段脚注（2026-10-19 用户指认「很影响体验」，见工作台 §32.12）。禁用的行不显示 chevron、不进入焦点顺序，也不带 `aria-expanded`。
- **「选择 Skill 生成」与「连接器与插件」恒可展开（2026-10-18 用户指认「点击不了」）**：没有项目/任务归属、未连接本机 API 这些情况下保留 `disabled === false` 与 chevron，缺口由二级面板第一句（`noteFor` 的同一句文案）说明；连接器面板在无项目时不再停在「正在读取连接器…」，而是直接说明按项目登记，「管理连接与权限」仍可点。仅「没有二级可讲」的行（首条消息的资料、无目录入口时的文件夹）保持禁用。
- **Skill 清单全量 + 目标芯片（2026-10-18 第二轮，用户指令「不应该跟工作区产生强关联」）**：两处输入器的「+ → 选择 Skill 生成」都列出全部内置 Skill（只按输出契约白名单过滤，不按 `target.kind` 过滤）；缺上下文的行尾标 `需任务 / 需项目` 并在 `title` 说明。首条输入器选中这类 Skill 后，工具行出现目标芯片：项目来自 `GET /projects?status=active`、任务来自 `GET /tasks?project_id=`，前端不写死；选定后交回宿主以 `?work=` / `?project=` 切作用域并带 `?skill=` 预选、`?new=` 新开对话。会话输入器（归属已冻结）只标注 + 禁用，`<select>` 同步不可选并说明去哪补。芯片不建会话、不改归属。
- 键盘：Tab 按原生顺序、↑↓ 在当前层内移动、→ 展开二级并把焦点交给第一个可用项、← 收二级回原一级行、Enter 激活、Esc 两段关闭；组词期间的键不触发菜单动作。
- **连接器与插件二级（2026-10-17 用户指令「github、chrome 和电脑插件放到 UI 里，不硬编码、动态读取」）**：一级第五项恒可展开（2026-10-18 起，无项目归属时面板说明缺口，见上一条）；清单动态来自 `GET /projects/:id/gateway-connections`，前端只有能力键 → 中文名映射（`lib/labels.ts` 的 `gatewayCapabilityLabel`，连接页共用，未知键回退原文）；每个能力一行、用 `p` 状态行而不是按钮（连接器是执行时的准入语义，不是消息附件），停用/撤销连接如实标注；空清单与读取失败各有文案；「管理连接与权限」走既有 `/settings/connections`。
- 动效只做轻微位移与淡入（`motion.duration.fast`），`prefers-reduced-motion: reduce` 与 `html[data-motion="off"]` 下动画为 `none` 且状态文字不变。
- 面板宽度收缩到内容、行内左右留白对称（2026-10-16 用户截图指认「菜单右侧留白太多」后补）：一级与二级面板都由最宽的一行决定宽度，行尾状态位与 chevron 组成一个右对齐的尾组，各行尾组右缘距行右缘相等；空态不参与固有宽度计算，长说明只折行、不撑宽面板（脚注已于 2026-10-19 删除）。

### 33.1 本轮实际覆盖

**2026-10-17 追加（hover 展开、二级列表化与连接器二级）**：`tests/composerAttachMenu.spec.tsx` **24/24 全绿**（原 16 例 + 新增 8 例：hover 展开／固定／移开延时收起／禁用行不 hover、项目资料直接列出并勾选、项目资料读取失败、Skill 直接列出与选中、连接器动态清单与空态/读取失败文案）；`tests/connectionsSettings.spec.ts` **23/23 全绿**（连接能力清单扩到 15 项，覆盖电脑 / GitHub / 浏览器三族）；`tests/assistantModeSwitch.spec.ts` **47/47 全绿**（真实 `/agent` 路由下的「+」弹层既有用例仍走点击语义）；`apps/workbench` `tsc --noEmit` 通过。真实 Chromium 用临时预览页量过 hover 展开、贴行定位（二级面板 `data-flip`、贴住当前行、超视口时收窄高度内部滚动）、移开 500ms 后二级收起且一级保持打开，预览页与截图脚本用后已删。未跑：Playwright 产品页面、真实 Windows 窗口与 DPI。

**2026-10-18 追加（Skill 与连接器入口恒可展开）**：`tests/composerAttachMenu.spec.tsx` **24/24**、`tests/assistantModeSwitch.spec.ts` **47/47**、`tsc --noEmit` exit0。改动把两项一级行的 `disabled` 去掉（无归属/无项目时仍可点开），断言随之从「禁用 + 无 `aria-expanded`」改为「可展开 + 面板首句说明缺口 + `title` 与脚注同源」；连接器无项目一例新增「面板不再停在『正在读取连接器…』且管理入口仍在」。未跑：真实 Chromium/Playwright 产品页面、真实 Windows 窗口与多 DPI。

**2026-10-18 第二轮追加（Skill 清单全量与目标芯片）**：`tests/composerAttachMenu.spec.tsx` **25/25**（新增「清单全量：缺上下文的行标注、能就地补齐时仍可选、归属冻结时禁用并说明」）、`tests/composerTargetPicker.spec.tsx` **4/4**（新建：项目清单来自接口、任务经项目两级、空清单与读取失败文案、无 API/发送中不可展开）、`tests/assistantModeSwitch.spec.ts` **47/47**（`/agent` 首条不再有 Skill 脚注，只有资料与连接器两条）。`tsc --noEmit` 通过；同一时刻 `tests/composerImageAttachments.spec.tsx` 有并行会话未完成的改动（`init` 未定义），与本轮无关。`?skill=` 深链预选、`?work=` / `?project=` 作用域切换只有 jsdom 断言与源码核对，未跑真实路由端到端。

**2026-10-19 晚追加（去掉菜单说明文字）**：`tests/composerAttachMenu.spec.tsx` **26/26**、`tests/chatCommandInput.spec.tsx` **7/7**、`tests/assistantModeSwitch.spec.ts` **47/47** 全绿。断言从「脚注存在且被 `aria-describedby` 引用」改为「`.agent-chat-attach-note` / `.agent-chat-attach-subnote` 节点数为 0、原因在行 `title` 上、可用的命令不再有状态标签」。`tsc --noEmit` 仅剩并行改动涉及的三份测试文件（`composerAttachmentPreview`、`memoryStatusClient`、`tmpFlashProbe`）报错，与本轮无关。真实 Chromium 的 `uiOption2FirstSession.spec.ts` 单条用例在本机两次单独运行分别停在首次点击与发送环节（失败点不同、均早于本轮改动的断言），判为**该用例在本机的不稳定**，未作为本轮证据。

**2026-10-19 晚追加（二级纵向定位：相对一级居中 / 贴底时底边对齐）**：真实 Chromium 临时预览页（挂载 `ComposerAttach` + stub client，引用真实 CSS 与 token，用后已删）量得四档——1280×900 与 900×620 下二级 offset 恰为 `(96−222)/2 = −63`（居中）；一级贴底档（1280×380）二级底边与一级底边差 0；二级比视口还高的极端档（1280×300）被 `max-height` 夹住、面板顶边 83px 未越出视口。截图留 `apps/workbench/results/attach-submenu-*.png`。单测套件复跑全绿：`composerAttachMenu` **25/25**、`assistantModeSwitch` **47/47**、`chatCommandInput` **7/7**（三份并跑时出现过成组抖动，单跑全绿，与 §33 首轮的并发提醒同因）。未跑：真实 Windows 窗口与多 DPI。

2026-10-16 首次实施：

两条出口都跑过。`tests/composerAttachMenu.spec.tsx`（Vitest + jsdom，**16 例全绿**）在组件层锁定菜单框架：一级四项与状态位、二级开合、引用开关与 10 个上限、三类空态、键盘四键、Esc 两段、外部点击、方向翻转、未接入项的禁用与脚注、命令清单读取失败文案，以及**尾组结构**（状态位与 chevron 同组、面板不写死最小宽度——jsdom 量不到几何，这条结构断言与下面的 Chromium 实测共同守住对称规则）。`tests/assistantModeSwitch.spec.ts`（**47/47 全绿**，该文件另含并行实例新增的输入器布局结构断言）在真实 `/agent` 路由下补两条集成用例：目录二级展开→未接入项禁用→「选择文件夹」打开协作页既有的「更换目录」对话框；命令二级列出真实登记→点击把 `/review ` 填进首条草稿且零 POST。`apps/workbench` 全量 `tsc --noEmit` 通过、`vite build` exit 0。

几何证据（真实 Chromium，临时量测页引用真实 CSS 与真实 token 值，用后已删、不作为产品页面保留）：一级面板宽度 235px → **200px**、二级面板 → **194px**；各级逐行实测「尾组右缘距行右缘」恒为 8px＝左内边距；对照组（长脚注不排除固有宽度）二级面板会被撑到 345px，故 `width: 0; min-width: 100%` 是必要而非装饰；二级面板 25 行超高滚动时 `scrollWidth === clientWidth`，无横向溢出。

为让真实路由用例能点到目录入口，`tests/setup.ts` 补了 `Element.prototype.scrollIntoView` 的空实现（jsdom 无布局，真实浏览器有；既有 `window.scrollTo` 同一做法）。

未覆盖，不得当作已验：**真实 Windows 窗口、DPI 与原生 IME**；**浏览器层 Playwright 规格**（本轮未跑）；**真实模型**（本片不涉及模型调用）；「左右两侧都放不下」的极端窄窗档位。全量 vitest 本轮在共享工作树内与并行实例同时运行，出现成组的用例级抖动（同一文件单跑全绿），故只把上列定向出口作为本片证据：`collaborationWorkspace` 的 1 例执行摘要文案与 `run-events` 的 SSE 时序是既有失败；`assist-flow`（4 例）与 `firstPartySkills`（1 例）走 `?skill=assist` 项目/任务子页，其路由假设已被并行实例「旧 Assist 入口统一到 `/agent`」（`ProjectSkillView.tsx` 改为 `<Navigate to="/agent?project=…">`）取代，属该改动的待同步夹具，与本片无关；`responsiveTiers` 的 1 例报的是并行实例新增的 `components/ComposerDraftAssist.css` 旧式 `max-width` 写法。

## 34. 会话局部与总 diff 验收规格

2026-10-16，**以下均为待运行规格，不是通过证据**。产品规则唯一见[工作台 §34](../frontend/workbench-design.md#34-会话局部与总-diff)，视觉见[设计系统 §9.15](../frontend/design-system.md#915-会话-diff-的展示建议)，实施见[专项提示词](../../prompts/conversation-live-diff.md)。场景编号 CD 用于需求、测试与交付映射，不新增业务状态枚举。

| 编号 | 场景与通过条件 |
|---|---|
| CD-01 两个位置 | 聊天逐文件编辑记录旁显示局部数；输入卡外上方居中显示会话总数；不是只在右栏或最终回复显示 |
| CD-02 正确起点 | 预置已暂存、未暂存、未跟踪内容后开始会话，初始增删为零；随后只计相对真实会话快照的变化；内容与 HEAD 不同也不能算初始新增 |
| CD-03 净变化 | 同一行反复修改后恢复、新建再删除、删除再恢复，净数各自回零，局部历史仍保留；两处数量允许不同但各自基线明确 |
| CD-04 生命周期 | 连续两条用户消息、多个 Run、暂停恢复、刷新及重启 API/Worker 后，沿原会话起点；真正新会话使用自己的基线 |
| CD-05 历史和目录 | 旧会话无起点时不可用；主动从现在开始显示新起点；换目录另建明确新段，不跨段汇总，返回旧目录不误用过期 epoch |
| CD-06 范围与拒绝 | 根为仓库子目录时不读取兄弟目录；覆盖未忽略的新文件；忽略项、敏感文件、越界、Windows 大小写/重解析点、子模块按原权限与范围处理，失权不可通过历史正文绕过 |
| CD-07 Git 不副作用 | 真实临时仓库中确认基线建立/查询不创建 commit/stash/分支、不改 index；用户暂存或提交后原会话数值仍成立；无初始提交也能建立内容基线 |
| CD-08 基线竞争与容量 | 并发首次请求只发布一个有效起点；捕获中遇到目录变化有界重试或明确不可用；大文件/文件数/总量超限列明，不把部分数据冒充完整；失败不丢原消息、不破坏原执行流程 |
| CD-09 生成中更新 | 可控模型分多批输出 `apply_changeset` 参数，至少两次真实预览变化出现在流结束与工具派发之前；不是前端定时造数或完整结果到达后的补间 |
| CD-10 片段解析 | JSON 转义换行、反斜杠、拆开的 Unicode、半截 content、路径晚到、多文件、两个交错工具调用均归属正确；不数原始 JSON 行、不执行片段；输出/CPU/频率有上限 |
| CD-11 预览语义 | 完整 MODIFY 目标到达前不把未到达文件尾部算成已删除；缺基线不猜行数；预览可修正、不标已修改，也不进入总数 |
| CD-12 准入和实际结果 | 等待批准、拒绝、取消、写入失败、部分应用与 UNKNOWN 逐文件真实显示；成功数绑定原操作及确切实际内容；UNKNOWN 不盲重试，目录统计不替原动作结算 |
| CD-13 多轮与迟到 | 切会话、目录、重试/新模型调用及权限变化后，旧片段/查询/终态事件不能复活旧数据；重复事件不新增编辑行或累计数字 |
| CD-14 外部编辑 | 会话激活时人工/受控 CLI/另一会话写入，在约定刷新预算内反映于总数；标明同期修改而非 Agent 归因，不越过目录资源排他 |
| CD-15 一致性与断线 | 总数和展开列表绑定同一修订及采样时间；事件断开后可补读，重新连接不重放加数；旧 revision 不能覆盖新值 |
| CD-16 字符与文件类型 | 中文、空文件、无末尾换行、CRLF/LF、二进制、重命名按方案固定规则；二进制不能编造行数，新增/删除/修改路径数按统一规则核对 |
| CD-17 空与错误 | 无目录、非 Git 根、缺基线、失权、统计中、空净变化、部分不可统计、刷新失败分别可辨；失败保留上次可信值和时间但不掩盖失权，不把未知显示为零 |
| CD-18 展开阅读 | 局部打开原编辑前后；总入口打开原会话起点到同一当前修订；展开时正文与统计匹配，历史查看不误读当前磁盘；超限明确而不假装完整 |
| CD-19 布局与可访问性 | 窄/宽视口长文件名、数字位数变化不遮发送/停止，不改变输入卡高度、草稿/光标/组词；键盘开合与回焦、可访问名、颜色/符号与 reduced-motion 正确 |
| CD-20 真实环境分层 | 真 PG 验证基线发布/唯一性/epoch/恢复；真 HTTP/API-client 验证权限与字段；临时真 Git 仓库验证净变化；浏览器验证实时流及位置；真实 Provider 和 Windows 窗口另行报告，不能用 Fake 或截图替代 |

先用受控片段与故障点固定身份、预览、实际结果和重启恢复，再在一次性目录/Git 仓库中做读写实验，不能拿用户当前工作目录作破坏性测试。涉及持久化约束必须执行真实 PG，不能以模拟 Repository 代替。具体刷新预算、扫描和响应上限在实现时先确定并写入接口/相关文档，再按同值验证；不把方案中的推荐周期当已测延迟。运行后只在统一功能验收表维护实际成绩与限制，本节保持测试契约。

## 35. 内置 GitHub Skill 只读片（0103）

2026-10-17。范围与取舍见 [ADR-023](../decisions/ADR-023-builtin-github-skill.md)，实现边界见[工具适配器 §4.1](../architecture/tool-adapters.md#41-github-只读查询01032026-10-17-开发自检)。场景编号 GH 只覆盖首片只读；GitHub 侧写动作与随包 Skill 资源另行补规格。

| 编号 | 场景与通过条件 |
|---|---|
| GH-01 能力与动作词表 | 只有 `GITHUB_READ` 一个只读能力，四个动作（仓库信息、PR 列表、PR 查看、Issue 列表）；词表外动作与 `gh_api` 一律拒绝，不进入 Gateway，不产生 Operation |
| GH-02 来源与资源 | 只放行 `ASSISTANT_READ`/`AGENT_SESSION_READ` 且必须绑定受管资源；`RUN`、`USER_ACTION`、`USER_IMPORT` 与无资源行被数据库 CHECK 拒绝；三条相关约束逐条重述而非覆盖 |
| GH-03 按需激活 | 只有存在 ACTIVE `GITHUB_READ` 连接时四个工具才进当轮词表；停用连接后下一轮立即消失，历史读取不受影响 |
| GH-04 目标绑定 | 目标恒为用例选定的受管根，Permission 按该根前缀判定；模型参数中的仓库名被丢弃/拒绝，适配器 argv 的 `--repo` 只能来自本地解析结果 |
| GH-05 仓库身份 | 从受管根的真实 `git` remote 解析，只认 `github.com` 的 https/ssh/scp 写法，多 remote 按名确定性选择；没有 GitHub remote 时报 `GH_REPO_UNIDENTIFIED`，不发网络请求 |
| GH-06 参数与进程边界 | `execFile`/`shell:false` 结构化 argv，固定只读标志；环境为显式白名单，不转发 `RELAY_`/token；超时与取消有界 |
| GH-07 缺失 CLI | 本机没有 `gh` 时结算 `FAILED` + `GH_CLI_UNAVAILABLE` 并给安装提示，不显示为空列表 |
| GH-08 失败分类 | 未登录、网络、仓库未识别、查无此项、权限/限流、超时分别可辨；错误不泄露凭据，不把失败当成功或空结果 |
| GH-09 有界投影 | 列表条数、PR 正文、状态检查数量有上限，截断显式可见并保留总数；所有外部正文带不可信标记 |
| GH-10 逐动作权限 | `repo_view` 与 `pr_list` 等动作分别受 Permission 约束；只授权一个动作时另一个仍被拒；被拒请求不落 Operation |
| GH-11 与其他能力共存 | `GITHUB_READ` 不放宽 `FILE_READ`/`FILE_QUERY`/`GIT_READ` 的范围，文件读取仍被限制在自己的受管根；只读轮次不创建 Task/Run/范围授权 |
| GH-12 真实 PG 与既有回归 | `0103` 在真实 PostgreSQL 迁移链应用成功；原始 INSERT 正向/反向反例通过；受约束重述影响的既有套件（助手只读、人工 Git、真实工具 Gateway、迁移）全部保持通过 |
| GH-13 真实 Windows 与安装包 | 真实 Windows/WebView2 窗口、打包后资源解析与安装验收；本片未运行，不得以开发模式顶替 |
| GH-14 真实已认证读取 | 在安装并登录 `gh` 的机器上执行四类读取，核对真实仓库、权限失败、限流与网络错误；本片未运行 |

**本轮实际覆盖（2026-10-17，开发自检）。** GH-01–GH-12 已由 `github-read.test.ts`（**16/16**）与真实 PostgreSQL 上的 `github-read.integration.test.ts`（**8/8**）覆盖；受 `0103` CHECK 重述影响的既有集成套件回归 **85/85**（助手只读 6、人工 Git 15、真实工具 Gateway 54、迁移 10），退出码 0，临时集群正常关停并删除。GH-13/GH-14 未运行：本机没有安装 `gh`，无法提供真实已认证读取或限流证据；官方 Skill 原文尚未进入打包与运行时提示，也没有 GitHub 写动作。上述成绩只说明开发自检通过，不构成 F25 验收。

## 36. 内置浏览器自动化验收规格（2026-10-17）

范围与选型见[浏览器自动化 V1](../architecture/browser-automation-v1.md)，取舍见 [ADR-024](../decisions/ADR-024-builtin-browser-automation.md)。本节为**未运行规格**：架构审查完成，源码、迁移与随包资源均未开始，验收表对应行记「未实施」。场景编号 BR 覆盖 F26 首片（浏览器自有实例 + 页面级隔离 + 三能力）。

| 编号 | 场景与通过条件 |
|---|---|
| BR-01 启动与连接 | Relay 拉起自有 Chrome（独立 profile、`--remote-debugging-port=0`、读 `DevToolsActivePort`），MCP 以 `--browserUrl` 附着；`ensureStarted` 返回 `READY`，`tools/list` 覆盖冻结映射表全部所需工具；不复用用户默认 profile |
| BR-02 缺失与不兼容 | Chrome 未安装/路径无效 → `CHROME_MISSING` + 可操作诊断，不抛栈；后端入口缺失 → `BACKEND_MISSING`；上游工具缺失或版本不符 → `INCOMPATIBLE`，不做降级猜测 |
| BR-03 读取与有界投影 | `browser_read_page` 返回 url/title/readyState/a11y 快照与 uid，超限截断显式标记；`browser_screenshot` 只返回摘要（宽高/字节/sha256），图片正文不进账本与日志 |
| BR-04 定位与元素不存在 | 只接受快照 uid；uid 不存在/已失效返回类型化失败并提示重读，不退回坐标点击、不静默重试 |
| BR-05 加载超时与等待 | `browser_wait_for` 在文本出现时成功、超时按类型化失败结算；导航超时不留下半可信动作，结果为 UNKNOWN 且页面标记 STALE |
| BR-06 页面所有权 | 未登记 page_id（用户自建页、其他 Run 的页）→ `BROWSER_PAGE_NOT_OWNED`，不导航、不点击、不关闭；`browser_close_page` 只关闭自有页 |
| BR-07 缺省页语义 | 缺省 `page_id` 恒为本 owner 自建默认页；不存在「缺省=用户聚焦标签页」分支；默认页被用户关闭后要求重新 `new_page`，不自动改选别的页 |
| BR-08 并行隔离 | 两个 Run 各绑一页交错执行，结果互不串页；同一 page_id 上的操作串行（页级互斥），不同页可并行 |
| BR-09 取消 | 取消后发出 MCP `notifications/cancelled`；在途写类动作按 UNKNOWN 结算、页面标记 STALE；不把「可能已发生」算成失败，也不在 STALE 未清时继续操作 |
| BR-10 崩溃与恢复 | `chrome.exe` 被杀或 MCP 退出 → 检测断连、关闭残留、丢弃所有权、重建实例；在途动作 UNKNOWN；任务得到「浏览器已重启，需重新打开页面」的明确提示，不认领旧页 |
| BR-11 用户接管 | 用户在自有页上操作或外部改动 DOM 后，旧 uid 失效、快照版本变化；Agent 必须重新读取后才可继续，禁止盲目重复点击或提交 |
| BR-12 权限分级 | `BROWSER_READ` 可 AUTO；`BROWSER_ACTION` 默认 ASK、可被「本次任务允许」覆盖；`BROWSER_COMMIT` 在有范围授权时仍 `WAITING_APPROVAL`；提交类点击被风险分类器升级为单动作 ASK |
| BR-13 目标与策略 | `normalized_target` 为 `browser://<origin>`（未知时 `browser://unknown`），origin 取自服务端已知页面状态或本次导航目标而非模型自报；策略可按 origin 收窄 |
| BR-14 外部内容不升级权限 | 页面文本与快照只作为数据；网页内指令不改变能力、策略、授权或工具词表；`evaluate_script` 等任意 JS 执行不在词表内 |
| BR-15 按需激活与只读边界 | 只有存在 ACTIVE `BROWSER_*` 连接时相应工具才进当轮词表；会话只读轮次只拿到 `BROWSER_READ` 四工具，写工具不出现 |
| BR-16 迁移与既有回归 | `0105` 在真实 PostgreSQL 迁移链应用成功；`logical_operations` 的 origin×resource CHECK 逐条重述后历史动作仍合法；`tool-catalog` 词表封闭性与助手只读集合回归通过 |
| BR-17 打包与安装 | `fetch-browser-mcp.mjs` 按固定版本 + integrity 取包；`build-release.ps1` 校验入口、`package.json.version`、`LICENSE`/第三方声明与产物清单；安装后能解析资源并启动，卸载无残留（不写注册表/扩展/PATH） |
| BR-18 真实 Windows 与安装态 | 真实 Windows/WebView2 窗口下的面板状态、暂停/停止、审批卡与轨迹展示；安装态冷启动；未运行不得以 dev 窗口或 mock 顶替 |

**本轮实际覆盖（2026-10-17，M1 开发自检）。** BR-01 已运行（真实 Chrome `155.0.8059.40` + 后端 `1.11.0`：独立 profile 起停、`DevToolsActivePort` 取端口、`tools/list` 26 个工具通过冻结映射自检、`READY`）；BR-02 部分（`CHROME_MISSING`/`BACKEND_MISSING`/`INCOMPATIBLE` 三条分支有代码与类型化错误码，只有路径缺失分支被真实触发过）；BR-03 部分（快照有界与截图摘要已实测：762×484、19,789 B、sha256 可核对，图片正文未进结果）；BR-04 已运行（错误 uid 得到 `BROWSER_ELEMENT_NOT_FOUND`，不回退坐标点击）；BR-06/BR-07 已运行（未登记页 `BROWSER_PAGE_NOT_OWNED`、缺省页只可能是自建页、两任务互不串页）；BR-13 已运行（`browser://<origin>` 目标由导航目标或该页已知 origin 生成，页面被改走后 `BROWSER_PAGE_STATE_CHANGED`）；BR-16 部分（`0105` 尚未在真实 PG 迁移链上跑过，仅 `tsc` 与词表断言通过）。

**未运行**：BR-05（加载超时/等待超时只有单测替身）、BR-08 的真实双 Run 交错（需真实 PG + Worker）、BR-09/BR-10/BR-11 的真实链路（取消底层停止、`chrome.exe` 被杀后的重建、用户接管后恢复——STALE 语义有单测，真实浏览器未验）、BR-12（权限分级需真实 Gateway 审批链）、BR-14（外部内容不升级权限的端到端）、BR-15（会话只读词表只有静态断言）、BR-17/BR-18（打包与安装态）。这些缺口不因 M1 冒烟通过而消失。

## 37. 普通 Agent 文件增删改与方法 MODIFY 接续（2026-10-18）

用户反馈「relay 好像还没有增删改的能力」；本轮范围是**对话 Agent 对绑定目录内文件执行 CREATE / MODIFY / DELETE**。只补执行链与可见性，不改删除确认、AUTO 不豁免、FULL 由系统判定或 Gateway 准入语义。实际成绩只在[统一功能验收表](overall-acceptance-2026-09-28.md#当前功能验收表)维护。

- **写提示词**：`run-prompts.test.ts`、`agent-runtime-prompts.test.ts`、`runtime-prompt-router.test.ts` 覆盖写分支允许三种动作、MODIFY/DELETE 必须先 `read_file` 并带真实 `sha256`、CREATE 目标必须不存在、删除只在任务明确要求时提出、ASK/AUTO 不豁免、FULL 由系统判定、禁止以清空/覆盖/改名绕过确认，以及只读分支不出现写文案；`DRAFT_WRITE_TOOLS` 模板版本为 `1.0.2`。
- **方法 MODIFY**：`conversation-prompts.test.ts` 覆盖「冻结方法说明在前、执行协议在后」、`INSPECT`/空行动/无工具轮仍只读；`folder-first-conversation.integration.test.ts` 的真实 PG/HTTP/磁盘用例验证 `/diagnose 修好 answer.txt` 产出带 `execution_method` 的写候选（`writes_files: true` 与 `file_changes`）、经原 Apply 建立 Run、真实读取基线后落盘；`INSPECT` 的脚本化写候选被收口为 `CLARIFY`，零 Task/Run、磁盘不变。该文件本轮 **20/20**。
- **真实模型删除**：`real-model-tool-loop.integration.test.ts` 增加 DELETE 批准与拒绝两例——批准后只有指定目标消失、无关文件不变；拒绝后字节不变、Run 以 `ACTION_APPROVAL_DENIED` 收口且不产生恢复命令。用例只在配置 `RELAY_MODEL_*` 时运行；本轮未配置 Provider，**5 例全部 skip、0 运行、未验**。脚本化模型、HTTP 与组件结果不能替代真实 Provider。
- **前端**：`executionSummary.spec.ts` 验证候选文件动作列表与含 DELETE 的审批提示；`executionTrajectorySummary.spec.ts` 验证等待审批链接的精确 `operation_id` 匹配、无匹配回退与读取失败回退；`conversationExecutionClient.spec.ts` 验证 `file_changes` 解析、旧投影缺字段为空数组、非法形状报错。定向 **15/15**；scoped typecheck 通过。
- **主流程输出协议（2026-10-18 用户实机截图回归）**：真实窗口里模型先写一句结论再贴信封，旧解析要求「整段输出必须是 JSON」，于是把原文当普通回复落库，聊天直接显示 JSON、候选同时丢失。现允许信封前最多 400 字前言与代码框包裹；信封仍必须是单个完整 JSON 对象，候选合法性不变。残缺信封不再原样展示：优先救回 `reply` 字符串，其次保留 JSON 前的结论，都没有时给出可读失败说明。执行候选与状态维护共用同一解析入口，避免两处判定漂移。`conversation-execution.test.ts` **15/15**（新增前言、代码框、残缺信封 3 例）；`folder-first-conversation` 复跑 **20/20**，`agent-conversation-main-loop` **8/8**。
- **回归（真实临时 PG/HTTP/磁盘）**：`tool-loop` **45/45**、`agent-conversation-main-loop` **8/8**、`real-tools-gateway` **55/55**、`agent-main-loop-execution` **17/17**、`gateway` **30/30**，均 exit 0，临时集群已删除。API typecheck exit 0。
- **未验**：真实 Provider 的 DELETE 批准/拒绝；真实 Windows/WebView2 窗口的 CREATE / MODIFY / DELETE（含批准与拒绝）与方法 MODIFY。用户实机截图只证明解析缺陷存在并被修复，截图会话的目录档位仍为只读（输入器显示「未开放写入」），重发前须切到请求批准或更高档位；活动桌面仍运行 2026-10-17 暂存 API，本次解析修复与当日提示词变更均未载入，需关闭应用后以 `-RefreshApi` 重新暂存并重启再验。全量 API 单测唯一红为 HEAD 既有的 DISCUSS 文案断言；Workbench 全量 typecheck 仍被并行未提交文件阻塞，均未修改。

## 37. 周期定时启动任务验收规格（2026-10-18）

产品规则归[后续路线 N08](../requirements/post-v1-roadmap.md#n08-周期定时启动任务)，取舍归 [ADR-026](../decisions/ADR-026-scheduled-task-autostart.md)，协议归 [HTTP §10.94](../api/http-command-contract.md#1094-周期定时启动任务2026-10-18-源码实现迁移-0115)，物理设计归[数据库 §103](../database/physical-design-postgresql.md#103-0115-周期定时启动任务2026-10-18-源码实现)。

**必须成立的七条。** 少任何一条都不算通过，也不因为其它条绿而放行。

1. **触发真的启动，且只启动一次。** 到点后新建一个 Task（标题/目标/验收来自模板）、Task 进入 `READY`、产生一个 Run；同一时段被重复扫描不会建出第二个 Task；同一 `command_id` 重放返回原结果。
2. **授权在先、准入在后。** 触发不扩大权限；`EXPIRED` 与预算耗尽都把计划置 `EXPIRED` 并留一条说明原因的 `BLOCKED`，不静默停。
3. **以 Task 终态判准入。** 上一轮 Task 不在 `DONE`/`CANCELLED` 时本轮 `SKIPPED`，不建新 Task，且不消耗 `max_runs`。
4. **错过不自动执行。** 应用关闭期间错过的时段记 `BLOCKED('MISSED')` 且 `task_id IS NULL`；只有人工「补跑」才启动。
5. **暂停/停用停止新触发。** 状态改变后即使时刻已到也不再扫描；已启动的 Run 不受影响。
6. **墙钟语义。** 跨夏令时仍按本地时刻触发；春跳不存在的时刻顺延一小时，秋回重复的时刻取较早一次；关机多天后只推进一次且结果严格晚于当前时刻。
7. **待处理可达。** `BLOCKED` 触发进入既有 `attention` 投影（`kind='SCHEDULED_TASK_BLOCKED'`），入口指向详情页，不与 N05 提醒混用去重键。

**证据分层（一种不能代替另一种）。**

- **纯单元**：`zoned-time.test.ts` 覆盖上海、纽约春跳/秋回、伦敦、Kolkata(+5:30)、Chatham(+12:45)、Kiritimati(+14)、跨 DST 的每日 09:00、关机三天只推进一次、首次触发严格晚于当前；`scheduled-tasks.test.ts` 覆盖规则/上限/到期/时刻/日期/时区/文本口径。这一层只证明计算与校验，不证明触发。
- **真实 PostgreSQL + 真实 API 进程**：`scheduled-tasks.integration.test.ts` 用 `now() ± interval` 直接改 `next_due_at` 制造到期（只改排期列，不改任何业务状态列），断言 Task/Run 真的落库、`runs_started` 计数、跳过与错过不建 Task、`EXPIRED` 与暂停不再扫描、补跑只建一个 Task、`attention` 投影可达。
- **前端**：`scheduledTasks.spec.tsx` 覆盖列表/详情解析（含未知状态与未知重复类型显式失败）、创建请求的 snake_case 载荷、回执身份核对、重复规则与时刻按时区呈现；`navigation.spec.ts` 复跑确认新增第 5 项不破坏既有选中语义。
- **未验**：真实 Windows/WebView2 窗口、多 DPI、安装态、多实例并发扫描（本片假设单 API 进程，与 N06 一致）、真实模型执行（集成测试只证明 Run 被创建，不证明它跑完）。

**故障与竞争的组合不因单条绿而推断通过。** 崩溃点注入（`createTask` 成功后进程退出）在本轮只由「预生成命令身份 + 回执重放」的设计与唯一约束兜底，没有专门的故障注入用例；要宣称该场景已验，须另补可控故障点测试。

## 38. 资料与记忆规则恢复（2026-10-19）

范围：仅 [HTTP §10.97](../api/http-command-contract.md#1097-资料归档与记忆规则停用的反向命令2026-10-19-后端实现) 的三个反向命令，产品规则归工作台 §13.2。规格不等于通过，运行结果只归统一功能验收表。

- 真实 PG/HTTP 验证 ARCHIVED/RETIRED→ACTIVE、根修订递增、版本指针和不可变正文/确认信息不变；Workspace 全局对象同样可恢复。
- 同命令同载荷、并发首次请求只有一次状态变更与审计；不同载荷拒绝；再次停用后重放仍返回历史原回执。已 ACTIVE 匹配请求不推进任何修订。
- 陈旧修订、跨 Workspace 与归档 Project 拒绝且零业务写入；正向回执不明时前端不得提供可承诺成功的撤销。
- context_revision 单调递增；Rule 恢复还推进 rule_revision，沿原 Rule/Delegate/动作准入栅栏回归，不修改原 Run 的冻结版本和已发生效果。
- 归档产生的决定复审候选与 Decision 在恢复后保持原行，不能删除待核对事实。Memory 有效期和来源可用性保持原过滤，不因恢复 ACTIVE 绕过。
- 前端接线后在 2026-10-19 补齐：client 三条路径与回执四项核对、正向回执确认后才出现的撤销条、撤销用新命令与正向回执修订、结果不明不给撤销、撤销失败升级 Notice 与永久入口可达、切类型/范围后仍落原目标、永久恢复用当次读回修订并在冲突时重读。运行结果只归[功能验收表](overall-acceptance-2026-09-28.md#当前功能验收表)；真实 Windows/WebView2、Provider 和安装态证据另报，不由后端套件代替。

## 39. 长期记忆状态与筛选（2026-10-19）

产品规则归[工作台 §13.3](../frontend/workbench-design.md#133-长期记忆状态与筛选2026-10-19已确认前端已接)，协议归 [HTTP §10.98](../api/http-command-contract.md#1098-长期记忆有效状态与筛选2026-10-19-后端接续)，实际成绩只归统一验收表。

- 真实 PG/HTTP 覆盖默认 ALL、ACTIVE/EXPIRED/RETIRED 筛选、列表/详情同源、非法枚举与到期边界；已停用优先于过期。
- 原 ACTIVE 记忆到期后有效状态变 EXPIRED，根、当前版本、Workspace authority 与不可变历史均不变；查询零写入。到期记忆不进入原搜索和 Context 候选。
- 恢复过期记忆不续期；明确确认的新修订才能改变有效期，当前投影沿新版本变化而历史不变。
- 与 project_id 组合含 Workspace 全局项和本项目，排除同 Workspace 其他项目与跨 Workspace 条目；跨范围 ID/Project 不可读。
- 前端另验状态未知兼容、四种筛选、迟到响应、无匹配、恢复/续版后重读和原撤销/未决命令守卫；浏览器与 Windows 验证独立报告。

## 40. 完整长短期记忆后端（2026-10-20）

按 [工程边界](../development/memory-module.md) 与 [HTTP §10.99](../api/http-command-contract.md#1099-长短期记忆接口2026-10-19) 验证，结果只归统一功能验收表。

- 长期：明确确认、确切原消息 hash、幂等、来源可查与删除引用栅栏；Workspace/Project 隔离、有效期/停用排除、关闭自动召回后实际 plain/tool-loop 模型输入不含旧自动来源。
- 短期：超过原20条仍能使用早期合法目标；手动/自动持久整理、摘要＋近期原文、独立进程连接重启、原消息保留、预算真实调用记录；中文 `/压缩` 与 `/compact` 沿同一 Owner，菜单只解析不执行。
- 恢复：坏 JSON/失效来源/设置或窗口修订变化不得发布；过期租约与迟到结果不能覆盖；运行中取消既覆盖异常也覆盖端口返回 CANCELLED；同覆盖边界 AUTO 失败后不立即循环整理，原消息能安全继续或明确预算失败。
- 传递隔离：A 使用来源 M→B 只经历史使用 A→撤销 M→C，不得经 B 回流；checkpoint 派生答复、分叉足迹与从答复保存长期记忆同样核对。工具历史换目录/权限变化拒用，旧工具答复无使用账本不能经 fork 补授权。
- 管理：清除与一次性模式保留原文和长期事实；在途控制拒绝、旧修订拒绝，重新开启不吸收关闭期间轮次；完成短期子记录可随物理删除清理，跨对象长期来源引用仍阻止删除。
- 输入与成本：最终 turns 的 UTF-8 字节包含实际来源正文，不能只量历史；工作预算不冒充物理模型窗口，Provider token/作用域预算仍有效。质量、命中率/缓存收益、真实 Provider、浏览器、Windows、安装态另验，Fake 仅证明输入/状态/计量工程链。

## 日常工具执行分层回归（2026-10-20）

规格依据：[运行架构 §2.10](../architecture/runtime-context.md#210-日常工具工作与正式交付分层2026-10-20-实施)。结果只归统一验收表。

- ASK 不暴露无法在会话接续的写工具；AUTO/FULL 的实际工具可见性与模板一致，停用连接不再宣称可写。
- 明确 MODIFY 的方法可真实写盘且零 Task/Run；INSPECT 即使 FULL 也只读；基线冲突保持原文件。
- 直写后只提交剩余检查；检查候选不得再次写入原修改。AUTO 删除在创建 Operation 前转交可恢复审批路径。
- BROWSER/COMPUTER 意图经候选解析、原请求、Delegate 到冻结 Run 工具集；无 root_path 的工具连接可用，不隐式增加范围授权，未知 interaction 拒绝。
- 缺操作连接在创建 Task 前拒绝；重复推进与已有活动 Run 的冲突语义保持。
- Fake/脚本化端口加真实 PG 只证明工程接线与落盘。真实 Provider、真实浏览器/电脑操作、Windows 窗口与审批往返须另验，不由上述测试代替。

## 会话执行的服务端推进与失败恢复（2026-10-20 第二轮）

规格依据：[运行架构 §2.10.1](../architecture/runtime-context.md#2101-推进-owner-收归服务端与能力事实说明2026-10-20-第二轮)、[工作台 §43.1](../frontend/workbench-design.md#431-就绪候选由服务端推进界面只呈现阶段2026-10-20-第二轮已实施实机未验)、[HTTP §10.107.1](../api/http-command-contract.md#101071-服务端自动推进与失败原因投影2026-10-20-第二轮源码实现)。结果只归统一验收表。

后端（真实 PG，`conversation-execution-autostart.integration.test.ts`）：

- 只有 Worker tick、没有任何前端请求时，READY 候选推进到 `DELEGATED`，恰好一个 Task 与一个 Run。
- 重复扫描与人工重复提交同一 `request_id` 只重放原回执，Task/Run 计数不变。
- 推进失败：`status=FAILED`、`clarification.questions[0]` 是**可执行的**具体原因（含能力名，不含「验收标准/任务目标」），候选与阶段命令身份保留，零 Task/Run。
- 已知失败不自动重试（第二轮 tick 为空）；补齐前置条件后沿同一 `request_id` 接续成功，且仍只有一套 Task/Run。

前端（jsdom）：

- `executionSummary`：READY/TASK_PREPARED/DELEGATED 无任何开始按钮；FAILED 呈现服务端原因并提供「继续原请求」；界面文本不出现 `task_id`/`run_id`。
- `folderFirstConversation`：候选就绪时本页**不发** `applications`；失败后点「继续原请求」才发一次，成功后进入执行详情。
- `settingsView`：执行策略面板不再有「计划执行方式」控件；遗留本地键不被读取。

提示词：

- `assist-capability-notice` 单测锁「原因指向真因」：无目录、只读档位、缺连接三类分别措辞；只读档位下的写缺口不进「缺连接」清单；事实块固定声明不是指令、也不构成授权。

不覆盖：真实 Provider 的选择质量与措辞、真实浏览器/电脑操作、Windows/WebView2 窗口、安装态。无目录操作会话与「普通检查不进入正式验收」本轮未实现，不在本规格范围内。

## 41. 聊天目标与计划模式验收规格

2026-10-20 确认设计；2026-10-21 实施后端、会话 UI 与恢复链（实施者自检）。依据：[总纲 §0.15](../../Personal_Workflow_OS_Master_Spec.md#015-聊天目标与计划模式)、[工作台 §44](../frontend/workbench-design.md#44-聊天目标与计划模式)、[运行架构 §9](../architecture/runtime-context.md#9-聊天目标与计划模式的运行边界)。下表场景仍是验收规格；本节末记录已实现的自动化覆盖与未验边界。

| 场景 | 必须验证的结果 |
|---|---|
| 命令与模式 | 菜单仅预填，发送后切换；自然语言和选择器一致；新会话普通模式，旧会话恢复保存状态；不自动创建领域 Goal |
| 只读规划 | `/plan` 可调查、读文件、只读验证；实际写工具准入被拒绝，写入试验需明确授权；计划含范围、步骤、验证和待定项，有版本且可继续修改 |
| 计划转执行 | 「按此计划执行」绑定所选版本并沿用需求；旧版/冲突核对，不静默替换版本或增加权限 |
| 持续目标 | 多轮实施、验证、修正持续推进；不因一轮结束或额外总时长/轮次/调用上限停止；关键歧义、真实阻塞和连续无进展可解释地等待 |
| 权限与调整 | 已授权操作无需逐步确认；扩大范围、改变目标、增加权限需用户决定；修改方法不绕过冻结契约，步骤调整原因及剩余工作可见 |
| 完成判断 | 逐项依据真实证据核对成功条件；缺证据、步骤全勾选、代码写完或模型自报不能算完成；需要人工验收的结果保持等待 |
| 后台与恢复 | 关闭页面后服务端继续；服务重启先核对现场；重复恢复/并发继续只有一条有效推进链；旧 Worker、迟到结果及 UNKNOWN 不导致重复副作用 |
| 额度耗尽 | 可控额度故障保存原目标和进度；额度恢复不自动执行，点击继续沿原身份接续；仍不可用时显示原因且不循环；未知额度不编造数值或恢复时间 |
| 插话与控制 | 进度询问不取消业务目标，补充要求融入后续；工具派发边界收到插话先停止未执行批次，由模型重新判断；冲突暂停受影响行动并澄清；暂停/取消/转计划先处理在途动作，取消不伪称回滚 |
| 卡片与恢复 | 计划卡可修改及执行；固定目标卡有状态、步骤、进展、控制和错误原因；恢复会话不丢卡；完成、待验收、阻塞及额度耗尽可区分 |

按影响分别补领域/工具准入检查、真实 PG/HTTP 的幂等与故障恢复、浏览器交互、真实 Provider、Windows/WebView2 与安装态证据；一种证据不替代另一种。额度耗尽可用故障注入验证恢复协议，不宣称因此证明真实服务商额度检测；实际成绩仅维护统一功能验收表。

### 已实现的自动化覆盖（2026-10-21，实施者自检）

`apps/api/test/integration/chat-plan-goal.integration.test.ts`（真实临时 PG 18.6 + 真实 HTTP API 进程）覆盖：

- **命令与模式**：`/plan 内容`、`/goal 内容` 发送后在同命令内切换并受理（应用层剥离前缀并与 `chat_mode` 核对一致性）；计划模式拒绝提案意图与 MODIFY 方法；新会话缺省 CHAT、消息带 `chat_mode` 受理；`chat_mode` 经会话 DTO 与 202 回执投影（HTTP 面断言，防 DTO 漏字段）。
- **只读规划**：PLAN 轮次**不声明写工具**，模型请求写操作被 Gateway 准入拒掉且工具账本留下类型化拒绝，本轮照常产出计划；计划信封结算后正文只落 `reply`，版本行按「会话 × 版本号」与「会话 × 源消息」两个唯一键落库。
- **计划转执行**：一份计划两次修改产生 v1/v2 且旧版标 SUPERSEDED；`startGoalFromPlan` 绑定确切 plan_id，已被取代版本默认拒绝、`allow_superseded` 显式放行；目标按该版本冻结条件。
- **持续目标**：目标模式消息建立目标并绑定轮次；Worker tick 结算上一轮结论并按同一目标接续下一轮（多轮推进，不以单轮限额结束）；成功条件缺证据保持 CONTINUE，报告 COMPLETE 只进 `AWAITING_ACCEPTANCE`，人工 `complete` 才 COMPLETED。
- **后台与恢复**：推进只发生在 Worker tick（`runAssistGoalTick`），页面请求不参与；轮次结算按消息唯一键幂等；重复 tick/重复 continue 不产生第二条链；`PAUSING`/`CANCELLING` 先在途安全停下才归一（在途轮次先结算，控制意图优先）。
- **额度耗尽**：预算闸门对 `BUDGET_EXHAUSTED` 目标按 `assist_goal_budget_grants` 授予量放大上限；`resume` 用尽后仍耗尽时保留现场，grant 按可核对事实（失败轮次冻结的模型快照 → 进程配置 → 最小窗口）计算并落账本。
- **领取顺序回归**：`claimNextPendingMessage` 按 `session_id, created_at, id` 排序且一次一条，「发一条再跑一次 tick」不保证轮到它——测试统一显式轮到目标消息，防止再把调度事实当成落库缺陷。

`apps/workbench/tests/chatPlanGoal.spec.ts`（jsdom）**11/11** 覆盖：模式命令解析（`/plan 内容`、`/goal 内容`、别名、正文中的 `/plan` 不误判）、`ChatModeSwitch` 受控值与禁用态、`ChatModeHint` 仅在非普通模式出现且安全停止时说明停止、`PlanCard` 版本标记与执行按钮、`GoalCard` 按服务端 `actions` 渲染控制与 `stop_reason`/`round_count` 事实字段。

未验边界：浏览器实际操作、真实 Provider 意图理解与额度识别、Windows/WebView2 实窗与安装态、独立验收。Fake/受控模型只证明协议、边界与恢复接线。

### 连续插话的定向回归规格（2026-10-20）

规则归[运行架构 §2.9](../architecture/runtime-context.md#29-排队消息的插话进入上下文的方式2026-10-19已实施)。自动化覆盖：多条插话按 seq 保留原文且只结算同一轮；请求期间新输入阻止旧工具入账/Gateway；批次中途到达保留首个真实文件读取结果、剩余工具回报未执行且不落 Operation；收尾轮不消费迟到插话；旧插话在其引发的工具之前、新插话在结果之后，tool-call/result 配对完整；**消费插话后模型失败与消费后取消各自收口且不复活占位行，恢复轮上下文仍能读到原要求与插话原文；Worker 崩溃经 `failExpiredLeases` 收口 `LEASE_LOST`，迟到结算被 CAS 拒绝，恢复轮同样读到原文；预算耗尽以 `MODEL_BUDGET_EXHAUSTED` 类型化失败且原文保留**。回归普通主链、会话直写、只读人设与提示词装配。

真实 Provider 检查（`steer-provider.integration.test.ts`，默认跳过）：显式 `RELAY_STEER_PROVIDER_CHECK=1` 且 Provider 配置可用时运行六场景（相关补充、局部修正、改变阶段、明确替换目标、临时提问、关系不清）。硬断言与模型无关：插话原文进入后续请求、被停止工具零账本/Gateway/磁盘改动（场景 C 在 FULL 档位验「先别改，只给方案」后磁盘逐字节不变）、排队行收口；回答措辞与语义选择只记录供人工复核，不作硬断言。Fake/受控端口只证明输入、顺序、规则接线与执行边界；不能凭 Fake 的预设回答宣称意图识别质量通过。未覆盖的重启恢复窗口单独报告。

Fake/受控端口只证明输入、顺序、规则接线与执行边界。真实 Provider 需另测相关补充、局部修正、先方案不修改、明确替换目标、临时提问、歧义澄清，以及跨多次请求连续变更；核对实际工具副作用与回答，不能凭 Fake 的预设回答宣称意图识别质量通过。未覆盖的重启恢复窗口单独报告。

## 42. 长期项目协作差异化体验的目标验收

2026-10-22。本节是新增目标场景，**尚未运行，不是验收结果**；原模块既有成绩不变。依据：[总纲 §0.17](../../Personal_Workflow_OS_Master_Spec.md#017-长期项目协作的差异化体验)、[后续路线 §14](../requirements/post-v1-roadmap.md#14-差异化体验的范围与推荐顺序)、[工作台 §45](../frontend/workbench-design.md#45-长期项目协作的差异化体验)。

| 编号 | 场景与预期 |
|---|---|
| DX-01 | 登录方式及被测版本变化后，旧测试只作为原版本证据；指出明确受影响条件，推断与未核对分开，无关联不报全量无影响，不自动撤销历史 PASS 或重开任务。2026-10-24 补充未运行目标：连续修改归并、关键节点集中提醒，影响在途验收立即提示；已有读取权限内先核对并准备方案，开始补验不隐含修复授权。明确修复范围后最多自动修复 3 轮，重复失败或无法验证提前停，不因重试/换会话重置；保留成果及剩余项。对应当前基线检查全部通过才自动标已复验并收起，人工待验、未核对、未运行与环境缺口不误关；验证途中或之后基线变化，旧结果不关闭新提醒，变化及验证记录可追溯 |
| DX-02 | 接手演练冻结相同资料基线，以无原会话隐含上下文的新会话检查下一步、决定、验证和恢复依据；预置缺口可被识别，回答有确切引用；无权、冲突、未找到和读取失败分开。2026-10-24 补充未运行目标：默认仅当前工作主线，主线不明确先澄清，局部结论不冒充全项目可接手；只读阶段无项目写入、启动命令、测试运行或执行权转移。缺口按当前接手影响排序，有依据才准备草案，缺失事实及冲突不猜填；明确补齐指令后复核版本和权限、沿原 Owner 仅写入确认范围的资料，不顺带修代码，不建重复事实源；补齐写入成功不自动算演练通过。补齐后在更新资料基线上自动复查一次，新 Agent 不携带上轮答案或隐含上下文；事后对照消除、遗留及新增缺口，仍有问题不循环补写。失权、失败、预算不足、取消与基线漂移保留未核对范围，不伪报通过 |
| DX-03 | 明确登记的决策前提变化后生成可追溯复审候选；未登记理由不补猜，决定与依据再次变化需复核旧候选，同一变化不重复打扰，不自动废止决定 |
| DX-04 | 需求变更草案展示已登记影响、推测与未核对范围，区分在途工作；基线变化不静默应用旧草案，接受草案不扩大执行权限 |
| DX-05 | 业务验收步骤对应确切需求/产物版本、预期及证据，缺环境如实呈现；模型生成、用户勾选和自动测试不能冒充实际人工接受；正式结果走原 Owner。2026-10-24 补充未运行目标：用户明确认可当前体验版本、仍有必要检查未完成时，记录已体验部分的认可及确切范围，展示剩余检查、原因与入口；不推定未体验部分已接受，不越过必要条件宣布完成，后续版本不继承认可。范围歧义先澄清，记录失败/回执未明不显示已登记 |
| DX-06 | 待决定事项排序能回溯到依赖、截止时间或阻塞；未知不补造，同一决定多处引用只合并展示，不合并不同批准；处理后不自动恢复未经授权的任务 |
| DX-07 | 生成失败、读取不全、取消、预算耗尽、迟到结果及恢复后不伪报完整结论；按实际新增写入口验证版本、幂等与并发，关闭提醒不修改业务事实 |
| DX-08 | 2026-10-24 新增未运行目标：在 Relay 自身软件功能／需求场景中，从业务对象查看已登记关系、确切成果版本与证据缺口，沿原入口完成局部修改、检查与退回；保留原要求和检查依据，新版本不继承旧批准；来源缺失、失权、读取失败及版本变化不伪报完整关系或已验收，聊天与对象视图不维护第二套业务状态 |
| DX-09 | 未运行目标：自由试用保留必要检查与未确认提示，浏览或沉默不自动通过；反馈绑定实际体验版本，明确缺陷在原授权内返工时当前版本保持稳定，新版须由用户切换。重复补充不重复派单，迟到修复不覆盖新要求，修复提交与检查通过不冒充人工接受。2026-10-24 补充：切换新版时兼容数据优先安全沿用，保留干净环境入口；结构变化或冲突先说明影响，保存含未提交输入的当前现场，再由用户选择转换或干净环境。保存失败暂停切换，未保存内容可见，转换不可用不伪报成功，不静默清空数据；数据沿用不继承旧验收 |
| DX-10 | 未运行目标：同一流程覆盖多个功能，归属不明的反馈保留待调查；功能结果与整体流程结果分别绑定对应版本及条件，局部通过不冒充整条流程通过。主观反馈先调查并推荐改法，确认前不擅自改动；明确修改指令在原授权内不被普遍要求二次确认 |

收益验证使用任务及材料规模可比的原流程和新体验样本；先固定缺口和判定口径，避免只统计发现数量。成果失效提醒记录正确识别、漏报、误报和人工复核成本；接手演练记录关键交接遗漏及恢复耗时，并把演练准备成本计入总成本；决定复审记录过期前提被沿用的次数与误提醒成本。其他方向观察关键场景漏验、完成必要决定的耗时及无效打断。样本数、阈值和观察周期待基线后、正式比较前冻结，不以单次演示证明产品独特性或长期收益。

按实现影响分别验证领域规则、真实 PG/HTTP 的版本与恢复、真实 Provider 的识别和建议质量、浏览器交互及 Windows 窗口。受控模型仅证明协议和边界，不证明语义质量；实际验收结果仍只维护统一功能验收表。

## 43. 外部 Agent 共享任务协作的目标验收

2026-10-23。**未运行的目标规格，不是验收成绩**；依据：[总纲专题](../../Personal_Workflow_OS_Master_Spec.md#项目事项与外部-agent-共享任务协作)、[领域模型 §22](../architecture/domain-model.md#22-外部-agent-共享任务的应用边界)、[工作台 §46](../frontend/workbench-design.md#46-项目事项与外部-agent-共享任务)。具体工程协议冻结后再映射自动化用例。

| 编号 | 场景与必须满足的结果 |
|---|---|
| ES-01 | 一条需求和一条 Bug 各跑通登记、拆分、范围确认、开发领取、提交、独立验收、人工批准、集成回归及完成；多 Task 事项不能因其中一项完成而全部关闭 |
| ES-02 | 未确认范围不能领取执行；项目/角色越权、凭据撤销及开发者领取自身验收被服务端拒绝；区分不同身份与实际独立性，不能用自报角色或新建身份绕过 |
| ES-03 | 并发领取仅一个成功；指定任务和下一条符合角色的任务服从同一准入。跨 Task 同目录冲突被拒，独立 worktree 的路径与所有权可核对 |
| ES-04 | 超时、断联及服务重启后仍可恢复原身份、范围和记录；超时不自动释放资源，原执行未确认停止时新 Agent 不得接手，旧领取者迟到提交不能推进当前结果 |
| ES-05 | 提交绑定确切提交/不可变快照、条件及证据；验收期间文件或分支变化不能改变被验对象。证据缺失、未运行、工具故障不能记 PASS |
| ES-06 | 退回附失败项和证据，原开发者再次领取后返工；重复提交/回执不重复计轮。默认三轮后转人工，争议可转人工；基础设施故障与业务退回分别记录 |
| ES-07 | 需求或条件变化产生新版本并阻止受影响执行按过期范围推进；明确沿用或切换可追溯，旧 PASS/批准不自动继承；重开保留历史且不自动开始执行 |
| ES-08 | 人批准确切变更后才进入集成；目标基线漂移、合并冲突、集成失败和回归失败均不完成事项。Git 成功但回执保存失败等 UNKNOWN 先核对原效果，不盲重试；最终完成审计与必要事实一致 |
| ES-09 | API/MCP 操作同一事实源；重复请求、超时查回执、撤权与迟到结果行为一致。聊天登记、页面详情及重开读取反映同一业务状态 |
| ES-10 | 无在线领取者时队列保持等待，不伪报后台运行；外部工具退出或关闭页面后展示实际状态；取消不声称撤销已有修改，暂停/交接按在途核对结果呈现 |
| ES-11 | 新事项试运行与禅道旧事项各有唯一当前登记处，无自动迁移或双向同步；本机接口授权不被描述为限制外部进程文件权限或费用的隔离能力 |
| ES-12 | 真实不同外部 Agent 经本机接入完成开发及独立验收；浏览器与 Windows 实窗验证事项、返工、失联、版本变化、批准及失败恢复；凭据不进入正文、证据或日志 |

规则自测、真实 PG/HTTP 的事务并发与恢复、MCP 客户端接线、真实外部 Agent、浏览器及 Windows 证据分别报告。自检与独立验收分开，实际结果只维护统一功能验收表。本轮不新增通过记录，也不以文档检查证明运行闭环。

价值验证比较人工转述、分派、催进度、交接耗时及遗漏，计入接入、验收和集成成本；样本与阈值在正式比较前冻结，不能由 Agent 数量或单次演示推断收益。

## 44. 长期 Agent 团队与跨会话协作的目标验收

2026-10-23，**未运行的目标规格，不是验收结果**。依据：[总纲 §0.18](../../Personal_Workflow_OS_Master_Spec.md#018-项目级长期-agent-团队与跨会话协作)、[领域模型 §23](../architecture/domain-model.md#23-长期-agent-成员与跨会话协作的应用边界)、[工作台 §47](../frontend/workbench-design.md#47-长期-agent-团队私聊群聊与工作概览)。原 §21 临时只读委派与 §43 外部共享任务的适用约束继续验证，不把已存在的委派接线当长期团队成绩。

| 编号 | 场景与预期 |
|---|---|
| PT-01 | 按需创建项目成员、复用模板，重开或换会话后身份/职责/记录持续保留；不自动建齐角色，不跨项目泄露上下文或把只读助手变成可写成员 |
| PT-02 | 私聊、群聊和概览关联相同事项/Task/Run/产物；同一成员跨会话读取获准来源，个人推测不自动覆盖确认事实，未授权私聊/记忆不可读取 |
| PT-03 | 协调者在明确工作范围内拆分、分派、处理依赖和汇总；新增需求/扩大范围/权限/放宽验收须人工决定，私聊、群聊或投票不能绕过 |
| PT-04 | 指定成员接收群聊消息，未指定由协调者接收，按需邀请；重复消息、互相回应、无新证据时不会持续唤醒全员或形成无结束条件的讨论 |
| PT-05 | 任务完成、退回及依赖解除触发必要接续；重复事件、并发巡检与恢复不重复领取或执行。无可推进工作进入等待，不持续调用模型、造任务或重复催促 |
| PT-06 | 关闭真实 Windows 窗口后服务端仍推进获准内置工作；明确退出后本机不再发起新工作，重启核对原身份、授权、目录和外部效果后恢复，不盲重放；关机不能被描述为云端继续 |
| PT-07 | 内置/外部长期成员身份可关联真实执行；外部沿本机主动领取工作，离线保留等待，失联不自动释放目录。更换运行端不重叠取得同一执行权，不绕过 UNKNOWN 核对 |
| PT-08 | 按成员配置模型、默认继承项目设置；更换模型不更换身份或增加工具权限，配置变化的在途处理有冻结协议。模型不可用明确报告，只按用户配置使用备用模型 |
| PT-09 | 不因新增项目/成员累计费用、时长、轮数或调用配额而停止；实际消耗有来源，外部未知不造数。服务商限额/额度耗尽如实等待并保存现场，恢复核对后接续 |
| PT-10 | 额度不上限仍服从用户暂停、权限失效、范围变化、真实阻塞、原默认三轮返工转人工、临时子委派槽位及单动作重试边界，不能换身份绕过 |
| PT-11 | 决定、风险、阻塞及成果需批准时通知；相同事实不重复打扰，普通交流可展开追溯。已读/关闭提醒不修改 Task、Review 或执行权 |
| PT-12 | 一项真实小功能跨需求讨论、设计交接、开发、独立验收、人工批准及集成回归，覆盖不同会话、窗口关闭和重启接续；版本变化、验收失败、集成失败和缺证据不能伪报完成 |

领域、真实 PG/HTTP 的版本/幂等/并发与恢复、受控唤醒及时钟、真实 Provider、真实外部客户端、浏览器与 Windows 证据分开。没有系统服务或云运行证据不作相应承诺；模型文字自报不算成功。实际成绩只写统一验收表，自检与独立验收分开，本轮不新增通过项。

首个真实小功能仅为推荐验收场景，具体项目/条件/基准及环境实施前选定。协调成本、重复交流、交接遗漏、跨会话恢复耗时、无效唤醒与总消耗共同观察，样本和收益阈值在正式对比前冻结。


## 45. 右侧工具面板与内置网页预览的目标验收

2026-10-24，**规格不变；实现已落地，其中 TP-01/02/03/05 的纯状态部分已有自动用例，TP-04/06/07/08 的真实 Windows 与打包态部分仍未运行**。交互归[工作台 §50](../frontend/workbench-design.md#50-右侧工具面板与内置网页预览)，分包归[路线 §17](../requirements/post-v1-roadmap.md#17-右侧工具面板与内置网页预览)，隔离门槛归[浏览器架构 §15](../architecture/browser-automation-v1.md#15-右侧内置网页预览的规划边界)，选型归 [ADR-035](../decisions/ADR-035-in-app-webview-preview.md)。实际成绩只写统一验收表，不复制回本规格。

| 编号 | 场景与必须观察的结果 | 必要证据 |
|---|---|---|
| TP-01 | 同一右栏切换工具/工作详情；收起、拖宽、窄窗和键盘返回保留对话及既有控制；无 Task 会话能打开网页 | 组件/真实浏览器布局＋Windows 原生观察 |
| TP-02 | 原文件/产物确切版本、Git 状态/diff、运行/轨迹及执行输出保留；未接入终端仍不提供提示符 | 定向组件及原入口回归 |
| TP-03 | 多标签独立前进/后退/刷新/停止/关闭，重定向显示实际 URL；旧事件不能覆盖新标签/导航 | 可控导航与 Windows 真网页 |
| TP-04 | 服务未启动、断网、证书失败、进程异常均有明确状态与重试；打开 URL 不启动 Shell/服务 | 故障注入＋真实 Windows |
| TP-05 | 会话/项目切换、隐藏、返回及重启不串页；不自动加载恢复地址，不自动重放表单，不持久化 query/fragment/凭据 | 存储断言＋Windows 重启检查 |
| TP-06 | 恶意页面/iframe/重定向/弹窗无法调用工作台 IPC、读 token 或共享工作台存储；权限不因同窗口继承；私有 API 与 bootstrap 导航被拒 | 打包态攻击夹具＋Windows 隔离验证，P0 硬门槛 |
| TP-07 | 下载、原生权限、文件选择、弹窗、外部协议与证书错误符合冻结策略；无静默授权/下载 | Windows 真交互；不支持时明确外部打开 |
| TP-08 | 拖动、缩放、最大化、滚动、切页和业务对话框不被子 WebView 遮挡；关闭/退出清理实例 | 真实 Windows 开发态及安装包 |
| TP-09 | 首版模型不能读取/操作内置页面；面板关闭不取消 Run；网页查看不产生 PASS、批准或 Task 完成；Chrome 扩展路径保持 | 相关权限/领域回归＋现有扩展链验证 |

先完成 P0 隔离与布局实证，再启动 P2；不能用 jsdom、浏览器截图或 Tauri 编译成功替代原生出口。自检、独立验收、真实 Windows 与安装验证分别记录，实际结果仅更新统一功能验收表。收益比较按路线 §17 先冻结基线，本轮不填数值或通过项。

## 46. 正式目标管理与项目状态写入的验收映射（2026-10-24）

| 编号 | 场景 | 验证方式 |
|---|---|---|
| GM-01 | 创建 Goal 后列表按 Active/Archived/All 读取，续页去重、末页收口、暂态失败保游标、401/403/404 撤数据 | 组件级 `goalManagementLive.spec.tsx`＋真实 PG `api-lists`／`project-goal-maintenance` |
| GM-02 | 编辑 Goal 按 revision CAS；响应错配不清 pending、不宣布成功；归档后停止编辑与新增关联 | `goalManagementLive`＋真实 PG `project-goal-maintenance` |
| GM-03 | 解除关联先展示受影响 Task 清单；清单变化返回 `GOAL_LINK_IN_USE` 并要求再次确认；命令冻结 | `goalManagementLive`＋真实 PG `project-goal-maintenance` |
| GM-04 | Project 改名只改标题与 revision，回执绑定原命令 | `projectManagementPanels.spec.tsx`＋真实 PG `project-goal-maintenance` |
| GM-05 | Project State 阶段限词、下一步只引用本项目 Task、风险/阻塞/解除走单一 action 与 CAS；`ADD_BLOCKER` 可经 HTTP 提交 | `projectManagementPanels.spec.tsx`＋真实 PG `api-state`（schema 回归先红后绿） |
| GM-06 | Goal 与目录工作上下文只读、会话保留原 ID、目录精确过滤、归档/停用按事实呈现 | `goalManagementLive.spec.tsx`＋真实 PG `work-contexts` |
| GM-07 | Goal 关联需求与前端入口不被误当成聊天 `/goal`；不创建 Project/Task/Run/Session | 组件级请求断言与真实 PG 回执 |

未覆盖：真实 Windows/WebView2、390px 与多 DPI 人工走查、真实浏览器导航、独立验收；全量工作台套件未跑。
