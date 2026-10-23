-- DEV-0115（2026-10-22）：工作区级默认写档位。
-- 档位仍然只有两个落点：这条默认值（还没有目录时可读可写）与 `local_directory_access.write_tier`
-- （某个具体目录的档位）。本列不新增第三种权限事实——它只在**新建** `local_directory_access` 行时
-- 被套用：那一行按它写 write_tier，并像用户当时显式改档一样建立 FILE_WRITE 连接与三条写策略。
-- 已有目录的行一律不因改默认而重写；被停用的写连接、核对不到的写身份、曾被明确撤销的写规则
-- 三种情况跳过，不绕过任何一道既有闸门。
ALTER TABLE workspace_default_directories ADD COLUMN default_write_tier text;
ALTER TABLE workspace_default_directories ADD CONSTRAINT ck_workspace_default_write_tier CHECK (
  default_write_tier IS NULL OR
  default_write_tier IN ('READ_ONLY', 'ASK', 'AUTO', 'FULL')
);
