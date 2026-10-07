-- An anonymised account has no phone and no email any more (Backend PRD 9.5).
-- The original rule (a user needs a phone or an email) still holds for every live account.
ALTER TABLE "users" DROP CONSTRAINT "users_email_or_phone";
ALTER TABLE "users" ADD CONSTRAINT "users_email_or_phone"
  CHECK ("email" IS NOT NULL OR "phone_e164" IS NOT NULL OR "anonymised_at" IS NOT NULL);

-- Finds accounts whose grace period ended, and deleted accounts waiting for anonymisation.
CREATE INDEX "users_anonymisation_due_idx" ON "users"("deleted_at") WHERE "status" = 'DELETED'::"UserStatus" AND "anonymised_at" IS NULL;
