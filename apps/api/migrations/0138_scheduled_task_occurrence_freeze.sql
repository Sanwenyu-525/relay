-- P0-A 发生时配置冻结：occurrence 落库时冻结任务模板与执行范围意图。
-- 分发/补跑一律使用冻结载荷，编辑只影响未来时段（ADR-026；#150 只覆盖了
-- 「CreateTask 已提交」分支，本迁移补齐未提交分支与 execution_input 首冻来源）。
ALTER TABLE scheduled_task_occurrences
  ADD COLUMN frozen_template jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(frozen_template) = 'object'),
  ADD COLUMN frozen_execution_input jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(frozen_execution_input) = 'object');

-- 存量 DISPATCHING 行保持 '{}'：分发按旧口径回落到计划当前模板，不回填、不重算。
