-- 会话行内控制接续：未读标记（工作台 §28.1、HTTP §10.87、物理设计 §94）。
-- 2026-10-17，源码实现。仅追加一列，不改写任何既有迁移、不回填、不动消息/提案/选择表。
--
-- 这一列与 0090 的 pinned_at 同一性质：**近期工作栏的导航偏好，不是业务事实**。
-- 会话能不能发消息、绑定哪个目录、归哪个项目都仍由既有列与既有 Owner 决定；
-- 未读不参与排序，也不改变任何准入判定。
--
-- 上游对照：Codex 的会话列表没有未读概念（threads 表 59 个迁移无该列，最接近的
-- has_user_event 只是过滤标记）；DeepSeek Harness 的 completionUnread 是内存 Set，重启即丢；
-- 只有 ZCode 把它持久化为 unread_at（NULL=已读）+ last_unread_at 单调版本做 CAS 清除。
-- 本列采纳 ZCode 的「NULL=已读」读法；单调版本与「点开即清」本轮不做——
-- 当前只有人工 toggle 一个写入方，同毫秒碰撞的窗口不存在（见下方 CAS 说明）。

-- NULL = 已读；有值 = 于该时刻被标记为未读。取消未读即写回 NULL，
-- 不在表里留「曾经未读」的历史——它是可调的标记，每一次改动都留在命令回执与审计里。
ALTER TABLE assist_sessions ADD COLUMN unread_at timestamptz NULL;

-- 权限：0015 已对 assist_sessions 授表级 SELECT/INSERT/UPDATE，新列自动在既有授权范围内，
-- 因此这里不追加 GRANT（表级授权覆盖新列）。应用角色仍无 DELETE。
--
-- CAS 说明：写入仍走 0090 那条 applySessionControl 的 `where revision = 期望值`，
-- 修订号本身就是并发裁决点，不需要第二枚单调列；只有「点开自动清除」这类
-- 由后台事件并发写入的路径才需要 expected_unread_at，那属于另一轮决定。
--
-- 索引：不为本列新建索引。单用户本机库会话量级小，且未读不作筛选条件、只作行内标记，
-- 加索引只增维护面（与 0090 对 pinned_at 的判断一致）。
--
-- 兼容与回滚：纯追加一列，旧行取 NULL（已读），既有响应与旧客户端不受影响，
-- Breaking Change: No。回退可直接保留该列（旧代码不读）；删除该列只丢失未读标记，
-- 不丢失任何会话、消息、回执或选择事实。
