-- Changeable secret links + "Save and continue later" drafts for forms.
-- 2026-11-15. APPLIED via psql 2026-11-15.
--
-- 1. forms.link_key -- a random secret that REPLACES the slug in a link-only
--    form's public URL (/forms/{link_key}). While it is set, the plain
--    /forms/{slug} URL stops working, and every public endpoint for the form
--    (submit, uploads, lookups, employee search) answers only to the key.
--    "Change link" in the builder's Settings tab writes a new key, which kills
--    every old link and QR code at once. Null = the form is reached by slug,
--    exactly as before (existing tablet bookmarks keep working until an admin
--    turns the secret link on).
--
-- 2. forms.email_drafts -- shows a "Save and continue later" button. The
--    filler types a company email address; the draft is stored server-side
--    and a random resume link (/forms/resume/{token}) is emailed. Turning it
--    on also turns OFF the browser's local autosave for that form, so a
--    personnel form never leaves its answers on a shared site tablet.
--
-- 3. form_drafts -- the saved drafts. Only the SHA-256 of the resume token is
--    stored. A draft expires 14 days after its last save and is deleted by the
--    daily cleanup cron; it is deleted at once when the form is submitted.
--    Draft answers can be personnel data: RLS on, no policies, no grants to
--    anon/authenticated (service key only), like every other forms table.

alter table public.forms add column if not exists link_key text;
alter table public.forms add column if not exists email_drafts boolean not null default false;

create unique index if not exists forms_link_key_key
  on public.forms (link_key) where link_key is not null;

comment on column public.forms.link_key is
  'Secret that replaces the slug in a link-only form''s public URL. Set = /forms/{slug} no longer works. Rotated from the builder Settings tab.';
comment on column public.forms.email_drafts is
  'Show "Save and continue later" (server draft + emailed resume link). Also disables browser-local autosave for the form.';

create table if not exists public.form_drafts (
  id                    uuid primary key default gen_random_uuid(),
  form_id               uuid not null references public.forms(id) on delete cascade,
  token_hash            text not null unique,
  email                 text not null,
  pending_submission_id uuid not null,
  "values"              jsonb not null default '{}'::jsonb,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  last_emailed_at       timestamptz,
  expires_at            timestamptz not null
);

create index if not exists form_drafts_expires_idx on public.form_drafts (expires_at);
create index if not exists form_drafts_pending_idx on public.form_drafts (pending_submission_id);
create index if not exists form_drafts_email_idx on public.form_drafts (lower(email), created_at);

alter table public.form_drafts enable row level security;
revoke all on public.form_drafts from public, anon, authenticated;

comment on table public.form_drafts is
  'Server-side "Save and continue later" drafts. token_hash = sha256 hex of the emailed resume token. Expires 14 days after last save; deleted on submit.';
