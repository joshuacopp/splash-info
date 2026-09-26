-- SDS binder index — tables + seeding view. APPLIED 2026-09-25 via the
-- Supabase connector at the operator's instruction. Idempotent (create table if
-- not exists / create or replace view), so re-running is safe.
--
--   public.sds_items                 per-site hazardous chemical list
--   public.sds_lists                 per-site review stamp
--   public.sds_inventory_candidates  view: wash chemicals inventory already knows
--
-- WHY public AND NOT A NEW SCHEMA
--
--   forms-worker reads these over PostgREST, which only serves schemas that are
--   explicitly exposed. action_items lives in public for the same reason. A
--   `safety` schema would have read better and required a Supabase config change
--   to work at all.
--
-- WHY NOT IN THE inventory SCHEMA
--
--   Most of what belongs on an SDS list is not inventory. Inventory tracks WASH
--   chemicals; oil-lube products, cleaning supplies, hydrogen peroxide and fuels
--   are outside it entirely. Filing this under `inventory` would tell the next
--   reader the opposite of the truth.
--
-- product_identifier IS THE LOAD-BEARING COLUMN
--
--   OSHA HazCom 1910.1200(e)(1)(i) wants the list to identify each chemical the
--   way its safety data sheet identifies it. So nothing in the app rewrites,
--   title-cases or shortens this value, and the printed index prints it
--   verbatim. If it disagrees with the sheet in the binder, that disagreement is
--   the finding -- hiding it behind nicer typography would defeat the point.
--
-- REMOVALS ARE SOFT
--
--   is_active = false plus removed_at/removed_by, stamped server-side so a row
--   can never claim it left on a date nobody recorded. The printed index shows
--   ACTIVE rows only -- printing a removed chemical would assert it is on site,
--   the one thing this page must not get wrong -- while the history stays
--   answerable ("what was on site last March?").
--
-- THE PARTIAL UNIQUE INDEX
--
--   (location_code, lower(product_identifier), coalesce(lower(work_area),''))
--   WHERE is_active. Same chemical in two work areas is legitimate and allowed;
--   the same chemical twice in one area is a defect on a compliance record. It
--   is partial so a re-add after removal is not blocked by the row it replaces.
--
-- THE SEEDING VIEW IS A HEAD START, NOT A LIST
--
--   1,127 rows across 81 sites, averaging 14 chemicals a site. The app offers
--   them as a picker and never auto-seeds: the identity has to be checked
--   against the actual sheet, and pre-filling rows that IMPLY somebody checked
--   would be worse than starting empty.
--
--   Join-key note, checked rather than assumed: 77 of the 81 inventory
--   location_codes match pricing_simple.location_code. The four that do not --
--   seneca_falls_iba, liverpool_iba, batavia_veterans_iba, buckley_4s -- are the
--   in-bay / self-serve profit centres the inventory overlay exists for. They
--   have no pricing_simple row, so they are not reachable by email-on-locations
--   either; the picker simply returns nothing for them rather than mismatching.
--
-- RLS is enabled with ZERO policies on both tables, which IS the lockdown here
-- (the service key bypasses it). Same posture as every other table in this repo.
--
-- Verified after apply: both tables present, rls_on = true, 0 policies, 16 and 4
-- columns, 3 and 1 indexes, view returning 1,127 rows across 81 sites.

create table if not exists public.sds_items (
  id                 uuid primary key default gen_random_uuid(),
  location_code      text not null,
  binder_tab         text,
  product_identifier text not null,
  manufacturer       text,
  work_area          text,
  source_product_id  uuid references inventory.products(id) on delete set null,
  sort_order         integer not null default 0,
  notes              text,
  is_active          boolean not null default true,
  removed_at         timestamptz,
  removed_by         text,
  created_at         timestamptz not null default now(),
  created_by         text,
  updated_at         timestamptz not null default now(),
  updated_by         text,
  constraint sds_items_identifier_not_blank check (length(btrim(product_identifier)) > 0),
  constraint sds_items_removed_consistent check ((is_active and removed_at is null) or (not is_active and removed_at is not null))
);

create index if not exists sds_items_location_active_idx
  on public.sds_items (location_code, is_active, sort_order);

create unique index if not exists sds_items_no_active_duplicate_idx
  on public.sds_items (location_code, lower(btrim(product_identifier)), coalesce(lower(btrim(work_area)), ''))
  where is_active;

create table if not exists public.sds_lists (
  location_code    text primary key,
  last_reviewed_at timestamptz,
  last_reviewed_by text,
  created_at       timestamptz not null default now()
);

alter table public.sds_items enable row level security;
alter table public.sds_lists enable row level security;

create or replace view public.sds_inventory_candidates as
select lp.location_code,
       p.id   as product_id,
       p.name as product_name,
       p.description
from inventory.location_products lp
join inventory.products p on p.id = lp.product_id;

-- (Column and table COMMENTs were applied with the original statement; they are
-- not repeated here. See the tables in Supabase for the authoritative text.)

-- ---------------------------------------------------------------------------
-- Stored safety data sheets. APPLIED 2026-09-26 via the connector.
--
--   sds_r2_key / sds_filename / sds_size_bytes / sds_uploaded_at /
--   sds_uploaded_by  -- the sheet itself, in FORMS_FILES at
--                       sds-sheets/{location_code}/{item_id}.pdf
--   source_url        -- where it came from. PROVENANCE ONLY.
--   sds_revision_date -- the date printed ON the sheet, not the upload date.
--
-- STORED, NOT LINKED, and the reasoning is the whole decision:
--
--   * A link is not a document. OSHA wants sheets readily accessible to
--     employees in their work area during each work shift; a manufacturer URL
--     depends on their site being up and still organised the same way. That is
--     a dependency on somebody else's website for an artifact we are
--     accountable for.
--   * Link rot is silent. Nobody discovers a dead SDS link until they need the
--     sheet, which is during a spill or an inspection.
--   * Version drift is invisible. If the manufacturer revises, a link and the
--     paper in the binder disagree and nothing says so. A stored copy plus
--     sds_revision_date makes "is this current?" answerable.
--   * Printing the binder needs the bytes.
--
-- The URL is still worth keeping: it is how someone re-checks for a newer
-- revision later without hunting for the page again.
--
-- PDF only, sniffed from the bytes at upload (a client Content-Type is a claim,
-- not evidence). The R2 key is DERIVED from the row, never supplied, so a
-- caller cannot write outside their own site's namespace by posting a path.
-- Re-upload overwrites: a revised sheet replaces the old one, because keeping
-- both would leave two answers to "which sheet is in the binder".
--
-- Verified after apply: all 7 columns present.
-- ---------------------------------------------------------------------------

alter table public.sds_items
  add column if not exists sds_r2_key        text,
  add column if not exists sds_filename      text,
  add column if not exists sds_size_bytes    integer,
  add column if not exists sds_uploaded_at   timestamptz,
  add column if not exists sds_uploaded_by   text,
  add column if not exists source_url        text,
  add column if not exists sds_revision_date date;
