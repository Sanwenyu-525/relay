-- 自然语言状态维护的「确认时点适用基线」（总纲 §0.8.1「纠正与撤回」/ 测试计划 NLS-11）。
--
-- 问题：应用与补偿此前都「读最新 revision 再写」，这会把解释/原变更之后发生的合法人工
-- 修改直接覆盖掉（阶段被后续人工改成 RELEASE，应用旧候选或撤回原指令都会把它改回去）。
--
-- 修复：解释结算时把每条变更的**适用版本与实际目标身份**冻结在这里：
--   * state_revision        —— 确认时点的 Project State 版本（SET_PHASE / SET_NEXT_ACTION /
--                             ADD_BLOCKER / RESOLVE_BLOCKER 这些经 runStateCommand 写入的变更）；
--   * 目标身份（task_id / goal_id / blocker_id / knowledge_id 及其版本）—— 按标题解析出的确切对象；
--   * resolved              —— 确认时点是否成功解析；false 表示确认时还不存在该对象
--                             （例如同组 CREATE_TASK 之后才被引用），应用时才首次解析。
--
-- 应用与补偿各自重查适用性：版本或身份对不上就保留当前事实并报类型化冲突，
-- 不用「读最新 revision」消除冲突，也不只比较字段值（后续修改可能又改回同值）。
--
-- 该列只保存「确认时点看到了什么」，不复制业务正文：目标、任务、State 仍各归原 Owner。
ALTER TABLE conversation_state_changes ADD COLUMN baseline_ref jsonb;

-- 整组撤回的**已确认方案**（测试计划 NLS-11 / 总纲 §0.8.1「纠正与撤回」）：
-- 事前预检发现原范围里有不可撤回项时，先给出具体方案并由用户决定范围，
-- 执行只针对确认的范围；把方案持久化，UNDOING 中断后才能按同一范围恢复剩余补偿，
-- 而不会把未确认的项也补偿掉。{ plan_digest, change_ids }。
ALTER TABLE conversation_state_requests ADD COLUMN undo_scope jsonb;
