-- CreateTable
CREATE TABLE "idempotency_keys" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "user_id" UUID NOT NULL,
    "operation" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "response_status" INTEGER,
    "response_body" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: Enforce idempotency per user-operation-key
CREATE UNIQUE INDEX "idempotency_keys_user_operation_key_unique" 
    ON "idempotency_keys"("user_id", "operation", "key");

-- CreateIndex: Cleanup job (remove entries older than 24h)
CREATE INDEX "idempotency_keys_created_at_idx" 
    ON "idempotency_keys"("created_at");
