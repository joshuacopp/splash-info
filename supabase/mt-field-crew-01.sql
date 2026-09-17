-- mt-field-crew-01.sql
--
-- mt_field_crew: the canonical field-mechanic list, and the ONLY thing the
-- mechanic-facing views filter on.
--
-- ===========================================================================
-- WHY, AND THE ASSUMPTION IT REPLACES
-- ===========================================================================
-- mt_device_person is a DEVICE-to-person map. It answers "whose vehicle is
-- this", and it correctly contains anyone with a tracked vehicle whatever
-- their job. Every crew-level surface built on top of it silently treated
-- "has a Geotab vehicle" as "is a field mechanic".
--
-- That held until 2026-09-17, when the operator identified Chris DeClercq --
-- tracked, vehicle b5, sitting in the crew table since the crosswalk was
-- built -- as IT. The assumption then cost three things at once: IT hours in
-- mechanic averages, IT time on site charges, and an IT transponder in the
-- crew's device-health alerts.
--
-- Field crew is now a stated fact (mt_closer_role.role = 'MECHANIC') rather
-- than an inference from owning a device. 12 field mechanics out of 13 tracked
-- people.
--
-- ===========================================================================
-- NOTHING IS DELETED -- THE EXCLUSION IS AT THE REPORTING EDGE
-- ===========================================================================
-- Operator: "Don't get rid of the data though as that may be surfaced
-- separately later."
--
-- mt_device_person, mt_punch, mt_gps_dwell and mt_punch_allocation all still
-- carry every tracked person, IT included. Verified after this change:
-- DeClercq retains 75 punches, 42 dwell intervals and 59 allocation rows, and
-- appears in zero crew-facing views. An IT view later needs no backfill --
-- the history is already there and still accruing on every refresh.
--
-- WHAT IS AND IS NOT FILTERED
--   filtered to field crew   mt_mechanic_week, mt_mechanic_workload,
--                            mt_device_health
--   NOT filtered             mt_punch_allocation and mt_cost_centre_month
--
-- The cost views must keep everyone, because excluding IT from the cost
-- allocation would silently delete their hours from the books rather than
-- moving them. IT time is charged to Management by mt_closer_role.expense_to;
-- the invariant that every cost centre sums to exactly paid hours (4,595)
-- still holds after this change and is the check that nothing fell out.
--
-- To add or remove someone from the crew views, change their role in
-- mt_closer_role. Do not filter by name or device id anywhere else.

create or replace view public.mt_field_crew as
select d.device_id, d.connecteam_user_id, d.maintainx_user_id, d.display_name
from mt_device_person d
join mt_closer_role r on r.maintainx_user_id = d.maintainx_user_id
where r.role = 'MECHANIC';

-- mt_mechanic_week, mt_mechanic_workload and mt_device_health are recreated
-- against mt_field_crew; see mt-rollups-01.sql and
-- mt-site-detail-and-device-health-01.sql for their bodies and reading rules.
-- The only change in each is the join to mt_field_crew in place of
-- mt_device_person.
