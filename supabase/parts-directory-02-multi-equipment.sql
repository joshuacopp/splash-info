-- Parts Directory 02 — a part can live on more than one machine.
--
-- Many manufacturer parts (bearings, motors, cylinders) are shared across the
-- wrap, top brush, conveyor, etc. Storing one row per (part, machine) forced
-- operators to enter the same part several times. parent_equipment becomes a
-- text[] so one row carries every machine it fits.
--
-- Uniqueness moves with it: "same number on the same machine" no longer
-- describes a duplicate. The real duplicate is the same vendor's same part
-- number entered twice, so that is what the index now guards.
--
-- Status: APPLIED to the live project (rewokyofschtvqgxrxwl) on 2026-09-12.
-- Committed for the record, matching the convention of 01.

-- 1. text -> text[]. Existing single values become one-element arrays; NULL /
--    blank becomes an empty array.
ALTER TABLE parts_directory
  ALTER COLUMN parent_equipment DROP NOT NULL;

DROP INDEX IF EXISTS idx_parts_directory_equipment;
DROP INDEX IF EXISTS idx_parts_directory_equipment_trgm;
DROP INDEX IF EXISTS uq_parts_directory_number_per_equipment;

ALTER TABLE parts_directory
  ALTER COLUMN parent_equipment TYPE text[]
  USING CASE
    WHEN parent_equipment IS NULL OR btrim(parent_equipment) = '' THEN '{}'::text[]
    ELSE ARRAY[btrim(parent_equipment)]
  END;

ALTER TABLE parts_directory
  ALTER COLUMN parent_equipment SET DEFAULT '{}',
  ALTER COLUMN parent_equipment SET NOT NULL;

COMMENT ON COLUMN parts_directory.parent_equipment IS
  'Every machine this part is used on, e.g. {"Top Brush","Wrap","Conveyor"}. Empty = unassigned.';

-- 2. Containment lookups for the equipment filter (parent_equipment @> / &&).
--
-- Note: there is deliberately NO gin_trgm_ops index on equipment. gin_trgm_ops
-- cannot index a text[], and the obvious workaround
-- (gin (array_to_string(parent_equipment,' ') gin_trgm_ops)) is rejected because
-- array_to_string is STABLE, not IMMUTABLE. Equipment substring matching is
-- therefore done client-side over the already-fetched list; the exact-value
-- equipment filter uses this index.
CREATE INDEX IF NOT EXISTS idx_parts_directory_equipment_gin
  ON parts_directory USING gin (parent_equipment);

-- 3. New duplicate guard: one row per vendor + part number. Partial, so rows
--    with no part number (number unknown) are still allowed; rows with no
--    vendor coalesce to '' so two vendorless entries of the same number still
--    collide.
CREATE UNIQUE INDEX IF NOT EXISTS uq_parts_directory_number_per_vendor
  ON parts_directory (lower(coalesce(vendor, '')), lower(part_number))
  WHERE part_number IS NOT NULL AND part_number <> '';
