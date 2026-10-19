-- 本目录写入档位词表加入 `FULL`（界面「完全访问」）。
--
-- `local_directory_access.write_tier` 是管理元数据，准入判定仍由 Gateway 策略行决定：
-- `FULL` 与 `AUTO` 一样把 FILE_WRITE 策略落成 `AUTO`，差别只在 Gateway 是否要求一次
-- 有效的 Run 范围授权、以及含删除的变化集是否退回单动作批准。因此本迁移只放宽词表，
-- 不动任何历史行，也不改策略表。
--
-- 兼容与回滚：新集合是旧的超集，历史行全部仍合法；回退前须确认没有 `FULL` 行，
-- 否则改回旧 CHECK 会违反约束。0109 已被校验和锁定，不就地修改。

ALTER TABLE local_directory_access DROP CONSTRAINT ck_local_directory_access_tier;
ALTER TABLE local_directory_access ADD CONSTRAINT ck_local_directory_access_tier CHECK (
  write_tier IN ('READ_ONLY', 'ASK', 'AUTO', 'FULL'));
