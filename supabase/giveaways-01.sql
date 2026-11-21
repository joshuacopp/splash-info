-- giveaways-01.sql
--
-- APPLIED 2026-11-21 (Supabase migration giveaways_01).
--
-- Giveaway contests (2026-11-20). One row per contest; customers enter on the
-- site tablet at /forms/giveaway/{token}[?site=N]. Set up at /admin/giveaways
-- by admin tier or anyone with the `giveaways` form access grant -- NOT in the
-- form builder: the entry fields are fixed (name, email, phone, license plate,
-- barcode) and each contest only switches each one Off / Optional / Required.
--
--   giveaways         the contest: title, prize text, dates, per-field modes,
--                     whether the SMS marketing consent box is off / optional /
--                     required, one-entry-per-person.
--   giveaway_entries  one row per entry. sms_consent_text is the EXACT wording
--                     shown when the box was ticked (null when not ticked), so
--                     a later wording change never rewrites what someone
--                     agreed to. ip / user_agent are kept for the same reason.
--
-- RLS on with zero policies and no grants to anon / authenticated, like every
-- other table here: only the service key reads or writes.

create table if not exists public.giveaways (
  id                uuid primary key default gen_random_uuid(),
  -- The public link's secret. 24 URL-safe characters; rotate by updating it.
  token             text not null unique check (token ~ '^[A-Za-z0-9_-]{20,64}$'),
  title             text not null check (char_length(title) between 1 and 120),
  prize             text check (char_length(prize) <= 1000),
  -- Eastern calendar days, inclusive. Null = no limit on that side.
  starts_on         date,
  ends_on           date,
  -- {"name":{"mode":"off|optional|required","label":"..."}, "email":..., "phone":..., "plate":..., "barcode":...}
  fields            jsonb not null default '{}'::jsonb,
  sms_consent       text not null default 'optional' check (sms_consent in ('off','optional','required')),
  one_per_person    boolean not null default true,
  archived_at       timestamptz,
  created_at        timestamptz not null default now(),
  created_by_email  text,
  updated_at        timestamptz not null default now(),
  updated_by_email  text,
  check (ends_on is null or starts_on is null or ends_on >= starts_on)
);

comment on table public.giveaways is
  'Giveaway contests (2026-11-20). Public entry page /forms/giveaway/{token}; set up at /admin/giveaways. Written by splash-forms src/giveaways/.';

create table if not exists public.giveaway_entries (
  id                uuid primary key default gen_random_uuid(),
  giveaway_id       uuid not null references public.giveaways(id) on delete cascade,
  site_number       integer,
  site_name         text,
  name              text check (char_length(name) <= 100),
  -- Stored lower-case.
  email             text check (char_length(email) <= 254),
  -- 10 digits, no punctuation.
  phone             text check (phone ~ '^[0-9]{10}$'),
  -- Upper-case letters and digits only.
  plate             text check (plate ~ '^[A-Z0-9]{1,10}$'),
  barcode           text check (char_length(barcode) <= 64),
  sms_consent       boolean not null default false,
  sms_consent_text  text,
  ip                text,
  user_agent        text check (char_length(user_agent) <= 500),
  created_at        timestamptz not null default now()
);

create index if not exists giveaway_entries_giveaway_created
  on public.giveaway_entries (giveaway_id, created_at desc);
-- One-entry-per-person lookups.
create index if not exists giveaway_entries_phone on public.giveaway_entries (giveaway_id, phone) where phone is not null;
create index if not exists giveaway_entries_email on public.giveaway_entries (giveaway_id, email) where email is not null;
create index if not exists giveaway_entries_plate on public.giveaway_entries (giveaway_id, plate) where plate is not null;
create index if not exists giveaway_entries_barcode on public.giveaway_entries (giveaway_id, barcode) where barcode is not null;

comment on table public.giveaway_entries is
  'One row per giveaway entry. sms_consent_text = exact consent wording shown when ticked.';

alter table public.giveaways enable row level security;
alter table public.giveaway_entries enable row level security;
revoke all on public.giveaways from anon, authenticated;
revoke all on public.giveaway_entries from anon, authenticated;
