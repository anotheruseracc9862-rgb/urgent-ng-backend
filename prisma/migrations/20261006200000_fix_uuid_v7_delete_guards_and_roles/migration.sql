-- Phase 1 corrections (applied on top of the earlier P1 migrations; never edit applied migrations).
--
-- 1. uuid_generate_v7() was invalid ("cannot cast type bytea to uuid"). Replaced with a
--    working RFC 9562 implementation.
-- 2. Id defaults are (re)asserted so databases created from an earlier version of the P1
--    migrations get them too.
-- 3. The P1-01 demo tables are dropped; patterns are exercised by temporary tables in tests.
-- 4. Table classes follow Backend PRD section 26.8:
--      never deleted:   audit_logs, price_versions
--      soft-deletable:  config_values, commercial_products (get deleted_at)
--      transient:       outbox_events, idempotency_keys (only the retention role may delete)
-- 5. Least-privilege database roles: urgent_app (no DELETE anywhere) and urgent_retention
--    (DELETE on transient tables only). Login passwords are set by `npm run db:roles`,
--    never in a migration.
-- 6. Columns needed by the corrected outbox publisher and idempotency flow.

-- ---------------------------------------------------------------- 1. UUIDv7
CREATE OR REPLACE FUNCTION uuid_generate_v7()
RETURNS uuid
AS $$
  SELECT encode(
    set_bit(
      set_bit(
        overlay(
          uuid_send(gen_random_uuid())
          placing substring(int8send(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3)
          FROM 1 FOR 6
        ),
        52, 1
      ),
      53, 1
    ),
    'hex'
  )::uuid;
$$ LANGUAGE sql VOLATILE;

-- ---------------------------------------------------------------- 2. id defaults
ALTER TABLE audit_logs          ALTER COLUMN id SET DEFAULT uuid_generate_v7();
ALTER TABLE outbox_events       ALTER COLUMN id SET DEFAULT uuid_generate_v7();
ALTER TABLE idempotency_keys    ALTER COLUMN id SET DEFAULT uuid_generate_v7();
ALTER TABLE config_values       ALTER COLUMN id SET DEFAULT uuid_generate_v7();
ALTER TABLE commercial_products ALTER COLUMN id SET DEFAULT uuid_generate_v7();
ALTER TABLE price_versions      ALTER COLUMN id SET DEFAULT uuid_generate_v7();

-- ---------------------------------------------------------------- 3. demo tables
DROP TABLE IF EXISTS demo_locations;
DROP TABLE IF EXISTS demo_constraints;

-- ---------------------------------------------------------------- 6. new columns
-- soft deletion for config and product catalogue rows
ALTER TABLE config_values       ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE commercial_products ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- one row per (key, version): concurrent writers can no longer create the same version
ALTER TABLE config_values DROP CONSTRAINT IF EXISTS config_values_key_effective_unique;
CREATE UNIQUE INDEX IF NOT EXISTS config_values_key_effective_unique
  ON config_values (key, effective_from) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS config_values_key_version_unique
  ON config_values (key, version) WHERE deleted_at IS NULL;

-- commercial product codes can be reused after a soft delete
ALTER TABLE commercial_products DROP CONSTRAINT IF EXISTS commercial_products_code_key;
DROP INDEX IF EXISTS commercial_products_code_key;
CREATE UNIQUE INDEX IF NOT EXISTS commercial_products_code_unique
  ON commercial_products (code) WHERE deleted_at IS NULL;

-- outbox: lease marker so a crashed publisher cannot strand events in PROCESSING
ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMPTZ;

-- find stale leases quickly
CREATE INDEX IF NOT EXISTS outbox_events_processing_idx
  ON outbox_events (processing_started_at) WHERE status = 'PROCESSING';

-- idempotency: failed requests release their key so the client can retry
ALTER TABLE idempotency_keys ADD COLUMN IF NOT EXISTS failed_at TIMESTAMPTZ;

-- ---------------------------------------------------------------- 4. delete guards
-- Replace the per-table generated trigger functions from P1-10 with two shared ones.
DROP TRIGGER IF EXISTS audit_logs_never_delete          ON audit_logs;
DROP TRIGGER IF EXISTS outbox_events_never_delete       ON outbox_events;
DROP TRIGGER IF EXISTS idempotency_keys_never_delete    ON idempotency_keys;
DROP TRIGGER IF EXISTS config_values_never_delete       ON config_values;
DROP TRIGGER IF EXISTS commercial_products_never_delete ON commercial_products;
DROP TRIGGER IF EXISTS price_versions_never_delete      ON price_versions;
DROP FUNCTION IF EXISTS audit_logs_never_delete_func();
DROP FUNCTION IF EXISTS outbox_events_never_delete_func();
DROP FUNCTION IF EXISTS idempotency_keys_never_delete_func();
DROP FUNCTION IF EXISTS config_values_never_delete_func();
DROP FUNCTION IF EXISTS commercial_products_never_delete_func();
DROP FUNCTION IF EXISTS price_versions_never_delete_func();
DROP FUNCTION IF EXISTS create_soft_delete_trigger(TEXT);
DROP FUNCTION IF EXISTS create_never_delete_trigger(TEXT);

-- Soft-deletable and never-deleted tables: DELETE is always rejected, for every role.
CREATE OR REPLACE FUNCTION block_hard_delete()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Hard deletes are not allowed on table %. Soft delete (set deleted_at) or keep the row.', TG_TABLE_NAME
    USING ERRCODE = 'P0001';
END;
$$ LANGUAGE plpgsql;

-- Transient tables: only members of the retention role may delete.
CREATE OR REPLACE FUNCTION retention_only_delete()
RETURNS trigger AS $$
BEGIN
  IF NOT pg_has_role(session_user, 'urgent_retention', 'member') THEN
    RAISE EXCEPTION 'Deleting from table % is reserved for the retention job role (urgent_retention).', TG_TABLE_NAME
      USING ERRCODE = 'P0001';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

-- Install helpers for later migrations:
--   SELECT install_block_delete_trigger('errands');      -- soft-deletable or never-deleted
--   SELECT install_retention_delete_trigger('sessions'); -- transient
CREATE OR REPLACE FUNCTION install_block_delete_trigger(target regclass)
RETURNS void AS $$
BEGIN
  EXECUTE format('DROP TRIGGER IF EXISTS block_hard_delete ON %s', target);
  EXECUTE format('CREATE TRIGGER block_hard_delete BEFORE DELETE ON %s FOR EACH ROW EXECUTE FUNCTION block_hard_delete()', target);
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION install_retention_delete_trigger(target regclass)
RETURNS void AS $$
BEGIN
  EXECUTE format('DROP TRIGGER IF EXISTS retention_only_delete ON %s', target);
  EXECUTE format('CREATE TRIGGER retention_only_delete BEFORE DELETE ON %s FOR EACH ROW EXECUTE FUNCTION retention_only_delete()', target);
  -- the retention role may read and delete from transient tables
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'urgent_retention') THEN
    EXECUTE format('GRANT SELECT, DELETE ON %s TO urgent_retention', target);
  END IF;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------- 5. roles
-- Managed hosts (e.g. Northflank) do not give the migration user CREATEROLE. The roles are
-- dropped again by 20261006210000_single_database_login, so creation and every grant below
-- are skipped when the roles cannot be created.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'urgent_app') THEN
    CREATE ROLE urgent_app NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'urgent_retention') THEN
    CREATE ROLE urgent_retention NOLOGIN;
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'Skipping role creation: no CREATEROLE privilege';
END
$$;

-- triggers (the roles above must exist first because the retention trigger refers to one)
SELECT install_block_delete_trigger('audit_logs');
SELECT install_block_delete_trigger('price_versions');
SELECT install_block_delete_trigger('config_values');
SELECT install_block_delete_trigger('commercial_products');
SELECT install_retention_delete_trigger('outbox_events');
SELECT install_retention_delete_trigger('idempotency_keys');

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'urgent_app')
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'urgent_retention') THEN
    EXECUTE $q$GRANT USAGE ON SCHEMA public TO urgent_app, urgent_retention$q$;
    EXECUTE $q$GRANT EXECUTE ON FUNCTION uuid_generate_v7() TO urgent_app, urgent_retention$q$;
    EXECUTE $q$GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO urgent_app$q$;
    EXECUTE $q$GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO urgent_app$q$;
    EXECUTE $q$ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE ON TABLES TO urgent_app$q$;
    EXECUTE $q$ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO urgent_app$q$;
    EXECUTE $q$REVOKE UPDATE ON audit_logs     FROM urgent_app$q$;
    EXECUTE $q$REVOKE UPDATE ON price_versions FROM urgent_app$q$;
    EXECUTE $q$REVOKE ALL ON _prisma_migrations FROM urgent_app$q$;
  END IF;
END
$$;
