-- mt-mechanic-work-orders-01.sql
--
-- APPLIED 2026-10-30 via Supabase MCP. Post-apply check against the created
-- view: 0 mismatches vs mt_mechanic_workload, 364 rows, security_invoker=on,
-- anon/authenticated SELECT denied, service_role allowed.
--
-- mt_mechanic_work_orders: the work orders BEHIND the counts in
-- mt_mechanic_workload. One row per (mechanic, work order). Read-only.
--
-- ===========================================================================
-- THE ONE RULE: LIST LENGTH MUST EQUAL THE COUNT BESIDE IT
-- ===========================================================================
-- This view exists so the Mechanics tab can expand a row of counts into the
-- jobs that make them up. If the list and the number disagree, the drill-down
-- is worse than nothing -- the reader cannot tell which one is wrong. So the
-- predicates below are COPIED from the live mt_mechanic_workload body
-- (pg_get_viewdef, 2026-10-30), not re-derived:
--
--   bucket 'open'    assignee_ids @> [maintainx_user_id]
--                    status in (OPEN, IN_PROGRESS, ON_HOLD)
--   bucket 'closed'  completer_id = maintainx_user_id
--                    completed_at >= now() - 30 days
--   both             type = 'REACTIVE', deleted_at is null,
--                    crew = mt_field_crew (role MECHANIC)
--
-- Change one of these and you must change mt_mechanic_workload in the same
-- breath. Verified at authoring against all 12 crew rows: open_assigned,
-- open_in_progress, open_over_30d, closed_7d and closed_30d all match exactly.
--
-- ===========================================================================
-- "CLOSED" IS THE CLOSER, NOT THE WORKER
-- ===========================================================================
-- Same caveat as mt_site_work_orders.completed_by: completer_id is who pressed
-- Done in MaintainX. A work order closed by someone else does not appear under
-- the mechanic who did it, and one they closed for a colleague does.
--
-- A WORK ORDER WITH TWO ASSIGNEES APPEARS UNDER BOTH, as it does in the
-- workload counts. At authoring: 127 open rows for 110 distinct work orders.
-- Do not count rows of this view to get the backlog.
--
-- ===========================================================================
-- SITE: NULL IS KEPT, AND THE FALLBACK JOIN IS LATERAL ON PURPOSE
-- ===========================================================================
-- Site resolution matches mt_site_work_orders --
-- coalesce(w.site_number, locations.site_number via maintainx_id) -- with two
-- deliberate differences:
--
-- 1. Work orders with NO resolvable site are KEPT with site_number null.
--    mt_site_work_orders drops them, which is right for a per-site list and
--    wrong here: dropping them would make the list shorter than the count.
--    (1 open row at authoring.)
--
-- 2. The locations fallback is a LATERAL min(), not a join. Four maintainx_id
--    values are shared by two locations rows (Bedford Hills 19/19, Bridgeport
--    22/23, Greenwich 40/40, Shelton 68/68). A plain LEFT JOIN multiplies the
--    work order even when coalesce ends up using w.site_number -- which is a
--    LIVE BUG in mt_site_work_orders today: 2,901 rows for 2,808 work orders.
--    Not fixed here; reported separately.
--
-- age_days / days_to_close are TICKET AGE (mx_created_at to now / to
-- completed_at), not work time -- same reading rule as mt_mechanic_workload.

create or replace view public.mt_mechanic_work_orders as
with rows as (
  select c.connecteam_user_id, c.display_name, 'open'::text as bucket,
         w.id, w.sequential_id, w.title, w.priority, w.status, w.site_number,
         w.mx_location_id, w.mx_created_at, w.completed_at
  from mt_field_crew c
  join mx_work_order w on w.assignee_ids @> array[c.maintainx_user_id]
  where w.type = 'REACTIVE'
    and w.deleted_at is null
    and w.status = any (array['OPEN', 'IN_PROGRESS', 'ON_HOLD'])
  union all
  select c.connecteam_user_id, c.display_name, 'closed'::text as bucket,
         w.id, w.sequential_id, w.title, w.priority, w.status, w.site_number,
         w.mx_location_id, w.mx_created_at, w.completed_at
  from mt_field_crew c
  join mx_work_order w on w.completer_id = c.maintainx_user_id
  where w.type = 'REACTIVE'
    and w.deleted_at is null
    and w.completed_at is not null
    and w.completed_at >= now() - interval '30 days'
)
select r.connecteam_user_id,
       r.display_name,
       r.bucket,
       r.id,
       r.sequential_id,
       r.title,
       r.priority,
       r.status,
       coalesce(r.site_number, lx.site_number)                          as site_number,
       sn.site_name,
       r.mx_created_at,
       r.completed_at,
       floor(extract(epoch from (now() - r.mx_created_at)) / 86400)::int as age_days,
       -- open_over_30d's EXACT predicate. Not "age_days > 30": floor() puts a
       -- ticket 30.5 days old at 30, so the highlight and the count disagree.
       (r.bucket = 'open' and r.mx_created_at < now() - interval '30 days')
                                                                        as over_30d,
       round((extract(epoch from (r.completed_at - r.mx_created_at)) / 86400)::numeric, 1)
                                                                        as days_to_close
from rows r
left join lateral (
  select min(l.site_number) as site_number
  from public.locations l
  where l.maintainx_id = r.mx_location_id
) lx on true
left join public.mt_site_name sn on sn.site_number = coalesce(r.site_number, lx.site_number);

-- Same posture as every other mt_* view (anon-view-revoke-03.sql): invoker
-- rights, service role only. apps/web reaches it through workorders-worker.
alter view public.mt_mechanic_work_orders set (security_invoker = on);
revoke select on public.mt_mechanic_work_orders from anon, authenticated;
