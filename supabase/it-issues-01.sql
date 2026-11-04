-- APPLIED 2026-11-04 (Supabase migration it_issues_01). Re-running is safe:
-- every statement is IF NOT EXISTS.
--
-- IT Issue Tracker (2026-11-04) -- tables for the site-facing IT issue log
-- served by splash-workorders (apps/workorders-worker/src/it-issues*.ts) and
-- the apps/web pages under /admin/it-issues plus the public /it-issue/{token}.
--
-- ONE ROW PER PROBLEM, NOT PER OCCURRENCE. The spreadsheet this replaces left
-- it ambiguous whether a repeat failure was a new row or an edit, and its
-- "Recurring" / "Frequency" / "Previous ticket" columns could (and did)
-- contradict each other. Here a repeat is an `occurrence` event on the same
-- issue; occurrence_count / last_occurred_at are maintained by the worker from
-- those events, and "recurring" is simply occurrence_count > 1.
--
-- Logging an occurrence on a RESOLVED issue reopens it rather than starting a
-- new one, so a fix that did not hold stays visible on one timeline.
--
-- RLS on with no policies, like every table here: service role only.

create table if not exists public.it_issues (
  id                 uuid primary key default gen_random_uuid(),
  ref_no             bigint generated always as identity unique,
  location_id        bigint not null references public.locations(id),
  site_number        integer,
  site_name          text not null,
  device             text not null,
  device_unit        text,
  problem            text not null,
  error_text         text,
  customer_impact    text not null
    check (customer_impact in ('none','single_customer','multiple_customers','site_wide')),
  priority           text not null check (priority in ('critical','high','medium','low')),
  troubleshooting    text,
  status             text not null default 'open'
    check (status in ('open','waiting_on_it','in_progress','resolved')),
  reporter_name      text not null,
  reporter_phone     text not null,
  created_by_email   text not null,
  it_ticket_no       text,
  mx_request_id      bigint,
  first_reported_at  timestamptz not null default now(),
  last_occurred_at   timestamptz not null default now(),
  occurrence_count   integer not null default 1,
  last_escalated_at  timestamptz,
  resolved_at        timestamptz,
  resolution         text,
  resolved_by        text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists it_issues_location_status_idx on public.it_issues (location_id, status);
create index if not exists it_issues_open_idx on public.it_issues (status, first_reported_at) where status <> 'resolved';

-- Append-only timeline. `via` says how the actor got there: 'app' (signed in),
-- 'email_link' (no sign-in, actor_name is typed and therefore a weaker claim),
-- 'system' (the worker itself, e.g. a MaintainX request it created).
create table if not exists public.it_issue_events (
  id          bigint generated always as identity primary key,
  issue_id    uuid not null references public.it_issues(id) on delete cascade,
  kind        text not null check (kind in (
                'created','occurrence','note','status','ticket','escalated',
                'resolved','reopened','mx_request','priority')),
  at          timestamptz not null default now(),
  actor_name  text,
  actor_email text,
  via         text not null default 'app' check (via in ('app','email_link','system')),
  note        text,
  details     jsonb not null default '{}'::jsonb
);

create index if not exists it_issue_events_issue_idx on public.it_issue_events (issue_id, at);

-- No-sign-in links sent in the IT report / escalation emails. SHA-256 of the
-- token only; the raw token exists only in the email. Opening never spends a
-- link. It works for actions while the issue is open and read-only after it is
-- resolved, until expires_at.
create table if not exists public.it_issue_links (
  id             uuid primary key default gen_random_uuid(),
  issue_id       uuid not null references public.it_issues(id) on delete cascade,
  token_hash     text not null unique,
  recipient      text not null,
  expires_at     timestamptz not null,
  open_count     integer not null default 0,
  last_opened_at timestamptz,
  created_at     timestamptz not null default now()
);

create index if not exists it_issue_links_issue_idx on public.it_issue_links (issue_id);

alter table public.it_issues enable row level security;
alter table public.it_issue_events enable row level security;
alter table public.it_issue_links enable row level security;
