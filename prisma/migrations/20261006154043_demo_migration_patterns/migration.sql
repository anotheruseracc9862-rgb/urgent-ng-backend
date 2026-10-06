-- Demo migration patterns for P1-01
-- This migration demonstrates:
-- 1. Geography column with GiST spatial index
-- 2. Partial unique index for soft-deletable tables
-- 3. CHECK constraints
-- 4. Generated tsvector column with GIN full-text index

-- Demo table: locations with soft deletion
CREATE TABLE demo_locations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    description TEXT,
    -- Geography column (point in WGS84)
    location GEOGRAPHY(Point, 4326) NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'INACTIVE')),
    -- Soft deletion support
    deleted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Generated tsvector for full-text search
    search_vector TSVECTOR GENERATED ALWAYS AS (
        setweight(to_tsvector('english', coalesce(name, '')), 'A') ||
        setweight(to_tsvector('english', coalesce(description, '')), 'B')
    ) STORED
);

-- GiST index for spatial queries
CREATE INDEX demo_locations_location_gist_idx ON demo_locations USING GIST(location);

-- GIN index for full-text search
CREATE INDEX demo_locations_search_gin_idx ON demo_locations USING GIN(search_vector);

-- Partial unique index: name must be unique among non-deleted rows
CREATE UNIQUE INDEX demo_locations_name_unique_idx 
    ON demo_locations(name) 
    WHERE deleted_at IS NULL;

-- CHECK constraint: deleted_at cannot be in the future
ALTER TABLE demo_locations 
    ADD CONSTRAINT demo_locations_deleted_at_not_future_check 
    CHECK (deleted_at IS NULL OR deleted_at <= NOW());

-- Demo table with complex CHECK constraints
CREATE TABLE demo_constraints (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    status TEXT NOT NULL CHECK (status IN ('PENDING', 'ACTIVE', 'COMPLETED')),
    amount_kobo BIGINT NOT NULL CHECK (amount_kobo >= 0),
    percentage INTEGER CHECK (percentage >= 0 AND percentage <= 100),
    -- Status-dependent field constraints
    completed_at TIMESTAMPTZ,
    completion_reason TEXT,
    deleted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- CHECK: completed_at required when status is COMPLETED
    CONSTRAINT demo_constraints_completed_at_required_check 
        CHECK (
            (status = 'COMPLETED' AND completed_at IS NOT NULL) OR
            (status != 'COMPLETED' AND completed_at IS NULL)
        ),
    -- CHECK: completion_reason required when status is COMPLETED
    CONSTRAINT demo_constraints_completion_reason_required_check
        CHECK (
            (status = 'COMPLETED' AND completion_reason IS NOT NULL) OR
            (status != 'COMPLETED')
        )
);

-- Partial unique index for soft-deletable table
CREATE UNIQUE INDEX demo_constraints_unique_active_idx
    ON demo_constraints(status, amount_kobo)
    WHERE deleted_at IS NULL AND status = 'ACTIVE';

-- Comment documenting migration patterns
COMMENT ON TABLE demo_locations IS 'Demonstrates geography column with GiST index, partial unique for soft-deletion, generated tsvector with GIN index';
COMMENT ON TABLE demo_constraints IS 'Demonstrates status-dependent CHECK constraints and partial unique indexes';
