-- shortbreak-archive-01.sql
--
-- APPLIED 2026-10-05 against production by operator instruction ("archive and
-- lock it down"). SB-sec.md finding H3.
--
-- ===========================================================================
-- WHY
-- ===========================================================================
-- public.shortbreak carried four policies for `authenticated` -- SELECT,
-- INSERT, UPDATE, DELETE -- all USING (true) / WITH CHECK (true). Any signed-in
-- operator could read, rewrite or delete every row with their own access token
-- straight off PostgREST. The rows are named-employee clock times and
-- worked_6h_short_break flags: labour-law compliance evidence.
--
-- The table is dead (checked 2026-10-05):
--   - 1,154 rows, work dates 2025-10-10 .. 2025-10-26, every row a violation
--     (worked_6h_short_break = true).
--   - Loaded by a nightly ~04:00 UTC job that lives OUTSIDE this repo (zero
--     references here) and wrote as `authenticated` -- hence the policies.
--     Last nightly load 2025-10-24; two manual-looking loads 2025-10-27; nothing
--     since. 2025-10-24 appears loaded twice (132 rows / 66 employees).
--   - No triggers, no dependent views or functions.
--
-- ===========================================================================
-- WHAT THIS DOES
-- ===========================================================================
--  1. Drops the four `authenticated` policies.
--  2. Revokes every privilege anon/authenticated held on the table.
--  3. Moves it to a new `archive` schema, which PostgREST does not serve and on
--     which anon/authenticated have no USAGE. Data is untouched.
--  If the old nightly job ever wakes up it now fails loudly ("relation
--  public.shortbreak does not exist") instead of silently writing.
--
-- REVERSIBLE:
--   alter table archive.shortbreak set schema public;
--   then re-create policies / grants as needed.
-- PERMANENT REMOVAL (when nobody needs the evidence): drop table archive.shortbreak;

create schema if not exists archive;
revoke all on schema archive from public, anon, authenticated;
comment on schema archive is
  'Retired tables kept for record. Not exposed via PostgREST; no anon/authenticated access.';

drop policy if exists "Enable delete access for authenticated users" on public.shortbreak;
drop policy if exists "Enable insert access for authenticated users" on public.shortbreak;
drop policy if exists "Enable read access for authenticated users"   on public.shortbreak;
drop policy if exists "Enable update access for authenticated users" on public.shortbreak;

revoke all on public.shortbreak from anon, authenticated;

alter table public.shortbreak set schema archive;

comment on table archive.shortbreak is
  'ARCHIVED 2026-10-05 (SB-sec H3). Short-break violation report, work dates 2025-10-10..2025-10-26, loaded by a retired external nightly job. Read-only record; RLS on, no policies.';
