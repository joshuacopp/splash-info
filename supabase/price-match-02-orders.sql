-- Price Match orders (2026-11-14) -- the optional order section on
-- /admin/price-match (splash-workorders src/price-match.ts).
--
-- APPLIED 2026-11-14 via psql. Idempotent.
--
-- A request may now carry one PO per site: "if you can match, process
-- these". The price table is per unit; quantities live only here.
--
-- price_match_requests.orders  -- what the email said, every send (test too).
-- price_match_orders           -- one row per LIVE PO. Exists so PO numbers
--   are reserved: the PO sequence is SHARED with Kleen-Rite orders
--   (supply_orders), and both workers check both tables before using a
--   number. Test sends compute POs but write nothing here, so testing never
--   burns a real PO.

alter table public.price_match_requests
  add column if not exists orders jsonb not null default '[]'::jsonb;

create table if not exists public.price_match_orders (
  id           uuid primary key default gen_random_uuid(),
  request_id   uuid not null,
  created_at   timestamptz not null default now(),
  location_id  bigint not null,
  site_number  integer,
  site_name    text not null,
  po_number    text not null,
  ship_to      text not null,
  lines        jsonb not null
);

-- Same case-insensitive rule as nextPo(): "Jc" and "JC" are one PO.
create unique index if not exists price_match_orders_po_idx on public.price_match_orders (lower(po_number));
create index if not exists price_match_orders_request_idx on public.price_match_orders (request_id);

alter table public.price_match_orders enable row level security;
