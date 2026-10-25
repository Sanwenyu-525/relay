-- 会话物理删除与自动记忆捕获账本（2026-10-25，接续 ADR-027 的 0116 与 ADR-030 的 0125）。
--
-- 背景：`memory_auto_captures.message_id` 与 `memory_message_sources.message_id` 都外键指向
-- `assist_messages(id)`，且都是默认 NO ACTION；0116 的删除路径没有、也无法删这两张表
-- （应用角色没有 DELETE 授权）。于是只要一段会话产生过自动记忆，`DeleteAssistSession`
-- 就会在删消息那一步撞外键失败，整条命令报错——而删除本来是不可撤销、必须一次成功的能力。
--
-- 为什么删账本而保留记忆：
--   * 长期记忆是**用户的长期事实**，有自己的停用/恢复入口（`RetireMemory` / `ReactivateMemory`）；
--     删一段会话不等于要求忘记，把记忆一并删掉会让「删聊天」变成隐形的遗忘动作。
--   * 捕获账本与来源绑定记录的是「这条记忆是从哪条消息的哪一段提出的」。消息随会话消失后，
--     这个指向已经无法核对；留着它只会是一条悬空凭据（或让删除失败）。
--   * 因此这里只授权删除**凭据**，不动 `memory_items` / `memory_versions`：记忆正文与版本
--     历史照旧保留，`confirmed_by='auto-capture'` 仍说明它来自自动提取。
--
-- 回滚：撤销这两条 GRANT 即可回到「有自动记忆的会话删不掉」的旧行为；不涉及数据形状，
-- 已删除的会话不会因回滚恢复。

GRANT DELETE ON memory_auto_captures, memory_message_sources TO relay_app;
