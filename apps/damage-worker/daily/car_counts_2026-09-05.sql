-- car_counts daily load for 2026-09-05
-- note tag: '2026-09-05 daily'
--
-- car_counts has NO unique constraint, so ON CONFLICT is unavailable.
-- The DELETE makes a re-run of this same day idempotent.
--
-- WARNING: sumCarsInWindow() apportions every row across its date
-- range. If a monthly row covering this month still exists, these
-- daily rows will double-count. Check before applying:
--   SELECT * FROM car_counts
--    WHERE start_date <= '2026-09-05' AND end_date >= '2026-09-05';
--
-- Apply with one statement per --command:
--   npx wrangler d1 execute splash-damage-claims --remote --command "..."

DELETE FROM car_counts WHERE note = '2026-09-05 daily';

INSERT INTO car_counts (location_code, start_date, end_date, cars, note) VALUES
  ('auburn','2026-09-05','2026-09-05',375,'2026-09-05 daily'),
  ('batavia_ii','2026-09-05','2026-09-05',462,'2026-09-05 daily'),
  ('batavia_liberty','2026-09-05','2026-09-05',168,'2026-09-05 daily'),
  ('batavia_veterans','2026-09-05','2026-09-05',367,'2026-09-05 daily'),
  ('bedford','2026-09-05','2026-09-05',528,'2026-09-05 daily'),
  ('binghamton','2026-09-05','2026-09-05',291,'2026-09-05 daily'),
  ('blackwood','2026-09-05','2026-09-05',218,'2026-09-05 daily'),
  ('bohemia','2026-09-05','2026-09-05',627,'2026-09-05 daily'),
  ('brewster','2026-09-05','2026-09-05',161,'2026-09-05 daily'),
  ('bridgeport','2026-09-05','2026-09-05',298,'2026-09-05 daily'),
  ('brockport_ii','2026-09-05','2026-09-05',382,'2026-09-05 daily'),
  ('canandaigua','2026-09-05','2026-09-05',232,'2026-09-05 daily'),
  ('cherry_hill','2026-09-05','2026-09-05',220,'2026-09-05 daily'),
  ('cheshire','2026-09-05','2026-09-05',206,'2026-09-05 daily'),
  ('chili','2026-09-05','2026-09-05',350,'2026-09-05 daily'),
  ('cicero','2026-09-05','2026-09-05',304,'2026-09-05 daily'),
  ('clay','2026-09-05','2026-09-05',609,'2026-09-05 daily'),
  ('commack','2026-09-05','2026-09-05',334,'2026-09-05 daily'),
  ('cortland','2026-09-05','2026-09-05',331,'2026-09-05 daily'),
  ('coscob','2026-09-05','2026-09-05',260,'2026-09-05 daily'),
  ('cromwell','2026-09-05','2026-09-05',176,'2026-09-05 daily'),
  ('darien','2026-09-05','2026-09-05',264,'2026-09-05 daily'),
  ('derby','2026-09-05','2026-09-05',608,'2026-09-05 daily'),
  ('easthaven','2026-09-05','2026-09-05',806,'2026-09-05 daily'),
  ('eastnorthport','2026-09-05','2026-09-05',568,'2026-09-05 daily'),
  ('elmira_heights','2026-09-05','2026-09-05',301,'2026-09-05 daily'),
  ('exton','2026-09-05','2026-09-05',160,'2026-09-05 daily'),
  ('fairfield','2026-09-05','2026-09-05',271,'2026-09-05 daily'),
  ('fairport','2026-09-05','2026-09-05',319,'2026-09-05 daily'),
  ('falmouth','2026-09-05','2026-09-05',301,'2026-09-05 daily'),
  ('farmington','2026-09-05','2026-09-05',236,'2026-09-05 daily'),
  ('fayetteville','2026-09-05','2026-09-05',539,'2026-09-05 daily'),
  ('geneva_ii','2026-09-05','2026-09-05',543,'2026-09-05 daily'),
  ('greenwich','2026-09-05','2026-09-05',731,'2026-09-05 daily'),
  ('guilderland','2026-09-05','2026-09-05',674,'2026-09-05 daily'),
  ('hamburg','2026-09-05','2026-09-05',243,'2026-09-05 daily'),
  ('hamden','2026-09-05','2026-09-05',350,'2026-09-05 daily'),
  ('hempstead','2026-09-05','2026-09-05',417,'2026-09-05 daily'),
  ('henrietta','2026-09-05','2026-09-05',364,'2026-09-05 daily'),
  ('johnson_city','2026-09-05','2026-09-05',447,'2026-09-05 daily'),
  ('leray','2026-09-05','2026-09-05',471,'2026-09-05 daily'),
  ('lindenhurst','2026-09-05','2026-09-05',482,'2026-09-05 daily'),
  ('liverpool','2026-09-05','2026-09-05',310,'2026-09-05 daily'),
  ('maple_shade','2026-09-05','2026-09-05',134,'2026-09-05 daily'),
  ('middletown','2026-09-05','2026-09-05',1219,'2026-09-05 daily'),
  ('milford','2026-09-05','2026-09-05',876,'2026-09-05 daily'),
  ('montogomery','2026-09-05','2026-09-05',474,'2026-09-05 daily'),
  ('newark','2026-09-05','2026-09-05',317,'2026-09-05 daily'),
  ('newark_ii','2026-09-05','2026-09-05',160,'2026-09-05 daily'),
  ('newburgh','2026-09-05','2026-09-05',435,'2026-09-05 daily'),
  ('newhaven','2026-09-05','2026-09-05',169,'2026-09-05 daily'),
  ('northport','2026-09-05','2026-09-05',624,'2026-09-05 daily'),
  ('norwalk','2026-09-05','2026-09-05',310,'2026-09-05 daily'),
  ('oswego','2026-09-05','2026-09-05',435,'2026-09-05 daily'),
  ('plattsburgh','2026-09-05','2026-09-05',371,'2026-09-05 daily'),
  ('randolph','2026-09-05','2026-09-05',559,'2026-09-05 daily'),
  ('rensselear','2026-09-05','2026-09-05',598,'2026-09-05 daily'),
  ('rochester','2026-09-05','2026-09-05',466,'2026-09-05 daily'),
  ('rutland','2026-09-05','2026-09-05',371,'2026-09-05 daily'),
  ('seneca_falls','2026-09-05','2026-09-05',539,'2026-09-05 daily'),
  ('shelburne','2026-09-05','2026-09-05',340,'2026-09-05 daily'),
  ('shelton','2026-09-05','2026-09-05',427,'2026-09-05 daily'),
  ('southeast','2026-09-05','2026-09-05',379,'2026-09-05 daily'),
  ('spencerport','2026-09-05','2026-09-05',417,'2026-09-05 daily'),
  ('springfield','2026-09-05','2026-09-05',371,'2026-09-05 daily'),
  ('stamford','2026-09-05','2026-09-05',439,'2026-09-05 daily'),
  ('tarrytown','2026-09-05','2026-09-05',1170,'2026-09-05 daily'),
  ('vestal','2026-09-05','2026-09-05',375,'2026-09-05 daily'),
  ('watertown','2026-09-05','2026-09-05',339,'2026-09-05 daily'),
  ('westhaven','2026-09-05','2026-09-05',303,'2026-09-05 daily'),
  ('westport','2026-09-05','2026-09-05',348,'2026-09-05 daily'),
  ('whiteplainscentral','2026-09-05','2026-09-05',426,'2026-09-05 daily'),
  ('whiteplainskensico','2026-09-05','2026-09-05',426,'2026-09-05 daily'),
  ('williamsville','2026-09-05','2026-09-05',369,'2026-09-05 daily'),
  ('williston','2026-09-05','2026-09-05',341,'2026-09-05 daily'),
  ('wilmington','2026-09-05','2026-09-05',124,'2026-09-05 daily'),
  ('wilton','2026-09-05','2026-09-05',272,'2026-09-05 daily');

-- 77 rows, 31,227 cars total

-- Totals by winning source:
--   DRB: 1,272
--   ICS: 2,389
--   splashdb: 26,894
--   spot_ai: 672

-- Sites with more than one contributing row:
--   bedford: Splash Bedford Express-019=253 (splashdb) + Splash Bedford Handwash & Lube-019=275 (splashdb)
--   greenwich: Splash Greenwich Express-040=279 (splashdb) + Splash Greenwich Handwash-040=452 (splashdb)
--   shelton: Splash Shelton Express-068=236 (splashdb) + Splash Shelton Handwash-068=191 (splashdb)

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
