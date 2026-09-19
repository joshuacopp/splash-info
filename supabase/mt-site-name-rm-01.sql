-- mt-site-name-rm-01.sql
--
-- Adds the Regional Manager to mt_site_name so site lists can be grouped by
-- who owns them.
--
-- WHY: the site tables had grown to 57 flat rows and the operator could not
-- find their own sites in them -- "how can we break this up so it's not an 80
-- row scroll?". Nine RMs with 3-10 sites each is a readable shape.
--
-- COLUMN NAMING, AND THE TRAP IN IT: `locations.regional_manager` really is
-- the Regional Manager, but `locations.area_manager` is the Regional
-- DIRECTOR -- the org renamed the roles and the columns kept their legacy
-- names. See the label-vs-data entry in CLAUDE.md. Group on
-- regional_manager; area_manager is a level up and would give four huge
-- buckets rather than nine useful ones.
--
-- Appended at the END of the select: `create or replace view` cannot insert a
-- column in the middle, and position is irrelevant to PostgREST callers.
--
-- The distinct-on dedupe from mt-site-name-dedupe-01 is preserved -- locations
-- still holds two rows for sites 19, 40 and 68, and a duplicate here fans out
-- every join that aggregates.

create or replace view public.mt_site_name as
select distinct on (l.site_number)
       l.site_number,
       coalesce(nullif(trim(both from p.location_pretty), ''),
                nullif(trim(both from l.site), ''),
                'Site ' || l.site_number) as site_name,
       nullif(trim(both from l.regional_manager), '') as regional_manager
from locations l
left join lateral (
  select pp.location_pretty
  from pricing_simple pp
  where pp.site::text = l.site_number::text and pp.location_pretty is not null
  limit 1
) p on true
where l.site_number is not null
order by l.site_number, site_name;
