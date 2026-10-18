-- Verification by NIN or BVN. `id_type` says which one the attempt used (existing rows are NIN).
-- `person_ref_hmac` is a keyed hash of the registry date of birth and first/last name words: it
-- finds the same person verified under the other id type (a NIN on one account, a BVN on
-- another), which the id hash alone cannot. Not unique: two different people can share a name and
-- a birthday, so the service only compares across id types.
ALTER TABLE "verification_attempts" ADD COLUMN "id_type" TEXT NOT NULL DEFAULT 'NIN';
ALTER TABLE "verification_attempts" ADD COLUMN "person_ref_hmac" TEXT;
ALTER TABLE "verification_attempts" ADD CONSTRAINT "verification_attempts_id_type_check" CHECK ("id_type" IN ('NIN', 'BVN'));
CREATE INDEX "verification_attempts_person_verified_idx" ON "verification_attempts"("person_ref_hmac") WHERE "status" = 'VERIFIED' AND "deleted_at" IS NULL AND "person_ref_hmac" IS NOT NULL;
