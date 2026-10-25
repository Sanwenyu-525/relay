# Relay 当前状态与下一步

角色：唯一进度入口；更新：2026-10-26（补入除工作台外全页面 V5.28 原型复刻首轮实施状态）。只维护当前工作、阻塞、下一步，不追加逐轮经过和测试输出。

## 开工读取

1. 本页 → 按当前用户任务确定范围；未指定开发任务时不自动接续历史任务书。
2. [功能验收简表](docs/testing/overall-acceptance-2026-09-28.md#当前功能验收表) → 搜索相关功能，按链接读取该项详细证据与剩余项。
3. [文档地图](docs/README.md#1-唯一事实源) → 只定位本次相关规格、契约与源码，不通读大型主文档。

## 当前接续

以下按精简前入口的最新记录整理，不扩大授权；并行工作可能仍在推进，修改前检查 git status 与目标 diff。

| 工作 | 已记录状态 | 接续与限制 |
|---|---|---|
| 插件一键启用（用户指认「用个插件这么麻烦」） | 2026-10-25 实施者自检通过：修掉两处缺口（HTTP 能力白名单不含插件能力→高级表单提交即 422、浏览器策略死前缀）＋新增 `EnableProjectPlugin`（一命令一事务补齐连接与逐动作策略，只读 AUTO/操作 ASK，停用与撤销不绕过）＋连接页工具行「一键启用」；真实 PG/HTTP 6/6、gateway 族回归与定向前端 35/35，见[验收详情 332](docs/testing/acceptance-details/part-19.md#条目-332)与[HTTP §10.115](docs/api/http-command-contract/part-08.md#10115-一键启用内置插件2026-10-25-源码实现) | 真实浏览器/桌面端到端（按钮→真实插件动作）未验；会话内 AI 回复仍只提示「去登记」，未带直达启用入口（后续可把 `?tool=` 深链接接进回复动作）；未 commit/push，独立验收未做 |
| 除 agent 页外其他页面视觉对齐 | 2026-10-25 两轮实施者自检通过：①页头层级——普通页面 h1 全局统一 compactPage(28px) 与 /agent 页同档、lede 降 meta、section 降回 1.5rem 恢复 28/24/20 层级链，取代 2026-10-01 的 2.5rem 放大决定；②卡片语言与留白——radius.panel→1rem、主区留白→32px、项目卡/今日空态卡/配置面板升级白卡语言（白底＋投影＋16px 圆角），基准为用户自迭代项目重设计原型 | 面包屑保留（agent 页去面包屑是与页头重复的页内决定，不推广）。规则归[设计系统 §4 分册](docs/frontend/design-system/part-01.md#4-字体与排版)，成绩与未验边界见[验收详情 039](docs/testing/acceptance-details/part-01.md#条目-039)；真实 Windows/WebView2 未复验，未 commit/push |
| 全页面 V5.28 原型复刻（除工作台） | 2026-10-26 首轮实施完成：新增 `views/proto/protoPage.css`（.pv-page 作用域皮肤，含页面骨架/页头/按钮/卡片/统计/表格/表单/chip/提示条原语，色板按原型 v528 原值固定、不并入 --relay-* token），PageHeader 增加 overline 层；/projects（原型卡结构）、/goals(+详情)、/tasks+收件箱、/reviews、/today（+三格统计）、/knowledge、/activity、/scheduled-tasks 三视图（+统计行）、/settings、/connections、runs/completion/lineage/工作目录与各创建页、任务/项目内页签全部启用；真实数据边界保留（分页/回执/撤销/状态机未动，原型无接口支撑的展示不造假）。验证：typecheck 通过（taskbarBadge 一处失败为他人未提交改动遗留）；Vitest 主树失败集与干净 HEAD 逐文件一致（0 新增）；Playwright browser 20 条失败 ID 与 HEAD 完全一致（0 新增），workbench.spec 23/23 过；截图对照见 `apps/workbench/results/proto-replica-20261026/`（原型 proto/ 18 张 + 产品 27 张 + LEDGER.md），复跑脚本同目录 | 逐像素级差异未全量核对（仅主页面并排目检）；项目工作台 /projects/:id/workbench/:kind 未加 pv-page；深度交互（创建/编辑/审批提交）只在单测层覆盖；真实 Windows/WebView2 未验；未 commit/push，独立验收未做。规则归[设计系统 §5.2](docs/frontend/design-system/part-01.md#52-原型复刻页面皮肤pv-page2026-10-26) |
| 长期协作与自动化调度 | P0-A 定时任务后端、P0-B 编辑/续授权 UI、P1-A 长期成员身份后端、P1-B 私聊/群聊/消息服务端记录面已实施并自检（迁移 0138–0140，详见[进度历史快照](docs/development/codex-next-step-history-20261025.md)对应条目）；P1-C 第一片「成员消息唤醒与消费结算」已实施并自检（迁移 0141：定向唤醒裁决、成员回信、租约与尝试上限、model_calls MEMBER 计量，见[验收详情 331](docs/testing/acceptance-details/part-19.md#条目-331)） | P1-C 余下：协调者复用 Task/Run 用例自动推进、成员间定向互相唤醒、EXPLICIT openrouter 成员路由、外部成员领取（ADR-033）；随后事件/巡检合并与 Windows 生命周期（包 D）、P2-A 工作台 UI。开始前核对当前源码及最新验收条目，不能据旧“下一步”重做并行实现。独立验收仍须按对应包核定。P0→P1→P2 范围以用户 2026-10-25 下发任务书为准，设计参考[长期团队任务书](prompts/persistent-project-agent-team.md)与 ADR-034。 |
| 成果与版本管理 P0–P2 | 实施、定向自检及 P2 只读代码复核已完成（PG/HTTP、Workbench、TypeScript、Windows helper 分层见[验收详情 330](docs/testing/acceptance-details/part-19.md#条目-330)） | 尚未整体独立验收；迁移 legacy 冲突分支与真实 WebView2 进程重启、安装未验；状态不升级为 M/N 阶段完成。 |
| 任务与计划、正式目标管理、Verification / Review / Completion | N04/N06 第二轮独立验收已于 2026-10-26 完成：修复 PROPOSE_PLAN/PROPOSE_SCOPE/CREATE 恢复在合法并发推进下的永久卡住缺口、估时草稿离页保护与计划输入安全整数对齐，真实 Chromium 8/8、定向 Vitest 54/54、真实 PG/HTTP 71/71，见[验收详情 334](docs/testing/acceptance-details/part-19.md#条目-334) | Windows/WebView2 与真实 Provider 未验（本轮桌面锁屏，按用户指示只做浏览器侧）；N04/N06 整体出口与使用收益未闭合。 |
| Agent 基础链路与聊天 UI | 2026-10-25 有独立复跑与定向修复记录；同日仍有组件自检和并行改动 | 旧成绩绑定当轮源码，不能覆盖其后未提交变更；Windows/WebView2、Provider、安装出口分别核对。 |
| Chrome / Windows 电脑 / GitHub 插件 | 有分片实现与真实环境记录 | 日常 Chrome 保活/扩展重载、已认证 GitHub、安装态及部分 UI 路径仍有未验边界；GitHub 写动作协议不等于实施授权。 |

## 阶段与整体交付边界

## 当前改造模块状态

| 模块 | 状态 | 当前范围与剩余出口 |
|---|---|---|
| M01：基线与适配 | ACCEPTED | 保留原验收范围，不覆盖后续变更 |
| M02：React 与 Windows 基础 | ACCEPTED | 保留原验收范围，不代表最新 UI 与安装总验收 |
| M03：Mock Runtime 与可靠性 | 有限 Mock 出口通过 | 仅原冻结包范围，整体交付仍按验收核对 |
| M04：模型、Context 与 Assist | IN_PROGRESS | 真实模型与完整出口按对应验收行核对 |
| M05：工作体验与追溯 | IN_PROGRESS | 局部实现与修复不升级为整体完成 |
| M06：真实工具与 Coding Worker | IN_PROGRESS | 实际能力与未验范围按对应验收行核对 |
| M07：Windows 安装与 V1 总验收 | IN_PROGRESS | 确切包、恢复、安装与总验收出口未整体闭合 |

## N 阶段当前状态

| 包 | 状态 | 当前范围与剩余出口 |
|---|---|---|
| N00 使用基线 | 未测基线 | 不宣称实际省时收益 |
| N01 项目接续点 | 已有工程实现与修复 | Windows / 产品价值出口未闭合 |
| N02 跨成果共创 | 已有工程实现与修复 | Windows / 产品价值出口未闭合 |
| N03 项目知识整理 | 已有工程实现与修复 | Windows / 产品价值出口未闭合 |
| N04 周期计划 | 基础切片已接，完整出口未验 | 继续按相关验收条目接续 |
| N05 有限触发 | 基础切片已接，完整出口未验 | 继续按相关验收条目接续 |
| N06 有限连续委托 | 基础切片已接，完整出口未验 | 继续按相关验收条目接续 |
| N07 声明式配置 | 不默认进入 | 需实际重复使用证据 |
- 上述是阶段口径，不是最新功能覆盖清单；旧模块段落中可能已有被后续实现替代的缺口，须查验收表和代码，不直接据此重做。
- 真实 Provider、Windows 独立窗口、安装/升级/卸载及完整恢复组合须分别有确切基准证据；局部通过不代表 V1 总验收通过。

## 阻塞与下一步

- 先完成当前用户明确授权的任务。仅要求方案、文档或提示词时不启动代码开发。
- 继续某模块：定位其验收行 → 核对当前源码、未提交改动与原任务书依赖门 → 选择尚未闭合的一项 → 实施、自检并按模块要求独立验收。
- 需要人工环境、登录态或安装条件的出口，保留未验状态；不盲重试 UNKNOWN，也不继承历史会话的外部执行权限。
- 禅道是当前问题与需求登记处，见[接入](docs/deployment/禅道接入.md)；历史台账不新增登记。

## 按需追溯

2026-10-25 整理前的完整进度内容（含并行未提交记录、具体故障与历史授权）已迁入[进度历史快照](docs/development/codex-next-step-history-20261025.md)。先用关键词/标题定位，再读取对应小节；该快照不再更新当前进度，也不构成新的任务授权。更早材料沿快照原链接保留。
