-- ============================================================================
-- Water readings on inventory.site_visits: hardness (grains per gallon) and
-- total dissolved solids (ppm), captured at the time of the visit.
--
-- One reading of each per visit -- not an incoming/treated pair. If that is
-- wanted later, add two more columns rather than reshaping these.
--
-- WHY grains per gallon. Hardness has two conventions in common use, gpg and
-- ppm as CaCO3, and they differ by a factor of ~17.1. A reading of "10" is
-- ordinary municipal water in gpg and nearly distilled in ppm, and nothing in
-- the stored number distinguishes them. The column name carries the unit so
-- the ambiguity cannot survive into the data.
--
-- WHY NO UPPER BOUND. Only `>= 0` is enforced. Earlier in this same schema an
-- upper bound copied from the standalone repo (discount < 1) rejected real
-- configuration and failed a load with a 23514 -- see
-- inventory-discount-allow-full.sql. A CHECK that fires on a legitimate but
-- unusual reading would block a submit in the field, with no way for the tech
-- to proceed. Plausible-range warnings belong in the form, where they can be
-- overridden; the database only rejects what is impossible.
--
-- Both columns are nullable with no default. The 1,628 imported visits have no
-- water data and never will, so NULL has to mean "not recorded" rather than
-- zero -- a real reading of 0 gpg (RO or softened water) is meaningful and
-- must stay distinguishable from a blank.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- STEP 1 -- add the columns. Safe to re-run.
-- ---------------------------------------------------------------------------
alter table inventory.site_visits
  add column if not exists water_hardness_gpg numeric
    constraint site_visits_water_hardness_gpg_check check (water_hardness_gpg >= 0);

alter table inventory.site_visits
  add column if not exists tds_ppm numeric
    constraint site_visits_tds_ppm_check check (tds_ppm >= 0);

comment on column inventory.site_visits.water_hardness_gpg is
  'Water hardness in GRAINS PER GALLON, read at the visit. NULL = not recorded; 0 is a valid reading.';
comment on column inventory.site_visits.tds_ppm is
  'Total dissolved solids in ppm, read at the visit. NULL = not recorded; 0 is a valid reading.';


-- ---------------------------------------------------------------------------
-- STEP 2 -- verify. EXPECT two rows, both numeric and nullable ('YES').
-- ---------------------------------------------------------------------------
select column_name, data_type, is_nullable
  from information_schema.columns
 where table_schema = 'inventory'
   and table_name   = 'site_visits'
   and column_name in ('water_hardness_gpg', 'tds_ppm')
 order by column_name;
