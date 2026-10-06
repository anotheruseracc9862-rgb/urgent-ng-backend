-- Soft deletion trigger helper (P1-10)
-- Creates a BEFORE DELETE trigger that prevents hard deletes on soft-deletable tables.
-- Only the retention job's database role may delete from transient tables.
-- Per PRD §26.8.

-- Usage in migration:
-- SELECT create_soft_delete_trigger('users');
-- SELECT create_soft_delete_trigger('errands');

CREATE OR REPLACE FUNCTION create_soft_delete_trigger(table_name TEXT)
RETURNS VOID AS $$
DECLARE
  trigger_name TEXT := table_name || '_prevent_delete';
BEGIN
  -- Create trigger function for this table
  EXECUTE format('
    CREATE OR REPLACE FUNCTION %I()
    RETURNS TRIGGER AS $func$
    BEGIN
      RAISE EXCEPTION ''Hard deletes are not allowed on table %s. Use soft deletion (SET deleted_at = NOW()) instead.'';
      RETURN NULL;
    END;
    $func$ LANGUAGE plpgsql;
  ', trigger_name || '_func', table_name);

  -- Drop existing trigger if present
  EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', trigger_name, table_name);

  -- Create BEFORE DELETE trigger
  EXECUTE format('
    CREATE TRIGGER %I
    BEFORE DELETE ON %I
    FOR EACH ROW
    EXECUTE FUNCTION %I();
  ', trigger_name, table_name, trigger_name || '_func');

  RAISE NOTICE 'Created soft delete trigger for table: %', table_name;
END;
$$ LANGUAGE plpgsql;

-- Helper to install triggers on all soft-deletable tables
CREATE OR REPLACE FUNCTION install_all_soft_delete_triggers()
RETURNS VOID AS $$
DECLARE
  table_name TEXT;
BEGIN
  -- Soft-deletable tables per PRD §26.8
  FOREACH table_name IN ARRAY ARRAY[
    'users',
    'profiles',
    'errands',
    'offers',
    'assignments',
    'messages',
    'conversations',
    'notifications',
    'disputes',
    'reports',
    'enforcement_actions'
  ]
  LOOP
    PERFORM create_soft_delete_trigger(table_name);
  END LOOP;

  RAISE NOTICE 'Installed soft delete triggers on all soft-deletable tables';
END;
$$ LANGUAGE plpgsql;

-- Never-deleted tables (enforce with triggers that always reject DELETE)
CREATE OR REPLACE FUNCTION create_never_delete_trigger(table_name TEXT)
RETURNS VOID AS $$
DECLARE
  trigger_name TEXT := table_name || '_never_delete';
BEGIN
  -- Create trigger function for this table
  EXECUTE format('
    CREATE OR REPLACE FUNCTION %I()
    RETURNS TRIGGER AS $func$
    BEGIN
      RAISE EXCEPTION ''Deletes are never allowed on table %s. This is an append-only table.'';
      RETURN NULL;
    END;
    $func$ LANGUAGE plpgsql;
  ', trigger_name || '_func', table_name);

  -- Drop existing trigger if present
  EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', trigger_name, table_name);

  -- Create BEFORE DELETE trigger
  EXECUTE format('
    CREATE TRIGGER %I
    BEFORE DELETE ON %I
    FOR EACH ROW
    EXECUTE FUNCTION %I();
  ', trigger_name, table_name, trigger_name || '_func');

  RAISE NOTICE 'Created never-delete trigger for table: %', table_name;
END;
$$ LANGUAGE plpgsql;

-- Helper to install triggers on all never-deleted tables
CREATE OR REPLACE FUNCTION install_all_never_delete_triggers()
RETURNS VOID AS $$
DECLARE
  table_name TEXT;
BEGIN
  -- Never-deleted tables per PRD §26.8
  FOREACH table_name IN ARRAY ARRAY[
    'audit_logs',
    'outbox_events',
    'idempotency_keys',
    'config_values',
    'commercial_products',
    'price_versions'
  ]
  LOOP
    PERFORM create_never_delete_trigger(table_name);
  END LOOP;

  RAISE NOTICE 'Installed never-delete triggers on all append-only tables';
END;
$$ LANGUAGE plpgsql;
