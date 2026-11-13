-- Personnel placements, ALTER 01 (2026-11-13). Phase 1 of PLAN_FORMS_PERSONNEL.md.
--
-- Three small editable tables and one view that answer, for any Beekeeper
-- employee: what org level are they (1-8), what department, and where do they
-- actually work. Nothing reads them yet; Phase 2 (employee picker) and Phase 3
-- (confidential forms) will.
--
--   personnel_title_levels  Beekeeper job title -> default level. Covers the
--                           ~1,500 ordinary site staff, who have no placement.
--   personnel_placements    Per-person override: level, department, works_at.
--                           Seeded from the operator's spreadsheet by a LOCAL
--                           script; that data is NOT in the repo (it names
--                           employees and their levels).
--   beekeeper_locations     Beekeeper location (API name: org unit) -> Splash
--                           site number, or one of the two management groups
--                           (011 SMG, 101 Grubka-area management).
--   personnel_effective     The answer: placement, else title, else level 7.
--
-- LEVELS: 8 board, 7 executive, 6 department head, 5 director / regional lead,
-- 4 regional or corporate staff, 3 site manager, 2 assistant manager, 1 site
-- staff. A level grants NOTHING by itself; it only decides who sits above
-- whom. Unknown people resolve to 7, the safe direction: their records are
-- then readable only by executives and HR leadership.
--
-- WHY BEEKEEPER LOCATION IS NOT ENOUGH: office staff are routinely filed at a
-- site in Beekeeper (the head of CRD, an HR admin and the CMMS admin all sit in
-- Greenwich). works_at on a placement overrides the Beekeeper location.
--
-- RLS on, no policies: service-key access only, like every table here.
-- Guarded; safe to re-run. APPLIED 2026-11-13 via psql (47 locations matched after the \y fix,
-- 37 left unknown; placements seeded locally with 122 rows).

-- ---------------------------------------------------------------- title levels
create table if not exists public.personnel_title_levels (
  position    text primary key,
  level       smallint not null check (level between 1 and 8),
  updated_at  timestamptz not null default now(),
  updated_by  text
);
alter table public.personnel_title_levels enable row level security;
comment on table public.personnel_title_levels is
  'Default org level for a Beekeeper job title (beekeeper_users.position). Only clear site titles are listed; anything else falls through to personnel_placements or level 7.';

insert into public.personnel_title_levels (position, level) values
  ('General Manager', 3), ('Lube Manager', 3), ('5* Manager', 3),
  ('Retail Manager', 3), ('Manager', 3),
  ('Assistant General Manager', 2), ('Lube Assistant Manager', 2),
  ('Manager in Training', 2),
  ('Laborers and Helpers', 1), ('Customer Service Advisor', 1),
  ('Production', 1), ('Full Service Production', 1), ('Express Production', 1),
  ('Service Workers', 1), ('Retail Associate', 1), ('Quality Control', 1),
  ('Lube Service Technician', 1), ('Lube Mechanics', 1), ('Detailer', 1),
  ('Operatives', 1), ('Sales Workers', 1), ('Prepper', 1), ('Top Tech', 1)
on conflict (position) do nothing;

-- ------------------------------------------------------------------ placements
create table if not exists public.personnel_placements (
  beekeeper_user_id  uuid primary key,
  level              smallint check (level between 1 and 8),
  department         text check (department in (
                       'Executive','HR','Finance','CRD','IT','Maintenance',
                       'Marketing','Retail','Incidents','Legal',
                       'Site Operations','Other')),
  works_at           text check (works_at in (
                       'site','office_011','office_101','regional','left')),
  notes              text,
  updated_at         timestamptz not null default now(),
  updated_by         text
);
alter table public.personnel_placements enable row level security;
comment on table public.personnel_placements is
  'Per-person org placement. Overrides the title default. No FK to beekeeper_users on purpose: a row should survive the person leaving and coming back.';
comment on column public.personnel_placements.works_at is
  'site = their Beekeeper location is right; office_011 / office_101 = management group regardless of Beekeeper location; regional = covers several sites; left = not an employee. NULL = use Beekeeper location.';

-- ----------------------------------------------------------- beekeeper locations
create table if not exists public.beekeeper_locations (
  org_unit_id  uuid primary key,
  name         text,
  kind         text not null default 'unknown'
                 check (kind in ('site','office_011','office_101','other','unknown')),
  site_number  integer,
  matched_by   text check (matched_by in ('schedule_number','site_name','gm_name','manual')),
  updated_at   timestamptz not null default now(),
  updated_by   text,
  check (kind <> 'site' or site_number is not null)
);
alter table public.beekeeper_locations enable row level security;
create index if not exists beekeeper_locations_site_idx
  on public.beekeeper_locations (site_number) where site_number is not null;
comment on table public.beekeeper_locations is
  'Beekeeper location (org unit) -> Splash site. Beekeeper carries no site number, so this is matched from schedule names / GM names and finished by hand. New locations are inserted as unknown by the beekeeper-worker sync.';

-- Every location anyone belongs to.
insert into public.beekeeper_locations (org_unit_id)
select distinct (jsonb_array_elements_text(org_unit_ids))::uuid
from public.beekeeper_users
on conflict (org_unit_id) do nothing;

-- Names from shift schedules ("Cortland - 126 Schedule" -> "Cortland - 126").
update public.beekeeper_locations bl
set name = s.name
from (
  select l.ou::uuid ou,
         min(trim(regexp_replace(s.name, '\s*schedules?\y.*$', '', 'i'))) name
  from public.beekeeper_schedules s
  cross join lateral jsonb_array_elements_text(s.location_ids) l(ou)
  where s.name !~* '^testing$'
  group by 1
) s
where bl.org_unit_id = s.ou and bl.name is null;

-- POSTGRES REGEX: word boundary is \y, NOT \b (\b is a backspace). The first
-- apply used \b, so " Schedule" was never stripped and step 2 below matched
-- nothing it should have. This repairs names written that way.
update public.beekeeper_locations
set name = trim(regexp_replace(name, '\s*schedules?\y.*$', '', 'i'))
where matched_by is null and name ~* 'schedules?\y';

-- 1) A real site number in the schedule name.
update public.beekeeper_locations bl
set kind = 'site', site_number = m.num, matched_by = 'schedule_number'
from (
  select l.ou::uuid ou, min((regexp_match(s.name, '(\d{3})'))[1]::int) num
  from public.beekeeper_schedules s
  cross join lateral jsonb_array_elements_text(s.location_ids) l(ou)
  where s.name ~ '\d{3}'
  group by 1
) m
where bl.org_unit_id = m.ou and bl.kind = 'unknown'
  and exists (select 1 from public.locations x where x.site_number = m.num);

-- 2) Location name equals a site name ("Hamden", "Guilderland").
update public.beekeeper_locations bl
set kind = 'site', site_number = x.site_number, matched_by = 'site_name'
from (select distinct on (lower(trim(site))) site, site_number
      from public.locations order by lower(trim(site)), site_number) x
where bl.kind = 'unknown' and bl.name is not null
  and lower(regexp_replace(x.site, '[*]', '', 'g'))
      = lower(regexp_replace(bl.name, '\s+(wash|splash car wash|work)$', '', 'i'));

-- 3) A GM in the location whose name is that site's locations.gm.
update public.beekeeper_locations bl
set kind = 'site', site_number = g.site_number, matched_by = 'gm_name'
from (
  select l.ou::uuid ou, min(x.site_number) site_number
  from public.beekeeper_users b
  cross join lateral jsonb_array_elements_text(b.org_unit_ids) l(ou)
  join public.locations x
    on lower(regexp_replace(trim(x.gm), '\s+', ' ', 'g'))
     = lower(regexp_replace(trim(b.display_name), '\s+', ' ', 'g'))
  where x.gm is not null and b.position = 'General Manager'
  group by 1
) g
where bl.org_unit_id = g.ou and bl.kind = 'unknown';

-- Known by hand (operator, 2026-11-13).
update public.beekeeper_locations set kind = 'office_011', site_number = null,
  name = coalesce(name, 'SMG (011)'), matched_by = 'manual'
where org_unit_id = 'be7b1bd4-8cc7-4248-8b55-6a78009289ab' and matched_by is distinct from 'manual';
update public.beekeeper_locations set kind = 'office_101', site_number = null,
  name = coalesce(name, 'CC-Manage (101)'), matched_by = 'manual'
where org_unit_id = 'fad4fa0b-e8e6-4764-a64e-bb72d226f2bf' and matched_by is distinct from 'manual';
update public.beekeeper_locations set kind = 'site', site_number = 40,
  name = coalesce(name, 'Greenwich'), matched_by = 'manual'
where org_unit_id = '3572a94d-ac6c-442b-a83b-bffac3e8d73f' and matched_by is distinct from 'manual';

-- ------------------------------------------------------------------- the answer
create or replace view public.personnel_effective as
select
  u.id                                        as beekeeper_user_id,
  u.display_name,
  u.position,
  coalesce(u.suspended, false)                as suspended,
  coalesce(p.level, t.level, 7)               as level,
  case when p.level is not null then 'placement'
       when t.level is not null then 'title'
       else 'default' end                     as level_source,
  p.department,
  coalesce(p.works_at, 'site')                as works_at,
  u.org_unit_ids,
  u.synced_at   -- the sync never deletes; stale synced_at = left the company
from public.beekeeper_users u
left join public.personnel_placements  p on p.beekeeper_user_id = u.id
left join public.personnel_title_levels t on t.position = u.position;
comment on view public.personnel_effective is
  'Effective placement per Beekeeper user: placement level, else title level, else 7. works_at defaults to site (= trust the Beekeeper location).';

-- Locations still to name by hand, with a hint of who is in each:
--
--   select bl.org_unit_id, count(*) people,
--          string_agg(b.display_name, ', ') filter (where b.position = 'General Manager') gms
--   from public.beekeeper_locations bl
--   join public.beekeeper_users b on b.org_unit_ids ? bl.org_unit_id::text
--   where bl.kind = 'unknown' and coalesce(b.suspended, false) = false
--   group by 1 order by 2 desc;
