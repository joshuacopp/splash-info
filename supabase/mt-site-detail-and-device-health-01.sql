-- mt-site-detail-and-device-health-01.sql
--
-- Three views added after the dashboard went in front of the operator.
-- All read-only; nothing is written.
--
--   mt_site_name          site number -> display name
--   mt_site_work_orders   the reactive work orders behind a site's hours
--   mt_device_health      is a mechanic's transponder still reporting?
--
-- ===========================================================================
-- mt_device_health IS THE IMPORTANT ONE, AND IT CAME FROM A GOOD QUESTION
-- ===========================================================================
-- The operator looked at the dashboard and asked whether any UNREGISTERED
-- transponder was recording miles, because two named mechanics showed nothing.
--
-- No unregistered device is recording miles. Every Geotab device_id in
-- geotab_gps maps to a person in mt_device_person except `bA`, which has
-- exactly ONE ping, on 2025-05-13, and zero miles -- the stray row already
-- recorded in BUILD_STATE as the reason geotab_gps does not really begin in
-- May 2025.
--
-- The actual answer was worse and more useful: both mechanics have thousands
-- of miles of history and THEIR TRANSPONDERS STOPPED.
--
--   b8  Charles Zimmer   last GPS 2026-08-30, punched 17 of the last 21 days
--   b9  Phillip Ritter   last GPS 2026-09-07, punched 19 of the last 21 days
--
-- A DEAD TRANSPONDER IS INDISTINGUISHABLE FROM AN IDLE MECHANIC on every other
-- surface this tracker has. Both show near-zero on-site hours and a large
-- unaccounted figure -- which reads exactly like doing nothing and is in fact
-- a hardware fault. That is the single most damaging way this system could be
-- misread, so it is detected here and rendered above the mechanic table rather
-- than left to be inferred from a no-GPS percentage.
--
-- WHY "SILENT" IS JUDGED ON SEVEN DAYS AND NOT TWENTY-ONE
--   The first version compared GPS days against punch days over 21 days and
--   missed BOTH men: a device that dies mid-window keeps a respectable ratio
--   for a fortnight afterwards. b9 scored 11 GPS days against 19 punch days --
--   "OK" -- while having reported nothing for ten days. Recency is the signal.
--   The ratio only catches a device that is intermittent rather than dead,
--   which is why both rules are kept.
--
-- NOT_WORKING is not a judgement. No punches in 21 days means leave, a changed
-- role, or a departure, and nothing here can tell those apart. It is reported
-- so an empty row is explained rather than mysterious.
--
-- ===========================================================================
-- mt_site_name: NEVER locations.location
-- ===========================================================================
-- Resolution is pricing_simple.location_pretty, then locations.site, then a
-- "Site N" placeholder. locations.location is a POSTAL ADDRESS and rendering
-- it as a site name is the Brief 115 bug. locations.site is kept as the second
-- step rather than dropped because it covers sites pricing_simple has no row
-- for -- site 60, for one.
--
-- ===========================================================================
-- mt_site_work_orders
-- ===========================================================================
-- Site comes from mx_work_order.site_number where MaintainX populated it, and
-- from the mx_location_id -> locations.maintainx_id join otherwise. 11 of
-- 1,086 recent reactive work orders have neither and are EXCLUDED rather than
-- bucketed somewhere wrong: a work order filed against the wrong site is worse
-- than one that is missing, because both are invisible but the first also
-- corrupts another site's list.
--
-- total_cost_cents is CENTS (see the MaintainX money glossary entry), and
-- labor_seconds carries no labour COST -- MaintainX exposes duration, not rate.
--
-- completer_id is populated on 100% of recent reactive work orders and all 56
-- distinct completers resolve against maintainx_users. The integration bot
-- (520201), which accounts for 100 of the first 741 status changes in the
-- event log, closes NONE of them -- so unlike the IN_PROGRESS intervals this
-- column needs no bot exclusion. Re-check that if it ever starts closing work.
--
-- Worth noting from the first look: the two mechanics whose transponders are
-- dead, b8 and b9, are also the two who closed the MOST reactive work orders
-- since August (94 and 78). The GPS silence is a hardware fault, not a
-- activity signal, and this column is the nearest independent evidence of it.

create or replace view public.mt_site_name as
select l.site_number,
       coalesce(nullif(trim(p.location_pretty), ''),
                nullif(trim(l.site), ''),
                'Site ' || l.site_number) as site_name
from public.locations l
left join lateral (
  select pp.location_pretty from pricing_simple pp
   where pp.site = l.site_number::text and pp.location_pretty is not null limit 1
) p on true
where l.site_number is not null;

create or replace view public.mt_site_work_orders as
select date_trunc('month', w.completed_at)::date     as month,
       coalesce(w.site_number, l.site_number)        as site_number,
       w.id, w.sequential_id, w.title, w.priority, w.status, w.completed_at,
       round((w.labor_seconds / 3600.0)::numeric, 1) as labor_h,
       w.total_cost_cents,
       w.completer_id,
       -- MaintainX's own spelling, not mt_device_person's. This column answers
       -- "who pressed Done in MaintainX", so MaintainX's name is the honest
       -- label even where the two differ (Chuck vs Charles, Cinfue vs
       -- Cifuentes). Falls back to the raw id rather than blank: an unresolved
       -- completer means a stale maintainx_users cache, which is worth seeing.
       --
       -- IT IS THE CLOSER, NOT NECESSARILY THE WORKER. One person can close a
       -- job somebody else did, and a supervisor closing out a backlog looks
       -- identical here to a mechanic finishing their own work. Do not read
       -- this column as a productivity count.
       coalesce(u.full_name, 'user ' || w.completer_id::text) as completed_by
from mx_work_order w
left join public.locations l on l.maintainx_id = w.mx_location_id
left join maintainx_users u on u.id = w.completer_id
where w.type = 'REACTIVE'
  and w.deleted_at is null
  and w.completed_at is not null
  and coalesce(w.site_number, l.site_number) is not null;

drop view if exists public.mt_device_health;
create view public.mt_device_health as
with punch as (
  select connecteam_user_id, max(start_utc) last_punch,
         count(distinct (start_utc at time zone 'America/New_York')::date)
           filter (where start_utc >= now() - interval '21 days') punch_days_21d,
         count(distinct (start_utc at time zone 'America/New_York')::date)
           filter (where start_utc >= now() - interval '7 days')  punch_days_7d
  from mt_punch group by 1),
gps as (
  select device_id, max(arrived_at) last_gps,
         count(distinct (arrived_at at time zone 'America/New_York')::date)
           filter (where arrived_at >= now() - interval '21 days') gps_days_21d,
         count(distinct (arrived_at at time zone 'America/New_York')::date)
           filter (where arrived_at >= now() - interval '7 days')  gps_days_7d
  from mt_gps_dwell group by 1)
select d.device_id, d.display_name, d.connecteam_user_id,
       g.last_gps, p.last_punch,
       floor(extract(epoch from (now() - g.last_gps))/86400)::int as days_since_gps,
       coalesce(g.gps_days_21d,0)   as gps_days_21d,
       coalesce(p.punch_days_21d,0) as punch_days_21d,
       case
         when coalesce(p.punch_days_21d,0) = 0 then 'NOT_WORKING'
         when coalesce(p.punch_days_7d,0) > 0 and coalesce(g.gps_days_7d,0) = 0
           then 'TRANSPONDER_SILENT'
         when coalesce(g.gps_days_21d,0) < coalesce(p.punch_days_21d,0) / 2.0
           then 'TRANSPONDER_PATCHY'
         else 'OK'
       end as device_status
from mt_device_person d
left join punch p on p.connecteam_user_id = d.connecteam_user_id
left join gps   g on g.device_id = d.device_id;

-- ===========================================================================
-- mt_closer_role -- ORG KNOWLEDGE THAT EXISTS NOWHERE IN THE DATA
-- ===========================================================================
-- Added 2026-09-17 after the operator read the first version of the site table.
--
-- That version flagged 13 sites as "work happened here, no visit recorded" and
-- invited somebody to go hunting for a tracking fault. Most were nothing of the
-- kind. The operator supplied what no query could:
--
--   Tyler Pianka, Alex Pezzino, Gustavo   IT. They DO drive to sites, but their
--                                         time and travel are overhead and are
--                                         NEVER expensed to a site.
--   Megan Burke, Amanda Regina            Admin on the CMMS, not in the field.
--                                         They close tickets from a desk.
--   Steve Gainer                          Regional manager, not maintenance.
--   "<name> Wash" logins                  Shared per-location accounts; the site
--                                         closing its own ticket.
--
-- So implies_site_visit and expense_to are SEPARATE COLUMNS and must not be
-- collapsed into one. IT is the case that proves it: a site visit genuinely
-- happens, and the cost still belongs to Management. A single "is this site
-- work?" flag would have to be wrong about one or the other.
--
-- Effect on the 16 September sites with work orders and no recorded hours:
-- 10 are a real tracking gap (a MECHANIC closed the ticket, and the usual
-- cause is a dead transponder -- see mt_device_health), and 6 are fully
-- explained by role and are now labelled "no site visit expected" instead of
-- being presented as a problem.
--
-- UNCLASSIFIED is deliberate and must stay visible rather than defaulting to
-- something convenient. It means nobody has said what that person does, and
-- guessing would put hours in the wrong cost centre. Several closers are
-- currently unclassified on purpose (Brett Sullivan, Jacob Petrelle, Nathan
-- May, Roger Williams, Steve Benfante, and the operator's own account) because
-- nobody has said, not because they were overlooked.
--
-- The SITE_ACCOUNT heuristic is narrow on purpose: the name ends in "wash" AND
-- every ticket it has ever closed is at one site. A real person surnamed Wash
-- would fail the second condition.

-- ===========================================================================
-- mt_mechanic_workload -- open and closed counts, and time to close
-- ===========================================================================
-- Added 2026-09-17 on operator request: mechanic hours next to open and closed
-- work orders, plus an average time to close.
--
-- MEDIAN, NOT MEAN, AND THAT IS NOT A DETAIL. Measured across the crew over 30
-- days: mean 8.7 days, median 1.2, p90 18.7. The mean is SEVEN TIMES typical
-- because a thin tail of stale tickets drags it, so "average time to close" as
-- normally computed describes a job nobody actually does. Both are exposed and
-- the median leads.
--
-- The gap between a person's median and their mean IS the interesting number,
-- which is why the mean is kept rather than dropped:
--   Derrick Grauer   median 2.0   mean 26.7   9 tickets open over 30 days
--   Chris DeClercq   median 1.8   mean 17.5   9 open over 30 days
--   Ryan Parry       median 0.9   mean  2.3   5 open over 30 days
-- The first two are not slower at the work; they are carrying old tickets.
-- open_over_30d says the same thing directly and is the column to act on.
--
-- DAYS-TO-CLOSE IS TICKET AGE, NOT WORK TIME. It measures mx_created_at to
-- completed_at, so a two-hour job raised in July and closed in September reads
-- as sixty days. It cannot be read as effort, and MaintainX has no field that
-- can -- labor_seconds is logged on a minority of work orders.
--
-- OPEN COUNTS DOUBLE-COUNT ACROSS PEOPLE, deliberately. assignee_ids is an
-- array and a work order with two assignees is genuinely open for both, so the
-- column is right per person and wrong as a total. Do not sum it to get the
-- backlog; 323 reactive work orders are open and 43 of them have no assignee
-- at all, which no per-person column can show.


-- ===========================================================================
-- 2026-09-17, LATER: the rest of the roster, and a correction
-- ===========================================================================
-- Operator supplied the remaining closers:
--   Brett Sullivan   head of maintenance
--   Jacob Petrelle   IT
--   Roger Williams   IT
--   Nathan May       regional manager
--   Steve Benfante   regional manager
--
-- CORRECTION TO implies_site_visit. It was set TRUE for IT on the reasoning
-- that IT genuinely drives to sites. That conflated two different questions
-- and produced a permanent false alarm, because the column drives the
-- dashboard's "no visit recorded" warning and NONE of these people carry a
-- Geotab vehicle. Their visits can never produce GPS evidence, so flagging
-- those sites as a tracking gap points at a fault nobody can fix, every month,
-- for ever.
--
-- The column now means "do we EXPECT a GPS record of this visit", which is
-- true only for tracked mechanics. That IT travels, and that its cost is
-- overhead, is carried by expense_to and the note. This is the second time
-- these two ideas have had to be pulled apart; they look like one field and
-- are not.
--
-- Brett Sullivan's expense_to is MANAGEMENT as an ASSUMPTION, marked as such
-- in his note: the operator gave his role but not his cost treatment, and
-- every other non-field role here avoids billing to sites. It is currently
-- inert -- he has no tracked vehicle, so no hours flow through it -- but it
-- should be confirmed before it ever matters.
--
-- The SITE_ACCOUNT heuristic was relaxed from "exactly 1 site" to "at most 3".
-- Six shared logins were left unclassified by the stricter rule because a site
-- account occasionally closes a ticket for a neighbouring wash when covering.
-- A real multi-site person has 5-25 sites, so the two populations are far
-- apart and 3 sits comfortably between them.
--
-- Effect on the September sites with work orders and no recorded hours:
-- 17 total, 10 a real tracking gap (a tracked mechanic closed the ticket --
-- mostly the two dead transponders), 7 fully explained by role.
--
-- STILL UNCLASSIFIED, deliberately: the operator's own MaintainX account
-- (Josh Copp, 2 work orders). Nobody has said how it should be treated and it
-- is too small to matter, but it stays visible rather than being quietly
-- filed somewhere convenient.
