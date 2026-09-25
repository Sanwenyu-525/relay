-- P11 Context source invalidation. Separate from P10 rule_revision: information
-- changes invalidate optional Context selection without rewriting Run contracts.
ALTER TABLE workspace_execution_authority
  ADD COLUMN context_revision bigint NOT NULL DEFAULT 0
    CHECK (context_revision >= 0);
