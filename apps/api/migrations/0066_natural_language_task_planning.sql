-- 自然语言状态维护的既有对象调整（总纲 §0.8.1 / 测试计划 §24）：
-- 「导出下周再做，本周优先搜索」这类指令针对**已有 Task** 调整优先级与截止日期，
-- 沿原 Owner（setTaskPlanningMetadata）生效，不因为提到「任务」就重复创建一个 Task。
--
-- 只放宽 change_kind 白名单增加 SET_TASK_PLANNING；其余约束（每条变更固定命令身份、
-- APPLIED 必须留下 after_ref、补偿身份派生）逐字保留。
ALTER TABLE conversation_state_changes DROP CONSTRAINT ck_conversation_state_change_kind;
ALTER TABLE conversation_state_changes ADD CONSTRAINT ck_conversation_state_change_kind
  CHECK (change_kind IN (
    'CREATE_GOAL', 'LINK_GOAL', 'CREATE_KNOWLEDGE', 'VERSION_KNOWLEDGE', 'CREATE_DECISION',
    'CREATE_TASK', 'ADD_TASK_DEPENDENCY', 'SET_NEXT_ACTION', 'SET_PHASE', 'ADD_BLOCKER',
    'RESOLVE_BLOCKER', 'SET_TASK_PLANNING'));
