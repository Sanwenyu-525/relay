# M07 提前开发与验证记录

## 范围与状态

2026-09-27 用户授权按提示词开发 M7/M8 中不依赖前序部分的内容。当前 [工作包](../../prompts/stack-migration.md) 只定义 M01–M07；M08 已请求澄清，不将可选 P22 论文实验自动当成 M08。

本次落地 M07/P20 的发布包只读诊断，Owner 为仓库运维脚本，复用现有资源校验和随包 API 配置/schema 契约。业务状态和数据库没有新增写入入口，API Breaking Change：No，无 migration 或新依赖。运行说明唯一维护在[部署文档](../deployment/local-deployment.md#发布包只读诊断)。M07 整体未验收。

| 主文档要求 | 本次处理 | 依据与限制 |
|---|---|---|
| P20 依赖诊断与包内运行时 | 实现并开发自检 | `scripts/diagnose-desktop.mjs`；检查包、Node、WebView2 注册、配置、PG/schema/Workspace |
| P20 安装入口、升级/卸载 | 后置 | 仍需安装产物、前序冻结基准与真实 Windows 安装演练 |
| P20 维护态、备份与隔离恢复 | 后置 | 依赖写入/领取冻结、内容一致性及未决动作恢复，不用单独 pg_dump 冒充完整实现 |
| P21 最终 OpenAPI 与完整回归 | 后置 | 前序接口/能力尚在开发，不能提前认定最终覆盖 |
| 产品总纲 0.4、验证计划 11 的体验评价 | 不适用本增量 | 只读运维诊断不实现新工作台体验，不声称提高注意力或验收效果 |
| P22 可选研究 | 未启动 | 未收到研究问题/任务集选择，也没有证据将其映射为 M08 |

## 自检

- 单元与既有包校验回归：`node --test scripts/diagnose-desktop.test.mjs scripts/test-desktop-package.test.mjs`，3/3 通过。覆盖未知/重复配置键、数值边界、相对路径、大小上限、包缺损/资源变化/越界及错误输出不含输入秘密。
- 真实 PG：复用 `start-acceptance-session.ps1 -SkipDesktop -UseCLocale` 创建临时 PostgreSQL 18.6、应用角色和 Workspace，未启动桌面/Worker。使用冻结 release EXE SHA-256 `c6c9b7bd730752c0252b541025806ab26837cb2264dda9d092faf12f7b852ebc`，业务 migrations 0001–0035；随包 Node 24.21.0。首轮七项诊断均 PASS。
- 最终代码的真实 PG 反例集：设置 `RELAY_DIAGNOSTIC_TEST_SESSION` 为临时会话绝对路径后，执行 `node --test scripts/diagnose-desktop.integration.test.mjs`，1/1 测试通过（含成功路径、Workspace 不存在、兼容视图不可见和数据库不可连接四个场景），退出 0，耗时约 39.3 秒。测试未启用 Graph，也未声称检查它。
- 清理：原会话 `3a8dc8f7ab5944e89e76a2bc0173ef95` 的 `stop-acceptance-session.ps1` 退出 0，`postgres_stop_exit=0`、`temporary_root_removed=True`，未停止其他数据库服务。
- 文档检查：`node scripts/check-docs.mjs` 通过。文档影响检查更新部署说明、README、当前进度和本记录；需求、架构、ADR、HTTP/API、数据库均无契约变化，不另建重复说明。
- 首轮全包 hash 在 60 秒内未结束，原诊断误将超时归入校验失败；已改为最多 5 分钟并独立报告完整性未知。后续直接包校验退出 0，未因超时改写包或 manifest。

本记录为开发自检，不是独立验收或 M07 总出口；没有运行安装器、真实 WebView2 窗口、Provider、备份恢复或跨版本升级。诊断不校验 Graph checkpoint，不能解除旧待审 checkpoint 升级阻塞。
