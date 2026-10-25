# Goal 与 Project 基础维护 API

状态：后端接口已实现；实际验收范围归[统一验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)。更新：2026-10-17。

本页定义编辑 Goal、归档 Goal 和修改 Project 标题的写入口。Goal 的标题/说明仍是 Goal 自身的当前事实；归档保留所有引用及历史。Project 改名只更新展示标题，不修改项目类型、ProjectState 或关联事实。

**Breaking Change: No。** 本次新增命令端点，不改变既有请求与响应，不增加表、字段或迁移。所有命令使用现有 Workspace 范围、CAS revision、幂等回执和 Activity 记录。

## 编辑 Goal

`POST /api/v1/workspaces/{workspace_id}/goals/{goal_id}/revisions`

```json
{
  "command_id": "…",
  "expected_revision": "3",
  "title": "完成毕业论文",
  "description": "完成实验并整理结论"
}
```

标题沿用 `goalTitle` 上限 200；说明沿用 `goalDescription` 上限 2000。说明必须提交，空字符串可用于清空；标题不能为空。成功返回 200：

```json
{
  "command_id": "…", "committed_at": "…",
  "result": { "goal_id": "…", "title": "完成毕业论文", "description": "完成实验并整理结论", "status": "ACTIVE", "revision": "4" },
  "links": { "resource": "/api/v1/workspaces/{workspace_id}/goals/{goal_id}" }
}
```

归档目标不能编辑（409）。revision 不匹配返回既有 `REVISION_CONFLICT`（409）；不存在或跨 Workspace 的 Goal 返回 404；字段校验失败返回 422。相同 `command_id` 和相同载荷重放原回执，即使 Goal 后来继续变化；相同 ID 配不同载荷返回 `COMMAND_ID_REUSED`（409）。

## 归档 Goal

`POST /api/v1/workspaces/{workspace_id}/goals/{goal_id}/archive`

请求为 `{ "command_id": "…", "expected_revision": "4" }`。成功返回 200，结果为 `{ "goal_id": "…", "status": "ARCHIVED", "revision": "5" }`，资源链接仍指向原 Goal GET。

归档只更新 Goal 的状态、revision 和更新时间。原 Goal ID、Project 关联、Task 显式对齐、会话、Task/Run 与成果历史均保留。默认 Goal 列表不再包含它，`status=archived` 与 `status=all` 可读；单读及 work-context 返回真实归档状态。新建 Project–Goal 关联若 Goal 已归档返回 409，既有关系仍可按原命令解除。新命令重复归档返回 409；原归档命令的相同载荷重放返回原回执；归档后编辑返回 409。

## 修改 Project 标题

`PATCH /api/v1/workspaces/{workspace_id}/projects/{project_id}`

请求为 `{ "command_id": "…", "expected_revision": "2", "title": "论文实验项目" }`。只接受这三个字段，标题沿用 `title` 上限 200，未知字段拒绝。成功返回 200，结果 `{ "project_id": "…", "title": "论文实验项目", "revision": "3" }`，资源链接指向原 Project GET。

已归档 Project 沿用 `PROJECT_ARCHIVED`（409）；revision 冲突返回既有 `REVISION_CONFLICT`（409）；不存在或跨 Workspace 的 Project 返回 404；无效标题返回 422。改名不修改 `project_type`、ProjectState、Goal 关联、目录、会话、Task 验收或 Run。相同 command ID 和载荷重放原回执；旧 revision 或载荷冲突按既有错误处理。

三条命令各在同一短事务中保存业务变化、对应 Activity 和回执；审计只记录必要引用，不复制完整 Goal 说明。实现使用现有行与 revision，不创建 Goal 版本表；Goal 标题与说明是原位 CAS 修改，不是 Artifact 式不可变版本。

## 工作台入口（2026-10-24）

正式 Goal 的列表（`/goals`，支持 Active/Archived/All 与游标）、详情（`/goals/:id`）、编辑、归档、解除关联与 Project 改名已接入工作台；入口在项目页「目标列表」，不新增一级导航。详情页在解除前调用 `GET /projects/:id/goals` 展示 `explicit_task_ids`，提交时携带 `expected_impacted_task_ids`；服务端清单变化返回 409 `GOAL_LINK_IN_USE` 与当前 `impacted_task_ids`，界面重读并要求再次确认。编辑/归档/解除与改名都冻结 `command_id` 与载荷，结果不明先查回执。实现与测试边界归[工作台 §51](../frontend/workbench-design.md#51-正式目标管理与项目状态写入2026-10-24已实施实机未验)与[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)。
