-- Phase 9 (P9-08): risk flags (Backend PRD 21.6, A.9). A risk flag records a signal for an admin
-- to look at. It never blocks a user by itself. Soft-deletable.

CREATE TABLE "risk_flags" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "user_id" UUID,
    "errand_id" UUID,
    -- OTP_ABUSE, OFFER_SPAM, FEED_PROBING, RATING_ANOMALY, SELF_DEALING, LOCATION_ANOMALY, ...
    "signal" TEXT NOT NULL,
    -- For signals that have no account yet (a one-time-code target): a keyed digest, never the value.
    "subject_key" TEXT,
    "details" JSONB,
    "status" "RiskFlagStatus" NOT NULL DEFAULT 'OPEN',
    -- The same signal raised again while a flag is open raises the count, not a second row.
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
    "reviewed_by" UUID,
    "reviewed_at" TIMESTAMPTZ(3),
    "review_note" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "risk_flags_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "risk_flags_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "risk_flags_errand_id_fkey" FOREIGN KEY ("errand_id") REFERENCES "errands"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "risk_flags_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "admins"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "risk_flags_occurrences_positive" CHECK ("occurrences" >= 1),
    CONSTRAINT "risk_flags_reviewed_consistent" CHECK (("status" = 'OPEN') = ("reviewed_at" IS NULL))
);
-- One open flag per signal and subject (user, errand, or key).
CREATE UNIQUE INDEX "risk_flags_open_unique" ON "risk_flags" (
    COALESCE("user_id", '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE("errand_id", '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE("subject_key", ''),
    "signal"
) WHERE "status" = 'OPEN' AND "deleted_at" IS NULL;
CREATE INDEX "risk_flags_status_created_idx" ON "risk_flags"("status", "created_at");
CREATE INDEX "risk_flags_user_idx" ON "risk_flags"("user_id") WHERE "user_id" IS NOT NULL;
SELECT install_block_delete_trigger('risk_flags');
