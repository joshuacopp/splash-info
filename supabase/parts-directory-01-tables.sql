-- Parts Directory — frequently-ordered parts lookup for the Mechanical group.
--
-- Backs /admin/parts/directory in apps/web. Rows are written and read only by
-- the service-role client on splash-workorders (/workorders/api/parts/*), which
-- is why RLS is ON with no policies: service-role bypasses RLS, and the anon /
-- authenticated roles get nothing. Same posture as the other internal-tooling
-- tables on this project.
--
-- Part photos are NOT stored here. The image lives in the existing
-- `splash-parts-manuals` R2 bucket (bound to apps/web as PARTS_FILES) under the
-- key convention:   parts-directory/{part_id}/{nanoid}.{ext}
-- and only that key is persisted, in `photo_r2_key`.
--
-- Operator: run this in the Supabase SQL editor before the feature ships.

CREATE TABLE IF NOT EXISTS parts_directory (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The five core fields.
  parent_equipment  text NOT NULL,          -- e.g. "Top Brush", "Conveyor", "Wrap"
  part_name         text NOT NULL,          -- e.g. "Idler bearing, 1-1/4 flange"
  part_number       text,                   -- manufacturer / vendor part number
  vendor            text,                   -- e.g. "MacNeil", "NCS", "Grainger"
  photo_r2_key      text,                   -- R2 key in splash-parts-manuals; NULL = no photo yet

  -- Extras captured at build time (Josh, 2026-09-11).
  unit_cost         numeric(10,2),          -- last known unit cost, USD
  vendor_url        text,                   -- direct order / product page
  location_codes    text[] NOT NULL DEFAULT '{}',  -- sites that use this part; empty = all / unspecified
  notes             text,

  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        text,                   -- session email at insert
  updated_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        text                    -- session email at last edit
);

COMMENT ON TABLE parts_directory IS
  'Frequently-ordered parts lookup surfaced at /admin/parts/directory. Written via splash-workorders service-role only; photos live in R2 (splash-parts-manuals) keyed by photo_r2_key.';

-- Grouping + exact-ish lookups.
CREATE INDEX IF NOT EXISTS idx_parts_directory_equipment
  ON parts_directory (parent_equipment);
CREATE INDEX IF NOT EXISTS idx_parts_directory_part_number
  ON parts_directory (part_number);
CREATE INDEX IF NOT EXISTS idx_parts_directory_vendor
  ON parts_directory (vendor);

-- Substring search. The UI searches with ILIKE '%term%', which cannot use a
-- btree index; pg_trgm GIN indexes make those scans cheap as the table grows.
-- pg_trgm is already installed on this project (schema: public).
CREATE INDEX IF NOT EXISTS idx_parts_directory_name_trgm
  ON parts_directory USING gin (part_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_parts_directory_number_trgm
  ON parts_directory USING gin (part_number gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_parts_directory_equipment_trgm
  ON parts_directory USING gin (parent_equipment gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_parts_directory_vendor_trgm
  ON parts_directory USING gin (vendor gin_trgm_ops);

-- Two admins editing the same bench at once shouldn't silently create twins.
-- Partial so rows without a part number (hand-entered, number unknown) are
-- still allowed, and duplicates there are the operator's call.
CREATE UNIQUE INDEX IF NOT EXISTS uq_parts_directory_number_per_equipment
  ON parts_directory (lower(parent_equipment), lower(part_number))
  WHERE part_number IS NOT NULL AND part_number <> '';

-- updated_at maintenance. Trigger rather than app-side so a manual SQL-editor
-- fix can't leave a stale timestamp behind.
CREATE OR REPLACE FUNCTION parts_directory_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_parts_directory_updated_at ON parts_directory;
CREATE TRIGGER trg_parts_directory_updated_at
  BEFORE UPDATE ON parts_directory
  FOR EACH ROW
  EXECUTE FUNCTION parts_directory_touch_updated_at();

-- Service-role only. No policies on purpose — see header.
ALTER TABLE parts_directory ENABLE ROW LEVEL SECURITY;
