-- 0166_memory_actor_sources：放宽记忆版本的 confirmed_by 枚举。
--
-- 0130 只接受 user:local / auto-capture，但 V2 的导入、真实数据回填与集成测试使用
-- import / test 等明确来源标签；这些标签是审计来源，不是用户身份。继续用固定枚举会让
-- 导入与索引回填在真实 PG 上失败。这里改为非空、长度有界的自由标签，保留原正文长度与
-- 版本约束；来源可信度仍由 memory_items.origin / source_kind 决定，不由该字段升级。

ALTER TABLE memory_versions DROP CONSTRAINT ck_memory_version_values;
ALTER TABLE memory_versions ADD CONSTRAINT ck_memory_version_values CHECK (
  version >= 1 AND title <> '' AND body_text <> ''
  AND confirmed_by <> '' AND octet_length(confirmed_by) <= 120
  AND octet_length(body_text) <= 262144);

-- 硬删除是用户明确要求的真实删除能力：0009 只给了 memory_items/versions 写读权限，
-- 未授予 DELETE；补授权后 purge 才能连同旧版本与主记录一起删除，否则会留下半删状态。
GRANT DELETE ON memory_items, memory_versions TO relay_app;

COMMENT ON COLUMN memory_items.superseded_by_id IS
  '被哪条新记忆替代；根 status 保持 ACTIVE，有效状态 SUPERSEDED 由该列派生，不写回';

