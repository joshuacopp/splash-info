-- READ-ONLY. SELECT only.
-- Recover the Connecteam jobId -> Splash site crosswalk from WHERE THE VEHICLE
-- SAT during each shift, not from the punch-out coordinate (which is wherever
-- the mechanic happened to be when he chained one punch into the next).
-- Residence is measured as the SPAN between first and last ping inside a
-- fence, never the ping COUNT: Geotab goes quiet while parked, so a 3-hour
-- stay can be two pings and counting them would rank a drive-past above it.
with sites as (select 19::int sn, 41.228058::float slat, -73.710615::float slon, 100::int rad union all select 21::int sn, 41.428852::float slat, -73.577025::float slon, 250::int rad union all select 22::int sn, 41.188502::float slat, -73.200805::float slon, 150::int rad union all select 23::int sn, 41.188834::float slat, -73.20017::float slon, 150::int rad union all select 30::int sn, 41.529029::float slat, -72.896241::float slon, 100::int rad union all select 32::int sn, 41.036641::float slat, -73.602093::float slon, 150::int rad union all select 40::int sn, 41.016287::float slat, -73.649588::float slon, 150::int rad union all select 49::int sn, 41.088237::float slat, -73.459326::float slon, 100::int rad union all select 50::int sn, 41.148751::float slat, -73.246661::float slon, 100::int rad union all select 51::int sn, 41.366707::float slat, -72.919692::float slon, 100::int rad union all select 53::int sn, 41.081647::float slat, -73.520856::float slon, 100::int rad union all select 57::int sn, 41.462128::float slat, -74.408341::float slon, 100::int rad union all select 60::int sn, 41.336454::float slat, -72.97836::float slon, 200::int rad union all select 65::int sn, 41.123687::float slat, -73.399336::float slon, 100::int rad union all select 68::int sn, 41.295342::float slat, -73.107852::float slon, 100::int rad union all select 70::int sn, 41.138322::float slat, -73.338439::float slon, 100::int rad union all select 73::int sn, 41.476832::float slat, -73.21549::float slon, 200::int rad union all select 74::int sn, 41.296707::float slat, -72.950846::float slon, 100::int rad union all select 75::int sn, 41.033433::float slat, -73.755887::float slon, 100::int rad union all select 76::int sn, 41.033674::float slat, -73.784992::float slon, 150::int rad union all select 77::int sn, 41.041751::float slat, -73.790347::float slon, 100::int rad union all select 80::int sn, 41.209793::float slat, -73.434282::float slon, 100::int rad union all select 82::int sn, 41.600601::float slat, -72.677429::float slon, 100::int rad union all select 83::int sn, 44.698008::float slat, -73.479773::float slon, 100::int rad union all select 84::int sn, 44.475883::float slat, -73.114134::float slon, 100::int rad union all select 85::int sn, 41.281604::float slat, -72.868381::float slon, 100::int rad union all select 86::int sn, 41.517857::float slat, -74.06217::float slon, 100::int rad union all select 88::int sn, 41.423882::float slat, -73.578286::float slon, 100::int rad union all select 89::int sn, 41.312736::float slat, -73.056796::float slon, 100::int rad union all select 90::int sn, 41.244355::float slat, -73.027929::float slon, 100::int rad union all select 91::int sn, 42.164429::float slat, -71.058438::float slon, 150::int rad union all select 92::int sn, 41.565507::float slat, -70.595682::float slon, 150::int rad union all select 95::int sn, 42.122011::float slat, -72.584479::float slon, 100::int rad union all select 121::int sn, 43.010261::float slat, -78.208413::float slon, 100::int rad union all select 122::int sn, 42.146458::float slat, -75.901139::float slon, 100::int rad union all select 123::int sn, 43.202231::float slat, -77.943356::float slon, 100::int rad union all select 124::int sn, 42.87794::float slat, -77.255096::float slon, 200::int rad union all select 125::int sn, 43.154523::float slat, -76.12227::float slon, 100::int rad union all select 126::int sn, 42.574168::float slat, -76.216813::float slon, 100::int rad union all select 127::int sn, 42.130411::float slat, -76.825752::float slon, 100::int rad union all select 131::int sn, 42.995648::float slat, -78.179617::float slon, 100::int rad union all select 132::int sn, 43.045708::float slat, -77.09343::float slon, 100::int rad union all select 133::int sn, 42.906666::float slat, -76.826337::float slon, 180::int rad union all select 134::int sn, 42.086689::float slat, -76.048912::float slon, 100::int rad union all select 135::int sn, 43.975371::float slat, -75.953834::float slon, 100::int rad union all select 137::int sn, 42.96607::float slat, -78.725245::float slon, 250::int rad union all select 138::int sn, 43.129036::float slat, -77.440452::float slon, 100::int rad union all select 139::int sn, 42.857412::float slat, -77.011316::float slon, 100::int rad union all select 140::int sn, 43.198104::float slat, -77.856667::float slon, 100::int rad union all select 141::int sn, 43.132587::float slat, -77.712148::float slon, 100::int rad union all select 142::int sn, 43.213445::float slat, -77.681849::float slon, 100::int rad union all select 143::int sn, 43.182408::float slat, -77.805104::float slon, 100::int rad union all select 144::int sn, 43.179568::float slat, -76.260968::float slon, 100::int rad union all select 145::int sn, 43.147928::float slat, -76.231272::float slon, 100::int rad union all select 146::int sn, 43.119571::float slat, -76.159223::float slon, 150::int rad union all select 147::int sn, 43.460966::float slat, -76.48495::float slon, 250::int rad union all select 148::int sn, 44.039369::float slat, -75.841903::float slon, 100::int rad union all select 149::int sn, 42.789696::float slat, -78.811012::float slon, 250::int rad union all select 150::int sn, 43.029017::float slat, -76.014158::float slon, 100::int rad union all select 151::int sn, 43.086402::float slat, -77.616729::float slon, 100::int rad union all select 156::int sn, 42.124766::float slat, -75.969789::float slon, 100::int rad union all select 157::int sn, 43.006509::float slat, -78.215057::float slon, 200::int rad union all select 159::int sn, 42.949757::float slat, -76.546201::float slon, 100::int rad union all select 160::int sn, 42.975019::float slat, -77.365343::float slon, 100::int rad union all select 182::int sn, 40.774408::float slat, -73.106218::float slon, 100::int rad union all select 183::int sn, 40.838589::float slat, -73.329235::float slon, 250::int rad union all select 184::int sn, 40.681802::float slat, -73.359428::float slon, 150::int rad union all select 185::int sn, 40.700596::float slat, -73.616216::float slon, 100::int rad union all select 186::int sn, 40.847413::float slat, -73.260964::float slon, 100::int rad union all select 187::int sn, 40.838571::float slat, -73.321263::float slon, 100::int rad union all select 191::int sn, 41.514296::float slat, -74.209604::float slon, 100::int rad union all select 196::int sn, 42.650927::float slat, -73.695596::float slon, 100::int rad union all select 197::int sn, 42.699049::float slat, -73.894484::float slon, 150::int rad union all select 221::int sn, 43.582509::float slat, -72.966419::float slon, 100::int rad union all select 222::int sn, 44.416848::float slat, -73.213346::float slon, 150::int rad union all select 231::int sn, 39.807706::float slat, -75.03488::float slon, 100::int rad union all select 232::int sn, 39.93175::float slat, -75.031461::float slon, 150::int rad union all select 233::int sn, 39.938756::float slat, -74.970619::float slon, 250::int rad union all select 234::int sn, 39.91255::float slat, -74.154702::float slon, 150::int rad union all select 241::int sn, 40.026081::float slat, -75.635762::float slon, 300::int rad union all select 251::int sn, 39.652645::float slat, -75.750457::float slon, 150::int rad union all select 252::int sn, 39.764388::float slat, -75.51429::float slon, 300::int rad),
crew as (select 'b1'::varchar dev, 2229900::bigint cid union all select 'b2', 14250258 union all select 'b36B', 12242553 union all select 'b36C', 3146122 union all select 'b36D', 9611831 union all select 'b36E', 2229901 union all select 'b36F', 18805857 union all select 'b4', 8552864 union all select 'b5', 1122039 union all select 'b6', 3324247 union all select 'b7', 13333061 union all select 'b8', 2217732 union all select 'b9', 5855509),
sh as (
  select s.id shift_id,
         nullif(json_extract_path_text(s.raw_json,'jobId'),'') job_id,
         c.dev, s.start_utc, s.end_utc
  from razayya_agent_collector.connecteam_shifts s
  join crew c on c.cid = s.user_id
  where s.end_utc is not null and s.start_utc >= '2026-07-16'
    and datediff(minute, s.start_utc, s.end_utc) between 5 and 1440
),
ping as (
  select sh.shift_id, sh.job_id, si.sn, g.date_time
  from sh
  join razayya_agent_collector.geotab_gps g
    on g.device_id = sh.dev
   and g.date_time >= sh.start_utc and g.date_time <= sh.end_utc
  join sites si
    on abs(g.latitude - si.slat) < 0.006 and abs(g.longitude - si.slon) < 0.008
   and sqrt(power((g.latitude-si.slat)*111320,2)
          + power((g.longitude-si.slon)*111320*cos(radians(g.latitude)),2)) <= si.rad
),
span as (
  select shift_id, job_id, sn,
         datediff(second, min(date_time), max(date_time))/60.0 mins
  from ping group by shift_id, job_id, sn
),
best as (
  select shift_id, job_id, sn, mins from (
    select span.*, row_number() over (partition by shift_id order by mins desc, sn) rk
    from span) z where rk = 1
),
tally as (select job_id, sn, count(*) shifts, sum(mins) tot_min from best group by job_id, sn),
modal as (
  select job_id, sn modal_site, shifts modal_shifts from (
    select tally.*, row_number() over (partition by job_id order by shifts desc, tot_min desc) rk
    from tally) z where rk = 1)
select m.job_id, m.modal_site, m.modal_shifts,
       t.shifts_with_a_site, t.distinct_sites,
       cast(round(100.0*m.modal_shifts/t.shifts_with_a_site) as int) modal_pct
from modal m
join (select job_id, count(*) shifts_with_a_site, count(distinct sn) distinct_sites
      from best group by job_id) t on t.job_id = m.job_id
order by t.shifts_with_a_site desc;
