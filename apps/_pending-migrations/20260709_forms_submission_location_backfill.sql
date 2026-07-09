-- One-time backfill of form_submissions.location_code for existing rows.
--
-- Run AFTER the schema migration (20260709_forms_submission_scoping.sql) and
-- AFTER you've designated scope_location_field_key on the forms that should be
-- location-scoped. Re-runnable: both passes only touch rows where
-- location_code IS NULL, so a second run is a no-op once everything resolves.
--
-- Mirrors the worker's resolveSubmissionLocationCode (db/forms.ts):
--   * primary path  — the scope field holds a 3-digit SITE NUMBER; resolve it
--                     to a canonical location_code via pricing_simple.site.
--   * passthrough   — the scope field is a `location` dropdown / location-keyed
--                     lookup, so the payload value ALREADY is a location_code.
--
-- location_code is stored lowercased to match the submit-time stamp
-- (siteToLocationCode lowercases) and the scoped read filter (which lowercases
-- session.locations). Apply through the normal migration flow, or run once by
-- hand against the DB.

begin;

-- Pass 1 — SITE-NUMBER forms. Join the submitted site number (payload value at
-- the form's scope field key) to pricing_simple.site and stamp its
-- location_code. This covers the auto-injected site-number field, the common
-- case. DISTINCT-safe: pricing_simple can have many rows per site (one per
-- package), so aggregate to a single code per site to avoid a fan-out UPDATE.
update public.form_submissions fs
set location_code = sub.location_code
from public.forms f
join lateral (
  select lower(ps.location_code) as location_code
  from public.pricing_simple ps
  where ps.site = (fs.payload ->> f.scope_location_field_key)
    and ps.location_code is not null
  limit 1
) sub on true
where fs.form_id = f.id
  and f.scope_location_field_key is not null
  and fs.location_code is null
  and coalesce(fs.payload ->> f.scope_location_field_key, '') <> '';

-- Pass 2 — PASSTHROUGH forms (scope field is a location dropdown / lookup whose
-- value is already a location_code). Any still-NULL scoped submission whose
-- payload value matches a known pricing_simple.location_code is stamped
-- directly. Runs second so a site-number value never gets misread as a code.
update public.form_submissions fs
set location_code = lower(fs.payload ->> f.scope_location_field_key)
from public.forms f
where fs.form_id = f.id
  and f.scope_location_field_key is not null
  and fs.location_code is null
  and coalesce(fs.payload ->> f.scope_location_field_key, '') <> ''
  and exists (
    select 1
    from public.pricing_simple ps
    where lower(ps.location_code) = lower(fs.payload ->> f.scope_location_field_key)
  );

commit;

-- Diagnostic — scoped forms whose submissions could NOT be resolved (bad/blank
-- site numbers on historical rows). These stay location_code = NULL, i.e.
-- super_admin / dc-admin only. Review before assuming the backfill is complete.
--
--   select f.id, f.title, f.scope_location_field_key,
--          count(*) as unresolved
--   from public.form_submissions fs
--   join public.forms f on f.id = fs.form_id
--   where f.scope_location_field_key is not null
--     and fs.location_code is null
--   group by f.id, f.title, f.scope_location_field_key
--   order by unresolved desc;
