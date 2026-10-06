-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "event_type" TEXT NOT NULL,
    "aggregate_type" TEXT,
    "aggregate_id" UUID,
    "payload" JSONB NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "available_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(3),
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: Publisher query optimization
CREATE INDEX "outbox_events_poll_idx" ON "outbox_events"("status", "available_at", "occurred_at", "id")
    WHERE status IN ('PENDING', 'FAILED');

-- CreateIndex: Dead letter monitoring
CREATE INDEX "outbox_events_dead_letter_idx" ON "outbox_events"("status", "occurred_at")
    WHERE status = 'DEAD_LETTERED';

-- CreateIndex: Aggregate ordering
CREATE INDEX "outbox_events_aggregate_idx" ON "outbox_events"("aggregate_type", "aggregate_id", "occurred_at", "id");
