-- car_counts daily load for 2026-09-07
-- note tag: '2026-09-07 daily'
--
-- car_counts has NO unique constraint, so ON CONFLICT is unavailable.
-- The DELETE makes a re-run of this same day idempotent.
--
-- WARNING: sumCarsInWindow() apportions every row across its date
-- range. If a monthly row covering this month still exists, these
-- daily rows will double-count. Check before applying:
--   SELECT * FROM car_counts
--    WHERE start_date <= '2026-09-07' AND end_date >= '2026-09-07';
--
-- Apply with one statement per --command:
--   npx wrangler d1 execute splash-damage-claims --remote --command "..."

DELETE FROM car_counts WHERE note = '2026-09-07 daily';

INSERT INTO car_counts (location_code, start_date, end_date, cars, note) VALUES
  ('auburn','2026-09-07','2026-09-07',381,'2026-09-07 daily'),
  ('batavia_ii','2026-09-07','2026-09-07',374,'2026-09-07 daily'),
  ('batavia_liberty','2026-09-07','2026-09-07',218,'2026-09-07 daily'),
  ('batavia_veterans','2026-09-07','2026-09-07',353,'2026-09-07 daily'),
  ('bedford','2026-09-07','2026-09-07',281,'2026-09-07 daily'),
  ('binghamton','2026-09-07','2026-09-07',267,'2026-09-07 daily'),
  ('blackwood','2026-09-07','2026-09-07',143,'2026-09-07 daily'),
  ('bohemia','2026-09-07','2026-09-07',346,'2026-09-07 daily'),
  ('brewster','2026-09-07','2026-09-07',90,'2026-09-07 daily'),
  ('bridgeport','2026-09-07','2026-09-07',150,'2026-09-07 daily'),
  ('brockport_ii','2026-09-07','2026-09-07',337,'2026-09-07 daily'),
  ('canandaigua','2026-09-07','2026-09-07',203,'2026-09-07 daily'),
  ('cherry_hill','2026-09-07','2026-09-07',116,'2026-09-07 daily'),
  ('cheshire','2026-09-07','2026-09-07',100,'2026-09-07 daily'),
  ('chili','2026-09-07','2026-09-07',236,'2026-09-07 daily'),
  ('cicero','2026-09-07','2026-09-07',303,'2026-09-07 daily'),
  ('clay','2026-09-07','2026-09-07',599,'2026-09-07 daily'),
  ('commack','2026-09-07','2026-09-07',197,'2026-09-07 daily'),
  ('cortland','2026-09-07','2026-09-07',306,'2026-09-07 daily'),
  ('coscob','2026-09-07','2026-09-07',153,'2026-09-07 daily'),
  ('cromwell','2026-09-07','2026-09-07',103,'2026-09-07 daily'),
  ('darien','2026-09-07','2026-09-07',166,'2026-09-07 daily'),
  ('derby','2026-09-07','2026-09-07',338,'2026-09-07 daily'),
  ('easthaven','2026-09-07','2026-09-07',360,'2026-09-07 daily'),
  ('eastnorthport','2026-09-07','2026-09-07',291,'2026-09-07 daily'),
  ('elmira_heights','2026-09-07','2026-09-07',282,'2026-09-07 daily'),
  ('exton','2026-09-07','2026-09-07',94,'2026-09-07 daily'),
  ('fairfield','2026-09-07','2026-09-07',129,'2026-09-07 daily'),
  ('fairport','2026-09-07','2026-09-07',295,'2026-09-07 daily'),
  ('falmouth','2026-09-07','2026-09-07',253,'2026-09-07 daily'),
  ('farmington','2026-09-07','2026-09-07',197,'2026-09-07 daily'),
  ('fayetteville','2026-09-07','2026-09-07',515,'2026-09-07 daily'),
  ('geneva_ii','2026-09-07','2026-09-07',487,'2026-09-07 daily'),
  ('greenwich','2026-09-07','2026-09-07',377,'2026-09-07 daily'),
  ('guilderland','2026-09-07','2026-09-07',402,'2026-09-07 daily'),
  ('hamburg','2026-09-07','2026-09-07',162,'2026-09-07 daily'),
  ('hamden','2026-09-07','2026-09-07',157,'2026-09-07 daily'),
  ('hempstead','2026-09-07','2026-09-07',155,'2026-09-07 daily'),
  ('henrietta','2026-09-07','2026-09-07',276,'2026-09-07 daily'),
  ('johnson_city','2026-09-07','2026-09-07',465,'2026-09-07 daily'),
  ('leray','2026-09-07','2026-09-07',516,'2026-09-07 daily'),
  ('lindenhurst','2026-09-07','2026-09-07',247,'2026-09-07 daily'),
  ('liverpool','2026-09-07','2026-09-07',266,'2026-09-07 daily'),
  ('maple_shade','2026-09-07','2026-09-07',83,'2026-09-07 daily'),
  ('middletown','2026-09-07','2026-09-07',862,'2026-09-07 daily'),
  ('milford','2026-09-07','2026-09-07',458,'2026-09-07 daily'),
  ('montogomery','2026-09-07','2026-09-07',368,'2026-09-07 daily'),
  ('newark','2026-09-07','2026-09-07',276,'2026-09-07 daily'),
  ('newark_ii','2026-09-07','2026-09-07',78,'2026-09-07 daily'),
  ('newburgh','2026-09-07','2026-09-07',304,'2026-09-07 daily'),
  ('newhaven','2026-09-07','2026-09-07',72,'2026-09-07 daily'),
  ('northport','2026-09-07','2026-09-07',345,'2026-09-07 daily'),
  ('norwalk','2026-09-07','2026-09-07',179,'2026-09-07 daily'),
  ('oswego','2026-09-07','2026-09-07',439,'2026-09-07 daily'),
  ('plattsburgh','2026-09-07','2026-09-07',378,'2026-09-07 daily'),
  ('randolph','2026-09-07','2026-09-07',314,'2026-09-07 daily'),
  ('rensselear','2026-09-07','2026-09-07',343,'2026-09-07 daily'),
  ('rochester','2026-09-07','2026-09-07',362,'2026-09-07 daily'),
  ('rutland','2026-09-07','2026-09-07',357,'2026-09-07 daily'),
  ('seneca_falls','2026-09-07','2026-09-07',420,'2026-09-07 daily'),
  ('shelburne','2026-09-07','2026-09-07',301,'2026-09-07 daily'),
  ('shelton','2026-09-07','2026-09-07',230,'2026-09-07 daily'),
  ('southeast','2026-09-07','2026-09-07',226,'2026-09-07 daily'),
  ('spencerport','2026-09-07','2026-09-07',357,'2026-09-07 daily'),
  ('springfield','2026-09-07','2026-09-07',183,'2026-09-07 daily'),
  ('stamford','2026-09-07','2026-09-07',218,'2026-09-07 daily'),
  ('tarrytown','2026-09-07','2026-09-07',769,'2026-09-07 daily'),
  ('vestal','2026-09-07','2026-09-07',390,'2026-09-07 daily'),
  ('watertown','2026-09-07','2026-09-07',342,'2026-09-07 daily'),
  ('westhaven','2026-09-07','2026-09-07',140,'2026-09-07 daily'),
  ('westport','2026-09-07','2026-09-07',185,'2026-09-07 daily'),
  ('whiteplainscentral','2026-09-07','2026-09-07',215,'2026-09-07 daily'),
  ('whiteplainskensico','2026-09-07','2026-09-07',199,'2026-09-07 daily'),
  ('williamsville','2026-09-07','2026-09-07',331,'2026-09-07 daily'),
  ('williston','2026-09-07','2026-09-07',358,'2026-09-07 daily'),
  ('wilmington','2026-09-07','2026-09-07',71,'2026-09-07 daily'),
  ('wilton','2026-09-07','2026-09-07',164,'2026-09-07 daily');

-- 77 rows, 22,003 cars total

-- Totals by winning source:
--   DRB: 745
--   ICS: 1,631
--   splashdb: 18,996
--   spot_ai: 631

-- Sites with more than one contributing row:
--   bedford: Splash Bedford Express-019=148 (splashdb) + Splash Bedford Handwash & Lube-019=133 (splashdb)
--   greenwich: Splash Greenwich Express-040=152 (splashdb) + Splash Greenwich Handwash-040=225 (splashdb)
--   shelton: Splash Shelton Express-068=119 (splashdb) + Splash Shelton Handwash-068=111 (splashdb)

-- Deliberately not inserted:
--   Online Portal -- not a store
--   Splash Bayville-234 -- site 234 not in pricing_simple
--   Splash Bridgeport Lube-023 -- site 023 has no location_code
--   Splash Brighton-155 -- site 155 not in pricing_simple
--   Splash Management-011 -- not a store
--   Splash Nanuet-087 -- site 087 not in pricing_simple
--   Splash Port Jefferson-188 -- site 188 not in pricing_simple
--   Splash USA Car Wash Bronx-096 -- site 096 has no location_code
--   Splash24 Brockport-123 -- blank splashdb
