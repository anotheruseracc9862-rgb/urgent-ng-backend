-- A service can take days, so the table no longer holds an offer to a day. The real limits (24 hours for a
-- delivery, 14 days for a service) are business configuration, checked by the application; this is only a
-- sanity bound that matches the request validation.
ALTER TABLE "offers" DROP CONSTRAINT "offers_duration_bounds";
ALTER TABLE "offers" ADD CONSTRAINT "offers_duration_bounds" CHECK ("duration_minutes" >= 1 AND "duration_minutes" <= 100000);
