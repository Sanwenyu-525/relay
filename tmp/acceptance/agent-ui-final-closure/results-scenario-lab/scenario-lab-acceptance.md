# AI 回复场景实验室 · UI 验收结果

源码版本：`4cc630da376140691e05cdf25db9dabbb5665c4f`（main，工作区有未提交改动）
源码内容指纹：`a9c17ad3fafec59c0727e455b9c807dac9a71320f1a9aee46a9f3fe2a5e3ca30`（覆盖实验室挂载的产品源码导入闭包 + 验收代码 + 构建配置共 221 个文件，按盘上内容逐个 SHA-256）
报告生成：2026-10-31T02:19:16.523Z
判定时间：2026-10-31T02:17:03.392Z（静态断言在真实浏览器里逐条跑出，非人工判读）
清单指纹：`106d08dbbe78a1c5c43d665512a85788011bd067d07d289bb3e088e84b75e1a7`（与当前 `src/dev/scenarios` 逐字段一致）
场景总数：145　通过(PASS) 145　失败(FAIL) 0　未覆盖(NOT_COVERED) 0　未跑(NOT_RUN) 0
仅真实布局/动画才能量的检查：154 条（由本文件的十条覆盖，jsdom 层不冒充通过）
控制台错误：无

> 这些结果只描述 UI 呈现与交互，不写入业务验收账本，也不代表任何真实任务通过。

## 清单与源码同步

- A03：6 帧 → 0ms 在途：第一次读数挂着没回来 / 1600ms 读数回来：仍在途、确实零记录 / 3200ms 读数失败：错误与恢复入口在场 / 4800ms 读数恢复：错误消失、仍如实报在途 / 6400ms 旧读数迟到：挂起的是这一刻的新事实 / 8000ms 新读数已到：两条未结算，迟到的旧读数不许盖回来
- A03 末帧截图：tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/A03-f5.png（内容摘要已登记，旧图不会被当成新图）
- 多帧场景逐帧重拍：190 张，覆盖 145 条场景的 190 个声明帧

| 场景 | 名称 | 状态类型 | 挂载宿主 | 组件位置 | 结果 | 失败原因 | 截图 |
|---|---|---|---|---|---|---|---|
| A05 | 只有一行短回复 | 终态 | SESSION | AssistView → AssistMessageRow + SessionRoundTrace + ActivityRow | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/A05-f0.png |
| A01 | 新会话首次发送 | 在途 | SESSION | AssistView → AssistMessageRow + SessionRoundTrace + ActivityRow | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/A01-f0.png |
| A03 | AI 正在处理，尚未调用工具 | 在途 | SESSION | AssistView → AssistMessageRow + SessionRoundTrace + ActivityRow | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/A03-f5.png |
| A04 | AI 开始流式输出 | 流式 | SESSION | AssistView → AssistMessageRow + SessionRoundTrace + ActivityRow | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/A04-f2.png |
| X01 | 草稿被服务端截断 | 流式 | SESSION | AssistView → AssistMessageRow + SessionRoundTrace + ActivityRow | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/X01-f0.png |
| X02 | 草稿读取失败（不影响消息状态） | 失败 | SESSION | AssistView → AssistMessageRow + SessionRoundTrace + ActivityRow | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/X02-f0.png |
| A11 | 正在核对最终回复 | 在途 | SESSION | AssistView → AssistMessageRow + SessionRoundTrace + ActivityRow | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/A11-f0.png |
| A12 | 最终回复读取失败 | 未知 | SESSION | AssistView → AssistMessageRow + SessionRoundTrace + ActivityRow | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/A12-f0.png |
| A10 | 流式草稿转换为正式回复 | 终态 | SESSION | AssistView → AssistMessageRow + SessionRoundTrace + ActivityRow | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/A10-f1.png |
| A14 | AI 生成失败 | 失败 | SESSION | AssistView → AssistMessageRow + SessionRoundTrace + ActivityRow | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/A14-f0.png |
| A15 | AI 回复被取消 | 取消 | SESSION | AssistView → AssistMessageRow + SessionRoundTrace + ActivityRow | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/A15-f0.png |
| A13 | 已完成但无正文 | 边界 | SESSION | AssistView → AssistMessageRow + SessionRoundTrace + ActivityRow | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/A13-f0.png |
| X03 | 正文已结束、过程却有一项没结算 | 未知 | SESSION | AssistView → AssistMessageRow + SessionRoundTrace + ActivityRow | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/X03-f0.png |
| A16 | 用户查看历史消息后继续生成 | 呈现 | SESSION | AssistView → AssistMessageRow + SessionRoundTrace + ActivityRow | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/A16-f0.png |
| X04 | 撤回回执（逐文件回退结果） | 恢复 | SESSION | AssistView → AssistMessageRow + SessionRoundTrace + ActivityRow | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/X04-f0.png |
| X05 | 来源、用量与人设标签 | 呈现 | SESSION | AssistView → AssistMessageRow + SessionRoundTrace + ActivityRow | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/X05-f0.png |
| A02 | 消息已提交，等待处理 | 在途 | SESSION | AssistView → AssistMessageRow + SessionRoundTrace + ActivityRow | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/A02-f0.png |
| A06 | 多段长文本回复 | 终态 | SESSION | AssistView → AssistMessageRow + SessionRoundTrace + ActivityRow | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/A06-f0.png |
| A07 | Markdown 标题、列表、引用 | 呈现 | SESSION | AssistView → AssistMessageRow + SessionRoundTrace + ActivityRow | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/A07-f0.png |
| A08 | 代码块与复制 | 呈现 | SESSION | AssistView → AssistMessageRow + SessionRoundTrace + ActivityRow | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/A08-f0.png |
| A09 | Markdown 表格 | 呈现 | SESSION | AssistView → AssistMessageRow + SessionRoundTrace + ActivityRow | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/A09-f0.png |
| B01 | 读取单个文件 | 工具 | SESSION | AssistView → AssistMessageRow + SessionRoundTrace + ActivityRow | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/B01-f0.png |
| B03 | 列出目录 | 工具 | SESSION | AssistView → AssistMessageRow + SessionRoundTrace + ActivityRow | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/B03-f0.png |
| B04 | 搜索文件 | 工具 | SESSION | AssistView → AssistMessageRow + SessionRoundTrace + ActivityRow | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/B04-f0.png |
| B05 | 搜索文件内容 | 工具 | SESSION | AssistView → AssistMessageRow + SessionRoundTrace + ActivityRow | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/B05-f0.png |
| X06 | 读取变更集（独立的读类动作词） | 工具 | SESSION | AssistView → AssistMessageRow + SessionRoundTrace + ActivityRow | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/X06-f0.png |
| B06 | Git 状态查询 | 工具 | RUN_TRAJECTORY | RunToolTrajectoryPanel（Run 侧逐轮全量轨迹） | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/B06-f0.png |
| B07 | Git Diff 查询 | 工具 | RUN_TRAJECTORY | RunToolTrajectoryPanel（Run 侧逐轮全量轨迹） | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/B07-f0.png |
| B08 | Git 历史查询 | 工具 | RUN_TRAJECTORY | RunToolTrajectoryPanel（Run 侧逐轮全量轨迹） | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/B08-f0.png |
| B09 | 运行简单命令 | 工具 | RUN_SUMMARY | ExecutionTrajectorySummary + ChatLocalFileDiff（Run 侧摘要与局部增删行） | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/B09-f0.png |
| B14 | 命令非零退出码 | 失败 | RUN_SUMMARY | ExecutionTrajectorySummary + ChatLocalFileDiff（Run 侧摘要与局部增删行） | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/B14-f0.png |
| B17 | 命令输出截断 | 边界 | RUN_TRAJECTORY | RunToolTrajectoryPanel（Run 侧逐轮全量轨迹） | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/B17-f0.png |
| B15 | 命令超时 | 失败 | RUN_SUMMARY | ExecutionTrajectorySummary + ChatLocalFileDiff（Run 侧摘要与局部增删行） | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/B15-f0.png |
| B16 | 命令取消 | 取消 | RUN_SUMMARY | ExecutionTrajectorySummary + ChatLocalFileDiff（Run 侧摘要与局部增删行） | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/B16-f0.png |
| B19 | 桌面工具调用 | 工具 | SESSION | AssistView → AssistMessageRow + SessionRoundTrace + ActivityRow | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/B19-f0.png |
| X07 | 枚举窗口（没有对象参数） | 工具 | SESSION | AssistView → AssistMessageRow + SessionRoundTrace + ActivityRow | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/X07-f0.png |
| B21 | 未知或未适配的工具类型 | 边界 | SESSION | AssistView → AssistMessageRow + SessionRoundTrace + ActivityRow | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/B21-f0.png |
| B18 | 浏览器工具调用 | 工具 | SESSION | AssistView → AssistMessageRow + SessionRoundTrace + ActivityRow | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/B18-f0.png |
| X08 | 未登记的浏览器动作 | 边界 | SESSION | AssistView → AssistMessageRow + SessionRoundTrace + ActivityRow | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/X08-f0.png |
| B20 | GitHub/MCP 工具调用 | 工具 | SESSION | AssistView → AssistMessageRow + SessionRoundTrace + ActivityRow | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/B20-f0.png |
| B22 | 多工具交替调用 | 工具 | SESSION | AssistView → AssistMessageRow + SessionRoundTrace + ActivityRow | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/B22-f0.png |
| X09 | 简洁档：正常完成行收起，风险项保留 | 呈现 | SESSION | AssistView → AssistMessageRow + SessionRoundTrace + ActivityRow | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/X09-f0.png |
| X10 | 详细档：第三层技术详情默认展开 | 呈现 | SESSION | AssistView → AssistMessageRow + SessionRoundTrace + ActivityRow | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/X10-f0.png |
| B02 | 连续读取多个文件 | 工具 | SESSION | AssistView → AssistMessageRow + SessionRoundTrace + ActivityRow | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/B02-f0.png |
| B10 | 运行较长命令 | 工具 | RUN_TRAJECTORY | RunToolTrajectoryPanel（Run 侧逐轮全量轨迹） | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/B10-f0.png |
| B11 | 命令实时输出 | 在途 | RUN_TRAJECTORY | RunToolTrajectoryPanel（Run 侧逐轮全量轨迹） | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/B11-f1.png |
| B12 | 命令大量 stdout | 边界 | RUN_TRAJECTORY | RunToolTrajectoryPanel（Run 侧逐轮全量轨迹） | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/B12-f0.png |
| B13 | 命令包含 stderr | 失败 | RUN_TRAJECTORY | RunToolTrajectoryPanel（Run 侧逐轮全量轨迹） | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/B13-f0.png |
| C07 | 文件修改预览 | 写入 | RUN_SUMMARY | ExecutionTrajectorySummary + ChatLocalFileDiff（Run 侧摘要与局部增删行） | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/C07-f0.png |
| X11 | 预览目标未收全：删除侧不给数字 | 写入 | RUN_SUMMARY | ExecutionTrajectorySummary + ChatLocalFileDiff（Run 侧摘要与局部增删行） | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/X11-f0.png |
| X12 | 预览正文被截断：数字只是下界 | 边界 | RUN_SUMMARY | ExecutionTrajectorySummary + ChatLocalFileDiff（Run 侧摘要与局部增删行） | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/X12-f0.png |
| C08 | 等待写入审批 | 审批 | RUN_SUMMARY | ExecutionTrajectorySummary + ChatLocalFileDiff（Run 侧摘要与局部增删行） | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/C08-f0.png |
| X13 | 待批准且还没有预览：只列意图不给数字 | 审批 | RUN_SUMMARY | ExecutionTrajectorySummary + ChatLocalFileDiff（Run 侧摘要与局部增删行） | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/X13-f0.png |
| C01 | 修改单个文件 | 写入 | RUN_SUMMARY | ExecutionTrajectorySummary + ChatLocalFileDiff（Run 侧摘要与局部增删行） | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/C01-f0.png |
| C06 | 同一文件连续修改 | 写入 | RUN_SUMMARY | ExecutionTrajectorySummary + ChatLocalFileDiff（Run 侧摘要与局部增删行） | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/C06-f0.png |
| C02 | 新增文件 | 写入 | RUN_SUMMARY | ExecutionTrajectorySummary + ChatLocalFileDiff（Run 侧摘要与局部增删行） | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/C02-f0.png |
| C03 | 删除文件 | 写入 | RUN_SUMMARY | ExecutionTrajectorySummary + ChatLocalFileDiff（Run 侧摘要与局部增删行） | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/C03-f0.png |
| C10 | 文件写入失败 | 失败 | RUN_SUMMARY | ExecutionTrajectorySummary + ChatLocalFileDiff（Run 侧摘要与局部增删行） | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/C10-f0.png |
| X14 | 基线冲突（CONFLICT） | 失败 | RUN_SUMMARY | ExecutionTrajectorySummary + ChatLocalFileDiff（Run 侧摘要与局部增删行） | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/X14-f0.png |
| C12 | 文件变更结果未知 | 未知 | RUN_SUMMARY | ExecutionTrajectorySummary + ChatLocalFileDiff（Run 侧摘要与局部增删行） | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/C12-f0.png |
| X15 | 二进制内容：不可统计就不给行数 | 边界 | RUN_SUMMARY | ExecutionTrajectorySummary + ChatLocalFileDiff（Run 侧摘要与局部增删行） | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/X15-f0.png |
| X16 | 账本给 -1（待核对）：绝不折算成 +0 −0 | 未知 | RUN_SUMMARY | ExecutionTrajectorySummary + ChatLocalFileDiff（Run 侧摘要与局部增删行） | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/X16-f0.png |
| X17 | 已结算但没有逐文件账本：不编文件行 | 未知 | RUN_SUMMARY | ExecutionTrajectorySummary + ChatLocalFileDiff（Run 侧摘要与局部增删行） | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/X17-f0.png |
| C13 | Diff 展开与折叠 | 写入 | RUN_SUMMARY | ExecutionTrajectorySummary + ChatLocalFileDiff（Run 侧摘要与局部增删行） | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/C13-f0.png |
| X18 | 差异文本不可用：保留摘要，不补造基线 | 未知 | DIFF | FileWriteFrozenDiffPanel（冻结计划文本差异） | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/X18-f0.png |
| C04 | 修改多行代码 | 写入 | DIFF | FileWriteFrozenDiffPanel（冻结计划文本差异） | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/C04-f0.png |
| C05 | 多文件修改 | 写入 | RUN_SUMMARY | ExecutionTrajectorySummary + ChatLocalFileDiff（Run 侧摘要与局部增删行） | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/C05-f0.png |
| C09 | 写入完成但验证尚未进行 | 写入 | RUN_SUMMARY | ExecutionTrajectorySummary + ChatLocalFileDiff（Run 侧摘要与局部增删行） | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/C09-f0.png |
| C11 | 修改被拒绝 | 审批 | RUN_SUMMARY | ExecutionTrajectorySummary + ChatLocalFileDiff（Run 侧摘要与局部增删行） | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/C11-f0.png |
| C14 | 大型 Diff | 边界 | DIFF | FileWriteFrozenDiffPanel（冻结计划文本差异） | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/C14-f0.png |
| C15 | 文件编辑后运行测试 | 工具 | RUN_SUMMARY | ExecutionTrajectorySummary + ChatLocalFileDiff（Run 侧摘要与局部增删行） | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/C15-f0.png |
| C16 | 验证通过（界面只说已结算 + 退出码 0） | 终态 | RUN_SUMMARY | ExecutionTrajectorySummary + ChatLocalFileDiff（Run 侧摘要与局部增删行） | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/C16-f0.png |
| C17 | 验证失败 | 失败 | RUN_SUMMARY | ExecutionTrajectorySummary + ChatLocalFileDiff（Run 侧摘要与局部增删行） | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/C17-f0.png |
| D04 | 工具已请求但未结算 | 在途 | SESSION | AssistView → AssistMessageRow + SessionRoundTrace + ActivityRow | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/D04-f0.png |
| X19 | 工具已请求（Run 侧措辞与会话侧不同） | 在途 | RUN_TRAJECTORY | RunToolTrajectoryPanel（Run 侧逐轮全量轨迹） | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/X19-f0.png |
| D05 | 工具已准备但未执行 | 在途 | RUN_TRAJECTORY | RunToolTrajectoryPanel（Run 侧逐轮全量轨迹） | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/D05-f0.png |
| D06 | 工具等待审批 | 审批 | RUN_TRAJECTORY | RunToolTrajectoryPanel（Run 侧逐轮全量轨迹） | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/D06-f0.png |
| X20 | 工具等待审批（摘要侧给去原审批的入口） | 审批 | RUN_SUMMARY | ExecutionTrajectorySummary + ChatLocalFileDiff（Run 侧摘要与局部增删行） | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/X20-f0.png |
| X21 | 工具已结算（会话侧只说已结算，不说成功） | 终态 | SESSION | AssistView → AssistMessageRow + SessionRoundTrace + ActivityRow | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/X21-f0.png |
| D10 | 工具已结算但成功性未知 | 未知 | RUN_SUMMARY | ExecutionTrajectorySummary + ChatLocalFileDiff（Run 侧摘要与局部增删行） | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/D10-f0.png |
| D11 | 工具实际执行失败 | 失败 | RUN_SUMMARY | ExecutionTrajectorySummary + ChatLocalFileDiff（Run 侧摘要与局部增删行） | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/D11-f0.png |
| D07 | 工具审批被拒绝 | 失败 | SESSION | AssistView → AssistMessageRow + SessionRoundTrace + ActivityRow | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/D07-f0.png |
| X22 | 工具审批被拒绝（Run 轨迹侧措辞与活动行不一致） | 失败 | RUN_TRAJECTORY | RunToolTrajectoryPanel（Run 侧逐轮全量轨迹） | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/X22-f0.png |
| D08 | 工具已放弃 | 取消 | SESSION | AssistView → AssistMessageRow + SessionRoundTrace + ActivityRow | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/D08-f0.png |
| D09 | 工具结果未知 | 未知 | SESSION | AssistView → AssistMessageRow + SessionRoundTrace + ActivityRow | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/D09-f0.png |
| X23 | 审批已过期：未执行，不沿用旧批准 | 审批 | RUN_TRAJECTORY | RunToolTrajectoryPanel（Run 侧逐轮全量轨迹） | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/X23-f0.png |
| X24 | 批准之后：已批准也不代表已执行 | 审批 | RUN_TRAJECTORY | RunToolTrajectoryPanel（Run 侧逐轮全量轨迹） | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/X24-f0.png |
| X25 | 审批记录读不到：说无法确认，不显示已批准 | 失败 | RUN_TRAJECTORY | RunToolTrajectoryPanel（Run 侧逐轮全量轨迹） | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/X25-f0.png |
| X26 | Run 终态但仍有未结算调用 | 未知 | RUN_TRAJECTORY | RunToolTrajectoryPanel（Run 侧逐轮全量轨迹） | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/X26-f0.png |
| D01 | 正在执行第一项工具 | 在途 | RUN_TRAJECTORY | RunToolTrajectoryPanel（Run 侧逐轮全量轨迹） | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/D01-f1.png |
| D02 | 连续执行多个工具 | 工具 | SESSION | AssistView → AssistMessageRow + SessionRoundTrace + ActivityRow | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/D02-f0.png |
| D03 | 已结算部分，工具仍在执行 | 在途 | RUN_TRAJECTORY | RunToolTrajectoryPanel（Run 侧逐轮全量轨迹） | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/D03-f0.png |
| D12 | 整轮执行已结束 | 终态 | RUN_TRAJECTORY | RunToolTrajectoryPanel（Run 侧逐轮全量轨迹） | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/D12-f0.png |
| D13 | Run 执行失败 | 失败 | RUN_TRAJECTORY | RunToolTrajectoryPanel（Run 侧逐轮全量轨迹） | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/D13-f0.png |
| D14 | Run 已取消 | 取消 | RUN_TRAJECTORY | RunToolTrajectoryPanel（Run 侧逐轮全量轨迹） | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/D14-f0.png |
| D15 | 工具轨迹跨多个轮次 | 工具 | RUN_TRAJECTORY | RunToolTrajectoryPanel（Run 侧逐轮全量轨迹） | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/D15-f0.png |
| D16 | Run 与会话的关联轨迹 | 工具 | LINK | AssistMessageRow + ExecutionTrajectorySummary（会话侧与 Run 侧同一轮的两处投影） | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/D16-f0.png |
| E01 | 工具轨迹读取 404 | 失败 | SESSION | AssistView → AssistMessageRow + SessionRoundTrace + ActivityRow | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/E01-f0.png |
| E14 | 重试读取成功 | 恢复 | SESSION | AssistView → AssistMessageRow + SessionRoundTrace + ActivityRow | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/E14-f1.png |
| E03 | 网络请求超时 | 失败 | SESSION | AssistView → AssistMessageRow + SessionRoundTrace + ActivityRow | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/E03-f0.png |
| X27 | 生成预览读取失败（草稿留在原位） | 流式 | SESSION | AssistView → AssistMessageRow + SessionRoundTrace + ActivityRow | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/X27-f1.png |
| E10 | 返回身份不匹配：整份丢弃 | 失败 | RUN_TRAJECTORY | RunToolTrajectoryPanel（Run 侧逐轮全量轨迹） | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/E10-f0.png |
| E04 | SSE 中断 | 恢复 | RUN_TRAJECTORY | RunToolTrajectoryPanel（Run 侧逐轮全量轨迹） | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/E04-f0.png |
| E09 | 迟到的旧响应 | 终态 | RUN_SUMMARY | ExecutionTrajectorySummary + ChatLocalFileDiff（Run 侧摘要与局部增删行） | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/E09-f0.png |
| X28 | 读到空轮次不抹掉已经见过的步骤 | 恢复 | SESSION | AssistView → AssistMessageRow + SessionRoundTrace + ActivityRow | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/X28-f1.png |
| E11 | 空工具轨迹 | 终态 | SESSION | AssistView → AssistMessageRow + SessionRoundTrace + ActivityRow | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/E11-f0.png |
| X29 | Run 摘要读取失败：说读不到，不说没调用工具 | 失败 | RUN_SUMMARY | ExecutionTrajectorySummary + ChatLocalFileDiff（Run 侧摘要与局部增删行） | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/X29-f0.png |
| X30 | 冻结正文读不到（失权）：不补造正文 | 失败 | RUN_SUMMARY | ExecutionTrajectorySummary + ChatLocalFileDiff（Run 侧摘要与局部增删行） | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/X30-f0.png |
| X31 | 预览读取失败：保留上一次数字，不闪回零 | 在途 | RUN_SUMMARY | ExecutionTrajectorySummary + ChatLocalFileDiff（Run 侧摘要与局部增删行） | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/X31-f1.png |
| E07 | 重复事件：同一身份只渲染一行 | 未知 | RUN_TRAJECTORY | RunToolTrajectoryPanel（Run 侧逐轮全量轨迹） | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/E07-f0.png |
| E02 | 工具轨迹读取 500 | 失败 | RUN_TRAJECTORY | RunToolTrajectoryPanel（Run 侧逐轮全量轨迹） | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/E02-f0.png |
| E05 | SSE 恢复 | 恢复 | RUN_TRAJECTORY | RunToolTrajectoryPanel（Run 侧逐轮全量轨迹） | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/E05-f1.png |
| E06 | 轮询回退 | 恢复 | RUN_TRAJECTORY | RunToolTrajectoryPanel（Run 侧逐轮全量轨迹） | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/E06-f1.png |
| E08 | 事件乱序 | 未知 | RUN_TRAJECTORY | RunToolTrajectoryPanel（Run 侧逐轮全量轨迹） | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/E08-f0.png |
| E12 | 工具轨迹部分可用 | 未知 | RUN_SUMMARY | ExecutionTrajectorySummary + ChatLocalFileDiff（Run 侧摘要与局部增删行） | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/E12-f0.png |
| E13 | 最终正文重读失败 | 未知 | SESSION | AssistView → AssistMessageRow + SessionRoundTrace + ActivityRow | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/E13-f1.png |
| E15 | 取消请求待确认 | 在途 | SESSION | AssistView → AssistMessageRow + SessionRoundTrace + ActivityRow | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/E15-f0.png |
| E16 | 用户拒绝审批 | 审批 | RUN_TRAJECTORY | RunToolTrajectoryPanel（Run 侧逐轮全量轨迹） | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/E16-f1.png |
| E17 | 等待审批期间刷新页面 | 审批 | RUN_TRAJECTORY | RunToolTrajectoryPanel（Run 侧逐轮全量轨迹） | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/E17-f1.png |
| F01 | 20 次工具调用 | 边界 | SESSION | AssistView → AssistMessageRow + SessionRoundTrace + ActivityRow | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/F01-f0.png |
| F02 | 50 次工具调用 | 边界 | SESSION | AssistView → AssistMessageRow + SessionRoundTrace + ActivityRow | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/F02-f0.png |
| F03 | 100 次工具调用 | 边界 | RUN_TRAJECTORY | RunToolTrajectoryPanel（Run 侧逐轮全量轨迹） | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/F03-f0.png |
| F04 | 300 次工具调用 | 边界 | RUN_TRAJECTORY | RunToolTrajectoryPanel（Run 侧逐轮全量轨迹） | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/F04-f0.png |
| F05 | 多轮工具执行 | 边界 | RUN_TRAJECTORY | RunToolTrajectoryPanel（Run 侧逐轮全量轨迹） | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/F05-f0.png |
| F07 | 超长文件路径 | 边界 | SESSION | AssistView → AssistMessageRow + SessionRoundTrace + ActivityRow | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/F07-f0.png |
| F08 | 超长命令 | 边界 | RUN_SUMMARY | ExecutionTrajectorySummary + ChatLocalFileDiff（Run 侧摘要与局部增删行） | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/F08-f0.png |
| F09 | 超长终端输出 | 边界 | RUN_TRAJECTORY | RunToolTrajectoryPanel（Run 侧逐轮全量轨迹） | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/F09-f0.png |
| F10 | 超长 Markdown | 边界 | SESSION | AssistView → AssistMessageRow + SessionRoundTrace + ActivityRow | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/F10-f0.png |
| F11 | 中文和英文混排 | 边界 | SESSION | AssistView → AssistMessageRow + SessionRoundTrace + ActivityRow | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/F11-f0.png |
| F12 | 表格与代码块混排 | 边界 | SESSION | AssistView → AssistMessageRow + SessionRoundTrace + ActivityRow | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/F12-f0.png |
| F13 | 用户向上滚动时继续生成 | 流式 | SESSION | AssistView → AssistMessageRow + SessionRoundTrace + ActivityRow | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/F13-f1.png |
| F14 | 展开详情后继续更新 | 在途 | RUN_TRAJECTORY | RunToolTrajectoryPanel（Run 侧逐轮全量轨迹） | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/F14-f1.png |
| F15 | 历史消息刷新恢复 | 恢复 | SESSION | AssistView → AssistMessageRow + SessionRoundTrace + ActivityRow | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/F15-f1.png |
| F16 | 快速切换会话 | 边界 | SESSION | AssistView → AssistMessageRow + SessionRoundTrace + ActivityRow | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/F16-f3.png |
| F17 | 快速展开/收起 | 呈现 | SESSION | AssistView → AssistMessageRow + SessionRoundTrace + ActivityRow | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/F17-f0.png |
| F18 | 小窗口与高 DPI | 边界 | SESSION | AssistView → AssistMessageRow + SessionRoundTrace + ActivityRow | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/F18-f0.png |
| F19 | reduced-motion | 呈现 | SESSION | AssistView → AssistMessageRow + SessionRoundTrace + ActivityRow | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/F19-f0.png |
| F20 | 深色/浅色主题 | 呈现 | SESSION | AssistView → AssistMessageRow + SessionRoundTrace + ActivityRow | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/F20-f0.png |
| F06 | 多文件变更摘要 | 边界 | RUN_SUMMARY | ExecutionTrajectorySummary + ChatLocalFileDiff（Run 侧摘要与局部增删行） | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/F06-f0.png |
| G01 | 正常开发任务（读 → 改 → 验证 → 回复） | 工具 | LINK | AssistMessageRow + ExecutionTrajectorySummary（会话侧与 Run 侧同一轮的两处投影） | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/G01-f5.png |
| G02 | 命令失败并如实停在失败 | 失败 | LINK | AssistMessageRow + ExecutionTrajectorySummary（会话侧与 Run 侧同一轮的两处投影） | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/G02-f3.png |
| G03 | 审批等待与批准 | 审批 | RUN_SUMMARY | ExecutionTrajectorySummary + ChatLocalFileDiff（Run 侧摘要与局部增删行） | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/G03-f2.png |
| G04 | 网络中断与恢复 | 恢复 | SESSION | AssistView → AssistMessageRow + SessionRoundTrace + ActivityRow | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/G04-f3.png |
| G05 | 长任务（多轮、逐项落账） | 工具 | RUN_TRAJECTORY | RunToolTrajectoryPanel（Run 侧逐轮全量轨迹） | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/G05-f3.png |
| G06 | 纯文本回复（无工具、无空白交接帧） | 流式 | SESSION | AssistView → AssistMessageRow + SessionRoundTrace + ActivityRow | 通过 |  | tmp/acceptance/agent-ui-final-closure/results-scenario-lab/screenshots/G06-f4.png |

## 十条只能由真实浏览器判定的性质

| 性质 | 判定入口 | 实测 |
|---|---|---|
| ① 元素与状态一一对应 | `assistScenarioLab.spec.ts` ① | D04/D05/D06/D07/D08/D09/D14 的状态属性与状态词逐条对上 |
| ② 展开与折叠稳定 | ② | 点入口翻转、展开所有/收起所有回到同一入口 |
| ③ 不产生无效成功标记 | ③ | 失败/未知/被拒先确认标记在场，再要求界面不宣布成功；A14 不渲染完成正文 |
| ④ 不出现重复工具行 | ④ | E07/F01/C05 按行身份去重；E07 仍明说服务端给了重复记录 |
| ⑤ 状态切换不卸载整块组件 | ⑤ | G01 逐帧推进后消息行仍是同一 DOM 节点 |
| ⑥ 流式回复无空白交接帧 | ⑥ | A10 共 2 帧，回复位为空的帧 0 个、未挂载的帧 0 个；档位序列 verifying → final（无第四档、落位后不回退） |
| ⑦ 动效开启只有一个主进度 | ⑦ | D04 在途时 `data-current` 恰一、转动指示恰一 |
| ⑧ 动效关闭受控动画停止 | ⑧ | 关闭后转动指示为 0，且正文一条不少 |
| ⑨ 长内容无页面级横向溢出 | ⑨ | F03/F07/F08/F09/F10/F12 在 1280 / 720 / 390 三档下页面横向溢出为 0 |
| ⑩ 用户上滚后位置稳定 | ⑩ | 会话流（F13，判定 PASS）：会话流（F13）：锚点行位移 0px、滚动位置变化 0px（正文 257→435 字）；Run 轨迹面板（G05，判定 PASS）：Run 轨迹面板（G05）：锚点行位移 0px、滚动位置变化 19px（顶部状态行 58→76px） |

## 六条可播放流程的逐帧留影

- **G01**（正常开发任务（读 → 改 → 验证 → 回复））：6 帧 → 1. 提交：还没有任何工具调用 / 2. 第 1 项读取结算 / 3. 第 2 项结算，第 3 项刚请求出去 / 4. 三处读完，写入参数还在流式生成（临时预览） / 5. 写入结算：预览行换成落账行，临时预览清空 / 6. 检查结算，正文落定
- **G02**（命令失败并如实停在失败）：4 帧 → 1. 命令请求已发出 / 2. 回执：退出码 1，三条用例没过 / 3. 再跑一次仍失败，Run 停下等人工决定 / 4. 正文说明停在哪里
- **G03**（审批等待与批准）：3 帧 → 1. 写入参数还在生成 / 2. 冻结完成，等待你批准 / 3. 批准之后落盘
- **G04**（网络中断与恢复）：4 帧 → 1. 草稿正常推进（v3，40%） / 2. 预览读取连续失败 / 3. 恢复：草稿回到原位并继续增长（v8，75%） / 4. 正文读回，同一位置落定
- **G05**（长任务（多轮、逐项落账））：4 帧 → 1. 第 0 轮三项读完 / 2. 第 1 轮开始：四项里两项已结算 / 3. 第 1 轮收尾，第 2 轮五项全部结算 / 4. Run 进入终态
- **G06**（纯文本回复（无工具、无空白交接帧））：5 帧 → 1. 刚提交（PENDING） / 2. 开始流式输出（v1，20%） / 3. 草稿继续（v5，60%） / 4. 预览判终态、正文还没读回（SETTLING） / 5. 正文读回，同一位置落定

## 实测发现（与「场景是否生成」无关）

1. **Run 轨迹面板的阅读位置**（判定 PASS，数字来自 panel-shift.json，不是推断）：G05 逐帧推进时，面板顶部那一行 [data-testid='trajectory-source-run'] 由 58px 长到 76px（Run 状态换措辞后多占一行），Run 轨迹面板（G05）：锚点行位移 0px、滚动位置变化 19px。会话流一侧：会话流（F13）：锚点行位移 0px、滚动位置变化 0px。顶部状态行变高不再推移正在阅读的轨迹行。
2. **产品没有深色主题**：实验室的暗档只是外壳反相颜色变量（见 ScenarioLab.css 的注释），F20 用它验证「暗底上结构一个不少」，不能当作产品支持主题切换的证据。
3. **X03 摘要与行事实**（场景判定 pass）：正文 COMPLETED 而工具仍 REQUESTED 时，摘要必须写出仍有未结算项，且不得宣布「已结束 / 全部完成 / 成功」——这条由 X03 场景自身的断言守住。
4. **A03 的加载分支**（场景判定 pass，当前清单 6 帧）：已由受控读层的挂起/释放能力在真实浏览器里覆盖；六帧分别对应挂起、释放、失败、恢复、迟到旧读数与新读数。
5. **状态口径**：通过 145、失败 0、未覆盖 0、未跑 0（报告只写实测判定：未跑不补数字，读数不可判一律记 NOT_RUN）。

## 修复前历史证据（不属于当前问题，仅留档）

- G05：修复前 panel-shift.json 记录 anchorShiftPx = 19、scrollTopShiftPx = 0，顶部状态行 58→76px，即状态行变长时滚动位置当时完全没有补偿。该现象已由 RunToolTrajectoryPanel 的滚动锚点补偿修掉，并由 assistScenarioLab.spec.ts「⑩-补」的位移断言钗住（撤销修复会失败）。
- X03：修复前摘要头部对「正文已结束 + 工具 REQUESTED」写「N 项操作 · 已结束」，读起来像全部结清。该口径已由 activityPresentation.ts 的 UNSETTLED 相位修掉（改报「仍有 N 项未结算」）。
- 以上两条只出现在本留档区，不得再作为当前问题出现在「实测发现」里。

## 日志与证据引用

- 批量判定原始数据：`D:/Develop/Relay-Agent/tmp/acceptance/agent-ui-final-closure/results-scenario-lab/browser-verdicts.json`
- 逐条静态断言（jsdom，145 条）：`apps/workbench/tests/scenarioLabMatrix.spec.tsx`
- 十条浏览器性质：`apps/workbench/tests/browser/assistScenarioLab.spec.ts`
- 截图批量：`apps/workbench/tests/browser/assistScenarioLabShots.spec.ts`
- 流式逐帧读数：`results/scenario-lab/stream-frames.json`；上滚位置实测：`scroll-stability.json` / `panel-shift.json`
- 生产隔离：`node apps/workbench/scripts/check-scenario-lab-isolation.mjs`（开发/生产各构建一次：开发构建必须搜得到实验室串，生产构建必须一个字都搜不到；证据 `results/scenario-lab/isolation.json`）