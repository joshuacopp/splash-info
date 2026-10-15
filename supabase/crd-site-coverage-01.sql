-- crd-site-coverage-01.sql
--
-- APPLIED 2026-10-15 against production (migration `crd_site_coverage_01`).
-- Verified as anon with the widget's publishable key: the view still returns
-- site 126 with crd_name/crd_email appended (null, no rows yet); the table
-- itself returns 42501 permission denied.
--
-- Which CRD (Customer Relations) agent covers each site, exposed to the
-- JotForm "SB Site Lookup Widget" through jotform_site_lookup so the Site
-- Opening / Site Closing forms can email the covering agent.
--
-- WHY A TABLE AND NOT A COLUMN ON locations
--   locations has duplicate rows per site_number (the view dedups with
--   DISTINCT ON), so a column there would have to be kept equal across every
--   duplicate. One row per site here has nothing to drift.
--
-- WHY NO anon GRANT ON THE TABLE
--   jotform_site_lookup is a plain (not security_invoker) view owned by
--   postgres, so anon reading the view reads this table through the owner.
--   The table itself stays unreadable to anon/authenticated, matching
--   grant-lockdown-01. RLS on with zero policies like everything else here.
--
-- THE VIEW CHANGE ONLY APPENDS COLUMNS. create or replace view requires the
--   existing columns unchanged and in order; crd_name / crd_email go on the
--   end, so the widget's existing fills are untouched. A site with no
--   coverage row yields NULLs.

create table if not exists public.crd_site_coverage (
  site_number integer primary key,
  crd_name    text,
  crd_email   text not null check (crd_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  updated_at  timestamptz not null default now(),
  updated_by  text
);

alter table public.crd_site_coverage enable row level security;

comment on table public.crd_site_coverage is
  'CRD agent covering each site. Read by jotform_site_lookup (crd_name, crd_email) for the Site Opening/Closing JotForms.';

create or replace view public.jotform_site_lookup as
 WITH dedup AS (
         SELECT DISTINCT ON (l.site_number) l.site_number,
            l.site,
            l.location,
            l.area_manager,
            l.regional_manager,
            l.rm_group,
            l.rm_email,
            l.am_email,
            l.hrt_email,
            l.site_email
           FROM locations l
          ORDER BY l.site_number, l.id
        ), flags AS (
         SELECT locations.site_number,
            bool_or(locations.fivestar) AS fivestar
           FROM locations
          GROUP BY locations.site_number
        ), gm AS (
         SELECT DISTINCT ON ((split_part(jotform_location_map.report_name::text, '-'::text, 1)::integer)) split_part(jotform_location_map.report_name::text, '-'::text, 1)::integer AS site_number,
            jotform_location_map.general_manager,
            jotform_location_map.general_manager_email
           FROM jotform_location_map
          WHERE jotform_location_map.report_name::text ~ '^[0-9]+-'::text
          ORDER BY (split_part(jotform_location_map.report_name::text, '-'::text, 1)::integer), (jotform_location_map.general_manager_email IS NULL), jotform_location_map.id
        )
 SELECT d.site_number,
    d.site,
    d.location,
    d.area_manager,
    d.am_email,
    d.regional_manager,
    d.rm_email,
    d.rm_group,
    g.general_manager,
    g.general_manager_email,
    d.hrt_email,
    d.site_email,
    COALESCE(f.fivestar, false) AS fivestar,
    c.crd_name,
    c.crd_email
   FROM dedup d
     LEFT JOIN flags f USING (site_number)
     LEFT JOIN gm g USING (site_number)
     LEFT JOIN crd_site_coverage c USING (site_number);
