-- Phase 9 (P9-05): earned badges (Backend PRD 21.5, A.9). user_badges is a cache of rules computed
-- from source rows, never deleted (a badge ends with revoked_at). user_stats remembers when its
-- owner's badges were last recomputed, for the nightly pass.

CREATE TABLE "user_badges" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "user_id" UUID NOT NULL,
    "badge" "BadgeType" NOT NULL,
    "awarded_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "revoked_reason" TEXT,
    -- The figures the rule used when it awarded the badge (for support and audit).
    "reason_snapshot" JSONB NOT NULL,

    CONSTRAINT "user_badges_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "user_badges_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "user_badges_revoked_after_awarded" CHECK ("revoked_at" IS NULL OR "revoked_at" >= "awarded_at")
);
-- One live badge of a kind per user.
CREATE UNIQUE INDEX "user_badges_live_unique" ON "user_badges"("user_id", "badge") WHERE "revoked_at" IS NULL;
CREATE INDEX "user_badges_user_idx" ON "user_badges"("user_id");
SELECT install_block_delete_trigger('user_badges');

ALTER TABLE "user_stats" ADD COLUMN "badges_computed_at" TIMESTAMPTZ(3);
CREATE INDEX "user_stats_badges_computed_idx" ON "user_stats"("badges_computed_at" NULLS FIRST);
