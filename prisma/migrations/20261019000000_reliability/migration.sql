-- Phase 9 (P9-02): reliability events and no-show reports (Backend PRD 21.1, A.9).
-- Classes (PRD 26.8): reliability_events is never deleted and is append-only (no UPDATE either);
-- no_show_reports is a soft-deletable case record.

-- ---------------------------------------------------------------------------------------------
-- reliability_events: objective marketplace facts. Points come from the event type and its
-- context; the table is the only source of truth for a user's reliability (explainable).
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "reliability_events" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "user_id" UUID NOT NULL,
    "errand_id" UUID,
    "assignment_id" UUID,
    "event_type" TEXT NOT NULL,
    "severity" SMALLINT NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "source" "AuditActorType" NOT NULL,
    "metadata" JSONB,
    -- Makes a retried consumer write each fact once: `<outbox event id>:<event type>:<user id>`.
    "dedupe_key" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reliability_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "reliability_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "reliability_events_errand_id_fkey" FOREIGN KEY ("errand_id") REFERENCES "errands"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "reliability_events_assignment_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "assignments"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "reliability_events_severity_non_negative" CHECK ("severity" >= 0),
    CONSTRAINT "reliability_events_type_known" CHECK ("event_type" IN (
      'OFFER_SUBMITTED', 'ASSIGNMENT_ACCEPTED', 'ASSIGNMENT_DECLINED', 'ASSIGNMENT_TIMEOUT', 'ASSIGNMENT_CANCELLED',
      'EXECUTION_STARTED', 'PICKUP_CONFIRMED', 'DELIVERY_CONFIRMED', 'ERRAND_COMPLETED', 'ERRAND_AUTO_COMPLETED',
      'ERRAND_DISPUTED', 'DISPUTE_RESOLVED', 'NO_SHOW', 'LATE_CANCELLATION', 'NO_RESPONSE_AFTER_ACCEPT',
      'FALSE_NON_COMPLETION_CLAIM', 'VALID_REPORT_UPHELD'
    ))
);
CREATE UNIQUE INDEX "reliability_events_dedupe_key_unique" ON "reliability_events"("dedupe_key");
CREATE INDEX "reliability_events_user_occurred_idx" ON "reliability_events"("user_id", "occurred_at" DESC);
CREATE INDEX "reliability_events_user_type_idx" ON "reliability_events"("user_id", "event_type");
CREATE INDEX "reliability_events_assignment_idx" ON "reliability_events"("assignment_id") WHERE "assignment_id" IS NOT NULL;
SELECT install_block_delete_trigger('reliability_events');

CREATE OR REPLACE FUNCTION reliability_events_block_update()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'reliability_events is append-only: UPDATE is not allowed';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER reliability_events_no_update
  BEFORE UPDATE ON reliability_events
  FOR EACH ROW EXECUTE FUNCTION reliability_events_block_update();

-- ---------------------------------------------------------------------------------------------
-- no_show_reports: one party says the other did not show up (PRD 21.1 definitions)
--   PENDING    the accused has been prompted and has until response_due_at
--   CONFIRMED  the accused acknowledged, did not answer in time, or an admin confirmed
--   CONTESTED  the accused says they are present: waits for an admin
--   DISMISSED  an admin did not uphold the report
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "no_show_reports" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "assignment_id" UUID NOT NULL,
    "errand_id" UUID NOT NULL,
    "reporter_id" UUID NOT NULL,
    "accused_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "note" TEXT,
    "response_due_at" TIMESTAMPTZ(3) NOT NULL,
    "responded_at" TIMESTAMPTZ(3),
    "resolved_at" TIMESTAMPTZ(3),
    "resolution_source" TEXT,
    "resolved_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "no_show_reports_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "no_show_reports_assignment_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "assignments"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "no_show_reports_errand_id_fkey" FOREIGN KEY ("errand_id") REFERENCES "errands"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "no_show_reports_reporter_id_fkey" FOREIGN KEY ("reporter_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "no_show_reports_accused_id_fkey" FOREIGN KEY ("accused_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "no_show_reports_resolved_by_fkey" FOREIGN KEY ("resolved_by") REFERENCES "admins"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "no_show_reports_parties_differ" CHECK ("reporter_id" <> "accused_id"),
    CONSTRAINT "no_show_reports_status_valid" CHECK ("status" IN ('PENDING', 'CONFIRMED', 'CONTESTED', 'DISMISSED')),
    CONSTRAINT "no_show_reports_source_valid" CHECK ("resolution_source" IS NULL OR "resolution_source" IN ('ACKNOWLEDGED', 'NO_RESPONSE', 'ADMIN')),
    CONSTRAINT "no_show_reports_resolved_has_time" CHECK (("status" IN ('CONFIRMED', 'DISMISSED')) = ("resolved_at" IS NOT NULL))
);
-- One open report per assignment.
CREATE UNIQUE INDEX "no_show_reports_open_unique" ON "no_show_reports"("assignment_id")
  WHERE "status" IN ('PENDING', 'CONTESTED') AND "deleted_at" IS NULL;
CREATE INDEX "no_show_reports_due_idx" ON "no_show_reports"("response_due_at") WHERE "status" = 'PENDING' AND "deleted_at" IS NULL;
CREATE INDEX "no_show_reports_assignment_idx" ON "no_show_reports"("assignment_id");
SELECT install_block_delete_trigger('no_show_reports');

-- The two parties are the assignment's requester and runner.
CREATE OR REPLACE FUNCTION no_show_reports_enforce_parties()
RETURNS TRIGGER AS $$
DECLARE
  a_requester UUID;
  a_runner UUID;
BEGIN
  SELECT requester_id, runner_id INTO a_requester, a_runner FROM assignments WHERE id = NEW.assignment_id;
  IF NOT ((NEW.reporter_id = a_requester AND NEW.accused_id = a_runner) OR (NEW.reporter_id = a_runner AND NEW.accused_id = a_requester)) THEN
    RAISE EXCEPTION 'no-show report parties do not match the assignment' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER no_show_reports_enforce_parties_trg
  BEFORE INSERT OR UPDATE OF assignment_id, reporter_id, accused_id ON no_show_reports
  FOR EACH ROW EXECUTE FUNCTION no_show_reports_enforce_parties();
