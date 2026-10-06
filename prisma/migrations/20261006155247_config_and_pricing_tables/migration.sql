-- P1-02: Config store and pricing tables
-- ConfigValue: dynamic business configuration with versioning and caching
-- CommercialProduct: product catalog (Runner Pro, boosts, verification fee)
-- PriceVersion: immutable price history with effectiveFrom dates

-- ConfigValue: versioned configuration store
CREATE TABLE config_values (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    key TEXT NOT NULL,
    value_json JSONB NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    effective_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by_admin_id UUID,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    -- Only one active version per key at any time
    CONSTRAINT config_values_key_effective_unique UNIQUE (key, effective_from)
);

-- Index for fast config lookups (get current effective value)
CREATE INDEX config_values_key_effective_idx ON config_values(key, effective_from DESC);

-- CommercialProduct: product catalog
CREATE TABLE commercial_products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT,
    type TEXT NOT NULL CHECK (type IN ('VERIFICATION_FEE', 'RUNNER_PRO', 'PRIORITY_BOOST')),
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- PriceVersion: immutable price history
CREATE TABLE price_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id UUID NOT NULL REFERENCES commercial_products(id) ON DELETE RESTRICT,
    amount_kobo BIGINT NOT NULL CHECK (amount_kobo >= 0),
    currency CHAR(3) NOT NULL DEFAULT 'NGN',
    effective_from TIMESTAMPTZ NOT NULL,
    notes TEXT,
    created_by_admin_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    -- Cannot have multiple prices effective at the same time for a product
    CONSTRAINT price_versions_product_effective_unique UNIQUE (product_id, effective_from)
);

-- Index for price resolution (get current/future prices)
CREATE INDEX price_versions_product_effective_idx ON price_versions(product_id, effective_from DESC);

-- Comments
COMMENT ON TABLE config_values IS 'Dynamic business configuration with versioning, future-dating, and 60s Redis cache';
COMMENT ON TABLE commercial_products IS 'Product catalog for platform billing (Runner Pro, boosts, verification)';
COMMENT ON TABLE price_versions IS 'Immutable price history with effectiveFrom dates; orders reference price_versions';

COMMENT ON COLUMN config_values.value_json IS 'JSON value: numbers, strings, booleans, objects';
COMMENT ON COLUMN config_values.effective_from IS 'When this config version becomes active; future-dated changes supported';
COMMENT ON COLUMN price_versions.effective_from IS 'When this price becomes active; future pricing supported';
COMMENT ON COLUMN price_versions.amount_kobo IS 'Price in kobo (₦1 = 100 kobo); always stored as kobo, never as float';
