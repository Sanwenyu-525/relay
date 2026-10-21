-- Git 只读随目录授权（2026-10-20，P1-3）。
--
-- 打开一个 Git 仓库根目录时，应用在同一个事务里为它建立 GIT_READ 连接与
-- status/diff/log 三条 AUTO 策略；本列记录应用自己建立的那条连接，用于
-- 「重新打开时复用同一条连接」和「连接被停用/撤销后不另建一条绕过」。
--
-- 它只是应用的管理指针：准入仍由 gateway_connections 与 gateway_permission_policies
-- 决定，本列不构成任何授权。为空表示该目录没有自动配置过 Git 只读
-- （非仓库、仓库子目录，或历史行）。
--
-- 兼容与回滚：新增可空列，历史行全部合法；回滚只需 drop column，不影响既有授权。

ALTER TABLE local_directory_access
  ADD COLUMN git_connection_id uuid REFERENCES gateway_connections (id);

COMMENT ON COLUMN local_directory_access.git_connection_id IS
  '应用为 Git 仓库根自动建立的 GIT_READ 连接；仅作复用与停用核对指针，不构成授权。';
