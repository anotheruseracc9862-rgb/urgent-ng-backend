-- P6-01/P6-05 durable offer state, counters and negotiation history.
CREATE TYPE "OfferAwaitingParty" AS ENUM ('NONE', 'RUNNER', 'REQUESTER');

CREATE TABLE "offer_daily_counters" (
    "user_id" UUID NOT NULL,
    "day_lagos" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "offer_daily_counters_pkey" PRIMARY KEY ("user_id", "day_lagos"),
    CONSTRAINT "offer_daily_counters_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "offer_daily_counters_count_non_negative" CHECK ("count" >= 0)
);
CREATE INDEX "offer_daily_counters_day_idx" ON "offer_daily_counters"("day_lagos", "count");
SELECT install_block_delete_trigger('offer_daily_counters');

CREATE TABLE "offers" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "errand_id" UUID NOT NULL,
    "runner_id" UUID NOT NULL,
    "requester_id" UUID NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "duration_minutes" INTEGER NOT NULL,
    "availability_confirmed_at" TIMESTAMPTZ(3),
    "message" TEXT,
    "status" "OfferStatus" NOT NULL DEFAULT 'ACTIVE',
    "close_reason" "OfferCloseReason",
    "awaiting_party" "OfferAwaitingParty" NOT NULL DEFAULT 'REQUESTER',
    "needs_reconfirmation" BOOLEAN NOT NULL DEFAULT FALSE,
    "conversation_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 0,
    "selected_at" TIMESTAMPTZ(3),
    "withdrawn_at" TIMESTAMPTZ(3),
    "closed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "offers_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "offers_errand_id_fkey" FOREIGN KEY ("errand_id") REFERENCES "errands"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "offers_runner_id_fkey" FOREIGN KEY ("runner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "offers_requester_id_fkey" FOREIGN KEY ("requester_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "offers_amount_positive" CHECK ("amount_minor" > 0),
    CONSTRAINT "offers_duration_bounds" CHECK ("duration_minutes" >= 5 AND "duration_minutes" <= 1440),
    CONSTRAINT "offers_version_non_negative" CHECK ("version" >= 0)
);
CREATE INDEX "offers_errand_status_created_idx" ON "offers"("errand_id", "status", "created_at");
CREATE INDEX "offers_runner_status_created_idx" ON "offers"("runner_id", "status", "created_at");
CREATE INDEX "offers_requester_status_created_idx" ON "offers"("requester_id", "status", "created_at");
CREATE INDEX "offers_errand_runner_idx" ON "offers"("errand_id", "runner_id");
CREATE UNIQUE INDEX "offers_errand_runner_active_unique" ON "offers"("errand_id", "runner_id") WHERE "status" = 'ACTIVE' AND "deleted_at" IS NULL;
SELECT install_block_delete_trigger('offers');

CREATE TABLE "negotiation_events" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "errand_id" UUID NOT NULL,
    "offer_id" UUID NOT NULL,
    "actor_user_id" UUID NOT NULL,
    "message_type" "NegotiationMessageType" NOT NULL,
    "proposed_amount_minor" BIGINT,
    "proposed_duration_minutes" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "message" TEXT,
    "resulting_offer_version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "negotiation_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "negotiation_events_errand_id_fkey" FOREIGN KEY ("errand_id") REFERENCES "errands"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "negotiation_events_offer_id_fkey" FOREIGN KEY ("offer_id") REFERENCES "offers"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "negotiation_events_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "negotiation_events_proposed_amount_positive" CHECK ("proposed_amount_minor" IS NULL OR "proposed_amount_minor" > 0),
    CONSTRAINT "negotiation_events_proposed_duration_positive" CHECK ("proposed_duration_minutes" IS NULL OR "proposed_duration_minutes" > 0),
    CONSTRAINT "negotiation_events_resulting_version_non_negative" CHECK ("resulting_offer_version" >= 0)
);
CREATE INDEX "negotiation_events_offer_created_idx" ON "negotiation_events"("offer_id", "created_at");
CREATE INDEX "negotiation_events_errand_created_idx" ON "negotiation_events"("errand_id", "created_at");
SELECT install_block_delete_trigger('negotiation_events');
