-- M03: durable refresh hints for one Run. Existing Runs have no synthetic history;
-- clients read the authoritative Run snapshot when the stream opens.
-- Every event is inserted in the transaction that changed the visible fact.

CREATE TABLE run_events (
  run_id uuid NOT NULL REFERENCES runs (id),
  seq bigint NOT NULL,
  kind text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT pk_run_events PRIMARY KEY (run_id, seq),
  CONSTRAINT ck_run_events_seq CHECK (seq > 0),
  CONSTRAINT ck_run_events_kind CHECK (kind IN
    ('RUN_CHANGED', 'STEP_CHANGED', 'ATTEMPT_CHANGED', 'REVIEW_CHANGED',
     'CONTROL_CHANGED', 'EFFECT_CHANGED'))
);

-- The Run row is the per-thread serial lock. A PG sequence would leave holes
-- after rollback, which the fetch SSE client correctly treats as lost history.
CREATE FUNCTION relay_append_run_event() RETURNS trigger LANGUAGE plpgsql AS $$
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

CREATE TRIGGER tr_run_events_run_insert AFTER INSERT ON runs
  FOR EACH ROW EXECUTE FUNCTION relay_append_run_event();
CREATE TRIGGER tr_run_events_run_update AFTER UPDATE ON runs
  FOR EACH ROW WHEN (
    OLD.status IS DISTINCT FROM NEW.status OR OLD.revision IS DISTINCT FROM NEW.revision OR
    OLD.current_step_id IS DISTINCT FROM NEW.current_step_id OR
    OLD.wait_reason IS DISTINCT FROM NEW.wait_reason OR
    OLD.terminal_at IS DISTINCT FROM NEW.terminal_at
  ) EXECUTE FUNCTION relay_append_run_event();
CREATE TRIGGER tr_run_events_step_update AFTER UPDATE ON run_steps
  FOR EACH ROW WHEN (
    OLD.status IS DISTINCT FROM NEW.status OR OLD.revision IS DISTINCT FROM NEW.revision OR
    OLD.result_ref IS DISTINCT FROM NEW.result_ref
  ) EXECUTE FUNCTION relay_append_run_event();
CREATE TRIGGER tr_run_events_attempt_insert AFTER INSERT ON step_attempts
  FOR EACH ROW EXECUTE FUNCTION relay_append_run_event();
CREATE TRIGGER tr_run_events_attempt_update AFTER UPDATE ON step_attempts
  FOR EACH ROW WHEN (
    OLD.status IS DISTINCT FROM NEW.status OR OLD.claim_epoch IS DISTINCT FROM NEW.claim_epoch OR
    OLD.result_ref IS DISTINCT FROM NEW.result_ref
  ) EXECUTE FUNCTION relay_append_run_event();
CREATE TRIGGER tr_run_events_review_insert AFTER INSERT ON review_requests
  FOR EACH ROW EXECUTE FUNCTION relay_append_run_event();
CREATE TRIGGER tr_run_events_review_update AFTER UPDATE ON review_requests
  FOR EACH ROW WHEN (
    OLD.status IS DISTINCT FROM NEW.status OR OLD.revision IS DISTINCT FROM NEW.revision
  ) EXECUTE FUNCTION relay_append_run_event();
CREATE TRIGGER tr_run_events_control_insert AFTER INSERT ON run_control_requests
  FOR EACH ROW EXECUTE FUNCTION relay_append_run_event();
CREATE TRIGGER tr_run_events_control_update AFTER UPDATE ON run_control_requests
  FOR EACH ROW WHEN (
    OLD.status IS DISTINCT FROM NEW.status OR OLD.revision IS DISTINCT FROM NEW.revision
  ) EXECUTE FUNCTION relay_append_run_event();
CREATE TRIGGER tr_run_events_effect_insert AFTER INSERT ON run_effect_actions
  FOR EACH ROW EXECUTE FUNCTION relay_append_run_event();
CREATE TRIGGER tr_run_events_effect_update AFTER UPDATE ON run_effect_actions
  FOR EACH ROW WHEN (
    OLD.status IS DISTINCT FROM NEW.status OR OLD.revision IS DISTINCT FROM NEW.revision OR
    OLD.result_ref IS DISTINCT FROM NEW.result_ref
  ) EXECUTE FUNCTION relay_append_run_event();

GRANT SELECT, INSERT ON run_events TO relay_app;
