-- P3-01: media table. Soft delete only (block_hard_delete trigger).
CREATE TABLE "media" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "owner_id" UUID NOT NULL,
    "purpose" "MediaPurpose" NOT NULL,
    "storage_key" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "checksum" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "status" "MediaStatus" NOT NULL DEFAULT 'PENDING',
    "moderation_status" "ModerationStatus" NOT NULL DEFAULT 'NONE',
    "thumbnail_key" TEXT,
    "rejection_reason" TEXT,
    "confirmed_at" TIMESTAMPTZ(3),
    "processed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "media_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "media_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT,
    CONSTRAINT "media_size_positive" CHECK ("size_bytes" > 0)
);

CREATE UNIQUE INDEX "media_storage_key_unique" ON "media"("storage_key");
CREATE INDEX "media_owner_purpose_idx" ON "media"("owner_id", "purpose");
CREATE INDEX "media_status_idx" ON "media"("status");
CREATE INDEX "media_deleted_at_idx" ON "media"("deleted_at");

SELECT install_block_delete_trigger('media');

-- profiles.photo_media_id existed without a foreign key until the media table did.
ALTER TABLE "profiles"
  ADD CONSTRAINT "profiles_photo_media_id_fkey" FOREIGN KEY ("photo_media_id") REFERENCES "media"("id") ON DELETE SET NULL;
