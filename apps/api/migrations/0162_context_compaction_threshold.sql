-- 0162：自动上下文压缩阈值改为用户可配置的 token 数（2026-11-12）。
--
-- 背景：0145 的上下文档位（256K / 512K / 1M）回答的是「一次调用最多申请多少」，不是
-- 「历史涨到多少时先整理」。此前自动整理的判定量是**字节**（输入开销的 80%），
-- 既不能按 token 说清，也无法与模型真实窗口分开表达。产品目标窗口是 1M、默认在
-- 350K tokens 触发压缩，用户可自行改阈值；推荐区间 256K–400K 只作提示，不强制。
--
-- 存储口径：
--   * NULL = 使用产品默认（350,000 tokens）。它不是「关闭」；关闭走
--     `automatic_compaction = false`（普通自动压缩开关，溢出保护不受它影响）。
--   * 非空值必须落在 16,384–1,048,576 之间：下限避免把阈值设成「每轮都整理」，
--     上限就是产品目标窗口 1M——比它还高的值没有可兑现的语义。
--   * 高于**当前模型**安全上限的值允许保存（同一工作区会切模型），生效时按真实窗口
--     收敛并在界面明说，不静默采用无效配置。
ALTER TABLE workspace_memory_settings
  ADD COLUMN compaction_threshold_tokens integer;

ALTER TABLE workspace_memory_settings
  ADD CONSTRAINT ck_workspace_memory_compaction_threshold CHECK (
    compaction_threshold_tokens IS NULL OR
    (compaction_threshold_tokens >= 16384 AND compaction_threshold_tokens <= 1048576)
  );

COMMENT ON COLUMN workspace_memory_settings.compaction_threshold_tokens IS
  '自动压缩阈值（tokens）。NULL = 产品默认 350000；生效值还会按模型真实窗口与输出预留收敛。';

-- 回滚：DROP CONSTRAINT 后 DROP COLUMN。已经写入的自定义阈值会丢失，回滚后自动整理
-- 退回产品默认 350K；原值不影响任何既有业务事实（摘要与原文都不在这个表里）。
