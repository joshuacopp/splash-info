-- maintainx-ingest-04-location-aliases
--
-- One physical site can answer to several MaintainX location ids. MaintainX
-- lets a location carry a parentId, and Splash's org uses it in exactly one
-- place: Long Pond/Rochester (site 142) is a parent node (5477553) with two
-- tunnel children, 2150810 "Longpond Tunnel A" and 1187704 "Longpond Tunnel B".
-- `locations.maintainx_id` only ever held Tunnel A, so Tunnel B's work orders
-- -- 43 of them -- landed with a null location_id and a null site_number and
-- were invisible to every join that goes through the locations table. Nothing
-- errored; the rows were simply unmapped.
--
-- Why a column and not a second `locations` row: three sites already have two
-- rows sharing one site_number (19 Bedford Hills, 40 Greenwich, 68 Shelton,
-- split by mla_location), and in all three the pair shares a single
-- maintainx_id. That shared id is what keeps the duplicates invisible. Long
-- Pond's ids differ, so a second row would surface as two entries in the New
-- Request dropdown, two headers in the grouped work-order list, and -- worst
-- -- a nondeterministic first-wins bind at apps/inventory/worker/db.ts:219,
-- which dedupes by site_number on the stated assumption that split sites
-- "share an id in practice".
--
-- Why a column and not an mx_location_alias table: the alias set has to be
-- readable by getLocationsByContactEmail, which is the email-based access
-- filter. Keeping the aliases on the row means that auth-adjacent query gains
-- a column instead of a join. Revisit if aliases ever outgrow a handful.
--
-- maintainx_id stays canonical. Aliases are read-only inputs: nothing is ever
-- written back to MaintainX against an alias id.

alter table public.locations
  add column if not exists maintainx_alias_ids bigint[];

comment on column public.locations.maintainx_alias_ids is
  'Additional MaintainX location ids that resolve to this row (sub-locations, parent nodes, merged-away ids). maintainx_id remains canonical; aliases are never written back to MaintainX.';

update public.locations
   set maintainx_alias_ids = array[1187704, 5477553]::bigint[]
 where site_number = 142;

create index if not exists locations_maintainx_alias_ids_gin
  on public.locations using gin (maintainx_alias_ids);

-- Backfill. Ingest only stamps location_id/site_number when it writes a row,
-- so rows already in the table stay unmapped until MaintainX happens to touch
-- their work order again. This resolves every existing row through the same
-- canonical-plus-alias set the worker now uses. Idempotent: the `is null`
-- guard means re-running it is a no-op, and it never overwrites a stamp.
--
-- Measured effect on first run, 2026-09-13: 344 work orders and 93 work
-- requests stamped -- 299 for site 76 White Plains Central (which had been
-- pointed at a MaintainX id deleted on their side and so had never resolved
-- once in its entire history), 44 for Long Pond's alias ids, 1 for site 234
-- Bayville. What remains unmapped afterwards is only the deleted duplicate
-- Liverpool 145 location and the non-wash nodes (General Storage, Office,
-- Milford IT Office, Warehouse-Bridgeport, Copp Inventory, the org root).
with resolver as (
  select maintainx_id as mx, id as location_id, site_number
    from public.locations where maintainx_id is not null
  union all
  select unnest(maintainx_alias_ids), id, site_number
    from public.locations where maintainx_alias_ids is not null
),
dedup as (
  -- Sites 22/23 Bridgeport and the three Express/Handwash pairs legitimately
  -- share one MaintainX id across two rows. min() picks deterministically
  -- rather than letting the plan decide.
  select mx, min(location_id) as location_id, min(site_number) as site_number
    from resolver group by mx
)
update public.mx_work_order w
   set location_id = d.location_id, site_number = d.site_number
  from dedup d
 where w.mx_location_id = d.mx and w.location_id is null;

with resolver as (
  select maintainx_id as mx, id as location_id, site_number
    from public.locations where maintainx_id is not null
  union all
  select unnest(maintainx_alias_ids), id, site_number
    from public.locations where maintainx_alias_ids is not null
),
dedup as (
  select mx, min(location_id) as location_id, min(site_number) as site_number
    from resolver group by mx
)
update public.mx_work_request r
   set location_id = d.location_id, site_number = d.site_number
  from dedup d
 where r.mx_location_id = d.mx and r.location_id is null;
