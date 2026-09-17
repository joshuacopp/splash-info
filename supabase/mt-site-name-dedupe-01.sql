-- mt-site-name-dedupe-01.sql
--
-- mt_site_name returned MORE THAN ONE ROW for some sites, which silently
-- doubled any figure computed through a join to it.
--
-- `locations` holds two records for site_numbers 19 (Bedford Hills), 40
-- (Greenwich) and 68 (Shelton) -- identical names, duplicate rows. The view
-- selected straight from it, so it inherited them.
--
-- HOW IT SURFACED, AND WHY IT HAD NOT BEFORE: every existing consumer reads
-- this view as a LOOKUP (build a site_number -> name map, or render one name),
-- and a duplicate key in a map is harmless -- the second write overwrites the
-- first with the same value. The moment mt_mechanic_day JOINED to it inside an
-- aggregate, each duplicate fanned the row out and every summed hour at those
-- three sites came back exactly 2x. Caught because a Greenwich day reported
-- 9.53 h on site against a 5.28 h punch -- an impossible number, which is the
-- only reason it was visible at all. A 2x that lands somewhere plausible would
-- not have been.
--
-- The deduplication belongs here rather than in each caller: a name lookup
-- promising one row per site is the contract every caller already assumes.
-- Cost figures are unaffected -- mt_site_month, mt_cost_centre_month and
-- mt_offsite_time never join to this view. Verified after the fix.

create or replace view public.mt_site_name as
select distinct on (l.site_number)
       l.site_number,
       coalesce(nullif(trim(both from p.location_pretty), ''),
                nullif(trim(both from l.site), ''),
                'Site ' || l.site_number) as site_name
from locations l
left join lateral (
  select pp.location_pretty
  from pricing_simple pp
  where pp.site::text = l.site_number::text and pp.location_pretty is not null
  limit 1
) p on true
where l.site_number is not null
order by l.site_number, site_name;
