-- APPLIED 2026-11-13 via psql (SUPABASE_DB_URL, --single-transaction).
-- Supply Orders (2026-11-13) -- Kleen-Rite ordering with RM approval.
-- Served by splash-workorders (apps/workorders-worker/src/supply-orders*.ts)
-- and the apps/web pages under /admin/supply-orders.
--
-- Re-running is safe: every statement is IF NOT EXISTS / idempotent.
--
-- WHY: Kleen-Rite has no punchout for us, so orders go by email. GMs used to
-- copy item #, description and quantity off kleen-rite.com into an email to
-- their RM, who forwarded it to sales@kleen-ritecorp.com. Here a GM builds a
-- cart from Kleen-Rite's catalog, the site's RM approves it, and the worker
-- writes the vendor email (reply-to the RM, CC the site).
--
-- LINES ARE SNAPSHOTS. sku / name / price are what the person saw when they
-- added the item; Kleen-Rite can rename or reprice later and the order must
-- still say what was asked for. Prices are Kleen-Rite's PUBLIC prices, an
-- estimate only -- never sent to Kleen-Rite.
--
-- RLS on with no policies, like every table here: service role only.

-- ---------------------------------------------------------------- settings
-- One row per vendor. Keeps the account number and order inbox out of code.
create table if not exists public.supply_order_vendors (
  vendor           text primary key,
  display_name     text not null,
  account_no       text not null,
  order_email      text not null,
  ship_to_company  text not null,
  shipping_method  text not null,
  updated_at       timestamptz not null default now()
);

insert into public.supply_order_vendors (vendor, display_name, account_no, order_email, ship_to_company, shipping_method)
values ('kleen_rite', 'Kleen-Rite', '169231', 'sales@kleen-ritecorp.com', 'Splash Express', 'Ground shipping')
on conflict (vendor) do nothing;

-- ---------------------------------------------------------------- ship-to
-- Optional shipping address when it differs from the physical address in
-- locations.location (Oswego ships to a PMB). Null = use locations.location.
alter table public.locations add column if not exists ship_to_address text;
comment on column public.locations.ship_to_address is
  'Shipping address for vendor orders when it differs from the physical address (locations.location). Null = use location.';

update public.locations
   set ship_to_address = '255 West Seneca Street Oswego NY 13126 PMB 400'
 where site_number = 147 and site = 'Oswego' and ship_to_address is null;

-- ---------------------------------------------------------------- orders
create table if not exists public.supply_orders (
  id                  uuid primary key default gen_random_uuid(),
  ref_no              bigint generated always as identity unique,
  vendor              text not null references public.supply_order_vendors(vendor),
  location_id         bigint not null references public.locations(id),
  site_number         integer,
  site_name           text not null,
  -- {site###}-{YYYYMMDD Eastern}-{initials}, then a 2/3/4 suffix for the
  -- same site, day and initials. Unique so two submits cannot share one.
  po_number           text not null unique,
  status              text not null
                      check (status in ('pending_approval', 'sent', 'denied', 'cancelled')),
  ordered_by_email    text not null,
  orderer_initials    text not null,
  note                text,
  -- Who must approve (site rm_email at submit time). Null when the orderer
  -- needed no approval (RM / RD / admin ordering directly).
  approver_email      text,
  decided_by_email    text,
  decided_at          timestamptz,
  decision_note       text,
  -- The vendor email as written: snapshotted so a later settings / address
  -- change does not rewrite what was sent.
  account_no          text not null,
  ship_to             text not null,
  shipping_method     text not null,
  vendor_email_to     text,
  vendor_email_cc     text[] not null default '{}',
  vendor_reply_to     text,
  sent_at             timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists supply_orders_location_idx on public.supply_orders (location_id, created_at desc);
create index if not exists supply_orders_pending_idx on public.supply_orders (approver_email) where status = 'pending_approval';
create index if not exists supply_orders_orderer_idx on public.supply_orders (ordered_by_email, created_at desc);

create table if not exists public.supply_order_lines (
  id                bigint generated always as identity primary key,
  order_id          uuid not null references public.supply_orders(id) on delete cascade,
  line_no           integer not null,
  sku               text not null,
  name              text not null,
  uom               text,
  qty               integer not null check (qty between 1 and 9999),
  unit_price_cents  integer check (unit_price_cents >= 0),
  product_url       text,
  image_url         text,
  -- 'catalog' = picked from Kleen-Rite's search; 'manual' = typed by hand
  -- (search unavailable, or an item it does not list).
  source            text not null check (source in ('catalog', 'manual')),
  unique (order_id, line_no)
);

create index if not exists supply_order_lines_order_idx on public.supply_order_lines (order_id, line_no);
create index if not exists supply_order_lines_sku_idx on public.supply_order_lines (sku);

-- Timeline: created / edited (approver changed lines) / approved / denied /
-- cancelled / sent / send_failed. details carries before/after for edits.
create table if not exists public.supply_order_events (
  id           bigint generated always as identity primary key,
  order_id     uuid not null references public.supply_orders(id) on delete cascade,
  at           timestamptz not null default now(),
  kind         text not null,
  actor_email  text,
  note         text,
  details      jsonb not null default '{}'::jsonb
);

create index if not exists supply_order_events_order_idx on public.supply_order_events (order_id, at);

alter table public.supply_order_vendors enable row level security;
alter table public.supply_orders enable row level security;
alter table public.supply_order_lines enable row level security;
alter table public.supply_order_events enable row level security;

-- ---------------------------------------------------------------- tool grant
alter table public.user_tool_access drop constraint if exists user_tool_access_tool_check;
alter table public.user_tool_access add constraint user_tool_access_tool_check check (tool = any (array[
  'pricing', 'claims', 'pertrack', 'form_submissions', 'schedule',
  'inventory_view', 'inventory', 'inventory_admin', 'it_issues', 'it_issues_it',
  'supply_orders'
]));
