-- P2-01: Identity and access schema
-- Per PRD Appendix A.3

-- Ensure trigger helper functions exist (idempotent)
CREATE OR REPLACE FUNCTION create_soft_delete_trigger(table_name TEXT)
RETURNS VOID AS $$
DECLARE
  trigger_name TEXT := table_name || '_prevent_delete';
BEGIN
  EXECUTE format('
    CREATE OR REPLACE FUNCTION %I()
    RETURNS TRIGGER AS $func$
    BEGIN
      RAISE EXCEPTION ''Hard deletes are not allowed on table %s. Use soft deletion (SET deleted_at = NOW()) instead.'';
      RETURN NULL;
    END;
    $func$ LANGUAGE plpgsql;
  ', trigger_name || '_func', table_name);

  EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', trigger_name, table_name);

  EXECUTE format('
    CREATE TRIGGER %I
    BEFORE DELETE ON %I
    FOR EACH ROW
    EXECUTE FUNCTION %I();
  ', trigger_name, table_name, trigger_name || '_func');
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION create_never_delete_trigger(table_name TEXT)
RETURNS VOID AS $$
DECLARE
  trigger_name TEXT := table_name || '_never_delete';
BEGIN
  EXECUTE format('
    CREATE OR REPLACE FUNCTION %I()
    RETURNS TRIGGER AS $func$
    BEGIN
      RAISE EXCEPTION ''Deletes are never allowed on table %s. This is an append-only table.'';
      RETURN NULL;
    END;
    $func$ LANGUAGE plpgsql;
  ', trigger_name || '_func', table_name);

  EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', trigger_name, table_name);

  EXECUTE format('
    CREATE TRIGGER %I
    BEFORE DELETE ON %I
    FOR EACH ROW
    EXECUTE FUNCTION %I();
  ', trigger_name, table_name, trigger_name || '_func');
END;
$$ LANGUAGE plpgsql;

-- Add missing enum values (ignore errors if they already exist)
DO $$ BEGIN
  ALTER TYPE "ConsentType" ADD VALUE IF NOT EXISTS 'SAFETY_GUIDELINES';
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TYPE "BlocklistType" ADD VALUE IF NOT EXISTS 'IDENTITY_HMAC';
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TYPE "BlocklistType" ADD VALUE IF NOT EXISTS 'DEVICE';
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TYPE "NotificationChannel" ADD VALUE IF NOT EXISTS 'EMAIL';
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TYPE "NotificationChannel" ADD VALUE IF NOT EXISTS 'SMS';
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TYPE "NotificationCategory" ADD VALUE IF NOT EXISTS 'ERRAND_UPDATES';
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TYPE "NotificationCategory" ADD VALUE IF NOT EXISTS 'OFFER_ACTIVITY';
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TYPE "NotificationCategory" ADD VALUE IF NOT EXISTS 'MESSAGES';
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TYPE "NotificationCategory" ADD VALUE IF NOT EXISTS 'PAYMENTS';
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TYPE "NotificationCategory" ADD VALUE IF NOT EXISTS 'RATINGS';
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TYPE "NotificationCategory" ADD VALUE IF NOT EXISTS 'ACCOUNT';
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TYPE "NotificationCategory" ADD VALUE IF NOT EXISTS 'PROMOTIONS';
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TYPE "NotificationCategory" ADD VALUE IF NOT EXISTS 'NEARBY_ERRANDS';
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TYPE "DeviceType" ADD VALUE IF NOT EXISTS 'ANDROID';
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TYPE "DeviceType" ADD VALUE IF NOT EXISTS 'IOS';
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TYPE "DeviceType" ADD VALUE IF NOT EXISTS 'WEB';
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- Create users table
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "name" TEXT NOT NULL,
    "first_name" TEXT NOT NULL,
    "last_name" TEXT NOT NULL,
    "email" TEXT,
    "email_verified_at" TIMESTAMPTZ(3),
    "phone_e164" TEXT,
    "phone_verified_at" TIMESTAMPTZ(3),
    "password_hash" TEXT NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "start_mode" "StartMode",
    "failed_login_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(3),
    "last_login_at" TIMESTAMPTZ(3),
    "deactivated_at" TIMESTAMPTZ(3),
    "deletion_requested_at" TIMESTAMPTZ(3),
    "deletion_scheduled_at" TIMESTAMPTZ(3),
    "anonymised_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "users_email_or_phone" CHECK ("email" IS NOT NULL OR "phone_e164" IS NOT NULL),
    CONSTRAINT "users_phone_e164_format" CHECK ("phone_e164" ~ '^\+234[0-9]{10}$')
);

-- Partial unique indexes (where deletedAt IS NULL for soft-delete reuse)
CREATE UNIQUE INDEX "users_email_unique" ON "users"("email") WHERE "email" IS NOT NULL AND "deleted_at" IS NULL;
CREATE UNIQUE INDEX "users_phone_unique" ON "users"("phone_e164") WHERE "phone_e164" IS NOT NULL AND "deleted_at" IS NULL;

-- Regular indexes
CREATE INDEX "users_status_idx" ON "users"("status");
CREATE INDEX "users_deletion_scheduled_idx" ON "users"("deletion_scheduled_at") WHERE "status" = 'DELETION_PENDING'::"UserStatus";

-- Install soft delete trigger on users
SELECT create_soft_delete_trigger('users'::text);

-- Create profiles table
CREATE TABLE "profiles" (
    "user_id" UUID NOT NULL,
    "photo_media_id" UUID,
    "home_point" VARCHAR,
    "home_area" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "profiles_pkey" PRIMARY KEY ("user_id"),
    CONSTRAINT "profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT
);

-- Install soft delete trigger on profiles
SELECT create_soft_delete_trigger('profiles'::text);

-- Create auth_sessions table (transient, real deletes allowed)
CREATE TABLE "auth_sessions" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "user_id" UUID NOT NULL,
    "family_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "user_agent" TEXT,
    "ip" INET,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "replaced_by_token_hash" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_sessions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "auth_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT
);

CREATE UNIQUE INDEX "auth_sessions_token_hash_unique" ON "auth_sessions"("token_hash");
CREATE INDEX "auth_sessions_user_revoked_idx" ON "auth_sessions"("user_id", "revoked_at");
CREATE INDEX "auth_sessions_family_idx" ON "auth_sessions"("family_id");
CREATE INDEX "auth_sessions_expires_idx" ON "auth_sessions"("expires_at");

-- Create policy_versions table (never deleted)
CREATE TABLE "policy_versions" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "type" "ConsentType" NOT NULL,
    "version" TEXT NOT NULL,
    "document_ref" TEXT NOT NULL,
    "published_at" TIMESTAMPTZ(3) NOT NULL,
    "requires_reacceptance" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "policy_versions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "policy_versions_type_version_unique" ON "policy_versions"("type", "version");

-- Install never-delete trigger on policy_versions
SELECT create_never_delete_trigger('policy_versions'::text);

-- Create consent_records table (never deleted)
CREATE TABLE "consent_records" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "user_id" UUID NOT NULL,
    "consent_type" "ConsentType" NOT NULL,
    "document_version" TEXT NOT NULL,
    "accepted_at" TIMESTAMPTZ(3) NOT NULL,
    "withdrawn_at" TIMESTAMPTZ(3),
    "ip_address" INET,
    "user_agent" TEXT,

    CONSTRAINT "consent_records_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "consent_records_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT
);

CREATE INDEX "consent_records_user_type_idx" ON "consent_records"("user_id", "consent_type", "accepted_at");

-- Install never-delete trigger on consent_records
SELECT create_never_delete_trigger('consent_records'::text);

-- Create blocks table
CREATE TABLE "blocks" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "blocker_id" UUID NOT NULL,
    "blocked_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "blocks_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "blocks_blocker_id_fkey" FOREIGN KEY ("blocker_id") REFERENCES "users"("id") ON DELETE RESTRICT,
    CONSTRAINT "blocks_blocked_id_fkey" FOREIGN KEY ("blocked_id") REFERENCES "users"("id") ON DELETE RESTRICT,
    CONSTRAINT "blocks_not_self" CHECK ("blocker_id" <> "blocked_id")
);

CREATE UNIQUE INDEX "blocks_blocker_blocked_unique" ON "blocks"("blocker_id", "blocked_id") WHERE "deleted_at" IS NULL;

-- Install soft delete trigger on blocks
SELECT create_soft_delete_trigger('blocks'::text);

-- Create blocklist_entries table
CREATE TABLE "blocklist_entries" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "type" "BlocklistType" NOT NULL,
    "value_hash" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "source_enforcement_id" UUID,
    "expires_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "blocklist_entries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "blocklist_entries_type_hash_unique" ON "blocklist_entries"("type", "value_hash") WHERE "deleted_at" IS NULL;

-- Install soft delete trigger on blocklist_entries
SELECT create_soft_delete_trigger('blocklist_entries'::text);

-- Create notification_preferences table
CREATE TABLE "notification_preferences" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "user_id" UUID NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "category" "NotificationCategory" NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "quiet_hours_start" TIME,
    "quiet_hours_end" TIME,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "notification_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT
);

CREATE UNIQUE INDEX "notification_prefs_user_channel_category_unique" 
  ON "notification_preferences"("user_id", "channel", "category") 
  WHERE "deleted_at" IS NULL;

-- Install soft delete trigger on notification_preferences
SELECT create_soft_delete_trigger('notification_preferences'::text);

-- Create devices table
CREATE TABLE "devices" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "user_id" UUID NOT NULL,
    "type" "DeviceType" NOT NULL,
    "push_token" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "last_seen_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "devices_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "devices_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT
);

CREATE UNIQUE INDEX "devices_push_token_unique" ON "devices"("push_token");
CREATE INDEX "devices_user_idx" ON "devices"("user_id");

-- Install soft delete trigger on devices
SELECT create_soft_delete_trigger('devices'::text);

-- Create user_restrictions table
CREATE TABLE "user_restrictions" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "user_id" UUID NOT NULL,
    "type" "UserRestrictionType" NOT NULL,
    "status" "RestrictionStatus" NOT NULL DEFAULT 'ACTIVE',
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3),
    "enforcement_action_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "user_restrictions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "user_restrictions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT
);

CREATE INDEX "user_restrictions_user_status_type_idx" ON "user_restrictions"("user_id", "status", "type");
CREATE INDEX "user_restrictions_ends_at_idx" ON "user_restrictions"("ends_at") WHERE "status" = 'ACTIVE'::"RestrictionStatus";

-- Install soft delete trigger on user_restrictions
SELECT create_soft_delete_trigger('user_restrictions'::text);
