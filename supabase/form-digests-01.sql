-- Form digests (2026-11-14): scheduled summary emails configured per form from
-- the Digests tab on /admin/forms/{id}. Read and written only by splash-forms
-- with the service key (src/digests/); RLS on with no policies, like every
-- other forms table.
--
-- form_digests      -- one row per digest. `config` is DigestConfig
--                      (packages/forms-schema/src/digest.ts), validated by the
--                      worker on every write.
-- form_digest_runs  -- one row per digest per period it was sent for. The
--                      UNIQUE (digest_id, period) is the send lock: the cron
--                      inserts the run row FIRST and only sends when the insert
--                      created it, so two overlapping cron ticks, a retry, or a
--                      redeploy mid-send can never mail a period twice.
--
-- Re-runnable.

create table if not exists public.form_digests (
  id            uuid primary key default gen_random_uuid(),
  form_id       uuid not null references public.forms(id) on delete cascade,
  name          text not null check (length(name) between 1 and 120),
  enabled       boolean not null default true,
  config        jsonb not null,
  last_sent_at  timestamptz,
  last_period   text,
  created_by    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists form_digests_form_idx on public.form_digests (form_id);
create index if not exists form_digests_enabled_idx on public.form_digests (enabled) where enabled;
alter table public.form_digests enable row level security;

create table if not exists public.form_digest_runs (
  id               uuid primary key default gen_random_uuid(),
  digest_id        uuid not null references public.form_digests(id) on delete cascade,
  period           text not null,
  started_at       timestamptz not null default now(),
  finished_at      timestamptz,
  recipients_sent  integer,
  recipients_skipped integer,
  error            text,
  unique (digest_id, period)
);
alter table public.form_digest_runs enable row level security;

comment on table public.form_digests is
  'Scheduled summary emails per form (Digests tab). Written by splash-forms only.';
comment on table public.form_digest_runs is
  'One row per digest per period sent. UNIQUE(digest_id, period) is the send lock -- insert first, send only if inserted.';
