-- Install uuid_generate_v7() function if not already present
-- This generates time-ordered UUIDs (UUIDv7 draft spec)
CREATE OR REPLACE FUNCTION uuid_generate_v7()
RETURNS UUID
AS $$
DECLARE
    unix_ts_ms BIGINT;
    uuid_bytes BYTEA;
BEGIN
    unix_ts_ms := (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT;
    uuid_bytes := decode(
        lpad(to_hex((unix_ts_ms >> 16) & 4294967295), 8, '0') ||
        lpad(to_hex(unix_ts_ms & 65535), 4, '0') ||
        lpad(to_hex((random() * 65535)::INT | 28672), 4, '0') ||  -- version 7
        lpad(to_hex((random() * 16383)::INT | 32768), 4, '0') ||  -- variant 10
        lpad(to_hex((random() * 4294967295::BIGINT)::BIGINT), 8, '0') ||
        lpad(to_hex((random() * 4294967295::BIGINT)::BIGINT), 8, '0'),
        'hex'
    );
    RETURN CAST(uuid_bytes AS UUID);
END;
$$ LANGUAGE plpgsql VOLATILE;

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "actor_type" "AuditActorType" NOT NULL,
    "actor_id" UUID,
    "action" TEXT NOT NULL,
    "entity_type" TEXT,
    "entity_id" UUID,
    "request_id" TEXT,
    "before_hash" TEXT,
    "after_hash" TEXT,
    "reason_code" TEXT,
    "metadata" JSONB,
    "ip" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_logs_actor_type_actor_id_idx" ON "audit_logs"("actor_type", "actor_id");

-- CreateIndex
CREATE INDEX "audit_logs_entity_type_entity_id_idx" ON "audit_logs"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_logs_action_idx" ON "audit_logs"("action");

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at");

-- Create trigger function to block UPDATE and DELETE on audit_logs
CREATE OR REPLACE FUNCTION prevent_audit_log_modification()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'audit_logs table is append-only: UPDATE and DELETE are not allowed';
END;
$$ LANGUAGE plpgsql;

-- Attach trigger to block UPDATE
CREATE TRIGGER audit_log_prevent_update
    BEFORE UPDATE ON audit_logs
    FOR EACH ROW
    EXECUTE FUNCTION prevent_audit_log_modification();

-- Attach trigger to block DELETE
CREATE TRIGGER audit_log_prevent_delete
    BEFORE DELETE ON audit_logs
    FOR EACH ROW
    EXECUTE FUNCTION prevent_audit_log_modification();
