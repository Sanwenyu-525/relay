-- 外部成果核对与完成指令（总纲 §0.8.1 / 测试计划 NLS-04，任务书第五节第 3 项 Slice B）。
--
-- SYNC_EXTERNAL_RESULT：用户明确说「其他工具已经做好，请核对并同步」时的**只读核对**——
--   沿既有事实（验收版本、标准、Artifact 版本、验证会话适用性）如实分类结果；
--   不完成、不接受、不改其他业务状态。核对记录是历史，整组撤回不把它算作待补偿效果。
-- COMPLETE_TASK：用户明确表达「完成并接受这项任务」时，沿**原完成 Owner**
--   （completeHumanTask）以冻结的任务版本、验收版本与产物提交；原用例的规则不满足即类型化
--   失败，外部自报完成不等于业务完成（NLS-04）。
--
-- 只放宽 change_kind 白名单；APPLIED/COMPENSATED 引用约束、命令身份与幂等逐字保留。
-- 回滚风险：新增 kind 的行在回退后的旧白名单下不可写（仅影响回退后新数据），既有 kind 不受影响。
ALTER TABLE conversation_state_changes DROP CONSTRAINT ck_conversation_state_change_kind;
ALTER TABLE conversation_state_changes ADD CONSTRAINT ck_conversation_state_change_kind
  CHECK (change_kind IN (
    'CREATE_GOAL', 'LINK_GOAL', 'CREATE_KNOWLEDGE', 'VERSION_KNOWLEDGE', 'CREATE_DECISION',
    'CREATE_TASK', 'ADD_TASK_DEPENDENCY', 'SET_NEXT_ACTION', 'SET_PHASE', 'ADD_BLOCKER',
    'RESOLVE_BLOCKER', 'SET_TASK_PLANNING', 'SYNC_EXTERNAL_RESULT', 'COMPLETE_TASK'));
