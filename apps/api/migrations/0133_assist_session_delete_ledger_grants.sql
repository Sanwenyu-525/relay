-- 0133：会话物理删除补齐 0127 / 0128 后加账本表的 DELETE 授权（ADR-027，0116 先例）。
--
-- 背景：0116 为会话删除按「子 → 父」逐表显式清理的口径授予了当时全部子表的 DELETE；
-- 0127（计划 / 目标 / 轮次 / 额度授予）与 0128（委派 / 子尝试）建表时只授了
-- SELECT / INSERT / UPDATE。这些行是**会话自有**的执行账本：删除会话时由
-- `assist-repository.deleteSession` 在同一短事务内显式清理，而应用角色没有 DELETE
-- 会让清理以权限错误失败（禅道 #119：生成计划或目标后删除会话整条 500 回滚）。
--
-- 只补删除 Owner 已在代码里处理的表，不外溢：阻断面不变——被外部对象引用的行
-- （Task 验收观察、假设、工作片段、学习记录、执行请求等）仍在 `listDeleteBlockers`
-- 整条拒绝，委派账本被子会话侧引用时同样阻断，不借 DELETE 抹掉。
-- 回滚：撤销这些 GRANT 即回到「含计划 / 目标 / 委派的会话无法删除」；不涉及数据形状。

GRANT DELETE ON
  assist_plans, assist_goals, assist_goal_rounds, assist_goal_budget_grants,
  assist_delegations, assist_delegation_attempts
TO relay_app;
