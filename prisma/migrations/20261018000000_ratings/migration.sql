-- Phase 9 (P9-01): ratings and derived user statistics (Backend PRD 20, A.2, A.9).
-- Classes (PRD 26.8): ratings is soft-deletable; rating_scores, rating_edits and user_stats are
-- never deleted (corrections are new rows or status changes).

-- ---------------------------------------------------------------------------------------------
-- ratings: one per party per assignment, bound to the assignment's two parties
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "ratings" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "assignment_id" UUID NOT NULL,
    "rater_id" UUID NOT NULL,
    "ratee_id" UUID NOT NULL,
    "direction" TEXT NOT NULL,
    "review" TEXT,
    "status" "RatingStatus" NOT NULL DEFAULT 'PUBLISHED',
    "revealed_at" TIMESTAMPTZ(3),
    "editable_until" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "ratings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ratings_assignment_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "assignments"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ratings_rater_id_fkey" FOREIGN KEY ("rater_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ratings_ratee_id_fkey" FOREIGN KEY ("ratee_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ratings_parties_differ" CHECK ("rater_id" <> "ratee_id"),
    CONSTRAINT "ratings_direction_valid" CHECK ("direction" IN ('REQUESTER_TO_RUNNER', 'RUNNER_TO_REQUESTER')),
    CONSTRAINT "ratings_review_length" CHECK ("review" IS NULL OR char_length("review") <= 1000)
);
CREATE UNIQUE INDEX "ratings_assignment_direction_unique" ON "ratings"("assignment_id", "direction") WHERE "deleted_at" IS NULL;
CREATE INDEX "ratings_ratee_status_idx" ON "ratings"("ratee_id", "status");
-- The reveal sweeper looks for unrevealed ratings.
CREATE INDEX "ratings_unrevealed_idx" ON "ratings"("created_at") WHERE "revealed_at" IS NULL AND "deleted_at" IS NULL;
SELECT install_block_delete_trigger('ratings');

-- A rating is by one party of the assignment about the other, in the direction that matches.
CREATE OR REPLACE FUNCTION ratings_enforce_parties()
RETURNS TRIGGER AS $$
DECLARE
  a_requester UUID;
  a_runner UUID;
BEGIN
  SELECT requester_id, runner_id INTO a_requester, a_runner FROM assignments WHERE id = NEW.assignment_id;
  IF NEW.direction = 'REQUESTER_TO_RUNNER' AND (NEW.rater_id <> a_requester OR NEW.ratee_id <> a_runner) THEN
    RAISE EXCEPTION 'rating parties do not match the assignment' USING ERRCODE = '23514';
  END IF;
  IF NEW.direction = 'RUNNER_TO_REQUESTER' AND (NEW.rater_id <> a_runner OR NEW.ratee_id <> a_requester) THEN
    RAISE EXCEPTION 'rating parties do not match the assignment' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ratings_enforce_parties_trg
  BEFORE INSERT OR UPDATE OF assignment_id, rater_id, ratee_id, direction ON ratings
  FOR EACH ROW EXECUTE FUNCTION ratings_enforce_parties();

-- ---------------------------------------------------------------------------------------------
-- rating_scores: one row per dimension (1 to 5)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "rating_scores" (
    "rating_id" UUID NOT NULL,
    "dimension" "RatingDimension" NOT NULL,
    "score" SMALLINT NOT NULL,

    CONSTRAINT "rating_scores_pkey" PRIMARY KEY ("rating_id", "dimension"),
    CONSTRAINT "rating_scores_rating_id_fkey" FOREIGN KEY ("rating_id") REFERENCES "ratings"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "rating_scores_score_range" CHECK ("score" BETWEEN 1 AND 5)
);
SELECT install_block_delete_trigger('rating_scores');

-- ---------------------------------------------------------------------------------------------
-- rating_edits: the previous content of a rating, kept for every edit
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "rating_edits" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "rating_id" UUID NOT NULL,
    "previous" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rating_edits_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "rating_edits_rating_id_fkey" FOREIGN KEY ("rating_id") REFERENCES "ratings"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "rating_edits_rating_idx" ON "rating_edits"("rating_id");
SELECT install_block_delete_trigger('rating_edits');

-- ---------------------------------------------------------------------------------------------
-- user_stats: derived aggregates, rebuildable from source rows (PRD A.2)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "user_stats" (
    "user_id" UUID NOT NULL,
    "completed_as_runner" INTEGER NOT NULL DEFAULT 0,
    "completed_as_requester" INTEGER NOT NULL DEFAULT 0,
    "runner_rating_count" INTEGER NOT NULL DEFAULT 0,
    "runner_rating_avg" DECIMAL(3,2),
    "requester_rating_count" INTEGER NOT NULL DEFAULT 0,
    "requester_rating_avg" DECIMAL(3,2),
    "payment_conduct_avg" DECIMAL(3,2),
    "payment_conduct_count" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_stats_pkey" PRIMARY KEY ("user_id"),
    CONSTRAINT "user_stats_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "user_stats_counts_non_negative" CHECK (
      "completed_as_runner" >= 0 AND "completed_as_requester" >= 0 AND "runner_rating_count" >= 0
      AND "requester_rating_count" >= 0 AND "payment_conduct_count" >= 0
    )
);
SELECT install_block_delete_trigger('user_stats');
