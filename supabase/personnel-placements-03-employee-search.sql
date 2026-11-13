-- Employee field roster search, ALTER 03 (2026-11-13). PLAN_FORMS_PERSONNEL.md
-- phase 2. APPLIED 2026-11-13 via psql (anon refused; Greenwich list excludes office staff).
--
-- Three functions behind the forms Employee field. They live in SQL rather
-- than as PostgREST filters in the worker because the filters need jsonb
-- containment inside an or(), and a mis-encoded jsonb literal in or() returns
-- FEWER ROWS rather than an error -- see the Brief 173 note in CLAUDE.md.
--
--   employee_roster(group, site, q, limit)  people at one site, or in the 011
--        / 101 office group. A site's list EXCLUDES anyone whose placement
--        says they work at an office / regionally / have left, even when
--        Beekeeper files them at that site (the Greenwich problem).
--   employee_search_anywhere(q, limit)      every current employee; used when
--        nobody at the site matches, so a transfer can still be picked.
--   employee_near_matches(name)             current employees whose name is
--        close to a typed one; the worker refuses a typed name that matches,
--        so typing cannot be used to dodge someone's real org level.
--
-- "Current" = not suspended and touched by the Beekeeper sync in the last two
-- days (the sync never deletes; a stale row is someone who left).
--
-- SECURITY: Postgres grants EXECUTE on new functions to PUBLIC, and these
-- return names and titles, so execute is revoked from everyone but
-- service_role. The view is switched to security_invoker for the same reason
-- (a plain view reads its tables as the view owner, skipping RLS).
--
-- Guarded; safe to re-run.

alter view public.personnel_effective set (security_invoker = true);
revoke all on public.personnel_effective from public, anon, authenticated;

-- Display label for a person's location: "Greenwich (040)", "SMG (011)" ...
create or replace function public.employee_location_label(p_org_unit_ids jsonb, p_works_at text)
returns text
language sql stable
set search_path = public
as $$
  select case
    when p_works_at = 'office_011' then 'SMG (011)'
    when p_works_at = 'office_101' then 'Corporate (101)'
    when p_works_at = 'regional'   then 'Regional'
    else (
      select case bl.kind
               when 'site' then coalesce(bl.name, 'Site') || ' (' || lpad(bl.site_number::text, 3, '0') || ')'
               when 'office_011' then 'SMG (011)'
               when 'office_101' then 'Corporate (101)'
               else bl.name
             end
      from jsonb_array_elements_text(coalesce(p_org_unit_ids, '[]'::jsonb)) ou(id)
      join public.beekeeper_locations bl on bl.org_unit_id = ou.id::uuid
      order by (bl.kind = 'site') desc, bl.site_number
      limit 1
    )
  end
$$;

create or replace function public.employee_roster(
  p_group text,          -- 'site' | 'office_011' | 'office_101'
  p_site  integer,       -- site number when p_group = 'site'
  p_q     text,
  p_limit integer default 10
)
returns table (beekeeper_user_id uuid, display_name text, job_title text, location_label text)
language sql stable
set search_path = public
as $$
  with units as (
    select org_unit_id::text as id
    from public.beekeeper_locations
    where (p_group = 'site' and kind = 'site' and site_number = p_site)
       or (p_group in ('office_011', 'office_101') and kind = p_group)
  ),
  fresh as (select max(synced_at) - interval '2 days' as since from public.beekeeper_users)
  select e.beekeeper_user_id, e.display_name, e.position,
         public.employee_location_label(e.org_unit_ids, e.works_at)
  from public.personnel_effective e, fresh
  where not e.suspended
    and e.synced_at > fresh.since
    and e.works_at <> 'left'
    and e.display_name ilike '%' || replace(replace(coalesce(p_q, ''), '%', ''), '_', '') || '%'
    and (
      (p_group = 'site'
        and e.works_at = 'site'
        and exists (select 1 from units u where e.org_unit_ids ? u.id))
      or (p_group in ('office_011', 'office_101')
        and (e.works_at = p_group
             or (e.works_at = 'site' and exists (select 1 from units u where e.org_unit_ids ? u.id))))
    )
  order by e.display_name
  limit greatest(1, least(coalesce(p_limit, 10), 25))
$$;

create or replace function public.employee_search_anywhere(p_q text, p_limit integer default 5)
returns table (beekeeper_user_id uuid, display_name text, job_title text, location_label text)
language sql stable
set search_path = public
as $$
  with fresh as (select max(synced_at) - interval '2 days' as since from public.beekeeper_users)
  select e.beekeeper_user_id, e.display_name, e.position,
         public.employee_location_label(e.org_unit_ids, e.works_at)
  from public.personnel_effective e, fresh
  where not e.suspended
    and e.synced_at > fresh.since
    and e.works_at <> 'left'
    and length(trim(coalesce(p_q, ''))) >= 3
    and e.display_name ilike '%' || replace(replace(trim(p_q), '%', ''), '_', '') || '%'
  order by e.display_name
  limit greatest(1, least(coalesce(p_limit, 5), 10))
$$;

-- Close = same words in any order ("Smith, Jane" / "jane  smith"), or trigram
-- similarity >= 0.6 ("Jose Cruz" / "Jose Cruzz"). Tuned to catch typos and
-- re-orderings of one person, not to equate two different people.
create or replace function public.employee_near_matches(p_name text)
returns table (beekeeper_user_id uuid, display_name text, job_title text, location_label text, score real)
language sql stable
set search_path = public, extensions
as $$
  with fresh as (select max(synced_at) - interval '2 days' as since from public.beekeeper_users),
  typed as (
    select lower(regexp_replace(trim(coalesce(p_name, '')), '\s+', ' ', 'g')) as n,
           (select string_agg(w, ' ' order by w)
              from regexp_split_to_table(lower(regexp_replace(coalesce(p_name, ''), '[^A-Za-z ]', ' ', 'g')), '\s+') w
              where w <> '') as words
  )
  select e.beekeeper_user_id, e.display_name, e.position,
         public.employee_location_label(e.org_unit_ids, e.works_at),
         similarity(lower(e.display_name), t.n) as score
  from public.personnel_effective e, fresh, typed t
  where not e.suspended
    and e.synced_at > fresh.since
    and e.works_at <> 'left'
    and length(t.n) >= 3
    and (
      similarity(lower(e.display_name), t.n) >= 0.6
      or (select string_agg(w, ' ' order by w)
            from regexp_split_to_table(lower(regexp_replace(e.display_name, '[^A-Za-z ]', ' ', 'g')), '\s+') w
            where w <> '') = t.words
    )
  order by score desc
  limit 3
$$;

revoke all on function public.employee_location_label(jsonb, text) from public, anon, authenticated;
revoke all on function public.employee_roster(text, integer, text, integer) from public, anon, authenticated;
revoke all on function public.employee_search_anywhere(text, integer) from public, anon, authenticated;
revoke all on function public.employee_near_matches(text) from public, anon, authenticated;
grant execute on function public.employee_location_label(jsonb, text) to service_role;
grant execute on function public.employee_roster(text, integer, text, integer) to service_role;
grant execute on function public.employee_search_anywhere(text, integer) to service_role;
grant execute on function public.employee_near_matches(text) to service_role;
