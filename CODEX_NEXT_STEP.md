# Relay 当前状态与下一步

更新：2026-09-30。角色：唯一阶段、模块与下一步入口。功能通过/未通过/未验收只看[功能验收表](docs/testing/overall-acceptance-2026-09-28.md#当前功能验收表)；长篇经过保存在[历史快照](docs/development/codex-next-step-history-20260930.md)，不作为默认交接输入。

**当前结论：基础人工/Mock 闭环及若干真实模型、恢复、UI 分片已有通过记录；M03–M07 总出口与 Windows 安装交付仍未完成。** 通过项绑定原运行环境和版本，不自动覆盖当前未提交修改。真实 Provider 已于 2026-09-29 获用户授权做定向验证，不把早期“保持关闭”当作现在的配置事实，也不自行扩大外发范围。

## 当前改造模块状态

| 模块 | 状态 | 当前范围与剩余出口 |
|---|---|---|
| M01：基线与适配 | ACCEPTED | [独立验收](docs/testing/m01-independent-acceptance.md)通过；保留原运行基准 |
| M02：React 与 Windows 基础 | ACCEPTED | [独立验收](docs/testing/m02-independent-acceptance.md)通过；不涵盖最新 UI 或安装总验收 |
| M03：Mock Runtime 与可靠性 | IN_PROGRESS | 冻结试用包基础 Mock/Review/重启链通过；[完整 G01–G08](docs/testing/m03-independent-acceptance.md)未总验收 |
| M04：模型、Context、Assist、低风险工具 | IN_PROGRESS | 隔离真实 DRAFT/语义检查/取消和诊断增量有通过记录；真实故障矩阵、首输出延迟、完整真实链及 Windows 仍待验 |
| M05：工作体验与追溯 | IN_PROGRESS | Today/工作台/知识/追溯及归档已有实现与分片自检；当前 UI 和业务总验收未完成 |
| M06：真实工具与 Coding Worker | IN_PROGRESS | 文件/Git/CLI、账本、UNKNOWN/PARTIAL 人工处置及无回执恢复有分片验证；[确切包、人工交互及总出口](docs/testing/m06-independent-acceptance.md)仍待验 |
| M07：Windows 安装与 V1 总验收 | IN_PROGRESS | [发布包诊断](docs/testing/m07-independent-acceptance.md)已有实现；安装/升级/卸载、完整备份恢复与总验收未通过 |

## 当前实现与验证边界

- 协作工作区采用已选方向 1“对话主轴 · 双页工作桌”；根路由仍为 `/projects`，旧路由/深链接保留。最新协作页视觉/Review 修复有浏览器与组件证据，真实 API 判断提交及最新 Windows/IME/DPI 尚未完整验收。依据：[工作台交互](docs/frontend/workbench-design.md#14-以目标协作为中心的工作台改造)、[开发记录](docs/development/ui-live-integration-2026-09-28.md#13-协作页参考图接续与-review-修复2026-09-30)。
- 2026-09-30 下午整套视觉纠偏已有浏览器与自动化、目录测试包静态证据；最后辅助页间距与总览/Assist 标签补修后已重新打包。真实 Windows/IME/DPI、特殊状态、Provider 或 PG 全链未重跑，旧包不代表最新界面。诊断与视觉各自的基准、成绩及剩余项只看[功能验收表](docs/testing/overall-acceptance-2026-09-28.md#当前功能验收表)；根因见[诊断记录](docs/development/ui-live-integration-2026-09-28.md#14-m04-run-模型调用诊断与本地错误归因2026-09-30)和[纠偏记录](docs/development/ui-live-integration-2026-09-28.md#16-整套页面视觉纠偏与发布输入冻结2026-09-30)。本轮仅完成视觉及打包增量，未据此推进 M04–M07 总验收。
- 菜单 6 `DesktopDev` 已复验真实 Windows 窗口、私有引导、readiness、重复启动和并发 Stop；仅验证开发启动，未重打包或刷新 API，也未覆盖完整业务。依据：[启动修复](docs/development/ui-live-integration-2026-09-28.md#15-菜单-6-桌面开发启动修复2026-09-30)。
- Git 只读 UI 与交互终端仍缺协议；PDF 导入、首输出完整延迟及 Windows 安装交付仍未完成。V1 后续长期协作/N00–N07 属规划，Proposed 不自动成为当前实现授权。

## 下一步与当前授权

1. 本轮按用户要求整理验收入口与原始输出：功能状态集中到已有验收表、缩短当前入口、压缩历史过程输出并调整 Git 保留规则，不扩大产品实现或真实调用范围。
2. 接续开发时先核对当前源码和已有通过分片，不重做已通过功能；按用户下一项范围补最新 UI/Windows、真实 Provider 故障与首输出、M06/M07 剩余出口。默认大模块自检、独立验收、修复复验后推进，已获授权的并行开发或验收后置保持原边界。
3. 读取[文档地图](docs/README.md)、[契约](contracts/README.md)、[大模块工作包](prompts/stack-migration.md)和[测试规格](docs/testing/verification-plan.md)中与本次任务相关的部分；仅为定位具体失败展开历史或日志，不扫描全部证据。

文档维护与输出保留见[规则](docs/README.md#6-验收结果与原始输出保留)。所有日期块、原包身份和旧阶段经过可在历史快照及各专题记录恢复；这些记录不替代当前模块状态。
