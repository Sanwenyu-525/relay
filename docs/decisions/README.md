# 架构决策路由

角色：按决策主题定位 ADR；状态和替代关系只在各 ADR 正文维护。本索引不统一批准决策，也不代表已实现或已验收。[返回文档入口](../README.md)。

| 决策 | 入口 |
|---|---|
| ADR-001：领域独立写入，应用层协调跨聚合事务 | [正文](ADR-001-domain-boundaries.md) |
| ADR-002：以 PostgreSQL 和显式 JDBC 作为推荐持久化方案 | [正文](ADR-002-postgresql-jdbc.md) |
| ADR-003：V1 使用同机浏览器工作台 | [正文](ADR-003-browser-workbench.md) |
| ADR-004：显式资料导入使用独立调用来源 | [正文](ADR-004-user-import-origin.md) |
| ADR-005：成熟实现优先复用，业务契约驱动适配 | [正文](ADR-005-reuse-first.md) |
| ADR-006：TypeScript-first 与按需 Python 工具层 | [正文](ADR-006-typescript-first.md) |
| ADR-007：Windows 桌面交付与本机服务边界 | [正文](ADR-007-windows-desktop.md) |
| ADR-008：声明式 Relay Skill 复用既有执行与提案机制 | [正文](ADR-008-declarative-skills.md) |
| ADR-009：P10 使用 Workspace 级 Rule 版本栅栏 | [正文](ADR-009-rule-revision-fence.md) |
| ADR-010：适配现有工程的 Agent 栈与 React 桌面迁移 | [正文](ADR-010-agent-stack-react-desktop.md) |
| ADR-011：Project 归档采用行锁栅栏与持久事实负面准入 | [正文](ADR-011-project-archive-serialization.md) |
| ADR-012：Windows 文件动作的句柄边界 | [正文](ADR-012-windows-file-io-handle-boundary.md) |
| ADR-013：长期协作通过既有领域入口实现有限连续委托 | [正文](ADR-013-bounded-project-continuation.md) |
| ADR-014：维护排空采用数据库级持久准入门 | [正文](ADR-014-database-maintenance-admission.md) |
| ADR-015：Windows 受管内容由实际原生写者持发布锁 | [正文](ADR-015-managed-content-native-publication.md) |
| ADR-016：文件夹入口与对话直接执行 | [正文](ADR-016-folder-first-conversation.md) |
| ADR-017：有界多 Agent 与自动主子会话 | [正文](ADR-017-bounded-multi-agent-conversations.md) |
| ADR-018：会话模式与人设助手会话 | [正文](ADR-018-assistant-conversations.md) |
| ADR-019：内置工作方法、命令与会话检查点 | [正文](ADR-019-builtin-methods-and-conversation-checkpoints.md) |
| ADR-020：学习模式的会话身份与个人学习记录协议 | [正文](ADR-020-learning-mode-record-protocol.md) |
| ADR-021：有限任务链复用原准入与完成 Owner | [正文](ADR-021-bounded-task-chain-admission.md) |
| ADR-022：普通 Agent 采用连续工具主流程 | [正文](ADR-022-agent-conversation-main-loop.md) |
| ADR-023：内置官方 GitHub Skill 进入 V1 主线 | [正文](ADR-023-builtin-github-skill.md) |
| ADR-024：内置浏览器自动化后端与能力边界 | [正文](ADR-024-builtin-browser-automation.md) |
| ADR-025：浏览器自动化改为「用户现有 Chrome + 扩展桥接」 | [正文](ADR-025-extension-bridge.md) |
| ADR-026：周期定时启动任务复用原准入与执行 Owner | [正文](ADR-026-scheduled-task-autostart.md) |
| ADR-027：会话物理删除及其保留边界 | [正文](ADR-027-session-physical-delete.md) |
| ADR-028：长期事实与短期会话记忆分层 | [正文](ADR-028-memory-layers.md) |
| ADR-029：长期记忆的自动候选提取（人工确认不变） | [正文](ADR-029-auto-memory-candidates.md) |
| ADR-030：零点击的自动记忆（自动生效、可撤销、明确标注） | [正文](ADR-030-zero-click-auto-memory.md) |
| ADR-031：会话内直接写文件（新增 AGENT_SESSION_WRITE 来源） | [正文](ADR-031-session-direct-write.md) |
| ADR-032：记忆条目的来源类别与「由系统判断要不要记」 | [正文](ADR-032-memory-source-kind.md) |
| ADR-033：外部 Agent 通过共享任务参与项目协作 | [正文](ADR-033-external-agent-shared-tasks.md) |
| ADR-034：项目级长期 Agent 成员与跨会话协作 | [正文](ADR-034-persistent-project-agent-team.md) |
| ADR-035：右侧内置网页预览使用 Tauri 原生子 WebView | [正文](ADR-035-in-app-webview-preview.md) |
| ADR-036：多 Provider 模型连接管理的数据模型与凭据存储前提（Proposed，未实现） | [正文](ADR-036-multi-provider-model-connections.md) |
| ADR-037：上下文档位归属会话，用量分项按真实请求采集 | [正文](ADR-037-session-context-budget.md) |

修改重要取舍时保留旧 ADR，标明 Accepted / Proposed / Superseded 等实际状态及接续链接；索引只同步标题与路径。
