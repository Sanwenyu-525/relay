-- M04 工具调用的 Run 刷新事件：把 run_tool_calls 登记为第 7 个事件来源。
-- 依据 docs/architecture/runtime-context.md §2.3、docs/database/physical-design-postgresql.md
-- 第 60 节与 docs/research/p00-source-study.md §1.6：
--   * 协作页要呈现「模型这一轮实际做了什么」，但 0012 只为 6 张表登记了刷新来源，
--     run_tool_calls 的状态推进不发任何提示。只读投影因此无法按事件刷新。
--   * 上游的共同形态是「工具事件本身持久化 + 逐项提示」而不是轮询：Codex 对每个工具项
--     发 item/started 与 item/completed，DeepSeek 把 tool/call 与 tool/result 作为持久
--     事件推送。Relay 的 run_tool_calls 本来就是持久账本，缺的只是「它变了」这个信号。
--   * 本迁移只放宽约束并新增触发器，不改 run_tool_calls 表结构、不新增业务表、不回填
--     历史：既有 Run 的 run_events 行保持原样，客户端在流打开时本就读取权威快照。
--
-- WHEN 条件只看 status / operation_id / result_ref 三列，不含 revision：这三次列的变化
-- 已覆盖全部状态推进（insert / bindOperation / settle / reject / abandon 都改 status），
-- 纳入 revision 只会为同一次推进多发一条提示。

ALTER TABLE run_events DROP CONSTRAINT ck_run_events_kind;
-- 完整保留 0012 的六个原取值，只追加 TOOL_CALL_CHANGED。就地追加或漏掉任何一支，
-- 都会让历史事件行在下一次写入时违反约束（0054 重述 ck_logical_operation_resource 时
-- 漏掉 WEB_FETCH 与 FILE_WRITE，造成 9 例既有动作失败，同一类教训）。
ALTER TABLE run_events ADD CONSTRAINT ck_run_events_kind CHECK (kind IN
  ('RUN_CHANGED', 'STEP_CHANGED', 'ATTEMPT_CHANGED', 'REVIEW_CHANGED',
   'CONTROL_CHANGED', 'EFFECT_CHANGED', 'TOOL_CALL_CHANGED'));

-- 只加分支，函数体其余部分逐字不变：事件序号必须在 Run 行锁下取 max(seq) + 1，
-- 否则并发推进会撞主键或留下序号空洞。
CREATE OR REPLACE FUNCTION relay_append_run_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  event_run_id uuid;
  event_kind text;
  next_seq bigint;
BEGIN
  CASE TG_TABLE_NAME
    WHEN 'runs' THEN
      event_run_id := NEW.id;
      event_kind := 'RUN_CHANGED';
    WHEN 'run_steps' THEN
      event_run_id := NEW.run_id;
      event_kind := 'STEP_CHANGED';
    WHEN 'step_attempts' THEN
      SELECT run_id INTO event_run_id FROM run_steps WHERE id = NEW.step_id;
      event_kind := 'ATTEMPT_CHANGED';
    WHEN 'review_requests' THEN
      event_run_id := NEW.run_id;
      event_kind := 'REVIEW_CHANGED';
    WHEN 'run_control_requests' THEN
      event_run_id := NEW.run_id;
      event_kind := 'CONTROL_CHANGED';
    WHEN 'run_effect_actions' THEN
      event_run_id := NEW.run_id;
      event_kind := 'EFFECT_CHANGED';
    -- run_id 就在行上，不需要像 step_attempts 那样回查 run_steps。
    WHEN 'run_tool_calls' THEN
      event_run_id := NEW.run_id;
      event_kind := 'TOOL_CALL_CHANGED';
    ELSE
      RAISE EXCEPTION 'unsupported Run event source: %', TG_TABLE_NAME;
  END CASE;

  IF event_run_id IS NULL THEN RETURN NEW; END IF;
  PERFORM 1 FROM runs WHERE id = event_run_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Run event source has no Run: %', event_run_id; END IF;
  SELECT coalesce(max(seq), 0)::bigint + 1 INTO next_seq
    FROM run_events WHERE run_id = event_run_id;
  INSERT INTO run_events (run_id, seq, kind) VALUES (event_run_id, next_seq, event_kind);
  RETURN NEW;
END;
$$;

CREATE TRIGGER tr_run_events_tool_call_insert AFTER INSERT ON run_tool_calls
  FOR EACH ROW EXECUTE FUNCTION relay_append_run_event();
CREATE TRIGGER tr_run_events_tool_call_update AFTER UPDATE ON run_tool_calls
  FOR EACH ROW WHEN (
    OLD.status IS DISTINCT FROM NEW.status OR OLD.operation_id IS DISTINCT FROM NEW.operation_id OR
    OLD.result_ref IS DISTINCT FROM NEW.result_ref
  ) EXECUTE FUNCTION relay_append_run_event();

-- 不需要新增 GRANT：函数默认 SECURITY INVOKER，以调用者即应用角色 relay_app 执行，
-- 而 0012 已授予 relay_app 对 run_events 的 SELECT, INSERT，0054 已授予对
-- run_tool_calls 的读写。应用角色仍看不到迁移台账。
