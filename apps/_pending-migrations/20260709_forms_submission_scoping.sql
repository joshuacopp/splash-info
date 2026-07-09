-- Forms submission scoping to location admins.
--
-- Adds the two columns the scoping feature depends on. Both are nullable with
-- no default, so this is an online-safe catalog change (brief ACCESS EXCLUSIVE
-- for the ALTERs; no full table rewrite).
--
-- Place under supabase/migrations/ with your standard timestamp-prefixed name
-- and apply through the normal migration flow.

-- 1. Per-form designation of WHICH field scopes submissions (a schema field.key).
--    NULL => the form is not location-scoped; its submissions stay visible to
--    super_admin / dc-admin only (the existing fallback).
alter table public.forms
  add column if not exists scope_location_field_key text;

-- 2. Denormalized location_code, stamped at submit time from the resolved site
--    number (via pricing_simple). NULL => unscoped submission (super_admin /
--    dc-admin only). Denormalized so the scoped read path can push
--    `location_code=in.(...)` into the same capped/paginated query instead of
--    fetch-then-filter, which would break the row-limit + CSV-cap semantics.
alter table public.form_submissions
  add column if not exists location_code text;

-- Scoped read path filters on location_code on every list / csv / report /
-- detail query. Partial index skips the many NULL (unscoped) rows to stay small.
create index if not exists form_submissions_location_code_idx
  on public.form_submissions (location_code)
  where location_code is not null;

-- Keeps the common "one form, this admin's site(s), newest first" query fast.
create index if not exists form_submissions_form_location_submitted_idx
  on public.form_submissions (form_id, location_code, submitted_at desc)
  where location_code is not null;
