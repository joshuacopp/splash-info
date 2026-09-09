-- car_counts daily load for 2026-09-01
-- note tag: '2026-09-01 daily'
--
-- car_counts has NO unique constraint, so ON CONFLICT is unavailable.
-- The DELETE makes a re-run of this same day idempotent.
--
-- WARNING: sumCarsInWindow() apportions every row across its date
-- range. If a monthly row covering this month still exists, these
-- daily rows will double-count. Check before applying:
--   SELECT * FROM car_counts
--    WHERE start_date <= '2026-09-01' AND end_date >= '2026-09-01';
--
-- Apply with one statement per --command:
--   npx wrangler d1 execute splash-damage-claims --remote --command "..."

DELETE FROM car_counts WHERE note = '2026-09-01 daily';

INSERT INTO car_counts (location_code, start_date, end_date, cars, note) VALUES
  ('auburn','2026-09-01','2026-09-01',346,'2026-09-01 daily'),
  ('batavia_ii','2026-09-01','2026-09-01',473,'2026-09-01 daily'),
  ('batavia_liberty','2026-09-01','2026-09-01',194,'2026-09-01 daily'),
  ('batavia_veterans','2026-09-01','2026-09-01',325,'2026-09-01 daily'),
  ('bedford','2026-09-01','2026-09-01',63,'2026-09-01 daily'),
  ('binghamton','2026-09-01','2026-09-01',142,'2026-09-01 daily'),
  ('blackwood','2026-09-01','2026-09-01',118,'2026-09-01 daily'),
  ('bohemia','2026-09-01','2026-09-01',78,'2026-09-01 daily'),
  ('brewster','2026-09-01','2026-09-01',0,'2026-09-01 daily'),
  ('bridgeport','2026-09-01','2026-09-01',73,'2026-09-01 daily'),
  ('brockport_ii','2026-09-01','2026-09-01',298,'2026-09-01 daily'),
  ('canandaigua','2026-09-01','2026-09-01',162,'2026-09-01 daily'),
  ('cherry_hill','2026-09-01','2026-09-01',107,'2026-09-01 daily'),
  ('cheshire','2026-09-01','2026-09-01',12,'2026-09-01 daily'),
  ('chili','2026-09-01','2026-09-01',351,'2026-09-01 daily'),
  ('cicero','2026-09-01','2026-09-01',207,'2026-09-01 daily'),
  ('clay','2026-09-01','2026-09-01',474,'2026-09-01 daily'),
  ('commack','2026-09-01','2026-09-01',6,'2026-09-01 daily'),
  ('cortland','2026-09-01','2026-09-01',273,'2026-09-01 daily'),
  ('coscob','2026-09-01','2026-09-01',8,'2026-09-01 daily'),
  ('cromwell','2026-09-01','2026-09-01',11,'2026-09-01 daily'),
  ('darien','2026-09-01','2026-09-01',9,'2026-09-01 daily'),
  ('derby','2026-09-01','2026-09-01',103,'2026-09-01 daily'),
  ('easthaven','2026-09-01','2026-09-01',121,'2026-09-01 daily'),
  ('eastnorthport','2026-09-01','2026-09-01',5,'2026-09-01 daily'),
  ('elmira_heights','2026-09-01','2026-09-01',211,'2026-09-01 daily'),
  ('exton','2026-09-01','2026-09-01',83,'2026-09-01 daily'),
  ('fairfield','2026-09-01','2026-09-01',22,'2026-09-01 daily'),
  ('fairport','2026-09-01','2026-09-01',267,'2026-09-01 daily'),
  ('falmouth','2026-09-01','2026-09-01',47,'2026-09-01 daily'),
  ('farmington','2026-09-01','2026-09-01',194,'2026-09-01 daily'),
  ('fayetteville','2026-09-01','2026-09-01',467,'2026-09-01 daily'),
  ('geneva_ii','2026-09-01','2026-09-01',500,'2026-09-01 daily'),
  ('greenwich','2026-09-01','2026-09-01',56,'2026-09-01 daily'),
  ('guilderland','2026-09-01','2026-09-01',55,'2026-09-01 daily'),
  ('hamburg','2026-09-01','2026-09-01',168,'2026-09-01 daily'),
  ('hamden','2026-09-01','2026-09-01',27,'2026-09-01 daily'),
  ('hempstead','2026-09-01','2026-09-01',2,'2026-09-01 daily'),
  ('henrietta','2026-09-01','2026-09-01',317,'2026-09-01 daily'),
  ('johnson_city','2026-09-01','2026-09-01',221,'2026-09-01 daily'),
  ('leray','2026-09-01','2026-09-01',310,'2026-09-01 daily'),
  ('lindenhurst','2026-09-01','2026-09-01',19,'2026-09-01 daily'),
  ('liverpool','2026-09-01','2026-09-01',246,'2026-09-01 daily'),
  ('maple_shade','2026-09-01','2026-09-01',68,'2026-09-01 daily'),
  ('middletown','2026-09-01','2026-09-01',494,'2026-09-01 daily'),
  ('milford','2026-09-01','2026-09-01',190,'2026-09-01 daily'),
  ('montogomery','2026-09-01','2026-09-01',165,'2026-09-01 daily'),
  ('newark','2026-09-01','2026-09-01',276,'2026-09-01 daily'),
  ('newark_ii','2026-09-01','2026-09-01',79,'2026-09-01 daily'),
  ('newburgh','2026-09-01','2026-09-01',117,'2026-09-01 daily'),
  ('newhaven','2026-09-01','2026-09-01',15,'2026-09-01 daily'),
  ('northport','2026-09-01','2026-09-01',76,'2026-09-01 daily'),
  ('norwalk','2026-09-01','2026-09-01',49,'2026-09-01 daily'),
  ('oswego','2026-09-01','2026-09-01',401,'2026-09-01 daily'),
  ('plattsburgh','2026-09-01','2026-09-01',473,'2026-09-01 daily'),
  ('randolph','2026-09-01','2026-09-01',84,'2026-09-01 daily'),
  ('rensselear','2026-09-01','2026-09-01',51,'2026-09-01 daily'),
  ('rochester','2026-09-01','2026-09-01',384,'2026-09-01 daily'),
  ('rutland','2026-09-01','2026-09-01',198,'2026-09-01 daily'),
  ('seneca_falls','2026-09-01','2026-09-01',498,'2026-09-01 daily'),
  ('shelburne','2026-09-01','2026-09-01',365,'2026-09-01 daily'),
  ('shelton','2026-09-01','2026-09-01',2,'2026-09-01 daily'),
  ('southeast','2026-09-01','2026-09-01',30,'2026-09-01 daily'),
  ('spencerport','2026-09-01','2026-09-01',416,'2026-09-01 daily'),
  ('springfield','2026-09-01','2026-09-01',29,'2026-09-01 daily'),
  ('stamford','2026-09-01','2026-09-01',1,'2026-09-01 daily'),
  ('tarrytown','2026-09-01','2026-09-01',289,'2026-09-01 daily'),
  ('vestal','2026-09-01','2026-09-01',161,'2026-09-01 daily'),
  ('watertown','2026-09-01','2026-09-01',218,'2026-09-01 daily'),
  ('westhaven','2026-09-01','2026-09-01',56,'2026-09-01 daily'),
  ('westport','2026-09-01','2026-09-01',60,'2026-09-01 daily'),
  ('whiteplainscentral','2026-09-01','2026-09-01',14,'2026-09-01 daily'),
  ('whiteplainskensico','2026-09-01','2026-09-01',7,'2026-09-01 daily'),
  ('williamsville','2026-09-01','2026-09-01',348,'2026-09-01 daily'),
  ('williston','2026-09-01','2026-09-01',313,'2026-09-01 daily'),
  ('wilmington','2026-09-01','2026-09-01',45,'2026-09-01 daily'),
  ('wilton','2026-09-01','2026-09-01',43,'2026-09-01 daily');

-- 77 rows, 13,186 cars total

-- Totals by winning source:
--   DRB: 106
--   ICS: 783
--   splashdb: 11,777
--   spot_ai: 520

-- Sites with more than one contributing row:
--   bedford: Splash Bedford Express-019=54 (splashdb) + Splash Bedford Handwash & Lube-019=9 (splashdb)
--   greenwich: Splash Greenwich Express-040=53 (splashdb) + Splash Greenwich Handwash-040=3 (splashdb)
--   shelton: Splash Shelton Express-068=2 (splashdb) + Splash Shelton Handwash-068=0 (splashdb)

-- Deliberately not inserted:
--   Corporate -- ICS non-store
--   Online Portal -- not a store
--   Splash Bridgeport Lube-023 -- site 023 has no location_code
--   Splash Brighton-155 -- site 155 not in pricing_simple
--   Splash Management-011 -- not a store
--   Splash Nanuet-087 -- site 087 not in pricing_simple
--   Splash Port Jefferson-188 -- site 188 not in pricing_simple
--   Splash USA Car Wash Bronx-096 -- site 096 has no location_code
--   Splash24 Brockport-123 -- blank splashdb
