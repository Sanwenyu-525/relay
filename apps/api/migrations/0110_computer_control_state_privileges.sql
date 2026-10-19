-- 0096 created the projection without application-role privileges.
-- Keep the original migration immutable; grant only the operations used by its Owner.
GRANT SELECT, INSERT, UPDATE ON computer_control_state TO relay_app;
