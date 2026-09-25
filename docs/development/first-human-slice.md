# 首条工程切片：人工任务与不可变产物闭环

日期：2026-09-19。状态：Proposed 实施规格，尚未开工。接口依据：[HTTP 与命令契约](../api/http-command-contract.md)。

## 目标与范围

在独立 Personal Workflow OS 工程的 Windows 桌面窗口中，用户能够建立 Project、创建 Task、明确验收、开始工作、保存 Markdown 版本、人工完成并重开。数据在应用重启后保留；重复请求和并发完成不产生重复事实。桌面交付边界见 [ADR-007](../decisions/ADR-007-windows-desktop.md)，不以单独浏览器或 API 客户端替代人工切片交付。

首条切片不依赖真实模型、ComfyUI、Manga 代码、宿主 CLI 或 Agent。这里只交付人工主线，不能标记整个 V1 完成。

## 工程形态

推荐单后端应用，内部按 application、project、task、artifact、infrastructure、api 组织。语言和构建工具依据 P00 验证结论，当前推荐 TypeScript/Node/Fastify + pnpm；阶段 A 不为尚无调用方的 Worker、Agent/Python 建空包，执行阶段再增加 Worker 进程。人工接受与完成凭据先归 Task 模块，不单独建立通用审批引擎；后续共享的是既定应用契约。不因文档里出现多个 Owner 就创建多个构建工程。

启动配置至少包括 PostgreSQL 连接、受管 data_root、本机 API 凭据和允许来源。项目自身管理 schema；应用角色与 migration 角色分开。源码和产物存储分开，秘密只从环境或外部配置注入。

本次工作区为 D:/Develop/Relay-Agent，原路径 D:/Develop/毕业论文项目保留为迁移历史。不能使用或覆盖 Manga 的工程、数据库与产物目录。

## 交付顺序与验收

| 步骤 | 产出 | 必须验证 |
|---|---|---|
| 1. 独立工程与依赖锁定 | P00 选定的后端组合、构建锁定、配置说明 | 编译/测试可运行；依赖精确版本固定；启动不连接 Manga DB |
| 2. V001 与 Repository | 人工闭环必要表、约束、权限、版本化 SQL migration | 空库迁移成功；二次启动不重复执行；循环 FK、跨 Workspace、周期唯一约束通过真实 DB 测试 |
| 3. 应用用例 | Create/Ready/Start/Save/Complete/Reopen、回执与审计 | owner/revision 校验，State 与完成同事务；事务失败不留下半完成 Task |
| 4. HTTP 与 OpenAPI | 仅人工切片路由、输入 schema、Problem Details | 示例与 schema 一致；未知字段/越权被拒；幂等及 409 可复现 |
| 5. 内容存储 | 不可变版本、hash、受管下载、失败核对 | 新版本不覆盖；保存前中断不登记假版本；文件缺失不能继续完成 |
| 6. 桌面壳与薄工作台 | 从独立入口打开窗口、连接本机 API，展示完整人工路径 | 重载/重启能续接，关闭处理草稿；人工完成与重开结果可见，不把自动化未实现藏起来 |

## 必须通过的场景

1. 有 Project 的任务与无 Project 的人工事项都能完成；无产物事项不被强制上传文件。
2. 同 command_id 相同请求只产生一份 Task/版本/完成凭据；不同 payload 被拒。
3. 两个不同 command_id 同时完成人工任务，只有一个有效周期完成凭据。
4. 重开增加 acceptance_revision，旧结果仍可查；重放旧完成命令不会再完成新周期。
5. 先保存 v1 与 v2，再明确按固定 v1 完成：凭据只指向 v1，不能把 v2 标为已验收；完成后必须先重开才能继续上传。
6. 内容发布成功、DB 提交失败：留下可核对孤儿，Task 不误完成；不开自动清理。
7. 完成事务在 Task/State 更新之间失败：二者一起回滚；重复提交最终状态一致。
8. 人工保存/完成只允许当前 HUMAN 执行权和合法状态；客户端无法 PATCH status=DONE。

这些对应 A01–A03、A08–A09、C01–C02 及 D 中适用于人工提交的场景；不声称本切片覆盖 Worker、资源隔离或真实副作用恢复。

## 完成标准与文档同步

必须交付实际可运行源码、完整 migration、OpenAPI、真实 PostgreSQL 测试结果和启动说明。README 写实际命令，测试说明列明运行版本与剩余边界，ROADMAP 只标记人工切片完成。未做的 AI/恢复能力继续标为未实现。

本文为人工业务切片的实施规格；最新阶段与环境状态见 [CODEX_NEXT_STEP](../../CODEX_NEXT_STEP.md)，P00 独立实验的实际覆盖见 [研究记录](../research/p00-source-study.md)。研究验收后进入工程搭建与 V001，不把基础数据库或恢复实验当作人工切片已完成。
