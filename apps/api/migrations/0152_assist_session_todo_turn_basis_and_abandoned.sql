-- ADR-038 第六轮（2026-10-31）：归属依据补一档 + 未执行调用可收口。
--
-- 两处改动都是**放宽**既有约束，不改任何列、不回填、不改写历史行：
--
-- 1) 归属依据新增 `CONTINUED_COMPLETED`。
--    第五轮把归属冻结成事实时，延续只发生在「上一轮清单仍有未完成项」。这把
--    「清单是否完成」当成了「工作是否换了」的判据：用户完成一轮后回来说「这里不对」，
--    那一轮会被判成开新作用域，上一份清单从注入和界面里同时消失，模型只能从正文里
--    重猜进度。第六轮改成：**只有用户明确声明换任务才开新作用域**，其余一律延续；
--    `basis` 仍如实记录当时看到的清单状态（未完成 / 已收尾），两者都是延续。
--
-- 2) `ABANDONED` 在会话工具账本上真正可用。
--    0060 的两条 CHECK 从未给 ABANDONED 留分支（`ck_session_tool_calls_operation`
--    要求 SETTLED/UNKNOWN 带 Operation、REJECTED 不带，其余只放行 REQUESTED；
--    `ck_session_tool_calls_settlement` 只认 REJECTED 带原因）。结果是「放弃」这个
--    状态在库里根本写不进去：`abandon()` 一调用就撞约束。第六轮需要给
--    「没有持久事件、消息已终止」的 todo_write 调用一个明确终态（不伪造成功、
--    不重跑），用的就是 ABANDONED + 类型化原因。
--
-- 历史兼容：约束只放宽不放宽到自相矛盾——ABANDONED 仍然不允许挂 Operation
-- （放弃的请求要么没派发、要么派发结果不再采信，两种都不该再指着一个可执行动作），
-- 也不允许 result_digest（没有结算结果）。既有行不受影响，回滚只需把约束改回 0146 版本。

ALTER TABLE assist_session_todo_turn_scopes
  DROP CONSTRAINT assist_session_todo_turn_scopes_basis_check;
ALTER TABLE assist_session_todo_turn_scopes
  ADD CONSTRAINT assist_session_todo_turn_scopes_basis_check
  CHECK (basis IN ('OPENED', 'CONTINUED_UNFINISHED', 'CONTINUED_COMPLETED', 'FORCED_NEW_PREFIX'));

ALTER TABLE session_tool_calls DROP CONSTRAINT ck_session_tool_calls_operation;
ALTER TABLE session_tool_calls ADD CONSTRAINT ck_session_tool_calls_operation CHECK (
    (status = 'REJECTED' AND operation_id IS NULL)
    OR (status IN ('SETTLED', 'UNKNOWN') AND operation_id IS NOT NULL)
    OR (status = 'SETTLED' AND operation_id IS NULL AND tool_name IN ('delegate_subagent', 'todo_write'))
    OR status = 'REQUESTED'
    -- 放弃：不再派发，也不再指着任何可执行动作。
    OR (status = 'ABANDONED' AND operation_id IS NULL));

ALTER TABLE session_tool_calls DROP CONSTRAINT ck_session_tool_calls_settlement;
ALTER TABLE session_tool_calls ADD CONSTRAINT ck_session_tool_calls_settlement CHECK (
    (status = 'REJECTED' AND rejection_reason IS NOT NULL AND rejection_reason <> ''
      AND operation_id IS NULL AND settled_at IS NOT NULL)
    OR (status NOT IN ('REJECTED', 'ABANDONED') AND rejection_reason IS NULL)
    -- 放弃必须说明为什么，并且有终止时刻；它不是「没结算」，是「不会再有结算」。
    OR (status = 'ABANDONED' AND rejection_reason IS NOT NULL AND rejection_reason <> ''
      AND settled_at IS NOT NULL)
    OR status = 'UNKNOWN');
