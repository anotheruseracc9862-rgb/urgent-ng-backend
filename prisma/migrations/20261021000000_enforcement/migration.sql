-- Phase 9 (P9-04): enforcement actions, their causes and the admin review queue
-- (Backend PRD 21.4, 21.7, A.9). Classes (PRD 26.8): enforcement_actions and
-- enforcement_action_events are never deleted (an action ends by status, never by removal);
-- enforcement_reviews is a soft-deletable case record.

-- ---------------------------------------------------------------------------------------------
-- enforcement_actions: every restriction, suspension or warning comes from one of these rows.
-- There is no direct change of a user's status without one.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "enforcement_actions" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "user_id" UUID NOT NULL,
    "type" "EnforcementActionType" NOT NULL,
    "reason" TEXT NOT NULL,
    -- LADDER (reliability points), SEVERE_EVENT (straight to a decision), ADMIN (an admin chose it).
    "trigger" TEXT NOT NULL,
    -- The ladder level that produced it: WARNING, RESTRICTION or SUSPENSION. Null for other triggers.
    "ladder_level" TEXT,
    -- Report, dispute or reliability event ids the action rests on.
    "case_ref" TEXT,
    "actor_type" "AuditActorType" NOT NULL,
    "actor_id" UUID,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3),
    "status" "RestrictionStatus" NOT NULL DEFAULT 'ACTIVE',
    -- A safety-critical suspension stops execution actions at once; a lower-level one lets the
    -- user finish the errands they already have (PRD 21.4).
    "safety_critical" BOOLEAN NOT NULL DEFAULT FALSE,
    -- What a BADGE_REMOVAL or CONTENT_REMOVAL targets.
    "target_badge" "BadgeType",
    "target_type" TEXT,
    "target_id" UUID,
    -- The account status before a suspension, restored when it ends.
    "user_status_before" "UserStatus",
    "appeal_requested_at" TIMESTAMPTZ(3),
    "appeal_note" TEXT,
    "appeal_due_at" TIMESTAMPTZ(3),
    "appeal_outcome" TEXT,
    "appeal_decided_by" UUID,
    "appeal_decided_at" TIMESTAMPTZ(3),
    "approval_request_id" UUID,
    "ended_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "enforcement_actions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "enforcement_actions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "enforcement_actions_trigger_valid" CHECK ("trigger" IN ('LADDER', 'SEVERE_EVENT', 'ADMIN')),
    CONSTRAINT "enforcement_actions_ladder_level_valid" CHECK ("ladder_level" IS NULL OR "ladder_level" IN ('WARNING', 'RESTRICTION', 'SUSPENSION')),
    CONSTRAINT "enforcement_actions_appeal_outcome_valid" CHECK ("appeal_outcome" IS NULL OR "appeal_outcome" IN ('UPHELD', 'REVOKED')),
    CONSTRAINT "enforcement_actions_window_valid" CHECK ("ends_at" IS NULL OR "ends_at" > "starts_at"),
    -- A permanent suspension has no end; a temporary one must.
    CONSTRAINT "enforcement_actions_permanent_open_ended" CHECK ("type" <> 'PERMANENT_SUSPENSION' OR "ends_at" IS NULL),
    CONSTRAINT "enforcement_actions_temporary_ends" CHECK ("type" <> 'TEMPORARY_SUSPENSION' OR "ends_at" IS NOT NULL),
    CONSTRAINT "enforcement_actions_appeal_decided_consistent" CHECK (("appeal_outcome" IS NULL) = ("appeal_decided_at" IS NULL))
);
CREATE INDEX "enforcement_actions_user_status_idx" ON "enforcement_actions"("user_id", "status");
CREATE INDEX "enforcement_actions_ends_idx" ON "enforcement_actions"("ends_at") WHERE "status" = 'ACTIVE' AND "ends_at" IS NOT NULL;
CREATE INDEX "enforcement_actions_ladder_idx" ON "enforcement_actions"("user_id", "ladder_level", "created_at") WHERE "ladder_level" IS NOT NULL;
CREATE INDEX "enforcement_actions_appeal_idx" ON "enforcement_actions"("appeal_requested_at") WHERE "appeal_requested_at" IS NOT NULL AND "appeal_outcome" IS NULL;
SELECT install_block_delete_trigger('enforcement_actions');

-- ---------------------------------------------------------------------------------------------
-- enforcement_action_events: the reliability events an action rests on
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "enforcement_action_events" (
    "enforcement_action_id" UUID NOT NULL,
    "reliability_event_id" UUID NOT NULL,

    CONSTRAINT "enforcement_action_events_pkey" PRIMARY KEY ("enforcement_action_id", "reliability_event_id"),
    CONSTRAINT "enforcement_action_events_action_fkey" FOREIGN KEY ("enforcement_action_id") REFERENCES "enforcement_actions"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "enforcement_action_events_event_fkey" FOREIGN KEY ("reliability_event_id") REFERENCES "reliability_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "enforcement_action_events_event_idx" ON "enforcement_action_events"("reliability_event_id");
SELECT install_block_delete_trigger('enforcement_action_events');

-- ---------------------------------------------------------------------------------------------
-- enforcement_reviews: cases that need an admin decision before any action (PRD 21.4)
--   LADDER_ADMIN_REVIEW  the points reached the admin-review threshold (permanent action)
--   SEVERE_EVENT         confirmed fraud, a safety incident or a prohibited item
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "enforcement_reviews" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "user_id" UUID NOT NULL,
    "trigger" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "case_ref" TEXT,
    "points" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "decided_by" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "decision_note" TEXT,
    "resulting_action_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "enforcement_reviews_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "enforcement_reviews_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "enforcement_reviews_decided_by_fkey" FOREIGN KEY ("decided_by") REFERENCES "admins"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "enforcement_reviews_action_fkey" FOREIGN KEY ("resulting_action_id") REFERENCES "enforcement_actions"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "enforcement_reviews_trigger_valid" CHECK ("trigger" IN ('LADDER_ADMIN_REVIEW', 'SEVERE_EVENT')),
    CONSTRAINT "enforcement_reviews_status_valid" CHECK ("status" IN ('OPEN', 'ACTIONED', 'DISMISSED')),
    CONSTRAINT "enforcement_reviews_decided_consistent" CHECK (("status" = 'OPEN') = ("decided_at" IS NULL))
);
-- One open review per user and trigger: a repeated signal does not queue it twice.
CREATE UNIQUE INDEX "enforcement_reviews_open_unique" ON "enforcement_reviews"("user_id", "trigger")
  WHERE "status" = 'OPEN' AND "deleted_at" IS NULL;
CREATE INDEX "enforcement_reviews_status_created_idx" ON "enforcement_reviews"("status", "created_at");
SELECT install_block_delete_trigger('enforcement_reviews');

-- ---------------------------------------------------------------------------------------------
-- Rows written before this table existed point at actions by id only: add the foreign keys now.
-- NOT VALID keeps any older row from failing the migration; new rows are checked.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE "user_restrictions"
  ADD CONSTRAINT "user_restrictions_enforcement_action_id_fkey"
  FOREIGN KEY ("enforcement_action_id") REFERENCES "enforcement_actions"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "blocklist_entries"
  ADD CONSTRAINT "blocklist_entries_source_enforcement_id_fkey"
  FOREIGN KEY ("source_enforcement_id") REFERENCES "enforcement_actions"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
