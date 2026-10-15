-- 自然语言撤回（总纲 §0.8.1「纠正与撤回」/ 测试计划 NLS-11 / 任务书第五节第 1 项）。
--
-- UNDO_STATE_CHANGE：用户明确说「撤回刚才那次调整」时的候选。它**不自带撤销逻辑**——
-- 应用阶段解析同会话中唯一一条已生效的状态维护请求，复用按钮撤回的同一应用用例
-- （undo-plan、范围决定、持久 undo_command_id 全部不变）；候选不唯一或不存在时类型化
-- 失败，不猜原对象；模糊措辞由解释层澄清，不进入本白名单。
--
-- 只放宽 change_kind 白名单；APPLIED/COMPENSATED 引用约束、命令身份与幂等逐字保留。
ALTER TABLE conversation_state_changes DROP CONSTRAINT ck_conversation_state_change_kind;
ALTER TABLE conversation_state_changes ADD CONSTRAINT ck_conversation_state_change_kind
  CHECK (change_kind IN (
    'CREATE_GOAL', 'LINK_GOAL', 'CREATE_KNOWLEDGE', 'VERSION_KNOWLEDGE', 'CREATE_DECISION',
    'CREATE_TASK', 'ADD_TASK_DEPENDENCY', 'SET_NEXT_ACTION', 'SET_PHASE', 'ADD_BLOCKER',
    'RESOLVE_BLOCKER', 'SET_TASK_PLANNING', 'SYNC_EXTERNAL_RESULT', 'COMPLETE_TASK',
    'UNDO_STATE_CHANGE'));
