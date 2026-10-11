-- Phase 9 (P9-03): reports, disputes and their evidence (Backend PRD 21.2, 21.3, A.9).
-- Classes (PRD 26.8): reports and disputes are soft-deletable case records; evidence_links is never
-- deleted. Open statuses: reports OPEN, UNDER_REVIEW, ACTION_REQUIRED; disputes OPEN, UNDER_REVIEW.

-- ---------------------------------------------------------------------------------------------
-- disputes: a structured case about an errand that can change its outcome
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "disputes" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "errand_id" UUID NOT NULL,
    "assignment_id" UUID NOT NULL,
    "opened_by" UUID NOT NULL,
    "type" "DisputeType" NOT NULL,
    "status" "DisputeStatus" NOT NULL DEFAULT 'OPEN',
    "claim" TEXT NOT NULL,
    "resolution" "DisputeResolution",
    "resolution_notes" TEXT,
    "resolved_by" UUID,
    "resolved_at" TIMESTAMPTZ(3),
    "first_response_at" TIMESTAMPTZ(3),
    -- First admin response due (DISPUTE_FIRST_RESPONSE_HOURS) and resolution due (DISPUTE_RESOLUTION_DAYS).
    "sla_due_at" TIMESTAMPTZ(3),
    "resolution_due_at" TIMESTAMPTZ(3),
    "retention_hold" BOOLEAN NOT NULL DEFAULT TRUE,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "disputes_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "disputes_errand_id_fkey" FOREIGN KEY ("errand_id") REFERENCES "errands"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "disputes_assignment_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "assignments"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "disputes_opened_by_fkey" FOREIGN KEY ("opened_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "disputes_resolved_by_fkey" FOREIGN KEY ("resolved_by") REFERENCES "admins"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "disputes_claim_length" CHECK (char_length("claim") BETWEEN 1 AND 2000),
    CONSTRAINT "disputes_resolved_consistent" CHECK (
      ("status" IN ('RESOLVED', 'CLOSED')) = ("resolved_at" IS NOT NULL AND "resolution" IS NOT NULL)
    )
);
-- One open dispute per assignment.
CREATE UNIQUE INDEX "disputes_open_assignment_unique" ON "disputes"("assignment_id")
  WHERE "status" IN ('OPEN', 'UNDER_REVIEW') AND "deleted_at" IS NULL;
CREATE INDEX "disputes_status_created_idx" ON "disputes"("status", "created_at");
CREATE INDEX "disputes_errand_idx" ON "disputes"("errand_id");
SELECT install_block_delete_trigger('disputes');

-- The opener is the requester or the runner of the assignment, and the assignment belongs to the errand.
CREATE OR REPLACE FUNCTION disputes_enforce_parties()
RETURNS TRIGGER AS $$
DECLARE
  a_errand UUID;
  a_requester UUID;
  a_runner UUID;
BEGIN
  SELECT errand_id, requester_id, runner_id INTO a_errand, a_requester, a_runner FROM assignments WHERE id = NEW.assignment_id;
  IF a_errand IS DISTINCT FROM NEW.errand_id THEN
    RAISE EXCEPTION 'dispute assignment does not belong to its errand' USING ERRCODE = '23514';
  END IF;
  IF NEW.opened_by <> a_requester AND NEW.opened_by <> a_runner THEN
    RAISE EXCEPTION 'a dispute can only be opened by a party of the assignment' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER disputes_enforce_parties_trg
  BEFORE INSERT OR UPDATE OF errand_id, assignment_id, opened_by ON disputes
  FOR EACH ROW EXECUTE FUNCTION disputes_enforce_parties();

-- ---------------------------------------------------------------------------------------------
-- reports: a complaint about conduct or content
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "reports" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "reporter_id" UUID NOT NULL,
    "target_type" "ReportTargetType" NOT NULL,
    "target_user_id" UUID,
    "errand_id" UUID,
    "assignment_id" UUID,
    "message_id" UUID,
    "rating_id" UUID,
    "type" "ReportType" NOT NULL,
    "description" TEXT NOT NULL,
    "status" "ReportStatus" NOT NULL DEFAULT 'OPEN',
    -- UPHELD or DISMISSED, set by the admin decision. An upheld report writes a reliability fact.
    "outcome" TEXT,
    "resolution" TEXT,
    "resolved_by" UUID,
    "resolved_at" TIMESTAMPTZ(3),
    "first_response_at" TIMESTAMPTZ(3),
    "sla_due_at" TIMESTAMPTZ(3),
    "pauses_auto_completion" BOOLEAN NOT NULL DEFAULT FALSE,
    "retention_hold" BOOLEAN NOT NULL DEFAULT FALSE,
    -- An admin can link a report to a dispute (PRD 21.3).
    "dispute_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "reports_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "reports_reporter_id_fkey" FOREIGN KEY ("reporter_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "reports_target_user_id_fkey" FOREIGN KEY ("target_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "reports_errand_id_fkey" FOREIGN KEY ("errand_id") REFERENCES "errands"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "reports_assignment_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "assignments"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "reports_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "reports_rating_id_fkey" FOREIGN KEY ("rating_id") REFERENCES "ratings"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "reports_resolved_by_fkey" FOREIGN KEY ("resolved_by") REFERENCES "admins"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "reports_dispute_id_fkey" FOREIGN KEY ("dispute_id") REFERENCES "disputes"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "reports_description_length" CHECK (char_length("description") BETWEEN 1 AND 2000),
    CONSTRAINT "reports_not_self" CHECK ("target_user_id" IS NULL OR "target_user_id" <> "reporter_id"),
    CONSTRAINT "reports_target_present" CHECK (
      ("target_type" = 'USER' AND "target_user_id" IS NOT NULL)
      OR ("target_type" = 'ERRAND' AND "errand_id" IS NOT NULL)
      OR ("target_type" = 'MESSAGE' AND "message_id" IS NOT NULL)
      OR ("target_type" = 'RATING' AND "rating_id" IS NOT NULL)
    ),
    CONSTRAINT "reports_outcome_valid" CHECK ("outcome" IS NULL OR "outcome" IN ('UPHELD', 'DISMISSED')),
    CONSTRAINT "reports_decided_consistent" CHECK (
      ("status" IN ('RESOLVED', 'DISMISSED')) = ("resolved_at" IS NOT NULL AND "outcome" IS NOT NULL)
    )
);
CREATE INDEX "reports_status_created_idx" ON "reports"("status", "created_at");
CREATE INDEX "reports_errand_idx" ON "reports"("errand_id") WHERE "errand_id" IS NOT NULL;
CREATE INDEX "reports_target_user_idx" ON "reports"("target_user_id") WHERE "target_user_id" IS NOT NULL;
CREATE INDEX "reports_reporter_created_idx" ON "reports"("reporter_id", "created_at" DESC);
-- Open reports that hold an errand's auto-completion.
CREATE INDEX "reports_open_pausing_idx" ON "reports"("errand_id")
  WHERE "pauses_auto_completion" AND "status" IN ('OPEN', 'UNDER_REVIEW', 'ACTION_REQUIRED') AND "deleted_at" IS NULL;
SELECT install_block_delete_trigger('reports');

-- ---------------------------------------------------------------------------------------------
-- evidence_links: what a case rests on, each keeping its source id (PRD 21.3). There is no payment
-- evidence in the product, so no source type for it.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "evidence_links" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "dispute_id" UUID,
    "report_id" UUID,
    "source_type" "EvidenceSourceType" NOT NULL,
    "source_id" UUID,
    "statement" TEXT,
    "added_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "evidence_links_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "evidence_links_dispute_id_fkey" FOREIGN KEY ("dispute_id") REFERENCES "disputes"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "evidence_links_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "reports"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "evidence_links_one_case" CHECK (("dispute_id" IS NULL) <> ("report_id" IS NULL)),
    CONSTRAINT "evidence_links_source_present" CHECK (
      ("source_type" = 'STATEMENT' AND "statement" IS NOT NULL) OR ("source_type" <> 'STATEMENT' AND "source_id" IS NOT NULL)
    ),
    CONSTRAINT "evidence_links_statement_length" CHECK ("statement" IS NULL OR char_length("statement") <= 2000)
);
CREATE INDEX "evidence_links_dispute_idx" ON "evidence_links"("dispute_id") WHERE "dispute_id" IS NOT NULL;
CREATE INDEX "evidence_links_report_idx" ON "evidence_links"("report_id") WHERE "report_id" IS NOT NULL;
-- Dispute media is looked up by media id for the access policy.
CREATE INDEX "evidence_links_media_idx" ON "evidence_links"("source_id") WHERE "source_type" = 'MEDIA';
SELECT install_block_delete_trigger('evidence_links');
