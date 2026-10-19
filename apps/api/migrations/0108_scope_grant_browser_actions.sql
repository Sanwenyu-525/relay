-- F26/M3：范围授权词表跟上代码（run_scope_grants.allowed_actions）。
--
-- 背景：`SCOPE_GRANT_ACTIONS` 在 0092 加入了 `COMPUTER_INPUT`、0105 加入了 `BROWSER_ACTION`，
-- 但本表上的 CHECK 自 0056 之后从未重述，仍只认
-- `['WRITE_FILE', 'APPLY_CHANGESET', 'CLI_RUN']`。后果是**插入授权行本身就会 23514 失败**，
-- 而代码路径看起来完全正常——这正是"CHECK 必须逐条重述"那条教训的又一次实例。
--
-- 顺带修一个既有缺口：0092 把 COMPUTER_INPUT 写进了源码词表，却漏了这里，
-- 因此「本次任务允许操作电脑」这个授权自 0092 起就无法在库里落地。本迁移一并补上，
-- 不改变任何历史行（历史行本来就只有那三个动作，仍在新集合内）。
--
-- BROWSER_COMMIT **故意不在集合内**：提交表单与上传文件是不可逆外部效果，
-- 永远逐次单动作批准，任何范围授权都覆盖不到。

ALTER TABLE run_scope_grants DROP CONSTRAINT ck_run_scope_grants_actions;
ALTER TABLE run_scope_grants ADD CONSTRAINT ck_run_scope_grants_actions CHECK (
  cardinality(allowed_actions) >= 1
  AND allowed_actions <@ ARRAY[
    'WRITE_FILE', 'APPLY_CHANGESET', 'CLI_RUN', 'COMPUTER_INPUT', 'BROWSER_ACTION']);

-- 兼容与回滚：重述后的集合是旧的超集，历史行全部仍合法；回退前必须确认没有
-- COMPUTER_INPUT / BROWSER_ACTION 的授权行，否则删约束/改回去会违反引用。
