-- Phase 6 hardening (Backend PRD 13.1, 13.3, 26.2, A.6).
-- 1. An offer's parties must match the errand: the requester is the errand's requester and the
--    runner is somebody else. The service checks this too; the database is the last line.
CREATE OR REPLACE FUNCTION offers_enforce_parties()
RETURNS TRIGGER AS $$
DECLARE
  errand_requester UUID;
BEGIN
  IF NEW.runner_id = NEW.requester_id THEN
    RAISE EXCEPTION 'an offer cannot be made by the errand requester' USING ERRCODE = '23514';
  END IF;
  SELECT requester_id INTO errand_requester FROM errands WHERE id = NEW.errand_id;
  IF errand_requester IS DISTINCT FROM NEW.requester_id THEN
    RAISE EXCEPTION 'offer requester does not match the errand requester' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER offers_enforce_parties_trg
  BEFORE INSERT OR UPDATE OF errand_id, runner_id, requester_id ON offers
  FOR EACH ROW EXECUTE FUNCTION offers_enforce_parties();

-- 2. Negotiation events are immutable: UPDATE is rejected as well as DELETE (delete is already blocked).
CREATE OR REPLACE FUNCTION negotiation_events_reject_update()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'negotiation_events rows are immutable' USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER negotiation_events_no_update
  BEFORE UPDATE ON negotiation_events
  FOR EACH ROW EXECUTE FUNCTION negotiation_events_reject_update();

-- 3. A closed offer carries a reason and a closing time; a live one carries neither.
ALTER TABLE offers ADD CONSTRAINT offers_closed_fields CHECK (
  (status = 'ACTIVE' AND close_reason IS NULL AND closed_at IS NULL)
  OR (status = 'SELECTED' AND selected_at IS NOT NULL)
  OR (status NOT IN ('ACTIVE', 'SELECTED') AND close_reason IS NOT NULL AND closed_at IS NOT NULL)
) NOT VALID;
