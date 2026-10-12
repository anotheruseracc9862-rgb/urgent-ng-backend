-- Phase 11 (P11-07): operations. What each sweeper last did (the admin console shows it), and the
-- data-subject-request tracker. Classes (PRD 26.8): data_subject_requests is never deleted;
-- sweeper_runs is operational state, one row per sweeper.

CREATE TABLE "sweeper_runs" (
    "name" TEXT NOT NULL,
    "last_started_at" TIMESTAMPTZ(3),
    "last_finished_at" TIMESTAMPTZ(3),
    "last_duration_ms" INTEGER,
    "last_processed" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "last_error_at" TIMESTAMPTZ(3),
    "runs" BIGINT NOT NULL DEFAULT 0,
    "failures" BIGINT NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sweeper_runs_pkey" PRIMARY KEY ("name")
);

CREATE TABLE "data_subject_requests" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "user_id" UUID,
    "type" "DsrType" NOT NULL,
    "status" "DsrStatus" NOT NULL DEFAULT 'OPEN',
    "channel" TEXT NOT NULL DEFAULT 'SUPPORT',
    "summary" TEXT NOT NULL,
    "due_at" TIMESTAMPTZ(3) NOT NULL,
    "assigned_to" UUID,
    "resolution" TEXT,
    "resolved_by" UUID,
    "resolved_at" TIMESTAMPTZ(3),
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "data_subject_requests_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "data_subject_requests_user_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "data_subject_requests_assigned_fkey" FOREIGN KEY ("assigned_to") REFERENCES "admins"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "data_subject_requests_resolved_by_fkey" FOREIGN KEY ("resolved_by") REFERENCES "admins"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "data_subject_requests_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "admins"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "data_subject_requests_resolved_complete" CHECK (
      ("status" IN ('COMPLETED', 'REJECTED')) = ("resolved_at" IS NOT NULL AND "resolved_by" IS NOT NULL)
    )
);
CREATE INDEX "data_subject_requests_status_due_idx" ON "data_subject_requests"("status", "due_at");
CREATE INDEX "data_subject_requests_user_idx" ON "data_subject_requests"("user_id");
SELECT install_block_delete_trigger('data_subject_requests');
