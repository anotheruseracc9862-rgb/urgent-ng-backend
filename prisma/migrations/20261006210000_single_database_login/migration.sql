-- One database login for the application.
--
-- The previous migration added two extra roles (urgent_app, urgent_retention) and a
-- trigger that only the retention role could pass. The project uses a single
-- DATABASE_URL, so those are removed.
--
-- Kept (they enforce soft deletion, no matter which login runs the SQL):
--   * block_hard_delete() on soft-deletable and never-deleted tables
--   * audit_logs append-only triggers
-- Added:
--   * price_versions rows cannot be updated (price history is immutable)
-- Changed:
--   * transient tables (outbox_events, idempotency_keys) can be deleted normally,
--     so cleanup jobs run with the normal login.

DROP TRIGGER IF EXISTS retention_only_delete ON outbox_events;
DROP TRIGGER IF EXISTS retention_only_delete ON idempotency_keys;
DROP FUNCTION IF EXISTS install_retention_delete_trigger(regclass);
DROP FUNCTION IF EXISTS retention_only_delete();

CREATE OR REPLACE FUNCTION block_update()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Rows in table % are immutable. Insert a new row instead of updating.', TG_TABLE_NAME
    USING ERRCODE = 'P0001';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS block_update ON price_versions;
CREATE TRIGGER block_update BEFORE UPDATE ON price_versions
  FOR EACH ROW EXECUTE FUNCTION block_update();

-- Remove the two roles and their grants. Roles are shared by the whole server,
-- so a role that is still used by another database is left in place (the
-- exception is ignored); it has no login and no effect here.
DO $$
DECLARE
  role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['urgent_app', 'urgent_retention'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('DROP OWNED BY %I', role_name);
      BEGIN
        EXECUTE format('DROP ROLE %I', role_name);
      EXCEPTION WHEN dependent_objects_still_exist THEN
        NULL;
      END;
    END IF;
  END LOOP;
END
$$;
