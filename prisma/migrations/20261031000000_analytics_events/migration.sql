-- P12-03: analytics events (Backend PRD 28.2). Transient: a retention job removes rows after
-- ANALYTICS_RETENTION_MONTHS. source_event_id is the outbox event the row came from, so a retried
-- job never writes a second row.
CREATE TABLE "analytics_events" (
  "id"              UUID           NOT NULL DEFAULT uuid_generate_v7(),
  "name"            TEXT           NOT NULL,
  "user_id"         UUID,
  "properties"      JSONB          NOT NULL DEFAULT '{}',
  "source_event_id" UUID,
  "occurred_at"     TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "analytics_events_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "analytics_events_source_event_unique" ON "analytics_events" ("source_event_id");
CREATE INDEX "analytics_events_name_occurred_idx" ON "analytics_events" ("name", "occurred_at");
CREATE INDEX "analytics_events_occurred_idx" ON "analytics_events" ("occurred_at");

-- P12-02: a legal hold keeps an errand's chat out of retention until an admin lifts it.
ALTER TABLE "errands" ADD COLUMN "legal_hold" BOOLEAN NOT NULL DEFAULT FALSE;
