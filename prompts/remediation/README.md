# 独立验收修复与调整提示词

日期：2026-09-21。来源：[前后端独立验收](../../docs/testing/frontend-backend-acceptance-2026-09-21.md)。状态：**R01–R04 已执行并完成分层复验；未完成真实前后端联调、Windows 桌面与完整业务验收。**

此目录独立于 P00–P22 开发提示词和 UI 逐页开发提示词。R 编号只标识本次修复任务，不新增开发阶段、不批准未实现功能，也不自动证明真实联调或桌面交付。

2026-10-03 专项入口：[方案 2 首条会话与待审版本整改](ui-option-2-first-session.md)。本次实际验收结果归[统一验收表 §10.7](../../docs/testing/overall-acceptance-2026-09-28.md#107-当前源码的独立复核2026-10-03)，提示词独立交付、尚未执行；不属于下表历史 R01–R05。当前子代理模型遵循最新 AGENTS 的 `gpt-6.1-sol`，下方旧模型路由说明仅保留历史，不作为当前派发指令。

2026-10-04 专项入口：[C 片实施：协作页工具轨迹呈现](tool-trajectory-presentation.md)。对应 `prompts/agent-native-tools.md` 五节的 C 片，**尚未执行**；设计规则归[工作台 §18.8](../../docs/frontend/workbench-design.md#188-工具轨迹的呈现2026-10-04c-片设计)，端面归[命令契约 §10.56](../../docs/api/http-command-contract.md)，物理设计归[第 60 节](../../docs/database/physical-design-postgresql.md)，验收规格归[测试计划 §20.4](../../docs/testing/verification-plan.md)，上游依据归[研究 §1.6](../../docs/research/p00-source-study.md#16-工具调用呈现与刷新机制对照2026-10-04)。它同样不属于下表历史 R01–R05。

| 顺序 | 可直接交给执行者的提示词 | 范围 |
|---|---|---|
| R01 | [后端当前事实与阶段校验](R01-backend-correctness.md) | 已执行：BE-01、BE-02；真实 PG+HTTP 73/73 |
| R02 | [前端对象隔离与创建闭环](R02-frontend-correctness.md) | 已执行：FE-01–04；fixture 回归与 Chromium 复验 |
| R03 | [前后端接入前对齐](R03-integration-alignment.md) | 已执行：INT-01–03；完成类型/能力映射，不代表已联调 |
| R04 | [可选视觉与产品文案调整](R04-visual-copy-adjustment.md) | 已执行：UI-ADJ-01/02；保留现有视觉方向与唯一 token |
| R05 | [P05/P06 验收阻塞项](R05-workflow-verification-gates.md) | 2026-09-23 已执行并独立复验：自动完成产物要求校验、迟到结果保留当前 claim；57 单测 / 113 PG 集成通过，P07 未实施 |

R01 与 R02 所属代码目录不同，已按各自范围完成修复并由主 Agent 汇总复验；R03 以其结果完成接入前对齐，R04 为非阻断视觉/文案收口。不要将这些结果外推到后续开发阶段。

如通过模型路由执行编码，沿用 AGENTS 指定的 `gpt-5.6-terra / xhigh`；主 Agent 负责验收。不能仅在文字中宣称切换模型。所有执行者先读仓库 AGENTS 和最新 CODEX_NEXT_STEP，以当时实际代码为准，不机械套用过期行号。
