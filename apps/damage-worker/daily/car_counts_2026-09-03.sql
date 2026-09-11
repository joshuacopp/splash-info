-- car_counts daily load for 2026-09-03
-- note tag: '2026-09-03 daily'
--
-- car_counts has NO unique constraint, so ON CONFLICT is unavailable.
-- The DELETE makes a re-run of this same day idempotent.
--
-- WARNING: sumCarsInWindow() apportions every row across its date
-- range. If a monthly row covering this month still exists, these
-- daily rows will double-count. Check before applying:
--   SELECT * FROM car_counts
--    WHERE start_date <= '2026-09-03' AND end_date >= '2026-09-03';
--
-- Apply with one statement per --command:
--   npx wrangler d1 execute splash-damage-claims --remote --command "..."

DELETE FROM car_counts WHERE note = '2026-09-03 daily';

INSERT INTO car_counts (location_code, start_date, end_date, cars, note) VALUES
  ('auburn','2026-09-03','2026-09-03',305,'2026-09-03 daily'),
  ('batavia_ii','2026-09-03','2026-09-03',367,'2026-09-03 daily'),
  ('batavia_liberty','2026-09-03','2026-09-03',159,'2026-09-03 daily'),
  ('batavia_veterans','2026-09-03','2026-09-03',304,'2026-09-03 daily'),
  ('bedford','2026-09-03','2026-09-03',299,'2026-09-03 daily'),
  ('binghamton','2026-09-03','2026-09-03',263,'2026-09-03 daily'),
  ('blackwood','2026-09-03','2026-09-03',133,'2026-09-03 daily'),
  ('bohemia','2026-09-03','2026-09-03',438,'2026-09-03 daily'),
  ('brewster','2026-09-03','2026-09-03',90,'2026-09-03 daily'),
  ('bridgeport','2026-09-03','2026-09-03',200,'2026-09-03 daily'),
  ('brockport_ii','2026-09-03','2026-09-03',227,'2026-09-03 daily'),
  ('canandaigua','2026-09-03','2026-09-03',153,'2026-09-03 daily'),
  ('cherry_hill','2026-09-03','2026-09-03',114,'2026-09-03 daily'),
  ('cheshire','2026-09-03','2026-09-03',90,'2026-09-03 daily'),
  ('chili','2026-09-03','2026-09-03',253,'2026-09-03 daily'),
  ('cicero','2026-09-03','2026-09-03',265,'2026-09-03 daily'),
  ('clay','2026-09-03','2026-09-03',532,'2026-09-03 daily'),
  ('commack','2026-09-03','2026-09-03',186,'2026-09-03 daily'),
  ('cortland','2026-09-03','2026-09-03',274,'2026-09-03 daily'),
  ('coscob','2026-09-03','2026-09-03',193,'2026-09-03 daily'),
  ('cromwell','2026-09-03','2026-09-03',111,'2026-09-03 daily'),
  ('darien','2026-09-03','2026-09-03',196,'2026-09-03 daily'),
  ('derby','2026-09-03','2026-09-03',359,'2026-09-03 daily'),
  ('easthaven','2026-09-03','2026-09-03',493,'2026-09-03 daily'),
  ('eastnorthport','2026-09-03','2026-09-03',433,'2026-09-03 daily'),
  ('elmira_heights','2026-09-03','2026-09-03',219,'2026-09-03 daily'),
  ('exton','2026-09-03','2026-09-03',96,'2026-09-03 daily'),
  ('fairfield','2026-09-03','2026-09-03',135,'2026-09-03 daily'),
  ('fairport','2026-09-03','2026-09-03',210,'2026-09-03 daily'),
  ('falmouth','2026-09-03','2026-09-03',100,'2026-09-03 daily'),
  ('farmington','2026-09-03','2026-09-03',192,'2026-09-03 daily'),
  ('fayetteville','2026-09-03','2026-09-03',494,'2026-09-03 daily'),
  ('geneva_ii','2026-09-03','2026-09-03',378,'2026-09-03 daily'),
  ('greenwich','2026-09-03','2026-09-03',523,'2026-09-03 daily'),
  ('guilderland','2026-09-03','2026-09-03',602,'2026-09-03 daily'),
  ('hamburg','2026-09-03','2026-09-03',140,'2026-09-03 daily'),
  ('hamden','2026-09-03','2026-09-03',151,'2026-09-03 daily'),
  ('hempstead','2026-09-03','2026-09-03',255,'2026-09-03 daily'),
  ('henrietta','2026-09-03','2026-09-03',252,'2026-09-03 daily'),
  ('johnson_city','2026-09-03','2026-09-03',422,'2026-09-03 daily'),
  ('leray','2026-09-03','2026-09-03',484,'2026-09-03 daily'),
  ('lindenhurst','2026-09-03','2026-09-03',310,'2026-09-03 daily'),
  ('liverpool','2026-09-03','2026-09-03',267,'2026-09-03 daily'),
  ('maple_shade','2026-09-03','2026-09-03',81,'2026-09-03 daily'),
  ('middletown','2026-09-03','2026-09-03',1090,'2026-09-03 daily'),
  ('milford','2026-09-03','2026-09-03',544,'2026-09-03 daily'),
  ('montogomery','2026-09-03','2026-09-03',359,'2026-09-03 daily'),
  ('newark','2026-09-03','2026-09-03',203,'2026-09-03 daily'),
  ('newark_ii','2026-09-03','2026-09-03',67,'2026-09-03 daily'),
  ('newburgh','2026-09-03','2026-09-03',287,'2026-09-03 daily'),
  ('newhaven','2026-09-03','2026-09-03',108,'2026-09-03 daily'),
  ('northport','2026-09-03','2026-09-03',489,'2026-09-03 daily'),
  ('norwalk','2026-09-03','2026-09-03',189,'2026-09-03 daily'),
  ('oswego','2026-09-03','2026-09-03',406,'2026-09-03 daily'),
  ('plattsburgh','2026-09-03','2026-09-03',445,'2026-09-03 daily'),
  ('randolph','2026-09-03','2026-09-03',326,'2026-09-03 daily'),
  ('rensselear','2026-09-03','2026-09-03',426,'2026-09-03 daily'),
  ('rochester','2026-09-03','2026-09-03',338,'2026-09-03 daily'),
  ('rutland','2026-09-03','2026-09-03',431,'2026-09-03 daily'),
  ('seneca_falls','2026-09-03','2026-09-03',0,'2026-09-03 daily'),
  ('shelburne','2026-09-03','2026-09-03',339,'2026-09-03 daily'),
  ('shelton','2026-09-03','2026-09-03',220,'2026-09-03 daily'),
  ('southeast','2026-09-03','2026-09-03',223,'2026-09-03 daily'),
  ('spencerport','2026-09-03','2026-09-03',293,'2026-09-03 daily'),
  ('springfield','2026-09-03','2026-09-03',239,'2026-09-03 daily'),
  ('stamford','2026-09-03','2026-09-03',292,'2026-09-03 daily'),
  ('tarrytown','2026-09-03','2026-09-03',973,'2026-09-03 daily'),
  ('vestal','2026-09-03','2026-09-03',371,'2026-09-03 daily'),
  ('watertown','2026-09-03','2026-09-03',364,'2026-09-03 daily'),
  ('westhaven','2026-09-03','2026-09-03',202,'2026-09-03 daily'),
  ('westport','2026-09-03','2026-09-03',209,'2026-09-03 daily'),
  ('whiteplainscentral','2026-09-03','2026-09-03',297,'2026-09-03 daily'),
  ('whiteplainskensico','2026-09-03','2026-09-03',398,'2026-09-03 daily'),
  ('williamsville','2026-09-03','2026-09-03',281,'2026-09-03 daily'),
  ('williston','2026-09-03','2026-09-03',356,'2026-09-03 daily'),
  ('wilmington','2026-09-03','2026-09-03',82,'2026-09-03 daily'),
  ('wilton','2026-09-03','2026-09-03',170,'2026-09-03 daily');

-- 77 rows, 22,765 cars total

-- Totals by winning source:
--   DRB: 1,028
--   ICS: 2,063
--   splashdb: 19,129
--   spot_ai: 545

-- Sites with more than one contributing row:
--   bedford: Splash Bedford Express-019=135 (splashdb) + Splash Bedford Handwash & Lube-019=164 (splashdb)
--   greenwich: Splash Greenwich Express-040=186 (splashdb) + Splash Greenwich Handwash-040=337 (splashdb)
--   shelton: Splash Shelton Express-068=122 (splashdb) + Splash Shelton Handwash-068=98 (splashdb)

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
