-- Enable PostGIS for geography columns, distance queries and spatial indexes.
-- Used by errand locations and runner operating areas (PRD 1 section 12, PRD 3 GR-34).
CREATE EXTENSION IF NOT EXISTS postgis;
