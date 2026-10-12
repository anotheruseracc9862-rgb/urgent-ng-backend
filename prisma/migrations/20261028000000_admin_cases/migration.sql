-- Phase 11 (P11-04): who owns a dispute or report, whether it was escalated, and the notes admins
-- leave on a case. Class (PRD 26.8): admin_case_notes is never deleted.

ALTER TABLE "disputes"
  ADD COLUMN "assigned_to" UUID,
  ADD COLUMN "assigned_at" TIMESTAMPTZ(3),
  ADD COLUMN "escalated_at" TIMESTAMPTZ(3),
  ADD COLUMN "escalated_by" UUID,
  ADD CONSTRAINT "disputes_assigned_to_fkey" FOREIGN KEY ("assigned_to") REFERENCES "admins"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "disputes_escalated_by_fkey" FOREIGN KEY ("escalated_by") REFERENCES "admins"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "disputes_assigned_idx" ON "disputes"("assigned_to") WHERE "assigned_to" IS NOT NULL;

ALTER TABLE "reports"
  ADD COLUMN "assigned_to" UUID,
  ADD COLUMN "assigned_at" TIMESTAMPTZ(3),
  ADD COLUMN "escalated_at" TIMESTAMPTZ(3),
  ADD COLUMN "escalated_by" UUID,
  ADD CONSTRAINT "reports_assigned_to_fkey" FOREIGN KEY ("assigned_to") REFERENCES "admins"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "reports_escalated_by_fkey" FOREIGN KEY ("escalated_by") REFERENCES "admins"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "reports_assigned_idx" ON "reports"("assigned_to") WHERE "assigned_to" IS NOT NULL;

CREATE TABLE "admin_case_notes" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "admin_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_case_notes_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "admin_case_notes_admin_fkey" FOREIGN KEY ("admin_id") REFERENCES "admins"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "admin_case_notes_entity_type_check" CHECK ("entity_type" IN ('dispute', 'report', 'user', 'errand')),
    CONSTRAINT "admin_case_notes_body_not_empty" CHECK (length(trim("body")) > 0)
);
CREATE INDEX "admin_case_notes_entity_idx" ON "admin_case_notes"("entity_type", "entity_id", "created_at");
SELECT install_block_delete_trigger('admin_case_notes');
