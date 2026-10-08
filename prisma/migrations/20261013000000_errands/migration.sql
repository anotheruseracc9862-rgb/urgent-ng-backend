-- P5-01 errands (Backend PRD 11, A.5). The database enforces the status-dependent rules.
CREATE TABLE "errands" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "requester_id" UUID NOT NULL,
    "category_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "instructions" TEXT,
    "status" "ErrandStatus" NOT NULL DEFAULT 'DRAFT',
    "status_before_dispute" "ErrandStatus",
    "priority" "ErrandPriority" NOT NULL DEFAULT 'STANDARD',
    "time_mode" "TimeMode",
    "scheduled_at" TIMESTAMPTZ(3),
    "suggested_budget_minor" BIGINT,
    "item_size" "ItemSize",
    "item_value_minor" BIGINT,
    "prohibited_items_confirmed_at" TIMESTAMPTZ(3),
    "prohibited_policy_version" TEXT,
    "published_at" TIMESTAMPTZ(3),
    "expires_at" TIMESTAMPTZ(3),
    "extended_at" TIMESTAMPTZ(3),
    "auto_complete_at" TIMESTAMPTZ(3),
    "delivered_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "cancellation_reason" "ErrandCancellationReason",
    "cancellation_note" TEXT,
    "cancelled_by" UUID,
    "cancelled_by_type" "AuditActorType",
    "feed_point" geography(Point,4326),
    "offer_count" INTEGER NOT NULL DEFAULT 0,
    "material_version" INTEGER NOT NULL DEFAULT 0,
    "search_vector" tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, "title" || ' ' || "description")) STORED,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "errands_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "errands_requester_id_fkey" FOREIGN KEY ("requester_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "errands_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "errands_budget_positive" CHECK ("suggested_budget_minor" IS NULL OR "suggested_budget_minor" > 0),
    CONSTRAINT "errands_item_value_positive" CHECK ("item_value_minor" IS NULL OR "item_value_minor" > 0),
    CONSTRAINT "errands_counters_non_negative" CHECK ("version" >= 0 AND "offer_count" >= 0 AND "material_version" >= 0),
    CONSTRAINT "errands_scheduled_needs_time" CHECK ("time_mode" IS DISTINCT FROM 'SCHEDULED' OR "scheduled_at" IS NOT NULL),
    -- ASAP errands are URGENT, every other errand is STANDARD (Backend PRD 11.1).
    CONSTRAINT "errands_priority_follows_time_mode" CHECK ("time_mode" IS NULL OR (("time_mode" = 'ASAP') = ("priority" = 'URGENT'))),
    -- Anything that was ever published carries its timing and the prohibited-items confirmation.
    CONSTRAINT "errands_published_fields" CHECK (
      "status" IN ('DRAFT', 'CANCELLED')
      OR ("published_at" IS NOT NULL AND "expires_at" IS NOT NULL AND "time_mode" IS NOT NULL AND "prohibited_items_confirmed_at" IS NOT NULL)
    ),
    CONSTRAINT "errands_open_has_feed_point" CHECK ("status" <> 'OPEN' OR "feed_point" IS NOT NULL),
    CONSTRAINT "errands_cancelled_fields" CHECK ("status" <> 'CANCELLED' OR ("cancelled_at" IS NOT NULL AND "cancellation_reason" IS NOT NULL)),
    CONSTRAINT "errands_completed_fields" CHECK ("status" <> 'COMPLETED' OR "completed_at" IS NOT NULL),
    CONSTRAINT "errands_delivered_fields" CHECK ("status" <> 'DELIVERED' OR "delivered_at" IS NOT NULL),
    CONSTRAINT "errands_disputed_fields" CHECK ("status" <> 'DISPUTED' OR "status_before_dispute" IS NOT NULL)
);
CREATE INDEX "errands_status_category_idx" ON "errands"("status", "category_id");
CREATE INDEX "errands_requester_status_idx" ON "errands"("requester_id", "status");
CREATE INDEX "errands_created_at_idx" ON "errands"("created_at");
CREATE INDEX "errands_feed_point_idx" ON "errands" USING GIST ("feed_point");
CREATE INDEX "errands_search_vector_idx" ON "errands" USING GIN ("search_vector");
-- The sweeper reads these two (Backend PRD 25.3): only the rows that can be due.
CREATE INDEX "errands_open_expires_idx" ON "errands"("expires_at") WHERE "status" = 'OPEN' AND "deleted_at" IS NULL;
CREATE INDEX "errands_delivered_auto_complete_idx" ON "errands"("auto_complete_at") WHERE "status" = 'DELIVERED' AND "deleted_at" IS NULL;
-- Feed: open errands, newest first.
CREATE INDEX "errands_open_feed_idx" ON "errands"("published_at" DESC, "id" DESC) WHERE "status" = 'OPEN' AND "deleted_at" IS NULL;
SELECT install_block_delete_trigger('errands');

CREATE TABLE "errand_locations" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "errand_id" UUID NOT NULL,
    "type" "LocationType" NOT NULL,
    "exact_point" geography(Point,4326) NOT NULL,
    "approx_point" geography(Point,4326) NOT NULL,
    "address_text" TEXT,
    "landmark" TEXT,
    "area" TEXT NOT NULL,
    "lga" TEXT,
    "state" TEXT,
    "source" "LocationSource" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "errand_locations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "errand_locations_errand_id_fkey" FOREIGN KEY ("errand_id") REFERENCES "errands"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "errand_locations_type_check" CHECK ("type" IN ('ERRAND_PICKUP', 'ERRAND_DESTINATION'))
);
CREATE UNIQUE INDEX "errand_locations_errand_type_unique" ON "errand_locations"("errand_id", "type") WHERE "deleted_at" IS NULL;
CREATE INDEX "errand_locations_approx_idx" ON "errand_locations" USING GIST ("approx_point");
CREATE INDEX "errand_locations_exact_idx" ON "errand_locations" USING GIST ("exact_point");
SELECT install_block_delete_trigger('errand_locations');

CREATE TABLE "errand_contacts" (
    "errand_id" UUID NOT NULL,
    "pickup_name" TEXT,
    "pickup_phone" TEXT,
    "dropoff_name" TEXT,
    "dropoff_phone" TEXT,
    "encryption_key_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "errand_contacts_pkey" PRIMARY KEY ("errand_id"),
    CONSTRAINT "errand_contacts_errand_id_fkey" FOREIGN KEY ("errand_id") REFERENCES "errands"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    -- Only ciphertext (`v1.<keyId>.<iv>.<tag>.<data>`) can be stored: a plain name or number is refused.
    CONSTRAINT "errand_contacts_encrypted_only" CHECK (
      ("pickup_name" IS NULL OR "pickup_name" ~ '^v1\.')
      AND ("pickup_phone" IS NULL OR "pickup_phone" ~ '^v1\.')
      AND ("dropoff_name" IS NULL OR "dropoff_name" ~ '^v1\.')
      AND ("dropoff_phone" IS NULL OR "dropoff_phone" ~ '^v1\.')
    )
);
SELECT install_block_delete_trigger('errand_contacts');

CREATE TABLE "errand_versions" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "errand_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "changed_fields" TEXT[],
    "changed_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "errand_versions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "errand_versions_errand_id_fkey" FOREIGN KEY ("errand_id") REFERENCES "errands"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "errand_versions_errand_version_unique" ON "errand_versions"("errand_id", "version");
SELECT install_block_delete_trigger('errand_versions');

CREATE TABLE "errand_media" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "errand_id" UUID NOT NULL,
    "media_id" UUID NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "errand_media_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "errand_media_errand_id_fkey" FOREIGN KEY ("errand_id") REFERENCES "errands"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "errand_media_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "media"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "errand_media_position_non_negative" CHECK ("position" >= 0)
);
CREATE INDEX "errand_media_errand_idx" ON "errand_media"("errand_id");
CREATE UNIQUE INDEX "errand_media_errand_media_unique" ON "errand_media"("errand_id", "media_id") WHERE "deleted_at" IS NULL;
SELECT install_block_delete_trigger('errand_media');

CREATE TABLE "saved_errands" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "user_id" UUID NOT NULL,
    "errand_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "saved_errands_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "saved_errands_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "saved_errands_errand_id_fkey" FOREIGN KEY ("errand_id") REFERENCES "errands"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "saved_errands_user_created_idx" ON "saved_errands"("user_id", "created_at");
CREATE UNIQUE INDEX "saved_errands_user_errand_unique" ON "saved_errands"("user_id", "errand_id") WHERE "deleted_at" IS NULL;
SELECT install_block_delete_trigger('saved_errands');

CREATE TABLE "errand_status_history" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "errand_id" UUID NOT NULL,
    "from_status" "ErrandStatus",
    "to_status" "ErrandStatus" NOT NULL,
    "actor_type" "AuditActorType" NOT NULL,
    "actor_id" UUID,
    "reason" TEXT,
    "version" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "errand_status_history_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "errand_status_history_errand_id_fkey" FOREIGN KEY ("errand_id") REFERENCES "errands"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "errand_status_history_errand_idx" ON "errand_status_history"("errand_id", "created_at");
SELECT install_block_delete_trigger('errand_status_history');
