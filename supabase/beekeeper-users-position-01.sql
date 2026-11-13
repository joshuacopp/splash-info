-- Beekeeper users: position and direct manager, ALTER 01 (2026-11-13). APPLIED 2026-11-13 via psql.
--
-- Adds two Beekeeper profile fields to beekeeper_users so personnel forms can
-- work out an employee's org level (who may see a warning notice, pay change
-- or termination about them):
--
--   position       custom_fields[key=position], visibility "public", free
--                  text. Observed values: "Regional Manager", "General Manager",
--                  "Assistant General Manager", "Customer Service Advisor",
--                  "Laborers and Helpers".
--   reports_to_id  custom_fields[key=reports_to], a user_select. Its value is
--                  an object ({id, display_name, ...}) or null. Only the
--                  Beekeeper user id is stored. It was null on every recent hire
--                  sampled and on the sampled Regional Manager, so it CANNOT be
--                  the basis of access control. Level comes from position plus
--                  site coverage; this column is informational.
--
-- ORDER MATTERS: run this file BEFORE deploying the beekeeper-worker change
-- that writes these columns. Upserting a column that does not exist fails the
-- whole batch, so the hourly sync would stop until this runs.
--
-- Guarded; safe to re-run.

alter table public.beekeeper_users add column if not exists position text;
alter table public.beekeeper_users add column if not exists reports_to_id text;

comment on column public.beekeeper_users.position is
  'Beekeeper custom field "position" (free text). Synced; do not edit here.';
comment on column public.beekeeper_users.reports_to_id is
  'Beekeeper user id from custom field "reports_to" (Direct manager). Often null; informational only, not used for access control.';

-- After the next sync, the job titles in use, with headcounts. Rows the sync
-- has not touched in two days are people who have left (see
-- beekeeper-users-status-01.sql), so they are excluded:
--
--   select coalesce(position, '(blank)') as position,
--          count(*) as people,
--          count(*) filter (where pay_type = 'Salary') as salaried
--   from public.beekeeper_users
--   where coalesce(suspended, false) = false
--     and synced_at > (select max(synced_at) from public.beekeeper_users) - interval '2 days'
--   group by 1
--   order by people desc;
