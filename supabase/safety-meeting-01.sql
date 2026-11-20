-- Monthly required topics (2026-11-18, Monthly Safety Meeting).
--
-- The safety committee sets, per month, the topics every site must cover at
-- its monthly safety meeting (/admin/safety-topics). The form's
-- `required_topics` field shows the list for the month of the meeting date and
-- every topic must be ticked as covered. No row, or an empty list, means no
-- mandatory topics that month.
--
-- Written ONLY by splash-forms (service key): src/required-topics/. RLS on with
-- zero policies, like every other forms table.
--
-- Re-runnable.

create table if not exists public.form_required_topics (
  list_key          text        not null check (list_key ~ '^[a-z][a-z0-9_]*$'),
  month             date        not null check (extract(day from month) = 1),
  topics            text[]      not null default '{}',
  updated_by        uuid        null references auth.users(id) on delete set null,
  updated_by_email  text        null,
  updated_at        timestamptz not null default now(),
  primary key (list_key, month)
);

alter table public.form_required_topics enable row level security;

comment on table public.form_required_topics is
  'Committee-set topics per month (list_key e.g. safety_meeting; month = first of the month). Read by the forms required_topics field; edited at /admin/safety-topics by admin tier or the list''s form_access_grants tag (safety_committee).';
