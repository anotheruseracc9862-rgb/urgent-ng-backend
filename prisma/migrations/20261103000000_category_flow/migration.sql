-- Category flow: TRANSIT (move something between places) or SERVICE (work done at one address).
CREATE TYPE "CategoryFlow" AS ENUM ('TRANSIT', 'SERVICE');

ALTER TABLE "categories" ADD COLUMN "flow" "CategoryFlow" NOT NULL DEFAULT 'TRANSIT';

-- A service happens at one address, stored as the destination: no pickup, one destination.
ALTER TABLE "categories" ADD CONSTRAINT "categories_service_shape_check"
  CHECK ("flow" <> 'SERVICE' OR (NOT "requires_pickup" AND "requires_destination"));

ALTER TYPE "DisputeType" ADD VALUE 'SERVICE_NOT_DONE';
ALTER TYPE "DisputeType" ADD VALUE 'POOR_QUALITY';
ALTER TYPE "DisputeType" ADD VALUE 'PROPERTY_DAMAGE';
