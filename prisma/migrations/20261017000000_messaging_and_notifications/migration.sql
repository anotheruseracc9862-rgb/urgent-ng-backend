-- Phase 8: messaging and notifications (Backend PRD 18, 19, A.8).
-- Classes (PRD 26.8): conversations, conversation_participants, messages and notification_templates
-- are soft-deletable. notifications and notification_deliveries are transient: a retention job
-- removes them after 90 days, so they have no deleted_at and no delete trigger.

-- ---------------------------------------------------------------------------------------------
-- conversations: one per (errand, runner), created at the runner's first offer (PRD 18.1)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "conversations" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "errand_id" UUID NOT NULL,
    "requester_id" UUID NOT NULL,
    "runner_id" UUID NOT NULL,
    "offer_id" UUID NOT NULL,
    "status" "ConversationStatus" NOT NULL DEFAULT 'ACTIVE',
    "send_disabled_at" TIMESTAMPTZ(3),
    "last_message_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "conversations_errand_id_fkey" FOREIGN KEY ("errand_id") REFERENCES "errands"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "conversations_requester_id_fkey" FOREIGN KEY ("requester_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "conversations_runner_id_fkey" FOREIGN KEY ("runner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "conversations_offer_id_fkey" FOREIGN KEY ("offer_id") REFERENCES "offers"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "conversations_parties_differ" CHECK ("requester_id" <> "runner_id")
);
CREATE UNIQUE INDEX "conversations_errand_runner_unique" ON "conversations"("errand_id", "runner_id") WHERE "deleted_at" IS NULL;
CREATE INDEX "conversations_requester_last_idx" ON "conversations"("requester_id", "last_message_at" DESC);
CREATE INDEX "conversations_runner_last_idx" ON "conversations"("runner_id", "last_message_at" DESC);
SELECT install_block_delete_trigger('conversations');

-- The two parties are the errand's requester and the offer's runner.
CREATE OR REPLACE FUNCTION conversations_enforce_parties()
RETURNS TRIGGER AS $$
DECLARE
  errand_requester UUID;
  offer_errand UUID;
  offer_runner UUID;
BEGIN
  SELECT requester_id INTO errand_requester FROM errands WHERE id = NEW.errand_id;
  IF errand_requester IS DISTINCT FROM NEW.requester_id THEN
    RAISE EXCEPTION 'conversation requester does not match the errand requester' USING ERRCODE = '23514';
  END IF;
  SELECT errand_id, runner_id INTO offer_errand, offer_runner FROM offers WHERE id = NEW.offer_id;
  IF offer_errand IS DISTINCT FROM NEW.errand_id OR offer_runner IS DISTINCT FROM NEW.runner_id THEN
    RAISE EXCEPTION 'conversation does not match its offer' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER conversations_enforce_parties_trg
  BEFORE INSERT OR UPDATE OF errand_id, requester_id, runner_id, offer_id ON conversations
  FOR EACH ROW EXECUTE FUNCTION conversations_enforce_parties();

-- ---------------------------------------------------------------------------------------------
-- conversation_participants: per-user state
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "conversation_participants" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "conversation_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "muted" BOOLEAN NOT NULL DEFAULT FALSE,
    "last_read_message_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "conversation_participants_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "conversation_participants_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "conversation_participants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "conversation_participants_unique" ON "conversation_participants"("conversation_id", "user_id") WHERE "deleted_at" IS NULL;
CREATE INDEX "conversation_participants_user_idx" ON "conversation_participants"("user_id");
SELECT install_block_delete_trigger('conversation_participants');

-- ---------------------------------------------------------------------------------------------
-- messages: a removed message is a tombstone, never a deleted row
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "messages" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "conversation_id" UUID NOT NULL,
    "sender_id" UUID NOT NULL,
    "type" "MessageType" NOT NULL,
    "body" TEXT,
    "media_id" UUID,
    "status" "MessageStatus" NOT NULL DEFAULT 'SENT',
    "client_message_id" TEXT,
    "delivered_at" TIMESTAMPTZ(3),
    "read_at" TIMESTAMPTZ(3),
    "removed_at" TIMESTAMPTZ(3),
    "removal_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "messages_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "messages_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "media"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "messages_content_by_type" CHECK (
      ("type" = 'TEXT' AND ("status" = 'REMOVED' OR ("body" IS NOT NULL AND length(btrim("body")) > 0)))
      OR ("type" = 'IMAGE' AND "media_id" IS NOT NULL)
      OR ("type" = 'SYSTEM' AND "body" IS NOT NULL)
    ),
    CONSTRAINT "messages_removed_fields" CHECK (("status" = 'REMOVED') = ("removed_at" IS NOT NULL))
);
CREATE UNIQUE INDEX "messages_sender_client_unique" ON "messages"("sender_id", "client_message_id")
  WHERE "client_message_id" IS NOT NULL AND "deleted_at" IS NULL;
CREATE INDEX "messages_conversation_created_idx" ON "messages"("conversation_id", "created_at", "id");
CREATE INDEX "messages_sender_idx" ON "messages"("sender_id");
SELECT install_block_delete_trigger('messages');

-- ---------------------------------------------------------------------------------------------
-- notifications (transient, 90 days) and their per-channel deliveries
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "notifications" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "user_id" UUID NOT NULL,
    "category" "NotificationCategory" NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "dedupe_key" TEXT,
    "read_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "notifications_dedupe_unique" ON "notifications"("dedupe_key") WHERE "dedupe_key" IS NOT NULL;
CREATE INDEX "notifications_user_read_created_idx" ON "notifications"("user_id", "read_at", "created_at" DESC);
CREATE INDEX "notifications_created_idx" ON "notifications"("created_at");

CREATE TABLE "notification_deliveries" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "notification_id" UUID NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "status" TEXT NOT NULL,
    "suppressed_reason" TEXT,
    "provider_ref" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "notification_deliveries_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "notification_deliveries_notification_id_fkey" FOREIGN KEY ("notification_id") REFERENCES "notifications"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "notification_deliveries_status_values" CHECK ("status" IN ('QUEUED', 'SENT', 'FAILED', 'SUPPRESSED'))
);
CREATE UNIQUE INDEX "notification_deliveries_notification_channel_unique" ON "notification_deliveries"("notification_id", "channel");

-- ---------------------------------------------------------------------------------------------
-- notification_templates: admin-editable overrides of the code defaults
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "notification_templates" (
    "key" TEXT NOT NULL,
    "category" "NotificationCategory" NOT NULL,
    "title_template" TEXT NOT NULL,
    "body_template" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT TRUE,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "notification_templates_pkey" PRIMARY KEY ("key")
);
SELECT install_block_delete_trigger('notification_templates');
