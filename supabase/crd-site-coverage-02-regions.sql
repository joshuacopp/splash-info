-- crd-site-coverage-02-regions.sql
--
-- APPLIED 2026-10-15 against production (migration `crd_site_coverage_02_regions`).
-- Verified: in a rolled-back transaction, a site whose agent differs from the
-- region supervisor returns both emails; a site whose agent IS the supervisor
-- (case-insensitive) returns crd_supervisor_email NULL. As anon with the
-- widget's publishable key the view still answers and crd_regions is 42501.
--
-- Two CRD regions, each with a supervisor who gets a copy of every Site
-- Opening / Site Closing report from the sites in that region, alongside the
-- covering agent (crd-site-coverage-01.sql).
--
-- SUPERVISOR LIVES ON THE REGION, NOT THE SITE. Changing a supervisor is one
--   row, not one per site.
--
-- crd_supervisor_email IS NULLED WHEN IT EQUALS crd_email. For some sites the
--   agent and the supervisor are the same person. JotForm notification
--   recipients are two separate fields; nulling here guarantees one email
--   rather than relying on JotForm to dedupe. crd_supervisor_name is left as
--   is (display only).
--
-- View change again ONLY APPENDS (crd_region, crd_supervisor_name,
--   crd_supervisor_email after crd_email).

create table if not exists public.crd_regions (
  region           text primary key,
  supervisor_name  text,
  supervisor_email text not null check (supervisor_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  updated_at       timestamptz not null default now(),
  updated_by       text
);
alter table public.crd_regions enable row level security;
comment on table public.crd_regions is
  'CRD regions and the supervisor over each. crd_site_coverage.crd_region points here.';

alter table public.crd_site_coverage
  add column if not exists crd_region text references public.crd_regions(region) on update cascade;

-- jotform_site_lookup: as in crd-site-coverage-01.sql, plus
--     c.crd_region,
--     r.supervisor_name AS crd_supervisor_name,
--     CASE WHEN lower(r.supervisor_email) = lower(c.crd_email) THEN NULL
--          ELSE r.supervisor_email END AS crd_supervisor_email
--   ... LEFT JOIN crd_regions r ON r.region = c.crd_region;
-- Current definition: select pg_get_viewdef('public.jotform_site_lookup', true);
