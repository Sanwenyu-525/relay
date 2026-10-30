# Relay 当前状态与下一步

角色：唯一进度入口；更新：2026-10-30（同步后端、Agent 与记忆压缩档位出口）。只维护当前工作、阻塞、下一步，不追加逐轮经过和测试输出。

## 开工读取

1. 本页 → 按当前用户任务确定范围；未指定开发任务时不自动接续历史任务书。
2. [功能验收简表](docs/testing/overall-acceptance-2026-09-28.md#当前功能验收表) → 搜索相关功能，按链接读取该项详细证据与剩余项。
3. [文档地图](docs/README.md#1-唯一事实源) → 只定位本次相关规格、契约与源码，不通读大型主文档。

## 当前接续

以下按精简前入口的最新记录整理，不扩大授权；并行工作可能仍在推进，修改前检查 git status 与目标 diff。

| 工作 | 已记录状态 | 接续与限制 |
|---|---|---|
| 长短期记忆与上下文压缩（2026-10-30） | 召回与压缩计量接缝已修复；工作容量与压缩压力绑定有效预算，设置和输入框上下文圆环均可选择256K/512K/1024K及跟随默认；首条前与已有会话两种圆环入口均已接线。API、相关记忆/Agent、组件和受控 Chromium 自检通过，依据归[条目 093](docs/testing/acceptance-details/part-05.md#条目-093) | 工作台全量类型检查需按条目093的最新记录核对并行开发文件阻塞；真实 Provider 摘要/提取质量与成本、Windows/安装及本轮独立验收未覆盖；保留原分层与版本/撤销机制；未 commit/push |
| Agent 主链逐层排查（2026-10-30） | 修复宿主停止准入、同会话排队排他及异步生成的心跳/停止监听生命周期，依据归[条目 191](docs/testing/acceptance-details/part-11.md#条目-191)；接续修复 SSE 完整超长行校验、上游流清理与已知缓存计量保留，模型接缝和相关 Agent/工具回归自检通过，依据归[条目 297](docs/testing/acceptance-details/part-16.md#条目-297) | 受控 Provider 不代替真实外呼与计费；Windows/WebView2、安装和独立验收未新增证据；既有间歇冷启动问题未据此关闭；未 commit/push |
| 基础后端逐层排查（2026-10-29–30） | 修复 IPv6 Origin、IPv6 Host 及编译后源码根定位三处启动边界缺陷；修正迁移清单与聊天回归夹具。基础 PG/HTTP、选定执行恢复和基础聊天自检通过，分别见[条目 282](docs/testing/acceptance-details/part-16.md#条目-282)、[条目 283](docs/testing/acceptance-details/part-16.md#条目-283)、[条目 298](docs/testing/acceptance-details/part-16.md#条目-298) | 间歇冷启动无输出超时根因未确认；聊天全量、真实 Provider、桌面与安装各自出口仍须核对，不继承历史通过；未 commit/push |
| 输入器与消息内联插件标识 | 2026-10-28/29 第二轮精修实施者自检通过：芯片宽度按 `@标签` 实测矩形下发（配名称省略号收口），「盖住后续正文/光标落进名称」结构上不可能；新增唯一视觉件 `components/PluginChip` 统一编辑态与消息态（sage 容器底 + `radius.badge`，零新增 token），图标两态 16px、名称只读态升到 body；修掉只读态 `<img>` 基线撑高消息气泡 1px 与禁用态灰度不一致；`forced-colors` 下补系统描边。**2026-10-29 第三轮把「跨行只盖首片段」这条按用户指认当缺陷改掉**：`placeChips()` 按 `getClientRects()` 段数判定，mention 被原生折行拆成两段以上时整枚芯片收起（`display:none`，不留半枚图标）、原文 `@标签` 恢复可见（`color: inherit`，禁用灰度照旧），折行规则不改、不用镜像层 `nowrap`，降级实测零矩形位移（光标/选区/IME/撤销落点不变）；回归从 14 条扩到 19 条，含三档宽度 × 21 档长度扫描、真实按键撤销恢复、多行消息、降级叠加 pending 禁用，并把「重载／真实发送回显／真正撤回」拆成三个状态各自取证。证据：真实 Chromium 几何套件 19/19、第一轮浏览器 7/7、芯片 jsdom 35/35、4-worker 全量 1882/1893（11 项失败逐条属既有基线，本轮路径零失败零新增）、typecheck 与 build exit 0、截图累计 34 张，见[验收详情 340](docs/testing/acceptance-details/part-19.md#条目-340)。**2026-10-29 第四轮 V3（用户「Codex 风格简洁内联 + 菜单去阴影 + 删尾随空格不得重开菜单」）**：`@` 菜单触发改绑「这一次键入」的 `mentionAt` 锚点——只有 `insertText` 新建查询，粘贴／拖入／IME／撤销／重做／删字都不新建，删除已选插件的尾随空格不再重开（无 setTimeout 或删完立刻关的掩盖），斜杠命令与键盘语义不变；标识去掉浅绿容器底/边框/阴影（透明背景、`color: inherit`、2px gap，编辑态与消息态同一套表面，宽度仍等于 `@标签` 原文字宽）；插件菜单去阴影并收成贴内容的紧凑浮层（≤320px、1px 分隔边框、常驻提示收进 `aria-describedby`），命令菜单与其他浮层不动。证据：jsdom 40/40、浏览器触发与菜单 11/11、几何与两态外观 21/21（含前后对照截图）、4-worker 全量 1887/1898（11 项失败身份属既有基线）、`tsc --noEmit` 与 `vite build` exit 0，见[验收详情 341](docs/testing/acceptance-details/part-19.md#条目-341)（第二轮见 [339](docs/testing/acceptance-details/part-19.md#条目-339)、第三轮见 [340](docs/testing/acceptance-details/part-19.md#条目-340)） | 真实 Windows/WebView2 **BLOCKED**：桌面壳固定互斥体 `Local\RelayAgentDesktopSingleInstance` 只允许单实例，第二次启动即退出；本机现有实例未开调试端口且属并行会话，接管需用户授权先关闭。窄容器跨行时读到的是 `@标签` 原文而非芯片（可读性与排版一致性的取舍）；编辑态名称留 meta 档（宽度预算）；菜单顶部键盘提示只存于无障碍语义，鼠标用户看不到；真实高对比与 DPI 缩放未验（工作台无暗色主题）；独立验收未做；未 commit/push |
| 近期工作栏运行状态动效 | 2026-10-28 实施者自检通过：会话投影新增读时派生 `run_state`（`assist_messages` 的 PENDING/RUNNING，`RUNNING` 压过 `PENDING`，无在途为 `null`），左栏 12px 类型图标换成环（`RUNNING` 1s 匀速转、`PENDING` 静止点线、终态回图标），轮询只在有会话运行期间存在且失败不清状态；真实 PG/HTTP 6/6、jsdom 9/9、真实 Chromium 5/5，见[验收详情 338](docs/testing/acceptance-details/part-19.md#条目-338) | 真实 Windows/WebView2、独立验收与 commit/push 未做；`recentWorkRailDensity`/`NotStarted`/`DragLine` 19 例中 4 条既有失败在改动前同工作树一致复现，归并行未提交改动；`PENDING` 长期不被认领时无超时降级 |
| 插件一键启用（用户指认「用个插件这么麻烦」） | 2026-10-25 实施者自检通过：修掉两处缺口（HTTP 能力白名单不含插件能力→高级表单提交即 422、浏览器策略死前缀）＋新增 `EnableProjectPlugin`（一命令一事务补齐连接与逐动作策略，只读 AUTO/操作 ASK，停用与撤销不绕过）＋连接页工具行「一键启用」；真实 PG/HTTP 6/6、gateway 族回归与定向前端 35/35，见[验收详情 332](docs/testing/acceptance-details/part-19.md#条目-332)与[HTTP §10.115](docs/api/http-command-contract/part-08.md#10115-一键启用内置插件2026-10-25-源码实现) | 真实浏览器/桌面端到端（按钮→真实插件动作）未验；会话内 AI 回复仍只提示「去登记」，未带直达启用入口（后续可把 `?tool=` 深链接接进回复动作）；未 commit/push，独立验收未做 |
| 除 agent 页外其他页面视觉对齐 | 2026-10-25 两轮实施者自检通过：①页头层级——普通页面 h1 全局统一 compactPage(28px) 与 /agent 页同档、lede 降 meta、section 降回 1.5rem 恢复 28/24/20 层级链，取代 2026-10-01 的 2.5rem 放大决定；②卡片语言与留白——radius.panel→1rem、主区留白→32px、项目卡/今日空态卡/配置面板升级白卡语言（白底＋投影＋16px 圆角），基准为用户自迭代项目重设计原型 | 面包屑保留（agent 页去面包屑是与页头重复的页内决定，不推广）。规则归[设计系统 §4 分册](docs/frontend/design-system/part-01.md#4-字体与排版)，成绩与未验边界见[验收详情 039](docs/testing/acceptance-details/part-01.md#条目-039)；真实 Windows/WebView2 未复验，未 commit/push |
| 全页面 V5.28 原型复刻（除工作台） | 2026-10-26 首轮实施完成：新增 `views/proto/protoPage.css`（.pv-page 作用域皮肤，含页面骨架/页头/按钮/卡片/统计/表格/表单/chip/提示条原语，色板按原型 v528 原值固定、不并入 --relay-* token），PageHeader 增加 overline 层；/projects（原型卡结构）、/goals(+详情)、/tasks+收件箱、/reviews、/today（+三格统计）、/knowledge、/activity、/scheduled-tasks 三视图（+统计行）、/settings、/connections、runs/completion/lineage/工作目录与各创建页、任务/项目内页签全部启用；真实数据边界保留（分页/回执/撤销/状态机未动，原型无接口支撑的展示不造假）。验证：typecheck 通过（taskbarBadge 一处失败为他人未提交改动遗留）；Vitest 主树失败集与干净 HEAD 逐文件一致（0 新增）；Playwright browser 20 条失败 ID 与 HEAD 完全一致（0 新增），workbench.spec 23/23 过；截图对照见 `apps/workbench/results/proto-replica-20261026/`（原型 proto/ 18 张 + 产品 27 张 + LEDGER.md），复跑脚本同目录。2026-10-27 精修轮（Skill 驱动，规则归[设计系统 §5.2](docs/frontend/design-system/part-01.md#52-原型复刻页面皮肤pv-page2026-10-26)）：probe 实测修掉全局字号档漏进 pv 作用域的层级倒置（page-state h1 28→22px 含 compound 形态、rail/表单/行内 meta 档、Reviews 分区 h3 24→13px、Tasks 页签 18→12px、Settings 分区头/说明句、Projects 空位卡），/tasks/:id（TaskDetailView）补挂 pv-page；probe 前后对照＋19 路由截图（results/pv-polish-20261027/）、typecheck exit 0、workbench.spec 23/23、impeccable detect 0 发现 | 逐像素级差异未全量核对（仅主页面并排目检）；项目工作台 /projects/:id/workbench/:kind 未加 pv-page；深度交互（创建/编辑/审批提交）只在单测层覆盖；两轮均实施者自检、未独立验收；真实 Windows/WebView2 未验；未 commit/push。规则归[设计系统 §5.2](docs/frontend/design-system/part-01.md#52-原型复刻页面皮肤pv-page2026-10-26) |
| 长期协作与自动化调度 | P0-A 定时任务后端、P0-B 编辑/续授权 UI、P1-A 长期成员身份后端、P1-B 私聊/群聊/消息服务端记录面已实施并自检（迁移 0138–0140，详见[进度历史快照](docs/development/codex-next-step-history-20261025.md)对应条目）；P1-C 第一片「成员消息唤醒与消费结算」已实施并自检（迁移 0141：定向唤醒裁决、成员回信、租约与尝试上限、model_calls MEMBER 计量，见[验收详情 331](docs/testing/acceptance-details/part-19.md#条目-331)） | P1-C 余下：协调者复用 Task/Run 用例自动推进、成员间定向互相唤醒、EXPLICIT openrouter 成员路由、外部成员领取（ADR-033）；随后事件/巡检合并与 Windows 生命周期（包 D）、P2-A 工作台 UI。开始前核对当前源码及最新验收条目，不能据旧“下一步”重做并行实现。独立验收仍须按对应包核定。P0→P1→P2 范围以用户 2026-10-25 下发任务书为准，设计参考[长期团队任务书](prompts/persistent-project-agent-team.md)与 ADR-034。 |
| 成果与版本管理 P0–P2 | 第二轮复验：迁移 0136 两分支 2/2，真实 PG/HTTP 六套件 69/69，Workbench 定向 10 文件 120/120 且 typecheck 通过；桌面脚本语法通过（见[验收详情 330](docs/testing/acceptance-details/part-19.md#条目-330)） | 真实 WebView2 多版本与重启恢复、Workbench Vite build 和安装包仍未验；共享 release 构建未结束，未启动竞争构建；整体维持 PARTIAL，不升级为 M/N 阶段完成。 |
| 任务与计划、正式目标管理、Verification / Review / Completion | N04/N06 第二轮独立复核见[验收详情 334](docs/testing/acceptance-details/part-19.md#条目-334)；2026-10-27 接续复验与联合 PG/HTTP/Worker 闭环见[验收详情 336](docs/testing/acceptance-details/part-19.md#条目-336)。 | N04/N06 仍为部分验收：同步 Workbench 快照全量 Vitest 1866/1877 通过、11 项失败均属于已记录历史失败身份；Workbench typecheck 与 Vite build 通过。当前 API typecheck exit 2，错误来自 Model Connections 的返回类型、RetryAction 和 Error.name；隔离快照 fresh build exit 1，且未同步 model-connection-api，不能记作当前 API 通过。最新 PG/HTTP 批次 65/72，personal-planning 启动钩子超时、7 个测试主体未运行；同快照单跑 7/7，联合链 1/1 使用 FakeModelPort。Windows/WebView2 项目列表与创建表单实际打开，但 CreateProject 未落库（projects=0、无 CreateProject 回执）；随后 user-input guard 阻止继续操作，桌面验收仍阻断；真实 Provider 未验，P2 未运行。Verification / Review / Completion 的既有验收见[详情 006](docs/testing/acceptance-details/part-01.md#条目-006)。 |
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
- 2026-10-27 Goal/Project：待核对命令作用域持久恢复、草稿守卫分离及接续投影/窄标题栏修复已完成；Workbench 137/137、typecheck/build 通过，Chromium 14/14；9 组真实 PG/HTTP 58/58（当时迁移至 0143）。随后并行 API 源码持续修改，release 编译结束后因输入指纹变化中止；API typecheck 有一次 exit 0，但检查期间源码也变化，不能认定最新快照稳定。旧包保存在 `test-release-goal-baseline-20261027`；另一工作树仍持有 Relay 单实例锁，最新 WebView2、干净 HEAD 构建及独立验收未完成。整体验收 BLOCKED，细节见[验收详情 011](docs/testing/acceptance-details/part-01.md#条目-011)。
- 禅道是当前问题与需求登记处，见[接入](docs/deployment/禅道接入.md)；历史台账不新增登记。

## 按需追溯

2026-10-25 整理前的完整进度内容（含并行未提交记录、具体故障与历史授权）已迁入[进度历史快照](docs/development/codex-next-step-history-20261025.md)。先用关键词/标题定位，再读取对应小节；该快照不再更新当前进度，也不构成新的任务授权。更早材料沿快照原链接保留。
