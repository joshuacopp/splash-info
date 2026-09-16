-- Every Connecteam shift with its punch coordinates, for Layer A.
--
-- READ-ONLY. SELECT only. Never writes to any database.
--
-- The coordinates are NOT columns -- they are nested inside raw_json under
-- start.locationData / end.locationData, which is why this is a JSON extract
-- rather than a plain select. Redshift's json_extract_path_text works against
-- the varchar column directly; no parsing step is needed.
--
-- source.type matters as much as the coordinates. The distribution is
-- mobile / admin / pc, and admin rows are PTO and manual corrections that will
-- NEVER carry GPS. They must be excluded from the denominator downstream, not
-- scored as failures.
select
  s.id                                                                    as shift_id,
  s.user_id                                                               as connecteam_user_id,
  s.start_utc,
  s.end_utc,
  s.timezone,
  s.duration_minutes,
  json_extract_path_text(s.raw_json,'start','source','type')              as source_type,
  json_extract_path_text(s.raw_json,'start','locationData','latitude')    as in_lat,
  json_extract_path_text(s.raw_json,'start','locationData','longitude')   as in_lon,
  json_extract_path_text(s.raw_json,'end','locationData','latitude')      as out_lat,
  json_extract_path_text(s.raw_json,'end','locationData','longitude')     as out_lon
from razayya_agent_collector.connecteam_shifts s
order by s.user_id, s.start_utc;
