-- Price Match (2026-11-14) -- history of NCS price-match request emails sent
-- from /admin/price-match (splash-workorders src/price-match.ts).
--
-- APPLIED 2026-11-14 via psql. Idempotent.
--
-- The email itself lives on outbound_emails (source_kind 'price-match',
-- source_id = this row's id). Attachments are copied to the
-- splash-workorder-files R2 bucket under price-match/{id}/ for the record;
-- files[].r2_key is null when that copy failed (the email still went).

create table if not exists public.price_match_requests (
  id                 uuid primary key,
  ref_no             bigint generated always as identity unique,
  created_at         timestamptz not null default now(),
  created_by_email   text not null,
  competitor         text not null,
  note               text,
  lines              jsonb not null,
  files              jsonb not null default '[]'::jsonb,
  sent_to            text not null,
  sent_cc            text[] not null default '{}',
  test               boolean not null,
  outbound_email_id  uuid
);

create index if not exists price_match_requests_created_idx on public.price_match_requests (created_at desc);

alter table public.price_match_requests enable row level security;

-- The new tool grant. Same list as VALID_TOOLS in packages/types/src/auth.ts.
alter table public.user_tool_access drop constraint if exists user_tool_access_tool_check;
alter table public.user_tool_access add constraint user_tool_access_tool_check check (tool = any (array[
  'pricing', 'claims', 'pertrack', 'form_submissions', 'schedule', 'inventory_view', 'inventory',
  'inventory_admin', 'it_issues', 'it_issues_it', 'supply_orders', 'price_match'
]::text[]));

-- Operator only, for now.
insert into public.user_tool_access (user_id, tool, notes)
select id, 'price_match', 'Price Match launch 2026-11-14'
from auth.users where email = 'josh.copp@splashcarwashes.com'
on conflict do nothing;
