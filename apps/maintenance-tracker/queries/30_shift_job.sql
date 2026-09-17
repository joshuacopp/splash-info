-- The Connecteam shift -> job link, for mt_shift_site.
--
-- READ-ONLY. SELECT only. Never writes to any database.
--
-- WHY THIS EXPORT EXISTS. mt_shift_site answers "which site does this shift
-- CLAIM", and it is derived as shift -> job -> site. Until 2026-09-17 only the
-- last term was stored in Supabase: jobId lived exclusively here, inside
-- raw_json. The refresh therefore tried to maintain mt_shift_site with an
-- update that had no join key, which is a cross join -- it collapsed all 1,723
-- shifts onto a single site and reported success. See
-- supabase/mt-shift-site-repair-02.sql.
--
-- Landing the link in Supabase is what makes a correct, keyed rebuild
-- possible at all. Cheap: one column pair per shift, no JSON beyond the one
-- extract, no join.
--
-- jobId is a UUID with no jobs table in Redshift to resolve it, which is why
-- the site behind it still has to come from mt_connecteam_job_site.
select
  s.id                                          as shift_id,
  json_extract_path_text(s.raw_json,'jobId')    as job_id
from razayya_agent_collector.connecteam_shifts s
where json_extract_path_text(s.raw_json,'jobId') <> ''
order by s.id;
