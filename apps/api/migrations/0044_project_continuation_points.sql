-- Project 拥有接续点身份与说明；其他对象只保存捕获时的确切版本引用，不复制业务状态。
CREATE TABLE project_continuation_points (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  project_id uuid NOT NULL REFERENCES projects (id),
  name text NOT NULL,
  note text,
  state_phase_key text NOT NULL,
  state_revision bigint NOT NULL,
  next_action_task_id uuid,
  captured_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_project_continuation_points_project
    FOREIGN KEY (project_id, next_action_task_id) REFERENCES tasks (project_id, id),
  CONSTRAINT ck_project_continuation_points_name CHECK (length(name) BETWEEN 1 AND 120),
  CONSTRAINT ck_project_continuation_points_note CHECK (note IS NULL OR length(note) <= 2000),
  CONSTRAINT ck_project_continuation_points_phase CHECK (state_phase_key <> ''),
  CONSTRAINT ck_project_continuation_points_state_revision CHECK (state_revision >= 0)
);
CREATE INDEX ix_project_continuation_points_project
  ON project_continuation_points (workspace_id, project_id, captured_at DESC, id);

-- ref_kind 决定哪一列带外键：同一张表不能对两种目标各挂一个条件外键，
-- 所以用 CHECK 把 ref_id 绑到对应列，两类引用都保留数据库级完整性。
CREATE TABLE project_continuation_point_refs (
  continuation_point_id uuid NOT NULL
    REFERENCES project_continuation_points (id) ON DELETE CASCADE,
  ref_kind text NOT NULL,
  ref_id uuid NOT NULL,
  ref_revision bigint NOT NULL,
  ordinal integer NOT NULL,
  task_id uuid REFERENCES tasks (id) DEFERRABLE INITIALLY DEFERRED,
  artifact_version_id uuid REFERENCES artifact_versions (id),
  PRIMARY KEY (continuation_point_id, ref_kind, ref_id),
  CONSTRAINT ck_project_continuation_point_refs_kind
    CHECK (ref_kind IN ('TASK', 'ARTIFACT_VERSION')),
  CONSTRAINT ck_project_continuation_point_refs_revision CHECK (ref_revision >= 0),
  CONSTRAINT ck_project_continuation_point_refs_ordinal CHECK (ordinal >= 0),
  CONSTRAINT ck_project_continuation_point_refs_target CHECK (
    (ref_kind = 'TASK' AND task_id = ref_id AND artifact_version_id IS NULL) OR
    (ref_kind = 'ARTIFACT_VERSION' AND artifact_version_id = ref_id AND task_id IS NULL)
  )
);
CREATE INDEX ix_project_continuation_point_refs_point
  ON project_continuation_point_refs (continuation_point_id, ordinal);

GRANT SELECT, INSERT ON project_continuation_points TO relay_app;
GRANT SELECT, INSERT ON project_continuation_point_refs TO relay_app;
