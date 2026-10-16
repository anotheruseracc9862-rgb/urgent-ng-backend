ALTER TABLE runner_profiles
  ADD COLUMN area_mode text NOT NULL DEFAULT 'RADIUS',
  ADD COLUMN area_state_ids text[] NOT NULL DEFAULT '{}',
  ADD COLUMN area_lga_ids text[] NOT NULL DEFAULT '{}',
  ALTER COLUMN area_center DROP NOT NULL,
  ADD CONSTRAINT runner_profiles_area_mode_check CHECK (
    (area_mode = 'RADIUS' AND area_center IS NOT NULL) OR
    (area_mode = 'STATE' AND cardinality(area_state_ids) > 0 AND area_center IS NULL) OR
    (area_mode = 'LGAS' AND cardinality(area_state_ids) > 0 AND cardinality(area_lga_ids) > 0 AND area_center IS NULL)
  );

-- No guessing/backfill: existing circles must be confirmed by saving their profile.
ALTER TABLE errand_locations ADD COLUMN state_id text, ADD COLUMN lga_id text;

-- Existing location labels were reverse-geocoded by the server, never supplied by callers.
-- Carry recognised states forward without inferring anything from private coordinates.
WITH candidates AS (
  SELECT id, CASE
    WHEN regexp_replace(lower(state), '[^a-z0-9]', '', 'g') IN ('fct', 'abuja', 'abujafct', 'federalcapitalterritory') THEN 'ng-fct'
    ELSE 'ng-' || trim(BOTH '-' FROM regexp_replace(lower(regexp_replace(trim(state), '\s+state$', '', 'i')), '[^a-z0-9]+', '-', 'g'))
  END AS state_id
  FROM errand_locations WHERE state IS NOT NULL
)
UPDATE errand_locations location SET state_id = candidates.state_id
FROM candidates WHERE location.id = candidates.id AND candidates.state_id = ANY(ARRAY[
  'ng-abia', 'ng-adamawa', 'ng-akwa-ibom', 'ng-anambra', 'ng-bauchi', 'ng-bayelsa',
  'ng-benue', 'ng-borno', 'ng-cross-river', 'ng-delta', 'ng-ebonyi', 'ng-edo',
  'ng-ekiti', 'ng-enugu', 'ng-fct', 'ng-gombe', 'ng-imo', 'ng-jigawa', 'ng-kaduna',
  'ng-kano', 'ng-katsina', 'ng-kebbi', 'ng-kogi', 'ng-kwara', 'ng-lagos', 'ng-nasarawa',
  'ng-niger', 'ng-ogun', 'ng-ondo', 'ng-osun', 'ng-oyo', 'ng-plateau', 'ng-rivers',
  'ng-sokoto', 'ng-taraba', 'ng-yobe', 'ng-zamfara'
]);

-- Match the pinned catalog's state-scoped slug format. Only catalog-validated runner
-- selections can match these IDs; unfamiliar LGA labels cannot broaden coverage.
UPDATE errand_locations SET lga_id = state_id || ':' ||
  trim(BOTH '-' FROM regexp_replace(lower(regexp_replace(trim(lga), '\s+(local government area|lga)$', '', 'i')), '[^a-z0-9]+', '-', 'g'))
WHERE state_id IS NOT NULL AND lga IS NOT NULL AND trim(lga) <> '';
