-- Phase 11 (P11-09): admin invitations. Only a keyed hash of the invite token is kept, and it is
-- cleared when the invitation is accepted.
ALTER TABLE "admins"
  ADD COLUMN "invite_token_hash" TEXT,
  ADD COLUMN "invite_expires_at" TIMESTAMPTZ(3),
  ADD COLUMN "invited_by" UUID,
  ADD CONSTRAINT "admins_invited_by_fkey" FOREIGN KEY ("invited_by") REFERENCES "admins"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE UNIQUE INDEX "admins_invite_token_hash_key" ON "admins"("invite_token_hash") WHERE "invite_token_hash" IS NOT NULL;
