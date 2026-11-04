-- 2026-11-04：模型连接明确承载 **API 协议**（MODEL-SETTINGS-03）。
--
-- 0143 建表时 `provider_kind` 的词表只有 `openai-compatible`，注释也写明它是「协议」而不是
-- 品牌。本轮把 Anthropic Messages 作为第二种真实协议接入，因此只扩充这一列的词表，不新建
-- 第二个「协议」列——两列并存必然出现「协议 A、协议 B」互相矛盾的一行。
--
-- 协议是登记时的**显式声明**，不按品牌、URL 或型号推断：
--   * `openai-compatible`：POST {base}/chat/completions，Authorization: Bearer <key>；
--   * `anthropic-messages`：POST {base}/messages，x-api-key + anthropic-version。
--
-- 现有行全部是 `openai-compatible`，不改写、不回填。配置指纹在应用层对
-- `openai-compatible` 保持历史算法，因此本迁移不会让既有冻结快照或会话选择失效；
-- `anthropic-messages` 会进入指纹输入，改协议必然使旧冻结快照失配。
--
-- API Breaking Change: Yes（受限）——`provider_kind` 的取值域扩大。旧客户端只会遇到
-- 自己创建的 `openai-compatible` 行；遇到 `anthropic-messages` 时应显式拒绝而不是猜协议。
--
-- 回滚：先确认没有 `anthropic-messages` 行需要保留，再恢复原 CHECK。
--   SELECT count(*) FROM model_connections WHERE provider_kind = 'anthropic-messages';
--   ALTER TABLE model_connections DROP CONSTRAINT model_connections_provider_kind_check;
--   ALTER TABLE model_connections ADD CONSTRAINT model_connections_provider_kind_check
--     CHECK (provider_kind IN ('openai-compatible'));

ALTER TABLE model_connections
  DROP CONSTRAINT IF EXISTS model_connections_provider_kind_check;

ALTER TABLE model_connections
  ADD CONSTRAINT model_connections_provider_kind_check
  CHECK (provider_kind IN ('openai-compatible', 'anthropic-messages'));

COMMENT ON COLUMN model_connections.provider_kind IS
  'API 协议（不是品牌）：openai-compatible = OpenAI Chat Completions；'
  'anthropic-messages = Anthropic Messages 原生协议。协议只在登记时显式声明，'
  '不按品牌、URL 或型号推断。';
