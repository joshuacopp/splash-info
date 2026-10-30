-- auth-impersonation-01.sql
--
-- APPLIED 2026-10-30 via Supabase MCP (operator: "double check sql then
-- run"). Verified after: both tables exist, RLS on with 0 policies,
-- anon/authenticated SELECT denied, service_role INSERT allowed.
-- Inert until the worker code that writes them is deployed.
--
-- Two tables behind super_admin impersonation. See
-- packages/auth/src/impersonation.ts for every rule; this file is storage.
--
--   auth_impersonation          one row per "View as" -- the grant
--   auth_impersonation_action   one row per non-read request made in ACT mode
--
-- ===========================================================================
-- WHY auth_impersonation_action EXISTS AT ALL
-- ===========================================================================
-- In act mode the session IS the target -- every permission check keys on
-- session.email / userId -- so every record a write produces names the
-- target: workflow history, comments, claim activity, and any email it sends.
-- This table is the only place the truth is written down. It is written
-- BEFORE the handler runs and the request is refused if the insert fails, so
-- a write cannot happen without its row. A row means ATTEMPTED, not
-- succeeded; the handler may still reject the request.
--
-- To answer "did Josh do this, or did Dan?" for a record stamped with Dan at
-- time T: look for a row here with target_email = Dan near T.
--
-- ===========================================================================
-- NO FOREIGN KEYS TO auth.users, ON PURPOSE
-- ===========================================================================
-- An audit trail must outlive the people in it. A FK would either block
-- deleting a user or (with cascade) delete the evidence with them. Emails are
-- snapshotted for the same reason: ids are unreadable once the user is gone.
--
-- token_hash is SHA-256 of the cookie value. The cookie itself is never
-- stored, so a database read cannot be turned into a working impersonation.
--
-- RLS on, no policies, no anon/authenticated grants -- service role only,
-- like every other auth table here.

begin;

create table public.auth_impersonation (
  id              uuid primary key default gen_random_uuid(),
  token_hash      text not null unique,
  actor_user_id   uuid not null,
  actor_email     text not null,
  target_user_id  uuid not null,
  target_email    text not null,
  mode            text not null check (mode in ('view', 'act')),
  -- Required to start, and required again to switch to 'act'. Mode switches
  -- are also written to sysadmin_audit_log with their own reason.
  reason          text not null check (length(trim(reason)) > 0),
  started_at      timestamptz not null default now(),
  expires_at      timestamptz not null,
  ended_at        timestamptz,
  ended_reason    text,
  check (actor_user_id <> target_user_id),
  check (expires_at > started_at)
);

create index auth_impersonation_actor_idx  on public.auth_impersonation (actor_user_id, started_at desc);
create index auth_impersonation_target_idx on public.auth_impersonation (target_user_id, started_at desc);

create table public.auth_impersonation_action (
  id                bigint generated always as identity primary key,
  impersonation_id  uuid not null references public.auth_impersonation (id),
  actor_user_id     uuid not null,
  actor_email       text not null,
  target_user_id    uuid not null,
  target_email      text not null,
  method            text not null,
  -- Service-binding calls from apps/web carry the placeholder host "internal";
  -- the path still identifies the worker because every worker is path-carved.
  host              text,
  path              text not null,
  at                timestamptz not null default now()
);

create index auth_impersonation_action_grant_idx  on public.auth_impersonation_action (impersonation_id, at);
create index auth_impersonation_action_target_idx on public.auth_impersonation_action (target_user_id, at desc);

alter table public.auth_impersonation        enable row level security;
alter table public.auth_impersonation_action enable row level security;
revoke all on public.auth_impersonation        from anon, authenticated;
revoke all on public.auth_impersonation_action from anon, authenticated;

commit;
