-- Phase 10 (P10-01): platform billing (Backend PRD 22, A.10). Urgent.ng's own products only: never
-- the errand payment between requester and runner (INV-008, INV-009).
-- Classes (PRD 26.8): every table here is never deleted. Money rows change by status, not by removal.

-- ---------------------------------------------------------------------------------------------
-- orders: what a user bought, at which price version
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "orders" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "user_id" UUID NOT NULL,
    "type" "OrderType" NOT NULL,
    "product_id" UUID NOT NULL,
    "price_version_id" UUID NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'NGN',
    "status" "OrderStatus" NOT NULL DEFAULT 'PENDING',
    "target_errand_id" UUID,
    "idempotency_key" TEXT NOT NULL,
    -- Order options that are not part of the price, such as { autoRenew: true } for Runner Pro.
    "metadata" JSONB,
    "paid_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "orders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "orders_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "commercial_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "orders_price_version_id_fkey" FOREIGN KEY ("price_version_id") REFERENCES "price_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "orders_target_errand_id_fkey" FOREIGN KEY ("target_errand_id") REFERENCES "errands"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "orders_amount_non_negative" CHECK ("amount_minor" >= 0),
    CONSTRAINT "orders_boost_has_errand" CHECK (("type" = 'BOOST') = ("target_errand_id" IS NOT NULL)),
    CONSTRAINT "orders_paid_has_time" CHECK (("status" IN ('PAID', 'REFUNDED')) = ("paid_at" IS NOT NULL))
);
CREATE UNIQUE INDEX "orders_user_idempotency_unique" ON "orders"("user_id", "idempotency_key");
CREATE INDEX "orders_user_status_idx" ON "orders"("user_id", "status");
CREATE INDEX "orders_created_idx" ON "orders"("created_at");
SELECT install_block_delete_trigger('orders');

-- ---------------------------------------------------------------------------------------------
-- payments: one gateway transaction for an order
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "payments" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "order_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_reference" TEXT NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'INITIATED',
    "amount_minor" BIGINT NOT NULL,
    -- Where the customer pays. Not secret, kept so a retried create returns the same checkout.
    "authorization_url" TEXT,
    -- A saved card authorisation for Runner Pro renewals: encrypted (AES-GCM envelope), never plain.
    "authorization_code" TEXT,
    "paid_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "payments_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "payments_amount_non_negative" CHECK ("amount_minor" >= 0)
);
CREATE UNIQUE INDEX "payments_provider_reference_unique" ON "payments"("provider", "provider_reference");
CREATE INDEX "payments_order_idx" ON "payments"("order_id");
CREATE INDEX "payments_status_idx" ON "payments"("status");
SELECT install_block_delete_trigger('payments');

-- ---------------------------------------------------------------------------------------------
-- payment_attempts: what the gateway said each time we asked (no card data)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "payment_attempts" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "payment_id" UUID NOT NULL,
    -- INITIALIZE, VERIFY, CHARGE_AUTHORIZATION, REFUND
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "provider_response" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_attempts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "payment_attempts_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "payment_attempts_payment_idx" ON "payment_attempts"("payment_id", "created_at");
SELECT install_block_delete_trigger('payment_attempts');

-- ---------------------------------------------------------------------------------------------
-- refunds: immutable once completed
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "refunds" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "payment_id" UUID NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "RefundStatus" NOT NULL DEFAULT 'REQUESTED',
    "requested_by_type" "AuditActorType" NOT NULL,
    "requested_by_id" UUID,
    -- Set by the four-eyes workflow (P11-01); the table it points at arrives with it.
    "approval_request_id" UUID,
    "approved_by" UUID,
    "provider_refund_ref" TEXT,
    "failure_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "refunds_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "refunds_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "refunds_amount_positive" CHECK ("amount_minor" > 0)
);
CREATE UNIQUE INDEX "refunds_provider_ref_unique" ON "refunds"("provider_refund_ref") WHERE "provider_refund_ref" IS NOT NULL;
CREATE INDEX "refunds_payment_idx" ON "refunds"("payment_id");
CREATE INDEX "refunds_status_idx" ON "refunds"("status", "created_at");
SELECT install_block_delete_trigger('refunds');

-- A completed refund is a financial record: nothing about it changes afterwards.
CREATE OR REPLACE FUNCTION refunds_immutable_when_completed()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status = 'COMPLETED' THEN
    RAISE EXCEPTION 'a completed refund cannot be changed' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER refunds_immutable_when_completed_trg
  BEFORE UPDATE ON refunds
  FOR EACH ROW EXECUTE FUNCTION refunds_immutable_when_completed();

-- ---------------------------------------------------------------------------------------------
-- entitlements: what a user may do because of something they bought or were granted
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "entitlements" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "user_id" UUID NOT NULL,
    "type" "EntitlementType" NOT NULL,
    -- ORDER, SUBSCRIPTION or ADMIN
    "source" TEXT NOT NULL,
    "source_id" UUID,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "valid_from" TIMESTAMPTZ(3) NOT NULL,
    "valid_until" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "entitlements_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "entitlements_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "entitlements_source_valid" CHECK ("source" IN ('ORDER', 'SUBSCRIPTION', 'ADMIN')),
    CONSTRAINT "entitlements_quantity_positive" CHECK ("quantity" >= 1),
    CONSTRAINT "entitlements_window_valid" CHECK ("valid_until" IS NULL OR "valid_until" > "valid_from")
);
CREATE INDEX "entitlements_user_type_until_idx" ON "entitlements"("user_id", "type", "valid_until");
-- A purchase grants its entitlement once, however many times its webhook arrives.
CREATE UNIQUE INDEX "entitlements_source_unique" ON "entitlements"("source", "source_id", "type", "valid_from")
  WHERE "source_id" IS NOT NULL;
SELECT install_block_delete_trigger('entitlements');

-- ---------------------------------------------------------------------------------------------
-- subscriptions: Runner Pro. The period end is the authoritative timer.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "subscriptions" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "user_id" UUID NOT NULL,
    "status" "SubscriptionStatus" NOT NULL,
    "current_period_start" TIMESTAMPTZ(3) NOT NULL,
    "current_period_end" TIMESTAMPTZ(3) NOT NULL,
    "grace_ends_at" TIMESTAMPTZ(3),
    "auto_renew" BOOLEAN NOT NULL DEFAULT FALSE,
    "cancelled_at" TIMESTAMPTZ(3),
    "latest_order_id" UUID,
    "renewal_attempted_at" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "subscriptions_latest_order_id_fkey" FOREIGN KEY ("latest_order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "subscriptions_period_valid" CHECK ("current_period_end" > "current_period_start")
);
-- One live subscription per user.
CREATE UNIQUE INDEX "subscriptions_live_user_unique" ON "subscriptions"("user_id")
  WHERE "status" IN ('TRIAL', 'ACTIVE', 'PENDING_RENEWAL', 'PAYMENT_FAILED', 'GRACE_PERIOD', 'CANCELLED');
CREATE INDEX "subscriptions_period_end_idx" ON "subscriptions"("current_period_end");
SELECT install_block_delete_trigger('subscriptions');

-- ---------------------------------------------------------------------------------------------
-- boosts: a paid, time-limited lift for one open errand
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "boosts" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "errand_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "status" "BoostStatus" NOT NULL DEFAULT 'PURCHASED',
    "activates_at" TIMESTAMPTZ(3),
    "expires_at" TIMESTAMPTZ(3),
    "ended_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "boosts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "boosts_errand_id_fkey" FOREIGN KEY ("errand_id") REFERENCES "errands"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "boosts_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "boosts_active_has_window" CHECK ("status" <> 'ACTIVE' OR ("activates_at" IS NOT NULL AND "expires_at" IS NOT NULL))
);
-- One live boost per errand.
CREATE UNIQUE INDEX "boosts_live_errand_unique" ON "boosts"("errand_id") WHERE "status" IN ('PURCHASED', 'SCHEDULED', 'ACTIVE');
CREATE UNIQUE INDEX "boosts_order_unique" ON "boosts"("order_id");
CREATE INDEX "boosts_active_expires_idx" ON "boosts"("expires_at") WHERE "status" = 'ACTIVE';
SELECT install_block_delete_trigger('boosts');

-- ---------------------------------------------------------------------------------------------
-- webhook_events: every notification from the gateway, once
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "webhook_events" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "provider" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "signature_valid" BOOLEAN NOT NULL,
    "processing_status" "WebhookProcessingStatus" NOT NULL DEFAULT 'RECEIVED',
    "payload_hash" TEXT NOT NULL,
    "payload_ref" TEXT,
    "failure_reason" TEXT,
    "duplicate_count" INTEGER NOT NULL DEFAULT 0,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(3),

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "webhook_events_provider_event_unique" ON "webhook_events"("provider", "event_id");
CREATE INDEX "webhook_events_status_received_idx" ON "webhook_events"("processing_status", "received_at");
SELECT install_block_delete_trigger('webhook_events');
