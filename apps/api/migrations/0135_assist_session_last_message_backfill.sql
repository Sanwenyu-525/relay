-- 回填 0111 会话活动键：把「0111 之前就已有消息」的会话补上 last_message_at
-- （2026-10-24 用户截图指认缺陷；不改列定义、不加索引、不动授权）。
--
-- 背景：0111 是**刻意不回填**的（原文「只追加一列…不回填」，兼容段写「旧行取 NULL（无消息）」）。
-- 那个括号里的假设不成立——0111 应用之前就已经有消息的会话，同样落在 NULL 上。
-- 当时无害：NULL 只参与 `coalesce(last_message_at, created_at)` 的排序，退化成按创建时间排。
--
-- 现在有害：2026-10-24 左栏「未开始」标记（workbench-design §28.1）把
-- `lastMessageAt === null` 读成「这段讨论还没有消息」。于是一条 6 条消息的老会话
-- （本机实例：2026-10-16 15:35 建、15:35/15:42/16:01 三轮对话、含一次 MODEL_FAILED）
-- 在左栏被标成「未开始」，点进去却有完整正文——用户看到的是自相矛盾的两处事实。
-- 缺陷不在标记本身（判据是对的），而在 0111 的 NULL 没有做到「NULL ⇔ 没有消息」这个语义：
-- 界面把一个**可空导航键**当成了**内容存在性**来读，而历史行从未被校准。
--
-- 修复：按消息表的真实最后时刻回填，只填 NULL，因此可重复执行；用 `max(created_at)`
-- 而不是 `now()`——活动时刻说的是「最后一条消息是什么时候」，回填不该把 2026-10-16 的
-- 会话记成今天。`assist_messages.created_at` 是消息落库时刻的既有事实，不新造时间来源。
--
-- 为什么不改 updated_at / revision：本列自 0111 起就是导航排序键，回填属数据校准，
-- 不是一次人工控制命令；推进 revision 会打翻改名/置顶/未读那一组命令的 CAS 基线。
--
-- 未来不会再出现同类行：0111 已确立唯一写入 Owner（insertMessage 与 settleGeneration，
-- 均 `greatest(last_message_at, now())` 单调推进），本迁移只补历史行，不引入新的写入方。
--
-- 回滚：不提供反向语句。把填过的行改回 NULL 只会重新引入本缺陷；保留已填值在旧代码下
-- 也完全兼容（旧代码只读它做排序，读到更精确的活动时刻是改善）。

UPDATE assist_sessions s
SET last_message_at = m.last_message_at
FROM (
  SELECT session_id, max(created_at) AS last_message_at
  FROM assist_messages
  GROUP BY session_id
) m
WHERE m.session_id = s.id
  AND s.last_message_at IS NULL;
