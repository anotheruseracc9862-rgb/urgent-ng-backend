-- Demo-gap additions: the features the demo shows that the first API did not cover.
-- Classes (PRD 26.8): verification_submissions is soft-deletable personal data (redacted in place
-- on anonymisation, never removed).

-- Profile: a short bio, shown on the public profile.
ALTER TABLE "profiles" ADD COLUMN "bio" VARCHAR(300);

-- Google sign-in: the stable Google account id (`sub`). Unique among accounts that have one.
ALTER TABLE "users" ADD COLUMN "google_subject" TEXT;
CREATE UNIQUE INDEX "users_google_subject_unique" ON "users"("google_subject");

-- "I arrived at pickup": a checkpoint and an execution event. The errand status does not change.
ALTER TYPE "CheckpointType" ADD VALUE IF NOT EXISTS 'ARRIVED';
ALTER TYPE "ExecutionEventType" ADD VALUE IF NOT EXISTS 'ARRIVED';

-- Verification: identity details, the ID document and a guarantor, kept for manual review.
CREATE TYPE "IdDocumentType" AS ENUM ('NIN_SLIP', 'VOTERS_CARD', 'DRIVERS_LICENCE', 'INTERNATIONAL_PASSPORT');
CREATE TYPE "GuarantorRelationship" AS ENUM ('FAMILY', 'FRIEND', 'EMPLOYER', 'NEIGHBOUR');

CREATE TABLE "verification_submissions" (
    "attempt_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "first_name" TEXT,
    "last_name" TEXT,
    "date_of_birth" DATE,
    "address_line" TEXT,
    "lga" TEXT,
    "id_document_type" "IdDocumentType",
    "id_document_media_id" UUID,
    "guarantor_name" TEXT,
    "guarantor_relationship" "GuarantorRelationship",
    "guarantor_phone_e164" TEXT,
    "anonymised_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "verification_submissions_pkey" PRIMARY KEY ("attempt_id"),
    CONSTRAINT "verification_submissions_attempt_fkey" FOREIGN KEY ("attempt_id") REFERENCES "verification_attempts"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "verification_submissions_user_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "verification_submissions_media_fkey" FOREIGN KEY ("id_document_media_id") REFERENCES "media"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "verification_submissions_guarantor_complete" CHECK (
      ("guarantor_name" IS NULL) = ("guarantor_relationship" IS NULL)
      AND ("guarantor_name" IS NULL) = ("guarantor_phone_e164" IS NULL)
    )
);
CREATE INDEX "verification_submissions_user_idx" ON "verification_submissions"("user_id");
SELECT install_block_delete_trigger('verification_submissions');
