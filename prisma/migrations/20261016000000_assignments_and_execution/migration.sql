-- P7-01: assignment and execution schema (Backend PRD 14, 15, 16, A.7).
-- Classes (PRD 26.8): assignments, payment_agreements, execution_problems and change_requests are
-- soft-deletable; execution_events and checkpoints are never deleted. DELETE is blocked on all
-- of them by the same trigger the other business tables use.

-- ---------------------------------------------------------------------------------------------
-- assignments
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "assignments" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "errand_id" UUID NOT NULL,
    "requester_id" UUID NOT NULL,
    "runner_id" UUID NOT NULL,
    "selected_offer_id" UUID NOT NULL,
    "status" "AssignmentStatus" NOT NULL DEFAULT 'PENDING_ACCEPTANCE',
    "agreed_amount_minor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "selected_at" TIMESTAMPTZ(3) NOT NULL,
    "acceptance_deadline" TIMESTAMPTZ(3) NOT NULL,
    "accepted_at" TIMESTAMPTZ(3),
    "declined_at" TIMESTAMPTZ(3),
    "timed_out_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "cancelled_by" UUID,
    "cancelled_by_type" "AuditActorType",
    "cancellation_reason" "ErrandCancellationReason",
    "cancellation_note" TEXT,
    "cancelled_stage" "ErrandStatus",
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "assignments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "assignments_errand_id_fkey" FOREIGN KEY ("errand_id") REFERENCES "errands"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "assignments_requester_id_fkey" FOREIGN KEY ("requester_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "assignments_runner_id_fkey" FOREIGN KEY ("runner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "assignments_selected_offer_id_fkey" FOREIGN KEY ("selected_offer_id") REFERENCES "offers"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "assignments_parties_differ" CHECK ("requester_id" <> "runner_id"),
    CONSTRAINT "assignments_amount_positive" CHECK ("agreed_amount_minor" > 0),
    CONSTRAINT "assignments_currency_ngn" CHECK ("currency" = 'NGN'),
    CONSTRAINT "assignments_version_non_negative" CHECK ("version" >= 0),
    -- Status-dependent fields: the timestamp that explains the status is always there.
    CONSTRAINT "assignments_status_fields" CHECK (
      ("status" = 'PENDING_ACCEPTANCE' AND "accepted_at" IS NULL AND "declined_at" IS NULL AND "timed_out_at" IS NULL
         AND "cancelled_at" IS NULL AND "completed_at" IS NULL)
      OR ("status" = 'ACCEPTED' AND "accepted_at" IS NOT NULL AND "declined_at" IS NULL AND "timed_out_at" IS NULL
         AND "cancelled_at" IS NULL AND "completed_at" IS NULL)
      OR ("status" = 'DECLINED' AND "declined_at" IS NOT NULL AND "accepted_at" IS NULL)
      OR ("status" = 'TIMED_OUT' AND "timed_out_at" IS NOT NULL AND "accepted_at" IS NULL)
      OR ("status" = 'CANCELLED' AND "cancelled_at" IS NOT NULL AND "cancellation_reason" IS NOT NULL AND "cancelled_by_type" IS NOT NULL)
      OR ("status" = 'COMPLETED' AND "accepted_at" IS NOT NULL AND "completed_at" IS NOT NULL)
    )
);

-- INV-004: at most one non-terminal assignment per errand. COMPLETED, DECLINED, TIMED_OUT and
-- CANCELLED rows are history and do not block a new selection.
CREATE UNIQUE INDEX "assignments_errand_live_unique" ON "assignments"("errand_id")
  WHERE "status" IN ('PENDING_ACCEPTANCE', 'ACCEPTED') AND "deleted_at" IS NULL;
-- An offer is selected at most once.
CREATE UNIQUE INDEX "assignments_selected_offer_unique" ON "assignments"("selected_offer_id") WHERE "deleted_at" IS NULL;
CREATE INDEX "assignments_runner_status_idx" ON "assignments"("runner_id", "status");
CREATE INDEX "assignments_requester_status_idx" ON "assignments"("requester_id", "status");
CREATE INDEX "assignments_errand_idx" ON "assignments"("errand_id");
-- The acceptance sweeper (timers are database facts, Backend PRD 25.3).
CREATE INDEX "assignments_acceptance_deadline_idx" ON "assignments"("acceptance_deadline") WHERE "status" = 'PENDING_ACCEPTANCE';
SELECT install_block_delete_trigger('assignments');

-- The parties of an assignment are the parties of the errand and of the selected offer. The
-- service checks this too; the database is the last line (Backend PRD 3.5, 26.2).
CREATE OR REPLACE FUNCTION assignments_enforce_parties()
RETURNS TRIGGER AS $$
DECLARE
  errand_requester UUID;
  offer_errand UUID;
  offer_runner UUID;
  offer_requester UUID;
BEGIN
  SELECT requester_id INTO errand_requester FROM errands WHERE id = NEW.errand_id;
  IF errand_requester IS DISTINCT FROM NEW.requester_id THEN
    RAISE EXCEPTION 'assignment requester does not match the errand requester' USING ERRCODE = '23514';
  END IF;
  SELECT errand_id, runner_id, requester_id INTO offer_errand, offer_runner, offer_requester
    FROM offers WHERE id = NEW.selected_offer_id;
  IF offer_errand IS DISTINCT FROM NEW.errand_id
     OR offer_runner IS DISTINCT FROM NEW.runner_id
     OR offer_requester IS DISTINCT FROM NEW.requester_id THEN
    RAISE EXCEPTION 'assignment does not match its selected offer' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER assignments_enforce_parties_trg
  BEFORE INSERT OR UPDATE OF errand_id, requester_id, runner_id, selected_offer_id ON assignments
  FOR EACH ROW EXECUTE FUNCTION assignments_enforce_parties();

-- ---------------------------------------------------------------------------------------------
-- payment_agreements (1:1 with assignments). Records what the parties say they agreed. It never
-- means Urgent.ng received money (INV-008).
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "payment_agreements" (
    "assignment_id" UUID NOT NULL,
    "agreed_amount_minor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "payment_method" "PaymentMethod",
    "payment_timing" "PaymentTiming",
    "confirmed_by_requester_at" TIMESTAMPTZ(3),
    "confirmed_by_runner_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "payment_agreements_pkey" PRIMARY KEY ("assignment_id"),
    CONSTRAINT "payment_agreements_assignment_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "assignments"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "payment_agreements_amount_positive" CHECK ("agreed_amount_minor" > 0),
    CONSTRAINT "payment_agreements_currency_ngn" CHECK ("currency" = 'NGN')
);
SELECT install_block_delete_trigger('payment_agreements');

-- ---------------------------------------------------------------------------------------------
-- execution_events (append-only)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "execution_events" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "assignment_id" UUID NOT NULL,
    "errand_id" UUID NOT NULL,
    "type" "ExecutionEventType" NOT NULL,
    "actor_id" UUID,
    "actor_type" "AuditActorType" NOT NULL,
    "note" TEXT,
    "media_id" UUID,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "execution_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "execution_events_assignment_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "assignments"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "execution_events_errand_id_fkey" FOREIGN KEY ("errand_id") REFERENCES "errands"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "execution_events_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "media"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "execution_events_assignment_created_idx" ON "execution_events"("assignment_id", "created_at");
CREATE INDEX "execution_events_errand_created_idx" ON "execution_events"("errand_id", "created_at");
SELECT install_block_delete_trigger('execution_events');

CREATE OR REPLACE FUNCTION execution_events_reject_update()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'execution_events rows are immutable' USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER execution_events_no_update
  BEFORE UPDATE ON execution_events
  FOR EACH ROW EXECUTE FUNCTION execution_events_reject_update();

-- ---------------------------------------------------------------------------------------------
-- execution_problems (PRD 15.4). Reporting never changes the errand status.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "execution_problems" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "assignment_id" UUID NOT NULL,
    "reported_by" UUID NOT NULL,
    "type" "ExecutionProblemType" NOT NULL,
    "note" TEXT,
    "media_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "resolved_at" TIMESTAMPTZ(3),
    "resolved_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "execution_problems_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "execution_problems_assignment_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "assignments"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "execution_problems_reported_by_fkey" FOREIGN KEY ("reported_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "execution_problems_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "media"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "execution_problems_status_values" CHECK ("status" IN ('OPEN', 'RESOLVED')),
    CONSTRAINT "execution_problems_resolved_fields" CHECK (
      ("status" = 'OPEN' AND "resolved_at" IS NULL) OR ("status" = 'RESOLVED' AND "resolved_at" IS NOT NULL)
    )
);
CREATE INDEX "execution_problems_assignment_status_idx" ON "execution_problems"("assignment_id", "status");
SELECT install_block_delete_trigger('execution_problems');

-- ---------------------------------------------------------------------------------------------
-- checkpoints (pickup and delivery evidence). The point is private: raw SQL only.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "checkpoints" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "assignment_id" UUID NOT NULL,
    "type" "CheckpointType" NOT NULL,
    "point" geography(Point, 4326),
    "captured_at" TIMESTAMPTZ(3) NOT NULL,
    "note" TEXT,
    "media_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "checkpoints_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "checkpoints_assignment_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "assignments"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "checkpoints_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "media"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
-- One pickup and one delivery checkpoint per assignment.
CREATE UNIQUE INDEX "checkpoints_assignment_type_unique" ON "checkpoints"("assignment_id", "type");
SELECT install_block_delete_trigger('checkpoints');

-- ---------------------------------------------------------------------------------------------
-- change_requests (PRD 15.6). One pending request per assignment.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "change_requests" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "assignment_id" UUID NOT NULL,
    "requested_by" UUID NOT NULL,
    "type" "ChangeRequestType" NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "ChangeRequestStatus" NOT NULL DEFAULT 'PENDING',
    "responded_by" UUID,
    "responded_at" TIMESTAMPTZ(3),
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "change_requests_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "change_requests_assignment_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "assignments"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "change_requests_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "change_requests_responded_by_fkey" FOREIGN KEY ("responded_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "change_requests_responder_differs" CHECK ("responded_by" IS NULL OR "responded_by" <> "requested_by" OR "status" = 'CANCELLED'),
    CONSTRAINT "change_requests_pending_fields" CHECK (
      ("status" = 'PENDING' AND "responded_at" IS NULL)
      OR ("status" IN ('ACCEPTED', 'REJECTED') AND "responded_at" IS NOT NULL AND "responded_by" IS NOT NULL)
      OR "status" IN ('EXPIRED', 'CANCELLED')
    )
);
CREATE UNIQUE INDEX "change_requests_assignment_pending_unique" ON "change_requests"("assignment_id")
  WHERE "status" = 'PENDING' AND "deleted_at" IS NULL;
CREATE INDEX "change_requests_expires_idx" ON "change_requests"("expires_at") WHERE "status" = 'PENDING';
CREATE INDEX "change_requests_assignment_idx" ON "change_requests"("assignment_id", "created_at");
SELECT install_block_delete_trigger('change_requests');
