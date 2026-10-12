-- Phase 11 (P11-01): the four-eyes approval request (Backend PRD 24.5).
-- Class (PRD 26.8): never deleted. A request changes by status, not by removal.

CREATE TYPE "ApprovalKind" AS ENUM ('PERMANENT_SUSPENSION', 'ADMIN_ROLE_CHANGE', 'PRICE_CHANGE', 'KILL_SWITCH', 'CONFIG_CHANGE');
CREATE TYPE "ApprovalRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'EXECUTED', 'FAILED', 'REJECTED', 'CANCELLED', 'EXPIRED');

CREATE TABLE "approval_requests" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "kind" "ApprovalKind" NOT NULL,
    "status" "ApprovalRequestStatus" NOT NULL DEFAULT 'PENDING',
    "requested_by" UUID NOT NULL,
    "reason_code" TEXT NOT NULL,
    "reason_text" TEXT,
    "summary" TEXT NOT NULL,
    "target_type" TEXT,
    "target_id" TEXT,
    "payload" JSONB NOT NULL,
    "decided_by" UUID,
    "decision_note" TEXT,
    "decided_at" TIMESTAMPTZ(3),
    "executed_at" TIMESTAMPTZ(3),
    "result" JSONB,
    "failure_reason" TEXT,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approval_requests_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "approval_requests_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "admins"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "approval_requests_decided_by_fkey" FOREIGN KEY ("decided_by") REFERENCES "admins"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    -- Four eyes: the admin who decides is never the admin who asked.
    CONSTRAINT "approval_requests_two_admins" CHECK ("decided_by" IS NULL OR "decided_by" <> "requested_by"),
    CONSTRAINT "approval_requests_decision_complete" CHECK (
      ("status" IN ('PENDING', 'CANCELLED', 'EXPIRED')) OR ("decided_by" IS NOT NULL AND "decided_at" IS NOT NULL)
    ),
    CONSTRAINT "approval_requests_executed_has_time" CHECK (("status" = 'EXECUTED') = ("executed_at" IS NOT NULL))
);
CREATE INDEX "approval_requests_status_created_idx" ON "approval_requests"("status", "created_at");
CREATE INDEX "approval_requests_kind_status_idx" ON "approval_requests"("kind", "status");
SELECT install_block_delete_trigger('approval_requests');
