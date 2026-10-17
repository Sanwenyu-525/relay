-- 0095：补齐会话模型选择「OpenRouter 连接必须有完整目录来源」的反向约束
-- （专项 prompts/free-model-catalog.md 阶段 0 独立反例整改；FM-13、HTTP §10.82、数据库设计 §91）。
--
-- 已复现的独立反例（保持原输入，未放宽）：
--   connection = 'openrouter'，free_only = false，
--   catalog_source = NULL，catalog_snapshot_seq = NULL，catalog_model_id = NULL
-- 预期 SQLSTATE 23514，实际**插入成功**。
--
-- 根因是两次同一类 SQL NULL 三值语义漏洞，而不是一个：
--   * 0089 的耦合 CHECK 第二个合取式是
--       (connection = 'default' OR catalog_source = 'openrouter')
--     当 connection = 'openrouter' 时左支为 false，右支 `catalog_source = 'openrouter'`
--     在 catalog_source 为 NULL 时求值为 **NULL**；`false OR NULL = NULL`，CHECK 把 NULL
--     视为**通过**。
--   * 0094 补的是另一个方向（default 不得携带目录来源）：
--       (connection <> 'default' OR catalog_source IS NULL)
--     当 connection = 'openrouter' 时左支为 true，整个表达式为 true，同样放行。
--   两条约束**各自**都在这个组合上求值为 true 或 NULL，因此「OpenRouter 连接却没有任何
--   目录依据」这一自相矛盾的行一直写得进去。
--
-- 为什么这不能算无害：OpenRouter 连接上的模型只存在于某一版目录快照里，`catalog_source`
-- /`catalog_snapshot_seq`/`catalog_model_id` 就是「这次选择依据哪份事实」的可核对凭据。
-- 允许它三者全空，等于允许一条**无法核对来源**的 OpenRouter 选择：目录刷新后既无法判定
-- 失效，也无法回溯当时凭什么判免费——「免费」就成了没有依据的断言。
--
-- 本迁移的约束（显式分支 + 显式非空判定，不再依赖与 NULL 比较）：
--   connection = 'openrouter'
--     → catalog_source 必须等于 'openrouter'，且 snapshot_seq / model_id 必须 IS NOT NULL。
--   connection = 'default'
--     → 由 0094 保证 catalog_source IS NULL（合法「沿用默认、无目录依据」继续可用）。
--   free_only = true
--     → 由 0089 保证三列依据齐全；结合 0094，free_only 在 default 连接上必然被拒。
--   三列同现同缺
--     → 由 0089 保证。
--
-- 为什么不改写 0089 / 0094：迁移台账按内容 sha256 逐条校验，已应用迁移被编辑即触发
-- MigrationIntegrityError。编号核对：0090–0094 已被 assist_session_pin /
-- composer_draft_assist / computer_use / assist_message_attachments /
-- session_model_selection_source_guard 占用，本迁移取 **0095**，不预占文档里出现过的旧编号。
--
-- 升级策略（既有数据，明确阻止而不是悄悄纠正）：
--   本迁移先做一次**只读预检**，统计将违反新约束的既有行；存在即抛出带行数的明确异常，
--   让整个迁移事务回滚——既不伪造来源、不默认改写 catalog_source，也不删除用户数据。
--   纠正方式只能是有控制的业务动作（重选或显式撤销该选择），由人决定，不由迁移代劳。
--   就本功能的实际历史而言，OpenRouter 选择在「聊天连接接通前」被 Owner 如实拒绝
--   （OPENROUTER_CHAT_NOT_WIRED），从未落过 openrouter 行；生产与测试库预检应为 0。
--
-- 兼容与回滚：只新增一条 CHECK，不加列、不改数据、不新建表、不动授权；
-- API Breaking Change：No——既有合法行全部满足。回滚可直接
-- DROP CONSTRAINT ck_session_model_selection_openrouter_requires_catalog。

DO $$
DECLARE
  violating_rows integer;
BEGIN
  SELECT count(*) INTO violating_rows
    FROM session_model_selection
   WHERE connection = 'openrouter'
     AND (catalog_source IS DISTINCT FROM 'openrouter'
          OR catalog_snapshot_seq IS NULL
          OR catalog_model_id IS NULL);

  IF violating_rows > 0 THEN
    RAISE EXCEPTION USING
      MESSAGE = format(
        'migration 0095: %s session_model_selection row(s) use the openrouter connection without complete catalog provenance',
        violating_rows),
      HINT = 'Correct these selections with a controlled business action (re-select or explicitly withdraw); this migration does not fabricate provenance or delete rows.',
      ERRCODE = '23514';
  END IF;
END
$$;

ALTER TABLE session_model_selection
  ADD CONSTRAINT ck_session_model_selection_openrouter_requires_catalog
  CHECK (
    connection <> 'openrouter'
    OR (catalog_source = 'openrouter'
        AND catalog_snapshot_seq IS NOT NULL
        AND catalog_model_id IS NOT NULL)
  );
