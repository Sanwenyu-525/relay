-- M04: freeze the reservation of each real Provider attempt so STARTED and
-- unknown-usage calls cannot be treated as zero after a worker crash or a
-- configuration change. Historical NULL reservations remain distinguishable.
ALTER TABLE model_calls ADD COLUMN budget_reserved_tokens integer
  CHECK (budget_reserved_tokens IS NULL OR budget_reserved_tokens > 0);
