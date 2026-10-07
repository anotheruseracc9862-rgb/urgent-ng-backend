-- Match what Prisma expects for the media, runner and verification tables (no behaviour change):
-- foreign keys cascade on key update, and updated_at has no database default (Prisma sets it).
ALTER TABLE "media" DROP CONSTRAINT "media_owner_id_fkey";
ALTER TABLE "media" ADD CONSTRAINT "media_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "profiles" DROP CONSTRAINT "profiles_photo_media_id_fkey";
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_photo_media_id_fkey" FOREIGN KEY ("photo_media_id") REFERENCES "media"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "runner_profiles" DROP CONSTRAINT "runner_profiles_user_id_fkey";
ALTER TABLE "runner_profiles" ADD CONSTRAINT "runner_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "verification_attempts" DROP CONSTRAINT "verification_attempts_user_id_fkey";
ALTER TABLE "verification_attempts" ADD CONSTRAINT "verification_attempts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "verification_attempts" DROP CONSTRAINT "verification_attempts_selfie_media_id_fkey";
ALTER TABLE "verification_attempts" ADD CONSTRAINT "verification_attempts_selfie_media_id_fkey" FOREIGN KEY ("selfie_media_id") REFERENCES "media"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "media" ALTER COLUMN "updated_at" DROP DEFAULT;
ALTER TABLE "runner_profiles" ALTER COLUMN "updated_at" DROP DEFAULT;
ALTER TABLE "verification_attempts" ALTER COLUMN "updated_at" DROP DEFAULT;
