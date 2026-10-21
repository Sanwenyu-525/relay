-- 0129：Worker fence 的结构化事实（DEV-0029）。
--
-- 「旧进程已停止并换来新 worker_epoch」是恢复重入的前提，不能只存在于
-- `activity_records.fact_refs` 的 JSON 文本里：审计键名、写入格式或保留策略变化都会让
-- `hasWorkerFence` 静默永远为假。这里把同一事实落成受约束的行，审计记录仍保留追溯用途。
CREATE TABLE run_worker_fences (
  run_id uuid NOT NULL REFERENCES runs (id),
  stopped_worker_id text NOT NULL,
  -- fence 之后的新 epoch，与调用方读取的 runs.worker_epoch 对齐。
  worker_epoch bigint NOT NULL,
  stopped_evidence text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_run_worker_fences PRIMARY KEY (run_id, worker_epoch),
  CONSTRAINT ck_run_worker_fences_worker CHECK (stopped_worker_id <> ''),
  CONSTRAINT ck_run_worker_fences_epoch CHECK (worker_epoch > 0)
);

CREATE INDEX ix_run_worker_fences_worker
  ON run_worker_fences (run_id, stopped_worker_id);

GRANT SELECT, INSERT ON run_worker_fences TO relay_app;

-- 升级前已经 fence 过的 Run 继续可恢复：把既有审计事实回填一次，非法行跳过而不是让迁移失败。
INSERT INTO run_worker_fences (run_id, stopped_worker_id, worker_epoch, stopped_evidence, created_at)
SELECT (a.fact_refs ->> 'run_id')::uuid, a.fact_refs ->> 'stopped_worker_id',
  (a.fact_refs ->> 'worker_epoch')::bigint, COALESCE(a.fact_refs ->> 'stopped_evidence', ''), a.created_at
FROM activity_records a
JOIN runs r ON r.id::text = a.fact_refs ->> 'run_id'
WHERE a.event_type = 'RUN_WORKER_FENCED'
  AND a.fact_refs ->> 'stopped_worker_id' <> ''
  AND a.fact_refs ->> 'worker_epoch' ~ '^[0-9]+$'
  AND (a.fact_refs ->> 'worker_epoch')::bigint > 0
ON CONFLICT (run_id, worker_epoch) DO NOTHING;
