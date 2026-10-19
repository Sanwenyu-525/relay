-- 会话物理删除的应用角色权限（ADR-027、HTTP §10.94、物理设计 §103）。
-- 2026-10-18，源码实现。只追加 GRANT，不改表结构、不加 ON DELETE CASCADE、不回填。
--
-- 背景：用户要求「会话删除」是真删除且不可撤销。应用角色此前对 assist_sessions 及其子表
-- 只有 SELECT/INSERT/UPDATE，指向会话的外键又全是默认 NO ACTION（全库只有 0044 与 0100
-- 两处显式动作，均与会话无关），因此删除必须在仓储层按「子 → 父」逐表显式执行。
-- 这里只补那批表缺的 DELETE；已有 DELETE 的 assist_message_previews（0028）与
-- learning_*（0072）不重复授予，也不在本次删除路径里。
--
-- 授权范围与服务用例一一对应，逐表理由：
--   assist_sessions / assist_messages / assist_proposals  —— 会话行与其正文、提案
--   assist_message_attachments                            —— 附件内容存 bytea，随行消失
--   session_tool_calls                                    —— 会话内只读工具调用账本
--   session_model_selection                               —— 会话模型选择快照
--   artifact_impact_checks / artifact_impact_candidates    —— 未进入组合检查的影响检查
--   artifact_impact_candidate_groups / ..._group_items     —— 上述检查的候选分组
--   conversation_state_requests / conversation_state_changes —— 自然语言状态维护请求
--   model_calls                                            —— 该会话的 ASSIST 外呼计量
--   model_provider_cooldowns                               —— 已到期、仍指向这些调用的冷却证据
--   conversation_diff_baselines                            —— session_id 是普通列（0097 无外键），
--                                                             不显式删就会留下悬空账本
--
-- 刻意**不**授权 DELETE 的表是删除的阻断面：Task 验收观察、项目假设、工作片段、项目蓝图、
-- 执行请求、学习记录都有各自的保留 Owner；会话删除命令在发现这些引用时整条拒绝，
-- 而不是借 DELETE 授权把它们一并抹掉（ADR-027 的七类阻断）。
--
-- 回滚：撤销这些 GRANT 即可回到「只能软归档」；不涉及数据形状，已删除的会话不会因回滚恢复。

GRANT DELETE ON
  assist_sessions, assist_messages, assist_proposals, assist_message_attachments,
  session_tool_calls, session_model_selection,
  artifact_impact_checks, artifact_impact_candidates,
  artifact_impact_candidate_groups, artifact_impact_candidate_group_items,
  conversation_state_requests, conversation_state_changes,
  model_calls, model_provider_cooldowns, conversation_diff_baselines
TO relay_app;
