-- Phase 9 (P9-06, P9-07): runner location sharing and trusted-contact links
-- (Backend PRD 17.3 to 17.6, A.7, A.9). Classes (PRD 26.8): location_records is transient (a
-- retention job removes rows after LOCATION_HISTORY_RETENTION_DAYS); trusted_contact_shares is
-- soft-deletable.

-- The runner can stop sharing at any time (PRD 17.3). Kept on the assignment so it is one flag
-- per errand, not per update.
ALTER TABLE "assignments" ADD COLUMN "location_sharing_stopped_at" TIMESTAMPTZ(3);

-- ---------------------------------------------------------------------------------------------
-- location_records: the runner's exact position while an errand is active. Private: the API only
-- ever returns a rounded point (about 250 m) and a freshness label.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "location_records" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "assignment_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "point" geography(Point,4326) NOT NULL,
    "accuracy_meters" DECIMAL(7,1),
    "captured_at" TIMESTAMPTZ(3) NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "location_records_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "location_records_assignment_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "assignments"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "location_records_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "location_records_accuracy_non_negative" CHECK ("accuracy_meters" IS NULL OR "accuracy_meters" >= 0)
);
CREATE INDEX "location_records_assignment_captured_idx" ON "location_records"("assignment_id", "captured_at" DESC);
CREATE INDEX "location_records_captured_idx" ON "location_records"("captured_at");

-- The user who reports a position is the runner of the assignment.
CREATE OR REPLACE FUNCTION location_records_enforce_runner()
RETURNS TRIGGER AS $$
DECLARE
  a_runner UUID;
BEGIN
  SELECT runner_id INTO a_runner FROM assignments WHERE id = NEW.assignment_id;
  IF a_runner IS DISTINCT FROM NEW.user_id THEN
    RAISE EXCEPTION 'only the runner of an assignment reports its location' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER location_records_enforce_runner_trg
  BEFORE INSERT ON location_records
  FOR EACH ROW EXECUTE FUNCTION location_records_enforce_runner();

-- ---------------------------------------------------------------------------------------------
-- trusted_contact_shares: a read-only link to an active errand. Only a hash of the token is kept.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "trusted_contact_shares" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "errand_id" UUID NOT NULL,
    "created_by" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "status" "TrustedShareStatus" NOT NULL DEFAULT 'ACTIVE',
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "view_count" INTEGER NOT NULL DEFAULT 0,
    "last_viewed_at" TIMESTAMPTZ(3),
    "concern_raised_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "trusted_contact_shares_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "trusted_contact_shares_errand_id_fkey" FOREIGN KEY ("errand_id") REFERENCES "errands"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "trusted_contact_shares_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "trusted_contact_shares_view_count_non_negative" CHECK ("view_count" >= 0),
    CONSTRAINT "trusted_contact_shares_revoked_consistent" CHECK (("status" = 'REVOKED') = ("revoked_at" IS NOT NULL))
);
CREATE UNIQUE INDEX "trusted_contact_shares_token_hash_unique" ON "trusted_contact_shares"("token_hash");
CREATE INDEX "trusted_contact_shares_errand_status_idx" ON "trusted_contact_shares"("errand_id", "status");
CREATE INDEX "trusted_contact_shares_expires_idx" ON "trusted_contact_shares"("expires_at") WHERE "status" IN ('CREATED', 'ACTIVE');
SELECT install_block_delete_trigger('trusted_contact_shares');
