-- Emailed no-sign-in approval links for form workflows.
--
-- NOT YET APPLIED. Run in the Supabase SQL editor before publishing any form
-- whose email step uses {approval.link}. Until this table exists, minting
-- fails soft: the email still goes out, and its button falls back to the
-- signed-in submission page.
--
-- WHAT A ROW IS
--
--   One link, for one recipient, to act on one submission at one workflow
--   stage. The worker mints a row per recipient when an email step that
--   leads into an approval stage renders `{approval.link}`.
--
-- ONLY THE HASH IS STORED. The raw token exists in the email (and in that
-- email's queued copy in outbound_emails, which admins can read in the email
-- queue viewer). A read of THIS table cannot be turned back into a working
-- link.
--
-- WHAT ENDS A LINK -- all checked by the worker at use time:
--   expires_at passed      -- 7 days from minting
--   used_at set            -- the recipient approved or denied through it
--   stage moved            -- the submission is no longer at stage_id
--   approver removed       -- recipient no longer on the stage's approver list
--
-- OPENING DOES NOT END IT. open_count is an audit counter only; an approver
-- who opens the link, gets pulled away and comes back must find it working.
--
-- NO FK ON submission_id, deliberately. On the submit path the email cascade
-- runs BEFORE the submission row is inserted (so the row lands with its
-- post-cascade stage), which means the link is minted while there is not yet
-- a row to reference. The worker checks the submission exists on every use.
--
-- RLS ENABLED WITH NO POLICIES, matching every other table here: the worker
-- uses SUPABASE_SERVICE_KEY, which bypasses RLS; anon and authenticated get
-- nothing. Do NOT add policies.

begin;

create table if not exists public.form_approval_links (
  id                  uuid primary key default gen_random_uuid(),
  -- SHA-256 hex of the token in the emailed URL.
  token_hash          text not null unique,
  form_id             uuid not null references public.forms (id) on delete cascade,
  submission_id       uuid not null,
  stage_id            text not null,
  recipient_email     text not null,
  created_at          timestamptz not null default now(),
  expires_at          timestamptz not null,
  open_count          integer not null default 0,
  last_opened_at      timestamptz null,
  used_at             timestamptz null,
  -- Stage id of the decision taken (e.g. the Approve transition's target).
  used_transition_to  text null,

  constraint form_approval_links_hash_shape
    check (token_hash ~ '^[0-9a-f]{64}$'),
  constraint form_approval_links_expiry_after_create
    check (expires_at > created_at)
);

-- "Every link issued for this submission" -- for support / audit queries.
create index if not exists form_approval_links_submission_idx
  on public.form_approval_links (submission_id);

alter table public.form_approval_links enable row level security;

-- Explicit, rather than relying on default privileges (see grant-lockdown-01).
revoke all on public.form_approval_links from anon, authenticated;
grant select, insert, update on public.form_approval_links to service_role;

comment on table public.form_approval_links is
  'Emailed no-sign-in approval links. One row per recipient per submission per stage. Stores only the SHA-256 of the token. Ended by expiry, use, the submission leaving stage_id, or the recipient leaving the approver list -- NOT by opening.';
comment on column public.form_approval_links.submission_id is
  'No FK: minted during the submit-time email cascade, before the submission row is inserted. The worker verifies existence on use.';

commit;

-- ---------------------------------------------------------------------------
-- Verification. Expected right after apply: rls_enabled true, 0 policies,
-- 3 indexes (pkey, token_hash unique, submission_idx), 0 rows.
-- ---------------------------------------------------------------------------
-- select c.relrowsecurity as rls_enabled,
--        (select count(*) from pg_policy p where p.polrelid = c.oid) as policies,
--        (select count(*) from pg_index i where i.indrelid = c.oid)  as indexes,
--        (select count(*) from public.form_approval_links)           as rows
--   from pg_class c
--   join pg_namespace n on n.oid = c.relnamespace
--  where n.nspname = 'public' and c.relname = 'form_approval_links';
--
-- Links for one submission, newest first:
-- select recipient_email, stage_id, created_at, expires_at, open_count,
--        used_at, used_transition_to
--   from public.form_approval_links
--  where submission_id = '<uuid>'
--  order by created_at desc;
