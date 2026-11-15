-- site-status-01.sql
--
-- APPLIED 2026-11-15 against production. Verified in a rolled-back transaction:
-- a second open closure for the same site is refused (site_closures_one_open),
-- a reopened site can be closed again, and an unknown reason is refused.
--
-- Site open / closed status (2026-11-15). Replaces the Site Opening / Site
-- Closing JotForms once tested.
--
--   site_closures         one row per closure. A site is CLOSED while it has a
--                         row with reopened_at IS NULL; the partial unique index
--                         makes a second open closure for the same site
--                         impossible, so two people closing at once can't
--                         double it.
--   site_closure_links    no-sign-in "extend / mark open" links mailed to the
--                         RM + RD when a closure runs past its estimate. Only
--                         the SHA-256 of the token is stored.
--   site_down_items       partial outages ("vacuums down"). Shown on the board,
--                         never emailed, never block a full closure.
--   site_status_settings  singleton: the company-wide reopen-link token and the
--                         test-mode address (every email goes only there while
--                         it is set).
--
-- Who may CLOSE is decided in the worker (site's am_email / rm_email, or admin
-- tier); the database has no opinion. Site names, RD and RM are SNAPSHOTTED on
-- the closure so reports keep saying who owned the site at the time.
--
-- RLS on with zero policies and no grants to anon / authenticated, like every
-- other table here: only the service key reads or writes.

create table if not exists public.site_closures (
  id                    uuid primary key default gen_random_uuid(),
  site_number           integer not null,
  site_name             text not null,
  rd_name               text,
  rd_email              text,
  rm_name               text,
  rm_email              text,
  reason                text not null check (reason in ('weather','power','water','equipment','staffing','other')),
  reason_detail         text check (char_length(reason_detail) <= 1000),
  closed_at             timestamptz not null default now(),
  closed_by             text not null,
  -- The first estimate, kept so reports can say how far off it was.
  original_est_reopen_at timestamptz not null,
  est_reopen_at         timestamptz not null,
  -- [{at, by, from, to, note}] -- every change to est_reopen_at.
  estimate_changes      jsonb not null default '[]'::jsonb,
  reopened_at           timestamptz,
  reopened_by           text,
  reopened_via          text check (reopened_via in ('board','link','email_link')),
  reopen_note           text check (char_length(reopen_note) <= 1000),
  -- The est_reopen_at value the overdue email was last sent for. The cron
  -- claims a send by compare-and-set on this, so overlapping ticks can't
  -- double-mail; extending moves est_reopen_at and re-arms it.
  overdue_notified_for  timestamptz,
  created_at            timestamptz not null default now()
);

create unique index if not exists site_closures_one_open
  on public.site_closures (site_number) where reopened_at is null;
create index if not exists site_closures_site_closed_at
  on public.site_closures (site_number, closed_at desc);
create index if not exists site_closures_closed_at
  on public.site_closures (closed_at desc);

comment on table public.site_closures is
  'Site open/closed history. Open closure = reopened_at IS NULL (at most one per site). Written by splash-forms src/site-status/.';

create table if not exists public.site_closure_links (
  id          uuid primary key default gen_random_uuid(),
  closure_id  uuid not null references public.site_closures(id) on delete cascade,
  token_hash  text not null unique,
  recipient   text not null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);
create index if not exists site_closure_links_closure on public.site_closure_links (closure_id);

create table if not exists public.site_down_items (
  id            uuid primary key default gen_random_uuid(),
  site_number   integer not null,
  item          text not null check (char_length(item) between 1 and 80),
  note          text check (char_length(note) <= 500),
  reported_at   timestamptz not null default now(),
  reported_by   text not null,
  reported_via  text not null check (reported_via in ('board','link')),
  cleared_at    timestamptz,
  cleared_by    text,
  cleared_via   text check (cleared_via in ('board','link'))
);
create index if not exists site_down_items_open
  on public.site_down_items (site_number) where cleared_at is null;

create table if not exists public.site_status_settings (
  id            integer primary key default 1 check (id = 1),
  open_token    text not null,
  test_email_to text,
  updated_at    timestamptz not null default now(),
  updated_by    text
);

-- Seed: a random link token, and TEST MODE ON (operator 2026-11-15: not live
-- until tested). Clear test_email_to from the board to go live.
insert into public.site_status_settings (id, open_token, test_email_to, updated_by)
values (
  1,
  replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  'josh.copp@splashcarwashes.com',
  'site-status-01.sql'
)
on conflict (id) do nothing;

alter table public.site_closures        enable row level security;
alter table public.site_closure_links   enable row level security;
alter table public.site_down_items      enable row level security;
alter table public.site_status_settings enable row level security;

revoke all on public.site_closures, public.site_closure_links,
              public.site_down_items, public.site_status_settings
  from anon, authenticated;
