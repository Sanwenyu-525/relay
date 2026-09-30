# 功能验收汇总与历史记录

更新：2026-09-30。角色：唯一功能验收结果汇总。阶段与模块进度归 [CODEX_NEXT_STEP](../../CODEX_NEXT_STEP.md)，验收规格归[测试计划](verification-plan.md)。各行通过结论仅覆盖注明的运行时点、环境和版本；下午视觉的最后增量与重打包证据已同步，其他历史成绩没有因此重新验收。

## 当前功能验收表

状态：**已通过**表示所列范围有实际通过记录；**部分通过**表示分片通过但完整出口未闭合；**未通过**表示受验基准仍有失败；**未验收**表示缺相应环境或完整验证；**未接入**表示所需入口/协议尚未实现。历史失败修复后保留历史，不把旧红灯当作当前已复现缺陷。

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| 人工项目/任务/产物/完成与重开 | 已通过（基础链） | 2026-09-28 真实 API＋隔离 PG＋浏览器闭环，见[实施记录](../development/ui-live-integration-2026-09-28.md#4-真实业务闭环与逐页核查) | 最新源码与 Windows 全路径不自动继承 |
| Mock Delegate→Review→完成/重启恢复 | 已通过（基础链） | 2026-09-25 冻结 Windows 试用包，见[M03](m03-independent-acceptance.md) | 附加动作配置由测试 HTTP 完成，配置 UI 不包含在此结论 |
| Mock 完整并发、取消、UNKNOWN 可靠性 | 部分通过 | 多个 PG/组件/Windows 反例分片有记录，见[M03](m03-independent-acceptance.md) | G01–G08 完整总出口未闭合 |
| 模型连接验证与配置保留 | 已通过（定向） | 2026-09-29 固定探针真实外呼、账本、重启配置保留，见[历史实跑](#61-本轮实跑) | 不等于全部模型业务可用 |
| 真实 DRAFT、HARD SEMANTIC、取消/abort | 已通过（定向） | 2026-09-29 隔离真实 Provider 用例 4/4，见[进度历史](../development/codex-next-step-history-20260930.md)及[语义修复](#62-本轮发现并修复的缺陷) | 完整协作 UI→真实 Run→Review→完成全链未验收 |
| Provider 六类错误的真实故障矩阵 | 未验收（真实环境） | Fake 连接验证 8/8，Assist/Trace 分类有 PG 与组件反例，见[诊断记录](../development/ui-live-integration-2026-09-28.md#14-m04-run-模型调用诊断与本地错误归因2026-09-30) | 真实 401/429/超时/断流等故障取证 |
| Assist/Run 调用诊断与取消归因 | 已通过（增量） | 2026-09-30 API 144/144、受影响 PG/HTTP 65/65，见[最终诊断记录](../development/ui-live-integration-2026-09-28.md#14-m04-run-模型调用诊断与本地错误归因2026-09-30) | M04 总验收及真实故障上浮全链 |
| Agent 聊天发送、导航保护与 Mock 回复 | 已通过（开发版基础链） | 2026-09-29 WebView2＋隔离 PG＋Mock，见[聊天验收](../development/ui-live-integration-2026-09-28.md#11-独立-agent-聊天验收2026-09-29) | 最新协作改版与真实 Provider/安装包另验 |
| 最新协作页视觉与 Review 状态/草稿 | 部分通过 | 2026-09-30 三尺寸浏览器、组件反例及前端 407/407，见[Review 修复](../development/ui-live-integration-2026-09-28.md#13-协作页参考图接续与-review-修复2026-09-30) | 真实 API 判断提交、最新 Windows/IME/DPI |
| 全页面视觉/故障状态覆盖 | 部分通过 | 2026-09-30 只读夹具截图、最近全量 412/412，其后 16/16、45/45、29/29 定向，见[纠偏记录](../development/ui-live-integration-2026-09-28.md#16-整套页面视觉纠偏与发布输入冻结2026-09-30)；旧 33 状态矩阵 31/2 见[实跑](#61-本轮实跑) | 最新特殊状态视觉矩阵、真实 Windows/IME/DPI、Provider/PG 全链未重跑 |
| 目录测试包的输入/资源完整性 | 已通过（记录时点静态范围） | 2026-09-30 389 个源码输入、17177 个资源哈希、字体许可及零链接检查通过，见[纠偏记录](../development/ui-live-integration-2026-09-28.md#16-整套页面视觉纠偏与发布输入冻结2026-09-30) | 后续源码变更须重新生成清单/校验；安装与真实窗口另验 |
| Today/三套工作台/知识/Trace/Lineage | 已实现待总验收 | 页面交互与分片测试已有记录，见[范围历史](../development/codex-next-step-history-20260930.md) | M05 完整真实业务与桌面验收 |
| 项目归档与关联写入栅栏 | 已实现待总验收 | 后端命令、live 入口与主要写入口已有开发自检，见[范围历史](../development/codex-next-step-history-20260930.md) | 完整集成与独立验收 |
| 文件/Git/CLI 与 UNKNOWN/PARTIAL 人工处置 | 部分通过 | PG/HTTP、隔离 Windows Job 和无回执恢复分片，见[M06](m06-independent-acceptance.md) | 确切包、人工交互与 M06 总出口 |
| Git 状态/diff 的协作 UI | 未接入 | Adapter 已存在，但缺 HTTP/UI 协议，见[协作规格](verification-plan.md#16-agent-协作主线验收提案) | 接入协议与真实改动归属验证 |
| 交互终端 / PDF 导入 | 未接入 | 当前只提供执行输出读取；两项未交付，见[当前入口](../../CODEX_NEXT_STEP.md) | 不以输出面板或其他格式导入代替 |
| 菜单 6 桌面开发启动 | 已通过（启动范围） | 2026-09-30 真实窗口、bootstrap/readiness、重复启动/并发 Stop，见[启动修复](../development/ui-live-integration-2026-09-28.md#15-菜单-6-桌面开发启动修复2026-09-30) | 未重打包、未刷新 API、未覆盖菜单 1–5 或完整业务 |
| Windows DPI/IME 与最新 UI | 部分通过 | M02 基础窗口有 IME/DPI 证据；2026-09-29 当时 UI 的 125% 取证通过，见[M02](m02-independent-acceptance.md)和[实跑](#61-本轮实跑) | 最新改版未完整验；本轮 150% 矩阵未完成 |
| 冷启动/反馈与首输出延迟 | 部分通过 | 2026-09-29 浏览器性能采样有记录，见[实跑](#61-本轮实跑) | 完整真实模型首输出、开发启动等待与代表性负载 |
| Windows 安装/升级/卸载/备份恢复及 V1 总交付 | 未验收 | 发布诊断有实现/自检，见[M07](m07-independent-acceptance.md) | 安装与备份恢复总矩阵；整体仍不通过 |

本表没有用不同轮次成绩拼成“当前全量通过”。2026-09-30 当时源码 PG 全量 491 通过/0 失败/5 跳过与后续受影响 65/65 分别保留原范围；后续视觉以最近全量及其后受影响定向、最终包静态证据分别记载。最后辅助页与面包屑补修的反例和复验见纠偏记录；“未验收/未接入”不自动等于运行失败。

## 原始输出归档

完整历史 stdout/stderr、逐进程 JSONL 和批量源码摘要已集中到[原始输出压缩包](evidence/raw-output-20260930.zip)：386 个证据条目（原历史 379 个，末轮 UI/发布补充 7 个），压缩包内 `_archive-index.json` 保存原路径和 SHA-256，本次逐项解压读取核对通过。`#entry=...` 链接指定 ZIP 内原条目；按需解压再复查，不作为默认 AI 上下文。原文件移至忽略的本机目录 `output/acceptance-raw/history-20260930/`，Git 删除项用于停止原始条目的版本保留，必要概要/截图/复跑脚本继续保留。后续输出遵循[保留规则](../README.md#6-验收结果与原始输出保留)。

## 历史验收记录

以下保留 2026-09-28/29 原始结论、失败与修复时点，不作为另一份当前状态表。

原记录：整体可用性验收（2026-09-28）

接续：用户报告整改完成后，本记录追加第 4 节独立复验；下方第 1–3 节保留首轮证据，不用新成绩覆盖历史失败。

范围：当前工作树的代码、实际浏览器页面、自动化回归与既有桌面证据。结论：**整体暂不通过**。人工基础闭环可运行，但不能作为真实模型可用、完整 UI 或 Windows 安装交付已完成的证明。

基准：HEAD `39edb226b418da139fdf9757a8963591dfe59ca6` 加现有未提交修改；本轮没有修改产品代码或用户配置。工作树存在其他开发改动，证据绑定本轮读取/运行时点，不自动覆盖后续修改。进度仍由 [CODEX_NEXT_STEP](../../CODEX_NEXT_STEP.md) 维护。

## 1. 实际验证

| 层次 | 本轮结果 | 证据与限制 |
|---|---|---|
| Workbench 单元/组件 | 56 文件，336/336 通过 | `evidence/overall-acceptance-2026-09-28/workbench-tests.log` |
| API 单元 | 130/130 通过 | `api-unit.log`，无真实 Provider 外呼 |
| 类型/构建 | Workbench tsc 通过，API 集成包装器 tsc 成功；Vite 生产构建通过 | `workbench-typecheck.log`、`api-integration.log`、`workbench-build.log`；前端输出到 output/overall-audit-build，未替换桌面包 |
| PostgreSQL 全量 | **461 项：449 通过、9 失败、3 跳过**，退出码 1 | 隔离临时 PG18，42 条迁移；耗时约 962 秒，PG 正常停止且临时目录删除 |
| 真实 API 人工闭环 | 1/1 通过 | `real-api-browser.log`；创建项目/任务→开始→保存版本→选用→完成→重开→刷新历史；临时 PG 停止且目录清理 |
| 实际页面 | 10 个 live 页面/状态只读检查，无 pageerror、无横向根溢出、无 action-error | [页面记录](evidence/overall-acceptance-2026-09-28/live-pages.json)，1280×800；另任务列表 960×640 截图。没有覆盖全部 33 页面/状态的业务交互 |
| 模型 | 现场 API 配置为真实 Provider，调用能力未验 | 设置显示 agnes-3.0-flash；只读状态不代表认证、协议、Worker 或生成成功。本轮未外发项目内容，未读取/输出密钥值 |
| Windows/安装 | 本轮未重建并复验确切 EXE、DPI、安装升级 | 历史桌面证据保持原边界，不能代替当前工作树验收 |

所有日志位于 `docs/testing/evidence/overall-acceptance-2026-09-28/`；日志可能被 Git 忽略，交接时须保留本地文件。页面记录只保存页面可见文字，不保存请求头或配置密钥。复跑脚本 `live-audit.mjs` 从本机配置在内存中完成认证，只做页面读取。

9 项失败分组：迁移基线 4、Skill 蓝图 3、控制顺序 1、网页导入 1。后面三组定向分别 5/5、1/1、1/1 通过，不覆盖全量失败。至少一个跳过项是 Windows helper 强杀无回执处置，不能将跳过视为通过。文档检查通过（98 Markdown、1773 链接、126 token、29 对比度检查）；关键源码 SHA 保存在 `source-hashes.json`，收尾核对未变化。

## 2. 按优先级的问题

### A01 / P1：模型“已配置”与“可用”没有闭环

**已确认产品缺口，调用失败根因尚待实测。** `apps/api/src/api/model-api.ts` 仅调用 `describeModelPortStatus(process.env)`；该函数只检查配置格式。`SettingsView.tsx` 展示模型名和端点，没有配置、验证连接、最近调用结果、Worker 实际配置一致性或修复入口。现场已有真实 Provider 配置，所以不能继续把“没有填模型”当成当前唯一原因，也不能说适配器完全不存在。

后端已有 `OpenAiCompatibleModelPort`，走流式输出，部分 Assist/语义验收要求 JSON 输出。真实端点是否兼容、授权是否有效、Worker 是否消费同一配置及调用是否落库，均未由只读页面证明。UI/API 已连接、模型已配置、模型调用成功必须分别呈现。

验收：在明确允许真实调用的阶段，使用不含项目资料的固定短文本验证端点，再核对 Assist 与 Delegate 的真实请求、流、终态和用量；401/403、429、超时、取消、断流、协议不兼容都有可理解反馈，不能回退 Mock 冒充成功。

### A02 / P1：测试版配置保存路径不完整

**代码确认。** `scripts/test-desktop.ps1` 的 Start 路径无条件 `WriteAllText` 重写 `.relay-test/desktop.env`，仅保留数据库和工作空间字段。若用户把模型参数加在该文件，下次 Start 会覆盖；`apps/api/.env` 又是另一条开发路径，不能假设桌面会加载它。宿主 `lib.rs` 从自己的 config path 启动 API，模型配置也可能从父进程继承，因此不能断言所有桌面实例必然是 Mock。

验收：明确开发/桌面配置 Owner 与来源；保存模型配置后 Start、Stop、重新 Build/Start 仍保留，API 与 Worker 指纹一致；密钥不出现在页面、日志、URL、截图和仓库中。不把运行态数据库字段与用户配置混写覆盖。

### A03 / P1：全量数据库回归出现红灯

**已复现。** `apps/api/test/integration/cli.integration.test.ts` 的 `migrate entry reports the applied migrations without repeating them` 仍要求迁移列表截止 0032，`ledger_rows === 32`；`migration.integration.test.ts` 的 ALL_MIGRATIONS 截止 0039，导致首次应用、advisory lock 和并发迁移三项失败。本轮真实库已应用 0042，共 42 条。不是据此认定迁移本身坏了，而是测试基线落后，当前不能宣称全量回归通过。

验收：核对新增迁移、账本、SHA 与幂等后修正有效预期，不删除断言；定向和全量复跑。不得将“退出 0”代替账本完整性检查。

### A04 / P1：页面仍把工程信息当成用户主流程

**现场可见。** 新建项目页完整截图高度 **4039px**（1280px 宽），创建表单下方直接铺开多版本 Pack、历史状态和长摘要；设置页同样大量铺开清单。项目列表把 UUID、`下一步 Task ID` 和“列表未单读 Task”等实现解释直接展示；这不是长期项目用户需要首先处理的信息。

验收：主区以项目名、目标、下一步标题和主要动作组织；版本/hash/历史组合折叠至“来源与技术详情”，保留可追溯性。新建项目默认只呈现当前创建所需内容，不用隐藏真实风险或删功能换取简洁。

### A05 / P1：响应式与视觉层级尚未逐页收敛

**现场可见。** 960×640 任务页第一条数据约从 y=557 开始，上半屏被标题、说明、筛选占据；搜索控件有重复边框感。1280×800 知识空态中“新建”按钮两字上下换行，列表标题又保留 `Knowledge 资料`；知识/待审仍使用明显偏大的标题，而今日已采用紧凑标题。页面可打开并不等于版式验收通过。

证据：[知识页面](evidence/overall-acceptance-2026-09-28/knowledge.png)、[创建项目](evidence/overall-acceptance-2026-09-28/projects-view-create.png)、[任务窄窗](evidence/ui-live-integration-2026-09-28/page-prompts/audit-tasks-viewport.png)。

验收：按已有 33 页面/状态映射逐页登记，覆盖有数据、空态、失败、等待人工、窄窗；共享标题/控件/筛选/阅读区保持一致；1280×800、960×640 与真实 Windows 125%/150% DPI 都留证据。沿用既有视觉方向与 token，不额外发动整体换风格。

### A06 / P2：若干入口仍没有承诺的操作能力

**代码确认，需逐项判断 V1 必需性。** `ProjectSkillView` 仍注明确认人/确认时间等待接口；`ConnectionsView` 的只读健康核对只刷新配置，不探测实际目录/主机可达性；Activity 的执行方筛选只覆盖已加载页。设置页仍说人工介入提醒“策略与调度尚未冻结”，与同日已确认规则和通知实现记录存在表述漂移。

验收：对照 V1 范围建立“入口→命令/查询→失败出口”清单。需要的功能补闭环；未承诺项明确边界，不为了消灭“暂不可用”而扩展深色主题、多语言或通用设置系统。通知策略已确认与偏好写接口未实现应分别描述。

### A07 / P2：构建有性能风险信号，未测量用户等待

**构建实测。** 主 JS 约 1094.56 kB，gzip 298.71 kB；所有主要页面由 router 静态导入；构建另报 Tauri window 同时静态/动态导入，动态导入不能拆分。不能仅凭大小断言卡顿，但需要测冷启动、路由切换、首反馈与模型首字延迟后再定向处理。

### A08 / P1：阶段证据和现场配置不一致，总交付证据不足

**文档与现场确认。** 当前主文档仍保留真实 Provider 关闭的门槛说明，现场 API 已配置真实 Provider；需要核实是否有后续用户授权和对应证据，不能自行关闭或改写用户配置。M03 总门槛、M04/M05 独立验收、M06 总出口与 M07 安装升级不能从组件绿灯推导通过。

验收：把历史通过、当前源码、当前 EXE 和当前配置各自绑定；补齐缺口后更新唯一阶段入口，不堆叠互相冲突的“当前接续”结论。

### A09 / P1：控制优先级回归在全量环境下失败

全量 PG 的 `M03 pending PAUSE, CANCEL and HANDOFF outrank an approved successor at the old START safe point` 失败；同一构建在隔离 PG 按 `run-command-order` 定向复跑通过。不能用单次转绿抹掉全量红灯，也不能据此认定生产暂停/取消必然失败。需核对完整失败堆栈、LOST 分支的停止证明与 requeue 顺序，区分测试编排缺陷和生产竞争；保留两份日志，并用可控 barrier 复现后验收。

最终失败点是 `HANDOFF: requeued delivery must claim the CONTROL_PENDING command`，并非最前面的 `CONTROL_PENDING` 优先级断言；整改应先检查 LOST 后重投递的测试编排，不把失败标题直接当作生产根因。

证据：`api-integration.log` 与 `control-order-recheck.log`。初次定向调用误选 `run-dispatch` 文件，没有产出目标用例成绩，已停止该次自建测试进程；包装器确认 PG 停止且临时目录删除。`control-priority-recheck.log` 的中止失败不算产品缺陷，也不算此用例的复验成绩。正确文件的定向运行 1/1 通过并正常清理。

### A10 / P1：Skill 蓝图用例在全量环境下失败，独立文件转绿

全量中“归档显式来源使蓝图失效”“Skill 冻结来源并应用同一候选”“基线变化与取消不生成候选”三项失败。`project-blueprint` 文件在另一隔离 PG 中 5/5 通过，不能直接认定三个产品功能均损坏，也不能抹掉全量失败。应检查共用数据库的待处理 Assist 消息、Worker 领取对象、前序测试清理及失败传播，使用请求 message ID 校验正确消费；根因待最终堆栈与确定性复现。

最终堆栈分别显示：来源预览 `stale` 为 undefined 而非 true、生成 tick 为 FAILED 而非 COMPLETED、tick 的 message ID 与当前请求不符。最后一个反例支持优先调查全局领取与共享数据，但仍不足以单独确认根因。证据：`api-integration.log`、`blueprint-recheck.log`。

### A11 / P1：网页导入全量计数受额外失败任务影响

`an AUTO web import lands the fetched page in Knowledge with provenance` 全量失败，tick 的 `[prepared, dispatched, succeeded, failed]` 实际为 `[1,1,1,1]`，预期 `[1,1,1,0]`。在隔离库定向 1/1 通过，且 PG/目录正常清理。该结果说明本轮成功导入同时存在一项失败统计，不能直接断言目标网页未导入。检查 `runWebImportTick` 的全局任务扫描、过期任务处理与测试遗留；保留来源和幂等断言，不删除 failed 计数后宣称通过。证据：`web-import-recheck.log`。

## 3. 结论边界与交接

这次确认了基础工程及人工闭环可运行，也确认了回归红灯和具体产品缺口。没有证据证明“所有模型调用都失败”，也没有证据证明“真实模型已经打通”。真实外呼、全部页面交互、故障恢复全组合和当前安装包仍待验收。

整改入口：[整体整改提示词](../../prompts/overall-remediation-2026-09-28.md)。本轮只做验收、证据与提示词，未实施整改。文档影响：更新阶段摘要和提示词导航；不改需求、架构、ADR、API 或数据模型，不新增重复路线图。

## 4. 整改后独立复验（2026-09-28 夜间）

用户报告任务已完成后，复验当前 HEAD 加未提交修改。**总体仍不通过：第一包已有修复、UI 局部改善，但第二包真实模型、第三包全页面 UI 与第四包桌面交付尚未完成。** 没有修改产品代码或用户配置；本节只验收、增加独立反例和维护文档。

### 4.1 核验范围与实跑

证据目录：`docs/testing/evidence/overall-recheck-2026-09-28/`。

| 检查 | 本轮结果 |
|---|---|
| 原有 Workbench 组件测试 | 56 文件，336/336 通过 |
| 新增下一步标题反例 | **2/2 失败**，证据独立于常规 336 项，不修改原测试集 |
| API 单元 | 130/130 通过 |
| Workbench 类型/构建 | 通过；JS 1098.29 kB，gzip 300.02 kB，仍有大包与无效动态导入警告 |
| 人工真实 API/PG 浏览器闭环 | 1/1 通过，PG 停止、临时目录清理 |
| 配置合并 | 提取生产脚本原合并块，在合成配置上验证模型字段保留、运行时键唯一、重复合并幂等，通过；未改真实配置 |
| Rust 配置白名单 | 正确 MSVC target 下 1/1 通过；首次误用机器默认 GNU target，测试进程以 STATUS_ENTRYPOINT_NOT_FOUND 退出，属于工具链执行问题，不算白名单断言失败 |
| 诊断脚本 | 2 通过、1 跳过 |
| 当前测试包 | **失败**：`test-release/desktop-build-manifest.json` 不存在；包核验脚本返回 ENOENT |
| live 页面 | 同前轮 10 个页面/状态检查，无页面异常和根横向溢出；新增任务 960×640 测量；并非全部 33 状态验收 |
| 独立全量 PG | **462 项：440 通过、19 失败、3 跳过**，退出 1；19 项均属首文件启动/清理异常，后续用例通过，原 9 个失败场景本轮全部通过；PG 正常停止且临时集群删除 |

开发方 `evidence/remediation-2026-09-28/full-pg-run1.log` 的 461 项（458 通过、0 失败、3 跳过）是开发自检记录。本轮未把它冒充独立实跑。3 个跳过涉及两个真实模型用例和一个需要 debug helper 的强杀用例，不构成真实 Provider 或完整恢复验收。

### 4.2 A01–A11 关闭判断

| 原项 | 状态 | 当前证据及剩余工作 |
|---|---|---|
| A01 模型闭环 | **未关闭** | 模型 API/config 代码与首轮 hash 相同；只增加设置页四态文案。verified/worker 均写死“尚未验证”，没有验证命令、结果查询、配置入口或真实模型闭环证据 |
| A02 桌面配置 | **部分通过** | 脚本合并与宿主模型键白名单通过源码级验证；没有当前确切包的 Start/Stop/重建保留配置及 API/Worker 实际指纹证明 |
| A03 迁移基线 | **对应修复通过** | 32/39 的过期清单补齐到 42，保留原完整性/幂等断言；独立全量对应 4 项通过，但全量总门槛仍受首文件启动问题影响 |
| A04 工程信息过重 | **部分改善，未关闭** | Pack 默认折叠，创建页从 4039px 降到 1906px；仍展示四个当前组合和工程解释。项目下一步新增标题，但存在本节反例 |
| A05 逐页布局 | **未关闭** | 知识“新建”仍上下换行；960×640 任务首行 y=533，首屏数据仍少。没有 33 状态、125%/150% Windows DPI 验收记录 |
| A06 能力/文案缺口 | **未关闭** | 通知页“策略与调度尚未冻结”旧文案仍在；确认事实、连接真实探测等原边界未完成，不把缺主题/语言列为强制新功能 |
| A07 性能 | **未关闭** | 没有新性能采样或路由拆包；主 JS 仍约 1.10MB，不据此断言必然卡顿 |
| A08 总交付与事实源 | **未关闭** | 配置来源报告解释浏览器/桌面差异，但阶段主文档未记录整改接续；当前测试包缺清单且 EXE 时间早于本轮宿主改动，无安装/升级证据 |
| A09 控制顺序 | **对应修复通过** | LOST 分支改为先 stop/reconcile/requeue，再重投递，并核对正确 worker/epoch；本轮对应场景通过，没有删断言或简单增加循环次数 |
| A10 蓝图 | **对应修复通过** | 归档测试通过领域命令取消遗留 Assist，蓝图新增领取 message ID 断言；保留来源失效与候选应用检查，本轮原 3 项通过 |
| A11 网页导入 | **对应修复通过** | Gateway fixture 在自身断言后结算遗留 import，保留网页导入的成功/失败计数断言，本轮对应场景通过 |

### 4.3 本轮新增确定缺陷：下一步标题刷新无效（P2）

位置：`apps/workbench/src/views/ProjectsView.tsx`，`taskTitles/resolvedTasks` 的 useEffect。ID 在发请求前即加入 resolvedTasks，成功和失败均永久保留，点击“刷新当前范围”只重读项目列表，不清除标题缓存。

两个反例均在当前组件上失败：

1. 首次显示“旧下一步”，服务端改名后点击刷新，仍显示旧标题。
2. 首次任务单读 503，服务端恢复后点击刷新，仍显示“标题暂不可读”，不再发第二次读取。

证据：[独立测试源](evidence/overall-recheck-2026-09-28/title-refresh.spec.ts)、`title-refresh.log`。复跑：在 apps/workbench 执行 `node node_modules/vitest/vitest.mjs run --config ../../docs/testing/evidence/overall-recheck-2026-09-28/title-refresh.config.ts`。应在显式刷新时重新校验标题，并给失败结果可重试出口；避免旧请求覆盖新一轮结果。不能只把 UUID 换成永不过期的缓存标题。

### 4.4 当前桌面包与模型工作包为何不能通过

- `test-release` 只有 exe、node、helper 和 api，缺 package manifest。`test-desktop.ps1` 在新启动时明确要求清单；已运行窗口不代表新启动可成功。EXE 时间为 20:59:51，宿主配置白名单修改为 22:41:48，不能证明新配置能力已经进入该包。本轮不重打包掩盖交付缺口，也不关闭用户现有窗口。
- 开发记录 `model-verification-design.md` 明确写 **Design only（实现阻塞）**。没有真实调用放行时不外呼是正确的，但不应停止不依赖真实调用的配置/验证入口实现及本地错误注入。本轮不补做实施、不擅自改变模型门槛；需按原提示词完成离线实现、门槛验证与获准后的真实调用证据。
- 设置页对浏览器实例也直接写“Worker 与 API 同一配置文件”，而配置来源报告明确 dev-stack 不启动 Worker。页面应反映当前宿主事实或标为未知，不能用桌面链说明替代浏览器 Worker 证据。

### 4.5 独立全量的启动异常与复验边界

首个 api-artifacts 文件的 before hook 未在 15 秒内获得 API liveness，18 个用例连带失败；after hook 对未赋值 api 调用 stop，留下测试/子进程，阻塞后续文件。核对 PID/父子关系及独立集群后，只终止本次自建的该测试和 API 子进程，让其余文件继续。之后同构建、隔离 PG 的 api-artifacts 文件独立 **18/18 通过**，PG 正常停止且目录清理。不能把此复跑与其余文件拼成一次无失败全量，也不能据此认定 18 个业务功能损坏。证据：`api-integration.log`、`api-artifacts-retry.log`。

最终堆栈确认 18 项均为 `the API did not become live within 15000ms`，第 19 项为 `Cannot read properties of undefined (reading 'stop')`，因此测试计数比首轮多了一个文件钩子失败。启动超时根因未定位，不武断归因负载；测试 harness 应在启动失败时回收已创建的子进程/数据目录，after hook 处理未完成初始化，避免挂住整个全量。关键源码收尾 hash 与本轮快照一致。文档检查最终通过。

文档影响：在本记录保留首轮与复验差异，更新唯一阶段入口；修复整改配置来源报告的 A02 锚点。没有改变需求、架构、API、数据模型或本轮生产实现。

## 5. 整改实现与独立复验（2026-09-29 凌晨）

用户授权按原整改提示词完成开发、返修、独立复验和文档同步。本轮由协调 Agent 分派并独立验收；实现者自报结果均经复跑核对。证据目录：docs/testing/evidence/remediation-2026-09-28/。

### 5.1 本轮实跑

| 检查 | 结果 |
|---|---|
| Workbench 类型检查 | 通过 |
| Workbench 组件测试 | 58 文件，**346/346 通过**（含标题反例 2、设置页六态、UI 整改新增项） |
| API 类型检查 | 通过 |
| API 单元（系统 node） | **135/135 通过**（含 model-port-verify 5） |
| 全量 PG 集成（单轮干净跑） | **469 项：466 通过、0 失败、3 跳过**，status: PASSED |
| 首文件 api-artifacts | **18/18 通过**，livenessMs≈1.8s，无启动超时连带 |
| 原标题 evidence 反例 | 2/2 通过（已纳入正式回归） |
| 桌面包 verify-desktop-package | Package hashes verified. |
| 桌面诊断 | package/node/webview2/config/database PASS；schema 在未迁移 DB 上 FAIL，Start 迁移后具备条件 |
| test-desktop Start 冷启动 | 退出 0；迁移 43 条、Graph ready、workspace 建立、3 个包进程运行 |

3 项跳过原因不变：2×RELAY_MODEL_* 未配置真实外呼、1×Windows helper 既有 SKIP。

### 5.2 A01–A11 与新增项关闭判断

| 原项 | 状态 | 本轮证据 |
|---|---|---|
| A01 模型闭环 | **离线闭环已关闭；真实外呼仍阻塞** | POST /model-port/verify + GET /model-port/verification + model_calls(kind=VERIFY)；设置页六态替换写死「尚未验证」；Fake 五分支（SUCCESS/AUTH/TIMEOUT/INVALID_MODEL/NETWORK）真实 PG 落账本；响应无密钥。真实 Provider 调用无放行记录，不外呼 |
| A02 桌面配置 | **部分通过** | 合并与白名单保持；	est-release 已重打包且含 manifest；Start 冷启动与升级备份链通过。Stop 须先关窗口（不强杀），重启保留完整链路待人工关窗后补测 |
| A03 迁移基线 | **保持通过并扩展** | 0043 入账后 cli/migration 清单基线补至 43；全量对应项通过 |
| A04 工程信息过重 | **部分关闭** | Pack 当前组合收进 <details>，首屏摘要一行 |
| A05 逐页布局 | **部分关闭** | 960×640 任务首行 y=312（原 533）；搜索双框消除；知识「新建」nowrap；1280×800 同步改善。**33 状态全矩阵与 Windows 125%/150% DPI 仍未验收** |
| A06 能力/文案缺口 | **部分关闭** | 通知偏好改为工作台 11.5 已确认规则；工程术语人话化。连接真实探测等边界未扩 |
| A07 性能 | **未关闭** | 未测冷启动/导航分位数；不宣称流畅或卡顿 |
| A08 总交付与事实源 | **部分关闭** | 本记录 + CODEX_NEXT_STEP 已同步；当前包 EXE SHA-256 6D3F80359336D7288FC8755E87D871E29C0EBB7E92E039DF889852FDEE6E8F87，manifest SHA-256 0E04E6A919BCAF5E5B46039D5EF047017265F1B14B8234F8E1BFD3F462A85ADC，17169 资源哈希通过；安装/升级/卸载属 M07 |
| A09 控制顺序 | **保持通过** | 全量对应场景通过 |
| A10 蓝图 | **保持通过** | 全量对应场景通过 |
| A11 网页导入 | **保持通过** | 全量对应场景通过 |
| 新：标题刷新 | **已关闭** | 根因 esolvedTasks 请求前永久标记；改为结束后写入 + 刷新整批失效 + epoch 丢弃过期响应；反例 2/2 转绿并纳入 projectsTitleRefresh.spec.ts |
| 新：集成启动/清理 | **已关闭** | 失败回收本 PID+data_root；after 可选链；liveness 区分退出/spawn/未监听；干净全量 0 失败 |

### 5.3 当前桌面包

- 路径：	est-release/（uild-release.ps1 -TestPackage）
- EXE SHA-256：6D3F80359336D7288FC8755E87D871E29C0EBB7E92E039DF889852FDEE6E8F87
- manifest SHA-256：0E04E6A919BCAF5E5B46039D5EF047017265F1B14B8234F8E1BFD3F462A85ADC
- 构建时间（UTC）：2026-09-28T17:35:16Z
- 包内含 pi/dist/src/workflow/model-port-verify.js（本轮模型修复已进包）
- 会话 session.json.manifest_hash 与上述一致；升级前自动备份 .relay-test/before-upgrade-20260929-*.dump
- 窗口已由 Start 打开；未强制关闭用户窗口。Stop 需人工先关窗

### 5.4 剩余阻塞与最小解除条件

1. **真实模型外呼**：实现已完成；解除条件 = 用户放行记录 + 已配置 RELAY_MODEL_*，再跑设计第 4 节错误注入矩阵与真实任务链路。
2. **33 页面/状态与 DPI**：解除条件 = 真实 Windows 125%/150% 逐页取证（浏览器视口不可替代）。
3. **性能采样**：解除条件 = 冷启动/首反馈/委托领取/取消反馈的实测分位数。
4. **M07 安装升级卸载**：解除条件 = 按既有 M07 要求做安装包与数据保留验收。

### 5.5 边界声明

- **实现已完成**（离线可验证范围）：模型验证闭环、标题刷新、UI 优先项、集成测试启动/清理、桌面包清单。
- **真实环境验收未完成**：真实 Provider 外呼、Windows DPI 矩阵、安装升级、性能分位数。
- 未删除失败检查、未拼接不同轮次结果、未伪称真实模型已验。

## 6. 真实外呼验收与遗留缺陷修复（2026-09-29 白天）

用户授权在具备已配置 Provider（`apps/api/.env`，openai-compatible / agnes-3.0-flash，用户此前写入的已授权凭据）时运行真实外呼验证。本轮由协调 Agent 分派四个并行执行 Agent（模型外呼、UI/DPI 取证、性能采样、桌面修复）并独立核对各报告与证据；5.4 节四项剩余阻塞中的三项取得实质进展，另发现并修复两个新缺陷。密钥全程未读取/未输出，日志脱敏（`grep` 复核 0 命中）。

### 6.1 本轮实跑

| 检查 | 结果 |
|---|---|
| Workbench 组件测试 | 58 文件，**346/346 通过** |
| API 单元 | **136/136 通过**（新增 1 例 VERIFY 结算映射单测） |
| 全量 PG 集成（干净单轮） | **471 项：466 通过 / 0 失败 / 5 跳过，status: PASSED**；PG stop exit 0、临时集群删除。5 项跳过 = 2 真实模型 opt-in（既有）+ 2 本轮新增取消反例 opt-in（本轮全量未带外呼环境）+ 1 Windows helper 既有 |
| 真实连接验证 | **通过**：`POST /model-port/verify` 200，latency_ms=872，`model_calls(kind=VERIFY)` 落账本 input=79/output=10；并发第二次 409 `MODEL_VERIFY_IN_PROGRESS`（2.8ms，未外呼）；验证后 `matches_current_config=true` |
| 真实 DRAFT 任务链路 | **通过**：Delegate→BUILD_CONTEXT→真实 DRAFT→WAITING_APPROVAL；候选为真实模型文本且含预埋探针标记（证实消费显式选源）；`completion_records=0` 完成门保持；DRAFT 账本两次真实用量 |
| HARD SEMANTIC 真实语义检查 | 修复后 **4/4 PASSED**（修复前挂起 >25 分钟自死锁）：3.8–11 秒收敛 WAITING_APPROVAL，check_results 落库（fake=false、真实用量），账本无孤儿 STARTED |
| Fake 错误注入矩阵 | model-verify 集成 **8/8 通过** |
| Fake 定向集成回归 | 5 文件 **104 过 / 0 失败**（run-graph 59+1 opt-in skip、verification 25、run-steps 8、run-command-order 7、model-call-budget 5） |
| 33 状态矩阵 | **31 pass / 2 unverified / 0 fail**；1280×800 与 960×640 两轮横向溢出 0、pageerror 0、console error 0 |
| Windows DPI | 原值即 **125%**：桌面窗口 GetDpiForWindow=120、devicePixelRatio=1.25，九页 PrintWindow 真实截图取证通过、无裁剪/重叠；**150% 程序化不可达**（注册表+广播+进程重启均不生效，缺陷 D3 如实登记），未用浏览器缩放冒充；终态恢复与原值逐项一致 |
| 性能采样（生产构建实测） | 首屏导航→可交互 P50 230ms / P90 303ms；路由切换 P50 62–73ms（全 <100ms）；Delegate 反馈 12ms；CANCEL 收敛 18ms；Ctrl+K 打开 10ms / 输入→结果 314ms（含 250ms 前端防抖）。**决定：不需要性能修复**；弱网/远程形态风险信号与可选优化记录于 perf 证据 |
| Rust 单测（MSVC target） | **27/27 通过**、0 warning（新增 5 例：重启策略、日志轮转、时间戳、事件落盘、"重启恢复不杀活动 API Job"门控） |
| 桌面包重打包 | EXE SHA-256 `5FA62913…576354`，manifest SHA-256 `6D1AF179…4831C`，built_at_utc 2026-09-29T01:40:12Z；verify-desktop-package **17169 资源哈希通过** |
| 重启配置保留（A02 补测） | Start#1 → 白名单内探针键 → 正常关窗 → Stop → Start#2 键仍在 → 移除，**通过**（未知键会被宿主白名单拒绝属安全不变量，故用白名单键做探针） |

### 6.2 本轮发现并修复的缺陷

| 缺陷 | 级别 | 修复 | 验证 |
|---|---|---|---|
| **VERIFY 语义检查自死锁**：结果事务持有 runs 行锁（run-steps.ts:479 + run-repository.ts:132）→ 事务内 `verifyRun` → `recordModelInvocation` → `ModelCallRepository.begin()` 另开连接对同一 runs 行二次 `for update`（`identity.budget` 存在时）；Mock 路径因 Fake 检查器无 budget 从未暴露；Run 永久卡 VERIFYING | P1（真实模型路径阻断） | 对齐 DRAFT 模式：`prepareSemanticChecks` 把语义检查的模型调用+记账移到结果事务之外，结果事务内 `verifyRun` 消费预计算结果；取消经 AbortSignal + 持久化控制意图（纯 abort 不产生 CANCELLED，符合"控制意图必须持久化"）；ERROR ≠ FAIL ≠ PASS 语义不变 | 真实外呼 4/4 转绿；真实 PG 取消反例 2 例纳入正式回归（在途 CANCEL→账本 COMPLETED、abort+CANCEL→账本 CANCELLED 非 STARTED）；Fake 定向 104/0；单元 136/136。证据 `verify-deadlock-fix.log`、`real-model-semantics-after-fix.log` |
| **D1**：worker 单次非零退出 → supervisor 抛错退出 → `desktop_bootstrap` 永久失败，桌面重载即"本机服务不可用" | 高（桌面阻断级） | 宿主有界重启（连续 3 次预算 + 指数退避 2s/4s/8s + supervisor 稳定 300s 后预算重置）；bootstrap 只在 API 停止时报错；重启恢复只终止 supervisor/worker 树、保留活动 API Job（门控单测） | 真实复现 worker exit=1 → 宿主 2s 退避重启 → 3s 内恢复派发；崩溃后两次独立 bootstrap OK；claim 真实收敛、60s+ 无假活派发。证据 `desktop-fix.log`、`d1-regression.log` |
| **D2**：supervisor/worker stderr 被 `Stdio::null` 丢弃，崩溃不可观测 | 中 | stderr 改轮转日志 `<data-root>/logs/worker-supervisor.log`（8MiB 轮转保留一代），协议事件 + 退出码 + 重启诊断带 UTC 时间戳落盘；密钥扫描 0 命中 | 崩溃复现日志含 worker_exit code=1 与 supervisor stderr 原文 |

33 矩阵中 UI-19（已暂停）经桌面安全点协调路径真实应用 PAUSE 后补取证 pass；UI-20（UNKNOWN 恢复核对）、UI-22（动作批准）维持 unverified（分别需 debug helper 强杀场景与 Git 能力触发，不造假状态）。

### 6.3 A01–A11 状态刷新

| 原项 | 5.2 时状态 | 本轮状态 |
|---|---|---|
| A01 模型闭环 | 离线闭环已关闭；真实外呼阻塞 | **关闭（本轮授权 Provider 范围内）**：连接验证、真实 DRAFT 链路、真实语义检查（修复后）均为真实外呼通过；「连接验证通过」与「真实任务执行成功」分别取证、未互相冒充。Worker 可执行性探测仍为只读建议（方案 A/B 见 `model-task-chain.log`），不阻塞 A01 |
| A02 桌面配置 | 部分通过 | **关闭**：重启保留链路补测通过；安装/升级/卸载仍属 M07 范围 |
| A05 逐页布局 | 部分关闭 | **大部分关闭**：33 状态矩阵完成登记（31/2/0）；125% DPI 真实取证通过；150% 程序化不可达登记为 D3，需系统设置人工切换后取证 |
| A07 性能 | 未关闭 | **关闭**：实测分位数全优（6.1），决定不实施重构；保留弱网形态风险信号与可选优化（路由拆包、防抖 250ms→120–150ms）于 perf 证据 |
| A08 总交付与事实源 | 部分关闭 | 本节 + CODEX_NEXT_STEP 同步后**关闭** |
| A03/A04/A06/A09/A10/A11 | 保持 5.2 结论 | A09/A10/A11 本轮全量对应场景继续通过；A04 Pack 折叠等维持；A06 通知文案维持已确认规则，连接真实探测边界维持不扩 |

### 6.4 剩余阻塞与边界

1. **150% DPI 真实取证**：程序化不可达（D3）；解除条件 = 系统设置 UI 人工切换 150% 后按同法取证并恢复原值。
2. **UI-20 / UI-22**：需 debug helper 强杀场景 / Git 能力触发；解除条件 = 专用故障注入环境（M06 既有 debug 助手链路）。
3. **worker 自然崩溃根因**：exit=1（claim 后无 step 输出）根因未定位——worker catch 只写 `worker_failed`，apps/api 侧 supervisor 未透传 worker stderr（本轮授权范围外）；宿主自愈已兜底，解除条件 = apps/api 侧补 stderr 透传后按日志定位。
4. **M07 安装/升级/卸载**：未启动，属 M07 出口。
5. 真实外呼结论绑定当前 `.env` 的 agnes-3.0-flash 与本轮固定短文本/小任务；流式、长输出、多轮、精确计量未全测，不外推到其他 Provider 或形态。
6. **实现与验收边界声明**：真实模型（连接验证 + DRAFT + 语义检查，本轮授权 Provider）、浏览器 33 状态矩阵、125% DPI、性能分位数、桌面包（新 EXE）均已由真实运行验证；"真实环境验收未完成"仅剩 6.4.1–6.4.4。

证据目录：`docs/testing/evidence/final-2026-09-29/`（model-verify-live、model-task-chain、verify-deadlock-fix、real-model-semantics-after-fix、desktop-fix、restart-persist、d1-regression、regression、perf/）与 `docs/testing/evidence/ui-dpi-2026-09-29/`（33 矩阵登记、DPI 原值/截图/恢复验证、defects json 含 D1/D2 修复状态）。

### 6.5 用户报告"打不开"排查（2026-09-29 中午）

用户启动 test-release 桌面包报"打不开"。排查证据：`worker-supervisor.log`、`postgres.log`、进程/窗口实测（`.tmp-openfix` 截图）。

1. **用户启动记录正常**：09:41 / 09:45 两次 Start 的 PG、迁移、升级备份、supervisor 全部正常就绪；09:41 会话在启动后 2 分 15 秒被关闭（fast shutdown），09:45 为重试。
2. **主因——启动链慢且无窗口反馈**：Start 全链（包完整性校验 60s+ → PG → 迁移检查 → 升级备份 pg_dump → 宿主 → 窗口）需 1–3 分钟，期间无任何窗口出现；用户在等待期放弃并重试，体感即"打不开"。
3. **偶发因素——窗口最小化**：11:03 复现启动后窗口处于最小化态（IsIconic=1、rect -25600 屏幕外 159×27），SW_RESTORE 后窗口与 UI 完全正常（Workflow OS 侧栏与真实项目列表渲染正常，截图验证）。该现象累计 3 个会话观测到（取证 B 曾靠 ShowWindow(9) 恢复后截图），但受控重启复现未命中（第二次启动窗口正常）；窗口创建代码（`visible(false)`→`show()`、无位置持久化）与 frame_guard 均无最小化逻辑，触发者未定位，登记为观察项。
4. **worker 崩溃史与可观测性修复**：01:46 会话 worker 启动 1.5s 后 exit=1（领取取证残留 Run `6e5f6ffb` 后无 step 输出；该 Run 现已 PAUSED，不再触发）。worker catch 原本只输出 `worker_failed` 吞掉错误栈——已修复：`apps/api/src/worker/main.ts` catch 现输出完整 stack（本轮最小可观测性修复，已进 dist；**桌面包内仍为旧 worker，重打包待窗口关闭后进行**）。
5. **交付时点实例状态**：宿主/PG/API/窗口全部正常，UI 渲染正常，worker 待命，应用可用。

处置与遗留：
- 用户侧即时可用；再遇"点了没反应"先等 1–3 分钟（包校验+迁移+备份为启动链固定成本）。
- **取证残留孤儿 Run**：`8d19e398`（「UI取证-20260929 项目A / 委托任务T6-1」）卡 RUNNING + 孤儿 ACTIVE claim（epoch 3），每轮启动记录 `worker_recovery_required` 但恢复链对无 launch 记录的旧孤儿无收敛路径（`retainedClaims=0`）。它不阻塞新委托，但会持续显示"运行中"并阻挡该项目归档。建议经 UI 取消该任务运行；登记为"恢复协议对无 launch 记录孤儿 claim 的收敛缺口"（结构性，apps/api 侧，待后续授权）。
- worker 崩溃根因定位依赖下一次打包 worker 崩溃时的 stderr 栈（本轮已具备输出能力）。
