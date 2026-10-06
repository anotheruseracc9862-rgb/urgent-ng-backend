-- Soft deletion infrastructure (P1-10)
-- Creates helper functions and triggers to enforce soft deletion rules.
-- Per PRD §26.8.

-- Create helper function for soft-deletable tables
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

-- Create helper function for never-deleted tables  
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

-- Install triggers on never-deleted (append-only) tables
-- These tables can NEVER be deleted, even by retention jobs
SELECT create_never_delete_trigger('audit_logs');
SELECT create_never_delete_trigger('outbox_events');
SELECT create_never_delete_trigger('idempotency_keys');
SELECT create_never_delete_trigger('config_values');
SELECT create_never_delete_trigger('commercial_products');
SELECT create_never_delete_trigger('price_versions');

-- Note: Soft-deletable tables (users, profiles, errands, etc.) will have triggers
-- installed when those tables are created in their respective migrations.
-- This migration only sets up the infrastructure.
