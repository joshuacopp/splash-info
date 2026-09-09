-- car_counts daily load for 2026-09-04
-- note tag: '2026-09-04 daily'
--
-- car_counts has NO unique constraint, so ON CONFLICT is unavailable.
-- The DELETE makes a re-run of this same day idempotent.
--
-- WARNING: sumCarsInWindow() apportions every row across its date
-- range. If a monthly row covering September 2026 still exists, these
-- daily rows will double-count. Check before applying:
--   SELECT * FROM car_counts
--    WHERE start_date <= '2026-09-04' AND end_date >= '2026-09-04';
--
-- Apply with one statement per --command:
--   npx wrangler d1 execute splash-damage-claims --remote --command "..."

DELETE FROM car_counts WHERE note = '2026-09-04 daily';

INSERT INTO car_counts (location_code, start_date, end_date, cars, note) VALUES
  ('auburn','2026-09-04','2026-09-04',451,'2026-09-04 daily'),
  ('batavia_ii','2026-09-04','2026-09-04',533,'2026-09-04 daily'),
  ('batavia_liberty','2026-09-04','2026-09-04',198,'2026-09-04 daily'),
  ('batavia_veterans','2026-09-04','2026-09-04',421,'2026-09-04 daily'),
  ('bedford','2026-09-04','2026-09-04',546,'2026-09-04 daily'),
  ('binghamton','2026-09-04','2026-09-04',366,'2026-09-04 daily'),
  ('blackwood','2026-09-04','2026-09-04',227,'2026-09-04 daily'),
  ('bohemia','2026-09-04','2026-09-04',705,'2026-09-04 daily'),
  ('brewster','2026-09-04','2026-09-04',144,'2026-09-04 daily'),
  ('bridgeport','2026-09-04','2026-09-04',297,'2026-09-04 daily'),
  ('brockport_ii','2026-09-04','2026-09-04',350,'2026-09-04 daily'),
  ('canandaigua','2026-09-04','2026-09-04',226,'2026-09-04 daily'),
  ('cherry_hill','2026-09-04','2026-09-04',203,'2026-09-04 daily'),
  ('cheshire','2026-09-04','2026-09-04',246,'2026-09-04 daily'),
  ('chili','2026-09-04','2026-09-04',385,'2026-09-04 daily'),
  ('cicero','2026-09-04','2026-09-04',336,'2026-09-04 daily'),
  ('clay','2026-09-04','2026-09-04',703,'2026-09-04 daily'),
  ('commack','2026-09-04','2026-09-04',301,'2026-09-04 daily'),
  ('cortland','2026-09-04','2026-09-04',403,'2026-09-04 daily'),
  ('coscob','2026-09-04','2026-09-04',308,'2026-09-04 daily'),
  ('cromwell','2026-09-04','2026-09-04',184,'2026-09-04 daily'),
  ('darien','2026-09-04','2026-09-04',307,'2026-09-04 daily'),
  ('derby','2026-09-04','2026-09-04',609,'2026-09-04 daily'),
  ('easthaven','2026-09-04','2026-09-04',756,'2026-09-04 daily'),
  ('eastnorthport','2026-09-04','2026-09-04',663,'2026-09-04 daily'),
  ('elmira_heights','2026-09-04','2026-09-04',306,'2026-09-04 daily'),
  ('exton','2026-09-04','2026-09-04',228,'2026-09-04 daily'),
  ('fairfield','2026-09-04','2026-09-04',265,'2026-09-04 daily'),
  ('fairport','2026-09-04','2026-09-04',326,'2026-09-04 daily'),
  ('falmouth','2026-09-04','2026-09-04',317,'2026-09-04 daily'),
  ('farmington','2026-09-04','2026-09-04',255,'2026-09-04 daily'),
  ('fayetteville','2026-09-04','2026-09-04',690,'2026-09-04 daily'),
  ('geneva_ii','2026-09-04','2026-09-04',621,'2026-09-04 daily'),
  ('greenwich','2026-09-04','2026-09-04',785,'2026-09-04 daily'),
  ('guilderland','2026-09-04','2026-09-04',907,'2026-09-04 daily'),
  ('hamburg','2026-09-04','2026-09-04',174,'2026-09-04 daily'),
  ('hamden','2026-09-04','2026-09-04',360,'2026-09-04 daily'),
  ('hempstead','2026-09-04','2026-09-04',371,'2026-09-04 daily'),
  ('henrietta','2026-09-04','2026-09-04',393,'2026-09-04 daily'),
  ('johnson_city','2026-09-04','2026-09-04',547,'2026-09-04 daily'),
  ('leray','2026-09-04','2026-09-04',598,'2026-09-04 daily'),
  ('lindenhurst','2026-09-04','2026-09-04',464,'2026-09-04 daily'),
  ('liverpool','2026-09-04','2026-09-04',388,'2026-09-04 daily'),
  ('maple_shade','2026-09-04','2026-09-04',144,'2026-09-04 daily'),
  ('middletown','2026-09-04','2026-09-04',1379,'2026-09-04 daily'),
  ('milford','2026-09-04','2026-09-04',894,'2026-09-04 daily'),
  ('montogomery','2026-09-04','2026-09-04',510,'2026-09-04 daily'),
  ('newark','2026-09-04','2026-09-04',396,'2026-09-04 daily'),
  ('newark_ii','2026-09-04','2026-09-04',146,'2026-09-04 daily'),
  ('newburgh','2026-09-04','2026-09-04',423,'2026-09-04 daily'),
  ('newhaven','2026-09-04','2026-09-04',213,'2026-09-04 daily'),
  ('northport','2026-09-04','2026-09-04',724,'2026-09-04 daily'),
  ('norwalk','2026-09-04','2026-09-04',359,'2026-09-04 daily'),
  ('oswego','2026-09-04','2026-09-04',459,'2026-09-04 daily'),
  ('plattsburgh','2026-09-04','2026-09-04',456,'2026-09-04 daily'),
  ('randolph','2026-09-04','2026-09-04',634,'2026-09-04 daily'),
  ('rensselear','2026-09-04','2026-09-04',592,'2026-09-04 daily'),
  ('rochester','2026-09-04','2026-09-04',494,'2026-09-04 daily'),
  ('rutland','2026-09-04','2026-09-04',580,'2026-09-04 daily'),
  ('seneca_falls','2026-09-04','2026-09-04',0,'2026-09-04 daily'),
  ('shelburne','2026-09-04','2026-09-04',411,'2026-09-04 daily'),
  ('shelton','2026-09-04','2026-09-04',477,'2026-09-04 daily'),
  ('southeast','2026-09-04','2026-09-04',356,'2026-09-04 daily'),
  ('spencerport','2026-09-04','2026-09-04',475,'2026-09-04 daily'),
  ('springfield','2026-09-04','2026-09-04',393,'2026-09-04 daily'),
  ('stamford','2026-09-04','2026-09-04',428,'2026-09-04 daily'),
  ('tarrytown','2026-09-04','2026-09-04',1244,'2026-09-04 daily'),
  ('vestal','2026-09-04','2026-09-04',443,'2026-09-04 daily'),
  ('watertown','2026-09-04','2026-09-04',425,'2026-09-04 daily'),
  ('westhaven','2026-09-04','2026-09-04',333,'2026-09-04 daily'),
  ('westport','2026-09-04','2026-09-04',350,'2026-09-04 daily'),
  ('whiteplainscentral','2026-09-04','2026-09-04',455,'2026-09-04 daily'),
  ('whiteplainskensico','2026-09-04','2026-09-04',470,'2026-09-04 daily'),
  ('williamsville','2026-09-04','2026-09-04',361,'2026-09-04 daily'),
  ('williston','2026-09-04','2026-09-04',452,'2026-09-04 daily'),
  ('wilmington','2026-09-04','2026-09-04',154,'2026-09-04 daily'),
  ('wilton','2026-09-04','2026-09-04',352,'2026-09-04 daily');

-- 77 rows, 33,845 cars total

-- Multi-meter sites summed into one code:
--   bedford: Splash Bedford Express-019=279 (sales) + Splash Bedford Handwash & Lube-019=267 (sales)
--   greenwich: Splash Greenwich Express-040=292 (sales) + Splash Greenwich Handwash-040=493 (sales)
--   shelton: Splash Shelton Express-068=272 (sales) + Splash Shelton Handwash-068=205 (sales)

-- Spot AI sourced (no Splash export coverage):
--   plattsburgh (site 083) = 456
--   falmouth (site 092) = 317
--   rensselear (site 196) = 592
--   guilderland (site 197) = 907

-- Deliberately not inserted:
--   Online Portal -- not a store
--   Splash Bridgeport Lube-023 -- site 023 has no location_code
--   Splash Brighton-155 -- site 155 not in pricing_simple
--   Splash Management-011 -- not a store
--   Splash Nanuet-087 -- site 087 not in pricing_simple
--   Splash Port Jefferson-188 -- site 188 not in pricing_simple
--   Splash USA Car Wash Bronx-096 -- site 096 has no location_code
--   Splash24 Brockport-123 -- no data in sales or Spot AI
--   Corporate -- ICS non-store
