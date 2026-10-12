-- P12-02: offer_daily_counters is a transient table (Backend PRD 26.8): the retention job removes
-- rows older than OFFER_COUNTER_RETENTION_DAYS, so the hard-delete guard is lifted.
DROP TRIGGER IF EXISTS block_hard_delete ON offer_daily_counters;
