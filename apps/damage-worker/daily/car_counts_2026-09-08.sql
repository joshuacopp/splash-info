-- car_counts daily load for 2026-09-08
-- note tag: '2026-09-08 daily'
--
-- car_counts has NO unique constraint, so ON CONFLICT is unavailable.
-- The DELETE makes a re-run of this same day idempotent.
--
-- WARNING: sumCarsInWindow() apportions every row across its date
-- range. If a monthly row covering this month still exists, these
-- daily rows will double-count. Check before applying:
--   SELECT * FROM car_counts
--    WHERE start_date <= '2026-09-08' AND end_date >= '2026-09-08';
--
-- Apply with one statement per --command:
--   npx wrangler d1 execute splash-damage-claims --remote --command "..."

DELETE FROM car_counts WHERE note = '2026-09-08 daily';

INSERT INTO car_counts (location_code, start_date, end_date, cars, note) VALUES
  ('auburn','2026-09-08','2026-09-08',393,'2026-09-08 daily'),
  ('batavia_ii','2026-09-08','2026-09-08',476,'2026-09-08 daily'),
  ('batavia_liberty','2026-09-08','2026-09-08',212,'2026-09-08 daily'),
  ('batavia_veterans','2026-09-08','2026-09-08',417,'2026-09-08 daily'),
  ('bedford','2026-09-08','2026-09-08',454,'2026-09-08 daily'),
  ('binghamton','2026-09-08','2026-09-08',325,'2026-09-08 daily'),
  ('blackwood','2026-09-08','2026-09-08',199,'2026-09-08 daily'),
  ('bohemia','2026-09-08','2026-09-08',575,'2026-09-08 daily'),
  ('brewster','2026-09-08','2026-09-08',138,'2026-09-08 daily'),
  ('bridgeport','2026-09-08','2026-09-08',226,'2026-09-08 daily'),
  ('brockport_ii','2026-09-08','2026-09-08',360,'2026-09-08 daily'),
  ('canandaigua','2026-09-08','2026-09-08',216,'2026-09-08 daily'),
  ('cherry_hill','2026-09-08','2026-09-08',178,'2026-09-08 daily'),
  ('cheshire','2026-09-08','2026-09-08',189,'2026-09-08 daily'),
  ('chili','2026-09-08','2026-09-08',359,'2026-09-08 daily'),
  ('cicero','2026-09-08','2026-09-08',315,'2026-09-08 daily'),
  ('clay','2026-09-08','2026-09-08',605,'2026-09-08 daily'),
  ('commack','2026-09-08','2026-09-08',261,'2026-09-08 daily'),
  ('cortland','2026-09-08','2026-09-08',396,'2026-09-08 daily'),
  ('coscob','2026-09-08','2026-09-08',246,'2026-09-08 daily'),
  ('cromwell','2026-09-08','2026-09-08',168,'2026-09-08 daily'),
  ('darien','2026-09-08','2026-09-08',271,'2026-09-08 daily'),
  ('derby','2026-09-08','2026-09-08',514,'2026-09-08 daily'),
  ('easthaven','2026-09-08','2026-09-08',745,'2026-09-08 daily'),
  ('eastnorthport','2026-09-08','2026-09-08',485,'2026-09-08 daily'),
  ('elmira_heights','2026-09-08','2026-09-08',337,'2026-09-08 daily'),
  ('exton','2026-09-08','2026-09-08',165,'2026-09-08 daily'),
  ('fairfield','2026-09-08','2026-09-08',211,'2026-09-08 daily'),
  ('fairport','2026-09-08','2026-09-08',351,'2026-09-08 daily'),
  ('falmouth','2026-09-08','2026-09-08',291,'2026-09-08 daily'),
  ('farmington','2026-09-08','2026-09-08',252,'2026-09-08 daily'),
  ('fayetteville','2026-09-08','2026-09-08',619,'2026-09-08 daily'),
  ('geneva_ii','2026-09-08','2026-09-08',527,'2026-09-08 daily'),
  ('greenwich','2026-09-08','2026-09-08',685,'2026-09-08 daily'),
  ('guilderland','2026-09-08','2026-09-08',839,'2026-09-08 daily'),
  ('hamburg','2026-09-08','2026-09-08',189,'2026-09-08 daily'),
  ('hamden','2026-09-08','2026-09-08',246,'2026-09-08 daily'),
  ('hempstead','2026-09-08','2026-09-08',276,'2026-09-08 daily'),
  ('henrietta','2026-09-08','2026-09-08',353,'2026-09-08 daily'),
  ('johnson_city','2026-09-08','2026-09-08',570,'2026-09-08 daily'),
  ('leray','2026-09-08','2026-09-08',432,'2026-09-08 daily'),
  ('lindenhurst','2026-09-08','2026-09-08',414,'2026-09-08 daily'),
  ('liverpool','2026-09-08','2026-09-08',287,'2026-09-08 daily'),
  ('maple_shade','2026-09-08','2026-09-08',145,'2026-09-08 daily'),
  ('middletown','2026-09-08','2026-09-08',1284,'2026-09-08 daily'),
  ('milford','2026-09-08','2026-09-08',871,'2026-09-08 daily'),
  ('montogomery','2026-09-08','2026-09-08',504,'2026-09-08 daily'),
  ('newark','2026-09-08','2026-09-08',324,'2026-09-08 daily'),
  ('newark_ii','2026-09-08','2026-09-08',112,'2026-09-08 daily'),
  ('newburgh','2026-09-08','2026-09-08',338,'2026-09-08 daily'),
  ('newhaven','2026-09-08','2026-09-08',166,'2026-09-08 daily'),
  ('northport','2026-09-08','2026-09-08',635,'2026-09-08 daily'),
  ('norwalk','2026-09-08','2026-09-08',250,'2026-09-08 daily'),
  ('oswego','2026-09-08','2026-09-08',480,'2026-09-08 daily'),
  ('plattsburgh','2026-09-08','2026-09-08',347,'2026-09-08 daily'),
  ('randolph','2026-09-08','2026-09-08',465,'2026-09-08 daily'),
  ('rensselear','2026-09-08','2026-09-08',637,'2026-09-08 daily'),
  ('rochester','2026-09-08','2026-09-08',467,'2026-09-08 daily'),
  ('rutland','2026-09-08','2026-09-08',495,'2026-09-08 daily'),
  ('seneca_falls','2026-09-08','2026-09-08',554,'2026-09-08 daily'),
  ('shelburne','2026-09-08','2026-09-08',325,'2026-09-08 daily'),
  ('shelton','2026-09-08','2026-09-08',357,'2026-09-08 daily'),
  ('southeast','2026-09-08','2026-09-08',352,'2026-09-08 daily'),
  ('spencerport','2026-09-08','2026-09-08',472,'2026-09-08 daily'),
  ('springfield','2026-09-08','2026-09-08',332,'2026-09-08 daily'),
  ('stamford','2026-09-08','2026-09-08',353,'2026-09-08 daily'),
  ('tarrytown','2026-09-08','2026-09-08',1064,'2026-09-08 daily'),
  ('vestal','2026-09-08','2026-09-08',447,'2026-09-08 daily'),
  ('watertown','2026-09-08','2026-09-08',386,'2026-09-08 daily'),
  ('westhaven','2026-09-08','2026-09-08',241,'2026-09-08 daily'),
  ('westport','2026-09-08','2026-09-08',326,'2026-09-08 daily'),
  ('whiteplainscentral','2026-09-08','2026-09-08',374,'2026-09-08 daily'),
  ('whiteplainskensico','2026-09-08','2026-09-08',477,'2026-09-08 daily'),
  ('williamsville','2026-09-08','2026-09-08',368,'2026-09-08 daily'),
  ('williston','2026-09-08','2026-09-08',281,'2026-09-08 daily'),
  ('wilmington','2026-09-08','2026-09-08',0,'2026-09-08 daily'),
  ('wilton','2026-09-08','2026-09-08',246,'2026-09-08 daily');

-- 77 rows, 30,242 cars total

-- Totals by winning source:
--   DRB: 1,476
--   ICS: 2,348
--   splashdb: 25,780
--   spot_ai: 638

-- Sites with more than one contributing row:
--   bedford: Splash Bedford Express-019=246 (splashdb) + Splash Bedford Handwash & Lube-019=208 (splashdb)
--   greenwich: Splash Greenwich Express-040=309 (splashdb) + Splash Greenwich Handwash-040=376 (splashdb)
--   shelton: Splash Shelton Express-068=209 (splashdb) + Splash Shelton Handwash-068=148 (splashdb)

-- Deliberately not inserted:
--   Corporate -- ICS non-store
--   Online Portal -- not a store
--   Splash Bayville-234 -- site 234 not in pricing_simple
--   Splash Bridgeport Lube-023 -- site 023 has no location_code
--   Splash Brighton-155 -- site 155 not in pricing_simple
--   Splash Management-011 -- not a store
--   Splash Nanuet-087 -- site 087 not in pricing_simple
--   Splash Port Jefferson-188 -- site 188 not in pricing_simple
--   Splash USA Car Wash Bronx-096 -- site 096 has no location_code
--   Splash24 Brockport-123 -- blank splashdb
