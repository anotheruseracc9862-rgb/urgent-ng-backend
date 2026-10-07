-- P4-01 runner_profiles
CREATE TABLE "runner_profiles" (
    "user_id" UUID NOT NULL,
    "transport" "TransportMethod" NOT NULL,
    "area_center" geography(Point,4326) NOT NULL,
    "area_radius_km" DECIMAL(4,1) NOT NULL DEFAULT 5,
    "availability" "RunnerAvailability" NOT NULL DEFAULT 'UNAVAILABLE',
    "excluded_category_ids" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "runner_profiles_pkey" PRIMARY KEY ("user_id"),
    CONSTRAINT "runner_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT,
    CONSTRAINT "runner_profiles_radius_range" CHECK ("area_radius_km" BETWEEN 1 AND 20)
);
CREATE INDEX "runner_profiles_area_center_idx" ON "runner_profiles" USING GIST ("area_center");
CREATE INDEX "runner_profiles_availability_idx" ON "runner_profiles"("availability");
SELECT install_block_delete_trigger('runner_profiles');

-- P4-02 verification_attempts
CREATE TABLE "verification_attempts" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "user_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_request_id" TEXT,
    "status" "VerificationStatus" NOT NULL,
    "failure_reason" "VerificationFailureReason",
    "provider_status" TEXT,
    "attempt_number" INTEGER NOT NULL,
    "identity_ref_hmac" TEXT,
    "masked_attributes" JSONB,
    "confidence" DECIMAL(5,2),
    "selfie_media_id" UUID,
    "counts_against_allowance" BOOLEAN NOT NULL DEFAULT true,
    "started_at" TIMESTAMPTZ(3) NOT NULL,
    "completed_at" TIMESTAMPTZ(3),
    "expires_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "verification_attempts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "verification_attempts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT,
    CONSTRAINT "verification_attempts_selfie_media_id_fkey" FOREIGN KEY ("selfie_media_id") REFERENCES "media"("id") ON DELETE SET NULL,
    -- A full NIN (11 digits in a row) can never be stored in the masked attributes.
    CONSTRAINT "verification_attempts_no_full_nin" CHECK ("masked_attributes" IS NULL OR "masked_attributes"::text !~ '[0-9]{11}')
);
CREATE INDEX "verification_attempts_user_created_idx" ON "verification_attempts"("user_id", "created_at");
CREATE UNIQUE INDEX "verification_attempts_provider_request_unique" ON "verification_attempts"("provider_request_id") WHERE "provider_request_id" IS NOT NULL;
-- One verified account per identity (DUPLICATE_IDENTITY), enforced by the database.
CREATE UNIQUE INDEX "verification_attempts_identity_verified_unique" ON "verification_attempts"("identity_ref_hmac") WHERE "status" = 'VERIFIED' AND "deleted_at" IS NULL AND "identity_ref_hmac" IS NOT NULL;
-- At most one attempt in flight per user.
CREATE UNIQUE INDEX "verification_attempts_one_pending_unique" ON "verification_attempts"("user_id") WHERE "status" = 'PENDING' AND "deleted_at" IS NULL;
SELECT install_block_delete_trigger('verification_attempts');
